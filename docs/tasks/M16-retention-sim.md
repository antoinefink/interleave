# M16 — Retention, optimization, simulation & retirement (T079–T082)

Detailed, buildable specs for the **second half** of M16 ("Advanced scheduling & overload").
The first half — T076 (advanced auto-sort), T077 (auto-postpone), T078 (catch-up / vacation
modes) — has its own spec file ([`./M16-sort-overload.md`](./M16-sort-overload.md), generated
separately); this file covers the four FSRS-side overload tools:

- **T079 — Desired retention by priority/concept.** A card's FSRS target retention is no longer
  one global number — it is **resolved** from the card's priority band and/or its concept, and
  FSRS schedules against that resolved target. Persisted in SQLite, read via the typed API.
- **T080 — FSRS parameter optimization.** Accumulated `review_logs` are replayed on-device to
  **score** candidate FSRS parameter sets (per preset / per concept) and **suggest** an update
  with a workload-impact preview. Suggestions are never auto-applied. ts-fsrs@5.4.1 ships **no**
  optimizer, so this spec defines an **honest on-device evaluator + bounded search** built from
  the primitives ts-fsrs *does* export — a heavy fit runs on the T058 runner.
- **T081 — Workload simulation.** Before committing a change, the user previews how daily load
  shifts from (a) altering desired retention, (b) adding N cards, or (c) postponing low-priority
  material — a **pure projection** over `review_states` + due dates, deterministic and unit-tested.
- **T082 — Mature-card retirement.** Low-value mature cards leave active review gracefully via a
  reversible **retired** flag (the source of truth — the review/due reads skip retired cards). A
  per-card **low** retention override (clamped to the supported floor) can *additionally* lengthen
  intervals, but it is **not** the retirement mechanism (the resolver floor prevents a "near-zero"
  target — see the T082 note). Reversible.

These four sit on the substrate M1/M5/M6/M7 already built. **Read `What already exists` below
before writing a line** — the FSRS wrapper, the settings model, the concept repository, the
queue/analytics reads, the IPC seam, and the background runner are all in place; M16 mostly
*composes* them. The architecture is unchanged and non-negotiable (see
[`../../CLAUDE.md`](../../CLAUDE.md) and the roadmap header): the React **renderer**
(`apps/web`) never touches SQLite, Node, or the filesystem. Every mutation flows React UI →
typed client wrapper (`apps/web/src/lib/appApi.ts`) → preload bridge
(`apps/desktop/src/preload/index.ts`) → validated IPC (Zod) on the main side
(`apps/desktop/src/main/ipc.ts`) → the `DbService` (`apps/desktop/src/main/db-service.ts`) →
`packages/local-db` repositories + `packages/scheduler` services → SQLite. Every meaningful
mutation runs in **one transaction** and appends an **`operation_log`** row; deletes are soft
(`deleted_at`); lineage is sacred.

> **The two-scheduler split (load-bearing — read before touching either scheduler).**
> `packages/scheduler` documents both mental models in its index doc comment
> (`packages/scheduler/src/index.ts`). **FSRS** (`CardSchedulerService` wrapping `ts-fsrs`,
> `packages/scheduler/src/card-scheduler.ts`) schedules **`card` elements only** — *"can the
> user recall this?"* — and persists on `review_states`. The **attention scheduler**
> (`packages/scheduler/src/attention-scheduler.ts` + the `SchedulerService` apply seam in
> `packages/local-db/src/scheduler-service.ts`) schedules `source`/`topic`/`extract`/`task`/
> `synthesis_note` — *"should the user process this again, and when?"* — on `elements.due_at`.
> **Every T079–T082 capability acts on the FSRS side only.** Desired-retention resolution,
> parameter optimization, the card half of workload simulation, and mature-card retirement all
> touch `card` elements / `review_states` / `cards` — **never** an extract's `due_at`. The
> attention half of workload simulation (T081) reads attention due dates but never reschedules
> a card through the attention scheduler or vice-versa. A `non-card` element must never gain a
> `review_states`/FSRS row; a `card` must never be rescheduled by the attention heuristic.

> **Operation-log discipline.** `OPERATION_TYPES` (`packages/core/src/operation-log.ts`) is a
> **closed, fixed set of 15** — "a rename is a migration." M16 mutations map onto the existing
> ops, **no new op types**: changing a per-priority/per-concept retention target is a `settings`
> write (no op — settings have no op, like the rest of T011) for the *defaults*, and an
> `update_element` when a *per-card* override is stored on a card; applying an optimized
> parameter set is a `settings` write (presets live in settings) — and, where a per-concept
> param set is stored on the `concept` element, `update_element`; retiring / un-retiring a card
> is `update_element` (status / a `cards` flag change). Workload simulation is **read-only** —
> it appends **nothing**. Do **not** invent `optimize` / `retire` / `set_retention` op types.

Read first:
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — the **Card scheduler
  (FSRS)** section ("the gold-standard phase allows per-priority/per-concept retention and
  parameter optimization from accumulated review history") and **Overload handling**
  ("Workload simulation — preview how load changes before changing retention/imports";
  "auto-postpone … low-priority *mature* cards … protecting high-priority *fragile* cards").
- [`../../CLAUDE.md`](../../CLAUDE.md) — **"Scheduling rules"** (FSRS for cards only),
  **"Priority rules"** (high-priority fragile memory protected; low-priority sacrificed first),
  **"Review rules"**, **"Data rules"** (operation log, soft delete), **"Electron runtime &
  security"** (narrow typed `window.appApi`, validated IPC, no raw DB).
- [`../architecture.md`](../architecture.md) and [`../domain-model.md`](../domain-model.md) —
  the layering + the `Element`/`card`/`review_states`/`concept` shapes.
- [`../design-system.md`](../design-system.md) — `SchedulerChip` (FSRS vs attention),
  `Retr`/`FsrsStats`, `Metric`, `Banner`, `Status`; the analytics/settings/maintenance surfaces
  these screens slot into. Match `design/tokens.css` + `lucide-react`; do not hard-code colors.

### What already exists (inspect before building — do not duplicate)

- **FSRS wrapper (T036):** `CardSchedulerService` (`packages/scheduler/src/card-scheduler.ts`).
  - Constructed with `CardSchedulerServiceOptions = { desiredRetention: number; enableFuzz?:
    boolean; params?: Partial<FSRSParameters> }` (lines 82–101). The `params` field is the
    **documented escape hatch for T080** (the index doc comment names it: "a documented escape
    hatch for the T080 FSRS-parameter optimization … a typed seam, not a runtime enum leak").
  - `desiredRetention` is a first-class input — `generatorParameters({ request_retention, … })`
    (lines 161–169). `get desiredRetention()` exposes it.
  - Pure methods: `previewIntervals(state, now)` (lines 263–280) and `gradeCard(state, rating,
    now, responseMs): ReviewOutcome` (lines 291–315). Adapters `toFsrsCard`/`fromFsrsCard`
    (lines 213–254) keep all `ts-fsrs` `State`/`Rating`/`Card` types behind this boundary. (Note:
    the wrapper does **not** currently call `ts-fsrs`'s `get_retrievability` — the queue's
    retrievability is `queue-query.ts`'s `approximateRetrievability`. T080's replay below uses
    `ts-fsrs`'s `forgetting_curve`/`get_retrievability` directly behind this boundary.)
  - **One scheduler is constructed per open DB** in the `DbService`
    (`apps/desktop/src/main/db-service.ts`), reading `defaultDesiredRetention` from
    `SettingsRepository` (the T036 wiring). **This is the seam T079/T080 generalize.**
- **`ts-fsrs@5.4.1`** (`packages/scheduler/package.json` line 23). Verified exports
  (`node_modules/.pnpm/ts-fsrs@5.4.1/.../dist/index.d.ts`): `fsrs`, `generatorParameters`,
  `createEmptyCard`, `FSRS`/`FSRSAlgorithm`, `Rating`/`State`/`Grade`, `forgetting_curve`,
  `FSRS.get_retrievability`, `FSRS.next_interval`, `FSRS.reschedule(card, reviews:
  FSRSHistory[], options)`, `FSRSReview`/`FSRSHistory`, `default_w`, `CLAMP_PARAMETERS`,
  `clipParameters`/`clamp`, `checkParameters`, `S_MIN`/`S_MAX`/`INIT_S_MAX`, `FSRSParameters`.
  **There is NO parameter optimizer / `computeParameters` / trainer** (confirmed by grep — the
  trainer lives in the separate Rust/Python `fsrs-optimizer`, not in ts-fsrs). T080 must define
  its own honest on-device evaluator (below) from these primitives — **do not pretend ts-fsrs
  optimizes for us.**
- **Settings (T011):** `AppSettings` (`packages/core/src/settings.ts`) already has
  `defaultDesiredRetention` (a `0.8`–`0.97` probability, lines 136–138 bounds), `dailyReviewBudget`,
  `SETTINGS_KEYS` (stable storage keys), `coerceSettingValue` / `appSettingsFromStored` /
  `coerceSettingsPatch` / `settingsPatchToStored`, and `DEFAULT_APP_SETTINGS`.
  `SettingsRepository` (`packages/local-db/src/settings-repository.ts`) reads/writes via
  `getAppSettings()` / `updateAppSettings(patch)` and the generic `get`/`set`/`getAll`/`setMany`
  (settings append **no** op). The renderer reaches it via `settings.*` IPC + `apps/web/src/
  pages/Settings.tsx`.
- **Priority (T005/T027):** `packages/core/src/priority.ts` — `Priority` (numeric `0.0`–`1.0`),
  `PRIORITY_LABELS` (`A`/`B`/`C`/`D`), `priorityToLabel` / `priorityFromLabel`,
  `PRIORITY_LABEL_VALUE`. A card's priority lives on `elements.priority`.
- **Concepts (T041):** `ConceptRepository` (`packages/local-db/src/concept-repository.ts`) — a
  concept is a `concept`-type element + a `concepts` row; membership is a `concept_membership`
  `element_relations` edge (`from = member`, `to = concept`). `conceptsForElement`,
  `listConcepts`, `firstConceptName`, `liveMembershipMap` are the reads T079/T080 use to resolve
  a card's concept(s).
- **Cards / review state (T006/T032/T036/T040):** `packages/db/src/schema/cards.ts` — `cards`
  (`elementId` PK, `kind`, `prompt`, `answer`, `cloze`, `sourceLocationId`, `sourceUri`,
  `mediaRef`, **`isLeech` boolean** added in T040) and `review_states` (`dueAt`, `stability`,
  `difficulty`, `elapsedDays`, `scheduledDays`, `reps`, `lapses`, `fsrsState`, `learningSteps`,
  `lastReviewedAt`) and `review_logs` (append-only: `rating`, `reviewedAt`, `responseMs`,
  `prevState`, `nextState`, `nextStability`, `nextDifficulty`, `nextDueAt`). **T040 already
  added a card-attribute column (`is_leech`)** — the precedent for T082's retirement flag.
- **Review session + repair (T037–T040):** `ReviewRepository`
  (`packages/local-db/src/review-repository.ts`: `findCardById`, `findReviewState`,
  `listReviewLogs`, `recordReview`), `ReviewSessionService`
  (`packages/local-db/src/review-session-service.ts`: `dueCards`-based deck + sibling burying),
  `CardEditService` (`packages/local-db/src/card-edit-service.ts`: `suspend`/`delete`/`flag` — the
  one-transaction + `update_element` pattern T082's retire/un-retire mirrors; the **leech toggle**
  is `DbService.markLeechCard` + the `cards.markLeech` IPC, the wiring T082's `cards.retire` mirrors
  — `CardEditService` itself has no `markLeech` method), `QueueRepository.dueCards`
  (excludes `suspended`/`deleted`/`done`/`dismissed` — T082 extends the exclusion).
- **Queue + analytics (T029/T045):** `QueueQuery` (`packages/local-db/src/queue-query.ts`) — the
  merged due read; it already computes an `approximateRetrievability(stability, lastReviewedAt,
  asOf)` (lines 137–148) using the FSRS forgetting-curve constants and a `budget` gauge
  (`{ used, target }`) from `dailyReviewBudget`. `AnalyticsService`
  (`packages/local-db/src/analytics-query.ts`) — `computeAnalytics` (`reviewsByDay`, `dueCards`,
  `dueTopics`, `retention30d` = the naive "% not-again", `leeches`). **T081 builds its
  projection alongside these reads; T080's workload preview reuses the due/budget machinery.**
- **Background runner (T058):** `apps/desktop/src/main/job-runner.ts` +
  `packages/local-db/src/jobs-repository.ts`; `JOB_TYPES`
  (`packages/core/src/enums.ts`: `url_import`/`ocr`/`epub_import`/`embed`/`ai`/`cleanup`/
  `vault_verify`/`vault_gc`) is a **closed set** with a reserved-extension precedent.
  **A heavy FSRS fit (T080) adds a new `fsrs_optimize` job type** to this set and a job-apply
  handler — the runner already runs DB-free heavy work off-thread and applies the result in main
  in one transaction. `jobs.list` + the `jobs:updated` event let the renderer observe progress.
- **IPC seam:** channels (`apps/desktop/src/shared/channels.ts`), contract
  (`apps/desktop/src/shared/contract.ts`, the `AppApiContract` groups: `settings`, `queue`,
  `cards`, `review`, `analytics`, `jobs`, …), preload, `ipc.ts`, `db-service.ts`, renderer
  client (`apps/web/src/lib/appApi.ts`). M16 adds methods to existing groups (`settings.*`,
  `cards.*`, `review.*`, `analytics.*` / a new `retention.*` + `workload.*` group) — never a
  generic `db.query`.

### What M16 (T079–T082) must add (the gaps)

- **A retention RESOLVER** (`packages/scheduler`): a pure `resolveDesiredRetention(input)` that
  picks a card's effective FSRS target from a small ordered rule set (per-card override →
  per-concept target → per-priority-band target → global default). Today only the single global
  `defaultDesiredRetention` exists.
- **Per-band + per-concept retention storage:** new `SETTINGS_KEYS` for the four band targets
  (and an enable flag); per-concept targets stored on the `concept` element (a `concepts`-row
  column or a settings sub-map). Optional per-card override column on `cards` (T082 reuses it for
  "very-low retention" retirement).
- **A per-card scheduler factory** so FSRS schedules a card against its **resolved** retention,
  not one global scheduler. Today the `DbService` builds exactly one `CardSchedulerService`.
- **An on-device FSRS evaluator + bounded search** (`packages/scheduler`): replay `review_logs`
  through candidate `FSRSParameters`, score by calibration/log-loss, suggest the best — plus a
  `workloadImpact` preview. No trainer exists in ts-fsrs.
- **A pure workload projection** (`packages/scheduler` / `packages/core`): given the live
  `review_states` + due dates and a hypothetical change, project the per-day due counts forward.
- **A retirement flag** (`cards`) + the review/due read changes that skip retired cards, with a
  reversible un-retire.

Build order is the task order, but the dependency graph is: **T079 → T081** (simulation needs
the resolver to project a retention change), **T080 → T081** (simulation previews an optimized
param set), **T082** is independent of T079–T081 (depends only on T036) and may land first or
last. The shared **retention resolver** (T079) and **per-card scheduler factory** are built in
T079 and reused by T080/T081/T082, so do T079 first.

---

## T079 — Desired retention by priority/concept

- **Status:** `[ ]`  · **Depends on:** T036, T041
- **Roadmap line:** Done when: retention targets can differ by concept or priority band.

### Goal

FSRS no longer schedules every card against one global desired-retention number. A card's
**effective target retention** is *resolved* from an ordered rule set — a per-card override, else
the card's concept target, else its A/B/C/D priority-band target, else the global
`defaultDesiredRetention` — so high-value (A) / fragile concepts can be held at, say, `0.92`
while low-value (D) / background concepts sit at `0.85` (longer intervals, less daily load). The
targets persist in SQLite, are read through the typed API, and the FSRS scheduler builds each
card's interval math against its resolved target. This is the gold-standard "per-priority/
per-concept retention" the scheduling doc names; it is a **card-only** change (the attention
scheduler is untouched).

### Context to load first

- Reference: `scheduling-and-priority.md` "Card scheduler (FSRS)" (desired retention first-class;
  per-priority/per-concept is the gold-standard phase); `CLAUDE.md` "Priority rules" (protect
  high-priority fragile memory) + "Review rules".
- Existing code to inspect: `packages/scheduler/src/card-scheduler.ts` (`desiredRetention` as a
  first-class input; the constructor builds one scheduler per retention value — line 161–169);
  `packages/core/src/settings.ts` (`AppSettings.defaultDesiredRetention`, `SETTINGS_KEYS`,
  `coerceSettingValue`, `DESIRED_RETENTION_MIN`/`MAX`); `packages/core/src/priority.ts`
  (`PRIORITY_LABELS`, `priorityToLabel`); `packages/local-db/src/concept-repository.ts`
  (`conceptsForElement`, `firstConceptName`); `apps/desktop/src/main/db-service.ts` (the single
  `CardSchedulerService` construction — the grade/preview path); `apps/web/src/pages/Settings.tsx`
  (the retention slider to extend); `packages/db/src/schema/cards.ts` + `organize.ts` (the
  `concepts` table).
- Invariants in play: FSRS = cards only; retention is resolved in **pure** code, not React;
  storage keys are stable (a rename is a migration); the resolver must always return a value in
  `[DESIRED_RETENTION_MIN, DESIRED_RETENTION_MAX]` (clamped) so a corrupt value can never reach FSRS.

### Deliverables

- [ ] **A pure retention resolver** in `packages/scheduler` (e.g.
      `packages/scheduler/src/retention.ts`, exported from `index.ts`):
      `resolveDesiredRetention(input: RetentionResolveInput): number` where
      `RetentionResolveInput = { priority: Priority; conceptNames?: readonly string[]; cardOverride?:
      number | null; targets: RetentionTargets }` and
      `RetentionTargets = { global: number; byBand?: Partial<Record<PriorityLabel, number>>;
      byConcept?: Readonly<Record<string, number>>; enabled: boolean }`. **`conceptNames` and
      `byConcept`'s key type MUST MATCH — both are concept *names* (strings), not `ElementId`s** —
      because `ConceptRepository.retentionTargets()` (below) is keyed by concept **name** (the
      `Math.max`-by-name dedup), so a `byConcept[conceptId]` lookup could never match; the per-card
      scheduler factory (below) maps a card's concept memberships → names before calling the
      resolver. Resolution order
      (first match wins): **(1)** a finite `cardOverride`; **(2)** when `enabled` and the card has
      a concept whose **name** has a `byConcept` entry — the **highest** target among the card's
      concept names (hold to the strictest concept, so a card shared by a fragile concept is
      protected); **(3)** when `enabled`, the `byBand[priorityToLabel(priority)]` target;
      **(4)** `global`. Every branch is
      clamped to `[DESIRED_RETENTION_MIN, DESIRED_RETENTION_MAX]`. When `enabled` is `false`, only
      `cardOverride` (if present) and `global` apply — bands/concepts are ignored, so toggling the
      feature off is a clean revert to T036 behavior. Deterministic; no DB, no `ts-fsrs`.
- [ ] **Storage:**
      - **Per-band targets + the enable flag** in `AppSettings`
        (`packages/core/src/settings.ts`): add `retentionByBandEnabled: boolean` (default
        `false`), `retentionByBand: Partial<Record<PriorityLabel, number>>` (default = **`{}`** /
        absent, i.e. a no-op until edited). **Do NOT default it to a filled `{ A:0.9, B:0.9, C:0.9,
        D:0.9 }` record** — `DEFAULT_APP_SETTINGS` is a static const, so a filled literal would NOT
        track a user-changed `defaultDesiredRetention` (set global to 0.85 and the bands would still
        read a stale 0.9). The resolver already treats a **missing** band entry as "inherit global"
        (`byBand?: Partial<...>`), so an **absent/empty** map = inherit, which stays correct
        dynamically. New stable `SETTINGS_KEYS` (`review.retentionByBand.enabled`,
        `review.retentionByBand`), coercion in `coerceSettingValue` (clamp each present band to the
        retention bounds; drop unknown labels; an absent label = inherit, not a stored duplicate of
        global), and inclusion in `appSettingsFromStored` / `coerceSettingsPatch` /
        `settingsPatchToStored`. Mirror the types in the renderer `AppSettings`
        (`apps/web/src/lib/appApi.ts`).
      - **Per-concept targets:** add a nullable `desiredRetention REAL` column to the `concepts`
        table (`packages/db/src/schema/organize.ts`) — a per-concept target, `null` = inherit.
        Surface it on `ConceptSummary`/`ConceptNode` (`concept-repository.ts`) and let
        `ConceptRepository` read/write it (`setConceptRetention(conceptId, value | null)` → one
        transaction + `update_element` on the concept element). Build the `byConcept` map via a new
        cheap read `ConceptRepository.retentionTargets(): Record<string, number>` keyed by concept
        **name** (matching `QueueQuery`'s name-based concept filter). **A concept name need not be
        unique** (`queue-query.ts` line ~293 documents this — multiple live concepts can share a
        name), so when several live concepts share a name with different targets, `retentionTargets`
        must collapse them **deterministically to the HIGHEST target among them** (aggregate by name
        with `Math.max` before returning the record) — never last-write-wins, which is
        order-dependent and could silently under-protect a fragile concept. This keeps the resolver's
        "strictest concept wins" rule consistent (the resolver also takes the highest among a card's
        concepts). Pin a duplicate-name case in the test.
      - **Optional per-card override:** add a nullable `desiredRetention REAL` column to `cards`
        (`packages/db/src/schema/cards.ts`) — `null` = inherit. This column is reused by T082 as an
        **optional low-retention lever** (floor-clamped — see T082); it is **not** a retirement
        mechanism, so add it here and let T082 reuse it.
      - **One Drizzle migration** (`pnpm db:generate` → `0018_*.sql`; `pnpm db:migrate`) adding
        `concepts.desired_retention` + `cards.desired_retention` (both nullable, default `null` =
        backfill-free) — **plus the `concepts.fsrs_params TEXT` column T080 needs** (a JSON-encoded
        `number[]`, nullable, `null` = inherit the global preset; folded into this same `0018`
        concepts/cards migration so T080 adds no second concepts migration — see T080). Update the
        `packages/db` schema (the new columns flow through automatically — `CardRow = typeof
        cards.$inferSelect` and the `ConceptRepository`'s `ConceptSummary` builder pick them up; there
        is **no** `rowToCard`/`rowToConcept` in `packages/local-db/src/mappers.ts` to touch, and a
        `card`'s renderer-facing shape is `CardSummary` in `apps/desktop/src/shared/contract.ts`
        — surface `desiredRetention` there, and `@interleave/core` only where a core type genuinely
        gains the field), the `ConceptSummary`/`ConceptNode` types, and the seed (T009) — optionally
        seed one A-band target + one concept target so the demo shows it.
- [ ] **A retention-targets read** in `packages/local-db` (a small `RetentionService` in
      `packages/local-db/src/retention-service.ts`, or methods on the existing settings/concept
      repos) that assembles the `RetentionTargets` for the live DB:
      `{ global: settings.defaultDesiredRetention, byBand: settings.retentionByBand, byConcept:
      concepts.retentionTargets(), enabled: settings.retentionByBandEnabled || byConcept non-empty }`.
- [ ] **A per-card scheduler factory** (the seam every FSRS call routes through) in the
      `DbService` (`apps/desktop/src/main/db-service.ts`): replace the single
      `CardSchedulerService` with a `schedulerForCard(cardElementId): CardSchedulerService` that
      resolves the card's effective retention (`resolveDesiredRetention` over the card's
      `elements.priority`, its concept memberships **mapped to names** — via
      `ConceptRepository.conceptsForElement(cardElementId)`, which returns `ConceptSummary[]` carrying
      both `id` and `name`, taking each `.name` so the `conceptNames` passed to the resolver match
      `byConcept`'s name keys — and its `cards.desiredRetention` override + the live
      `RetentionTargets`) and constructs/caches a `CardSchedulerService` for that
      retention value (cache by rounded retention so we build at most ~one scheduler per distinct
      target, not per card). The grade path (`gradeCard`) and preview path (`previewCard`,
      `previewIntervals`) both go through `schedulerForCard`. **The renderer is unchanged** — it
      still calls `review.grade` / `review.preview`; only the resolution behind them changes.
- [ ] **A `retention.*` (or extended `settings.*` + `concepts.*`) IPC surface** so the renderer
      can read/edit targets, Zod-validated, following the `settings.*` / `concepts.*` pattern:
      - `retention.get() → { global, byBandEnabled, byBand, byConcept: { conceptId, name,
        target }[] }` (read);
      - `retention.setBand({ band, target | null }) → { …updated }` and `retention.setBandEnabled({
        enabled })` (→ `settings.updateAppSettings`);
      - `retention.setConcept({ conceptId, target | null }) → { concept }`
        (→ `ConceptRepository.setConceptRetention`);
      - `retention.setCard({ cardId, target | null }) → { card }` (→ a `CardEditService` /
        `RetentionService` write of `cards.desiredRetention`, `update_element`);
      - `retention.resolveFor({ cardId }) → { target, source: "card"|"concept"|"band"|"global" }`
        (a debug/inspector read of the resolved value + which rule won).
      Wire channels + contract + preload + ipc + db-service + renderer client.
- [ ] **UI:** a **Retention** section in `/settings` (`apps/web/src/pages/Settings.tsx`) — the
      enable toggle + four band sliders (A/B/C/D, each bounded to `DESIRED_RETENTION_MIN`/`MAX`,
      showing the effective % and the implied "shorter/longer intervals" hint), and a per-concept
      target editor reachable from the concept surface (the Library concept chip / inspector).
      The inspector (T010) for a card shows the **resolved** target + its source (`retention.
      resolveFor`). Match the design tokens; no hard-coded colors.
- [ ] **Tests (Vitest, `packages/scheduler`):** `resolveDesiredRetention` — override wins over
      everything; highest concept target wins among multiple memberships; band target applies when
      no concept entry; `global` fallback; every branch clamped to the bounds; `enabled: false`
      ignores band/concept (only override + global). A smoke check that two cards (A vs D band)
      built via the factory schedule **different** intervals for the same grade (higher target →
      shorter interval), reusing the T036 "higher retention → shorter interval" assertion.
- [ ] **Tests (Vitest, `packages/local-db` / `DbService`):** the migration round-trips
      (`concepts.desired_retention` / `cards.desired_retention` nullable, default `null`);
      `RetentionService.targets()` assembles bands + concept names; **two live concepts sharing a
      name** with different targets collapse to the **highest** in `retentionTargets()`
      (deterministic, not order-dependent); `schedulerForCard` resolves the right target for a card
      by band, by concept membership, and by per-card override (against an in-memory `better-sqlite3`
      DB); `retention.setConcept` logs `update_element` and changes the resolved target; setting a
      per-card override changes the scheduled interval on the next grade; a per-card override below
      the floor is clamped **up** to `DESIRED_RETENTION_MIN` (it cannot reach a self-retiring
      "near-zero" target).
- [ ] **Playwright E2E** (`tests/electron/retention.spec.ts`): set the A-band target higher in
      `/settings`, give a card an A priority, grade it `Good`, and assert its next interval is
      **shorter** than the same grade under the default; set a concept target and confirm a card in
      that concept resolves to it (visible in the inspector); **restart the app** → the targets +
      the resulting scheduling persist.

### Done when

- A card's FSRS desired-retention target is resolved from per-card override → concept → priority
  band → global default, persisted in SQLite and read through the typed API; FSRS schedules each
  card against its **resolved** target (distinct bands/concepts produce distinct intervals).
- The resolution + clamping is pure (`packages/scheduler`), not in React; the renderer reaches
  targets only via the typed IPC; FSRS stays card-only; the attention scheduler is untouched.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the retention Playwright spec pass; targets +
  scheduling **survive app restart**.

### Notes / risks

- **Concept-target conflict:** a card can belong to several concepts. The spec resolves to the
  **highest** (strictest) target among them so the most fragile context wins — pin this in a test;
  do not average (averaging would silently under-protect a fragile card).
- **Scheduler caching:** cache `CardSchedulerService` instances by rounded retention (e.g. to
  `0.001`) so we never build one per card; rebuild on a settings/target change (bump a cache
  generation when `retention.*` writes).
- **Backfill-free migration:** both new columns are nullable `null`-default = inherit, so existing
  cards/concepts behave exactly as before until edited (no data migration, no behavior change on
  upgrade). Note that as the migration/backfill note.
- T080 reuses the resolver (to score per-concept param sets at the right target) and T082 reuses
  `cards.desired_retention` as an **optional** interval-lengthening lever (a *low*, floor-clamped
  override) — **not** the retirement mechanism. The resolver clamps every branch (including
  `cardOverride`) to `[DESIRED_RETENTION_MIN, DESIRED_RETENTION_MAX]`, so an override can never
  reach a "near-zero" target that would self-retire a card; T082's reversible `is_retired` flag is
  the source of truth for "leave active review" (see T082). Keep `resolveDesiredRetention` and the
  per-card column generic.

---

## T080 — FSRS parameter optimization

- **Status:** `[ ]`  · **Depends on:** T036
- **Roadmap line:** Done when: accumulated review history can optimize FSRS parameters per preset/
  concept, with suggested updates and a workload-impact preview.

### Goal

The user's accumulated `review_logs` are used to **fit better FSRS parameters** (the ~21-weight
`w` vector + decay — `ts-fsrs@5.4.1`'s `default_w` is 21 numbers, FSRS-6) for a preset (global) and
optionally per concept, and the app **suggests** an
update — showing the fit's quality and a **workload-impact preview** (how daily load would change
if accepted) — which the user explicitly **applies or dismisses**. Optimization is **never**
auto-applied. It runs **on-device** (a quick fit inline in main; a heavy fit on the T058 runner),
and only changes scheduling once approved. **FSRS / cards only.**

> **HONESTY NOTE (read before building).** `ts-fsrs@5.4.1` exports **no** parameter optimizer /
> trainer / `computeParameters` (verified against the package's `dist/index.d.ts`). The
> gradient-descent trainer lives in the separate `fsrs-rs` (Rust) / `fsrs-optimizer` (Python)
> projects, which we will **not** bundle, call out to a server for, or reimplement as a full
> autograd trainer in this task. **What we CAN do on-device, honestly, with the primitives
> ts-fsrs *does* export** (`forgetting_curve`, `FSRS.get_retrievability`, `default_w`,
> `CLAMP_PARAMETERS`/`clipParameters`/`clamp`, `S_MIN`/`S_MAX`, `checkParameters`,
> `FSRS.reschedule(card, FSRSHistory[])`):
> 1. **Evaluate** any candidate parameter set against the user's real history by replaying each
>    card's review sequence through FSRS and scoring the model's predicted recall probability
>    against the actual `again` vs not-`again` outcome (a proper **calibration / log-loss /
>    RMSE** metric). This is exact and cheap.
> 2. **Search** a small, bounded neighborhood of candidate parameter sets — the ts-fsrs default
>    `w` plus a handful of presets (e.g. higher/lower default-stability variants) and a bounded
>    **coordinate / hill-climb** over a few influential weights (each candidate clamped to
>    `CLAMP_PARAMETERS`) — keeping the candidate with the best score. This is a *local search over
>    a scoring function we own*, not gradient training, and we **say so** in the UI ("estimated
>    from your history" with the metric, not "optimal").
> Do **not** claim mathematical optimality. The seam is built so a real `fsrs-rs`/wasm trainer can
> drop in later behind the same `FsrsOptimizer` interface without changing callers.

### Context to load first

- Reference: `scheduling-and-priority.md` ("parameter optimization from accumulated review
  history"; even MVP stores `reps`/`lapses`/timestamps so this is addable); `CLAUDE.md`
  "Scheduling rules" + "AI-generated … must be drafts until explicitly approved" (the same
  *suggest-not-apply* discipline applies to parameter changes).
- Existing code to inspect: `packages/scheduler/src/card-scheduler.ts` (the `params:
  Partial<FSRSParameters>` escape hatch — the apply target; `toFsrsCard`/`fromFsrsCard`);
  `packages/db/src/schema/cards.ts` (`review_logs` — `rating`, `reviewedAt`, `prevState`/
  `nextState`, `nextStability` — the replay input; per-card sequences keyed by `elementId`. Note
  `review_logs` has **no per-log `elapsedDays`** — derive it from `reviewedAt` deltas — and
  `listReviewLogs` returns rows **DESC** (newest first), so re-sort ASCENDING per card before
  computing deltas); `packages/local-db/src/review-repository.ts` (`listReviewLogs`);
  `packages/local-db/src/analytics-query.ts` (`reviewsByDay` / due reads — the workload preview
  baseline); the **T058 runner** (`apps/desktop/src/main/job-runner.ts`,
  `packages/local-db/src/jobs-repository.ts`, `JOB_TYPES` in `packages/core/src/enums.ts`, the
  `jobs.list` + `jobs:updated` surface) — the heavy-fit dispatch; `packages/core/src/settings.ts`
  (presets live in settings); T079's `resolveDesiredRetention` (score per-concept sets at the
  right target).
- ts-fsrs verified API (from `dist/index.d.ts`): `generatorParameters({ w, request_retention,
  … })` → `FSRSParameters`; `fsrs(params)` → `FSRS`; `FSRS.get_retrievability(card, now, false):
  number`; `forgetting_curve(w, elapsed_days, stability): number`; `default_w` (the 21-number
  default weight vector), `CLAMP_PARAMETERS(decay)` / `clipParameters(w, decay)` / `clamp` (bounds
  each weight), `checkParameters(w)` (validates length/range), `S_MIN`/`S_MAX`/`INIT_S_MAX`;
  `FSRS.reschedule(currentCard, reviews: FSRSHistory[], { recordLogHandler })` (replays a history
  to recompute a card's state under the *current* params — used to compute the **post-apply**
  due-date shift for the workload preview). **NO optimizer export.**
- Invariants in play: optimization **suggests**, never auto-applies; it is read-only until the
  user accepts; the apply is a `settings` write (preset) / `update_element` (per-concept on the
  concept element); FSRS math + replay live in `packages/scheduler`, never React; the renderer
  observes a runner job, it never runs the fit.

### Deliverables

- [ ] **An `FsrsOptimizer` evaluator + bounded search** in `packages/scheduler`
      (`packages/scheduler/src/fsrs-optimizer.ts`, exported from `index.ts`), **pure**, no DB/IPC/
      React:
      - **Replay input:** `OptimizerHistory = { cardId: string; reviews: { rating: ReviewRating;
        reviewedAt: IsoTimestamp; elapsedDays: number }[] }[]` — built from `review_logs` (the
        service maps the rows; the evaluator stays DB-free). **Two substrate facts the
        `OptimizationService` mapper must handle (the evaluator assumes a clean, ascending input):**
        (1) `review_logs` has **no per-log `elapsedDays` column** (it stores `rating`/`reviewedAt`/
        `responseMs`/`prevState`/`nextState`/`nextStability`/`nextDifficulty`/`nextDueAt`; the
        `elapsedDays` on `review_states` is an aggregate, not per-log) — so **`elapsedDays` is
        DERIVED by diffing consecutive `reviewedAt` timestamps** per card (the first review's
        `elapsedDays` is `0`); (2) `ReviewRepository.listReviewLogs` returns rows
        `orderBy(desc(reviewedAt))` — **newest first** — so the mapper must **re-sort ASCENDING per
        card before computing the deltas**, or the `delta_t` signs invert.
      - **`scoreParameters(history, params, options): FitScore`** — replays each card's review
        sequence: for each review at `delta_t` after the previous, compute the model's predicted
        retrievability `R` (`forgetting_curve(w, delta_t, stability)` / `get_retrievability`) using
        the candidate `w`, compare to the actual outcome (recalled = rating ≠ `again`), and
        accumulate **log-loss** + **RMSE(bins)** calibration. `FitScore = { logLoss: number;
        rmse: number; reviewsScored: number }`. Lower is better. Deterministic. **Note: pass the
        FULL `w` array to `forgetting_curve` (the `parameters[]` overload, which derives the decay
        from `w[20]`); do NOT pass only the decay scalar.** The `w` here is the candidate weight
        vector, not the scalar decay — `forgetting_curve` reads decay off `w[20]` internally.
      - **`suggestParameters(history, options): OptimizationSuggestion`** — starts from `default_w`
        (and the current params), evaluates a small fixed set of presets + a **bounded
        coordinate/hill-climb** (≤ K influential weights, ≤ N steps, each candidate `clipParameters`-
        clamped + `checkParameters`-validated), and returns the best-scoring set:
        `OptimizationSuggestion = { params: FSRSParameters; baseline: FitScore; suggested: FitScore;
        improvement: number; reviewsScored: number; method: "history-calibration"; sufficientData:
        boolean }`. **`sufficientData` is `false` below a minimum review count** (e.g. `< 200`
        reviews / `< 20` cards with ≥ 3 reviews) — below that, suggest **nothing** (return the
        current params with `sufficientData: false`) so we never "optimize" on noise.
      - Keep the search budget small and bounded (it must finish in well under a second on a few
        thousand reviews when run inline; the runner path is for very large histories).
- [ ] **A `workloadImpactOf(params)` preview** (shared with T081 — build the shared projection in
      T081 and call it here, or build a minimal version here that T081 generalizes): given the live
      `review_states` and a candidate parameter set, project the **change in daily due counts** over
      the next N days (e.g. 30) by recomputing each card's next interval under the new params
      (via `FSRS.reschedule` over the card's history, or a single-step `next_interval` from its
      current stability). Return `{ before: DayCount[]; after: DayCount[]; deltaDueNext7: number;
      deltaDueNext30: number }`. **Read-only** — it recomputes in memory and writes nothing.
      **Shape bridge (do NOT pass the evaluator's `OptimizerHistory` to `reschedule`).** The pure
      `scoreParameters` replay consumes the spec's own `OptimizerHistory` (with the **derived**
      `elapsedDays` → it calls `forgetting_curve(w, delta_t, stability)` directly, which is a valid
      ts-fsrs second-overload call). But `FSRS.reschedule(card, reviews, …)` requires
      **`FSRSHistory[]`** — `{ rating: Grade; review: DateInput }` (NOT an `elapsedDays` field; ts-fsrs
      derives `delta_t` itself from the `review` timestamps). So on the `reschedule`-based projection
      path the mapper must convert each `OptimizerHistory` review to `FSRSHistory` — `reviewedAt →
      review` and `rating → Grade` (via the existing `Rating`/`Grade` adapter behind
      `card-scheduler.ts`) — and **drop** `elapsedDays`. Keep this conversion in the
      `OptimizationService`/`WorkloadService` mapper (behind the `packages/scheduler` boundary); the
      pure evaluator never sees `FSRSHistory`.
- [ ] **An `OptimizationService`** in `packages/local-db`
      (`packages/local-db/src/optimization-service.ts`) composing `ReviewRepository.listReviewLogs`
      (build `OptimizerHistory`), `FsrsOptimizer`, the `RetentionService` (T079) and the workload
      projection:
      - `suggest({ scope: "global" } | { scope: "concept"; conceptId }): OptimizationSuggestion &
        { workload: WorkloadImpact }` — builds the history (all cards, or the concept's member
        cards), runs `suggestParameters`, computes the workload impact, and returns the suggestion
        **without persisting anything**.
      - **Queryable param storage (mirror how T079 stores its targets — an op payload is NOT a
        store).** An `update_element` op payload is an **append-only audit record**, not a queryable
        column, so the accepted params must land in a **concrete, readable** place exactly like
        T079's `retentionByBand`/`concepts.desired_retention`:
        - **Global preset → a `fsrs.params.global` SETTINGS_KEY.** Add `fsrsParamsGlobal:
          number[] | null` to `AppSettings` (`packages/core/src/settings.ts`, default `null` =
          inherit ts-fsrs `default_w`) with a stable `SETTINGS_KEYS` entry
          (`review.fsrsParamsGlobal`), stored JSON-encoded; coerce it in `coerceSettingValue`
          (parse the JSON array, **validate via ts-fsrs `checkParameters` — a 21-number FSRS-6
          vector** — and fall back to `null` on a malformed/wrong-length value, the same choke-point
          discipline as the other coercions), and thread it through `appSettingsFromStored` /
          `coerceSettingsPatch` / `settingsPatchToStored` and the renderer `AppSettings`
          (`apps/web/src/lib/appApi.ts`) — **mirroring T079's `retentionByBand` additions exactly**
          (settings have no op, like the rest of T011).
        - **Per-concept preset → the `concepts.fsrs_params TEXT` column** (added in the `0018`
          migration above), JSON-encoded `number[]`, `null` = inherit global. `setConceptFsrsParams(
          conceptId, params | null)` writes it in one transaction + `update_element` (the op is the
          *audit*, the column is the *store*).
      - `apply({ scope, params }): { applied: true }` — the **only** persisting method: writes the
        accepted params to the **queryable** stores above — `scope: "global"` → the
        `fsrs.params.global` setting (via `SettingsRepository.updateAppSettings`); `scope: "concept"`
        → `concepts.fsrs_params` (+ an `update_element` audit op on the concept element) — in one
        transaction. **Read path (so resolved scheduling actually uses the optimized params):**
        `schedulerForCard` (T079) reads these stores when building a card's scheduler — it resolves
        the card's params as **`concepts.fsrs_params` (the strictest/first concept preset) override
        → `settings.fsrsParamsGlobal` → ts-fsrs `default_w`**, passes the resolved vector through
        `CardSchedulerServiceOptions.params` (the documented escape hatch), and caches the scheduler
        keyed by **(rounded retention, params signature)** so a card with a concept preset gets its
        own scheduler. Extend `RetentionTargets`/the factory to carry the optional per-scope `params`
        so the global/per-concept presets reach the factory. **Apply does not retroactively
        reschedule existing cards** in the MVP (note the deferral) — new grades use the new params;
        an optional "reschedule existing" pass is a later refinement.
- [ ] **Heavy-fit on the T058 runner:** add an `fsrs_optimize` job type to `JOB_TYPES`
      (`packages/core/src/enums.ts`) + a job-apply handler + a DB-free worker step that runs
      `suggestParameters` on a large history off the main thread; the result (the suggestion) is
      surfaced via `jobs.list` / the `jobs:updated` event, then the user applies it through
      `optimization.apply`. **A small history fits inline in main** (no job); the job path is for
      large histories so the UI never blocks. Wire it like the existing runner jobs (do not invent
      a new runner). **Adding to `JOB_TYPES` is a migration** — the `jobs.type` CHECK is built from
      that tuple (`packages/db/src/schema/jobs.ts` line 58: `check("jobs_type_check", inList(
      table.type, JOB_TYPES))`, and the `enums.ts` comment states "adding a type is a migration"),
      so this widens the CHECK and **requires a Drizzle migration** (`pnpm db:generate` →
      `pnpm db:migrate`) — fold it into the `0018` retention migration or ship it as its own
      `0018a`/separate migration; **list it in the exit-criteria migration set**. **SQLite cannot
      `ALTER` a CHECK in place**, so widening `jobs_type_check` is a **table-rebuild** migration
      (create a new `jobs` table with the wider CHECK, `INSERT … SELECT` the existing rows, drop the
      old, rename) — verify `pnpm db:generate` actually **emits that rebuild** from the schema diff
      (drizzle-kit may emit a no-op if it doesn't detect the CHECK change; if so, hand-author the
      rebuild) and that the rebuild **preserves existing `jobs` rows** (assert in the migration test).
- [ ] **An `optimization.*` IPC surface** (channels + contract + preload + ipc + db-service +
      renderer client), Zod-validated:
      - `optimization.suggest({ scope }) → OptimizationSuggestionView` (the suggestion + workload
        preview + `sufficientData`; for a large history, returns `{ enqueued: jobId }` and the
        result arrives via `jobs:updated`);
      - `optimization.apply({ scope, params }) → { applied: true }`;
      - `optimization.status()` / reuse `jobs.list` for the running fit.
- [ ] **UI:** an **Optimization** panel on the Analytics / settings maintenance surface
      (`apps/web`) — "Estimate FSRS parameters from your review history", a **Run** button (shows a
      spinner / job progress), then a result card: the metric improvement ("calibration improved
      from X to Y over N reviews"), the **workload-impact preview** (a small before/after due
      sparkline + "≈ +M cards/day for 30 days" using `Metric`/`Spark`), an **insufficient-data**
      empty state when `sufficientData` is false, and explicit **Apply** / **Dismiss** buttons.
      The copy must say "estimated from your history", never "optimal". Match the design tokens.
- [ ] **Tests (Vitest, `packages/scheduler`):** `scoreParameters` returns a finite `logLoss`/`rmse`
      and a lower score for a parameter set that fits a synthetic, deterministically-generated
      history than for an obviously-wrong set; `suggestParameters` never returns params worse than
      the baseline (it keeps the baseline if no candidate beats it); `sufficientData` is `false`
      below the minimum and the suggestion equals the current params there; every returned param
      vector passes `checkParameters` (clamped/valid). All deterministic (seeded history, fuzz off).
- [ ] **Tests (Vitest, `packages/local-db` / `DbService`):** `OptimizationService.suggest` builds
      the right history for a concept scope (only that concept's cards) and persists nothing;
      `apply` writes the queryable preset — the `fsrs.params.global` setting for a global scope, the
      `concepts.fsrs_params` column (+ an `update_element` audit op) for a concept scope — and
      `schedulerForCard` then **reads that store** and builds with the new params (assert the resolved
      scheduler's params changed, not just that an op was logged); the `fsrs_optimize` job runs and applies the
      suggestion through the runner (integration).
- [ ] **Playwright E2E** (`tests/electron/optimization.spec.ts`): with a seeded review history,
      open the Optimization panel, run the fit, see the suggestion + workload preview, **Apply**,
      and assert subsequent scheduling uses the new params (and that **Dismiss** changes nothing);
      **restart the app** → applied params persist; the insufficient-data path shows the empty state.

### Done when

- Accumulated `review_logs` produce a **suggested** FSRS parameter set per preset / per concept,
  scored against the user's real history on-device, with a workload-impact preview; the user
  explicitly applies or dismisses — **nothing is auto-applied**; an applied set changes subsequent
  scheduling and **survives app restart**.
- The fit + scoring + search live in `packages/scheduler` (pure) / `packages/local-db`; a heavy
  fit runs on the T058 runner; the renderer only observes + applies via typed IPC. FSRS stays
  card-only.
- The UI is honest ("estimated from your history", with the metric) — it never claims optimality.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the optimization Playwright spec pass.

### Notes / risks

- **ts-fsrs has no trainer (the central risk).** Do not import a non-existent `computeParameters`
  / `optimizer` from ts-fsrs (it will not type-check) and do not silently degrade to "return the
  default `w`". Build the evaluator + bounded search above; gate it behind `sufficientData`; keep
  the `FsrsOptimizer` interface clean so a real `fsrs-rs`/wasm trainer can replace the search
  later without touching callers. Record this honestly in the spec/code comments.
- **Scope the compute.** Cap the search budget (presets + a few coordinate steps); the inline
  path must finish fast, and the runner path handles large histories so the UI never blocks. Do
  not attempt full gradient descent in JS in this task.
- **Apply ≠ retroactive reschedule.** Applying new params affects future grades; rescheduling
  every existing card under new params is a heavier, optional follow-up (note the deferral). This
  keeps T080 a parameter change, not a mass mutation.
- **Per-concept fit needs enough per-concept data** — reuse the same `sufficientData` gate per
  scope; a thin concept simply has no suggestion.
- Keep the apply transactional and on the closed op set (`settings` write / `update_element`); do
  not invent an `optimize` op. **The params must live in a queryable store, not an op payload** —
  the global preset in the `fsrs.params.global` setting, the per-concept preset in the
  `concepts.fsrs_params` column (the `update_element` is the audit record, the setting/column is the
  store `schedulerForCard` reads). An `update_element` payload alone is append-only and not
  queryable, so a payload-only "apply" would never reach the scheduler.

---

## T081 — Workload simulation

- **Status:** `[ ]`  · **Depends on:** T080, T079
- **Roadmap line:** Done when: the user can preview how load changes from altering desired
  retention, adding cards, or postponing low-priority material before committing.

### Goal

Before committing a change, the user sees how their **daily workload** (cards/items due per day
over the next N days) would shift. Three levers: **(a)** altering desired retention (global, a
band, or a concept — via T079's resolver), **(b)** adding N new cards (e.g. a planned import or a
batch of new extracts), and **(c)** postponing low-priority material (the auto-postpone lever from
T077, previewed). The projection is a **pure, deterministic function** over the live
`review_states` + due dates + the hypothetical change — it writes **nothing** and is fully
unit-tested. It is the "workload simulation … before changing retention/imports" the scheduling
doc calls for, and it backs T080's apply preview and T077's catch-up/vacation cost display.

### Context to load first

- Reference: `scheduling-and-priority.md` "Overload handling" ("Workload simulation — preview how
  load changes before changing retention/imports"; "always showing the cost of postponement");
  `CLAUDE.md` "Priority rules" (low-priority sacrificed first).
- Existing code to inspect: `packages/local-db/src/queue-query.ts` (`approximateRetrievability`,
  the `budget` gauge, the due reads); `packages/local-db/src/analytics-query.ts` (`reviewsByDay`,
  `dueCards`/`dueTopics`, the day-bucketing in **local** calendar days — reuse it exactly so the
  simulation buckets the same way the analytics screen does); `packages/scheduler/src/
  card-scheduler.ts` (`previewIntervals` / `next_interval` — how a retention change moves a card's
  next interval); T079's `resolveDesiredRetention` (project a retention change); T080's
  `workloadImpactOf` (the shared projection — **build it here, generalized, and have T080 call
  it**); `packages/scheduler/src/attention-scheduler.ts` (`postponeIntervalForPriority` — the
  postpone lever for attention items); `packages/core/src/settings.ts` (`dailyReviewBudget` — the
  overload line on the chart).
- Invariants in play: **read-only** — the simulation never mutates `review_states`/`due_at`/
  settings and appends no op; pure + deterministic (the `now`/`asOf` clock is passed in); FSRS
  vs attention stay distinct in the projection (a retention change moves *cards*; a postpone lever
  moves *attention items* and/or *low-priority mature cards* per T077's rule — never cross them).

### Deliverables

- [ ] **A pure workload projector** in `packages/scheduler` (e.g.
      `packages/scheduler/src/workload.ts`, exported from `index.ts`):
      - **Input snapshot (DB-free):** `WorkloadSnapshot = { cards: { id; priority; stability;
        lastReviewedAt; dueAt; reps; conceptIds }[]; attention: { id; priority; dueAt; postponeCount;
        type }[]; budget: number; targets: RetentionTargets }` — the service builds it from the
        live tables; the projector stays pure.
      - **`projectWorkload(snapshot, change, options): WorkloadProjection`** where `change` is one
        of: `{ kind: "retention"; scope: "global"|"band"|"concept"; key?; target: number }`,
        `{ kind: "addCards"; count: number; priority: Priority; firstDueInDays?: number }`, or
        `{ kind: "postponeLowPriority"; band: PriorityLabel; days: number; includeMatureCards?:
        boolean }`. It computes, for each day in `[asOf, asOf + N)` (local-calendar bucketed like
        analytics), the **baseline** due count and the **projected** due count after the change,
        plus summary deltas: `WorkloadProjection = { days: { date: string; before: number; after:
        number }[]; overBudgetDaysBefore: number; overBudgetDaysAfter: number; peakBefore: number;
        peakAfter: number; deltaNext7: number; deltaNext30: number; budget: number }`.
        - For **retention**, recompute each affected card's next due via `next_interval` at the new
          resolved target (a higher target → shorter interval → load pulls **earlier**; lower →
          later). Use the same FSRS forgetting-curve math the queue already approximates so the
          projection matches what the user will actually see.
        - For **addCards**, distribute N new cards' first due dates (new cards become due ~now /
          `firstDueInDays`) and add a coarse learning-step cadence so the chart reflects the
          near-term spike a batch of new cards creates.
        - For **postponeLowPriority**, move the matching items' due dates out by `days` (attention
          via `postponeIntervalForPriority`-style growth; low-priority **mature** cards only when
          `includeMatureCards`, per T077's protect-fragile rule) and show the relief.
      - Deterministic; no DB, no IPC, no React. The `dailyReviewBudget` is drawn as the overload
        line (`overBudgetDays*` count days above it).
- [ ] **A `WorkloadService`** in `packages/local-db`
      (`packages/local-db/src/workload-service.ts`) that builds the `WorkloadSnapshot` from
      `QueueRepository`/`ReviewRepository`/`ConceptRepository`/`RetentionService` and calls
      `projectWorkload` — **read-only**, no transaction, no op. T080's `workloadImpactOf` becomes a
      thin wrapper over this (a `{ kind: "applyParams"; params }` change variant, or the retention
      variant when an optimization shifts effective intervals).
- [ ] **A `workload.*` IPC surface** (channels + contract + preload + ipc + db-service + renderer
      client), Zod-validated: `workload.simulate({ change, windowDays?, asOf? }) → WorkloadProjection`
      (one read command; the `change` discriminated union is validated by a Zod `discriminatedUnion`).
- [ ] **UI:** a **workload preview** affordance shown wherever a load-changing decision is made:
      next to the retention sliders (T079) in `/settings`, in T080's optimization panel, and in
      T077's catch-up/vacation flow — a small before/after area chart (reuse the analytics `Spark`/
      a bar chart) with the budget line, "peak N/day → M/day", and "X over-budget days → Y". A
      dedicated lightweight simulator (pick a lever + value → preview) can live on the Analytics /
      maintenance surface. Pure preview — a **Commit** button then performs the real change via the
      relevant existing command (retention set / import / postpone); the preview itself commits
      nothing. Match design tokens.
- [ ] **Tests (Vitest, `packages/scheduler`):** `projectWorkload` is deterministic for a fixed
      snapshot + clock; raising a retention target moves due load **earlier** (more cards in the
      near window) and lowering moves it **later**; `addCards` increases near-term peak by ~the
      added count; `postponeLowPriority` reduces near-window load and the relief respects the
      protect-fragile rule (high-priority/fragile cards are **not** moved); `overBudgetDays*` count
      days above `budget`; the projection writes nothing (no mutation possible — it's a pure fn).
- [ ] **Tests (Vitest, `packages/local-db`):** `WorkloadService.simulate` builds the snapshot from
      seeded data and returns a projection whose baseline `before` series matches the actual due
      counts the queue/analytics report for the same clock (the projection's baseline is *grounded*
      in the real reads, not a parallel guess).
- [ ] **Playwright E2E** (`tests/electron/workload.spec.ts`): open the simulator, raise the global
      retention and see the projected daily load rise (peak/over-budget increase) **without**
      changing any due date; Commit and confirm the real change then takes effect; the preview alone
      mutates nothing (re-open with no change → identical baseline).

### Done when

- The user can preview how daily load changes from altering desired retention, adding cards, or
  postponing low-priority material **before committing**; the projection is pure + deterministic,
  reads the live `review_states`/due dates, writes nothing, and its baseline matches the queue/
  analytics due counts for the same clock.
- The projector lives in `packages/scheduler` (pure); the renderer reaches it only via the typed
  `workload.simulate` IPC; FSRS and attention stay distinct in the projection.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the workload Playwright spec pass.

### Notes / risks

- **The baseline must be grounded.** The projector's `before` series must equal what the queue /
  analytics actually report for the same `asOf` (use the same local-calendar bucketing and the
  same forgetting-curve constants) — otherwise the "after" is meaningless. Pin this in a test.
- **Approximation is acceptable, drift is not.** A single-step `next_interval` projection (vs a
  full multi-grade replay) is fine for a preview as long as it is deterministic and labeled an
  estimate; don't promise exact future intervals. Keep the math identical to the scheduler's so
  the estimate tracks reality.
- **Don't cross the schedulers.** A retention lever moves cards; a postpone lever moves attention
  items (and, only with `includeMatureCards`, low-priority *mature* cards) — never reschedule a
  card via the attention heuristic in the projection.
- This projector is the shared engine for T080's apply-preview and T077's postponement-cost
  display — keep its inputs/outputs general so both consume it (don't fork three copies).

---

## T082 — Mature-card retirement

- **Status:** `[ ]`  · **Depends on:** T036
- **Roadmap line:** Done when: cards can be retired/archived/moved to very-low retention so
  low-value mature cards leave active review gracefully.

### Goal

A low-value **mature** card (high stability, low priority, well-learned) can be **retired** — it
gracefully leaves active review without being deleted or losing its lineage/history — and a
retired card is **skipped** by the due/review reads. Retirement is **reversible** (un-retire
restores it to normal scheduling). The MVP ships a single, explicit mechanism: a reversible
**`is_retired` flag** (the card drops out of the deck entirely, like `suspended` but semantically
"done with, kept for reference") — the flag is the **source of truth** for "leave active review".
A per-card **low desired-retention override** (T079's `cards.desired_retention`) can *optionally*
also be set to lengthen the card's intervals, but it is **NOT** the retirement mechanism and does
**not** self-retire: T079's resolver clamps every branch — including `cardOverride` — to
`[DESIRED_RETENTION_MIN, DESIRED_RETENTION_MAX]` (0.8–0.97), so the lowest reachable target is
`0.8` (a still-in-rotation card with modestly longer intervals), never a "near-zero / enormous
interval". A retired card is removed from the due read by the **flag**, full stop. **FSRS / cards
only.**

### Context to load first

- Reference: `scheduling-and-priority.md` "Overload handling" (auto-postpone targets low-priority
  *mature* cards; retirement is the graceful exit); `CLAUDE.md` "Priority rules" (low-priority
  sacrificed first) + "Data rules" (soft delete, undoable, do not destroy user data) + "Review
  rules".
- Existing code to inspect: `packages/db/src/schema/cards.ts` (the **`is_leech` column** added in
  T040 — the precedent for adding a card-attribute flag; `cards.desired_retention` from T079);
  `packages/local-db/src/card-edit-service.ts` (`suspend`/`delete`/`flag` — the one-transaction +
  `update_element` pattern retire/un-retire mirrors; note the **leech toggle** is
  `DbService.markLeechCard` + `cards.markLeech` IPC, **not** a `CardEditService` method);
  `packages/local-db/src/
  queue-repository.ts` (`dueCards` — already excludes `suspended`/`deleted`/`done`/`dismissed`;
  extend the exclusion to retired); `packages/local-db/src/review-session-service.ts` (the deck);
  `packages/core/src/enums.ts` (`ELEMENT_STATUSES` — note there is no `retired` status; decide
  status-vs-flag below); `packages/local-db/src/analytics-query.ts` (count retired like leeches).
- Invariants in play: retirement is **reversible** + non-destructive (never `soft_delete`); it is
  `update_element` on the closed op set (a status or `cards`-flag change); lineage + `review_states`
  + `review_logs` are preserved; FSRS stays card-only; a retired card leaves the due/review reads.

### Deliverables

- [ ] **Decide the mechanism (and document it in the spec/PR):** the MVP uses a **durable
      `is_retired` boolean flag on `cards`** (mirroring `is_leech`) **rather than** adding a new
      `retired` value to `ELEMENT_STATUSES` — adding an element status is a wider blast radius (every
      status switch, the inspector, the queue filters, the design `Status` badge set) and "retired"
      is a *card-quality* attribute like leech, not a lifecycle stage. (Note the considered
      alternative — a `retired` status — and why the flag was chosen.) Keep the card `active`/
      `scheduled` underneath so un-retire is a pure flag flip.
- [ ] **Schema:** add `cards.is_retired` (`integer … mode: "boolean"`, `notNull().default(false)`,
      with an index for the cheap "list retired" read) via a Drizzle migration (`pnpm db:generate`
      → `0019_*.sql`; `pnpm db:migrate`) — backfill-free (default `false` = no behavior change on
      upgrade). Optionally store a `retiredAt` timestamp + reason in the `update_element` op payload
      (schema-churn-free, like the flag/postpone markers) rather than new columns. Update the
      `packages/db` schema (the new column flows through automatically — `CardRow = typeof
      cards.$inferSelect` picks `isRetired` up; there is **no** `rowToCard` in
      `packages/local-db/src/mappers.ts` to edit) and surface `isRetired` on the card's
      renderer-facing `CardSummary` type in `apps/desktop/src/shared/contract.ts` (a `card`'s shape is
      `CardSummary` there, **not** in `@interleave/core` — touch `@interleave/core` only if a core
      `Card` type genuinely gains the field), and update the seed (T009 — seed one retired mature card
      so the cleanup/inventory view + tests have data).
- [ ] **A `CardRetirementService`** (or methods on `CardEditService`) in `packages/local-db`:
      - `retire({ cardId, reason? }) → { card }` — sets `cards.is_retired = true` in ONE
        transaction, logs `update_element` (payload `{ retired: true, reason?, retiredAt }`).
        Reversible; never `soft_delete`. Lineage + FSRS state untouched.
      - `unretire({ cardId }) → { card }` — clears the flag (`update_element`), restoring the card
        to the normal due read at its existing `review_states.dueAt`.
      - **Optional low-retention lever (reuse T079) — NOT the retirement mechanism:** `retire` may
        **optionally** also set `cards.desired_retention` to the **floor** (`DESIRED_RETENTION_MIN`
        = 0.8 — the lowest the T079 resolver will honor; a lower value would be clamped up to it, so
        do not pass "near-zero"), which lengthens the card's intervals somewhat if it is ever
        un-retired without clearing the override. This is a *convenience* only — the **`is_retired`
        flag is the sole source of truth** for "skip in review", and the resolver clamp means the
        override can never on its own remove a card from rotation. Keep the two independent:
        un-retire clears the flag (and the card returns to its existing `review_states.dueAt`);
        clearing the low-retention override is a separate `retention.setCard` call. (Document this
        so the two are never conflated — the flag retires, the override only lengthens.)
- [ ] **Skip retired cards in the due/review reads:** extend `QueueRepository.dueCards` (and any
      `dueCardCount`/`dueCardsBetween`/`nextCard`) to exclude retired cards. Note this is a
      **different mechanism** from the suspended exclusion: `dueCards` (queue-repository.ts:52–68)
      excludes suspended via `notInArray(elements.status, QUEUE_EXCLUDED_STATUSES)` on the
      **elements** table and only innerJoins `reviewStates → elements` — it does **not** join
      `cards`. `is_retired` lives on `cards`, so the implementer must **add an
      `innerJoin(cards, eq(cards.elementId, elements.id))` plus an `eq(cards.isRetired, false)`
      predicate** (a join + flag filter, not another status in the status filter). The review deck
      (`ReviewSessionService`) and the queue/analytics due counts then drop retired cards
      automatically. **Do not** touch the attention reads (no card-retirement logic leaks to
      sources/extracts).
- [ ] **`cards.*` IPC additions** (channels + contract + preload + ipc + db-service + renderer
      client), Zod-validated, following the existing `cards.suspend`/`cards.markLeech` pattern:
      `cards.retire({ cardId, reason? }) → { card }`, `cards.unretire({ cardId }) → { card }`, and a
      read `cards.retired() → { cards: RetiredCardSummary[] }` (live retired cards + their stability/
      priority/source, for an inventory/cleanup view) — or fold the read into the existing
      analytics/maintenance surface.
- [ ] **UI:** a **Retire** action on the card inspector (T010) and in the review repair row
      (alongside Suspend/Delete/Mark-leech) — "Retire (low-value, keep for reference)" — and an
      **Un-retire** on a retired card; a **Retired cards** inventory list on the maintenance /
      analytics surface (count + list, each with Un-retire). Surface a `retired` `Status`/badge in
      the inspector + library so a retired card reads clearly as out-of-rotation-but-kept. Match
      design tokens; reuse the existing badge/`Status` styling family.
- [ ] **Tests (Vitest, `packages/local-db` / `DbService`):** `retire` sets `is_retired`, logs
      `update_element`, and the card **drops out of `dueCards`/the review deck** while keeping its
      `review_states`/`review_logs`/lineage; `unretire` clears the flag and the card returns to the
      due read at its existing due date; a retired card never appears in the review session;
      `cards.retired()` lists only live retired cards (excludes deleted/suspended as appropriate);
      retiring never `soft_delete`s. Optionally: setting the **floor** `desired_retention`
      (`DESIRED_RETENTION_MIN`) lengthens the next interval (a *modestly* longer interval, not
      "enormous" — the resolver clamps to 0.8) via the T079 resolver, and a below-floor value is
      clamped **up** to the floor (asserting the override can NOT self-retire a card — only the
      `is_retired` flag removes it from the due read).
- [ ] **Playwright E2E** (`tests/electron/retirement.spec.ts`): retire a seeded mature card from
      the inspector/review → it disappears from review and the due queue → it shows in the Retired
      inventory → un-retire it → it returns to review; **restart the app** → the retired/un-retired
      state persists; the card's history/lineage is intact throughout.

### Done when

- A card can be retired (and un-retired) so low-value mature cards leave active review gracefully;
  retired cards are skipped by the due/review reads and the due counts; retirement is reversible,
  non-destructive (never deletes), and preserves lineage + `review_states` + `review_logs`; the
  state **survives app restart**.
- Retirement is a card flag (`update_element`, closed op set) handled in `packages/local-db`, not
  React; FSRS stays card-only; the attention reads are untouched.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the retirement Playwright spec pass.

### Notes / risks

- **Flag vs status (the key decision):** the spec chooses a `cards.is_retired` flag over a new
  `ELEMENT_STATUSES` value to keep the blast radius small and because "retired" is a quality
  attribute, not a lifecycle stage (mirrors `is_leech`). If a reviewer prefers a status, that is a
  wider change (status enum + every switch + the design `Status` set + migration) — call it out;
  do not do both.
- **Retire ≠ delete ≠ suspend:** suspend is "temporarily out, will return"; delete is soft-delete
  to trash; **retire is "done with, kept for reference, low-value"** — a distinct, reversible
  exit. Keep the three independent (a card can be un-retired without un-deleting, etc.).
- **Coordinate the migration:** T079 adds `cards.desired_retention`; T082 adds `cards.is_retired`.
  If both land in the same milestone window, they can ship as **one** migration touching `cards`
  to avoid two — but they are independent tasks, so each may ship its own (cheap, backfill-free,
  nullable/default). Note which migration carries which column.
- **Auto-retirement is out of scope here.** T082 ships the explicit, reversible retire; an
  *automatic* "retire low-value mature cards under overload" rule is the auto-postpone family
  (T077) and an analytics-driven suggestion (M17/T083/T084) — note the deferral. Retirement is the
  graceful manual exit T077 can later automate.

---

## Exit criteria for M16 (T079–T082)

- All of T079–T082 are `[x]` in [`../roadmap.md`](../roadmap.md) (alongside T076–T078 from the
  sibling overload spec).
- **Per-priority/per-concept desired retention** works: a card's FSRS target is resolved from
  per-card override → concept → band → global default, persisted in SQLite, read through the typed
  API, and FSRS schedules each card against its resolved target — distinct bands/concepts produce
  distinct intervals; the resolver is pure (`packages/scheduler`), clamped, and card-only.
- **FSRS parameter optimization** works honestly on-device: `review_logs` are replayed to **score**
  candidate parameter sets (the calibration/log-loss metric ts-fsrs's primitives support — *no*
  trainer is faked) and **suggest** an update per preset/concept with a **workload-impact preview**;
  the user explicitly applies or dismisses (**never** auto-applied); a heavy fit runs on the T058
  runner; the seam admits a real trainer later without changing callers.
- **Workload simulation** works: a pure, deterministic projection over the live `review_states` +
  due dates previews daily-load changes from altering retention, adding cards, or postponing
  low-priority material **before committing** — writing nothing, with a baseline grounded in the
  real queue/analytics due counts; it backs T080's apply-preview and T077's postponement-cost
  display.
- **Mature-card retirement** works: a reversible `cards.is_retired` flag lets low-value mature
  cards leave active review gracefully, skipped by the due/review reads, preserving lineage +
  `review_states` + `review_logs`; un-retire restores normal scheduling.
- **The two-scheduler split is intact:** every T079–T082 capability acts on `card` elements /
  `review_states` / `cards` only; no `non-card` element ever gains a `review_states`/FSRS row; the
  attention scheduler is untouched (the workload projection reads attention due dates but never
  reschedules across the boundary).
- All new capabilities reach the renderer **only** through new typed `window.appApi` commands
  (`retention.*` / extended `settings.*`+`concepts.*`, `optimization.*`, `workload.*`, extended
  `cards.*`) with Zod-validated IPC; **no raw DB/filesystem access is exposed to the renderer**,
  and no generic `db.query`. Mutations run in one transaction, append the correct **existing**
  `operation_log` op (or are settings writes / read-only), and survive **app restart**.
- Migrations (`0018` retention columns — `concepts.desired_retention` + `cards.desired_retention`
  [T079] **and `concepts.fsrs_params`** [T080] — plus the `jobs.type` CHECK widened for the
  `fsrs_optimize` job type [T080], folded into `0018` or shipped as its own; `0019` retirement flag
  — or one combined `cards` migration) are included, backfill-free, with the seed updated; `pnpm
  db:generate`/`db:migrate` succeed.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the M16 Playwright specs (retention,
  optimization, workload, retirement) are green.

When M16 is complete, generate `tasks/M17-analytics-quality.md` from the roadmap before starting
T083.

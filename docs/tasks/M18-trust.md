# M18 — Trust: staleness, source reliability & verification tasks (T090–T092)

Detailed, buildable specs for the **trust** slice of M18. Where the rest of M18
(T087–T089 semantic search + suggestions, T093–T095 on-device AI + synthesis) makes
the collection *smarter*, this slice makes it **honest about time and provenance** —
so time-sensitive knowledge cannot silently rot. Three capabilities land:

- **T090 — Staleness & expiry:** new claim-lifetime fields on the card/element model
  (`fact_stability`, `valid_from`, `valid_until`, `jurisdiction`, `software_version`,
  `review_by`) let a fact **expire** and **trigger verification**. Expiry is surfaced
  in review (a calm "this fact may be out of date" banner, post-reveal) and the
  inspector, and is the signal source for the T092 verification tasks.
- **T091 — Source-reliability metadata:** the T014 provenance row gains a source
  **type**, **tier** (primary/secondary/tertiary), **confidence**, and **notes**; the
  T043 `refblock` and the inspector surface reliability/uncertainty on important cards
  (a reliability badge + an uncertainty note) without inventing a new lineage model.
- **T092 — Verification tasks:** scheduled **`task`-type elements** ("verify this
  claim", "find better source", "update outdated card", "check current version") —
  the **existing** core element type, **attention-scheduled** (never FSRS) — give the
  user concrete maintenance work. Tasks can be **created by hand** or **generated from
  T090 expiry**; they appear in the daily queue, link back to the element they protect,
  and complete/postpone like any attention item.

Together these close the product north-star question **"when should this knowledge
return, and is it still true?"** for the long-lived collection M1–M17 built. None of
this requires a server, a model, embeddings, or the network — it is pure on-device
schema + scheduling + UI. (The *semantic* trust features — duplicate/contradiction
detection — are T088/T089 and live next to this file, not in it.)

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md)
and the roadmap header): the React **renderer** (`apps/web`) never touches SQLite, Node,
or the filesystem. Every read/mutation flows React UI → typed client wrapper
(`apps/web/src/lib/appApi.ts`) → preload bridge (`apps/desktop/src/preload/index.ts`) →
validated IPC (Zod) on the main side (`apps/desktop/src/main/ipc.ts`) → the `DbService`
(`apps/desktop/src/main/db-service.ts`) → `packages/local-db` repositories → SQLite.
Every meaningful **mutation** runs in **one transaction** and appends an
**`operation_log`** row; deletes are soft (`deleted_at`). **Staleness rules, reliability
derivation, and task scheduling live in the domain/repository layer, never in React.**

> **Operation-log discipline (load-bearing).** `OPERATION_TYPES`
> (`packages/core/src/operation-log.ts`) is a **closed, fixed set of 15** — "a rename is
> a migration." **M18-trust adds NO new op types.** The mapping:
> - editing a card's claim-lifetime fields (T090) or a source's reliability fields
>   (T091) → **`update_element`** (the fields live on the element/side-tables the
>   element owns; the edit is one `update_element` op in the same transaction as the
>   column write — exactly like every other inspector edit).
> - **creating a verification `task`** (T092) → **`create_element`** (a `task`-type
>   element; the `tasks` side-table row is written in the **same transaction**, like the
>   M8 `createConcept` pattern). Linking the task to the element it protects →
>   **`add_relation`** (a `references` edge — already in `RELATION_TYPES`).
> - **scheduling / postponing / completing** a task → **`reschedule_element`**
>   (status → `scheduled`/`done`), reusing the existing `SchedulerService` /
>   `ExtractService.postpone` machinery. Completing a task that *resolves* an expiry may
>   also `update_element` the protected card's `valid_until`/`review_by`.
> Do **not** invent `create_task` / `expire_fact` / `set_reliability` ops.

### What already exists (inspect before building — do not duplicate)

The substrate is almost entirely present; this milestone is **6 small migration
columns + 1 task side-table widening + scheduling/UI wiring**, not new infrastructure.

- **Schema (T006/T032/T014):**
  - `cards` (`packages/db/src/schema/cards.ts`): the 1:1 card side-table keyed by
    element id (`kind`, `prompt`, `answer`, `cloze`, `sourceLocationId`, `sourceUri`,
    `mediaRef`, `isLeech`, `desiredRetention`, `isRetired`). **T090 adds the
    claim-lifetime columns here** (cards are the canonical "fact" carrier); a parallel
    mirror on `elements` for non-card attention items that can also expire is an OPTIONAL,
    **deferred-by-default** extension (see the T090 migration decision).
  - `elements` (`packages/db/src/schema/elements.ts`): the universal primitive —
    `type`/`status`/`stage`/`priority`/`dueAt`/`parentId`/`sourceId`/`deletedAt`, with
    CHECK constraints derived from the `@interleave/core` tuples via `inList`
    (`_shared.ts`). `dueAt` is the attention-scheduler due time. **T090 MAY add the
    element-level expiry mirror columns here — deferred by default (cards-only is the
    default migration shape); see the T090 migration decision.**
  - `sources` (`packages/db/src/schema/sources.ts`): the T014 provenance side-table —
    `url`, `canonicalUrl`, `originalUrl`, `author`, `publishedAt`, `accessedAt`,
    `snapshotKey`, `reasonAdded`, `mediaKind`. **T091 adds `sourceType`,
    `reliabilityTier`, `confidence`, `reliabilityNotes` here.**
  - `tasks` (`packages/db/src/schema/organize.ts`): **the `task` side-table ALREADY
    EXISTS** — `elementId` (1:1, cascade), `taskType` (text), `dueAt`, `status`
    (CHECK against `ELEMENT_STATUSES`), `tasks_due_idx`. Its doc comment literally
    says *"maintenance/verification actions ('verify this claim') with their own
    scheduling."* **T092 widens it** (an optional `linkedElementId`, a `note`/reason,
    and the verification-typed `taskType`) and adds the **create/schedule/complete
    path that does not exist yet**.
  - The latest migration is `packages/db/drizzle/0020_optimal_zombie.sql`
    (journal idx 20). **Do NOT hard-code migration indices** — T087–T095 are parallel
    siblings in the same milestone built sequentially, so whichever M18 slice builds
    first consumes `0021`+ and the next consumes the next free index. **T090 adds one
    migration, T091 adds one, T092 adds one** (only for the `tasks` widening — see its
    Notes), each at **the next available index in `meta/_journal.json` at build time**.
    (T092 MAY share one migration with T090 if built together, but the build order below
    keeps them separate so each task ships its own migration.)
- **`@interleave/core` (T005):**
  - `ELEMENT_TYPES` **already includes `task`** and `synthesis_note` — no enum change.
  - `OPERATION_TYPES` (the closed 15), `RELATION_TYPES` (incl. `references`),
    `ELEMENT_STATUSES`, `Priority`/A-B-C-D, `DistillationStage`.
  - `SourceRef` + `formatSourceRef` (`packages/core/src/source-ref.ts`, T043) — the
    framework-agnostic citation model + formatter the refblock renders. **T091 extends
    `SourceRef` with the reliability fields and `formatSourceRef` to surface them.**
  - `card-quality.ts` (T086) — the `outdated-source` advisory check + the
    `SourceRecencySignals` input (`sourceDate`, `sourceIsStale`). Its doc comment says:
    *"Real fact-expiry (`valid_from`/`valid_until`/`review_by`/staleness scheduling) is
    deferred to M18/T090."* **T090 is the deferred work** — it adds the real persisted
    fields and wires `sourceIsStale`/`sourceDate` from them where the quality check runs.
- **`packages/scheduler` (T028/T029/T076):**
  - `attention-scheduler.ts`: `nextDueAt(input, now)`, `scheduleForChoice(choice, now)`
    (`tomorrow`/`nextWeek`/`nextMonth`/`manual`), `postponeIntervalForPriority(priority,
    postponeCount)`, `rawExtractIntervalDays(priority)`, `sourceIntervalDays(priority)`,
    `addDays(fromIso, days)` (`date-util.ts`). **Tasks reuse these — a task is just
    another attention `Schedulable`; do NOT add a parallel scheduler.**
- **`packages/local-db` (T008/T028):**
  - `ElementRepository` (`element-repository.ts`): `createWithin`/`createElement`
    (logs `create_element`), `update`/`updateWithin` (logs `update_element`),
    `reschedule`/`rescheduleWithin` (logs `reschedule_element`, status → `scheduled`),
    `addRelationWithin`/`removeRelation` (`references` edge, logs `add_relation`/
    `remove_relation`), `findById`, `listByType("task")`. **Reuse these — the task
    create/schedule/complete path is composition, not new SQL primitives.**
  - `SchedulerService` (`scheduler-service.ts`): the APPLY seam for the attention
    scheduler — `scheduleForChoice`, `countPostpones`, rejecting `card`. **Tasks
    schedule through it.**
  - `ExtractService.postpone` (`extract-service.ts`): the canonical postpone pattern
    (`postponeIntervalForPriority` + `reschedule_element` carrying the running postpone
    count). **Task postpone mirrors it.**
  - `inspector-query.ts` (`InspectorQuery`): assembles `InspectorData` (the element
    summary + scheduler signals + lineage + `provenance` + `sourceRef` + `location` +
    `tags` + `concepts` + `review`). **T090/T091 add the new fields to this payload;
    T092 surfaces a task's linked element + its source.**
  - `queue-query.ts` (`QueueQuery`): merges due cards (FSRS) + due attention items
    (sources/topics/extracts/**tasks**/synthesis notes) and counts per type — the
    `task` per-type count already exists (`counts.byType.task`). **`task` rows already
    flow through the attention path; T092 makes sure created tasks land here and the
    queue renders them with a task affordance.**
- **Contract / `window.appApi` (M1–M17):** the seam
  (`apps/desktop/src/shared/{contract,channels}.ts`, `preload/index.ts`,
  `main/ipc.ts`, `main/db-service.ts`, `apps/web/src/lib/appApi.ts`) exposes
  `app`/`db`/`settings`/`inspector`/`elements`/`queue`/`lineage`/`sources`/`inbox`/
  `documents`/`extractions`/`cards`/`extracts`/`review`/`readPoint`/`concepts`/`tags`/
  `search`. **There is no `tasks.*` group yet** — T092 adds it.
  - `InspectorData` (`contract.ts`) carries `provenance: SourceProvenance | null`,
    `sourceRef: SourceRef | null`, `location`, `review`. `SourceProvenance` has
    `url`/`canonicalUrl`/`originalUrl`/`author`/`publishedAt`/`accessedAt`/
    `reasonAdded`. **T091 adds the reliability fields to `SourceProvenance` + `SourceRef`.**
  - `ReviewCardView` (`contract.ts`) carries `sourceRef: SourceRef | null` (hidden
    until reveal) + `schedulerSignals` + `leech`/`lapses`/`flagged`. **T090 adds an
    `expiry` block here (kept hidden until reveal, like the ref).**
- **Renderer:**
  - `Inspector.tsx` (`apps/web/src/components/inspector/`) renders sections via
    `insp-sec`/`MetaRow`/`SchedulerChip`/`RefBlock`; the concepts/tags/export/retirement
    sections are the structural model to follow. **T090/T091 add an "Expiry" /
    "Reliability" `insp-sec`; T092 adds a "Maintenance" section listing linked tasks.**
  - `ReviewScreen.tsx` / `ReviewRepairBar.tsx` (`apps/web/src/review/`) already hide
    `answer`/`ref`/`sourceRef` until `revealed`. **T090's expiry banner rides the same
    reveal gate (it must not leak the answer); the reliability badge is part of the
    post-reveal refblock.**
  - `QueueScreen` (`apps/web/src/queue/…`) renders the merged due list with the
    FSRS-vs-attention `SchedulerChip`. **T092 renders a task row + a "Verify"/"Open"
    affordance and a jump to the protected element.**
- **`packages/testing` (T009):** `DEMO_FIXTURES` + factories
  (`packages/testing/src/factories.ts`) seed a source + extract + sub-extract + Q&A +
  cloze + review state/logs + concepts/tags. **No `task` element is seeded today**
  (only test files insert raw `task` rows). **T092 adds a seeded verification task** so
  the queue/inspector specs have a live task to exercise.

### What M18-trust must add (the gaps)

- **The claim-lifetime fields** (T090): six columns on `cards` (the fact carrier; the
  element-level mirror is an optional, deferred-by-default extension), a derivation that
  turns `valid_until`/`review_by`/
  `fact_stability` into an "expired / due-for-verification" status, and the
  review/inspector surfacing.
- **The reliability fields** (T091): four columns on `sources`, threaded into
  `SourceProvenance` + `SourceRef` + `formatSourceRef`, surfaced as a reliability
  badge + uncertainty note in the refblock + inspector.
- **The task create/schedule/complete path** (T092): a `TaskService` (or methods on an
  existing service) + a `tasks.*` `window.appApi` surface + the queue/inspector task UI
  + the **expiry → task generation** bridge from T090.

> **Dependency note (resolved).** Per the roadmap, **T090 deps T032** (card model —
> `[x]`), **T091 deps T043** (refblock — `[x]`), **T092 deps T090 + T091**. T090 and
> T091 are **independent of each other** (one touches `cards`/`elements`, the other
> `sources`) and can be built in parallel; **T092 builds on both** (it generates tasks
> from T090 expiry and shows T091 reliability when proposing a "find better source"
> task). Build order below is the task order; T090 and T091 can interleave.

Read first:
- [`../domain-model.md`](../domain-model.md) — element types (incl. `task` —
  "maintenance/verification actions"); the lineage chain `card → extract → source
  location → source metadata`; the stage-vs-status split.
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — the **two-scheduler
  split** (FSRS for cards; the **attention scheduler** for sources/topics/extracts/
  **tasks**/synthesis notes — "should the user process this again, and when?"). Tasks
  are attention-scheduled; never FSRS.
- [`../../CLAUDE.md`](../../CLAUDE.md) — "Scheduling rules" (topic/extract/task scheduler
  signals: priority, stage, last action, postpone count); "Card-quality rules"
  (time-sensitive claim with no date/version → warn); "Priority rules" (protect
  high-priority fragile memory); "Data rules" (every mutation op-logged, soft-delete).
- [`../design-system.md`](../design-system.md) — the `refblock` (source reference),
  `SchedulerChip` (FSRS vs attention), `Status`/`Prio` primitives, the inspector
  `insp-sec`/`MetaRow` structure, the queue row.
- Design kit (immutable reference): the `refblock`/`refblock__src` pattern in
  `design/kit/app/screen-review.jsx` + `screen-reader.jsx` + `screen-builder.jsx`;
  the queue rows in `design/kit/app/screen-queue.jsx` (the attention chip + the smart
  "Stale facts" filter row); `design/kit/app/components.jsx` (`SchedulerChip`, `Status`,
  `Prio`, `Tag`). There is no bespoke "expiry"/"reliability" widget in the kit — build
  these from the existing primitives (a `Status`-style badge + a `MetaRow`), matching
  the kit's restrained, dense, status-colored visual language. Do not invent a playful
  widget.

Build order is the task order. {T090, T091} (independent) → T092 (depends on both).

---

## T090 — Staleness & expiry

- **Status:** `[ ]`  · **Depends on:** T032
- **Roadmap line:** Done when: `fact_stability`, `valid_from`, `valid_until`,
  `jurisdiction`, `software_version`, `review_by` let facts expire and trigger
  verification.

### Goal

A user can mark a fact's **lifetime** — how stable the fact is (`fact_stability`), the
window it is true (`valid_from` → `valid_until`), the **jurisdiction** it applies to,
the **software version** it describes, and a **`review_by` date** by which it should be
re-checked. Cards (and other attention items) **expire** when `valid_until`/`review_by`
passes, the app **knows** a fact is stale (a derived "expired / due-for-verification"
state), and that state is **surfaced** — in **review** (a calm, post-reveal "this fact
may be out of date" banner) and the **inspector** ("Expiry" section) — and is the
**signal source** that the T092 verification-task generation consumes. Everything is
persisted, op-logged (`update_element`), and survives app restart; the renderer reaches
it only through the typed `window.appApi`.

### Context to load first

- Reference: `CLAUDE.md` "Card-quality rules" (time-sensitive claim with no date/version
  → warn) + "Scheduling rules"; `domain-model.md` (the card is the fact carrier);
  `card-quality.ts` (T086) — the `outdated-source` check + `SourceRecencySignals` that
  **explicitly defers** the real fields to this task.
- Existing code to inspect: `packages/db/src/schema/cards.ts` (the card columns to add
  to) + `elements.ts` (the element-level mirror) + `_shared.ts` (`inList` for the
  jurisdiction/stability CHECK, if used); the latest migration
  `packages/db/drizzle/0020_optimal_zombie.sql` + `meta/_journal.json` (the new one is **the next
  free index at build time** — do NOT hard-code `0021`, since T087–T095 are parallel siblings and
  an earlier-built slice may have already taken it); `packages/db/src/migrator.ts` (the dev +
  Electron-startup migrator);
  `packages/local-db/src/card-service.ts` / `card-repository.ts` (where card fields are
  written — extend the update path); `packages/local-db/src/inspector-query.ts` (the
  `InspectorData` assembly); `apps/desktop/src/main/db-service.ts` (~the review-card
  builder that fills `ReviewCardView.sourceRef` — add the `expiry` block); the contract
  (`ReviewCardView`, `InspectorData`); `apps/web/src/review/ReviewScreen.tsx` +
  `ReviewRepairBar.tsx` (the reveal gate) + `apps/web/src/components/inspector/Inspector.tsx`
  (the `insp-sec`/`MetaRow` model); `packages/core/src/card-quality.ts`
  (`SourceRecencySignals` → feed `sourceIsStale` from the derived expiry).
- Invariants in play: the new fields are **claim metadata**, not lifecycle — they do
  **NOT** add an `ELEMENT_STATUSES` value (a card stays `active`/`scheduled`
  underneath; "expired" is a *derived* attribute, like `isLeech`/`isRetired`, not a
  status). Editing them is `update_element` in one transaction. Expiry derivation is
  **pure** and lives in `@interleave/core` (a function of the fields + `now`), never in
  React. Withholding the banner until reveal is load-bearing (it must not leak the
  answer). All fields are **nullable** — a fact with no lifetime never expires (the
  vast majority of cards). No backfill (existing rows get `null`).

### Deliverables

- [ ] **A Drizzle migration (at the next free `meta/_journal.json` index at build time — do NOT
      hard-code `0021`; T087–T095 are parallel siblings and an earlier-built slice may have taken
      it)** adding the six claim-lifetime columns to `cards`
      (the fact carrier). **DEFAULT decision (pick this unless you deliberately choose otherwise):
      ship the six columns on `cards` ONLY and DEFER the element-level mirror** — it is a
      convenience, not load-bearing, and cards are the canonical fact carrier. **If you ship
      cards-only, the T092 expiry → task generation scan is correspondingly narrowed to card-backed
      facts** (the `cards_review_by_idx`/`cards.valid_until` scan). **REQUIRED build-time contract
      (do NOT leave it a build-time coin-flip):** because T090 and T092 may build separately — even in
      parallel per the dependency note below — this default is a **cross-task contract that MUST be
      written verbatim into the T090 migration's SQL comment** (e.g.
      `-- T090: claim-lifetime fields are CARDS-ONLY; the elements mirror is deferred. T092's
      generateVerificationTasks scans card-backed facts only.`). T092's `generateVerificationTasks`
      MUST read that comment and build its scan to the same shape. If a builder ships the optional
      `elements` mirror instead, the comment MUST say so and T092 MUST widen the scan to elements.
      Skipping the comment is a defect — it lets the T090 scan-surface and the T092 scan silently
      diverge. The optional `elements` mirror (so a non-card
      attention item — a `source`/`extract`/`synthesis_note` — can also carry a
      `valid_until`/`review_by` lifetime + an `elements_review_by_idx`) is a documented later
      addition; only add it (and widen the T092 scan to elements) if a sibling slice explicitly
      needs non-card expiry. Hand-author or `pnpm db:generate` then verify; register in
      `meta/_journal.json` + snapshot. Columns (all nullable, no backfill):
      - `fact_stability` — a small enum string (`stable` / `slow` / `volatile`) OR a
        nullable real if a numeric half-life is preferred. **Decide and document one**
        (recommend the enum: a `FACT_STABILITY` core tuple `["stable","slow","volatile"]`
        + an `inList` CHECK — it maps cleanly to the kit's restrained labels and avoids a
        meaningless free-form number). `null` = unspecified.
      - `valid_from` — ISO date string, the fact's start of validity, or `null`.
      - `valid_until` — ISO date string, the fact's end of validity, or `null`. When
        `now > valid_until` the fact is **expired**.
      - `jurisdiction` — free text (≤128), e.g. "US-CA" / "EU" / "global", or `null`.
        (Display only; not validated against a code list for the MVP.)
      - `software_version` — free text (≤64), e.g. "React 19" / "Postgres 18", or
        `null`. (Pairs with the `outdated-source` version heuristic.)
      - `review_by` — ISO date string, the soft re-check deadline, or `null`. When
        `now > review_by` the fact is **due for verification** (a softer signal than
        expired).
      Add `cards_review_by_idx` so the T092 generation scan
      (`WHERE review_by < now`/`valid_until < now`) is cheap (add `elements_review_by_idx` too
      only if the optional element mirror is shipped).
- [ ] **The `@interleave/core` claim-lifetime model + pure derivation**
      (`packages/core/src/fact-lifetime.ts`, with unit tests):
      - `FACT_STABILITY` tuple + `FactStability` type (if the enum is chosen).
      - `interface FactLifetime { factStability, validFrom, validUntil, jurisdiction,
        softwareVersion, reviewBy }` (all nullable).
      - `type FactExpiryStatus = "fresh" | "due_for_review" | "expired"` and a pure
        `deriveExpiryStatus(lifetime, now): FactExpiryStatus` — `expired` when
        `validUntil` is past, else `due_for_review` when `reviewBy` is past, else
        `fresh`. Robust to unparseable/empty dates (treat as absent → `fresh`), never
        throws. (Mirror the defensive date handling already in `source-ref.ts`/the
        inspector's date guard.)
      - An optional `expiryLabel(status, lifetime): string | null` for the UI ("Expired
        2025-01-01" / "Review by 2026-09-01"), framework-free.
- [ ] **Persist + read the fields** through `packages/local-db`:
      - extend the card update path (`CardService`/`card-repository.ts`) so the inspector
        edit writes the six card columns in **one transaction** logging `update_element`
        (reuse the existing card-update op path — do **not** add a new op).
      - (ONLY if the optional `elements` mirror was shipped — deferred by default) extend the
        element update path for the element-level mirror (non-card items).
      - extend `inspector-query.ts` so `InspectorData` carries the lifetime fields + the
        derived `FactExpiryStatus` (computed main-side via `deriveExpiryStatus(now)`).
      - in the review-card builder (`db-service.ts`), add `expiry: { status, validUntil,
        reviewBy, jurisdiction, softwareVersion } | null` to `ReviewCardView` (resolved
        from the card's lifetime). It travels with the card but the renderer keeps it
        **hidden until reveal** (like `sourceRef`).
      - feed the derived staleness back into card-quality: where the quality check runs
        with `SourceRecencySignals`, set `sourceIsStale = (status !== "fresh")` and
        `sourceDate` from `validFrom`/the source's `publishedAt`, so the T086
        `outdated-source` warning and the real expiry agree.
- [ ] **`tasks`/`cards` editing surface** — extend the existing card-edit `window.appApi`
      path (the inspector card editor / the builder) to accept the six fields (Zod:
      bounded strings, ISO-or-empty dates, the `FactStability` enum), validated
      main-side. **No new top-level command group** is required for T090 — it rides the
      existing card/element update command (add the fields to its request schema). (T092
      adds the `tasks.*` group.)
- [ ] **Review surfacing** (`apps/web/src/review/ReviewScreen.tsx`): after reveal, when
      `view.expiry && view.expiry.status !== "fresh"`, render a calm banner near the
      refblock — `expired` → a "This fact may be out of date (expired {date})" line with
      a status color; `due_for_review` → a softer "Due for review by {date}" line —
      using the existing `Status`/badge primitives, matching the kit's restrained style.
      It must be **absent before reveal** (load-bearing — keep the existing `revealed`
      gate). Optionally offer a one-click "Create verify task" (wired in T092).
- [ ] **Inspector surfacing** (`apps/web/src/components/inspector/Inspector.tsx`): an
      **"Expiry" `insp-sec`** (only when any lifetime field is set, or always with an
      "Add expiry" affordance) showing the derived status as a badge + `MetaRow`s for
      `valid_from`/`valid_until`/`review_by`/`jurisdiction`/`software_version`/
      `fact_stability`, with edit controls that call the extended update command. Follow
      the existing retirement/concepts section structure.
- [ ] **Seed/fixtures:** give the seeded Q&A card (or a new card) a lifetime that is
      **already past** `review_by` (and one with a future `valid_until`) so the
      inspector/review specs + the T092 generation scan have a real expired fact. Add a
      `fact_stability` to one card. Keep the rest `null`.
- [ ] **Tests (Vitest, `packages/core`):** `deriveExpiryStatus` — past `validUntil` →
      `expired`; past `reviewBy` (future/absent `validUntil`) → `due_for_review`; all
      future/absent → `fresh`; unparseable/empty dates → `fresh` (no throw);
      `expiryLabel` formats each case. The `FACT_STABILITY` tuple guard works.
- [ ] **Tests (Vitest, `packages/local-db`):** a card update writes the six columns in
      one transaction and logs **`update_element`** (not a new op); `inspector.get`
      returns the lifetime fields + the derived status; the review-card builder returns
      the `expiry` block for an expired seeded card and `null` for a no-lifetime card;
      the staleness feeds `sourceIsStale` into the quality input.
- [ ] **Tests (Vitest, renderer):** the inspector "Expiry" section renders the badge +
      rows and edits round-trip (mock `window.appApi`); in review, the expiry banner is
      **absent before reveal and present after reveal** for an expired card, and absent
      entirely for a fresh card.
- [ ] **Playwright E2E** (`tests/electron/staleness-expiry.spec.ts`): open the inspector
      on the seeded card → set `valid_until` to a **past** date + a `review_by` → the
      "Expiry" badge shows "Expired" → open `/review` on that card → the prompt shows
      **without** the expiry banner → reveal → the "out of date" banner appears →
      **restart the Electron app** → the lifetime fields persist and the card still reads
      as expired.

### Done when

- `fact_stability`, `valid_from`, `valid_until`, `jurisdiction`, `software_version`, and
  `review_by` persist on the card/element model (the new T090 migration), are
  **editable** through the typed `window.appApi` (one transaction + `update_element`),
  and a pure `deriveExpiryStatus` in `@interleave/core` turns them into `fresh` /
  `due_for_review` / `expired`.
- The expiry status is **surfaced** in review (a calm banner, **hidden until reveal**)
  and the inspector ("Expiry" section), and is exposed for **T092 verification-task
  generation** (the scan reads `review_by`/`valid_until`).
- "Expired" is a **derived attribute**, not a new `ELEMENT_STATUSES` value; all fields
  are nullable; no backfill; everything **survives app restart**.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the staleness Playwright spec pass.

### Notes / risks

- **No new op type, no new status.** Expiry is metadata + a derived attribute (like
  `isLeech`/`isRetired` in `cards.ts`). Editing the fields is `update_element`; the
  card never leaves `active`/`scheduled`. Do **not** add `expired` to `ELEMENT_STATUSES`
  (that vocabulary is closed/synced) and do **not** add an `expire_fact` op.
- **Cards are the fact carrier; the element mirror is DEFERRED by default.** Put the
  canonical six fields on `cards`. The default migration shape is **cards-only** — the
  `elements` mirror is a convenience and is deferred unless a sibling slice explicitly needs
  non-card expiry; keep the `deriveExpiryStatus` derivation generic (it takes a
  `FactLifetime`, agnostic to which table the fields came from) so adding the mirror later is
  non-breaking. **Consequence: with cards-only, the T092 generation scan covers card-backed
  facts only** — document this default in the migration comment so the two sibling slices
  resolve it consistently (do not leave it a build-time coin-flip).
- **Date handling is loose, never aggressive.** Dates are stored as-entered (ISO
  preferred) and parsed defensively (reuse the `source-ref.ts`/inspector date guard);
  an unparseable date is treated as "no constraint", never an error.
- **This is the deferred half of T086.** `card-quality.ts` already warns on
  time-sensitive language with no date; T090 makes the *real* expiry persistent and
  feeds `sourceIsStale` back. Keep the authoring-time warning (T086) and the persisted
  expiry (T090) consistent — do not duplicate the heuristic.
- **T092 consumes the scan.** Keep the `review_by`/`valid_until` indexes so the
  verification-task generation (T092) can cheaply find facts to protect. The *generation*
  itself is T092 — T090 only exposes the signal.

---

## T091 — Source-reliability metadata

- **Status:** `[ ]`  · **Depends on:** T043
- **Roadmap line:** Done when: source type, author, date, primary/secondary/tertiary,
  confidence, and notes can show reliability/uncertainty on important cards.

### Goal

A source records **how trustworthy** it is: its **type** (e.g. paper / book / blog /
docs / forum / video / personal note), its **tier** (**primary** / **secondary** /
**tertiary**), a **confidence** level (the user's trust in it), and free-text
**reliability notes** (caveats / known biases). This metadata extends the **T014
provenance** row and surfaces in the **T043 `refblock`** and the **inspector** — a
small **reliability badge** + an **uncertainty note** — so an *important* card (a card
the user relies on) carries its source's reliability/uncertainty alongside its
author/date/location. Author and date already exist (T014/T043); T091 adds type / tier /
confidence / notes and the surfacing. No new lineage model, no remote fetching — it
reuses the existing `sources` row + the `SourceRef` formatter.

### Context to load first

- Reference: `domain-model.md` "Relationships & lineage" (the source is the lineage
  root); `CLAUDE.md` "Data rules" (provenance captured at import, no auto-fetch) +
  "Card-quality rules" (missing/weak source is a quality signal); `design-system.md`
  `refblock`.
- Existing code to inspect: `packages/db/src/schema/sources.ts` (the T014 provenance
  side-table to extend) + `_shared.ts` (`inList` for the tier/type/confidence CHECK);
  `packages/core/src/source-ref.ts` (T043 — `SourceRef` + `formatSourceRef` +
  `FormattedSourceRef`; **extend both**); the main-side `resolveSourceRef` /
  `SourceProvenance` builders in `apps/desktop/src/main/db-service.ts` +
  `packages/local-db/src/inspector-query.ts` (where `provenance`/`sourceRef` are
  assembled); the contract (`SourceProvenance`, `SourceRef` re-export); the renderer
  `RefBlock` component (`apps/web/src/components/RefBlock.tsx`) + `Inspector.tsx`
  provenance rendering; the source-creation/edit path (`sources.importManual` / the
  inbox provenance editor — `apps/web` inbox + the `sources.*` commands) where these
  fields are entered; `design/kit/app/screen-review.jsx` + `screen-reader.jsx` (the
  `refblock`/`refblock__src` to enrich) + `components.jsx` (`Tag`/`Status` for the
  badge).
- Invariants in play: reliability is **provenance** (on the `sources` side-table), not
  lineage — T091 does not touch `source_locations`/`element_relations`. Editing it is
  `update_element` in one transaction (the source element owns its provenance row).
  All fields **nullable** — a source with no reliability data renders exactly as today
  (no badge), no backfill. The formatter stays framework-free in `@interleave/core`; the
  renderer only renders `FormattedSourceRef`. In **review**, the reliability badge is
  part of the **post-reveal** refblock (it rides the existing reveal gate — it must not
  leak the answer).

### Deliverables

- [ ] **A Drizzle migration (at the next free `meta/_journal.json` index at build time — do NOT
      hard-code `0022`; T087–T095 are parallel siblings and earlier-built slices consume earlier
      indices)** adding four columns to `sources` (all nullable,
      no backfill), registered in `meta/_journal.json` + snapshot:
      - `source_type` — a small enum string from a new `SOURCE_TYPES` core tuple
        (recommend `["paper","book","article","docs","reference","blog","forum","video",
        "dataset","personal_note","other"]`) + an `inList` CHECK, or `null`.
      - `reliability_tier` — enum from a `RELIABILITY_TIERS` core tuple
        `["primary","secondary","tertiary"]` + CHECK, or `null`.
      - `confidence` — enum from a `CONFIDENCE_LEVELS` core tuple
        `["high","medium","low"]` + CHECK (prefer an ordinal enum over a free-form 0–1
        number — it maps to the kit's restrained labels and the badge color), or `null`.
      - `reliability_notes` — free text (≤2048), the uncertainty/caveat note, or `null`.
- [ ] **Extend the `@interleave/core` provenance/citation model**
      (`packages/core/src/source-ref.ts` + the new tuples, with unit tests):
      - add the `SOURCE_TYPES` / `RELIABILITY_TIERS` / `CONFIDENCE_LEVELS` tuples +
        derived types.
      - add `sourceType`, `reliabilityTier`, `confidence`, `reliabilityNotes` (all
        nullable) to `SourceRef` (extend `EMPTY_SOURCE_REF` too).
      - extend `FormattedSourceRef` with a presentation-ready reliability summary, e.g.
        `reliability: { tier, confidence, label, hasUncertainty } | null` and have
        `formatSourceRef` assemble a calm label ("Primary source · high confidence",
        "Secondary · low confidence — see notes") that the badge renders. Omit cleanly
        when all fields are null (no badge). Framework-free.
- [ ] **Thread the fields through the seam:**
      - add the four fields to `SourceProvenance` (contract) and to the main-side
        provenance/`resolveSourceRef` builders (`db-service.ts` /
        `inspector-query.ts`) so `provenance` + `sourceRef` carry them.
      - extend the source-create/edit command (the `sources.*` provenance update — the
        inbox provenance editor / `sources.importManual`) request schema (Zod: the three
        enums + bounded notes) so the user can enter them, validated main-side, written
        in one transaction logging `update_element` (reuse the existing source-update
        op path — **no new op**).
- [ ] **Refblock surfacing** (`apps/web/src/components/RefBlock.tsx`): render the
      reliability badge + uncertainty note from `FormattedSourceRef.reliability` — a
      `Status`/`Tag`-style pill colored by tier/confidence + a small notes line — beside
      the existing citation/location. It appears wherever the refblock appears: the
      extract view, the inspector, the library result detail, and **review (post-reveal
      only)**. A source with no reliability data shows no badge (unchanged).
- [ ] **Inspector surfacing** (`apps/web/src/components/inspector/Inspector.tsx`): in the
      provenance section (for a **source**) and the refblock area (for an **extract/
      card**), show the reliability badge + the notes, with edit controls (the three
      enum pickers + a notes textarea) that call the extended source-update command.
- [ ] **Seed/fixtures:** give the seeded source a `reliability_tier: "secondary"`,
      `confidence: "medium"`, `source_type: "article"`, and a short `reliability_notes`
      so the refblock/inspector specs render a real badge; leave a second source (if any)
      null to prove the no-badge case.
- [ ] **Tests (Vitest, `packages/core`):** `formatSourceRef` produces the reliability
      label for each tier/confidence combination, omits it cleanly when all null, and
      sets `hasUncertainty` for `low` confidence / a present notes string; the new tuples'
      guards work.
- [ ] **Tests (Vitest, `packages/local-db` / `DbService`):** a source-update writes the
      four columns in one transaction logging `update_element`; `inspector.get` for the
      source and for a card derived from it returns the reliability fields in
      `provenance`/`sourceRef`; a source with null reliability yields a `sourceRef` with
      no reliability summary.
- [ ] **Tests (Vitest, renderer):** `RefBlock` renders the badge + notes for a reliable
      source and renders nothing extra for a null one; in review the badge appears only
      **after reveal** (it is part of the gated refblock).
- [ ] **Playwright E2E** (`tests/electron/source-reliability.spec.ts`): open the
      inspector on the seeded source → set tier = primary, confidence = high, type =
      paper, add a note → the refblock badge updates → open the inspector on a **card
      derived from that source** → the same reliability shows on the card's refblock →
      open `/review` on the card → the badge is **absent before reveal**, present after →
      **restart the Electron app** → the reliability persists.

### Done when

- A source records **type / tier (primary/secondary/tertiary) / confidence / notes**
  (the new T091 migration), editable through the typed `window.appApi` (one transaction +
  `update_element`), threaded into `SourceProvenance` + `SourceRef` and the shared
  `formatSourceRef`.
- The **refblock** and **inspector** surface a reliability badge + uncertainty note on
  sources, extracts, and **important cards** (reusing the existing lineage + the T043
  refblock), **post-reveal** in review; a source with no reliability data renders
  exactly as before (no badge).
- The citation/reliability formatting lives in `packages/core` (one source of truth, no
  React-side logic); all fields nullable, no backfill; everything **survives app
  restart**.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the reliability Playwright spec pass.

### Notes / risks

- **Reuse the T043 refblock, don't rebuild.** Author/date already live in
  `SourceRef`/`formatSourceRef`; T091 only adds type/tier/confidence/notes + the badge.
  Do not add a second citation path.
- **Enums over free-form numbers.** Tier and confidence are ordinal enums (clean badge
  colors + CHECK-constrained vocabulary that the DB and core tuple can't drift). A 0–1
  confidence float was considered and rejected (meaningless precision, no kit mapping).
- **No new op type.** Editing reliability is `update_element` on the source element.
- **The reveal gate is load-bearing.** In review the reliability badge is part of the
  refblock, which is hidden until reveal — keep the existing gate; do not show it on the
  prompt face.
- **"Important cards" = the surfacing target, not a filter.** The roadmap phrase means
  reliability *shows on cards that have a source*; it is not a request to compute
  "importance". Every card with a resolvable reliable source shows the badge.
- **Auto-classification of source type/reliability is out of scope** (it would need AI —
  that is T093+). T091 is user-entered metadata only.

---

## T092 — Verification tasks

- **Status:** `[ ]`  · **Depends on:** T090, T091
- **Roadmap line:** Done when: scheduled `task` elements ("verify this claim", "find
  better source", "update outdated card", "check current version") keep time-sensitive
  knowledge from rotting.

### Goal

A user can create — or have the app **generate** — scheduled **`task`-type elements**
that protect time-sensitive knowledge: **"verify this claim"**, **"find a better
source"**, **"update this outdated card"**, **"check the current version"**. A `task` is
the **existing** core element type, **attention-scheduled** (it answers "should the user
process this again, and when?" — **never** FSRS), **links back** to the element it
protects (the card/extract/source), appears in the **daily queue** with a task
affordance, and can be **completed**, **postponed**, or **deleted** like any attention
item. Tasks can be created **by hand** (from the inspector / a review-banner button) or
**generated from T090 expiry** (a fact past `review_by`/`valid_until` → a "verify this
claim" task) — closing the loop so stale facts surface as concrete work rather than
silently rotting. Everything is persisted, op-logged (`create_element` /
`reschedule_element` / `add_relation`), and survives restart; the renderer reaches it
only through a new typed `tasks.*` `window.appApi` surface.

### Context to load first

- Reference: `CLAUDE.md` "Scheduling rules" (the task/extract/topic attention scheduler;
  signals: priority, stage, last action, postpone count) + "Data rules" (op-logged,
  soft-delete); `scheduling-and-priority.md` (the two-scheduler split — tasks are
  attention, never FSRS); `domain-model.md` (`task` — "maintenance/verification
  actions").
- Existing code to inspect: `packages/db/src/schema/organize.ts` — the **existing
  `tasks` side-table** (`elementId`, `taskType`, `dueAt`, `status`); `packages/core/src/
  enums.ts` (`task` in `ELEMENT_TYPES`; `references` in `RELATION_TYPES`); the create
  pattern `packages/testing/src/factories.ts` `createConcept` (the canonical "element +
  side-table row in one transaction" pattern to mirror); `packages/local-db/src/
  element-repository.ts` (`createWithin`/`createElement`, `addRelationWithin`,
  `reschedule`/`rescheduleWithin`, `listByType("task")`); `packages/local-db/src/
  scheduler-service.ts` + `extract-service.ts` (the attention `schedule`/`postpone`
  pattern + `postponeIntervalForPriority` — reuse it for task scheduling/postpone);
  `packages/scheduler/src/attention-scheduler.ts` (`nextDueAt`, `scheduleForChoice`,
  `rawExtractIntervalDays`, `addDays`); `packages/local-db/src/queue-query.ts` (tasks
  already flow through the attention path; `counts.byType.task` exists) +
  `inspector-query.ts`; `packages/core/src/fact-lifetime.ts` (T090 —
  `deriveExpiryStatus`, the generation signal); the contract/preload/ipc/db-service/
  appApi seam (follow `extracts.*` / `concepts.*` exactly — there is **no `tasks.*`**
  group); `apps/web/src/queue/…` (the queue row + `SchedulerChip`) +
  `apps/web/src/components/inspector/Inspector.tsx` + `apps/web/src/review/ReviewScreen.tsx`
  (the T090 expiry banner's "Create verify task" button); `design/kit/app/screen-queue.jsx`
  (the attention row + the "Stale facts" smart filter the task list maps to).
- Invariants in play: a `task` IS an element (id/status/stage/priority/`dueAt`/
  `deletedAt`) — **no parallel object model**. It is **attention-scheduled** on
  `elements.due_at` (no `review_states` row — `SchedulerService` rejects cards, and a
  task must never get an FSRS row). Creation writes the element **and** the `tasks`
  side-table row in **one transaction** (mirror `createConcept`), logging
  `create_element`. The link to the protected element is a **`references`**
  `element_relations` edge (logs `add_relation`). Scheduling/postpone/complete is
  `reschedule_element` (status → `scheduled`/`done`). Deletes are soft. **No new op
  types, no new element type, no new status.** Generation from expiry is **idempotent**
  (one open task per (protected element, taskType) — re-running the scan must not flood
  the queue with duplicates), enforced by an **in-transaction open-task re-check + a
  partial unique index** (`tasks_open_link_type_uq` on `(linked_element_id, task_type)`
  WHERE status is open), NOT a bare read-then-create that races a concurrent trigger.

### Deliverables

- [ ] **A `TASK_TYPES` core tuple** (`packages/core/src/enums.ts` or a new
      `packages/core/src/task.ts`): `["verify_claim", "find_better_source",
      "update_outdated_card", "check_current_version", "custom"]` + a `TaskType` type +
      a guard, with a human-label map (`taskTypeLabel`) for the UI. This is the closed
      vocabulary the `tasks.task_type` CHECK references — keep it in core so the DB and
      domain can't drift.
- [ ] **A Drizzle migration (at the next free `meta/_journal.json` index at build time — do NOT
      hard-code `0023`; T087–T095 are parallel siblings, so the actual index depends on how many
      M18 migrations already landed)** widening the existing `tasks` table (registered
      in `meta/_journal.json` + snapshot):
      - add a CHECK on `task_type` against `TASK_TYPES` (it is currently free text).
      - add `linked_element_id` (text, nullable, FK → `elements.id`
        `on delete set null`, indexed) — the element the task protects (redundant with
        the `references` edge for cheap reads/joins; the edge stays the canonical
        lineage). Document the dual-modeling like `cards.source_location_id`.
      - add `note` (text, nullable, ≤2048) — the task's free-text detail ("v18 released,
        check the hook API").
      - add a **partial unique index** `tasks_open_link_type_uq` on
        `(linked_element_id, task_type)` `WHERE status NOT IN ('done','dismissed','deleted')`
        — so at most one OPEN task of a given type can protect a given element, making
        `generateVerificationTasks` idempotent at the DB level (a duplicate generation insert
        fails rather than depending on the read-check serializing). It excludes
        `linked_element_id IS NULL` (a hand-created custom task with no link is not deduped).
        **There is NO partial-unique-index precedent in this schema** — every existing
        `uniqueIndex(...)` (e.g. `ocr_pages_source_page_idx`, `tags_name_unique`,
        `document_blocks_stable_idx`) is unconditional, and every `WHERE` clause in the committed
        `0002`–`0020` migrations lives inside an **FTS trigger body**, never on an index. SQLite
        supports partial unique indexes and Drizzle 0.45.x supports `.where()` on indexes, BUT
        Drizzle's SQLite generator has historically been inconsistent about emitting the predicate.
        So this is a **build-time-verify, do-not-skip** step: after `uniqueIndex("tasks_open_link_type_uq")
        .on(table.linkedElementId, table.taskType).where(sql\`status NOT IN ('done','dismissed','deleted')\`)`
        + `pnpm db:generate`, **open the generated `.sql` and confirm the emitted DDL actually contains
        the `WHERE status NOT IN (...)` clause** (a unique index WITHOUT the predicate would wrongly
        forbid a SECOND task of the same type even after the first is `done`). If Drizzle drops the
        predicate, **hand-author the `CREATE UNIQUE INDEX ... WHERE ...` statement** in the migration
        and reconcile the snapshot. Cover it with the migration-level test (the `done`-status row does
        NOT block a fresh open one — see the T092 tests).
      - keep `status`/`due_at`/`element_id` as-is. (Note: if T090 and T092 ship
        together, the `tasks` widening MAY fold into an earlier migration — but the
        default build order gives T092 its own migration at the next free index.)
- [ ] **A `TaskService`** (`packages/local-db/src/task-service.ts`, exported from
      `index.ts`) — all transactional + op-logged, composing the existing repositories:
      - `createTask({ taskType, title, note?, linkedElementId?, priority?, dueChoice? })`
        — in **one transaction**: create the `task` element via
        `ElementRepository.createWithin` (logs `create_element`; `type: "task"`, an
        appropriate `stage` — reuse an existing stage such as `rough_topic` or document
        the chosen one; status `scheduled`; inherit the linked element's priority by
        default), insert the `tasks` row (`taskType`, `dueAt`, `status`, `linkedElementId`,
        `note`), add a `references` edge task → linkedElement via `addRelationWithin`
        (logs `add_relation`) when linked, and set `dueAt` via `scheduleForChoice`/an
        attention interval. Mirror `createConcept` exactly.
      - `listOpenTasks({ linkedElementId? })` / `listDueTasks(now)` — reads for the
        inspector's "Maintenance" section + the queue (the queue already merges attention
        items; this is the targeted read for the inspector + the generation idempotency
        check).
      - `completeTask(id)` — set the element/`tasks` status → `done` via
        `reschedule`/an update (logs `reschedule_element`); when the task *resolved* an
        expiry, OPTIONALLY bump the protected card's `review_by` forward (T090 field,
        `update_element`) — keep this an explicit caller choice, not automatic.
      - `postponeTask(id, choice)` — reschedule further out via the
        `ExtractService.postpone` pattern (`postponeIntervalForPriority` + the running
        postpone count in the `reschedule_element` payload).
      - (delete reuses the existing soft-delete element path — no task-specific delete.)
- [ ] **Expiry → task generation** (`packages/local-db/src/task-service.ts` +
      `packages/core/src/fact-lifetime.ts`): a `generateVerificationTasks(now)` method
      that scans facts whose T090 `deriveExpiryStatus(now)` is `due_for_review`/`expired`
      and **creates one `verify_claim` (or `update_outdated_card`) task per protected
      element that does not already have an open task of that type** (idempotent — the
      `listOpenTasks` guard prevents flooding). **Scan shape MUST match T090's committed migration
      shape (read its SQL comment first).** The default is **cards-only** (scan `cards` via
      `cards_review_by_idx`/`cards.valid_until`/`cards.review_by`) — confirm against the T090
      migration comment before building, since T090 and T092 may build separately/in parallel. Only
      if T090 shipped the optional `elements` expiry mirror (its comment will say so) does this scan
      widen to elements (`elements_review_by_idx`). Do NOT assume a shape; read the comment so the
      two slices cannot diverge. **The idempotency guard must not be a bare
      read-then-create across the transaction boundary (a TOCTOU race once a second trigger —
      e.g. the reserved `cleanup` job AND a manual trigger — can run concurrently): re-check
      the open-task set INSIDE the same transaction that inserts the task (the
      `listOpenTasks(linkedElementId)` read + the create are one tx), AND back it with a
      partial unique index `WHERE status NOT IN ('done','dismissed','deleted')` on
      `(linked_element_id, task_type)` in the T092 migration so a duplicate insert fails at the
      DB level rather than depending on call serialization.** (For the explicit single-trigger
      MVP the in-tx re-check alone suffices; the partial unique index makes it correct once the
      reserved auto-trigger lands — cheap to pin now.) It is **explicit/opt-in**, not a hidden
      background job for the MVP: expose it as a command the user (or a future scheduled
      runner) triggers, and ALSO offer the one-click "Create verify task" from the T090
      review banner / inspector. (A future T058-runner `cleanup`-style periodic trigger
      is reserved — note it; do not build a silent auto-generator that surprises the
      user with tasks.) The generated task is **priority-inherited** from the protected
      card so a low-priority stale fact does not dominate the queue (honors the "low
      priority sacrificed first" rule).
- [ ] **`tasks.*` `window.appApi` surface** (channels + contract + preload + ipc +
      db-service + renderer client), Zod-validated, following the `extracts.*` /
      `concepts.*` pattern exactly:
      - `tasks.create({ taskType, title, note?, linkedElementId?, priority?, dueChoice? })
        → TaskSummary`
      - `tasks.list({ linkedElementId? }) → { tasks: TaskSummary[] }`
      - `tasks.complete({ id }) → TaskSummary`
      - `tasks.postpone({ id, choice }) → TaskSummary`
      - `tasks.generateFromExpiry({}) → { created: number; tasks: TaskSummary[] }`
      - `TaskSummary = { id, taskType, title, note, status, dueAt, priority,
        linkedElement: { id, type, title } | null }`. Bounded strings; the `taskType`
        enum + the `dueChoice` enum (`tomorrow`/`nextWeek`/`nextMonth`/`manual`) reuse
        the scheduler's `ScheduleChoice`. No generic `db.query`.
- [ ] **Queue UI** (`apps/web/src/queue/…`): render due `task` rows with a task icon
      (lucide per `design/icon-map.md`), the `taskTypeLabel`, the attention
      `SchedulerChip`, and a "Verify"/"Open" affordance that **jumps to the linked
      element** (reuse the existing inspector-open / jump-to-source navigation) plus
      complete/postpone actions. Tasks already pass through the merged due read — ensure
      they render distinctly, not as a bare element.
- [ ] **Inspector UI** (`apps/web/src/components/inspector/Inspector.tsx`): a
      **"Maintenance" `insp-sec`** on a card/extract/source listing its open tasks
      (`tasks.list({ linkedElementId })`) with complete/postpone, plus a **"Create
      verification task"** control (a `taskType` picker + note + schedule choice). The
      T090 review banner's "Create verify task" button calls `tasks.create` with
      `taskType: "verify_claim"` + the card's id.
- [ ] **Seed/fixtures** (`packages/testing/src/factories.ts`): seed **one open
      `verify_claim` task** linked (a `references` edge + `linkedElementId`) to the
      seeded expired card from T090, due today, so the queue/inspector specs have a live
      task. (This is the first seeded `task` element.)
- [ ] **Tests (Vitest, `packages/local-db`):** `createTask` writes the element
      (`create_element`) + the `tasks` row + the `references` edge in **one
      transaction**, sets an attention `dueAt`, and inherits the linked element's
      priority; the new task has **no `review_states` row** (never FSRS);
      `completeTask`/`postponeTask` log `reschedule_element` and move status correctly;
      `generateVerificationTasks` creates a task for an **expired** seeded card and is
      **idempotent** (a second run creates none — the in-transaction open-task re-check + the
      `tasks_open_link_type_uq` partial unique index; assert a direct duplicate-open-task insert
      for the same `(linked_element_id, task_type)` is rejected by the index, and that a task whose
      status is `done`/`dismissed` does NOT block a fresh open one); a non-expired
      card generates nothing; `listOpenTasks`/`listDueTasks` resolve correctly; soft-delete
      of a task works.
- [ ] **Tests (Vitest, `DbService` / contract):** the `tasks.*` handlers validate
      payloads (reject empty title / oversized note / bad `taskType`) and return
      `TaskSummary` with the resolved `linkedElement`; `tasks.generateFromExpiry` returns
      the created count.
- [ ] **Tests (Vitest, renderer):** the queue renders a task row with the label + chip +
      jump affordance; the inspector "Maintenance" section lists the open task and creates
      a new one (mock `window.appApi.tasks`).
- [ ] **Playwright E2E** (`tests/electron/verification-tasks.spec.ts`): from the seeded
      expired card's inspector, **create a "verify this claim" task** → it appears in the
      inspector's Maintenance section AND in the **daily queue** as a task row →
      **complete** it from the queue → it leaves the due list (status `done`) → run
      "generate from expiry" → a task is created for the still-expired card and a second
      run creates **no duplicate** → **restart the Electron app** → the remaining task +
      its link to the card persist.

### Done when

- Scheduled **`task`-type elements** (`verify_claim` / `find_better_source` /
  `update_outdated_card` / `check_current_version` / `custom`) can be **created** (by
  hand and **generated from T090 expiry**), **linked** to the element they protect (a
  `references` edge + `linked_element_id`), **scheduled / postponed / completed** on the
  **attention** scheduler (never FSRS, no `review_states` row), and appear in the daily
  queue + the inspector — through the typed `tasks.*` `window.appApi`, each action one
  transaction + the correct **existing** op (`create_element` / `add_relation` /
  `reschedule_element`).
- Expiry-driven generation is **idempotent** (one open task per protected element +
  type), **priority-inherited** (a low-priority stale fact does not dominate the queue),
  and **explicit/opt-in** (no silent surprise tasks).
- The `task` element type, the `tasks` side-table, and the attention scheduler are
  **reused** — no new element type, status, op type, or parallel scheduler; everything
  **survives app restart**.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the verification-tasks Playwright spec
  pass.

### Notes / risks

- **`task` is an existing element type; the side-table exists.** T092 is **wiring +
  scheduling + UI + a `tasks` widening migration**, not a new model. Mirror the M8
  `createConcept` "element + side-table row in one transaction" pattern; do not invent a
  `create_task` op or a `TaskRepository` parallel to `ElementRepository`.
- **Attention, never FSRS (load-bearing).** A task schedules on `elements.due_at` via
  `SchedulerService`/the attention interval helpers; it must never get a `review_states`
  row. `SchedulerService` already rejects cards — keep tasks on the same attention path
  and assert "no FSRS row" in a test.
- **Generation must not flood the queue.** Idempotency is enforced by the
  **in-transaction open-task re-check** (the `listOpenTasks` read + the create run in the
  SAME tx) **backed by the `tasks_open_link_type_uq` partial unique index** — so it stays
  correct even if a future second trigger (the reserved `cleanup` job AND a manual run)
  fires concurrently, rather than relying on the read-check serializing. Priority
  inheritance keeps low-value stale facts from dominating (the "low priority sacrificed
  first during overload" rule). Generation is explicit/opt-in for the MVP — a periodic
  auto-trigger on the T058 runner (a `cleanup` job type) is **reserved/deferred**; note it,
  don't build a silent surprise generator.
- **Completing a task may resolve an expiry, but do it explicitly.** When the user
  completes an `update_outdated_card`/`verify_claim` task, OPTIONALLY bump the protected
  card's `review_by`/`valid_until` (T090) in the same flow — but as an explicit choice
  surfaced in the UI, not an automatic side effect (the user may complete a task without
  having actually refreshed the fact).
- **The link is dual-modeled.** The `references` edge is the canonical lineage; the
  `linked_element_id` column is a denormalized convenience for cheap inspector/queue
  reads (like `cards.source_location_id`). Keep them consistent in the create
  transaction.
- **A rich task-management screen is deferred.** The MVP surfaces tasks in the **queue**
  + the **inspector**; a dedicated "/maintenance" task board is M17/T099-adjacent and
  out of scope here. The kit's "Stale facts" smart-filter row (queue) is the natural
  home — render it if cheap, otherwise note the deferral.

---

## Exit criteria for M18-trust (T090–T092)

- All of T090–T092 are `[x]` in [`../roadmap.md`](../roadmap.md).
- **Staleness & expiry (T090):** `fact_stability` / `valid_from` / `valid_until` /
  `jurisdiction` / `software_version` / `review_by` persist (the new T090 migration), are
  editable through the typed `window.appApi` (one transaction + `update_element`), and a
  pure `deriveExpiryStatus` in `@interleave/core` turns them into `fresh` /
  `due_for_review` / `expired` — surfaced in review (a calm banner, **hidden until
  reveal**) and the inspector, and exposed for T092 generation. "Expired" is a derived
  attribute, **not** a new status.
- **Source-reliability metadata (T091):** sources record **type / tier
  (primary/secondary/tertiary) / confidence / notes** (the new T091 migration), threaded
  into `SourceProvenance` + `SourceRef` + the shared `formatSourceRef`, and shown as a
  reliability badge + uncertainty note in the **refblock** and **inspector** on sources,
  extracts, and important cards (**post-reveal** in review) — reusing the T043 refblock,
  no new lineage model. Null-everywhere renders exactly as before.
- **Verification tasks (T092):** scheduled **`task`-type elements** keep time-sensitive
  knowledge from rotting — created by hand or **generated from T090 expiry**
  (idempotent, priority-inherited, opt-in), **linked** to the protected element
  (`references` edge + `linked_element_id`), **attention-scheduled** (never FSRS),
  visible in the daily queue + the inspector, and completable/postponable — through the
  new typed `tasks.*` `window.appApi`. No new element type, status, op type, or parallel
  scheduler.
- All new capabilities reach the renderer **only** through the typed `window.appApi`
  (the extended card/element/source update commands + the new `tasks.*` group) with
  Zod-validated IPC; **no raw DB/filesystem access is exposed to the renderer**, and no
  generic `db.query`. Every mutation is one transaction + the correct **existing** op
  (`update_element` / `create_element` / `add_relation` / `reschedule_element`) — **no
  new op types**.
- Everything **survives app restart**.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the M18-trust Playwright specs
  (staleness expiry; source reliability; verification tasks) are green.

When this slice is complete, the remaining M18 tasks (T087–T089 semantic search +
suggestions + contradiction detection; T093–T095 on-device AI distillation + grounding +
synthesis notes) are specified in the sibling on-device-AI/semantic-search task files
referenced from [`../roadmap.md`](../roadmap.md) (M18 header) — they are **out of scope
for this file** and share the same local-first, drafts-only, lineage-sacred invariants.

# M5 — Priority, scheduling & queue (T027–T031)

Detailed, buildable specs for the fifth milestone. M4 produced a stream of independent,
attention-scheduled extracts (each with a `due_at`, an inherited priority, and a postpone
counter); M5 makes that stream **steerable and processable**. It promotes priority to a
first-class, editable axis on every element (T027); replaces the ad-hoc interval helpers that
currently live inside `extract-service.ts`/`extraction-service.ts` with a single, tested
**attention scheduler** in `packages/scheduler` (T028); surfaces everything due in a real
`/queue` screen sorted priority-then-due-date with type/concept/status filters (T029); makes
every due row act in place — open / postpone / raise / lower / done / dismiss / delete (T030);
and finally wraps the queue in a **single-element "Process queue" loop** so a user can grind
through ten mixed sources/extracts/cards without ever returning to a list (T031).

After M5 the app has its **daily loop**: import → triage → read → extract → distill (M2–M4)
now feeds a queue that actually schedules, prioritizes, and presents work one item at a time.
Cards (M6) and FSRS (M7) slot into the *same* queue/loop afterward — M5 builds the
attention-side and the queue shell so the FSRS side only has to fill in the card scheduler.

**The two-scheduler split is the load-bearing invariant of this milestone**
(see [`../scheduling-and-priority.md`](../scheduling-and-priority.md)). There are two
schedulers answering two different questions, and M5 must never collapse them:

| Scheduler | Applies to | Question | Engine | Due field | Milestone |
|-----------|-----------|----------|--------|-----------|-----------|
| **Attention** | `source`, `topic`, `extract`, `task`, `synthesis_note` | *Should I process this again, and when?* | custom, priority-based (**T028, this milestone**) | `elements.due_at` | M5 |
| **FSRS** | `card` only | *Can I recall this?* | `ts-fsrs` (**T036, deferred to M7**) | `review_states.due_at` | M7 |

The attention scheduler computes from **priority + stage + last-seen + last-action +
postpone-count**; it **never** writes a `review_states`/FSRS row. FSRS schedules cards only and
persists on `review_states`. The `SchedulerChip` (already built in
`apps/web/src/components/inspector/primitives.tsx`) renders whichever applies. An extract must
**never** get an FSRS row; a card is scheduled by FSRS, never the attention heuristic.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md) and
the roadmap header): the React **renderer** (`apps/web`) never touches SQLite, Node, or the
filesystem. Every mutation flows React UI → typed client wrapper
(`apps/web/src/lib/appApi.ts`) → preload bridge (`apps/desktop/src/preload/index.ts`) →
validated IPC (Zod) on the main side (`apps/desktop/src/main/ipc.ts`) → the `DbService`
(`apps/desktop/src/main/db-service.ts`) → `packages/local-db` repositories + the new
`packages/scheduler` service → SQLite. Every meaningful mutation runs in **one transaction**
and appends an **`operation_log`** row; deletes are soft (`deleted_at`); **all scheduling math
lives in `packages/scheduler`, never in a React component**.

Read first:
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — **authoritative** for the
  attention scheduler heuristics + the priority model. The starter intervals (by priority for
  sources, by stage for extracts), the rescheduling-by-action table, the "sort by priority then
  due date + 10–20% randomness" queue rule, and the protect-high / sacrifice-low priority rules
  all come from here.
- [`../domain-model.md`](../domain-model.md) — `elements` columns (`priority`, `due_at`,
  `status`, `stage`), priority model, "High-priority fragile memory is protected".
- [`../design-system.md`](../design-system.md) — `Prio`, `SchedulerChip` (the FSRS-vs-attention
  split), `BudgetMeter`, `qitem` (queue row + `--protected` accent bar), the screen→route map
  (`screen-queue` → `/queue` → M5).
- [`../../CLAUDE.md`](../../CLAUDE.md) — "Scheduling rules", "Priority rules", "Architectural
  rules", "Electron runtime & security".
- Design kit (immutable reference): `design/kit/app/screen-queue.jsx` (`QueueScreen`,
  `QueueItem`/`qitem`, the filter chips, `BudgetMeter`, the `next-action` affordance, the
  "Today's status" inspector), `design/kit/app/components.jsx` (`Prio`, `Status`,
  `SchedulerChip`, `BudgetMeter`, `Stage`, `TypeIcon`), `design/kit/styles/app.css` (`.qitem`,
  `.qitem--protected::before` accent bar, `.budget`, `.next-action`, `.chip`), and the
  screenshots `design/kit/screenshots/queue.png` + `q2.png`.

### What already exists (inspect before building — do not duplicate)

The earlier milestones built more of M5's substrate than the roadmap implies:

- **Priority helpers (T005) — `packages/core/src/priority.ts`:** numeric `Priority`
  (`0.0`–`1.0`), `PRIORITY_LABELS` (`A/B/C/D`), `PRIORITY_LABEL_VALUE` (A=0.875, B=0.625,
  C=0.375, D=0.125), `DEFAULT_PRIORITY` = C, and the bidirectional `priorityFromLabel` /
  `priorityToLabel` / `isPriorityLabel`. **T027 reuses these verbatim — do not add new priority
  math.** The renderer already has a mirrored `priorityLabel()` + `Prio` badge/dot in
  `apps/web/src/components/inspector/primitives.tsx`, and `PriorityLabelSchema`
  (`z.enum(["A","B","C","D"])`) already exists in `apps/desktop/src/shared/contract.ts`.
- **`ElementRepository` priority + reschedule (T008) — `packages/local-db/src/element-repository.ts`:**
  `update(id, { priority })` (logs `update_element`), `reschedule(id, dueAt)` /
  `rescheduleWithin(tx, id, dueAt, status?, opExtras?)` (logs `reschedule_element`, with the
  `opExtras` seam already used to persist `{ postpone: true, postponeCount }` into the op
  payload — no schema migration), `softDelete` (`soft_delete_element`), `restore`
  (`restore_element`), `update(id, { status })` (`update_element`). **T027/T028/T030 compose
  these — do not add parallel mutation paths.**
- **`QueueRepository` (T008) — `packages/local-db/src/queue-repository.ts`:** already keeps the
  two schedulers separate. `dueCards(asOf, limit)` joins `review_states.due_at` for FSRS cards;
  `dueAttentionItems(asOf, limit)` reads `elements.due_at` for non-card items; `nextCard`,
  `dueCardCount`, `inbox`. **T029 extends/uses this for the unified, sorted, filtered queue read
  — keep the FSRS join and the attention read distinct inside it.**
- **Attention-scheduling math currently lives inline in `packages/local-db`** and **must move
  to `packages/scheduler` in T028:** `extract-service.ts` has `EXTRACT_STAGES`,
  `nextExtractStage`, `extractStageIntervalDays(stage, priority)` (raw `+1..7d`, clean `+3..14d`,
  atomic `+1d`), `postponeIntervalDays(priority)` (`+7..30d`), `addDays`, and `countPostpones`
  (scans `reschedule_element` ops for the `postpone` marker); `extraction-service.ts` has
  `rawExtractIntervalDays(priority)`. T028 consolidates these into one tested scheduler and has
  `ExtractService`/`ExtractionService` call **into** it (rather than re-deriving intervals).
- **`packages/scheduler` is still a stub** — `packages/scheduler/src/index.ts` exports only
  `SCHEDULER_PACKAGE`/`schedulerPlaceholder` and the package has no real `test`/`build`/`lint`
  scripts wired (`package.json` echoes placeholders, `typecheck` runs `tsc`). T028 fills it in
  and wires real scripts so Turbo runs its Vitest tests.
- **`SchedulerChip` + `BudgetMeter` UI:** `SchedulerChip`/`Prio`/`Status`/`Stage`/`TypeIcon`/
  `FsrsStats` already exist in `apps/web/src/components/inspector/primitives.tsx` with CSS in
  `apps/web/src/components/inspector/inspector.css` (`.sched--fsrs`/`.sched--attn`). **The
  `BudgetMeter` component and the `qitem` row are NOT built yet** — `/queue` is still a
  `Placeholder` in `apps/web/src/router.tsx`. T029 builds them.
- **The appApi pattern (M2–M4):** new capabilities are added across six files in lockstep —
  `apps/desktop/src/shared/channels.ts` (channel string), `.../shared/contract.ts` (Zod request
  schema + result type + `AppApi` method), `.../preload/index.ts` (preload method),
  `.../main/ipc.ts` (validated handler), `.../main/db-service.ts` (`DbService` method calling a
  repo/service), and `apps/web/src/lib/appApi.ts` (renderer client + mirrored types). The
  `extracts.*` / `inbox.triage` groups are the exact precedent to copy.

> **Operation-log discipline (read before adding any op).** `OPERATION_TYPES`
> (`packages/core/src/operation-log.ts`) is a **closed, fixed set of 15** — "a rename is a
> migration." M5 introduces **no new op types**. The mappings are: raise/lower priority →
> **`update_element`**; reschedule / postpone (attention) → **`reschedule_element`** (postpone
> count carried in the op `payload` via the existing `opExtras` seam — no schema change);
> mark done → **`update_element`** (status `done`); dismiss → **`update_element`** (status
> `dismissed`); delete → **`soft_delete_element`**. Do **not** invent `set_priority` /
> `postpone` / `dismiss` op types.

Build order is the task order; each depends on the prior as the roadmap states. T027 and the
T028 scheduler can be developed together, but T028's reschedule paths assume T027's priority
edits exist, and T029→T031 build strictly on top.

---

## T027 — Priorities

- **Status:** `[ ]`  · **Depends on:** T008
- **Roadmap line:** Done when: priority is stored numerically and surfaced as A/B/C/D; every
  source/extract/card can be raised/lowered.

### Goal

Priority becomes a **first-class, editable axis** on every element. It is already stored
numerically (`elements.priority`, `0.0`–`1.0`) and surfaced as A/B/C/D in the inspector; this
task adds the *write* path — from any source, extract, or card (and tasks/topics/synthesis
notes), the user can **raise** or **lower** priority (step up/down a band) or **set** an explicit
A/B/C/D label, through a single typed `window.appApi` command that updates the numeric value and
logs `update_element`. The change is reflected immediately in the inspector `Prio` badge and is
read by the attention scheduler (T028) and the queue sort (T029).

### Context to load first

- Reference: [`../scheduling-and-priority.md`](../scheduling-and-priority.md) "Priority model"
  (numeric internally, A/B/C/D in UI; protect high, sacrifice low; new material must not
  dominate); [`../domain-model.md`](../domain-model.md) priority model; `CLAUDE.md` "Priority
  rules".
- Existing code to inspect: `packages/core/src/priority.ts` (`priorityFromLabel`,
  `priorityToLabel`, `PRIORITY_LABELS`, `PRIORITY_LABEL_VALUE`, `DEFAULT_PRIORITY`) — **reuse,
  add nothing**; `packages/local-db/src/element-repository.ts` (`update(id, { priority })` logs
  `update_element`); `apps/desktop/src/shared/contract.ts` (`PriorityLabelSchema`, the
  `inbox.triage` `setPriority` action precedent); `apps/web/src/components/inspector/primitives.tsx`
  (`Prio`, `priorityLabel`) + `Inspector.tsx` (the `priority` `MetaRow`); the design kit `Prio`
  (`design/kit/app/components.jsx`) and the inbox screen's A/B/C/D chip group
  (`apps/web/src/pages/inbox/InboxScreen.tsx`).
- Invariants in play: priority stored **numerically**, A/B/C/D is *display only*; every write is
  one transaction + `update_element`; raise/lower must be defined in a tested core helper, not
  inline in React.

### Deliverables

- [ ] **Raise/lower band helpers in `packages/core/src/priority.ts`** (next to the existing
      conversions, framework-agnostic + tested): `raisePriority(p: Priority): Priority` and
      `lowerPriority(p: Priority): Priority` that step to the next/previous A/B/C/D band's
      representative value (A↔B↔C↔D, clamped at the ends so raising A is a no-op and lowering D is
      a no-op). Keep them deterministic so raise-then-lower round-trips. Export from
      `packages/core/src/index.ts`. Unit tests in `packages/core/src/priority.test.ts` cover
      every band transition + the clamps.
- [ ] **A reusable `setElementPriority` mutation** — extend `ElementRepository` with a thin
      `setPriority(id, priority): Element` (or reuse `update(id, { priority })`) that runs in one
      transaction and logs `update_element`. (The existing `update` already does this; prefer it
      and only add a named wrapper if it improves call-site clarity.) Must work for **any**
      element type (source/extract/card/task/topic/synthesis_note) — priority is universal.
- [ ] **New `window.appApi` surface `elements.setPriority`** added across all six files:
      `channels.ts` (`elementsSetPriority: "elements:setPriority"`), `contract.ts`
      (`ElementsSetPriorityRequestSchema` = `{ id: ElementIdSchema, action }` where `action` is a
      discriminated union `{ kind: "set", priority: PriorityLabelSchema }` /
      `{ kind: "raise" }` / `{ kind: "lower" }`, plus an `ElementsSetPriorityResult` carrying the
      updated element summary incl. the new numeric `priority` + derived label; add the method to
      the `AppApi` `elements` group), `preload/index.ts`, `ipc.ts` (validated handler), the
      `DbService` (loads the element, computes the new numeric priority via
      `priorityFromLabel`/`raisePriority`/`lowerPriority`, calls `ElementRepository.update`), and
      the renderer client `apps/web/src/lib/appApi.ts` (mirrored types + `appApi.elements.setPriority`).
      There is no `elements` group on `AppApi` yet — create it (the inspector currently reads via
      `inspector.*`); `elements.setPriority` is its first member.
- [ ] **Inspector wiring:** the inspector's priority row (`Inspector.tsx`) gets an editable A/B/C/D
      control (an inline `Prio`-styled segmented chip group, matching the inbox screen's priority
      chips) that calls `elements.setPriority` with `kind: "set"`, plus raise/lower affordances;
      on success the inspector re-reads (`inspector.get`) so the badge updates without a reload.
      This is the universal write path every later surface (queue T030, review M7) reuses.
- [ ] **Tests:** Vitest core tests for `raisePriority`/`lowerPriority` (band steps + clamps +
      round-trip); a `packages/local-db` repository test (in-memory `better-sqlite3` via
      `test-db.ts`) that setting priority updates `elements.priority` and appends exactly one
      `update_element` op; a `DbService` test (`apps/desktop/src/main/db-service.test.ts`) that
      `elements.setPriority` with `kind: "raise"`/`"lower"`/`"set"` produces the expected numeric
      value for a source, an extract, and a card.

### Done when

- Priority is stored numerically and surfaced as A/B/C/D; **every** source/extract/card (and
  task/topic/synthesis note) can be raised, lowered, or set to an explicit label through
  `elements.setPriority`, each write logging `update_element`; the inspector reflects the change
  immediately and it survives **app restart**.
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks

- Priority math stays in `packages/core` (tested), never in a React component or the `DbService`
  beyond calling the helper — the layering rule.
- A/B/C/D is a *display bucket*: `priorityToLabel` already buckets `>=0.75→A`, `>=0.5→B`,
  `>=0.25→C`, else D. `raise`/`lower` step between the band *representative* values
  (`PRIORITY_LABEL_VALUE`) so the displayed label always changes by exactly one band.
- Do not add a `set_priority` op type — priority changes are `update_element` (closed op set).
- Default-priority policy ("new material must not dominate") is already enforced by
  `DEFAULT_PRIORITY = C` at import (T013); this task only adds editing, it does not change
  defaults.

---

## T028 — Topic/extract scheduler (the attention scheduler)

- **Status:** `[ ]`  · **Depends on:** T027, T005
- **Roadmap line:** Done when: a non-card scheduler computes `due_at` from priority, stage,
  last-seen, and action; items can be scheduled for tomorrow/next week/next month/manual.
  (See [`scheduling-and-priority.md`](../scheduling-and-priority.md).)

### Goal

A single, tested **attention scheduler** in `packages/scheduler` that computes the next `due_at`
for a non-card element (`source`/`topic`/`extract`/`task`/`synthesis_note`) from **priority,
distillation stage, last-seen date, last action, and postpone count** — explicitly **distinct
from FSRS**, which it never touches. It replaces the interval helpers currently scattered inside
`extract-service.ts` / `extraction-service.ts` with one authoritative module, and exposes
explicit "schedule for **tomorrow / next week / next month / manual (pick a date)**" choices in
addition to the heuristic next-due. Rescheduling persists via `ElementRepository.reschedule`
(`reschedule_element`), with the postpone count carried in the op payload (no schema migration).

### Context to load first

- Reference: [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — **authoritative**.
  The starter intervals: by priority for sources (A `1–7d`, B `7–30d`, C `30–60d`, D `90d+`); by
  stage for extracts (`raw_extract` `+1..7d`, `clean_extract` `+3..14d`, `atomic_statement`
  convert-now/`+1d`); the rescheduling-by-action table (deleted=never, low-value `+30..180d`,
  medium `+7..30d`, high `+1..7d`); the "should I process this again, and when?" framing; and the
  invariant that overload data (`reps`, `lapses`, last-processed, postpone counts) is stored now
  so T076–T082 are addable without a migration rewrite.
- Existing code to inspect: `packages/scheduler/src/index.ts` (the stub to fill) +
  `packages/scheduler/package.json` (wire real `test`/`build`/`lint`);
  `packages/local-db/src/extract-service.ts` (`extractStageIntervalDays`, `postponeIntervalDays`,
  `nextExtractStage`, `EXTRACT_STAGES`, `addDays`, `countPostpones` — **move the math out**);
  `packages/local-db/src/extraction-service.ts` (`rawExtractIntervalDays` — move it out);
  `packages/local-db/src/element-repository.ts` (`reschedule`/`rescheduleWithin` with `opExtras`
  for the postpone marker); `packages/core/src/priority.ts` + `enums.ts`
  (`DISTILLATION_STAGES`, `ElementType`).
- Invariants in play: **the attention scheduler NEVER writes `review_states`/FSRS** (an extract
  has no FSRS row); it reads/writes `elements.due_at` only; all math is pure + framework-agnostic
  (no Drizzle/React imports in `packages/scheduler`); postpone history lives in the
  `reschedule_element` op payload, queryable without schema churn.

### Deliverables

- [ ] **Fill in `packages/scheduler`** with an `AttentionScheduler` (e.g.
      `packages/scheduler/src/attention-scheduler.ts`) of **pure functions** — no DB, no IPC, no
      React. Inputs are a plain "schedulable" descriptor
      (`{ type, stage, priority, lastSeenAt, postponeCount, lastAction }`) + a "now" clock
      (injectable for tests); outputs are an ISO `due_at` (and the chosen interval in days).
      Required surface:
      - `nextDueAt(input, now): { dueAt: IsoTimestamp; intervalDays: number }` — the heuristic
        next-due, branching on element **type/stage** (extract → by-stage; source/topic → by
        priority band, with the topic path reconciling the existing `defaultTopicIntervalDays`
        setting so that global setting is consumed, not orphaned) and the **last action** (extract/rewrite/postpone/done) per the
        rescheduling-by-action table. Higher priority returns sooner within each band; repeated
        postpones push further out.
      - Explicit choices `scheduleTomorrow(now)`, `scheduleNextWeek(now)`, `scheduleNextMonth(now)`,
        and a `scheduleManual(date)` validator/normalizer — the "tomorrow / next week / next month
        / manual" the roadmap requires.
      - A `SchedulerAction` enum (`extract`/`rewrite`/`postpone`/`done`/`activate`) and a
        `postponeIntervalForPriority(priority, postponeCount)` that grows the interval as
        `postponeCount` rises (so repeatedly-postponed items recede, per the stagnation concern).
      - Re-export `EXTRACT_STAGES`/`nextExtractStage` and the stage/priority interval functions
        from here (or keep them in core and import) so there is **one** source of truth. Default
        intervals MUST match the `scheduling-and-priority.md` tables.
      - Export everything from `packages/scheduler/src/index.ts`; remove the placeholder. Add
        `@interleave/core` as a dependency.
- [ ] **Wire real package scripts** in `packages/scheduler/package.json` (`test: vitest run`,
      `lint`, `build` as appropriate) so Turbo runs the scheduler's Vitest suite in `pnpm test`.
- [ ] **Re-point the local-db services at the scheduler:** update
      `packages/local-db/src/extract-service.ts` and `extraction-service.ts` so their interval
      decisions call `@interleave/scheduler` instead of their own inline copies (delete the
      duplicated `extractStageIntervalDays`/`postponeIntervalDays`/`rawExtractIntervalDays` or
      thin them to re-exports), and consolidate the **two duplicated `addDays` helpers** (one each
      in `extract-service.ts` and `extraction-service.ts`) into a single `packages/scheduler` date
      util so no copy remains in `packages/local-db`. `ExtractService.postpone` keeps recording
      `{ postpone: true, postponeCount }` via `rescheduleWithin`'s `opExtras`, but the *interval*
      now comes from `AttentionScheduler.postponeIntervalForPriority`. **No behavior regression**
      — the existing M4 extract tests must still pass (or be updated only where the consolidated
      intervals legitimately changed).
- [ ] **A `SchedulerService` seam in `packages/local-db`** (e.g.
      `packages/local-db/src/scheduler-service.ts`) that composes the pure `AttentionScheduler`
      with `ElementRepository` to *apply* a schedule: `rescheduleForAction(id, action)` and
      `scheduleAt(id, choice)` where `choice ∈ { tomorrow, nextWeek, nextMonth, { manual: date } }`
      — each loads the element, computes the new `due_at`, and calls
      `ElementRepository.reschedule` (`reschedule_element`, status → `scheduled`), all in one
      transaction. This is the service the queue actions (T030) and the loop (T031) call.
- [ ] **Tests:** a comprehensive Vitest suite in `packages/scheduler/src/attention-scheduler.test.ts`
      asserting: each priority band's source interval, each extract stage's interval, the
      action-based reschedule table, that postpone intervals grow with `postponeCount`, that
      tomorrow/next-week/next-month land on the right dates from a fixed injected `now`, and that
      manual dates are normalized/validated. A `packages/local-db` test that
      `SchedulerService.rescheduleForAction` / `scheduleAt` persist the computed `due_at`, set
      status `scheduled`, append exactly one `reschedule_element` op, and **create no
      `review_states` row** for an extract (the FSRS-isolation assertion).

### Done when

- A non-card attention scheduler computes `due_at` from **priority, stage, last-seen, and last
  action** (and grows the interval with postpone count), living entirely in `packages/scheduler`
  as tested pure functions; sources/topics/extracts can be scheduled for **tomorrow / next week /
  next month / a manual date**; applying a schedule persists via `ElementRepository.reschedule`
  (`reschedule_element`) and survives **app restart**.
- The scheduler **never** writes FSRS/`review_states` — verified by a test.
- The duplicated interval math is gone from `packages/local-db` (single source of truth in
  `packages/scheduler`).
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks

- **Do not import `ts-fsrs` here or build any card scheduling** — FSRS is **T036 (M7)**. T028 is
  the *attention* half only. Keep the two packages' concerns separate even though both will live
  under `packages/scheduler` (FSRS lands in a sibling module in M7).
- Keep the scheduler **pure**: inject `now` (a `() => IsoTimestamp` or a passed timestamp) so the
  Vitest suite is deterministic; do not call `Date.now()` deep inside.
- The `lastSeenAt`/`lastAction`/`postponeCount` inputs are read by the *service* from the element
  + its op log (`countPostpones` already exists on `ExtractService`; lift it to a shared helper or
  the `OperationLogRepository`). Store nothing new in the schema — the postpone count stays in the
  `reschedule_element` payload, and `lastSeenAt` derives from `updatedAt`/the last reschedule.
- The "10–20% randomness" in the daily-queue rule is a **queue-sort** concern (T029), not a
  scheduler concern — keep `nextDueAt` deterministic; T029 owns the jitter.
- Leave per-priority/per-concept retention, auto-postpone, catch-up/vacation, and workload
  simulation to M16 (T076–T082) — but the postpone-count + last-processed data this task relies on
  is exactly what makes those addable without a migration.

---

## T029 — Due queue

- **Status:** `[ ]`  · **Depends on:** T028, T004
- **Roadmap line:** Done when: `/queue` shows due sources/extracts/cards sorted by priority then
  due date, with filters for type/concept/status.

### Goal

A real **`/queue`** screen replacing today's placeholder: it lists everything due — due
**cards** (by FSRS `review_states.due_at`) and due **sources/topics/extracts/tasks** (by
attention `elements.due_at`) — **sorted by priority first, then due date** (with the
`scheduling-and-priority.md` 10–20% jitter so the user isn't trapped in one topic), filterable by
**type / concept / status**, and rendered as the design kit's `qitem` rows with the
`SchedulerChip` (FSRS vs attention), the `Prio` badge, a due `Status`, and the `--protected`
accent bar for high-priority items. A `BudgetMeter` reflects the daily budget vs items due.

### Context to load first

- Reference: [`../scheduling-and-priority.md`](../scheduling-and-priority.md) "The daily queue"
  (select due cards + due sources/extracts; sort by priority then due date; 10–20% randomness;
  process within a daily budget); [`../design-system.md`](../design-system.md) (`qitem` +
  `--protected` bar, `BudgetMeter`, `SchedulerChip` split, filter `chip`s).
- Existing code to inspect: `packages/local-db/src/queue-repository.ts` (`dueCards`,
  `dueAttentionItems`, `inbox`, `dueCardCount`, `nextCard` — the read side, already keeping the
  two schedulers separate); `apps/web/src/router.tsx` (the `/queue` `Placeholder` to replace);
  `apps/web/src/pages/inbox/InboxScreen.tsx` (the closest precedent: a list + filters + per-row
  metadata fed by `appApi`, wiring selection to the shell inspector); the renderer primitives
  `Prio`/`Status`/`SchedulerChip`/`Stage`/`TypeIcon` in
  `apps/web/src/components/inspector/primitives.tsx` (+ `inspector.css`); the design kit
  `design/kit/app/screen-queue.jsx` (`QueueScreen`/`QueueItem`/filters/`BudgetMeter`/the
  "Today's status" inspector) + `design/kit/styles/app.css` (`.qitem`, `.qitem--protected::before`,
  `.budget`, `.next-action`, `.chip`); `SettingsRepository` (the daily review budget from T011)
  for the `BudgetMeter` target.
- Invariants in play: the two schedulers stay distinct inside the read (cards via the FSRS join,
  attention items via `elements.due_at`); the renderer never touches SQL — the sorted/filtered
  queue is computed in `packages/local-db` + crosses IPC as flat rows; `SchedulerChip` must show
  the correct side per row.

### Deliverables

- [ ] **A unified queue read in `packages/local-db`** — extend `QueueRepository` (or add a
      `queue-query.ts` composing it) with `dueQueue({ asOf, filters, limit })` that merges
      `dueCards` (FSRS, marked `scheduler: "fsrs"` + retrievability/stability signals for the chip)
      and `dueAttentionItems` (attention, marked `scheduler: "attention"` + stage/postpone signals),
      then **sorts by priority desc, then `due_at` asc**, applies the type/concept/status filters,
      and returns flat `QueueItemSummary` rows: `{ id, type, status, stage, priority, title, dueAt,
      scheduler, schedulerSignals, sourceTitle?, concept?, protected, dueLabel }`. `protected`
      is `priority` band A (the `--protected` accent bar). Keep the **deterministic** sort here; the
      10–20% jitter is applied as a stable, seeded shuffle layer (so re-renders don't reshuffle).
- [ ] **New `window.appApi` surface `queue.list`** across all six files: `channels.ts`
      (`queueList: "queue:list"`), `contract.ts` (`QueueListRequestSchema` =
      `{ asOf?: string, types?: ElementType[], concept?: string, statuses?: ElementStatus[] }`,
      `QueueItemSummary`, `QueueListResult` = `{ items, counts, budget: { used, target } }`, and a
      `queue` group on `AppApi`), `preload/index.ts`, `ipc.ts`, the `DbService` (calls the queue
      query + reads the daily budget from `SettingsRepository`), and `apps/web/src/lib/appApi.ts`.
      Read-only command (no mutation, no op-log).
- [ ] **The `/queue` screen** in `apps/web` (e.g. `apps/web/src/pages/queue/QueueScreen.tsx` +
      `queue.css`, registered in `router.tsx` replacing the placeholder), rebuilt from
      `design/kit/app/screen-queue.jsx` pixel-for-pixel: the page head ("Daily Queue", N items due,
      est. minutes), the `BudgetMeter` (new component — port from `design/kit/app/components.jsx`
      `BudgetMeter` into `apps/web`, using the `.budget` CSS), the filter `chip` row
      (All / Cards / Sources / Extracts / Tasks / High-priority, each with a count), the `qitem`
      list (each row: `TypeIcon`, title, per-type meta line, `SchedulerChip`, `Prio`, due `Status`,
      `next-action`, and the `--protected` accent bar), the "Start session" button (routes to the
      T031 loop), and the "Today's status" inspector summary (due/overdue/protected counts). Empty
      and filtered-empty states match the kit.
- [ ] **Filters:** type (the element types), **concept** (deferred display — see Notes; wire the
      filter param now, populate when T041 lands concepts), and **status**; clicking a row selects
      it in the shell inspector (`useSelection().select(id)`) and clicking the row body / its
      `next-action` opens it (source → `/source/$id`, extract → `/extract/$id`, card → review when
      M7 lands).
- [ ] **Tests:** a `packages/local-db` Vitest test (seeded via `test-db.ts` + the T009 demo
      collection, which contains a source, extract, sub-extract, and two cards with review state)
      that `dueQueue` returns due cards **and** due attention items, sorted priority-then-due-date,
      with the correct `scheduler` tag on each and `protected` set for A items, and that filters
      narrow correctly. A renderer component test that the queue renders `qitem` rows with the right
      `SchedulerChip` side for a card vs an extract and that a filter chip narrows the list.
      A Playwright/Electron E2E (`tests/electron/queue.spec.ts`) that seeds/derives due items, opens
      `/queue`, and asserts due sources/extracts/cards appear sorted with priority + due labels.

### Done when

- `/queue` shows due sources/topics/extracts **and** due cards, **sorted by priority then due
  date**, with working type / concept / status filters and a `BudgetMeter`; each row shows the
  correct `SchedulerChip` (FSRS for cards, attention for the rest), its `Prio` band, and the
  `--protected` accent bar for A-priority items, matching `screen-queue.jsx`.
- The queue read keeps the two schedulers distinct (FSRS join vs attention `due_at`) and is
  computed in `packages/local-db`, not the renderer.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the queue Playwright spec pass.

### Notes / risks

- **Concept filter is partially deferred:** concepts/tags land in T041 (M8). Wire the `concept`
  filter *parameter* + the filter chip UI now (so the surface is stable), but it can be a no-op /
  hidden until T041 populates concept memberships. Type + status + high-priority filters are fully
  functional in M5. Note this clearly in the screen.
- **Cards depend on M6/M7:** the T009 seed already contains a Q&A card + a cloze card with
  `review_states`/`review_logs`, so `dueCards` has real rows to return and the FSRS-side chip can
  render now. Card *creation* (M6) and FSRS *scheduling* (M7) come later, but the queue must list
  whatever due cards exist — do not special-case them out.
- Keep the jitter a **stable seeded shuffle** (seed by the day + item id) so the order is steady
  within a session/render but varies day to day — never a fresh `Math.random()` per render.
- The overload `Banner` (auto-postpone / catch-up) in `screen-queue.jsx` is **M16 (T077/T078)** —
  render the `BudgetMeter` and the over-budget count now, but defer the auto-postpone action and
  catch-up/vacation modes. Leave the banner slot but do not wire auto-postpone.

---

## T030 — Queue actions

- **Status:** `[ ]`  · **Depends on:** T029
- **Roadmap line:** Done when: each due item supports open/postpone/raise/lower/done/dismiss/delete
  without leaving the list.

### Goal

Every `qitem` row in `/queue` acts **in place**: **open** (navigate to the item),
**postpone** (reschedule further out on the attention scheduler / FSRS-defer for cards),
**raise/lower** priority, **done** (status `done`), **dismiss** (status `dismissed`), and
**delete** (soft-delete). Each non-open action is a typed `window.appApi` command, runs in one
transaction, appends the correct `operation_log` op, and updates (or removes) the row **without
navigating away from the list** — with an undo snackbar for the destructive ones.

### Context to load first

- Reference: [`../scheduling-and-priority.md`](../scheduling-and-priority.md) "Rescheduling by
  action"; `CLAUDE.md` "Data rules" (soft delete, undoable, no silent data loss); the design kit
  `design/kit/app/screen-queue.jsx` (the per-row `next-action` + "Mark done" button; the `Snackbar`
  undo pattern in `design/kit/app/components.jsx`).
- Existing code to inspect: the **T028** `SchedulerService` (`rescheduleForAction` / `scheduleAt`)
  — postpone routes through it; the **T027** `elements.setPriority` command — raise/lower reuse it;
  `packages/local-db/src/element-repository.ts` (`update(id,{status})` for done/dismiss,
  `softDelete`/`restore` for delete+undo); the `extracts.*` command group in `contract.ts`/
  `db-service.ts` (the exact per-action precedent); the T029 `QueueScreen` + `queue.list` read.
- Invariants in play: each action = one transaction + one op (`reschedule_element` /
  `update_element` / `soft_delete_element`); delete is **soft** + undoable; no new op types; the
  list does not navigate on any action except explicit "open".

### Deliverables

- [ ] **A `queue.act` (or a small `queue.*` action group) `window.appApi` surface** across all six
      files. Prefer a **single** `queue.act` command with a discriminated-union `action`:
      `{ kind: "postpone" }` / `{ kind: "raise" }` / `{ kind: "lower" }` /
      `{ kind: "markDone" }` / `{ kind: "dismiss" }` / `{ kind: "delete" }` (open is renderer-only
      navigation, no IPC). Add `channels.ts` (`queueAct: "queue:act"`), `contract.ts`
      (`QueueActRequestSchema` = `{ id, action }`, `QueueActResult` = `{ item: QueueItemSummary |
      null, removed: boolean, undo?: { restorable: boolean } }`), `preload/index.ts`, `ipc.ts`,
      the `DbService` (dispatches per `kind`: postpone → `SchedulerService` (attention) or an
      FSRS-defer stub for cards; raise/lower → priority helpers + `ElementRepository.update`;
      markDone/dismiss → `update(id,{status})`; delete → `softDelete`), and
      `apps/web/src/lib/appApi.ts`. Each path is validated + transactional + logs the right op.
- [ ] **Per-action op mapping (no new op types):** postpone → `reschedule_element` (+ postpone
      marker/count in payload); raise/lower → `update_element`; markDone → `update_element`
      (status `done`); dismiss → `update_element` (status `dismissed`); delete →
      `soft_delete_element`. Cards' postpone in M5 reschedules the FSRS `review_states.due_at`
      forward via `ReviewRepository` (a thin defer — full FSRS grading is M7); attention items'
      postpone goes through `SchedulerService`. **Do not** put a card on the attention scheduler or
      an extract on FSRS.
- [ ] **In-place row behavior in `QueueScreen`:** each `qitem` exposes the actions (the
      `next-action`/"Mark done" affordances + a small action menu / keyboard hints). On
      postpone/raise/lower the row updates in place (re-read its summary, re-sort if priority/due
      changed); on done/dismiss/delete the row is removed from the list with a `Snackbar` undo
      (port the kit `Snackbar`; undo calls `ElementRepository.restore` for delete, or re-sets the
      prior status for done/dismiss). **No navigation** happens except the explicit "open".
- [ ] **Tests:** a `DbService`/`packages/local-db` Vitest test that each `queue.act` kind produces
      the expected status/priority/`due_at` change + exactly the expected op, that delete is soft
      (`deletedAt` set, row still present) and `restore` undoes it, and that postponing a card defers
      its `review_states.due_at` while postponing an extract reschedules `elements.due_at` (the
      isolation assertion). A renderer component/E2E step (extend `tests/electron/queue.spec.ts`):
      postpone an item → it leaves the due list; raise priority → its `Prio` badge changes in place;
      delete → row removed + undo restores it; verify a postponed item is **still scheduled after app
      restart** (not lost).

### Done when

- Each due item supports **open / postpone / raise / lower / done / dismiss / delete** without
  leaving the list; every mutating action is one transaction appending the correct existing op,
  delete is soft + undoable, and the results survive **app restart**.
- Attention items postpone on the attention scheduler and cards defer on FSRS — never crossed.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the (extended) queue Playwright spec pass.

### Notes / risks

- Reuse T027 (`elements.setPriority`) and T028 (`SchedulerService`) rather than re-implementing
  priority/schedule math in the `DbService` — `queue.act` is a thin dispatcher.
- Card postpone is a **deliberate thin defer** in M5 (push `review_states.due_at`); full FSRS
  grade-driven rescheduling is **T036/T037 (M7)**. Keep it minimal and clearly TODO-marked so M7
  replaces it.
- Undo for done/dismiss restores the *prior* status; undo for delete uses
  `ElementRepository.restore`. Keep the undo window short (the kit's 5s `Snackbar`).
- Bulk actions, trash view, and command-level undo across many ops are **T044 (M9)** — M5 only
  needs per-row undo.

---

## T031 — "Process queue" learning loop

- **Status:** `[ ]`  · **Depends on:** T030
- **Roadmap line:** Done when: a single mode shows one element at a time and advances after action;
  the user can process ten mixed elements without returning to a list.

### Goal

A focused **"Process queue"** mode that takes the T029 due queue and presents it **one element at
a time**, rendering the right surface for each type (a source/extract reader-style view for
attention items; a card prompt/reveal view for cards once M7 lands), with the T030 actions
(open-in-full / postpone / raise / lower / done / dismiss / delete / next) available inline. After
each action it **advances to the next due item automatically**, so a user can process ten mixed
sources/extracts/cards end to end **without ever returning to the list** — the keyboard-first daily
grind the product is built around.

### Context to load first

- Reference: [`../scheduling-and-priority.md`](../scheduling-and-priority.md) "The daily queue"
  (process within a timebox; due cards first, then reading/extract items; sibling cards not
  back-to-back); `CLAUDE.md` "Key screens" (Daily Queue / Home Command Center; Active Recall Review
  Session) + "UX rules" (keyboard-first, fast); the design kit `design/kit/app/screen-queue.jsx`
  ("Start session" + the budget/mode `Segmented` controls) and `design/kit/app/screen-review.jsx`
  (the one-at-a-time review surface to mirror for the loop's card case in M7).
- Existing code to inspect: the T029 `queue.list` read + `QueueScreen`; the T030 `queue.act`
  command; `QueueRepository.nextCard`/`dueAttentionItems` (the "next due item" reads); the
  `/review` `Placeholder` in `router.tsx` (the loop lives here or at a dedicated `/process` route);
  the source/extract reader views (`SourceReader`, `ExtractView`) the loop embeds for attention
  items.
- Invariants in play: the loop **advances after every action**; it reuses the **same** typed
  `appApi` mutation path as the queue list (no separate mutation channel); cards stay on FSRS,
  attention items on the attention scheduler; sibling cards are not shown back-to-back (the rule is
  enforced once cards/FSRS exist — M7; the loop must leave a seam for it).

### Deliverables

- [ ] **A "Process queue" loop screen** in `apps/web` (e.g.
      `apps/web/src/pages/queue/ProcessQueue.tsx`, reachable from the queue's "Start session"
      button — either the `/review` route or a new `/process` route in `router.tsx`). It loads the
      ordered due queue (`queue.list`, honoring the active filters/mode), holds a **cursor** over the
      ordered items, and renders the current item's surface:
      - **source / topic / extract / task** → a compact read/process panel (reuse the
        `SourceReader`/`ExtractView` body + the attention `SchedulerChip`/`Stage`/source-context);
      - **card** → a prompt/reveal/grade panel **stub** that routes to the M7 review surface (cards
        appear in the loop but full grading lands with T037 — show the prompt + a "review in M7"
        affordance, or wire grading directly if M7 already landed).
- [ ] **Advance-after-action:** every action (postpone / raise / lower / done / dismiss / delete /
      explicit "next/skip") calls the **same** `queue.act` / `elements.setPriority` commands as the
      list (no new mutation path), then advances the cursor to the next item. A progress readout
      ("3 / 12 · est. N min") and a budget/mode header (port the `Segmented` budget/mode controls
      from `screen-queue.jsx`) frame the session; completing the last item shows the "Queue clear"
      done state (the kit `EmptyState`).
- [ ] **Keyboard-first controls** for the loop (advance, postpone, done, raise/lower, open-in-full,
      delete) wired through the existing shell shortcut mechanism
      (`apps/web/src/shell/useShellShortcuts.ts`) so the whole session is mouse-free — the full
      shortcut catalog + command palette is T048, but the loop's core keys land here.
- [ ] **Tests:** a renderer component test that the loop renders the current item, advances on an
      action, and reaches the done state at the end. A **Playwright/Electron E2E**
      (`tests/electron/process-queue.spec.ts`, the milestone flow): seed a mixed due set (≥10 items:
      sources + extracts + at least the seeded cards), open Process queue, process each with a mix of
      done/postpone/raise/lower **without returning to the list**, reach the done state, then
      **restart the app** and assert the postponed items are still scheduled (and the done/processed
      ones did not reappear) — proving the loop's mutations persisted.

### Done when

- A single "Process queue" mode shows **one element at a time** and **advances after each action**,
  so the user processes ten mixed sources/extracts/cards end to end **without returning to a list**;
  every action uses the same typed `appApi` mutation path as the queue list, and the results survive
  **app restart**.
- Cards are presented via the FSRS-side surface and attention items via the attention-side surface
  (the chip + scheduling stay on the correct side).
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the process-queue Playwright spec pass.

### Notes / risks

- **Card grading is M7.** In M5 the loop must *include* cards in the rotation (they are due
  alongside attention items) but full FSRS reveal/grade is T037 — render the card prompt and route
  grading to a placeholder, or fully wire it only if M7 has already landed. Leave a clear seam.
- **Sibling burying (T039)** and **"due cards first, then reading"** ordering refinements are
  M7-side; the loop consumes the order `queue.list` gives it. Leave the ordering policy in the
  queue read so T039/T076 can refine it without touching the loop.
- The budget/mode `Segmented` controls are presentational steering for now (which slice of the due
  set to process); the real **auto-postpone/catch-up/vacation** behind "Mode" is M16 (T077/T078).
- Do not introduce a second mutation path — the loop reuses `queue.act`/`elements.setPriority`
  exactly, which is what keeps the keyboard shortcuts (T048) and the list (T030) in sync with one
  validated IPC surface.

---

## Exit criteria for M5

- All of T027–T031 are `[x]` in [`../roadmap.md`](../roadmap.md).
- Priority is a **first-class, editable** axis: stored numerically, surfaced A/B/C/D, and
  raise/lower/set works on every source/extract/card (and task/topic/synthesis note) through the
  typed `elements.setPriority` command, each logging `update_element`.
- A **non-card attention scheduler** lives in `packages/scheduler` as tested pure functions,
  computing `due_at` from priority/stage/last-seen/last-action/postpone-count and offering
  tomorrow/next-week/next-month/manual scheduling; the duplicated interval math has been
  consolidated out of `packages/local-db`. **It never writes an FSRS `review_states` row.**
- `/queue` lists due sources/topics/extracts **and** due cards, **sorted by priority then due
  date** (with stable jitter), filterable by type/concept/status, rendered as `qitem` rows with the
  correct `SchedulerChip` (FSRS vs attention), `Prio`, due `Status`, `BudgetMeter`, and the
  `--protected` accent bar — matching `screen-queue.jsx`.
- Every due row acts **in place** — open/postpone/raise/lower/done/dismiss/delete — each a typed,
  validated, transactional `window.appApi` command appending the correct existing op
  (`reschedule_element`/`update_element`/`soft_delete_element`), with delete soft + undoable and no
  navigation away from the list.
- A **"Process queue" loop** presents one element at a time and advances after each action, so ten
  mixed elements process without returning to a list — reusing the *same* typed mutation path as the
  list.
- **The two-scheduler split holds throughout:** attention items schedule on the attention scheduler;
  cards schedule/defer on FSRS; an extract never gets an FSRS row; a card never gets the attention
  heuristic — asserted by tests.
- All new capabilities reach the renderer **only** through new typed `window.appApi` commands
  (`elements.setPriority`, `queue.list`, `queue.act`) with Zod-validated IPC; **no raw
  DB/filesystem access is exposed to the renderer**, and no generic `db.query`. **All scheduling
  math lives in `packages/scheduler` (and priority math in `packages/core`), never in a React
  component.**
- Every M5 mutation runs in **one transaction**, appends the correct existing `operation_log` op
  (**no new op types**), and **survives app restart**.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the M5 Playwright specs (schedule → appears due in
  `/queue` → postpone/act → process one-at-a-time → survives restart) are green.

When M5 is complete, generate `tasks/M6-cards.md` from the roadmap before starting T032.

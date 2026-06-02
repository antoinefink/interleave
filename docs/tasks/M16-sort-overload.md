# M16 — Advanced scheduling & overload (T076–T078)

Detailed, buildable specs for the overload core of the sixteenth milestone. M5/M7 built the
**daily loop** and the **two-scheduler split**: the attention scheduler
(`packages/scheduler/src/attention-scheduler.ts`) schedules `source`/`topic`/`extract`/`task`/
`synthesis_note` on `elements.due_at`, FSRS (`packages/scheduler/src/card-scheduler.ts`,
`ts-fsrs` 5.4.1) schedules `card` on `review_states.due_at`, and the `/queue` screen merges them
through `QueueQuery.list` (`packages/local-db/src/queue-query.ts`) — **sorted priority-desc then
`due_at`-asc**, with a daily-budget gauge and a stable seeded jitter applied in the renderer
(`apps/web/src/pages/queue/jitter.ts`). M16 makes that loop **survive overload**, which the
product treats as the normal steady state of a years-long knowledge base:

- **T076 (advanced auto-sort)** replaces the queue's two-key sort with a deterministic **scoring
  function** over priority, due date, retrievability, type, sibling spacing, concept diversity,
  and the active **session mode** — a pure module in `packages/scheduler`, unit-tested, that
  `QueueQuery` composes. The jitter stays a separate seeded layer; the score is the new ordering.
- **T077 (auto-postpone)** is the overload valve: when the **due load exceeds the daily budget**,
  it postpones **low-priority topics first, then low-priority mature cards**, while **protecting
  high-priority fragile cards** — deterministic selection, transactional application, reusing the
  *correct* scheduler per element type (attention reschedule for topics, an FSRS-aware defer for
  cards) and the existing `reschedule_element` op. It never corrupts FSRS memory state.
- **T078 (catch-up & vacation modes)** are the two human-facing overload tools: **catch-up**
  recovers from an accumulated backlog by spreading it forward over N days; **vacation**
  pre-adjusts future load across a date range so the user returns to a survivable queue. **Both
  must show the COST of postponement** before committing — what slips, by how much — via a pure
  preview, then apply the plan safely (one transaction, existing ops, reversible).

After M16's overload core the queue is **steerable under pressure**: a user can import far too
much, fall a week behind, take a two-week holiday, and still return to a prioritized, survivable
daily queue with high-value fragile memory protected and low-value material sacrificed first.

> **The two-scheduler split is the load-bearing invariant of this milestone too**
> (see [`../scheduling-and-priority.md`](../scheduling-and-priority.md) "Overload handling").
> Auto-sort, auto-postpone, and catch-up/vacation **act on the correct scheduler per element
> type** and must NEVER cross them:
>
> | Scheduler | Applies to | Due field | M16 touches it via |
> |-----------|-----------|-----------|--------------------|
> | **Attention** | `source` `topic` `extract` `task` `synthesis_note` | `elements.due_at` | `SchedulerService.scheduleAt`/`rescheduleForAction` (`reschedule_element`) |
> | **FSRS** | `card` only | `review_states.due_at` | a thin **defer** of `review_states.due_at` (NEVER a re-grade; NEVER an `add_review_log`; NEVER FSRS-param math) |
>
> A topic is postponed on the attention scheduler; a card is *deferred* on FSRS (its memory
> state — `stability`/`difficulty`/`reps`/`lapses`/`fsrsState` — is left **untouched**). An
> extract never gets a `review_states` row; a card never gets the attention heuristic. Every M16
> change asserts this with a test.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md) and the
roadmap header): the React **renderer** (`apps/web`) never touches SQLite, Node, or the
filesystem. Every mutation flows React UI → typed client wrapper (`apps/web/src/lib/appApi.ts`)
→ preload bridge (`apps/desktop/src/preload/index.ts`) → validated IPC (Zod) on the main side
(`apps/desktop/src/main/ipc.ts`) → the `DbService` (`apps/desktop/src/main/db-service.ts`) →
`packages/local-db` repositories/services + `packages/scheduler` pure functions → SQLite. Every
meaningful mutation runs in **one transaction** and appends an **`operation_log`** row; deletes
are soft (`deleted_at`); **all scoring/selection/optimization math is PURE domain logic in
`packages/scheduler` (and `packages/core`), deterministic and unit-tested, NEVER in a React
component.** Settings (daily budget, desired retention) persist in SQLite `settings` (T011) and
are read through the typed `SettingsRepository` / `getAppSettings()`. Everything survives **app
restart** and is verified with native pnpm.

Read first:
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — **authoritative**. The
  "**Overload handling**" section names all three: auto-sort (a scoring function over priority,
  due date, retrievability, type, sibling spacing, concept diversity, session mode); auto-postpone
  (low-priority topics first, then low-priority *mature* cards, protecting high-priority *fragile*
  cards); catch-up/vacation (recover backlog / pre-adjust future load, **always showing the cost
  of postponement**). The "daily queue" rule (sort by priority then due date, 10–20% randomness,
  process within a daily budget), the priority rules (protect high, sacrifice low, new material
  must not dominate), and the explicit note that overload data (`reps`, `lapses`,
  last-processed, postpone counts) is **already stored** so M16 is addable "without a migration
  rewrite".
- [`../architecture.md`](./architecture.md) + [`../../CLAUDE.md`](../../CLAUDE.md) — the layering,
  the Electron/IPC boundary, the closed `operation_log` set, soft-delete, transactional mutations.
- [`../domain-model.md`](../domain-model.md) — `elements` columns (`priority`, `due_at`, `status`,
  `stage`), `ElementStatus` (`suspended` already exists — vacation reuses it), the priority model.
- [`../design-system.md`](../design-system.md) — the queue `Banner` (overload), `BudgetMeter`,
  `Segmented` mode controls, `qitem`/`--protected`, `Snackbar` (undo). The
  `design/kit/app/screen-queue.jsx` overload `Banner` slot was **intentionally left unwired in M5**
  (T029 Notes) — M16 wires it.
- [`./M5-scheduling-queue.md`](./M5-scheduling-queue.md) (the queue substrate) +
  [`./M7-fsrs-review.md`](./M7-fsrs-review.md) (the FSRS substrate) — the milestones M16 builds ON.

### What already exists (inspect before building — do not duplicate)

The M5/M7 substrate built nearly everything M16's overload core composes:

- **The pure attention scheduler — `packages/scheduler/src/attention-scheduler.ts`:**
  `nextDueAt(input, now)`, `scheduleTomorrow`/`scheduleNextWeek`/`scheduleNextMonth`/
  `scheduleManual`, `scheduleForChoice(choice, now)`, `postponeIntervalForPriority(priority,
  postponeCount)` (grows with the postpone count, capped at the `+180d` ceiling),
  `basePostponeIntervalDays`, `sourceIntervalDays`, `extractStageIntervalDays`. The date helpers
  `addDays` + `MS_PER_DAY` live in `packages/scheduler/src/date-util.ts` (re-exported from
  `packages/scheduler/src/index.ts`; `attention-scheduler.ts` only imports `addDays` from there).
  **T077/T078 compute new due dates by calling these — they add no new interval math.** All pure
  (no DB/IPC/React), `now` injected.
- **The pure FSRS scheduler — `packages/scheduler/src/card-scheduler.ts`:** `CardSchedulerService`
  wraps `ts-fsrs` behind our vocabulary: `gradeCard`, `previewIntervals`,
  `toFsrsCard`/`fromFsrsCard` adapters, `formatInterval`, the
  `ReviewOutcome`/`IntervalPreview` types, and `CardSchedulerServiceOptions.params:
  Partial<FSRSParameters>` (the documented per-preset/per-concept seam). **The `ts-fsrs`
  `State`/`Rating`/`Card` vocabulary never leaks past this file.** Note: this wrapper does **not**
  currently call `ts-fsrs`'s `get_retrievability` — the queue's retrievability is the
  `approximateRetrievability` already computed in `queue-query.ts` (factor 19/81, decay −0.5) and
  carried on the summary, so **T076 reads retrievability off the summary** (no `ts-fsrs` call in the
  score) and T077 reads that same summary value to classify a card as *fragile* vs *mature*; M16
  never re-grades. (`ts-fsrs`'s `get_retrievability` is available behind the wrapper for T080's
  history replay if needed — see the retention-sim spec.)
- **`isLeech` — `packages/scheduler/src/leech.ts`** (`LEECH_LAPSE_THRESHOLD`): the lapse-count
  classifier T077/T078 reuse to leave leeches alone (don't auto-postpone a card already flagged
  for repair).
- **The unified queue read — `packages/local-db/src/queue-query.ts`:** `QueueQuery.list({ asOf,
  filters, limit })` already merges `dueCards` (FSRS, `scheduler: "fsrs"`, with
  `approximateRetrievability` + stability in `schedulerSignals`) and `dueAttentionItems`
  (attention, `scheduler: "attention"`, with stage + `postponed` count), decorates each into a
  flat `QueueItemSummary` (`{ id, type, status, stage, priority, title, dueAt, scheduler,
  schedulerSignals, sourceTitle, author, concept, cardType, protected, due, dueLabel }`), applies
  type/concept/tag/status filters, computes drill-down `counts` + the `budget: { used, target }`
  gauge (target = `getAppSettings().dailyReviewBudget`), and **sorts priority-desc then due-asc**
  (`QueueQuery.sort`). `summaryFor(id, asOf)` rebuilds one row. **T076 replaces the `sort` call
  with the scoring sort; T077/T078 read this same merged-and-decorated set to choose what to
  postpone.** `approximateRetrievability` (factor=19/81, decay=−0.5) + `dueStateFor`/`dueLabelFor`
  already live here.
- **The seeded jitter — `apps/web/src/pages/queue/jitter.ts` (+ `jitter.test.ts`):** the stable
  day+id seeded shuffle that the daily-queue rule's "10–20% randomness" asks for, applied in the
  renderer so re-renders don't reshuffle. **It stays a separate layer ON TOP of the T076 score —
  the score is the deterministic ordering, the jitter is the small diversity nudge.**
- **The attention APPLY seam — `packages/local-db/src/scheduler-service.ts`** (aliased
  `AttentionScheduleService` in `db-service.ts`): `rescheduleForAction(id, action, now, batchId?)`
  and `scheduleAt(id, choice, now, batchId?)` — each loads the element, computes the new `due_at`
  with the pure scheduler, and persists via `ElementRepository.reschedule` (`reschedule_element`,
  status → `scheduled`) in one transaction, with an optional `batchId` already threaded into the
  op payload for **bulk undo (T044)**. It **rejects a `card`** (`requireAttentionElement`).
  `countPostpones(id)` delegates to `OperationLogRepository.countPostpones`. **T077/T078 apply
  attention-item postpones through this — and through `batchId` so a whole overload sweep undoes as
  one.**
- **The queue ACT dispatcher — `packages/local-db/src/queue-action-service.ts`:**
  `QueueActionService.act(id, kind, now)` (`postpone`/`raise`/`lower`/`markDone`/`dismiss`/
  `delete`), `bulkPostpone(ids, now)` (one shared `batchId`), `deferCard(id, now, batchId)` —
  **the existing thin FSRS defer** (`CARD_DEFER_DAYS = 1`: pushes `review_states.due_at` +
  `elements.due_at` forward by one day in one transaction, logs `reschedule_element` with
  `{ postpone: true, cardDefer: true, prevReviewDueAt, batchId? }`, **preserves card status**,
  writes NO review log). **T077 generalizes `deferCard` to defer by N days; `bulkPostpone` is the
  exact precedent for the overload sweep.**
- **Settings (T011) — `packages/core/src/settings.ts` + `SettingsRepository`:** `getAppSettings()`
  returns the validated `AppSettings` incl. `dailyReviewBudget` (the overload threshold — already
  documented as "overflow auto-postpones by priority (read by the queue/scheduler, T029/**T077**)")
  and `defaultDesiredRetention`. `coerceSettingsPatch`/`settingsPatchToStored` for any new setting.
- **The IPC seam (M5/M7/M17 precedent):** `apps/desktop/src/shared/channels.ts` already has
  `queueList`/`queueAct`/`queueSchedule`/`queueUndo`, `settingsGetAll`/`settingsUpdateMany`,
  `analyticsGet`. `contract.ts` has `QueueListRequestSchema`/`QueueItemSummary`/`QueueListResult`,
  `QueueActRequestSchema`, `QueueScheduleRequestSchema`, `QueueUndoRequestSchema`. `db-service.ts`
  holds `QueueQuery`, `QueueActionService`, `AttentionScheduleService`, `CardSchedulerService`,
  `AnalyticsService`. **New M16 commands are added across the same six files in lockstep**
  (`channels` → `contract` → `preload` → `ipc` → `db-service` → renderer `appApi.ts`).
- **The queue UI — `apps/web/src/pages/queue/`:** `QueueScreen.tsx` (the `BudgetMeter`, the filter
  chips, the `qitem` list via `queueRow.tsx`, the over-budget gauge — **the overload `Banner` slot
  is unwired**), `ProcessQueue.tsx` (the one-at-a-time loop with a presentational `SessionMode`
  = `full`/`review`/`read` `Segmented` — **"steering only — auto-postpone is M16"**, the exact
  seam T076's mode input + T077's banner action wire into), `useProcessShortcuts.ts`.

> **Operation-log discipline (read before adding any op).** `OPERATION_TYPES`
> (`packages/core/src/operation-log.ts`) is a **closed, fixed set of 15** — "a rename is a
> migration." **M16's overload core introduces NO new op types.** Auto-postpone (topics) →
> **`reschedule_element`** (with `{ postpone: true, postponeCount, batchId }` in the payload via
> the existing `opExtras` seam); auto-defer (cards) → **`reschedule_element`** (with
> `{ postpone: true, cardDefer: true, prevReviewDueAt, batchId }`, exactly like the existing
> `deferCard`); vacation suspend → **`update_element`** (status `suspended`); vacation resume →
> **`update_element`** (status back to prior). Auto-sort (T076) is a **read** — no op at all. Do
> **not** invent `autopostpone`/`catchup`/`vacation` op types.

Build order is the task order. T076 (the score) is the deterministic ordering everything else
reasons about; T077 (auto-postpone) is the single-shot overload valve that uses the score's
priority/fragility reasoning to choose victims; T078 (catch-up/vacation) generalizes T077's
selection + application into a previewed, multi-day, reversible plan. T079–T082 (retention by
priority/concept, FSRS-param optimization, workload simulation, mature-card retirement) are the
**rest of M16** and are specced separately — this file covers **T076–T078 only**.

---

## T076 — Advanced auto-sort

- **Status:** `[ ]`  · **Depends on:** T029, T036
- **Roadmap line:** Done when: queue sorting uses a scoring function over priority, due date,
  retrievability, type, sibling spacing, concept diversity, and session mode.

### Goal

The `/queue` ordering stops being a two-key `priority desc, due_at asc` comparison and becomes a
single deterministic **scoring function** over **priority, due date, retrievability, element type,
sibling spacing, concept diversity, and the active session mode**. The score lives as a **pure,
unit-tested module in `packages/scheduler`** (`scoreQueueItems`), takes the already-merged-and-
decorated `QueueItemSummary[]` (so it needs no DB) plus the session mode + `asOf`, and returns the
items in score order; `QueueQuery.list` composes it in place of the old `sort`. The seeded jitter
(`jitter.ts`) stays a *separate* renderer layer on top — the score is the ordering, the jitter is
the small day-varying diversity nudge. After this task a high-priority overdue fragile card sorts
above a fresh low-priority topic, two sibling cards do **not** sort adjacent, and "review mode"
floats cards while "read mode" floats sources/extracts — all without any randomness in the score.

### Context to load first

- Reference: [`../scheduling-and-priority.md`](../scheduling-and-priority.md) "Overload handling →
  Auto-sort" (the exact seven factors) + "The daily queue" (priority then due date; 10–20%
  randomness is the *separate* jitter; due cards first then reading items); the priority rules
  (protect high, sacrifice low, new material must not dominate).
- Existing code to inspect: `packages/local-db/src/queue-query.ts` — the `QueueItemSummary` shape
  (it already carries `priority`, `dueAt`, `due` overdue/today/soon, `scheduler`,
  `schedulerSignals.retrievability`/`.stability`/`.postponed`, `type`, `concept`, `cardType`,
  `protected` — but **NOT** `siblingGroupId` or `sourceId`; see the enrichment deliverable below),
  the existing `sort` (priority desc, due asc) **this replaces**, and where `list`
  calls it; `apps/web/src/pages/queue/jitter.ts` (the seeded shuffle that stays a separate layer);
  `packages/scheduler/src/card-scheduler.ts` (retrievability is already in the summary via
  `approximateRetrievability`; no FSRS call needed in the score); the `sibling_group` relation
  (M7/T039 — `ReviewSessionService.siblingGroupOf` resolves it via the `sibling_group`
  `element_relations` edge **per card** at line ~81 — the spacing input; **enrich it batched, not
  per-row**, see the enrichment deliverable), and `sourceContext` in `queue-query.ts` (lines
  ~410–420 — where the owning `sourceId` is already resolved in scope but **not yet returned**, so
  widen its return shape, see the enrichment deliverable);
  `apps/web/src/pages/queue/ProcessQueue.tsx` (the `SessionMode` = `full`/`review`/`read` that
  becomes a real score input + the existing `modeIncludes` hard filter the score must reconcile —
  see the mode deliverable); `QueueScreen.tsx` (which passes filters to `queue.list`).
- Invariants in play: the score is **pure + deterministic** (no `Math.random`, no `Date.now()`
  deep inside — `asOf` is passed); it consumes the flat `QueueItemSummary` (no DB access in the
  scorer); the two-scheduler split is **read-only** here (FSRS rows keep `scheduler: "fsrs"` and
  their retrievability, attention rows keep `scheduler: "attention"`); the jitter remains a
  separate, seeded layer (never folded into the score).

### Deliverables

- [ ] **A pure scoring module `packages/scheduler/src/queue-score.ts`** exporting
      `scoreQueueItems(items, options)` and the per-item `queueItemScore(item, context)` it builds
      on — **no DB, no IPC, no React, no `ts-fsrs` import** (it reads the already-computed
      retrievability off the summary). Inputs are the flat queue-row shape (a `QueueScoreInput`
      structurally satisfied by `QueueItemSummary`), the `SessionMode` (`"full" | "review" |
      "read"`), and `asOf`. The score is a **documented weighted sum** of normalized `[0,1]`
      factors (weights are named exported constants so they are tunable + asserted):
      - **priority** — the dominant term (numeric `priority`, normalized): high-priority floats up,
        so "high-priority fragile memory is protected" holds and "new material must not dominate";
      - **due urgency** — overdue > due-today > soon; an overdue penalty grows with days overdue
        (derived from `dueAt` vs `asOf`), so the longest-overdue high-value items surface first;
      - **retrievability** — for cards, *lower* retrievability scores *higher* (a card about to be
        forgotten is more urgent); attention rows (no retrievability) use a neutral mid value so
        they are not unfairly buried or floated;
      - **type weight** — a small per-type bias the **session mode** modulates: `review` mode
        up-weights `card`, `read` mode up-weights `source`/`extract`/`topic`, `full` is neutral
        (this is the "due cards first, then reading" rule made tunable, not hard-coded). **This is a
        soft float, not a hard filter** — but the existing `ProcessQueue.modeIncludes` (lines
        151–156) is a *hard* client-side filter that drops all cards in `read` and all non-cards in
        `review`. The score's soft type-weight and that hard filter would disagree, so **the
        decision (state it explicitly): the score makes `mode` the ordering and
        `ProcessQueue.modeIncludes` is removed** — `mode` becomes a pure soft ordering bias, both
        types stay in the list, and "due cards first then reading" is the up-weight, not a filter.
        (The mode `Segmented` then *steers* the order rather than slicing the deck.);
      - **sibling spacing** — a *post-sort de-clumping* pass over the scored order that pushes
        items sharing a `siblingGroupId`/`sourceId` apart so siblings/same-source rows are not
        adjacent (the M7 "siblings not back-to-back" rule, generalized to the queue ordering);
        deterministic (a fixed minimum-gap reorder, not a shuffle). **This factor reads
        `siblingGroupId` + `sourceId`, which the flat `QueueItemSummary` does NOT carry today** —
        the enrichment deliverable below adds them to the summary (so the scorer stays pure over the
        summary and needs no DB), and `QueueScoreInput` includes `siblingGroupId: string | null` +
        `sourceId: string | null`;
      - **concept diversity** — a deterministic round-robin/de-clumping nudge so the top of the
        queue isn't all one concept (uses `item.concept`), keeping the user from being "trapped in
        one topic" *without* the random jitter doing all that work.
      Export `DEFAULT_QUEUE_SCORE_WEIGHTS`, the `SessionMode` type, `QueueScoreInput`, and
      `scoreQueueItems` from `packages/scheduler/src/index.ts`. Keep the de-clumping passes
      **stable** (a fixed tie-break by id) so a fixed input always yields a fixed order.
- [ ] **Enrich `QueueItemSummary` with the de-clumping keys** (`packages/local-db/src/queue-query.ts`):
      add `siblingGroupId: string | null` and `sourceId: string | null` to the flat
      `QueueItemSummary` (today it has neither — only a `sourceTitle` string and `concept`), and
      populate them in the two decorators (`toCardSummary`/`toAttentionSummary`, the
      card + attention build paths): `sourceId` is **already resolved in scope** in the
      `sourceContext` helper (defined at line ~411 — but `sourceContext` currently returns only
      `{ sourceTitle, author }`, so **widen its return type to `{ sourceTitle, author, sourceId }`**
      and destructure `sourceId` at **both** of its call sites — `const { sourceTitle, author } =
      this.sourceContext(element)` in `toCardSummary` (line ~353) **and** in `toAttentionSummary`
      (line ~383); do **not** re-resolve it). `siblingGroupId` is
      resolved via the **existing** `sibling_group` `element_relations` edge (the same edge
      `ReviewSessionService.siblingGroupOf` reads — line ~81, which reads `element_relations` **per
      card**). Resolving it per row would be **N+1** over a large due-card set, regressing the queue
      read, so **add a single batched read** — one `liveSiblingGroupMap()` (a `Map<cardElementId,
      siblingGroupId>` built from one `sibling_group` relations query) computed once per `list()`
      and looked up per row (returning `null` for non-cards) — rather than calling `siblingGroupOf`
      in each decorator. This keeps the scorer **pure over the summary** (no DB in the scorer) while
      giving sibling-spacing + same-source de-clumping the identifiers they need; `QueueScoreInput`
      is structurally satisfied by the enriched `QueueItemSummary`. **No schema migration** — both
      are derived from existing rows/relations. (This is a read-path enrichment only; the new fields
      cross IPC on the existing `QueueItemSummary` contract type, so mirror them in `contract.ts`.)
- [ ] **Compose the score in `QueueQuery.list`** (`packages/local-db/src/queue-query.ts`): replace
      the `this.sort(rows)` call with `scoreQueueItems(rows, { mode, asOf })`, threading a new
      optional `mode?: SessionMode` through `list({ asOf, filters, limit, mode })` (default
      `"full"`). The merge, decoration, filters, drill-down counts, and budget gauge are unchanged;
      **only the ordering changes**. The deterministic score stays here; the renderer's seeded
      jitter still runs after, on the scored order.
- [ ] **Thread `mode` through `queue.list`** across the six IPC files: `contract.ts` — add an
      optional `mode: z.enum(["full","review","read"]).optional()` to `QueueListRequestSchema`;
      `preload`/`ipc`/`db-service` pass it into `QueueQuery.list`; `apps/web/src/lib/appApi.ts`
      mirrors it. `ProcessQueue.tsx`'s existing `SessionMode` is sent as `mode` (so its
      `Segmented` control stops being purely presentational and actually re-orders the loop).
      **Remove the now-redundant `ProcessQueue.modeIncludes` hard filter** (the helper at lines
      ~151–156 and its two `.filter(...)` call sites at ~222/~306 — **re-confirm these line numbers
      at build time**, since `ProcessQueue.tsx` is edited in this task): with `mode` flowing into the
      score as a soft up-weight, the loop no longer slices the deck by type — both types stay in the
      list and the mode merely re-orders them (so a `read`-mode list still contains cards, ordered
      below the reading items, which is exactly what the "review floats a card / read floats a
      source" test asserts). **Reconcile the session-progress copy:** because the deck is no longer
      sliced, the "N left" counter (and any session-progress UI in `ProcessQueue`/`QueueScreen`) now
      counts the **full mixed deck**, not the type-filtered slice it counted before — update the
      copy/derivation so it reports the real remaining count and does not silently misreport (e.g. a
      `review`-mode session no longer shows "only cards left"). `QueueScreen.tsx` may default to
      `"full"`. Read-only command — no mutation, no op-log.
- [ ] **Tests:**
      - Vitest `packages/scheduler/src/queue-score.test.ts`: a high-priority overdue fragile
        (low-retrievability) card outscores a fresh low-priority topic; two cards sharing a
        `siblingGroupId` are **not** adjacent in the result; with **both** a card and a source in
        the input, `review` mode floats the card above an otherwise equally-scored source while
        `read` mode does the inverse (the soft type-weight reorders; neither type is dropped — the
        old `modeIncludes` filter is gone); the function is **pure** (same input → same output, no
        randomness); concept de-clumping breaks a run of one concept at the top. Pin the weights so a
        weight change is a deliberate test update.
      - `packages/local-db/src/queue-query.test.ts` (extend): `list({ mode })` returns the
        score order (not the old priority-then-due order) for a seeded mixed due set, the
        drill-down counts + budget gauge are unchanged, and `list()` with no mode defaults to
        `"full"`.
      - Renderer: extend `apps/web/src/pages/queue/QueueScreen.test.tsx` / `ProcessQueue.test.tsx`
        that switching the `SessionMode` re-requests `queue.list` with the new `mode` and reorders
        the visible rows (cards float in `review`, sources in `read`) — and assert the session
        **"N left" counter now reflects the full mixed deck** (it counts every remaining item, not
        the old type-filtered slice), so removing `modeIncludes` does not silently misreport progress.

### Done when

- `/queue` (and the process loop) order by the **scoring function** over priority, due date,
  retrievability, type, sibling spacing, concept diversity, and session mode — a pure, deterministic,
  unit-tested module in `packages/scheduler` that `QueueQuery` composes; the seeded jitter remains a
  separate renderer layer on top; the two-scheduler split is untouched (FSRS rows keep their
  retrievability, attention rows their stage/postpone signals).
- The ordering is **deterministic** (asserted: no randomness in the score) and **survives app
  restart** (it is a read over durable rows; nothing persisted changes).
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the queue/process Playwright specs pass.

### Notes / risks

- **No schema migration.** Every factor reads off the `QueueItemSummary` — but two new fields
  (`siblingGroupId`, `sourceId`) must be **enriched onto** the summary in `QueueQuery` first (they
  are not on it today), both derived from already-present rows/relations (the `sibling_group` edge
  and the `sourceId` already in scope in `sourceContext`), so **no migration** is needed; the scorer
  itself stays pure over the (now-enriched) summary and never reads the DB. Retrievability is the
  existing `approximateRetrievability` until FSRS owns the authoritative number; the score does not
  call `ts-fsrs`.
- **Keep the jitter separate.** Do not fold the 10–20% randomness into the score — the score must
  be reproducible in tests; the renderer's `jitter.ts` applies the small day-varying nudge after.
- **De-clumping is a reorder, not a re-weight of the sum**, so it can't starve a genuinely
  top-priority item: cap how far a high-score item can be pushed down for diversity (a bounded
  swap), and tie-break by id for stability. Document the cap.
- Leave **auto-postpone (T077)** and **catch-up/vacation (T078)** out — T076 only changes ordering.
  But the score's "what's most/least valuable right now" reasoning is exactly what T077 reuses to
  pick postpone victims, so keep `queueItemScore` exported and reusable.

---

## T077 — Auto-postpone

- **Status:** `[ ]`  · **Depends on:** T076
- **Roadmap line:** Done when: when due load exceeds the daily budget, low-priority topics then
  low-priority mature cards are postponed first while high-priority fragile cards are protected.

### Goal

When the **due load exceeds the daily budget** (`getAppSettings().dailyReviewBudget`), the user
can **auto-postpone** the overflow — and the system chooses victims **deterministically by value**:
**low-priority topics/sources/extracts first**, then **low-priority *mature* cards**, while
**never touching high-priority *fragile* cards** (or leeches under repair, or items the user
explicitly protected). Selection is a **pure function** in `packages/scheduler`
(`planAutoPostpone`) over the merged due set; application is **transactional** through the existing
seams — attention items reschedule via `SchedulerService` (`reschedule_element`), cards defer via
the generalized `deferCard` (push `review_states.due_at` forward, **memory state untouched**) —
all under **one shared `batchId`** so the whole sweep undoes as one (T044). The `/queue` overload
`Banner` (the slot left unwired in M5) shows "N over budget" and an **"Auto-postpone N"** action;
the preview tells the user exactly what will move before they commit.

### Context to load first

- Reference: [`../scheduling-and-priority.md`](../scheduling-and-priority.md) "Overload handling →
  Auto-postpone" (the **exact victim order**: low-priority topics → low-priority mature cards;
  protect high-priority fragile cards) + the priority rules (sacrifice low first, protect high
  fragile); `CLAUDE.md` "Priority rules" + "Data rules" (no silent data loss, undoable).
- Existing code to inspect: `packages/scheduler/src/queue-score.ts` (T076 — the value reasoning to
  reuse for victim ranking); `packages/scheduler/src/card-scheduler.ts` (retrievability →
  **fragile** vs **mature** classification; the FSRS vocabulary stays behind it) + `leech.ts`
  (`isLeech` — leeches are excluded); `packages/local-db/src/queue-query.ts` (`QueueQuery.list`
  gives the merged due set + the `budget: { used, target }` gauge — the overflow count is
  `used - target`); `packages/local-db/src/scheduler-service.ts`
  (`rescheduleForAction(id,"postpone",now,batchId)` — the attention apply seam with `batchId`);
  `packages/local-db/src/queue-action-service.ts` (`deferCard`/`bulkPostpone`/`CARD_DEFER_DAYS` —
  the FSRS thin-defer to generalize); `SettingsRepository.getAppSettings().dailyReviewBudget` (the
  threshold); `apps/web/src/pages/queue/QueueScreen.tsx` (the over-budget gauge + the **unwired
  overload `Banner` slot** from `design/kit/app/screen-queue.jsx`).
- Invariants in play: **the two-scheduler split** (topics postpone on the attention scheduler;
  cards defer on FSRS — never crossed; an extract never gets a `review_states` row); **FSRS state
  is NOT corrupted** — a card defer moves only `review_states.due_at` (+ `elements.due_at` in
  lockstep), never `stability`/`difficulty`/`reps`/`lapses`/`fsrsState`, and writes **no review
  log** (a postpone is not a graded review); one transaction + the existing `reschedule_element`
  op per item, all sharing one `batchId`; deterministic selection (no randomness); **high-priority
  fragile memory is protected** (asserted).

### Deliverables

- [ ] **A pure selection planner `packages/scheduler/src/auto-postpone.ts`** exporting
      `planAutoPostpone(items, options)` — **no DB/IPC/React** — that takes the merged due set (the
      `QueueScoreInput[]`/`QueueItemSummary[]` shape, each carrying `priority`, `type`, `scheduler`,
      `schedulerSignals.retrievability`/`.stability`, `cardType`, `protected`, and a `fsrsState`/
      lapse signal) + `{ budget, asOf, protectHighPriority?: true }`, and returns a **deterministic,
      ordered postpone plan**: the list of `{ id, type, scheduler, postponeKind: "attention" |
      "cardDefer" }` to move, and the count, such that the remaining due count ≤ budget. The victim
      order is the doc's exact policy:
      1. **low-priority attention items** (topics/sources/extracts/tasks, band C/D, lowest score
         first per T076's `queueItemScore`);
      2. then **low-priority *mature* cards** — a card is *mature* when its retrievability/stability
         clears a documented `CARD_MATURE_*` threshold (or `fsrsState === "review"` with high
         stability); **never** a *fragile* card (new/learning/relearning, or low stability/
         retrievability) and **never** a high-priority card while `protectHighPriority`;
      3. it **stops** as soon as the due count is back within budget, and it **never selects** a
         high-priority fragile card, a leech (`isLeech`), or a `protected` item.
      Define + export `CARD_MATURE_STABILITY_DAYS` / `CARD_MATURE_RETRIEVABILITY` (the fragile↔mature
      cutline) and `isCardFragile(signals)`/`isCardMature(signals)` so the cutline is named, tested,
      and reused. Export everything from `packages/scheduler/src/index.ts`.
- [ ] **Generalize the FSRS defer** in `packages/local-db/src/queue-action-service.ts`: extend
      `deferCard` to accept a **day count** (default the existing `CARD_DEFER_DAYS`) so auto-postpone
      can push a mature card out by the plan's interval, keeping the existing op shape
      (`reschedule_element` with `{ postpone: true, cardDefer: true, prevReviewDueAt, batchId }`),
      preserving card status, and writing **no review log**. Existing single-day callers are
      unaffected (default arg). **`deferCard` is currently `private` on `QueueActionService`
      (line ~170)** — a separate `AutoPostponeService` cannot call it as-is. Pick one and state it:
      **(a)** make `deferCard` non-private (or lift it to a shared `cardDefer(db, review, id, now,
      days, batchId)` helper both services import), or **(b)** have `AutoPostponeService` compose
      `QueueActionService` and delegate the card path through it. The spec assumes **(a)** — a
      shared, exported card-defer helper — so the apply service below calls it directly without a
      visibility wall.
      - **Two defer shapes — by-N-days AND absolute-date (T078 needs the absolute form).** The
        current `deferCard` (`queue-action-service.ts:170–197`) computes
        `from = max(prevReviewDueAt, now)` then `nextDue = from + days` — a **relative**
        push. That is correct for T077's single-shot "postpone by one cycle" valve. But **T078
        catch-up** assigns each item an **absolute `targetDueAt`** (a specific calendar day in the
        spread), and converting that absolute date back into a "days-from-`max(prevDue, now)`" delta
        is **lossy/ambiguous** — when `prevDue` is already past `now`, days-from-now ≠ days-from-prevDue,
        so the card can land on a *different* day than the plan computed, breaking catch-up's "each
        day ≤ budget" guarantee. So the shared helper exposes **both**: `cardDeferBy(id, now, days,
        batchId)` (relative, what T077 uses — `nextDue = max(prevReviewDueAt, now) + days`) **and**
        `cardDeferTo(id, now, targetDueAt, batchId)` (sets the due to the **exact** `targetDueAt`).
        **Both variants MUST preserve the EXACT op shape + pre-image the existing `deferCard`
        (`queue-action-service.ts:170–197`) already establishes** — there is no new op math, only the
        chosen `nextDue`: in **one transaction**, update `review_states.due_at` **AND** `elements.due_at`
        in lockstep (the queue reads `review_states.due_at` for cards) via `rescheduleWithin`, log
        **`reschedule_element`** with the payload `{ postpone: true, cardDefer: true, prevReviewDueAt,
        ...(batchId ? { batchId } : {}) }` (capturing the `review_states.due_at` PRE-IMAGE as
        `prevReviewDueAt` so command-level undo restores BOTH due fields — T044), **preserve the
        card's status** (pass no `status` — a card lives in active/pending/suspended, never the
        attention-side `scheduled`), and write **NO review log** (FSRS memory state —
        `stability`/`difficulty`/`reps`/`lapses`/`fsrsState` — is left untouched; a defer is not a
        graded review). T078's `applyCatchUp` dispatches cards through `cardDeferTo` so the applied
        per-day load curve **matches the previewed plan**. (Alternatively the planner emits day-deltas
        computed from the **same** base the relative helper uses — but the absolute variant is cleaner
        and is what T078's deliverable assumes.)
- [ ] **An apply service `packages/local-db/src/auto-postpone-service.ts`** (`AutoPostponeService`)
      that composes the planner + the two apply seams: `preview({ asOf })` → reads
      `QueueQuery.list`, computes `budget` overflow, runs `planAutoPostpone`, and returns a flat,
      JSON-serializable **preview** (`{ overBudget, target, used, willPostpone: PostponePreviewRow[],
      remainingAfter }`, each `PostponePreviewRow` = `{ id, title, type, priority, scheduler,
      fromDueAt, toDueAt, reason: "low-priority-topic" | "low-priority-mature-card" }`) **without
      mutating**; `apply({ asOf })` → mints **one `batchId`**, applies each planned item in its
      correct scheduler (attention → `SchedulerService.rescheduleForAction(id,"postpone",now,
      batchId)`; card → the **shared card-defer helper** from the deliverable above, e.g.
      `cardDefer(id, now, days, batchId)` — not the still-private `QueueActionService.deferCard`),
      each in its own transaction with the shared `batchId`, and returns `{ postponed: number,
      batchId }`. Reuses the existing ops only.
- [ ] **New `window.appApi` surface `queue.autoPostpone` (preview) + `queue.autoPostponeApply`**
      across the six files: `channels.ts` (`queueAutoPostpone: "queue:autoPostpone"`,
      `queueAutoPostponeApply: "queue:autoPostpone:apply"`); `contract.ts`
      (`QueueAutoPostponeRequestSchema = { asOf?: IsoTimestampInput }`, `AutoPostponePreview`,
      `AutoPostponeApplyResult = { postponed, batchId }`, added to the `queue` group); `preload`;
      `ipc` (validated); `db-service` (constructs `AutoPostponeService`, calls `preview`/`apply`);
      `apps/web/src/lib/appApi.ts`. Preview is read-only (no op); apply is transactional. Undo
      reuses the **existing** command-level/`batchId` undo (the `reschedule_element` pre-images
      restore both `elements.due_at` and `review_states.due_at`).
- [ ] **Wire the overload `Banner` in `QueueScreen.tsx`** (the slot left unwired in M5): when
      `budget.used > budget.target`, render the kit overload `Banner` — "N items over today's
      budget" + an **"Auto-postpone N"** button that opens a small confirm/preview (the
      `AutoPostponePreview` list: what moves, from→to, why), then calls `queue.autoPostponeApply`,
      re-reads the queue, and shows a `Snackbar` "Postponed N · Undo" (undo → the existing
      `queue.undo`/batch undo). The protected (A-priority) fragile rows visibly **stay**.
- [ ] **Tests:**
      - Vitest `packages/scheduler/src/auto-postpone.test.ts`: given an over-budget mixed set, the
        plan postpones low-priority topics first, then low-priority mature cards, **never** a
        high-priority fragile card, a leech, or a `protected` item, and stops exactly when
        `remaining ≤ budget`; `isCardFragile`/`isCardMature` honor the documented thresholds;
        deterministic (same input → same plan).
      - `packages/local-db/src/auto-postpone-service.test.ts` (seeded `test-db.ts` + an over-budget
        due set): `preview` mutates nothing; `apply` postpones the planned items, appends exactly
        one `reschedule_element` op per item all sharing one `batchId`, defers cards on
        `review_states.due_at` (the **FSRS memory state — `stability`/`difficulty`/`reps`/`lapses`/
        `fsrsState` — is unchanged**, asserted) while rescheduling topics on `elements.due_at`,
        writes **no `review_logs` row**, leaves high-priority fragile cards due, and the batch
        undoes both due fields.
      - Playwright/Electron `tests/electron/auto-postpone.spec.ts`: seed an over-budget queue, open
        `/queue`, the overload `Banner` shows the over-budget count, **Auto-postpone** drops the due
        count to ≤ budget with high-priority cards remaining, Undo restores them, and the result
        **survives app restart** (postponed items stay postponed; nothing lost).

### Done when

- When due load exceeds the daily budget, **Auto-postpone** moves **low-priority topics first, then
  low-priority mature cards**, **protecting high-priority fragile cards** (and leeches + explicitly
  protected items) — deterministic selection in `packages/scheduler`, transactional application
  through the attention scheduler (topics) and an FSRS-aware defer (cards) that **does not corrupt
  FSRS memory state**, every item appending the existing `reschedule_element` op under one
  `batchId`, undoable, and surviving **app restart**.
- The two-scheduler split holds (a card never lands on the attention scheduler; an extract never
  gets a `review_states` row) — asserted by tests.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the auto-postpone Playwright spec pass.

### Notes / risks

- **No schema migration.** The fragile↔mature cutline is computed from existing `review_states`
  fields; the postpone reuses the existing `reschedule_element` op + payload markers; the budget is
  the existing setting. Everything overload-related the doc said to "store now" (`reps`, `lapses`,
  last-processed, postpone counts) is already persisted.
- **Never corrupt FSRS.** A card defer touches `review_states.due_at` (+ `elements.due_at`) **only**
  — never `stability`/`difficulty`/`reps`/`lapses`/`fsrsState`, and writes **no review log**. A
  deferred card resumes its exact FSRS trajectory when it next comes due. Test this explicitly.
- **Fragile vs mature is the heart of the protection rule.** Pick a defensible cutline (e.g. mature
  = `fsrsState === "review"` AND stability ≥ `CARD_MATURE_STABILITY_DAYS`; fragile = anything else,
  incl. new/learning/relearning), document it, and pin it in a test — the whole point is that a
  high-priority *fragile* card is never sacrificed to free up budget.
- **Deterministic, not random.** Auto-postpone must be reproducible (same due set + budget → same
  plan) for tests and user trust; it reuses T076's `queueItemScore` for victim ranking, not jitter.
- Bulk-undo via `batchId` already exists (T044) — reuse it; do **not** add a bespoke undo path.
- Leave **catch-up/vacation (T078)** to the next task; auto-postpone is the single-shot,
  postpone-by-one-cycle valve that T078 generalizes into a multi-day previewed plan.

---

## T078 — Catch-up & vacation modes

- **Status:** `[ ]`  · **Depends on:** T077
- **Roadmap line:** Done when: catch-up recovers from backlog and vacation pre-adjusts future
  load, both showing the cost of postponement.

### Goal

Two human-facing overload tools, both built on T077's deterministic selection + safe application,
and both **showing the COST of postponement before committing** (what slips, by how much):

- **Catch-up** — the user is *behind* (a pile of overdue items exceeds what one day's budget can
  clear). Catch-up **spreads the overdue backlog forward over N days** so each day stays within
  budget, prioritizing high-value/fragile items to the front and pushing low-value to the back —
  recovering gracefully instead of facing an un-clearable wall.
- **Vacation** — the user *will be away* over a date range. Vacation **pre-adjusts future load**:
  it suspends (or shifts) what would come due during the away window and re-spreads it across the
  days after return, so the user comes back to a survivable queue rather than the full backlog on
  day one.

Both are a **pure planner** (`planCatchUp` / `planVacation` in `packages/scheduler`) → a
serializable **preview** that quantifies the cost (items moved, days added, the per-day load curve
before vs after, what newly slips and by how many days) → a **safe, transactional, reversible
apply** that reuses the existing ops (`reschedule_element` for attention items + card defers under
one `batchId`; `update_element` to `suspended`/back for the vacation away-window) and the correct
scheduler per type. Nothing is destroyed; everything is undoable and survives restart.

### Context to load first

- Reference: [`../scheduling-and-priority.md`](../scheduling-and-priority.md) "Overload handling →
  Catch-up / vacation modes — recover from backlog / pre-adjust future load, **always showing the
  cost of postponement**"; the priority rules (high-value to the front of the recovery, low-value
  sacrificed/pushed back); `CLAUDE.md` "Data rules" (no silent loss, undoable, soft state changes).
- Existing code to inspect: `packages/scheduler/src/auto-postpone.ts` (T077 — the victim selection
  + fragile/mature classification to reuse) + `queue-score.ts` (the value ranking); the scheduler's
  date helpers — `scheduleForChoice` in `attention-scheduler.ts`, and `addDays` + `MS_PER_DAY` in
  `date-util.ts` (re-exported from the package index); `packages/local-db/src/
  auto-postpone-service.ts` (T077 — the apply pattern with `batchId` + the preview shape to
  mirror); `packages/local-db/src/scheduler-service.ts` (`scheduleAt`/`rescheduleForAction`);
  `packages/local-db/src/queue-action-service.ts` (`deferCard` by N days); `SettingsRepository`
  (the daily budget = the per-day cap the plans spread under); `ElementRepository.update(id,
  {status})` (`update_element` — the vacation suspend/resume seam; `ElementStatus.suspended`
  already exists); `packages/local-db/src/analytics-query.ts` (the durable due-counts the preview's
  before/after load curve is computed from); `apps/web/src/pages/queue/ProcessQueue.tsx` (the
  presentational `SessionMode` "Mode" `Segmented` — **"the real auto-postpone/catch-up/vacation
  behind 'Mode' is M16 (T077/T078)"**, the seam these modes wire into) + `QueueScreen.tsx`.
- Invariants in play: **the two-scheduler split** (attention items reschedule on the attention
  scheduler; cards defer on FSRS — never re-graded, memory state untouched, no review log; an
  extract never gets a `review_states` row); **the preview never mutates**; the apply is **one
  reversible batch** (`batchId`) of existing ops; vacation suspend uses the existing `suspended`
  status + `update_element`, and resume restores the prior status; deterministic plans (no
  randomness); nothing is hard-deleted.

### Deliverables

- [ ] **Pure planners `packages/scheduler/src/recovery-modes.ts`** — `planCatchUp(items, options)`
      and `planVacation(items, options)`, **no DB/IPC/React**:
      - `planCatchUp({ items, budget, asOf, spreadDays })` — take the overdue/due set + the per-day
        `budget`, and assign each item a **target day** over the next `spreadDays` so each day's
        load ≤ budget, **high-value/fragile items to the earliest days** (reuse T077's value
        ranking + fragile/mature split so fragile high-value cards are recovered first and never
        pushed to the back), low-value to the latest. Returns an ordered plan of
        `{ id, type, scheduler, targetDueAt }` + a **per-day load curve** (before vs after).
      - `planVacation({ items, awayStart, awayEnd, asOf, budget })` — find everything that would
        come due in `[awayStart, awayEnd]`, choose **suspend-for-the-window** (status) vs
        **shift-past-return** (reschedule) per item, and re-spread the shifted load over the days
        **after** `awayEnd` within budget (high-value first). Returns the plan +
        `{ awayStart, awayEnd, suspendedCount, shiftedCount }` + the after-return load curve.
      - Both return a shared **`PostponeCostPreview`** shape that **quantifies the cost**: total
        items moved, the new tail date (how far the last item now lands), the per-day load curve,
        and a `slips: { id, fromDueAt, toDueAt, slipDays }[]` list (what newly slips + by how much)
        — the doc's "always show the cost of postponement". Export all from `index.ts`.
- [ ] **An apply service `packages/local-db/src/recovery-mode-service.ts`** (`RecoveryModeService`)
      with `previewCatchUp({ asOf, spreadDays })` / `applyCatchUp(...)` and
      `previewVacation({ awayStart, awayEnd, asOf })` / `applyVacation(...)`. Previews read
      `QueueQuery.list` + the analytics due-counts and run the pure planners — **no mutation**.
      Applies mint **one `batchId`** and dispatch per item to the correct seam: attention →
      `SchedulerService.scheduleAt(id, { manual: targetDueAt }, now, batchId)`
      (`reschedule_element`, an **absolute** date); card → the **absolute** card-defer helper
      `cardDeferTo(id, now, targetDueAt, batchId)` from T077 (FSRS due only — sets
      `review_states.due_at` + `elements.due_at` to the **exact** planned `targetDueAt`, memory state
      untouched, no review log) — **not** the relative `cardDeferBy(…, days, …)`, so the applied
      per-day load curve matches the previewed plan day-for-day; vacation suspend →
      `ElementRepository.update(id, { status: "suspended" })` (`update_element`), with the prior
      status captured for resume. Each item in its own transaction under the shared `batchId`. A
      `resumeVacation(batchId)` (or the existing batch undo) restores suspended items to their prior
      status and un-shifts the moved ones.
- [ ] **New `window.appApi` surface** across the six files: `channels.ts`
      (`queueCatchUp`/`queueCatchUpApply`/`queueVacation`/`queueVacationApply` — or one
      `queue:recovery` family); `contract.ts` (`QueueCatchUpRequestSchema = { asOf?, spreadDays }`,
      `QueueVacationRequestSchema = { awayStart, awayEnd, asOf? }` with date validation +
      `awayStart < awayEnd`, the `PostponeCostPreview` result, the apply results
      `{ moved, batchId }`, all on the `queue` group); `preload`; `ipc` (validated); `db-service`
      (constructs `RecoveryModeService`); `apps/web/src/lib/appApi.ts`. Previews read-only; applies
      transactional + reversible.
- [ ] **Catch-up + vacation UI** in `apps/web/src/pages/queue/`: a **catch-up** entry from the
      overload `Banner` / a queue header action (when overdue ≫ budget) opening a panel that shows
      the `PostponeCostPreview` — the before/after **per-day load curve**, "N items spread over D
      days", and the `slips` summary ("12 items now due up to 9 days later") — with **Apply** +
      `Snackbar` undo; a **vacation** entry (a date-range picker, e.g. from `/settings` or the queue
      header) that previews the away-window cost (suspended vs shifted, the after-return curve) and
      **Apply** + undo/`resume`. Both surfaces make the **cost explicit before committing** (the
      Done-when requirement). Reuse the kit `Banner`/`Segmented`/`Snackbar`; no new visual language.
- [ ] **Tests:**
      - Vitest `packages/scheduler/src/recovery-modes.test.ts`: `planCatchUp` keeps each day ≤
        budget, puts high-value/fragile items on the earliest days and low-value last, and the
        per-day curve + `slips` are correct; `planVacation` moves exactly the items due in the away
        window (suspend vs shift), re-spreads after return within budget, and reports the cost;
        both are deterministic and never select a protected high-priority fragile card to sacrifice.
      - `packages/local-db/src/recovery-mode-service.test.ts` (seeded backlog/away set): previews
        mutate nothing; `applyCatchUp` reschedules attention items + defers cards under one
        `batchId` (existing ops only, **FSRS memory state unchanged**, **no review log**), and each
        card lands on its **exact planned `targetDueAt`** (asserting the `cardDeferTo` absolute path —
        the applied per-day due curve **equals the previewed** curve, including for a card whose
        `prevDue` was already overdue, which a relative `cardDeferBy` would have mis-placed);
        `applyVacation` suspends/shifts via `update_element`/`reschedule_element`, captures prior
        status, and `resume`/batch-undo restores everything; both survive a reopen.
      - Playwright/Electron `tests/electron/recovery-modes.spec.ts`: seed a backlog, run **Catch-up**
        — the daily due count drops to ≤ budget across days, the preview showed the cost, Undo
        restores; seed an away range, run **Vacation** — items due in the window are suspended/shifted
        and the after-return load is within budget; **restart the app** and assert the plans
        persisted (suspended stays suspended, shifted stays shifted, nothing lost).

### Done when

- **Catch-up** recovers from a backlog (spreads the overdue pile forward over N days, each day ≤
  budget, high-value/fragile first) and **vacation** pre-adjusts future load (suspends/shifts the
  away-window due items and re-spreads after return) — **both showing the COST of postponement**
  (items moved, days added, the before/after per-day load curve, what slips + by how much) **before
  committing**; planning is pure + deterministic in `packages/scheduler`; application is one
  reversible `batchId` of existing ops through the correct scheduler per type; everything survives
  **app restart** and is undoable.
- The two-scheduler split holds throughout (cards defer on FSRS with memory state untouched + no
  review log; attention items reschedule on the attention scheduler; vacation suspend is a status
  change, not a scheduler cross) — asserted by tests.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the recovery-modes Playwright spec pass.

### Notes / risks

- **No schema migration.** Catch-up/vacation reuse `reschedule_element` (attention + card defer) +
  `update_element` (`suspended`/resume) — the `suspended` status and the `batchId` payload marker
  already exist. The before/after load curve is computed from durable due dates; nothing new is
  stored.
- **The cost preview is the headline requirement** — it is explicit in the Done-when. Make the
  per-day load curve + the `slips` list (what moves + by how many days) the centerpiece of both UIs
  and **always show it before apply**. Do not let an "apply" path skip the preview.
- **Vacation: prefer suspend over destructive moves for the away window**; resume restores the prior
  status exactly (capture it). Never hard-delete or drop an away-window item.
- **Reversibility:** both apply under one `batchId` so the existing batch undo reverses the whole
  plan; vacation additionally offers an explicit `resume`. Keep all pre-images in the op payload so
  undo restores both `elements.due_at` and (for cards) `review_states.due_at`.
- **Determinism + protection:** reuse T077's value ranking + fragile/mature split so high-value
  fragile memory is recovered first and never sacrificed; no randomness in the plans.
- Workload **simulation** of *arbitrary* what-ifs (changing desired retention, adding cards) is
  **T081** — T078's preview is scoped to the catch-up/vacation plans themselves. Per-priority/
  per-concept retention (**T079**), FSRS-param optimization (**T080**), and mature-card retirement
  (**T082**) are the rest of M16, specced separately.

---

## Exit criteria for T076–T078 (the M16 overload core)

- **T076–T078 are `[x]`** in [`../roadmap.md`](../roadmap.md) (T079–T082 remain — they are the rest
  of M16, specced separately).
- **Auto-sort (T076):** the `/queue` + process-loop ordering is a **pure, deterministic, unit-tested
  scoring function** in `packages/scheduler` over priority, due date, retrievability, type, sibling
  spacing, concept diversity, and **session mode**, composed by `QueueQuery.list`; the seeded jitter
  remains a separate renderer layer; the two-scheduler split is read-only and intact.
- **Auto-postpone (T077):** over-budget due load is relieved by postponing **low-priority topics
  first, then low-priority mature cards**, **protecting high-priority fragile cards** (+ leeches +
  protected items) — deterministic selection, transactional application through the attention
  scheduler (topics) and an FSRS-aware defer (cards) that **never corrupts FSRS memory state or
  writes a review log**, every item under one `batchId` of the existing `reschedule_element` op,
  undoable, restart-durable.
- **Catch-up & vacation (T078):** catch-up spreads a backlog forward and vacation pre-adjusts the
  away-window load, **both showing the cost of postponement** (items moved, days added, before/after
  per-day curve, what slips + by how much) **before committing**; pure deterministic planners,
  reversible one-`batchId` application of existing ops, restart-durable.
- **The two-scheduler split holds throughout:** attention items act on the attention scheduler;
  cards defer on FSRS with memory state untouched; an extract never gets a `review_states` row; a
  card never gets the attention heuristic — asserted by tests in every task.
- **No new op types** (the closed 15-op set is unchanged); **no schema migration** for T076–T078;
  every mutation is **one transaction** + the correct existing `operation_log` op; soft-delete only;
  all results **survive app restart**.
- All new capabilities reach the renderer **only** through new typed `window.appApi` commands
  (`queue.list` extended with `mode`; `queue.autoPostpone`/`…Apply`; the `queue.recovery` /
  catch-up + vacation family) with Zod-validated IPC; **no raw DB/filesystem access is exposed to
  the renderer**, no generic `db.query`. **All scoring/selection/planning math lives in
  `packages/scheduler` (and priority math in `packages/core`), never in a React component.**
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the M16 overload Playwright specs (auto-sort
  reorders → over-budget banner → auto-postpone within budget → catch-up/vacation preview-then-apply
  → survives restart, high-priority fragile cards protected throughout) are green.

When T076–T078 are complete, continue M16 with T079 (desired retention by priority/concept) before
T080–T082 (FSRS-param optimization, workload simulation, mature-card retirement).

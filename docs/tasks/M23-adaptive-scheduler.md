# M23 — The adaptive attention scheduler (T111–T114)

> The flagship gap — the only finding all six ideation frames produced independently (survivor
> #1; the SuperMemo A-Factor analog). The attention scheduler is a static band lookup
> (`sourceIntervalDays` returns `{A:1, B:7, C:30, D:90}` forever); T111 has now wired
> `lastSeenAt` into `nextDueAt` as a bounded recency credit, while the rich yield signals reduce to
> exactly two binary branches in `adjustForSourceProcessing` (halve when high-priority with >25%
> unresolved; double + `retirementSuggestion` when dead). `docs/scheduling-and-priority.md` and
> the package charter promise inputs ("last processed date", "whether the element produced
> useful children", "stagnation") the engine provably ignores — close the spec-vs-code gap from
> the code side. `docs/solutions/architecture-patterns/durable-source-block-processing-state.md`
> names source-yield scheduler inputs as the intended unbuilt seam.
>
> **Order is load-bearing:** T104 (value model v2) must be `[x]` before T112 — yield-keyed
> scheduling on the cards-only value function would punish synthesis-driven reading.
>
> **Shared invariants for every task in this file.** Sources/topics/extracts are attention-
> scheduled ONLY — never touch `review_states` (FSRS is cards-only). Scheduling stays
> deterministic and unit-testable (pure functions in `packages/scheduler`, composed by
> `SchedulerService` in `packages/local-db`). Every scheduling change adds drift-diagnostic
> cases (`docs/solutions/logic-errors/queue-eligibility-inventory-scheduler-state.md`) and
> respects the explainability bar (no unexplained interval change reaches the UI — that is
> T113, and T112 must not ship to users without it; build T112 behind a flag if landing
> separately). Update `docs/scheduling-and-priority.md` as each input becomes real.
>
> **Standard gates (inherited by every task below):** `pnpm lint` · `pnpm typecheck` ·
> `pnpm test` · relevant `pnpm e2e`; persistence survives restart; mutations transactional +
> op-logged; no unrelated refactors.
>
> **File/line references** verified 2026-06-09/10; re-verify with grep before editing.

---

# T111 — Consume recency (`lastSeenAt`)

- **Milestone:** M23 — Adaptive attention scheduler
- **Status:** `[x]` complete in `d4489520`
- **Depends on:** T028, T076
- **Roadmap line:** `lastSeenAt` feeds interval computation so untouched-but-due elements stop
  interleaving identically with just-processed ones; deterministic, unit-tested, with a
  drift-diagnostic case.

## Goal

The smallest real scheduler change first: wire the already-reserved recency axis into
`nextDueAt`. This proves the extension seam end-to-end (descriptor → interval function → due
write → queue) before the larger multiplier lands, and removes the obvious wart where the
engine cannot tell "processed yesterday" from "ignored for a month".

## Context to load first

- Existing code: `packages/scheduler/src/attention-scheduler.ts` — the `Schedulable` descriptor,
  `sourceIntervalDays`, `extractStageIntervalDays`, `postponeIntervalForPriority`; `packages/local-db/src/scheduler-service.ts` — where
  descriptors are built and `lastSeenAt` is supplied from pre-action `updatedAt`; scheduler unit
  tests as the spec of current behavior.
- Invariants: pure-function determinism (clock injected, never `Date.now()` inside the math).

## Deliverables

- [x] Define and document the recency rule in-code (e.g., a damping term so a just-processed
      element's next return is computed from `lastSeenAt`, not from a band table applied to
      "now"; an element untouched far past its due gets a bounded freshness boost in queue
      score, not a punishment). Keep it small — this is one input, not the multiplier.
- [x] Ensure `lastSeenAt` is populated correctly for sources, topics, and extracts at every
      processing action (grep all `SchedulerService` write paths).
- [x] Delete/replace the old placeholder comment with the real contract; update
      `docs/scheduling-and-priority.md` accordingly.
- [x] Drift diagnostic: a case detecting `lastSeenAt`-vs-due inconsistency.
- [x] Tests: unit table-tests for the new term (boundary: never-seen, just-seen, long-overdue);
      scheduler-service integration proving writes populate the field.

## Completion notes

- Recency rule: after priority/stage/action/source-processing chooses the base interval,
  `nextDueAt` applies whole-day credit from valid `lastSeenAt`, capped at half the base interval
  with a one-day minimum. Missing, invalid, sub-day, or future values keep the base interval.
- Local-db seam: `SchedulerService` computes recency from pre-action `updatedAt`, persists the
  action clock through the reschedule timestamp seam, and records heuristic `scheduledAt` payloads
  for diagnostics. Explicit choices and queue-soon remain outside the heuristic drift rule.
- Verification: focused `pnpm exec vitest run packages/scheduler/src/attention-scheduler.test.ts`,
  `pnpm --filter @interleave/local-db test -- scheduler-service`,
  `pnpm --filter @interleave/local-db test -- scheduler-consistency-query`, and
  `pnpm --filter @interleave/local-db test -- element-repository`.

## Done when

- Two otherwise-identical elements with different `lastSeenAt` get different, correctly-ordered
  next dues; the old placeholder comment is gone; the doc matches the code; drift case exists.
- Standard gates pass.

## Notes / risks

- Queue-stability: a one-time global re-sort on upgrade is acceptable but must be boring —
  verify with a seeded 100k fixture (M20 harness) that the first post-upgrade queue
  materialization stays performant and sane.

---

# T112 — Yield-adaptive interval multiplier

- **Milestone:** M23 — Adaptive attention scheduler
- **Status:** `[x]` complete
- **Depends on:** T104, T111
- **Roadmap line:** each source/extract carries a bounded per-element interval multiplier
  (≈×0.5–×4 of band base) updated on every processed visit from v2 yield, with priority
  modulating growth — replacing the two binary `adjustForSourceProcessing` branches.

## Goal

The A-Factor analog: productive material returns sooner; exhausted material recedes with
dignity. A 50-pass A-source that yields ten extracts per visit and one that yields nothing stop
sharing a cadence, and a maturing collection's attention load finally amortizes instead of
growing linearly with source count.

## Context to load first

- Existing code: `adjustForSourceProcessing` (the two branches this replaces — keep
  `retirementSuggestion` emission, T103 consumes it); the v2 value model (T104,
  `packages/core/src/source-yield.ts`); per-visit yield facts (block-processing service rows,
  extraction lineage counts); `schedulerSignals` plumbing (T113 will surface reasons — emit the
  structured reason from day one).
- Invariants: bounded and monotone-sane (one visit can move the multiplier only one step);
  deterministic; the multiplier is element state persisted with the schedule (Drizzle migration)
  and restored by undo preimages like any schedule field.

## Deliverables

- [x] Multiplier definition in `packages/scheduler` (pure): inputs = v2 yield of the visit
      (extracts/statements/cards/synthesis produced, honorable fates), unresolved ratio, and
      priority (higher priority → slower interval growth, mirroring SM's priority↔A-Factor
      coupling). Bounds ≈ [0.5, 4.0] on the band base; step-limited per visit; documented
      in-code with the growth table.
- [x] Persistence: per-element multiplier column + migration; written transactionally with the
      schedule on each processed visit; undo preimages logged.
- [x] Replace the two binary branches with the graded path (dead-source case still emits
      `retirementSuggestion`).
- [x] Feature flag/setting: "adaptive intervals" default ON only once T113 ships; OFF falls back
      to band tables (keep the fallback path tested).
- [x] Drift diagnostic: multiplier-out-of-bounds and multiplier-vs-history inconsistency cases.
- [x] Tests: table-tests across the yield×priority grid (productive A-source shortens; barren
      C-source lengthens toward retirement; synthesis-only output counts as productive — the
      T104 regression test); 100k-fixture performance check; e2e — a productive fixture source
      visibly returns sooner than its band floor after two visits.

## Completion notes

- Added `elements.attention_interval_multiplier` with a SQLite migration, Drizzle snapshot, core
  element mapping, repository write support, and undo restoration via `reschedule_element`
  preimages.
- Added the typed `scheduler.adaptiveAttentionIntervals` setting, defaulting `false` until T113
  exposes schedule reasons in the UI. With the flag off, source/extract scheduling keeps the
  pre-T112 band/legacy source-processing behavior.
- Added the pure adaptive multiplier path in `@interleave/scheduler`: processed source/extract
  visits can shorten, hold, or lengthen the bounded multiplier `[0.5, 4.0]`; dead-source
  retirement suggestions remain available.
- Scheduler application captures command-scoped source/extract yield baselines before the
  transaction, computes after-counters after the mutation, records structured adaptive diagnostics
  in the same `reschedule_element` op, and uses a bounded latest-adaptive-payload lookup instead
  of scanning full element history.
- Source/extract yield counters include child extracts, cards, synthesis-note references,
  honorable extract fates, atomic-statement output, and block-processing output so
  synthesis-driven reading is counted as productive.
- Verification: `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm e2e
  tests/electron/extraction.spec.ts tests/electron/extract-review.spec.ts` (rerun with local
  server-binding escalation after sandbox `listen EPERM`).

## Done when

- The multiplier behaves per the documented table, persists, restores through undo, respects
  bounds, and the binary branches are gone; with the flag off, behavior is byte-identical to
  pre-T112 scheduling (snapshot test).
- Standard gates pass.

## Notes / risks

- Start conservative: narrow bounds and small steps; widening later is cheap, rebuilding trust
  is not.
- Do NOT consume raw card lapse data here — that input arrives in T114 with its own caps.

---

# T113 — Schedule explainability

- **Milestone:** M23 — Adaptive attention scheduler
- **Status:** `[x]` complete
- **Depends on:** T112
- **Roadmap line:** wherever a due date is shown, a learned interval change carries a structured
  one-line reason via `schedulerSignals`; no unexplained interval change reaches the UI.

## Goal

The trust contract for the adaptive scheduler: every learned deviation from the band base is
explainable in one plain line — "returning in 3d instead of 7d: last visit produced 6 extracts"
/ "receding: 3 visits without output". The feed-ranking lesson: decay functions users can't see
read as the system being broken.

## Context to load first

- Existing code: `schedulerSignals` on queue rows (T112 emits structured reasons), queue row UI
  + inspector schedule section, DoneIntentMenu breakdown copy style (domain-predicate-derived
  copy that cannot drift — same discipline here).
- Invariants: reasons are computed domain-side and carried as structured data (kind + numbers);
  the renderer formats, never re-derives.

## Deliverables

- [x] Reason vocabulary (small union: `yield_shortened`, `yield_lengthened`, `recency_damped`,
      `postpone_recession`, `source_unresolved_shortened`, `source_exhausted_lengthened`,
      `descendant_lapses` (emitted by T114 when descendant-health evidence crosses threshold),
      `band_base`) carried on schedule reads.
- [x] Queue row affordance (inline) + inspector line rendering the reason; band-base
      schedules show nothing (silence is the default state, not noise).
- [x] T112's flag flips to default-ON here (adaptive intervals ship to users only with reasons
      attached).
- [x] Tests: unit (reason emission matches the interval math for each branch); renderer unit
      (formatting); e2e — productive fixture shows the shortened-reason line.

## Done when

- Every non-band-base due date in queue/inspector carries its reason; copy comes from structured
  signals; adaptive scheduling is on by default.
- Standard gates pass.

## Notes / risks

- Keep the union closed and exhaustively switched — a new scheduler input without a reason kind
  must fail typecheck, not render blank.
- T113 persists `scheduleReason` on the governing `reschedule_element` operation and only projects
  it while that operation's `dueAt` still matches `elements.due_at`; explicit choices and
  queue-soon reschedules stay silent.

## Completion notes

- Added the closed `AttentionScheduleReason` vocabulary and durable `scheduleReason` projection
  through scheduler decisions, `operation_log`, queue rows, inspector reads, and the desktop IPC
  contract.
- Queue rows, home preview rows, and the inspector scheduler section now render visible one-line
  reasons from structured data; `band_base`, explicit choices, queue-soon, stale ops, malformed
  diagnostics, and under-evidenced reasons stay silent.
- Flipped `scheduler.adaptiveAttentionIntervals` to default-on and added boundary coverage that the
  typed settings patch accepts boolean updates.
- Verification: `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm e2e -- tests/electron/schedule-explainability.spec.ts`.
- Learning captured in
  [`docs/solutions/architecture-patterns/trusted-schedule-reasons-from-governing-reschedule-ops.md`](../solutions/architecture-patterns/trusted-schedule-reasons-from-governing-reschedule-ops.md).

---

# T114 — Descendant-health input

- **Milestone:** M23 — Adaptive attention scheduler
- **Status:** `[x]` complete; commit `feat: T114 descendant health input`
- **Depends on:** T112
- **Roadmap line:** descendant-card lapse rate feeds the multiplier (struggling descendants pull
  the parent source back sooner), capped and explained, with tests proving a lapsing cluster
  shortens the parent's return interval.

## Goal

The first back-edge from review into attention scheduling: when the cards built from a source
keep failing, the source itself returns sooner — comprehension debt pulls re-exposure. (The
full re-reading proposal workflow is M28; this task is only the scheduling input.)

## Context to load first

- Existing code: review_logs lapse data + lineage joins (T040 leech detection has the lapse
  semantics; M28's T128 will formalize clustering — share the join logic if T128 lands first,
  otherwise keep this task's query minimal and let T128 absorb it), T112's multiplier inputs,
  T113's reason union (`descendant_lapses`).
- Invariants: capped influence (descendant lapses can shorten, never lengthen, and only within
  the multiplier bounds); cards' own FSRS scheduling is untouched.

## Deliverables

- [x] Descendant lapse-rate input on the descriptor: only live descendant cards that are
      active/scheduled and non-retired contribute; the signal requires at least 3 true lapse
      increments across at least 2 affected cards in the last 30 days, with a windowed lapse rate
      of at least 10%.
- [x] `descendant_lapses` reason emitted when the input bites after review-triggered source
      reschedules; manual explicit schedules and queue-soon commands suppress stale reason
      projection.
- [x] Transient interval pressure is capped at a maximum 25% shortening and can never lengthen a
      source or alter descendant cards' own FSRS schedules.
- [x] Tests: unit — a lapsing-cluster fixture shortens the parent's interval within cap; a
      healthy-descendants fixture is a no-op; e2e — inspector shows the reason on a seeded
      struggling source.

## Done when

- A source with a struggling descendant cluster returns measurably sooner, capped, with the
  reason visible; healthy sources are unaffected.
- Standard gates pass.

## Completion notes

- `descendant_lapses` is no longer reserved: it is emitted only from review-triggered source
  reschedules after the lapse floor, affected-card floor, 30-day window, and 10% lapse-rate floor
  are all met.
- Manual explicit schedules and queue-soon commands remain user intent, not heuristic evidence, and
  therefore suppress stale descendant-lapse reason projection.
- Verification: `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm e2e -- tests/electron/schedule-explainability.spec.ts`.

## Notes / risks

- Noise control: ignore lapse counts below a floor (1–2 lapses is review noise, not
  comprehension debt) — align the floor with T128's clustering threshold when both exist.

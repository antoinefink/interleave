# M24 — Ambient, time-denominated overload (T115–T118)

> Queue bankruptcy is the #1 documented abandonment cause for incremental-reading tools, and the
> entire point of overload-tolerance-by-design is that the user never faces the raw backlog.
> Today the budget is an item count (`dailyReviewBudget`, `packages/core/src/settings.ts:42`,
> default 60 — one 6-second cloze and one 90-minute PDF pass both cost "1") and auto-postpone is
> a manual ceremony (`apps/web/src/pages/queue/OverloadBanner.tsx:5-12`: banner → preview →
> confirm, every overloaded morning — exactly when an overwhelmed user is likeliest to bounce).
> SuperMemo runs auto-postpone before the session, unattended. All the safety machinery exists
> (deterministic planner, preview math, `batchId` batch undo, op-log audit) — only the unit and
> the trigger are wrong. Ideation survivor #2.
>
> **Order is load-bearing:** T105 (priority-integrity ledger) must be `[x]` before T117 —
> automation rides on receipts. House precedent to respect: auto-scheduling fresh *imports* was
> explicitly rejected (`docs/solutions/ui-bugs/daily-work-read-model-inbox-only-routing.md`);
> deferring already-due work is a different operation, but build the receipts/undo contract to
> the standard that rejection set.
>
> **Standard gates (inherited by every task below):** `pnpm lint` · `pnpm typecheck` ·
> `pnpm test` · relevant `pnpm e2e`; persistence survives restart; mutations transactional +
> op-logged; read models behind typed IPC; no unrelated refactors.
>
> **File/line references** verified 2026-06-09/10; re-verify with grep before editing.

---

# T115 — Per-item time-cost model

- **Milestone:** M24 — Ambient, time-denominated overload
- **Status:** `[x]` done
- **Depends on:** T037, T083
- **Roadmap line:** a typed read model estimates per-item minutes — cards from median graded
  response times in `review_logs` by timing bucket; attention rows use documented defaults until
  elapsed attention-work telemetry exists. Every default is flagged.

## Goal

The pricing function everything in this milestone consumes: how many minutes does this queue
item actually cost? Learned from telemetry the app already records, honest about uncertainty
when history is thin.

## Context to load first

- Existing code: `review_logs` response-time capture
  (`docs/solutions/architecture-patterns/review-analytics-data-capture-in-review-logs.md`),
  T083's per-source time-spent rollup (review time only, not elapsed reading time), the queue
  header's display-only "est. minutes" (`QueueScreen.tsx:5` — this model replaces its guesswork),
  media `durationMs`.
- Invariants: pure read model; estimates carry their confidence (`learned` vs `default`) so
  consumers can label them.

## Deliverables

- [x] `TimeCostQuery` in `packages/local-db`: full due-set minute estimates — cards: rolling
      median graded review time by timing bucket (Q&A / cloze / occlusion / audio) with audio
      falling back to the base card bucket, then defaults; attention rows: documented defaults
      because elapsed reading/extract-processing time is not yet persisted. Coarse documented
      defaults when an estimator has < 3 valid observations, flagged `default`.
- [x] Typed IPC surface through `queue.list`; Queue and Home header estimates are rewired to this
      model and labeled "~" plus accessible explanatory text when any component is `default`.
- [x] Tests: unit with seeded logs proving medians, fallbacks, and the learned/default flag;
      contract/preload/appApi/UI tests.

## Done when

- Given seeded history, the model prices a mixed queue correctly and flags thin-history
  estimates; the queue header uses it.
- Standard gates pass.
- Completion verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant Electron queue
  E2E.

## Notes / risks

- Outlier discipline: medians, not means — one walked-away-from-the-desk review must not poison
  a card type's cost.
- Source/extract elapsed work is intentionally not inferred from read progress, media duration, or
  T083 review-time rollups. Those rows remain default-priced until a later task records actual
  attention-work timings.
- Implementation commit: bd3b8cce.

---

# T116 — Minutes-denominated daily budget

- **Milestone:** M24 — Ambient, time-denominated overload
- **Status:** `[ ]` not started
- **Depends on:** T115
- **Roadmap line:** the daily budget is set in minutes (count setting migrated with a sensible
  conversion), the queue gauge projects today's real time cost, and over-budget detection
  compares minutes to minutes.

## Goal

Re-denominate the overload system in the unit the user actually runs out of. The budget meter
stops lying ("12/40 items" hiding three hours of reading) and every protection rule downstream
sizes the protected subset honestly.

## Context to load first

- Existing code: `packages/core/src/settings.ts:42` (`dailyReviewBudget` count, default 60, and
  its consumers — grep all reads), the BudgetMeter/queue gauge, over-budget detection feeding
  the OverloadBanner, T077 victim-selection ("remaining due count ≤ budget" becomes "remaining
  due minutes ≤ budget").
- Invariants: settings migration is one-way with a derived default (count × median item cost at
  migration time, rounded to a sane preset); keep the old key readable for rollback one release.

## Deliverables

- [ ] Settings: `dailyBudgetMinutes` (+ migration from the count; Settings UI updated with
      presets like 15/30/60/120).
- [ ] Queue gauge: projected minutes of today's plan vs budget (T115 pricing, uncertainty
      labeled); over-budget detection in minutes.
- [ ] T077 planner: victim selection trims to the minute envelope (same priority-ordered
      protection rules; cut math in minutes) with an explicit reserve buffer (e.g. plan to
      budget − 10%).
- [ ] Tests: unit (planner trims mixed-cost fixtures correctly — a day of 30 cheap clozes and a
      day of 3 heavy sources both land within budget); migration test; e2e — gauge renders
      minutes, banner triggers on a minute-overloaded fixture.

## Done when

- Budget is set and enforced in minutes end-to-end; mixed-type fixture days are sized correctly;
  the count setting is migrated.
- Standard gates pass.

## Notes / risks

- Cold start: with zero history everything is `default`-priced — acceptable; label it and let
  estimates tighten with use (T115's flag).

---

# T117 — Standing auto-postpone policy

- **Milestone:** M24 — Ambient, time-denominated overload
- **Status:** `[ ]` not started
- **Depends on:** T058, T077, T105
- **Roadmap line:** an opt-in policy (off / suggest / automatic) runs the T077 planner main-side
  at day rollover; every automatic run writes one `batchId`, a receipt line with one-tap undo
  appears in the daily summary, and the overload banner remains as manual override.

## Goal

The user who most needs the valve is the least likely to operate it daily. With the policy on
"automatic", the day opens already trimmed to budget with a calm receipt ("14 low-priority items
slipped — undo") — overload tolerance becomes ambient, the way SuperMemo ships it, with a
stronger audit trail than SuperMemo ever had.

## Context to load first

- Existing code: the T077 planner + apply path (`queue.autoPostpone` preview /
  `queue.autoPostponeApply`, `batchId` undo), OverloadBanner (stays as the manual override and
  the "suggest" surface), the T058 background runner (day-rollover trigger; see how
  `vault_verify` jobs are scheduled/applied — same pattern: worker is DB-free, main applies),
  daily-work summary surface (receipt line), T105 ledger (consumes the batches).
- Invariants: the plan is computed and applied MAIN-side in one transaction; protection rules
  identical to manual auto-postpone (top-priority and today's fragile cards never trimmed);
  idempotent per local-day (at-least-once job delivery must not double-trim — guard on a
  per-day marker).

## Deliverables

- [ ] Setting: `overloadPolicy: off | suggest | automatic` (default `suggest` for existing
      users; onboarding may default new users to `automatic` — decide and document).
- [ ] Day-rollover trigger: on first queue materialization of a local day (or a runner job at
      rollover — pick one, document why; first-materialization avoids wall-clock jobs while the
      app is closed), `suggest` pre-computes the plan and one-taps from the banner; `automatic`
      applies it, writes one `batchId`, marks the day.
- [ ] Receipt: daily-work summary line — items trimmed, bands affected, one-tap undo (whole
      batch); receipt persists for the day, not just a toast.
- [ ] T105 integration: automatic batches visibly attributed in the integrity ledger.
- [ ] Tests: unit (idempotence per day; protection rules hold; undo restores the full batch with
      preimages); e2e — overloaded fixture + automatic policy opens onto a within-budget day
      with the receipt, undo restores, second open does not double-trim.

## Done when

- With the policy on automatic, an overloaded morning opens within budget, shows the receipt,
  undoes in one tap, never double-trims, and every sacrifice is ledgered in T105.
- Standard gates pass.

## Notes / risks

- Trust is the whole feature: if anything about the trim is not visible/undoable/attributable,
  stop and fix that before shipping the trigger.
- Vacation/catch-up (T078) interplay: a day inside an active vacation plan should skip the
  policy (document the precedence).

---

# T118 — Session assembly ("what fits in N minutes")

- **Milestone:** M24 — Ambient, time-denominated overload
- **Status:** `[ ]` not started
- **Depends on:** T116
- **Roadmap line:** the user can request a session sized to N minutes; composition respects
  priority order, protection rules, and the T119 quota when present, and states what was left
  out and why.

## Goal

The positive-space twin of trimming: "I have 25 minutes" produces a session plan priced by
T115 — highest-value work first, honest about what didn't fit. Sized sessions make budget
overruns a choice instead of a surprise.

## Context to load first

- Existing code: queue scoring (T076 `queue-score.ts` — assembly must respect it, not re-rank),
  ProcessQueue session flow (the assembled session feeds the same one-item-at-a-time loop),
  T115 pricing, T119 quota (consume when present; degrade gracefully before it lands).
- Invariants: assembly is a read-model plan until started — nothing reschedules by being left
  out of a session.

## Deliverables

- [ ] Session-plan read model: given N minutes, fill by queue-score order within type-protection
      rules (and the T119 distillation share when available), pricing by T115; return the plan +
      the cut list with reasons ("didn't fit: 12 items, ~40 min").
- [ ] UI: a "Start a session" affordance on queue/home (N presets + free entry) → plan preview →
      run through ProcessQueue; end-of-session summary (planned vs actual minutes — feeds T115's
      future tuning).
- [ ] Tests: unit (fill math, protection rules, cut-list honesty); e2e — 25-minute session on a
      mixed fixture assembles, runs, and summarizes.

## Done when

- Requesting a 25-minute session yields a priced, protection-respecting plan that runs in the
  existing process loop and reports planned-vs-actual at the end.
- Standard gates pass.

## Notes / risks

- Do not let session assembly become a parallel scheduler: it selects from what is due/eligible
  by existing rules; it never changes due dates.

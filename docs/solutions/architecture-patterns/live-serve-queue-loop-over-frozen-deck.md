---
title: "Serve the next best item from the live queue instead of a frozen accepted deck"
date: "2026-06-23"
category: "architecture-patterns"
module: "process-queue"
problem_type: "architecture_pattern"
component: "frontend"
severity: "medium"
applies_when:
  - "A processing loop should resume on reload/deep-link with zero data loss instead of losing an in-memory plan."
  - "A time budget should inform the user (an ambient gauge) rather than gate the session (a hard wall)."
  - "A cross-surface refresh must update a running loop without restarting it or yanking the user's place."
related_components:
  - "service_object"
  - "testing_framework"
tags:
  - "queue"
  - "process-queue"
  - "live-serve"
  - "session"
  - "time-cost"
  - "minute-budget"
  - "distillation-quota"
  - "undo"
---

# Serve the next best item from the live queue instead of a frozen accepted deck

## Context

`/process` used to run a **frozen accepted deck**: the queue preview assembled a bounded
plan, stored it in an in-memory module variable, navigated to `/process?assembled=1`, and
the loop walked that exact snapshot to a hard "done" wall. If the snapshot was missing
(reload, deep-link, back-button) the loop showed a **"Session plan expired"** dead-end —
the one ephemeral, non-durable artifact in an otherwise durable, op-logged system, and the
visible symptom of losing it. Incremental reading is a continuous stream ("interrupted
reading is normal"), so the frozen-deck/batch frame fought the product's grain.

The replacement: the **live queue is the session**. `/process` always serves the next best
item from the live scored queue; the preview becomes a non-binding **forecast** and the
time budget becomes an **ambient, adaptive gauge** with a soft "wrap up or keep going?"
nudge. Reopening mid-stream resumes at the next best item, and "expired" is unrepresentable.

## Guidance

**Split the loop's load into `rebuildDeck` and `repriceDeck`.** A monolithic `load()` that
re-reads on every signal (mount, mode switch, *and* cross-surface refresh) restarts the
session — resetting the cursor, processed count, and jitter. That is a latent bug in a
frozen-deck model (the deck looked the same after a restart) and a constant, place-losing
disruption in a live-serve model (the order changes on every read).

- `rebuildDeck` — mount, mode switch, manual "Reload", and a user-confirmed end-of-order
  continuation. Re-reads `listQueue({ includeTimeEstimate: true })`, re-jitters, and resets
  the cursor + session bookkeeping.
- `repriceDeck` — after each *mutating* action, on `queueRefresh`, and once at end-of-order.
  Always re-prices the gauge from the live due universe. When reconciling (an external
  mutation may have changed upcoming items) it **reconciles by id**: the already-seen prefix
  stays put (no re-jitter), the current item is preserved (or the loop advances to the
  nearest surviving item if it vanished), and genuinely-new work is appended at the tail in
  score order. A failed reprice is **non-destructive** — it never blanks a live session. A
  refresh that lands mid-action is deferred via a dirty flag and flushed when busy clears,
  so external mutations are never lost.

A pure *skip* (cursor advance, no DB change) must NOT reprice — the due set is unchanged.
Only mutations (act/grade/schedule/lineage-delete) reprice.

**Guard the many fire-and-forget reads with a single-flight token + a mounted ref.** Once
several `void repriceDeck()` calls fire from different sites (each action, the queueRefresh
listener, the busy-clear flush, the end-of-order check), they race: with no ordering guard
the *later-resolving* read wins regardless of start order, and a stale reconcile resolving
*after* a `rebuildDeck` re-pollutes the freshly-reset seen-id set — which permanently
suppressed the end-of-order "keep going". The fix is two refs, not a fetching library:

- `loadSeqRef` — every read (rebuild + reprice + end-of-order) bumps it at START and
  captures its value; after the await it applies its result only if it is still the latest
  (`seq === loadSeqRef.current`). Newest-started read wins; stale in-flight reads bail
  *before* mutating `seenIdsRef` / `setOrder` / the gauge.
- `mountedRef` — set false in an unmount effect; checked alongside the seq so a read
  resolving after navigation never `setState`s a dead tree.

This is the load-bearing lesson of moving from a frozen deck to a live loop: you trade
"expired session" bugs for "concurrent read" bugs, and a start-order single-flight token is
the smallest thing that removes the whole class.

**Extract the reconciliation into a pure helper.** The order/cursor reconcile (anchor-by-id,
prefix preservation, nearest-surviving fallback, append-new, the was-drained clamp) is the
densest, most regression-prone logic in the change. Inlined in an async callback it is only
reachable through a full `listQueue` mock, so its branches were effectively untested. Pulling
it out as a pure `reconcileOrder(prevOrder, prevCursor, fresh) -> { nextOrder, nextCursor,
newlySeenIds }` (it depends only on those three inputs; the refs are just call-site plumbing)
makes every branch a table-test without a React/IPC harness — and is where the
"finished deck stays finished" clamp lives so new work always routes through the explicit
"keep going" affordance, never a silent resume.

**Drive the ambient gauge from backend-priced minutes only.** "Remaining" is
`timeEstimate.totalMinutes` (the full filtered due universe, server-priced); "elapsed" is
wall-clock. The renderer never sums per-item minutes itself. Keep the gauge component's own
seconds tick local so the elapsed display stays live without re-rendering the heavy process
surface. Be confidence-aware (`~` + an sr-only "defaults" clause) and degrade-safe — an
unpriced deck (`pricedItemCount === 0`) shows "estimate unavailable", never a false "0 min
left". Hide the gauge during a rebuild so it never flashes stale minutes.

**Make the time budget ambient, not a gate.** Fire a soft "wrap up or keep going?" nudge
ONCE when elapsed crosses a reference (the explicit `?target=` box if valid, else the daily
minute budget — so every entry path behaves the same). Use a single timeout, not a poll.
"Keep going"/Esc dismisses without re-nagging; "Wrap up" returns to the queue. Never a hard
stop — the natural end is the queue draining.

**End-of-order is a stopping point with user-driven continuation.** When the deck drains,
re-read once; if genuinely-new actionable work exists (ids not seen this session — track a
seen-id set SEPARATE from the card double-grade guard), surface a "Queue clear — N new items
arrived. Keep going?" affordance ("Keep going" rebuilds). Otherwise show the honest empty
states (`zeroLoad` "No due items today" + `recommendedAction` CTA vs drained "Queue clear").
This gives a real completion signal, avoids an endless treadmill for a productive user, and
sidesteps any undo↔seen-set contradiction (continuation is an explicit user action).

**Undo restores the cursor BY ID, not by a captured index.** Because `repriceDeck` can shift
indices, re-find the restored item's id in the current order (fall back to the captured
index only if it is gone) so the cursor and the inspector selection always agree.

## Distillation-quota interaction (a real, surfaced behavior change)

The protected distillation quota (T119) is enforced in **two** places, not one:

1. `planSession` — the frozen deck's fill *reserved* distillation minutes before score-order
   fill. The live-serve loop does NOT use `planSession` for its order, so this reservation
   no longer shapes the now-primary path.
2. `auto-postpone.ts` — skips postponing extract victims below the floor. This only runs
   under `overloadPolicy === "automatic"`; the default is `suggest`. And `queueItemScore`
   has **zero** distillation weighting (neutral type bias in `full` mode).

So on a card-heavy day under the default policy, nothing guarantees due distillation
*surfaces within a sized sitting*. The accurate regression scope is **intra-sitting
composition**, not daily throughput (auto-postpone still protects throughput when the policy
is `automatic`). Rather than silently relaxing a shipped guarantee, this change keeps the
live order pure score (honoring the "don't touch the ordering" boundary) and makes the loss
**loud**: the forecast and the in-session gauge surface the distillation share from
`listQueue.dayComposition`. A serving-time floor for the live path is the recommended
follow-up (it needs a small backend addition so `listQueue` can return a floor-aware order —
the renderer must not recompute eligibility/pricing locally), gated on maintainer sign-off.

## Read-only framing (be precise)

The forecast and gauge perform no session/plan writes. Note that `listQueue` /
`previewSessionPlan` trigger `materializeDailyPoliciesToday()` — a day-gated, idempotent,
once-per-local-day standing-auto-postpone convergence that *any* non-`asOf` due read
triggers, not a session write. One documented edge: a reprice that crosses local midnight in
a long session may run that day's convergence once and move items mid-session; the
reconcile-by-id rules handle the resulting deck change gracefully.

## Pitfalls

- Re-jittering the seen prefix on reprice makes the served order jump under the user — keep
  the prefix stable and only append new work at the tail.
- Repricing on a pure skip wastes a read and can mask the end-of-order "new work" check.
- Reusing the card double-grade guard (`gradedRef`) as the continuity seen-set breaks undo
  re-serving — keep them separate.
- Treating a failed reprice like a failed initial load (blanking `order`) destroys a live
  session — reprice failures must be non-destructive.

## See also

- [`session-assembly-read-model-accepted-deck-handoff.md`](./session-assembly-read-model-accepted-deck-handoff.md) — the superseded frozen-deck pattern (its pure read models are reused).
- [`queue-time-cost-read-model.md`](./queue-time-cost-read-model.md) — full-due-universe pricing + confidence.
- [`minute-denominated-overload-budget.md`](./minute-denominated-overload-budget.md) — `minuteBudget` / `BudgetMeter`.
- [`protected-distillation-quota-daily-workload-share.md`](./protected-distillation-quota-daily-workload-share.md) — the quota whose binding deck-floor this change relaxes.
- [`daily-work-read-model-inbox-only-routing.md`](../ui-bugs/daily-work-read-model-inbox-only-routing.md) — the honest empty states.

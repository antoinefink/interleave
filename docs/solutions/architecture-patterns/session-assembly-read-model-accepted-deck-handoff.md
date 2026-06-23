---
title: "Assemble minute-sized sessions as read-only queue plans with one-shot deck handoff"
date: "2026-06-12"
category: "architecture-patterns"
module: "queue-session-assembly"
problem_type: "architecture_pattern"
component: "database"
severity: "medium"
applies_when:
  - "A workflow needs to preview a bounded due-work deck without mutating scheduling, review state, or operation_log."
  - "The renderer must execute an exact accepted plan without reconstructing queue eligibility, pricing, protection, or score order."
  - "Async previews, route refreshes, and undoable process actions can desynchronize planned progress unless the deck handoff is explicit."
related_components:
  - "service_object"
  - "frontend_stimulus"
  - "testing_framework"
tags:
  - "queue"
  - "session-assembly"
  - "read-model"
  - "process-queue"
  - "time-cost"
  - "ipc"
  - "undo"
---

# Assemble minute-sized sessions as read-only queue plans with one-shot deck handoff

> **Update (2026-06-23) — the accepted-deck handoff and expired-plan state were removed.**
> The "queue-as-session" refactor replaced the frozen one-shot deck in `/process` with a
> continuous **live-serve loop** over the live scored queue, and demoted the session
> preview to a **non-binding forecast** + ambient minute gauge. The `assembled=1` param,
> the in-memory `sessionAssemblyState` handoff, and the "Session plan expired" dead-end
> are gone — so an expired session is now impossible to express.
>
> What the expired guard protected ("don't make the user execute work they did not
> accept") is preserved differently: the user never accepts a frozen set, so serving the
> live queue's current best item is always legitimate. **The read-only-preview invariant
> below still holds** — the forecast/gauge append no `operation_log`, change no schedules,
> and grade nothing; progress still flows only through command-shaped queue/review
> actions. See
> [`live-serve-queue-loop-over-frozen-deck.md`](./live-serve-queue-loop-over-frozen-deck.md)
> for the replacement pattern (including the distillation-quota interaction). The pure
> `planSession` / `SessionPlanQuery.preview()` / time-cost read models documented here are
> unchanged — only the renderer's *binding* consumption of them changed.

## Context

T118 needed a way to let users choose a time box, preview exactly what due work fits, then start `/process` with that exact deck. The existing process loop reads the live due queue directly, which is right for an open-ended session but wrong for a planned session: a previewed plan needs stable membership, stable order, honest minute accounting, and no hidden mutations during preview.

The reusable split is: assemble the session as a trusted read-only plan, then hand the accepted deck into `/process` exactly once.

## Guidance

Model session assembly as three separate layers.

First, keep the fill algorithm pure. `planSession` should accept already-ranked candidates and a target minute envelope, then return planned rows and cut rows. It should not query, score, mutate, or apply queue policy:

```ts
const plan = planSession(candidates, { targetMinutes });
```

Second, compose the trusted read model outside React. `SessionPlanQuery.preview()` should gather canonical due membership through the queue query, price candidates through the time-cost read model, and then call the pure planner. That keeps queue eligibility, filters, score order, protected work, and estimate confidence backend-owned.

Third, make acceptance a one-shot handoff. The renderer can temporarily store the exact accepted deck, but `/process?assembled=1` should consume that deck once:

```ts
const accepted = assembledSessionRef.current ?? consumeAcceptedSessionAssembly();
setMissingAssembly(accepted === null);
setOrder(accepted ? [...accepted.plannedItems] : []);
```

If the accepted deck is missing, show an expired-plan state instead of silently re-querying `queue.list`. Silent replanning would make the user execute work they did not accept.

Guard async preview state by tying the visible plan to the exact request that produced it:

```ts
const seq = loadSeqRef.current + 1;
loadSeqRef.current = seq;
const next = await appApi.previewSessionPlan(fullRequest);
if (loadSeqRef.current !== seq) return;
setPlan(next);
setPlanRequestKey(requestKey);
```

Only enable Start when the loaded plan still matches the current target, filters, mode, and clock.

## Why This Matters

This preserves the invariant that previews are read-only while real progress still flows through existing command-shaped queue and review actions. A session preview should not append to `operation_log`, change due dates, grade cards, or materialize historical scheduling side effects.

The one-shot deck also prevents plan drift. Without it, a route refresh, daily-work refresh, stale preview response, or direct `/process?assembled=1` navigation can quietly swap the deck underneath the user.

Minute accounting belongs to the accepted plan, not the live queue. If the user marks an item done and then undoes it, or deletes a lineage branch and undoes that batch restore, completed estimated minutes and cursor position must roll back with the item. Otherwise the final session summary overstates completed work even though the deck was restored.

## When to Apply

- A UI needs to preview a derived work set before execution.
- The execution loop must run the exact accepted items after navigation.
- The preview depends on trusted queue predicates, minute estimates, or scheduling clocks.
- Direct route entry should fail closed instead of fabricating a fresh plan.
- Undoable actions inside the execution loop affect local progress or completed-minute accounting.

Do not use this pattern for durable session history by itself. The accepted deck here is a short-lived execution handoff, not a persisted record of what happened.

## Examples

Tests should pin each boundary separately:

- Pure planner tests cover score-order fill, oversized first item, zero target, invalid estimates, and non-finite targets.
- Local-db read-model tests cover full due-universe membership, filters, mode, `asOf`, weekly-review exclusion, and no `operation_log` or due-state writes.
- Contract, IPC, preload, and app API tests cover the narrow typed `queue.sessionPlan` bridge.
- Preview UI tests cover stale async responses not enabling Start.
- Process loop tests cover one-shot consumption, missing accepted state, refresh not restarting the deck, undo subtracting completed minutes, and lineage branch-delete undo restoring cursor/progress.
- Electron E2E should start from Home and Queue, confirm the preview, process the assembled deck, and assert the final planned/completed/left-out summary.

The read model should be explicit about current-day materialization. A current live preview may perform trusted daily-work preparation before reading, but an explicit historical `asOf` preview should stay read-only and not materialize today's auto-postpone receipt.

## Related

- [Model queue time cost as an opt-in trusted read model](./queue-time-cost-read-model.md)
- [Minute-denominated overload budgets should price the full due universe](./minute-denominated-overload-budget.md)
- [Process Queue Inline Session Controls](../ui-bugs/process-queue-inline-session-controls.md)
- [Lineage-aware deletion needs tombstone, purge, and restore guards](./lineage-aware-deletion-tombstone-purge-guard.md)
- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md)

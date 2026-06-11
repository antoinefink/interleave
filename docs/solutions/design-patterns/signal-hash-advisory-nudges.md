---
title: "Signal-hash advisory nudges"
date: "2026-06-11"
category: "docs/solutions/design-patterns/"
module: "source retirement suggestions"
problem_type: "design_pattern"
component: "frontend_stimulus"
severity: "medium"
applies_when:
  - "A backend signal should prompt a calm user decision without creating a second mutation path."
  - "The prompt is advisory, dismissible, and should reappear only when the underlying evidence changes."
  - "The same nudge appears in multiple renderer surfaces that share one trusted command."
tags:
  - "advisory-nudge"
  - "signal-hash"
  - "dismissal"
  - "done-intent"
  - "ipc"
  - "react"
---

# Signal-hash advisory nudges

## Context

T103 surfaced the scheduler's source `retirementSuggestion`: when a source is mostly terminal,
mostly ignored, and has produced no extracts, queue rows and the source reader now offer a calm
"Done?" nudge that opens the existing `DoneIntentMenu` with Abandon marked as suggested. The nudge
is advisory; the actual mutation remains the normal Done/Abandon command.

## Guidance

Keep the signal backend-owned and make the UI consume a concrete read-model payload. For source
retirement suggestions, the scheduler exports a pure helper that returns the suggestion and a
stable signal hash:

```ts
sourceRetirementSuggestion({
  sourceId,
  totalBlocks,
  terminalBlocks,
  ignoredBlocks,
  unresolvedBlocks,
  terminalRatio,
  ignoredRatio,
  unresolvedRatio,
  extractedOutputCount,
});
```

The hash should include the evaluator version, suggestion kind, threshold signature, source id,
and integer counters. Do not hash renderer copy, floating ratios alone, or timestamps.

Persist dismissal against that hash, not just the source id. When the source's processing evidence
changes enough to produce a different hash, the nudge may reappear. When the hash still matches,
the trusted read model suppresses it.

Use a typed, product-specific command for dismissal:

```ts
await appApi.dismissSourceRetirementSuggestion({
  sourceElementId,
  signalHash,
});
```

The command should recompute the current raw signal before writing. If the caller's hash is stale,
return `stale: true` and do not persist a dismissal for outdated evidence. If it matches, upsert the
dismissal row and append an `operation_log` entry in the same transaction.

In React, treat "open the advisory review surface" as a forced-open read, not as a mutation. Guard
the async read with a version token so a dismissal, busy transition, or newer force-open signal
cannot reopen a stale popover after the nudge has disappeared.

## Why This Matters

Advisory nudges are easy to get subtly wrong:

- A renderer-only threshold drifts from the scheduler and starts prompting on the wrong sources.
- Dismissal keyed only by source id can hide useful future advice forever.
- Dismissal keyed by time or UI state can spam after reload or fail to survive restart.
- A stale async summary read can reopen an intent menu after the user dismissed the suggestion.
- A second "Abandon" shortcut can bypass the existing Done gate, undo behavior, and operation log.

The pattern keeps the signal explainable, replayable, and reversible without multiplying command
paths.

## When to Apply

- The backend has a derived signal that should prompt a user decision.
- The prompt can be dismissed, but only for the current evidence.
- Multiple surfaces need the same nudge.
- Accepting the nudge should route through an existing trusted command.
- Restart persistence is part of the product promise.

## Examples

For T103:

- `packages/scheduler/src/attention-scheduler.ts` owns the retirement heuristic and hash.
- `packages/local-db/src/retirement-suggestion-repository.ts` recomputes the signal before
  persisting dismissal.
- `packages/local-db/src/queue-query.ts` and `packages/local-db/src/inspector-query.ts` expose only
  visible, non-dismissed suggestions.
- `apps/web/src/components/queue/DoneIntentMenu.tsx` supports `forceOpenSignal` and
  `suggestedIntent` while preserving the safe Return-later focus.
- `tests/electron/done-intent.spec.ts` proves dismissal suppression survives an app restart.

## Related

- [Non-modal intent menu replacing a blocking confirm gate](./non-modal-intent-menu-replacing-confirm-gate.md)
- [Track source block processing as durable source-scoped state](../architecture-patterns/durable-source-block-processing-state.md)
- [Balance banner actions should stay actionable and dismissible](../ui-bugs/balance-banner-queue-inbox-action-gating.md)

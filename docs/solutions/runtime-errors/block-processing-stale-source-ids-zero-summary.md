---
title: "Block processing list tolerates stale missing-source reads"
date: "2026-06-08"
category: "runtime-errors"
module: "source-block-processing"
problem_type: "runtime_error"
component: "service_object"
severity: "low"
symptoms:
  - "Electron IPC handler blockProcessing:list logged BlockProcessingService: source <id> not found for stale or missing source IDs."
  - "Read-only block processing views treated deleted, missing, or non-source element IDs as exceptional cases."
root_cause: "logic_error"
resolution_type: "code_fix"
tags:
  - "block-processing"
  - "electron-ipc"
  - "stale-source-id"
  - "read-only-query"
  - "soft-delete"
  - "zero-summary"
---

# Block processing list tolerates stale missing-source reads

## Problem

Stale renderer requests could call `blockProcessing:list` or `blockProcessing:summary` with a
source id that no longer represented a live source. The read-only IPC path flowed straight into
`BlockProcessingService.requireSourceElement`, which correctly rejects invalid source targets but
made harmless stale reads show up as Electron handler errors.

## Symptoms

- Electron main logged handler errors for stale `blockProcessing:list` requests.
- The error came from `BlockProcessingService: source <id> not found`.
- The likely trigger was deletion, navigation, or another stale renderer state that still held an old source id.

## What Didn't Work

Letting read-only calls go directly into `BlockProcessingService.listBlockViews()` and
`getSourceProcessingSummary()` was too strict for renderer refresh traffic.

Weakening `BlockProcessingService.requireSourceElement()` would have been the wrong fix. Mutation
paths still need strict rejection so invalid block-processing writes do not create rows or logs for
missing, deleted, non-source, or wrong-source block targets.

## Solution

Keep the domain service strict, and add the stale-read tolerance at the Electron `DbService`
adapter layer:

```ts
listBlockProcessing(request: BlockProcessingSourceRequest): BlockProcessingListResult {
  const sourceElementId = request.sourceElementId as ElementId;
  if (!this.isLiveSource(sourceElementId)) {
    return { blocks: [], summary: emptyBlockProcessingSummary(sourceElementId) };
  }
  return {
    blocks: this.blockProcessingService.listBlockViews(sourceElementId),
    summary: this.blockProcessingService.getSourceProcessingSummary(sourceElementId),
  };
}
```

`getBlockProcessingSummary()` uses the same live-source guard. The empty summary preserves the full
contract shape with zero counts, `terminalRatio: 1`, and `canMarkDoneWithoutConfirmation: true`, so
renderer callers can treat the disappeared source as an empty read model instead of an exception.

Tests cover both sides of the split:

- `apps/desktop/src/main/db-service.test.ts` verifies read-only list/summary requests return empty
  results for missing, deleted, and non-source ids.
- The same test file verifies all public mark methods still throw for missing, deleted, non-source,
  and wrong-source block ids without creating `source_block_processing` or `operation_log` rows.
- `packages/local-db/src/block-processing-service.test.ts` keeps the strict domain-service boundary
  covered for non-source ids.

## Why This Works

`DbService` is the right adapter for UI tolerance because it sits at the trusted IPC-facing read
boundary. It can convert stale renderer reads into stable empty projections without changing durable
domain rules.

`BlockProcessingService` remains authoritative for source-block-processing invariants. It still
requires live source elements before listing views, deriving extraction state, reconciling edits, or
writing explicit block outcomes. That preserves source lineage and prevents invalid writes from
being logged as user actions.

## Prevention

- Treat read-only renderer refresh APIs as projections: if the UI can legitimately hold a stale id,
  return a stable empty payload when the entity has disappeared.
- Keep mutation APIs strict: missing, deleted, non-source, and wrong-owner targets should throw
  before any row or operation-log write.
- Add tests for both read tolerance and write strictness whenever an IPC boundary wraps a strict
  domain service.
- Preserve the full response contract for empty read models so renderer code does not need special
  error handling for ordinary deletion or navigation races.

## Related Issues

- [Track source block processing as durable source-scoped state](../architecture-patterns/durable-source-block-processing-state.md)
- [Daily work read model routes inbox-only days honestly](../ui-bugs/daily-work-read-model-inbox-only-routing.md)
- [URL and browser-captured articles should open as internal readable sources](../ui-bugs/url-imported-articles-inbox-processing.md)
- [Command palette source search should use compact typed search and reset stale async state](../ui-bugs/command-palette-source-lookup-search-query.md)
- [Test operation-log and IPC invariants for extract to card mutation paths](../architecture-patterns/extract-card-ipc-invariant-test-hardening.md)

---
title: Block Processing Missing Source IPC Guard
type: fix
status: active
date: 2026-06-08
---

# Block Processing Missing Source IPC Guard

## Problem Frame

The renderer can issue a stale `blockProcessing:list` request for a source id that no longer
exists or has been soft-deleted. Today that read-only request crosses IPC and throws from
`BlockProcessingService.requireSourceElement`, producing Electron handler errors such as
`BlockProcessingService: source ... not found`.

Mutation paths should keep rejecting missing or deleted sources, but read-only decoration and
summary calls should be safe for stale renderer requests.

## Scope Boundaries

- Do not weaken `markBlock*`, extraction-derived block state, or edit reconciliation validation.
- Do not expose raw DB/filesystem access or change renderer IPC shape.
- Do not add schema changes.
- Do not alter source-lineage semantics for live sources.

## Implementation Units

### U1. Add a read-only missing-source fallback

- **Goal:** Make `DbService.listBlockProcessing` and `DbService.getBlockProcessingSummary` return
  empty source-scoped results when the requested element is missing, soft-deleted, or not a source.
- **Files:** Modify `apps/desktop/src/main/db-service.ts`.
- **Pattern:** Follow read-only APIs like `getInspectorData`, `setElementPriority`, and
  `summaryForId`, which return `null`/empty payloads for unknown or deleted ids instead of throwing.
- **Test scenarios:** Missing source id returns `{ blocks: [], summary: emptySummary(id) }`; deleted
  source id returns the same; live source behavior is unchanged.
- **Verification:** `apps/desktop/src/main/db-service.test.ts` targeted tests pass.

### U2. Preserve domain service strictness

- **Goal:** Keep `BlockProcessingService` validation strict for callers that mutate or derive
  durable state, so stale read-only IPC tolerance does not mask data-integrity errors.
- **Files:** Modify `packages/local-db/src/block-processing-service.test.ts` only if needed.
- **Pattern:** Existing test `rejects non-source elements at the block-processing boundary`.
- **Test scenarios:** Direct service summary/list still throws for a non-source, proving tolerance is
  owned by the read-only Electron API boundary rather than the domain service.
- **Verification:** `packages/local-db/src/block-processing-service.test.ts` remains green.

## Acceptance

- A stale `blockProcessing:list` request for a deleted/missing source no longer logs an Electron
  handler error.
- Live source processing rows and summaries are unchanged.
- Mutations against missing or deleted sources still fail.
- Targeted tests, `pnpm typecheck`, and `pnpm test` pass.

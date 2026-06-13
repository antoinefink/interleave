---
title: "Frozen conversion sessions revalidate before every mutation"
date: 2026-06-13
category: architecture-patterns
module: conversion-session
problem_type: architecture_pattern
component: service_object
severity: medium
applies_when:
  - "Building a batch authoring surface over queue-ranked work that can change while the user is acting."
  - "Letting AI prefetch drafts for current items without letting drafts become active cards automatically."
  - "Converting extracts into cards while preserving source lineage and operation-log boundaries."
tags: [conversion-session, frozen-snapshot, stale-revalidation, source-lineage, ai-drafts]
---

# Frozen conversion sessions revalidate before every mutation

## Context

Batch conversion needs a stable worklist: a user should be able to open `/convert`, move through due atomic statements, ask for AI drafts, skip items, mark honorable fates, and create cards without the deck silently changing underneath them. At the same time, the underlying extracts can be carded elsewhere, fated, edited, deleted, rescheduled, or receive new AI drafts while the session is open.

The safe pattern is a short-lived main-process session snapshot. The renderer gets a frozen list, but every mutation goes back through the desktop service, which revalidates the item against current local state before writing anything.

## Guidance

Create a read model that starts from the trusted queue candidate path, then narrows to eligible conversion work. For T120, `ConversionSessionQuery` asks for due extract candidates, filters to live `atomic_statement` extracts with source locations, excludes terminal fates, synthesis references, already-carded rows, and decorates each row with source refs, AI grounding, scheduler signals, body text, and live draft summaries.

Freeze only small, trustable facts in the desktop service:

```ts
interface ConversionSessionSnapshot {
  readonly id: string;
  readonly asOf: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly limit: number;
  readonly itemIds: readonly ElementId[];
  readonly fingerprints: ReadonlyMap<ElementId, string>;
}
```

The snapshot stores ordered ids plus a fingerprint of the grounding/body the user saw. Refreshes use `previewByIds()` to preserve snapshot order instead of re-ranking against new queue work. Mutations call `requireCurrentConversionItem(...)`, which rejects missing ids and fingerprint drift before card creation, AI prefetch, or fate changes.

Keep every durable action command-shaped and scoped to the session. T120 uses dedicated conversion IPC methods instead of letting the renderer call generic extract/card primitives directly:

- `conversion.sessionPreview({ sessionId?, limit? })`
- `conversion.prefetchDrafts({ sessionId, action, consentedAt })`
- `conversion.createCard({ sessionId, extractId, ...card })`
- `conversion.setFate({ sessionId, id, fate })`

AI prefetch remains drafts-only. The user explicitly consents for the session; the job payload records the consent timestamp and grounding, and duplicate pending prefetches are deduped by item/action only until the session TTL. A draft-backed card still goes through the normal transactional card creation path, with the used `ai_suggestions` row consumed inside the same transaction so rollback cannot leave a created card with a reusable draft.

Bound candidate reads after eligibility pressure is understood. A hard first-window cap before eligibility can hide valid atomic statements behind raw/clean/already-carded extracts. T120 uses an adaptive bounded scan: start with a small extract-only candidate window, filter for eligibility, and expand until the session fills or all due extracts are exhausted. The queue batch path skips card sibling maps when the request is extract-only and resolves concept names only for candidate ids.

## Why This Matters

The renderer is not the source of truth for queue membership, source lineage, AI job ownership, or card creation. If a batch UI treats its initial list as authorization, stale rows can be converted after their source span changed, an AI draft can be consumed for the wrong extract, or a fate action can bypass the same freshness gate that card creation uses.

The snapshot/fingerprint split gives the UI continuity while preserving local-first data integrity. The user sees a stable batch, but the desktop service remains free to reject stale work at the moment of mutation.

## When to Apply

- Batch workflows over queue-ranked items where the list must feel stable while the database remains live.
- Multi-step authoring flows that prefill AI suggestions but require explicit user approval before durable creation.
- Any conversion from one lineage-bearing element into another, especially extract-to-card flows.
- Surfaces that need skip/fate/mark-done actions alongside create actions and must disable conflicting mutations while one is pending.

## Examples

Refresh an existing session by id, not by asking the queue for a new top-N:

```ts
const snapshot = requireConversionSnapshot(sessionId);
const current = conversionSessionQuery.previewByIds(snapshot.itemIds, { asOf: snapshot.asOf });
const items = snapshot.itemIds.flatMap((id) => {
  const item = currentById.get(id);
  return item && fingerprintMatches(snapshot, item) ? [item] : [];
});
```

Consume an AI draft inside the card transaction:

```ts
createCard(cardRequest, {
  onWithin: (tx) =>
    aiSuggestions.consumeDraftWithin(tx, {
      id: suggestionId,
      owningElementId: item.id,
      status: "dismissed",
    }),
});
```

Test the contract at multiple layers:

- Query tests: eligibility filtering, adaptive candidate expansion, `previewByIds()` order and stale skips.
- Desktop service tests: stale fingerprint rejection, foreign/dismissed suggestion rejection, cross-session prefetch dedupe, runner error propagation, fate freshness.
- Renderer tests: draft prefill does not auto-create, manual edits clear `suggestionId`, create/fate buttons disable during pending mutations.
- Electron E2E: manual and draft-backed cards preserve `parentId`, `sourceId`, `source_location_id`, `derived_from`, due review state, AI suggestion status, fate updates, and restart persistence.

## Related

- [Session assembly read model accepted deck handoff](./session-assembly-read-model-accepted-deck-handoff.md) covers accepted-deck handoff for process sessions.
- [Protected distillation quota daily workload share](./protected-distillation-quota-daily-workload-share.md) explains why conversion throughput should be protected under card pressure.
- [Extract fates value model](./extract-fates-value-model-v2-source-yield-stagnation.md) covers terminal extract fates and their impact on conversion eligibility.
- [Electron E2E stale build lock and lineage contract](../test-failures/electron-e2e-stale-build-lock-and-lineage-contract.md) covers restart-safe lineage assertions in Electron tests.

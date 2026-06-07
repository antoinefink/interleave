---
title: "Track source block processing as durable source-scoped state"
date: "2026-06-07"
category: "architecture-patterns"
module: "source-block-processing"
problem_type: "architecture_pattern"
component: "database"
severity: "high"
related_components:
  - "service_object"
  - "frontend_stimulus"
  - "testing_framework"
applies_when:
  - "Source reader progress must survive app restart and document reprocessing."
  - "Stable document block IDs need independent processing state such as unread, read, extracted, ignored, or stale after edit."
  - "Extracts and cards must remain traceable to the source blocks that produced them."
  - "Scheduler and mark-done behavior need source-yield signals instead of transient UI selection state."
tags:
  - "source-blocks"
  - "processing-state"
  - "sqlite"
  - "source-lineage"
  - "reader-progress"
  - "scheduler"
  - "stale-reconciliation"
  - "local-first"
---

# Track source block processing as durable source-scoped state

## Context

Source-reader progress started as a visual affordance: marking a paragraph as processed dimmed text by writing a `processed_span` mark. That worked for the immediate reader surface, but it was not a durable progress model. Visual marks could not reliably drive source completion, restart persistence, source-yield analytics, scheduling pressure, or lineage-aware extraction.

The block-processing implementation promoted that behavior into a domain layer. Stable source document blocks now have explicit processing outcomes, and the UI projects those outcomes into decorations, filters, and controls.

## Guidance

Persist block outcomes underneath reader marks. The durable model should be keyed by the source element and the stable document block ID, with timestamps, actor/action metadata, and optional output links for extracts or cards. Visual marks can still exist, but they are decoration or compatibility data, not the source of truth.

Use an explicit outcome layer:

```ts
type SourceBlockProcessingState =
  | "unread"
  | "read"
  | "extracted"
  | "ignored"
  | "processed_without_output"
  | "needs_later"
  | "stale_after_edit";
```

Only terminal outcomes should resolve source progress: extracted, ignored, and processed without output. `needs_later` is intentionally unresolved; `stale_after_edit` is a warning that previous progress no longer matches the current block text.

Keep extracted state tied to live output lineage. Extraction should create the extract, source location, relation, visual extracted-span mark, and block-processing output link in one transaction. If the extract or card output is later soft-deleted, the block should no longer count as extracted. A user action should not overwrite a block that still has live extracted output with ignored, unread, or processed-without-output.

Reconcile state on document edits and reimports. Store a normalized content hash for every explicitly processed block. When a source document changes, hydrate old rows that were backfilled without hashes if their text still matches; otherwise mark terminal or needs-later rows as stale after edit when the block text changes or disappears.

Gate source completion in the domain service, not only in React. `markDone` should ask the block-processing service whether all blocks are resolved. Clients may ask for confirmation and pass an explicit override, but the trusted mutation path must remain the final guard.

Expose list and summary APIs, then make UI and analytics consume those APIs. Reader hooks can project block views into old decoration/button shapes during migration, but React should not infer source progress from marks or recompute database summaries.

## Why This Matters

This keeps the source reader, queue behavior, scheduling, analytics, and restart persistence aligned. A paragraph that is processed in the reader now survives app restart, contributes to source progress, affects unresolved-block counts, and can be reconciled when the underlying source text changes.

The lineage rule prevents destructive ambiguity. A block is extracted because it produced live knowledge output, not because a toggle says it is done. That distinction matters when extracts are deleted, source documents are edited, or a source is about to be marked done.

Service-level gating also protects non-UI callers. Electron IPC, queue actions, and future agent tools all receive the same source-done semantics instead of relying on whichever renderer button happened to add a confirmation dialog.

## When to Apply

- A reader/editor mark starts affecting progress, completion, scheduling, analytics, backup, undo, or lineage.
- A stable document region can produce downstream knowledge output and needs to retain that relationship after restart.
- The UI needs hide/collapse/filter modes for completed material.
- A completion action would otherwise risk burying unresolved or stale source text.
- A future feature wants scheduler inputs based on how much useful output a source produced.

## Examples

Good extraction shape:

```ts
database.transaction(() => {
  const extract = extractionRepository.createExtract(...);
  sourceLocationRepository.createForExtract(extract.id, sourceBlockLocation);
  relationRepository.addDerivedFrom(extract.id, sourceElementId);
  documentRepository.addMark("extracted_span", sourceBlockLocation);
  blockProcessingService.deriveBlockStateFromExtractionWithin({
    sourceElementId,
    stableBlockId,
    outputElementId: extract.id,
  });
})();
```

Good reader shape:

```ts
const blockViews = await appApi.blockProcessing.list({ sourceElementId });

return blockViews.map((block) => ({
  stableBlockId: block.stableBlockId,
  state: block.state,
  dimmed: block.state === "ignored" || block.state === "processed_without_output",
}));
```

Good completion shape:

```ts
const gate = await blockProcessingService.getDoneGate(sourceElementId);

if (!gate.canMarkDone && !confirmUnresolvedBlocks) {
  throw new Error("Source still has unresolved or stale blocks.");
}
```

Edit reconciliation shape:

```ts
for (const row of persistedBlockProcessingRows) {
  const currentHash = currentBlockHashById.get(row.stableBlockId);

  if (!currentHash || currentHash !== row.blockContentHash) {
    markStaleAfterEdit(row);
  }
}
```

## Related

- [Test operation-log and IPC invariants for extract to card mutation paths](./extract-card-ipc-invariant-test-hardening.md)
- [Battle-testing matrix and test-hardening execution for core app surfaces](./test-audit-driven-battle-testing.md)
- [Extract inspector single-responsibility layout and scheduler refresh](../ui-bugs/extract-inspector-single-responsibility-lineage-scheduler.md)
- [Balance banner queue/inbox action gating](../ui-bugs/balance-banner-queue-inbox-action-gating.md)
- [URL-imported articles inbox processing](../ui-bugs/url-imported-articles-inbox-processing.md)

Refresh recommendation: a targeted `/ce-compound-refresh source-block-processing` pass could update the related lineage, test-hardening, and queue-actionability docs with this durable block-processing pattern.

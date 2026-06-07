---
title: "Rich extracts must rebuild from source document structure"
date: "2026-06-07"
category: "docs/solutions/logic-errors/"
module: "extraction-rich-content"
problem_type: "logic_error"
component: "service_object"
severity: "high"
symptoms:
  - "Cross-paragraph selections were persisted as a single extract paragraph."
  - "Selected article image blocks were omitted from extract documents."
  - "Extract plain text survived, but the stored ProseMirror body lost source document structure."
root_cause: "logic_error"
resolution_type: "code_fix"
related_components:
  - "frontend_stimulus"
  - "database"
  - "testing_framework"
tags:
  - "extraction"
  - "prosemirror"
  - "source-lineage"
  - "paragraphs"
  - "article-images"
  - "block-ids"
  - "document-structure"
---

# Rich extracts must rebuild from source document structure

## Problem

Creating an extract from selected rich source content seeded the new extract body from a plain selected-text snapshot. That preserved a source-location row, but it discarded the ProseMirror structure the reader needs for multi-paragraph text, lists, and article images.

## Symptoms

- Multi-paragraph selections appeared as one paragraph in the extracted result.
- Selected article images did not appear inside extracts.
- Sub-extracts could keep lineage rows while still losing parent extract body structure.
- Image-only selections could fail to produce a usable selection location.

## What Didn't Work

- Converting `selectedText` with `plainTextToProseMirrorDoc` was too lossy. Single newlines from ProseMirror selection snapshots are not enough to reconstruct paragraphs, and plain text cannot carry image nodes.
- Broadening offsetless selections to the full stored block was unsafe because minimal extraction requests may intentionally provide only selected text.
- Copying every selected row naively duplicated nested list selections when both an ancestor row and descendant row were part of the anchor.
- Trusting stored document JSON too much could turn malformed legacy bodies into thrown errors or empty rich extract bodies.

## Solution

Reconstruct rich extract bodies in the main-side extraction service from the stored parent document, not from a new renderer payload. The source-location anchor remains the original `blockIds`, offsets, and `selectedText`; the child extract document gets freshly minted block ids.

The extraction service now only attempts rich reconstruction when offsets are present:

```ts
const conversion =
  input.startOffset != null && input.endOffset != null
    ? (richSelectionToProseMirrorDoc({
        parentDoc: this.documents.findById(locationSource)?.prosemirrorJson ?? null,
        blockIds: input.blockIds,
        startOffset: input.startOffset,
        endOffset: input.endOffset,
        selectedText: input.selectedText,
      }) ?? plainTextToProseMirrorDoc(input.selectedText))
    : plainTextToProseMirrorDoc(input.selectedText);
```

The core helper walks only the requested row block ids, trims first and last selected rows by flattened text offsets, preserves fully selected intermediate blocks such as `image`, restores structural list wrappers around selected list items, and remints row ids for the child document.

The helper must fail closed:

- missing offsets return `null` so callers use the selected-text fallback
- malformed stored JSON returns `null` instead of throwing
- a non-empty selected-text snapshot with an empty reconstructed body returns `null`
- partial text selections do not include zero-width inline atoms just because the atom touches the selection boundary

The editor and core now share the same row-id ownership predicate so selection-location, rich reconstruction, and block persistence agree on which row owns a stable `blockId`.

Image-only extraction also needs a real selection anchor. The selection resolver handles `NodeSelection` for id-bearing image atoms and returns a single-block, zero-offset location with selected text derived from safe image alt/title attrs.

## Why This Works

The stored parent document is the canonical rich substrate for extraction. Reconstructing from that document preserves block boundaries and constrained atoms while keeping the renderer API narrow: the renderer still sends only the existing anchor payload.

Fresh child block ids keep lineage and body identity separate. `source_locations.blockIds` continue to point into the parent/source document for jump-to-source and extracted-span marks, while the extracted document has its own stable rows for later read-points and sub-extracts.

The fallback behavior matters because stored ProseMirror JSON is accepted as broad `unknown` at persistence boundaries. Rich reconstruction is an optimization for valid constrained documents, not a reason to widen a selection or reject extraction.

## Prevention

- Do not seed rich extract documents from plain text when the selected parent document is available.
- Keep source-location anchors and extracted document block ids separate.
- Treat offsetless rich reconstruction as invalid; fall back to the selected-text snapshot rather than widening to the whole source block.
- Preserve structural wrappers, such as list containers, when selected content depends on them.
- Test extraction across:
  - multiple paragraphs
  - selected article image blocks
  - image-only `NodeSelection`
  - sub-extracts from rich parent extracts
  - list and nested-row selections
  - malformed stored document JSON
  - offsetless minimal extraction requests
  - partial selections adjacent to inline atoms

## Related Issues

- [Store URL-imported article images as asset-vault files served by a narrow protocol](../architecture-patterns/url-import-article-images-asset-vault-protocol.md)
- [URL and browser-captured articles should open as internal readable sources](../ui-bugs/url-imported-articles-inbox-processing.md)
- [Test operation-log and IPC invariants for extract→card mutation paths](../architecture-patterns/extract-card-ipc-invariant-test-hardening.md)
- [Extract inspector should keep lineage and scheduling responsibilities separate](../ui-bugs/extract-inspector-single-responsibility-lineage-scheduler.md)
- [Core ProseMirror conversion helpers](../../../packages/core/src/prosemirror.ts)
- [Selection-location resolver](../../../packages/editor/src/selection-location.ts)
- [Extraction service](../../../packages/local-db/src/extraction-service.ts)

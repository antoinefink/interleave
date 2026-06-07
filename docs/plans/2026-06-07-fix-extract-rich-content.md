---
title: Fix Rich Content Extraction
type: fix
status: completed
date: 2026-06-07
---

# Fix Rich Content Extraction

## Summary

Preserve rich document structure when creating text extracts. Multi-paragraph selections should become multi-paragraph extract bodies, and selected article images should remain visible inside the extract.

## Problem Frame

The current extraction path records a correct source-location anchor, but it seeds the new extract body from `selectedText` with `plainTextToProseMirrorDoc`. That rebuilds a paragraph-only document, collapses single newlines into spaces, and cannot carry selected `image` nodes.

## Requirements

- R1. A selection spanning multiple source paragraphs creates an extract document with separate block nodes, not one collapsed paragraph.
- R2. A selection spanning an existing article `image` node preserves that image node in the extract body.
- R3. The extract's `source_locations` row remains anchored to the original source or parent extract block ids, offsets, and verbatim `selectedText` snapshot.
- R4. The extract's own document blocks use fresh stable ids so future sub-extracts and read-points inside the extract do not share row identity with the source document.
- R5. Existing extraction atomicity, scheduling, relations, tag inheritance, extracted-span marks, and operation-log behavior remain unchanged.
- R6. The fix benefits top-level extracts, queue/process extraction, and sub-extracts through the shared extraction service.

## Key Technical Decisions

- **Reconstruct main-side from the stored parent document:** `ExtractionService` should read the origin document (`parentId ?? sourceElementId`) and derive the extract body from its ProseMirror JSON plus the existing `blockIds` and offsets. This avoids trusting a new renderer-supplied rich payload and fixes every caller of `extractions.create`.
- **Keep lineage and body ids separate:** `source_locations.blockIds` continue to point at the original source/parent document. The new extract document receives freshly minted `blockId` attrs and matching `document_blocks` rows.
- **Preserve constrained nodes, not arbitrary HTML:** The helper should copy the existing constrained ProseMirror nodes, including `image` atoms with their `article-image://source/asset` refs. It should not duplicate assets, expose vault paths, or broaden the IPC contract.
- **Fallback to plain text when rich reconstruction is impossible:** If the parent document is missing or the selected blocks cannot be found, keep the existing `plainTextToProseMirrorDoc(selectedText)` behavior rather than failing extraction.

## Implementation Units

### U1. Add Rich Selection Extraction Helper

- **Goal:** Add a pure helper that builds a ProseMirror extract document from a parent ProseMirror document, selected block ids, and first/last text offsets.
- **Files:** Modify `packages/core/src/prosemirror.ts`; modify `packages/core/src/index.ts`; add or extend `packages/core/src/prosemirror.test.ts`.
- **Approach:** Walk row-bearing blocks in document order, select the requested original block ids, trim text-bearing first/last blocks by flattened text offsets, copy fully covered intermediate blocks such as images, mint fresh block ids, compute `plainText`, and return matching `blocks`.
- **Test Scenarios:** Partial paragraph-to-paragraph selection yields two paragraphs; paragraph-image-paragraph selection preserves the image; output block ids differ from source block ids; fallback plain text still works for text-only input.
- **Verification:** `pnpm test -- packages/core/src/prosemirror.test.ts`.

### U2. Use Rich Reconstruction in ExtractionService

- **Goal:** Seed extract documents from the origin document structure while preserving existing lineage behavior.
- **Files:** Modify `packages/local-db/src/extraction-service.ts`; extend `packages/local-db/src/extraction-service.test.ts`.
- **Approach:** Before the transaction, load the location-source document and call the helper. Fall back to `plainTextToProseMirrorDoc(selectedText)` if no rich selection can be built. Continue persisting through `DocumentRepository.upsertWithin` inside the existing transaction.
- **Test Scenarios:** Cross-paragraph extraction persists multiple paragraph nodes; extraction across an image persists the image node and a matching image block row; source-location anchors retain original block ids; operation-log and mark expectations remain intact.
- **Verification:** `pnpm test -- packages/local-db/src/extraction-service.test.ts`.

### U3. Regression Verification Across App Surfaces

- **Goal:** Prove the shared service fix covers renderer and desktop callers without widening IPC.
- **Files:** Review `apps/web/src/pages/source/SourceReader.tsx`, `apps/web/src/reader/ExtractView.tsx`, `apps/web/src/pages/queue/ProcessQueue.tsx`, `apps/desktop/src/shared/contract.ts`, and existing tests; add targeted tests only if service coverage leaves a real gap.
- **Approach:** Confirm callers still send the same anchor payload and need no renderer changes. Run focused desktop/web type checks or tests touched by the change.
- **Test Scenarios:** Existing `ExtractionCreateRequestSchema` still accepts the current payload; extract rendering can already display stored `image` nodes through `SourceEditor`.
- **Verification:** `pnpm typecheck`, `pnpm test`, and relevant focused tests.

## Scope Boundaries

- Do not change source-location schema or add a migration.
- Do not duplicate article image assets into the extract's vault area.
- Do not broaden the renderer IPC surface with raw HTML, filesystem paths, or database access.
- Do not change PDF region `media_fragment`, media clip, or image-occlusion extraction behavior.

## Risks & Dependencies

- Offset trimming must respect flattened block text semantics for list items and blockquotes. Existing selection-location tests document those rules.
- Rich reconstruction must avoid reusing source block ids in the child extract body.
- If a malformed stored document cannot be reconstructed, the extraction should still succeed using the current plain-text fallback.

## Sources

- `packages/local-db/src/extraction-service.ts` currently calls `plainTextToProseMirrorDoc(input.selectedText)` to seed extract bodies.
- `packages/editor/src/selection-location.ts` resolves source-location anchors and uses `textBetween(..., "\n", "\n")` for the snapshot.
- `packages/editor/src/serialize.ts` already flattens image nodes to alt/title text for `plainText`.
- `packages/editor/src/SourceEditor.tsx` already renders the constrained `image` node in extract bodies.

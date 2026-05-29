/**
 * `useHighlights` (T020) — the reader's load/add/remove seam for highlight marks.
 *
 * A highlight is a lightweight reading annotation persisted as a `document_marks`
 * row (a STABLE block id + a `[start,end]` character range) — NOT an element, NOT
 * lineage. This hook loads the source's persisted highlights through the typed
 * `window.appApi` bridge (`documents.marks.list` filtered to `highlight`), exposes
 * them as {@link HighlightDecoration}s the reader overlays via `setReaderDecorations`
 * (the same ProseMirror-decoration mechanism the read-point divider / extracted
 * markers use — never DOM surgery), and lets the reader add a highlight from a
 * resolved {@link SelectionLocation} (`documents.marks.add`) or remove one by id
 * (`documents.marks.remove`).
 *
 * Layering: NO SQL/Node/fs here. All persistence flows through `window.appApi`;
 * the block-id + range math is computed once in `@interleave/editor`
 * (`resolveSelectionLocation`) and handed in as the `SelectionLocation`. Highlights
 * survive an app restart because they live in `document_marks`.
 *
 * A highlight may span multiple blocks (a cross-block selection): we persist ONE
 * `document_marks` row per spanned block so each re-anchors independently by its
 * stable block id. The range within the first block runs from `startOffset` to the
 * block's end; within the last block from its start to `endOffset`; middle blocks
 * are covered whole. For the common single-block case that collapses to one row
 * `[startOffset, endOffset]`.
 */

import type { HighlightDecoration, SelectionLocation } from "@interleave/editor";
import { useCallback, useEffect, useState } from "react";
import { appApi, type DocumentMarkPayload, isDesktop } from "../../lib/appApi";

/** A very large per-block end so "to end of block" clamps to the block text length. */
const BLOCK_END = Number.MAX_SAFE_INTEGER;

export interface UseHighlightsResult {
  /** Persisted highlights as overlay decorations (block id + range + mark id). */
  readonly highlights: readonly HighlightDecoration[];
  /** Add a highlight over a resolved selection location; persists + refreshes. */
  readonly add: (location: SelectionLocation) => Promise<void>;
  /** Remove a highlight by its `document_marks` id; persists + refreshes. */
  readonly remove: (markId: string) => Promise<void>;
  /** The last load/mutate error message, if any. */
  readonly error: string | null;
}

/** Map a persisted highlight mark payload to a reader overlay decoration. */
function toDecoration(mark: DocumentMarkPayload): HighlightDecoration {
  return {
    markId: mark.id,
    blockId: mark.blockId,
    start: mark.range[0],
    end: mark.range[1],
  };
}

/**
 * Manage one source's highlight marks. Loads on mount / element change; exposes
 * add + remove that persist through the bridge and refresh the local set.
 *
 * @param elementId The owning source element id, or `null`/`undefined` to idle.
 */
export function useHighlights(elementId: string | null | undefined): UseHighlightsResult {
  const [highlights, setHighlights] = useState<readonly HighlightDecoration[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!elementId || !isDesktop()) return;
    try {
      const result = await appApi.listDocumentMarks({ elementId, markType: "highlight" });
      setHighlights(result.marks.map(toDecoration));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [elementId]);

  // Load on mount / when the element changes.
  useEffect(() => {
    if (!elementId || !isDesktop()) {
      setHighlights([]);
      return;
    }
    let cancelled = false;
    void appApi
      .listDocumentMarks({ elementId, markType: "highlight" })
      .then((result) => {
        if (!cancelled) {
          setHighlights(result.marks.map(toDecoration));
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [elementId]);

  const add = useCallback(
    async (location: SelectionLocation) => {
      if (!elementId || !isDesktop()) return;
      const blocks = location.blockIds;
      if (blocks.length === 0) return;
      try {
        // One mark row per spanned block so each re-anchors by its own stable id.
        for (let i = 0; i < blocks.length; i++) {
          const isFirst = i === 0;
          const isLast = i === blocks.length - 1;
          const start = isFirst ? location.startOffset : 0;
          const end = isLast ? location.endOffset : BLOCK_END;
          // Skip a degenerate empty range (e.g. a caret at a block boundary).
          if (end <= start) continue;
          await appApi.addDocumentMark({
            elementId,
            blockId: blocks[i] as string,
            markType: "highlight",
            range: [start, end],
          });
        }
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [elementId, reload],
  );

  const remove = useCallback(
    async (markId: string) => {
      if (!isDesktop()) return;
      try {
        await appApi.removeDocumentMark({ markId });
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [reload],
  );

  return { highlights, add, remove, error };
}

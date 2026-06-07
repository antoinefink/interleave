/**
 * `useProcessedSpans` (T026) — the reader's load/toggle seam for processed-span marks.
 *
 * Marking a paragraph **processed** dims it (`.dimmed`) so the user can declutter a
 * long source WITHOUT deleting any content. A processed span is a lightweight,
 * fully REVERSIBLE reading annotation persisted as a `document_marks` row
 * (`markType: "processed_span"`, a STABLE block id + a `[start,end]` character
 * range) — NOT an element, NOT lineage, NO schedule. It reuses the SAME T020 mark
 * surface (`documents.marks.list/add/remove`) as highlights — no new IPC command,
 * table, or op type.
 *
 * This hook loads the source's persisted processed spans through the typed
 * `window.appApi` bridge (filtered to `processed_span`), exposes them as
 * {@link ProcessedDecoration}s the reader overlays via `setReaderDecorations` (the
 * same ProseMirror-decoration mechanism the read-point divider / extracted markers /
 * highlights use — never DOM surgery), and lets the reader toggle a block processed
 * (add) or restore it (remove by id).
 *
 * Granularity: T026 dims at PARAGRAPH level (matching the design kit's per-paragraph
 * toggle), so we persist ONE `processed_span` row covering the whole block
 * (`[0, BLOCK_END]`, which the decoration layer clamps to the block — but processed
 * spans are rendered as a whole-block node `.dimmed` class, not an inline range, so
 * the exact end is immaterial). The source body is never touched; restoring deletes
 * only the annotation row. Processed spans survive an app restart because they live
 * in `document_marks`.
 */

import type { ProcessedDecoration } from "@interleave/editor";
import { useCallback, useEffect, useState } from "react";
import { appApi, type DocumentMarkPayload, isDesktop } from "../../lib/appApi";

/** Cover the whole block: a large end the persistence layer stores verbatim. */
const BLOCK_END = Number.MAX_SAFE_INTEGER;

export interface UseProcessedSpansResult {
  /** Persisted processed spans as reader overlay decorations (block id + mark id). */
  readonly processed: readonly ProcessedDecoration[];
  /** Whether a given stable block id is currently marked processed. */
  readonly isProcessed: (blockId: string) => boolean;
  /** The `document_marks.id` dimming a block, or `null` if it is not processed. */
  readonly markIdFor: (blockId: string) => string | null;
  /** Mark a block processed (persists a `processed_span` row + refreshes). */
  readonly mark: (blockId: string) => Promise<boolean>;
  /** Restore a block by its `document_marks` id (deletes the row + refreshes). */
  readonly restore: (markId: string) => Promise<boolean>;
  /** Toggle a block's processed state (mark if clear, restore if already set). */
  readonly toggle: (blockId: string) => Promise<"marked" | "restored" | null>;
  /** The last load/mutate error message, if any. */
  readonly error: string | null;
}

/** Map a persisted processed-span mark payload to a reader overlay decoration. */
function toDecoration(mark: DocumentMarkPayload): ProcessedDecoration {
  return { markId: mark.id, blockId: mark.blockId };
}

/**
 * Manage one source's processed-span marks. Loads on mount / element change;
 * exposes mark + restore + toggle that persist through the bridge and refresh the
 * local set.
 *
 * @param elementId The owning source element id, or `null`/`undefined` to idle.
 */
export function useProcessedSpans(elementId: string | null | undefined): UseProcessedSpansResult {
  const [processed, setProcessed] = useState<readonly ProcessedDecoration[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!elementId || !isDesktop()) return;
    try {
      const result = await appApi.listDocumentMarks({ elementId, markType: "processed_span" });
      setProcessed(result.marks.map(toDecoration));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [elementId]);

  // Load on mount / when the element changes.
  useEffect(() => {
    if (!elementId || !isDesktop()) {
      setProcessed([]);
      return;
    }
    let cancelled = false;
    void appApi
      .listDocumentMarks({ elementId, markType: "processed_span" })
      .then((result) => {
        if (!cancelled) {
          setProcessed(result.marks.map(toDecoration));
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

  const markIdFor = useCallback(
    (blockId: string): string | null =>
      processed.find((p) => p.blockId === blockId)?.markId ?? null,
    [processed],
  );

  const isProcessed = useCallback(
    (blockId: string): boolean => processed.some((p) => p.blockId === blockId),
    [processed],
  );

  const mark = useCallback(
    async (blockId: string) => {
      if (!elementId || !isDesktop() || blockId.length === 0) return false;
      // Already processed ⇒ nothing to add (avoid a duplicate row).
      if (processed.some((p) => p.blockId === blockId)) return true;
      try {
        await appApi.addDocumentMark({
          elementId,
          blockId,
          markType: "processed_span",
          range: [0, BLOCK_END],
        });
        await reload();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [elementId, processed, reload],
  );

  const restore = useCallback(
    async (markId: string) => {
      if (!isDesktop()) return false;
      try {
        await appApi.removeDocumentMark({ markId });
        await reload();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [reload],
  );

  const toggle = useCallback(
    async (blockId: string) => {
      const existing = processed.find((p) => p.blockId === blockId);
      if (existing) {
        return (await restore(existing.markId)) ? "restored" : null;
      }
      return (await mark(blockId)) ? "marked" : null;
    },
    [processed, mark, restore],
  );

  return { processed, isProcessed, markIdFor, mark, restore, toggle, error };
}

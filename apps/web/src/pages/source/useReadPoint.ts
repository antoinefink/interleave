/**
 * `useReadPoint` (T017) — the renderer's load/set/jump seam for a read-point.
 *
 * A read-point is how far the user has read a source/topic: a STABLE block id
 * (from T016) plus a character offset. This hook loads the element's read-point
 * on mount via `appApi.getReadPoint`, and exposes:
 *
 *  - `setFromSelection(editor)` — capture the block id + offset at the editor's
 *    current caret/selection (via `@interleave/editor`'s
 *    `resolveReadPointFromSelection`) and persist it through `appApi.setReadPoint`.
 *    This backs the reader's "Set read-point" (Space) action (T018 wires the
 *    button; T017 provides the command + the resolution helper).
 *  - `markReadThrough(editor, blockId)` — the AUTO-ADVANCE-ON-EXTRACT seam
 *    reserved for T021: advance the read-point to the END of the given block.
 *    In M3 it is wired only to the Set-read-point path; M4's extraction (T021)
 *    will be the real call site. It is a clearly named seam, not a built feature.
 *  - `jump(editor)` — scroll/focus the editor to the stored read-point (used on
 *    reader open + an explicit "Resume" affordance); degrades gracefully when the
 *    referenced block was deleted.
 *  - `firstUnreadBlockId` / `progress` derived from the current doc, so the reader
 *    can render the `.readpoint` divider + progress bar.
 *
 * Like `useDocument`, it degrades to `"no-desktop"` outside the Electron shell
 * (no IPC attempted) and never touches SQLite/Node/fs — only the typed
 * `window.appApi` bridge. All read-point math lives in `@interleave/editor`; this
 * hook only orchestrates UI state + IPC.
 */

import {
  firstUnreadBlockId as computeFirstUnread,
  type Editor,
  isBlockAtOrAfterReadPoint,
  type JumpResult,
  jumpToReadPoint,
  type ResolvedReadPoint,
  readPointProgress,
  readPointProgressFraction,
  readThroughBlock,
  resolveReadPointFromSelection,
} from "@interleave/editor";
import { useCallback, useEffect, useState } from "react";
import { appApi, isDesktop, type ReadPointPayload } from "../../lib/appApi";

/** Lifecycle of the read-point load. */
export type ReadPointStatus = "loading" | "ready" | "no-desktop" | "error";

export interface UseReadPointResult {
  /** Where the load is in its lifecycle. */
  readonly status: ReadPointStatus;
  /** The current read-point (block id + offset), or `null` when unset. */
  readonly readPoint: ResolvedReadPoint | null;
  /** Whether a set is in flight. */
  readonly saving: boolean;
  /** The last load/set error message, if any. */
  readonly error: string | null;
  /**
   * Capture + persist the read-point at the editor's current selection. Resolves
   * the nearest enclosing block's stable id + caret offset; a no-op when no block
   * is in scope. Returns the resolved point, or `null` when nothing was captured.
   */
  readonly setFromSelection: (editor: Editor) => Promise<ResolvedReadPoint | null>;
  /**
   * The auto-advance-on-extract SEAM (reserved for T021): advance the read-point
   * to the END of `blockId`. M3 wires this only via the Set-read-point path; M4's
   * extraction will be the real caller. Returns the new point, or `null` when the
   * block is not in the doc.
   */
  readonly markReadThrough: (editor: Editor, blockId: string) => Promise<ResolvedReadPoint | null>;
  /** Jump the editor to the stored read-point (used on open + explicit resume). */
  readonly jump: (editor: Editor) => JumpResult;
  /**
   * The first UNREAD block id (the block after the read-point) for the given doc,
   * so the reader can render the `.readpoint` divider before it; `null` when none.
   */
  readonly firstUnreadBlockId: (doc: unknown) => string | null;
  /** The `{ index, total }` reading progress for the given doc + current point. */
  readonly progress: (doc: unknown) => { readonly index: number; readonly total: number };
  /**
   * The reading-progress fraction in `[0, 1]` for the progress bar + percentage —
   * 1-based (`(index + 1) / total`), so a read-point on the LAST block reads a full
   * 100% (rather than maxing at `(total-1)/total`). Consistent with the 1-based
   * "block N of N" label.
   */
  readonly progressFraction: (doc: unknown) => number;
  /**
   * Whether `blockId` is at or AFTER the current read-point in document order — the
   * forward-only guard the auto-advance-on-extract path uses so extracting above the
   * read-point never rewinds it. `true` when there is no read-point yet.
   */
  readonly isAtOrAfterReadPoint: (doc: unknown, blockId: string) => boolean;
}

function toResolved(payload: ReadPointPayload | null): ResolvedReadPoint | null {
  return payload ? { blockId: payload.blockId, offset: payload.offset } : null;
}

/**
 * Manage loading + setting + jumping of one element's read-point.
 *
 * @param elementId The owning element id (source/topic), or `null`/`undefined`.
 */
export function useReadPoint(elementId: string | null | undefined): UseReadPointResult {
  const [status, setStatus] = useState<ReadPointStatus>(isDesktop() ? "loading" : "no-desktop");
  const [readPoint, setReadPointState] = useState<ResolvedReadPoint | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load on mount / when the element changes.
  useEffect(() => {
    if (!isDesktop()) {
      setStatus("no-desktop");
      return;
    }
    if (!elementId) {
      setStatus("loading");
      setReadPointState(null);
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setError(null);
    void appApi
      .getReadPoint({ elementId })
      .then((result) => {
        if (cancelled) return;
        setReadPointState(toResolved(result.readPoint));
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [elementId]);

  /** Persist a resolved read-point through the typed bridge (one row per element). */
  const persist = useCallback(
    async (point: ResolvedReadPoint): Promise<ResolvedReadPoint | null> => {
      if (!elementId || !isDesktop()) return null;
      setSaving(true);
      try {
        const result = await appApi.setReadPoint({
          elementId,
          // The block lives in this element's own document body.
          documentId: elementId,
          blockId: point.blockId,
          offset: point.offset,
        });
        const next = { blockId: result.readPoint.blockId, offset: result.readPoint.offset };
        setReadPointState(next);
        setError(null);
        return next;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setSaving(false);
      }
    },
    [elementId],
  );

  const setFromSelection = useCallback(
    async (editor: Editor): Promise<ResolvedReadPoint | null> => {
      const resolved = resolveReadPointFromSelection(editor);
      if (!resolved) return null;
      return persist(resolved);
    },
    [persist],
  );

  const markReadThrough = useCallback(
    async (editor: Editor, blockId: string): Promise<ResolvedReadPoint | null> => {
      const resolved = readThroughBlock(editor.getJSON(), blockId);
      if (!resolved) return null;
      return persist(resolved);
    },
    [persist],
  );

  const jump = useCallback(
    (editor: Editor): JumpResult => jumpToReadPoint(editor, readPoint),
    [readPoint],
  );

  const firstUnreadBlockId = useCallback(
    (doc: unknown): string | null => computeFirstUnread(doc, readPoint),
    [readPoint],
  );

  const progress = useCallback(
    (doc: unknown): { readonly index: number; readonly total: number } =>
      readPointProgress(doc, readPoint),
    [readPoint],
  );

  const progressFraction = useCallback(
    (doc: unknown): number => readPointProgressFraction(doc, readPoint),
    [readPoint],
  );

  const isAtOrAfterReadPoint = useCallback(
    (doc: unknown, blockId: string): boolean => isBlockAtOrAfterReadPoint(doc, readPoint, blockId),
    [readPoint],
  );

  return {
    status,
    readPoint,
    saving,
    error,
    setFromSelection,
    markReadThrough,
    jump,
    firstUnreadBlockId,
    progress,
    progressFraction,
    isAtOrAfterReadPoint,
  };
}

/**
 * useLineageDelete (T135 / U7) — the shared controller behind every descendant-aware
 * delete entry point.
 *
 * Encapsulates the honorable-delete intents so the inspector, extract reader, queue
 * row/loop, source reader, and maintenance surfaces all behave identically:
 *
 *   • Keep descendants  → `softDeleteSubtree({ includeSubtree: false })` (tombstone the
 *     node; descendants stay live + connected). The safe default.
 *   • Delete the branch → `softDeleteSubtree({ includeSubtree: true })` (soft-cascade the
 *     node + every live descendant under one `batchId`, recoverable as a unit).
 *   • Mark processed    → the extract `done_without_card` fate (node kept as provenance).
 *   • Rest / Fallow     → the topic fallow path (the honorable non-destructive topic state).
 *   • Quiet delete      → a single soft-delete for a leaf (no menu), via the host's existing
 *     delete path (so it stays the SAME op ⌘Z + Trash already understand).
 *
 * It owns the Undo snackbar state too. The crucial correctness rule (KTD10): the
 * BRANCH-delete snackbar Undo calls `restoreBatch({ batchId })` — the batch it announced —
 * NOT `undoLast`, so it restores the exact branch even after an intervening logged action.
 * The leaf/tombstone/mark-done variants can rely on the host's own quiet undo (⌘Z / the
 * row recipe) and therefore raise no snackbar of their own when the host already does.
 *
 * Pure orchestration over `window.appApi` — no SQL, no lineage math in the renderer.
 */

import { useCallback, useRef, useState } from "react";
import {
  appApi,
  type ElementsCountDescendantsResult,
  isDesktop,
  type TopicFallowRequest,
} from "../../lib/appApi";
import type { IconName } from "../Icon";
import { SNACKBAR_TIMEOUT_LONG_MS } from "../Snackbar";

/** The element a delete targets — the minimum the menu + controller need. */
export interface LineageDeleteTarget {
  readonly id: string;
  readonly type: string;
  /** A short title for the (optional) snackbar copy; falls back to a generic noun. */
  readonly title?: string | null | undefined;
}

/** The snackbar the controller raises after an action. */
export interface LineageDeleteSnackbar {
  readonly message: string;
  /** Undo handler, or `undefined` for a no-undo (error) toast. */
  readonly onUndo?: () => void;
  /** Leading icon — `trash` for a delete, `checkCircle` for the kept-alive variants. */
  readonly icon: IconName;
  /** Auto-dismiss window in ms (a large branch gets a longer one). */
  readonly timeoutMs?: number;
}

/** Default per-type fallow window for the topic "Rest" action — 14 days out. */
function defaultFallowUntilIso(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 14);
  return date.toISOString();
}

/** A short, human noun for the deleted target (for the snackbar copy). */
function targetNoun(type: string): string {
  switch (type) {
    case "extract":
      return "Extract";
    case "topic":
      return "Topic";
    case "source":
      return "Source";
    case "card":
      return "Card";
    default:
      return "Item";
  }
}

/** Above this many nodes a branch-delete snackbar holds a little longer (KTD/U7). */
export const LARGE_BRANCH_THRESHOLD = 10;

export interface UseLineageDeleteOptions {
  /**
   * Run after any successful action (re-read the surface + `requestInspectorRefresh()`).
   * Receives the target id and the kind that ran so a host can also navigate away.
   */
  readonly onAfter?: (
    target: LineageDeleteTarget,
    kind: "quiet" | "keep" | "branch" | "markDone" | "rest",
  ) => void;
  /**
   * Run after a controller-owned snackbar undo succeeds. Defaults to `onAfter` so
   * existing hosts continue to refresh after undo; hosts with local cursor/progress
   * state can distinguish undo from forward mutation.
   */
  readonly onUndoAfter?: (target: LineageDeleteTarget, kind: "quiet" | "keep" | "branch") => void;
  /**
   * The host's own single-row soft-delete for the LEAF / quiet path (R4) — usually the
   * existing `deleteExtract` / `actOnQueueItem({delete})` call. Kept as-is so the leaf
   * delete stays the SAME op the host's ⌘Z / Trash already understand. When omitted, the
   * quiet path falls back to `softDeleteSubtree({ includeSubtree: false })`.
   */
  readonly quietDelete?: (target: LineageDeleteTarget) => Promise<void>;
  /**
   * Whether the host already raises its own undo affordance for the quiet/leaf delete
   * (e.g. the queue's row recipe). When `true`, the controller does NOT raise its own
   * leaf snackbar (the host owns it); the branch snackbar is always controller-owned
   * because only `restoreBatch` can undo it order-independently.
   */
  readonly hostOwnsQuietUndo?: boolean;
}

export function useLineageDelete(options: UseLineageDeleteOptions = {}) {
  const { onAfter, onUndoAfter, quietDelete, hostOwnsQuietUndo = false } = options;
  const [snackbar, setSnackbar] = useState<LineageDeleteSnackbar | null>(null);
  // A single in-flight guard for the mutation phase (count is guarded inside the menu).
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const run = useCallback(
    async (
      kind: "quiet" | "keep" | "branch" | "markDone" | "rest",
      target: LineageDeleteTarget,
      fn: () => Promise<LineageDeleteSnackbar | null>,
    ) => {
      if (!isDesktop() || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const toast = await fn();
        if (toast) setSnackbar(toast);
        onAfter?.(target, kind);
      } catch (e) {
        setSnackbar({
          message: e instanceof Error ? e.message : String(e),
          icon: "trash",
        });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onAfter],
  );

  /** Quiet leaf delete (R4): immediate single soft-delete + an Undo snackbar (unless the host owns it). */
  const quiet = useCallback(
    (target: LineageDeleteTarget) =>
      run("quiet", target, async () => {
        if (quietDelete) {
          await quietDelete(target);
        } else {
          await appApi.softDeleteSubtree({ id: target.id, includeSubtree: false });
        }
        if (hostOwnsQuietUndo) return null;
        return {
          message: `${targetNoun(target.type)} deleted`,
          icon: "trash",
          onUndo: () => {
            void appApi
              .undoLast()
              .then(() => (onUndoAfter ?? onAfter)?.(target, "quiet"))
              .catch((e) =>
                setSnackbar({ message: e instanceof Error ? e.message : String(e), icon: "trash" }),
              );
            setSnackbar(null);
          },
        };
      }),
    [run, quietDelete, hostOwnsQuietUndo, onAfter, onUndoAfter],
  );

  /** Keep descendants (default): tombstone only the node; descendants stay live. */
  const keepDescendants = useCallback(
    (target: LineageDeleteTarget, count?: ElementsCountDescendantsResult) =>
      run("keep", target, async () => {
        await appApi.softDeleteSubtree({ id: target.id, includeSubtree: false });
        const kept = count?.total ?? 0;
        return {
          message:
            kept > 0
              ? `${targetNoun(target.type)} removed — ${kept} item${kept === 1 ? "" : "s"} kept`
              : `${targetNoun(target.type)} deleted`,
          icon: "trash",
          onUndo: () => {
            void appApi
              .undoLast()
              .then(() => (onUndoAfter ?? onAfter)?.(target, "keep"))
              .catch((e) =>
                setSnackbar({ message: e instanceof Error ? e.message : String(e), icon: "trash" }),
              );
            setSnackbar(null);
          },
        };
      }),
    [run, onAfter, onUndoAfter],
  );

  /**
   * Delete the whole branch: soft-cascade under one `batchId`. The snackbar Undo restores
   * THAT batch via `restoreBatch` (KTD10), so it is order-independent — it survives an
   * intervening grade/postpone, which `undoLast` would not.
   */
  const deleteBranch = useCallback(
    (target: LineageDeleteTarget) =>
      run("branch", target, async () => {
        const res = await appApi.softDeleteSubtree({ id: target.id, includeSubtree: true });
        const n = res.affected.length;
        const batchId = res.batchId;
        return {
          message: `Branch deleted (${n} item${n === 1 ? "" : "s"})`,
          icon: "trash" as const,
          // A big branch's only cheap "undo the whole thing" affordance is this Undo, so
          // hold the toast a little longer when there's a lot to lose.
          ...(n > LARGE_BRANCH_THRESHOLD ? { timeoutMs: SNACKBAR_TIMEOUT_LONG_MS } : {}),
          onUndo: () => {
            void appApi
              .restoreBatchFromTrash({ batchId })
              .then(() => (onUndoAfter ?? onAfter)?.(target, "branch"))
              .catch((e) =>
                setSnackbar({ message: e instanceof Error ? e.message : String(e), icon: "trash" }),
              );
            setSnackbar(null);
          },
        };
      }),
    [run, onAfter, onUndoAfter],
  );

  /**
   * The countDescendants read FAILED (R4 error path): fall through to a safe single
   * soft-delete so the user's intent isn't lost, but surface the read error with NO undo
   * (we couldn't quantify the blast radius, so we don't promise a batch restore).
   */
  const quietAfterCountError = useCallback(
    (target: LineageDeleteTarget, errorMessage: string) =>
      run("quiet", target, async () => {
        if (quietDelete) {
          await quietDelete(target);
        } else {
          await appApi.softDeleteSubtree({ id: target.id, includeSubtree: false });
        }
        return {
          message: `${targetNoun(target.type)} deleted — couldn't check for descendants (${errorMessage})`,
          icon: "trash",
        };
      }),
    [run, quietDelete],
  );

  /** Mark processed (extract honorable fate) — keep the node alive as provenance (R6/KTD4). */
  const markProcessed = useCallback(
    (target: LineageDeleteTarget) =>
      run("markDone", target, async () => {
        await appApi.setExtractFate({ id: target.id, fate: "done_without_card" });
        return { message: "Extract marked done", icon: "checkCircle" };
      }),
    [run],
  );

  /** Rest / Fallow (topic honorable state) — NEVER calls the extract-only setFate (R6/KTD4). */
  const restTopic = useCallback(
    (target: LineageDeleteTarget) =>
      run("rest", target, async () => {
        const request: TopicFallowRequest = {
          topicId: target.id,
          fallowUntil: defaultFallowUntilIso(),
        };
        await appApi.fallowTopic(request);
        return { message: "Topic resting", icon: "checkCircle" };
      }),
    [run],
  );

  return {
    snackbar,
    setSnackbar,
    busy,
    actions: {
      quiet,
      quietAfterCountError,
      keepDescendants,
      deleteBranch,
      markProcessed,
      restTopic,
    },
  };
}

export type LineageDeleteActions = ReturnType<typeof useLineageDelete>["actions"];

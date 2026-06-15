/**
 * LineageContextMenu (lineage-tree context menu, U5) — the host container that turns a
 * right-clicked {@link LineageNode} into the in-app {@link ContextMenu}, then dispatches
 * each chosen action through the right channel.
 *
 * The container is intentionally THIN: it owns no domain logic. It assembles the
 * type-aware catalog with {@link buildLineageNodeMenu}, renders the presentational
 * `ContextMenu`, and wires the injected handlers to:
 *
 *   • the router/selection (Open, Create card → navigate to the extract surface),
 *   • the clipboard (Copy reference → `interleave://element/<id>`, Copy text → title),
 *   • the typed `appApi` commands (priority / advance-stage / postpone / mark-done /
 *     suspend / flag-leech / retire / rename / restore / restore-chain / purge), and
 *   • the SHARED {@link useLineageDelete} flow for Delete — routed through the SAME
 *     {@link LineageDeleteMenu} component (count-descendants pre-flight → fast-path or
 *     intent popover + Undo) as every other delete entry point. There is NO second
 *     soft-delete call site here (R4): Delete sets a delete target + bumps a signal that
 *     drives the rendered (hidden-trigger) `LineageDeleteMenu`.
 *
 * Toasts: the renderer's only shared transient toast is `Snackbar`. Delete owns its
 * Undo snackbar via `useLineageDelete`; the clipboard + error toasts here use a second,
 * short-lived `Snackbar` (no Undo). The in-flight guard resets when the mutation settles,
 * never on a menu open→close transition (KTD6), so a fast action can never deadlock.
 *
 * Inspector owns the menu target state (U6); this component is controlled via `target`.
 * It is renderer-only: every mutation is gated by `isDesktop()` and dispatched as an
 * existing typed `appApi` command — no SQL, no FS, no new generic IPC.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appApi, isDesktop, type LineageNode } from "../../lib/appApi";
import { elementDeepLink } from "../../lib/deep-link";
import { LineageDeleteMenu } from "../lineage/LineageDeleteMenu";
import { useLineageDelete } from "../lineage/useLineageDelete";
import { ContextMenu } from "../menu/ContextMenu";
import type { ContextMenuItem, ContextMenuPosition } from "../menu/types";
import { SNACKBAR_TIMEOUT_MS, Snackbar } from "../Snackbar";
import {
  buildLineageNodeMenu,
  type LineageNodeMenuHandlers,
  type PriorityLabel,
} from "./lineageNodeActions";
import "./lineage-context-menu.css";

/** A short, no-undo toast (clipboard confirmations + command errors). */
interface CtxToast {
  readonly message: string;
  readonly icon: "link" | "copy" | "trash" | "checkCircle" | "warning";
}

/** The in-flight inline rename editor (Rename… opens this at the node's position). */
interface RenameState {
  readonly node: LineageNode;
  readonly position: ContextMenuPosition;
}

export function LineageContextMenu({
  target,
  onClose,
  onOpen,
  onAfterMutation,
}: {
  /** The right-clicked node + cursor position, or `null` when the menu is closed. */
  readonly target: { readonly node: LineageNode; readonly position: ContextMenuPosition } | null;
  /** Clear the menu target (the host owns the state). */
  readonly onClose: () => void;
  /** Navigate to / select a node (the Inspector's onPickLineageNode). */
  readonly onOpen: (node: LineageNode) => void;
  /** Re-read the surface after a successful mutation (requestInspectorRefresh). */
  readonly onAfterMutation: () => void;
}) {
  // Delete rides the SAME controller + component as every other delete entry point.
  const { snackbar, setSnackbar, busy, actions } = useLineageDelete({
    onAfter: onAfterMutation,
    onUndoAfter: onAfterMutation,
  });

  const [toast, setToast] = useState<CtxToast | null>(null);
  const [rename, setRename] = useState<RenameState | null>(null);
  // The hidden LineageDeleteMenu is driven by a target + a bumped signal (NOT a click). The
  // target, anchor position, and signal are ONE atom so they can only ever move together —
  // a single setState means the consuming LineageDeleteMenu effect can never observe a new
  // signal against a stale target/position (which would act on the wrong node).
  const [deleteState, setDeleteState] = useState<{
    readonly target: { id: string; type: string; title?: string | null };
    readonly position: ContextMenuPosition;
    readonly signal: number;
  } | null>(null);

  // A single in-flight guard for the direct-command mutations (Delete has its own in the
  // controller). It resets when the work settles, never on open→close (KTD6) — see below.
  const submittingRef = useRef(false);

  const showToast = useCallback((next: CtxToast) => setToast(next), []);

  /**
   * Wrap a direct `appApi` mutation: gate on desktop + the in-flight guard, run it,
   * refresh + close on success, surface an error toast on failure, and ALWAYS release
   * the guard when the call settles so a fast action can never deadlock the menu (KTD6).
   */
  const runMutation = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      if (!isDesktop() || submittingRef.current) return;
      submittingRef.current = true;
      try {
        await fn();
        onAfterMutation();
        onClose();
      } catch (e) {
        setToast({
          message: e instanceof Error ? e.message : `Could not ${label}`,
          icon: "warning",
        });
        onClose();
      } finally {
        submittingRef.current = false;
      }
    },
    [onAfterMutation, onClose],
  );

  const copyToClipboard = useCallback(
    (text: string, ok: CtxToast) => {
      void navigator.clipboard.writeText(text).then(
        () => showToast(ok),
        () => showToast({ message: "Could not copy", icon: "copy" }),
      );
      onClose();
    },
    [onClose, showToast],
  );

  const commitRename = useCallback(
    (node: LineageNode, value: string) => {
      const next = value.trim();
      setRename(null);
      if (next === "" || next === node.title) return;
      void runMutation("rename", async () => {
        const res = await appApi.renameElement({ id: node.id, title: next });
        // A null element means the target was deleted between right-click and commit —
        // surface it as an error rather than reporting a silent (no-op) success.
        if (!res.element) throw new Error("Couldn't rename — the item no longer exists");
      });
    },
    [runMutation],
  );

  // The catalog is memoised on the right-clicked node so `items` keeps a STABLE identity
  // across unrelated re-renders (toasts, snackbars): without this the ContextMenu would
  // re-measure/re-place on every render and an open submenu would remount + steal focus.
  const items = useMemo<ContextMenuItem[]>(() => {
    if (!target) return [];
    const node = target.node;
    const position = target.position;
    const handlers: LineageNodeMenuHandlers = {
      open: (n) => {
        onOpen(n);
        onClose();
      },
      copyReference: (n) =>
        copyToClipboard(elementDeepLink(n.id), { message: "Reference copied", icon: "link" }),
      copyText: (n) => copyToClipboard(n.title, { message: "Copied to clipboard", icon: "copy" }),
      setPriority: (n, priority: PriorityLabel) =>
        void runMutation("set priority", async () => {
          await appApi.setElementPriority({ id: n.id, action: { kind: "set", priority } });
        }),
      // Rename opens the inline editor at the node's position (no IPC yet — commit does it).
      rename: (n) => {
        setRename({ node: n, position });
        onClose();
      },
      delete: (n) => {
        // R4: route through the SAME LineageDeleteMenu flow — set the target + bump the
        // signal (atomically) so its countDescendants → fast-path-or-intent-popover runs.
        // We never call softDeleteSubtree directly here.
        setDeleteState((prev) => ({
          target: { id: n.id, type: n.type, title: n.title },
          position,
          signal: (prev?.signal ?? 0) + 1,
        }));
        onClose();
      },
      advanceStage: (n) =>
        void runMutation("advance stage", async () => {
          await appApi.updateExtractStage({ id: n.id });
        }),
      // Create card needs the multi-field CardBuilder (KTD5): navigate to the extract
      // surface rather than firing createCard with empty fields.
      createCard: (n) => {
        onOpen(n);
        onClose();
      },
      postpone: (n) =>
        void runMutation("postpone", async () => {
          await appApi.postponeExtract({ id: n.id });
        }),
      markDone: (n) =>
        void runMutation("mark done", async () => {
          await appApi.markExtractDone({ id: n.id });
        }),
      suspend: (n) =>
        void runMutation("suspend", async () => {
          await appApi.suspendCard({ cardId: n.id });
        }),
      flagLeech: (n) =>
        void runMutation("flag leech", async () => {
          await appApi.markLeechCard({ cardId: n.id, leech: true });
        }),
      retire: (n) =>
        void runMutation("retire", async () => {
          await appApi.retireCard({ cardId: n.id });
        }),
      restore: (n) =>
        void runMutation("restore", async () => {
          await appApi.restoreFromTrash({ id: n.id });
        }),
      restoreAncestorChain: (n) =>
        void runMutation("restore chain", async () => {
          await appApi.restoreAncestorChain({ id: n.id });
        }),
      purge: (n) =>
        void runMutation("delete permanently", async () => {
          const res = await appApi.purgeFromTrash({ id: n.id });
          if (res.blocked) {
            // A purge that would orphan live descendants is refused server-side; surface it
            // (this throws out of the success path so the toast is the blocked message).
            throw new Error(
              `Can't delete permanently — ${res.liveDependents} live item${
                res.liveDependents === 1 ? "" : "s"
              } still descend from it`,
            );
          }
        }),
    };
    return buildLineageNodeMenu(node, handlers);
  }, [target, onOpen, onClose, copyToClipboard, runMutation]);

  return (
    <>
      <ContextMenu
        open={!!target}
        position={target?.position ?? { x: 0, y: 0 }}
        items={items}
        onClose={onClose}
        ariaLabel={target ? `Actions for ${target.node.title}` : "Lineage node actions"}
        testId="lineage-context-menu"
      />

      {/* The inline rename editor (commit on Enter; cancel on Escape/blur). */}
      {rename ? (
        <RenameInput
          state={rename}
          onCommit={(value) => commitRename(rename.node, value)}
          onCancel={() => setRename(null)}
        />
      ) : null}

      {/*
       * The driven Delete flow (R4): the SAME LineageDeleteMenu component, anchored near
       * the node. Its trigger is collapsed (it is fired by the bumped signal, not a
       * click) but stays in the DOM + focusable for the intent popover's focus mgmt.
       */}
      <span
        className="lctx-delete-host"
        style={{ left: deleteState?.position.x ?? 0, top: deleteState?.position.y ?? 0 }}
      >
        <LineageDeleteMenu
          target={deleteState?.target ?? null}
          actions={actions}
          busy={busy}
          triggerSignal={deleteState?.signal ?? 0}
          triggerTestId="lineage-context-delete-trigger"
        />
      </span>

      {/* Delete's own Undo snackbar (controller-owned). */}
      {snackbar ? (
        <Snackbar
          message={snackbar.message}
          onUndo={snackbar.onUndo}
          onClose={() => setSnackbar(null)}
          icon={snackbar.icon}
          timeoutMs={snackbar.timeoutMs}
          testId="lineage-context-snackbar"
        />
      ) : null}

      {/* Clipboard + error toasts (no Undo). */}
      {toast ? (
        <Snackbar
          message={toast.message}
          onClose={() => setToast(null)}
          icon={toast.icon}
          timeoutMs={SNACKBAR_TIMEOUT_MS}
          testId="lineage-context-toast"
        />
      ) : null}
    </>
  );
}

/** The small fixed-position inline rename field (autofocus + select-all on mount). */
function RenameInput({
  state,
  onCommit,
  onCancel,
}: {
  readonly state: RenameState;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(state.node.title);
  // Run teardown exactly once: Enter/blur commit (so "edit then click away to save" never
  // silently drops the rename), Escape cancels. The latch also stops the unmount-triggered
  // blur (fired when commit/cancel sets rename=null) from re-running teardown.
  const doneRef = useRef(false);
  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      className="lctx-rename"
      data-testid="lineage-rename-input"
      aria-label="Rename"
      value={value}
      style={{ left: state.position.x, top: state.position.y }}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

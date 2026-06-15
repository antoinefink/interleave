/**
 * LineageTree (T023) — the navigable element hierarchy, rebuilt from the design
 * kit's `LineageTree` (`design/kit/app/components.jsx`) for React 19.
 *
 * Renders the FLATTENED, depth-tagged nodes the main process computes
 * (`lineage.get`) as depth-indented `tree-row`/`tree-indent`/`tree-node` rows —
 * `source → extract → sub-extract → card`, navigable in BOTH directions. The whole
 * tree is computed in `packages/local-db` and crosses IPC as flat nodes; this
 * component ONLY renders + navigates (no lineage logic, no SQL — per the layering
 * rules). Clicking a node re-selects that element (driving the inspector) and, for
 * sources, navigates the reader to `/source/$id`.
 *
 * Pixel-for-pixel with the kit: a `tree-indent` spacer per depth level (the
 * vertical guide line), the `TypeIcon`, a truncated title, the active node's
 * `tree-node--on` accent highlight, and a faint mono `meta` suffix.
 *
 * Tombstones (T135 / U2): when the lineage is requested with `includeTombstones`, a
 * soft-deleted ancestor (or the focused node itself) carries `deleted: true`. Such a
 * node renders MUTED + with a struck-through title (mirroring `.badge--dismissed`) so
 * it reads as clearly-deleted — distinct from a live-but-inactive node AND from the
 * retired/expired card treatments that also use `--text-3` — and carries an
 * ALWAYS-VISIBLE (keyboard-reachable, never hover-only) inline "Restore" control so a
 * focused live card never silently loses its own chain.
 *
 * Right-click (U5): when the host passes `onNodeContextMenu`, right-clicking a node
 * suppresses the native browser menu and reports the node + cursor position so the host
 * can open the in-app `LineageContextMenu`. The inline Restore control is unaffected.
 */

import type { LineageNode } from "../../lib/appApi";
import { Icon } from "../Icon";
import { TypeIcon } from "./primitives";

/** Render an array of depth-tagged lineage nodes as the kit's `LineageTree`. */
export function LineageTree({
  nodes,
  onPick,
  onRestore,
  restoringId = null,
  onNodeContextMenu,
}: {
  readonly nodes: readonly LineageNode[];
  /** Called with the picked node; the caller re-selects + navigates. */
  onPick: (node: LineageNode) => void;
  /**
   * Restore a soft-deleted tombstone node (T135). Omit to hide the inline Restore
   * control entirely (e.g. surfaces that only ever render live lineage).
   */
  onRestore?: (node: LineageNode) => void;
  /** The id of the tombstone whose restore is in flight (its control shows a busy state). */
  restoringId?: string | null;
  /**
   * Right-click a node (U5): suppress the native menu and report the node + cursor
   * position so the host can open the in-app `LineageContextMenu`. Omit to keep the
   * default browser context menu (e.g. surfaces with no per-node actions).
   */
  onNodeContextMenu?: (node: LineageNode, position: { x: number; y: number }) => void;
}) {
  return (
    <div className="tree" data-testid="lineage-tree">
      {nodes.map((n) => {
        const restoring = restoringId === n.id;
        return (
          <div className="tree-row" key={n.id}>
            {/* One indent spacer per depth level (the kit's vertical guide line). */}
            {Array.from({ length: n.depth }).map((_, d) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: pure spacers, count == depth
              <span className="tree-indent" key={d} aria-hidden />
            ))}
            <button
              type="button"
              className={`tree-node${n.active ? " tree-node--on" : ""}${
                n.deleted ? " tree-node--deleted" : ""
              }`}
              data-testid="lineage-tree-node"
              data-element-id={n.id}
              data-element-type={n.type}
              data-depth={n.depth}
              data-active={n.active ? "true" : "false"}
              data-deleted={n.deleted ? "true" : "false"}
              aria-current={n.active ? "true" : undefined}
              onClick={() => onPick(n)}
              onContextMenu={(e) => {
                if (onNodeContextMenu) {
                  e.preventDefault();
                  onNodeContextMenu(n, { x: e.clientX, y: e.clientY });
                }
              }}
            >
              <TypeIcon type={n.type} />
              <span className="tree-node__title">{n.title}</span>
              {n.deleted ? (
                <span className="tree-node__tomb" data-testid="lineage-tombstone-tag">
                  deleted
                </span>
              ) : n.meta ? (
                <span className="tree-node__meta">{n.meta}</span>
              ) : null}
            </button>
            {n.deleted && onRestore ? (
              <button
                type="button"
                className="tree-node__restore"
                data-testid="lineage-tombstone-restore"
                data-element-id={n.id}
                disabled={restoring}
                aria-label={`Restore ${n.title}`}
                onClick={() => onRestore(n)}
              >
                <Icon name="restore" size={12} />
                {restoring ? "Restoring…" : "Restore"}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

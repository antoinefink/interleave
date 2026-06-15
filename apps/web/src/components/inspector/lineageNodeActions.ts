/**
 * Type-aware action-catalog builder for the lineage-tree context menu (U4).
 *
 * `buildLineageNodeMenu` is a PURE function: no React, no `appApi`/IPC, no Node.
 * It maps a {@link LineageNode} plus an injected handler bag to the flat
 * {@link ContextMenuItem}[] the reusable `ContextMenu` primitive renders. All side
 * effects (clipboard, router, IPC) live in the handlers the host injects, which keeps
 * this catalog trivially unit-testable and keeps `LineageTree`/the catalog free of the
 * renderer's command surface.
 *
 * ## Catalog shape (order matters — R3)
 *
 * **Tombstone branch (exclusive).** When `node.deleted` is true the node is a
 * soft-deleted tombstone and gets ONLY restore/purge affordances — none of the live
 * actions below:
 *   1. Restore (`restore`)
 *   2. Restore ancestor chain (`treeBranch`)
 *   3. separator
 *   4. "Delete permanently…" — a danger **submenu** whose single danger child
 *      ("Yes, permanently delete") fires `purge`. Modelling the destructive confirm as
 *      a one-child submenu means no top-level item ever calls `purge` directly; the user
 *      must open the submenu and pick the explicit child.
 *
 * **Live node.** Every live type gets the universal "All" actions; extract and card
 * types insert their extras as a visually separated block. The grouping (top → bottom):
 *   1. Open · Copy reference · Copy text                       (navigate + clipboard)
 *   2. separator + type-specific extras, only when present:
 *        - extract: Advance stage · Create card · Postpone · Mark done
 *        - card:    Suspend · Flag leech · Retire   (NO Postpone — cards are
 *                   FSRS-scheduled by design)
 *   3. separator + Set priority (4-child submenu A/B/C/D) · Rename… (capability-gated) ·
 *      Delete
 *
 * Separators only appear between non-empty groups, so source/topic nodes (no extras)
 * collapse the middle block to a single separator between the clipboard group and the
 * priority/delete group.
 *
 * **Rename** is a capability gate: the "Rename…" item appears only when
 * `handlers.rename` is provided. Omitting the handler omits the item entirely (KTD1
 * fallback for types whose rename path is unavailable).
 *
 * **Set priority** is always a submenu with four children A/B/C/D (A highest → D lowest),
 * each calling `setPriority(node, label)`.
 */
import type { LineageNode, PriorityLabel } from "../../lib/appApi";
import type {
  ContextMenuActionItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSubmenuItem,
} from "../menu/types";

/** Priority bucket labels, highest (A) → lowest (D). Re-exported from the appApi contract
 * so the catalog and `setElementPriority` can never drift apart. */
export type { PriorityLabel };

/**
 * The injected side-effecting handlers. Each receives the node the menu was opened on.
 * `rename` is optional: omit it to capability-gate the "Rename…" item off for a type
 * whose rename path is unavailable.
 */
export interface LineageNodeMenuHandlers {
  // All live types
  readonly open: (node: LineageNode) => void;
  readonly copyReference: (node: LineageNode) => void;
  readonly copyText: (node: LineageNode) => void;
  readonly setPriority: (node: LineageNode, priority: PriorityLabel) => void;
  /** Optional → capability gate: omit to drop "Rename…" for this node. */
  readonly rename?: (node: LineageNode) => void;
  readonly delete: (node: LineageNode) => void;
  // Extract-only
  readonly advanceStage: (node: LineageNode) => void;
  readonly createCard: (node: LineageNode) => void;
  readonly postpone: (node: LineageNode) => void;
  readonly markDone: (node: LineageNode) => void;
  // Card-only
  readonly suspend: (node: LineageNode) => void;
  readonly flagLeech: (node: LineageNode) => void;
  readonly retire: (node: LineageNode) => void;
  // Tombstone-only
  readonly restore: (node: LineageNode) => void;
  readonly restoreAncestorChain: (node: LineageNode) => void;
  readonly purge: (node: LineageNode) => void;
}

/** A/B/C/D priority children, highest → lowest, with a short relative hint. */
const PRIORITY_LABELS: ReadonlyArray<{ label: PriorityLabel; hint: string }> = [
  { label: "A", hint: "Highest" },
  { label: "B", hint: "High" },
  { label: "C", hint: "Normal" },
  { label: "D", hint: "Low" },
];

function separator(id: string): ContextMenuSeparator {
  return { kind: "separator", id };
}

/**
 * Build the right-click context-menu items for one lineage node.
 *
 * Tombstone nodes (`node.deleted`) return the restore/purge branch only; live nodes
 * return the universal actions plus any extract-/card-specific extras. See the file
 * JSDoc for the exact grouping and ordering.
 */
export function buildLineageNodeMenu(
  node: LineageNode,
  handlers: LineageNodeMenuHandlers,
): ContextMenuItem[] {
  if (node.deleted) {
    const purgeConfirm: ContextMenuActionItem = {
      kind: "action",
      id: "purge-confirm",
      label: "Yes, permanently delete",
      icon: "trash",
      danger: true,
      onSelect: () => handlers.purge(node),
    };
    const purgeSubmenu: ContextMenuSubmenuItem = {
      kind: "submenu",
      id: "purge",
      label: "Delete permanently…",
      icon: "trash",
      danger: true,
      items: [purgeConfirm],
    };
    return [
      {
        kind: "action",
        id: "restore",
        label: "Restore",
        icon: "restore",
        onSelect: () => handlers.restore(node),
      },
      {
        kind: "action",
        id: "restore-chain",
        label: "Restore ancestor chain",
        icon: "treeBranch",
        onSelect: () => handlers.restoreAncestorChain(node),
      },
      separator("sep-tombstone"),
      purgeSubmenu,
    ];
  }

  // --- Group 1: open + clipboard (every live type) -----------------------------------
  const items: ContextMenuItem[] = [
    {
      kind: "action",
      id: "open",
      label: "Open",
      icon: "external",
      onSelect: () => handlers.open(node),
    },
    {
      kind: "action",
      id: "copy-ref",
      label: "Copy reference",
      icon: "link",
      onSelect: () => handlers.copyReference(node),
    },
    {
      kind: "action",
      id: "copy-text",
      label: "Copy text",
      icon: "copy",
      onSelect: () => handlers.copyText(node),
    },
  ];

  // --- Group 2: type-specific extras (extract / card) --------------------------------
  const extras: ContextMenuActionItem[] = [];
  if (node.type === "extract") {
    extras.push(
      {
        kind: "action",
        id: "advance-stage",
        label: "Advance stage",
        icon: "sparkle",
        onSelect: () => handlers.advanceStage(node),
      },
      {
        kind: "action",
        id: "create-card",
        label: "Create card",
        icon: "plus",
        onSelect: () => handlers.createCard(node),
      },
      {
        kind: "action",
        id: "postpone",
        label: "Postpone",
        icon: "pause",
        onSelect: () => handlers.postpone(node),
      },
      {
        kind: "action",
        id: "mark-done",
        label: "Mark done",
        icon: "checkCircle",
        onSelect: () => handlers.markDone(node),
      },
    );
  } else if (node.type === "card") {
    // Cards get NO "Postpone" — they are FSRS-scheduled by design.
    extras.push(
      {
        kind: "action",
        id: "suspend",
        label: "Suspend",
        icon: "pause2",
        onSelect: () => handlers.suspend(node),
      },
      {
        kind: "action",
        id: "flag-leech",
        label: "Flag leech",
        icon: "leech",
        onSelect: () => handlers.flagLeech(node),
      },
      {
        kind: "action",
        id: "retire",
        label: "Retire",
        icon: "archive",
        onSelect: () => handlers.retire(node),
      },
    );
  }
  if (extras.length > 0) {
    items.push(separator("sep-type"), ...extras);
  }

  // --- Group 3: priority + rename + delete (every live type) -------------------------
  const prioritySubmenu: ContextMenuSubmenuItem = {
    kind: "submenu",
    id: "priority",
    label: "Set priority",
    icon: "arrowUp",
    items: PRIORITY_LABELS.map(({ label, hint }) => ({
      kind: "action",
      id: `priority-${label}`,
      label,
      hint,
      onSelect: () => handlers.setPriority(node, label),
    })),
  };
  items.push(separator("sep-actions"), prioritySubmenu);

  if (handlers.rename) {
    const rename = handlers.rename;
    items.push({
      kind: "action",
      id: "rename",
      label: "Rename…",
      icon: "edit",
      onSelect: () => rename(node),
    });
  }

  items.push({
    kind: "action",
    id: "delete",
    label: "Delete",
    icon: "trash",
    danger: true,
    onSelect: () => handlers.delete(node),
  });

  return items;
}

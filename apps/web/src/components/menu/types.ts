/**
 * Item model for the reusable {@link ContextMenu} primitive (lineage-tree context
 * menu, U1).
 *
 * A `ContextMenuItem` is a small discriminated union the host assembles into a flat
 * list (separators included). Action items carry an `onSelect`; submenu items carry a
 * single nested level of action items only (no deeper nesting — the primitive renders
 * exactly one submenu level). Separators are non-interactive dividers.
 *
 * This is a pure presentational contract: it has no `appApi`/IPC/Node imports and is
 * shared verbatim by the type-aware catalog builder downstream so the wiring stays in
 * lock-step with the primitive.
 */
import type { IconName } from "../Icon";

/** A selectable, leaf menu item that runs `onSelect` then closes the menu. */
export interface ContextMenuActionItem {
  readonly kind: "action";
  readonly id: string;
  readonly label: string;
  readonly icon?: IconName;
  /**
   * A leading filled color dot instead of an icon — pass a CSS color/token string
   * (e.g. `"var(--prio-a)"`). Used for the priority A/B/C/D children so they read as a
   * scannable color scale. Takes precedence over `icon` when both are set.
   */
  readonly dot?: string;
  /** Optional secondary line rendered under the label. */
  readonly hint?: string;
  /** Destructive tint (e.g. Delete / purge). */
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

/** A parent item that opens a single nested level of action items to the side. */
export interface ContextMenuSubmenuItem {
  readonly kind: "submenu";
  readonly id: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** ONE level only — submenu children are always plain action items. */
  readonly items: readonly ContextMenuActionItem[];
}

/** A non-focusable visual divider between groups of items. */
export interface ContextMenuSeparator {
  readonly kind: "separator";
  readonly id?: string;
}

export type ContextMenuItem = ContextMenuActionItem | ContextMenuSubmenuItem | ContextMenuSeparator;

/** Cursor-anchored position (clientX/clientY) the menu is opened at. */
export interface ContextMenuPosition {
  readonly x: number;
  readonly y: number;
}

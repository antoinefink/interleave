/**
 * ContextMenu (lineage-tree context menu, U1) — a controlled, cursor-anchored popover.
 *
 * Generalizes the hand-rolled popover mechanics from {@link LineageDeleteMenu}
 * (outside-click close, Escape + focus restore, ArrowUp/ArrowDown nav over
 * `[data-menu-action]` with wraparound, role/aria, token-only CSS) and adds a
 * positioning mode the codebase did not have: `position: fixed` at a supplied cursor
 * `{x,y}` with viewport-edge FLIPPING and one level of submenu.
 *
 * Controlled API: the parent owns `open` + `position`; the menu reports closes via
 * `onClose`. It is renderer-only and purely presentational — no `appApi`/IPC/Node.
 *
 * Positioning: it renders at `{x,y}` (hidden on the very first frame), measures its own
 * rect after mount, then flips left when it would overflow the right edge and up when it
 * would overflow the bottom edge, finally clamping into the VISIBLE viewport with a small
 * margin. Recomputed on open only — there is no resize/scroll reposition loop for v1
 * (scrolling simply closes the menu, which is acceptable and simpler).
 */

import {
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "../Icon";
import type { ContextMenuActionItem, ContextMenuItem, ContextMenuPosition } from "./types";
import "./context-menu.css";

/** Margin (px) kept between the menu and the viewport edge when clamping/flipping. */
const VIEWPORT_MARGIN = 8;

/** Resolved coordinates after measure + flip + clamp. */
interface ResolvedRect {
  readonly left: number;
  readonly top: number;
}

/**
 * Given the desired cursor anchor, the measured menu size, and the viewport, compute
 * the final top-left so the menu stays on-screen: flip to the LEFT of the anchor when it
 * would overflow the right edge, flip UP when it would overflow the bottom edge, then
 * clamp into [margin, viewport - size - margin].
 */
function resolvePlacement(
  anchor: ContextMenuPosition,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin: number,
): ResolvedRect {
  let left = anchor.x;
  if (left + size.width > viewport.width - margin) {
    // Flip so the menu's RIGHT edge sits at the anchor.
    left = anchor.x - size.width;
  }
  left = Math.min(Math.max(left, margin), Math.max(margin, viewport.width - size.width - margin));

  let top = anchor.y;
  if (top + size.height > viewport.height - margin) {
    // Flip so the menu's BOTTOM edge sits at the anchor.
    top = anchor.y - size.height;
  }
  top = Math.min(Math.max(top, margin), Math.max(margin, viewport.height - size.height - margin));

  return { left, top };
}

export function ContextMenu({
  open,
  position,
  items,
  onClose,
  ariaLabel,
  testId = "context-menu",
}: {
  readonly open: boolean;
  /** Cursor anchor (clientX/clientY) the menu opens at. */
  readonly position: ContextMenuPosition;
  readonly items: readonly ContextMenuItem[];
  readonly onClose: () => void;
  readonly ariaLabel?: string;
  /** Test id for the menu container; default "context-menu". */
  readonly testId?: string;
}): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Resolved coords; null until the first post-mount measure (rendered hidden until then).
  const [rect, setRect] = useState<ResolvedRect | null>(null);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);

  // Capture the element to restore focus to when the menu opens; restore it on close.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  // Reset transient placement + submenu state whenever the menu (re)opens or moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the cursor anchor changes too.
  useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      setOpenSubmenuId(null);
      return;
    }
    setRect(null);
    setOpenSubmenuId(null);
  }, [open, position.x, position.y]);

  // After mount, measure the menu and flip/clamp it into the visible viewport.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when items/anchor change so the size is current.
  useLayoutEffect(() => {
    if (!open) return;
    const el = rootRef.current;
    if (!el) return;
    const measured = el.getBoundingClientRect();
    setRect(
      resolvePlacement(
        position,
        { width: measured.width, height: measured.height },
        { width: window.innerWidth, height: window.innerHeight },
        VIEWPORT_MARGIN,
      ),
    );
  }, [open, position.x, position.y, items]);

  // Focus the first enabled top-level action once placed.
  useEffect(() => {
    if (!open || !rect) return;
    const first = rootRef.current?.querySelector<HTMLButtonElement>(
      "[data-menu-action]:not(:disabled)",
    );
    first?.focus();
  }, [open, rect]);

  // Outside-click and window scroll close the menu (no reposition loop for v1).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, onClose]);

  const topLevelActions = useCallback(
    () =>
      Array.from(
        rootRef.current?.querySelectorAll<HTMLButtonElement>(
          // Direct action buttons AND submenu-parent buttons (wrapped one level deep),
          // but NOT the action buttons rendered inside an open submenu.
          ":scope > [data-menu-action]:not(:disabled), :scope > .ctxmenu__submenu > [data-menu-action]:not(:disabled)",
        ) ?? [],
      ),
    [],
  );

  const moveFocus = useCallback(
    (delta: 1 | -1) => {
      const els = topLevelActions();
      if (els.length === 0) return;
      // biome-ignore lint/complexity/useIndexOf: document.activeElement is Element | null; indexOf would require an unsafe cast.
      const idx = els.findIndex((el) => el === document.activeElement);
      const next = els[(idx + delta + els.length) % els.length];
      next?.focus();
    },
    [topLevelActions],
  );

  const selectAction = useCallback(
    (item: ContextMenuActionItem) => {
      if (item.disabled) return;
      item.onSelect();
      onClose();
    },
    [onClose],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          if (openSubmenuId) {
            // Escape inside a submenu closes only the submenu, back to its parent.
            setOpenSubmenuId(null);
            return;
          }
          onClose();
          return;
        case "ArrowDown":
          e.preventDefault();
          moveFocus(1);
          return;
        case "ArrowUp":
          e.preventDefault();
          moveFocus(-1);
          return;
        case "ArrowLeft":
          if (openSubmenuId) {
            e.preventDefault();
            const parent = rootRef.current?.querySelector<HTMLButtonElement>(
              `[data-submenu-parent="${openSubmenuId}"]`,
            );
            setOpenSubmenuId(null);
            parent?.focus();
          }
          return;
        default:
          return;
      }
    },
    [moveFocus, onClose, openSubmenuId],
  );

  // Hidden until measured so the first paint is never off-screen; anchored at {x,y} on
  // that first frame so getBoundingClientRect reflects a realistic position.
  const style: CSSProperties = rect
    ? { left: rect.left, top: rect.top }
    : { left: position.x, top: position.y, visibility: "hidden" };

  const flipSubmenuLeft = useMemo(() => {
    if (!rect) return false;
    // If there is little room to the right of the menu, open submenus to the left.
    return rect.left > window.innerWidth / 2;
  }, [rect]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      className="ctxmenu"
      role="menu"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      data-testid={testId}
      style={style}
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) =>
        renderItem(item, index, {
          openSubmenuId,
          setOpenSubmenuId,
          selectAction,
          flipSubmenuLeft,
        }),
      )}
    </div>
  );
}

/** Shared render context threaded into each item so the map stays declarative. */
interface RenderCtx {
  readonly openSubmenuId: string | null;
  readonly setOpenSubmenuId: (id: string | null) => void;
  readonly selectAction: (item: ContextMenuActionItem) => void;
  readonly flipSubmenuLeft: boolean;
}

function renderItem(item: ContextMenuItem, index: number, ctx: RenderCtx): ReactElement {
  if (item.kind === "separator") {
    // <hr> carries an implicit `separator` role (so `getByRole("separator")` still
    // matches) and is non-focusable — no fake `aria-valuenow` needed.
    return (
      <hr
        key={item.id ?? `sep-${index}`}
        className="ctxmenu__separator"
        data-testid="context-menu-separator"
      />
    );
  }
  if (item.kind === "submenu") {
    return <SubmenuItem key={item.id} item={item} ctx={ctx} />;
  }
  return <ActionButton key={item.id} item={item} onSelect={() => ctx.selectAction(item)} />;
}

/** A leaf action: a focusable `menuitem` button that runs onSelect then closes. */
function ActionButton({
  item,
  onSelect,
}: {
  item: ContextMenuActionItem;
  onSelect: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-action
      className={`ctxmenu__item${item.danger ? " ctxmenu__item--danger" : ""}`}
      disabled={item.disabled}
      data-testid={`context-menu-item-${item.id}`}
      onClick={onSelect}
    >
      {item.icon ? (
        <span className="ctxmenu__icon">
          <Icon name={item.icon} size={15} />
        </span>
      ) : null}
      <span className="ctxmenu__text">
        <span className="ctxmenu__label">{item.label}</span>
        {item.hint ? <span className="ctxmenu__hint">{item.hint}</span> : null}
      </span>
    </button>
  );
}

/** A submenu parent + its single nested level, opened to the side on hover/ArrowRight. */
function SubmenuItem({
  item,
  ctx,
}: {
  item: import("./types").ContextMenuSubmenuItem;
  ctx: RenderCtx;
}): ReactElement {
  const expanded = ctx.openSubmenuId === item.id;
  const childRef = useRef<HTMLDivElement>(null);

  const openChild = useCallback(() => {
    if (item.disabled) return;
    ctx.setOpenSubmenuId(item.id);
  }, [ctx, item.disabled, item.id]);

  // Focus the first child when the submenu opens (ArrowRight / hover then keyboard).
  useEffect(() => {
    if (!expanded) return;
    const first = childRef.current?.querySelector<HTMLButtonElement>(
      "[data-menu-action]:not(:disabled)",
    );
    first?.focus();
  }, [expanded]);

  return (
    <div className="ctxmenu__submenu" data-testid={`context-menu-submenu-${item.id}`}>
      <button
        type="button"
        role="menuitem"
        data-menu-action
        data-submenu-parent={item.id}
        aria-haspopup="menu"
        aria-expanded={expanded}
        className={`ctxmenu__item${item.danger ? " ctxmenu__item--danger" : ""}`}
        disabled={item.disabled}
        data-testid={`context-menu-item-${item.id}`}
        onClick={openChild}
        onMouseEnter={openChild}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            openChild();
          }
        }}
      >
        {item.icon ? (
          <span className="ctxmenu__icon">
            <Icon name={item.icon} size={15} />
          </span>
        ) : null}
        <span className="ctxmenu__text">
          <span className="ctxmenu__label">{item.label}</span>
        </span>
        <span className="ctxmenu__chevron">
          <Icon name="chevronRight" size={14} />
        </span>
      </button>
      {expanded ? (
        <div
          ref={childRef}
          className="ctxmenu"
          role="menu"
          aria-orientation="vertical"
          aria-label={item.label}
          data-testid={`context-menu-sub-${item.id}`}
          style={{
            position: "absolute",
            top: 0,
            left: ctx.flipSubmenuLeft ? "auto" : "100%",
            right: ctx.flipSubmenuLeft ? "100%" : "auto",
          }}
        >
          {item.items.map((child) => (
            <ActionButton key={child.id} item={child} onSelect={() => ctx.selectAction(child)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

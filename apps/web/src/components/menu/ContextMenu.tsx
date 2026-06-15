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
 *
 * Submenu interaction (the polished bit): a submenu opens on hover after a short intent
 * delay and closes on a calm grace delay when the pointer leaves — but a **safe-triangle**
 * keeps it open while the pointer is *aiming* toward the submenu, so you can cut the corner
 * diagonally toward A/B/C/D without it snapping shut as you pass over sibling rows. Mouse-
 * opened menus never pre-select a row; a focus ring appears only once the keyboard is used.
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
import { Icon, type IconName } from "../Icon";
import type {
  ContextMenuActionItem,
  ContextMenuItem,
  ContextMenuPosition,
  ContextMenuSubmenuItem,
} from "./types";
import "./context-menu.css";

/** Margin (px) kept between the menu and the viewport edge when clamping/flipping. */
const VIEWPORT_MARGIN = 8;
/** Hover-intent delay before a submenu opens (ms) — a fast sweep shouldn't flicker it. */
const SUBMENU_OPEN_DELAY = 70;
/** Calm grace before a submenu closes once the pointer leaves it (ms). The SAME delay is
 *  used on every leave path (sibling row, off-menu) — never snap shut faster on a sibling. */
const SUBMENU_CLOSE_GRACE = 260;

/** Resolved placement after measure + flip + clamp, with the transform-origin for entrance. */
interface Placement {
  readonly left: number;
  readonly top: number;
  readonly originX: "left" | "right";
  readonly originY: "top" | "bottom";
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Barycentric point-in-triangle test (used for the submenu safe-triangle aim cone). */
function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (d === 0) return false;
  const s = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / d;
  const t = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / d;
  return s >= 0 && t >= 0 && s + t <= 1;
}

/**
 * Given the desired cursor anchor, the measured menu size, and the viewport, compute
 * the final top-left so the menu stays on-screen: flip to the LEFT of the anchor when it
 * would overflow the right edge, flip UP when it would overflow the bottom edge, then
 * clamp into [margin, viewport - size - margin]. Also reports the transform-origin so the
 * entrance scales out from the cursor corner.
 */
function resolvePlacement(
  anchor: ContextMenuPosition,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin: number,
): Placement {
  let left = anchor.x;
  let originX: "left" | "right" = "left";
  if (left + size.width > viewport.width - margin) {
    left = anchor.x - size.width; // flip so the menu's RIGHT edge sits at the anchor
    originX = "right";
  }
  left = Math.min(Math.max(left, margin), Math.max(margin, viewport.width - size.width - margin));

  let top = anchor.y;
  let originY: "top" | "bottom" = "top";
  if (top + size.height > viewport.height - margin) {
    top = anchor.y - size.height; // flip so the menu's BOTTOM edge sits at the anchor
    originY = "bottom";
  }
  top = Math.min(Math.max(top, margin), Math.max(margin, viewport.height - size.height - margin));

  return { left, top, originX, originY };
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
  // Resolved placement; null until the first post-mount measure (rendered hidden until then).
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  // Keyboard mode: ONLY when true does a focus ring show (mouse-opened menus never pre-select).
  const [kbd, setKbd] = useState(false);
  // The menu plays a one-shot entrance: it starts hidden (opacity 0, slightly scaled) the
  // moment it becomes visible, then transitions to its resting visible state on the next frame.
  const [entering, setEntering] = useState(true);

  // Latest-value refs so capture-phase / timer callbacks read current state without re-subscribing.
  const openSubmenuIdRef = useRef<string | null>(null);
  openSubmenuIdRef.current = openSubmenuId;

  // --- submenu hover-intent controller state (refs — no re-render needed) ---
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const prevPointRef = useRef<Point>({ x: 0, y: 0 });
  const curPointRef = useRef<Point>({ x: 0, y: 0 });
  const subRectRef = useRef<DOMRect | null>(null);
  const overSubRef = useRef(false);
  const overParentRef = useRef(false);
  // Set when a submenu is opened via the keyboard so its panel grabs focus once it mounts.
  const pendingFocusFirstRef = useRef(false);

  const flipSubmenuLeft = useMemo(() => {
    if (!placement) return false;
    // If the menu sits in the right half of the viewport, open submenus to the LEFT.
    return placement.left > window.innerWidth / 2;
  }, [placement]);
  const flipSubmenuLeftRef = useRef(flipSubmenuLeft);
  flipSubmenuLeftRef.current = flipSubmenuLeft;

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current != null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);
  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current != null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closeSubmenu = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    subRectRef.current = null;
    setOpenSubmenuId(null);
  }, [clearOpenTimer, clearCloseTimer]);

  const openSubmenuNow = useCallback(
    (id: string, focusFirst: boolean) => {
      clearOpenTimer();
      clearCloseTimer();
      subRectRef.current = null; // re-measured by the panel layout effect once it mounts
      pendingFocusFirstRef.current = focusFirst;
      setOpenSubmenuId(id);
      if (focusFirst) setKbd(true);
    },
    [clearOpenTimer, clearCloseTimer],
  );

  const requestOpenSubmenu = useCallback(
    (id: string) => {
      clearCloseTimer();
      if (openSubmenuIdRef.current === id) return;
      clearOpenTimer();
      openTimerRef.current = window.setTimeout(() => openSubmenuNow(id, false), SUBMENU_OPEN_DELAY);
    },
    [clearCloseTimer, clearOpenTimer, openSubmenuNow],
  );

  const scheduleCloseSubmenu = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      // Honour the pointer that doubled back onto the parent or into the panel.
      if (overSubRef.current || overParentRef.current) return;
      closeSubmenu();
    }, SUBMENU_CLOSE_GRACE);
  }, [clearCloseTimer, closeSubmenu]);

  // Is the pointer aiming into the cone from where it was toward the submenu's near edge?
  const aiming = useCallback(() => {
    const r = subRectRef.current;
    if (!r) return false;
    const nearX = flipSubmenuLeftRef.current ? r.right : r.left;
    return pointInTriangle(
      curPointRef.current,
      prevPointRef.current,
      { x: nearX, y: r.top },
      { x: nearX, y: r.bottom },
    );
  }, []);

  // Capture the element to restore focus to when the menu opens; restore it on close —
  // but only if it is still in the document (a mutation can refresh the tree and detach
  // the opener, in which case focusing it would throw or strand focus on <body>).
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      const opener = restoreFocusRef.current;
      if (opener?.isConnected) opener.focus?.();
    };
  }, [open]);

  // Reset transient state whenever the menu (re)opens or moves: clear placement (hide until
  // re-measured), close any submenu, drop keyboard mode, and arm the entrance.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the cursor anchor changes too.
  useLayoutEffect(() => {
    setPlacement(null);
    setOpenSubmenuId(null);
    setKbd(false);
    setEntering(true);
  }, [open, position.x, position.y]);

  // After mount, measure the menu and flip/clamp it into the visible viewport.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when items/anchor change so the size is current.
  useLayoutEffect(() => {
    if (!open) return;
    const el = rootRef.current;
    if (!el) return;
    const measured = el.getBoundingClientRect();
    setPlacement(
      resolvePlacement(
        position,
        { width: measured.width, height: measured.height },
        { width: window.innerWidth, height: window.innerHeight },
        VIEWPORT_MARGIN,
      ),
    );
  }, [open, position.x, position.y, items]);

  // Drop the entrance class on the next frames so the menu transitions to its resting,
  // fully-visible state (the resting state is visible, so a throttled tab can't strand it).
  useEffect(() => {
    if (!open || !placement || !entering) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntering(false));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [open, placement, entering]);

  // Outside-click closes immediately. Window scroll closes too (no reposition loop for v1),
  // but the scroll listener is attached one frame LATER so an open-time scroll can't dismiss
  // the menu before the user interacts, and it is ignored while a submenu is open. A document
  // mousemove drops keyboard mode so the focus ring fades the moment the pointer is used.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onScroll = () => {
      if (!openSubmenuIdRef.current) onClose();
    };
    const onMove = () => setKbd(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("mousemove", onMove);
    const raf = requestAnimationFrame(() => {
      window.addEventListener("scroll", onScroll, true);
    });
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mousemove", onMove);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, onClose]);

  // Clear pending timers on unmount.
  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
    },
    [clearOpenTimer, clearCloseTimer],
  );

  // Arrow-nav targets the OPEN submenu's children when one is open, so ArrowUp/Down cycle
  // the priority A/B/C/D items instead of escaping back to the top level; otherwise it
  // targets the top-level items (direct actions + submenu-parent buttons, one level deep).
  const navItems = useCallback(() => {
    const root = rootRef.current;
    if (!root) return [] as HTMLButtonElement[];
    const sub = openSubmenuId
      ? root.querySelector<HTMLElement>(`[data-submenu-id="${openSubmenuId}"]`)
      : null;
    if (sub) {
      return Array.from(
        sub.querySelectorAll<HTMLButtonElement>("[data-menu-action]:not(:disabled)"),
      );
    }
    return Array.from(
      root.querySelectorAll<HTMLButtonElement>(
        ":scope > [data-menu-action]:not(:disabled), :scope > .ctxmenu__submenu > [data-menu-action]:not(:disabled)",
      ),
    );
  }, [openSubmenuId]);

  const moveFocus = useCallback(
    (delta: 1 | -1) => {
      setKbd(true);
      const els = navItems();
      if (els.length === 0) return;
      // biome-ignore lint/complexity/useIndexOf: document.activeElement is Element | null; indexOf would require an unsafe cast.
      const idx = els.findIndex((el) => el === document.activeElement);
      const next = els[(idx + delta + els.length) % els.length];
      next?.focus();
    },
    [navItems],
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
            const parent = rootRef.current?.querySelector<HTMLButtonElement>(
              `[data-submenu-parent="${openSubmenuId}"]`,
            );
            closeSubmenu();
            setKbd(true);
            parent?.focus();
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
        case "ArrowRight": {
          const active = document.activeElement as HTMLElement | null;
          const submenuId = active?.dataset.submenuParent;
          if (submenuId) {
            e.preventDefault();
            openSubmenuNow(submenuId, true);
          }
          return;
        }
        case "ArrowLeft":
          if (openSubmenuId) {
            e.preventDefault();
            const parent = rootRef.current?.querySelector<HTMLButtonElement>(
              `[data-submenu-parent="${openSubmenuId}"]`,
            );
            closeSubmenu();
            setKbd(true);
            parent?.focus();
          }
          return;
        default:
          return;
      }
    },
    [moveFocus, onClose, openSubmenuId, closeSubmenu, openSubmenuNow],
  );

  // Track the pointer for the safe-triangle, and keep an aimed-at submenu alive.
  const onMenuMouseMove = useCallback(
    (e: { clientX: number; clientY: number }) => {
      prevPointRef.current = curPointRef.current;
      curPointRef.current = { x: e.clientX, y: e.clientY };
      if (openSubmenuIdRef.current && aiming()) clearCloseTimer();
    },
    [aiming, clearCloseTimer],
  );
  const onMenuMouseLeave = useCallback(() => {
    if (openSubmenuIdRef.current) scheduleCloseSubmenu();
  }, [scheduleCloseSubmenu]);

  // Hidden until measured so the first paint is never off-screen; anchored at {x,y} on
  // that first frame so getBoundingClientRect reflects a realistic position.
  const style: CSSProperties = placement
    ? {
        left: placement.left,
        top: placement.top,
        ["--origin" as string]: `${placement.originY} ${placement.originX}`,
      }
    : { left: position.x, top: position.y, visibility: "hidden" };

  if (!open) return null;

  const ctx: RenderCtx = {
    openSubmenuId,
    flipSubmenuLeft,
    selectAction,
    requestOpenSubmenu,
    openSubmenuNow,
    scheduleCloseSubmenu,
    clearCloseTimer,
    clearOpenTimer,
    setOverParent: (v) => {
      overParentRef.current = v;
    },
    setOverSub: (v) => {
      overSubRef.current = v;
    },
    registerSubRect: (r) => {
      subRectRef.current = r;
    },
    consumeFocusFirst: () => {
      const v = pendingFocusFirstRef.current;
      pendingFocusFirstRef.current = false;
      return v;
    },
    onTopItemEnter: () => {
      // A sibling row was entered while a submenu is open — dismiss on the SAME calm grace.
      if (openSubmenuIdRef.current) scheduleCloseSubmenu();
    },
  };

  return (
    <div
      ref={rootRef}
      className={`ctxmenu ctxmenu--root${entering ? " is-entering" : ""}${kbd ? " kbd" : ""}`}
      role="menu"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      data-testid={testId}
      style={style}
      onKeyDown={onKeyDown}
      onMouseMove={onMenuMouseMove}
      onMouseLeave={onMenuMouseLeave}
    >
      {items.map((item, index) => renderItem(item, index, ctx))}
    </div>
  );
}

/** Shared render context threaded into each item so the map stays declarative. */
interface RenderCtx {
  readonly openSubmenuId: string | null;
  readonly flipSubmenuLeft: boolean;
  readonly selectAction: (item: ContextMenuActionItem) => void;
  readonly requestOpenSubmenu: (id: string) => void;
  readonly openSubmenuNow: (id: string, focusFirst: boolean) => void;
  readonly scheduleCloseSubmenu: () => void;
  readonly clearCloseTimer: () => void;
  readonly clearOpenTimer: () => void;
  readonly setOverParent: (v: boolean) => void;
  readonly setOverSub: (v: boolean) => void;
  readonly registerSubRect: (r: DOMRect) => void;
  /** Returns whether the just-opened submenu should focus its first child, and resets it. */
  readonly consumeFocusFirst: () => boolean;
  readonly onTopItemEnter: () => void;
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
  return (
    <ActionButton
      key={item.id}
      item={item}
      onSelect={() => ctx.selectAction(item)}
      onMouseEnter={ctx.onTopItemEnter}
    />
  );
}

/** The leading adornment: a priority color dot when supplied, else the item's icon. */
function ItemAdornment({
  dot,
  icon,
}: {
  dot?: string | undefined;
  icon?: IconName | undefined;
}): ReactElement | null {
  if (dot) {
    return <span className="ctxmenu__dot" style={{ background: dot }} aria-hidden="true" />;
  }
  if (icon) {
    return (
      <span className="ctxmenu__icon">
        <Icon name={icon} size={15} />
      </span>
    );
  }
  return null;
}

/** A leaf action: a focusable `menuitem` button that runs onSelect then closes. */
function ActionButton({
  item,
  onSelect,
  onMouseEnter,
}: {
  item: ContextMenuActionItem;
  onSelect: () => void;
  onMouseEnter?: () => void;
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
      onMouseEnter={onMouseEnter}
    >
      <ItemAdornment dot={item.dot} icon={item.icon} />
      <span className="ctxmenu__text">
        <span className="ctxmenu__label">{item.label}</span>
        {item.hint ? <span className="ctxmenu__hint">{item.hint}</span> : null}
      </span>
    </button>
  );
}

/** A submenu parent + its single nested level, opened to the side with hover-intent. */
function SubmenuItem({
  item,
  ctx,
}: {
  item: ContextMenuSubmenuItem;
  ctx: RenderCtx;
}): ReactElement {
  const expanded = ctx.openSubmenuId === item.id;
  const childRef = useRef<HTMLDivElement>(null);
  const [subEntering, setSubEntering] = useState(true);

  // On open: measure the panel for the safe-triangle, focus the first child if this was a
  // keyboard open, and arm the panel entrance. Re-runs only on the expanded transition; the
  // `ctx` helpers are render-fresh closures over stable refs, so they stay out of the deps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: register-on-open only.
  useLayoutEffect(() => {
    if (!expanded) {
      setSubEntering(true);
      return;
    }
    const panel = childRef.current;
    if (!panel) return;
    ctx.registerSubRect(panel.getBoundingClientRect());
    // A keyboard open (ArrowRight / Esc-back into the submenu) grabs focus on the first child;
    // a hover open leaves focus untouched so no ring appears.
    if (ctx.consumeFocusFirst()) {
      panel.querySelector<HTMLButtonElement>("[data-menu-action]:not(:disabled)")?.focus();
    }
  }, [expanded]);

  useEffect(() => {
    if (!expanded || !subEntering) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setSubEntering(false));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [expanded, subEntering]);

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
        onClick={() => {
          if (item.disabled) return;
          ctx.openSubmenuNow(item.id, false);
        }}
        onMouseEnter={() => {
          if (item.disabled) return;
          ctx.setOverParent(true);
          ctx.clearCloseTimer();
          ctx.requestOpenSubmenu(item.id);
        }}
        onMouseLeave={() => {
          ctx.setOverParent(false);
          ctx.clearOpenTimer();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            ctx.openSubmenuNow(item.id, true);
          }
        }}
      >
        <ItemAdornment icon={item.icon} />
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
          className={`ctxmenu ctxmenu__sub${subEntering ? " is-entering" : ""}`}
          role="menu"
          aria-orientation="vertical"
          aria-label={item.label}
          data-submenu-id={item.id}
          data-testid={`context-menu-sub-${item.id}`}
          style={{
            // Row-align the first child with the parent (pull up by the menu's own padding),
            // and overlap the parent column a touch so there's no dead gap to cross.
            top: "calc(-1 * var(--s-2))",
            left: ctx.flipSubmenuLeft ? "auto" : "calc(100% - 5px)",
            right: ctx.flipSubmenuLeft ? "calc(100% - 5px)" : "auto",
          }}
          onMouseEnter={() => {
            ctx.setOverSub(true);
            ctx.clearCloseTimer();
          }}
          onMouseLeave={() => {
            ctx.setOverSub(false);
            ctx.scheduleCloseSubmenu();
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

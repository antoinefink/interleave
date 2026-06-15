/**
 * ContextMenu primitive test (lineage-tree context menu, U1).
 *
 * Covers the controlled popover seam: closed render, role/aria + one menuitem per
 * action, cursor positioning, viewport-edge flip (mocked size + viewport), arrow-key
 * nav with wraparound + disabled-skip, Escape/outside-click close, action select →
 * onSelect + onClose, the single submenu level (ArrowRight open / ArrowLeft close /
 * child select closes the whole menu, aria-expanded), and the non-focusable separator.
 *
 * jsdom has no layout, so `getBoundingClientRect` is stubbed on the menu element and
 * `window.innerWidth/innerHeight` are set per test to drive deterministic placement.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuItem } from "./types";

afterEach(cleanup);

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
}

beforeEach(() => {
  setViewport(1200, 800);
});

afterEach(() => {
  setViewport(originalInnerWidth, originalInnerHeight);
});

/**
 * Force the menu's measured rect so flip/clamp math is deterministic. jsdom returns a
 * zero-sized rect from `getBoundingClientRect`, so we stub it on the rendered menu via
 * the global HTMLElement prototype filtered to our test id.
 */
function stubMenuSize(width: number, height: number) {
  const proto = HTMLElement.prototype;
  const spy = vi.spyOn(proto, "getBoundingClientRect");
  spy.mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute("data-testid") === "context-menu") {
      return {
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return {
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
  return spy;
}

function basicItems(onSelect = vi.fn()): ContextMenuItem[] {
  return [
    { kind: "action", id: "open", label: "Open", icon: "eye", onSelect },
    { kind: "action", id: "copy", label: "Copy text", icon: "copy", onSelect },
    { kind: "action", id: "del", label: "Delete", icon: "trash", danger: true, onSelect },
  ];
}

describe("ContextMenu", () => {
  it("renders nothing when open is false", () => {
    render(
      <ContextMenu
        open={false}
        position={{ x: 10, y: 10 }}
        items={basicItems()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("context-menu")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders role=menu with one menuitem per action when open", () => {
    stubMenuSize(180, 120);
    render(
      <ContextMenu
        open
        position={{ x: 100, y: 100 }}
        items={basicItems()}
        onClose={vi.fn()}
        ariaLabel="Node actions"
      />,
    );
    const menu = screen.getByTestId("context-menu");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.getAttribute("aria-orientation")).toBe("vertical");
    expect(menu.getAttribute("aria-label")).toBe("Node actions");
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("positions at the supplied {x,y} when it fits", async () => {
    stubMenuSize(180, 120);
    render(
      <ContextMenu open position={{ x: 200, y: 150 }} items={basicItems()} onClose={vi.fn()} />,
    );
    const menu = screen.getByTestId("context-menu");
    await waitFor(() => {
      expect(menu.style.left).toBe("200px");
      expect(menu.style.top).toBe("150px");
    });
  });

  it("flips left and up when the menu would overflow the right/bottom edges", async () => {
    setViewport(400, 300);
    stubMenuSize(180, 120);
    // Anchor near the bottom-right corner so it must flip both axes.
    render(
      <ContextMenu open position={{ x: 380, y: 290 }} items={basicItems()} onClose={vi.fn()} />,
    );
    const menu = screen.getByTestId("context-menu");
    await waitFor(() => {
      // Flipped left: right edge at anchor → left = 380 - 180 = 200.
      expect(menu.style.left).toBe("200px");
      // Flipped up: bottom edge at anchor → top = 290 - 120 = 170.
      expect(menu.style.top).toBe("170px");
    });
  });

  it("clamps into the viewport margin when the anchor is hard against an edge", async () => {
    setViewport(400, 300);
    stubMenuSize(180, 120);
    render(<ContextMenu open position={{ x: 2, y: 2 }} items={basicItems()} onClose={vi.fn()} />);
    const menu = screen.getByTestId("context-menu");
    await waitFor(() => {
      // x=2 < margin(8) → clamped to 8.
      expect(menu.style.left).toBe("8px");
      expect(menu.style.top).toBe("8px");
    });
  });

  it("focuses the first enabled item on open", async () => {
    stubMenuSize(180, 120);
    render(
      <ContextMenu open position={{ x: 100, y: 100 }} items={basicItems()} onClose={vi.fn()} />,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("context-menu-item-open")),
    );
  });

  it("ArrowDown/ArrowUp cycle focus with wraparound", async () => {
    stubMenuSize(180, 120);
    render(
      <ContextMenu open position={{ x: 100, y: 100 }} items={basicItems()} onClose={vi.fn()} />,
    );
    const menu = screen.getByTestId("context-menu");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("context-menu-item-open")),
    );
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("context-menu-item-copy"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("context-menu-item-del"));
    // Wrap forward from the last item to the first.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("context-menu-item-open"));
    // Wrap backward from the first item to the last.
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("context-menu-item-del"));
  });

  it("skips disabled items in arrow nav and does not activate them", async () => {
    stubMenuSize(180, 120);
    const onSelect = vi.fn();
    const items: ContextMenuItem[] = [
      { kind: "action", id: "a", label: "A", onSelect },
      { kind: "action", id: "b", label: "B", disabled: true, onSelect },
      { kind: "action", id: "c", label: "C", onSelect },
    ];
    render(<ContextMenu open position={{ x: 100, y: 100 }} items={items} onClose={vi.fn()} />);
    const menu = screen.getByTestId("context-menu");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("context-menu-item-a")),
    );
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    // B is disabled → skipped → focus lands on C.
    expect(document.activeElement).toBe(screen.getByTestId("context-menu-item-c"));
    // The disabled button does nothing when clicked.
    fireEvent.click(screen.getByTestId("context-menu-item-b"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("Escape calls onClose", async () => {
    stubMenuSize(180, 120);
    const onClose = vi.fn();
    render(
      <ContextMenu open position={{ x: 100, y: 100 }} items={basicItems()} onClose={onClose} />,
    );
    const menu = await screen.findByTestId("context-menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the opener element on close", async () => {
    stubMenuSize(180, 120);
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
            opener
          </button>
          <ContextMenu
            open={open}
            position={{ x: 100, y: 100 }}
            items={basicItems()}
            onClose={() => setOpen(false)}
          />
        </div>
      );
    }
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    render(<Harness />);
    const menu = await screen.findByTestId("context-menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it("outside mousedown calls onClose", async () => {
    stubMenuSize(180, 120);
    const onClose = vi.fn();
    render(
      <ContextMenu open position={{ x: 100, y: 100 }} items={basicItems()} onClose={onClose} />,
    );
    await screen.findByTestId("context-menu");
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clicking an action fires its onSelect and calls onClose", async () => {
    stubMenuSize(180, 120);
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const items: ContextMenuItem[] = [{ kind: "action", id: "open", label: "Open", onSelect }];
    render(<ContextMenu open position={{ x: 100, y: 100 }} items={items} onClose={onClose} />);
    await screen.findByTestId("context-menu");
    fireEvent.click(screen.getByTestId("context-menu-item-open"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders a non-focusable separator with role=separator", async () => {
    stubMenuSize(180, 120);
    const items: ContextMenuItem[] = [
      { kind: "action", id: "a", label: "A", onSelect: vi.fn() },
      { kind: "separator", id: "sep" },
      { kind: "action", id: "b", label: "B", onSelect: vi.fn() },
    ];
    render(<ContextMenu open position={{ x: 100, y: 100 }} items={items} onClose={vi.fn()} />);
    await screen.findByTestId("context-menu");
    const sep = screen.getByRole("separator");
    expect(sep.getAttribute("data-menu-action")).toBeNull();
    expect(sep.tagName).toBe("HR");
    // Arrow nav steps over the separator (only the two actions cycle).
    const menu = screen.getByTestId("context-menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("context-menu-item-b"));
  });

  describe("submenu", () => {
    function withSubmenu(childSelect = vi.fn()): ContextMenuItem[] {
      return [
        { kind: "action", id: "open", label: "Open", onSelect: vi.fn() },
        {
          kind: "submenu",
          id: "prio",
          label: "Set priority",
          items: [
            { kind: "action", id: "pa", label: "A", onSelect: childSelect },
            { kind: "action", id: "pb", label: "B", onSelect: childSelect },
          ],
        },
      ];
    }

    it("ArrowRight opens the child and aria-expanded reflects state", async () => {
      stubMenuSize(180, 120);
      render(
        <ContextMenu open position={{ x: 100, y: 100 }} items={withSubmenu()} onClose={vi.fn()} />,
      );
      const parent = await screen.findByTestId("context-menu-item-prio");
      expect(parent.getAttribute("aria-haspopup")).toBe("menu");
      expect(parent.getAttribute("aria-expanded")).toBe("false");
      parent.focus();
      fireEvent.keyDown(parent, { key: "ArrowRight" });
      await waitFor(() =>
        expect(screen.getByTestId("context-menu-item-prio").getAttribute("aria-expanded")).toBe(
          "true",
        ),
      );
      expect(screen.getByTestId("context-menu-sub-prio")).toBeInTheDocument();
    });

    it("hovering the parent opens the submenu", async () => {
      stubMenuSize(180, 120);
      render(
        <ContextMenu open position={{ x: 100, y: 100 }} items={withSubmenu()} onClose={vi.fn()} />,
      );
      const parent = await screen.findByTestId("context-menu-item-prio");
      fireEvent.mouseEnter(parent);
      await waitFor(() =>
        expect(screen.queryByTestId("context-menu-sub-prio")).toBeInTheDocument(),
      );
    });

    it("selecting a submenu child fires its onSelect and closes the whole menu", async () => {
      stubMenuSize(180, 120);
      const childSelect = vi.fn();
      const onClose = vi.fn();
      render(
        <ContextMenu
          open
          position={{ x: 100, y: 100 }}
          items={withSubmenu(childSelect)}
          onClose={onClose}
        />,
      );
      const parent = await screen.findByTestId("context-menu-item-prio");
      fireEvent.mouseEnter(parent);
      const childB = await screen.findByTestId("context-menu-item-pb");
      fireEvent.click(childB);
      expect(childSelect).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("ArrowLeft closes the submenu back to the parent", async () => {
      stubMenuSize(180, 120);
      render(
        <ContextMenu open position={{ x: 100, y: 100 }} items={withSubmenu()} onClose={vi.fn()} />,
      );
      const parent = await screen.findByTestId("context-menu-item-prio");
      fireEvent.mouseEnter(parent);
      await screen.findByTestId("context-menu-sub-prio");
      const menu = screen.getByTestId("context-menu");
      fireEvent.keyDown(menu, { key: "ArrowLeft" });
      await waitFor(() => expect(screen.queryByTestId("context-menu-sub-prio")).toBeNull());
      expect(document.activeElement).toBe(screen.getByTestId("context-menu-item-prio"));
    });

    it("Escape inside an open submenu closes only the submenu, not the whole menu", async () => {
      stubMenuSize(180, 120);
      const onClose = vi.fn();
      render(
        <ContextMenu open position={{ x: 100, y: 100 }} items={withSubmenu()} onClose={onClose} />,
      );
      const parent = await screen.findByTestId("context-menu-item-prio");
      fireEvent.mouseEnter(parent);
      await screen.findByTestId("context-menu-sub-prio");
      const menu = screen.getByTestId("context-menu");
      fireEvent.keyDown(menu, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("context-menu-sub-prio")).toBeNull());
      // The first Escape only closed the submenu — the menu stays open.
      expect(onClose).not.toHaveBeenCalled();
      // A second Escape closes the whole menu.
      fireEvent.keyDown(menu, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});

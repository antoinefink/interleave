/**
 * LineageDeleteMenu component test (T135 / U7).
 *
 * Covers the renderer seam of the descendant-aware delete intent surface: the leaf
 * fast path (no popover), the count-error fallthrough, the menu's quantified blast
 * radius + KTD5 action order + default focus, the keyboard contract (Esc/Enter), and
 * that the honorable alternative is typed by node kind (Mark processed for an extract,
 * Rest for a topic, neither for other types — setFate never runs on a non-extract).
 *
 * The IPC + undo live in `useLineageDelete` (tested via these wired actions); here the
 * menu is driven with stub action handlers + a stubbed `countDescendants`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  countDescendants: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: { countDescendants: h.countDescendants },
  };
});

import type { ElementsCountDescendantsResult } from "../../lib/appApi";
import { blastRadiusLabel, LineageDeleteMenu } from "./LineageDeleteMenu";
import type { LineageDeleteActions, LineageDeleteTarget } from "./useLineageDelete";

afterEach(cleanup);

function count(
  overrides: Partial<ElementsCountDescendantsResult> = {},
): ElementsCountDescendantsResult {
  return { extracts: 0, cards: 0, cardsWithHistory: 0, total: 0, ...overrides };
}

function stubActions(): LineageDeleteActions {
  return {
    quiet: vi.fn(),
    quietAfterCountError: vi.fn(),
    keepDescendants: vi.fn(),
    deleteBranch: vi.fn(),
    markProcessed: vi.fn(),
    restTopic: vi.fn(),
  };
}

const EXTRACT: LineageDeleteTarget = { id: "ext-1", type: "extract", title: "An extract" };
const TOPIC: LineageDeleteTarget = { id: "top-1", type: "topic", title: "A topic" };

beforeEach(() => {
  h.desktop = true;
  h.countDescendants.mockReset();
});

describe("blastRadiusLabel", () => {
  it("composes extracts + cards + with-history", () => {
    expect(blastRadiusLabel(count({ extracts: 1, cards: 2, cardsWithHistory: 1, total: 3 }))).toBe(
      "1 extract, 2 cards (1 with review history)",
    );
  });
  it("omits the with-history clause when zero", () => {
    expect(blastRadiusLabel(count({ cards: 1, total: 1 }))).toBe("1 card");
  });
});

describe("LineageDeleteMenu", () => {
  it("leaf fast path: total 0 quietly deletes with no popover (Covers R4)", async () => {
    const actions = stubActions();
    h.countDescendants.mockResolvedValue(count({ total: 0 }));
    render(<LineageDeleteMenu target={EXTRACT} actions={actions} />);

    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));

    await waitFor(() => expect(actions.quiet).toHaveBeenCalledWith(EXTRACT));
    expect(screen.queryByTestId("lineage-delete-pop")).toBeNull();
  });

  it("count-error fallthrough: deletes safely + surfaces the error, no popover", async () => {
    const actions = stubActions();
    h.countDescendants.mockRejectedValue(new Error("boom"));
    render(<LineageDeleteMenu target={EXTRACT} actions={actions} />);

    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));

    await waitFor(() => expect(actions.quietAfterCountError).toHaveBeenCalledWith(EXTRACT, "boom"));
    expect(screen.queryByTestId("lineage-delete-pop")).toBeNull();
    expect(actions.quiet).not.toHaveBeenCalled();
  });

  it("opens the menu with blast radius, KTD5 order, and focus on Keep descendants (Covers R5)", async () => {
    const actions = stubActions();
    h.countDescendants.mockResolvedValue(
      count({ extracts: 1, cards: 1, cardsWithHistory: 1, total: 2 }),
    );
    render(<LineageDeleteMenu target={EXTRACT} actions={actions} />);

    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));

    const pop = await screen.findByTestId("lineage-delete-pop");
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(pop.getAttribute("aria-modal")).toBe("false");
    expect(screen.getByTestId("lineage-delete-radius").textContent).toContain(
      "1 extract, 1 card (1 with review history)",
    );

    // KTD5 order: Mark processed → Keep descendants → Delete branch → Cancel.
    const order = Array.from(pop.querySelectorAll("[data-menu-action]")).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(order).toEqual([
      "lineage-delete-mark-done",
      "lineage-delete-keep",
      "lineage-delete-branch",
      "lineage-delete-cancel",
    ]);

    // Default focus is the SAFE action (Keep descendants).
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("lineage-delete-keep")),
    );
  });

  // Regression: the popover hovers below an action bar near the bottom of a clipped flex
  // column; a plain focus() on open scrolls the underlying content up to reveal the button.
  // Focus on open must pass `{ preventScroll: true }`. Same root cause as DoneIntentMenu.
  it("focuses the safe default without scrolling the underlying content", async () => {
    const actions = stubActions();
    h.countDescendants.mockResolvedValue(count({ cards: 1, total: 1 }));
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    render(<LineageDeleteMenu target={EXTRACT} actions={actions} />);

    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));
    const keep = await screen.findByTestId("lineage-delete-keep");
    await waitFor(() => expect(document.activeElement).toBe(keep));

    // Bind the assertion to the Keep descendants button specifically (see DoneIntentMenu test):
    // SOME focus() call whose `this` is that button passed `{ preventScroll: true }`.
    const defaultFocusedWithoutScroll = focusSpy.mock.instances.some(
      (el, i) =>
        el === keep &&
        (focusSpy.mock.calls[i]?.[0] as FocusOptions | undefined)?.preventScroll === true,
    );
    expect(defaultFocusedWithoutScroll).toBe(true);
    focusSpy.mockRestore();
  });

  it("offers Mark processed for an extract and routes it (Covers R6)", async () => {
    const actions = stubActions();
    h.countDescendants.mockResolvedValue(count({ cards: 1, total: 1 }));
    render(<LineageDeleteMenu target={EXTRACT} actions={actions} />);

    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));
    await screen.findByTestId("lineage-delete-pop");
    expect(screen.queryByTestId("lineage-delete-rest")).toBeNull();
    fireEvent.click(screen.getByTestId("lineage-delete-mark-done"));

    expect(actions.markProcessed).toHaveBeenCalledWith(EXTRACT);
    expect(actions.restTopic).not.toHaveBeenCalled();
  });

  it("offers Rest for a topic and NEVER offers mark-done (setFate is never called) (Covers R6)", async () => {
    const actions = stubActions();
    h.countDescendants.mockResolvedValue(count({ extracts: 2, total: 2 }));
    render(<LineageDeleteMenu target={TOPIC} actions={actions} />);

    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));
    await screen.findByTestId("lineage-delete-pop");
    expect(screen.queryByTestId("lineage-delete-mark-done")).toBeNull();
    fireEvent.click(screen.getByTestId("lineage-delete-rest"));

    expect(actions.restTopic).toHaveBeenCalledWith(TOPIC);
    expect(actions.markProcessed).not.toHaveBeenCalled();
  });

  it("offers NEITHER honorable action for a non-extract/non-topic (e.g. source)", async () => {
    const actions = stubActions();
    h.countDescendants.mockResolvedValue(count({ extracts: 1, total: 1 }));
    render(<LineageDeleteMenu target={{ id: "src-1", type: "source" }} actions={actions} />);

    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));
    await screen.findByTestId("lineage-delete-pop");
    expect(screen.queryByTestId("lineage-delete-mark-done")).toBeNull();
    expect(screen.queryByTestId("lineage-delete-rest")).toBeNull();
    // Keep + Branch + Cancel only.
    expect(screen.getByTestId("lineage-delete-keep")).toBeInTheDocument();
    expect(screen.getByTestId("lineage-delete-branch")).toBeInTheDocument();
  });

  it("routes Keep descendants to the controller with the count", async () => {
    const actions = stubActions();
    const c = count({ extracts: 1, cards: 1, total: 2 });
    h.countDescendants.mockResolvedValue(c);
    render(<LineageDeleteMenu target={EXTRACT} actions={actions} />);

    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));
    await screen.findByTestId("lineage-delete-pop");
    fireEvent.click(screen.getByTestId("lineage-delete-keep"));
    expect(actions.keepDescendants).toHaveBeenCalledWith(EXTRACT, c);
  });

  it("routes Delete branch to the controller (Covers R8/R10)", async () => {
    const actions = stubActions();
    const c = count({ extracts: 1, cards: 1, total: 2 });
    h.countDescendants.mockResolvedValue(c);
    render(<LineageDeleteMenu target={EXTRACT} actions={actions} />);

    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));
    await screen.findByTestId("lineage-delete-pop");
    fireEvent.click(screen.getByTestId("lineage-delete-branch"));
    // The branch action takes only the target — it derives the count from the IPC result.
    expect(actions.deleteBranch).toHaveBeenCalledWith(EXTRACT);
  });

  it("Enter activates the focused safe default (Keep descendants)", async () => {
    const actions = stubActions();
    h.countDescendants.mockResolvedValue(count({ cards: 1, total: 1 }));
    render(<LineageDeleteMenu target={EXTRACT} actions={actions} />);

    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));
    await screen.findByTestId("lineage-delete-pop");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("lineage-delete-keep")),
    );
    // Activating the focused button (Enter on a <button> fires click).
    fireEvent.click(document.activeElement as HTMLElement);
    expect(actions.keepDescendants).toHaveBeenCalledWith(EXTRACT, count({ cards: 1, total: 1 }));
  });

  it("Esc cancels and returns focus to the trigger without acting", async () => {
    const actions = stubActions();
    h.countDescendants.mockResolvedValue(count({ cards: 1, total: 1 }));
    render(<LineageDeleteMenu target={EXTRACT} actions={actions} />);

    const trigger = screen.getByTestId("lineage-delete-trigger");
    fireEvent.click(trigger);
    await screen.findByTestId("lineage-delete-pop");
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("lineage-delete-pop")).toBeNull());
    expect(actions.keepDescendants).not.toHaveBeenCalled();
    expect(actions.deleteBranch).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("arrows cycle the actions in document order", async () => {
    const actions = stubActions();
    h.countDescendants.mockResolvedValue(count({ cards: 1, total: 1 }));
    render(<LineageDeleteMenu target={EXTRACT} actions={actions} />);

    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));
    await screen.findByTestId("lineage-delete-pop");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("lineage-delete-keep")),
    );
    // From Keep (index 1) ArrowUp wraps to Mark processed (index 0).
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("lineage-delete-mark-done"));
    // ArrowDown back to Keep.
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("lineage-delete-keep"));
  });

  it("an external triggerSignal runs the same delete logic", async () => {
    const actions = stubActions();
    h.countDescendants.mockResolvedValue(count({ cards: 1, total: 1 }));
    const { rerender } = render(
      <LineageDeleteMenu target={EXTRACT} actions={actions} triggerSignal={0} />,
    );
    expect(h.countDescendants).not.toHaveBeenCalled();
    rerender(<LineageDeleteMenu target={EXTRACT} actions={actions} triggerSignal={1} />);
    await screen.findByTestId("lineage-delete-pop");
    expect(h.countDescendants).toHaveBeenCalledTimes(1);
  });

  it("disables the trigger when host is busy and does not fetch", () => {
    const actions = stubActions();
    h.countDescendants.mockResolvedValue(count({ cards: 1, total: 1 }));
    render(<LineageDeleteMenu target={EXTRACT} actions={actions} busy />);
    const trigger = screen.getByTestId("lineage-delete-trigger") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(h.countDescendants).not.toHaveBeenCalled();
  });

  it("drops a double-submit (routes the chosen action once)", async () => {
    const actions = stubActions();
    h.countDescendants.mockResolvedValue(count({ cards: 1, total: 1 }));
    render(<LineageDeleteMenu target={EXTRACT} actions={actions} />);

    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));
    await screen.findByTestId("lineage-delete-pop");
    const branch = screen.getByTestId("lineage-delete-branch");
    fireEvent.click(branch);
    fireEvent.click(branch);
    expect(actions.deleteBranch).toHaveBeenCalledTimes(1);
  });

  // Regression (real-app bug): the delete trigger did nothing in the running app
  // because `mountedRef` was initialised `true` and only ever set `false` on cleanup.
  // Under React StrictMode (active in apps/web/src/main.tsx), the dev-only
  // mount→unmount→remount cycle left `mountedRef.current === false` for the component's
  // whole life, so `handleTrigger` always bailed at `if (!mountedRef.current) return`
  // right after awaiting `countDescendants` — the delete never fired. RTL's plain
  // `render` does not apply StrictMode, so the rest of this suite could not catch it.
  describe("under StrictMode (regression: mountedRef must reset on remount)", () => {
    it("leaf fast path still quietly deletes after the StrictMode remount cycle", async () => {
      const actions = stubActions();
      h.countDescendants.mockResolvedValue(count({ total: 0 }));
      render(
        <StrictMode>
          <LineageDeleteMenu target={EXTRACT} actions={actions} />
        </StrictMode>,
      );

      fireEvent.click(screen.getByTestId("lineage-delete-trigger"));

      await waitFor(() => expect(actions.quiet).toHaveBeenCalledWith(EXTRACT));
    });

    it("still opens the intent popover for a non-leaf after the StrictMode remount cycle", async () => {
      const actions = stubActions();
      h.countDescendants.mockResolvedValue(count({ extracts: 1, total: 1 }));
      render(
        <StrictMode>
          <LineageDeleteMenu target={EXTRACT} actions={actions} />
        </StrictMode>,
      );

      fireEvent.click(screen.getByTestId("lineage-delete-trigger"));

      expect(await screen.findByTestId("lineage-delete-pop")).toBeInTheDocument();
    });

    it("count-error fallthrough still deletes after the StrictMode remount cycle", async () => {
      // The catch branch carries the same post-await mountedRef guard as the success
      // path — it was equally dead pre-fix. Confirms the whole guarded surface recovers.
      const actions = stubActions();
      h.countDescendants.mockRejectedValue(new Error("boom"));
      render(
        <StrictMode>
          <LineageDeleteMenu target={EXTRACT} actions={actions} />
        </StrictMode>,
      );

      fireEvent.click(screen.getByTestId("lineage-delete-trigger"));

      await waitFor(() =>
        expect(actions.quietAfterCountError).toHaveBeenCalledWith(EXTRACT, "boom"),
      );
    });
  });
});

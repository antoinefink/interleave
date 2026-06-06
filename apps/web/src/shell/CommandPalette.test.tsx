/**
 * Command palette tests (T048).
 *
 * The ⌘K palette gained ACTION entries (not just route navigation): an entry can
 * carry an `actionId` the shell runs (dispatching the SAME typed `window.appApi`
 * command as the on-screen button) and/or a `to` route. These tests assert:
 *
 *  - choosing an ACTION command runs its handler with the registry's `actionId`;
 *  - an action with a route navigates AND runs the action (e.g. "Start review");
 *  - context-scoped action commands ("Open source"/"Raise priority") are HIDDEN
 *    when nothing is selected and SHOWN when an element is selected (`when` gate);
 *  - a plain navigation command still navigates without an action.
 *
 * The palette is pure UI — handlers are mocked; the real `appApi` calls live in
 * the shell's `useGlobalActions` (tested where wired).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

function setup(hasSelection: boolean) {
  const onNavigate = vi.fn();
  const onAction = vi.fn();
  const onClose = vi.fn();
  render(
    <CommandPalette
      open
      onClose={onClose}
      onNavigate={onNavigate}
      onAction={onAction}
      hasSelection={hasSelection}
    />,
  );
  return { onNavigate, onAction, onClose };
}

/** Click the palette row whose visible label matches. */
function clickRow(label: string) {
  fireEvent.click(screen.getByText(label));
}

describe("CommandPalette — action entries (T048)", () => {
  it("runs the action handler with the registry actionId when chosen", () => {
    const { onAction } = setup(true);
    clickRow("Raise priority");
    expect(onAction).toHaveBeenCalledWith("raise-priority");
  });

  it("navigates AND runs the action for a routed action (Start review)", () => {
    vi.useFakeTimers();
    try {
      const { onNavigate, onAction } = setup(true);
      clickRow("Start review");
      expect(onNavigate).toHaveBeenCalledWith("/review");
      // A routed action is deferred one tick (so the route settles first).
      vi.runAllTimers();
      expect(onAction).toHaveBeenCalledWith("start-review");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides context-scoped actions when nothing is selected", () => {
    setup(false);
    expect(screen.queryByText("Open source")).toBeNull();
    expect(screen.queryByText("Open parent")).toBeNull();
    expect(screen.queryByText("Raise priority")).toBeNull();
    // Non-context actions stay available.
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByText("Start review")).toBeInTheDocument();
  });

  it("shows context-scoped actions when an element is selected", () => {
    setup(true);
    expect(screen.getByText("Open source")).toBeInTheDocument();
    expect(screen.getByText("Raise priority")).toBeInTheDocument();
  });

  it("a plain navigation command navigates with no action", () => {
    const { onNavigate, onAction } = setup(false);
    clickRow("Daily Queue");
    expect(onNavigate).toHaveBeenCalledWith("/queue");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("finds sidebar maintenance sections such as Trash by search query", () => {
    const { onNavigate, onAction } = setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "trash" } });

    expect(screen.getByText("Trash")).toBeInTheDocument();
    expect(screen.queryByText(/No commands match/)).toBeNull();
    clickRow("Trash");
    expect(onNavigate).toHaveBeenCalledWith("/trash");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("finds route-only sections by aliases and paths", () => {
    setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "retired" } });
    expect(screen.getByText("Retired cards")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "/process" } });
    expect(screen.getByText("Process queue")).toBeInTheDocument();
  });

  it("runs the action on Enter after filtering to it", () => {
    const { onAction } = setup(true);
    const input = screen.getByLabelText("Command palette search");
    // "Lower priority" is a unique label → it is the only/first filtered row, so
    // Enter selects + runs it.
    fireEvent.change(input, { target: { value: "Lower priority" } });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onAction).toHaveBeenCalledWith("lower-priority");
  });

  it("dispatches the shell-only event when a Help command is chosen", () => {
    const spy = vi.fn();
    window.addEventListener("interleave:open-help", spy);

    vi.useFakeTimers();
    try {
      setup(false);
      clickRow("Help: Open help center");

      expect(spy).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(spy).toHaveBeenCalledTimes(1);
      const dispatched = spy.mock.calls.at(0)?.[0];
      expect(dispatched).toBeInstanceOf(Event);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
      window.removeEventListener("interleave:open-help", spy);
    }
  });

  it("dispatches the tour event when the help tour command is chosen", () => {
    const spy = vi.fn();
    window.addEventListener("interleave:start-tour", spy);

    vi.useFakeTimers();
    try {
      setup(false);
      clickRow("Help: Take the tour");

      expect(spy).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.any(Event));
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
      window.removeEventListener("interleave:start-tour", spy);
    }
  });
});

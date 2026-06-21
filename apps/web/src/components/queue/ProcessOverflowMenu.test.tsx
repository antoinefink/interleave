/**
 * ProcessOverflowMenu component tests.
 *
 * The overflow collapses the infrequently-used Raise / Lower / Delete actions
 * behind a "⋯" trigger. The happy paths through the bar are covered by the
 * process-queue e2e; this asserts the interaction logic an Electron run would
 * otherwise be the only guard for:
 *  - the popover opens on the trigger and closes on Escape (restoring focus to
 *    the trigger) + outside-click;
 *  - Raise / Lower fire `onAction` with the right kind and close;
 *  - Delete fires `onDelete` (the host owns the descendant-aware confirm) and closes;
 *  - the trigger is disabled (and the menu cannot open) while busy;
 *  - the menu is keyboard-navigable: first item focused on open, Arrow roving;
 *  - the trigger advertises an ARIA menu (haspopup + expanded).
 *
 * Pure UI — `onAction` / `onDelete` are spies.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProcessOverflowMenu } from "./ProcessOverflowMenu";

describe("ProcessOverflowMenu", () => {
  it("opens the popover on the trigger and renders Raise / Lower / Delete", () => {
    render(<ProcessOverflowMenu onAction={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByTestId("process-overflow-pop")).toBeNull();

    const trigger = screen.getByTestId("process-action-more");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(screen.getByTestId("process-overflow-pop")).not.toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("process-action-raise")).not.toBeNull();
    expect(screen.getByTestId("process-action-lower")).not.toBeNull();
    expect(screen.getByTestId("process-action-delete")).not.toBeNull();
  });

  it("fires onAction('raise') / onAction('lower') and closes", () => {
    const onAction = vi.fn();
    render(<ProcessOverflowMenu onAction={onAction} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByTestId("process-action-more"));
    fireEvent.click(screen.getByTestId("process-action-raise"));
    expect(onAction).toHaveBeenCalledWith("raise");
    expect(screen.queryByTestId("process-overflow-pop")).toBeNull();

    fireEvent.click(screen.getByTestId("process-action-more"));
    fireEvent.click(screen.getByTestId("process-action-lower"));
    expect(onAction).toHaveBeenCalledWith("lower");
  });

  it("fires onDelete (the host owns the confirm) and closes", () => {
    const onDelete = vi.fn();
    render(<ProcessOverflowMenu onAction={vi.fn()} onDelete={onDelete} />);

    fireEvent.click(screen.getByTestId("process-action-more"));
    fireEvent.click(screen.getByTestId("process-action-delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("process-overflow-pop")).toBeNull();
  });

  it("focuses the first item on open and rolls focus with Arrow keys", () => {
    render(<ProcessOverflowMenu onAction={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByTestId("process-action-more"));

    expect(document.activeElement).toBe(screen.getByTestId("process-action-raise"));
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("process-action-lower"));
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("process-action-raise"));
    // Wrap-around: Up from the first item lands on the last (Delete).
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByTestId("process-action-delete"));
  });

  it("closes on Escape and restores focus to the trigger", () => {
    render(<ProcessOverflowMenu onAction={vi.fn()} onDelete={vi.fn()} />);
    const trigger = screen.getByTestId("process-action-more");
    fireEvent.click(trigger);
    expect(screen.getByTestId("process-overflow-pop")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("process-overflow-pop")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on an outside click", () => {
    render(
      <div>
        <ProcessOverflowMenu onAction={vi.fn()} onDelete={vi.fn()} />
        <button type="button" data-testid="outside">
          outside
        </button>
      </div>,
    );
    fireEvent.click(screen.getByTestId("process-action-more"));
    expect(screen.getByTestId("process-overflow-pop")).not.toBeNull();

    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByTestId("process-overflow-pop")).toBeNull();
  });

  it("disables the trigger while busy so the menu cannot open", () => {
    const onAction = vi.fn();
    render(<ProcessOverflowMenu busy onAction={onAction} onDelete={vi.fn()} />);
    const trigger = screen.getByTestId("process-action-more");
    expect(trigger).toBeDisabled();

    fireEvent.click(trigger);
    expect(screen.queryByTestId("process-overflow-pop")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });
});

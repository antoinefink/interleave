/**
 * ScheduleMenu component tests (T028/T030).
 *
 * The happy "Next week" preset path is covered end-to-end by the queue e2e; this
 * asserts the edge-prone interaction logic that an Electron run would otherwise be
 * the only guard for:
 *  - the popover opens on the trigger and closes on Escape + outside-click;
 *  - the manual-date apply is disabled until a date is picked, and anchors the
 *    picked calendar day to noon UTC (`<date>T12:00:00.000Z`) so it is timezone
 *    stable (the main process re-normalizes to canonical ISO);
 *  - the trigger is disabled (and the menu cannot open) while a row action is busy;
 *  - the presets fire `onSchedule({ kind })`.
 *
 * Pure UI — no IPC. The single `onSchedule` callback is a spy.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScheduleMenu } from "./ScheduleMenu";

describe("ScheduleMenu", () => {
  it("opens the popover when the trigger is clicked and renders the presets + manual picker", () => {
    render(<ScheduleMenu onSchedule={vi.fn()} />);
    expect(screen.queryByTestId("schedule-menu-pop")).toBeNull();

    const trigger = screen.getByTestId("schedule-menu-trigger");
    expect(trigger).toHaveClass("schedmenu__trigger");

    fireEvent.click(trigger);
    expect(screen.getByTestId("schedule-menu-pop")).not.toBeNull();
    expect(screen.getByTestId("schedule-tomorrow")).not.toBeNull();
    expect(screen.getByTestId("schedule-nextWeek")).not.toBeNull();
    expect(screen.getByTestId("schedule-nextMonth")).not.toBeNull();
    expect(screen.getByTestId("schedule-manual-date")).not.toBeNull();
  });

  it("fires onSchedule with a preset kind and closes the popover", () => {
    const onSchedule = vi.fn();
    render(<ScheduleMenu onSchedule={onSchedule} />);
    fireEvent.click(screen.getByTestId("schedule-menu-trigger"));

    fireEvent.click(screen.getByTestId("schedule-nextWeek"));
    expect(onSchedule).toHaveBeenCalledWith({ kind: "nextWeek" });
    // Picking a choice closes the popover.
    expect(screen.queryByTestId("schedule-menu-pop")).toBeNull();
  });

  it("supports a labeled custom trigger and opens from an external signal", () => {
    const { rerender } = render(
      <ScheduleMenu
        onSchedule={vi.fn()}
        openSignal={0}
        triggerClassName="pq-btn"
        triggerIcon="postpone"
        triggerLabel="Postpone"
        triggerTestId="process-action-postpone"
        tooltipLabel="Postpone"
        ariaLabel="Postpone until later"
      />,
    );

    const trigger = screen.getByTestId("process-action-postpone");
    expect(trigger).toHaveClass("pq-btn");
    expect(trigger).toHaveTextContent("Postpone");
    expect(trigger).toHaveAttribute("aria-label", "Postpone until later");
    expect(screen.queryByTestId("schedule-menu-pop")).toBeNull();

    rerender(
      <ScheduleMenu
        onSchedule={vi.fn()}
        openSignal={1}
        triggerClassName="pq-btn"
        triggerIcon="postpone"
        triggerLabel="Postpone"
        triggerTestId="process-action-postpone"
        tooltipLabel="Postpone"
        ariaLabel="Postpone until later"
      />,
    );
    expect(screen.getByTestId("schedule-menu-pop")).toBeInTheDocument();
  });

  it("closes the popover on Escape", () => {
    render(<ScheduleMenu onSchedule={vi.fn()} />);
    fireEvent.click(screen.getByTestId("schedule-menu-trigger"));
    expect(screen.getByTestId("schedule-menu-pop")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("schedule-menu-pop")).toBeNull();
  });

  it("closes the popover on an outside click", () => {
    render(
      <div>
        <ScheduleMenu onSchedule={vi.fn()} />
        <button type="button" data-testid="outside">
          outside
        </button>
      </div>,
    );
    fireEvent.click(screen.getByTestId("schedule-menu-trigger"));
    expect(screen.getByTestId("schedule-menu-pop")).not.toBeNull();

    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByTestId("schedule-menu-pop")).toBeNull();
  });

  it("keeps the manual apply disabled until a date is picked", () => {
    render(<ScheduleMenu onSchedule={vi.fn()} />);
    fireEvent.click(screen.getByTestId("schedule-menu-trigger"));

    const apply = screen.getByTestId("schedule-manual-apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("schedule-manual-date"), {
      target: { value: "2026-06-15" },
    });
    expect(apply.disabled).toBe(false);
  });

  it("anchors the manual date to noon UTC when applied (timezone-stable)", () => {
    const onSchedule = vi.fn();
    render(<ScheduleMenu onSchedule={onSchedule} />);
    fireEvent.click(screen.getByTestId("schedule-menu-trigger"));

    fireEvent.change(screen.getByTestId("schedule-manual-date"), {
      target: { value: "2026-06-15" },
    });
    fireEvent.click(screen.getByTestId("schedule-manual-apply"));

    expect(onSchedule).toHaveBeenCalledWith({
      kind: "manual",
      date: "2026-06-15T12:00:00.000Z",
    });
  });

  it("disables the trigger and cannot open while busy", () => {
    render(<ScheduleMenu disabled onSchedule={vi.fn()} />);
    const trigger = screen.getByTestId("schedule-menu-trigger") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);

    fireEvent.click(trigger);
    expect(screen.queryByTestId("schedule-menu-pop")).toBeNull();
  });
});

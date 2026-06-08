import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { QueueItemSummary } from "../../lib/appApi";
import { actionFor, DueBadge, metaFor, titleFor } from "./queueRow";

function queueItem(overrides: Partial<QueueItemSummary>): QueueItemSummary {
  return {
    id: "q-1",
    type: "source",
    status: "active",
    stage: "raw_source",
    priority: 2,
    title: "A source",
    dueAt: "2026-06-03T09:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {},
    sourceTitle: null,
    author: null,
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    cardType: null,
    linkedElementId: null,
    linkedElementType: null,
    protected: false,
    due: "today",
    dueLabel: "Today",
    ...overrides,
  } as QueueItemSummary;
}

describe("queue row helpers", () => {
  it("prefixes ambiguous row titles by element type", () => {
    expect(titleFor(queueItem({ type: "card", cardType: "qa", title: "What is FSRS?" }))).toBe(
      "Q&A · What is FSRS?",
    );
    expect(
      titleFor(queueItem({ type: "card", cardType: "cloze", title: "Capital: {{c1::Paris}}" })),
    ).toBe("Cloze · Capital: […]");
    expect(titleFor(queueItem({ type: "extract", title: "Useful fragment" }))).toBe(
      "Extract · Useful fragment",
    );
    expect(titleFor(queueItem({ type: "topic", title: "Scheduling" }))).toBe("Topic · Scheduling");
    expect(titleFor(queueItem({ type: "source", title: "Article title" }))).toBe("Article title");
  });

  it("returns type-specific open actions", () => {
    expect(actionFor(queueItem({ type: "card" }))).toEqual({ icon: "brain", label: "Review" });
    expect(actionFor(queueItem({ type: "source" }))).toEqual({
      icon: "eye",
      label: "Continue reading from read point",
    });
    expect(actionFor(queueItem({ type: "extract" }))).toEqual({
      icon: "extract",
      label: "Process",
    });
    expect(actionFor(queueItem({ type: "task", linkedElementId: "card-1" }))).toEqual({
      icon: "eye",
      label: "Verify",
    });
    expect(actionFor(queueItem({ type: "task", linkedElementId: null }))).toEqual({
      icon: "return",
      label: "Open",
    });
  });

  it("renders metadata for rows with useful context", () => {
    const { rerender, getByText } = render(metaFor(queueItem({ type: "source", author: "Ada" })));
    expect(getByText("Ada")).toBeInTheDocument();

    rerender(metaFor(queueItem({ type: "card", sourceTitle: "Original source" })));
    expect(getByText("Original source")).toBeInTheDocument();

    rerender(metaFor(queueItem({ type: "topic" })));
    expect(getByText("Topic")).toBeInTheDocument();

    rerender(metaFor(queueItem({ type: "synthesis_note" })));
    expect(getByText("Synthesis note")).toBeInTheDocument();

    rerender(metaFor(queueItem({ type: "task" })));
    expect(getByText("Task")).toBeInTheDocument();

    rerender(
      metaFor(queueItem({ type: "task", linkedElementId: "card-1", linkedElementType: "card" })),
    );
    expect(getByText("Protects card")).toBeInTheDocument();
  });

  it("maps due state to the stable badge classes", () => {
    const { rerender, getByTestId } = render(
      <DueBadge item={queueItem({ due: "overdue", dueLabel: "2d overdue" })} />,
    );
    expect(getByTestId("queue-due-badge")).toHaveClass("badge--overdue");
    expect(getByTestId("queue-due-badge")).toHaveTextContent("2d overdue");

    rerender(<DueBadge item={queueItem({ due: "today", dueLabel: "Today" })} />);
    expect(getByTestId("queue-due-badge")).toHaveClass("badge--due");

    rerender(<DueBadge item={queueItem({ due: "soon", dueLabel: "Tomorrow" })} />);
    expect(getByTestId("queue-due-badge")).toHaveClass("badge--soft");
  });
});

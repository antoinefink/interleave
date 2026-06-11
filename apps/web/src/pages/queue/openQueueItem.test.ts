import { describe, expect, it, vi } from "vitest";
import type { QueueItemSummary } from "../../lib/appApi";
import { openQueueItem } from "./openQueueItem";

function queueItem(overrides: Partial<QueueItemSummary>): QueueItemSummary {
  return {
    id: "item-1",
    type: "source",
    status: "active",
    stage: "raw_source",
    priority: 0.5,
    title: "A source",
    dueAt: "2026-06-03T09:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {
      kind: "attention",
      retrievability: null,
      stability: null,
      fsrsState: null,
      lapses: null,
      stage: "raw_source",
      postponed: 0,
      retirementSuggestion: null,
    },
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
    dueLabel: "Due today",
    queueEligible: true,
    notInQueueReason: null,
    ...overrides,
  };
}

function harness() {
  return {
    navigate: vi.fn(),
    select: vi.fn(),
  };
}

describe("openQueueItem", () => {
  it("routes normal queue items to their work surfaces", () => {
    const h = harness();
    openQueueItem({ item: queueItem({ type: "source", id: "source-1" }), ...h });
    expect(h.select).toHaveBeenCalledWith("source-1");
    expect(h.navigate).toHaveBeenLastCalledWith({
      to: "/source/$id",
      params: { id: "source-1" },
    });

    openQueueItem({ item: queueItem({ type: "extract", id: "extract-1" }), ...h });
    expect(h.select).toHaveBeenCalledWith("extract-1");
    expect(h.navigate).toHaveBeenLastCalledWith({
      to: "/extract/$id",
      params: { id: "extract-1" },
    });

    openQueueItem({ item: queueItem({ type: "card", id: "card-1" }), ...h });
    expect(h.select).toHaveBeenCalledWith(null);
    expect(h.navigate).toHaveBeenLastCalledWith({
      to: "/card/$id",
      params: { id: "card-1" },
    });

    openQueueItem({ item: queueItem({ type: "topic", id: "topic-1" }), ...h });
    expect(h.select).toHaveBeenCalledWith("topic-1");
    expect(h.navigate).toHaveBeenLastCalledWith({ to: "/process", search: {} });
  });

  it("opens linked verification tasks at the protected element", () => {
    const h = harness();

    openQueueItem({
      item: queueItem({
        type: "task",
        id: "task-source",
        linkedElementId: "source-1",
        linkedElementType: "source",
      }),
      ...h,
    });
    expect(h.select).toHaveBeenLastCalledWith("source-1");
    expect(h.navigate).toHaveBeenLastCalledWith({
      to: "/source/$id",
      params: { id: "source-1" },
    });

    openQueueItem({
      item: queueItem({
        type: "task",
        id: "task-extract",
        linkedElementId: "extract-1",
        linkedElementType: "extract",
      }),
      ...h,
    });
    expect(h.select).toHaveBeenLastCalledWith("extract-1");
    expect(h.navigate).toHaveBeenLastCalledWith({
      to: "/extract/$id",
      params: { id: "extract-1" },
    });

    openQueueItem({
      item: queueItem({
        type: "task",
        id: "task-card",
        linkedElementId: "card-1",
        linkedElementType: "card",
      }),
      asOf: "2026-06-06T12:00:00.000Z",
      ...h,
    });
    expect(h.select).toHaveBeenLastCalledWith(null);
    expect(h.navigate).toHaveBeenLastCalledWith({
      to: "/card/$id",
      params: { id: "card-1" },
    });
  });

  it("keeps unlinked tasks in the process loop", () => {
    const h = harness();
    openQueueItem({
      item: queueItem({ type: "task", id: "task-1" }),
      asOf: "2026-06-06T12:00:00.000Z",
      ...h,
    });

    expect(h.select).toHaveBeenCalledWith("task-1");
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/process",
      search: { asOf: "2026-06-06T12:00:00.000Z" },
    });
  });
});

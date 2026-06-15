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
      scheduleReason: null,
      retirementSuggestion: null,
      needsReverify: false,
    },
    sourceTitle: null,
    author: null,
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    cardType: null,
    taskType: null,
    linkedElementId: null,
    linkedElementType: null,
    linkedSourceId: null,
    protected: false,
    due: "today",
    dueLabel: "Due today",
    queueEligible: true,
    notInQueueReason: null,
    fallowState: null,
    fallowUntil: null,
    fallowReason: null,
    fallowTopicId: null,
    extractAging: null,
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

  it("opens weekly review tasks in the weekly session", () => {
    const h = harness();
    openQueueItem({
      item: queueItem({ type: "task", taskType: "weekly_review" as const, id: "weekly-1" }),
      asOf: "2026-06-06T12:00:00.000Z",
      ...h,
    });

    expect(h.select).toHaveBeenCalledWith("weekly-1");
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/weekly",
      search: { asOf: "2026-06-06T12:00:00.000Z" },
    });
  });

  it("routes a re-read task to the SOURCE reader at the region, not the extract view", () => {
    const h = harness();
    openQueueItem({
      item: queueItem({
        type: "task",
        taskType: "reread_region",
        id: "reread-1",
        // The task links the ancestor EXTRACT, but routing uses the owning source.
        linkedElementId: "extract-9",
        linkedElementType: "extract",
        linkedSourceId: "source-9",
      }),
      ...h,
    });

    expect(h.select).toHaveBeenLastCalledWith("source-9");
    expect(h.navigate).toHaveBeenLastCalledWith({
      to: "/source/$id",
      params: { id: "source-9" },
      search: { reread: "reread-1", n: expect.any(Number) },
    });
  });

  it("falls back to the generic linked-task surface when a re-read has no owning source", () => {
    const h = harness();
    openQueueItem({
      item: queueItem({
        type: "task",
        taskType: "reread_region",
        id: "reread-2",
        linkedElementId: "extract-7",
        linkedElementType: "extract",
        linkedSourceId: null,
      }),
      ...h,
    });

    // Degrades to the extract surface rather than a broken `/source/$id` with no id.
    expect(h.navigate).toHaveBeenLastCalledWith({
      to: "/extract/$id",
      params: { id: "extract-7" },
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

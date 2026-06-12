import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItemSummary, QueueSessionPlanResult } from "../../lib/appApi";
import { SessionAssemblyPreview } from "./SessionAssemblyPreview";
import { clearAcceptedSessionAssembly } from "./sessionAssemblyState";

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  previewSessionPlan: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));

vi.mock("../../lib/appApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/appApi")>();
  return {
    ...actual,
    appApi: {
      ...actual.appApi,
      previewSessionPlan: h.previewSessionPlan,
    },
  };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function item(id: string, title: string): QueueItemSummary {
  return {
    id,
    type: "card",
    status: "scheduled",
    stage: "active_card",
    priority: 0.9,
    title,
    dueAt: "2026-06-12T12:00:00.000Z",
    scheduler: "fsrs",
    schedulerSignals: {
      kind: "fsrs",
      retrievability: 0.8,
      stability: 5,
      fsrsState: "review",
      lapses: 0,
      stage: "active_card",
      postponed: 0,
      scheduleReason: null,
      retirementSuggestion: null,
    },
    sourceTitle: null,
    author: null,
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    cardType: "qa",
    taskType: null,
    linkedElementId: null,
    linkedElementType: null,
    protected: true,
    due: "today",
    dueLabel: "Due today",
    queueEligible: true,
    notInQueueReason: null,
    fallowState: null,
    fallowUntil: null,
    fallowReason: null,
    fallowTopicId: null,
  };
}

function plan(targetMinutes: number, row: QueueItemSummary): QueueSessionPlanResult {
  return {
    targetMinutes,
    plannedMinutes: 2,
    candidateMinutes: 2,
    plannedCount: 1,
    candidateCount: 1,
    overTarget: false,
    confidence: "learned",
    usesDefaultEstimate: false,
    items: [
      {
        item: row,
        estimatedMinutes: 2,
        estimateConfidence: "learned",
        estimateBasis: "test",
      },
    ],
    cut: {
      totalCount: 0,
      totalMinutes: 0,
      detailLimit: 25,
      items: [],
      byReason: { did_not_fit: { count: 0, minutes: 0 } },
      byType: {},
    },
  };
}

describe("SessionAssemblyPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAcceptedSessionAssembly();
  });

  it("does not enable start from a stale preview response", async () => {
    const first = deferred<QueueSessionPlanResult>();
    const second = deferred<QueueSessionPlanResult>();
    h.previewSessionPlan.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    render(
      <SessionAssemblyPreview
        open
        origin="queue"
        defaultTargetMinutes={25}
        request={{ mode: "full" }}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => expect(h.previewSessionPlan).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId("session-target-minutes"), {
      target: { value: "15" },
    });
    await waitFor(() => expect(h.previewSessionPlan).toHaveBeenCalledTimes(2));

    await act(async () => {
      first.resolve(plan(25, item("old", "Old plan")));
      await first.promise;
    });
    await waitFor(() => expect(screen.getByTestId("session-preview-start")).toBeDisabled());
    expect(screen.queryByText("Old plan")).not.toBeInTheDocument();

    await act(async () => {
      second.resolve(plan(15, item("new", "New plan")));
      await second.promise;
    });
    await screen.findByText("New plan");
    expect(screen.getByTestId("session-preview-start")).toBeEnabled();

    fireEvent.click(screen.getByTestId("session-preview-start"));
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/process",
      search: { assembled: 1 },
    });
  });
});

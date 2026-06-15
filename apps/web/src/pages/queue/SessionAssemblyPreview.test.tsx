import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  QueueItemSummary,
  QueueQuotaComposition,
  QueueSessionPlanRequest,
  QueueSessionPlanResult,
} from "../../lib/appApi";
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
      needsReverify: false,
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
    extractAging: null,
  };
}

function plan(
  targetMinutes: number,
  row: QueueItemSummary,
  composition: QueueQuotaComposition = {
    status: "active",
    quotaFloorMinutes: 4,
    eligibleDistillationMinutes: 6,
    selectedDistillationMinutes: 6,
    returnedQuotaMinutes: 0,
    cardMinutes: 2,
    distillationMinutes: 6,
    otherMinutes: 0,
  },
): QueueSessionPlanResult {
  return {
    targetMinutes,
    plannedMinutes: 2,
    candidateMinutes: 2,
    plannedCount: 1,
    candidateCount: 1,
    overTarget: false,
    confidence: "learned",
    usesDefaultEstimate: false,
    composition,
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
    // Non-preset target values (30, 20) keep the two main loads we care about
    // unambiguous from the best-effort preset previews (15/25/45), which the
    // split layout fires on open to populate each preset card's consequence.
    const first = deferred<QueueSessionPlanResult>();
    const second = deferred<QueueSessionPlanResult>();
    h.previewSessionPlan.mockImplementation((req: QueueSessionPlanRequest) => {
      if (req.targetMinutes === 30) return first.promise;
      if (req.targetMinutes === 20) return second.promise;
      return Promise.resolve(plan(req.targetMinutes, item(`p${req.targetMinutes}`, "Preset row")));
    });

    render(
      <SessionAssemblyPreview
        open
        origin="queue"
        defaultTargetMinutes={30}
        request={{ mode: "full" }}
        onClose={() => undefined}
      />,
    );

    await waitFor(() =>
      expect(h.previewSessionPlan).toHaveBeenCalledWith(
        expect.objectContaining({ targetMinutes: 30 }),
      ),
    );
    fireEvent.change(screen.getByTestId("session-target-minutes"), {
      target: { value: "20" },
    });
    await waitFor(() =>
      expect(h.previewSessionPlan).toHaveBeenCalledWith(
        expect.objectContaining({ targetMinutes: 20 }),
      ),
    );

    await act(async () => {
      first.resolve(plan(30, item("old", "Old plan")));
      await first.promise;
    });
    await waitFor(() => expect(screen.getByTestId("session-preview-start")).toBeDisabled());
    expect(screen.queryByText("Old plan")).not.toBeInTheDocument();

    await act(async () => {
      second.resolve(plan(20, item("new", "New plan")));
      await second.promise;
    });
    await screen.findByText("New plan");
    expect(screen.getByTestId("session-composition")).toHaveTextContent(
      "Distillation floor active: 4 min reserved.",
    );
    expect(screen.getByTestId("session-composition")).toHaveTextContent(
      "Planned 6 min distillation, 2 min cards.",
    );
    expect(screen.getByTestId("session-preview-start")).toBeEnabled();

    fireEvent.click(screen.getByTestId("session-preview-start"));
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/process",
      search: { assembled: 1 },
    });
  });

  it("renders preset consequences, budget meter chips, and the floor note", async () => {
    h.previewSessionPlan.mockImplementation((req: QueueSessionPlanRequest) =>
      Promise.resolve(plan(req.targetMinutes, item("row", "Planned row"))),
    );

    render(
      <SessionAssemblyPreview
        open
        origin="home"
        defaultTargetMinutes={25}
        request={{ mode: "full" }}
        onClose={() => undefined}
      />,
    );

    await screen.findByText("Planned row");
    // plan() reports plannedMinutes:2; pct = round(2 / box * 100): 15→13, 25→8, 45→4.
    await waitFor(() => expect(screen.getByText(/13% full/)).toBeInTheDocument());
    expect(screen.getByText(/8% full/)).toBeInTheDocument();
    expect(screen.getByText(/4% full/)).toBeInTheDocument();
    // category chips from composition (distillation 6m, cards 2m; other 0 → no chip)
    expect(screen.getByText("6m")).toBeInTheDocument();
    expect(screen.getByText("2m")).toBeInTheDocument();
    // floor note + meter free-space readout
    expect(screen.getByText(/Distillation floor active.*4 min held/)).toBeInTheDocument();
    expect(screen.getByText(/min free|box full/)).toBeInTheDocument();
  });

  it("renders left-out rows with a didn't-fit tag", async () => {
    const base = plan(15, item("kept", "Kept row"));
    const withCut: QueueSessionPlanResult = {
      ...base,
      cut: {
        totalCount: 1,
        totalMinutes: 10,
        detailLimit: 25,
        items: [
          {
            item: item("cut", "Cut row"),
            estimatedMinutes: 10,
            estimateConfidence: "learned",
            estimateBasis: "test",
            reason: "did_not_fit",
          },
        ],
        byReason: { did_not_fit: { count: 1, minutes: 10 } },
        byType: {},
      },
    };
    h.previewSessionPlan.mockResolvedValue(withCut);

    render(
      <SessionAssemblyPreview
        open
        origin="queue"
        defaultTargetMinutes={15}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText("Cut row")).toBeInTheDocument();
    expect(screen.getByText(/Didn't fit/)).toBeInTheDocument();
    expect(screen.getByTestId("session-cut-count")).toHaveTextContent("Left out 1 item");
  });

  it("keeps the left-out summary visible when nothing is cut", async () => {
    h.previewSessionPlan.mockResolvedValue(plan(45, item("kept", "Everything fits")));

    render(
      <SessionAssemblyPreview
        open
        origin="queue"
        defaultTargetMinutes={45}
        onClose={() => undefined}
      />,
    );

    await screen.findByText("Everything fits");
    expect(screen.getByTestId("session-cut-list")).toBeVisible();
    expect(screen.getByTestId("session-cut-count")).toHaveTextContent("Left out 0 items");
  });

  it("renders returned quota copy", async () => {
    h.previewSessionPlan.mockResolvedValue(
      plan(15, item("returned", "Returned plan"), {
        status: "returned_empty_backlog",
        quotaFloorMinutes: 4,
        eligibleDistillationMinutes: 0,
        selectedDistillationMinutes: 0,
        returnedQuotaMinutes: 4,
        cardMinutes: 2,
        distillationMinutes: 0,
        otherMinutes: 0,
      }),
    );

    render(
      <SessionAssemblyPreview
        open
        origin="queue"
        defaultTargetMinutes={15}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByTestId("session-composition")).toHaveTextContent(
      "Distillation share returned: no due extracts.",
    );
    expect(screen.getByTestId("session-composition")).toHaveTextContent(
      "Planned 0 min distillation, 2 min cards.",
    );
  });

  it("renders filtered-out quota copy", async () => {
    h.previewSessionPlan.mockResolvedValue(
      plan(15, item("filtered", "Filtered plan"), {
        status: "inactive_filtered_out",
        quotaFloorMinutes: 4,
        eligibleDistillationMinutes: 0,
        selectedDistillationMinutes: 0,
        returnedQuotaMinutes: 0,
        cardMinutes: 2,
        distillationMinutes: 0,
        otherMinutes: 0,
      }),
    );

    render(
      <SessionAssemblyPreview
        open
        origin="queue"
        defaultTargetMinutes={15}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByTestId("session-composition")).toHaveTextContent(
      "Current filter: distillation quota inactive.",
    );
  });

  it("omits composition copy when estimates are unavailable", async () => {
    h.previewSessionPlan.mockResolvedValue(
      plan(15, item("unavailable", "Unavailable plan"), {
        status: "unavailable_no_time_estimate",
        quotaFloorMinutes: 0,
        eligibleDistillationMinutes: 0,
        selectedDistillationMinutes: 0,
        returnedQuotaMinutes: 0,
        cardMinutes: 0,
        distillationMinutes: 0,
        otherMinutes: 0,
      }),
    );

    render(
      <SessionAssemblyPreview
        open
        origin="queue"
        defaultTargetMinutes={15}
        onClose={() => undefined}
      />,
    );

    await screen.findByText("Unavailable plan");
    expect(screen.queryByTestId("session-composition")).not.toBeInTheDocument();
  });

  it("does not refetch preset previews when the parent re-renders with a value-equal request", async () => {
    h.previewSessionPlan.mockImplementation((req: QueueSessionPlanRequest) =>
      Promise.resolve(plan(req.targetMinutes, item("row", "Planned row"))),
    );

    const requestProp = { mode: "full" } as const;
    const { rerender } = render(
      <SessionAssemblyPreview
        open
        origin="home"
        defaultTargetMinutes={25}
        request={{ ...requestProp }}
        onClose={() => undefined}
      />,
    );

    await screen.findByText("Planned row");
    // targetMinutes 15 is a pure preset value (not the default box), so it
    // isolates the preset-preview effect from the main load.
    const preset15Calls = () =>
      h.previewSessionPlan.mock.calls.filter((c) => c[0]?.targetMinutes === 15).length;
    await waitFor(() => expect(preset15Calls()).toBe(1));

    // Re-render with a brand-new request object literal of identical content,
    // exactly as the inline-prop mount sites do on every parent render. The
    // preset previews must NOT refire — baseRequestKey is unchanged.
    rerender(
      <SessionAssemblyPreview
        open
        origin="home"
        defaultTargetMinutes={25}
        request={{ ...requestProp }}
        onClose={() => undefined}
      />,
    );
    expect(preset15Calls()).toBe(1);
  });

  it("surfaces an error when the session plan fails", async () => {
    h.previewSessionPlan.mockImplementation((req: QueueSessionPlanRequest) =>
      req.targetMinutes === 25
        ? Promise.reject(new Error("plan boom"))
        : Promise.resolve(plan(req.targetMinutes, item("p", "Preset"))),
    );

    render(
      <SessionAssemblyPreview
        open
        origin="home"
        defaultTargetMinutes={25}
        request={{ mode: "full" }}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByTestId("session-preview-error")).toHaveTextContent("plan boom");
    expect(screen.getByTestId("session-preview-start")).toBeDisabled();
  });
});

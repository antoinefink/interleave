import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElementSummary, InspectorData } from "../../lib/appApi";

const h = vi.hoisted(() => ({
  desktop: true,
  selectedId: null as string | null,
  select: vi.fn(),
  navigate: vi.fn(),
  navigateToLocation: vi.fn(),
  listInspectableElements: vi.fn(),
  listConcepts: vi.fn(),
  getInspectorData: vi.fn(),
  getLineage: vi.fn(),
  setElementPriority: vi.fn(),
  scheduleQueueItem: vi.fn(),
  semanticRelated: vi.fn(),
  listTasks: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  postponeTask: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));

vi.mock("../../reader/navigateToLocation", () => ({
  useNavigateToLocation: () => h.navigateToLocation,
}));

vi.mock("../../review/ReviewModeButton", () => ({
  ReviewModeButton: () => <button type="button" data-testid="review-mode-button" />,
}));

vi.mock("../../shell/selection", () => ({
  useSelection: () => ({ selectedId: h.selectedId, select: h.select }),
}));

vi.mock("../ConflictSection", () => ({
  ConflictSection: () => <div data-testid="conflict-section" />,
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      listInspectableElements: h.listInspectableElements,
      listConcepts: h.listConcepts,
      getInspectorData: h.getInspectorData,
      getLineage: h.getLineage,
      setElementPriority: h.setElementPriority,
      scheduleQueueItem: h.scheduleQueueItem,
      semanticRelated: h.semanticRelated,
      listTasks: h.listTasks,
      createTask: h.createTask,
      completeTask: h.completeTask,
      postponeTask: h.postponeTask,
      exportDocumentMarkdown: vi.fn(),
      addTag: vi.fn(),
      removeTag: vi.fn(),
      assignConcept: vi.fn(),
      unassignConcept: vi.fn(),
      createConcept: vi.fn(),
    },
  };
});

import { pushActiveScope } from "../../shell/activeScope";
import { Inspector, requestInspectorRefresh } from "./Inspector";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function element(id: string, title: string): ElementSummary {
  return {
    id,
    title,
    type: "topic",
    status: "active",
    stage: "rough_topic",
    priority: 0.5,
    dueAt: null,
  };
}

function topicData(title: string): InspectorData {
  return {
    element: element("topic-1", title),
    scheduler: {
      kind: "attention",
      retrievability: null,
      stability: null,
      difficulty: null,
      reps: null,
      lapses: null,
      fsrsState: null,
      stage: "rough_topic",
      postponed: 0,
      lastProcessedAt: null,
      yield: null,
    },
    parent: null,
    children: [],
    source: null,
    provenance: null,
    location: null,
    sourceRef: null,
    tags: [],
    concepts: [],
    review: null,
    lifetime: null,
  };
}

function extractDataWithCardChild(): InspectorData {
  const data = topicData("Linked extract");
  return {
    ...data,
    element: {
      ...element("ext-1", "Linked extract"),
      type: "extract",
      stage: "clean_extract",
    },
    children: [
      {
        id: "card-1",
        title: "Linked card",
        type: "card",
        stage: "active_card",
      },
    ],
  };
}

function extractDataWithSourceLineage(): InspectorData {
  const data = topicData("Linked extract");
  return {
    ...data,
    element: {
      ...element("ext-1", "Linked extract"),
      type: "extract",
      status: "scheduled",
      stage: "clean_extract",
      priority: 0.64,
      dueAt: "2026-06-10T12:00:00.000Z",
    },
    scheduler: {
      kind: "attention",
      retrievability: null,
      stability: null,
      difficulty: null,
      reps: null,
      lapses: null,
      fsrsState: null,
      stage: "clean_extract",
      postponed: 0,
      lastProcessedAt: new Date().toISOString(),
      yield: null,
    },
    source: {
      id: "src-1",
      title: "Source paper",
      type: "source",
      stage: "raw_source",
    },
    sourceRef: {
      sourceElementId: "src-1",
      sourceTitle: "Source paper",
      url: "https://example.test/source",
      author: "Ada",
      publishedAt: "2026-01-01T00:00:00.000Z",
      locationLabel: "¶ 3",
      snippet: "The selected source text.",
      sourceType: null,
      reliabilityTier: null,
      confidence: null,
      reliabilityNotes: null,
    },
    location: {
      label: "¶ 3",
      selectedText: "The selected source text.",
      page: null,
      region: null,
      clip: null,
      timestampMs: null,
      sourceElementId: "src-1",
      blockIds: ["block-1"],
      startOffset: 10,
      endOffset: 35,
    },
  };
}

function cardDataWithSourceContext(): InspectorData {
  const data = topicData("What is intelligence?");
  return {
    ...data,
    element: {
      ...element("card-1", "What is intelligence?"),
      type: "card",
      stage: "active_card",
    },
    scheduler: {
      kind: "fsrs",
      retrievability: 0.82,
      stability: 9,
      difficulty: 4,
      reps: 3,
      lapses: 0,
      fsrsState: "review",
      stage: "active_card",
      postponed: 0,
      lastProcessedAt: null,
      yield: null,
    },
    source: {
      id: "src-1",
      title: "Source paper",
      type: "source",
      stage: "raw_source",
    },
    sourceRef: {
      sourceElementId: "src-1",
      sourceTitle: "Source paper",
      url: "https://example.test/source",
      author: "Ada",
      publishedAt: "2026-01-01T00:00:00.000Z",
      locationLabel: "¶ 3",
      snippet: "Hidden source context",
      sourceType: null,
      reliabilityTier: null,
      confidence: null,
      reliabilityNotes: null,
    },
    location: {
      label: "¶ 3",
      selectedText: "Hidden source context",
      page: null,
      region: null,
      clip: null,
      timestampMs: null,
      sourceElementId: "src-1",
      blockIds: ["block-1"],
      startOffset: 0,
      endOffset: 5,
    },
    review: {
      dueAt: "2026-06-06T12:00:00.000Z",
      stability: 9,
      difficulty: 4,
      reps: 3,
      lapses: 0,
      fsrsState: "review",
      lastReviewedAt: null,
      logCount: 3,
      isRetired: false,
    },
  };
}

function sourceData(): InspectorData {
  const data = topicData("Wigner paper");
  return {
    ...data,
    element: {
      ...element("src-1", "Wigner paper"),
      type: "source",
      stage: "raw_source",
    },
    provenance: {
      elementId: "src-1",
      url: "https://www.maths.ed.ac.uk/~v1ranick/papers/wigner.pdf?download=1",
      canonicalUrl: "https://www.maths.ed.ac.uk/~v1ranick/papers/wigner.pdf",
      originalUrl: "https://www.maths.ed.ac.uk/~v1ranick/papers/wigner.pdf?utm_source=test",
      author: "Eugene Wigner",
      publishedAt: "1960-02-01T00:00:00.000Z",
      accessedAt: "2026-04-24T00:00:00.000Z",
      reasonAdded: null,
      sourceType: null,
      reliabilityTier: null,
      confidence: null,
      reliabilityNotes: null,
    },
  };
}

beforeEach(() => {
  h.desktop = true;
  h.selectedId = null;
  h.select.mockReset();
  h.navigate.mockReset();
  h.navigateToLocation.mockReset();
  h.listInspectableElements.mockReset();
  h.listInspectableElements.mockResolvedValue({ elements: [element("topic-1", "Topic one")] });
  h.listConcepts.mockReset();
  h.listConcepts.mockResolvedValue({ concepts: [] });
  h.getInspectorData.mockReset();
  h.getInspectorData.mockResolvedValue({ data: topicData("Topic one") });
  h.getLineage.mockReset();
  h.getLineage.mockResolvedValue({ lineage: { rootId: "topic-1", nodes: [] } });
  h.setElementPriority.mockReset();
  h.setElementPriority.mockResolvedValue({ element: null });
  h.scheduleQueueItem.mockReset();
  h.scheduleQueueItem.mockResolvedValue({
    item: null,
    dueAt: "2026-06-08T12:00:00.000Z",
    intervalDays: 1,
  });
  h.semanticRelated.mockReset();
  h.semanticRelated.mockResolvedValue({
    similar: [],
    duplicates: [],
    prerequisiteConcepts: [],
    siblingSources: [],
    semanticAvailable: true,
  });
  h.listTasks.mockReset();
  h.listTasks.mockResolvedValue({ tasks: [] });
  h.createTask.mockReset();
  h.createTask.mockResolvedValue({});
  h.completeTask.mockReset();
  h.completeTask.mockResolvedValue({});
  h.postponeTask.mockReset();
  h.postponeTask.mockResolvedValue({});
});

describe("Inspector", () => {
  it("renders the desktop-only placeholder outside the Electron bridge", () => {
    h.desktop = false;

    render(<Inspector />);

    expect(screen.getByTestId("inspector-desktop-only")).toBeInTheDocument();
    expect(h.listInspectableElements).not.toHaveBeenCalled();
  });

  it("loads the picker list and selects an element from it", async () => {
    render(<Inspector />);

    const item = await screen.findByTestId("element-picker-item");
    expect(item).toHaveTextContent("Topic one");

    fireEvent.click(item);
    expect(h.select).toHaveBeenCalledWith("topic-1");
  });

  it("re-fetches selected data when the inspector refresh event fires", async () => {
    h.selectedId = "topic-1";
    render(<Inspector />);

    await screen.findByText("Topic one");
    h.getInspectorData.mockClear();
    h.getInspectorData.mockResolvedValue({ data: topicData("Topic updated") });

    requestInspectorRefresh();

    await waitFor(() =>
      expect(screen.getByTestId("inspector-title")).toHaveTextContent("Topic updated"),
    );
    expect(h.getInspectorData).toHaveBeenCalledWith({ id: "topic-1" });
    expect(h.listInspectableElements).toHaveBeenCalledTimes(2);
  });

  it("renders source provenance URLs as clickable external links", async () => {
    h.selectedId = "src-1";
    h.getInspectorData.mockResolvedValue({ data: sourceData() });

    render(<Inspector />);

    const url = await screen.findByTestId("provenance-url");
    expect(url).toHaveAttribute(
      "href",
      "https://www.maths.ed.ac.uk/~v1ranick/papers/wigner.pdf?download=1",
    );
    expect(url).toHaveAttribute("target", "_blank");
    expect(url).toHaveClass("external-url-link");
    expect(screen.getByTestId("provenance-canonical-url")).toHaveAttribute(
      "href",
      "https://www.maths.ed.ac.uk/~v1ranick/papers/wigner.pdf",
    );
    expect(screen.getByTestId("provenance-original-url")).toHaveAttribute(
      "href",
      "https://www.maths.ed.ac.uk/~v1ranick/papers/wigner.pdf?utm_source=test",
    );
  });

  it("renders extract identity, properties, attention, and source lineage without duplicated facts", async () => {
    h.selectedId = "ext-1";
    h.getInspectorData.mockResolvedValue({ data: extractDataWithSourceLineage() });

    render(<Inspector />);

    await screen.findByTestId("inspector-content");

    expect(screen.getByTestId("inspector-state-line")).toHaveTextContent(
      "Extract · B · Scheduled · Clean extract",
    );
    const header = screen.getByTestId("inspector-state-line").closest(".insp-head");
    if (!(header instanceof HTMLElement)) throw new Error("Missing inspector header");
    expect(within(header).queryByTestId("scheduler-chip")).not.toBeInTheDocument();
    expect(header.querySelector(".badge")).toBeNull();
    expect(screen.getByTestId("meta-type")).toHaveTextContent("Extract");
    expect(screen.getByTestId("meta-priority")).toHaveTextContent("B · 0.640");
    expect(screen.getByText("Set priority")).toBeInTheDocument();
    expect(screen.getByTestId("meta-due")).toHaveTextContent("2026-06-10");
    const propertiesSection = screen.getByText("Properties").closest(".insp-sec");
    if (!(propertiesSection instanceof HTMLElement)) throw new Error("Missing Properties section");
    expect(within(propertiesSection).queryByText("Stage")).not.toBeInTheDocument();

    expect(screen.getByTestId("scheduler-section")).toHaveTextContent("Clean extract");
    expect(screen.getByTestId("attention-summary")).not.toHaveTextContent("Clean extract");
    expect(screen.getByTestId("attention-summary")).toHaveTextContent("Seen today");
    expect(screen.getByTestId("attention-summary")).toHaveTextContent("Postponed 0x");

    expect(screen.getByTestId("source-lineage-section")).toBeInTheDocument();
    expect(screen.queryByTestId("source-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("source-ref-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("location-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inspector-refblock-open-source")).not.toBeInTheDocument();
    expect(screen.getByTestId("source-lineage-section")).toHaveTextContent("Source paper");
    expect(screen.getByTestId("source-lineage-quote")).toHaveTextContent(
      "The selected source text.",
    );
    expect(screen.getByTestId("inspector-refblock-citation")).toHaveTextContent("Ada");
    expect(screen.getByTestId("inspector-refblock-url")).toHaveAttribute(
      "href",
      "https://example.test/source",
    );
    expect(screen.getAllByText("¶ 3")).toHaveLength(1);

    const jumpButtons = screen.getAllByRole("button", { name: /jump to source/i });
    expect(jumpButtons).toHaveLength(1);
    const jumpButton = jumpButtons[0] as HTMLElement;
    fireEvent.click(jumpButton);
    expect(h.navigateToLocation).toHaveBeenCalledWith({
      label: "¶ 3",
      selectedText: "The selected source text.",
      page: null,
      region: null,
      clip: null,
      timestampMs: null,
      sourceElementId: "src-1",
      blockIds: ["block-1"],
      startOffset: 10,
      endOffset: 35,
    });
  });

  it("schedules an attention item through the existing queue schedule bridge", async () => {
    h.selectedId = "ext-1";
    const initial = extractDataWithSourceLineage();
    const refreshed = {
      ...initial,
      element: {
        ...initial.element,
        dueAt: "2026-06-08T12:00:00.000Z",
      },
    };
    h.getInspectorData
      .mockResolvedValueOnce({ data: initial })
      .mockResolvedValueOnce({ data: refreshed });

    render(<Inspector />);

    const trigger = await screen.findByTestId("schedule-menu-trigger");
    h.getInspectorData.mockClear();
    h.getLineage.mockClear();
    h.listConcepts.mockClear();
    h.listInspectableElements.mockClear();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId("schedule-tomorrow"));

    await waitFor(() =>
      expect(h.scheduleQueueItem).toHaveBeenCalledWith({
        id: "ext-1",
        choice: { kind: "tomorrow" },
      }),
    );
    expect(h.getInspectorData).toHaveBeenCalledWith({ id: "ext-1" });
    expect(h.getInspectorData).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("meta-due")).toHaveTextContent("2026-06-08"));
    expect(h.getLineage).not.toHaveBeenCalled();
    expect(h.listConcepts).not.toHaveBeenCalled();
    expect(h.listInspectableElements).not.toHaveBeenCalled();
  });

  it("ignores stale schedule refreshes after the selection changes", async () => {
    h.selectedId = "ext-1";
    const schedule = deferred<{
      item: null;
      dueAt: string;
      intervalDays: number;
    }>();
    const staleRefresh = deferred<{ data: InspectorData }>();
    h.scheduleQueueItem.mockReturnValue(schedule.promise);
    h.getInspectorData
      .mockResolvedValueOnce({ data: extractDataWithSourceLineage() })
      .mockResolvedValueOnce({ data: topicData("New selection") })
      .mockReturnValueOnce(staleRefresh.promise);

    const view = render(<Inspector />);

    fireEvent.click(await screen.findByTestId("schedule-menu-trigger"));
    fireEvent.click(screen.getByTestId("schedule-tomorrow"));

    h.selectedId = "topic-1";
    view.rerender(<Inspector />);
    expect(await screen.findByText("New selection")).toBeInTheDocument();

    await act(async () => {
      schedule.resolve({
        item: null,
        dueAt: "2026-06-08T12:00:00.000Z",
        intervalDays: 1,
      });
      await schedule.promise;
    });
    await act(async () => {
      staleRefresh.resolve({
        data: {
          ...extractDataWithSourceLineage(),
          element: {
            ...extractDataWithSourceLineage().element,
            title: "Stale extract",
          },
        },
      });
      await staleRefresh.promise;
    });

    await waitFor(() => expect(screen.getByText("New selection")).toBeInTheDocument());
    expect(screen.queryByText("Stale extract")).not.toBeInTheDocument();
  });

  it("does not expose the attention schedule menu when an FSRS item has no review state", async () => {
    h.selectedId = "card-1";
    h.getInspectorData.mockResolvedValue({
      data: {
        ...cardDataWithSourceContext(),
        review: null,
      },
    });

    render(<Inspector />);

    expect(await screen.findByTestId("fsrs-review-missing")).toHaveTextContent(
      "Review state unavailable.",
    );
    expect(screen.queryByTestId("attention-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("schedule-menu-trigger")).not.toBeInTheDocument();
  });

  it("shows source lineage without an unanchored jump when no source block is available", async () => {
    h.selectedId = "ext-1";
    const data = extractDataWithSourceLineage();
    h.getInspectorData.mockResolvedValue({
      data: {
        ...data,
        location: {
          ...data.location,
          blockIds: [],
        },
      },
    });

    render(<Inspector />);

    await screen.findByTestId("source-lineage-section");
    expect(screen.getByTestId("source-lineage-quote")).toHaveTextContent(
      "The selected source text.",
    );
    expect(screen.queryByRole("button", { name: /jump to source/i })).not.toBeInTheDocument();
  });

  it("redacts card source context while the review scope owns reveal state", async () => {
    h.selectedId = "card-1";
    h.getInspectorData.mockResolvedValue({ data: cardDataWithSourceContext() });
    const release = pushActiveScope("review");
    try {
      render(<Inspector />);

      await screen.findByTestId("inspector-content");
      expect(screen.getByTestId("meta-type")).toHaveTextContent("Card");
      expect(screen.queryByTestId("source-section")).not.toBeInTheDocument();
      expect(screen.queryByTestId("source-ref-section")).not.toBeInTheDocument();
      expect(screen.queryByTestId("location-section")).not.toBeInTheDocument();
      expect(screen.queryByTestId("source-lineage-section")).not.toBeInTheDocument();
      expect(screen.queryByTestId("location-jump")).not.toBeInTheDocument();
      expect(screen.queryByText("Source paper")).not.toBeInTheDocument();
      expect(screen.queryByText("Hidden source context")).not.toBeInTheDocument();
      expect(screen.queryByText("Ada")).not.toBeInTheDocument();
      expect(screen.queryByText("¶ 3")).not.toBeInTheDocument();
      expect(screen.queryByTestId("inspector-refblock-url")).not.toBeInTheDocument();
      expect(screen.queryByTestId("parent-section")).not.toBeInTheDocument();
      expect(screen.queryByTestId("lineage-section")).not.toBeInTheDocument();
    } finally {
      release();
    }
  });

  it("opens card child lineage rows by clearing selection and navigating to card detail", async () => {
    h.selectedId = "ext-1";
    h.getInspectorData.mockResolvedValue({ data: extractDataWithCardChild() });

    render(<Inspector />);

    const row = await screen.findByTestId("lineage-row");
    fireEvent.click(row);

    expect(h.select).toHaveBeenCalledWith(null);
    expect(h.navigate).toHaveBeenCalledWith({ to: "/card/$id", params: { id: "card-1" } });
  });

  it("opens card lineage tree nodes by clearing selection and navigating to card detail", async () => {
    h.selectedId = "ext-1";
    h.getInspectorData.mockResolvedValue({ data: extractDataWithCardChild() });
    h.getLineage.mockResolvedValue({
      lineage: {
        elementId: "ext-1",
        rootId: "src-1",
        nodes: [
          {
            id: "src-1",
            title: "Source",
            type: "source",
            stage: "raw_source",
            depth: 0,
            meta: "source",
            active: false,
          },
          {
            id: "ext-1",
            title: "Linked extract",
            type: "extract",
            stage: "clean_extract",
            depth: 1,
            meta: "clean extract",
            active: true,
          },
          {
            id: "card-1",
            title: "Linked card",
            type: "card",
            stage: "active_card",
            depth: 2,
            meta: "active card",
            active: false,
          },
        ],
      },
    });

    render(<Inspector />);

    await screen.findByTestId("lineage-tree");
    const cardNode = screen
      .getAllByTestId("lineage-tree-node")
      .find((node) => node.getAttribute("data-element-id") === "card-1");
    expect(cardNode).toBeDefined();

    fireEvent.click(cardNode as HTMLElement);

    expect(h.select).toHaveBeenCalledWith(null);
    expect(h.navigate).toHaveBeenCalledWith({ to: "/card/$id", params: { id: "card-1" } });
  });
});

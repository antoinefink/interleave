import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElementSummary, InspectorData, TopicKnowledgeStateGetResult } from "../../lib/appApi";
import type { LibraryInspectorPanel } from "../../shell/libraryInspectorPanel";

const h = vi.hoisted(() => ({
  desktop: true,
  selectedId: null as string | null,
  // The inbox triage panel the inspector reads (null = no relocated triage section).
  triagePanel: null as import("../../shell/inboxTriagePanel").InboxTriagePanel | null,
  // The Library inspector panel the inspector reads (null = no relocated controls).
  libraryPanel: null as import("../../shell/libraryInspectorPanel").LibraryInspectorPanel | null,
  select: vi.fn(),
  navigate: vi.fn(),
  navigateToLocation: vi.fn(),
  listInspectableElements: vi.fn(),
  listConcepts: vi.fn(),
  getInspectorData: vi.fn(),
  getLineage: vi.fn(),
  setElementPriority: vi.fn(),
  scheduleQueueItem: vi.fn(),
  fallowTopic: vi.fn(),
  unfallowTopic: vi.fn(),
  getTopicKnowledgeState: vi.fn(),
  semanticRelated: vi.fn(),
  listTasks: vi.fn(),
  createTask: vi.fn(),
  completeTask: vi.fn(),
  postponeTask: vi.fn(),
  exportDocumentMarkdown: vi.fn(),
  exportAnki: vi.fn(),
  restoreFromTrash: vi.fn(),
  restoreAncestorChain: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));

vi.mock("../../reader/navigateToLocation", () => ({
  useNavigateToLocation: () => h.navigateToLocation,
}));

vi.mock("../../review/ReviewModeButton", () => ({
  ReviewModeButton: ({ label, testId }: { label?: (count: number) => string; testId?: string }) => (
    <button type="button" data-testid={testId ?? "review-mode-button"}>
      {label ? label(4) : "Review"}
    </button>
  ),
}));

vi.mock("../../shell/selection", () => ({
  useSelection: () => ({ selectedId: h.selectedId, select: h.select }),
}));

vi.mock("../../shell/inboxTriagePanel", () => ({
  useInboxTriagePanel: () => ({
    panel: h.triagePanel,
    setPanel: vi.fn(),
    registerSection: vi.fn(),
    registerReadNowButton: vi.fn(),
    sectionRef: { current: null },
    readNowRef: { current: null },
    registrationTick: 0,
  }),
}));

vi.mock("../../shell/libraryInspectorPanel", () => ({
  useLibraryInspectorPanel: () => ({ panel: h.libraryPanel, setPanel: vi.fn() }),
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
      fallowTopic: h.fallowTopic,
      unfallowTopic: h.unfallowTopic,
      getTopicKnowledgeState: h.getTopicKnowledgeState,
      semanticRelated: h.semanticRelated,
      listTasks: h.listTasks,
      createTask: h.createTask,
      completeTask: h.completeTask,
      postponeTask: h.postponeTask,
      exportDocumentMarkdown: h.exportDocumentMarkdown,
      exportAnki: h.exportAnki,
      restoreFromTrash: h.restoreFromTrash,
      restoreAncestorChain: h.restoreAncestorChain,
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
    extractFate: null,
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
      scheduleReason: null,
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

function topicKnowledge(): TopicKnowledgeStateGetResult {
  return {
    asOf: "2026-06-12T10:00:00.000Z",
    windowDays: 90,
    subjects: [
      {
        subjectType: "topic",
        subjectId: "topic-1",
        title: "Topic one",
        priority: 0.5,
        priorityLabel: "C",
        directMemberCount: null,
        includedElementCount: 8,
        funnel: {
          read: 4,
          extracted: 3,
          distilled: 2,
          carded: 2,
          mature: 1,
          extractedOfRead: 0.75,
          distilledOfExtracted: 2 / 3,
          cardedOfDistilled: 1,
          matureOfCarded: 0.5,
        },
        stability: { young: 1, maturing: 1, mature: 1, retired: 0 },
        retention: {
          windowDays: 90,
          reviewCount: 7,
          measuredRetention: 0.84,
          retentionTarget: 0.92,
          directConceptTarget: null,
          deltaFromTarget: -0.08,
          snapshots: [],
        },
        staleness: { staleItems: 1, needsReverify: 1 },
        graduationState: {
          status: "needs_attention",
          reason: "Retention is below target.",
          thresholdVersion: "v1",
        },
      },
    ],
    graduationEvents: [],
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
      scheduleReason: null,
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
      scheduleReason: null,
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
  h.triagePanel = null;
  h.libraryPanel = null;
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
  h.getTopicKnowledgeState.mockReset();
  h.getTopicKnowledgeState.mockResolvedValue(topicKnowledge());
  h.setElementPriority.mockReset();
  h.setElementPriority.mockResolvedValue({ element: null });
  h.scheduleQueueItem.mockReset();
  h.scheduleQueueItem.mockResolvedValue({
    item: null,
    dueAt: "2026-06-08T12:00:00.000Z",
    intervalDays: 1,
  });
  h.fallowTopic.mockReset();
  h.fallowTopic.mockResolvedValue({ applied: 1, skipped: [], batchId: "batch-fallow" });
  h.unfallowTopic.mockReset();
  h.unfallowTopic.mockResolvedValue({ applied: 1, skipped: [], batchId: "batch-fallow" });
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
  h.exportDocumentMarkdown.mockReset();
  h.exportDocumentMarkdown.mockResolvedValue({
    relativePath: "Wigner-paper.md",
    directoryLabel: "Downloads",
  });
  h.exportAnki.mockReset();
  h.exportAnki.mockResolvedValue({
    relativePath: "Interleave.apkg",
    directoryLabel: "Downloads",
    cardCount: 1,
  });
  h.restoreFromTrash.mockReset();
  h.restoreFromTrash.mockResolvedValue({ item: null });
  h.restoreAncestorChain.mockReset();
  h.restoreAncestorChain.mockResolvedValue({ restored: ["ext-dead"], batchId: "restore-batch-1" });
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

  it("renders the topic maturity receipt and weak-topic subset review CTA", async () => {
    h.selectedId = "topic-1";
    render(<Inspector />);

    await screen.findByTestId("topic-maturity-status");
    const panel = screen.getByTestId("topic-maturity-section");
    expect(h.getTopicKnowledgeState).toHaveBeenCalledWith({
      subjectType: "topic",
      subjectId: "topic-1",
      limit: 1,
      order: "default",
    });
    expect(panel).toHaveTextContent("Needs attention");
    expect(panel).toHaveTextContent("84%");
    expect(panel).toHaveTextContent("target 92%");
    expect(panel).toHaveTextContent("Retention is below target.");
    expect(screen.getByTestId("topic-maturity-buckets")).toHaveTextContent("Young 1");
    expect(screen.getByTestId("topic-maturity-flags")).toHaveTextContent("1 stale");
    expect(screen.getByTestId("topic-maturity-review")).toHaveTextContent(
      "Review 4 weak-topic cards",
    );
  });

  it("shows the T123 content-staleness advisory when the element needs re-verify", async () => {
    h.selectedId = "topic-1";
    const data = topicData("Edited-source extract");
    h.getInspectorData.mockResolvedValue({
      data: { ...data, scheduler: { ...data.scheduler, needsReverify: true } },
    });

    render(<Inspector />);

    expect(await screen.findByTestId("inspector-reverify")).toHaveTextContent(
      "Source content changed",
    );
  });

  it("omits the content-staleness advisory when the element does not need re-verify", async () => {
    h.selectedId = "topic-1";
    render(<Inspector />);

    await screen.findByTestId("scheduler-section");
    expect(screen.queryByTestId("inspector-reverify")).toBeNull();
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

  it("hides the canonical URL when it only differs from URL by a trailing slash", async () => {
    const data = sourceData();
    const provenance = data.provenance;
    if (!provenance) throw new Error("Missing source provenance fixture");
    h.selectedId = "src-1";
    h.getInspectorData.mockResolvedValue({
      data: {
        ...data,
        provenance: {
          ...provenance,
          url: "https://moretothat.com/travel-is-no-cure-for-the-mind/",
          canonicalUrl: "https://moretothat.com/travel-is-no-cure-for-the-mind",
          originalUrl: null,
        },
      },
    });

    render(<Inspector />);

    expect(await screen.findByTestId("provenance-url")).toHaveAttribute(
      "href",
      "https://moretothat.com/travel-is-no-cure-for-the-mind/",
    );
    expect(screen.queryByTestId("provenance-canonical-url")).not.toBeInTheDocument();
    expect(screen.queryByText("Canonical URL")).not.toBeInTheDocument();
  });

  it("renders topic rest controls and applies fallow through the typed app API", async () => {
    h.selectedId = "topic-1";
    h.getInspectorData.mockResolvedValue({ data: topicData("Topic one") });

    render(<Inspector />);

    expect(await screen.findByTestId("fallow-section")).toHaveTextContent("Not resting");
    const fallowDate = screen.getByTestId("fallow-date");
    fireEvent.change(fallowDate, {
      target: { value: "2099-07-01" },
    });
    fireEvent.change(screen.getByTestId("fallow-reason"), {
      target: { value: "Let this rest" },
    });
    await waitFor(() => expect(fallowDate).toHaveValue("2099-07-01"));
    fireEvent.click(screen.getByTestId("fallow-apply"));

    await waitFor(() =>
      expect(h.fallowTopic).toHaveBeenCalledWith({
        topicId: "topic-1",
        fallowUntil: "2099-07-01T00:00:00.000Z",
        fallowReason: "Let this rest",
      }),
    );
  });

  it("clears existing topic rest through the typed app API", async () => {
    h.selectedId = "topic-1";
    const data = topicData("Topic one");
    h.getInspectorData.mockResolvedValue({
      data: {
        ...data,
        element: {
          ...data.element,
          fallowUntil: "2099-07-01T00:00:00.000Z",
          fallowReason: "Let this rest",
        },
      },
    });

    render(<Inspector />);

    expect(await screen.findByTestId("fallow-section")).toHaveTextContent("Resting");
    fireEvent.click(screen.getByTestId("fallow-clear"));

    await waitFor(() => expect(h.unfallowTopic).toHaveBeenCalledWith({ topicId: "topic-1" }));
  });

  it("shows Markdown exports as written to Downloads", async () => {
    h.selectedId = "src-1";
    h.getInspectorData.mockResolvedValue({ data: sourceData() });

    render(<Inspector />);

    fireEvent.click(await screen.findByTestId("export-markdown"));

    await waitFor(() =>
      expect(h.exportDocumentMarkdown).toHaveBeenCalledWith({ elementId: "src-1" }),
    );
    expect(await screen.findByTestId("export-done")).toHaveTextContent(
      "Exported to Downloads/Wigner-paper.md",
    );
  });

  it("shows Anki exports as written to Downloads", async () => {
    h.selectedId = "card-1";
    h.getInspectorData.mockResolvedValue({ data: cardDataWithSourceContext() });

    render(<Inspector />);

    fireEvent.click(await screen.findByTestId("export-anki-apkg"));

    await waitFor(() =>
      expect(h.exportAnki).toHaveBeenCalledWith({ format: "apkg", cardIds: ["card-1"] }),
    );
    expect(await screen.findByTestId("export-anki-done")).toHaveTextContent(
      "Exported to Downloads/Interleave.apkg · 1 card",
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

  it("renders the trusted attention schedule reason before the attention summary", async () => {
    h.selectedId = "ext-1";
    const data = extractDataWithSourceLineage();
    h.getInspectorData.mockResolvedValue({
      data: {
        ...data,
        scheduler: {
          ...data.scheduler,
          scheduleReason: {
            kind: "source_unresolved_shortened",
            baseIntervalDays: 7,
            finalIntervalDays: 3,
            unresolvedRatio: 0.5,
            terminalRatio: 0.5,
            ignoredRatio: 0,
            extractedOutputCount: 0,
          },
        },
      },
    });

    render(<Inspector />);

    const section = await screen.findByTestId("scheduler-section");
    const reason = within(section).getByTestId("schedule-reason-line");
    expect(reason).toHaveTextContent("Returning sooner: source still has unresolved blocks.");
    expect(
      section.textContent?.indexOf("Returning sooner: source still has unresolved blocks."),
    ).toBeLessThan(section.textContent?.indexOf("Seen today") ?? Number.POSITIVE_INFINITY);
  });

  it("does not render attention schedule reasons for FSRS scheduler signals", async () => {
    h.selectedId = "card-1";
    h.getInspectorData.mockResolvedValue({ data: cardDataWithSourceContext() });

    render(<Inspector />);

    const section = await screen.findByTestId("scheduler-section");
    expect(within(section).queryByTestId("schedule-reason-line")).toBeNull();
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
            deleted: false,
          },
          {
            id: "ext-1",
            title: "Linked extract",
            type: "extract",
            stage: "clean_extract",
            depth: 1,
            meta: "clean extract",
            active: true,
            deleted: false,
          },
          {
            id: "card-1",
            title: "Linked card",
            type: "card",
            stage: "active_card",
            depth: 2,
            meta: "active card",
            active: false,
            deleted: false,
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

  // T135 / U2 — tombstone lineage in the inspector.
  describe("lineage tombstones (T135)", () => {
    /** A focused live card under a soft-deleted middle extract (the user's real case). */
    function lineageWithDeletedAncestor() {
      return {
        lineage: {
          elementId: "card-1",
          rootId: "src-1",
          nodes: [
            {
              id: "src-1",
              title: "The Toxoplasma Of Rage",
              type: "source",
              stage: "raw_source",
              depth: 0,
              meta: "source",
              active: false,
              deleted: false,
            },
            {
              id: "ext-dead",
              title: "The University of Virginia rape case…",
              type: "extract",
              stage: "raw_extract",
              depth: 1,
              meta: "raw_extract",
              active: false,
              deleted: true,
            },
            {
              id: "card-1",
              title: "Linked card",
              type: "card",
              stage: "active_card",
              depth: 2,
              meta: "cloze",
              active: true,
              deleted: false,
            },
          ],
        },
      };
    }

    it("requests tombstone-aware lineage but hides deleted nodes behind the header toggle by default (Covers R1)", async () => {
      h.selectedId = "card-1";
      h.getInspectorData.mockResolvedValue({ data: cardDataWithSourceContext() });
      h.getLineage.mockResolvedValue(lineageWithDeletedAncestor());

      render(<Inspector />);

      await screen.findByTestId("lineage-tree");
      expect(h.getLineage).toHaveBeenCalledWith({ id: "card-1", includeTombstones: true });
      expect(screen.getByRole("button", { name: /show deleted \(1\)/i })).toBeInTheDocument();
      expect(screen.queryByTestId("lineage-tombstone-tag")).toBeNull();
      expect(screen.queryByTestId("lineage-tombstone-restore")).toBeNull();
      expect(screen.queryByTestId("lineage-ancestor-deleted")).toBeNull();
      const liveCard = screen
        .getAllByTestId("lineage-tree-node")
        .find((n) => n.getAttribute("data-element-id") === "card-1");
      expect(liveCard).toBeInTheDocument();
      expect(liveCard?.getAttribute("data-depth")).toBe("1");

      fireEvent.click(screen.getByRole("button", { name: /show deleted/i }));

      // The deleted middle extract is revealed as a tombstone, not pruned.
      const dead = screen
        .getAllByTestId("lineage-tree-node")
        .find((n) => n.getAttribute("data-element-id") === "ext-dead");
      expect(dead?.getAttribute("data-deleted")).toBe("true");
      expect(screen.getByRole("button", { name: /hide deleted/i })).toBeInTheDocument();
    });

    it("hint Restore calls restoreAncestorChain for the FOCUSED element, not a multi-node restore (Covers R3/B1)", async () => {
      h.selectedId = "card-1";
      h.getInspectorData.mockResolvedValue({ data: cardDataWithSourceContext() });
      h.getLineage.mockResolvedValue(lineageWithDeletedAncestor());

      render(<Inspector />);

      fireEvent.click(await screen.findByRole("button", { name: /show deleted/i }));
      const hint = await screen.findByTestId("lineage-ancestor-deleted");
      expect(hint).toHaveTextContent(/ancestor of this item is deleted/i);

      fireEvent.click(screen.getByTestId("lineage-ancestor-restore"));

      // The CORRECT primitive: restore the focused element's ancestor chain, which the
      // main side walks up to a live root — never a per-tombstone `restoreFromTrash` that
      // could resurrect unrelated sibling tombstones.
      await waitFor(() => expect(h.restoreAncestorChain).toHaveBeenCalledWith({ id: "card-1" }));
      expect(h.restoreFromTrash).not.toHaveBeenCalled();
    });

    it("resets the deleted-lineage reveal when the selected element changes", async () => {
      h.selectedId = "card-1";
      const secondCard = cardDataWithSourceContext();
      h.getInspectorData
        .mockResolvedValueOnce({ data: cardDataWithSourceContext() })
        .mockResolvedValueOnce({
          data: {
            ...secondCard,
            element: { ...secondCard.element, id: "card-2", title: "Second linked card" },
          },
        })
        .mockResolvedValueOnce({ data: cardDataWithSourceContext() });
      const secondLineage = {
        lineage: {
          elementId: "card-2",
          rootId: "src-1",
          nodes: [
            {
              id: "src-1",
              title: "The Toxoplasma Of Rage",
              type: "source",
              stage: "raw_source",
              depth: 0,
              meta: "source",
              active: false,
              deleted: false,
            },
            {
              id: "ext-dead-2",
              title: "Second deleted extract",
              type: "extract",
              stage: "raw_extract",
              depth: 1,
              meta: "raw_extract",
              active: false,
              deleted: true,
            },
            {
              id: "card-2",
              title: "Second linked card",
              type: "card",
              stage: "active_card",
              depth: 2,
              meta: "cloze",
              active: true,
              deleted: false,
            },
          ],
        },
      };
      h.getLineage
        .mockResolvedValueOnce(lineageWithDeletedAncestor())
        .mockResolvedValueOnce(secondLineage)
        .mockResolvedValueOnce(lineageWithDeletedAncestor());

      const view = render(<Inspector />);

      fireEvent.click(await screen.findByRole("button", { name: /show deleted/i }));
      expect(screen.getByText("The University of Virginia rape case…")).toBeInTheDocument();

      h.selectedId = "card-2";
      view.rerender(<Inspector />);

      await waitFor(() =>
        expect(screen.getByTestId("inspector-title")).toHaveTextContent("Second linked card"),
      );
      expect(screen.getByRole("button", { name: /show deleted \(1\)/i })).toBeInTheDocument();
      expect(screen.queryByText("Second deleted extract")).toBeNull();
      expect(screen.queryByRole("button", { name: /hide deleted/i })).toBeNull();

      h.selectedId = "card-1";
      view.rerender(<Inspector />);

      await waitFor(() =>
        expect(screen.getByTestId("inspector-title")).toHaveTextContent("What is intelligence?"),
      );
      expect(screen.getByRole("button", { name: /show deleted \(1\)/i })).toBeInTheDocument();
      expect(screen.queryByText("The University of Virginia rape case…")).toBeNull();
      expect(screen.queryByRole("button", { name: /hide deleted/i })).toBeNull();
    });

    it("does not render stale lineage while the selected element's lineage is still loading", async () => {
      h.selectedId = "card-1";
      const pendingSecondLineage = deferred<ReturnType<typeof lineageWithDeletedAncestor>>();
      const secondCard = cardDataWithSourceContext();
      h.getInspectorData
        .mockResolvedValueOnce({ data: cardDataWithSourceContext() })
        .mockResolvedValueOnce({
          data: {
            ...secondCard,
            element: { ...secondCard.element, id: "card-2", title: "Second linked card" },
          },
        });
      h.getLineage
        .mockResolvedValueOnce(lineageWithDeletedAncestor())
        .mockReturnValueOnce(pendingSecondLineage.promise);

      const view = render(<Inspector />);

      expect(
        await screen.findByRole("button", { name: /show deleted \(1\)/i }),
      ).toBeInTheDocument();

      h.selectedId = "card-2";
      view.rerender(<Inspector />);

      await waitFor(() =>
        expect(screen.getByTestId("inspector-title")).toHaveTextContent("Second linked card"),
      );
      expect(screen.queryByRole("button", { name: /show deleted/i })).toBeNull();
      expect(screen.queryByText("The University of Virginia rape case…")).toBeNull();

      await act(async () => {
        pendingSecondLineage.resolve({
          lineage: {
            ...lineageWithDeletedAncestor().lineage,
            elementId: "card-2",
            nodes: lineageWithDeletedAncestor().lineage.nodes.map((node) =>
              node.id === "card-1" ? { ...node, id: "card-2", title: "Second linked card" } : node,
            ),
          },
        });
        await pendingSecondLineage.promise;
      });

      expect(
        await screen.findByRole("button", { name: /show deleted \(1\)/i }),
      ).toBeInTheDocument();
    });

    it("restores a single tombstone via its ancestor chain from the inline row control (Covers R11/B1)", async () => {
      h.selectedId = "card-1";
      h.getInspectorData.mockResolvedValue({ data: cardDataWithSourceContext() });
      h.getLineage.mockResolvedValue(lineageWithDeletedAncestor());

      render(<Inspector />);

      await screen.findByTestId("lineage-tree");
      fireEvent.click(screen.getByRole("button", { name: /show deleted/i }));
      fireEvent.click(screen.getByTestId("lineage-tombstone-restore"));

      // The per-tombstone Restore restores THAT node's chain (so it is never left under a
      // still-tombstoned parent), not a bare single-row restore.
      await waitFor(() => expect(h.restoreAncestorChain).toHaveBeenCalledWith({ id: "ext-dead" }));
      expect(h.restoreFromTrash).not.toHaveBeenCalled();
    });

    it("does NOT show the ancestor hint (nor restore anything) when only a DESCENDANT is a tombstone (B1)", async () => {
      // Focused live extract `ext-mid` with a live source ancestor and a DELETED child card.
      // A deleted descendant is not an "ancestor deleted" case — the hint must stay hidden.
      h.selectedId = "ext-mid";
      h.getInspectorData.mockResolvedValue({
        data: {
          ...cardDataWithSourceContext(),
          element: {
            ...element("ext-mid", "Middle extract"),
            type: "extract",
            stage: "raw_extract",
          },
        },
      });
      h.getLineage.mockResolvedValue({
        lineage: {
          elementId: "ext-mid",
          rootId: "src-1",
          nodes: [
            {
              id: "src-1",
              title: "The Toxoplasma Of Rage",
              type: "source",
              stage: "raw_source",
              depth: 0,
              meta: "source",
              active: false,
              deleted: false,
            },
            {
              id: "ext-mid",
              title: "Middle extract",
              type: "extract",
              stage: "raw_extract",
              depth: 1,
              meta: "raw_extract",
              active: true,
              deleted: false,
            },
            {
              id: "card-dead",
              title: "Deleted child card",
              type: "card",
              stage: "active_card",
              depth: 2,
              meta: "cloze",
              active: false,
              deleted: true,
            },
          ],
        },
      });

      render(<Inspector />);

      await screen.findByTestId("lineage-tree");
      expect(screen.getByRole("button", { name: /show deleted \(1\)/i })).toBeInTheDocument();
      expect(screen.queryByTestId("lineage-ancestor-deleted")).toBeNull();
    });

    it("does not treat an earlier deleted sibling as an ancestor", async () => {
      h.selectedId = "card-1";
      h.getInspectorData.mockResolvedValue({ data: cardDataWithSourceContext() });
      h.getLineage.mockResolvedValue({
        lineage: {
          elementId: "card-1",
          rootId: "src-1",
          nodes: [
            {
              id: "src-1",
              title: "The Toxoplasma Of Rage",
              type: "source",
              stage: "raw_source",
              depth: 0,
              meta: "source",
              active: false,
              deleted: false,
            },
            {
              id: "ext-dead-sibling",
              title: "Deleted sibling extract",
              type: "extract",
              stage: "raw_extract",
              depth: 1,
              meta: "raw_extract",
              active: false,
              deleted: true,
            },
            {
              id: "ext-live",
              title: "Live extract",
              type: "extract",
              stage: "raw_extract",
              depth: 1,
              meta: "raw_extract",
              active: false,
              deleted: false,
            },
            {
              id: "card-1",
              title: "Linked card",
              type: "card",
              stage: "active_card",
              depth: 2,
              meta: "cloze",
              active: true,
              deleted: false,
            },
          ],
        },
      });

      render(<Inspector />);

      fireEvent.click(await screen.findByRole("button", { name: /show deleted/i }));

      expect(screen.getByText("Deleted sibling extract")).toBeInTheDocument();
      expect(screen.queryByTestId("lineage-ancestor-deleted")).toBeNull();
    });

    it("does not show the deleted-lineage toggle for live-only lineage", async () => {
      h.selectedId = "card-1";
      h.getInspectorData.mockResolvedValue({ data: cardDataWithSourceContext() });
      h.getLineage.mockResolvedValue({
        lineage: {
          elementId: "card-1",
          rootId: "src-1",
          nodes: [
            {
              id: "src-1",
              title: "The Toxoplasma Of Rage",
              type: "source",
              stage: "raw_source",
              depth: 0,
              meta: "source",
              active: false,
              deleted: false,
            },
            {
              id: "card-1",
              title: "Linked card",
              type: "card",
              stage: "active_card",
              depth: 1,
              meta: "cloze",
              active: true,
              deleted: false,
            },
          ],
        },
      });

      render(<Inspector />);

      await screen.findByTestId("lineage-tree");
      expect(screen.queryByRole("button", { name: /show deleted/i })).toBeNull();
      expect(screen.queryByTestId("lineage-tombstone-tag")).toBeNull();
    });
  });

  describe("relocated inbox triage section", () => {
    function triagePanel(
      overrides: Partial<import("../../shell/inboxTriagePanel").InboxTriagePanel> = {},
    ): import("../../shell/inboxTriagePanel").InboxTriagePanel {
      return {
        targetId: "src-1",
        priority: 0.5,
        busy: false,
        suggestion: null,
        placementAssigned: false,
        triageHighlighted: false,
        onReadNow: vi.fn(),
        onTriage: vi.fn(),
        onPickPriority: vi.fn(),
        onAcceptSuggestion: vi.fn(),
        onAcceptPlacement: vi.fn(),
        ...overrides,
      };
    }

    const bandedSuggestion = {
      kind: "suggestion",
      band: "A",
      placement: { conceptId: "c-1", conceptName: "Quantum mechanics" },
      justification: { signals: [{ kind: "semantic", neighborCount: 3, lean: "A" }] },
      signalHash: "hash-1",
    } satisfies import("../../lib/appApi").TriageSuggestionSuggestionDto;

    it("renders the triage section ABOVE Properties for a matching inbox source", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.triagePanel = triagePanel();

      render(<Inspector />);

      const triage = await screen.findByTestId("inbox-triage-actions");
      expect(triage).toHaveTextContent("1 · 2 · 3 · 6");
      const properties = screen.getByText("Properties").closest(".insp-sec");
      if (!properties) throw new Error("Missing Properties section");
      // Triage precedes Properties in the DOM (rendered above it).
      expect(
        triage.compareDocumentPosition(properties) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("fires the triage handlers on click", async () => {
      const panel = triagePanel();
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.triagePanel = panel;

      render(<Inspector />);

      fireEvent.click(await screen.findByTestId("inbox-read-now"));
      expect(panel.onReadNow).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId("inbox-queue-soon"));
      expect(panel.onTriage).toHaveBeenCalledWith("queueSoon");
      fireEvent.click(screen.getByTestId("inbox-keep"));
      expect(panel.onTriage).toHaveBeenCalledWith("keepForLater");
      fireEvent.click(screen.getByTestId("inbox-delete"));
      expect(panel.onTriage).toHaveBeenCalledWith("delete");
    });

    it("renders the provenance-aware picker and suppresses the generic Set priority", async () => {
      const panel = triagePanel();
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.triagePanel = panel;

      render(<Inspector />);

      await screen.findByTestId("inbox-triage-actions");
      // The relocated picker is present; the inspector's generic picker is hidden.
      expect(screen.getByTestId("inbox-priority")).toBeInTheDocument();
      expect(screen.queryByTestId("inspector-priority")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("inbox-priority-A"));
      expect(panel.onPickPriority).toHaveBeenCalledWith("A");
    });

    it("keeps the generic Set priority when no triage panel is active", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.triagePanel = null;

      render(<Inspector />);

      await screen.findByTestId("provenance-url");
      expect(screen.queryByTestId("inbox-triage-actions")).not.toBeInTheDocument();
      expect(screen.getByTestId("inspector-priority")).toBeInTheDocument();
    });

    it("disables the controls when busy", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.triagePanel = triagePanel({ busy: true });

      render(<Inspector />);

      expect(await screen.findByTestId("inbox-read-now")).toBeDisabled();
      expect(screen.getByTestId("inbox-priority-A")).toBeDisabled();
    });

    it("applies the highlight when triageHighlighted", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.triagePanel = triagePanel({ triageHighlighted: true });

      render(<Inspector />);

      expect(await screen.findByTestId("inbox-triage-actions")).toHaveAttribute(
        "data-highlighted",
        "true",
      );
    });

    it("does NOT render for a non-source element even with a payload", async () => {
      h.selectedId = "topic-1";
      h.getInspectorData.mockResolvedValue({ data: topicData("Topic one") });
      h.triagePanel = triagePanel({ targetId: "topic-1" });

      render(<Inspector />);

      await screen.findByTestId("inspector-title");
      expect(screen.queryByTestId("inbox-triage-actions")).not.toBeInTheDocument();
    });

    it("does NOT render when the payload targets a different element", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.triagePanel = triagePanel({ targetId: "some-other-id" });

      render(<Inspector />);

      await screen.findByTestId("provenance-url");
      expect(screen.queryByTestId("inbox-triage-actions")).not.toBeInTheDocument();
    });

    it("renders the suggested-priority accept and placement affordances", async () => {
      const panel = triagePanel({ suggestion: bandedSuggestion });
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.triagePanel = panel;

      render(<Inspector />);

      await screen.findByTestId("inbox-triage-actions");
      fireEvent.click(screen.getByTestId("inbox-suggestion-chip"));
      expect(panel.onAcceptSuggestion).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId("inbox-suggestion-placement-accept"));
      expect(panel.onAcceptPlacement).toHaveBeenCalledWith("c-1");
    });

    it("shows the confirmed placement state when already assigned", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.triagePanel = triagePanel({ suggestion: bandedSuggestion, placementAssigned: true });

      render(<Inspector />);

      await screen.findByTestId("inbox-triage-actions");
      expect(screen.getByTestId("inbox-suggestion-placement-assigned")).toBeInTheDocument();
      expect(screen.queryByTestId("inbox-suggestion-placement-accept")).not.toBeInTheDocument();
    });

    it("does not unmount/remount the section when the payload re-publishes (no flicker)", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.triagePanel = triagePanel({ busy: false });

      const { rerender } = render(<Inspector />);
      const before = await screen.findByTestId("inbox-triage-actions");

      // Re-publish with only `busy` changed (the common case during triage), the
      // shape InboxScreen produces on every busy/highlight tick. The section must
      // re-render in place, not remount — the DOM node identity must be preserved
      // (KTD-2 no-flicker), and the busy state must apply.
      h.triagePanel = triagePanel({ busy: true });
      rerender(<Inspector />);

      const after = screen.getByTestId("inbox-triage-actions");
      expect(after).toBe(before);
      expect(screen.getByTestId("inbox-read-now")).toBeDisabled();
    });

    it("renders no suggestion affordance for a pending suggestion", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.triagePanel = triagePanel({ suggestion: "pending" });

      render(<Inspector />);

      await screen.findByTestId("inbox-triage-actions");
      expect(screen.queryByTestId("inbox-suggestion")).not.toBeInTheDocument();
      expect(screen.queryByTestId("inbox-suggestion-placement")).not.toBeInTheDocument();
    });
  });

  // The Library detail column was removed; its unique controls (Open + parked
  // actions + context lines) relocated here, published via the libraryInspectorPanel
  // bridge and gated to the inspected element.
  describe("relocated Library controls (U3)", () => {
    function makeLibraryPanel(
      overrides: Partial<LibraryInspectorPanel> = {},
    ): LibraryInspectorPanel {
      return {
        targetId: "src-1",
        openLabel: "Open source",
        onOpen: vi.fn(),
        parkedAt: null,
        notInQueueReason: null,
        parked: null,
        ...overrides,
      };
    }

    it("renders the full-width Open button for the matching element and invokes onOpen", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      const onOpen = vi.fn();
      h.libraryPanel = makeLibraryPanel({ onOpen });
      render(<Inspector />);

      const btn = await screen.findByTestId("inspector-open-element");
      expect(btn.textContent).toContain("Open source");
      expect(btn.className).toContain("insp-add__btn--accent");
      fireEvent.click(btn);
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it("does not render the controls when the payload targets a different element (leak guard)", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.libraryPanel = makeLibraryPanel({ targetId: "some-other-id" });
      render(<Inspector />);

      await screen.findByTestId("inspector-content");
      expect(screen.queryByTestId("inspector-library-actions")).toBeNull();
      expect(screen.queryByTestId("inspector-open-element")).toBeNull();
    });

    it("does not render the controls when no payload is published", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.libraryPanel = null;
      render(<Inspector />);

      await screen.findByTestId("inspector-content");
      expect(screen.queryByTestId("inspector-open-element")).toBeNull();
    });

    it("renders parked quick-actions only when parked, and wires their handlers", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      const onMoveToInbox = vi.fn();
      const onQueueSoon = vi.fn();
      const onDismiss = vi.fn();
      h.libraryPanel = makeLibraryPanel({
        parked: { busy: false, onMoveToInbox, onQueueSoon, onDismiss },
      });
      render(<Inspector />);

      fireEvent.click(await screen.findByTestId("inspector-parked-inbox"));
      fireEvent.click(screen.getByTestId("inspector-parked-schedule"));
      fireEvent.click(screen.getByTestId("inspector-parked-dismiss"));
      expect(onMoveToInbox).toHaveBeenCalledTimes(1);
      expect(onQueueSoon).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it("omits parked quick-actions when the element is not a parked source", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.libraryPanel = makeLibraryPanel({ parked: null });
      render(<Inspector />);

      await screen.findByTestId("inspector-open-element");
      expect(screen.queryByTestId("inspector-parked-actions")).toBeNull();
    });

    it("disables the parked buttons while a parked action is busy", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.libraryPanel = makeLibraryPanel({
        parked: { busy: true, onMoveToInbox: vi.fn(), onQueueSoon: vi.fn(), onDismiss: vi.fn() },
      });
      render(<Inspector />);

      expect(await screen.findByTestId("inspector-parked-inbox")).toBeDisabled();
      expect(screen.getByTestId("inspector-parked-schedule")).toBeDisabled();
      expect(screen.getByTestId("inspector-parked-dismiss")).toBeDisabled();
    });

    it("renders the parked-date and queue-reason context lines when present", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.libraryPanel = makeLibraryPanel({
        parkedAt: "2026-07-02T00:00:00.000Z",
        notInQueueReason: "Not in queue: returns Jul 2",
      });
      render(<Inspector />);

      expect((await screen.findByTestId("inspector-parked-date")).textContent).toContain("Parked");
      expect(screen.getByTestId("inspector-queue-reason").textContent).toContain(
        "Not in queue: returns Jul 2",
      );
    });

    it("omits the context lines when parkedAt and notInQueueReason are null (no regression placeholder)", async () => {
      h.selectedId = "src-1";
      h.getInspectorData.mockResolvedValue({ data: sourceData() });
      h.libraryPanel = makeLibraryPanel({ parkedAt: null, notInQueueReason: null });
      render(<Inspector />);

      await screen.findByTestId("inspector-open-element");
      expect(screen.queryByTestId("inspector-parked-date")).toBeNull();
      expect(screen.queryByTestId("inspector-queue-reason")).toBeNull();
    });
  });
});

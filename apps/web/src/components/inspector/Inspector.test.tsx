import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { Inspector, requestInspectorRefresh } from "./Inspector";

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
});

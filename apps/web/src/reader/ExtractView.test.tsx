/**
 * ExtractView component tests (T024 — extract review mode).
 *
 * Covers the renderer seam the spec calls out:
 *  - the stage STEPPER renders the three steps (`raw_extract → clean_extract →
 *    atomic_statement`) and "Advance stage" calls `extracts.updateStage` (the
 *    main side persists the stage + reschedules on the attention scheduler);
 *  - clicking a specific step calls `extracts.updateStage` with that explicit
 *    stage;
 *  - "Convert to card" routes to the (placeholder) M6 builder (`/review`) instead
 *    of inventing a builder now;
 *  - Trim / Postpone / Mark done / Delete each invoke their `extracts.*` command.
 *
 * The heavy collaborators are mocked so the test exercises ONLY this component's
 * wiring: `@interleave/editor`'s `SourceEditor` is stubbed (no Tiptap/jsdom
 * contentEditable), the router params/navigation are mocked, and `window.appApi`
 * is a fake whose calls are asserted. No SQLite/IPC — the renderer is a pure UI
 * consumer here, exactly as the layering rules require.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared spies + fixture data, hoisted so the (hoisted) vi.mock factories below
// can close over them without a TDZ error.
const h = vi.hoisted(() => {
  const inspectorData = {
    element: {
      id: "ex_1",
      type: "extract",
      status: "scheduled",
      stage: "raw_extract",
      priority: 0.625,
      title: "A clean idea",
      dueAt: "2026-06-05T00:00:00.000Z",
    },
    scheduler: {
      kind: "attention",
      retrievability: null,
      stability: null,
      difficulty: null,
      reps: null,
      lapses: null,
      fsrsState: null,
      stage: "raw_extract",
      postponed: 0,
      lastProcessedAt: "2026-05-29T00:00:00.000Z",
    },
    parent: null,
    children: [],
    source: { id: "src_1", type: "source", title: "On Sleep", stage: "raw_source" },
    provenance: null,
    // The originating source reference (T043) — the refblock the source-context
    // pane renders, resolved main-side from this extract's lineage.
    sourceRef: {
      sourceElementId: "src_1",
      sourceTitle: "On Sleep",
      url: "https://example.com/sleep",
      author: "M. Walker",
      publishedAt: "2017-10-03T00:00:00.000Z",
      locationLabel: "¶2",
      snippet: "The definition paragraph two.",
    },
    location: {
      label: "¶2",
      selectedText: "The definition paragraph two.",
      page: null,
      sourceElementId: "src_1",
      blockIds: ["blk_2"],
      startOffset: 0,
      endOffset: 29,
    },
    tags: [],
    concepts: [],
    review: null,
  };
  return {
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    inspectorData,
    updateStage: vi.fn().mockResolvedValue({
      extract: { ...inspectorData.element, stage: "clean_extract" },
    }),
    rewrite: vi.fn().mockResolvedValue({ extract: inspectorData.element, plainText: "x" }),
    postpone: vi.fn().mockResolvedValue({ extract: inspectorData.element, postponeCount: 1 }),
    markDone: vi.fn().mockResolvedValue({ extract: inspectorData.element }),
    deleteExtract: vi.fn().mockResolvedValue({ extract: inspectorData.element }),
    createCard: vi.fn().mockResolvedValue({
      card: {
        id: "card_1",
        type: "card",
        status: "pending",
        stage: "card_draft",
        priority: 0.625,
        title: "Q?",
        kind: "qa",
        parentId: "ex_1",
        sourceId: "src_1",
        siblingGroupId: "sg_1",
      },
      sourceLocationId: "loc_1",
    }),
    createExtraction: vi.fn().mockResolvedValue({
      extract: { id: "sub_1", parentId: "ex_1", sourceId: "src_1" },
      location: { sourceElementId: "ex_1" },
    }),
    // The selection the toolbar/Split act on. `null` by default (no live selection);
    // tests override `current` to simulate a selection inside the extract body.
    selectionLocation: { current: null as null | Record<string, unknown> },
  };
});

// Mock the typed client wrapper used by the component.
vi.mock("../lib/appApi", () => ({
  isDesktop: () => true,
  appApi: {
    getInspectorData: vi.fn().mockResolvedValue({ data: h.inspectorData }),
    getLineage: vi.fn().mockResolvedValue({
      lineage: {
        elementId: "ex_1",
        rootId: "src_1",
        nodes: [
          {
            id: "src_1",
            type: "source",
            title: "On Sleep",
            stage: "raw_source",
            depth: 0,
            meta: "source",
            active: false,
          },
          {
            id: "ex_1",
            type: "extract",
            title: "A clean idea",
            stage: "raw_extract",
            depth: 1,
            meta: "this",
            active: true,
          },
          {
            id: "card_1",
            type: "card",
            title: "Why does sleep consolidate memories?",
            stage: "active_card",
            depth: 2,
            meta: "active_card",
            active: false,
          },
          {
            id: "ex_2",
            type: "extract",
            title: "A narrower sleep mechanism",
            stage: "raw_extract",
            depth: 2,
            meta: "sub-extract",
            active: false,
          },
        ],
      },
    }),
    getDocument: vi.fn().mockResolvedValue({
      document: {
        prosemirrorJson: { type: "doc", content: [] },
        plainText: "body",
        schemaVersion: 1,
        updatedAt: "",
      },
      extractedBlockIds: [],
    }),
    saveDocument: vi.fn().mockResolvedValue({
      document: {
        prosemirrorJson: { type: "doc", content: [] },
        plainText: "body",
        schemaVersion: 1,
        updatedAt: "",
      },
    }),
    updateExtractStage: h.updateStage,
    rewriteExtract: h.rewrite,
    postponeExtract: h.postpone,
    markExtractDone: h.markDone,
    deleteExtract: h.deleteExtract,
    createExtraction: h.createExtraction,
    createCard: h.createCard,
  },
}));

// Mock the router seams the component reaches (params + navigation).
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ id: "ex_1" }),
  useNavigate: () => h.navigateSpy,
}));

vi.mock("../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
}));

// Stub the heavy Tiptap editor with a trivial element so the component renders
// without a real contentEditable. `toBlockInputs` is a no-op here.
vi.mock("@interleave/editor", () => ({
  SourceEditor: () => <div data-testid="mock-editor" />,
  toBlockInputs: () => [],
  emptyDoc: () => ({ type: "doc", content: [] }),
  setReaderDecorations: vi.fn(),
}));

// Stub the selection hook so the test can drive the "live selection" directly:
// `position` stays null (no toolbar rendered in jsdom), and `location` reflects the
// hoisted `selectionLocation.current` so Split/Sub-extract have something to act on.
vi.mock("./useTextSelection", () => ({
  useTextSelection: () => ({
    position: null,
    location: h.selectionLocation.current,
    dismiss: vi.fn(),
  }),
}));

// The inspector refresh is a window event; stub it so it is a no-op in the test.
vi.mock("../components/inspector/Inspector", () => ({
  requestInspectorRefresh: vi.fn(),
}));

import { ExtractView } from "./ExtractView";

beforeEach(() => {
  vi.clearAllMocks();
  h.selectionLocation.current = null;
});

async function lineageNode(id: string): Promise<HTMLElement> {
  await screen.findByTestId("lineage-tree");
  const node = screen
    .getAllByTestId("lineage-tree-node")
    .find((row) => row.getAttribute("data-element-id") === id);
  expect(node).toBeDefined();
  return node as HTMLElement;
}

describe("ExtractView — stage stepper", () => {
  it("renders the three-step stepper for raw → clean → atomic", async () => {
    render(<ExtractView />);
    await screen.findByTestId("extract-stage-stepper");
    expect(screen.getByTestId("extract-stage-step-raw_extract")).toBeInTheDocument();
    expect(screen.getByTestId("extract-stage-step-clean_extract")).toBeInTheDocument();
    expect(screen.getByTestId("extract-stage-step-atomic_statement")).toBeInTheDocument();
  });

  it("advances the stage via extracts.updateStage when 'Advance stage' is clicked", async () => {
    render(<ExtractView />);
    const advance = await screen.findByTestId("extract-advance-stage");
    fireEvent.click(advance);
    await waitFor(() => expect(h.updateStage).toHaveBeenCalledTimes(1));
    // No explicit stage → advance one step from the current stage.
    expect(h.updateStage).toHaveBeenCalledWith({ id: "ex_1" });
  });

  it("sets an explicit stage when a stepper step is clicked", async () => {
    render(<ExtractView />);
    const step = await screen.findByTestId("extract-stage-step-atomic_statement");
    fireEvent.click(step);
    await waitFor(() => expect(h.updateStage).toHaveBeenCalledTimes(1));
    expect(h.updateStage).toHaveBeenCalledWith({ id: "ex_1", stage: "atomic_statement" });
  });
});

describe("ExtractView — source reference (T043)", () => {
  it("renders the source refblock with title/author/year + URL + location + snippet", async () => {
    render(<ExtractView />);
    const ref = await screen.findByTestId("extract-refblock");
    expect(ref).toBeInTheDocument();
    // The verbatim snippet (quote).
    expect(screen.getByTestId("extract-refblock-quote")).toHaveTextContent(
      "The definition paragraph two.",
    );
    // The assembled citation (author. title (year) · location).
    const cite = screen.getByTestId("extract-refblock-citation");
    expect(cite).toHaveTextContent("M. Walker");
    expect(cite).toHaveTextContent("On Sleep (2017)");
    expect(cite).toHaveTextContent("¶2");
    // The external URL link.
    expect(screen.getByTestId("extract-refblock-url")).toHaveAttribute(
      "href",
      "https://example.com/sleep",
    );
    // The jump-to-source affordance is wired (T022 reuse).
    expect(screen.getByTestId("extract-refblock-open-source")).toBeInTheDocument();
  });
});

describe("ExtractView — lineage navigation", () => {
  it("navigates source and extract lineage nodes to their dedicated views", async () => {
    render(<ExtractView />);

    fireEvent.click(await lineageNode("src_1"));
    expect(h.selectSpy).toHaveBeenCalledWith("src_1");
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src_1" } });

    fireEvent.click(await lineageNode("ex_2"));
    expect(h.selectSpy).toHaveBeenLastCalledWith("ex_2");
    expect(h.navigateSpy).toHaveBeenLastCalledWith({
      to: "/extract/$id",
      params: { id: "ex_2" },
    });
  });

  it("selects the current extract lineage node without re-navigating to the same route", async () => {
    render(<ExtractView />);

    fireEvent.click(await lineageNode("ex_1"));

    expect(h.selectSpy).toHaveBeenCalledWith("ex_1");
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("selects card lineage nodes in the inspector without starting a review session", async () => {
    render(<ExtractView />);

    fireEvent.click(await lineageNode("card_1"));

    expect(h.selectSpy).toHaveBeenCalledWith("card_1");
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });
});

describe("ExtractView — actions", () => {
  it("'Convert to card' opens the card builder (Q&A) instead of navigating away (T033)", async () => {
    render(<ExtractView />);
    const convert = await screen.findByTestId("extract-convert");
    fireEvent.click(convert);
    // The builder mounts as the third column on the Q&A tab.
    expect(await screen.findByTestId("card-builder")).toBeInTheDocument();
    expect(screen.getByTestId("cb-qa-front")).toBeInTheDocument();
    // Convert does NOT navigate away / touch the stage / create anything yet.
    expect(h.navigateSpy).not.toHaveBeenCalled();
    expect(h.updateStage).not.toHaveBeenCalled();
    expect(h.createCard).not.toHaveBeenCalled();
  });

  it("authoring a Q&A card in the builder calls cards.create with this extract's id (T033)", async () => {
    render(<ExtractView />);
    fireEvent.click(await screen.findByTestId("extract-convert"));
    await screen.findByTestId("card-builder");
    fireEvent.change(screen.getByTestId("cb-qa-front"), { target: { value: "Q?" } });
    fireEvent.change(screen.getByTestId("cb-qa-back"), { target: { value: "A." } });
    fireEvent.click(screen.getByTestId("cb-create"));
    await waitFor(() => expect(h.createCard).toHaveBeenCalledTimes(1));
    expect(h.createCard).toHaveBeenCalledWith(
      expect.objectContaining({ extractId: "ex_1", kind: "qa", prompt: "Q?", answer: "A." }),
    );
  });

  it("wires Trim → rewrite, Postpone, Mark done, and Delete to their commands", async () => {
    render(<ExtractView />);
    fireEvent.click(await screen.findByTestId("extract-trim"));
    await waitFor(() => expect(h.rewrite).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("extract-postpone"));
    await waitFor(() => expect(h.postpone).toHaveBeenCalledWith({ id: "ex_1" }));

    fireEvent.click(screen.getByTestId("extract-mark-done"));
    await waitFor(() => expect(h.markDone).toHaveBeenCalledWith({ id: "ex_1" }));

    fireEvent.click(screen.getByTestId("extract-delete"));
    await waitFor(() => expect(h.deleteExtract).toHaveBeenCalledWith({ id: "ex_1" }));
  });
});

describe("ExtractView — sub-extract (T025)", () => {
  beforeEach(() => {
    h.selectionLocation.current = null;
  });

  it("Sub-extract with a live selection calls extractions.create with parentId = this extract and sourceElementId = the source root", async () => {
    // Simulate text selected inside the extract body.
    h.selectionLocation.current = {
      selectedText: "definition paragraph two.",
      blockIds: ["blk_ex_1"],
      startOffset: 4,
      endOffset: 29,
    };
    render(<ExtractView />);
    fireEvent.click(await screen.findByTestId("extract-subextract"));
    await waitFor(() => expect(h.createExtraction).toHaveBeenCalledTimes(1));
    // Reuses the T021 command verbatim — only the ids differ: parent = THIS extract,
    // source root = the original source (so the sub-extract's source_id stays the root).
    expect(h.createExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceElementId: "src_1",
        parentId: "ex_1",
        selectedText: "definition paragraph two.",
        blockIds: ["blk_ex_1"],
        startOffset: 4,
        endOffset: 29,
      }),
    );
    // A sub-extract is NOT a stage transition and never touches the card builder.
    expect(h.updateStage).not.toHaveBeenCalled();
  });

  it("Split with a live selection also creates a sub-extract (same path)", async () => {
    h.selectionLocation.current = {
      selectedText: "definition paragraph two.",
      blockIds: ["blk_ex_1"],
      startOffset: 4,
      endOffset: 29,
    };
    render(<ExtractView />);
    fireEvent.click(await screen.findByTestId("extract-split"));
    await waitFor(() => expect(h.createExtraction).toHaveBeenCalledTimes(1));
    expect(h.createExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: "ex_1", sourceElementId: "src_1" }),
    );
  });

  it("Sub-extract with no live selection does not call extractions.create", async () => {
    h.selectionLocation.current = null;
    render(<ExtractView />);
    fireEvent.click(await screen.findByTestId("extract-subextract"));
    // Give any (incorrect) async path a tick — it must NOT fire the command.
    await new Promise((r) => setTimeout(r, 10));
    expect(h.createExtraction).not.toHaveBeenCalled();
  });
});

/**
 * ExtractView component tests (T024 — extract review mode).
 *
 * Covers the renderer seam the spec calls out:
 *  - the stage STEPPER renders the three steps (`raw_extract → clean_extract →
 *    atomic_statement`) and "Advance stage" calls `extracts.updateStage` (the
 *    main side persists the stage + reschedules on the attention scheduler);
 *  - clicking a specific step calls `extracts.updateStage` with that explicit
 *    stage;
 *  - "Convert to card" opens the in-workspace CardBuilder, while active card
 *    lineage clicks open an embedded card detail/editor surface;
 *  - Trim / Postpone / Mark done / Delete each invoke their `extracts.*` command.
 *
 * The heavy collaborators are mocked so the test exercises ONLY this component's
 * wiring: `@interleave/editor`'s `SourceEditor` is stubbed (no Tiptap/jsdom
 * contentEditable), the router params/navigation are mocked, and `window.appApi`
 * is a fake whose calls are asserted. No SQLite/IPC — the renderer is a pure UI
 * consumer here, exactly as the layering rules require.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  const reviewCardData = {
    id: "card_1",
    kind: "qa",
    prompt: "Why does sleep consolidate memories?",
    answer: "Because reactivation strengthens useful traces.",
    cloze: null,
    priority: 0.625,
    stage: "active_card",
    concept: "Sleep",
    sourceTitle: "On Sleep",
    sourceLocationLabel: "¶2",
    ref: "The definition paragraph two.",
    sourceRef: {
      sourceElementId: "src_1",
      sourceTitle: "On Sleep",
      url: "https://example.com/sleep",
      author: "M. Walker",
      publishedAt: "2017-10-03T00:00:00.000Z",
      locationLabel: "¶2",
      snippet: "The definition paragraph two.",
    },
    expiry: null,
    schedulerSignals: {
      kind: "fsrs",
      retrievability: 0.82,
      stability: 9.4,
      difficulty: 5,
      reps: 2,
      lapses: 0,
      fsrsState: "review",
    },
    leech: false,
    lapses: 0,
    flagged: false,
    siblingGroupId: null,
    occlusion: null,
    mediaRef: null,
    mediaSource: null,
    youtubeId: null,
  };
  const cardSummary = {
    id: "card_1",
    type: "card",
    status: "active",
    stage: "active_card",
    priority: 0.625,
    title: "Why does sleep consolidate memories?",
    kind: "qa",
    prompt: "Why does sleep consolidate memories?",
    answer: "Because reactivation strengthens useful traces.",
    cloze: null,
    parentId: "ex_1",
    sourceId: "src_1",
    flagged: false,
    leech: false,
    retired: false,
    deleted: false,
  };
  const lineageData = {
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
  };
  return {
    routeId: "ex_1",
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    inspectorData,
    reviewCardData,
    cardSummary,
    lineageData,
    getInspectorData: vi.fn().mockResolvedValue({ data: inspectorData }),
    getLineage: vi.fn().mockResolvedValue({ lineage: lineageData }),
    reviewCard: vi.fn().mockResolvedValue({ card: reviewCardData }),
    updateCard: vi.fn().mockResolvedValue({ card: cardSummary }),
    suspendCard: vi.fn().mockResolvedValue({ card: { ...cardSummary, status: "suspended" } }),
    deleteCard: vi.fn().mockResolvedValue({
      card: { ...cardSummary, status: "deleted", deleted: true },
    }),
    flagCard: vi.fn().mockResolvedValue({ card: { ...cardSummary, flagged: true } }),
    markLeechCard: vi.fn().mockResolvedValue({ card: { ...cardSummary, leech: true } }),
    retireCard: vi.fn().mockResolvedValue({ card: { ...cardSummary, retired: true } }),
    createTask: vi.fn().mockResolvedValue({}),
    updateStage: vi.fn().mockResolvedValue({
      extract: { ...inspectorData.element, stage: "clean_extract" },
    }),
    saveDocument: vi.fn().mockResolvedValue({
      document: {
        prosemirrorJson: { type: "doc", content: [] },
        plainText: "Edited full extract.",
        schemaVersion: 1,
        updatedAt: "",
      },
    }),
    rewrite: vi.fn().mockResolvedValue({ extract: inspectorData.element, plainText: "x" }),
    postpone: vi.fn().mockResolvedValue({ extract: inspectorData.element, postponeCount: 1 }),
    markDone: vi.fn().mockResolvedValue({ extract: inspectorData.element }),
    deleteExtract: vi.fn().mockResolvedValue({ extract: inspectorData.element }),
    setExtractFate: vi.fn().mockResolvedValue({
      extract: { ...inspectorData.element, status: "done", dueAt: null, extractFate: "reference" },
    }),
    reactivateExtractFate: vi.fn().mockResolvedValue({
      extract: { ...inspectorData.element, status: "scheduled", extractFate: null },
    }),
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
    highlightsState: {
      highlights: [],
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      error: null,
    },
    // The selection the toolbar/Split act on. `null` by default (no live selection);
    // tests override `current` to simulate a selection inside the extract body.
    selectionLocation: { current: null as null | Record<string, unknown> },
    selectionPosition: { current: null as null | { top: number; left: number } },
  };
});

// Mock the typed client wrapper used by the component.
vi.mock("../lib/appApi", () => ({
  isDesktop: () => true,
  appApi: {
    getInspectorData: h.getInspectorData,
    getLineage: h.getLineage,
    getDocument: vi.fn().mockResolvedValue({
      document: {
        prosemirrorJson: { type: "doc", content: [] },
        plainText: "body",
        schemaVersion: 1,
        updatedAt: "",
      },
      extractedBlockIds: [],
    }),
    saveDocument: h.saveDocument,
    updateExtractStage: h.updateStage,
    rewriteExtract: h.rewrite,
    postponeExtract: h.postpone,
    markExtractDone: h.markDone,
    deleteExtract: h.deleteExtract,
    setExtractFate: h.setExtractFate,
    reactivateExtractFate: h.reactivateExtractFate,
    createExtraction: h.createExtraction,
    createCard: h.createCard,
    reviewCard: h.reviewCard,
    updateCard: h.updateCard,
    suspendCard: h.suspendCard,
    deleteCard: h.deleteCard,
    flagCard: h.flagCard,
    markLeechCard: h.markLeechCard,
    retireCard: h.retireCard,
    createTask: h.createTask,
  },
}));

// Mock the router seams the component reaches (params + navigation).
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ id: h.routeId }),
  useNavigate: () => h.navigateSpy,
}));

vi.mock("../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
}));

// Stub the heavy Tiptap editor with a trivial element so the component renders
// without a real contentEditable. `toBlockInputs` is a no-op here.
vi.mock("@interleave/editor", () => ({
  SourceEditor: ({
    onChange,
  }: {
    onChange?: (change: { prosemirrorJson: unknown; plainText: string }) => void;
  }) => (
    <div className="reader" data-testid="mock-editor-reader">
      <textarea
        data-testid="mock-editor"
        defaultValue="body"
        onChange={(e) =>
          onChange?.({
            prosemirrorJson: { type: "doc", content: [], mockPlainText: e.target.value },
            plainText: e.target.value,
          })
        }
      />
    </div>
  ),
  toBlockInputs: () => [],
  toPlainText: (doc: { mockPlainText?: string } | null | undefined) => doc?.mockPlainText ?? "body",
  emptyDoc: () => ({ type: "doc", content: [] }),
  setReaderDecorations: vi.fn(),
  parseBodySegments: (body: string) => [{ kind: "text", content: body }],
  renderMathHtml: () => "",
  highlightCodeHtml: vi.fn().mockResolvedValue(""),
}));

// Stub the selection hook so the test can drive the "live selection" directly:
// `position` reflects the hoisted `selectionPosition.current`, and `location`
// reflects `selectionLocation.current` so Split / the selection toolbar have
// something to act on.
vi.mock("./useTextSelection", () => ({
  useTextSelection: () => ({
    position: h.selectionPosition.current,
    location: h.selectionLocation.current,
    dismiss: vi.fn(),
  }),
}));

vi.mock("../pages/source/useHighlights", () => ({
  useHighlights: () => h.highlightsState,
}));

// The inspector refresh is a window event; stub it so it is a no-op in the test.
vi.mock("../components/inspector/Inspector", () => ({
  requestInspectorRefresh: vi.fn(),
}));

import { hasActiveScope } from "../shell/activeScope";
import { ExtractView } from "./ExtractView";

beforeEach(() => {
  vi.clearAllMocks();
  h.routeId = "ex_1";
  h.selectionLocation.current = null;
  h.selectionPosition.current = null;
  h.getInspectorData.mockResolvedValue({ data: h.inspectorData });
  h.getLineage.mockResolvedValue({ lineage: h.lineageData });
  h.reviewCard.mockResolvedValue({ card: h.reviewCardData });
  h.updateCard.mockResolvedValue({ card: h.cardSummary });
  h.suspendCard.mockResolvedValue({ card: { ...h.cardSummary, status: "suspended" } });
  h.deleteCard.mockResolvedValue({
    card: { ...h.cardSummary, status: "deleted", deleted: true },
  });
  h.flagCard.mockResolvedValue({ card: { ...h.cardSummary, flagged: true } });
  h.markLeechCard.mockResolvedValue({ card: { ...h.cardSummary, leech: true } });
  h.retireCard.mockResolvedValue({ card: { ...h.cardSummary, retired: true } });
  h.createTask.mockResolvedValue({});
  h.setExtractFate.mockResolvedValue({
    extract: { ...h.inspectorData.element, status: "done", dueAt: null, extractFate: "reference" },
  });
  h.reactivateExtractFate.mockResolvedValue({
    extract: { ...h.inspectorData.element, status: "scheduled", extractFate: null },
  });
});

async function lineageNode(id: string): Promise<HTMLElement> {
  await screen.findByTestId("lineage-tree");
  const node = screen
    .getAllByTestId("lineage-tree-node")
    .find((row) => row.getAttribute("data-element-id") === id);
  expect(node).toBeDefined();
  return node as HTMLElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "m"));
  return match?.groups?.body ?? "";
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

describe("ExtractView — distillation layout", () => {
  it("keeps editor prose, footer, actions, and AI assistance in non-overlapping order", async () => {
    render(<ExtractView />);

    const distill = await screen.findByTestId("extract-distill");
    const reader = await screen.findByTestId("mock-editor-reader");
    const meta = screen.getByText("aim for a single, self-contained idea");
    const actions = screen.getByTestId("extract-trim").closest(".extract-actions");
    const ai = await screen.findByText(/AI assistance/i).then((node) => node.closest(".ai-assist"));
    if (!(actions instanceof HTMLElement) || !(ai instanceof HTMLElement)) {
      throw new Error("extract distillation controls changed structure");
    }

    expect(distill).toContainElement(reader);
    expect(distill).toContainElement(meta);
    expect(distill).toContainElement(actions);
    expect(distill).toContainElement(ai);
    expect(reader.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(meta.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions.compareDocumentPosition(ai) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("bounds the extract reader as the scrollable region instead of the action footer", () => {
    const css = readFileSync(resolve(import.meta.dirname, "extract-view.css"), "utf8");

    expect(cssRule(css, ".extract-distill")).toContain("overflow-y: auto");
    expect(cssRule(css, ".extract-editor")).toContain("display: flex");
    expect(cssRule(css, ".extract-editor")).toContain("overflow: hidden");
    expect(cssRule(css, ".extract-editor .reader")).toContain("overflow-y: auto");
    expect(cssRule(css, ".extract-editor__meta")).toContain("flex: none");
    expect(cssRule(css, ".extract-actions")).toContain("flex: none");
    expect(cssRule(css, ".ai-assist")).toContain("flex: none");
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

  it("opens card lineage nodes as an embedded revealed card editor without navigating away", async () => {
    render(<ExtractView />);
    fireEvent.click(await screen.findByTestId("extract-convert"));
    expect(await screen.findByTestId("card-builder")).toBeInTheDocument();

    fireEvent.click(await lineageNode("card_1"));

    await waitFor(() => expect(h.reviewCard).toHaveBeenCalledWith({ cardId: "card_1" }));
    expect(h.navigateSpy).not.toHaveBeenCalled();
    expect(screen.queryByTestId("card-builder")).not.toBeInTheDocument();
    expect(screen.queryByTestId("extract-distill")).not.toBeInTheDocument();
    expect(await screen.findByTestId("extract-card-detail")).toBeInTheDocument();
    expect(screen.getByTestId("card-detail")).toHaveAttribute("data-card-id", "card_1");
    expect(screen.getByTestId("fsrs-stats")).toBeInTheDocument();
    expect(await screen.findByTestId("card-answer")).toHaveTextContent(
      "Because reactivation strengthens useful traces.",
    );
    expect(screen.getByTestId("card-refblock")).toBeInTheDocument();
    expect(screen.getByTestId("review-repair-edit")).toBeInTheDocument();
    expect(screen.getByTestId("review-repair-source")).toBeEnabled();
    expect(screen.getByTestId("review-repair-context")).toBeEnabled();
    expect(await lineageNode("card_1")).toHaveAttribute("data-active", "true");
    await waitFor(() => expect(h.selectSpy).toHaveBeenCalledWith("card_1"));

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Edited sleep prompt?" } });
    const answer = screen.getByTestId("review-edit-answer");
    fireEvent.change(answer, { target: { value: "Edited sleep answer." } });
    fireEvent.blur(answer);

    await waitFor(() =>
      expect(h.updateCard).toHaveBeenCalledWith({
        cardId: "card_1",
        prompt: "Edited sleep prompt?",
        answer: "Edited sleep answer.",
      }),
    );

    fireEvent.click(screen.getByTestId("extract-card-back"));

    expect(await screen.findByTestId("extract-distill")).toBeInTheDocument();
    expect(screen.queryByTestId("extract-card-detail")).not.toBeInTheDocument();
    expect(h.selectSpy).toHaveBeenLastCalledWith("ex_1");
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("keeps hidden card selection cleared while an embedded card detail is still loading", async () => {
    const load = deferred<{ card: typeof h.reviewCardData }>();
    h.reviewCard.mockReturnValueOnce(load.promise);
    render(<ExtractView />);

    fireEvent.click(await lineageNode("card_1"));
    await screen.findByTestId("card-loading");

    expect(h.selectSpy).toHaveBeenLastCalledWith(null);
    expect(h.selectSpy).not.toHaveBeenCalledWith("card_1");
    expect(hasActiveScope()).toBe(false);

    load.resolve({ card: h.reviewCardData });
    await screen.findByTestId("card-detail");
    await waitFor(() => expect(h.selectSpy).toHaveBeenCalledWith("card_1"));
  });

  it("closes the embedded source drawer and clears selection when the answer is hidden", async () => {
    render(<ExtractView />);

    fireEvent.click(await lineageNode("card_1"));
    await screen.findByTestId("card-detail");
    fireEvent.click(screen.getByTestId("review-repair-context"));
    expect(await screen.findByTestId("review-context-drawer")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("card-hide"));

    await waitFor(() =>
      expect(screen.queryByTestId("review-context-drawer")).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId("card-answer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-repair-edit")).not.toBeInTheDocument();
    await waitFor(() => expect(h.selectSpy).toHaveBeenLastCalledWith(null));
    await waitFor(() => expect(hasActiveScope()).toBe(true));
  });

  it("closes the embedded card and refreshes lineage when a repair action removes it", async () => {
    render(<ExtractView />);

    fireEvent.click(await lineageNode("card_1"));
    await screen.findByTestId("card-detail");
    await screen.findByTestId("review-repair-suspend");
    h.getLineage.mockClear();
    h.getInspectorData.mockClear();

    fireEvent.click(screen.getByTestId("review-repair-suspend"));

    await waitFor(() => expect(h.suspendCard).toHaveBeenCalledWith({ cardId: "card_1" }));
    expect(await screen.findByTestId("extract-distill")).toBeInTheDocument();
    expect(screen.queryByTestId("extract-card-detail")).not.toBeInTheDocument();
    expect(h.selectSpy).toHaveBeenLastCalledWith("ex_1");
    expect(h.getLineage).toHaveBeenCalledWith({ id: "ex_1" });
    expect(h.getInspectorData).toHaveBeenCalledWith({ id: "ex_1" });
  });

  it("clears embedded card selection when the extract route id changes", async () => {
    const view = render(<ExtractView />);

    fireEvent.click(await lineageNode("card_1"));
    await screen.findByTestId("card-detail");
    await waitFor(() => expect(h.selectSpy).toHaveBeenCalledWith("card_1"));

    h.routeId = "ex_2";
    view.rerender(<ExtractView />);

    await waitFor(() =>
      expect(screen.queryByTestId("extract-card-detail")).not.toBeInTheDocument(),
    );
    expect(await screen.findByTestId("extract-distill")).toBeInTheDocument();
    expect(h.selectSpy).toHaveBeenLastCalledWith("ex_2");
  });

  it("clears an embedded card before navigating to another extract lineage node", async () => {
    render(<ExtractView />);

    fireEvent.click(await lineageNode("card_1"));
    await screen.findByTestId("card-detail");

    fireEvent.click(await lineageNode("ex_2"));

    expect(screen.queryByTestId("extract-card-detail")).not.toBeInTheDocument();
    expect(await screen.findByTestId("extract-distill")).toBeInTheDocument();
    expect(h.selectSpy).toHaveBeenLastCalledWith("ex_2");
    expect(h.navigateSpy).toHaveBeenLastCalledWith({
      to: "/extract/$id",
      params: { id: "ex_2" },
    });
  });

  it("ignores stale extract reload responses after a newer route load wins", async () => {
    const staleInspectorLoad = deferred<{ data: typeof h.inspectorData }>();
    const staleLineageLoad = deferred<{ lineage: typeof h.lineageData }>();
    const staleInspector = {
      ...h.inspectorData,
      element: { ...h.inspectorData.element, title: "Stale extract" },
    };
    const staleLineage = {
      ...h.lineageData,
      nodes: [
        ...h.lineageData.nodes,
        {
          id: "stale_card",
          type: "card",
          title: "Stale card",
          stage: "active_card",
          depth: 2,
          meta: "stale",
          active: false,
        },
      ],
    };
    const freshInspector = {
      ...h.inspectorData,
      element: { ...h.inspectorData.element, id: "ex_2", title: "Fresh extract" },
    };
    const freshLineage = {
      ...h.lineageData,
      elementId: "ex_2",
      nodes: [
        h.lineageData.nodes[0],
        {
          id: "ex_2",
          type: "extract",
          title: "Fresh extract",
          stage: "raw_extract",
          depth: 1,
          meta: "this",
          active: true,
        },
        {
          id: "fresh_card",
          type: "card",
          title: "Fresh card",
          stage: "active_card",
          depth: 2,
          meta: "fresh",
          active: false,
        },
      ],
    };
    h.getInspectorData
      .mockReturnValueOnce(staleInspectorLoad.promise)
      .mockResolvedValueOnce({ data: freshInspector });
    h.getLineage
      .mockReturnValueOnce(staleLineageLoad.promise)
      .mockResolvedValueOnce({ lineage: freshLineage });

    const view = render(<ExtractView />);
    h.routeId = "ex_2";
    view.rerender(<ExtractView />);

    await waitFor(() =>
      expect(screen.getByTestId("extract-title")).toHaveTextContent("Fresh extract"),
    );
    expect(await lineageNode("fresh_card")).toBeInTheDocument();

    staleInspectorLoad.resolve({ data: staleInspector });
    staleLineageLoad.resolve({ lineage: staleLineage });
    await staleInspectorLoad.promise;
    await staleLineageLoad.promise;
    await Promise.resolve();

    expect(screen.getByTestId("extract-title")).toHaveTextContent("Fresh extract");
    expect(screen.queryByText("Stale extract")).not.toBeInTheDocument();
    expect(screen.queryByText("Stale card")).not.toBeInTheDocument();
  });

  it("ignores stale removal completion when another embedded card is already open", async () => {
    const cardTwo = {
      ...h.reviewCardData,
      id: "card_2",
      prompt: "What does card two ask?",
      answer: "The second card answer.",
    };
    h.getLineage.mockResolvedValue({
      lineage: {
        ...h.lineageData,
        nodes: [
          ...h.lineageData.nodes,
          {
            id: "card_2",
            type: "card",
            title: "Second linked card",
            stage: "active_card",
            depth: 2,
            meta: "active_card",
            active: false,
          },
        ],
      },
    });
    h.reviewCard.mockImplementation(({ cardId }: { cardId: string }) =>
      Promise.resolve({ card: cardId === "card_2" ? cardTwo : h.reviewCardData }),
    );
    const removal = deferred<{ card: typeof h.cardSummary }>();
    h.suspendCard.mockReturnValueOnce(removal.promise);
    render(<ExtractView />);

    fireEvent.click(await lineageNode("card_1"));
    await screen.findByTestId("card-detail");
    fireEvent.click(screen.getByTestId("review-repair-suspend"));
    await waitFor(() => expect(h.suspendCard).toHaveBeenCalledWith({ cardId: "card_1" }));

    fireEvent.click(await lineageNode("card_2"));
    await waitFor(() =>
      expect(screen.getByTestId("card-detail")).toHaveAttribute("data-card-id", "card_2"),
    );
    h.getLineage.mockClear();

    removal.resolve({ card: h.cardSummary });
    await removal.promise;
    await Promise.resolve();

    expect(screen.getByTestId("card-detail")).toHaveAttribute("data-card-id", "card_2");
    expect(screen.queryByTestId("extract-distill")).not.toBeInTheDocument();
    expect(h.getLineage).not.toHaveBeenCalled();
  });
});

describe("ExtractView — actions", () => {
  it("autosaves edited extract text through documents.save without a Save button", async () => {
    render(<ExtractView />);
    const editor = await screen.findByTestId("mock-editor");

    expect(screen.queryByTestId("extract-rewrite")).not.toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "Edited full extract." } });

    await waitFor(
      () =>
        expect(h.saveDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            elementId: "ex_1",
            plainText: "Edited full extract.",
          }),
        ),
      { timeout: 1200 },
    );
    expect(h.rewrite).not.toHaveBeenCalled();
  });

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

  it("sets honorable extract fates and can reactivate a fated extract", async () => {
    const fatedInspector = {
      ...h.inspectorData,
      element: {
        ...h.inspectorData.element,
        status: "done",
        dueAt: null,
        extractFate: "reference",
      },
    };
    h.getInspectorData.mockResolvedValue({ data: fatedInspector });

    render(<ExtractView />);

    expect(await screen.findByTestId("extract-fate-controls")).toBeInTheDocument();
    expect(screen.getByTestId("extract-fate-current")).toHaveTextContent("Reference");

    fireEvent.click(screen.getByTestId("extract-fate-done-without-card"));
    await waitFor(() =>
      expect(h.setExtractFate).toHaveBeenCalledWith({
        id: "ex_1",
        fate: "done_without_card",
      }),
    );

    fireEvent.click(screen.getByTestId("extract-fate-reactivate"));
    await waitFor(() => expect(h.reactivateExtractFate).toHaveBeenCalledWith({ id: "ex_1" }));
  });

  it("does not render a redundant static Sub-extract action button", async () => {
    render(<ExtractView />);
    await screen.findByTestId("extract-split");

    expect(screen.queryByTestId("extract-subextract")).not.toBeInTheDocument();
  });
});

describe("ExtractView — sub-extract (T025)", () => {
  beforeEach(() => {
    h.selectionLocation.current = null;
  });

  it("selection-toolbar Sub-extract calls extractions.create with parentId = this extract and sourceElementId = the source root", async () => {
    // Simulate text selected inside the extract body.
    h.selectionLocation.current = {
      selectedText: "definition paragraph two.",
      blockIds: ["blk_ex_1"],
      startOffset: 4,
      endOffset: 29,
    };
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ExtractView />);
    fireEvent.click(await screen.findByTestId("sel-tool-extract"));
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

  it("shows extract-specific selection actions including Highlight", async () => {
    h.selectionLocation.current = {
      selectedText: "definition paragraph two.",
      blockIds: ["blk_ex_1"],
      startOffset: 4,
      endOffset: 29,
    };
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ExtractView />);

    await screen.findByTestId("selection-toolbar");
    expect(screen.getByTestId("sel-tool-extract")).toHaveTextContent("Sub-extract");
    expect(screen.getByTestId("sel-tool-cloze")).toHaveTextContent("Cloze");
    expect(screen.getByTestId("sel-tool-highlight")).toHaveTextContent("Highlight");
    expect(screen.getByTestId("sel-tool-copy")).toHaveTextContent("Copy");
  });

  it("highlights selected extract text through document marks", async () => {
    const location = {
      selectedText: "definition paragraph two.",
      blockIds: ["blk_ex_1"],
      startOffset: 4,
      endOffset: 29,
    };
    h.selectionLocation.current = location;
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ExtractView />);

    fireEvent.click(await screen.findByTestId("sel-tool-highlight"));

    await waitFor(() => expect(h.highlightsState.add).toHaveBeenCalledWith(location));
  });

  it("highlights selected extract text from the H keyboard shortcut", async () => {
    const location = {
      selectedText: "definition paragraph two.",
      blockIds: ["blk_ex_1"],
      startOffset: 4,
      endOffset: 29,
    };
    h.selectionLocation.current = location;
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ExtractView />);
    await screen.findByTestId("selection-toolbar");

    fireEvent.keyDown(window, { key: "h" });

    await waitFor(() => expect(h.highlightsState.add).toHaveBeenCalledWith(location));
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

  it("does not create a sub-extract from stale lineage while a new route inspector is loading", async () => {
    const pendingInspector = deferred<{ data: typeof h.inspectorData }>();
    const pendingLineage = deferred<{ lineage: typeof h.lineageData }>();
    const freshInspector = {
      ...h.inspectorData,
      element: { ...h.inspectorData.element, id: "ex_2", title: "Fresh extract" },
      source: { ...h.inspectorData.source, id: "src_2" },
      location: { ...h.inspectorData.location, sourceElementId: "src_2", blockIds: ["blk_ex_2"] },
    };
    const freshLineage = {
      ...h.lineageData,
      elementId: "ex_2",
      rootId: "src_2",
      nodes: h.lineageData.nodes.map((node) =>
        node.id === "ex_1"
          ? { ...node, id: "ex_2", title: "Fresh extract" }
          : node.id === "src_1"
            ? { ...node, id: "src_2" }
            : node,
      ),
    };
    h.getInspectorData
      .mockResolvedValueOnce({ data: h.inspectorData })
      .mockReturnValueOnce(pendingInspector.promise);
    h.getLineage
      .mockResolvedValueOnce({ lineage: h.lineageData })
      .mockReturnValueOnce(pendingLineage.promise);
    h.selectionLocation.current = {
      selectedText: "fresh selection",
      blockIds: ["blk_ex_2"],
      startOffset: 0,
      endOffset: 15,
    };
    const view = render(<ExtractView />);
    await waitFor(() =>
      expect(screen.getByTestId("extract-title")).toHaveTextContent("A clean idea"),
    );

    h.routeId = "ex_2";
    view.rerender(<ExtractView />);
    await waitFor(() => expect(h.selectSpy).toHaveBeenLastCalledWith("ex_2"));
    fireEvent.click(await screen.findByTestId("extract-split"));
    await new Promise((r) => setTimeout(r, 10));

    expect(h.createExtraction).not.toHaveBeenCalled();

    pendingInspector.resolve({ data: freshInspector });
    pendingLineage.resolve({ lineage: freshLineage });
    await waitFor(() =>
      expect(screen.getByTestId("extract-title")).toHaveTextContent("Fresh extract"),
    );

    fireEvent.click(screen.getByTestId("extract-split"));

    await waitFor(() => expect(h.createExtraction).toHaveBeenCalledTimes(1));
    expect(h.createExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: "ex_2", sourceElementId: "src_2" }),
    );
  });

  it("Split with no live selection does not call extractions.create", async () => {
    h.selectionLocation.current = null;
    render(<ExtractView />);
    fireEvent.click(await screen.findByTestId("extract-split"));
    // Give any (incorrect) async path a tick — it must NOT fire the command.
    await new Promise((r) => setTimeout(r, 10));
    expect(h.createExtraction).not.toHaveBeenCalled();
  });
});

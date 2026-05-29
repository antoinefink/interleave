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
    review: null,
  };
  return {
    navigateSpy: vi.fn(),
    inspectorData,
    updateStage: vi.fn().mockResolvedValue({
      extract: { ...inspectorData.element, stage: "clean_extract" },
    }),
    rewrite: vi.fn().mockResolvedValue({ extract: inspectorData.element, plainText: "x" }),
    postpone: vi.fn().mockResolvedValue({ extract: inspectorData.element, postponeCount: 1 }),
    markDone: vi.fn().mockResolvedValue({ extract: inspectorData.element }),
    deleteExtract: vi.fn().mockResolvedValue({ extract: inspectorData.element }),
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
  },
}));

// Mock the router seams the component reaches (params + navigation).
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ id: "ex_1" }),
  useNavigate: () => h.navigateSpy,
}));

// Stub the heavy Tiptap editor with a trivial element so the component renders
// without a real contentEditable. `toBlockInputs` is a no-op here.
vi.mock("@interleave/editor", () => ({
  SourceEditor: () => <div data-testid="mock-editor" />,
  toBlockInputs: () => [],
  emptyDoc: () => ({ type: "doc", content: [] }),
}));

// The inspector refresh is a window event; stub it so it is a no-op in the test.
vi.mock("../components/inspector/Inspector", () => ({
  requestInspectorRefresh: vi.fn(),
}));

import { ExtractView } from "./ExtractView";

beforeEach(() => {
  vi.clearAllMocks();
});

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

describe("ExtractView — actions", () => {
  it("routes 'Convert to card' to the M6 placeholder (/review)", async () => {
    render(<ExtractView />);
    const convert = await screen.findByTestId("extract-convert");
    fireEvent.click(convert);
    await waitFor(() => expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/review" }));
    // Convert does NOT create a card / touch the stage.
    expect(h.updateStage).not.toHaveBeenCalled();
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

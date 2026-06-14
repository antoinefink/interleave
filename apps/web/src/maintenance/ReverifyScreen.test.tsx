import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ReverifyFlaggedSourcesResult,
  ReverifyResolveResult,
  ReverifySessionItem,
  ReverifySessionPreview,
  ReverifyUndoResult,
} from "../lib/appApi";

const h = vi.hoisted(() => ({
  flaggedSources: vi.fn(),
  sessionPreview: vi.fn(),
  resolve: vi.fn(),
  undoReceipt: vi.fn(),
  search: { current: {} as { source?: string } },
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      reverifyFlaggedSources: h.flaggedSources,
      reverifySessionPreview: h.sessionPreview,
      reverifyResolve: h.resolve,
      reverifyUndoReceipt: h.undoReceipt,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => h.search.current,
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import { ReverifyScreen } from "./ReverifyScreen";

function item(over: Partial<ReverifySessionItem> = {}): ReverifySessionItem {
  return {
    elementId: "ext-1",
    type: "extract",
    stage: "clean_extract",
    title: "An extract",
    stableBlockId: "blk-1",
    oldAnchorText: "the cat sat",
    currentBlockText: "the dog sat",
    fingerprint: "fp-1",
    ...over,
  };
}

function flagged(sources = [{ sourceElementId: "src-1", title: "A source", count: 1 }]) {
  return {
    totalOutputs: sources.reduce((n, s) => n + s.count, 0),
    sources,
  } as ReverifyFlaggedSourcesResult;
}

function preview(items: ReverifySessionItem[], remaining = 0): ReverifySessionPreview {
  return {
    sourceElementId: "src-1",
    asOf: "2026-06-14T00:00:00.000Z",
    expiresAt: "2026-06-14T01:00:00.000Z",
    cap: 25,
    remaining,
    items,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.search.current = {};
  h.flaggedSources.mockResolvedValue(flagged());
  h.sessionPreview.mockResolvedValue(preview([item()]));
  h.resolve.mockResolvedValue({
    batchId: "batch-1",
    applied: 1,
    skipped: [],
    receipt: null,
  } satisfies ReverifyResolveResult);
  h.undoReceipt.mockResolvedValue({
    undone: true,
    count: 1,
    skipped: [],
    receipt: null,
  } satisfies ReverifyUndoResult);
});

describe("ReverifyScreen", () => {
  it("renders a per-source group with the old→new diff and the flagged item", async () => {
    const { findByTestId, getByTestId } = render(<ReverifyScreen />);
    await findByTestId("reverify-group");
    expect(getByTestId("reverify-diff")).toBeInTheDocument();
    // The diff marks the deletion (cat) and insertion (dog).
    expect(
      getByTestId("reverify-diff").querySelector('[data-diff="delete"]')?.textContent,
    ).toContain("cat");
    expect(
      getByTestId("reverify-diff").querySelector('[data-diff="insert"]')?.textContent,
    ).toContain("dog");
    expect(getByTestId("reverify-item")).toBeInTheDocument();
  });

  it("fires a confirm decision immediately and shows an undo snackbar", async () => {
    const { findByTestId, getByTestId, queryByTestId } = render(<ReverifyScreen />);
    fireEvent.click(await findByTestId("reverify-confirm"));
    await waitFor(() => expect(h.resolve).toHaveBeenCalledTimes(1));
    expect(h.resolve).toHaveBeenCalledWith({
      sourceElementId: "src-1",
      decisions: [
        { elementId: "ext-1", stableBlockId: "blk-1", verb: "confirm", fingerprint: "fp-1" },
      ],
    });
    // Item drops optimistically; undo snackbar appears.
    await waitFor(() => expect(queryByTestId("reverify-item")).toBeNull());
    expect(getByTestId("reverify-snackbar")).toBeInTheDocument();
    expect(getByTestId("reverify-snackbar-undo")).toBeInTheDocument();
  });

  it("bulk-confirms all visible items in one batch", async () => {
    h.sessionPreview.mockResolvedValue(preview([item(), item({ elementId: "ext-2", title: "B" })]));
    h.flaggedSources.mockResolvedValue(
      flagged([{ sourceElementId: "src-1", title: "A source", count: 2 }]),
    );
    const { findByTestId } = render(<ReverifyScreen />);
    fireEvent.click(await findByTestId("reverify-bulk-confirm"));
    await waitFor(() => expect(h.resolve).toHaveBeenCalledTimes(1));
    expect(h.resolve.mock.calls[0]?.[0]?.decisions).toHaveLength(2);
  });

  it("rebase and detach fire the right verbs", async () => {
    const { findByTestId, getByTestId } = render(<ReverifyScreen />);
    await findByTestId("reverify-item");
    fireEvent.click(getByTestId("reverify-rebase"));
    await waitFor(() => expect(h.resolve).toHaveBeenCalled());
    expect(h.resolve.mock.calls[0]?.[0]?.decisions?.[0]?.verb).toBe("rebase");
  });

  it("shows the resume affordance when the source has more than the cap", async () => {
    h.sessionPreview.mockResolvedValue(preview([item()], 12));
    const { findByTestId } = render(<ReverifyScreen />);
    const resume = await findByTestId("reverify-resume");
    expect(resume.textContent).toContain("12 more");
  });

  it("keeps a skipped item with an inline badge after a partial batch", async () => {
    h.resolve.mockResolvedValue({
      batchId: "batch-1",
      applied: 0,
      skipped: [{ elementId: "ext-1", reason: "block-re-edited" }],
      receipt: null,
    } satisfies ReverifyResolveResult);
    const { findByTestId, getByTestId } = render(<ReverifyScreen />);
    fireEvent.click(await findByTestId("reverify-confirm"));
    await findByTestId("reverify-skip");
    expect(getByTestId("reverify-skip").textContent).toContain("Re-edited");
  });

  it("shows the refusal reason (no Undo) when undoReceipt refuses", async () => {
    h.undoReceipt.mockResolvedValue({
      undone: false,
      count: 0,
      reason: "Source changed since",
      skipped: [],
      receipt: null,
    } satisfies ReverifyUndoResult);
    const { findByTestId, getByTestId, queryByTestId } = render(<ReverifyScreen />);
    fireEvent.click(await findByTestId("reverify-confirm"));
    fireEvent.click(await findByTestId("reverify-snackbar-undo"));
    await waitFor(() =>
      expect(getByTestId("reverify-snackbar").textContent).toContain("Source changed since"),
    );
    // Terminal: no Undo button on the refusal toast.
    expect(queryByTestId("reverify-snackbar-undo")).toBeNull();
  });

  it("renders the empty state when nothing is flagged", async () => {
    h.flaggedSources.mockResolvedValue(flagged([]));
    const { findByTestId } = render(<ReverifyScreen />);
    expect(await findByTestId("reverify-empty")).toBeInTheDocument();
  });
});

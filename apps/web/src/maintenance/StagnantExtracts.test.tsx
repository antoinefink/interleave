/**
 * StagnantExtracts component tests (T084).
 *
 * The detection lives MAIN-side (`ExtractStagnationQuery` + the pure
 * `@interleave/scheduler` `isStagnant`); this asserts the RENDERER seam of the
 * maintenance view:
 *  - the rows load from `appApi.getExtractStagnation()` and render the title,
 *    reasons, postpone count, and the suggested action highlighted;
 *  - Rewrite + Convert OPEN the extract editor (`/extract/$id`);
 *  - Postpone calls `appApi.postponeExtract` and removes the row;
 *  - Delete calls `appApi.deleteExtract` and removes the row;
 *  - an empty payload shows the calm empty state.
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring; no
 * SQLite/IPC — the renderer is a pure UI consumer + command invoker here.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractStagnationListResult, StagnantExtractRow } from "../lib/appApi";

const h = vi.hoisted(() => {
  const rewriteRow: StagnantExtractRow = {
    extract: {
      id: "ex-rewrite",
      title: "A raw, half-formed thought",
      stage: "raw_extract",
      priority: 0.6,
      dueAt: "2026-06-10T00:00:00.000Z",
      createdAt: "2026-04-01T00:00:00.000Z",
    },
    postponeCount: 5,
    childCount: 0,
    daysSinceProgress: 61,
    reasons: ["postponed-repeatedly", "no-progress", "no-children", "stale"],
    suggestion: "rewrite",
  };
  const convertRow: StagnantExtractRow = {
    extract: {
      id: "ex-convert",
      title: "A cleaned-up but unconverted idea",
      stage: "clean_extract",
      priority: 0.85,
      dueAt: "2026-06-12T00:00:00.000Z",
      createdAt: "2026-04-05T00:00:00.000Z",
    },
    postponeCount: 3,
    childCount: 0,
    daysSinceProgress: 40,
    reasons: ["postponed-repeatedly", "no-progress", "no-children", "stale"],
    suggestion: "convert",
  };
  const result: ExtractStagnationListResult = {
    asOf: "2026-06-01T12:00:00.000Z",
    rows: [rewriteRow, convertRow],
    stagnantCount: 2,
  };
  return {
    rewriteRow,
    convertRow,
    result,
    getExtractStagnation: vi.fn(),
    postponeExtract: vi.fn(),
    deleteExtract: vi.fn(),
    setExtractFate: vi.fn(),
    reactivateExtractFate: vi.fn(),
    navigate: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
  useSearch: () => ({}),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      getExtractStagnation: h.getExtractStagnation,
      postponeExtract: h.postponeExtract,
      deleteExtract: h.deleteExtract,
      setExtractFate: h.setExtractFate,
      reactivateExtractFate: h.reactivateExtractFate,
    },
  };
});

import { StagnantExtracts } from "./StagnantExtracts";

beforeEach(() => {
  vi.clearAllMocks();
  h.getExtractStagnation.mockResolvedValue(h.result);
  h.postponeExtract.mockResolvedValue({});
  h.deleteExtract.mockResolvedValue({});
  h.setExtractFate.mockResolvedValue({});
  h.reactivateExtractFate.mockResolvedValue({});
});

describe("StagnantExtracts", () => {
  it("renders the stagnant rows with reasons, postpone count, and the suggestion", async () => {
    render(<StagnantExtracts />);
    await waitFor(() => expect(screen.getAllByTestId("stagnant-row")).toHaveLength(2));

    expect(screen.getByTestId("stagnant-count").textContent).toContain("2 stagnant");

    const row = screen.getByText("A raw, half-formed thought").closest("[data-extract-id]");
    expect(row).not.toBeNull();
    if (row) {
      expect(within(row as HTMLElement).getByTestId("stagnant-postpones").textContent).toContain(
        "×5",
      );
      const reasons = within(row as HTMLElement).getByTestId("stagnant-reasons");
      expect(reasons.textContent).toContain("Postponed repeatedly");
      expect(reasons.textContent).toContain("No progress");
      expect(within(row as HTMLElement).getByTestId("stagnant-suggestion").textContent).toContain(
        "Rewrite",
      );
    }
  });

  it("highlights the suggested action (rewrite row → Rewrite button is suggested)", async () => {
    render(<StagnantExtracts />);
    await waitFor(() => expect(screen.getAllByTestId("stagnant-row")).toHaveLength(2));

    const row = screen.getByText("A raw, half-formed thought").closest("[data-extract-id]");
    expect(row).not.toBeNull();
    if (row) {
      const rewriteBtn = within(row as HTMLElement).getByTestId("stagnant-rewrite");
      expect(rewriteBtn.className).toContain("se-btn--suggested");
      // The other buttons are NOT highlighted.
      expect(within(row as HTMLElement).getByTestId("stagnant-delete").className).not.toContain(
        "se-btn--suggested",
      );
    }
  });

  it("opens the extract editor on Rewrite and Convert", async () => {
    render(<StagnantExtracts />);
    await waitFor(() => expect(screen.getAllByTestId("stagnant-row")).toHaveLength(2));

    const rewriteRow = screen.getByText("A raw, half-formed thought").closest("[data-extract-id]");
    if (rewriteRow) {
      fireEvent.click(within(rewriteRow as HTMLElement).getByTestId("stagnant-rewrite"));
      expect(h.navigate).toHaveBeenCalledWith({
        to: "/extract/$id",
        params: { id: "ex-rewrite" },
      });
    }

    const convertRow = screen
      .getByText("A cleaned-up but unconverted idea")
      .closest("[data-extract-id]");
    if (convertRow) {
      fireEvent.click(within(convertRow as HTMLElement).getByTestId("stagnant-convert"));
      expect(h.navigate).toHaveBeenCalledWith({
        to: "/extract/$id",
        params: { id: "ex-convert" },
      });
    }
  });

  it("postpones via the existing extracts.postpone command and removes the row", async () => {
    render(<StagnantExtracts />);
    await waitFor(() => expect(screen.getAllByTestId("stagnant-row")).toHaveLength(2));

    const row = screen.getByText("A raw, half-formed thought").closest("[data-extract-id]");
    if (row) {
      fireEvent.click(within(row as HTMLElement).getByTestId("stagnant-postpone"));
      await waitFor(() => expect(h.postponeExtract).toHaveBeenCalledWith({ id: "ex-rewrite" }));
      await waitFor(() => expect(screen.getAllByTestId("stagnant-row")).toHaveLength(1));
    }
  });

  it("deletes via the existing extracts.delete command and removes the row", async () => {
    render(<StagnantExtracts />);
    await waitFor(() => expect(screen.getAllByTestId("stagnant-row")).toHaveLength(2));

    const row = screen.getByText("A cleaned-up but unconverted idea").closest("[data-extract-id]");
    if (row) {
      fireEvent.click(within(row as HTMLElement).getByTestId("stagnant-delete"));
      await waitFor(() => expect(h.deleteExtract).toHaveBeenCalledWith({ id: "ex-convert" }));
      await waitFor(() => expect(screen.getAllByTestId("stagnant-row")).toHaveLength(1));
    }
  });

  it("keeps a stagnant extract as reference when supported", async () => {
    const referenceRow = {
      ...h.rewriteRow,
      extract: { ...h.rewriteRow.extract, id: "ex-ref", extractFate: null },
      suggestion: "keep_as_reference",
    } as unknown as StagnantExtractRow;
    h.getExtractStagnation.mockResolvedValue({
      asOf: "x",
      rows: [referenceRow],
      stagnantCount: 1,
    });

    render(<StagnantExtracts />);
    const row = await screen.findByTestId("stagnant-row");

    expect(within(row).getByTestId("stagnant-suggestion")).toHaveTextContent("Keep as reference");
    expect(within(row).queryByTestId("stagnant-fate")).not.toBeInTheDocument();

    fireEvent.click(within(row).getByTestId("stagnant-reference"));
    await waitFor(() =>
      expect(h.setExtractFate).toHaveBeenCalledWith({ id: "ex-ref", fate: "reference" }),
    );
  });

  it("renders the synthesized remediation label", async () => {
    const synthesizedRow = {
      ...h.rewriteRow,
      extract: { ...h.rewriteRow.extract, id: "ex-synth", extractFate: null },
      suggestion: "mark_synthesized",
    } as unknown as StagnantExtractRow;

    h.getExtractStagnation.mockResolvedValue({
      asOf: "x",
      rows: [synthesizedRow],
      stagnantCount: 1,
    });

    render(<StagnantExtracts />);
    const row = await screen.findByTestId("stagnant-row");

    expect(within(row).getByTestId("stagnant-suggestion")).toHaveTextContent("Synthesis reference");
  });

  it("can reactivate a fated stagnant row when supported", async () => {
    const referenceRow = {
      ...h.rewriteRow,
      extract: { ...h.rewriteRow.extract, id: "ex-ref", extractFate: "reference" },
      suggestion: "keep_as_reference",
    } as unknown as StagnantExtractRow;

    h.getExtractStagnation.mockResolvedValue({
      asOf: "x",
      rows: [referenceRow],
      stagnantCount: 1,
    });

    render(<StagnantExtracts />);
    const row = await screen.findByTestId("stagnant-row");
    fireEvent.click(within(row).getByTestId("stagnant-reactivate"));

    await waitFor(() => expect(h.reactivateExtractFate).toHaveBeenCalledWith({ id: "ex-ref" }));
  });

  it("shows the empty state when there are no stagnant extracts", async () => {
    h.getExtractStagnation.mockResolvedValue({ asOf: "x", rows: [], stagnantCount: 0 });
    render(<StagnantExtracts />);
    await waitFor(() => expect(screen.getByTestId("stagnant-empty")).toBeInTheDocument());
  });
});

/**
 * LeechRemediation component tests (T085).
 *
 * The leech threshold + detection + storage + the split/add-context/back-to-extract
 * domain logic live MAIN-side (`@interleave/scheduler` + `ReviewRepository` +
 * `CardRemediationService`); this asserts the RENDERER seam of the remediation screen:
 *  - the leech list loads from `appApi.reviewLeeches()` and renders each card with its
 *    lapse count + source + the FULL action row;
 *  - **Rewrite** opens the inline editor and saves via `appApi.updateCard` (then
 *    un-leeches);
 *  - **Split** opens the multi-part editor and calls `appApi.splitCard` with the parts;
 *  - **Add context** calls `appApi.addCardContext`;
 *  - **Back to extract** is DISABLED when `parentExtractId` is `null`, and calls
 *    `appApi.backToExtractCard` otherwise;
 *  - **Lower priority** calls `appApi.setElementPriority`;
 *  - **Suspend** / **Delete** / **Not a leech** call the existing typed commands and
 *    refresh the list.
 *
 * Collaborators (incl. the T022 navigate hook) are mocked so the test exercises ONLY
 * this component's wiring; no SQLite/IPC/router — the renderer is a pure UI consumer.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LeechSummary } from "../lib/appApi";

const h = vi.hoisted(() => {
  const leechQa: LeechSummary = {
    id: "card-leech",
    kind: "qa",
    status: "active",
    stage: "active_card",
    priority: 0.5,
    title: "Generalization difficulty",
    prompt: "What does a measure of intelligence reward, and how is it measured?",
    answer: "Generalization power; measured by skill-acquisition efficiency.",
    cloze: null,
    lapses: 5,
    reps: 9,
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: "¶ 4",
    sourceLocationId: "loc-1",
    parentExtractId: "extract-1",
    context: null,
  };
  const leechOrphan: LeechSummary = {
    ...leechQa,
    id: "card-orphan",
    title: "Anki-imported leech",
    sourceLocationId: null,
    parentExtractId: null,
  };
  return {
    leechQa,
    leechOrphan,
    reviewLeeches: vi.fn(),
    updateCard: vi.fn(),
    markLeechCard: vi.fn(),
    suspendCard: vi.fn(),
    deleteCard: vi.fn(),
    splitCard: vi.fn(),
    addCardContext: vi.fn(),
    backToExtractCard: vi.fn(),
    setElementPriority: vi.fn(),
    getInspectorData: vi.fn(),
    navigateToLocation: vi.fn(),
  };
});

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      reviewLeeches: h.reviewLeeches,
      updateCard: h.updateCard,
      markLeechCard: h.markLeechCard,
      suspendCard: h.suspendCard,
      deleteCard: h.deleteCard,
      splitCard: h.splitCard,
      addCardContext: h.addCardContext,
      backToExtractCard: h.backToExtractCard,
      setElementPriority: h.setElementPriority,
      getInspectorData: h.getInspectorData,
    },
  };
});

vi.mock("../reader/navigateToLocation", () => ({
  useNavigateToLocation: () => h.navigateToLocation,
}));

import { LeechRemediation } from "./LeechRemediation";

beforeEach(() => {
  vi.clearAllMocks();
  h.reviewLeeches.mockResolvedValue({ cards: [h.leechQa] });
  h.updateCard.mockResolvedValue({ card: { id: "card-leech" } });
  h.markLeechCard.mockResolvedValue({ card: { id: "card-leech" } });
  h.suspendCard.mockResolvedValue({ card: { id: "card-leech" } });
  h.deleteCard.mockResolvedValue({ card: { id: "card-leech" } });
  h.splitCard.mockResolvedValue({ cards: [{ id: "split-a" }, { id: "split-b" }] });
  h.addCardContext.mockResolvedValue({ card: { id: "card-leech" }, context: "note" });
  h.backToExtractCard.mockResolvedValue({ extract: { id: "extract-1" } });
  h.setElementPriority.mockResolvedValue({ element: { id: "card-leech", priorityLabel: "C" } });
  h.getInspectorData.mockResolvedValue({
    data: { location: { sourceElementId: "src-1", blockIds: ["blk-1"], label: "¶ 4" } },
  });
});

describe("LeechRemediation", () => {
  it("lists leech cards with lapse count + source + the full action row", async () => {
    render(<LeechRemediation />);
    expect(await screen.findByTestId("leech-card")).toBeTruthy();
    expect(screen.getByTestId("leech-card-lapses")).toHaveTextContent("5 lapses");
    expect(screen.getByTestId("leech-count")).toHaveTextContent("1 leech");
    // The full repair set is present.
    for (const id of [
      "leech-rewrite",
      "leech-split",
      "leech-add-context",
      "leech-open-source",
      "leech-back-to-extract",
      "leech-priority",
      "leech-suspend",
      "leech-unleech",
      "leech-delete",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  it("rewrites a leech via updateCard then un-leeches it, and refreshes", async () => {
    render(<LeechRemediation />);
    await screen.findByTestId("leech-card");
    fireEvent.click(screen.getByTestId("leech-rewrite"));
    fireEvent.change(await screen.findByTestId("leech-edit-prompt"), {
      target: { value: "Clearer prompt?" },
    });
    fireEvent.change(screen.getByTestId("leech-edit-answer"), {
      target: { value: "Clearer answer." },
    });
    fireEvent.click(screen.getByTestId("leech-edit-save"));
    await waitFor(() =>
      expect(h.updateCard).toHaveBeenCalledWith({
        cardId: "card-leech",
        prompt: "Clearer prompt?",
        answer: "Clearer answer.",
      }),
    );
    await waitFor(() =>
      expect(h.markLeechCard).toHaveBeenCalledWith({ cardId: "card-leech", leech: false }),
    );
    await waitFor(() => expect(h.reviewLeeches).toHaveBeenCalledTimes(2));
  });

  it("splits a leech via splitCard with the authored parts and refreshes", async () => {
    render(<LeechRemediation />);
    await screen.findByTestId("leech-card");
    fireEvent.click(screen.getByTestId("leech-split"));
    // The multi-part editor opens with two parts.
    fireEvent.change(await screen.findByTestId("leech-split-prompt-0"), {
      target: { value: "What is generalization power?" },
    });
    fireEvent.change(screen.getByTestId("leech-split-answer-0"), {
      target: { value: "The ability to handle novel situations." },
    });
    fireEvent.change(screen.getByTestId("leech-split-prompt-1"), {
      target: { value: "How is intelligence measured?" },
    });
    fireEvent.change(screen.getByTestId("leech-split-answer-1"), {
      target: { value: "Skill-acquisition efficiency." },
    });
    fireEvent.click(screen.getByTestId("leech-split-save"));
    await waitFor(() =>
      expect(h.splitCard).toHaveBeenCalledWith({
        cardId: "card-leech",
        parts: [
          {
            kind: "qa",
            prompt: "What is generalization power?",
            answer: "The ability to handle novel situations.",
          },
          {
            kind: "qa",
            prompt: "How is intelligence measured?",
            answer: "Skill-acquisition efficiency.",
          },
        ],
      }),
    );
    await waitFor(() => expect(h.reviewLeeches).toHaveBeenCalledTimes(2));
  });

  it("adds context via addCardContext and refreshes", async () => {
    render(<LeechRemediation />);
    await screen.findByTestId("leech-card");
    fireEvent.click(screen.getByTestId("leech-add-context"));
    fireEvent.change(await screen.findByTestId("leech-context-note"), {
      target: { value: "In the context of the ARC benchmark." },
    });
    fireEvent.click(screen.getByTestId("leech-context-save"));
    await waitFor(() =>
      expect(h.addCardContext).toHaveBeenCalledWith({
        cardId: "card-leech",
        note: "In the context of the ARC benchmark.",
      }),
    );
    await waitFor(() => expect(h.reviewLeeches).toHaveBeenCalledTimes(2));
  });

  it("renders a saved context note as a separate context line (no note → no line)", async () => {
    // No note on the default fixture → no context line is shown.
    const { unmount } = render(<LeechRemediation />);
    await screen.findByTestId("leech-card");
    expect(screen.queryByTestId("leech-card-context")).toBeNull();
    unmount();

    // A card carrying a context note surfaces it on the card (so the note isn't
    // write-only — it re-appears on the read and makes the prompt answerable).
    h.reviewLeeches.mockResolvedValue({
      cards: [{ ...h.leechQa, context: "Refers to the ARC-AGI benchmark, not the ARC format." }],
    });
    render(<LeechRemediation />);
    await screen.findByTestId("leech-card");
    expect(screen.getByTestId("leech-card-context")).toHaveTextContent(
      "Refers to the ARC-AGI benchmark, not the ARC format.",
    );
  });

  it("sends the parent extract back via backToExtractCard", async () => {
    render(<LeechRemediation />);
    await screen.findByTestId("leech-card");
    const btn = screen.getByTestId("leech-back-to-extract");
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => expect(h.backToExtractCard).toHaveBeenCalledWith({ cardId: "card-leech" }));
    await waitFor(() => expect(h.reviewLeeches).toHaveBeenCalledTimes(2));
  });

  it("disables Back to extract when the leech has no live parent extract", async () => {
    h.reviewLeeches.mockResolvedValue({ cards: [h.leechOrphan] });
    render(<LeechRemediation />);
    await screen.findByTestId("leech-card");
    expect(screen.getByTestId("leech-back-to-extract")).toBeDisabled();
    // An orphaned card (no source location) has no Open source button either.
    expect(screen.queryByTestId("leech-open-source")).toBeNull();
  });

  it("lowers a leech's priority via setPriority", async () => {
    render(<LeechRemediation />);
    await screen.findByTestId("leech-card");
    fireEvent.click(screen.getByTestId("leech-priority-C"));
    await waitFor(() =>
      expect(h.setElementPriority).toHaveBeenCalledWith({
        id: "card-leech",
        action: { kind: "set", priority: "C" },
      }),
    );
    await waitFor(() => expect(h.reviewLeeches).toHaveBeenCalledTimes(2));
  });

  it("opens the source via the inspector location + the navigate hook", async () => {
    render(<LeechRemediation />);
    await screen.findByTestId("leech-card");
    fireEvent.click(screen.getByTestId("leech-open-source"));
    await waitFor(() => expect(h.getInspectorData).toHaveBeenCalledWith({ id: "card-leech" }));
    await waitFor(() => expect(h.navigateToLocation).toHaveBeenCalledTimes(1));
  });

  it("suspends a leech via suspendCard and refreshes", async () => {
    render(<LeechRemediation />);
    await screen.findByTestId("leech-card");
    fireEvent.click(screen.getByTestId("leech-suspend"));
    await waitFor(() => expect(h.suspendCard).toHaveBeenCalledWith({ cardId: "card-leech" }));
    await waitFor(() => expect(h.reviewLeeches).toHaveBeenCalledTimes(2));
  });

  it("deletes a leech via deleteCard and un-leeches via markLeechCard", async () => {
    render(<LeechRemediation />);
    await screen.findByTestId("leech-card");
    fireEvent.click(screen.getByTestId("leech-delete"));
    await waitFor(() => expect(h.deleteCard).toHaveBeenCalledWith({ cardId: "card-leech" }));
    fireEvent.click(screen.getByTestId("leech-unleech"));
    await waitFor(() =>
      expect(h.markLeechCard).toHaveBeenCalledWith({ cardId: "card-leech", leech: false }),
    );
  });

  it("shows the empty state when there are no leeches", async () => {
    h.reviewLeeches.mockResolvedValue({ cards: [] });
    render(<LeechRemediation />);
    expect(await screen.findByTestId("leech-empty")).toBeTruthy();
  });
});

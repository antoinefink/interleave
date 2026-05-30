/**
 * LeechCleanup component tests (T040).
 *
 * The leech threshold + detection + storage live MAIN-side (`@interleave/scheduler`
 * + `ReviewRepository`); this asserts the RENDERER seam of the cleanup view:
 *  - the leech list loads from `appApi.reviewLeeches()` and renders each card with
 *    its lapse count + source;
 *  - **Rewrite** opens the inline editor and saves via `appApi.updateCard`, then
 *    un-leeches the card via `appApi.markLeechCard({ leech: false })`;
 *  - **Suspend** / **Delete** / **Not a leech** call the matching typed commands;
 *  - the list refreshes after an action.
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring; no
 * SQLite/IPC — the renderer is a pure UI consumer here.
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
    prompt: "What does a measure of intelligence reward?",
    answer: "Generalization power.",
    cloze: null,
    lapses: 5,
    reps: 9,
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: "¶ 4",
  };
  return {
    leechQa,
    reviewLeeches: vi.fn(),
    updateCard: vi.fn(),
    markLeechCard: vi.fn(),
    suspendCard: vi.fn(),
    deleteCard: vi.fn(),
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
    },
  };
});

import { LeechCleanup } from "./LeechCleanup";

beforeEach(() => {
  vi.clearAllMocks();
  h.reviewLeeches.mockResolvedValue({ cards: [h.leechQa] });
  h.updateCard.mockResolvedValue({ card: { id: "card-leech" } });
  h.markLeechCard.mockResolvedValue({ card: { id: "card-leech" } });
  h.suspendCard.mockResolvedValue({ card: { id: "card-leech" } });
  h.deleteCard.mockResolvedValue({ card: { id: "card-leech" } });
});

describe("LeechCleanup", () => {
  it("lists leech cards with their lapse count + source", async () => {
    render(<LeechCleanup />);
    expect(await screen.findByTestId("leech-card")).toBeTruthy();
    expect(screen.getByTestId("leech-card-lapses")).toHaveTextContent("5 lapses");
    expect(screen.getByTestId("leech-card-prompt")).toHaveTextContent(
      "What does a measure of intelligence reward?",
    );
    expect(screen.getByTestId("leech-count")).toHaveTextContent("1 leech");
  });

  it("rewrites a leech via updateCard then un-leeches it, and refreshes", async () => {
    render(<LeechCleanup />);
    await screen.findByTestId("leech-card");

    fireEvent.click(screen.getByTestId("leech-rewrite"));
    const prompt = await screen.findByTestId("leech-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Clearer prompt?" } });
    fireEvent.change(screen.getByTestId("leech-edit-answer"), {
      target: { value: "Clearer answer." },
    });
    fireEvent.click(screen.getByTestId("leech-edit-save"));

    await waitFor(() => expect(h.updateCard).toHaveBeenCalledTimes(1));
    expect(h.updateCard).toHaveBeenCalledWith({
      cardId: "card-leech",
      prompt: "Clearer prompt?",
      answer: "Clearer answer.",
    });
    // A rewrite resolves the leech → un-flag it so it leaves the list.
    await waitFor(() =>
      expect(h.markLeechCard).toHaveBeenCalledWith({ cardId: "card-leech", leech: false }),
    );
    // The list is re-read after the rewrite (initial load + post-save refresh).
    await waitFor(() => expect(h.reviewLeeches).toHaveBeenCalledTimes(2));
  });

  it("suspends a leech via suspendCard and refreshes", async () => {
    render(<LeechCleanup />);
    await screen.findByTestId("leech-card");
    fireEvent.click(screen.getByTestId("leech-suspend"));
    await waitFor(() => expect(h.suspendCard).toHaveBeenCalledWith({ cardId: "card-leech" }));
    await waitFor(() => expect(h.reviewLeeches).toHaveBeenCalledTimes(2));
  });

  it("deletes a leech via deleteCard and un-leeches via markLeechCard", async () => {
    render(<LeechCleanup />);
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
    render(<LeechCleanup />);
    expect(await screen.findByTestId("leech-empty")).toBeTruthy();
  });
});

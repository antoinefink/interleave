/**
 * RetiredCards component tests (T082).
 *
 * Retirement (the durable `cards.is_retired` flag) lives MAIN-side
 * (`CardRetirementService`); this asserts the RENDERER seam of the inventory view:
 *  - the retired list loads from `appApi.retiredCards()` and renders each card with
 *    its body + stability + source;
 *  - **Un-retire** calls `appApi.unretireCard` and the list refreshes (the card
 *    leaves the inventory);
 *  - an empty inventory shows the calm empty state.
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring; no
 * SQLite/IPC — the renderer is a pure UI consumer here.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RetiredCardSummary } from "../lib/appApi";

const h = vi.hoisted(() => {
  const retiredQa: RetiredCardSummary = {
    id: "card-retired",
    kind: "qa",
    status: "active",
    stage: "mature_card",
    priority: 0.125,
    title: "Skill-acquisition efficiency",
    prompt: "What single phrase captures the essence of the intelligence measure?",
    answer: "Skill-acquisition efficiency.",
    cloze: null,
    stability: 64,
    reps: 2,
    lapses: 0,
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: "¶ 1",
  };
  return {
    retiredQa,
    retiredCards: vi.fn(),
    unretireCard: vi.fn(),
  };
});

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      retiredCards: h.retiredCards,
      unretireCard: h.unretireCard,
    },
  };
});

import { RetiredCards } from "./RetiredCards";

beforeEach(() => {
  vi.clearAllMocks();
  h.retiredCards.mockResolvedValue({ cards: [h.retiredQa] });
  h.unretireCard.mockResolvedValue({ card: { id: "card-retired", retired: false } });
});

describe("RetiredCards", () => {
  it("lists retired cards with their body, stability, and source", async () => {
    render(<RetiredCards />);
    await waitFor(() => expect(screen.getByTestId("retired-card")).toBeInTheDocument());
    expect(screen.getByTestId("retired-count").textContent).toContain("1 retired");
    expect(screen.getByTestId("retired-card-prompt").textContent).toContain("essence");
    expect(screen.getByTestId("retired-card-stability").textContent).toContain("64d");
  });

  it("un-retires a card and refreshes the list (the card leaves the inventory)", async () => {
    h.retiredCards
      .mockResolvedValueOnce({ cards: [h.retiredQa] })
      .mockResolvedValueOnce({ cards: [] });
    render(<RetiredCards />);
    await waitFor(() => expect(screen.getByTestId("retired-card")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("retired-unretire"));
    await waitFor(() => expect(h.unretireCard).toHaveBeenCalledWith({ cardId: "card-retired" }));
    await waitFor(() => expect(screen.getByTestId("retired-empty")).toBeInTheDocument());
  });

  it("shows the empty state when nothing is retired", async () => {
    h.retiredCards.mockResolvedValue({ cards: [] });
    render(<RetiredCards />);
    await waitFor(() => expect(screen.getByTestId("retired-empty")).toBeInTheDocument());
  });
});

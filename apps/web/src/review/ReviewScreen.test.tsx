/**
 * ReviewScreen component tests (T037 — Review UI).
 *
 * The FSRS scheduling + the durable `review_logs` row live MAIN-side (in
 * `packages/scheduler` + `ReviewRepository`); this asserts the RENDERER seam of
 * the session loop the spec calls out:
 *  - the prompt shows; reveal toggles the answer into view;
 *  - revealing fetches the four interval previews and renders them on the grade
 *    buttons;
 *  - grading calls the typed `appApi.reviewGrade` with the correct rating + a
 *    plausible `responseMs` (reveal → grade), then advances to the next card;
 *  - cloze fronts MASK `{{cN::…}}` until reveal, then show the answer;
 *  - the completion summary tallies per-grade counts.
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring:
 * `window.appApi.review.*` are spies, and the router + selection + jump-to-source
 * seams are stubbed. No SQLite/IPC — the renderer is a pure UI consumer here.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewCardView, ReviewSessionNextResult } from "../lib/appApi";

const h = vi.hoisted(() => {
  const qaCard: ReviewCardView = {
    id: "card-qa",
    kind: "qa",
    prompt: "How does Chollet define the intelligence of a system?",
    answer: "As skill-acquisition efficiency over a scope of tasks.",
    cloze: null,
    priority: 0.875,
    stage: "active_card",
    concept: "Intelligence",
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: "¶ 4",
    ref: "Intelligence is a measure of skill-acquisition efficiency…",
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
  };
  const clozeCard: ReviewCardView = {
    id: "card-cloze",
    kind: "cloze",
    prompt:
      "Intelligence is a measure of {{c1::skill-acquisition efficiency}} over a scope of tasks.",
    answer: null,
    cloze:
      "Intelligence is a measure of {{c1::skill-acquisition efficiency}} over a scope of tasks.",
    priority: 0.625,
    stage: "active_card",
    concept: null,
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: "¶ 4",
    ref: null,
    schedulerSignals: {
      kind: "fsrs",
      retrievability: null,
      stability: 1,
      difficulty: 5,
      reps: 0,
      lapses: 0,
      fsrsState: "new",
    },
    leech: false,
    lapses: 0,
    flagged: false,
    siblingGroupId: null,
  };
  return {
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    navigateToLocationSpy: vi.fn(),
    reviewSessionNext: vi.fn(),
    reviewPreview: vi.fn(),
    reviewGrade: vi.fn(),
    getInspectorData: vi.fn(),
    qaCard,
    clozeCard,
  };
});

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      reviewSessionNext: h.reviewSessionNext,
      reviewPreview: h.reviewPreview,
      reviewGrade: h.reviewGrade,
      getInspectorData: h.getInspectorData,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
  useSearch: () => ({}),
}));

vi.mock("../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
}));

vi.mock("../reader/navigateToLocation", () => ({
  useNavigateToLocation: () => h.navigateToLocationSpy,
}));

import { ReviewScreen } from "./ReviewScreen";

const PREVIEWS = {
  again: { dueAt: "2026-05-30T08:10:00.000Z", scheduledDays: 0.007, label: "10m" },
  hard: { dueAt: "2026-06-01T08:00:00.000Z", scheduledDays: 2, label: "2d" },
  good: { dueAt: "2026-06-09T08:00:00.000Z", scheduledDays: 10, label: "10d" },
  easy: { dueAt: "2026-06-29T08:00:00.000Z", scheduledDays: 30, label: "1mo" },
};

/** A `session.next` result for a single-card deck. */
function singleDeck(card: ReviewCardView): ReviewSessionNextResult {
  return { card, remaining: 0, total: 1 };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reviewPreview.mockResolvedValue({ intervals: PREVIEWS });
  h.reviewGrade.mockResolvedValue({
    reviewLog: {
      id: "rl_1",
      elementId: "card-qa",
      rating: "good",
      reviewedAt: "2026-05-30T08:00:00.000Z",
      responseMs: 1200,
      nextDueAt: "2026-06-09T08:00:00.000Z",
    },
    reviewState: {
      dueAt: "2026-06-09T08:00:00.000Z",
      stability: 18,
      difficulty: 5,
      reps: 3,
      lapses: 0,
      fsrsState: "review",
      lastReviewedAt: "2026-05-30T08:00:00.000Z",
    },
  });
});

describe("ReviewScreen", () => {
  it("shows the prompt and hides the answer until reveal", async () => {
    h.reviewSessionNext.mockResolvedValue(singleDeck(h.qaCard));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    expect(screen.getByTestId("review-prompt")).toHaveTextContent(/how does chollet define/i);
    // The answer is not in the DOM until reveal.
    expect(screen.queryByTestId("review-answer")).not.toBeInTheDocument();
    // The reveal CTA is shown.
    expect(screen.getByTestId("review-reveal")).toBeInTheDocument();
  });

  it("reveal toggles the answer into view and fetches the four interval previews", async () => {
    h.reviewSessionNext.mockResolvedValue(singleDeck(h.qaCard));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    fireEvent.click(screen.getByTestId("review-reveal"));

    const answer = await screen.findByTestId("review-answer");
    expect(answer).toHaveTextContent(/skill-acquisition efficiency over a scope of tasks/i);
    expect(h.reviewPreview).toHaveBeenCalledWith(expect.objectContaining({ cardId: "card-qa" }));

    // The grade buttons render the four preview intervals.
    await waitFor(() => {
      expect(screen.getByTestId("review-interval-again")).toHaveTextContent("10m");
    });
    expect(screen.getByTestId("review-interval-hard")).toHaveTextContent("2d");
    expect(screen.getByTestId("review-interval-good")).toHaveTextContent("10d");
    expect(screen.getByTestId("review-interval-easy")).toHaveTextContent("1mo");
  });

  it("grading calls reviewGrade with the rating + a plausible responseMs, then advances", async () => {
    // First card, then an empty deck (session complete).
    h.reviewSessionNext
      .mockResolvedValueOnce(singleDeck(h.qaCard))
      .mockResolvedValueOnce({ card: null, remaining: 0, total: 0 });
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-grades");

    fireEvent.click(screen.getByTestId("review-grade-good"));

    await waitFor(() => expect(h.reviewGrade).toHaveBeenCalledTimes(1));
    expect(h.reviewGrade).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: "card-qa",
        rating: "good",
        responseMs: expect.any(Number),
      }),
    );
    const arg = h.reviewGrade.mock.calls[0]?.[0] as { responseMs: number };
    expect(arg.responseMs).toBeGreaterThanOrEqual(0);

    // The deck is now exhausted → the completion summary appears (advanced).
    await screen.findByTestId("review-summary");
  });

  it("masks cloze deletions until reveal, then shows the answer span", async () => {
    h.reviewSessionNext.mockResolvedValue(singleDeck(h.clozeCard));
    render(<ReviewScreen />);

    const cardEl = await screen.findByTestId("review-card");
    // Before reveal the deletion is the placeholder, not the answer.
    expect(screen.getByTestId("review-prompt")).toHaveTextContent("[ … ]");
    expect(cardEl).not.toHaveTextContent("skill-acquisition efficiency");

    fireEvent.click(screen.getByTestId("review-reveal"));
    const answer = await screen.findByTestId("review-answer");
    expect(answer).toHaveTextContent("skill-acquisition efficiency");
  });

  it("threads the shown card's siblingGroupId into the NEXT session.next call (T039)", async () => {
    // The first card belongs to a sibling group; after grading it, the renderer
    // must pass that group as `recentSiblingGroups` so the main side can bury it.
    const grouped = { ...h.qaCard, siblingGroupId: "sib_group_1" };
    h.reviewSessionNext
      .mockResolvedValueOnce({ card: grouped, remaining: 1, total: 2 })
      .mockResolvedValueOnce({ card: { ...h.clozeCard, id: "card-2" }, remaining: 0, total: 1 });
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    // First load: nothing shown yet → no recent sibling group passed.
    expect(h.reviewSessionNext.mock.calls[0]?.[0]?.recentSiblingGroups).toBeUndefined();

    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-grades");
    fireEvent.click(screen.getByTestId("review-grade-good"));

    // After grading the grouped card, the next load buries its group.
    await waitFor(() => expect(h.reviewSessionNext).toHaveBeenCalledTimes(2));
    expect(h.reviewSessionNext.mock.calls[1]?.[0]?.recentSiblingGroups).toEqual(["sib_group_1"]);
    // The renderer never sets burySiblings — the main side reads the persisted setting.
    expect(h.reviewSessionNext.mock.calls[1]?.[0]?.burySiblings).toBeUndefined();
  });

  it("tallies per-grade counts in the completion summary", async () => {
    // Two cards: grade the first Again, the second Good, then the deck empties.
    h.reviewSessionNext
      .mockResolvedValueOnce({ card: h.qaCard, remaining: 1, total: 2 })
      .mockResolvedValueOnce({ card: { ...h.clozeCard, id: "card-2" }, remaining: 0, total: 1 })
      .mockResolvedValueOnce({ card: null, remaining: 0, total: 0 });
    h.reviewGrade.mockResolvedValue({
      reviewLog: {
        id: "rl",
        elementId: "x",
        rating: "x",
        reviewedAt: "2026-05-30T08:00:00.000Z",
        responseMs: 1,
        nextDueAt: "2026-05-30T08:00:00.000Z",
      },
      reviewState: {
        dueAt: null,
        stability: 1,
        difficulty: 5,
        reps: 1,
        lapses: 0,
        fsrsState: "learning",
        lastReviewedAt: "2026-05-30T08:00:00.000Z",
      },
    });
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-grades");
    fireEvent.click(screen.getByTestId("review-grade-again"));

    // Second card.
    await waitFor(() =>
      expect(screen.getByTestId("review-card")).toHaveAttribute("data-card-id", "card-2"),
    );
    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-grades");
    fireEvent.click(screen.getByTestId("review-grade-good"));

    // Summary: 1 Again, 1 Good.
    await screen.findByTestId("review-summary");
    expect(screen.getByTestId("review-tally-again")).toHaveTextContent("1");
    expect(screen.getByTestId("review-tally-good")).toHaveTextContent("1");
    expect(screen.getByTestId("review-tally-hard")).toHaveTextContent("0");
    expect(screen.getByTestId("review-tally-easy")).toHaveTextContent("0");
  });

  it("shows the no-cards-due state for an empty deck (not the completion summary)", async () => {
    h.reviewSessionNext.mockResolvedValue({ card: null, remaining: 0, total: 0 });
    render(<ReviewScreen />);
    await screen.findByTestId("review-empty");
    expect(screen.getByText(/no cards due/i)).toBeInTheDocument();
    expect(screen.queryByTestId("review-summary")).not.toBeInTheDocument();
  });
});

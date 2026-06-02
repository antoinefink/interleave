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
    sourceRef: {
      sourceElementId: "src-1",
      sourceTitle: "On the Measure of Intelligence",
      url: "https://arxiv.org/abs/1911.01547",
      author: "François Chollet",
      publishedAt: "2019-11-05T00:00:00.000Z",
      locationLabel: "¶ 4",
      snippet: "Intelligence is a measure of skill-acquisition efficiency…",
    },
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
    sourceRef: {
      sourceElementId: "src-1",
      sourceTitle: "On the Measure of Intelligence",
      url: "https://arxiv.org/abs/1911.01547",
      author: "François Chollet",
      publishedAt: "2019-11-05T00:00:00.000Z",
      locationLabel: "¶ 4",
      snippet: null,
    },
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
    occlusion: null,
    mediaRef: null,
    mediaSource: null,
    youtubeId: null,
  };
  const leechCard: ReviewCardView = {
    ...qaCard,
    id: "card-leech",
    leech: true,
    lapses: 8,
    schedulerSignals: { ...qaCard.schedulerSignals, lapses: 8 },
  };
  // T075: an audio-PROMPT card — the looped clip is the prompt; a written answer.
  const audioPromptCard: ReviewCardView = {
    ...qaCard,
    id: "card-audio-prompt",
    prompt: "", // audio-only prompt
    answer: "the written translation",
    mediaRef: { sourceElementId: "src-1", startMs: 1000, endMs: 4000, on: "prompt" },
    mediaSource: "local",
    youtubeId: null,
  };
  // T075: an audio-ANSWER card — written prompt; the looped clip is the answer.
  const audioAnswerCard: ReviewCardView = {
    ...qaCard,
    id: "card-audio-answer",
    prompt: "How is this phrase pronounced?",
    answer: "",
    mediaRef: { sourceElementId: "src-1", startMs: 1000, endMs: 4000, on: "answer" },
    mediaSource: "local",
    youtubeId: null,
  };
  return {
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    navigateToLocationSpy: vi.fn(),
    reviewSessionNext: vi.fn(),
    reviewPreview: vi.fn(),
    reviewGrade: vi.fn(),
    getInspectorData: vi.fn(),
    suspendCard: vi.fn(),
    deleteCard: vi.fn(),
    semanticContradictions: vi.fn(),
    qaCard,
    clozeCard,
    leechCard,
    audioPromptCard,
    audioAnswerCard,
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
      suspendCard: h.suspendCard,
      deleteCard: h.deleteCard,
      // T089 conflict surface (post-reveal) — default to no flags in these tests.
      semanticContradictions: h.semanticContradictions,
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
  // Suspend/delete remove the current card from the live deck; the repair bar
  // ignores their return value (it only awaits, then calls `onCardRemoved`).
  h.suspendCard.mockResolvedValue({});
  h.deleteCard.mockResolvedValue({});
  h.semanticContradictions.mockResolvedValue({ flags: [] });
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

  it("hides the source refblock until reveal, then shows it (T043 reveal gate)", async () => {
    h.reviewSessionNext.mockResolvedValue(singleDeck(h.qaCard));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    // The refblock must NOT be in the DOM before reveal — it could leak the answer.
    expect(screen.queryByTestId("review-refblock")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-answer");

    // After reveal the enriched refblock appears with the citation + open-source.
    const ref = await screen.findByTestId("review-refblock");
    expect(ref).toBeInTheDocument();
    expect(screen.getByTestId("review-refblock-citation")).toHaveTextContent("François Chollet");
    expect(screen.getByTestId("review-refblock-citation")).toHaveTextContent(
      "On the Measure of Intelligence (2019)",
    );
    expect(screen.getByTestId("review-refblock-open-source")).toBeInTheDocument();
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

  it("does not write a second review log when the same card is re-presented after grading", async () => {
    // Guard against double-grading: once a card is recorded in the exclude set it
    // has a durable `review_logs` row + an advanced FSRS state. If a stale read
    // re-presents the just-graded card (e.g. a transient advance race), grading it
    // a second time must be a no-op — no second `reviewGrade` / `review_logs` row.
    h.reviewSessionNext
      .mockResolvedValueOnce({ card: h.qaCard, remaining: 0, total: 1 })
      // The advance re-reads the SAME card id (it has not yet dropped from the deck);
      // the guard then swallows the second grade, so no further read is queued.
      .mockResolvedValueOnce({ card: h.qaCard, remaining: 0, total: 1 });
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-grades");
    fireEvent.click(screen.getByTestId("review-grade-good"));

    // The first grade is recorded once.
    await waitFor(() => expect(h.reviewGrade).toHaveBeenCalledTimes(1));
    // The advance re-presented the same card id (still on screen, re-gradable).
    await waitFor(() =>
      expect(screen.getByTestId("review-card")).toHaveAttribute("data-card-id", "card-qa"),
    );

    // Re-reveal and grade the re-presented card: the exclude-set guard short-circuits
    // before any IPC, so no second log is written.
    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-grades");
    fireEvent.click(screen.getByTestId("review-grade-again"));

    // Still exactly one grade — the duplicate was swallowed by the guard.
    await waitFor(() => expect(h.reviewSessionNext).toHaveBeenCalledTimes(2));
    expect(h.reviewGrade).toHaveBeenCalledTimes(1);
    expect(h.reviewGrade).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: "card-qa", rating: "good" }),
    );
  });

  it("suspend/delete shrink the progress denominator so a repaired-away session still reaches 100%", async () => {
    // A two-card deck: grade the first (counts as a review), then SUSPEND the second
    // (removed without a grade). The completion summary must show full progress even
    // though only one of the two cards was actually reviewed — suspend/delete are
    // repairs, not reviews, so they shrink the denominator.
    h.reviewSessionNext
      .mockResolvedValueOnce({ card: h.qaCard, remaining: 1, total: 2 })
      .mockResolvedValueOnce({ card: { ...h.clozeCard, id: "card-2" }, remaining: 0, total: 1 })
      .mockResolvedValueOnce({ card: null, remaining: 0, total: 0 });
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-grades");
    fireEvent.click(screen.getByTestId("review-grade-good"));

    // The second card surfaces; before any repair the bar shows "1 reviewed · 1 left".
    await waitFor(() =>
      expect(screen.getByTestId("review-card")).toHaveAttribute("data-card-id", "card-2"),
    );
    expect(screen.getByTestId("review-progress")).toHaveTextContent("1 reviewed · 1 left");
    const filledBefore = document.querySelector<HTMLElement>(".pbar__fill");
    // 1 of 2 → the bar is half full while the second card is still pending.
    expect(filledBefore?.style.width).toBe("50%");

    // Suspend the second card: it leaves the deck WITHOUT a grade.
    fireEvent.click(screen.getByTestId("review-repair-suspend"));
    await waitFor(() => expect(h.suspendCard).toHaveBeenCalledTimes(1));

    // The deck is exhausted → completion summary. Only one card was reviewed, but the
    // bar reaches 100% because the suspended card was subtracted from the denominator.
    await screen.findByTestId("review-summary");
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 card reviewed");
    const filledAfter = document.querySelector<HTMLElement>(".pbar__fill");
    expect(filledAfter?.style.width).toBe("100%");
  });

  it("shows the no-cards-due state for an empty deck (not the completion summary)", async () => {
    h.reviewSessionNext.mockResolvedValue({ card: null, remaining: 0, total: 0 });
    render(<ReviewScreen />);
    await screen.findByTestId("review-empty");
    expect(screen.getByText(/no cards due/i)).toBeInTheDocument();
    expect(screen.queryByTestId("review-summary")).not.toBeInTheDocument();
  });

  it("surfaces a leech card with the leech banner + lapse badge (T040)", async () => {
    h.reviewSessionNext.mockResolvedValue(singleDeck(h.leechCard));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    // The leech banner is shown (the T040 "surface the leech in review" deliverable).
    const banner = screen.getByTestId("review-leech-banner");
    expect(banner).toHaveTextContent(/keeps lapsing/i);
    // The leech lapse badge renders with the lapse count + the warn `badge--leech` class.
    const badge = screen.getByText(/leech · 8 lapses/i);
    expect(badge).toHaveClass("badge--leech");
    // The banner exposes the kit's inline "Add context" remediation action.
    expect(screen.getByTestId("review-leech-add-context")).toBeInTheDocument();
  });

  it("does NOT show the leech banner for a non-leech card", async () => {
    h.reviewSessionNext.mockResolvedValue(singleDeck(h.qaCard));
    render(<ReviewScreen />);
    await screen.findByTestId("review-card");
    expect(screen.queryByTestId("review-leech-banner")).not.toBeInTheDocument();
  });

  it("the leech banner's Add context opens the source-context drawer", async () => {
    h.reviewSessionNext.mockResolvedValue(singleDeck(h.leechCard));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    expect(screen.queryByTestId("review-context-drawer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("review-leech-add-context"));
    expect(await screen.findByTestId("review-context-drawer")).toBeInTheDocument();
  });

  it("keyboard: Space reveals, then 1–4 grade the revealed card", async () => {
    h.reviewSessionNext
      .mockResolvedValueOnce(singleDeck(h.qaCard))
      .mockResolvedValueOnce({ card: null, remaining: 0, total: 0 });
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    // 1–4 are inert before reveal (no grade until the answer is shown).
    fireEvent.keyDown(window, { key: "3", code: "Digit3" });
    expect(h.reviewGrade).not.toHaveBeenCalled();

    // Space reveals.
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    await screen.findByTestId("review-grades");

    // `3` grades Good.
    fireEvent.keyDown(window, { key: "3", code: "Digit3" });
    await waitFor(() => expect(h.reviewGrade).toHaveBeenCalledTimes(1));
    expect(h.reviewGrade).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: "card-qa", rating: "good" }),
    );
  });

  it("keyboard grades are ignored while focus is in a textarea", async () => {
    h.reviewSessionNext.mockResolvedValue(singleDeck(h.qaCard));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-grades");

    // Open the inline editor, then a `3` typed in its textarea must NOT grade.
    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.keyDown(prompt, { key: "3", code: "Digit3" });
    expect(h.reviewGrade).not.toHaveBeenCalled();
  });

  it("keyboard: `o` resolves the card's location via lineage and jumps to source (T022/T048)", async () => {
    // The load-bearing actionable-lineage jump-back: pressing `o` resolves the
    // card's full source location (block ids/offsets) via `getInspectorData` then
    // calls `navigateToLocation` with it — card → location → source, no SQL in the
    // renderer. The repair-bar button delegates to the SAME `openSource` resolver.
    const location = {
      label: "¶ 4",
      selectedText: "Intelligence is a measure of skill-acquisition efficiency…",
      page: null,
      sourceElementId: "src-1",
      blockIds: ["blk-7", "blk-8"],
      startOffset: 12,
      endOffset: 40,
    };
    h.reviewSessionNext.mockResolvedValue(singleDeck(h.qaCard));
    h.getInspectorData.mockResolvedValue({
      data: { location },
    });
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    // The jump works before reveal (ground a card without leaking the answer).
    fireEvent.keyDown(window, { key: "o", code: "KeyO" });

    await waitFor(() => expect(h.getInspectorData).toHaveBeenCalledWith({ id: "card-qa" }));
    await waitFor(() => expect(h.navigateToLocationSpy).toHaveBeenCalledWith(location));
    // Pressing `o` is a navigation convenience — it never grades.
    expect(h.reviewGrade).not.toHaveBeenCalled();
  });

  it("a failed grade shows the error, leaves the card in place, and stays retryable", async () => {
    // When `reviewGrade` rejects nothing is recorded: the same card stays on screen
    // (its `review_logs` row was never written), the error renders in `review-error`,
    // and the exclude set is NOT advanced — so the user can retry the SAME grade and
    // have it succeed the second time.
    h.reviewSessionNext
      .mockResolvedValueOnce(singleDeck(h.qaCard))
      // Once the retry succeeds, the deck empties → completion summary.
      .mockResolvedValueOnce({ card: null, remaining: 0, total: 0 });
    h.reviewGrade.mockRejectedValueOnce(new Error("write failed"));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-grades");

    // First grade fails: the error surfaces and the card stays put (re-gradable).
    fireEvent.click(screen.getByTestId("review-grade-good"));
    await waitFor(() => expect(h.reviewGrade).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("review-error")).toHaveTextContent("write failed");
    // The same card is still on screen — nothing advanced.
    expect(screen.getByTestId("review-card")).toHaveAttribute("data-card-id", "card-qa");
    // No further read was queued (the deck did not advance past this card).
    expect(h.reviewSessionNext).toHaveBeenCalledTimes(1);

    // Retry the SAME grade: this time it resolves, the card is recorded, and the
    // session advances to the completion summary.
    fireEvent.click(screen.getByTestId("review-grade-good"));
    await waitFor(() => expect(h.reviewGrade).toHaveBeenCalledTimes(2));
    await screen.findByTestId("review-summary");
  });

  it("the completion summary's `Review again` restarts the session from the top", async () => {
    // Grade a single-card deck to reach the summary, then `Review again` must clear
    // the per-grade tally + denominator and re-read the due deck (a fresh
    // `session.next`), dropping the summary back to a live card.
    h.reviewSessionNext
      .mockResolvedValueOnce(singleDeck(h.qaCard))
      // Deck empties → completion summary.
      .mockResolvedValueOnce({ card: null, remaining: 0, total: 0 })
      // Restart re-reads the deck and surfaces the card again.
      .mockResolvedValueOnce(singleDeck(h.qaCard));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-grades");
    fireEvent.click(screen.getByTestId("review-grade-good"));

    // The summary shows one card reviewed + the Good tally at 1.
    await screen.findByTestId("review-summary");
    expect(screen.getByTestId("review-summary")).toHaveTextContent("1 card reviewed");
    expect(screen.getByTestId("review-tally-good")).toHaveTextContent("1");

    // Restart: a fresh deck read fires, the summary is gone, and a live card shows.
    fireEvent.click(screen.getByTestId("review-restart"));
    await waitFor(() => expect(h.reviewSessionNext).toHaveBeenCalledTimes(3));
    await screen.findByTestId("review-card");
    expect(screen.queryByTestId("review-summary")).not.toBeInTheDocument();
    // The progress denominator/tally reset: 0 reviewed again.
    expect(screen.getByTestId("review-progress")).toHaveTextContent("0 reviewed · 1 left");
  });

  // ---- T075: audio cards ----

  it("an audio-prompt card mounts a looping <audio> on the FRONT and shows the Audio badge", async () => {
    h.reviewSessionNext.mockResolvedValue(singleDeck(h.audioPromptCard));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    // The looped clip plays on the prompt face before reveal.
    const audio = screen.getByTestId("card-audio-prompt-el") as HTMLAudioElement;
    expect(audio.getAttribute("src")).toBe("media://src-1");
    // The audio badge marks it as an audio card (a presentation modifier, not a kind).
    expect(screen.getByTestId("review-audio-badge")).toBeInTheDocument();
    // The Q&A badge is still shown — an audio card stays a Q&A card.
    expect(screen.getByTestId("review-kind")).toHaveTextContent("Q&A");
  });

  it("an audio-ANSWER card plays NO audio before reveal, then mounts it on reveal (never leaks)", async () => {
    h.reviewSessionNext.mockResolvedValue(singleDeck(h.audioAnswerCard));
    render(<ReviewScreen />);

    await screen.findByTestId("review-card");
    // Before reveal: the written prompt shows, but NO audio answer is in the DOM.
    expect(screen.getByTestId("review-prompt")).toHaveTextContent(/how is this phrase/i);
    expect(screen.queryByTestId("card-audio-answer-el")).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-audio-prompt-el")).not.toBeInTheDocument();

    // Reveal: now the looped answer clip mounts.
    fireEvent.click(screen.getByTestId("review-reveal"));
    await screen.findByTestId("review-answer");
    const audio = screen.getByTestId("card-audio-answer-el") as HTMLAudioElement;
    expect(audio.getAttribute("src")).toBe("media://src-1");
  });

  it("a plain Q&A card mounts NO audio (no regression)", async () => {
    h.reviewSessionNext.mockResolvedValue(singleDeck(h.qaCard));
    render(<ReviewScreen />);
    await screen.findByTestId("review-card");
    expect(screen.queryByTestId("card-audio-prompt-el")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-audio-badge")).not.toBeInTheDocument();
  });
});

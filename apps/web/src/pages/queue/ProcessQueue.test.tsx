/**
 * ProcessQueue loop component tests (T031 + T037 inline card review).
 *
 * The queue read (sorting/filtering/budget) lives in `packages/local-db`; this
 * asserts the RENDERER seam of the one-at-a-time loop:
 *  - it renders ONE item at a time (the current cursor item only);
 *  - acting on an item calls the SAME typed `queue.act` mutation path as the list
 *    (no new channel) and ADVANCES the cursor to the next item;
 *  - reaching the end shows the "Queue clear" done state;
 *  - a CARD reveals its answer INLINE (cloze unmasked / Q&A answer), renders the
 *    four interval previews from `review.preview`, and grading it calls the SAME
 *    `review.grade` the review session uses (with a plausible responseMs + rating)
 *    then advances the cursor — NO detour to /review.
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring:
 * `window.appApi.queue.list` returns a fixed payload, `queue.act` / `review.*` are
 * spies, and the router + selection seams are stubbed. No SQLite/IPC — the renderer
 * is a pure UI consumer.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  QueueItemSummary,
  QueueListResult,
  ReviewCardView,
  ReviewIntervalPreview,
  ReviewRating,
} from "../../lib/appApi";

const h = vi.hoisted(() => {
  const mk = (over: Partial<QueueItemSummary> & { id: string }): QueueItemSummary => ({
    type: "extract",
    status: "scheduled",
    stage: "clean_extract",
    priority: 0.625,
    title: `Item ${over.id}`,
    dueAt: "2026-05-30T06:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {
      kind: "attention",
      retrievability: null,
      stability: null,
      stage: "clean_extract",
      postponed: 0,
    },
    sourceTitle: "On the Measure of Intelligence",
    author: "François Chollet",
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    cardType: null,
    protected: false,
    due: "today",
    dueLabel: "Due today",
    ...over,
  });
  const card = mk({
    id: "card-1",
    type: "card",
    scheduler: "fsrs",
    stage: "active_card",
    cardType: "qa",
    priority: 0.875,
    protected: true,
    title: "What does Chollet define intelligence as?",
    schedulerSignals: {
      kind: "fsrs",
      retrievability: 0.82,
      stability: 9.4,
      stage: "active_card",
      postponed: 0,
    },
  });
  const extractA = mk({ id: "extract-1", title: "skill-acquisition efficiency" });
  const source = mk({
    id: "source-1",
    type: "source",
    stage: "raw_source",
    title: "The Bitter Lesson",
  });
  const result: QueueListResult = {
    items: [card, source, extractA],
    counts: {
      all: 3,
      card: 1,
      source: 1,
      extract: 1,
      topic: 0,
      task: 0,
      highPriority: 2,
      overdue: 0,
      protected: 2,
    },
    budget: { used: 3, target: 30 },
  };
  // The full reveal-ready view for card-1 (the answer + source ref ship with the
  // card; the renderer hides them until reveal — exactly like the review session).
  const cardView: ReviewCardView = {
    id: "card-1",
    kind: "qa",
    prompt: "What does Chollet define intelligence as?",
    answer: "Skill-acquisition efficiency.",
    cloze: null,
    priority: 0.875,
    stage: "active_card",
    concept: null,
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: "¶ 4",
    ref: "intelligence is skill-acquisition efficiency",
    sourceRef: {
      sourceElementId: "source-9",
      sourceTitle: "On the Measure of Intelligence",
      url: null,
      author: "François Chollet",
      publishedAt: null,
      locationLabel: "¶ 4",
      snippet: "intelligence is skill-acquisition efficiency",
    },
    schedulerSignals: {
      kind: "fsrs",
      retrievability: 0.82,
      stability: 9.4,
      difficulty: 5.1,
      reps: 3,
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
  const previews: Record<ReviewRating, ReviewIntervalPreview> = {
    again: { dueAt: "2026-05-30T08:10:00.000Z", scheduledDays: 0.007, label: "10m" },
    hard: { dueAt: "2026-05-31T08:00:00.000Z", scheduledDays: 1, label: "1d" },
    good: { dueAt: "2026-06-03T08:00:00.000Z", scheduledDays: 4, label: "4d" },
    easy: { dueAt: "2026-06-09T08:00:00.000Z", scheduledDays: 10, label: "10d" },
  };
  return {
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    listQueue: vi.fn().mockResolvedValue(result),
    actOnQueueItem: vi.fn().mockResolvedValue({ item: null, removed: true, undo: null }),
    getDocument: vi
      .fn()
      .mockResolvedValue({ document: { plainText: "Body preview text." }, extractedBlockIds: [] }),
    getInspectorData: vi.fn().mockResolvedValue({ data: null }),
    reviewCard: vi.fn().mockResolvedValue({ card: cardView }),
    reviewPreview: vi.fn().mockResolvedValue({ intervals: previews }),
    reviewGrade: vi.fn().mockResolvedValue({
      reviewLog: {
        id: "log-1",
        elementId: "card-1",
        rating: "good",
        reviewedAt: "2026-05-30T08:00:05.000Z",
        responseMs: 1234,
        nextDueAt: "2026-06-03T08:00:00.000Z",
      },
      reviewState: {
        dueAt: "2026-06-03T08:00:00.000Z",
        stability: 12.1,
        difficulty: 5.0,
        reps: 4,
        lapses: 0,
        fsrsState: "review",
        lastReviewedAt: "2026-05-30T08:00:05.000Z",
      },
    }),
  };
});

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      listQueue: h.listQueue,
      actOnQueueItem: h.actOnQueueItem,
      getDocument: h.getDocument,
      getInspectorData: h.getInspectorData,
      reviewCard: h.reviewCard,
      reviewPreview: h.reviewPreview,
      reviewGrade: h.reviewGrade,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
  useSearch: () => ({}),
}));

vi.mock("../../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
}));

// The seeded daily jitter (T029) is a presentation collaborator that reorders the
// queue by the calendar day — its shuffle is covered by `jitter.test.ts`. Stub it to
// the identity here so this test exercises ONLY the loop's cursor wiring against the
// deterministic input order (card-1 → source-1 → extract-1), instead of depending on
// today's wall-clock seed (which would make these assertions flaky day to day).
vi.mock("./jitter", () => ({
  jitterOrder: <T,>(rows: readonly T[]): T[] => [...rows],
  daySeed: () => "2026-01-01",
}));

import { ProcessQueue } from "./ProcessQueue";

beforeEach(() => {
  vi.clearAllMocks();
  h.actOnQueueItem.mockResolvedValue({ item: null, removed: true, undo: null });
});

/** The id of the single rendered process item (the cursor item), or null. */
function currentItemId(): string | null {
  return screen.queryByTestId("process-item")?.getAttribute("data-element-id") ?? null;
}

describe("ProcessQueue", () => {
  it("renders exactly ONE element at a time (the cursor item)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(screen.getAllByTestId("process-item")).toHaveLength(1);
  });

  it("shows the progress readout (N / total)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-progress");
    expect(screen.getByTestId("process-progress")).toHaveTextContent("1 / 3");
  });

  it("advances to the next item after an action, using the queue.act path", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    const first = currentItemId();

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: first,
        action: { kind: "markDone" },
      }),
    );
    // The cursor advanced: a DIFFERENT item is now shown (no return to a list).
    await waitFor(() => expect(currentItemId()).not.toBe(first));
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("processes all items one at a time and reaches the done state", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    // Act on each of the three items in turn.
    for (let i = 0; i < 3; i++) {
      await screen.findByTestId("process-item");
      fireEvent.click(screen.getByTestId("process-action-markDone"));
      // wait for this action to register before the next
      await waitFor(() => expect(h.actOnQueueItem).toHaveBeenCalledTimes(i + 1));
    }
    await screen.findByTestId("process-done");
    expect(screen.getByTestId("process-done")).toHaveTextContent(/queue clear/i);
  });

  it("skip advances WITHOUT mutating (no queue.act call)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    const first = currentItemId();
    fireEvent.click(screen.getByTestId("process-action-skip"));
    await waitFor(() => expect(currentItemId()).not.toBe(first));
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
  });

  it("renders the card surface with the FSRS chip + a reveal for a card item", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    // The first item is the FSRS card.
    expect(currentItemId()).toBe("card-1");
    expect(screen.getByTestId("process-card-face")).toBeInTheDocument();
    expect(screen.getByTestId("process-card-reveal")).toBeInTheDocument();
    // Its chip is the FSRS side (the two-scheduler split holds in the loop).
    expect(
      screen.getByTestId("process-item").querySelector('[data-scheduler="fsrs"]'),
    ).not.toBeNull();
    // The answer is hidden until reveal — no detour-to-review placeholder note.
    expect(screen.queryByTestId("process-card-answer")).toBeNull();
  });

  it("reveals a card's answer INLINE with the four interval previews (no navigation)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(currentItemId()).toBe("card-1");
    // The full reveal-ready view is fetched by id (the architectural seam closing
    // the original stub) before the answer can show.
    await waitFor(() => expect(h.reviewCard).toHaveBeenCalledWith({ cardId: "card-1" }));

    fireEvent.click(screen.getByTestId("process-card-reveal"));

    // The answer reveals inline (Q&A answer), with the four previews from review.preview.
    const answer = await screen.findByTestId("process-card-answer");
    expect(answer).toHaveTextContent("Skill-acquisition efficiency.");
    await waitFor(() =>
      expect(screen.getByTestId("process-interval-good")).toHaveTextContent("4d"),
    );
    expect(h.reviewPreview).toHaveBeenCalledWith(expect.objectContaining({ cardId: "card-1" }));
    // No detour to /review — still on the loop.
    expect(h.navigateSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("route-process")).toBeInTheDocument();
  });

  it("grades a revealed card via review.grade and advances the cursor (no navigation)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(currentItemId()).toBe("card-1");
    await waitFor(() => expect(h.reviewCard).toHaveBeenCalledWith({ cardId: "card-1" }));

    fireEvent.click(screen.getByTestId("process-card-reveal"));
    await screen.findByTestId("process-card-answer");

    fireEvent.click(screen.getByTestId("process-grade-good"));

    await waitFor(() => expect(h.reviewGrade).toHaveBeenCalledTimes(1));
    const arg = h.reviewGrade.mock.calls[0]?.[0] as {
      cardId: string;
      rating: string;
      responseMs: number;
    };
    expect(arg.cardId).toBe("card-1");
    expect(arg.rating).toBe("good");
    expect(typeof arg.responseMs).toBe("number");
    expect(arg.responseMs).toBeGreaterThanOrEqual(0);
    // The grade does NOT go through the attention queue.act path (FSRS only).
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    // The cursor advanced to the next item; no detour to /review.
    await waitFor(() => expect(currentItemId()).not.toBe("card-1"));
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("does NOT offer the attention ScheduleMenu on a card (FSRS only)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(currentItemId()).toBe("card-1");
    expect(screen.queryByTestId("schedule-menu")).toBeNull();
  });

  it("opens the current item in full via the open action (the only navigation)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    // Advance past the card to the source item.
    fireEvent.click(screen.getByTestId("process-action-skip"));
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
    fireEvent.click(screen.getByTestId("process-action-open"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "source-1" } });
  });

  it("T076: requests queue.list with mode `full` on mount", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(h.listQueue).toHaveBeenCalledWith(expect.objectContaining({ mode: "full" }));
  });

  it("T076: switching the SessionMode re-requests queue.list with the new mode (soft re-order, not a slice)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    h.listQueue.mockClear();

    fireEvent.click(screen.getByTestId("process-mode-review"));
    // The mode flows to the read as a soft ordering bias — a deliberate re-fetch.
    await waitFor(() =>
      expect(h.listQueue).toHaveBeenCalledWith(expect.objectContaining({ mode: "review" })),
    );

    fireEvent.click(screen.getByTestId("process-mode-read"));
    await waitFor(() =>
      expect(h.listQueue).toHaveBeenCalledWith(expect.objectContaining({ mode: "read" })),
    );
  });

  it("T076: the 'N left' counter reflects the FULL mixed deck, not a type-filtered slice", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-progress");
    // The seeded mock returns a card + a source + an extract (3 mixed items): the deck
    // total is 3 and "N left" counts the full mixed remainder.
    expect(screen.getByTestId("process-progress")).toHaveTextContent("1 / 3");
    expect(screen.getByTestId("process-progress")).toHaveTextContent("3 left");

    // Switching to review mode keeps the FULL deck (cards AND reading items) — the
    // old `modeIncludes` hard filter is gone, so the total never drops to a 1-card slice.
    fireEvent.click(screen.getByTestId("process-mode-review"));
    await waitFor(() =>
      expect(h.listQueue).toHaveBeenCalledWith(expect.objectContaining({ mode: "review" })),
    );
    await waitFor(() => expect(screen.getByTestId("process-progress")).toHaveTextContent("1 / 3"));
    expect(screen.getByTestId("process-progress")).toHaveTextContent("3 left");
  });
});

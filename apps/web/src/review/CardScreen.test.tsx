import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardEditSummary, ReviewCardView } from "../lib/appApi";

const h = vi.hoisted(() => ({
  routeId: "card-qa",
  navigateSpy: vi.fn(),
  selectSpy: vi.fn(),
  navigateToLocationSpy: vi.fn(),
  reviewCard: vi.fn(),
  updateCard: vi.fn(),
  suspendCard: vi.fn(),
  deleteCard: vi.fn(),
  flagCard: vi.fn(),
  markLeechCard: vi.fn(),
  retireCard: vi.fn(),
  getInspectorData: vi.fn(),
  createTask: vi.fn(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      reviewCard: h.reviewCard,
      updateCard: h.updateCard,
      suspendCard: h.suspendCard,
      deleteCard: h.deleteCard,
      flagCard: h.flagCard,
      markLeechCard: h.markLeechCard,
      retireCard: h.retireCard,
      getInspectorData: h.getInspectorData,
      createTask: h.createTask,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
  useParams: () => ({ id: h.routeId }),
}));

vi.mock("../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
}));

vi.mock("../reader/navigateToLocation", () => ({
  useNavigateToLocation: () => h.navigateToLocationSpy,
}));

import { hasActiveScope } from "../shell/activeScope";
import { CardScreen } from "./CardScreen";

const QA_SOURCE_REF: NonNullable<ReviewCardView["sourceRef"]> = {
  sourceElementId: "src-1",
  sourceTitle: "On the Measure of Intelligence",
  url: "https://arxiv.org/abs/1911.01547",
  author: "François Chollet",
  publishedAt: "2019-11-05T00:00:00.000Z",
  locationLabel: "¶ 4",
  snippet: "Intelligence is a measure of skill-acquisition efficiency…",
  sourceType: null,
  reliabilityTier: null,
  confidence: null,
  reliabilityNotes: null,
};

const QA_CARD: ReviewCardView = {
  id: "card-qa",
  kind: "qa",
  prompt: "How does Chollet define intelligence?",
  answer: "As skill-acquisition efficiency.",
  cloze: null,
  priority: 0.875,
  stage: "active_card",
  concept: "Intelligence",
  sourceTitle: "On the Measure of Intelligence",
  sourceLocationLabel: "¶ 4",
  ref: "Intelligence is a measure of skill-acquisition efficiency…",
  sourceRef: QA_SOURCE_REF,
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

const SECOND_CARD: ReviewCardView = {
  ...QA_CARD,
  id: "card-2",
  prompt: "What is the second card asking?",
  answer: "The second answer.",
  sourceTitle: "Second source",
  sourceLocationLabel: "¶ 8",
  sourceRef: {
    ...QA_SOURCE_REF,
    sourceElementId: "src-2",
    sourceTitle: "Second source",
    locationLabel: "¶ 8",
    snippet: "The second answer.",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function editSummary(overrides: Partial<CardEditSummary> = {}): CardEditSummary {
  return {
    id: "card-qa",
    type: "card",
    status: "active",
    stage: "active_card",
    priority: 0.875,
    title: "card",
    kind: "qa",
    prompt: "Edited prompt?",
    answer: "Edited answer.",
    cloze: null,
    parentId: "ex-1",
    sourceId: "src-1",
    flagged: false,
    leech: false,
    retired: false,
    deleted: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.routeId = "card-qa";
  h.reviewCard.mockResolvedValue({ card: QA_CARD });
  h.updateCard.mockResolvedValue({ card: editSummary() });
  h.suspendCard.mockResolvedValue({ card: editSummary({ status: "suspended" }) });
  h.deleteCard.mockResolvedValue({ card: editSummary({ status: "deleted", deleted: true }) });
  h.flagCard.mockResolvedValue({ card: editSummary({ flagged: true }) });
  h.markLeechCard.mockResolvedValue({ card: editSummary({ leech: true }) });
  h.retireCard.mockResolvedValue({ card: editSummary({ retired: true }) });
  h.getInspectorData.mockResolvedValue({ data: null });
  h.createTask.mockResolvedValue({});
});

describe("CardScreen", () => {
  it("loads one card by route id and keeps the answer/source hidden until reveal", async () => {
    render(<CardScreen />);

    const card = await screen.findByTestId("card-detail");
    expect(h.reviewCard).toHaveBeenCalledWith({ cardId: "card-qa" });
    expect(h.selectSpy).toHaveBeenCalledWith(null);
    expect(h.selectSpy).not.toHaveBeenCalledWith("card-qa");
    expect(card).toHaveAttribute("data-card-id", "card-qa");
    expect(screen.getByTestId("card-prompt")).toHaveTextContent(/define intelligence/i);
    expect(screen.queryByTestId("card-answer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-refblock")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-repair-edit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-repair-source")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-repair-context")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("card-reveal"));

    await waitFor(() => expect(h.selectSpy).toHaveBeenCalledWith("card-qa"));
    expect(await screen.findByTestId("card-answer")).toHaveTextContent(
      /skill-acquisition efficiency/i,
    );
    expect(await screen.findByTestId("card-refblock")).toBeInTheDocument();
    expect(screen.getByTestId("card-refblock-citation")).toHaveTextContent("François Chollet");
    expect(screen.getByTestId("review-repair-edit")).toBeInTheDocument();
    expect(screen.getByTestId("review-repair-source")).toBeInTheDocument();
    expect(screen.getByTestId("review-repair-context")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Hide answer"));
    await waitFor(() => expect(h.selectSpy).toHaveBeenLastCalledWith(null));
  });

  it("owns global element actions while the route-selected card is loading and hidden", async () => {
    const load = deferred<{ card: ReviewCardView | null }>();
    h.reviewCard.mockReturnValueOnce(load.promise);
    render(<CardScreen />);

    await screen.findByTestId("card-loading");
    await waitFor(() => expect(hasActiveScope()).toBe(true));

    load.resolve({ card: QA_CARD });
    await screen.findByTestId("card-detail");
    expect(hasActiveScope()).toBe(true);
    expect(h.selectSpy).not.toHaveBeenCalledWith("card-qa");

    fireEvent.click(screen.getByTestId("card-reveal"));
    await waitFor(() => expect(hasActiveScope()).toBe(false));
    await waitFor(() => expect(h.selectSpy).toHaveBeenCalledWith("card-qa"));
  });

  it("edits the opened card through the existing card update path and patches the visible body", async () => {
    render(<CardScreen />);

    await screen.findByTestId("card-detail");
    fireEvent.click(screen.getByTestId("card-reveal"));
    await screen.findByTestId("card-answer");

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Edited prompt?" } });
    const answer = screen.getByTestId("review-edit-answer");
    fireEvent.change(answer, { target: { value: "Edited answer." } });
    fireEvent.blur(answer);

    await waitFor(() =>
      expect(h.updateCard).toHaveBeenCalledWith({
        cardId: "card-qa",
        prompt: "Edited prompt?",
        answer: "Edited answer.",
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("card-prompt")).toHaveTextContent("Edited prompt?");
      expect(screen.getByTestId("card-answer")).toHaveTextContent("Edited answer.");
    });
  });

  it("shows a missing-card state when the targeted card is not live", async () => {
    h.reviewCard.mockResolvedValue({ card: null });
    render(<CardScreen />);

    await screen.findByTestId("card-empty");
    expect(screen.getByText(/card not found/i)).toBeInTheDocument();
    expect(screen.queryByTestId("card-detail")).not.toBeInTheDocument();
  });

  it("resets reveal state when navigating between card ids in the same route component", async () => {
    h.reviewCard.mockResolvedValueOnce({ card: QA_CARD }).mockResolvedValueOnce({
      card: SECOND_CARD,
    });
    const view = render(<CardScreen />);

    await screen.findByTestId("card-detail");
    fireEvent.click(screen.getByTestId("card-reveal"));
    await screen.findByTestId("card-answer");

    h.routeId = "card-2";
    view.rerender(<CardScreen />);

    await waitFor(() => expect(h.reviewCard).toHaveBeenLastCalledWith({ cardId: "card-2" }));
    await waitFor(() =>
      expect(screen.getByTestId("card-detail")).toHaveAttribute("data-card-id", "card-2"),
    );
    expect(screen.getByTestId("card-prompt")).toHaveTextContent("What is the second card asking?");
    expect(screen.queryByTestId("card-answer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-refblock")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("card-reveal"));
    expect(await screen.findByTestId("card-answer")).toHaveTextContent("The second answer.");
  });

  it("clears the previous card when a later route-id load rejects", async () => {
    h.reviewCard
      .mockResolvedValueOnce({ card: QA_CARD })
      .mockRejectedValueOnce(new Error("bridge unavailable"));
    const view = render(<CardScreen />);

    await screen.findByTestId("card-detail");
    expect(screen.getByTestId("card-prompt")).toHaveTextContent(/define intelligence/i);

    h.routeId = "card-2";
    view.rerender(<CardScreen />);

    await screen.findByTestId("card-empty");
    expect(screen.getByText("bridge unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("card-detail")).not.toBeInTheDocument();
    expect(screen.queryByText(/define intelligence/i)).not.toBeInTheDocument();
  });

  it("ignores stale open-source responses after the route id changes", async () => {
    h.reviewCard.mockResolvedValueOnce({ card: QA_CARD }).mockResolvedValueOnce({
      card: SECOND_CARD,
    });
    const sourceRead = deferred<{ data: { location: unknown } }>();
    h.getInspectorData.mockReturnValueOnce(sourceRead.promise);
    const view = render(<CardScreen />);

    await screen.findByTestId("card-detail");
    fireEvent.click(screen.getByTestId("card-reveal"));
    await screen.findByTestId("review-repair-source");
    fireEvent.click(screen.getByTestId("review-repair-source"));

    h.routeId = "card-2";
    view.rerender(<CardScreen />);
    await waitFor(() =>
      expect(screen.getByTestId("card-detail")).toHaveAttribute("data-card-id", "card-2"),
    );

    sourceRead.resolve({
      data: {
        location: {
          sourceElementId: "src-1",
          blockIds: ["block-1"],
          startOffset: 0,
          endOffset: 5,
        },
      },
    });

    await sourceRead.promise;
    await Promise.resolve();
    expect(h.navigateToLocationSpy).not.toHaveBeenCalled();
  });
});

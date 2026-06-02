/**
 * ReviewRepairBar component tests (T038 — in-review card repair).
 *
 * The card mutations (edit / suspend / delete / flag) + the `operation_log` ops
 * live MAIN-side (`CardEditService`); this asserts the RENDERER seam the spec
 * calls out:
 *  - Edit opens the inline editor and saves via the typed `appApi.updateCard`,
 *    then patches the in-flight card;
 *  - Open source calls back into the parent's lineage jump-back;
 *  - Suspend / Delete call their commands and advance the session (remove the card);
 *  - Flag toggles the non-destructive marker via `appApi.flagCard`.
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring:
 * `window.appApi.*` are spies. No SQLite/IPC.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardEditSummary, ReviewCardView } from "../lib/appApi";

const h = vi.hoisted(() => ({
  updateCard: vi.fn(),
  suspendCard: vi.fn(),
  deleteCard: vi.fn(),
  flagCard: vi.fn(),
  markLeechCard: vi.fn(),
  onOpenSource: vi.fn(),
  onCardUpdated: vi.fn(),
  onCardRemoved: vi.fn(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      updateCard: h.updateCard,
      suspendCard: h.suspendCard,
      deleteCard: h.deleteCard,
      flagCard: h.flagCard,
      markLeechCard: h.markLeechCard,
    },
  };
});

import { ReviewRepairBar } from "./ReviewRepairBar";

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
};

function summary(overrides: Partial<CardEditSummary> = {}): CardEditSummary {
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
    deleted: false,
    ...overrides,
  };
}

/**
 * The source-context drawer is controlled by the parent (`ReviewScreen`); this tiny
 * harness owns that state so the bar behaves exactly as it does in the app (one
 * drawer, lifted open/close).
 */
function Harness({ card, busy }: { card: ReviewCardView; busy: boolean }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  return (
    <ReviewRepairBar
      card={card}
      busy={busy}
      onOpenSource={h.onOpenSource}
      onCardUpdated={h.onCardUpdated}
      onCardRemoved={h.onCardRemoved}
      drawerOpen={drawerOpen}
      onDrawerOpenChange={setDrawerOpen}
    />
  );
}

function renderBar(card: ReviewCardView = QA_CARD, busy = false) {
  return render(<Harness card={card} busy={busy} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.updateCard.mockResolvedValue({ card: summary() });
  h.suspendCard.mockResolvedValue({ card: summary({ status: "suspended" }) });
  h.deleteCard.mockResolvedValue({ card: summary({ status: "deleted", deleted: true }) });
  h.flagCard.mockResolvedValue({ card: summary({ flagged: true }) });
  h.markLeechCard.mockResolvedValue({ card: summary({ leech: false }) });
});

describe("ReviewRepairBar", () => {
  it("edits the prompt/answer and saves via appApi.updateCard, patching the card", async () => {
    renderBar();

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Edited prompt?" } });
    fireEvent.change(screen.getByTestId("review-edit-answer"), {
      target: { value: "Edited answer." },
    });
    fireEvent.click(screen.getByTestId("review-edit-save"));

    await waitFor(() => expect(h.updateCard).toHaveBeenCalledTimes(1));
    expect(h.updateCard).toHaveBeenCalledWith({
      cardId: "card-qa",
      prompt: "Edited prompt?",
      answer: "Edited answer.",
    });
    await waitFor(() =>
      expect(h.onCardUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ id: "card-qa", prompt: "Edited prompt?" }),
      ),
    );
    // The editor closed after a successful save.
    await waitFor(() => expect(screen.queryByTestId("review-edit")).not.toBeInTheDocument());
  });

  it("edits cloze cards through the cloze field (not prompt/answer)", async () => {
    const clozeCard: ReviewCardView = {
      ...QA_CARD,
      id: "card-cloze",
      kind: "cloze",
      prompt: "Intelligence is {{c1::skill-acquisition efficiency}}.",
      answer: null,
      cloze: "Intelligence is {{c1::skill-acquisition efficiency}}.",
    };
    h.updateCard.mockResolvedValue({
      card: summary({ id: "card-cloze", kind: "cloze", prompt: null, answer: null, cloze: "x" }),
    });
    renderBar(clozeCard);

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const cloze = await screen.findByTestId("review-edit-cloze");
    fireEvent.change(cloze, { target: { value: "Intelligence is {{c1::edited}}." } });
    fireEvent.click(screen.getByTestId("review-edit-save"));

    await waitFor(() =>
      expect(h.updateCard).toHaveBeenCalledWith({
        cardId: "card-cloze",
        cloze: "Intelligence is {{c1::edited}}.",
      }),
    );
  });

  it("edits an image_occlusion card through a single Reveal label field (not prompt/answer)", async () => {
    const occlusionCard: ReviewCardView = {
      ...QA_CARD,
      id: "card-occ",
      kind: "image_occlusion",
      // An occlusion card has no prompt text body; the mask reveal label lives on answer.
      prompt: "",
      answer: "Hippocampus",
      cloze: null,
    };
    h.updateCard.mockResolvedValue({
      card: summary({
        id: "card-occ",
        kind: "image_occlusion",
        prompt: null,
        answer: "Amygdala",
        cloze: null,
      }),
    });
    renderBar(occlusionCard);

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    // The editor shows the label field only — NO prompt/answer/cloze textareas.
    const label = await screen.findByTestId("review-edit-occlusion-label");
    expect(screen.queryByTestId("review-edit-prompt")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-edit-answer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-edit-cloze")).not.toBeInTheDocument();
    expect(label).toHaveValue("Hippocampus");

    fireEvent.change(label, { target: { value: "Amygdala" } });
    fireEvent.click(screen.getByTestId("review-edit-save"));

    // Only the answer (label) is sent — no prompt key.
    await waitFor(() =>
      expect(h.updateCard).toHaveBeenCalledWith({ cardId: "card-occ", answer: "Amygdala" }),
    );
  });

  it("Open source calls back into the parent's lineage jump-back", () => {
    renderBar();
    fireEvent.click(screen.getByTestId("review-repair-source"));
    expect(h.onOpenSource).toHaveBeenCalledTimes(1);
  });

  it("suspends a card and advances the session", async () => {
    renderBar();
    fireEvent.click(screen.getByTestId("review-repair-suspend"));
    await waitFor(() => expect(h.suspendCard).toHaveBeenCalledWith({ cardId: "card-qa" }));
    await waitFor(() => expect(h.onCardRemoved).toHaveBeenCalledTimes(1));
  });

  it("deletes a card and advances the session", async () => {
    renderBar();
    fireEvent.click(screen.getByTestId("review-repair-delete"));
    await waitFor(() => expect(h.deleteCard).toHaveBeenCalledWith({ cardId: "card-qa" }));
    await waitFor(() => expect(h.onCardRemoved).toHaveBeenCalledTimes(1));
  });

  it("flags a card as bad via appApi.flagCard and patches it (stays in the deck)", async () => {
    renderBar();
    fireEvent.click(screen.getByTestId("review-repair-flag"));
    await waitFor(() =>
      expect(h.flagCard).toHaveBeenCalledWith({ cardId: "card-qa", flagged: true }),
    );
    await waitFor(() =>
      expect(h.onCardUpdated).toHaveBeenCalledWith(expect.objectContaining({ flagged: true })),
    );
    // Flagging does NOT advance the session (the card stays).
    expect(h.onCardRemoved).not.toHaveBeenCalled();
  });

  it("un-flags an already-flagged card", async () => {
    h.flagCard.mockResolvedValue({ card: summary({ flagged: false }) });
    renderBar({ ...QA_CARD, flagged: true });
    expect(screen.getByTestId("review-repair-flag")).toHaveTextContent(/flagged/i);
    fireEvent.click(screen.getByTestId("review-repair-flag"));
    await waitFor(() =>
      expect(h.flagCard).toHaveBeenCalledWith({ cardId: "card-qa", flagged: false }),
    );
  });

  it("opens the source-context drawer and routes its open-source to the parent", async () => {
    renderBar();
    fireEvent.click(screen.getByTestId("review-repair-context"));
    const drawer = await screen.findByTestId("review-context-drawer");
    expect(drawer).toHaveTextContent("On the Measure of Intelligence");
    fireEvent.click(screen.getByTestId("review-drawer-open-source"));
    expect(h.onOpenSource).toHaveBeenCalledTimes(1);
  });

  it("marks a non-leech card as a leech via appApi.markLeechCard (stays in the deck)", async () => {
    h.markLeechCard.mockResolvedValue({ card: summary({ leech: true }) });
    renderBar();
    expect(screen.getByTestId("review-repair-leech")).toHaveTextContent(/mark leech/i);

    fireEvent.click(screen.getByTestId("review-repair-leech"));

    await waitFor(() =>
      expect(h.markLeechCard).toHaveBeenCalledWith({ cardId: "card-qa", leech: true }),
    );
    await waitFor(() =>
      expect(h.onCardUpdated).toHaveBeenCalledWith(expect.objectContaining({ leech: true })),
    );
    // Marking a leech does NOT advance the session (the card stays).
    expect(h.onCardRemoved).not.toHaveBeenCalled();
  });

  it("un-leeches an already-leech card after remediation", async () => {
    h.markLeechCard.mockResolvedValue({ card: summary({ leech: false }) });
    renderBar({ ...QA_CARD, leech: true });
    expect(screen.getByTestId("review-repair-leech")).toHaveTextContent(/^leech$/i);

    fireEvent.click(screen.getByTestId("review-repair-leech"));

    await waitFor(() =>
      expect(h.markLeechCard).toHaveBeenCalledWith({ cardId: "card-qa", leech: false }),
    );
    await waitFor(() =>
      expect(h.onCardUpdated).toHaveBeenCalledWith(expect.objectContaining({ leech: false })),
    );
  });

  it("keyboard `s` suspends and `e` opens the inline editor (review-scope repair keys)", async () => {
    renderBar();

    // `e` opens the inline editor (the SAME handler the Edit button calls).
    fireEvent.keyDown(window, { key: "e" });
    expect(await screen.findByTestId("review-edit")).toBeInTheDocument();

    // While the editor is open the repair keys are suppressed (so `s` typed in the
    // body never suspends mid-edit). Cancel, then `s` suspends + advances.
    fireEvent.click(screen.getByTestId("review-edit-cancel"));
    await waitFor(() => expect(screen.queryByTestId("review-edit")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(h.suspendCard).toHaveBeenCalledWith({ cardId: "card-qa" }));
    await waitFor(() => expect(h.onCardRemoved).toHaveBeenCalledTimes(1));
  });

  it("ignores repair keys while focus is in a textarea (typing the prompt is unaffected)", async () => {
    renderBar();
    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    // `s` typed into the prompt field must NOT suspend the card.
    fireEvent.keyDown(prompt, { key: "s" });
    expect(h.suspendCard).not.toHaveBeenCalled();
  });
});

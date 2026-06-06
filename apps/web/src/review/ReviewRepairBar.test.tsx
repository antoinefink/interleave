/**
 * ReviewRepairBar component tests (T038 — in-review card repair).
 *
 * The card mutations (edit / suspend / delete / flag) + the `operation_log` ops
 * live MAIN-side (`CardEditService`); this asserts the RENDERER seam the spec
 * calls out:
 *  - Edit opens the inline editor and autosaves via the typed `appApi.updateCard`,
 *    then patches the in-flight card;
 *  - Open source calls back into the parent's lineage jump-back;
 *  - Suspend / Delete call their commands and advance the session (remove the card);
 *  - Flag toggles the non-destructive marker via `appApi.flagCard`.
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring:
 * `window.appApi.*` are spies. No SQLite/IPC.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CardEditSummary, ReviewCardView } from "../lib/appApi";

const h = vi.hoisted(() => ({
  updateCard: vi.fn(),
  suspendCard: vi.fn(),
  deleteCard: vi.fn(),
  flagCard: vi.fn(),
  markLeechCard: vi.fn(),
  retireCard: vi.fn(),
  onOpenSource: vi.fn(),
  onCardUpdated: vi.fn(),
  onCardRemoved: vi.fn(),
  onBusyChange: vi.fn(),
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
      retireCard: h.retireCard,
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
    sourceType: null,
    reliabilityTier: null,
    confidence: null,
    reliabilityNotes: null,
  },
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
    retired: false,
    deleted: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
      onBusyChange={h.onBusyChange}
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
  h.retireCard.mockResolvedValue({ card: summary({ retired: true }) });
});

describe("ReviewRepairBar", () => {
  it("autosaves prompt/answer edits via appApi.updateCard and patches the card", async () => {
    renderBar();

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Edited prompt?" } });
    fireEvent.change(screen.getByTestId("review-edit-answer"), {
      target: { value: "Edited answer." },
    });

    expect(screen.queryByTestId("review-edit-save")).not.toBeInTheDocument();
    await waitFor(() => expect(h.updateCard).toHaveBeenCalledTimes(1), { timeout: 1200 });
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

    fireEvent.click(screen.getByTestId("review-edit-done"));
    await waitFor(() => expect(screen.queryByTestId("review-edit")).not.toBeInTheDocument());
  });

  it("flushes card edits when an edit field blurs", async () => {
    renderBar();

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Blur-saved prompt?" } });
    fireEvent.blur(prompt);

    await waitFor(() =>
      expect(h.updateCard).toHaveBeenCalledWith({
        cardId: "card-qa",
        prompt: "Blur-saved prompt?",
        answer: "As skill-acquisition efficiency.",
      }),
    );
  });

  it("keeps the editor open and visible when a card edit save fails", async () => {
    h.updateCard.mockRejectedValueOnce(new Error("save failed"));
    renderBar();

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Rejected prompt?" } });
    fireEvent.blur(prompt);

    await waitFor(() => expect(h.updateCard).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("review-edit-error")).toHaveTextContent("save failed");
    expect(screen.getByTestId("review-edit")).toBeInTheDocument();
    expect(h.onCardUpdated).not.toHaveBeenCalled();
    expect(h.onBusyChange).toHaveBeenCalledWith(false);
    await waitFor(() => expect(h.onBusyChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByTestId("review-repair-suspend")).toBeDisabled();

    fireEvent.click(screen.getByTestId("review-edit-done"));
    await waitFor(() => expect(h.updateCard).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("review-edit")).not.toBeInTheDocument());
  });

  it("does not duplicate the same edit when blur and Done overlap", async () => {
    const save = deferred<{ card: CardEditSummary }>();
    h.updateCard.mockReturnValueOnce(save.promise);
    renderBar();

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Blur-saved prompt?" } });
    fireEvent.blur(prompt);
    await waitFor(() => expect(h.updateCard).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("review-edit-done"));
    await new Promise((r) => setTimeout(r, 10));

    expect(h.updateCard).toHaveBeenCalledTimes(1);
    expect(h.onBusyChange).toHaveBeenCalledWith(true);

    save.resolve({
      card: summary({ prompt: "Blur-saved prompt?", answer: "As skill-acquisition efficiency." }),
    });

    await waitFor(() =>
      expect(h.onCardUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Blur-saved prompt?" }),
      ),
    );
    await waitFor(() => expect(screen.queryByTestId("review-edit")).not.toBeInTheDocument());
    expect(h.onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("does not flush a dirty edit just because the parent re-renders", async () => {
    h.updateCard.mockResolvedValueOnce({
      card: summary({ prompt: "Dirty prompt?", answer: "As skill-acquisition efficiency." }),
    });
    function InlineUpdateHarness({ version }: { version: number }) {
      const [drawerOpen, setDrawerOpen] = useState(false);
      return (
        <ReviewRepairBar
          card={QA_CARD}
          busy={false}
          onOpenSource={h.onOpenSource}
          onCardUpdated={(patch) => h.onCardUpdated({ ...patch, version })}
          onCardRemoved={h.onCardRemoved}
          onBusyChange={h.onBusyChange}
          drawerOpen={drawerOpen}
          onDrawerOpenChange={setDrawerOpen}
        />
      );
    }
    const view = render(<InlineUpdateHarness version={1} />);

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Dirty prompt?" } });

    view.rerender(<InlineUpdateHarness version={2} />);
    await new Promise((r) => setTimeout(r, 10));

    expect(h.updateCard).not.toHaveBeenCalled();
    expect(h.onBusyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByTestId("review-edit-done"));

    await waitFor(() =>
      expect(h.updateCard).toHaveBeenCalledWith({
        cardId: "card-qa",
        prompt: "Dirty prompt?",
        answer: "As skill-acquisition efficiency.",
      }),
    );
    await waitFor(() =>
      expect(h.onCardUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Dirty prompt?" }),
      ),
    );
  });

  it("treats dirty debounced edits as busy until the save finishes", async () => {
    const save = deferred<{ card: CardEditSummary }>();
    h.updateCard.mockReturnValueOnce(save.promise);
    renderBar();

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Dirty prompt?" } });

    await waitFor(() => expect(h.onBusyChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByTestId("review-repair-suspend")).toBeDisabled();
    expect(screen.getByTestId("review-repair-delete")).toBeDisabled();
    fireEvent.click(screen.getByTestId("review-repair-suspend"));
    expect(h.suspendCard).not.toHaveBeenCalled();

    save.resolve({
      card: summary({ prompt: "Dirty prompt?", answer: "As skill-acquisition efficiency." }),
    });

    await waitFor(() => expect(h.onBusyChange).toHaveBeenLastCalledWith(false), {
      timeout: 1200,
    });
  });

  it("treats incomplete dirty edits as busy even though they are not autosave-ready", async () => {
    renderBar();

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "" } });

    await waitFor(() => expect(h.onBusyChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByTestId("review-repair-suspend")).toBeDisabled();
    expect(screen.getByTestId("review-repair-delete")).toBeDisabled();
    fireEvent.click(screen.getByTestId("review-repair-delete"));

    expect(h.deleteCard).not.toHaveBeenCalled();
    expect(h.updateCard).not.toHaveBeenCalled();
  });

  it("does not let an unmounted edit save clear a newer card's dirty busy state", async () => {
    const firstSave = deferred<{ card: CardEditSummary }>();
    h.updateCard.mockReturnValueOnce(firstSave.promise);
    const secondCard: ReviewCardView = {
      ...QA_CARD,
      id: "card-2",
      prompt: "Second prompt?",
      answer: "Second answer.",
    };
    function SwitchingHarness() {
      const [card, setCard] = useState(QA_CARD);
      const [busy, setBusy] = useState(false);
      const [drawerOpen, setDrawerOpen] = useState(false);
      const handleBusyChange = useCallback((next: boolean) => {
        h.onBusyChange(next);
        setBusy(next);
      }, []);
      return (
        <>
          <span data-testid="parent-busy">{String(busy)}</span>
          <button type="button" data-testid="switch-card" onClick={() => setCard(secondCard)}>
            Switch
          </button>
          <ReviewRepairBar
            key={card.id}
            card={card}
            busy={false}
            onOpenSource={h.onOpenSource}
            onCardUpdated={h.onCardUpdated}
            onCardRemoved={h.onCardRemoved}
            onBusyChange={handleBusyChange}
            drawerOpen={drawerOpen}
            onDrawerOpenChange={setDrawerOpen}
          />
        </>
      );
    }
    render(<SwitchingHarness />);

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const firstPrompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(firstPrompt, { target: { value: "First pending prompt?" } });
    await waitFor(() => expect(screen.getByTestId("parent-busy")).toHaveTextContent("true"));
    fireEvent.blur(firstPrompt);
    await waitFor(() => expect(h.updateCard).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("parent-busy")).toHaveTextContent("true");

    fireEvent.click(screen.getByTestId("switch-card"));
    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const secondPrompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(secondPrompt, { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("parent-busy")).toHaveTextContent("true"));

    firstSave.resolve({
      card: summary({
        prompt: "First pending prompt?",
        answer: "As skill-acquisition efficiency.",
      }),
    });
    await firstSave.promise;
    await Promise.resolve();

    expect(screen.getByTestId("parent-busy")).toHaveTextContent("true");
    expect(screen.getByTestId("review-repair-suspend")).toBeDisabled();
    expect(h.onBusyChange).toHaveBeenLastCalledWith(true);
  });

  it("ignores stale edit completions and applies the newest queued edit", async () => {
    const olderSave = deferred<{ card: CardEditSummary }>();
    const newerSave = deferred<{ card: CardEditSummary }>();
    h.updateCard.mockReturnValueOnce(olderSave.promise).mockReturnValueOnce(newerSave.promise);
    renderBar();

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Older prompt?" } });
    fireEvent.blur(prompt);
    await waitFor(() => expect(h.updateCard).toHaveBeenCalledTimes(1));

    fireEvent.change(prompt, { target: { value: "Newest prompt?" } });
    fireEvent.blur(prompt);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.updateCard).toHaveBeenCalledTimes(1);

    olderSave.resolve({
      card: summary({ prompt: "Older prompt?", answer: "As skill-acquisition efficiency." }),
    });

    await waitFor(() => expect(h.updateCard).toHaveBeenCalledTimes(2));
    expect(h.updateCard).toHaveBeenLastCalledWith({
      cardId: "card-qa",
      prompt: "Newest prompt?",
      answer: "As skill-acquisition efficiency.",
    });
    expect(h.onCardUpdated).not.toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Older prompt?" }),
    );

    newerSave.resolve({
      card: summary({ prompt: "Newest prompt?", answer: "As skill-acquisition efficiency." }),
    });

    await waitFor(() =>
      expect(h.onCardUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Newest prompt?" }),
      ),
    );
  });

  it("serializes an unmount edit flush behind an in-flight save", async () => {
    const olderSave = deferred<{ card: CardEditSummary }>();
    const unmountSave = deferred<{ card: CardEditSummary }>();
    h.updateCard.mockReturnValueOnce(olderSave.promise).mockReturnValueOnce(unmountSave.promise);
    const view = renderBar();

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Older prompt?" } });
    fireEvent.blur(prompt);
    await waitFor(() => expect(h.updateCard).toHaveBeenCalledTimes(1));

    fireEvent.change(prompt, { target: { value: "Unmount prompt?" } });
    view.unmount();
    await new Promise((r) => setTimeout(r, 10));

    expect(h.updateCard).toHaveBeenCalledTimes(1);

    olderSave.resolve({
      card: summary({ prompt: "Older prompt?", answer: "As skill-acquisition efficiency." }),
    });

    await waitFor(() => expect(h.updateCard).toHaveBeenCalledTimes(2));
    expect(h.updateCard).toHaveBeenLastCalledWith({
      cardId: "card-qa",
      prompt: "Unmount prompt?",
      answer: "As skill-acquisition efficiency.",
    });
    expect(h.onCardUpdated).not.toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Older prompt?" }),
    );

    unmountSave.resolve({
      card: summary({ prompt: "Unmount prompt?", answer: "As skill-acquisition efficiency." }),
    });
    await unmountSave.promise;
  });

  it("flushes pending card edits when the editor unmounts before the debounce fires", async () => {
    const view = renderBar();

    fireEvent.click(screen.getByTestId("review-repair-edit"));
    const prompt = await screen.findByTestId("review-edit-prompt");
    fireEvent.change(prompt, { target: { value: "Unmount-saved prompt?" } });

    view.unmount();

    await waitFor(() =>
      expect(h.updateCard).toHaveBeenCalledWith({
        cardId: "card-qa",
        prompt: "Unmount-saved prompt?",
        answer: "As skill-acquisition efficiency.",
      }),
    );
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
    await waitFor(() => expect(h.onCardRemoved).toHaveBeenCalledWith("card-qa"));
  });

  it("deletes a card and advances the session", async () => {
    renderBar();
    fireEvent.click(screen.getByTestId("review-repair-delete"));
    await waitFor(() => expect(h.deleteCard).toHaveBeenCalledWith({ cardId: "card-qa" }));
    await waitFor(() => expect(h.onCardRemoved).toHaveBeenCalledWith("card-qa"));
  });

  it("retires a card via appApi.retireCard and advances the session (T082)", async () => {
    renderBar();
    fireEvent.click(screen.getByTestId("review-repair-retire"));
    await waitFor(() => expect(h.retireCard).toHaveBeenCalledWith({ cardId: "card-qa" }));
    await waitFor(() => expect(h.onCardRemoved).toHaveBeenCalledWith("card-qa"));
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
    // body never suspends mid-edit). Close the autosaved editor, then `s` suspends.
    fireEvent.click(screen.getByTestId("review-edit-done"));
    await waitFor(() => expect(screen.queryByTestId("review-edit")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(h.suspendCard).toHaveBeenCalledWith({ cardId: "card-qa" }));
    await waitFor(() => expect(h.onCardRemoved).toHaveBeenCalledWith("card-qa"));
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

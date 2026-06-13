import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversionSessionPreviewResult } from "../../lib/appApi";

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  previewConversionSession: vi.fn(),
  createConversionCard: vi.fn(),
  prefetchConversionDrafts: vi.fn(),
  setConversionFate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));

vi.mock("../../lib/appApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/appApi")>();
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      previewConversionSession: h.previewConversionSession,
      createConversionCard: h.createConversionCard,
      prefetchConversionDrafts: h.prefetchConversionDrafts,
      setConversionFate: h.setConversionFate,
    },
  };
});

import { ConversionSession } from "./ConversionSession";

function preview(): ConversionSessionPreviewResult {
  return {
    sessionId: "session-1",
    asOf: "2026-06-13T08:00:00.000Z",
    expiresAt: "2026-06-13T08:15:00.000Z",
    limit: 25,
    candidateCount: 2,
    staleItemIds: [],
    items: [
      {
        id: "ex-1",
        title: "Skill acquisition efficiency",
        priority: 0.875,
        dueAt: "2026-06-13T08:00:00.000Z",
        plainText: "Intelligence is skill-acquisition efficiency over a scope of tasks.",
        excerpt: "Intelligence is skill-acquisition efficiency.",
        sourceRef: {
          sourceElementId: "src-1",
          sourceTitle: "On the Measure of Intelligence",
          url: null,
          author: "Francois Chollet",
          publishedAt: null,
          locationLabel: "¶1",
          snippet: "Intelligence is skill-acquisition efficiency over a scope of tasks.",
          sourceType: null,
          reliabilityTier: null,
          confidence: null,
          reliabilityNotes: null,
        },
        aiGrounding: {
          sourceElementId: "src-1",
          blockIds: ["block-1"],
          startOffset: 0,
          endOffset: 68,
          selectedText: "Intelligence is skill-acquisition efficiency over a scope of tasks.",
          context: "Definition paragraph.",
        },
        schedulerSignals: {
          kind: "attention",
          retrievability: null,
          stability: null,
          fsrsState: null,
          lapses: null,
          stage: "atomic_statement",
          postponed: 0,
          scheduleReason: null,
          retirementSuggestion: null,
        },
        drafts: [
          {
            id: "sug-1",
            action: "suggest_qa",
            kind: "card_qa",
            providerKind: "anthropic",
            suggestionText: "What is intelligence?",
            cards: [
              {
                kind: "qa",
                prompt: "How does Chollet define intelligence?",
                answer: "Skill-acquisition efficiency over a scope of tasks.",
              },
            ],
            createdAt: "2026-06-13T08:01:00.000Z",
          },
        ],
      },
      {
        id: "ex-2",
        title: "Generalization scope",
        priority: 0.625,
        dueAt: "2026-06-13T08:00:00.000Z",
        plainText: "The task scope defines the generalization space.",
        excerpt: "The task scope defines the generalization space.",
        sourceRef: {
          sourceElementId: "src-1",
          sourceTitle: "On the Measure of Intelligence",
          url: null,
          author: "Francois Chollet",
          publishedAt: null,
          locationLabel: "¶2",
          snippet: "The task scope defines the generalization space.",
          sourceType: null,
          reliabilityTier: null,
          confidence: null,
          reliabilityNotes: null,
        },
        aiGrounding: {
          sourceElementId: "src-1",
          blockIds: ["block-2"],
          startOffset: 0,
          endOffset: 48,
          selectedText: "The task scope defines the generalization space.",
          context: null,
        },
        schedulerSignals: {
          kind: "attention",
          retrievability: null,
          stability: null,
          fsrsState: null,
          lapses: null,
          stage: "atomic_statement",
          postponed: 1,
          scheduleReason: null,
          retirementSuggestion: null,
        },
        drafts: [],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.previewConversionSession.mockResolvedValue(preview());
  h.createConversionCard.mockResolvedValue({
    card: { id: "card-1", siblingGroupId: "sg-1" },
    sourceLocationId: "loc-1",
  });
  h.prefetchConversionDrafts.mockResolvedValue({
    queued: 2,
    skipped: [],
    alreadyDrafted: 0,
  });
  h.setConversionFate.mockResolvedValue({ extract: { id: "ex-1" } });
});

describe("ConversionSession", () => {
  it("loads a frozen conversion preview and renders the selected statement", async () => {
    render(<ConversionSession />);

    expect(await screen.findByTestId("convert-session")).toBeInTheDocument();
    expect(h.previewConversionSession).toHaveBeenCalledWith({ limit: 25 });
    expect(screen.getByTestId("convert-selected-title")).toHaveTextContent(
      "Skill acquisition efficiency",
    );
    expect(screen.getByTestId("convert-session-meta")).toHaveTextContent("2 candidates");
    expect(screen.getByTestId("convert-source-ref")).toBeInTheDocument();
  });

  it("creates a manual Q&A card through the conversion create path", async () => {
    render(<ConversionSession />);
    await screen.findByTestId("convert-session");

    fireEvent.change(screen.getByTestId("convert-prompt"), {
      target: { value: "How does Chollet define intelligence?" },
    });
    fireEvent.change(screen.getByTestId("convert-answer"), {
      target: { value: "Skill-acquisition efficiency over a scope of tasks." },
    });
    fireEvent.click(screen.getByTestId("convert-create"));

    await waitFor(() =>
      expect(h.createConversionCard).toHaveBeenCalledWith({
        sessionId: "session-1",
        extractId: "ex-1",
        kind: "qa",
        priority: "A",
        prompt: "How does Chollet define intelligence?",
        answer: "Skill-acquisition efficiency over a scope of tasks.",
      }),
    );
  });

  it("disables competing conversion actions while card creation is pending", async () => {
    let resolveCreate: ((value: unknown) => void) | undefined;
    h.createConversionCard.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    render(<ConversionSession />);
    await screen.findByTestId("convert-session");

    fireEvent.change(screen.getByTestId("convert-prompt"), {
      target: { value: "How does Chollet define intelligence?" },
    });
    fireEvent.change(screen.getByTestId("convert-answer"), {
      target: { value: "Skill-acquisition efficiency over a scope of tasks." },
    });
    fireEvent.click(screen.getByTestId("convert-create"));

    await waitFor(() => expect(screen.getByTestId("convert-create")).toBeDisabled());
    expect(screen.getByTestId("convert-skip")).toBeDisabled();
    expect(screen.getByTestId("convert-fate-reference")).toBeDisabled();
    expect(screen.getByTestId("convert-ai-open")).toBeDisabled();
    expect(screen.getByTestId("convert-use-draft-sug-1")).toBeDisabled();

    resolveCreate?.({
      card: { id: "card-1", siblingGroupId: "sg-1" },
      sourceLocationId: "loc-1",
    });
  });

  it("disables card creation while an extract fate mutation is pending", async () => {
    let resolveFate: ((value: unknown) => void) | undefined;
    h.setConversionFate.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFate = resolve;
      }),
    );
    render(<ConversionSession />);
    await screen.findByTestId("convert-session");

    fireEvent.change(screen.getByTestId("convert-prompt"), {
      target: { value: "How does Chollet define intelligence?" },
    });
    fireEvent.change(screen.getByTestId("convert-answer"), {
      target: { value: "Skill-acquisition efficiency over a scope of tasks." },
    });
    fireEvent.click(screen.getByTestId("convert-fate-reference"));

    await waitFor(() => expect(screen.getByTestId("convert-create")).toBeDisabled());
    fireEvent.click(screen.getByTestId("convert-create"));
    expect(h.createConversionCard).not.toHaveBeenCalled();

    resolveFate?.({ extract: { id: "ex-1" } });
  });

  it("requires explicit session consent before queuing AI pre-drafts", async () => {
    render(<ConversionSession />);
    await screen.findByTestId("convert-session");

    expect(h.prefetchConversionDrafts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("convert-ai-open"));
    expect(screen.getByTestId("convert-ai-consent")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("convert-ai-confirm"));
    await waitFor(() =>
      expect(h.prefetchConversionDrafts).toHaveBeenCalledWith({
        sessionId: "session-1",
        action: "suggest_qa",
        consentedAt: expect.any(String),
      }),
    );
    expect(await screen.findByTestId("convert-ai-result")).toHaveTextContent("2 queued");
  });

  it("refreshes the existing frozen session rather than starting a new snapshot", async () => {
    h.previewConversionSession.mockResolvedValueOnce(preview()).mockResolvedValueOnce({
      ...preview(),
      sessionId: "session-1",
      staleItemIds: ["ex-2"],
      items: [preview().items[0]],
    });
    render(<ConversionSession />);
    await screen.findByTestId("convert-session");

    fireEvent.click(screen.getByTestId("convert-refresh"));

    await waitFor(() =>
      expect(h.previewConversionSession).toHaveBeenLastCalledWith({
        limit: 25,
        sessionId: "session-1",
      }),
    );
    expect(await screen.findByTestId("convert-notice")).toHaveTextContent(
      "1 session item(s) changed",
    );
  });

  it("copies a draft into the builder without auto-creating a card", async () => {
    render(<ConversionSession />);
    await screen.findByTestId("convert-session");

    fireEvent.click(screen.getByTestId("convert-use-draft-sug-1"));

    expect(h.createConversionCard).not.toHaveBeenCalled();
    expect(screen.getByTestId("convert-prompt")).toHaveValue(
      "How does Chollet define intelligence?",
    );
    expect(screen.getByTestId("convert-answer")).toHaveValue(
      "Skill-acquisition efficiency over a scope of tasks.",
    );
  });

  it("does not consume a draft suggestion after the copied text is manually edited", async () => {
    render(<ConversionSession />);
    await screen.findByTestId("convert-session");

    fireEvent.click(screen.getByTestId("convert-use-draft-sug-1"));
    fireEvent.change(screen.getByTestId("convert-prompt"), {
      target: { value: "Edited question?" },
    });
    fireEvent.click(screen.getByTestId("convert-create"));

    await waitFor(() =>
      expect(h.createConversionCard).toHaveBeenCalledWith({
        sessionId: "session-1",
        extractId: "ex-1",
        kind: "qa",
        priority: "A",
        prompt: "Edited question?",
        answer: "Skill-acquisition efficiency over a scope of tasks.",
      }),
    );
  });

  it("guards dirty builder text before replacing it with a draft", async () => {
    render(<ConversionSession />);
    await screen.findByTestId("convert-session");

    fireEvent.change(screen.getByTestId("convert-prompt"), {
      target: { value: "My question?" },
    });
    fireEvent.click(screen.getByTestId("convert-use-draft-sug-1"));

    expect(screen.getByTestId("convert-replace-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("convert-prompt")).toHaveValue("My question?");

    fireEvent.click(screen.getByTestId("convert-replace-confirm-yes"));
    expect(screen.getByTestId("convert-prompt")).toHaveValue(
      "How does Chollet define intelligence?",
    );
  });

  it("applies honorable extract fates through the conversion-scoped fate command", async () => {
    render(<ConversionSession />);
    await screen.findByTestId("convert-session");

    fireEvent.click(screen.getByTestId("convert-fate-reference"));

    await waitFor(() =>
      expect(h.setConversionFate).toHaveBeenCalledWith({
        sessionId: "session-1",
        id: "ex-1",
        fate: "reference",
      }),
    );
    expect(
      within(screen.getByTestId("convert-session")).getByTestId("convert-selected-title"),
    ).toHaveTextContent("Generalization scope");
  });
});

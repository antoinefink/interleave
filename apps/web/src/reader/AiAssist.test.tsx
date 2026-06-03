/**
 * AiAssist jump-to-source wiring tests (T094 — AI source grounding).
 *
 * Covers the renderer seam the T094 spec calls out for the drafts panel: an AI
 * draft's grounding `RefBlock` carries a WORKING in-app "jump to source" that lands
 * on the originating block exactly like an extract/card refblock — and the calm
 * orphan degradation when the grounding span resolves no source.
 *
 * What we assert (the bits `AiAssist.locationFromGrounding` + the guarded
 * `onOpenSource` spread own — the same path the Playwright e2e exercises end-to-end):
 *  - a draft whose `groundingLocation` is non-null renders the
 *    `refblock-open-source` button, and clicking it routes to the grounding source's
 *    reader (`/source/$id`) with the first spanned STABLE block id as the jump target;
 *  - the `LocationSummary` handed to navigation is built from the grounding span, with
 *    the AI-irrelevant page / region / clip / timestamp fields degraded to `null`;
 *  - a draft whose `groundingLocation` is `null` (orphan / soft-deleted source) shows
 *    NO jump affordance — a calm refblock with no "open source" button, never a crash.
 *
 * The renderer is a pure UI consumer here: `window.appApi.ai.*` is mocked (no IPC, no
 * model, no network — drafts are seeded directly), and the router `useNavigate` is a
 * spy so we observe the jump target `useNavigateToLocation` computes without a live
 * router.
 */

import type { SourceRef } from "@interleave/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiGroundingLocation, AiSuggestionView } from "../lib/appApi";

const h = vi.hoisted(() => ({
  aiStatus: vi.fn(),
  listAiSuggestions: vi.fn(),
  subscribeJobs: vi.fn(() => () => {}),
  navigateSpy: vi.fn(),
}));

vi.mock("../lib/appApi", () => ({
  isDesktop: () => true,
  appApi: {
    aiStatus: h.aiStatus,
    listAiSuggestions: h.listAiSuggestions,
    subscribeJobs: h.subscribeJobs,
    runAi: vi.fn(),
    approveAiCard: vi.fn(),
    dismissAiSuggestion: vi.fn(),
  },
}));

// The drafts panel reuses the shared T022 jump-to-source navigation; stub the router
// seam so we can read the route + jump param `useNavigateToLocation` produces.
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
}));

import { AiAssist } from "./AiAssist";

/** A resolved grounding ref so `RefBlock` treats the draft as having a source. */
const GROUNDED_REF: SourceRef = {
  sourceElementId: "src_1",
  sourceTitle: "On the Measure of Intelligence",
  url: null,
  author: "François Chollet",
  publishedAt: "2019",
  locationLabel: "Definition · ¶ 4",
  snippet: "Intelligence is skill-acquisition efficiency.",
  sourceType: null,
  reliabilityTier: null,
  confidence: null,
  reliabilityNotes: null,
};

const GROUNDING_LOCATION: AiGroundingLocation = {
  label: "Definition · ¶ 4",
  selectedText: "Intelligence is skill-acquisition efficiency.",
  sourceElementId: "src_1",
  blockIds: ["blk_intro_p1", "blk_intro_p2"],
  startOffset: 3,
  endOffset: 17,
};

function suggestion(overrides?: Partial<AiSuggestionView>): AiSuggestionView {
  return {
    id: "sug_1",
    action: "suggest_qa",
    kind: "card_qa",
    text: "Q: What is intelligence? A: Skill-acquisition efficiency.",
    cards: [
      { kind: "qa", prompt: "What is intelligence?", answer: "Skill-acquisition efficiency." },
    ],
    status: "pending",
    qualityChecks: [],
    grounding: GROUNDED_REF,
    groundingLocation: GROUNDING_LOCATION,
    ...overrides,
  };
}

const GROUNDING: React.ComponentProps<typeof AiAssist>["grounding"] = {
  sourceElementId: "src_1",
  blockIds: ["blk_intro_p1"],
  startOffset: 3,
  endOffset: 17,
  selectedText: "Intelligence is skill-acquisition efficiency.",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.aiStatus.mockResolvedValue({
    enabled: true,
    providerKind: "local",
    keyConfigured: true,
    modelDownloaded: true,
    managedProxyEnabled: false,
  });
  h.subscribeJobs.mockReturnValue(() => {});
});

describe("AiAssist — grounding jump-to-source wiring (T094)", () => {
  it("renders a working jump affordance and routes to the grounding source's reader on the originating block", async () => {
    h.listAiSuggestions.mockResolvedValue({ suggestions: [suggestion()] });
    render(<AiAssist owningElementId="ex_1" grounding={GROUNDING} />);

    // The draft + its grounding refblock render once the suggestions resolve.
    const jump = await screen.findByTestId("refblock-open-source");
    fireEvent.click(jump);

    // Clicking jumps to the grounding source's reader, scrolling to the FIRST spanned
    // stable block (T022 resolves by stable id, never an absolute position).
    expect(h.navigateSpy).toHaveBeenCalledTimes(1);
    const navArg = h.navigateSpy.mock.calls[0]?.[0] as {
      to: string;
      params: { id: string };
      search: { block: string; offset?: number; label?: string };
    };
    expect(navArg.to).toBe("/source/$id");
    expect(navArg.params).toEqual({ id: "src_1" });
    expect(navArg.search.block).toBe("blk_intro_p1");
    expect(navArg.search.offset).toBe(3);
    expect(navArg.search.label).toBe("Definition · ¶ 4");
  });

  it("omits the jump affordance for an orphan draft whose grounding resolves no source (calm degradation)", async () => {
    // A grounded refblock body, but no resolvable jump target (e.g. soft-deleted source).
    h.listAiSuggestions.mockResolvedValue({
      suggestions: [suggestion({ groundingLocation: null })],
    });
    render(<AiAssist owningElementId="ex_1" grounding={GROUNDING} />);

    // The draft still renders (with its refblock) — but with NO "open source" button.
    await screen.findByTestId("ai-draft");
    expect(screen.queryByTestId("refblock-open-source")).toBeNull();
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("degrades the AI-irrelevant location fields (page / region / clip / timestamp) to null on jump", async () => {
    h.listAiSuggestions.mockResolvedValue({ suggestions: [suggestion()] });
    render(<AiAssist owningElementId="ex_1" grounding={GROUNDING} />);

    fireEvent.click(await screen.findByTestId("refblock-open-source"));
    await waitFor(() => expect(h.navigateSpy).toHaveBeenCalled());

    // `useNavigateToLocation` only forwards the block/offset/label, so the proof that
    // `locationFromGrounding` degraded the media fields is that no page/region/clip/
    // timestamp leak into the jump search (an AI grounding span has none of them).
    const search = (h.navigateSpy.mock.calls[0]?.[0] as { search: Record<string, unknown> }).search;
    expect(search.page).toBeUndefined();
    expect(search.region).toBeUndefined();
    expect(search.clip).toBeUndefined();
    expect(search.timestampMs).toBeUndefined();
  });
});

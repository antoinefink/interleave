/**
 * ConflictSection tests (T089).
 *
 * The HEURISTIC is computed main-side (`packages/core` `detectContradictions` +
 * `ContradictionService`); this asserts the RENDERER seam only:
 *  - the section fetches `semantic.contradictions` and renders a calm chip per flag;
 *  - the copy says "Possible conflict", NEVER "conflict" (the load-bearing framing);
 *  - the chip expands into a compare view (both sources + the reasons + open/dismiss);
 *  - dismiss hides the flag (LOCAL UI state);
 *  - it renders NOTHING when there are no flags;
 *  - the `inline` variant (review) renders the same flags (the caller gates it to the
 *    post-reveal face — proven separately in the review screen / E2E).
 *
 * `appApi` is mocked so the test exercises only this component's wiring (no network).
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SemanticContradictionsResult } from "../lib/appApi";

const h = vi.hoisted(() => ({ semanticContradictions: vi.fn() }));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: { semanticContradictions: h.semanticContradictions },
  };
});

import { ConflictSection } from "./ConflictSection";

const ONE_FLAG: SemanticContradictionsResult = {
  flags: [
    {
      otherId: "ex-2",
      otherType: "extract",
      otherTitle: "Caffeine rebuttal",
      otherRef: {
        sourceElementId: "src-new",
        sourceTitle: "New paper",
        url: null,
        author: null,
        publishedAt: "2026",
        locationLabel: null,
        snippet: null,
      },
      selfRef: {
        sourceElementId: "src-old",
        sourceTitle: "Old paper",
        url: null,
        author: null,
        publishedAt: "2019",
        locationLabel: null,
        snippet: null,
      },
      reasons: ["negation", "recency"],
      severity: "medium",
      newerSide: "other",
    },
  ],
};

beforeEach(() => {
  h.semanticContradictions.mockReset();
});

describe("ConflictSection (T089)", () => {
  it("renders a calm 'Possible conflict' chip from the fetched flags", async () => {
    h.semanticContradictions.mockResolvedValue(ONE_FLAG);
    render(<ConflictSection elementId="ex-1" />);

    await waitFor(() => expect(screen.getByTestId("conflict-section")).toBeInTheDocument());
    expect(screen.getByText("Possible conflict")).toBeInTheDocument();
    // The load-bearing framing: NEVER the bare word "conflict" as a definitive claim.
    expect(screen.queryByText(/^conflict$/i)).toBeNull();
    expect(h.semanticContradictions).toHaveBeenCalledWith({ elementId: "ex-1" });
  });

  it("expands into a compare view with both sources + the reasons", async () => {
    h.semanticContradictions.mockResolvedValue(ONE_FLAG);
    render(<ConflictSection elementId="ex-1" />);

    await waitFor(() => screen.getByTestId("conflict-flag-chip"));
    expect(screen.queryByTestId("conflict-flag-compare")).toBeNull();

    fireEvent.click(screen.getByTestId("conflict-flag-chip"));

    expect(screen.getByTestId("conflict-flag-compare")).toBeInTheDocument();
    // Both sides' refs render (the side-by-side compare).
    expect(screen.getByTestId("conflict-self-ref")).toBeInTheDocument();
    expect(screen.getByTestId("conflict-other-ref")).toBeInTheDocument();
    // The explanation names the supersession direction (newer source).
    expect(screen.getByTestId("conflict-flag-explain").textContent).toMatch(/newer/i);
  });

  it("dismiss hides the flag (local UI state)", async () => {
    h.semanticContradictions.mockResolvedValue(ONE_FLAG);
    render(<ConflictSection elementId="ex-1" />);

    await waitFor(() => screen.getByTestId("conflict-flag-chip"));
    fireEvent.click(screen.getByTestId("conflict-flag-chip"));
    fireEvent.click(screen.getByTestId("conflict-flag-dismiss"));

    expect(screen.queryByTestId("conflict-flag")).toBeNull();
  });

  it("calls onOpen with the conflicting element id", async () => {
    h.semanticContradictions.mockResolvedValue(ONE_FLAG);
    const onOpen = vi.fn();
    render(<ConflictSection elementId="ex-1" onOpen={onOpen} />);

    await waitFor(() => screen.getByTestId("conflict-flag-chip"));
    fireEvent.click(screen.getByTestId("conflict-flag-chip"));
    fireEvent.click(screen.getByTestId("conflict-flag-open"));

    expect(onOpen).toHaveBeenCalledWith("ex-2");
  });

  it("renders nothing when there are no flags", async () => {
    h.semanticContradictions.mockResolvedValue({ flags: [] });
    const { container } = render(<ConflictSection elementId="ex-1" />);

    await waitFor(() => expect(h.semanticContradictions).toHaveBeenCalled());
    expect(screen.queryByTestId("conflict-section")).toBeNull();
    expect(container.querySelector("[data-testid='conflict-flag']")).toBeNull();
  });

  it("the inline variant renders the flags without the inspector section wrapper", async () => {
    render(<ConflictSection flags={ONE_FLAG.flags} variant="inline" />);

    expect(await screen.findByTestId("conflict-section-inline")).toBeInTheDocument();
    expect(screen.queryByTestId("conflict-section")).toBeNull();
    expect(screen.getByText("Possible conflict")).toBeInTheDocument();
    // Pre-fetched flags skip the network call entirely.
    expect(h.semanticContradictions).not.toHaveBeenCalled();
  });
});

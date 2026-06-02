/**
 * Inspector "Related" panel tests (T088).
 *
 * The four DERIVED buckets are computed MAIN-side (`packages/local-db`
 * `RelatedService`); this asserts the RENDERER seam only:
 *  - the panel calls `semantic.related` and renders similar extracts, possible
 *    duplicates, prerequisite concepts, and sibling sources;
 *  - duplicates are styled distinctly (a "possible duplicate" badge) + dismissable;
 *  - clicking a related row navigates (selects) that element;
 *  - when `semanticAvailable` is false it shows the lineage buckets + the calm
 *    "enable semantic search" hint (never an error/crash).
 *
 * `appApi` is mocked so the test exercises only this component's wiring.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SemanticRelatedResult } from "../../lib/appApi";

const h = vi.hoisted(() => ({ semanticRelated: vi.fn() }));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: { semanticRelated: h.semanticRelated },
  };
});

import { RelatedSection } from "./Inspector";

const FULL: SemanticRelatedResult = {
  similar: [
    {
      id: "ex-2",
      type: "extract",
      title: "Distributed practice",
      similarity: 0.82,
      kind: "similar",
      ref: null,
    },
  ],
  duplicates: [
    {
      id: "ex-dup",
      type: "extract",
      title: "Spacing effect (copy)",
      similarity: 0.99,
      kind: "duplicate",
      ref: null,
    },
  ],
  prerequisiteConcepts: [
    { id: "c-cognition", name: "Cognition", level: 1 },
    { id: "c-memory", name: "Memory", level: 0 },
  ],
  siblingSources: [
    {
      id: "src-1",
      type: "source",
      title: "Memory consolidation",
      similarity: 0.7,
      kind: "similar",
      ref: null,
    },
  ],
  semanticAvailable: true,
};

describe("RelatedSection (T088)", () => {
  beforeEach(() => {
    h.semanticRelated.mockReset();
  });

  it("renders all four buckets from semantic.related", async () => {
    h.semanticRelated.mockResolvedValue(FULL);
    render(<RelatedSection elementId="ex-1" onSelect={() => {}} />);

    await waitFor(() => expect(screen.getByTestId("related-section")).toBeInTheDocument());
    expect(h.semanticRelated).toHaveBeenCalledWith({ elementId: "ex-1" });

    expect(screen.getByTestId("related-similar")).toBeInTheDocument();
    expect(screen.getByTestId("related-duplicates")).toBeInTheDocument();
    expect(screen.getByTestId("related-prereqs")).toBeInTheDocument();
    expect(screen.getByTestId("related-siblings")).toBeInTheDocument();

    expect(screen.getByText("Distributed practice")).toBeInTheDocument();
    expect(screen.getByText("Spacing effect (copy)")).toBeInTheDocument();
    expect(screen.getByText("Cognition")).toBeInTheDocument();
    expect(screen.getByText("Memory consolidation")).toBeInTheDocument();
  });

  it("styles duplicates distinctly with a 'possible duplicate' badge", async () => {
    h.semanticRelated.mockResolvedValue(FULL);
    render(<RelatedSection elementId="ex-1" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("related-section")).toBeInTheDocument());

    const dupRow = screen.getByTestId("related-duplicate-row");
    expect(dupRow.className).toContain("related-row--duplicate");
    expect(screen.getByTestId("related-duplicate-badge")).toHaveTextContent(/possible duplicate/i);
  });

  it("selects the element on a related row click", async () => {
    const onSelect = vi.fn();
    h.semanticRelated.mockResolvedValue(FULL);
    render(<RelatedSection elementId="ex-1" onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByTestId("related-section")).toBeInTheDocument());

    // Scope to the "Similar extracts" bucket (sibling-source rows share the same
    // row testid since they are also `kind: "similar"`).
    const similarBucket = within(screen.getByTestId("related-similar"));
    const similarRow = within(similarBucket.getByTestId("related-similar-row"));
    fireEvent.click(similarRow.getByTestId("related-row-select"));
    expect(onSelect).toHaveBeenCalledWith("ex-2");
  });

  it("dismisses a duplicate suggestion locally (this session)", async () => {
    h.semanticRelated.mockResolvedValue(FULL);
    render(<RelatedSection elementId="ex-1" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("related-section")).toBeInTheDocument());

    expect(screen.getByTestId("related-duplicate-row")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("related-duplicate-dismiss"));
    expect(screen.queryByTestId("related-duplicate-row")).not.toBeInTheDocument();
  });

  it("degrades gracefully: shows lineage buckets + a hint when semantics are off", async () => {
    const degraded: SemanticRelatedResult = {
      similar: [],
      duplicates: [],
      prerequisiteConcepts: [{ id: "c-memory", name: "Memory", level: 0 }],
      siblingSources: [
        {
          id: "src-1",
          type: "source",
          title: "Memory book",
          similarity: null,
          kind: "similar",
          ref: null,
        },
      ],
      semanticAvailable: false,
    };
    h.semanticRelated.mockResolvedValue(degraded);
    render(<RelatedSection elementId="ex-1" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("related-section")).toBeInTheDocument());

    // Lineage buckets still resolve.
    expect(screen.getByTestId("related-prereqs")).toBeInTheDocument();
    expect(screen.getByTestId("related-siblings")).toBeInTheDocument();
    // Vector buckets hidden + the calm degrade hint shown (never an error).
    expect(screen.queryByTestId("related-similar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("related-duplicates")).not.toBeInTheDocument();
    expect(screen.getByTestId("related-degrade-hint")).toHaveTextContent(/enable semantic search/i);
  });

  it("renders nothing when there is nothing related and semantics are on", async () => {
    h.semanticRelated.mockResolvedValue({
      similar: [],
      duplicates: [],
      prerequisiteConcepts: [],
      siblingSources: [],
      semanticAvailable: true,
    });
    render(<RelatedSection elementId="ex-1" onSelect={() => {}} />);
    await waitFor(() => expect(h.semanticRelated).toHaveBeenCalled());
    expect(screen.queryByTestId("related-section")).not.toBeInTheDocument();
  });
});

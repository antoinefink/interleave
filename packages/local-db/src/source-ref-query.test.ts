import type {
  Element,
  ElementId,
  ElementLocation,
  Source,
  SourceLocationId,
} from "@interleave/core";
import { describe, expect, it } from "vitest";
import { resolveSourceRef } from "./source-ref-query";

const now = "2026-06-03T00:00:00.000Z";
type SourceRefRepos = Parameters<typeof resolveSourceRef>[0];

function element(overrides: Partial<Element> & { id: ElementId; type: Element["type"] }): Element {
  const { id, stage, type, ...rest } = overrides;
  return {
    id,
    type,
    status: "active",
    stage: stage ?? (type === "source" ? "raw_source" : "raw_extract"),
    priority: 0.5,
    dueAt: null,
    parkedAt: null,
    extractFate: null,
    title: "Untitled",
    parentId: null,
    sourceId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...rest,
  };
}

function source(elementId: ElementId, overrides: Partial<Source> = {}): Source {
  return {
    elementId,
    url: "https://example.test/source",
    canonicalUrl: "https://example.test/source",
    originalUrl: null,
    author: "Researcher",
    publishedAt: "2026-01-01T00:00:00.000Z",
    accessedAt: now,
    snapshotKey: "assets/sources/source/cleaned.html",
    reasonAdded: null,
    mediaKind: null,
    sourceType: "paper",
    reliabilityTier: "primary",
    confidence: "high",
    reliabilityNotes: "Peer-reviewed",
    ...overrides,
  };
}

function location(
  id: SourceLocationId,
  elementId: ElementId,
  sourceElementId: ElementId,
): ElementLocation {
  return {
    id,
    elementId,
    sourceElementId,
    blockIds: [],
    startOffset: null,
    endOffset: null,
    page: null,
    timestampMs: null,
    region: null,
    clip: null,
    label: "p. 3",
    selectedText: "Selected source text",
  };
}

function repos(options: {
  elements: Record<string, Element | undefined>;
  sources?: Record<string, Source | undefined>;
  locationsByElement?: Record<string, ElementLocation | undefined>;
  locationsById?: Record<string, ElementLocation | undefined>;
  cardLocationIds?: Record<string, SourceLocationId | null | undefined>;
}): SourceRefRepos {
  return {
    elements: {
      findById: (id: ElementId) => options.elements[id],
    },
    sources: {
      findById: (id: ElementId) => {
        const row = options.sources?.[id] ?? null;
        return row ? { element: options.elements[id] as Element, source: row } : null;
      },
      findLocationForElement: (id: ElementId) => options.locationsByElement?.[id] ?? null,
      findLocationById: (id: SourceLocationId) => options.locationsById?.[id] ?? null,
    },
    review: {
      findCardById: (id: ElementId) => ({
        element: options.elements[id] as Element,
        card: { sourceLocationId: options.cardLocationIds?.[id] ?? null },
      }),
    },
  } as unknown as SourceRefRepos;
}

describe("resolveSourceRef", () => {
  it("resolves a source element from its own provenance", () => {
    const sourceId = "source" as ElementId;
    const src = element({ id: sourceId, type: "source", title: "Original Source" });
    const ref = resolveSourceRef(
      repos({ elements: { [sourceId]: src }, sources: { [sourceId]: source(sourceId) } }),
      sourceId,
    );

    expect(ref).toEqual({
      sourceElementId: sourceId,
      sourceTitle: "Original Source",
      url: "https://example.test/source",
      author: "Researcher",
      publishedAt: "2026-01-01T00:00:00.000Z",
      locationLabel: null,
      snippet: null,
      sourceType: "paper",
      reliabilityTier: "primary",
      confidence: "high",
      reliabilityNotes: "Peer-reviewed",
    });
  });

  it("resolves extract refs through sourceId and the extract location", () => {
    const sourceId = "source" as ElementId;
    const extractId = "extract" as ElementId;
    const loc = location("loc" as SourceLocationId, extractId, sourceId);
    const ref = resolveSourceRef(
      repos({
        elements: {
          [sourceId]: element({ id: sourceId, type: "source", title: "Book" }),
          [extractId]: element({ id: extractId, type: "extract", sourceId }),
        },
        sources: { [sourceId]: source(sourceId, { author: "Author" }) },
        locationsByElement: { [extractId]: loc },
      }),
      extractId,
    );

    expect(ref?.sourceElementId).toBe(sourceId);
    expect(ref?.sourceTitle).toBe("Book");
    expect(ref?.author).toBe("Author");
    expect(ref?.locationLabel).toBe("p. 3");
    expect(ref?.snippet).toBe("Selected source text");
  });

  it("falls back from a card to its card.source_location_id anchor", () => {
    const sourceId = "source" as ElementId;
    const cardId = "card" as ElementId;
    const locId = "card-loc" as SourceLocationId;
    const loc = location(locId, "extract" as ElementId, sourceId);
    const ref = resolveSourceRef(
      repos({
        elements: {
          [sourceId]: element({ id: sourceId, type: "source", title: "Paper" }),
          [cardId]: element({ id: cardId, type: "card", stage: "active_card", sourceId }),
        },
        sources: { [sourceId]: source(sourceId) },
        locationsById: { [locId]: loc },
        cardLocationIds: { [cardId]: locId },
      }),
      cardId,
    );

    expect(ref?.sourceTitle).toBe("Paper");
    expect(ref?.locationLabel).toBe("p. 3");
    expect(ref?.snippet).toBe("Selected source text");
  });

  it("returns null for missing or soft-deleted anchor elements", () => {
    const deletedId = "deleted" as ElementId;
    const deleted = element({
      id: deletedId,
      type: "extract",
      deletedAt: now,
      status: "deleted",
    });

    expect(resolveSourceRef(repos({ elements: {} }), "missing" as ElementId)).toBeNull();
    expect(resolveSourceRef(repos({ elements: { [deletedId]: deleted } }), deletedId)).toBeNull();
  });

  it("degrades calmly when the owning source is missing or soft-deleted", () => {
    const sourceId = "source" as ElementId;
    const cardId = "card" as ElementId;
    const deletedSource = element({
      id: sourceId,
      type: "source",
      title: "Deleted source",
      status: "deleted",
      deletedAt: now,
    });

    const ref = resolveSourceRef(
      repos({
        elements: {
          [sourceId]: deletedSource,
          [cardId]: element({ id: cardId, type: "card", stage: "active_card", sourceId }),
        },
      }),
      cardId,
    );

    expect(ref).toMatchObject({
      sourceElementId: null,
      sourceTitle: null,
      url: null,
      author: null,
      locationLabel: null,
      snippet: null,
      sourceType: null,
      reliabilityTier: null,
      confidence: null,
      reliabilityNotes: null,
    });
  });
});

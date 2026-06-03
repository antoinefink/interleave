import { describe, expect, it } from "vitest";
import type { ElementId } from "./ids";
import type { Document, Source } from "./source";

describe("source and document model shapes", () => {
  it("keeps provenance metadata separate from document body data", () => {
    const elementId = "src" as ElementId;
    const source = {
      elementId,
      url: "https://example.test/article",
      canonicalUrl: "https://example.test/article",
      originalUrl: "https://example.test/article?utm_source=x",
      author: "A. Author",
      publishedAt: "2026-01-01T00:00:00.000Z",
      accessedAt: "2026-06-03T00:00:00.000Z",
      snapshotKey: "assets/sources/src/cleaned.html",
      reasonAdded: "Research",
      mediaKind: null,
      sourceType: "article",
      reliabilityTier: "secondary",
      confidence: "medium",
      reliabilityNotes: "Editorial source",
    } satisfies Source;

    const document = {
      elementId,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "Readable body",
      schemaVersion: 1,
      updatedAt: "2026-06-03T00:00:00.000Z",
    } satisfies Document;

    expect(source.elementId).toBe(document.elementId);
    expect(source.snapshotKey).toContain("assets/sources");
    expect(document.plainText).toBe("Readable body");
  });
});

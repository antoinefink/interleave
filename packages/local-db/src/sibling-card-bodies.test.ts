/**
 * ReviewRepository.listSiblingCardBodies (T086) — the read-only candidate set the card
 * builder feeds to the pure `detectInterference` similar-answer heuristic.
 *
 * It returns the comparable answer bodies (Q&A `answer` / cloze `cloze`) of the LIVE
 * `card` children of an extract — no FSRS state, no lineage resolution, and never a
 * mutation/op. Runs against a temporary, fully-migrated in-memory better-sqlite3 DB.
 */

import type { BlockId, ElementId, Priority } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardService } from "./card-service";
import { ElementRepository } from "./element-repository";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

beforeEach(() => {
  handle = createInMemoryDb();
});
afterEach(() => {
  handle.sqlite.close();
});

/** Seed a source + one extract anchored at a source location; return the extract id. */
function seedExtract(priority: Priority = 0.625): ElementId {
  const sources = new SourceRepository(handle.db);
  const { element: source } = sources.createWithDocument({
    title: "On the Measure of Intelligence",
    priority,
    status: "active",
    stage: "raw_source",
    body: "The definition paragraph.\n\nAnother paragraph.",
  });
  const { element: extract } = sources.createExtract({
    sourceElementId: source.id,
    title: "Definition extract",
    priority,
    stage: "atomic_statement",
    selectedText: "The definition paragraph.",
    blockIds: ["blk_def" as BlockId],
    startOffset: 0,
    endOffset: 25,
    label: "Definition · ¶1",
  });
  return extract.id;
}

describe("ReviewRepository.listSiblingCardBodies (T086)", () => {
  it("returns the answer bodies of the extract's live card children", () => {
    const extractId = seedExtract();
    const cards = new CardService(handle.db);
    const review = new ReviewRepository(handle.db);

    const a = cards.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "How does Chollet define intelligence?",
      answer: "As skill-acquisition efficiency.",
    });
    const b = cards.createFromExtract({
      extractId,
      kind: "cloze",
      cloze: "Intelligence is {{c1::skill-acquisition efficiency}}.",
    });

    const bodies = review.listSiblingCardBodies(extractId);
    expect(bodies).toHaveLength(2);

    const byId = new Map(bodies.map((row) => [row.id, row]));
    expect(byId.get(a.element.id)?.answer).toBe("As skill-acquisition efficiency.");
    expect(byId.get(a.element.id)?.cloze).toBeNull();
    expect(byId.get(b.element.id)?.cloze).toBe(
      "Intelligence is {{c1::skill-acquisition efficiency}}.",
    );
    expect(byId.get(b.element.id)?.answer).toBeNull();
  });

  it("excludes soft-deleted cards and cards under a different extract", () => {
    const extractA = seedExtract();
    const extractB = seedExtract();
    const cards = new CardService(handle.db);
    const elements = new ElementRepository(handle.db);
    const review = new ReviewRepository(handle.db);

    const live = cards.createFromExtract({
      extractId: extractA,
      kind: "qa",
      prompt: "Q1?",
      answer: "A1.",
    });
    const deleted = cards.createFromExtract({
      extractId: extractA,
      kind: "qa",
      prompt: "Q2?",
      answer: "A2.",
    });
    // A card under a DIFFERENT extract must not leak into A's candidate set.
    cards.createFromExtract({ extractId: extractB, kind: "qa", prompt: "Q3?", answer: "A3." });

    elements.softDelete(deleted.element.id);

    const bodies = review.listSiblingCardBodies(extractA);
    expect(bodies.map((b) => b.id)).toEqual([live.element.id]);
  });

  it("returns an empty array for an extract with no cards (graceful degradation)", () => {
    const extractId = seedExtract();
    const review = new ReviewRepository(handle.db);
    expect(review.listSiblingCardBodies(extractId)).toEqual([]);
  });
});

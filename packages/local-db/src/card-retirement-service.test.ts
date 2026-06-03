import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { operationLog, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRetirementService } from "./card-retirement-service";
import { ElementRepository } from "./element-repository";
import { ReviewRepository } from "./review-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let elements: ElementRepository;
let review: ReviewRepository;
let retirement: CardRetirementService;

beforeEach(() => {
  handle = createInMemoryDb();
  elements = new ElementRepository(handle.db);
  review = new ReviewRepository(handle.db);
  retirement = new CardRetirementService(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

function createCard(title = "Card"): ElementId {
  const { element } = review.createCard({
    kind: "qa",
    title,
    prompt: "Q",
    answer: "A",
    priority: 0.5,
  });
  handle.db
    .update(reviewStates)
    .set({ stability: 42, reps: 8, lastReviewedAt: "2026-06-01T00:00:00.000Z" as IsoTimestamp })
    .where(eq(reviewStates.elementId, element.id))
    .run();
  return element.id;
}

describe("CardRetirementService direct guards", () => {
  it("rejects non-card and soft-deleted card ids", () => {
    const source = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.5,
      title: "Source",
    });
    const card = createCard();
    elements.softDelete(card);

    expect(() => retirement.retire(source.id)).toThrow(/not found/);
    expect(() => retirement.retire(card)).toThrow(/not found/);
  });

  it("records batch ids in retirement audit payloads", () => {
    const card = createCard();

    retirement.retire(card, { batchId: "batch-retire", reason: "bulk archive" });

    const rows = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, card))
      .all();
    const retirePayloads = rows
      .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
      .filter((payload) => payload.retired === true);
    expect(retirePayloads).toEqual([
      expect.objectContaining({
        batchId: "batch-retire",
        reason: "bulk archive",
      }),
    ]);
  });

  it("lists retired cards with zeroed review signals when no review state exists", () => {
    const { element, card } = review.createCard({
      kind: "qa",
      title: "No state",
      prompt: "Q",
      answer: "A",
      priority: 0.5,
    });
    handle.db.delete(reviewStates).where(eq(reviewStates.elementId, element.id)).run();
    retirement.retire(element.id);

    expect(retirement.listRetired()).toEqual([
      expect.objectContaining({
        element: expect.objectContaining({ id: element.id }),
        card: expect.objectContaining({ elementId: card.elementId }),
        stability: 0,
        reps: 0,
        lapses: 0,
        lastReviewedAt: null,
      }),
    ]);
  });
});

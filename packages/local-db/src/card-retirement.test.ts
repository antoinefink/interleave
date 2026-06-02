/**
 * Mature-card retirement persistence (T082).
 *
 * Exercises the retirement seam end to end against a TEMPORARY, fully-migrated
 * in-memory `better-sqlite3` DB. The mechanism is the durable `cards.is_retired`
 * flag (the sole source of truth for "leave active review"); this asserts:
 *
 *  - `retire` sets `cards.is_retired`, logs ONE `update_element` op (no new op type),
 *    and the card DROPS OUT of `QueueRepository.dueCards` + the review deck while
 *    keeping its `review_states` / `review_logs` / lineage (never a soft delete);
 *  - `unretire` clears the flag and the card RETURNS to the due read at its existing
 *    due date;
 *  - a retired card never surfaces in the review session;
 *  - `listRetired` lists only LIVE retired cards (excludes soft-deleted), most-stable
 *    first;
 *  - retiring never `soft_delete`s (status + `deletedAt` untouched);
 *  - the OPTIONAL low-retention lever (`lowRetention`) floor-clamps
 *    `cards.desired_retention` to `DESIRED_RETENTION_MIN` (a *modestly* longer
 *    interval) and a below-floor override can NOT self-retire — only the flag removes
 *    a card from the due read.
 */

import type { BlockId, ElementId, IsoTimestamp, Priority } from "@interleave/core";
import { DESIRED_RETENTION_MIN } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards as cardsTable, operationLog, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRetirementService } from "./card-retirement-service";
import { CardService } from "./card-service";
import { ElementRepository } from "./element-repository";
import { QueueRepository } from "./queue-repository";
import { RetentionService } from "./retention-service";
import { ReviewRepository } from "./review-repository";
import { ReviewSessionService } from "./review-session-service";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

const PAST = "2026-06-01T08:00:00.000Z" as IsoTimestamp;
const ASOF = "2026-06-15T08:00:00.000Z" as IsoTimestamp;

/** Author one Q&A card from a fresh source+extract; returns its element id. */
function seedCard(title = "Retire candidate", priority: Priority = 0.5): ElementId {
  const sources = new SourceRepository(handle.db);
  const cardService = new CardService(handle.db);
  const { element: source } = sources.createWithDocument({
    title,
    priority,
    status: "active",
    stage: "raw_source",
    body: "The definition paragraph.\n\nAnother paragraph.",
  });
  const { element: extract } = sources.createExtract({
    sourceElementId: source.id,
    title: "Extract",
    priority,
    stage: "atomic_statement",
    selectedText: "The definition paragraph.",
    blockIds: ["blk_def" as BlockId],
    startOffset: 0,
    endOffset: 25,
    label: "Definition · ¶1",
  });
  const { element: card } = cardService.createFromExtract({
    extractId: extract.id,
    kind: "qa",
    prompt: "What is intelligence?",
    answer: "Skill-acquisition efficiency.",
  });
  return card.id;
}

/** Make a card due NOW with a given stability (so it heads the deck + is "mature"). */
function makeDue(cardId: ElementId, dueAt: IsoTimestamp, stability = 30): void {
  handle.db
    .update(reviewStates)
    .set({ dueAt, stability, fsrsState: "review", lastReviewedAt: PAST, reps: 3 })
    .where(eq(reviewStates.elementId, cardId))
    .run();
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("CardRetirementService.retire / unretire", () => {
  it("retires a card: sets is_retired, logs one update_element, drops it from the due read", () => {
    const cardId = seedCard();
    makeDue(cardId, PAST);
    const queue = new QueueRepository(handle.db);
    const service = new CardRetirementService(handle.db);

    // Due before retiring.
    expect(queue.dueCards(ASOF).map((c) => c.id)).toContain(cardId);

    const result = service.retire(cardId, { reason: "Low-value, well-learned" });
    expect(result.card.isRetired).toBe(true);
    expect(service.isRetired(cardId)).toBe(true);

    // Gone from the due read by the FLAG (review_states.dueAt is still in the past).
    expect(queue.dueCards(ASOF).map((c) => c.id)).not.toContain(cardId);
    expect(queue.dueCardCount(ASOF)).toBe(0);
    expect(queue.dueCardsBetween(PAST, ASOF)).toBe(0);

    // Exactly one update_element op carrying the retirement marker (payload is a
    // JSON string in the raw row — parse it).
    const retireOps = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, cardId))
      .all()
      .map((op) => ({
        opType: op.opType,
        payload:
          typeof op.payload === "string"
            ? (JSON.parse(op.payload) as Record<string, unknown>)
            : null,
      }))
      .filter((op) => op.opType === "update_element" && op.payload?.retired === true);
    expect(retireOps).toHaveLength(1);
    const retirePayload = retireOps[0]?.payload ?? {};
    expect(retirePayload.reason).toBe("Low-value, well-learned");
    expect(typeof retirePayload.retiredAt).toBe("string");
  });

  it("does NOT soft-delete on retire (status + deletedAt + review state preserved)", () => {
    const cardId = seedCard();
    makeDue(cardId, PAST);
    const review = new ReviewRepository(handle.db);
    const elements = new ElementRepository(handle.db);
    const before = review.findReviewState(cardId);

    new CardRetirementService(handle.db).retire(cardId);

    const el = elements.findById(cardId);
    expect(el?.deletedAt).toBeNull();
    expect(el?.status).not.toBe("deleted");
    // The FSRS memory state is untouched (retire never writes review_states).
    const after = review.findReviewState(cardId);
    expect(after?.stability).toBe(before?.stability);
    expect(after?.dueAt).toBe(before?.dueAt);
    expect(after?.reps).toBe(before?.reps);
  });

  it("unretire clears the flag and the card returns to the due read at its existing due date", () => {
    const cardId = seedCard();
    makeDue(cardId, PAST);
    const queue = new QueueRepository(handle.db);
    const service = new CardRetirementService(handle.db);

    service.retire(cardId);
    expect(queue.dueCards(ASOF).map((c) => c.id)).not.toContain(cardId);

    const result = service.unretire(cardId);
    expect(result.card.isRetired).toBe(false);
    expect(service.isRetired(cardId)).toBe(false);
    // Back in the due read at the SAME (untouched) due date.
    expect(queue.dueCards(ASOF).map((c) => c.id)).toContain(cardId);

    // An update_element op clearing the flag was logged (payload is a JSON string).
    const unretireOps = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, cardId))
      .all()
      .map((op) => ({
        opType: op.opType,
        payload:
          typeof op.payload === "string"
            ? (JSON.parse(op.payload) as Record<string, unknown>)
            : null,
      }))
      .filter((op) => op.opType === "update_element" && op.payload?.retired === false);
    expect(unretireOps).toHaveLength(1);
  });

  it("a retired card never surfaces in the review session deck", () => {
    const cardId = seedCard();
    makeDue(cardId, PAST);
    const session = new ReviewSessionService(handle.db);

    // Surfaceable before retiring.
    expect(session.nextReviewCard({ asOf: ASOF }).cardId).toBe(cardId);

    new CardRetirementService(handle.db).retire(cardId);
    const next = session.nextReviewCard({ asOf: ASOF });
    expect(next.cardId).toBeNull();
    expect(next.deckSize).toBe(0);
  });

  it("listRetired returns only LIVE retired cards, most-stable first; excludes soft-deleted", () => {
    const lowStability = seedCard("low-stability");
    makeDue(lowStability, PAST, 12);
    const highStability = seedCard("high-stability");
    makeDue(highStability, PAST, 90);
    const notRetired = seedCard("not-retired");
    makeDue(notRetired, PAST, 50);
    const service = new CardRetirementService(handle.db);
    const elements = new ElementRepository(handle.db);

    service.retire(lowStability);
    service.retire(highStability);

    let retired = service.listRetired();
    expect(retired.map((r) => r.element.id)).toEqual([highStability, lowStability]); // most-stable first
    expect(retired.map((r) => r.element.id)).not.toContain(notRetired);

    // Soft-delete a retired card → it leaves the inventory.
    elements.softDelete(highStability);
    retired = service.listRetired();
    expect(retired.map((r) => r.element.id)).toEqual([lowStability]);
  });
});

describe("CardRetirementService — the optional low-retention lever (NOT the mechanism)", () => {
  it("retire({ lowRetention }) floor-clamps cards.desired_retention to DESIRED_RETENTION_MIN", () => {
    const cardId = seedCard();
    makeDue(cardId, PAST);

    new CardRetirementService(handle.db).retire(cardId, { lowRetention: true });

    const row = handle.db
      .select({ desiredRetention: cardsTable.desiredRetention, isRetired: cardsTable.isRetired })
      .from(cardsTable)
      .where(eq(cardsTable.elementId, cardId))
      .get();
    expect(row?.desiredRetention).toBe(DESIRED_RETENTION_MIN);
    expect(row?.isRetired).toBe(true);

    // The resolver honors the floor (it cannot reach a self-retiring near-zero target).
    const retention = new RetentionService(handle.db);
    expect(retention.resolveForCard(cardId).target).toBe(DESIRED_RETENTION_MIN);
  });

  it("a below-floor override is clamped UP to the floor — the override can NOT self-retire", () => {
    const cardId = seedCard();
    makeDue(cardId, PAST);
    const retention = new RetentionService(handle.db);
    const queue = new QueueRepository(handle.db);

    // Try to push the per-card target near zero — the write clamps it UP to the floor.
    retention.setCardRetention(cardId, 0.01);
    expect(retention.resolveForCard(cardId).target).toBe(DESIRED_RETENTION_MIN);
    // And the card is STILL in the due read — only the is_retired flag removes it.
    expect(queue.dueCards(ASOF).map((c) => c.id)).toContain(cardId);
  });
});

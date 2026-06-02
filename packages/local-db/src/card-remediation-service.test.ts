/**
 * CardRemediationService (T085) — the leech remediation compositions.
 *
 * Exercises the three NEW compositions (split / add-context / back-to-extract) end to
 * end against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB, asserting the
 * transactional contract + the correct EXISTING `operation_log` op + the two-scheduler
 * split + lineage/history preservation:
 *
 *  - `split`: a 2-part split creates 2 NEW cards, each inheriting the original's
 *    `parentId`/`sourceLocationId`/priority, grouped as siblings (`sibling_group`),
 *    each with a FRESH `review_states` row (NOT the original's FSRS state), and
 *    soft-deletes (default) the original; logs `create_card` ×2 + `add_relation` +
 *    `soft_delete_element`; the original's `review_logs` survive; rejects an empty part.
 *  - `addContext`: records the note (op-payload marker), logs `update_element`, leaves
 *    `review_states`/lineage untouched, and the card stays live.
 *  - `backToExtract`: reschedules the parent extract on the ATTENTION scheduler
 *    (`reschedule_element`, due-now, no `review_states` for the extract), applies the
 *    default suspend disposition, and returns the extract; returns `{ extract: null }`
 *    (mutating nothing destructive) when the card has no live parent.
 *  - regression: `setPriority` on a leech still lowers its numeric priority +
 *    `update_element` from this screen's reuse path.
 */

import {
  type BlockId,
  type ElementId,
  type IsoTimestamp,
  type Priority,
  priorityFromLabel,
} from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { elementRelations, operationLog, reviewStates } from "@interleave/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRemediationService } from "./card-remediation-service";
import { CardService } from "./card-service";
import { ElementRepository } from "./element-repository";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

interface SeedResult {
  readonly cardId: ElementId;
  readonly extractId: ElementId;
  readonly sourceLocationId: string | null;
}

/** Author one Q&A card from a fresh source+extract; returns ids + the anchor. */
function seedCard(title = "Leech candidate", priority: Priority = 0.5): SeedResult {
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
  const { element: card, sourceLocationId } = cardService.createFromExtract({
    extractId: extract.id,
    kind: "qa",
    prompt: "What is intelligence and how is it measured?",
    answer: "Generalization power; skill-acquisition efficiency.",
  });
  return { cardId: card.id, extractId: extract.id, sourceLocationId };
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("CardRemediationService.split", () => {
  it("creates 2 sibling cards inheriting lineage + fresh FSRS, soft-deleting the original", () => {
    const remediation = new CardRemediationService(handle.db);
    const review = new ReviewRepository(handle.db);
    const elements = new ElementRepository(handle.db);
    const { cardId, extractId, sourceLocationId } = seedCard();

    // The original carries a review_logs row + an FSRS state (it has been reviewed).
    review.recordReview(cardId, {
      rating: "again",
      reviewedAt: "2026-06-15T00:00:00.000Z" as IsoTimestamp,
      responseMs: 4000,
      prevState: "new",
      nextState: "learning",
      nextStability: 1,
      nextDifficulty: 5,
      nextDueAt: "2026-06-16T00:00:00.000Z" as IsoTimestamp,
      elapsedDays: 0,
      scheduledDays: 1,
      reps: 1,
      lapses: 0,
      nextLearningSteps: 1,
    });
    const originalLogsBefore = review.listReviewLogs(cardId).length;
    expect(originalLogsBefore).toBe(1);

    const { cards } = remediation.split({
      cardId,
      parts: [
        { kind: "qa", prompt: "What is intelligence?", answer: "Generalization power." },
        {
          kind: "qa",
          prompt: "How is intelligence measured?",
          answer: "Skill-acquisition efficiency.",
        },
      ],
    });
    expect(cards).toHaveLength(2);

    // Each new card inherits parentId (extract) + sourceLocationId + priority.
    for (const c of cards) {
      expect(c.element.parentId).toBe(extractId);
      expect(c.card.sourceLocationId).toBe(sourceLocationId);
      expect(c.element.priority).toBe(0.5);
      // FRESH review_states — fsrsState "new", 0 reps/lapses (NOT the original's).
      const state = review.findReviewState(c.element.id);
      expect(state?.fsrsState).toBe("new");
      expect(state?.reps).toBe(0);
      expect(state?.lapses).toBe(0);
    }

    // Both new cards share ONE sibling group via the sibling_group relation.
    const groups = cards.map(
      (c) =>
        handle.db
          .select({ g: elementRelations.siblingGroupId })
          .from(elementRelations)
          .where(
            and(
              eq(elementRelations.fromElementId, c.element.id),
              eq(elementRelations.relationType, "sibling_group"),
            ),
          )
          .get()?.g ?? null,
    );
    expect(groups[0]).not.toBeNull();
    expect(groups[0]).toBe(groups[1]);

    // The original is soft-deleted (default) but its review_logs survive.
    const original = elements.findById(cardId);
    expect(original?.deletedAt).not.toBeNull();
    expect(original?.status).toBe("deleted");
    expect(review.listReviewLogs(cardId).length).toBe(originalLogsBefore);

    // Op-log: create_card ×2 + add_relation ×2 (siblings) + a soft_delete_element.
    const ops = handle.db.select().from(operationLog).all();
    expect(ops.filter((o) => o.opType === "create_card").length).toBeGreaterThanOrEqual(2);
    expect(
      ops.filter((o) => o.opType === "soft_delete_element" && o.elementId === cardId).length,
    ).toBe(1);
    const siblingRelations = handle.db
      .select()
      .from(elementRelations)
      .where(eq(elementRelations.relationType, "sibling_group"))
      .all()
      .filter((r) => cards.some((c) => c.element.id === r.fromElementId));
    expect(siblingRelations.length).toBe(2);
  });

  it("can suspend the original instead of deleting it", () => {
    const remediation = new CardRemediationService(handle.db);
    const elements = new ElementRepository(handle.db);
    const { cardId } = seedCard();
    remediation.split({
      cardId,
      originalDisposition: "suspend",
      parts: [
        { kind: "qa", prompt: "Q1?", answer: "A1." },
        { kind: "qa", prompt: "Q2?", answer: "A2." },
      ],
    });
    const original = elements.findById(cardId);
    expect(original?.status).toBe("suspended");
    expect(original?.deletedAt).toBeNull();
  });

  it("rejects an empty part and fewer than two parts", () => {
    const remediation = new CardRemediationService(handle.db);
    const { cardId } = seedCard();
    expect(() =>
      remediation.split({
        cardId,
        parts: [
          { kind: "qa", prompt: "Q1?", answer: "A1." },
          { kind: "qa", prompt: "", answer: "" },
        ],
      }),
    ).toThrow();
    expect(() =>
      remediation.split({ cardId, parts: [{ kind: "qa", prompt: "Q1?", answer: "A1." }] }),
    ).toThrow();
    // A rejected split mutated nothing — the original is still a live card.
    const original = new ElementRepository(handle.db).findById(cardId);
    expect(original?.deletedAt).toBeNull();
    expect(original?.status).not.toBe("deleted");
  });
});

describe("CardRemediationService.addContext", () => {
  it("records the note as an op-payload marker, leaving lineage + FSRS untouched", () => {
    const remediation = new CardRemediationService(handle.db);
    const review = new ReviewRepository(handle.db);
    const { cardId } = seedCard();
    const stateBefore = review.findReviewState(cardId);

    const result = remediation.addContext(cardId, "In the context of the ARC benchmark.");
    expect(result.context).toBe("In the context of the ARC benchmark.");
    expect(remediation.contextNote(cardId)).toBe("In the context of the ARC benchmark.");

    // The card stays live; its review_states + body/lineage are untouched.
    expect(result.card.element.deletedAt).toBeNull();
    expect(result.card.element.status).not.toBe("deleted");
    const stateAfter = review.findReviewState(cardId);
    expect(stateAfter?.reps).toBe(stateBefore?.reps);
    expect(stateAfter?.lapses).toBe(stateBefore?.lapses);

    // An update_element op carrying the context marker was logged (no new op type).
    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, cardId))
      .all();
    const ctx = ops.filter(
      (o) =>
        o.opType === "update_element" &&
        typeof o.payload === "string" &&
        o.payload.includes('"context":"In the context'),
    );
    expect(ctx).toHaveLength(1);

    // A later add-context REPLACES the read-back value.
    remediation.addContext(cardId, "As of GPT-4.");
    expect(remediation.contextNote(cardId)).toBe("As of GPT-4.");
  });

  it("rejects an empty note", () => {
    const remediation = new CardRemediationService(handle.db);
    const { cardId } = seedCard();
    expect(() => remediation.addContext(cardId, "   ")).toThrow();
  });
});

describe("CardRemediationService.backToExtract", () => {
  it("reschedules the parent extract due-now on the ATTENTION scheduler + suspends the card", () => {
    const remediation = new CardRemediationService(handle.db);
    const elements = new ElementRepository(handle.db);
    const review = new ReviewRepository(handle.db);
    const { cardId, extractId } = seedCard();

    const before = Date.now();
    const { extract } = remediation.backToExtract(cardId);
    expect(extract?.id).toBe(extractId);
    expect(extract?.status).toBe("scheduled");
    // Due-now (within a small window of the call).
    const dueMs = extract?.dueAt ? Date.parse(extract.dueAt) : 0;
    expect(dueMs).toBeGreaterThanOrEqual(before - 1000);
    expect(dueMs).toBeLessThanOrEqual(Date.now() + 1000);

    // The extract NEVER gets an FSRS review_states row (two-scheduler split).
    const extractState = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, extractId))
      .get();
    expect(extractState).toBeUndefined();

    // The card is suspended by default (recoverable; review_logs preserved).
    expect(elements.findById(cardId)?.status).toBe("suspended");
    expect(elements.findById(cardId)?.deletedAt).toBeNull();
    expect(() => review.listReviewLogs(cardId)).not.toThrow();

    // A reschedule_element op was logged on the extract (the attention op).
    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, extractId))
      .all();
    expect(ops.some((o) => o.opType === "reschedule_element")).toBe(true);
  });

  it("returns { extract: null } and mutates nothing when the card has no live parent", () => {
    const remediation = new CardRemediationService(handle.db);
    const elements = new ElementRepository(handle.db);
    const { cardId, extractId } = seedCard();

    // Soft-delete the parent extract so the card has no LIVE parent.
    elements.softDelete(extractId);
    const opsBefore = handle.db.select().from(operationLog).all().length;

    const { extract } = remediation.backToExtract(cardId);
    expect(extract).toBeNull();
    // The card was not touched (still active, not deleted).
    expect(elements.findById(cardId)?.status).toBe("active");
    expect(elements.findById(cardId)?.deletedAt).toBeNull();
    // No new destructive op was appended.
    expect(handle.db.select().from(operationLog).all().length).toBe(opsBefore);
  });

  it("can soft-delete the card instead of suspending it", () => {
    const remediation = new CardRemediationService(handle.db);
    const elements = new ElementRepository(handle.db);
    const { cardId } = seedCard();
    remediation.backToExtract(cardId, "delete");
    expect(elements.findById(cardId)?.deletedAt).not.toBeNull();
    expect(elements.findById(cardId)?.status).toBe("deleted");
  });
});

describe("regression: lower-priority on a leech (the reused T027 path)", () => {
  it("lowers the numeric priority + logs update_element", () => {
    const elements = new ElementRepository(handle.db);
    const { cardId } = seedCard("A-priority leech", 0.9);
    expect(elements.findById(cardId)?.priority).toBe(0.9);

    // The screen's lower-priority reuses the universal elements.setPriority (T027).
    elements.setPriority(cardId, priorityFromLabel("C"));
    const after = elements.findById(cardId);
    expect(after?.priority).toBeLessThan(0.9);

    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, cardId))
      .all();
    expect(ops.some((o) => o.opType === "update_element")).toBe(true);
  });
});

/**
 * Leech detection persistence (T040).
 *
 * Exercises the leech seam end to end against a TEMPORARY, fully-migrated in-memory
 * `better-sqlite3` DB. The leech RULE lives in `@interleave/scheduler` (`isLeech`,
 * threshold 4); this asserts the PERSISTENCE the rule drives:
 *
 *  - grading a card to its 4th lapse sets the durable `cards.is_leech` flag in the
 *    SAME transaction as the `add_review_log` (one `update_element` op, no new op
 *    type), and `isCardLeech` reports it;
 *  - a card below the threshold is not a leech;
 *  - the leech flag is set ONCE (a subsequent lapse does not re-log it);
 *  - `listLeechCards` returns only leech cards (most-lapsed first), excluding
 *    non-leech + soft-deleted cards;
 *  - `setCardLeech` toggles the flag + logs `update_element` (manual mark / un-leech).
 */

import type { BlockId, ElementId, IsoTimestamp, Priority } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards as cardsTable, operationLog } from "@interleave/db";
import { LEECH_LAPSE_THRESHOLD, SchedulerService } from "@interleave/scheduler";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardService } from "./card-service";
import { ElementRepository } from "./element-repository";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

/** Author one Q&A card from a fresh source+extract; returns its element id. */
function seedCard(title = "Leech candidate", priority: Priority = 0.5): ElementId {
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

const BASE_MS = Date.parse("2026-06-15T00:00:00.000Z");
const DAY_MS = 86_400_000;

/**
 * Drive a card to exactly `targetLapses` FSRS lapses via the real scheduler +
 * repository. FSRS only counts a lapse when a card in `review` state fails, so the
 * card is first graduated to `review` (one `easy`), then for each lapse it is
 * failed (`again`, which increments `lapses` from `review`→`relearning`) and — for
 * all but the last — recovered (`good`, `relearning`→`review`) so the next `again`
 * can lapse again. This is the realistic "keeps lapsing" leech path.
 */
function lapse(cardId: ElementId, targetLapses: number): ReviewRepository {
  const review = new ReviewRepository(handle.db);
  const scheduler = new SchedulerService({ desiredRetention: 0.9, enableFuzz: false });
  let ms = BASE_MS;
  const step = (rating: "again" | "good" | "easy") => {
    const state = review.findReviewState(cardId);
    if (!state) throw new Error("review state missing");
    const out = scheduler.gradeCard(
      state,
      rating,
      new Date(ms).toISOString() as IsoTimestamp,
      5000,
    );
    review.recordReview(cardId, out);
    ms = Date.parse(out.nextDueAt) + DAY_MS;
  };
  if (targetLapses <= 0) {
    step("again"); // a single fail from `new` produces 0 lapses (still learning)
    return review;
  }
  step("easy"); // new → review
  for (let i = 0; i < targetLapses; i++) {
    step("again"); // review → relearning (lapses += 1)
    if (i < targetLapses - 1) step("good"); // relearning → review (so it can lapse again)
  }
  return review;
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("leech detection on the grade path", () => {
  it("flags a card a leech once lapses reach the threshold (4), in the same transaction", () => {
    expect(LEECH_LAPSE_THRESHOLD).toBe(4);
    const cardId = seedCard();
    const review = lapse(cardId, LEECH_LAPSE_THRESHOLD);

    const state = review.findReviewState(cardId);
    expect(state?.lapses).toBeGreaterThanOrEqual(LEECH_LAPSE_THRESHOLD);
    expect(review.isCardLeech(cardId)).toBe(true);

    // Exactly one `update_element` op carrying the leech flag was logged, alongside
    // the `add_review_log` ops — and NO new op type was introduced.
    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, cardId))
      .all();
    const leechOps = ops.filter(
      (o) =>
        o.opType === "update_element" &&
        typeof o.payload === "string" &&
        o.payload.includes('"isLeech":true'),
    );
    expect(leechOps).toHaveLength(1);
    expect(ops.every((o) => o.opType !== "mark_leech" && o.opType !== "leech")).toBe(true);
  });

  it("does not flag a card below the threshold", () => {
    const cardId = seedCard();
    const review = lapse(cardId, LEECH_LAPSE_THRESHOLD - 1);
    expect(review.isCardLeech(cardId)).toBe(false);
  });

  it("sets the leech flag only ONCE (a later lapse does not re-log it)", () => {
    const cardId = seedCard();
    lapse(cardId, LEECH_LAPSE_THRESHOLD + 2);
    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, cardId))
      .all();
    const leechOps = ops.filter(
      (o) =>
        o.opType === "update_element" &&
        typeof o.payload === "string" &&
        o.payload.includes('"isLeech":true'),
    );
    expect(leechOps).toHaveLength(1);
  });
});

describe("ReviewRepository.listLeechCards", () => {
  it("returns only leech cards, most-lapsed first, excluding non-leech + deleted", () => {
    const review = new ReviewRepository(handle.db);
    const elementsRepo = new ElementRepository(handle.db);

    const leechA = seedCard("Leech A");
    lapse(leechA, LEECH_LAPSE_THRESHOLD); // 4 lapses
    const leechB = seedCard("Leech B");
    lapse(leechB, LEECH_LAPSE_THRESHOLD + 2); // 6 lapses
    const healthy = seedCard("Healthy");
    lapse(healthy, 1); // not a leech

    const deletedLeech = seedCard("Deleted leech");
    lapse(deletedLeech, LEECH_LAPSE_THRESHOLD);
    elementsRepo.softDelete(deletedLeech);

    const leeches = review.listLeechCards();
    const ids = leeches.map((l) => l.element.id);
    expect(ids).toContain(leechA);
    expect(ids).toContain(leechB);
    expect(ids).not.toContain(healthy);
    expect(ids).not.toContain(deletedLeech);

    // Most-lapsed first (B before A).
    expect(ids.indexOf(leechB)).toBeLessThan(ids.indexOf(leechA));
    const b = leeches.find((l) => l.element.id === leechB);
    expect(b?.lapses).toBeGreaterThanOrEqual(LEECH_LAPSE_THRESHOLD + 2);
  });
});

describe("ReviewRepository.setCardLeech (manual mark / un-leech)", () => {
  it("sets + clears the flag and logs update_element each time", () => {
    const review = new ReviewRepository(handle.db);
    const cardId = seedCard();
    expect(review.isCardLeech(cardId)).toBe(false);

    review.setCardLeech(cardId, true);
    expect(review.isCardLeech(cardId)).toBe(true);
    const row = handle.db.select().from(cardsTable).where(eq(cardsTable.elementId, cardId)).get();
    expect(row?.isLeech).toBe(true);

    review.setCardLeech(cardId, false);
    expect(review.isCardLeech(cardId)).toBe(false);

    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, cardId))
      .all();
    const updates = ops.filter((o) => o.opType === "update_element");
    // Two manual toggles → two update_element ops (no new op type).
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });
});

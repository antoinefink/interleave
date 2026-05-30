/**
 * UndoService tests (T044 — the general, command-level undo).
 *
 * Run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB so behaviour
 * matches production. They pin the contract from the roadmap's covered set:
 *
 *  - `soft_delete_element` → restore to the PRIOR status, lineage intact, with a
 *    `restore_element` op appended;
 *  - `update_element` (mark-done / suspend) → re-apply the PRE-IMAGE so the status
 *    goes back, with another `update_element` appended;
 *  - `reschedule_element` (postpone) → restore the prior `dueAt`/`status`;
 *  - a BULK postpone (one shared `batchId`) → `undoLast` reverts EVERY item;
 *  - a NON-INVERTIBLE last op (e.g. `create_element`) → `{ undone: false }`, no
 *    mutation;
 *  - undo adds NO new op type (the inverse is one of the closed 15 and is itself
 *    logged), so the log stays append-only.
 */

import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardEditService } from "./card-edit-service";
import { ElementRepository } from "./element-repository";
import { createRepositories } from "./index";
import { OperationLogRepository } from "./operation-log-repository";
import { QueueActionService } from "./queue-action-service";
import { type ReviewOutcome, ReviewRepository } from "./review-repository";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

let handle: DbHandle;

function createActiveElement(handle: DbHandle, title = "Spaced repetition"): ElementId {
  const elements = new ElementRepository(handle.db);
  const el = elements.create({
    type: "extract",
    status: "active",
    stage: "raw_extract",
    priority: 0.625,
    title,
    dueAt: "2026-01-01T00:00:00.000Z" as IsoTimestamp,
  });
  return el.id;
}

/** Seed a Q&A card with an FSRS review_states row, forced due so it reads in the queue. */
function seedDueCard(handle: DbHandle, title = "Q: define intelligence"): ElementId {
  const review = new ReviewRepository(handle.db);
  const { element } = review.createCard({
    kind: "qa",
    title,
    priority: 0.625,
    prompt: "Define intelligence",
    answer: "Skill-acquisition efficiency",
  });
  handle.db
    .update(reviewStates)
    .set({ dueAt: "2020-01-01T00:00:00.000Z" })
    .where(eq(reviewStates.elementId, element.id))
    .run();
  return element.id;
}

/**
 * Seed a Q&A card LEFT AT `card_draft` (no `firstScheduledAt`), so the first grade
 * with `promoteFromDraft` fires the `card_draft → active_card` promote op.
 */
function seedDraftCard(handle: DbHandle, title = "Q: define recall"): ElementId {
  const review = new ReviewRepository(handle.db);
  const { element } = review.createCard({
    kind: "qa",
    title,
    priority: 0.625,
    prompt: "Define recall",
    answer: "Retrieving stored information",
  });
  return element.id;
}

/** A passing (non-leech) FSRS outcome — a normal `good` grade, no added lapse. */
function passingOutcome(): ReviewOutcome {
  return {
    rating: "good",
    reviewedAt: "2026-05-30T12:00:00.000Z" as IsoTimestamp,
    responseMs: 1500,
    prevState: "new",
    nextState: "review",
    nextStability: 3.2,
    nextDifficulty: 5.1,
    nextDueAt: "2026-06-02T12:00:00.000Z" as IsoTimestamp,
    elapsedDays: 0,
    scheduledDays: 3,
    reps: 1,
    lapses: 0,
    nextLearningSteps: 0,
  };
}

/** A review outcome whose cumulative `lapses` crosses the leech threshold (4). */
function leechOutcome(): ReviewOutcome {
  return {
    rating: "again",
    reviewedAt: "2026-05-30T12:00:00.000Z" as IsoTimestamp,
    responseMs: 1500,
    prevState: "review",
    nextState: "relearning",
    nextStability: 1.2,
    nextDifficulty: 8.4,
    nextDueAt: "2026-05-31T12:00:00.000Z" as IsoTimestamp,
    elapsedDays: 3,
    scheduledDays: 1,
    reps: 9,
    lapses: 4,
    nextLearningSteps: 0,
  };
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("UndoService.undoLast", () => {
  it("undoes a soft-delete: element live again with its prior status + a restore_element op", () => {
    const elements = new ElementRepository(handle.db);
    const undo = new UndoService(handle.db);
    const log = new OperationLogRepository(handle.db);
    const id = createActiveElement(handle);

    elements.softDelete(id);
    expect(elements.findById(id)?.deletedAt).not.toBeNull();
    expect(elements.findById(id)?.status).toBe("deleted");

    const result = undo.undoLast();
    expect(result.undone).toBe(true);
    expect(result.opType).toBe("soft_delete_element");
    expect(result.label).toContain("Spaced repetition");

    const after = elements.findById(id);
    expect(after?.deletedAt).toBeNull();
    expect(after?.status).toBe("active"); // restored to PRIOR status, not a default
    expect(log.listAll(1)[0]?.opType).toBe("restore_element"); // undo is itself logged
  });

  it("undoes a mark-done: status back to the prior value with an update_element op", () => {
    const elements = new ElementRepository(handle.db);
    const undo = new UndoService(handle.db);
    const log = new OperationLogRepository(handle.db);
    const id = createActiveElement(handle);

    elements.update(id, { status: "done" });
    expect(elements.findById(id)?.status).toBe("done");

    const result = undo.undoLast();
    expect(result.undone).toBe(true);
    expect(result.opType).toBe("update_element");
    expect(elements.findById(id)?.status).toBe("active");
    expect(log.listAll(1)[0]?.opType).toBe("update_element");
  });

  it("undoes a suspend back to the prior status", () => {
    const elements = new ElementRepository(handle.db);
    const undo = new UndoService(handle.db);
    const id = createActiveElement(handle);

    elements.update(id, { status: "suspended" });
    expect(elements.findById(id)?.status).toBe("suspended");

    undo.undoLast();
    expect(elements.findById(id)?.status).toBe("active");
  });

  it("undoes a reschedule (postpone): prior dueAt + status restored", () => {
    const elements = new ElementRepository(handle.db);
    const undo = new UndoService(handle.db);
    const id = createActiveElement(handle);
    const originalDue = elements.findById(id)?.dueAt;

    const later = "2026-06-01T00:00:00.000Z" as IsoTimestamp;
    elements.reschedule(id, later);
    expect(elements.findById(id)?.dueAt).toBe(later);

    const result = undo.undoLast();
    expect(result.undone).toBe(true);
    expect(result.opType).toBe("reschedule_element");
    expect(elements.findById(id)?.dueAt).toBe(originalDue);
  });

  it("undoes a whole BULK postpone batch in one call", () => {
    const repos = createRepositories(handle.db);
    const qa = new QueueActionService(handle.db);
    const undo = new UndoService(handle.db);
    const a = createActiveElement(handle, "Alpha");
    const b = createActiveElement(handle, "Beta");
    const c = createActiveElement(handle, "Gamma");
    const dueBefore = {
      a: repos.elements.findById(a)?.dueAt,
      b: repos.elements.findById(b)?.dueAt,
      c: repos.elements.findById(c)?.dueAt,
    };

    const { batchId } = qa.bulkPostpone([a, b, c]);
    expect(batchId).toBeTruthy();
    // All three moved.
    expect(repos.elements.findById(a)?.dueAt).not.toBe(dueBefore.a);
    expect(repos.elements.findById(b)?.dueAt).not.toBe(dueBefore.b);
    expect(repos.elements.findById(c)?.dueAt).not.toBe(dueBefore.c);

    const result = undo.undoLast();
    expect(result.undone).toBe(true);
    expect(result.count).toBe(3); // the whole batch reversed
    expect(repos.elements.findById(a)?.dueAt).toBe(dueBefore.a);
    expect(repos.elements.findById(b)?.dueAt).toBe(dueBefore.b);
    expect(repos.elements.findById(c)?.dueAt).toBe(dueBefore.c);
  });

  it("returns { undone: false } and mutates nothing on a non-invertible last op", () => {
    const elements = new ElementRepository(handle.db);
    const undo = new UndoService(handle.db);
    const log = new OperationLogRepository(handle.db);
    // A bare create — the last op is `create_element`, which the global undo does
    // not invert for the MVP.
    const id = createActiveElement(handle);
    const before = elements.findById(id);
    const opCountBefore = log.count();

    const result = undo.undoLast();
    expect(result.undone).toBe(false);
    expect(result.opType).toBe("create_element");
    expect(result.reason).toBeTruthy();
    // Nothing changed, no op appended.
    expect(elements.findById(id)).toEqual(before);
    expect(log.count()).toBe(opCountBefore);
  });

  it("undoes a restore back to trashed (redo-friendly)", () => {
    const elements = new ElementRepository(handle.db);
    const undo = new UndoService(handle.db);
    const id = createActiveElement(handle);

    elements.softDelete(id);
    elements.restore(id, "active");
    expect(elements.findById(id)?.deletedAt).toBeNull();

    const result = undo.undoLast();
    expect(result.undone).toBe(true);
    expect(result.opType).toBe("restore_element");
    expect(elements.findById(id)?.deletedAt).not.toBeNull();
  });

  it("returns { undone: false } on an empty log", () => {
    const undo = new UndoService(handle.db);
    const result = undo.undoLast();
    expect(result.undone).toBe(false);
    expect(result.opType).toBeNull();
  });

  // ── Marker `update_element` ops carry no pre-image → they are NON-invertible.
  // Global undo immediately after them must NOT report a phantom success.

  it("reports { undone: false } and changes nothing on a card FLAG (marker update_element, no prev)", () => {
    const edit = new CardEditService(handle.db);
    const undo = new UndoService(handle.db);
    const id = seedDueCard(handle);

    edit.flag(id, true, "ambiguous pronoun");
    expect(edit.isFlagged(id)).toBe(true);
    const opsBefore = new OperationLogRepository(handle.db).count();

    const result = undo.undoLast();
    expect(result.undone).toBe(false);
    expect(result.opType).toBe("update_element");
    expect(result.reason).toBeTruthy();
    // The flag is UNCHANGED (the marker has no pre-image to revert) and NO inverting
    // op was appended — undo did not fake a success.
    expect(edit.isFlagged(id)).toBe(true);
    expect(new OperationLogRepository(handle.db).count()).toBe(opsBefore);
  });

  it("reports { undone: false } and changes nothing on a card BODY edit (marker update_element, no prev)", () => {
    const edit = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);
    const undo = new UndoService(handle.db);
    const id = seedDueCard(handle);

    edit.updateBody(id, { prompt: "Define G", answer: "general intelligence" });
    expect(review.findCardById(id)?.card.prompt).toBe("Define G");
    const opsBefore = new OperationLogRepository(handle.db).count();

    const result = undo.undoLast();
    expect(result.undone).toBe(false);
    expect(result.opType).toBe("update_element");
    // The edited body STANDS (the marker op has no pre-image) and no op was appended.
    expect(review.findCardById(id)?.card.prompt).toBe("Define G");
    expect(new OperationLogRepository(handle.db).count()).toBe(opsBefore);
  });

  it("reports { undone: false } when the last op is the leech marker from a review (no prev)", () => {
    const review = new ReviewRepository(handle.db);
    const undo = new UndoService(handle.db);
    const id = seedDueCard(handle);

    // A grade that crosses the lapse threshold appends a leech `update_element` AS THE
    // LAST op — pressing global Undo right after must not claim a phantom success.
    review.recordReview(id, leechOutcome());
    expect(review.isCardLeech(id)).toBe(true);
    expect(new OperationLogRepository(handle.db).listAll(1)[0]?.opType).toBe("update_element");
    const opsBefore = new OperationLogRepository(handle.db).count();

    const result = undo.undoLast();
    expect(result.undone).toBe(false);
    expect(result.opType).toBe("update_element");
    // The leech flag is untouched and no inverting op was appended.
    expect(review.isCardLeech(id)).toBe(true);
    expect(new OperationLogRepository(handle.db).count()).toBe(opsBefore);
  });

  it("reports { undone: false } when the last op is the first-grade draft-card PROMOTE (rides with the review)", () => {
    const review = new ReviewRepository(handle.db);
    const elements = new ElementRepository(handle.db);
    const undo = new UndoService(handle.db);
    const id = seedDraftCard(handle);
    expect(elements.findById(id)?.stage).toBe("card_draft");

    // First grade of a still-draft card: recordReview appends `add_review_log` THEN a
    // promote `update_element` (card_draft → active_card) AS THE LAST op. That promote
    // carries a real `prev` for audit, but it is tagged `reviewPromote` so global undo
    // treats it as part of the (non-invertible) review — pressing ⌘Z must NOT demote
    // the card back to a draft while the durable review_log + advanced FSRS due persist.
    review.recordReview(id, passingOutcome(), { promoteFromDraft: true });
    expect(elements.findById(id)?.stage).toBe("active_card");
    expect(elements.findById(id)?.status).toBe("active");
    const lastOp = new OperationLogRepository(handle.db).listAll(1)[0];
    expect(lastOp?.opType).toBe("update_element"); // the promote is the last op
    const reviewDueAfter = review.findReviewState(id)?.dueAt;
    const opsBefore = new OperationLogRepository(handle.db).count();

    const result = undo.undoLast();
    expect(result.undone).toBe(false);
    expect(result.opType).toBe("update_element");
    expect(result.reason).toBeTruthy();
    // The card STAYS promoted, the FSRS due date STANDS, and no inverting op was
    // appended — no incoherent partial undo of the review.
    expect(elements.findById(id)?.stage).toBe("active_card");
    expect(elements.findById(id)?.status).toBe("active");
    expect(review.findReviewState(id)?.dueAt).toBe(reviewDueAfter);
    expect(new OperationLogRepository(handle.db).count()).toBe(opsBefore);
  });

  // ── A card postpone-defer (T030) advances BOTH stores; undo must restore BOTH so
  // the card returns to the FSRS due queue.

  it("undoes a CARD postpone-defer: restores BOTH elements.due_at AND review_states.due_at", () => {
    const repos = createRepositories(handle.db);
    const qa = new QueueActionService(handle.db);
    const undo = new UndoService(handle.db);
    const review = new ReviewRepository(handle.db);
    const id = seedDueCard(handle);

    const elementDueBefore = repos.elements.findById(id)?.dueAt;
    const reviewDueBefore = review.findReviewState(id)?.dueAt;
    expect(reviewDueBefore).toBe("2020-01-01T00:00:00.000Z");

    // Postpone the due card → both the element due and the FSRS due move forward.
    qa.act(id, "postpone", "2026-05-30T12:00:00.000Z" as IsoTimestamp);
    expect(review.findReviewState(id)?.dueAt).not.toBe(reviewDueBefore);
    // The card has LEFT the due queue while deferred.
    expect(
      repos.queue.dueCards("2026-05-30T12:00:00.000Z" as IsoTimestamp).map((c) => c.id),
    ).not.toContain(id);

    const result = undo.undoLast();
    expect(result.undone).toBe(true);
    expect(result.opType).toBe("reschedule_element");
    // BOTH stores restored — the queue (which reads review_states.due_at for cards)
    // sees the card as due again.
    expect(repos.elements.findById(id)?.dueAt).toBe(elementDueBefore);
    expect(review.findReviewState(id)?.dueAt).toBe(reviewDueBefore);
    expect(
      repos.queue.dueCards("2026-05-30T12:00:00.000Z" as IsoTimestamp).map((c) => c.id),
    ).toContain(id);
  });
});

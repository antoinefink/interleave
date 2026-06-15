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

import type { BlockId, ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import {
  documents,
  elementDetachSnapshot,
  elementReverifyProvenance,
  elements,
  operationLog,
  reviewStates,
} from "@interleave/db";
import { desc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { CardEditService } from "./card-edit-service";
import { CardService } from "./card-service";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ExtractService } from "./extract-service";
import { ExtractionService } from "./extraction-service";
import { createRepositories } from "./index";
import { OperationLogRepository } from "./operation-log-repository";
import { QueueActionService } from "./queue-action-service";
import { ReverifyResolutionRepository } from "./reverify-resolution-repository";
import { type ReviewOutcome, ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

/**
 * A minimal `ParsedOp`-shaped record so the tests can drive `UndoService`'s private
 * `isInvertible` / `invertWithin` directly (the plan's U3 assertions name those methods).
 * The service parses the same shape out of `operation_log`, so calling them with a
 * hand-built op is faithful to production.
 */
interface UndoServicePrivate {
  isInvertible(op: {
    id: string;
    opType: string;
    elementId: ElementId | null;
    payload: Record<string, unknown>;
  }): boolean;
  invertWithin(
    tx: unknown,
    op: {
      id: string;
      opType: string;
      elementId: ElementId | null;
      payload: Record<string, unknown>;
    },
  ): string | null;
}

function asPrivate(undo: UndoService): UndoServicePrivate {
  return undo as unknown as UndoServicePrivate;
}

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
    prevState: "new",
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

  it("restores schedule reason evidence when undo returns to a learned due date", () => {
    const elements = new ElementRepository(handle.db);
    const undo = new UndoService(handle.db);
    const log = new OperationLogRepository(handle.db);
    const id = createActiveElement(handle);
    const learnedDue = "2026-02-01T00:00:00.000Z" as IsoTimestamp;
    const explicitDue = "2026-03-01T00:00:00.000Z" as IsoTimestamp;

    handle.db.transaction((tx) => {
      elements.rescheduleWithin(tx, id, learnedDue, "scheduled", {
        action: "extract",
        scheduledAt: "2026-01-25T00:00:00.000Z",
        scheduleReason: {
          kind: "yield_shortened",
          baseIntervalDays: 7,
          finalIntervalDays: 6,
          intervalAfterMultiplierDays: 6,
          productiveOutputCount: 2,
        },
      });
    });
    elements.reschedule(id, explicitDue);
    expect(elements.findById(id)?.dueAt).toBe(explicitDue);

    const result = undo.undoLast();
    expect(result.undone).toBe(true);
    expect(result.opType).toBe("reschedule_element");
    expect(elements.findById(id)?.dueAt).toBe(learnedDue);
    expect(log.currentScheduleProjection(id, learnedDue).reason).toMatchObject({
      kind: "yield_shortened",
      productiveOutputCount: 2,
    });
  });

  it("undoes queue-soon-from-parked with the parked timestamp restored", () => {
    const elements = new ElementRepository(handle.db);
    const undo = new UndoService(handle.db);
    const id = createActiveElement(handle);
    const parkedAt = "2026-06-09T10:00:00.000Z" as IsoTimestamp;
    const queuedAt = "2026-06-10T10:00:00.000Z" as IsoTimestamp;

    elements.update(id, { status: "parked", dueAt: null, parkedAt });
    elements.update(id, { status: "scheduled", dueAt: queuedAt, parkedAt: null });
    expect(elements.findById(id)).toMatchObject({
      status: "scheduled",
      dueAt: queuedAt,
      parkedAt: null,
    });

    const result = undo.undoLast();
    expect(result.undone).toBe(true);
    expect(result.opType).toBe("update_element");
    expect(elements.findById(id)).toMatchObject({
      status: "parked",
      dueAt: null,
      parkedAt,
    });
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

  it("is ATOMIC: a mid-batch inversion failure rolls back the WHOLE batch (REL-01)", () => {
    const repos = createRepositories(handle.db);
    const qa = new QueueActionService(handle.db);
    const undo = new UndoService(handle.db);
    const a = createActiveElement(handle, "Alpha");
    const b = createActiveElement(handle, "Beta");
    const c = createActiveElement(handle, "Gamma");
    const origDueA = repos.elements.findById(a)?.dueAt;

    // Bulk-postpone all three under one batchId → three `reschedule_element` ops, in
    // insertion order a, b, c (so the batch inverts newest-first: c, b, a).
    qa.bulkPostpone([a, b, c], "2026-06-15T12:00:00.000Z" as IsoTimestamp);
    const postponed = {
      a: repos.elements.findById(a)?.dueAt,
      b: repos.elements.findById(b)?.dueAt,
      c: repos.elements.findById(c)?.dueAt,
    };
    // Sanity: every row actually moved off its original due before we attempt undo.
    expect(postponed.a).not.toBe(origDueA);
    const opsAfterBatch = new OperationLogRepository(handle.db).count();

    // Fault-inject a stale-row / constraint-style failure on the inversion of `a` — the
    // OLDEST op, so it is inverted LAST. `c` and `b` invert cleanly first; in the old
    // bare loop (N independent transactions) they would already be durably committed
    // when `a` throws, stranding a HALF-undone batch with no compensation. The fix wraps
    // the whole batch in ONE transaction, so the throw must roll EVERYTHING back.
    const realReschedule = ElementRepository.prototype.rescheduleWithin;
    const spy = vi
      .spyOn(ElementRepository.prototype, "rescheduleWithin")
      .mockImplementation(function (
        this: ElementRepository,
        ...args: Parameters<typeof realReschedule>
      ) {
        if (args[1] === a) throw new Error("simulated stale row during inversion");
        return realReschedule.apply(this, args);
      });

    try {
      expect(() => undo.undoLast()).toThrow(/simulated stale row/);
    } finally {
      spy.mockRestore();
    }

    // ALL-OR-NOTHING: not a single row was reverted (full rollback to the post-postpone
    // state), and no inverting op leaked into the log — never a partial state.
    expect(repos.elements.findById(a)?.dueAt).toBe(postponed.a);
    expect(repos.elements.findById(b)?.dueAt).toBe(postponed.b);
    expect(repos.elements.findById(c)?.dueAt).toBe(postponed.c);
    expect(new OperationLogRepository(handle.db).count()).toBe(opsAfterBatch);
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

  it("undoes a chronic-postpone reset marker by appending a reset-undo marker", () => {
    const elements = new ElementRepository(handle.db);
    const log = new OperationLogRepository(handle.db);
    const undo = new UndoService(handle.db);
    const id = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.625,
      title: "Chronic source",
    }).id;

    for (let i = 0; i < 5; i++) {
      handle.db.transaction((tx) => {
        log.append(tx, {
          opType: "reschedule_element",
          payload: { postpone: true, postponeCount: i + 1 },
          elementId: id,
        });
      });
    }
    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "update_element",
        payload: {
          id,
          action: "chronicPostpone:keep",
          chronicPostponeReset: true,
          prevEffectivePostponeCount: 5,
        },
        elementId: id,
      });
    });
    expect(log.countPostpones(id)).toBe(0);

    const result = undo.undoLast();

    expect(result.undone).toBe(true);
    expect(result.opType).toBe("update_element");
    expect(log.countPostpones(id)).toBe(5);
    expect(log.listAll(1)[0]?.payload).toMatchObject({
      chronicPostponeResetUndo: true,
      restoredEffectivePostponeCount: 5,
    });
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

describe("UndoService.undoLast — lineage branch delete (T135/U5)", () => {
  /** A `source → extract → card` chain; the card is DUE in both stores. */
  function seedBranch(): { extractId: ElementId; cardId: ElementId; reviewDue: string } {
    const repos = createRepositories(handle.db);
    const sourceId = repos.sources.create({ title: "Src", priority: 0.875, status: "active" })
      .element.id;
    const extractId = repos.sources.createExtract({
      sourceElementId: sourceId,
      title: "Extract",
      priority: 0.625,
      selectedText: "…",
      blockIds: ["blk" as BlockId],
      startOffset: 0,
      endOffset: 10,
      label: "¶1",
    }).element.id;
    const reviewDue = "2026-06-15T00:00:00.000Z";
    const cardId = repos.review.createCard({
      kind: "qa",
      title: "Card",
      priority: 0.625,
      prompt: "Q?",
      answer: "A.",
      parentId: extractId,
      sourceId,
      stage: "active_card",
      firstScheduledAt: reviewDue as IsoTimestamp,
    }).element.id;
    return { extractId, cardId, reviewDue };
  }

  it("R10/R11: undoLast restores every node to prior status AND re-establishes the card's review_states.due_at", () => {
    const { extractId, cardId, reviewDue } = seedBranch();
    const repos = createRepositories(handle.db);
    const review = new ReviewRepository(handle.db);
    const extractStatusBefore = repos.elements.findById(extractId)?.status;
    const cardStatusBefore = repos.elements.findById(cardId)?.status;

    new ExtractService(handle.db).deleteSubtree(extractId, { includeSubtree: true });
    // Both stores are cleared by the delete.
    expect(repos.elements.findById(cardId)?.dueAt).toBeNull();
    expect(review.findReviewState(cardId)?.dueAt).toBeNull();

    const result = new UndoService(handle.db).undoLast();
    expect(result.undone).toBe(true);
    expect(result.count).toBe(2); // extract + card

    // Both nodes are live again at their EXACT prior status…
    expect(repos.elements.findById(extractId)?.status).toBe(extractStatusBefore);
    expect(repos.elements.findById(extractId)?.deletedAt).toBeNull();
    expect(repos.elements.findById(cardId)?.status).toBe(cardStatusBefore);
    // …and the card's FSRS due is re-established EXACTLY (back in the due queue).
    expect(review.findReviewState(cardId)?.dueAt).toBe(reviewDue);
    expect(
      repos.queue.dueCards("2026-06-20T00:00:00.000Z" as IsoTimestamp).map((c) => c.id),
    ).toContain(cardId);
  });

  it("R10: undoLast restores the branch even after an intervening logged action (batch-scoped)", () => {
    const { extractId, cardId } = seedBranch();
    const repos = createRepositories(handle.db);

    new ExtractService(handle.db).deleteSubtree(extractId, { includeSubtree: true });
    // An unrelated logged action happens AFTER the delete.
    const otherId = repos.sources.create({ title: "Other", priority: 0.5, status: "active" })
      .element.id;
    repos.elements.update(otherId, { title: "Renamed" });

    // undoLast reverses the most-recent op (the rename), not the branch — so the
    // batch-scoped restore is what the snackbar Undo (restoreBatch) is for. Here we
    // assert the rename is undone and the branch is still deleted (documents the
    // global-undo semantics the plan calls out: snackbar uses restoreBatch).
    const result = new UndoService(handle.db).undoLast();
    expect(result.undone).toBe(true);
    expect(repos.elements.findById(otherId)?.title).toBe("Other");
    expect(repos.elements.findById(extractId)?.deletedAt).toBeTruthy();
    expect(repos.elements.findById(cardId)?.deletedAt).toBeTruthy();
  });

  it("undo-the-undo is symmetric: re-trashing a restored card re-clears its FSRS due", () => {
    const { cardId, reviewDue } = seedBranch();
    const review = new ReviewRepository(handle.db);
    const repos = createRepositories(handle.db);
    const cardStatusBefore = repos.elements.findById(cardId)?.status;

    // Single-node lineage delete of the card (preimage-aware): clears both due stores.
    new ExtractService(handle.db).deleteSubtree(cardId, { includeSubtree: false });
    expect(review.findReviewState(cardId)?.dueAt).toBeNull();
    const undo = new UndoService(handle.db);

    // Undo the delete → card live again + FSRS due re-established EXACTLY.
    const restored = undo.undoLast();
    expect(restored.undone).toBe(true);
    expect(repos.elements.findById(cardId)?.status).toBe(cardStatusBefore);
    expect(review.findReviewState(cardId)?.dueAt).toBe(reviewDue);

    // Undo-the-undo → the restore is inverted (re-trash). The card must go back to
    // deleted AND have its FSRS due cleared again (no phantom "Due today").
    const redo = undo.undoLast();
    expect(redo.undone).toBe(true);
    expect(repos.elements.findById(cardId)?.deletedAt).toBeTruthy();
    expect(repos.elements.findById(cardId)?.status).toBe("deleted");
    expect(review.findReviewState(cardId)?.dueAt).toBeNull();

    // …and undo-the-undo-the-undo restores it once more (the preimage round-trips).
    const reRestored = undo.undoLast();
    expect(reRestored.undone).toBe(true);
    expect(review.findReviewState(cardId)?.dueAt).toBe(reviewDue);
  });
});

/**
 * T124 U3 — `reverifyResolution` ops are reversed ONLY through the guarded receipt path.
 *
 * A resolution (confirm / detach / rebase) clears the self-healing flag by DELETING
 * provenance rows; its op carries the full preimage on a dedicated `reverifyResolution`
 * marker. The actual inverse lives in `ReverifyResolutionService.undoReceipt` →
 * `ReverifyResolutionRepository.restoreResolutionWithin` (with a four-part current-state
 * guard) — covered by the service + repository suites. The GLOBAL undo (`undoLast`)
 * deliberately does NOT reverse a resolution: a second, unguarded undo path would desync
 * the persisted receipt, and every resolution is immediately followed by a non-invertible
 * `propagation: true` recompute op that already shadows it. So this suite asserts the
 * global path defers — `isInvertible` is false and `invertWithin` is a no-op — while
 * T123's `propagation: true` flips stay non-invertible too. The seed mirrors the
 * resolution-repository test: a real source → extract → card lineage staled through
 * `BlockProcessingService` so provenance is produced exactly as production writes it.
 */
describe("UndoService — reverifyResolution is receipt-only (T124)", () => {
  interface ReverifyLineage {
    readonly sourceId: ElementId;
    readonly extractId: ElementId;
    readonly cardId: ElementId;
    readonly extractedBlock: BlockId;
  }

  function seedReverifyLineage(): ReverifyLineage {
    const { element: source } = new SourceRepository(handle.db).createWithDocument({
      title: "A long article",
      priority: 0.875,
      status: "active",
      stage: "raw_source",
      body: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
    });
    const sourceId = source.id;
    const blocks = new DocumentRepository(handle.db)
      .listBlocks(sourceId)
      .map((b) => b.stableBlockId as BlockId);
    const extractedBlock = blocks[1] as BlockId;

    const { element: extract } = new ExtractionService(handle.db).createExtraction({
      sourceElementId: sourceId,
      selectedText: "Second paragraph.",
      blockIds: [extractedBlock],
      startOffset: 0,
      endOffset: 17,
      priority: 0.875,
    });
    const { element: card } = new CardService(handle.db).createFromExtract({
      extractId: extract.id,
      kind: "qa",
      prompt: "What is in the second paragraph?",
      answer: "Second paragraph.",
    });

    return { sourceId, extractId: extract.id, cardId: card.id, extractedBlock };
  }

  function storedDoc(sourceId: ElementId): unknown {
    const row = handle.db
      .select({ json: documents.prosemirrorJson })
      .from(documents)
      .where(eq(documents.elementId, sourceId))
      .get();
    if (!row) throw new Error("no document");
    return JSON.parse(row.json);
  }

  function editBlockText(doc: unknown, blockId: BlockId, newText: string): unknown {
    const clone = JSON.parse(JSON.stringify(doc)) as { content?: unknown[] };
    const visit = (node: { attrs?: { blockId?: unknown }; content?: unknown[] }): void => {
      if (node?.attrs?.blockId === blockId) {
        node.content = [{ type: "text", text: newText }];
        return;
      }
      for (const child of node?.content ?? []) visit(child as never);
    };
    visit(clone as never);
    return clone;
  }

  /** Stale `extractedBlock` so the extract + card gain provenance + the flag. */
  function staleLineage(lineage: ReverifyLineage): void {
    const service = new BlockProcessingService(handle.db);
    handle.db.transaction((tx) => {
      service.reconcileSourceDocumentWithin(
        tx,
        lineage.sourceId,
        editBlockText(storedDoc(lineage.sourceId), lineage.extractedBlock, "Heavily rewritten."),
      );
    });
  }

  function needsReverify(id: ElementId): boolean {
    return (
      handle.db
        .select({ needsReverify: elements.needsReverify })
        .from(elements)
        .where(eq(elements.id, id))
        .get()?.needsReverify === true
    );
  }

  function provenanceRows(elementId: ElementId) {
    return handle.db
      .select()
      .from(elementReverifyProvenance)
      .where(eq(elementReverifyProvenance.elementId, elementId))
      .all();
  }

  function detachSnapshotCount(elementId: ElementId): number {
    return handle.db
      .select()
      .from(elementDetachSnapshot)
      .where(eq(elementDetachSnapshot.elementId, elementId))
      .all().length;
  }

  type ParsedLogOp = {
    id: string;
    opType: string;
    elementId: ElementId | null;
    payload: Record<string, unknown>;
  };

  /** All `update_element` ops for an element, parsed into the `ParsedOp` shape (newest first). */
  function elementOps(elementId: ElementId): ParsedLogOp[] {
    return new OperationLogRepository(handle.db).listForElement(elementId).map((entry) => ({
      id: entry.id,
      opType: entry.opType,
      elementId: entry.elementId as ElementId | null,
      payload: (entry.payload ?? {}) as Record<string, unknown>,
    }));
  }

  /** The `reverifyResolution`-marked op for an element. */
  function resolutionOp(elementId: ElementId): ParsedLogOp {
    const op = elementOps(elementId).find(
      (o) => o.payload.reverifyResolution !== undefined && o.payload.reverifyResolution !== null,
    );
    if (!op) throw new Error("expected a reverifyResolution op");
    return op;
  }

  /** A `propagation: true` op for an element (a T123 flag flip). */
  function propagationOp(elementId: ElementId): ParsedLogOp {
    const op = elementOps(elementId).find((o) => o.payload.propagation === true);
    if (!op) throw new Error("expected a propagation op");
    return op;
  }

  function confirmClear(lineage: ReverifyLineage, elementId: ElementId): void {
    handle.db.transaction((tx) => {
      new ReverifyResolutionRepository(handle.db).clearProvenanceWithin(tx, {
        elementId,
        sourceElementId: lineage.sourceId,
        stableBlockId: lineage.extractedBlock,
        batchId: "confirm-batch",
        verb: "confirm",
      });
    });
  }

  it("a reverifyResolution confirm op is NOT globally invertible — undo is receipt-only", () => {
    const lineage = seedReverifyLineage();
    staleLineage(lineage);
    confirmClear(lineage, lineage.extractId);
    expect(provenanceRows(lineage.extractId)).toHaveLength(0);
    expect(needsReverify(lineage.extractId)).toBe(false);

    // T124 resolutions are reversed ONLY through the guarded receipt path
    // (`ReverifyResolutionService.undoReceipt`), never global ⌘Z: the op reports
    // non-invertible and a global invert is a no-op that leaves the flag cleared (so the
    // single authoritative receipt path can't be desynced by an unguarded global undo).
    const undo = new UndoService(handle.db);
    const op = resolutionOp(lineage.extractId);
    expect(asPrivate(undo).isInvertible(op)).toBe(false);
    expect(asPrivate(undo).invertWithin(handle.db, op)).toBeNull();
    expect(provenanceRows(lineage.extractId)).toHaveLength(0);
    expect(needsReverify(lineage.extractId)).toBe(false);
  });

  it("a reverifyResolution detach op is NOT globally invertible either", () => {
    const lineage = seedReverifyLineage();
    staleLineage(lineage);
    handle.db.transaction((tx) => {
      new ReverifyResolutionRepository(handle.db).detachWithin(
        tx,
        {
          elementId: lineage.extractId,
          sourceElementId: lineage.sourceId,
          stableBlockId: lineage.extractedBlock,
          snapshot: {
            elementId: lineage.extractId,
            sourceElementId: lineage.sourceId,
            stableBlockId: lineage.extractedBlock,
            selectedText: "Second paragraph.",
            blockIds: JSON.stringify([lineage.extractedBlock]),
            startOffset: null,
            endOffset: null,
            preStaleHash: null,
          },
        },
        "detach-batch",
      );
    });
    expect(detachSnapshotCount(lineage.extractId)).toBe(1);

    const undo = new UndoService(handle.db);
    const op = resolutionOp(lineage.extractId);
    expect(asPrivate(undo).isInvertible(op)).toBe(false);
    expect(asPrivate(undo).invertWithin(handle.db, op)).toBeNull();
    // The snapshot + cleared flag stand — only the guarded receipt path reverses a detach.
    expect(detachSnapshotCount(lineage.extractId)).toBe(1);
    expect(needsReverify(lineage.extractId)).toBe(false);
  });

  it("a propagation:true op remains NON-invertible (T123 regression guard)", () => {
    const lineage = seedReverifyLineage();
    staleLineage(lineage); // the stale produces a `propagation: true` flag-flip op

    const undo = new UndoService(handle.db);
    const op = propagationOp(lineage.extractId);
    expect(asPrivate(undo).isInvertible(op)).toBe(false);
    // …and the inverse refuses to mutate (returns null), leaving the flag set.
    expect(asPrivate(undo).invertWithin(handle.db, op)).toBeNull();
    expect(needsReverify(lineage.extractId)).toBe(true);
  });
});

/**
 * Reach `UndoService`'s private `collectBatch` directly so the regression below can
 * assert its access path and bounded cost without routing through a full `undoBatch`.
 */
interface CollectBatchPrivate {
  collectBatch(batchId: string): {
    id: string;
    opType: string;
    payload: Record<string, unknown>;
  }[];
}

function asCollect(undo: UndoService): CollectBatchPrivate {
  return undo as unknown as CollectBatchPrivate;
}

/** Seed `n` single-op rows (no `batchId`) + one `size`-op batch sharing `batchId`. */
function seedLargeLog(handle: DbHandle, n: number, batchId: string, size: number): void {
  const insert = handle.sqlite.prepare(
    `INSERT INTO operation_log (id, op_type, payload, element_id, created_at, batch_id)
     VALUES (?, 'reschedule_element', ?, NULL, ?, ?)`,
  );
  const seed = handle.sqlite.transaction(() => {
    for (let i = 0; i < n; i++) {
      // Single-op rows: NO batchId in payload, NULL batch_id column.
      insert.run(
        `op-${i}`,
        JSON.stringify({ i }),
        `2026-01-01T00:00:00.${String(i % 1000).padStart(3, "0")}Z`,
        null,
      );
    }
    for (let j = 0; j < size; j++) {
      // The one batch: payload carries `batchId`, column mirrors it.
      insert.run(
        `b-${j}`,
        JSON.stringify({ batchId, postpone: true }),
        `2026-02-01T00:00:00.00${j}Z`,
        batchId,
      );
    }
  });
  seed();
}

describe("UndoService.collectBatch — index-bound (regression: PERF-01/R-002 full-scan)", () => {
  // collectBatch used to `SELECT * FROM operation_log` (no WHERE) and filter
  // `payload.batchId` in JS — an O(total ops) synchronous main-thread scan on every
  // batch undo. It now reads the indexed `batch_id` column. These pin the bounded cost.

  it("uses the operation_log_batch_idx index, never a full table scan", () => {
    seedLargeLog(handle, 20_000, "batch-x", 3);

    // Build the EXACT query `collectBatch` issues (same Drizzle builder + ordering) and
    // EXPLAIN the SQL Drizzle actually emits — not a hand-written approximation that
    // could drift from production. SQLite picks the selective equality index for the
    // WHERE and only sorts the handful of matched rows.
    const { sql: collectSql, params } = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.batchId, "batch-x"))
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .toSQL();
    const plan = handle.sqlite.prepare(`EXPLAIN QUERY PLAN ${collectSql}`).all(...params) as {
      detail: string;
    }[];
    const details = plan.map((row) => row.detail).join(" | ");

    expect(details).toContain("operation_log_batch_idx");
    expect(details).toContain("SEARCH");
    // The regression we are preventing: a SCAN of the whole operation_log table.
    expect(details).not.toMatch(/SCAN operation_log\b/);
  });

  it("collects a heterogeneous batch (mixed op types) newest-first (T126 inbox sweep)", () => {
    // A T126 inbox bulk sweep emits DIFFERENT op types under ONE batchId:
    // reschedule_element (queueSoon), update_element (park/priority), soft_delete_element
    // (delete). collectBatch is op-type-agnostic — it groups purely by batch_id — and
    // must return the whole batch newest-first so the inverses replay in reverse order.
    const insert = handle.sqlite.prepare(
      `INSERT INTO operation_log (id, op_type, payload, element_id, created_at, batch_id)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    );
    handle.sqlite.transaction(() => {
      insert.run(
        "h0",
        "reschedule_element",
        JSON.stringify({ batchId: "mix" }),
        "2026-03-01T00:00:00.000Z",
        "mix",
      );
      insert.run(
        "h1",
        "update_element",
        JSON.stringify({ batchId: "mix" }),
        "2026-03-01T00:00:00.001Z",
        "mix",
      );
      insert.run(
        "h2",
        "soft_delete_element",
        JSON.stringify({ batchId: "mix" }),
        "2026-03-01T00:00:00.002Z",
        "mix",
      );
      // A foreign single-op row that must NOT be collected.
      insert.run("other", "update_element", JSON.stringify({}), "2026-03-01T00:00:00.003Z", null);
    })();

    const batch = asCollect(new UndoService(handle.db)).collectBatch("mix");
    expect(batch.map((op) => op.id)).toEqual(["h2", "h1", "h0"]); // newest-first
    expect(batch.map((op) => op.opType)).toEqual([
      "soft_delete_element",
      "update_element",
      "reschedule_element",
    ]);
  });

  it("undoBatch on an unknown batchId is a clean no-op (no throw)", () => {
    seedLargeLog(handle, 100, "real-batch", 3);
    const undo = new UndoService(handle.db);

    const result = undo.undoBatch("does-not-exist");
    expect(result.undone).toBe(false);
    expect(result.count).toBe(0);
    expect(result.reason).toBe("Batch not found");
  });

  it("returns exactly the batch (newest-first) from a large log", () => {
    seedLargeLog(handle, 20_000, "batch-x", 3);
    const undo = new UndoService(handle.db);

    const batch = asCollect(undo).collectBatch("batch-x");
    expect(batch).toHaveLength(3);
    expect(batch.every((op) => op.payload.batchId === "batch-x")).toBe(true);
    // newest-first: created_at desc, rowid desc → b-2, b-1, b-0.
    expect(batch.map((op) => op.id)).toEqual(["b-2", "b-1", "b-0"]);
  });

  it("collect cost is bounded by batch size, not log size", () => {
    seedLargeLog(handle, 20_000, "batch-x", 3);
    const undo = new UndoService(handle.db);

    // Indexed collect of the 3-row batch.
    const t0 = performance.now();
    asCollect(undo).collectBatch("batch-x");
    const indexedMs = performance.now() - t0;

    // Replicate the OLD O(total) behaviour on the SAME table: read every row + parse
    // every payload + filter. Same machine, same data → a fair, non-flaky baseline.
    const t1 = performance.now();
    const allRows = handle.sqlite.prepare("SELECT id, payload FROM operation_log").all() as {
      id: string;
      payload: string;
    }[];
    allRows.filter(
      (row) => (JSON.parse(row.payload) as { batchId?: string }).batchId === "batch-x",
    );
    const fullScanMs = performance.now() - t1;

    // The indexed lookup must beat the full scan it replaced. The gap is ~orders of
    // magnitude (3 rows vs 20003 rows + 20003 JSON.parse), so this stays green even
    // under CI jitter; an accidental revert to the scan makes it fail.
    expect(indexedMs).toBeLessThan(fullScanMs);
  });
});

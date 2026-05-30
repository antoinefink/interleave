/**
 * CardEditService tests (T038 — in-review card repair).
 *
 * Against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB, these assert
 * the load-bearing repair invariants in ONE place:
 *
 *  - `updateBody` edits a Q&A card's prompt/answer (or a cloze card's cloze text),
 *    logs `update_element`, and NEVER touches lineage (`sourceLocationId`), the
 *    FSRS `review_states`, or the append-only `review_logs` (an edit must not
 *    corrupt the in-flight FSRS state);
 *  - `updateBody` keeps the body non-empty for the card's kind;
 *  - `suspend` sets status `suspended` (`update_element`), leaving review state/logs;
 *  - `delete` SOFT-deletes (`deletedAt` + status `deleted`, `soft_delete_element`);
 *  - `flag` records the flag in the op payload (no column; the latest marker wins),
 *    leaving the card live + un-touching its body/lineage/FSRS state;
 *  - every repair appends the CORRECT EXISTING op (the closed 15-op set is unchanged).
 */

import type { BlockId, ElementId, Priority } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { operationLog } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardEditService } from "./card-edit-service";
import { CardService } from "./card-service";
import { ElementRepository } from "./element-repository";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

/** Seed a source + an anchored extract, then a Q&A (and optionally cloze) card. */
function seedCard(
  handle: DbHandle,
  kind: "qa" | "cloze" = "qa",
  priority: Priority = 0.875,
): { cardId: ElementId; sourceLocationId: string | null } {
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
  const cardSvc = new CardService(handle.db);
  const { element, sourceLocationId } = cardSvc.createFromExtract(
    kind === "qa"
      ? {
          extractId: extract.id,
          kind: "qa",
          prompt: "Original prompt?",
          answer: "Original answer.",
        }
      : { extractId: extract.id, kind: "cloze", cloze: "Intelligence is {{c1::efficiency}}." },
  );
  return { cardId: element.id, sourceLocationId };
}

/** Count `operation_log` rows of a given type for an element. */
function opCount(handle: DbHandle, elementId: ElementId, opType: string): number {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, elementId))
    .all()
    .filter((r) => r.opType === opType).length;
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("CardEditService.updateBody", () => {
  it("edits a Q&A card's prompt/answer, logs update_element, and preserves lineage + FSRS state", () => {
    const { cardId, sourceLocationId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);

    const stateBefore = review.findReviewState(cardId);
    const logsBefore = review.listReviewLogs(cardId).length;
    const opsBefore = opCount(handle, cardId, "update_element");

    const { card } = service.updateBody(cardId, { prompt: "New prompt?", answer: "New answer." });

    expect(card.prompt).toBe("New prompt?");
    expect(card.answer).toBe("New answer.");
    // The inherited source-location anchor is intact (lineage preserved).
    expect(card.sourceLocationId).toBe(sourceLocationId);
    // The FSRS state + append-only logs are untouched by an edit.
    const stateAfter = review.findReviewState(cardId);
    expect(stateAfter?.dueAt).toBe(stateBefore?.dueAt);
    expect(stateAfter?.reps).toBe(stateBefore?.reps);
    expect(review.listReviewLogs(cardId).length).toBe(logsBefore);
    // Exactly one new update_element op.
    expect(opCount(handle, cardId, "update_element")).toBe(opsBefore + 1);
  });

  it("edits a cloze card's cloze text (canonicalizing bare markers), ignoring prompt/answer", () => {
    const { cardId } = seedCard(handle, "cloze");
    const service = new CardEditService(handle.db);
    const { card } = service.updateBody(cardId, { cloze: "Memory is {{consolidation}}." });
    // Bare `{{answer}}` is auto-numbered to the canonical `{{c1::answer}}` form.
    expect(card.cloze).toContain("{{c1::consolidation}}");
    expect(card.prompt).toBeNull();
    expect(card.answer).toBeNull();
  });

  it("rejects emptying a Q&A card's required prompt/answer", () => {
    const { cardId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    expect(() => service.updateBody(cardId, { prompt: "" })).toThrow();
    expect(() => service.updateBody(cardId, { answer: "   " })).toThrow();
  });

  it("rejects a non-card / unknown element", () => {
    const service = new CardEditService(handle.db);
    expect(() => service.updateBody("el_missing" as ElementId, { prompt: "x" })).toThrow(
      /not found/,
    );
  });
});

describe("CardEditService.suspend / delete", () => {
  it("suspend sets status suspended and logs update_element, keeping review state", () => {
    const { cardId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);
    const opsBefore = opCount(handle, cardId, "update_element");

    const { element } = service.suspend(cardId);
    expect(element.status).toBe("suspended");
    expect(new ElementRepository(handle.db).findById(cardId)?.status).toBe("suspended");
    // The review state survives (recoverable on un-suspend).
    expect(review.findReviewState(cardId)).not.toBeNull();
    expect(opCount(handle, cardId, "update_element")).toBe(opsBefore + 1);
  });

  it("delete soft-deletes (status deleted, deletedAt set) and logs soft_delete_element", () => {
    const { cardId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    const opsBefore = opCount(handle, cardId, "soft_delete_element");

    const { element } = service.delete(cardId);
    expect(element.status).toBe("deleted");
    expect(element.deletedAt).toBeTruthy();
    expect(opCount(handle, cardId, "soft_delete_element")).toBe(opsBefore + 1);
  });
});

describe("CardEditService.flag", () => {
  it("records a non-destructive flag (via update_element) the latest marker resolves", () => {
    const { cardId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    const elements = new ElementRepository(handle.db);

    expect(service.isFlagged(cardId)).toBe(false);
    // Baseline: the card was first-scheduled + activated at creation (T036), which
    // itself logs an update_element. Measure the flag deltas against that baseline.
    const updatesBefore = opCount(handle, cardId, "update_element");

    const flagged = service.flag(cardId, true, "ambiguous pronoun");
    expect(flagged.element.status).not.toBe("deleted");
    expect(service.isFlagged(cardId)).toBe(true);
    expect(service.flagState(cardId).reason).toBe("ambiguous pronoun");
    // The card is NOT destroyed (a flag is advisory).
    expect(elements.findById(cardId)?.deletedAt).toBeNull();

    // Un-flagging clears it (latest marker wins).
    service.flag(cardId, false);
    expect(service.isFlagged(cardId)).toBe(false);

    // Only update_element ops were used for the flag (no new op type): the two
    // toggles add exactly two update_element ops over the creation baseline.
    expect(opCount(handle, cardId, "update_element")).toBe(updatesBefore + 2);
  });

  it("leaves the body + lineage + FSRS state untouched", () => {
    const { cardId, sourceLocationId } = seedCard(handle);
    const service = new CardEditService(handle.db);
    const review = new ReviewRepository(handle.db);
    const before = review.findCardById(cardId);
    const stateBefore = review.findReviewState(cardId);

    service.flag(cardId, true);

    const after = review.findCardById(cardId);
    expect(after?.card.prompt).toBe(before?.card.prompt);
    expect(after?.card.sourceLocationId).toBe(sourceLocationId);
    expect(review.findReviewState(cardId)?.dueAt).toBe(stateBefore?.dueAt);
  });
});

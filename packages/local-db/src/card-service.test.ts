/**
 * CardService tests (T032 — the M6 keystone).
 *
 * These run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB so
 * behaviour matches production. They assert the load-bearing card-authoring
 * invariants in ONE place:
 *
 *  - one `cards.create` produces EXACTLY one `card` element at stage `card_draft`,
 *    status `pending`, with `parentId = extractId` and `sourceId = extract.sourceId`;
 *  - a `cards` row carrying `kind` + prompt/answer (or cloze) + the INHERITED
 *    `sourceLocationId` (the extract's anchor → `card → extract → source location →
 *    source` lineage);
 *  - an UN-DUE `review_states` row (`dueAt = null`, `fsrsState = "new"`) — M6 does
 *    NO FSRS math; the card never appears in a `dueAt <= now` query;
 *  - inherited tags;
 *  - the exact `operation_log` rows (`create_element` + `create_card` + `add_tag`
 *    + `add_relation`);
 *  - sibling grouping: two cards from one extract sharing a `siblingGroupId`
 *    produce two `sibling_group` edges sharing that id;
 *  - the originating extract is UNCHANGED (still an attention item, still its own
 *    element, never given a `review_states` row);
 *  - ATOMICITY: a forced failure rolls the WHOLE card back (no orphan
 *    element/card/review-state/relation/tag rows).
 */

import type { BlockId, ElementId, Priority } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elementRelations, elementTags, operationLog, reviewStates } from "@interleave/db";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardService } from "./card-service";
import { ElementRepository } from "./element-repository";
import { nowIso } from "./ids";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

/** Seed a source with a body, then an extract anchored at its first block; return ids. */
function seedExtract(
  handle: DbHandle,
  priority: Priority = 0.875,
): { sourceId: ElementId; extractId: ElementId; locationId: string } {
  const sources = new SourceRepository(handle.db);
  const elementsRepo = new ElementRepository(handle.db);
  const { element: source } = sources.createWithDocument({
    title: "On the Measure of Intelligence",
    priority,
    status: "active",
    stage: "raw_source",
    body: "The definition paragraph.\n\nAnother paragraph.",
  });
  // The extract is created directly via the repository (the extraction service is
  // tested elsewhere) + anchored at a source location so the card inherits it.
  const { element: extract, location } = sources.createExtract({
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
  // Tag the EXTRACT so the card's tag inheritance is exercised (the card inherits
  // the extract's tags — the extract→source tag inheritance is ExtractionService's job).
  elementsRepo.addTag(extract.id, "definitions");
  elementsRepo.addTag(extract.id, "machine-learning");
  return { sourceId: source.id, extractId: extract.id, locationId: location.id };
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  handle.sqlite.close();
});

describe("CardService.createFromExtract — Q&A card", () => {
  it("creates exactly one card element at stage card_draft with extract/source lineage", () => {
    const { sourceId, extractId } = seedExtract(handle);
    const service = new CardService(handle.db);
    const elementsRepo = new ElementRepository(handle.db);

    const before = elementsRepo.listByType("card").length;
    const { element } = service.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "How does Chollet define intelligence?",
      answer: "As skill-acquisition efficiency over a scope of tasks.",
    });

    const after = elementsRepo.listByType("card");
    expect(after.length).toBe(before + 1);
    expect(element.type).toBe("card");
    expect(element.stage).toBe("card_draft");
    expect(element.status).toBe("pending");
    expect(element.parentId).toBe(extractId);
    expect(element.sourceId).toBe(sourceId);
  });

  it("writes a cards row with kind=qa, prompt/answer, and the inherited sourceLocationId", () => {
    const { extractId, locationId } = seedExtract(handle);
    const service = new CardService(handle.db);

    const { element, sourceLocationId } = service.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "How does Chollet define intelligence?",
      answer: "As skill-acquisition efficiency over a scope of tasks.",
    });

    const row = handle.db.select().from(cards).where(eq(cards.elementId, element.id)).get();
    expect(row?.kind).toBe("qa");
    expect(row?.prompt).toBe("How does Chollet define intelligence?");
    expect(row?.answer).toBe("As skill-acquisition efficiency over a scope of tasks.");
    expect(row?.cloze).toBeNull();
    // The card inherits the extract's EXACT source anchor (lineage).
    expect(row?.sourceLocationId).toBe(locationId);
    expect(sourceLocationId).toBe(locationId);
  });

  it("creates an UN-DUE review_states row (dueAt null, fsrsState new) — no FSRS math", () => {
    const { extractId } = seedExtract(handle);
    const service = new CardService(handle.db);

    const { element } = service.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
    });

    const rs = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, element.id))
      .get();
    expect(rs).toBeTruthy();
    expect(rs?.dueAt).toBeNull();
    expect(rs?.fsrsState).toBe("new");
    expect(rs?.reps).toBe(0);
    expect(rs?.lapses).toBe(0);

    // The card does NOT appear in a "due now" query (not FSRS-scheduled in M6).
    const dueNow = handle.db
      .select()
      .from(reviewStates)
      .where(and(isNotNull(reviewStates.dueAt), lte(reviewStates.dueAt, nowIso())))
      .all();
    expect(dueNow.length).toBe(0);
  });

  it("inherits the extract's tags onto the card", () => {
    const { extractId } = seedExtract(handle);
    const service = new CardService(handle.db);
    const elementsRepo = new ElementRepository(handle.db);

    const { element } = service.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
    });

    expect(elementsRepo.listTags(element.id).sort()).toEqual(["definitions", "machine-learning"]);
  });

  it("appends create_element + create_card + add_tag + add_relation ops (no FSRS op)", () => {
    const { extractId } = seedExtract(handle);
    const service = new CardService(handle.db);

    const { element } = service.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
    });

    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, element.id))
      .all()
      .map((r) => r.opType);
    expect(ops).toContain("create_element");
    expect(ops).toContain("create_card");
    expect(ops).toContain("add_tag");
    expect(ops).toContain("add_relation");
    // M6 does NO FSRS scheduling — no review op is logged for the card.
    expect(ops).not.toContain("add_review_log");
    expect(ops).not.toContain("reschedule_element");
  });

  it("inherits the extract's priority by default, and honors an explicit override", () => {
    const { extractId } = seedExtract(handle, 0.875); // A priority extract
    const service = new CardService(handle.db);

    const inherited = service.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
    });
    expect(inherited.element.priority).toBe(0.875);

    const overridden = service.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "Q2?",
      answer: "A2.",
      priority: 0.125, // D
      siblingGroupId: inherited.siblingGroupId,
    });
    expect(overridden.element.priority).toBe(0.125);
  });

  it("rolls back the WHOLE card atomically when a step throws", () => {
    const { extractId } = seedExtract(handle);
    const service = new CardService(handle.db);
    const elementsRepo = new ElementRepository(handle.db);

    // Force the sibling-relation step to throw AFTER the card + tags are written
    // on the tx; the whole card must roll back.
    const elementsField = (service as unknown as { elements: ElementRepository }).elements;
    const spy = vi.spyOn(elementsField, "addRelationWithin").mockImplementation(() => {
      throw new Error("boom: simulated failure inside the card transaction");
    });

    const cardsBefore = elementsRepo.listByType("card").length;
    const cardRowsBefore = handle.db.select().from(cards).all().length;
    const reviewStatesBefore = handle.db.select().from(reviewStates).all().length;
    const relationsBefore = handle.db.select().from(elementRelations).all().length;
    const tagsBefore = handle.db.select().from(elementTags).all().length;
    const opsBefore = handle.db.select().from(operationLog).all().length;

    expect(() =>
      service.createFromExtract({ extractId, kind: "qa", prompt: "Q?", answer: "A." }),
    ).toThrow(/boom/);

    expect(spy).toHaveBeenCalled();
    expect(elementsRepo.listByType("card").length).toBe(cardsBefore);
    expect(handle.db.select().from(cards).all().length).toBe(cardRowsBefore);
    expect(handle.db.select().from(reviewStates).all().length).toBe(reviewStatesBefore);
    expect(handle.db.select().from(elementRelations).all().length).toBe(relationsBefore);
    expect(handle.db.select().from(elementTags).all().length).toBe(tagsBefore);
    expect(handle.db.select().from(operationLog).all().length).toBe(opsBefore);
  });
});

describe("CardService.createFromExtract — cloze card + siblings", () => {
  it("writes a cards row with kind=cloze and the canonical cloze text", () => {
    const { extractId } = seedExtract(handle);
    const service = new CardService(handle.db);

    const { element } = service.createFromExtract({
      extractId,
      kind: "cloze",
      cloze: "Intelligence is {{c1::skill-acquisition efficiency}} over a scope of {{c2::tasks}}.",
    });

    const row = handle.db.select().from(cards).where(eq(cards.elementId, element.id)).get();
    expect(row?.kind).toBe("cloze");
    expect(row?.cloze).toContain("{{c1::skill-acquisition efficiency}}");
    expect(row?.prompt).toBeNull();
    expect(row?.answer).toBeNull();
  });

  it("groups two cards from one extract under the same sibling_group id, and neither is FSRS-due", () => {
    const { extractId } = seedExtract(handle);
    const service = new CardService(handle.db);

    const qa = service.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
    });
    const cloze = service.createFromExtract({
      extractId,
      kind: "cloze",
      cloze: "Intelligence is {{c1::skill-acquisition efficiency}}.",
      siblingGroupId: qa.siblingGroupId,
    });

    // Both cards carry a sibling_group edge sharing the SAME group id.
    expect(cloze.siblingGroupId).toBe(qa.siblingGroupId);
    const edges = handle.db
      .select()
      .from(elementRelations)
      .where(eq(elementRelations.relationType, "sibling_group"))
      .all();
    expect(edges.length).toBe(2);
    expect(new Set(edges.map((e) => e.siblingGroupId))).toEqual(new Set([qa.siblingGroupId]));
    expect(new Set(edges.map((e) => e.fromElementId))).toEqual(
      new Set([qa.element.id, cloze.element.id]),
    );

    // Neither card is FSRS-due: no review_states row has a dueAt <= now.
    const dueNow = handle.db
      .select()
      .from(reviewStates)
      .where(and(isNotNull(reviewStates.dueAt), lte(reviewStates.dueAt, nowIso())))
      .all();
    expect(dueNow.length).toBe(0);
  });

  it("leaves the originating extract UNCHANGED (still attention-scheduled, no review_states row)", () => {
    const { extractId } = seedExtract(handle);
    const elementsRepo = new ElementRepository(handle.db);
    const before = elementsRepo.findById(extractId);
    const service = new CardService(handle.db);

    service.createFromExtract({ extractId, kind: "qa", prompt: "Q?", answer: "A." });

    const after = elementsRepo.findById(extractId);
    expect(after?.type).toBe("extract");
    expect(after?.stage).toBe(before?.stage);
    expect(after?.status).toBe(before?.status);
    expect(after?.priority).toBe(before?.priority);
    // The extract was NOT converted into a card and was NOT given an FSRS row.
    const fsrs = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, extractId))
      .get();
    expect(fsrs).toBeUndefined();
  });
});

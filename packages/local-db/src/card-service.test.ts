/**
 * CardService tests (T032 — the M6 keystone).
 *
 * These run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB so
 * behaviour matches production. They assert the load-bearing card-authoring
 * invariants in ONE place:
 *
 *  - one `cards.create` produces EXACTLY one `card` element first-scheduled into
 *    active rotation (stage `active_card`, status `active`), with
 *    `parentId = extractId` and `sourceId = extract.sourceId`;
 *  - a `cards` row carrying `kind` + prompt/answer (or cloze) + the INHERITED
 *    `sourceLocationId` (the extract's anchor → `card → extract → source location →
 *    source` lineage);
 *  - a first-scheduled `review_states` row (`dueAt` set, `fsrsState = "new"`,
 *    counters zero) — no interval math runs here (the first GRADE does that), but
 *    the card IS due so it enters the deck and is reviewable;
 *  - inherited tags;
 *  - the exact `operation_log` rows (`create_element` + `create_card` +
 *    `update_element` [the card_draft → active_card first-schedule] + `add_tag`
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
import {
  cards,
  documentBlocks,
  documentMarks,
  documents,
  elementRelations,
  elementTags,
  operationLog,
  reviewStates,
} from "@interleave/db";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardService } from "./card-service";
import { ElementRepository } from "./element-repository";
import { ExtractService } from "./extract-service";
import { ExtractionService } from "./extraction-service";
import { nowIso } from "./ids";
import { SourceRepository } from "./source-repository";
import { SynthesisService } from "./synthesis-service";
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
  it("creates exactly one active_card element (first-scheduled) with extract/source lineage", () => {
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
    // T036 first-schedule: an authored card is activated into FSRS rotation so it
    // can actually be reviewed (card_draft → active_card, pending → active).
    expect(element.stage).toBe("active_card");
    expect(element.status).toBe("active");
    expect(element.parentId).toBe(extractId);
    expect(element.sourceId).toBe(sourceId);
  });

  it("rejects card creation from an extract with a non-card fate", () => {
    const { extractId } = seedExtract(handle);
    new ExtractService(handle.db).setFate(extractId, "done_without_card");

    expect(() =>
      new CardService(handle.db).createFromExtract({
        extractId,
        kind: "qa",
        prompt: "Q?",
        answer: "A.",
      }),
    ).toThrow(/reactivate the extract/);
  });

  it("rejects card creation from an extract with live synthesis lineage even if the cache is stale", () => {
    const { extractId } = seedExtract(handle);
    const synthesis = new SynthesisService(handle.db);
    const note = synthesis.create({ title: "Synthesis note" }).element;
    synthesis.linkElement(note.id, extractId);
    new ElementRepository(handle.db).update(extractId, { extractFate: null });

    expect(() =>
      new CardService(handle.db).createFromExtract({
        extractId,
        kind: "qa",
        prompt: "Q?",
        answer: "A.",
      }),
    ).toThrow(/reactivate the extract/);
  });

  it("rejects AI card drafts from an extract with a non-card fate", () => {
    const { extractId } = seedExtract(handle);
    new ExtractService(handle.db).setFate(extractId, "reference");

    expect(() =>
      new CardService(handle.db).createDraftFromSuggestion({
        owningElementId: extractId,
        kind: "qa",
        prompt: "Q?",
        answer: "A.",
      }),
    ).toThrow(/reactivate the extract/);
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

  it("first-schedules the review_states row (dueAt set, fsrsState new) — no interval math", () => {
    const { extractId } = seedExtract(handle);
    const service = new CardService(handle.db);

    const { element } = service.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
      asOf: "2026-05-30T00:00:00.000Z" as never,
    });

    const rs = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, element.id))
      .get();
    expect(rs).toBeTruthy();
    // T036 first-schedule: the card is DUE now (so it enters the deck and is
    // reviewable), but no interval math has run yet — fsrsState is still "new" and
    // the counters are zero. The first GRADE runs the real FSRS next() math.
    expect(rs?.dueAt).toBe("2026-05-30T00:00:00.000Z");
    expect(rs?.fsrsState).toBe("new");
    expect(rs?.reps).toBe(0);
    expect(rs?.lapses).toBe(0);

    // The card DOES appear in a "due now" query — it is first-scheduled at creation.
    const dueNow = handle.db
      .select()
      .from(reviewStates)
      .where(and(isNotNull(reviewStates.dueAt), lte(reviewStates.dueAt, nowIso())))
      .all();
    expect(dueNow.some((r) => r.elementId === element.id)).toBe(true);
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

  it("appends create_element + create_card + update_element + add_tag + add_relation ops (no FSRS op)", () => {
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
    // The card_draft → active_card first-schedule transition (T036) is logged as
    // update_element (no new op type — the closed 15-op set is unchanged).
    expect(ops).toContain("update_element");
    // First-schedule sets the initial due time directly on the new review_states /
    // element rows (NOT via reschedule_element), and no review has happened yet.
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

  it("rejects image_occlusion (those must go through the occlusion generator)", () => {
    // image_occlusion cards need an occlusion_masks row minted atomically by the
    // occlusion generator; authoring one here would yield a mask-less, blank card.
    const { extractId } = seedExtract(handle);
    const service = new CardService(handle.db);
    const elementsRepo = new ElementRepository(handle.db);

    const cardsBefore = elementsRepo.listByType("card").length;
    expect(() => service.createFromExtract({ extractId, kind: "image_occlusion" })).toThrow(
      /occlusion generator/,
    );
    // No element/row leaked: the guard throws before any write.
    expect(elementsRepo.listByType("card").length).toBe(cardsBefore);
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

  it("canonicalizes a bare {{answer}} cloze to numbered {{c1::…}} form", () => {
    const { extractId } = seedExtract(handle);
    const service = new CardService(handle.db);

    const { element } = service.createFromExtract({
      extractId,
      kind: "cloze",
      // The kit's bare form — must be auto-numbered before it is stored.
      cloze: "From the {{hippocampus}} to the {{neocortex}}.",
    });

    const row = handle.db.select().from(cards).where(eq(cards.elementId, element.id)).get();
    expect(row?.cloze).toBe("From the {{c1::hippocampus}} to the {{c2::neocortex}}.");
  });

  it("seeds the card body + a cloze document_mark per deletion (multi-cloze ⇒ clozeCount 2)", () => {
    const { extractId } = seedExtract(handle);
    const service = new CardService(handle.db);

    const { element } = service.createFromExtract({
      extractId,
      kind: "cloze",
      cloze: "Memory moves from the {{c1::hippocampus}} to the {{c2::neocortex}}.",
    });

    // The card has its OWN document body (one paragraph block) — needed so the cloze
    // marks can anchor to a stable block id (the marks FK targets documents).
    const body = handle.db
      .select()
      .from(documents)
      .where(eq(documents.elementId, element.id))
      .get();
    expect(body).toBeTruthy();
    // Answers are inline in the body text; the markers are NOT written there.
    expect(body?.plainText).toBe("Memory moves from the hippocampus to the neocortex.");
    expect(body?.plainText).not.toContain("{{");

    const blocks = handle.db
      .select()
      .from(documentBlocks)
      .where(eq(documentBlocks.documentId, element.id))
      .all();
    expect(blocks.length).toBe(1);
    const blockId = blocks[0]?.stableBlockId;

    // One `cloze` mark per deletion, anchored to the block, carrying its clozeIndex.
    const marks = handle.db
      .select()
      .from(documentMarks)
      .where(eq(documentMarks.documentId, element.id))
      .all();
    const clozeMarks = marks.filter((m) => m.markType === "cloze");
    expect(clozeMarks.length).toBe(2);
    expect(clozeMarks.every((m) => m.blockId === blockId)).toBe(true);
    const indices = clozeMarks
      .map((m) => (m.attrs ? (JSON.parse(m.attrs) as { clozeIndex: number }).clozeIndex : null))
      .sort();
    expect(indices).toEqual([1, 2]);
    // The ranges line up with the answer spans in the body text.
    for (const m of clozeMarks) {
      const [start, end] = JSON.parse(m.range) as [number, number];
      const span = (body?.plainText ?? "").slice(start, end);
      expect(["hippocampus", "neocortex"]).toContain(span);
    }

    // The mark writes are logged under update_document (no new op type).
    const docOps = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, element.id))
      .all()
      .filter((r) => r.opType === "update_document");
    expect(docOps.length).toBeGreaterThanOrEqual(1);
  });

  it("seeds NO card body / cloze marks for a Q&A card", () => {
    const { extractId } = seedExtract(handle);
    const service = new CardService(handle.db);

    const { element } = service.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
    });

    const body = handle.db
      .select()
      .from(documents)
      .where(eq(documents.elementId, element.id))
      .get();
    expect(body).toBeUndefined();
    const marks = handle.db
      .select()
      .from(documentMarks)
      .where(eq(documentMarks.documentId, element.id))
      .all();
    expect(marks.length).toBe(0);
  });

  it("groups two cards from one extract under the same sibling_group id, both first-scheduled due", () => {
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

    // Both cards are first-scheduled due (so they enter the deck) but still
    // fsrsState "new" — the first grade is where the FSRS interval math runs.
    const dueNow = handle.db
      .select()
      .from(reviewStates)
      .where(and(isNotNull(reviewStates.dueAt), lte(reviewStates.dueAt, nowIso())))
      .all();
    expect(dueNow.map((r) => r.elementId).sort()).toEqual([qa.element.id, cloze.element.id].sort());
    expect(dueNow.every((r) => r.fsrsState === "new")).toBe(true);
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

/**
 * Seed a media `source` + a clip `media_fragment` (T074) so the audio-card path (T075)
 * can be exercised end-to-end: the clip's `source_locations.clip` window + media source
 * is exactly what `CardService` DERIVES the audio `media_ref` from.
 */
function seedClipFragment(handle: DbHandle): {
  mediaSourceId: ElementId;
  clipId: ElementId;
} {
  const sources = new SourceRepository(handle.db);
  const { element: source } = sources.createWithDocument({
    title: "A spoken lecture",
    priority: 0.625,
    status: "active",
    stage: "raw_source",
    body: "First cue.\n\nSecond cue.",
  });
  const blockRows = handle.db
    .select()
    .from(documentBlocks)
    .where(eq(documentBlocks.documentId, source.id))
    .all();
  const anchor = blockRows[0]?.stableBlockId as BlockId;
  const extraction = new ExtractionService(handle.db);
  const { element: clip } = extraction.createClipExtract({
    sourceElementId: source.id,
    startMs: 42_000,
    endMs: 75_000,
    anchorBlockId: anchor,
    transcriptSegment: "the spoken phrase under the range",
    priority: 0.625,
  });
  return { mediaSourceId: source.id, clipId: clip.id };
}

describe("CardService.createFromExtract — audio card (T075)", () => {
  it("DERIVES a media_ref from a clip media_fragment (window + media source, default prompt face)", () => {
    const { mediaSourceId, clipId } = seedClipFragment(handle);
    const service = new CardService(handle.db);

    const { element, mediaRef } = service.createFromExtract({
      extractId: clipId,
      kind: "qa",
      // The audio is the prompt; the written answer is the translation.
      prompt: "",
      answer: "the translation",
    });

    // The derived ref points at the MEDIA SOURCE (not the clip fragment), copies the
    // clip window, and defaults the loop to the prompt face.
    expect(mediaRef).toEqual({
      sourceElementId: mediaSourceId,
      startMs: 42_000,
      endMs: 75_000,
      on: "prompt",
    });

    // It is persisted on cards.media_ref (JSON) and round-trips.
    const row = handle.db.select().from(cards).where(eq(cards.elementId, element.id)).get();
    expect(JSON.parse(row?.mediaRef ?? "null")).toEqual({
      sourceElementId: mediaSourceId,
      startMs: 42_000,
      endMs: 75_000,
      on: "prompt",
    });

    // The card is a normal FSRS card (a review_states row exists) — the two-scheduler
    // split holds: the CLIP fragment is attention-scheduled (no review_states), the
    // AUDIO CARD is FSRS-scheduled (has one).
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, element.id)).get(),
    ).toBeTruthy();
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, clipId)).get(),
    ).toBeUndefined();
  });

  it("honors an EXPLICIT media_ref over the derived one (e.g. audio on the answer)", () => {
    const { mediaSourceId, clipId } = seedClipFragment(handle);
    const service = new CardService(handle.db);

    const { element, mediaRef } = service.createFromExtract({
      extractId: clipId,
      kind: "qa",
      prompt: "How is this phrase pronounced?",
      answer: "",
      mediaRef: { sourceElementId: mediaSourceId, startMs: 50_000, endMs: 60_000, on: "answer" },
    });

    expect(mediaRef?.on).toBe("answer");
    expect(mediaRef?.startMs).toBe(50_000);
    const row = handle.db.select().from(cards).where(eq(cards.elementId, element.id)).get();
    expect(JSON.parse(row?.mediaRef ?? "null").on).toBe("answer");
  });

  it("does NOT set a media_ref for a normal text extract", () => {
    const { extractId } = seedExtract(handle);
    const service = new CardService(handle.db);

    const { element, mediaRef } = service.createFromExtract({
      extractId,
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
    });

    expect(mediaRef).toBeNull();
    const row = handle.db.select().from(cards).where(eq(cards.elementId, element.id)).get();
    expect(row?.mediaRef).toBeNull();
  });

  it("inherits the clip's source location so jump-to-source seeks the clip (lineage)", () => {
    const { clipId } = seedClipFragment(handle);
    const sources = new SourceRepository(handle.db);
    const clipLocation = sources.findLocationForElement(clipId);
    const service = new CardService(handle.db);

    const { sourceLocationId } = service.createFromExtract({
      extractId: clipId,
      kind: "qa",
      prompt: "",
      answer: "translation",
    });

    expect(sourceLocationId).toBe(clipLocation?.id);
  });
});

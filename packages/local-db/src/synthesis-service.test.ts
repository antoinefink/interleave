/**
 * SynthesisService tests (T095 — incremental writing / synthesis notes).
 *
 * Against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB, these assert the
 * load-bearing synthesis-note invariants:
 *
 *  - `create` writes the `synthesis_note` element (`create_element`) + an initial
 *    `documents` body (`update_document`) in ONE transaction, stage `synthesis`,
 *    inheriting the default source priority; the note has NO `review_states` row;
 *  - `linkElement` adds a `references` edge note→extract/card (`add_relation`), rejects
 *    a non-extract/non-card target and a self-reference, and is IDEMPOTENT (a duplicate
 *    link appends no op);
 *  - `unlinkElement` removes the edge (`remove_relation`);
 *  - `editBody` logs `update_document` preserving stable block ids;
 *  - `scheduleReturn` reschedules on the ATTENTION scheduler (`reschedule_element`,
 *    status `scheduled`) and writes NO `review_states` row (the two-scheduler split);
 *    a scheduled note appears in the attention DUE read when due;
 *  - soft-delete + restore (undo) work; lineage of the referenced material is intact.
 */

import type { BlockId, ElementId } from "@interleave/core";
import { DEFAULT_PRIORITY, PRIORITY_LABEL_VALUE } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { elements, operationLog, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardService } from "./card-service";
import { ExtractService } from "./extract-service";
import { createRepositories, type Repositories } from "./index";
import { QueueRepository } from "./queue-repository";
import { SourceRepository } from "./source-repository";
import { SynthesisService } from "./synthesis-service";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

let handle: DbHandle;
let repos: Repositories;
let svc: SynthesisService;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  svc = new SynthesisService(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

/** Count `operation_log` rows of a given type for an element. */
function opCount(elementId: string, opType: string): number {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, elementId))
    .all()
    .filter((r) => r.opType === opType).length;
}

function lastOpType(): string | null {
  const row = handle.sqlite
    .prepare("SELECT op_type AS opType FROM operation_log ORDER BY rowid DESC LIMIT 1")
    .get() as { opType: string } | undefined;
  return row?.opType ?? null;
}

/** Seed a source + an extract + a card; returns their ids (reused as link targets). */
function seedMaterial(): { sourceId: ElementId; extractId: ElementId; cardId: ElementId } {
  const sources = new SourceRepository(handle.db);
  const { element: source } = sources.createWithDocument({
    title: "On the Measure of Intelligence",
    priority: PRIORITY_LABEL_VALUE.A,
    status: "active",
    stage: "raw_source",
    body: "The definition paragraph.",
  });
  const { element: extract } = sources.createExtract({
    sourceElementId: source.id,
    title: "Definition extract",
    priority: PRIORITY_LABEL_VALUE.A,
    stage: "atomic_statement",
    selectedText: "The definition paragraph.",
    blockIds: ["blk_def" as BlockId],
    startOffset: 0,
    endOffset: 25,
    label: "Definition · ¶1",
  });
  const { element: card } = new CardService(handle.db).createFromExtract({
    extractId: extract.id,
    kind: "qa",
    prompt: "How does Chollet define intelligence?",
    answer: "Skill-acquisition efficiency.",
  });
  return { sourceId: source.id, extractId: extract.id, cardId: card.id };
}

describe("create", () => {
  it("creates a synthesis_note element + body in one transaction (synthesis stage, default priority)", () => {
    const { element } = svc.create({
      title: "Weaving intelligence definitions",
      bodyJson: { type: "doc", content: [{ type: "paragraph" }] },
      bodyPlainText: "Initial thoughts.",
      blocks: [{ blockType: "paragraph", order: 0, stableBlockId: "blk_syn_0" }],
    });

    const row = handle.db.select().from(elements).where(eq(elements.id, element.id)).get();
    expect(row?.type).toBe("synthesis_note");
    expect(row?.status).toBe("pending");
    expect(row?.stage).toBe("synthesis");
    // Inherits the configured default source priority (C on a fresh DB).
    expect(row?.priority).toBe(DEFAULT_PRIORITY);

    // The correct EXISTING ops — create_element + update_document, no new op type.
    expect(opCount(element.id, "create_element")).toBe(1);
    expect(opCount(element.id, "update_document")).toBe(1);

    // The body persisted with its stable block id (so it can later be searched/extracted).
    const blocks = repos.documents.listBlocks(element.id);
    expect(blocks.map((b) => b.stableBlockId)).toEqual(["blk_syn_0"]);

    // NEVER FSRS — no review_states row.
    const rs = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, element.id))
      .get();
    expect(rs).toBeUndefined();
  });

  it("creates with no body when none is supplied (no update_document op)", () => {
    const { element } = svc.create({ title: "Empty note" });
    expect(opCount(element.id, "create_element")).toBe(1);
    expect(opCount(element.id, "update_document")).toBe(0);
    expect(svc.get(element.id)?.element.title).toBe("Empty note");
  });

  it("rejects an empty title", () => {
    expect(() => svc.create({ title: "   " })).toThrow(/non-empty/);
  });

  it("honors an explicit priority", () => {
    const { element } = svc.create({ title: "High note", priority: PRIORITY_LABEL_VALUE.A });
    expect(svc.get(element.id)?.element.priority).toBe(PRIORITY_LABEL_VALUE.A);
  });
});

describe("linkElement", () => {
  it("adds a references edge note→extract and note→card (add_relation), surfaced as linked material", () => {
    const { extractId, cardId } = seedMaterial();
    const { element } = svc.create({ title: "Note" });

    svc.linkElement(element.id, extractId);
    const after = svc.linkElement(element.id, cardId);

    // Two references edges from the note.
    const edges = repos.elements.listRelationsFrom(element.id);
    expect(edges.filter((e) => e.relationType === "references")).toHaveLength(2);
    expect(opCount(element.id, "add_relation")).toBe(2);

    // The linked panel surfaces both, with their type/title/stage.
    const linkedIds = after.data.linked.map((l) => l.id).sort();
    expect(linkedIds).toEqual([extractId, cardId].sort());
    const extractLink = after.data.linked.find((l) => l.id === extractId);
    expect(extractLink?.type).toBe("extract");
    expect(extractLink?.relationId).toBeTruthy();

    const extract = repos.elements.findById(extractId);
    expect(extract?.status).toBe("done");
    expect(extract?.dueAt).toBeNull();
    expect(extract?.parkedAt).toBeNull();
    expect(extract?.extractFate).toBe("synthesized");
    expect(opCount(extractId, "update_element")).toBe(1);
  });

  it("is idempotent — a duplicate link is a no-op (no second add_relation op)", () => {
    const { extractId } = seedMaterial();
    const { element } = svc.create({ title: "Note" });
    svc.linkElement(element.id, extractId);
    const result = svc.linkElement(element.id, extractId); // duplicate
    expect(opCount(element.id, "add_relation")).toBe(1);
    expect(opCount(extractId, "update_element")).toBe(1);
    expect(result.data.linked).toHaveLength(1);
  });

  it("does not overwrite a direct honorable fate when a synthesis note references the extract", () => {
    const { extractId } = seedMaterial();
    const { element } = svc.create({ title: "Note" });
    new ExtractService(handle.db).setFate(extractId, "reference");

    svc.linkElement(element.id, extractId);
    expect(repos.elements.findById(extractId)?.extractFate).toBe("reference");
    expect(opCount(extractId, "update_element")).toBe(1);

    svc.unlinkElement(element.id, extractId);
    const extract = repos.elements.findById(extractId);
    expect(extract?.status).toBe("done");
    expect(extract?.dueAt).toBeNull();
    expect(extract?.extractFate).toBe("reference");
  });

  it("leaves add_relation as the last operation after synthesized cache updates", () => {
    const { extractId } = seedMaterial();
    const { element } = svc.create({ title: "Note" });

    svc.linkElement(element.id, extractId);

    expect(repos.elements.findById(extractId)?.extractFate).toBe("synthesized");
    expect(lastOpType()).toBe("add_relation");
  });

  it("rejects a non-extract/non-card target (e.g. a source)", () => {
    const { sourceId } = seedMaterial();
    const { element } = svc.create({ title: "Note" });
    expect(() => svc.linkElement(element.id, sourceId)).toThrow(/only extracts\/cards/);
  });

  it("rejects a self-reference", () => {
    const { element } = svc.create({ title: "Note" });
    expect(() => svc.linkElement(element.id, element.id)).toThrow(/cannot reference itself/);
  });

  it("does NOT re-parent the referenced extract/card (lineage stays intact)", () => {
    const { sourceId, extractId } = seedMaterial();
    const { element } = svc.create({ title: "Note" });
    svc.linkElement(element.id, extractId);
    // The extract is still a child of its SOURCE, never of the note.
    const extractRow = handle.db.select().from(elements).where(eq(elements.id, extractId)).get();
    expect(extractRow?.parentId).toBe(sourceId);
    expect(repos.elements.listChildren(element.id).map((c) => c.id)).not.toContain(extractId);
  });
});

describe("unlinkElement", () => {
  it("removes the references edge (remove_relation) and drops it from the panel", () => {
    const { extractId } = seedMaterial();
    const { element } = svc.create({ title: "Note" });
    svc.linkElement(element.id, extractId);
    const result = svc.unlinkElement(element.id, extractId);
    expect(result.data.linked).toHaveLength(0);
    expect(opCount(element.id, "remove_relation")).toBe(1);
    expect(repos.elements.listRelationsFrom(element.id)).toHaveLength(0);
    const extract = repos.elements.findById(extractId);
    expect(extract?.status).toBe("scheduled");
    expect(extract?.dueAt).toBeTruthy();
    expect(extract?.extractFate).toBeNull();
    expect(lastOpType()).toBe("remove_relation");
  });

  it("keeps synthesized fate while another live synthesis note still references the extract", () => {
    const { extractId } = seedMaterial();
    const first = svc.create({ title: "First note" }).element;
    const second = svc.create({ title: "Second note" }).element;
    svc.linkElement(first.id, extractId);
    svc.linkElement(second.id, extractId);

    svc.unlinkElement(first.id, extractId);
    expect(repos.elements.findById(extractId)?.extractFate).toBe("synthesized");

    svc.unlinkElement(second.id, extractId);
    expect(repos.elements.findById(extractId)?.extractFate).toBeNull();
  });

  it("is a no-op when the edge is absent (no remove_relation op)", () => {
    const { extractId } = seedMaterial();
    const { element } = svc.create({ title: "Note" });
    svc.unlinkElement(element.id, extractId);
    expect(opCount(element.id, "remove_relation")).toBe(0);
  });
});

describe("delete", () => {
  it("clears synthesized fate when deleting the last live synthesis note", () => {
    const { extractId } = seedMaterial();
    const { element } = svc.create({ title: "Note" });
    svc.linkElement(element.id, extractId);

    svc.delete(element.id);

    const extract = repos.elements.findById(extractId);
    expect(extract?.status).toBe("scheduled");
    expect(extract?.dueAt).toBeTruthy();
    expect(extract?.extractFate).toBeNull();
  });

  it("preserves a direct fate when deleting a synthesis note that references it", () => {
    const { extractId } = seedMaterial();
    const { element } = svc.create({ title: "Note" });
    new ExtractService(handle.db).setFate(extractId, "done_without_card");
    svc.linkElement(element.id, extractId);

    svc.delete(element.id);

    const extract = repos.elements.findById(extractId);
    expect(extract?.status).toBe("done");
    expect(extract?.dueAt).toBeNull();
    expect(extract?.extractFate).toBe("done_without_card");
  });

  it("undoing a synthesis-note delete restores synthesized cache for referenced extracts", () => {
    const { extractId } = seedMaterial();
    const { element } = svc.create({ title: "Note" });
    svc.linkElement(element.id, extractId);
    svc.delete(element.id);
    expect(repos.elements.findById(extractId)?.extractFate).toBeNull();

    new UndoService(handle.db).undoLast();

    expect(repos.elements.findById(element.id)?.deletedAt).toBeNull();
    expect(repos.elements.findById(extractId)?.extractFate).toBe("synthesized");
  });

  it("clears synthesized cache for deleted extract targets when their last synthesis note is deleted", () => {
    const { extractId } = seedMaterial();
    const { element } = svc.create({ title: "Note" });
    svc.linkElement(element.id, extractId);
    repos.elements.softDelete(extractId);

    svc.delete(element.id);

    const extract = repos.elements.findById(extractId);
    expect(extract?.status).toBe("deleted");
    expect(extract?.deletedAt).toBeTruthy();
    expect(extract?.extractFate).toBeNull();
  });
});

describe("editBody", () => {
  it("upserts the body (update_document) preserving stable block ids", () => {
    const { element } = svc.create({ title: "Note" });
    svc.editBody({
      noteId: element.id,
      prosemirrorJson: { type: "doc", content: [{ type: "paragraph" }] },
      plainText: "A first refined pass.",
      blocks: [{ blockType: "paragraph", order: 0, stableBlockId: "blk_edit_0" }],
    });
    const doc = repos.documents.findById(element.id);
    expect(doc?.plainText).toBe("A first refined pass.");
    expect(repos.documents.listBlocks(element.id).map((b) => b.stableBlockId)).toEqual([
      "blk_edit_0",
    ]);
    expect(opCount(element.id, "update_document")).toBeGreaterThanOrEqual(1);
  });
});

describe("scheduleReturn", () => {
  it("reschedules on the ATTENTION scheduler (reschedule_element, scheduled) and writes NO review_states", () => {
    const { element } = svc.create({ title: "Note" });
    const data = svc.scheduleReturn(element.id, "nextWeek");

    expect(data.element.status).toBe("scheduled");
    expect(data.element.dueAt).toBeTruthy();
    expect(opCount(element.id, "reschedule_element")).toBe(1);

    // THE TWO-SCHEDULER SPLIT: a synthesis note NEVER gets a review_states row.
    const rs = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, element.id))
      .get();
    expect(rs).toBeUndefined();
  });

  it("a scheduled synthesis note appears in the attention DUE read when due", () => {
    const { element } = svc.create({ title: "Note" });
    // Schedule to a manual past date so it reads as due against a future asOf.
    svc.scheduleReturn(element.id, { manual: "2026-01-01T00:00:00.000Z" });
    const due = new QueueRepository(handle.db).dueAttentionItems("2030-01-01T00:00:00.000Z");
    expect(due.map((e) => e.id)).toContain(element.id);
    // And it is NOT in the FSRS due-card read (it is not a card).
    const dueCards = new QueueRepository(handle.db).dueCards("2030-01-01T00:00:00.000Z");
    expect(dueCards.map((e) => e.id)).not.toContain(element.id);
  });
});

describe("delete + restore", () => {
  it("soft-deletes (soft_delete_element) and restores (restore_element) — undo works", () => {
    const { element } = svc.create({ title: "Note" });
    svc.delete(element.id);
    expect(svc.get(element.id)).toBeNull();
    expect(opCount(element.id, "soft_delete_element")).toBe(1);

    repos.elements.restore(element.id, "pending");
    expect(svc.get(element.id)?.element.status).toBe("pending");
  });
});

describe("get", () => {
  it("returns null for a non-synthesis element / unknown id", () => {
    const { cardId } = seedMaterial();
    expect(svc.get(cardId)).toBeNull();
    expect(svc.get("nope" as ElementId)).toBeNull();
  });
});

/**
 * AiSuggestionRepository tests (T093/T094).
 *
 * Run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB so behaviour
 * matches production. They assert the load-bearing AI-draft invariants:
 *
 *  - create / list / status / soft-dismiss round-trip the draft rows;
 *  - the GROUNDING columns round-trip, and the model output (`suggestion_text`) is
 *    stored SEPARATELY from the verbatim source quote (`selected_text`);
 *  - a suggestion row appends NO `operation_log` entry (transient draft/infra);
 *  - the DRAFT-ONLY `CardService.createDraftFromSuggestion` seam mints a PARKED, un-due
 *    `card_draft` (`review_states.dueAt = null`, element stays `card_draft`, NOT
 *    `active_card`, NOT in the due deck) and DOES append `create_element` + `create_card`;
 *  - `groundingFor` resolves a `SourceRef` (right sourceElementId/label/snippet), and
 *    degrades to `EMPTY_SOURCE_REF`-ish when the source is gone (the orphan case).
 */

import type { BlockId, ElementId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, operationLog, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardService } from "./card-service";
import { createRepositories, type Repositories } from "./index";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;

/** Seed a source with a body + an extract anchored at its first block; return ids. */
function seedSourceAndExtract(): {
  sourceId: ElementId;
  extractId: ElementId;
  blockId: BlockId;
} {
  const sources = new SourceRepository(handle.db);
  const { element: source } = sources.createWithDocument({
    title: "On the Measure of Intelligence",
    priority: 0.875,
    status: "active",
    stage: "raw_source",
    body: "The definition paragraph.\n\nAnother paragraph.",
  });
  const blocks = repos.documents.listBlocks(source.id);
  const firstBlock = blocks[0]?.stableBlockId as BlockId;
  const { element: extract } = sources.createExtract({
    sourceElementId: source.id,
    title: "Definition extract",
    priority: 0.875,
    stage: "atomic_statement",
    selectedText: "The definition paragraph.",
    blockIds: [firstBlock],
    startOffset: 0,
    endOffset: 25,
    label: "¶1",
  });
  return { sourceId: source.id, extractId: extract.id, blockId: firstBlock };
}

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

describe("AiSuggestionRepository — CRUD + grounding round-trip", () => {
  it("creates, lists, and reads back a draft with grounding stored separately from output", () => {
    const { sourceId, extractId, blockId } = seedSourceAndExtract();
    const created = repos.aiSuggestions.create({
      owningElementId: extractId,
      action: "suggest_qa",
      kind: "card_qa",
      providerKind: "anthropic",
      suggestionText: "MODEL: a Q&A about the definition",
      cards: [{ kind: "qa", prompt: "What is the definition?", answer: "Skill efficiency." }],
      grounding: {
        sourceElementId: sourceId,
        blockIds: [blockId],
        startOffset: 0,
        endOffset: 25,
        selectedText: "The definition paragraph.",
      },
    });

    expect(created.status).toBe("draft");
    // The model output and the source quote are DISTINCT — separate columns.
    expect(created.suggestionText).toBe("MODEL: a Q&A about the definition");
    expect(created.grounding.selectedText).toBe("The definition paragraph.");
    expect(created.suggestionText).not.toBe(created.grounding.selectedText);
    // The grounding columns round-trip.
    expect(created.grounding.sourceElementId).toBe(sourceId);
    expect(created.grounding.blockIds).toEqual([blockId]);
    expect(created.grounding.startOffset).toBe(0);
    expect(created.grounding.endOffset).toBe(25);
    expect(created.cards).toEqual([
      { kind: "qa", prompt: "What is the definition?", answer: "Skill efficiency." },
    ]);

    const listed = repos.aiSuggestions.listForElement(extractId);
    expect(listed.map((s) => s.id)).toEqual([created.id]);
  });

  it("sets distinct selected_text and suggestion_text and reads them back independently (T094)", () => {
    const { sourceId, extractId, blockId } = seedSourceAndExtract();
    const created = repos.aiSuggestions.create({
      owningElementId: extractId,
      action: "explain",
      kind: "text",
      providerKind: "openai",
      suggestionText: "THE MODEL EXPLANATION",
      grounding: {
        sourceElementId: sourceId,
        blockIds: [blockId],
        startOffset: null,
        endOffset: null,
        selectedText: "THE VERBATIM SOURCE QUOTE",
      },
    });
    const read = repos.aiSuggestions.findById(created.id);
    expect(read?.suggestionText).toBe("THE MODEL EXPLANATION");
    expect(read?.grounding.selectedText).toBe("THE VERBATIM SOURCE QUOTE");
  });

  it("dismisses a draft (soft) so it leaves the live drafts list but the row persists", () => {
    const { sourceId, extractId, blockId } = seedSourceAndExtract();
    const created = repos.aiSuggestions.create({
      owningElementId: extractId,
      action: "summarize",
      kind: "text",
      providerKind: "anthropic",
      suggestionText: "summary",
      grounding: {
        sourceElementId: sourceId,
        blockIds: [blockId],
        startOffset: null,
        endOffset: null,
        selectedText: "quote",
      },
    });
    expect(repos.aiSuggestions.softDismiss(created.id)).toEqual({ dismissed: true });
    expect(repos.aiSuggestions.listForElement(extractId)).toEqual([]);
    // The row still exists (soft) — readable with includeAll.
    expect(repos.aiSuggestions.findById(created.id)?.status).toBe("dismissed");
    expect(repos.aiSuggestions.listForElement(extractId, { includeAll: true }).length).toBe(1);
  });

  it("lists live drafts for multiple elements in one grouped read", () => {
    const first = seedSourceAndExtract();
    const second = seedSourceAndExtract();
    const firstDraft = repos.aiSuggestions.create({
      owningElementId: first.extractId,
      action: "suggest_qa",
      kind: "card_qa",
      providerKind: "anthropic",
      suggestionText: "first live",
      cards: [{ kind: "qa", prompt: "Q1?", answer: "A1." }],
      grounding: {
        sourceElementId: first.sourceId,
        blockIds: [first.blockId],
        startOffset: null,
        endOffset: null,
        selectedText: "quote 1",
      },
    });
    const dismissed = repos.aiSuggestions.create({
      owningElementId: first.extractId,
      action: "suggest_cloze",
      kind: "card_cloze",
      providerKind: "anthropic",
      suggestionText: "dismissed",
      cards: [{ kind: "cloze", cloze: "{{c1::dismissed}}" }],
      grounding: {
        sourceElementId: first.sourceId,
        blockIds: [first.blockId],
        startOffset: null,
        endOffset: null,
        selectedText: "quote 1",
      },
    });
    const secondDraft = repos.aiSuggestions.create({
      owningElementId: second.extractId,
      action: "suggest_qa",
      kind: "card_qa",
      providerKind: "openai",
      suggestionText: "second live",
      cards: [{ kind: "qa", prompt: "Q2?", answer: "A2." }],
      grounding: {
        sourceElementId: second.sourceId,
        blockIds: [second.blockId],
        startOffset: null,
        endOffset: null,
        selectedText: "quote 2",
      },
    });
    repos.aiSuggestions.softDismiss(dismissed.id);

    const grouped = repos.aiSuggestions.listLiveForElements([first.extractId, second.extractId]);

    expect(grouped.get(first.extractId)?.map((s) => s.id)).toEqual([firstDraft.id]);
    expect(grouped.get(second.extractId)?.map((s) => s.id)).toEqual([secondDraft.id]);
    expect([...grouped.values()].flat().map((s) => s.id)).not.toContain(dismissed.id);
    expect(repos.aiSuggestions.listLiveForElements([]).size).toBe(0);
  });

  it("appends NO operation_log entry for a suggestion row (transient draft/infra)", () => {
    const { sourceId, extractId, blockId } = seedSourceAndExtract();
    const opsBefore = handle.db.select().from(operationLog).all().length;
    repos.aiSuggestions.create({
      owningElementId: extractId,
      action: "suggest_qa",
      kind: "card_qa",
      providerKind: "anthropic",
      suggestionText: "x",
      cards: [{ kind: "qa", prompt: "Q?", answer: "A." }],
      grounding: {
        sourceElementId: sourceId,
        blockIds: [blockId],
        startOffset: null,
        endOffset: null,
        selectedText: "quote",
      },
    });
    const opsAfter = handle.db.select().from(operationLog).all().length;
    expect(opsAfter).toBe(opsBefore);
  });
});

describe("groundingFor (T094)", () => {
  it("resolves a SourceRef with the right source element + label + verbatim snippet", () => {
    const { sourceId, extractId, blockId } = seedSourceAndExtract();
    const created = repos.aiSuggestions.create({
      owningElementId: extractId,
      action: "explain",
      kind: "text",
      providerKind: "openai",
      suggestionText: "explanation",
      grounding: {
        sourceElementId: sourceId,
        blockIds: [blockId],
        startOffset: 0,
        endOffset: 25,
        selectedText: "The definition paragraph.",
      },
    });
    const ref = repos.aiSuggestions.groundingFor(repos, created.id);
    expect(ref.sourceElementId).toBe(sourceId);
    expect(ref.sourceTitle).toBe("On the Measure of Intelligence");
    expect(ref.snippet).toBe("The definition paragraph.");
    expect(ref.locationLabel).toBe("¶1");
  });

  it("degrades to a calm orphan ref when the source is soft-deleted", () => {
    const { sourceId, extractId, blockId } = seedSourceAndExtract();
    const created = repos.aiSuggestions.create({
      owningElementId: extractId,
      action: "explain",
      kind: "text",
      providerKind: "openai",
      suggestionText: "explanation",
      grounding: {
        sourceElementId: sourceId,
        blockIds: [blockId],
        startOffset: null,
        endOffset: null,
        selectedText: "orphan quote",
      },
    });
    // Soft-delete the source so `resolveSourceRef` returns null (the orphan case).
    repos.elements.softDelete(sourceId);
    const ref = repos.aiSuggestions.groundingFor(repos, created.id);
    expect(ref.sourceElementId).toBeNull();
    // The verbatim quote is preserved so the user still sees what the model commented on.
    expect(ref.snippet).toBe("orphan quote");
  });
});

describe("groundingLocationFor (T094 — drafts-panel jump-to-source target)", () => {
  it("resolves a jump location with the span's source element + block ids + offsets + label", () => {
    const { sourceId, extractId, blockId } = seedSourceAndExtract();
    const created = repos.aiSuggestions.create({
      owningElementId: extractId,
      action: "suggest_qa",
      kind: "card_qa",
      providerKind: "anthropic",
      suggestionText: "a Q&A",
      grounding: {
        sourceElementId: sourceId,
        blockIds: [blockId],
        startOffset: 0,
        endOffset: 25,
        selectedText: "The definition paragraph.",
      },
    });
    const loc = repos.aiSuggestions.groundingLocationFor(repos, created.id);
    expect(loc).not.toBeNull();
    // The jump lands on the ORIGINATING block of the source the model commented on.
    expect(loc?.sourceElementId).toBe(sourceId);
    expect(loc?.blockIds).toEqual([blockId]);
    expect(loc?.startOffset).toBe(0);
    expect(loc?.endOffset).toBe(25);
    expect(loc?.selectedText).toBe("The definition paragraph.");
    expect(loc?.label).toBe("¶1");
  });

  it("returns null (no jump affordance) when the grounding source is soft-deleted", () => {
    const { sourceId, extractId, blockId } = seedSourceAndExtract();
    const created = repos.aiSuggestions.create({
      owningElementId: extractId,
      action: "explain",
      kind: "text",
      providerKind: "openai",
      suggestionText: "explanation",
      grounding: {
        sourceElementId: sourceId,
        blockIds: [blockId],
        startOffset: null,
        endOffset: null,
        selectedText: "orphan quote",
      },
    });
    repos.elements.softDelete(sourceId);
    // No live reader to jump into → no jump target (the refblock degrades on its own).
    expect(repos.aiSuggestions.groundingLocationFor(repos, created.id)).toBeNull();
  });
});

describe("CardService.createDraftFromSuggestion — the draft-only approve seam", () => {
  it("mints a PARKED, un-due card_draft (NOT active, dueAt null) with create_element + create_card", () => {
    const { sourceId, extractId, blockId } = seedSourceAndExtract();
    const card = new CardService(handle.db);

    const opsBefore = handle.db.select().from(operationLog).all();
    const result = card.createDraftFromSuggestion({
      owningElementId: extractId,
      kind: "qa",
      prompt: "What is the definition?",
      answer: "Skill-acquisition efficiency.",
      grounding: {
        sourceElementId: sourceId,
        blockIds: [blockId],
        startOffset: 0,
        endOffset: 25,
        selectedText: "The definition paragraph.",
        label: "¶1",
      },
    });

    // The element is a PARKED card_draft — NOT activated.
    const el = handle.db.select().from(elements).where(eq(elements.id, result.element.id)).get();
    expect(el?.type).toBe("card");
    expect(el?.stage).toBe("card_draft");
    expect(el?.stage).not.toBe("active_card");
    expect(el?.status).toBe("pending");
    expect(el?.dueAt).toBeNull();

    // The review_states row EXISTS (every card path writes one) but is un-due (dueAt null).
    const rs = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, result.element.id))
      .get();
    expect(rs).toBeTruthy();
    expect(rs?.dueAt).toBeNull();
    expect(rs?.fsrsState).toBe("new");

    // The card's source_location anchor was written + linked (grounding inherited).
    const cardRow = handle.db
      .select()
      .from(cards)
      .where(eq(cards.elementId, result.element.id))
      .get();
    expect(cardRow?.sourceLocationId).toBe(result.sourceLocationId);
    expect(result.sourceLocationId).toBeTruthy();

    // The op-log GREW by the existing create_element + create_card (+ derived_from add_relation).
    const opsAfter = handle.db.select().from(operationLog).all();
    const newOps = opsAfter.slice(opsBefore.length).map((o) => o.opType);
    expect(newOps).toContain("create_element");
    expect(newOps).toContain("create_card");
    expect(newOps).toContain("add_relation");
  });
});

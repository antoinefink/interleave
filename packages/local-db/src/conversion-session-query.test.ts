import type { BlockId, ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { operationLog } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardService } from "./card-service";
import {
  ConversionSessionQuery,
  createRepositories,
  DEFAULT_CONVERSION_SESSION_LIMIT,
  MAX_CONVERSION_SESSION_LIMIT,
  type Repositories,
} from "./index";
import { QueueQuery } from "./queue-query";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

const AS_OF = "2026-06-13T10:00:00.000Z" as IsoTimestamp;
const DUE = "2026-06-12T10:00:00.000Z" as IsoTimestamp;
const FUTURE = "2026-06-14T10:00:00.000Z" as IsoTimestamp;

let handle: DbHandle;
let repos: Repositories;
let sources: SourceRepository;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  sources = new SourceRepository(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

function seedSource(title = "Source"): { sourceId: ElementId; blockId: BlockId } {
  const { element } = sources.createWithDocument({
    title,
    priority: 0.7,
    status: "active",
    stage: "raw_source",
    body: `${title} first paragraph.\n\n${title} second paragraph.`,
  });
  const blockId = repos.documents.listBlocks(element.id)[0]?.stableBlockId as BlockId;
  return { sourceId: element.id, blockId };
}

function seedAtomicStatement(options: {
  readonly title: string;
  readonly priority?: number;
  readonly dueAt?: IsoTimestamp;
  readonly stage?: "raw_extract" | "clean_extract" | "atomic_statement";
  readonly selectedText?: string;
  readonly blockIds?: readonly BlockId[];
  readonly sourceId?: ElementId;
  readonly blockId?: BlockId;
  readonly plainText?: string;
}): ElementId {
  const source =
    options.sourceId && options.blockId
      ? { sourceId: options.sourceId, blockId: options.blockId }
      : seedSource(`${options.title} source`);
  const { element } = sources.createExtract({
    sourceElementId: source.sourceId,
    title: options.title,
    priority: options.priority ?? 0.7,
    stage: options.stage ?? "atomic_statement",
    selectedText: options.selectedText ?? `${options.title} selected text.`,
    blockIds: options.blockIds ?? [source.blockId],
    startOffset: 0,
    endOffset: 20,
    label: "¶1",
  });
  repos.elements.update(element.id, {
    status: "active",
    dueAt: options.dueAt ?? DUE,
  });
  if (options.plainText) {
    repos.documents.upsert({
      elementId: element.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: options.plainText,
      blocks: [],
    });
  }
  return element.id;
}

describe("ConversionSessionQuery.preview", () => {
  it("returns due atomic statements in queue score order with source refs, grounding, excerpts, scheduler signals, and live drafts", () => {
    const sourceA = seedSource("A source");
    const sourceB = seedSource("B source");
    const first = seedAtomicStatement({
      title: "First atom",
      sourceId: sourceA.sourceId,
      blockId: sourceA.blockId,
      priority: 0.95,
      plainText: "First atom detailed body for the card builder.",
    });
    const second = seedAtomicStatement({
      title: "Second atom",
      sourceId: sourceB.sourceId,
      blockId: sourceB.blockId,
      priority: 0.4,
      plainText: "Second atom detailed body for the card builder.",
    });
    const liveDraft = repos.aiSuggestions.create({
      owningElementId: first,
      action: "suggest_qa",
      kind: "card_qa",
      providerKind: "openai",
      suggestionText: "Draft Q&A text",
      cards: [{ kind: "qa", prompt: "What is first?", answer: "The first atom." }],
      grounding: {
        sourceElementId: sourceA.sourceId,
        blockIds: [sourceA.blockId],
        startOffset: 0,
        endOffset: 20,
        selectedText: "First atom selected text.",
      },
    });
    const dismissed = repos.aiSuggestions.create({
      owningElementId: first,
      action: "suggest_cloze",
      kind: "card_cloze",
      providerKind: "openai",
      suggestionText: "Dismissed cloze",
      cards: [{ kind: "cloze", cloze: "Dismissed {{c1::cloze}}" }],
      grounding: {
        sourceElementId: sourceA.sourceId,
        blockIds: [sourceA.blockId],
        startOffset: 0,
        endOffset: 20,
        selectedText: "First atom selected text.",
      },
    });
    repos.aiSuggestions.softDismiss(dismissed.id);

    const preview = new ConversionSessionQuery(handle.db, repos).preview({ asOf: AS_OF });
    const queueOrder = new QueueQuery(repos)
      .sessionPlanCandidates({ asOf: AS_OF, filters: { types: ["extract"] } })
      .items.filter((item) => item.id === first || item.id === second)
      .map((item) => item.id);

    expect(preview.items.map((item) => item.id)).toEqual(queueOrder);
    const firstItem = preview.items.find((item) => item.id === first);
    expect(firstItem).toMatchObject({
      title: "First atom",
      plainText: "First atom detailed body for the card builder.",
      excerpt: "First atom detailed body for the card builder.",
      sourceRef: {
        sourceElementId: sourceA.sourceId,
        sourceTitle: "A source",
        locationLabel: "¶1",
      },
      aiGrounding: {
        sourceElementId: sourceA.sourceId,
        blockIds: [sourceA.blockId],
        selectedText: "First atom selected text.",
      },
      schedulerSignals: {
        kind: "attention",
        stage: "atomic_statement",
      },
    });
    expect(firstItem?.drafts).toEqual([
      {
        id: liveDraft.id,
        action: "suggest_qa",
        kind: "card_qa",
        providerKind: "openai",
        suggestionText: "Draft Q&A text",
        cards: [{ kind: "qa", prompt: "What is first?", answer: "The first atom." }],
        createdAt: liveDraft.createdAt,
      },
    ]);
  });

  it("excludes ineligible extracts and exposes skip reasons for candidates it sees", () => {
    const eligible = seedAtomicStatement({ title: "Eligible" });
    const raw = seedAtomicStatement({ title: "Raw", stage: "raw_extract" });
    const clean = seedAtomicStatement({ title: "Clean", stage: "clean_extract" });
    const terminal = seedAtomicStatement({ title: "Reference fate" });
    repos.elements.update(terminal, { extractFate: "reference" });
    const carded = seedAtomicStatement({ title: "Already carded" });
    new CardService(handle.db).createFromExtract({
      extractId: carded,
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
      asOf: AS_OF,
    });
    const emptyText = seedAtomicStatement({ title: "Empty text", selectedText: "   " });
    const noBlocks = seedAtomicStatement({ title: "No blocks", blockIds: [] });
    const synthesized = seedAtomicStatement({ title: "Synthesized" });
    const note = repos.synthesis.create({ title: "Synthesis note" }).element;
    repos.elements.addRelation({
      fromElementId: note.id,
      toElementId: synthesized,
      relationType: "references",
    });
    const future = seedAtomicStatement({ title: "Future", dueAt: FUTURE });
    const deleted = seedAtomicStatement({ title: "Deleted" });
    repos.elements.softDelete(deleted);
    const sourceless = repos.elements.create({
      type: "extract",
      status: "active",
      stage: "atomic_statement",
      priority: 0.7,
      title: "Sourceless",
      dueAt: DUE,
      parentId: null,
      sourceId: null,
    }).id;

    const preview = new ConversionSessionQuery(handle.db, repos).preview({ asOf: AS_OF });

    expect(preview.items.map((item) => item.id)).toEqual([eligible]);
    expect(preview.items.map((item) => item.id)).not.toContain(future);
    expect(preview.items.map((item) => item.id)).not.toContain(deleted);
    expect(Object.fromEntries(preview.skipped.map((skip) => [skip.id, skip.reason]))).toEqual(
      expect.objectContaining({
        [raw]: "not_atomic_statement",
        [clean]: "not_atomic_statement",
        [terminal]: "terminal_fate",
        [carded]: "already_carded",
        [emptyText]: "empty_selected_text",
        [noBlocks]: "missing_source_blocks",
        [synthesized]: "synthesis_reference",
        [sourceless]: "sourceless",
      }),
    );
  });

  it("defaults to 25 candidates and caps requested limits at 100 before draft decoration", () => {
    for (let i = 0; i < MAX_CONVERSION_SESSION_LIMIT + 5; i++) {
      seedAtomicStatement({ title: `Atom ${i}`, priority: 0.5 + i / 1000 });
    }
    const query = new ConversionSessionQuery(handle.db, repos);
    const draftBatch = vi.spyOn(repos.aiSuggestions, "listLiveForElements");

    const defaultPreview = query.preview({ asOf: AS_OF });
    expect(defaultPreview.limit).toBe(DEFAULT_CONVERSION_SESSION_LIMIT);
    expect(defaultPreview.items).toHaveLength(DEFAULT_CONVERSION_SESSION_LIMIT);
    expect(draftBatch.mock.calls[0]?.[0]).toHaveLength(DEFAULT_CONVERSION_SESSION_LIMIT);

    const cappedPreview = query.preview({ asOf: AS_OF, limit: 500 });
    expect(cappedPreview.limit).toBe(MAX_CONVERSION_SESSION_LIMIT);
    expect(cappedPreview.items).toHaveLength(MAX_CONVERSION_SESSION_LIMIT);
    expect(draftBatch.mock.calls[1]?.[0]).toHaveLength(MAX_CONVERSION_SESSION_LIMIT);
  });

  it("bounds the due extract scan while preserving the true candidate count", () => {
    for (let i = 0; i < 120; i++) {
      seedAtomicStatement({ title: `Bounded atom ${i}`, priority: 0.5 + i / 1000 });
    }
    const dueAttentionItems = vi.spyOn(repos.queue, "dueAttentionItems");

    const preview = new ConversionSessionQuery(handle.db, repos).preview({
      asOf: AS_OF,
      limit: 5,
    });

    expect(preview.items).toHaveLength(5);
    expect(preview.candidateCount).toBe(120);
    expect(dueAttentionItems).toHaveBeenCalledWith(AS_OF, 100, { types: ["extract"] });
  });

  it("expands the bounded scan when ineligible extracts hide eligible atoms", () => {
    for (let i = 0; i < 101; i++) {
      seedAtomicStatement({ title: `Raw backlog ${i}`, stage: "raw_extract" });
    }
    const eligible = seedAtomicStatement({ title: "Eligible after raw backlog" });
    const dueAttentionItems = vi.spyOn(repos.queue, "dueAttentionItems");

    const preview = new ConversionSessionQuery(handle.db, repos).preview({
      asOf: AS_OF,
      limit: 5,
    });

    expect(preview.items.map((item) => item.id)).toContain(eligible);
    expect(dueAttentionItems).toHaveBeenNthCalledWith(1, AS_OF, 100, { types: ["extract"] });
    expect(dueAttentionItems).toHaveBeenLastCalledWith(AS_OF, 102, { types: ["extract"] });
  });

  it("uses the batched AI draft helper instead of per-row draft reads", () => {
    seedAtomicStatement({ title: "One" });
    seedAtomicStatement({ title: "Two" });
    const batch = vi.spyOn(repos.aiSuggestions, "listLiveForElements");
    const single = vi.spyOn(repos.aiSuggestions, "listForElement");

    new ConversionSessionQuery(handle.db, repos).preview({ asOf: AS_OF });

    expect(batch).toHaveBeenCalledTimes(1);
    expect(single).not.toHaveBeenCalled();
  });

  it("revalidates frozen ids in snapshot order and reports no-longer-due ids", () => {
    const first = seedAtomicStatement({ title: "First frozen", priority: 0.2 });
    const second = seedAtomicStatement({ title: "Second frozen", priority: 0.9 });
    const draft = repos.aiSuggestions.create({
      owningElementId: second,
      action: "suggest_qa",
      kind: "card_qa",
      providerKind: "openai",
      suggestionText: "Frozen draft",
      cards: [{ kind: "qa", prompt: "Q?", answer: "A." }],
      grounding: {
        sourceElementId: repos.elements.findById(second)?.sourceId ?? second,
        blockIds: [],
        startOffset: null,
        endOffset: null,
        selectedText: "Frozen draft source.",
      },
    });
    repos.elements.update(first, { dueAt: FUTURE });

    const preview = new ConversionSessionQuery(handle.db, repos).previewByIds([second, first], {
      asOf: AS_OF,
    });

    expect(preview.items.map((item) => item.id)).toEqual([second]);
    expect(preview.items[0]?.drafts.map((item) => item.id)).toEqual([draft.id]);
    expect(preview.skipped).toEqual([{ id: first, reason: "not_due" }]);
  });

  it("is read-only and appends no operation_log rows", () => {
    seedAtomicStatement({ title: "Read only" });
    const opsBefore = handle.db.select().from(operationLog).all().length;

    new ConversionSessionQuery(handle.db, repos).preview({ asOf: AS_OF });

    expect(handle.db.select().from(operationLog).all()).toHaveLength(opsBefore);
  });
});

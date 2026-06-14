/**
 * T124 U4/U5 — ReverifyResolutionService.
 *
 * Drives the per-source re-verify drain orchestrator: a read-only, capped, fingerprinted
 * `sessionPreview` (ZERO op-log rows); transactional `resolve` of confirm/detach (U4) and
 * rebase (U5) with in-tx fingerprint revalidation + per-item skip reasons; a settings-
 * persisted receipt keyed by local day + batchId; and receipt-scoped (and per-item)
 * `undoReceipt` with the four-part current-state guard. Rebase coverage proves the
 * main-side body re-derivation (fail-closed), the immutable anchor, the conditional
 * (last-anchor) block reconcile + sibling protection, and symmetric undo of the body +
 * block-state preimages. The seed mirrors the U2 repository test — a real source → extract
 * → card lineage, staled through the production
 * `BlockProcessingService.reconcileSourceDocumentWithin` so provenance is exactly as
 * production writes it.
 */

import type { BlockId, ElementId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import {
  documents,
  elementDetachSnapshot,
  elementReverifyProvenance,
  elements,
  operationLog,
  reviewStates,
  settings,
  sourceBlockProcessing,
  sourceLocations,
} from "@interleave/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { CardService } from "./card-service";
import { DocumentRepository } from "./document-repository";
import { ExtractionService } from "./extraction-service";
import { createRepositories, type Repositories } from "./index";
import { ReverifyPropagationRepository } from "./reverify-propagation-repository";
import {
  REVERIFY_RESOLUTION_STATE_KEY,
  type ReverifyDecision,
  ReverifyResolutionService,
} from "./reverify-resolution-service";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

interface Lineage {
  readonly sourceId: ElementId;
  readonly extractId: ElementId;
  readonly cardId: ElementId;
  readonly blocks: BlockId[];
  readonly extractedBlock: BlockId;
}

/** Seed source → extract (anchored to block[1]) → card (parentId = extract). */
function seedLineage(): Lineage {
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

  return { sourceId, extractId: extract.id, cardId: card.id, blocks, extractedBlock };
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

/** A deep-cloned copy of the document with one block's text replaced. */
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

function saveSourceDoc(sourceId: ElementId, doc: unknown): void {
  const service = new BlockProcessingService(handle.db);
  handle.db.transaction((tx) => {
    new DocumentRepository(handle.db).upsertWithin(tx, {
      elementId: sourceId,
      prosemirrorJson: doc,
      plainText: "",
    });
    service.reconcileSourceDocumentWithin(tx, sourceId, doc);
  });
}

/** Stale `extractedBlock` so the extract + card are flagged with provenance. */
function staleLineage(lineage: Lineage): void {
  saveSourceDoc(
    lineage.sourceId,
    editBlockText(storedDoc(lineage.sourceId), lineage.extractedBlock, "Heavily rewritten."),
  );
}

function needsReverify(id: ElementId): boolean {
  const row = handle.db
    .select({ needsReverify: elements.needsReverify })
    .from(elements)
    .where(eq(elements.id, id))
    .get();
  return row?.needsReverify === true;
}

function provenanceCount(elementId: ElementId): number {
  return handle.db
    .select()
    .from(elementReverifyProvenance)
    .where(eq(elementReverifyProvenance.elementId, elementId))
    .all().length;
}

function opLogCount(): number {
  return handle.db.select().from(operationLog).all().length;
}

function cardReviewDueAt(cardId: ElementId): string | null {
  return (
    handle.db
      .select({ dueAt: reviewStates.dueAt })
      .from(reviewStates)
      .where(eq(reviewStates.elementId, cardId))
      .get()?.dueAt ?? null
  );
}

/** The flattened plain text of an element's stored body document. */
function bodyPlainText(elementId: ElementId): string {
  return (
    handle.db
      .select({ plainText: documents.plainText })
      .from(documents)
      .where(eq(documents.elementId, elementId))
      .get()?.plainText ?? ""
  );
}

/** The stored ProseMirror body JSON of an element. */
function bodyJson(elementId: ElementId): unknown {
  const row = handle.db
    .select({ json: documents.prosemirrorJson })
    .from(documents)
    .where(eq(documents.elementId, elementId))
    .get();
  return row ? JSON.parse(row.json) : null;
}

/** The `source_block_processing` row for one (source, block), or null. */
function blockProcessingRow(
  sourceId: ElementId,
  blockId: BlockId,
): { state: string; preStaleHash: string | null; blockContentHash: string | null } | null {
  const row = handle.db
    .select({
      state: sourceBlockProcessing.state,
      preStaleHash: sourceBlockProcessing.preStaleHash,
      blockContentHash: sourceBlockProcessing.blockContentHash,
    })
    .from(sourceBlockProcessing)
    .where(
      and(
        eq(sourceBlockProcessing.sourceElementId, sourceId),
        eq(sourceBlockProcessing.stableBlockId, blockId),
      ),
    )
    .get();
  return row ?? null;
}

function service(): ReverifyResolutionService {
  return new ReverifyResolutionService(handle.db, repos);
}

/** Build a confirm/detach decision from a hydrated preview item. */
function decisionFor(
  item: { elementId: ElementId; stableBlockId: BlockId; fingerprint: string },
  verb: ReverifyDecision["verb"],
): ReverifyDecision {
  return {
    elementId: item.elementId,
    stableBlockId: item.stableBlockId,
    verb,
    fingerprint: item.fingerprint,
  };
}

describe("ReverifyResolutionService — sessionPreview", () => {
  it("groups flagged outputs by source, hydrates old + current text, appends ZERO op-log rows", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const before = opLogCount();

    const preview = service().sessionPreview({ sourceElementId: lineage.sourceId });

    expect(preview.sourceElementId).toBe(lineage.sourceId);
    // The extract + the card are both flagged against the one edited block.
    expect(preview.items.map((i) => i.elementId).sort()).toEqual(
      [lineage.extractId, lineage.cardId].sort(),
    );
    const extractItem = preview.items.find((i) => i.elementId === lineage.extractId);
    expect(extractItem?.stableBlockId).toBe(lineage.extractedBlock);
    expect(extractItem?.oldAnchorText).toBe("Second paragraph.");
    expect(extractItem?.currentBlockText).toBe("Heavily rewritten.");
    expect(extractItem?.fingerprint).toBeTruthy();
    expect(preview.remaining).toBe(0);
    // Read-only: not a single op-log row was written.
    expect(opLogCount()).toBe(before);
  });

  it("respects the cap and reports `remaining` when the flagged set exceeds it", () => {
    const lineage = seedLineage();
    staleLineage(lineage); // 2 flagged tuples (extract + card)

    const preview = service().sessionPreview({ sourceElementId: lineage.sourceId, cap: 1 });
    expect(preview.cap).toBe(1);
    expect(preview.items).toHaveLength(1);
    expect(preview.remaining).toBe(1);
  });

  it("tolerates a missing/deleted source id with a stable empty payload (no throw)", () => {
    const preview = service().sessionPreview({ sourceElementId: "missing" as ElementId });
    expect(preview.items).toHaveLength(0);
    expect(preview.remaining).toBe(0);
  });
});

describe("ReverifyResolutionService — resolve (confirm / detach)", () => {
  it("confirm clears the flags, writes one receipt with the right counts and one batchId", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });

    const result = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: preview.items.map((item) => decisionFor(item, "confirm")),
    });

    expect(result.applied).toBe(2);
    expect(result.skipped).toHaveLength(0);
    expect(needsReverify(lineage.extractId)).toBe(false);
    expect(needsReverify(lineage.cardId)).toBe(false);
    expect(provenanceCount(lineage.extractId)).toBe(0);

    expect(result.receipt?.batchId).toBe(result.batchId);
    expect(result.receipt?.counts).toEqual({ confirmed: 2, rebased: 0, detached: 0, skipped: 0 });
    expect(result.receipt?.items).toHaveLength(2);
    expect(result.receipt?.status).toBe("actionable");
  });

  it("fingerprint drift — a block re-edited after preview is skipped; the rest still applies", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });

    // Re-edit the SAME block after the preview was captured (a fresh reconcile run keeps
    // provenance present but bumps the current block content + the element's updatedAt).
    saveSourceDoc(
      lineage.sourceId,
      editBlockText(storedDoc(lineage.sourceId), lineage.extractedBlock, "Re-edited again."),
    );

    const result = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: preview.items.map((item) => decisionFor(item, "confirm")),
    });

    // Every item drifted (same block) → all skipped with a drift reason; no receipt.
    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(2);
    for (const skip of result.skipped) {
      expect(["block-re-edited", "target-changed"]).toContain(skip.reason);
    }
    // The flags remain (nothing was cleared).
    expect(needsReverify(lineage.extractId)).toBe(true);
  });

  it("partial drift — one item drifts, the other applies", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    const extractItem = preview.items.find((i) => i.elementId === lineage.extractId);
    const cardItem = preview.items.find((i) => i.elementId === lineage.cardId);
    if (!extractItem || !cardItem) throw new Error("expected both items");

    // Drift ONLY the extract's decision by corrupting its fingerprint; the card's is valid.
    const result = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: [
        { ...decisionFor(extractItem, "confirm"), fingerprint: "stale-fingerprint" },
        decisionFor(cardItem, "confirm"),
      ],
    });

    expect(result.applied).toBe(1);
    expect(result.skipped.map((s) => s.elementId)).toEqual([lineage.extractId]);
    expect(needsReverify(lineage.cardId)).toBe(false);
    expect(needsReverify(lineage.extractId)).toBe(true); // skipped → still flagged
  });

  it("not-flagged — a decision for an already-cleared triple is skipped", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    const extractItem = preview.items.find((i) => i.elementId === lineage.extractId);
    if (!extractItem) throw new Error("expected extract item");

    // Resolve it once, then replay the SAME decision — the second pass finds no provenance.
    svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: [decisionFor(extractItem, "confirm")],
    });
    const replay = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: [decisionFor(extractItem, "confirm")],
    });
    expect(replay.applied).toBe(0);
    expect(replay.skipped).toEqual([{ elementId: lineage.extractId, reason: "not-flagged" }]);
  });

  it("detach writes snapshot rows, clears the flags, and the receipt records the detached count", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });

    const result = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: preview.items.map((item) => decisionFor(item, "detach")),
    });

    expect(result.applied).toBe(2);
    expect(result.receipt?.counts).toEqual({ confirmed: 0, rebased: 0, detached: 2, skipped: 0 });
    expect(needsReverify(lineage.extractId)).toBe(false);
    // A detach snapshot exists for the extract, carrying the frozen anchor text.
    const snapshot = handle.db
      .select()
      .from(elementDetachSnapshot)
      .where(eq(elementDetachSnapshot.elementId, lineage.extractId))
      .get();
    expect(snapshot?.selectedText).toBe("Second paragraph.");
  });

  it("card confirm leaves review_states untouched (R7 — due_at unchanged)", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const dueBefore = cardReviewDueAt(lineage.cardId);
    expect(dueBefore).not.toBeNull();

    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    const cardItem = preview.items.find((i) => i.elementId === lineage.cardId);
    if (!cardItem) throw new Error("expected card item");

    svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: [decisionFor(cardItem, "confirm")],
    });
    expect(needsReverify(lineage.cardId)).toBe(false);
    expect(cardReviewDueAt(lineage.cardId)).toBe(dueBefore);
  });

  it("card detach leaves review_states untouched (R7 — due_at unchanged)", () => {
    // A fresh lineage so the card is freshly flagged (a second edit of an
    // already-stale block does not re-report it — that is the T123 contract).
    const lineage = seedLineage();
    staleLineage(lineage);
    const dueBefore = cardReviewDueAt(lineage.cardId);
    expect(dueBefore).not.toBeNull();

    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    const cardItem = preview.items.find((i) => i.elementId === lineage.cardId);
    if (!cardItem) throw new Error("expected card item");

    svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: [decisionFor(cardItem, "detach")],
    });
    expect(needsReverify(lineage.cardId)).toBe(false);
    expect(cardReviewDueAt(lineage.cardId)).toBe(dueBefore);
  });
});

describe("ReverifyResolutionService — resolve (rebase)", () => {
  it("rebases a raw/clean extract: body re-derived to current text, anchor unchanged, block un-staled, flag cleared, op-logged", () => {
    const lineage = seedLineage();
    // The seeded extract ("Second paragraph.", 2 words) is a `raw_extract` → rebase re-derives.
    expect(needsReverify(lineage.extractId)).toBe(false);
    staleLineage(lineage); // edits block[1] to "Heavily rewritten." → flags extract + card
    expect(needsReverify(lineage.extractId)).toBe(true);
    expect(bodyPlainText(lineage.extractId)).toBe("Second paragraph.");

    // The IMMUTABLE anchor row before rebase (asserted unchanged after).
    const anchorBefore = handle.db
      .select()
      .from(sourceLocations)
      .where(eq(sourceLocations.elementId, lineage.extractId))
      .get();

    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    // Rebase BOTH so the block reaches its last flagged anchor and exits stale.
    const result = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: preview.items.map((item) => decisionFor(item, "rebase")),
    });

    expect(result.applied).toBe(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.receipt?.counts).toEqual({
      confirmed: 0,
      rebased: 2,
      detached: 0,
      skipped: 0,
    });

    // The extract body now reflects the corrected source text (offsets 0–17 of the new block).
    expect(bodyPlainText(lineage.extractId)).toContain("Heavily rewritten");
    expect(bodyPlainText(lineage.extractId)).not.toBe("Second paragraph.");

    // The `source_locations` anchor row is byte-identical — rebase never rewrites it.
    const anchorAfter = handle.db
      .select()
      .from(sourceLocations)
      .where(eq(sourceLocations.elementId, lineage.extractId))
      .get();
    expect(anchorAfter).toEqual(anchorBefore);

    // The block left `stale_after_edit` (corrected text accepted as the new baseline).
    expect(blockProcessingRow(lineage.sourceId, lineage.extractedBlock)?.state).not.toBe(
      "stale_after_edit",
    );
    // Flags cleared everywhere.
    expect(needsReverify(lineage.extractId)).toBe(false);
    expect(needsReverify(lineage.cardId)).toBe(false);
    expect(provenanceCount(lineage.extractId)).toBe(0);

    // Each rebase is op-logged with the `reverifyResolution` marker (verb: rebase).
    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, lineage.extractId))
      .all()
      .map((op) => JSON.parse(op.payload) as { reverifyResolution?: { verb?: string } })
      .filter((p) => p.reverifyResolution?.verb === "rebase");
    expect(ops).toHaveLength(1);
  });

  it("fail-closed: reconstruction returns null → skipped with `rebase-failed`, body + flag untouched, no partial write", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    const extractItem = preview.items.find((i) => i.elementId === lineage.extractId);
    if (!extractItem) throw new Error("expected extract item");

    // Clear the anchor's offsets so `richSelectionToProseMirrorDoc` fails closed (null).
    handle.db
      .update(sourceLocations)
      .set({ startOffset: null, endOffset: null })
      .where(eq(sourceLocations.elementId, lineage.extractId))
      .run();

    const bodyBefore = bodyJson(lineage.extractId);
    const opsBefore = opLogCount();

    const result = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: [decisionFor(extractItem, "rebase")],
    });

    expect(result.applied).toBe(0);
    expect(result.skipped).toEqual([{ elementId: lineage.extractId, reason: "rebase-failed" }]);
    // No write at all: body, flag, provenance, and op-log are untouched.
    expect(bodyJson(lineage.extractId)).toEqual(bodyBefore);
    expect(needsReverify(lineage.extractId)).toBe(true);
    expect(provenanceCount(lineage.extractId)).toBe(1);
    expect(opLogCount()).toBe(opsBefore);
  });

  it("sibling protection: rebasing one of two extracts on one block leaves the other flagged AND the block stale with pre_stale_hash intact", () => {
    // Two independent raw extracts anchored to the SAME source block.
    const { element: source } = new SourceRepository(handle.db).createWithDocument({
      title: "Shared-block source",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
      body: "Shared sentence one.\n\nUnrelated tail.",
    });
    const sourceId = source.id;
    const blocks = new DocumentRepository(handle.db)
      .listBlocks(sourceId)
      .map((b) => b.stableBlockId as BlockId);
    const sharedBlock = blocks[0] as BlockId;
    const extraction = new ExtractionService(handle.db);
    const { element: extractA } = extraction.createExtraction({
      sourceElementId: sourceId,
      selectedText: "Shared sentence one.",
      blockIds: [sharedBlock],
      startOffset: 0,
      endOffset: 20,
      priority: 0.5,
    });
    const { element: extractB } = extraction.createExtraction({
      sourceElementId: sourceId,
      selectedText: "Shared sentence one.",
      blockIds: [sharedBlock],
      startOffset: 0,
      endOffset: 20,
      priority: 0.5,
    });

    // Stale the shared block → both extracts flagged.
    saveSourceDoc(
      sourceId,
      editBlockText(storedDoc(sourceId), sharedBlock, "Shared sentence ONE edited."),
    );
    expect(needsReverify(extractA.id)).toBe(true);
    expect(needsReverify(extractB.id)).toBe(true);
    const staleBefore = blockProcessingRow(sourceId, sharedBlock);
    expect(staleBefore?.state).toBe("stale_after_edit");
    expect(staleBefore?.preStaleHash).toBeTruthy();

    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: sourceId });
    const itemA = preview.items.find((i) => i.elementId === extractA.id);
    if (!itemA) throw new Error("expected extractA item");

    // Rebase ONLY extractA.
    const result = svc.resolve({
      sourceElementId: sourceId,
      decisions: [decisionFor(itemA, "rebase")],
    });
    expect(result.applied).toBe(1);

    // extractB stays flagged; the block stays stale with pre_stale_hash intact (so the
    // sibling keeps its content-restore auto-clear).
    expect(needsReverify(extractA.id)).toBe(false);
    expect(needsReverify(extractB.id)).toBe(true);
    const staleAfter = blockProcessingRow(sourceId, sharedBlock);
    expect(staleAfter?.state).toBe("stale_after_edit");
    expect(staleAfter?.preStaleHash).toBe(staleBefore?.preStaleHash);

    // Proof the sibling can STILL auto-clear on a content restore (pre_stale_hash intact).
    saveSourceDoc(
      sourceId,
      editBlockText(storedDoc(sourceId), sharedBlock, "Shared sentence one."),
    );
    expect(needsReverify(extractB.id)).toBe(false);
    expect(blockProcessingRow(sourceId, sharedBlock)?.state).not.toBe("stale_after_edit");
  });

  it("rebase undo restores the prior body, the prior block-processing state, and provenance symmetrically", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const bodyBefore = bodyJson(lineage.extractId);
    const blockBefore = blockProcessingRow(lineage.sourceId, lineage.extractedBlock);
    expect(blockBefore?.state).toBe("stale_after_edit");
    expect(blockBefore?.preStaleHash).toBeTruthy();

    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    const result = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: preview.items.map((item) => decisionFor(item, "rebase")),
    });
    expect(result.applied).toBe(2);
    expect(needsReverify(lineage.extractId)).toBe(false);
    expect(blockProcessingRow(lineage.sourceId, lineage.extractedBlock)?.state).not.toBe(
      "stale_after_edit",
    );

    const undo = svc.undoReceipt(result.batchId);
    expect(undo.undone).toBe(true);
    expect(undo.count).toBe(2);

    // Body restored byte-for-byte; block back to stale_after_edit with its pre_stale_hash;
    // provenance + flag back to true (symmetric).
    expect(bodyJson(lineage.extractId)).toEqual(bodyBefore);
    const blockAfter = blockProcessingRow(lineage.sourceId, lineage.extractedBlock);
    expect(blockAfter?.state).toBe("stale_after_edit");
    expect(blockAfter?.preStaleHash).toBe(blockBefore?.preStaleHash);
    expect(needsReverify(lineage.extractId)).toBe(true);
    expect(needsReverify(lineage.cardId)).toBe(true);
    expect(provenanceCount(lineage.extractId)).toBe(1);
  });

  it("atomic-statement extract / card rebase is clear-only: provenance cleared, NO body re-derivation, card schedule untouched", () => {
    const lineage = seedLineage();
    // Force the extract to the `atomic_statement` stage (clear-only on rebase).
    handle.db
      .update(elements)
      .set({ stage: "atomic_statement" })
      .where(eq(elements.id, lineage.extractId))
      .run();
    staleLineage(lineage);
    const extractBodyBefore = bodyJson(lineage.extractId);
    const cardDueBefore = cardReviewDueAt(lineage.cardId);
    expect(cardDueBefore).not.toBeNull();

    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    const result = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: preview.items.map((item) => decisionFor(item, "rebase")),
    });

    expect(result.applied).toBe(2);
    // The atomic-statement extract's body is NOT re-derived (clear-only).
    expect(bodyJson(lineage.extractId)).toEqual(extractBodyBefore);
    // The card's FSRS schedule is untouched (R7).
    expect(cardReviewDueAt(lineage.cardId)).toBe(cardDueBefore);
    // Provenance cleared against the current block; flags cleared.
    expect(needsReverify(lineage.extractId)).toBe(false);
    expect(needsReverify(lineage.cardId)).toBe(false);
  });

  it("multi-block extract: rebasing against one corrected block leaves the flag set while another block still flags it", () => {
    const { element: source } = new SourceRepository(handle.db).createWithDocument({
      title: "Two-block source",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
      body: "Alpha block sentence.\n\nBeta block sentence.",
    });
    const sourceId = source.id;
    const blocks = new DocumentRepository(handle.db)
      .listBlocks(sourceId)
      .map((b) => b.stableBlockId as BlockId);
    const { element: extract } = new ExtractionService(handle.db).createExtraction({
      sourceElementId: sourceId,
      selectedText: "Alpha block sentence. Beta block sentence.",
      blockIds: [blocks[0] as BlockId, blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 21,
      priority: 0.5,
    });
    // Stale BOTH blocks → the extract has two provenance rows (one per block).
    let edited = editBlockText(
      storedDoc(sourceId),
      blocks[0] as BlockId,
      "Alpha edited text here.",
    );
    edited = editBlockText(edited, blocks[1] as BlockId, "Beta edited text here.");
    saveSourceDoc(sourceId, edited);
    expect(needsReverify(extract.id)).toBe(true);
    expect(provenanceCount(extract.id)).toBe(2);

    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: sourceId });
    // Rebase only the tuple for block[0]; block[1] still flags the extract.
    const block0Item = preview.items.find((i) => i.stableBlockId === blocks[0]);
    if (!block0Item) throw new Error("expected block[0] item");
    const result = svc.resolve({
      sourceElementId: sourceId,
      decisions: [decisionFor(block0Item, "rebase")],
    });

    expect(result.applied).toBe(1);
    // One provenance row (block[1]) remains → flag stays true (projection, not flip).
    expect(provenanceCount(extract.id)).toBe(1);
    expect(needsReverify(extract.id)).toBe(true);
  });
});

describe("ReverifyResolutionService — undoReceipt", () => {
  it("happy path restores provenance + flags and marks the receipt undone", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    const result = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: preview.items.map((item) => decisionFor(item, "confirm")),
    });
    expect(needsReverify(lineage.extractId)).toBe(false);

    const undo = svc.undoReceipt(result.batchId);
    expect(undo.undone).toBe(true);
    expect(undo.count).toBe(2);
    expect(undo.receipt?.status).toBe("undone");
    expect(needsReverify(lineage.extractId)).toBe(true);
    expect(needsReverify(lineage.cardId)).toBe(true);
    expect(provenanceCount(lineage.extractId)).toBe(1);

    // A second undo of the same (now-undone) receipt refuses.
    const again = svc.undoReceipt(result.batchId);
    expect(again.undone).toBe(false);
    expect(again.reason).toBe("receipt-not-actionable");
  });

  it("missing receipt refuses with receipt-not-actionable", () => {
    const undo = service().undoReceipt("nope");
    expect(undo).toMatchObject({ undone: false, reason: "receipt-not-actionable" });
  });

  it("refuses to clobber a re-staled item; per-item undo still reverses the unaffected ones", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    const result = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: preview.items.map((item) => decisionFor(item, "confirm")),
    });
    expect(needsReverify(lineage.extractId)).toBe(false);

    // Re-stale the EXTRACT's triple AFTER the confirm cleared it (a fresh provenance
    // row for the same triple) — the four-part guard must refuse to clobber it.
    const prop = new ReverifyPropagationRepository(handle.db);
    handle.db.transaction((tx) => {
      prop.insertProvenanceWithin(tx, {
        elementId: lineage.extractId,
        sourceElementId: lineage.sourceId,
        stableBlockId: lineage.extractedBlock,
        batchId: "re-stale",
      });
      prop.recomputeFlagWithin(tx, lineage.extractId, "re-stale");
    });
    expect(needsReverify(lineage.extractId)).toBe(true);

    // Whole-receipt undo: the extract is skipped (re-staled), the card still restores.
    const undo = svc.undoReceipt(result.batchId);
    expect(undo.undone).toBe(true); // the card item reversed
    expect(undo.count).toBe(1);
    expect(undo.skipped.map((s) => s.elementId)).toEqual([lineage.extractId]);
    // The card's flag is restored; the extract keeps its NEWER provenance (not clobbered).
    expect(needsReverify(lineage.cardId)).toBe(true);
    expect(provenanceCount(lineage.extractId)).toBe(1);
    // A partial per-item undo leaves the receipt actionable.
    expect(svc.receipt(result.batchId)?.status).toBe("actionable");
  });

  it("itemIds filter reverses only the named items", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    const result = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: preview.items.map((item) => decisionFor(item, "confirm")),
    });

    const undo = svc.undoReceipt(result.batchId, { itemIds: [lineage.cardId] });
    expect(undo.undone).toBe(true);
    expect(undo.count).toBe(1);
    expect(needsReverify(lineage.cardId)).toBe(true);
    expect(needsReverify(lineage.extractId)).toBe(false); // not in the filter → still cleared
  });
});

describe("ReverifyResolutionService — restart safety", () => {
  it("a fresh service over the same DB sees the persisted receipt", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    const result = svc.resolve({
      sourceElementId: lineage.sourceId,
      decisions: preview.items.map((item) => decisionFor(item, "confirm")),
    });

    // The receipt is durably persisted in settings JSON.
    const stored = handle.db
      .select()
      .from(settings)
      .where(eq(settings.key, REVERIFY_RESOLUTION_STATE_KEY))
      .get();
    expect(stored).toBeTruthy();

    // A brand-new service instance (new repositories) rehydrates the receipt + can undo it.
    const freshRepos = createRepositories(handle.db);
    const fresh = new ReverifyResolutionService(handle.db, freshRepos);
    expect(fresh.receipt(result.batchId)?.batchId).toBe(result.batchId);
    const undo = fresh.undoReceipt(result.batchId);
    expect(undo.undone).toBe(true);
    expect(needsReverify(lineage.extractId)).toBe(true);
  });
});

describe("ReverifyResolutionService — flaggedSourcesSummary", () => {
  /** A titled source with one raw extract anchored to its first block, plus a card. */
  function seedTitledLineage(title: string): Lineage {
    const { element: source } = new SourceRepository(handle.db).createWithDocument({
      title,
      priority: 0.5,
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
      priority: 0.5,
    });
    const { element: card } = new CardService(handle.db).createFromExtract({
      extractId: extract.id,
      kind: "qa",
      prompt: "What is in the second paragraph?",
      answer: "Second paragraph.",
    });
    return { sourceId, extractId: extract.id, cardId: card.id, blocks, extractedBlock };
  }

  it("groups by source with distinct-output counts, ordered by count desc then title asc, and appends ZERO op-log rows", () => {
    // Source "Zebra" flags 2 outputs (extract + card); source "Alpha" flags 2 outputs too —
    // a tie, so title asc breaks it ("Alpha" before "Zebra").
    const zebra = seedTitledLineage("Zebra source");
    staleLineage(zebra);
    const alpha = seedTitledLineage("Alpha source");
    staleLineage(alpha);
    const before = opLogCount();

    const summary = service().flaggedSourcesSummary();

    expect(summary.totalOutputs).toBe(4);
    expect(summary.sources.map((s) => s.title)).toEqual(["Alpha source", "Zebra source"]);
    expect(summary.sources.map((s) => s.count)).toEqual([2, 2]);
    expect(summary.sources.map((s) => s.sourceElementId).sort()).toEqual(
      [alpha.sourceId, zebra.sourceId].sort(),
    );
    // Read-only: not a single op-log row was written.
    expect(opLogCount()).toBe(before);
  });

  it("counts an element once per source even when several blocks flag it (distinct outputs)", () => {
    const { element: source } = new SourceRepository(handle.db).createWithDocument({
      title: "Two-block source",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
      body: "Alpha block sentence.\n\nBeta block sentence.",
    });
    const sourceId = source.id;
    const blocks = new DocumentRepository(handle.db)
      .listBlocks(sourceId)
      .map((b) => b.stableBlockId as BlockId);
    new ExtractionService(handle.db).createExtraction({
      sourceElementId: sourceId,
      selectedText: "Alpha block sentence. Beta block sentence.",
      blockIds: [blocks[0] as BlockId, blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 21,
      priority: 0.5,
    });
    // Stale BOTH blocks → the extract has two provenance rows (one per block).
    let edited = editBlockText(
      storedDoc(sourceId),
      blocks[0] as BlockId,
      "Alpha edited text here.",
    );
    edited = editBlockText(edited, blocks[1] as BlockId, "Beta edited text here.");
    saveSourceDoc(sourceId, edited);

    const summary = service().flaggedSourcesSummary();
    const entry = summary.sources.find((s) => s.sourceElementId === sourceId);
    // The extract is flagged against two blocks but counts as ONE distinct output.
    expect(entry?.count).toBe(1);
    expect(summary.totalOutputs).toBe(1);
  });

  it("ignores soft-deleted flagged outputs (excluded from count and total)", () => {
    const lineage = seedTitledLineage("Has a deleted output");
    staleLineage(lineage); // extract + card flagged

    // Soft-delete the card output; only the live extract should be counted.
    handle.db
      .update(elements)
      .set({ deletedAt: "2026-06-14T00:00:00.000Z" })
      .where(eq(elements.id, lineage.cardId))
      .run();

    const summary = service().flaggedSourcesSummary();
    const entry = summary.sources.find((s) => s.sourceElementId === lineage.sourceId);
    expect(entry?.count).toBe(1);
    expect(summary.totalOutputs).toBe(1);
  });

  it("returns a stable empty rollup when nothing is flagged", () => {
    seedTitledLineage("Nothing flagged here"); // no staleLineage → no provenance
    const summary = service().flaggedSourcesSummary();
    expect(summary).toEqual({ totalOutputs: 0, sources: [] });
  });
});

describe("ReverifyResolutionService — code-review regression fixes", () => {
  it("bulk-confirm fully resolves an element flagged against TWO blocks in one batch (per-triple fingerprint)", () => {
    // An extract spanning TWO source blocks, flagged against BOTH — the case where a
    // whole-element provenance signature self-invalidated the batch (clearing block A
    // shifted block B's fingerprint → block B skipped as `target-changed`).
    const { element: source } = new SourceRepository(handle.db).createWithDocument({
      title: "Two-block source",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
      body: "Alpha sentence.\n\nBeta sentence.",
    });
    const sourceId = source.id;
    const blocks = new DocumentRepository(handle.db)
      .listBlocks(sourceId)
      .map((b) => b.stableBlockId as BlockId);
    const { element: extract } = new ExtractionService(handle.db).createExtraction({
      sourceElementId: sourceId,
      selectedText: "Alpha sentence.\n\nBeta sentence.",
      blockIds: [blocks[0] as BlockId, blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 14,
      priority: 0.5,
    });

    // Stale BOTH blocks in one save → the extract gains provenance for each.
    let doc = storedDoc(sourceId);
    doc = editBlockText(doc, blocks[0] as BlockId, "Alpha heavily rewritten.");
    doc = editBlockText(doc, blocks[1] as BlockId, "Beta heavily rewritten.");
    saveSourceDoc(sourceId, doc);
    expect(needsReverify(extract.id)).toBe(true);
    expect(provenanceCount(extract.id)).toBe(2);

    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: sourceId });
    const items = preview.items.filter((i) => i.elementId === extract.id);
    expect(items).toHaveLength(2); // one item per flagged block

    const result = svc.resolve({
      sourceElementId: sourceId,
      decisions: items.map((item) => decisionFor(item, "confirm")),
    });

    // BOTH blocks confirm in one batch — the element fully clears.
    expect(result.applied).toBe(2);
    expect(result.skipped).toHaveLength(0);
    expect(needsReverify(extract.id)).toBe(false);
    expect(provenanceCount(extract.id)).toBe(0);
  });

  it("a detached DESCENDANT stays standalone — re-staling the ancestor's block does NOT re-flag it", () => {
    const lineage = seedLineage();
    staleLineage(lineage); // flags the extract AND its descendant card (via the descent walk)
    expect(needsReverify(lineage.cardId)).toBe(true);

    const svc = service();
    const preview = svc.sessionPreview({ sourceElementId: lineage.sourceId });
    const cardItem = preview.items.find((i) => i.elementId === lineage.cardId);
    if (!cardItem) throw new Error("expected a flagged card item");
    expect(
      svc.resolve({
        sourceElementId: lineage.sourceId,
        decisions: [decisionFor(cardItem, "detach")],
      }).applied,
    ).toBe(1);
    expect(needsReverify(lineage.cardId)).toBe(false);

    // Restore the block (the un-stale arm clears the extract's provenance), then stale it
    // AFRESH so the propagation walk re-fires (a re-edit while already stale is a T123 no-op).
    saveSourceDoc(
      lineage.sourceId,
      editBlockText(storedDoc(lineage.sourceId), lineage.extractedBlock, "Second paragraph."),
    );
    expect(needsReverify(lineage.extractId)).toBe(false);
    saveSourceDoc(
      lineage.sourceId,
      editBlockText(
        storedDoc(lineage.sourceId),
        lineage.extractedBlock,
        "Rewritten a different way.",
      ),
    );

    // The anchor extract re-flags; the DETACHED descendant card stays standalone (the
    // tombstone now applies to descendants in the propagation walk, not just anchors).
    expect(needsReverify(lineage.extractId)).toBe(true);
    expect(needsReverify(lineage.cardId)).toBe(false);
  });
});

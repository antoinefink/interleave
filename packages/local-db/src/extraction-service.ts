/**
 * ExtractionService (T021) — the keystone of the distillation loop.
 *
 * Extraction lifts a run of selected source text into a NEW, **independent,
 * attention-scheduled** `extract` element — a first-class child of the source, NOT
 * a highlight and NOT an FSRS item. This service composes `SourceRepository`,
 * `ElementRepository`, and `DocumentRepository` to perform the whole extraction in
 * ONE transaction:
 *
 *   1. create the `extract` element (status `pending`, stage `raw_extract`) + its
 *      `source_locations` anchor (block ids + offsets + verbatim snapshot + a
 *      human-readable label) — `create_element` + `create_extract`;
 *   2. seed the extract's own `documents` body + stable blocks from the selected
 *      text — `update_document`;
 *   3. record the `derived_from` edge extract → source/parent — `add_relation`;
 *   4. inherit the source's priority (passed in) + copy its tag memberships;
 *   5. give it an initial **attention** `due_at` (the `raw_extract` `+1..+7d`
 *      heuristic by inherited priority) and flip its status to `scheduled` —
 *      `reschedule_element` (NEVER FSRS: no `review_states` row is created);
 *   6. mark the parent/source body `extracted_span` over the selected range —
 *      `update_document` (a breadcrumb annotation, not lineage).
 *
 * **Atomicity (load-bearing):** all six steps plus their `operation_log` appends
 * commit in a SINGLE `db.transaction`, via the tx-composable `*Within(tx, …)`
 * seams that mirror `ElementRepository.createWithin` + `OperationLogRepository
 * .append(tx, …)`. A throw anywhere — a bad block id, a constraint failure —
 * rolls back the ENTIRE extraction: no orphan element, location, relation, mark,
 * body, or log row is left behind. The op-log row is never appended in a
 * transaction separate from the mutation it records.
 *
 * Lineage is sacred: the extract's `source_id` is the original source root and its
 * `parent_id` is the origin element it was lifted from (the source for a top-level
 * extract; the parent extract for a sub-extract — T025 passes an explicit
 * `parentId`). The renderer never runs any of this; it reaches the service only
 * through the validated `extractions.create` IPC command.
 */

import type {
  BlockId,
  Element,
  ElementId,
  ElementLocation,
  IsoTimestamp,
  Priority,
} from "@interleave/core";
import { plainTextToProseMirrorDoc, priorityToLabel } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { nowIso } from "./ids";
import { deriveSourceLocationLabel, type LabelBlock } from "./source-location-label";
import { SourceRepository } from "./source-repository";

/** A very large per-block end so an `extracted_span` over the first block clamps to its text length. */
const BLOCK_END = Number.MAX_SAFE_INTEGER;

/**
 * The starter attention interval (DAYS) for a freshly created `raw_extract`, by
 * inherited priority band — the MVP `raw_extract +1..+7d` heuristic from
 * `scheduling-and-priority.md`. Higher-priority extracts return sooner so they are
 * not buried; T028's real scheduler will replace this formula. Kept here (not in a
 * React component) per the layering rule.
 */
export function rawExtractIntervalDays(priority: Priority): number {
  // priorityToLabel buckets to A/B/C/D; map onto the 1–7 day raw_extract window.
  switch (priorityToLabel(priority)) {
    case "A":
      return 1;
    case "B":
      return 3;
    case "C":
      return 5;
    case "D":
      return 7;
  }
}

/** Add `days` to an ISO timestamp, returning a new ISO timestamp. */
function addDays(fromIso: IsoTimestamp, days: number): IsoTimestamp {
  const ms = Date.parse(fromIso) + days * 86_400_000;
  return new Date(ms).toISOString() as IsoTimestamp;
}

/** Arguments to extract a child element from selected source text. */
export interface CreateExtractionInput {
  /** The original source element this extract derives from (the lineage root). */
  readonly sourceElementId: ElementId;
  /**
   * The origin element the selection was lifted from. Defaults to
   * `sourceElementId` for a top-level extract; T025 passes the parent extract id
   * for a sub-extract (whose `source_id` is still the original source).
   */
  readonly parentId?: ElementId | undefined;
  /** Verbatim snapshot of the selected text — seeds the extract's body. */
  readonly selectedText: string;
  /** Ordered stable block ids the selection spans (≥ 1, document order). */
  readonly blockIds: readonly BlockId[];
  /** Char offset within the FIRST spanned block where the selection starts. */
  readonly startOffset?: number | undefined;
  /** Char offset within the LAST spanned block where the selection ends. */
  readonly endOffset?: number | undefined;
  /** Optional explicit title; defaults to a trimmed prefix of the selection. */
  readonly title?: string | undefined;
  /**
   * The inherited priority for the extract. Normally the source's priority; the
   * caller (DbService) resolves it so this service stays free of provenance reads.
   */
  readonly priority: Priority;
  /** Optional human label override; otherwise derived from the source's blocks. */
  readonly label?: string | null | undefined;
  /** Optional page (PDF, later); null for text sources. */
  readonly page?: number | null | undefined;
}

/** The created extract element + its source-location anchor (T021 result). */
export interface ExtractionResult {
  readonly element: Element;
  readonly location: ElementLocation;
}

/** Build a short title from a selection (first ~80 chars, single line). */
function titleFromSelection(selectedText: string): string {
  const normalized = selectedText.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "Untitled extract";
  return normalized.length > 80 ? `${normalized.slice(0, 80).trimEnd()}…` : normalized;
}

export class ExtractionService {
  private readonly elements: ElementRepository;
  private readonly sources: SourceRepository;
  private readonly documents: DocumentRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.sources = new SourceRepository(db);
    this.documents = new DocumentRepository(db);
  }

  /**
   * Perform the full extraction in ONE transaction. See the file header for the
   * six steps + the atomicity contract. Returns the new extract element + its
   * source-location anchor.
   */
  createExtraction(input: CreateExtractionInput): ExtractionResult {
    if (input.blockIds.length === 0) {
      throw new Error("ExtractionService.createExtraction: at least one block id is required");
    }
    const title = (input.title ?? "").trim() || titleFromSelection(input.selectedText);
    const label = input.label ?? this.deriveLabel(input.sourceElementId, input.blockIds[0]);
    // The body seed is computed BEFORE the transaction (pure CPU work, no DB).
    const conversion = plainTextToProseMirrorDoc(input.selectedText);
    // Read the source's inherited tags up front (a read; the writes happen in tx).
    const inheritedTags = this.elements.listTags(input.sourceElementId);

    return this.db.transaction((tx) => {
      // 1) extract element + source_locations anchor (create_element + create_extract).
      const { element, location } = this.sources.createExtractWithin(tx, {
        sourceElementId: input.sourceElementId,
        parentId: input.parentId ?? input.sourceElementId,
        title,
        priority: input.priority,
        stage: "raw_extract",
        selectedText: input.selectedText,
        blockIds: input.blockIds,
        startOffset: input.startOffset ?? null,
        endOffset: input.endOffset ?? null,
        page: input.page ?? null,
        label,
      });

      // 2) seed the extract's own document body + stable blocks (update_document).
      this.documents.upsertWithin(tx, {
        elementId: element.id,
        prosemirrorJson: conversion.doc,
        plainText: conversion.plainText,
        blocks: conversion.blocks.map((b) => ({
          blockType: b.blockType,
          order: b.order,
          stableBlockId: b.stableBlockId,
        })),
      });

      // 3) derived_from edge extract → source/parent (add_relation). Lineage is sacred.
      this.elements.addRelationWithin(tx, {
        fromElementId: element.id,
        toElementId: input.parentId ?? input.sourceElementId,
        relationType: "derived_from",
      });

      // 4) inherit the source's tags (priority was inherited via the element above).
      for (const tagName of inheritedTags) {
        this.elements.addTagWithin(tx, element.id, tagName);
      }

      // 5) initial ATTENTION due date + status scheduled (reschedule_element).
      //    NEVER FSRS — no review_states row is created for an extract.
      const dueAt = addDays(nowIso(), rawExtractIntervalDays(input.priority));
      const scheduled = this.elements.rescheduleWithin(tx, element.id, dueAt, "scheduled");

      // 6) parent/source extracted_span breadcrumb over the selected range
      //    (update_document). One mark row per spanned block so each re-anchors
      //    independently by its stable id (same convention as highlights, T020).
      const parentDocId = input.parentId ?? input.sourceElementId;
      const blocks = input.blockIds;
      for (let i = 0; i < blocks.length; i++) {
        const isFirst = i === 0;
        const isLast = i === blocks.length - 1;
        const start = isFirst ? (input.startOffset ?? 0) : 0;
        const end = isLast ? (input.endOffset ?? BLOCK_END) : BLOCK_END;
        if (end <= start) continue;
        this.documents.addMarkWithin(tx, {
          elementId: parentDocId,
          blockId: blocks[i] as BlockId,
          markType: "extracted_span",
          range: [start, end],
          attrs: { extractId: element.id },
        });
      }

      return { element: scheduled, location };
    });
  }

  /** Derive a human label for the anchor from the source's ordered blocks. */
  private deriveLabel(sourceElementId: ElementId, firstBlockId: BlockId | undefined): string {
    if (!firstBlockId) return "Selected text";
    const blocks: LabelBlock[] = this.documents
      .listBlocks(sourceElementId)
      .map((b) => ({ stableBlockId: b.stableBlockId, blockType: b.blockType, order: b.order }));
    return deriveSourceLocationLabel(blocks, firstBlockId);
  }
}

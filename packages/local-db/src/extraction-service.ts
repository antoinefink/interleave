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
 *
 * Sub-extracts (T025) reuse this path VERBATIM — only `parentId` differs. When a
 * `parentId` is given, the selected text was lifted from the PARENT extract's body,
 * so the `source_locations` anchor (block ids + offsets + label) points into the
 * parent extract while `elements.source_id` still points at the original source
 * root. The result is the navigable chain `source → extract → sub-extract` whose
 * jump-to-source lands in the parent extract's document (where the text lives).
 */

import type {
  BlockId,
  ClipWindow,
  Element,
  ElementId,
  ElementLocation,
  Priority,
  RegionRect,
} from "@interleave/core";
import { plainTextToProseMirrorDoc, richSelectionToProseMirrorDoc } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { addDays, rawExtractIntervalDays } from "@interleave/scheduler";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { newElementId, nowIso } from "./ids";
import {
  deriveClipLabel,
  deriveSourceLocationLabel,
  type LabelBlock,
} from "./source-location-label";
import { SourceRepository } from "./source-repository";

// The starter `raw_extract +1..7d` interval math now lives ONCE in
// `@interleave/scheduler` (T028); this re-export keeps the historical symbol
// (`@interleave/local-db`, the M4 extraction tests) working without a second copy.
export { rawExtractIntervalDays };

/** A very large per-block end so an `extracted_span` over the first block clamps to its text length. */
const BLOCK_END = Number.MAX_SAFE_INTEGER;

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

/** Arguments to create a PDF REGION extract (T065 — a `media_fragment`). */
export interface CreateRegionExtractInput {
  /**
   * Optional pre-minted element id so the caller can import the image asset keyed
   * by it AFTER this transaction (and soft-delete by id on an asset-import failure).
   */
  readonly elementId?: ElementId;
  /** The source (PDF) element this region was drawn over (the lineage root + parent). */
  readonly sourceElementId: ElementId;
  /** The 1-based page the region sits on. */
  readonly page: number;
  /** The page's heading/first stable block id — the region's anchor (jump target). */
  readonly pageBlockId: BlockId;
  /** The normalized bounding box `{ x0, y0, x1, y1 }` (fractions 0–1). */
  readonly region: RegionRect;
  /** The inherited (source) priority for the fragment. */
  readonly priority: Priority;
  /** An optional user caption; defaults to "Figure on page N". */
  readonly caption?: string | null;
  /** The OCR/text under the region when resolved; else a generated snapshot. */
  readonly selectedText?: string | null;
}

/** Arguments to create a media CLIP extract (T074 — a `media_fragment`). */
export interface CreateClipExtractInput {
  /** Optional pre-minted element id (symmetry with the region path); else minted. */
  readonly elementId?: ElementId;
  /** The media source element this clip was selected over (the lineage root + parent). */
  readonly sourceElementId: ElementId;
  /** The clip start in integer milliseconds (the location's `timestamp_ms`). */
  readonly startMs: number;
  /** The clip end in integer milliseconds (`endMs > startMs`). */
  readonly endMs: number;
  /**
   * The stable block id the clip anchors to — the first transcript cue in range, or
   * the title-heading/placeholder block for a transcript-less source. Jump-to-source
   * lands here.
   */
  readonly anchorBlockId: BlockId;
  /** The transcript text spanning the range (when a transcript exists), else null. */
  readonly transcriptSegment?: string | null;
  /** Optional caption override; otherwise the generated "Clip M:SS–M:SS" label. */
  readonly caption?: string | null;
  /** The inherited (source) priority for the fragment. */
  readonly priority: Priority;
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
    // The selection was lifted from the PARENT element's body (the source for a
    // top-level extract; the PARENT EXTRACT for a sub-extract — T025). The
    // `source_locations` anchor and its human label therefore point INTO that
    // parent document, while `elements.source_id` stays the lineage root. This is
    // the ONLY thing that differs for a sub-extract — the rest of the path is the
    // T021 extraction verbatim (same element/body/relation/tags/schedule/mark).
    const locationSource = input.parentId ?? input.sourceElementId;
    // Thread the extract's page (PDF, T064) into the label so a PDF extract reads
    // "Page N · ¶M"; null/absent for a text source keeps the existing "¶M".
    const label = input.label ?? this.deriveLabel(locationSource, input.blockIds[0], input.page);
    // The body seed is computed BEFORE the transaction (pure CPU work, no writes).
    // Prefer the stored parent/source document so multi-block selections keep
    // paragraph boundaries and constrained block atoms such as article images.
    // Fall back to the historical plain-text body if the parent doc cannot be
    // reconstructed, so extraction stays available for malformed/legacy bodies.
    const conversion =
      input.startOffset != null && input.endOffset != null
        ? (richSelectionToProseMirrorDoc({
            parentDoc: this.documents.findById(locationSource)?.prosemirrorJson ?? null,
            blockIds: input.blockIds,
            startOffset: input.startOffset,
            endOffset: input.endOffset,
            selectedText: input.selectedText,
          }) ?? plainTextToProseMirrorDoc(input.selectedText))
        : plainTextToProseMirrorDoc(input.selectedText);
    // Read the source's inherited tags up front (a read; the writes happen in tx).
    const inheritedTags = this.elements.listTags(input.sourceElementId);

    return this.db.transaction((tx) => {
      // 1) extract element + source_locations anchor (create_element + create_extract).
      //    `sourceElementId` is the lineage root (→ elements.source_id); the location
      //    anchor points into `locationSource` (the parent extract for a sub-extract).
      const { element, location } = this.sources.createExtractWithin(tx, {
        sourceElementId: input.sourceElementId,
        parentId: input.parentId ?? input.sourceElementId,
        locationSourceElementId: locationSource,
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

  /**
   * Create a PDF REGION extract (T065) — a `media_fragment` element anchoring a
   * figure/table crop to its page + bounding box. Mirrors {@link createExtraction}
   * but: the element is a `media_fragment` (not a text `extract`), the
   * `source_locations` anchor carries the `page` + the normalized `region` rect
   * (not a text span), the body is a caption placeholder (the image is the LINKED
   * asset, not an inline node — the constrained schema has no image node), and the
   * parent body is NOT marked (there is no text span). Everything else matches the
   * extraction path: a `derived_from` edge, inherited priority/tags, and an
   * initial ATTENTION `due_at` (NEVER FSRS). All of it commits in ONE transaction.
   *
   * The image asset is imported SEPARATELY (out of this transaction) by the
   * main-side `PdfRegionService`, keyed by the returned element id — so this method
   * accepts a pre-minted `elementId` (it returns the same id) and the caller owns
   * the asset import + its rollback. Returns the new element + its region anchor.
   */
  createRegionExtract(input: CreateRegionExtractInput): ExtractionResult {
    const elementId = input.elementId ?? newElementId();
    const page = input.page;
    const title = (input.caption ?? "").trim() || `Figure on page ${page}`;
    // The region anchors to the page's heading block (so jump-to-source lands on
    // the page); the label reads "Page N · region".
    const blockIds: readonly BlockId[] = [input.pageBlockId];
    const label = `Page ${page} · region`;
    // `selectedText` is the OCR/text under the region when the caller resolved it
    // (from intersecting PDF lines), else a generated label — never empty (the
    // snapshot must never dead-end).
    const selectedText = (input.selectedText ?? "").trim() || title;
    // A minimal caption body — the cropped image is shown from the linked asset by
    // the extract/inspector view, not embedded inline.
    const conversion = plainTextToProseMirrorDoc(title);
    const inheritedTags = this.elements.listTags(input.sourceElementId);

    return this.db.transaction((tx) => {
      // 1) media_fragment element + its region source-location anchor.
      const { element, location } = this.sources.createExtractWithin(tx, {
        id: elementId,
        elementType: "media_fragment",
        sourceElementId: input.sourceElementId,
        parentId: input.sourceElementId,
        locationSourceElementId: input.sourceElementId,
        title,
        priority: input.priority,
        stage: "raw_extract",
        selectedText,
        blockIds,
        page,
        region: input.region,
        label,
      });

      // 2) seed the caption body + its stable block.
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

      // 3) derived_from edge media_fragment → source (lineage is sacred).
      this.elements.addRelationWithin(tx, {
        fromElementId: element.id,
        toElementId: input.sourceElementId,
        relationType: "derived_from",
      });

      // 4) inherit the source's tags (priority inherited via the element above).
      for (const tagName of inheritedTags) {
        this.elements.addTagWithin(tx, element.id, tagName);
      }

      // 5) initial ATTENTION due date + status scheduled (a region fragment is an
      //    attention-scheduled topic, NEVER FSRS — no review_states row).
      const dueAt = addDays(nowIso(), rawExtractIntervalDays(input.priority));
      const scheduled = this.elements.rescheduleWithin(tx, element.id, dueAt, "scheduled");

      return { element: scheduled, location };
    });
  }

  /**
   * Create a media CLIP extract (T074) — a `media_fragment` element anchoring a
   * `{ startMs, endMs }` time window onto the original media. Mirrors
   * {@link createRegionExtract} but: the `source_locations` anchor carries
   * `timestampMs = startMs` + a `clip = { startMs, endMs }` window (NOT a page+region),
   * the body is the transcript segment under the range (or a generated caption when
   * transcript-less), the label reads "Clip M:SS–M:SS", and there is NO asset — a clip
   * is a TIME WINDOW on the existing media, not a cut/re-encoded sub-file (the reader
   * + the T075 audio card seek the original between the two times, keeping the app
   * `ffmpeg`-free). Everything else matches the extraction path: a `derived_from` edge,
   * inherited priority/tags, and an initial ATTENTION `due_at` (NEVER FSRS — no
   * `review_states` row). All of it commits in ONE transaction (`create_element` +
   * `create_extract`). Returns the new `media_fragment` + its clip source-location.
   *
   * Validation of `0 ≤ startMs < endMs ≤ durationMs` is the caller's job (the
   * main-side `MediaClipService`, which knows the media `durationMs`); this method
   * asserts only the cheap `startMs < endMs` invariant so a corrupt window never
   * reaches the DB.
   */
  createClipExtract(input: CreateClipExtractInput): ExtractionResult {
    const startMs = Math.floor(input.startMs);
    const endMs = Math.floor(input.endMs);
    if (!(startMs >= 0 && endMs > startMs)) {
      throw new Error(
        `ExtractionService.createClipExtract: invalid clip window [${input.startMs}, ${input.endMs})`,
      );
    }
    const elementId = input.elementId ?? newElementId();
    const label = deriveClipLabel(startMs, endMs);
    // The title prefers an explicit caption, then a trimmed transcript prefix, then
    // the clip label — never empty (the snapshot must never dead-end).
    const segment = (input.transcriptSegment ?? "").trim();
    const title = (input.caption ?? "").trim() || (segment ? titleFromSelection(segment) : label);
    // The body holds the transcript segment (as paragraphs) when present, else a
    // caption paragraph ("Clip M:SS–M:SS") so the fragment reads as a mini-topic.
    const conversion = plainTextToProseMirrorDoc(segment || label);
    // `selectedText` snapshots the transcript segment under the range; else the label.
    const selectedText = segment || label;
    const clip: ClipWindow = { startMs, endMs };
    const inheritedTags = this.elements.listTags(input.sourceElementId);

    return this.db.transaction((tx) => {
      // 1) media_fragment element + its clip source-location anchor.
      const { element, location } = this.sources.createExtractWithin(tx, {
        id: elementId,
        elementType: "media_fragment",
        sourceElementId: input.sourceElementId,
        parentId: input.sourceElementId,
        locationSourceElementId: input.sourceElementId,
        title,
        priority: input.priority,
        stage: "raw_extract",
        selectedText,
        blockIds: [input.anchorBlockId],
        timestampMs: startMs,
        clip,
        label,
      });

      // 2) seed the transcript-segment/caption body + its stable blocks.
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

      // 3) derived_from edge media_fragment → source (lineage is sacred).
      this.elements.addRelationWithin(tx, {
        fromElementId: element.id,
        toElementId: input.sourceElementId,
        relationType: "derived_from",
      });

      // 4) inherit the source's tags (priority inherited via the element above).
      for (const tagName of inheritedTags) {
        this.elements.addTagWithin(tx, element.id, tagName);
      }

      // 5) initial ATTENTION due date + status scheduled (a clip fragment is an
      //    attention-scheduled topic, NEVER FSRS — no review_states row).
      const dueAt = addDays(nowIso(), rawExtractIntervalDays(input.priority));
      const scheduled = this.elements.rescheduleWithin(tx, element.id, dueAt, "scheduled");

      return { element: scheduled, location };
    });
  }

  /** Derive a human label for the anchor from the source's ordered blocks. */
  private deriveLabel(
    sourceElementId: ElementId,
    firstBlockId: BlockId | undefined,
    page?: number | null,
  ): string {
    if (!firstBlockId) return "Selected text";
    const blocks: LabelBlock[] = this.documents
      .listBlocks(sourceElementId)
      .map((b) => ({ stableBlockId: b.stableBlockId, blockType: b.blockType, order: b.order }));
    return deriveSourceLocationLabel(blocks, firstBlockId, page);
  }
}

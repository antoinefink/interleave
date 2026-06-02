/**
 * OcrService (T066) — the main-side OCR orchestrator.
 *
 * OCR runs on the T058 background runner: a DB-FREE `utilityProcess` worker runs
 * `tesseract.js` WASM on a page image MAIN prepared, and posts the recognized text
 * + confidence back. THIS service is the main-owned glue around that:
 *
 *  - {@link enqueuePage} — MAIN writes the renderer-supplied page PNG to the vault
 *    (`assets/sources/<id>/ocr/page-N.png`) FIRST, then enqueues an `ocr` job
 *    carrying ONLY the vault-relative path (never bytes — a persisted `jobs` row
 *    must not hold a binary blob). The worker resolves that path against the vault
 *    root it reads from `INTERLEAVE_ASSETS_DIR` (the fork-env seam) and OCRs it.
 *  - {@link applyResult} — the runner's `ocr` apply handler calls this: it UPSERTS
 *    the recognized text into the `ocr_pages` layer (status `suggested`, idempotent
 *    by `(source, page)`) and writes the durable `ocr/page-N.json` to the vault. It
 *    NEVER merges into the body — confidence is attached, the text is opt-in.
 *  - {@link acceptPage} — the user's explicit Accept: it MERGES the page's OCR text
 *    into the body's empty "Page N" run through the normal document-save path
 *    (logging `update_document`), so accepted OCR becomes ordinary searchable /
 *    extractable body text, and flips the `ocr_pages` row to `accepted`.
 *  - {@link listForSource} / {@link dismissPage} — the reader's read + dismiss.
 *
 * The renderer reaches all of this ONLY through typed `sources.runOcr` /
 * `sources.getOcr` / `sources.acceptOcr` commands — never a generic `jobs.enqueue`.
 */

import { Readable } from "node:stream";
import type {
  BlockId,
  ElementId,
  PlainTextConversion,
  ProseMirrorBlockNode,
  ProseMirrorParagraphNode,
} from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  type DocumentBlockInput,
  newBlockId,
  type OcrPage,
  type OcrPagesRepository,
  type Repositories,
} from "@interleave/local-db";
import type { AssetVaultService } from "./asset-vault-service";
import type { JobRunner } from "./job-runner";

/** The worker's `ocr` result `data` shape (validated at this apply boundary). */
export interface OcrResultData {
  readonly page: number;
  readonly text: string;
  readonly meanConfidence: number;
  readonly words: ReadonlyArray<{
    text: string;
    confidence: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  }>;
}

/** The `ocr` job payload MAIN enqueues (only a vault-relative path — never bytes). */
export interface OcrJobPayload {
  readonly sourceElementId: string;
  readonly page: number;
  /** Vault-relative path to the page PNG MAIN rendered + wrote BEFORE enqueueing. */
  readonly imagePagePath: string;
}

/** A renderer-safe OCR page summary (the suggestion + its confidence + status). */
export interface OcrPageSummary {
  readonly page: number;
  readonly text: string;
  readonly meanConfidence: number;
  readonly status: string;
}

/** Constructor dependencies (built lazily against the open DB). */
export interface OcrServiceDeps {
  readonly db: InterleaveDatabase;
  readonly repositories: Repositories;
  readonly assetVault: AssetVaultService;
  /** Resolve the runner lazily so a contract-only test that never OCRs can open the DB. */
  readonly getRunner: () => JobRunner;
}

export class OcrService {
  private readonly repositories: Repositories;
  private readonly ocrPages: OcrPagesRepository;
  private readonly assetVault: AssetVaultService;
  private readonly getRunner: () => JobRunner;

  constructor(deps: OcrServiceDeps) {
    this.repositories = deps.repositories;
    this.ocrPages = deps.repositories.ocrPages;
    this.assetVault = deps.assetVault;
    this.getRunner = deps.getRunner;
  }

  /**
   * Write a renderer-supplied page PNG into the vault, then enqueue an `ocr` job
   * pointing at its vault-relative path (never the bytes). Returns the enqueued
   * job id. The page image is keyed by the source (`ocr/page-N.png`), so a re-OCR
   * overwrites the same file (idempotent like the apply).
   */
  async enqueuePage(input: {
    sourceElementId: ElementId;
    page: number;
    imagePng: ArrayBuffer;
  }): Promise<{ jobId: string }> {
    const relPath = `sources/${input.sourceElementId}/ocr/page-${input.page}.png`;
    await this.assetVault.importAsset({
      owningElementId: input.sourceElementId,
      kind: "snapshot",
      source: Readable.from(Buffer.from(input.imagePng)),
      mime: "image/png",
      destRelativePath: relPath,
    });
    const payload: OcrJobPayload = {
      sourceElementId: input.sourceElementId,
      page: input.page,
      imagePagePath: relPath,
    };
    const job = this.getRunner().enqueue("ocr", { ...payload });
    return { jobId: job.id };
  }

  /**
   * Apply a worker `ocr` result (the runner apply handler): UPSERT the recognized
   * text into `ocr_pages` (status `suggested`, idempotent by `(source, page)`) +
   * write the durable `ocr/page-N.json` to the vault. Returns a small serializable
   * summary. NEVER merges into the body (the text is a confidence-flagged
   * suggestion until the user accepts it).
   */
  async applyResult(payload: OcrJobPayload, result: OcrResultData): Promise<OcrPageSummary> {
    const sourceElementId = payload.sourceElementId as ElementId;
    const page = result.page;
    const stored = this.ocrPages.upsertPage({
      sourceElementId,
      page,
      text: result.text,
      meanConfidence: result.meanConfidence,
      words: result.words.map((w) => ({
        text: w.text,
        confidence: w.confidence,
        bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
      })),
      status: "suggested",
    });

    // Durable export copy in the vault (the `ocr.json` analog the architecture
    // layout names). Best-effort — the SQLite row is the queryable source of truth.
    try {
      const json = JSON.stringify({
        page,
        text: result.text,
        meanConfidence: result.meanConfidence,
        words: result.words,
      });
      await this.assetVault.importAsset({
        owningElementId: sourceElementId,
        kind: "snapshot",
        source: Readable.from(Buffer.from(json, "utf8")),
        mime: "application/json",
        destRelativePath: `sources/${sourceElementId}/ocr/page-${page}.json`,
      });
    } catch {
      // The vault json is a durable copy; a write failure does not fail the apply.
    }

    return {
      page: stored.page,
      text: stored.text,
      meanConfidence: stored.meanConfidence,
      status: stored.status,
    };
  }

  /** All OCR page suggestions for a source (the reader's read surface). */
  listForSource(sourceElementId: ElementId): OcrPageSummary[] {
    return this.ocrPages.listForSource(sourceElementId).map((p) => ({
      page: p.page,
      text: p.text,
      meanConfidence: p.meanConfidence,
      status: p.status,
    }));
  }

  /**
   * Accept a page's OCR text into the body (an explicit user action). Merges the
   * recognized lines as paragraphs after the page's "Page N" heading (replacing the
   * empty body the T064 importer left), through the normal document-save path
   * (logging `update_document` + updating `plainText` → FTS, so the accepted text
   * is searchable/extractable), and flips the `ocr_pages` row to `accepted`. A
   * no-op (returns `false`) when there is no suggestion or it is already accepted.
   */
  acceptPage(sourceElementId: ElementId, page: number): { accepted: boolean } {
    const ocr = this.ocrPages.findPage(sourceElementId, page);
    if (!ocr || ocr.status === "accepted") return { accepted: false };

    const doc = this.repositories.documents.findById(sourceElementId);
    if (!doc) return { accepted: false };
    const existingBlocks = this.repositories.documents.listBlocks(sourceElementId);

    const merged = mergeOcrIntoBody(doc.prosemirrorJson, existingBlocks, page, ocr.text);
    if (!merged) return { accepted: false };

    this.repositories.documents.upsert({
      elementId: sourceElementId,
      prosemirrorJson: merged.doc,
      plainText: merged.plainText,
      blocks: merged.blocks,
    });
    this.ocrPages.setStatus(ocr.id, "accepted");
    return { accepted: true };
  }

  /** Dismiss a page's OCR suggestion (sets `dismissed`). */
  dismissPage(sourceElementId: ElementId, page: number): { dismissed: boolean } {
    const ocr = this.ocrPages.findPage(sourceElementId, page);
    if (!ocr) return { dismissed: false };
    this.ocrPages.setStatus(ocr.id, "dismissed");
    return { dismissed: true };
  }
}

/** A `document_blocks` row shape (the subset this merge reads). */
interface BlockRow {
  readonly blockType: string;
  readonly order: number;
  readonly stableBlockId: string;
  readonly page: number | null;
}

/** The merged-body result (doc JSON + plainText + the new ordered block list). */
interface MergedBody {
  readonly doc: PlainTextConversion["doc"];
  readonly plainText: string;
  readonly blocks: DocumentBlockInput[];
}

/**
 * Merge `ocrText` (one page's recognized text) into the document body: insert one
 * `paragraph` per non-empty OCR line directly AFTER the page's "Page N" heading,
 * each minted a fresh stable block id + tagged with the page. The body's other
 * pages are untouched. Returns `null` when the page's heading block cannot be
 * found (nothing to anchor to). Pure aside from `newBlockId` (id minting).
 */
function mergeOcrIntoBody(
  prosemirrorJson: unknown,
  existingBlocks: readonly BlockRow[],
  page: number,
  ocrText: string,
): MergedBody | null {
  const doc = prosemirrorJson as { type: string; content?: ProseMirrorBlockNode[] };
  const content = Array.isArray(doc.content) ? [...doc.content] : [];

  // The page's heading is the FIRST block tagged with this page (a "Page N" run).
  const pageHeadingBlockId =
    existingBlocks.find((b) => b.page === page && b.blockType === "heading")?.stableBlockId ?? null;
  if (!pageHeadingBlockId) return null;

  // Find the heading node's index in the doc content by its blockId.
  const headingIdx = content.findIndex((node) => blockIdOf(node) === pageHeadingBlockId);
  if (headingIdx < 0) return null;

  // Build a paragraph per OCR line.
  const lines = ocrText
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
  const newParagraphs: ProseMirrorParagraphNode[] = lines.map((text) => ({
    type: "paragraph",
    attrs: { blockId: newBlockId() },
    content: [{ type: "text", text }],
  }));

  // Insert the paragraphs right after the page heading.
  content.splice(headingIdx + 1, 0, ...newParagraphs);

  // Rebuild the ordered block list (preserving each existing block's page) and the
  // plainText mirror from the new doc content.
  const blocksByPage = new Map<string, number | null>();
  for (const b of existingBlocks) blocksByPage.set(b.stableBlockId, b.page);

  const blocks: DocumentBlockInput[] = [];
  const plainParts: string[] = [];
  let order = 0;
  for (const node of content) {
    const blockId = blockIdOf(node);
    if (!blockId) continue;
    const nodePage = blocksByPage.has(blockId)
      ? (blocksByPage.get(blockId) ?? null)
      : // A freshly inserted OCR paragraph belongs to this page.
        page;
    blocks.push({
      blockType: node.type,
      order,
      stableBlockId: blockId as BlockId,
      page: nodePage,
    });
    order += 1;
    const text = textOf(node);
    if (text.length > 0) plainParts.push(text);
  }

  return {
    doc: { type: "doc", content },
    plainText: plainParts.join("\n"),
    blocks,
  };
}

/** The `blockId` attr of a node, or `null`. */
function blockIdOf(node: ProseMirrorBlockNode): string | null {
  const attrs = (node as { attrs?: { blockId?: unknown } }).attrs;
  return typeof attrs?.blockId === "string" ? attrs.blockId : null;
}

/** The flattened text of a block node (its direct text children). */
function textOf(node: ProseMirrorBlockNode): string {
  const content = (node as { content?: Array<{ type: string; text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join("")
    .trim();
}

// Re-export for the typed list signature used by the IPC layer.
export type { OcrPage };

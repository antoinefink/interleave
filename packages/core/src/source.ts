/**
 * Source & Document types (T005).
 *
 * A `Source` is the provenance side-table for a `source`-type {@link Element}
 * (`sources` table, keyed by `elementId`); a `Document` is the editable body
 * (`documents` table). Together they preserve the bottom of the lineage chain —
 * the origin metadata and original document context a card must be able to trace
 * back to. These are plain data shapes (no React/Drizzle/better-sqlite3).
 *
 * The ProseMirror document is the substrate for extraction lineage: blocks carry
 * stable IDs and marks carry highlight/extracted-span/processed-span/cloze
 * annotations. Those structures are detailed in `domain-model.md`; here we model
 * the row-level vocabulary the rest of the app imports.
 */

import type { BlockId, ElementId, IsoTimestamp } from "./ids";
import type { ConfidenceLevel, ReliabilityTier, SourceType } from "./source-ref";

/**
 * Provenance metadata for a `source` element (`sources` table). `snapshotKey`
 * points at the saved snapshot asset in the vault (the bytes are NOT in SQLite).
 * `readPoint` mirrors the last read position for quick resume. Most fields are
 * optional because manual imports may omit them (auto-fetch lands later, M12).
 */
export interface Source {
  /** Mirrors the owning `source` element's id (one-to-one). */
  readonly elementId: ElementId;
  /** As-entered URL, if the source came from the web. */
  url: string | null;
  /** Normalized URL used for duplicate detection (tracking params stripped). */
  canonicalUrl: string | null;
  /** Original/pre-redirect URL, preserved for provenance. */
  originalUrl: string | null;
  author: string | null;
  publishedAt: IsoTimestamp | null;
  /** When the user imported/snapshotted the source. */
  accessedAt: IsoTimestamp | null;
  /** Vault key/relative path of the saved snapshot asset, if any. */
  snapshotKey: string | null;
  /** Why the user added this source (free text), aiding later triage. */
  reasonAdded: string | null;
  /**
   * The MEDIA discriminator (T073): `"video"`/`"audio"` for a local media file
   * streamed into the vault, `"youtube"` for a referenced YouTube embed (no local
   * bytes), and `null` for every non-media source. The authoritative signal the
   * media reader keys off (NOT a snapshot-key derivation).
   */
  mediaKind: MediaKind | null;
  /**
   * Source-reliability metadata (T091) — how trustworthy the source is. All four are
   * nullable (a source with no reliability data is the unchanged pre-T091 render).
   * User-entered only; auto-classification is out of scope (that needs AI — T093+).
   */
  /** The source KIND (`paper`/`book`/…), or `null`. */
  sourceType: SourceType | null;
  /** The source TIER (`primary`/`secondary`/`tertiary`), or `null`. */
  reliabilityTier: ReliabilityTier | null;
  /** The user's CONFIDENCE in the source (`high`/`medium`/`low`), or `null`. */
  confidence: ConfidenceLevel | null;
  /** Free-text reliability caveats / known biases, or `null`. */
  reliabilityNotes: string | null;
}

/**
 * The kind of media a `source` is (T073) — the `sources.media_kind` discriminator.
 * `"video"`/`"audio"` denote a local file whose original bytes live in the asset
 * vault; `"youtube"` denotes a referenced YouTube embed (the canonical URL is the
 * reference — the bytes are NOT downloaded).
 */
export type MediaKind = "video" | "audio" | "youtube";

/** The ProseMirror schema version a stored document was authored against. */
export type DocumentSchemaVersion = number;

/**
 * An editable rich-text body for an element (`documents` table). Stores the
 * ProseMirror JSON (as an opaque structure) plus a flattened `plainText`
 * mirror used for full-text search and previews. Block-level stable IDs and
 * marks live in `document_blocks` / `document_marks` (modeled in `packages/db`);
 * they are the anchors extracts and read-points depend on.
 */
export interface Document {
  /** Mirrors the owning element's id (one-to-one). */
  readonly elementId: ElementId;
  /**
   * ProseMirror document JSON. Typed as `unknown` here on purpose: `packages/core`
   * stays framework-agnostic and must not depend on the editor's node schema
   * (that lives in `packages/editor`). Repositories/editor narrow it.
   */
  prosemirrorJson: unknown;
  /** Flattened text mirror for search/preview; kept in sync with the JSON. */
  plainText: string;
  schemaVersion: DocumentSchemaVersion;
  updatedAt: IsoTimestamp;
}

/**
 * Durable processing outcomes for source document blocks.
 *
 * These are keyed to `source_element_id + stable_block_id` in SQLite. A missing
 * row is interpreted as `unread`, but `unread` is still a valid explicit row so
 * the user can restore a block even when a past read-point would otherwise derive
 * `read`.
 */
export const SOURCE_BLOCK_PROCESSING_STATES = [
  "unread",
  "read",
  "extracted",
  "ignored",
  "processed_without_output",
  "needs_later",
  "stale_after_edit",
] as const;
export type SourceBlockProcessingState = (typeof SOURCE_BLOCK_PROCESSING_STATES)[number];

/** States that count as terminal processing for source completion. */
export const TERMINAL_SOURCE_BLOCK_PROCESSING_STATES = [
  "extracted",
  "ignored",
  "processed_without_output",
] as const satisfies readonly SourceBlockProcessingState[];

export function isTerminalSourceBlockProcessingState(state: SourceBlockProcessingState): boolean {
  return (TERMINAL_SOURCE_BLOCK_PROCESSING_STATES as readonly string[]).includes(state);
}

/** Reader/service actions recorded as metadata on the latest block-processing row. */
export const SOURCE_BLOCK_PROCESSING_ACTIONS = [
  "mark_unread",
  "mark_read",
  "mark_ignored",
  "mark_processed_without_output",
  "mark_needs_later",
  "mark_extracted",
  "mark_stale_after_edit",
  "legacy_processed_span_backfill",
  "reconcile_document_blocks",
] as const;
export type SourceBlockProcessingAction = (typeof SOURCE_BLOCK_PROCESSING_ACTIONS)[number];

/** Output kinds that can be linked back to a processed source block. */
export const SOURCE_BLOCK_OUTPUT_TYPES = ["extract", "card"] as const;
export type SourceBlockOutputType = (typeof SOURCE_BLOCK_OUTPUT_TYPES)[number];

export interface SourceBlockProcessing {
  readonly id: string;
  readonly sourceElementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly state: SourceBlockProcessingState;
  readonly blockContentHash: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly lastAction: SourceBlockProcessingAction | null;
  readonly lastActionAt: IsoTimestamp | null;
}

export interface SourceBlockProcessingOutput {
  readonly id: string;
  readonly sourceElementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly outputElementId: ElementId;
  readonly outputType: SourceBlockOutputType;
  readonly sourceLocationId: string | null;
  readonly createdAt: IsoTimestamp;
}

export type SourceBlockProcessingDerivation =
  | "explicit"
  | "read_point"
  | "legacy_processed_span"
  | "missing";

export interface SourceBlockProcessingView {
  readonly sourceElementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly order: number;
  readonly state: SourceBlockProcessingState;
  readonly storedState: SourceBlockProcessingState | null;
  readonly blockContentHash: string | null;
  readonly outputElementIds: readonly ElementId[];
  readonly derivedFrom: SourceBlockProcessingDerivation;
}

export interface SourceBlockProcessingSummary {
  readonly sourceElementId: ElementId;
  readonly totalBlocks: number;
  readonly processedBlocks: number;
  readonly terminalBlocks: number;
  readonly unresolvedBlocks: number;
  readonly highPriorityUnresolvedBlocks: number;
  readonly extractedBlockCount: number;
  readonly extractedOutputCount: number;
  readonly ignoredBlocks: number;
  readonly ignoredRatio: number;
  readonly terminalRatio: number;
  readonly staleAfterEditBlocks: number;
  readonly legacyProjectedBlocks: number;
  readonly canMarkDoneWithoutConfirmation: boolean;
  readonly stateCounts: Readonly<Record<SourceBlockProcessingState, number>>;
}

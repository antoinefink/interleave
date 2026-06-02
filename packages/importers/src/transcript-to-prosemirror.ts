/**
 * Transcript cues → constrained ProseMirror document (T073).
 *
 * A transcript has no semantic blocks, so this imposes a deterministic,
 * lineage-stable structure on the {@link TranscriptCue} list (mirroring T064's
 * page-mapping model): a `heading` (level 2) carrying the media title opens the
 * body, followed by ONE `paragraph` per caption cue. Every row-bearing node is
 * minted ONE stable `blockId` (the default minter is the editor's ULID; injectable
 * for tests) and each cue paragraph is tagged with its START `timestampMs` in the
 * parallel `blocks` list — the canonical block→time map (`document_blocks.timestamp_ms`)
 * the timestamp read-point + the T074 clip path read. The title heading carries no
 * timestamp (`null`).
 *
 * NO transcript (an empty cue list — a transcript-less local file, or a YouTube
 * video with captions disabled) → a VALID doc with the title heading + ONE
 * placeholder paragraph, so the source is never lost and T074 still works via manual
 * timestamp selection.
 *
 * The output is the SAME `{ doc, plainText, blocks }` `PlainTextConversion` shape
 * the other importers return, so the source pipeline (`createWithDocument`) stores
 * it verbatim. It validates against `buildSchema()`: every node ∈ `ALLOWED_NODE_NAMES`,
 * every mark ∈ `ALLOWED_MARK_NAMES` (the body uses only `heading`/`paragraph`/`text`).
 *
 * `plainText` is the cue texts joined, each prefixed with a `[m:ss]` timestamp, so
 * search/preview reads naturally (the same mirror convention the other importers use).
 *
 * Pure: no I/O, no Electron. Imports ONLY the React-free block-id minter from
 * `@interleave/editor/block-ids`.
 */

import type {
  PlainTextConversion,
  ProseMirrorBlock,
  ProseMirrorBlockNode,
  ProseMirrorHeadingNode,
  ProseMirrorParagraphNode,
} from "@interleave/core";
import { type BlockIdMinter, newBlockId } from "@interleave/editor/block-ids";
import type { TranscriptCue } from "./transcript";

/** The heading level used for the media-title block. */
const TITLE_HEADING_LEVEL = 2;

/** The placeholder body used when a media source has no transcript. */
const NO_TRANSCRIPT_PLACEHOLDER =
  "No transcript available — play the media and set timestamp read-points; clip by selecting a start/end time.";

/** Arguments to {@link transcriptToProseMirrorDoc}. */
export interface TranscriptToProseMirrorInput {
  /** The media title (heads the body as a level-2 heading). */
  readonly title: string;
  /** The transcript cues in document order; empty → the placeholder body. */
  readonly cues: readonly TranscriptCue[];
}

/**
 * Format a millisecond start as a compact `[m:ss]` / `[h:mm:ss]` label for the
 * `plainText` mirror (e.g. `[0:42]`, `[1:03:07]`).
 */
function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `[${hours}:${String(minutes).padStart(2, "0")}:${ss}]`;
  }
  return `[${minutes}:${ss}]`;
}

/**
 * Convert a media title + transcript cues into the constrained
 * `{ doc, plainText, blocks }` conversion. A level-2 title heading + one paragraph
 * per cue (each tagged with its `timestampMs` in the `blocks` mirror); an empty cue
 * list → the title heading + one placeholder paragraph.
 *
 * @param input the media title + ordered cues.
 * @param mint optional block-id minter (defaults to the editor's ULID minter).
 */
export function transcriptToProseMirrorDoc(
  input: TranscriptToProseMirrorInput,
  mint: BlockIdMinter = newBlockId,
): PlainTextConversion {
  const content: ProseMirrorBlockNode[] = [];
  const blocks: ProseMirrorBlock[] = [];

  const title = input.title.trim().length > 0 ? input.title.trim() : "Media";

  // The title heading (one id-bearing row; no timestamp).
  const titleId = mint();
  const heading: ProseMirrorHeadingNode = {
    type: "heading",
    attrs: { level: TITLE_HEADING_LEVEL, blockId: titleId },
    content: [{ type: "text", text: title }],
  };
  content.push(heading);
  blocks.push({ blockType: "heading", order: 0, stableBlockId: titleId, timestampMs: null });

  const plainTextParts: string[] = [title];

  if (input.cues.length === 0) {
    // No transcript → a valid placeholder paragraph (`timestamp_ms` stays null).
    const placeholderId = mint();
    const placeholder: ProseMirrorParagraphNode = {
      type: "paragraph",
      attrs: { blockId: placeholderId },
      content: [{ type: "text", text: NO_TRANSCRIPT_PLACEHOLDER }],
    };
    content.push(placeholder);
    blocks.push({
      blockType: "paragraph",
      order: 1,
      stableBlockId: placeholderId,
      timestampMs: null,
    });
    return {
      doc: { type: "doc", content },
      // The placeholder text is NOT in `plainText` — the title is the only mirror,
      // so a transcript-less source's search/preview is just its title.
      plainText: title,
      blocks,
    };
  }

  // One paragraph per cue, tagged with its start time.
  for (const cue of input.cues) {
    const id = mint();
    const paragraph: ProseMirrorParagraphNode = {
      type: "paragraph",
      attrs: { blockId: id },
      content: [{ type: "text", text: cue.text }],
    };
    content.push(paragraph);
    blocks.push({
      blockType: "paragraph",
      order: blocks.length,
      stableBlockId: id,
      timestampMs: cue.startMs,
    });
    plainTextParts.push(`${formatTimestamp(cue.startMs)} ${cue.text}`);
  }

  return {
    doc: { type: "doc", content },
    plainText: plainTextParts.join("\n"),
    blocks,
  };
}

/** Re-export so callers can build a deterministic test minter. */
export type { BlockIdMinter };
/** Exposed so a test can assert the exact placeholder text. */
export { NO_TRANSCRIPT_PLACEHOLDER };

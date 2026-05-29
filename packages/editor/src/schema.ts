/**
 * The constrained Interleave document schema (T015).
 *
 * Documents are the substrate for extraction lineage, not just display, so the
 * schema is deliberately **narrow**: a source body may only contain the node /
 * mark set the rest of the pipeline (block IDs in T016, marks + extraction in
 * M4) knows how to reason about. An over-broad schema (tables, images,
 * task-lists, mentions, raw HTML) would make later block-ID + mark + extraction
 * logic brittle, so we lock the schema down here and let it grow only by an
 * explicit, reviewed change — never by accident.
 *
 * The allowed set (per the M3 spec):
 *   Nodes  — Document, Paragraph, Text, Heading, Blockquote, BulletList,
 *            OrderedList, ListItem, CodeBlock, HorizontalRule, HardBreak
 *   Marks  — Bold, Italic, Link, Code
 *   Util   — History (undo/redo), Dropcursor, Gapcursor, ListKeymap
 *
 * Everything else StarterKit v3 ships by default — notably the `Strike` and
 * `Underline` marks (both included in StarterKit v3) — is **disabled** so it can
 * never enter a stored document.
 *
 * This module is framework-agnostic on purpose: it imports `@tiptap/core` and
 * `@tiptap/starter-kit` (which run under ProseMirror, usable headless in Node)
 * but **no** React. That keeps `schema.ts` unit-testable without a DOM and lets
 * the main process (or a future server) reuse the exact same schema to validate
 * stored JSON if needed.
 */

import type { Extensions } from "@tiptap/core";
import { getSchema } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { BlockId } from "./block-id";
import type { BlockIdMinter } from "./block-ids";

/** The heading levels the constrained schema permits. */
export const ALLOWED_HEADING_LEVELS = [1, 2, 3] as const;

/**
 * The marks the constrained schema permits, by ProseMirror mark name. Used by
 * tests + future validation to assert the schema does not silently grow.
 */
export const ALLOWED_MARK_NAMES = ["bold", "italic", "link", "code"] as const;

/**
 * The block/leaf node types the constrained schema permits, by ProseMirror node
 * name. `doc`/`text` are structural; the rest are the body content the reader +
 * extraction target.
 */
export const ALLOWED_NODE_NAMES = [
  "doc",
  "text",
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "codeBlock",
  "horizontalRule",
  "hardBreak",
] as const;

/**
 * Marks StarterKit v3 ships by default that are explicitly **out** of the
 * constrained set. Exported so tests can assert the schema never silently
 * regrows them; they are disabled by their StarterKit config key in
 * {@link buildExtensions} so the schema cannot accept them on paste / import /
 * round-trip.
 */
export const DISABLED_STARTER_KIT_MARKS = ["strike", "underline"] as const;

/** Options for {@link buildExtensions}. */
export interface BuildExtensionsOptions {
  /**
   * Include the stable-block-id extension (T016): adds the global `blockId`
   * attribute + the additive filler that mints a ULID for any block lacking one.
   * Defaults to `true` — the editor always wants stable ids. Set `false` only for
   * a pure headless schema where the filler plugin (and its randomness) is
   * irrelevant; the `blockId` attribute is harmless extra metadata either way.
   */
  readonly withBlockIds?: boolean;
  /** Override the block-id minter (tests inject a deterministic one). */
  readonly mintBlockId?: BlockIdMinter;
  /** Extra extensions appended after the constrained set. */
  readonly extra?: Extensions;
}

/**
 * Build the constrained Tiptap extension array. By default it includes the
 * stable-block-id extension (T016); pass `withBlockIds: false` to omit it, or
 * `extra` to append further extensions, without re-deriving the StarterKit config.
 *
 * StarterKit is configured to enable only the allowed set; `link` is locked down
 * (no auto-open, `https` default protocol, `noopener` rel) since the reader is a
 * trusted local surface but stored links are user content.
 */
export function buildExtensions(options: BuildExtensionsOptions = {}): Extensions {
  const { withBlockIds = true, mintBlockId, extra = [] } = options;
  return [
    StarterKit.configure({
      heading: { levels: [...ALLOWED_HEADING_LEVELS] },
      // Disable the StarterKit marks that are outside the constrained set.
      strike: false,
      underline: false,
      // Lock down link behaviour; it stays in the allowed mark set.
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        HTMLAttributes: { rel: "noopener noreferrer nofollow" },
      },
    }),
    ...(withBlockIds ? [mintBlockId ? BlockId.configure({ mintBlockId }) : BlockId] : []),
    ...extra,
  ];
}

/**
 * The canonical constrained extension array (with stable block ids). The React
 * editor builds from this so it can never drift from the schema.
 */
export const interleaveExtensions: Extensions = buildExtensions();

/**
 * The compiled ProseMirror {@link Schema} for the constrained document. Useful
 * for headless validation (parse stored JSON, reject disallowed nodes/marks)
 * without instantiating a full editor or touching the DOM. The `blockId` global
 * attribute is part of the schema so stored ids round-trip through it.
 */
export function buildSchema(extra: Extensions = []): Schema {
  return getSchema(buildExtensions({ extra }));
}

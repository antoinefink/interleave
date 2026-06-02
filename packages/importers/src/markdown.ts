/**
 * Markdown ↔ constrained ProseMirror transforms (T068) — the pure, I/O-free pair.
 *
 * `markdownToProseMirrorDoc` parses Markdown into the SAME
 * `{ doc, plainText, blocks }` `PlainTextConversion` shape `htmlToProseMirrorDoc`
 * produces (so the source pipeline `createWithDocument` stores it verbatim), and
 * `proseMirrorDocToMarkdown` serializes a stored constrained `ProseMirrorDoc` back
 * to Markdown. Together they are the ROUND-TRIP pair the roadmap's "exported
 * Markdown round-trips back with acceptable fidelity" criterion is tested against.
 *
 * ## Why `markdown-it` for import (decision, documented here)
 *
 * `markdown-it` is the de-facto, pure-JS, CommonMark-compliant Markdown parser. It
 * produces a flat **token stream** (not a DOM), which we walk DIRECTLY into the
 * constrained node set — no intermediate HTML re-parse. Chosen over `marked`
 * (HTML-string output → an unnecessary linkedom round-trip + a fidelity loss on
 * code/links) and `remark`/`unified` (a much larger mdast + plugin tree we don't
 * need). `markdown-it`'s tokens map cleanly 1:1 onto our constrained block set
 * (heading / paragraph / blockquote / bullet_list / ordered_list / list_item /
 * fence(code) / hr) + inline marks (strong / em / link / code). Pure JS, no native
 * deps, bundles cleanly into `main.cjs`. Raw-HTML passthrough is OFF (`html:
 * false`) so inline HTML in a Markdown file is escaped, never injected — keeping
 * the import safe and the schema constrained.
 *
 * ## Why a HAND-WRITTEN serializer for export (decision, documented here)
 *
 * Markdown EXPORT needs NO new dependency. The constrained schema is tiny (≤8
 * block types, 4 marks), so a small hand-written serializer that walks the
 * `ProseMirrorBlockNode` union is simpler, dependency-free, and gives us EXACT
 * control over the round-trip normalization than pulling `prosemirror-markdown`
 * (which assumes the full prosemirror-schema-basic schema + real prosemirror `Node`
 * instances we never construct on the core side). Determinism is load-bearing: a
 * fixed normalization is what makes the round-trip a fixed point.
 *
 * ## Fidelity ceiling (documented)
 *
 * The constrained schema is the fidelity ceiling: anything it cannot represent —
 * images (`![alt](src)` → the alt text only), code-block language, tables, HTML
 * passthrough, footnotes, task lists, strikethrough — is normalized away on import
 * and is NOT expected to round-trip. Block ids are freshly minted each import, so
 * round-trip equality is "structurally equal modulo block ids".
 *
 * The module imports ONLY the React-free block-id module of `@interleave/editor`
 * (never the barrel that re-exports React), so it bundles cleanly into main.
 *
 * Pure: no network, no `fs`, no Electron. Empty/whitespace Markdown → a valid empty
 * doc.
 */

import type {
  BlockId,
  PlainTextConversion,
  ProseMirrorBlock,
  ProseMirrorBlockNode,
  ProseMirrorBlockquoteNode,
  ProseMirrorBulletListNode,
  ProseMirrorCodeBlockNode,
  ProseMirrorDoc,
  ProseMirrorHeadingLevel,
  ProseMirrorHeadingNode,
  ProseMirrorHorizontalRuleNode,
  ProseMirrorInlineNode,
  ProseMirrorListItemNode,
  ProseMirrorMark,
  ProseMirrorOrderedListNode,
  ProseMirrorParagraphNode,
  ProseMirrorTextNode,
} from "@interleave/core";
import { type BlockIdMinter, newBlockId } from "@interleave/editor/block-ids";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

// ===========================================================================
// Import — Markdown → constrained ProseMirror
// ===========================================================================

/**
 * A single shared CommonMark parser. `html: false` drops raw-HTML passthrough
 * (inline HTML in the Markdown is escaped, not injected); `linkify`/`typographer`
 * stay off so the output is a faithful, deterministic mirror of the source text.
 */
const md = new MarkdownIt("commonmark", { html: false, linkify: false, typographer: false });

/** Clamp an `h1`–`h6` Markdown heading to the allowed 1–3 level set. */
function clampHeadingLevel(tag: string): ProseMirrorHeadingLevel {
  const n = Number.parseInt(tag.slice(1), 10);
  if (n <= 1) return 1;
  if (n === 2) return 2;
  return 3;
}

/**
 * Normalize a fenced-code info string to a clean `language` (T072). markdown-it's
 * `token.info` is the raw text after the opening fence (e.g. `python`, or
 * `python title=x`); take the FIRST whitespace-separated word, lower-cased, and keep
 * only language-shaped characters. Empty/absent → `null` (a plain block).
 */
function normalizeFenceLanguage(info: string | undefined): string | null {
  const first = (info ?? "").trim().split(/\s+/)[0] ?? "";
  const cleaned = first.toLowerCase().replace(/[^\w+#.-]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Match a paragraph that is ENTIRELY a block math formula `$$…$$` (T072). markdown-it
 * does not tokenize math, so a `$$E=mc^2$$` source arrives as a paragraph whose only
 * inline text is the delimited latex. When a paragraph's flattened text is exactly
 * one `$$…$$`, we map it to a block `math` node instead of a text paragraph.
 */
const STANDALONE_BLOCK_MATH = /^\$\$([\s\S]+?)\$\$$/;

/** The active inline marks while walking an `inline` token's children. */
type MarkSet = readonly ProseMirrorMark[];

/** Add a mark to the set (deduped by type — one of each is enough for our schema). */
function withMark(marks: MarkSet, mark: ProseMirrorMark): MarkSet {
  if (marks.some((m) => m.type === mark.type)) return marks;
  return [...marks, mark];
}

/**
 * Walk an `inline` token's children (markdown-it's flat inline token list) into
 * ProseMirror inline nodes (text runs with marks + hard breaks). Image tokens are
 * flattened to their alt text (the constrained schema has no image node); raw
 * HTML is dropped (it was escaped at parse time anyway with `html: false`).
 */
function collectInline(children: readonly Token[]): ProseMirrorInlineNode[] {
  const out: ProseMirrorInlineNode[] = [];
  let marks: MarkSet = [];
  for (const tok of children) {
    switch (tok.type) {
      case "text": {
        if (tok.content.length === 0) break;
        const run: ProseMirrorTextNode =
          marks.length > 0
            ? { type: "text", text: tok.content, marks: [...marks] }
            : { type: "text", text: tok.content };
        out.push(run);
        break;
      }
      case "softbreak":
        // A soft line break inside a paragraph collapses to a space.
        out.push({ type: "text", text: " " });
        break;
      case "hardbreak":
        out.push({ type: "hardBreak" });
        break;
      case "strong_open":
        marks = withMark(marks, { type: "bold" });
        break;
      case "strong_close":
        marks = marks.filter((m) => m.type !== "bold");
        break;
      case "em_open":
        marks = withMark(marks, { type: "italic" });
        break;
      case "em_close":
        marks = marks.filter((m) => m.type !== "italic");
        break;
      case "code_inline": {
        // Inline code is its own token (no open/close); push it with the code mark.
        const codeMarks = withMark(marks, { type: "code" });
        out.push({ type: "text", text: tok.content, marks: [...codeMarks] });
        break;
      }
      case "link_open": {
        const href = tok.attrGet("href");
        if (href) marks = withMark(marks, { type: "link", attrs: { href } });
        break;
      }
      case "link_close":
        marks = marks.filter((m) => m.type !== "link");
        break;
      case "image": {
        // No image node in the constrained schema → keep the alt text as a run.
        const alt = tok.content.trim();
        if (alt.length > 0) {
          const run: ProseMirrorTextNode =
            marks.length > 0
              ? { type: "text", text: alt, marks: [...marks] }
              : { type: "text", text: alt };
          out.push(run);
        }
        break;
      }
      default:
        // html_inline / unknown inline tokens carry no representable content.
        break;
    }
  }
  return out;
}

/** Do two text runs carry the identical mark set (order-independent)? */
function sameMarks(a: ProseMirrorTextNode, b: ProseMirrorTextNode): boolean {
  const am = a.marks ?? [];
  const bm = b.marks ?? [];
  if (am.length !== bm.length) return false;
  const key = (m: ProseMirrorMark): string => `${m.type}:${(m.attrs?.href as string) ?? ""}`;
  const as = am.map(key).sort();
  const bs = bm.map(key).sort();
  return as.every((k, i) => k === bs[i]);
}

/**
 * Merge ADJACENT text runs that share an identical mark set into one run. This
 * normalizes the inline fragmentation markdown-it produces (a soft break is its own
 * token, so `"x"` + `" "` + `"y"` arrive as three runs) so the import is stable: a
 * round-trip (serialize → re-import) collapses to the SAME runs. Hard breaks split
 * runs (they are not text), as do mark changes.
 */
function mergeRuns(nodes: readonly ProseMirrorInlineNode[]): ProseMirrorInlineNode[] {
  const out: ProseMirrorInlineNode[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.type === "text" && prev && prev.type === "text" && sameMarks(prev, node)) {
      out[out.length - 1] = { ...prev, text: prev.text + node.text };
    } else {
      out.push(node);
    }
  }
  return out;
}

/** Flatten inline nodes to their concatenated text (for the plainText mirror). */
function inlineText(nodes: readonly ProseMirrorInlineNode[]): string {
  return nodes
    .map((n) => (n.type === "text" ? n.text : " "))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Accumulator threaded through the token walk. */
interface Acc {
  readonly mint: BlockIdMinter;
  readonly blocks: ProseMirrorBlock[];
  readonly plainText: string[];
}

/** Record a row-bearing block descriptor mirroring an id-bearing node. */
function recordBlock(acc: Acc, blockType: ProseMirrorBlock["blockType"], id: BlockId): void {
  acc.blocks.push({ blockType, order: acc.blocks.length, stableBlockId: id });
}

/**
 * The walk consumes markdown-it's flat token stream with a manual cursor.
 * `depth` is the list-nesting depth so nested lists never carry an id on their
 * container; ids sit on the OUTERMOST row of each row (heading/paragraph/codeBlock/
 * hr at the top level, or listItem/blockquote for wrappers — NOT their inner
 * paragraphs), exactly mirroring `htmlToProseMirrorDoc`.
 */
class TokenWalker {
  private i = 0;
  constructor(
    private readonly tokens: readonly Token[],
    private readonly acc: Acc,
  ) {}

  /** Walk to the matching close token of `openType`, returning the nodes between. */
  private walkUntil(closeType: string, topLevel: boolean): ProseMirrorBlockNode[] {
    const out: ProseMirrorBlockNode[] = [];
    while (this.i < this.tokens.length) {
      const tok = this.tokens[this.i];
      if (!tok) break;
      if (tok.type === closeType) {
        this.i += 1;
        return out;
      }
      const built = this.consumeBlock(topLevel);
      if (built) out.push(built);
    }
    return out;
  }

  /** Consume ONE block token (advancing the cursor), returning its node or null. */
  private consumeBlock(topLevel: boolean): ProseMirrorBlockNode | null {
    const tok = this.tokens[this.i];
    if (!tok) {
      this.i += 1;
      return null;
    }
    switch (tok.type) {
      case "heading_open": {
        const level = clampHeadingLevel(tok.tag);
        this.i += 1;
        const inline = this.takeInline();
        this.expectClose("heading_close");
        if (inline.length === 0) return null;
        const id = this.acc.mint();
        recordBlock(this.acc, "heading", id);
        this.acc.plainText.push(inlineText(inline));
        const node: ProseMirrorHeadingNode = {
          type: "heading",
          attrs: { level, blockId: id },
          content: inline,
        };
        return node;
      }
      case "paragraph_open": {
        this.i += 1;
        const inline = this.takeInline();
        this.expectClose("paragraph_close");
        if (inline.length === 0) return null;
        if (topLevel) {
          const id = this.acc.mint();
          recordBlock(this.acc, "paragraph", id);
          // T072: a paragraph that is ENTIRELY `$$…$$` becomes a block math formula
          // (a `display:true` math node alone in its paragraph; the row id stays on
          // the paragraph). Otherwise it is a normal text paragraph.
          const flat = inlineText(inline);
          const blockMath = STANDALONE_BLOCK_MATH.exec(flat.trim());
          if (blockMath) {
            const latex = (blockMath[1] ?? "").trim();
            this.acc.plainText.push(`$$${latex}$$`);
            const mathPara: ProseMirrorParagraphNode = {
              type: "paragraph",
              attrs: { blockId: id },
              content: [{ type: "math", attrs: { latex, display: true } }],
            };
            return mathPara;
          }
          this.acc.plainText.push(flat);
          const node: ProseMirrorParagraphNode = {
            type: "paragraph",
            attrs: { blockId: id },
            content: inline,
          };
          return node;
        }
        // Inner paragraph (inside a list item / blockquote): id-less, but still
        // mirrored into plainText so the search/preview text stays complete.
        this.acc.plainText.push(inlineText(inline));
        return { type: "paragraph", content: inline };
      }
      case "blockquote_open": {
        this.i += 1;
        const id = this.acc.mint();
        recordBlock(this.acc, "blockquote", id);
        const inner = this.walkUntil("blockquote_close", false);
        const content = inner.length > 0 ? inner : [{ type: "paragraph" as const }];
        const node: ProseMirrorBlockquoteNode = {
          type: "blockquote",
          attrs: { blockId: id },
          content,
        };
        return node;
      }
      case "bullet_list_open": {
        this.i += 1;
        const items = this.takeListItems("bullet_list_close");
        if (items.length === 0) return null;
        const node: ProseMirrorBulletListNode = { type: "bulletList", content: items };
        return node;
      }
      case "ordered_list_open": {
        this.i += 1;
        const items = this.takeListItems("ordered_list_close");
        if (items.length === 0) return null;
        const node: ProseMirrorOrderedListNode = { type: "orderedList", content: items };
        return node;
      }
      case "fence":
      case "code_block": {
        this.i += 1;
        // Preserve the code verbatim (indentation is load-bearing); drop only the
        // trailing newline markdown-it appends. T072: the fence INFO STRING (the
        // language, e.g. ```` ```python ````) IS now representable — the `codeBlock`
        // carries a `language` attr — so map the first info-string token to it (the
        // standard Markdown fence convention) so import/export round-trips the language.
        const text = tok.content.replace(/\n$/, "");
        if (text.length === 0) return null;
        const language = normalizeFenceLanguage(tok.info);
        const id = this.acc.mint();
        recordBlock(this.acc, "codeBlock", id);
        this.acc.plainText.push(text);
        const node: ProseMirrorCodeBlockNode = {
          type: "codeBlock",
          attrs: language ? { blockId: id, language } : { blockId: id },
          content: [{ type: "text", text }],
        };
        return node;
      }
      case "hr": {
        this.i += 1;
        const id = this.acc.mint();
        recordBlock(this.acc, "horizontalRule", id);
        const node: ProseMirrorHorizontalRuleNode = {
          type: "horizontalRule",
          attrs: { blockId: id },
        };
        return node;
      }
      default:
        // Any other block token (html_block, unsupported) is skipped.
        this.i += 1;
        return null;
    }
  }

  /** Consume `list_item_open … list_item_close` pairs until the list close. */
  private takeListItems(listCloseType: string): ProseMirrorListItemNode[] {
    const items: ProseMirrorListItemNode[] = [];
    while (this.i < this.tokens.length) {
      const tok = this.tokens[this.i];
      if (!tok) break;
      if (tok.type === listCloseType) {
        this.i += 1;
        break;
      }
      if (tok.type === "list_item_open") {
        this.i += 1;
        const id = this.acc.mint();
        recordBlock(this.acc, "listItem", id);
        const inner = this.walkUntil("list_item_close", false);
        const content = inner.length > 0 ? inner : [{ type: "paragraph" as const }];
        items.push({ type: "listItem", attrs: { blockId: id }, content });
      } else {
        // Defensive: skip a stray token inside a list container.
        this.i += 1;
      }
    }
    return items;
  }

  /** Take an `inline` token's content (the cursor is on the inline token). */
  private takeInline(): ProseMirrorInlineNode[] {
    const tok = this.tokens[this.i];
    if (tok && tok.type === "inline") {
      this.i += 1;
      return mergeRuns(collectInline(tok.children ?? []));
    }
    return [];
  }

  /** Advance past an expected close token if present (tolerant of malformed streams). */
  private expectClose(closeType: string): void {
    const tok = this.tokens[this.i];
    if (tok && tok.type === closeType) this.i += 1;
  }

  /** Walk the whole top-level token stream into block nodes. */
  walk(): ProseMirrorBlockNode[] {
    return this.walkUntil(" __never__ ", true);
  }
}

/**
 * Convert Markdown into the constrained `{ doc, plainText, blocks }`
 * `PlainTextConversion`. Empty/whitespace Markdown → a valid empty doc.
 *
 * @param markdown the raw Markdown text.
 * @param mint optional block-id minter (defaults to the editor's ULID minter).
 */
export function markdownToProseMirrorDoc(
  markdown: string,
  mint: BlockIdMinter = newBlockId,
): PlainTextConversion {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    return { doc: { type: "doc", content: [] }, plainText: "", blocks: [] };
  }
  const acc: Acc = { mint, blocks: [], plainText: [] };
  const tokens = md.parse(markdown, {});
  const content = new TokenWalker(tokens, acc).walk();
  return {
    doc: { type: "doc", content },
    plainText: acc.plainText.join("\n\n"),
    blocks: acc.blocks,
  };
}

// ===========================================================================
// Export — constrained ProseMirror → Markdown
// ===========================================================================

/**
 * Inline characters that are ALWAYS Markdown-significant mid-text (emphasis,
 * code, links, escape, raw-angle/tilde) and so must be backslash-escaped in every
 * text run. Line-LEADING block markers (`#`, `>`, `-`, `+`, digit-`.`/`)`) are
 * handled separately in {@link escapeLeadingMarker} so a `.` or `-` mid-sentence is
 * left untouched (escaping every period would be ugly + lossy).
 */
const MARKDOWN_INLINE_ESCAPE = /[\\`*_[\]<>~]/g;

/**
 * Escape always-significant inline characters in a plain text run so a paragraph
 * containing `*`, `` ` ``, `[` (etc.) round-trips as literal text rather than markup.
 * Inline code runs are NOT escaped (they are wrapped in backticks verbatim).
 */
function escapeText(text: string): string {
  return text.replace(MARKDOWN_INLINE_ESCAPE, (ch) => `\\${ch}`);
}

/**
 * Escape a LINE-LEADING block marker so the line does not re-parse as a heading /
 * blockquote / list / hr on re-import. Only the leading marker is escaped — a `-`
 * or `.` later in the line stays literal. Applied per serialized line of a
 * paragraph/heading (after inline escaping).
 */
function escapeLeadingMarker(line: string): string {
  // Heading (`#`), blockquote (`>`), bullet (`-`/`+`/`*` already escaped inline).
  if (/^(#{1,6}\s|>|[-+]\s)/.test(line)) return `\\${line}`;
  // Ordered-list marker: one-or-more digits then `.`/`)` then space.
  const ordered = line.match(/^(\d+)([.)])(\s)/);
  if (ordered) return `${ordered[1]}\\${ordered[2]}${ordered[3]}${line.slice(ordered[0].length)}`;
  return line;
}

/** Serialize an inline node list to Markdown, applying marks. */
function serializeInline(nodes: readonly ProseMirrorInlineNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      // A hard break in Markdown is two trailing spaces + newline.
      out += "  \n";
      continue;
    }
    if (node.type === "math") {
      // T072: a math node emits delimited LaTeX — `$$…$$` for a block formula,
      // `$…$` for inline. The latex is stored clean, so this round-trips.
      const latex = node.attrs.latex;
      out += node.attrs.display ? `$$${latex}$$` : `$${latex}$`;
      continue;
    }
    const text = node.text;
    const marks = node.marks ?? [];
    const hasCode = marks.some((m) => m.type === "code");
    let piece: string;
    if (hasCode) {
      // Inline code: verbatim inside backticks (no escaping). Other marks wrap it.
      piece = `\`${text}\``;
    } else {
      piece = escapeText(text);
    }
    // Apply the remaining marks from innermost to outermost. Order is fixed for
    // determinism: code (handled above) → italic → bold → link.
    if (marks.some((m) => m.type === "italic")) piece = `*${piece}*`;
    if (marks.some((m) => m.type === "bold")) piece = `**${piece}**`;
    const link = marks.find((m) => m.type === "link");
    if (link) {
      const href = (link.attrs?.href as string | undefined) ?? "";
      piece = `[${piece}](${href})`;
    }
    out += piece;
  }
  return out;
}

/** Markdown heading prefix for a level (1–3). */
function headingPrefix(level: ProseMirrorHeadingLevel): string {
  return `${"#".repeat(level)} `;
}

/**
 * Serialize a list's items. `ordered` selects `1.`/`2.`… vs `- `; `indent` is the
 * accumulated leading whitespace for nesting. Each item's first block is the marker
 * line; subsequent blocks (nested lists / extra paragraphs) are indented under it.
 */
function serializeList(
  items: readonly ProseMirrorListItemNode[],
  ordered: boolean,
  indent: string,
): string {
  const lines: string[] = [];
  items.forEach((item, index) => {
    const marker = ordered ? `${index + 1}. ` : "- ";
    const childIndent = indent + " ".repeat(marker.length);
    const children = item.content ?? [];
    // Render the item's block children; the first paragraph shares the marker line.
    const rendered = children.map((child) => serializeBlock(child, childIndent));
    let body = rendered.join("\n");
    // Strip the leading childIndent off the very first line so it sits after the marker.
    body = body.startsWith(childIndent) ? body.slice(childIndent.length) : body.replace(/^\s+/, "");
    lines.push(`${indent}${marker}${body}`);
  });
  return lines.join("\n");
}

/**
 * Serialize a single block node to Markdown, prefixing every line with `indent`
 * (used for nested-list / blockquote continuation). Returns the block's text WITHOUT
 * a trailing blank line (the doc walker joins blocks with blank lines).
 */
function serializeBlock(node: ProseMirrorBlockNode, indent: string): string {
  switch (node.type) {
    case "heading":
      return indent + headingPrefix(node.attrs.level) + serializeInline(node.content ?? []);
    case "paragraph":
      // Escape a leading block marker so the paragraph never re-parses as a
      // heading/list/blockquote/hr on re-import (each line of a wrapped paragraph).
      return (
        indent +
        serializeInline(node.content ?? [])
          .split("\n")
          .map(escapeLeadingMarker)
          .join("\n")
      );
    case "codeBlock": {
      const text = (node.content ?? []).map((t) => t.text).join("");
      // T072: emit the fence language (`` ```python ``) so import → export → import
      // round-trips it. `null`/absent language → a bare ` ``` ` fence.
      const language = node.attrs?.language ?? "";
      const fenced = [`\`\`\`${language}`, ...text.split("\n"), "```"];
      return fenced.map((line) => indent + line).join("\n");
    }
    case "horizontalRule":
      return `${indent}---`;
    case "blockquote": {
      const inner = (node.content ?? [])
        .map((child) => serializeBlock(child, ""))
        .join("\n\n")
        .split("\n")
        .map((line) => `${indent}> ${line}`.trimEnd())
        .join("\n");
      return inner;
    }
    case "bulletList":
      return serializeList(node.content ?? [], false, indent);
    case "orderedList":
      return serializeList(node.content ?? [], true, indent);
    case "listItem": {
      // A bare listItem (shouldn't appear at the top level) → its inner blocks.
      return (node.content ?? []).map((child) => serializeBlock(child, indent)).join("\n");
    }
    default:
      return "";
  }
}

/**
 * Serialize a constrained `ProseMirrorDoc` to deterministic Markdown. Blocks are
 * separated by a single blank line. The output is designed to round-trip: re-
 * importing it via {@link markdownToProseMirrorDoc} yields a structurally identical
 * doc (modulo freshly minted block ids). Images, code-language, and tables are not
 * representable and are normalized away on the first import (see the module docblock).
 */
export function proseMirrorDocToMarkdown(doc: ProseMirrorDoc): string {
  const blocks = doc.content ?? [];
  const rendered = blocks.map((block) => serializeBlock(block, ""));
  return `${rendered
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

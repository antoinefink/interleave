/**
 * Markdown ↔ ProseMirror transform tests (T068) — pure, fixture-driven. They prove
 * `markdownToProseMirrorDoc` maps Markdown to the constrained schema with stable
 * block ids, `proseMirrorDocToMarkdown` serializes deterministically, and — the
 * roadmap's "acceptable fidelity" criterion made CONCRETE — that the round-trip is a
 * FIXED POINT: `md → doc1 → md' → doc2` with `doc2` structurally equal to `doc1`
 * modulo freshly minted block ids.
 *
 * The fidelity ceiling (the constrained schema) is asserted explicitly: images,
 * code-block language, tables, and HTML passthrough are normalized away on the first
 * import and are NOT expected to round-trip.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { BlockId } from "@interleave/core";
import { ALLOWED_MARK_NAMES, ALLOWED_NODE_NAMES, buildSchema } from "@interleave/editor/schema";
import { describe, expect, it } from "vitest";
import { htmlFileToProseMirrorDoc } from "./html-file";
import { markdownToProseMirrorDoc, proseMirrorDocToMarkdown } from "./markdown";

const FIXTURES = path.join(__dirname, "__fixtures__", "markdown");

function readMd(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

const NODE_NAMES = new Set<string>([...ALLOWED_NODE_NAMES, "doc", "text"]);
const MARK_NAMES = new Set<string>([...ALLOWED_MARK_NAMES]);

/** A deterministic block-id minter so doc snapshots are stable. */
function counterMint(): () => BlockId {
  let n = 0;
  return () => `blk-${(n++).toString().padStart(4, "0")}` as BlockId;
}

/** Walk every node, asserting names + collecting block ids. */
function validate(doc: unknown): { blockIds: string[]; nodeNames: Set<string> } {
  expect(() => buildSchema().nodeFromJSON(doc)).not.toThrow();
  const blockIds: string[] = [];
  const nodeNames = new Set<string>();
  const walk = (node: Record<string, unknown>): void => {
    nodeNames.add(node.type as string);
    const attrs = node.attrs as { blockId?: string } | undefined;
    if (attrs?.blockId) blockIds.push(attrs.blockId);
    for (const mark of (node.marks ?? []) as { type: string }[]) {
      expect(MARK_NAMES.has(mark.type)).toBe(true);
    }
    for (const child of (node.content ?? []) as Record<string, unknown>[]) walk(child);
  };
  walk(doc as Record<string, unknown>);
  for (const name of nodeNames) expect(NODE_NAMES.has(name)).toBe(true);
  return { blockIds, nodeNames };
}

/** Strip every `blockId` attr so two docs can be compared modulo ids. */
function stripBlockIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripBlockIds) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "attrs" && v && typeof v === "object") {
        const { blockId: _drop, ...rest } = v as Record<string, unknown>;
        // Keep an empty attrs object out of the comparison when only blockId was present.
        if (Object.keys(rest).length > 0) out[k] = stripBlockIds(rest);
      } else {
        out[k] = stripBlockIds(v);
      }
    }
    return out as T;
  }
  return value;
}

describe("markdownToProseMirrorDoc", () => {
  const conversion = markdownToProseMirrorDoc(readMd("sample.md"), counterMint());

  it("maps headings/paragraphs/lists/blockquote/code/hr/links to the constrained schema", () => {
    const { nodeNames } = validate(conversion.doc);
    expect(nodeNames.has("heading")).toBe(true);
    expect(nodeNames.has("paragraph")).toBe(true);
    expect(nodeNames.has("bulletList")).toBe(true);
    expect(nodeNames.has("listItem")).toBe(true);
    expect(nodeNames.has("blockquote")).toBe(true);
    expect(nodeNames.has("codeBlock")).toBe(true);
    expect(nodeNames.has("horizontalRule")).toBe(true);
  });

  it("clamps an h2 heading to level 2 and preserves the code text verbatim", () => {
    const content = conversion.doc.content;
    const headings = content.filter((n) => n.type === "heading");
    // The fixture has an h1 (level 1) and an h2 (level 2).
    const levels = headings.map((h) => (h as { attrs: { level: number } }).attrs.level).sort();
    expect(levels).toEqual([1, 2]);
    const code = content.find((n) => n.type === "codeBlock") as
      | { content?: Array<{ text: string }> }
      | undefined;
    expect(code?.content?.[0]?.text).toContain("def review(card):");
    expect(code?.content?.[0]?.text).toContain("    return schedule(card)"); // indentation kept
  });

  it("preserves bold/italic/link/code inline marks", () => {
    const flatMarks = new Set<string>();
    const walk = (node: Record<string, unknown>): void => {
      for (const m of (node.marks ?? []) as { type: string }[]) flatMarks.add(m.type);
      for (const c of (node.content ?? []) as Record<string, unknown>[]) walk(c);
    };
    walk(conversion.doc as unknown as Record<string, unknown>);
    expect(flatMarks.has("bold")).toBe(true);
    expect(flatMarks.has("italic")).toBe(true);
    expect(flatMarks.has("link")).toBe(true);
    expect(flatMarks.has("code")).toBe(true);
  });

  it("assigns a unique stable blockId to each row + mirrors the blocks list", () => {
    const { blockIds } = validate(conversion.doc);
    expect(new Set(blockIds).size).toBe(blockIds.length);
    // Every recorded block has a matching node blockId.
    const recorded = conversion.blocks.map((b) => b.stableBlockId);
    expect(new Set(recorded)).toEqual(new Set(blockIds));
  });

  it("returns a valid empty doc for empty/whitespace Markdown", () => {
    const empty = markdownToProseMirrorDoc("   \n\n  ");
    expect(empty.doc.content).toEqual([]);
    expect(empty.plainText).toBe("");
    expect(empty.blocks).toEqual([]);
    expect(() => buildSchema().nodeFromJSON(empty.doc)).not.toThrow();
  });
});

describe("proseMirrorDocToMarkdown", () => {
  it("produces deterministic Markdown for a known doc", () => {
    const conversion = markdownToProseMirrorDoc(
      "# Title\n\nA **bold** word.\n\n- one\n- two\n",
      counterMint(),
    );
    const out = proseMirrorDocToMarkdown(conversion.doc);
    expect(out).toBe("# Title\n\nA **bold** word.\n\n- one\n- two\n");
  });

  it("escapes inline-significant characters + a leading block marker in plain text", () => {
    // A literal `*` mid-text must be escaped; a mid-line `#` is NOT significant.
    const inline = markdownToProseMirrorDoc("A literal \\* and \\# here.\n", counterMint());
    const inlineOut = proseMirrorDocToMarkdown(inline.doc);
    expect(inlineOut).toContain("\\*");
    expect(inlineOut).not.toContain("\\#"); // mid-line # stays literal

    // A paragraph that STARTS with `#` would re-parse as a heading → escape the leader.
    const leading = markdownToProseMirrorDoc("\\# not a heading\n", counterMint());
    const leadingOut = proseMirrorDocToMarkdown(leading.doc);
    expect(leadingOut).toMatch(/^\\#/);
    // It round-trips: re-importing yields a paragraph, not a heading.
    const redoc = markdownToProseMirrorDoc(leadingOut, counterMint()).doc;
    expect(redoc.content[0]?.type).toBe("paragraph");
  });
});

describe("round-trip fidelity (the fixed-point contract)", () => {
  it("md → doc1 → md' → doc2 yields doc2 structurally equal to doc1 (modulo block ids)", () => {
    const md = readMd("sample.md");
    const doc1 = markdownToProseMirrorDoc(md, counterMint()).doc;
    const mdPrime = proseMirrorDocToMarkdown(doc1);
    const doc2 = markdownToProseMirrorDoc(mdPrime, counterMint()).doc;
    expect(stripBlockIds(doc2)).toEqual(stripBlockIds(doc1));
  });

  it("a second round-trip is a fixed point (the serialized form is stable)", () => {
    const md = readMd("sample.md");
    const doc1 = markdownToProseMirrorDoc(md, counterMint()).doc;
    const md1 = proseMirrorDocToMarkdown(doc1);
    const doc2 = markdownToProseMirrorDoc(md1, counterMint()).doc;
    const md2 = proseMirrorDocToMarkdown(doc2);
    expect(md2).toBe(md1);
  });

  it("normalizes away features outside the constrained schema (images)", () => {
    // An image becomes its alt text — it does not round-trip, by design (the
    // documented fidelity ceiling).
    const conversion = markdownToProseMirrorDoc(
      "![A caption](https://example.com/x.png)\n\n```\nconst x = 1;\n```\n",
      counterMint(),
    );
    const md = proseMirrorDocToMarkdown(conversion.doc);
    expect(md).not.toContain("https://example.com/x.png"); // image src gone
    expect(md).toContain("A caption"); // alt text kept
    expect(md).toContain("```\nconst x = 1;\n```"); // code text preserved
  });

  it("round-trips a fenced code block's LANGUAGE and a $$…$$ math node (T072)", () => {
    // T072 widened the schema: the codeBlock carries a `language` attr and `$$…$$`
    // maps to a `math` node, so both now round-trip through import → export → import.
    const source = "```python\nprint('hi')\n```\n\n$$E=mc^2$$\n";
    const conversion = markdownToProseMirrorDoc(source, counterMint());

    // Import: the code block carries `language: "python"`; the `$$…$$` paragraph
    // holds a `display:true` math node.
    const blocks = conversion.doc.content;
    const code = blocks.find((b) => b.type === "codeBlock");
    expect(code?.type === "codeBlock" ? code.attrs?.language : null).toBe("python");
    const mathPara = blocks.find(
      (b): b is Extract<typeof b, { type: "paragraph" }> =>
        b.type === "paragraph" && b.content?.[0]?.type === "math",
    );
    const mathNode = mathPara?.content?.[0];
    expect(mathNode?.type).toBe("math");
    if (mathNode?.type === "math") {
      expect(mathNode.attrs.latex).toBe("E=mc^2");
      expect(mathNode.attrs.display).toBe(true);
    }

    // Export: the fence language + the `$$…$$` are emitted back.
    const md = proseMirrorDocToMarkdown(conversion.doc);
    expect(md).toContain("```python");
    expect(md).toContain("$$E=mc^2$$");

    // Re-import is a fixed point (structurally equal modulo block ids).
    const md2 = proseMirrorDocToMarkdown(markdownToProseMirrorDoc(md, counterMint()).doc);
    expect(md2).toBe(md);
  });
});

describe("htmlFileToProseMirrorDoc (HTML import path — reused sanitize + HTML→PM)", () => {
  const html = readFileSync(path.join(__dirname, "__fixtures__", "html", "sample.html"), "utf8");
  const conversion = htmlFileToProseMirrorDoc(html, counterMint());

  it("sanitizes scripts/styles + maps to the constrained schema with stable block ids", () => {
    const { blockIds, nodeNames } = validate(conversion.doc);
    expect(new Set(blockIds).size).toBe(blockIds.length);
    expect(conversion.plainText).not.toContain("alert");
    expect(conversion.plainText).not.toContain("color: red");
    expect(nodeNames.has("heading")).toBe(true);
    expect(nodeNames.has("bulletList")).toBe(true);
    expect(nodeNames.has("blockquote")).toBe(true);
    expect(nodeNames.has("codeBlock")).toBe(true);
  });

  it("keeps the link href + drops the image (alt text retained per the schema)", () => {
    const links: string[] = [];
    const walk = (node: Record<string, unknown>): void => {
      for (const m of (node.marks ?? []) as { type: string; attrs?: { href?: string } }[]) {
        if (m.type === "link" && m.attrs?.href) links.push(m.attrs.href);
      }
      for (const c of (node.content ?? []) as Record<string, unknown>[]) walk(c);
    };
    walk(conversion.doc as unknown as Record<string, unknown>);
    expect(links).toContain("https://example.com/page");
    expect(conversion.plainText).not.toContain("figure.png");
  });
});

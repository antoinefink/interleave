/**
 * Plain-text → ProseMirror converter tests (T013).
 *
 * Pins the deterministic conversion the document upsert + the later editor both
 * rely on: blank-line splitting → paragraph count, an empty body → a valid empty
 * doc, plainText round-trips the normalized input, and each block gets a unique
 * stable id.
 */

import { describe, expect, it } from "vitest";
import type { BlockId } from "./ids";
import {
  PROSEMIRROR_ROW_BLOCK_TYPES,
  type ProseMirrorParagraphNode,
  type ProseMirrorTextNode,
  plainTextToProseMirrorDoc,
  richSelectionToProseMirrorDoc,
  shouldCarryProseMirrorRowBlockId,
} from "./prosemirror";

/** The plain-text converter emits paragraphs only — narrow to read their text. */
function paragraphText(node: { readonly type: string }): string | undefined {
  if (node.type !== "paragraph") return undefined;
  const inline = (node as ProseMirrorParagraphNode).content?.[0];
  return inline && inline.type === "text" ? (inline as ProseMirrorTextNode).text : undefined;
}

describe("shouldCarryProseMirrorRowBlockId", () => {
  it("keeps the shared one-id-per-row block ownership rule explicit", () => {
    expect(PROSEMIRROR_ROW_BLOCK_TYPES).toEqual([
      "paragraph",
      "heading",
      "blockquote",
      "listItem",
      "codeBlock",
      "image",
      "horizontalRule",
    ]);
    expect(shouldCarryProseMirrorRowBlockId("paragraph", "doc")).toBe(true);
    expect(shouldCarryProseMirrorRowBlockId("listItem", "bulletList")).toBe(true);
    expect(shouldCarryProseMirrorRowBlockId("paragraph", "listItem")).toBe(false);
    expect(shouldCarryProseMirrorRowBlockId("paragraph", "blockquote")).toBe(false);
    expect(shouldCarryProseMirrorRowBlockId("bulletList", "doc")).toBe(false);
  });
});

describe("plainTextToProseMirrorDoc", () => {
  it("splits on blank lines into one paragraph node + block each", () => {
    const { doc, blocks } = plainTextToProseMirrorDoc("First para.\n\nSecond para.\n\nThird.");
    expect(doc.type).toBe("doc");
    expect(doc.content).toHaveLength(3);
    expect(doc.content.map((p) => p.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(paragraphText(doc.content[0] as ProseMirrorParagraphNode)).toBe("First para.");
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.order)).toEqual([0, 1, 2]);
    expect(blocks.every((b) => b.blockType === "paragraph")).toBe(true);
  });

  it("treats a single paragraph (no blank lines) as one paragraph", () => {
    const { doc, blocks } = plainTextToProseMirrorDoc("Just one line of text here.");
    expect(doc.content).toHaveLength(1);
    expect(blocks).toHaveLength(1);
    expect(paragraphText(doc.content[0] as ProseMirrorParagraphNode)).toBe(
      "Just one line of text here.",
    );
  });

  it("collapses runs of blank lines and inline whitespace", () => {
    const { doc } = plainTextToProseMirrorDoc("A\n\n\n\nB   B\twith   spaces");
    expect(doc.content).toHaveLength(2);
    expect(paragraphText(doc.content[0] as ProseMirrorParagraphNode)).toBe("A");
    expect(paragraphText(doc.content[1] as ProseMirrorParagraphNode)).toBe("B B with spaces");
  });

  it("normalizes CRLF / CR line endings", () => {
    const { doc } = plainTextToProseMirrorDoc("One\r\n\r\nTwo\r\rThree");
    expect(doc.content).toHaveLength(3);
    expect(doc.content.map((p) => paragraphText(p))).toEqual(["One", "Two", "Three"]);
  });

  it("returns a valid EMPTY doc for an empty or whitespace-only body", () => {
    for (const body of ["", "   ", "\n\n\t\n  \n"]) {
      const { doc, plainText, blocks } = plainTextToProseMirrorDoc(body);
      expect(doc).toEqual({ type: "doc", content: [] });
      expect(plainText).toBe("");
      expect(blocks).toHaveLength(0);
    }
  });

  it("round-trips: plainText re-splits into the same paragraphs", () => {
    const { plainText } = plainTextToProseMirrorDoc("Alpha.\n\n\nBeta line.\n\nGamma.");
    expect(plainText).toBe("Alpha.\n\nBeta line.\n\nGamma.");
    // Re-converting the normalized plainText yields the same paragraph count.
    const again = plainTextToProseMirrorDoc(plainText);
    expect(again.doc.content).toHaveLength(3);
    expect(again.plainText).toBe(plainText);
  });

  it("assigns a unique stable id to each block", () => {
    const { blocks } = plainTextToProseMirrorDoc("a\n\nb\n\nc\n\nd");
    const ids = blocks.map((b) => b.stableBlockId);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("uses an injected id minter deterministically (purity)", () => {
    let n = 0;
    const mint = () => `blk-${n++}` as BlockId;
    const { blocks } = plainTextToProseMirrorDoc("x\n\ny", mint);
    expect(blocks.map((b) => b.stableBlockId)).toEqual(["blk-0", "blk-1"]);
  });

  it("embeds each block id in the paragraph's `blockId` attr (T016: editor adopts it)", () => {
    let n = 0;
    const mint = () => `blk-${n++}` as BlockId;
    const { doc, blocks } = plainTextToProseMirrorDoc("alpha\n\nbeta", mint);
    // The node attr and the parallel block list carry the SAME id, in order.
    expect(doc.content.map((p) => (p as ProseMirrorParagraphNode).attrs?.blockId)).toEqual([
      "blk-0",
      "blk-1",
    ]);
    expect(blocks.map((b) => b.stableBlockId)).toEqual(["blk-0", "blk-1"]);
  });
});

describe("richSelectionToProseMirrorDoc", () => {
  function mint(prefix = "child"): () => BlockId {
    let n = 0;
    return () => `${prefix}-${n++}` as BlockId;
  }

  const richDoc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "src-a" },
        content: [{ type: "text", text: "First paragraph here." }],
      },
      {
        type: "image",
        attrs: {
          blockId: "src-img",
          src: "article-image://source_1/asset_1",
          alt: "Architecture diagram",
          title: "Figure title",
          width: 640,
          height: 480,
        },
      },
      {
        type: "paragraph",
        attrs: { blockId: "src-b" },
        content: [{ type: "text", text: "Second paragraph after image." }],
      },
    ],
  };

  it("preserves paragraph boundaries for cross-paragraph selections", () => {
    const conversion = richSelectionToProseMirrorDoc({
      parentDoc: richDoc,
      blockIds: ["src-a" as BlockId, "src-b" as BlockId],
      startOffset: 6,
      endOffset: 16,
      selectedText: "paragraph here.\nSecond paragraph",
      mintBlockId: mint(),
    });

    expect(conversion).not.toBeNull();
    expect(conversion?.doc.content.map((node) => node.type)).toEqual(["paragraph", "paragraph"]);
    expect(conversion?.doc.content.map((node) => paragraphText(node))).toEqual([
      "paragraph here.",
      "Second paragraph",
    ]);
    expect(conversion?.plainText).toBe("paragraph here.\n\nSecond paragraph");
    expect(conversion?.blocks.map((block) => block.blockType)).toEqual(["paragraph", "paragraph"]);
  });

  it("preserves selected article image blocks and mints fresh extract block ids", () => {
    const conversion = richSelectionToProseMirrorDoc({
      parentDoc: richDoc,
      blockIds: ["src-a" as BlockId, "src-img" as BlockId, "src-b" as BlockId],
      startOffset: 0,
      endOffset: 6,
      selectedText: "First paragraph here.\nArchitecture diagram\nSecond",
      mintBlockId: mint("extract"),
    });

    expect(conversion).not.toBeNull();
    expect(conversion?.doc.content.map((node) => node.type)).toEqual([
      "paragraph",
      "image",
      "paragraph",
    ]);
    expect(conversion?.doc.content[1]).toMatchObject({
      type: "image",
      attrs: {
        blockId: "extract-1",
        src: "article-image://source_1/asset_1",
        alt: "Architecture diagram",
        title: "Figure title",
        width: 640,
        height: 480,
      },
    });
    expect(conversion?.plainText).toBe("First paragraph here.\n\nArchitecture diagram\n\nSecond");
    expect(conversion?.blocks).toEqual([
      { blockType: "paragraph", order: 0, stableBlockId: "extract-0" },
      { blockType: "image", order: 1, stableBlockId: "extract-1" },
      { blockType: "paragraph", order: 2, stableBlockId: "extract-2" },
    ]);
    expect(conversion?.blocks.map((block) => block.stableBlockId)).not.toContain("src-img");
  });

  it("does not include zero-width inline atoms that only touch a partial selection boundary", () => {
    const conversion = richSelectionToProseMirrorDoc({
      parentDoc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "src-math" },
            content: [
              { type: "text", text: "a" },
              { type: "math", attrs: { latex: "x", display: false } },
              { type: "text", text: "b" },
            ],
          },
        ],
      },
      blockIds: ["src-math" as BlockId],
      startOffset: 0,
      endOffset: 1,
      selectedText: "a",
      mintBlockId: mint("extract"),
    });

    expect(conversion).not.toBeNull();
    expect(conversion?.doc.content).toEqual([
      {
        type: "paragraph",
        attrs: { blockId: "extract-0" },
        content: [{ type: "text", text: "a" }],
      },
    ]);
  });

  it("preserves the structural list wrapper around selected list rows", () => {
    const conversion = richSelectionToProseMirrorDoc({
      parentDoc: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                attrs: { blockId: "src-li" },
                content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
              },
            ],
          },
        ],
      },
      blockIds: ["src-li" as BlockId],
      startOffset: 0,
      endOffset: 3,
      selectedText: "one",
      mintBlockId: mint("extract"),
    });

    expect(conversion).not.toBeNull();
    expect(conversion?.doc.content).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            attrs: { blockId: "extract-0" },
            content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
          },
        ],
      },
    ]);
    expect(conversion?.blocks).toEqual([
      { blockType: "listItem", order: 0, stableBlockId: "extract-0" },
    ]);
  });

  it("trims nested row blocks by flattened text offsets and removes inner row ids", () => {
    const conversion = richSelectionToProseMirrorDoc({
      parentDoc: {
        type: "doc",
        content: [
          {
            type: "blockquote",
            attrs: { blockId: "src-quote" },
            content: [
              {
                type: "paragraph",
                attrs: { blockId: "legacy-inner-a" },
                content: [{ type: "text", text: "alpha line" }],
              },
              {
                type: "paragraph",
                attrs: { blockId: "legacy-inner-b" },
                content: [{ type: "text", text: "beta line" }],
              },
            ],
          },
        ],
      },
      blockIds: ["src-quote" as BlockId],
      startOffset: "alpha line".length,
      endOffset: "alpha linebeta".length,
      selectedText: "beta",
      mintBlockId: mint("extract"),
    });

    expect(conversion).not.toBeNull();
    expect(conversion?.doc.content).toEqual([
      {
        type: "blockquote",
        attrs: { blockId: "extract-0" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "beta" }] }],
      },
    ]);
    expect(conversion?.blocks).toEqual([
      { blockType: "blockquote", order: 0, stableBlockId: "extract-0" },
    ]);
    expect(JSON.stringify(conversion?.doc)).not.toContain("legacy-inner");
  });

  it("does not duplicate a selected nested row already contained by a selected ancestor", () => {
    const conversion = richSelectionToProseMirrorDoc({
      parentDoc: {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                attrs: { blockId: "src-outer" },
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "outer header text" }] },
                  {
                    type: "bulletList",
                    content: [
                      {
                        type: "listItem",
                        attrs: { blockId: "src-inner" },
                        content: [
                          { type: "paragraph", content: [{ type: "text", text: "inner body" }] },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      blockIds: ["src-outer" as BlockId, "src-inner" as BlockId],
      startOffset: "outer ".length,
      endOffset: "inner".length,
      selectedText: "header text\ninner",
      mintBlockId: mint("extract"),
    });

    expect(conversion).not.toBeNull();
    expect(conversion?.plainText).toBe("header text\ninner");
    expect(conversion?.doc.content).toHaveLength(1);
    expect(conversion?.doc.content[0]?.type).toBe("bulletList");
    expect(conversion?.blocks).toEqual([
      { blockType: "listItem", order: 0, stableBlockId: "extract-0" },
      { blockType: "listItem", order: 1, stableBlockId: "extract-1" },
    ]);
  });

  it("returns null instead of widening a partial extraction when offsets are absent", () => {
    expect(
      richSelectionToProseMirrorDoc({
        parentDoc: richDoc,
        blockIds: ["src-a" as BlockId],
        selectedText: "paragraph",
        mintBlockId: mint(),
      }),
    ).toBeNull();
  });

  it("returns null instead of throwing for malformed top-level document content", () => {
    expect(() =>
      richSelectionToProseMirrorDoc({
        parentDoc: { type: "doc", content: [null] },
        blockIds: ["missing" as BlockId],
        startOffset: 0,
        endOffset: 1,
        selectedText: "fallback",
        mintBlockId: mint(),
      }),
    ).not.toThrow();
    expect(
      richSelectionToProseMirrorDoc({
        parentDoc: { type: "doc", content: [null] },
        blockIds: ["missing" as BlockId],
        startOffset: 0,
        endOffset: 1,
        selectedText: "fallback",
        mintBlockId: mint(),
      }),
    ).toBeNull();
  });

  it("returns null instead of throwing for malformed inline content in a selected block", () => {
    const input = {
      parentDoc: {
        type: "doc",
        content: [{ type: "paragraph", attrs: { blockId: "src-a" }, content: [null] }],
      },
      blockIds: ["src-a" as BlockId],
      startOffset: 0,
      endOffset: 1,
      selectedText: "fallback",
      mintBlockId: mint(),
    };

    expect(() => richSelectionToProseMirrorDoc(input)).not.toThrow();
    expect(richSelectionToProseMirrorDoc(input)).toBeNull();
  });

  it("returns null when a malformed selected row would create an empty body for selected text", () => {
    expect(
      richSelectionToProseMirrorDoc({
        parentDoc: {
          type: "doc",
          content: [{ type: "paragraph", attrs: { blockId: "src-empty" } }],
        },
        blockIds: ["src-empty" as BlockId],
        startOffset: 0,
        endOffset: 1,
        selectedText: "fallback",
        mintBlockId: mint(),
      }),
    ).toBeNull();
  });

  it("returns null when the selected original blocks are not present", () => {
    expect(
      richSelectionToProseMirrorDoc({
        parentDoc: richDoc,
        blockIds: ["missing" as BlockId],
        selectedText: "fallback",
        mintBlockId: mint(),
      }),
    ).toBeNull();
  });
});

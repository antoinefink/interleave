/**
 * Serialization-helper tests (T015).
 *
 * `toPlainText` is the value stored in `documents.plainText`, so it must flatten
 * a ProseMirror document to stable, ordered, readable text in plain Node (no
 * DOM). `emptyDoc` is the canonical empty body the editor + repository agree on.
 */

import { describe, expect, it } from "vitest";
import { emptyDoc, toPlainText } from "./serialize";

describe("emptyDoc", () => {
  it("is a single empty paragraph", () => {
    expect(emptyDoc()).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });

  it("flattens to the empty string", () => {
    expect(toPlainText(emptyDoc())).toBe("");
  });
});

describe("toPlainText", () => {
  it("returns empty for nullish / non-object input", () => {
    expect(toPlainText(null)).toBe("");
    expect(toPlainText(undefined)).toBe("");
    expect(toPlainText("not a doc")).toBe("");
  });

  it("joins paragraphs and headings with newlines in document order", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
        { type: "paragraph", content: [{ type: "text", text: "First para." }] },
        { type: "paragraph", content: [{ type: "text", text: "Second para." }] },
      ],
    };
    expect(toPlainText(doc)).toBe("Title\nFirst para.\nSecond para.");
  });

  it("flattens marks to their text (bold/italic/link/code)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a", marks: [{ type: "bold" }] },
            { type: "text", text: "b", marks: [{ type: "italic" }] },
            { type: "text", text: "c", marks: [{ type: "code" }] },
          ],
        },
      ],
    };
    expect(toPlainText(doc)).toBe("abc");
  });

  it("emits one line per list item", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
            },
          ],
        },
      ],
    };
    expect(toPlainText(doc)).toBe("one\ntwo");
  });

  it("flattens blockquote paragraphs to their own lines", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "quoted line 1" }] },
            { type: "paragraph", content: [{ type: "text", text: "quoted line 2" }] },
          ],
        },
      ],
    };
    expect(toPlainText(doc)).toBe("quoted line 1\nquoted line 2");
  });

  it("keeps code-block text and converts hard breaks to newlines", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "codeBlock", content: [{ type: "text", text: "const x = 1;" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "line A" },
            { type: "hardBreak" },
            { type: "text", text: "line B" },
          ],
        },
      ],
    };
    expect(toPlainText(doc)).toBe("const x = 1;\nline A\nline B");
  });

  it("flattens math nodes to delimited LaTeX and code blocks to their code (T072)", () => {
    const doc = {
      type: "doc",
      content: [
        // A block formula (display:true math alone in its paragraph) → $$…$$.
        {
          type: "paragraph",
          content: [{ type: "math", attrs: { latex: "E=mc^2", display: true } }],
        },
        // An inline formula inside running text → $…$.
        {
          type: "paragraph",
          content: [
            { type: "text", text: "energy " },
            { type: "math", attrs: { latex: "a^2+b^2", display: false } },
            { type: "text", text: " end" },
          ],
        },
        // A code block keeps its code text verbatim (language is not in plainText).
        {
          type: "codeBlock",
          attrs: { language: "python" },
          content: [{ type: "text", text: "print('hi')" }],
        },
      ],
    };
    expect(toPlainText(doc)).toBe("$$E=mc^2$$\nenergy $a^2+b^2$ end\nprint('hi')");
  });

  it("trims trailing empty blocks (no dangling newline)", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "content" }] },
        { type: "paragraph" },
        { type: "paragraph" },
      ],
    };
    expect(toPlainText(doc)).toBe("content");
  });
});

/**
 * Card-body segmentation tests (T072).
 *
 * `parseBodySegments` recovers math + code from the `$…$` / `$$…$$` / fenced-code
 * delimiters in a card prompt/answer STRING, so the review face renders them
 * (instead of a raw string) via the shared KaTeX/Shiki path.
 */

import { describe, expect, it } from "vitest";
import { bodyHasRichSegments, parseBodySegments } from "./body-segments";

describe("parseBodySegments", () => {
  it("returns a single text segment for plain prose", () => {
    expect(parseBodySegments("just words")).toEqual([{ kind: "text", content: "just words" }]);
    expect(bodyHasRichSegments("just words")).toBe(false);
  });

  it("splits inline math out of surrounding text", () => {
    const segments = parseBodySegments("The mass-energy relation is $E=mc^2$ exactly.");
    expect(segments).toEqual([
      { kind: "text", content: "The mass-energy relation is " },
      { kind: "math", latex: "E=mc^2", display: false },
      { kind: "text", content: " exactly." },
    ]);
    expect(bodyHasRichSegments("a $x$ b")).toBe(true);
  });

  it("treats $$…$$ as a block formula (display:true), not two inline $", () => {
    const segments = parseBodySegments("$$\\int_0^1 x\\,dx$$");
    expect(segments).toEqual([{ kind: "math", latex: "\\int_0^1 x\\,dx", display: true }]);
  });

  it("extracts a fenced code block with its language", () => {
    const segments = parseBodySegments("Run:\n```python\nprint('hi')\n```\ndone");
    expect(segments[0]).toEqual({ kind: "text", content: "Run:\n" });
    expect(segments[1]).toEqual({ kind: "code", code: "print('hi')", language: "python" });
    expect(segments[2]).toEqual({ kind: "text", content: "\ndone" });
  });

  it("does not treat a $ inside a code fence as math", () => {
    const segments = parseBodySegments("```bash\necho $HOME\n```");
    expect(segments).toEqual([{ kind: "code", code: "echo $HOME", language: "bash" }]);
  });

  it("leaves an unmatched $ as literal text (no crash)", () => {
    const segments = parseBodySegments("price is $5 today");
    expect(segments).toEqual([{ kind: "text", content: "price is $5 today" }]);
  });

  it("handles a code fence with no language", () => {
    const segments = parseBodySegments("```\nplain code\n```");
    expect(segments).toEqual([{ kind: "code", code: "plain code", language: null }]);
  });
});

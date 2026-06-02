/**
 * aggregateOcrWords tests (T066) — the pure OCR post-processor.
 *
 * The actual `tesseract.js` WASM call lives in the Electron worker; this package
 * owns only the SHARED result type + the line-grouping / confidence-aggregation
 * post-processor, which is fixture-tested here over a known word list (no WASM).
 */

import { describe, expect, it } from "vitest";
import { aggregateOcrWords, type RawOcrWord } from "./ocr";

/** A word with a bbox (top-left origin). */
function word(text: string, confidence: number, x0: number, y0: number): RawOcrWord {
  return { text, confidence, bbox: { x0, y0, x1: x0 + 10, y1: y0 + 8 } };
}

describe("aggregateOcrWords", () => {
  it("averages per-word confidences into an integer page mean", () => {
    const result = aggregateOcrWords([word("a", 80, 0, 0), word("b", 90, 12, 0)]);
    expect(result.meanConfidence).toBe(85);
    expect(result.words).toHaveLength(2);
  });

  it("reconstructs reading-order text from word boxes (top-to-bottom, left-to-right)", () => {
    const words = [
      word("world", 90, 30, 0),
      word("Hello", 90, 0, 0),
      word("second", 90, 0, 20),
      word("line", 90, 30, 20),
    ];
    const result = aggregateOcrWords(words);
    expect(result.text).toBe("Hello world\nsecond line");
  });

  it("prefers the engine text when supplied (it carries the engine's line breaks)", () => {
    const result = aggregateOcrWords(
      [word("ignored", 50, 0, 0)],
      "Engine line one\nEngine line two",
    );
    expect(result.text).toBe("Engine line one\nEngine line two");
    // The confidence + words still come from the word list.
    expect(result.meanConfidence).toBe(50);
    expect(result.words).toHaveLength(1);
  });

  it("drops empty/whitespace words and clamps stray confidences", () => {
    const result = aggregateOcrWords([
      word("real", 95, 0, 0),
      word("   ", 10, 12, 0),
      word("bad", Number.NaN, 24, 0),
    ]);
    // The blank word is dropped; the NaN confidence clamps to 0.
    expect(result.words.map((w) => w.text)).toEqual(["real", "bad"]);
    expect(result.words[1]?.confidence).toBe(0);
  });

  it("returns an empty result for no words", () => {
    const result = aggregateOcrWords([]);
    expect(result).toEqual({ text: "", meanConfidence: 0, words: [] });
  });
});

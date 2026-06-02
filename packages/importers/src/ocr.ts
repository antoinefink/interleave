/**
 * Pure OCR result shape + post-processor (T066).
 *
 * The ACTUAL `tesseract.js` WASM call lives in the Electron OCR worker (it is the
 * heavy dependency that must stay out of this pure, fixture-tested package). This
 * module owns only the SHARED TYPE the worker + the main-side apply handler + the
 * tests agree on, plus a small framework-agnostic post-processor that AGGREGATES
 * raw tesseract word output into the page-level `{ text, meanConfidence, words }`
 * record — so the line-grouping / confidence-averaging logic is unit-testable
 * against a fixture payload without loading WASM.
 *
 * NO `fs`, NO Electron, NO WASM here — words in, an {@link OcrResult} out.
 */

/** One recognized word with its confidence (0–100) and pixel bounding box. */
export interface OcrWord {
  readonly text: string;
  /** Per-word confidence 0–100 (tesseract's `Word.confidence`). */
  readonly confidence: number;
  /** Pixel bounding box on the OCR'd page image. */
  readonly bbox: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
}

/** The recognized-text record for one page/region (the worker → main payload). */
export interface OcrResult {
  /** The full recognized text (reading order). */
  readonly text: string;
  /** Mean confidence 0–100 across the recognized words (0 when no words). */
  readonly meanConfidence: number;
  /** The per-word detail (for word-level placement + low-confidence highlighting). */
  readonly words: readonly OcrWord[];
}

/** Raw per-word output, as the engine produces it (a subset of tesseract's `Word`). */
export interface RawOcrWord {
  readonly text: string;
  readonly confidence: number;
  readonly bbox: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
}

/**
 * Aggregate raw tesseract words into an {@link OcrResult}: group words into visual
 * lines by their vertical position (so a re-joined page reads top-to-bottom,
 * left-to-right), join line words with single spaces, and average the per-word
 * confidences into a page mean (rounded to an integer 0–100). An `engineText`
 * (tesseract's own `data.text`) is preferred for the body text when supplied (it
 * already carries the engine's line breaks); the line grouping is the deterministic
 * fallback + the always-computed `meanConfidence`/`words`.
 *
 * Pure + deterministic — the fixture test drives it with a known word list.
 */
export function aggregateOcrWords(
  words: readonly RawOcrWord[],
  engineText?: string | null,
): OcrResult {
  const cleaned: OcrWord[] = words
    .filter((w) => typeof w.text === "string" && w.text.trim().length > 0)
    .map((w) => ({
      text: w.text.trim(),
      confidence: clampConfidence(w.confidence),
      bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
    }));

  const meanConfidence =
    cleaned.length === 0
      ? 0
      : Math.round(cleaned.reduce((sum, w) => sum + w.confidence, 0) / cleaned.length);

  // Prefer the engine's own text when present (it already has line breaks); else
  // reconstruct lines from word boxes so the post-processor still yields readable
  // text from a bare word list (the fixture path).
  const text =
    typeof engineText === "string" && engineText.trim().length > 0
      ? normalizeText(engineText)
      : groupWordsIntoText(cleaned);

  return { text, meanConfidence, words: cleaned };
}

/** Vertical tolerance (pixels) within which two words share a line. */
const LINE_Y_TOLERANCE = 10;

/** Reconstruct page text from word boxes (top-to-bottom lines, left-to-right runs). */
function groupWordsIntoText(words: readonly OcrWord[]): string {
  if (words.length === 0) return "";
  const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const lines: OcrWord[][] = [];
  let current: OcrWord[] = [];
  let lineY: number | null = null;
  for (const w of sorted) {
    if (lineY === null || Math.abs(w.bbox.y0 - lineY) <= LINE_Y_TOLERANCE) {
      current.push(w);
      lineY = lineY === null ? w.bbox.y0 : Math.min(lineY, w.bbox.y0);
    } else {
      lines.push(current);
      current = [w];
      lineY = w.bbox.y0;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines
    .map((line) =>
      [...line]
        .sort((a, b) => a.bbox.x0 - b.bbox.x0)
        .map((w) => w.text)
        .join(" "),
    )
    .join("\n")
    .trim();
}

/** Collapse repeated whitespace within a line; preserve newlines. */
function normalizeText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Clamp a confidence to an integer in 0–100 (a stray NaN/negative → 0). */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

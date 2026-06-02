/**
 * Card-body segmentation (T072) — split a card prompt/answer STRING into ordered
 * text / math / code segments so the review face renders math + highlighted code
 * instead of a raw string.
 *
 * A card's `prompt`/`answer`/`cloze` are plain strings (the card model stores text,
 * not ProseMirror JSON). So in REVIEW we recover math + code from delimiters the
 * `plainText`/authoring path already writes (the SAME `$…$` / `$$…$$` / fenced-code
 * convention `toPlainText` emits for the math/code nodes):
 *
 *  - a fenced code block — ```` ```lang\n…code…\n``` ```` → a `code` segment;
 *  - block math — `$$…$$` → a `math` segment (`display: true`);
 *  - inline math — `$…$` → a `math` segment (`display: false`);
 *  - everything else → `text` segments (rendered verbatim, cloze-aware upstream).
 *
 * Pure + framework-agnostic (no React, no DOM): the renderer maps these segments to
 * KaTeX / Shiki via the shared {@link renderMathHtml} / {@link highlightCodeHtml}
 * helpers, so source/extract/review share ONE render path. A `$` with no closing
 * delimiter is left as literal text (never a half-parsed crash).
 */

/** One ordered piece of a card body. */
export type BodySegment =
  | { readonly kind: "text"; readonly content: string }
  | { readonly kind: "math"; readonly latex: string; readonly display: boolean }
  | { readonly kind: "code"; readonly code: string; readonly language: string | null };

/** A fenced code block: ```` ```lang\n…\n``` ```` (language optional). */
const FENCE = /```([\w+#.-]*)\n([\s\S]*?)```/;
/** Block math `$$…$$` (non-greedy, allows newlines). */
const BLOCK_MATH = /\$\$([\s\S]+?)\$\$/;
/** Inline math `$…$` (single line, no `$` inside, not an empty `$$`). */
const INLINE_MATH = /\$([^$\n]+?)\$/;

/**
 * Parse a card-body string into ordered {@link BodySegment}s. Fenced code is matched
 * FIRST (so a `$` inside code is not treated as math), then block math, then inline
 * math; the rest is text. Unmatched `$`/backticks stay literal.
 */
export function parseBodySegments(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  let rest = body;

  // Walk left-to-right, at each step finding the EARLIEST of {fence, block, inline}.
  while (rest.length > 0) {
    const fence = FENCE.exec(rest);
    const block = BLOCK_MATH.exec(rest);
    const inline = INLINE_MATH.exec(rest);

    // Pick the match with the smallest start index (fence wins ties so code is intact;
    // block wins over inline at the same index so `$$` is not read as two `$`).
    const candidates = [
      fence ? { kind: "code" as const, m: fence } : null,
      block ? { kind: "block" as const, m: block } : null,
      inline ? { kind: "inline" as const, m: inline } : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);

    if (candidates.length === 0) {
      segments.push({ kind: "text", content: rest });
      break;
    }

    candidates.sort((a, b) => {
      if (a.m.index !== b.m.index) return a.m.index - b.m.index;
      // At the same index: code > block > inline (so `$$`/fence aren't mis-split).
      const rank = { code: 0, block: 1, inline: 2 } as const;
      return rank[a.kind] - rank[b.kind];
    });
    const chosen = candidates[0];
    if (!chosen) {
      segments.push({ kind: "text", content: rest });
      break;
    }

    const { m } = chosen;
    const start = m.index;
    if (start > 0) segments.push({ kind: "text", content: rest.slice(0, start) });

    if (chosen.kind === "code") {
      const language = (m[1] ?? "").trim();
      segments.push({
        kind: "code",
        code: (m[2] ?? "").replace(/\n$/, ""),
        language: language.length > 0 ? language : null,
      });
    } else {
      segments.push({
        kind: "math",
        latex: (m[1] ?? "").trim(),
        display: chosen.kind === "block",
      });
    }
    rest = rest.slice(start + m[0].length);
  }

  return segments;
}

/** True when a body string carries any math or code delimiter worth rendering. */
export function bodyHasRichSegments(body: string): boolean {
  return parseBodySegments(body).some((s) => s.kind !== "text");
}

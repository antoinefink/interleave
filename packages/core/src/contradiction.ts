/**
 * Contradiction detection (T089) — a PURE, HEURISTIC, SUGGESTIVE flag.
 *
 * `detectContradictions(pairs)` takes candidate pairs of highly-similar
 * cards/extracts (the high-similarity gate comes from the T087 `vec0` neighbors,
 * resolved main-side) and flags the ones that ALSO carry an opposing/superseding
 * signal: a negation/polarity divergence, a numeric/quantity mismatch, or one side
 * being backed by a meaningfully NEWER source than the other (the roadmap's literal
 * "a newer source conflicts with an older card").
 *
 * Load-bearing constraints (CLAUDE.md + the T089 spec):
 *  - **Explicitly heuristic, never authoritative.** It WILL miss real conflicts and
 *    flag non-conflicts. The UI copy must say "possible conflict — review", never
 *    "conflict". No flag is ever high-severity. It is a prompt to the user's
 *    judgment, never an automatic correction.
 *  - **No I/O, no React, no Drizzle, no DB.** Data in, flags out — so it is trivially
 *    testable and reusable. Main resolves the inputs (text + similarity + source
 *    dates via lineage) and calls this.
 *  - **Built for T090/T091 enrichment.** The input struct is extensible (extra
 *    optional fields): T090 (`valid_from`/`valid_until`/`fact_stability`) and T091
 *    (source reliability) will ENRICH the signals (a stronger "superseded" signal, a
 *    reliability-weighted severity) WITHOUT changing the core shape — the dates are
 *    taken as plain strings, the constants are exported and tunable.
 *
 * The negation/antonym cue list is INTENTIONALLY minimal (a small, documented set);
 * it accepts false positives/negatives because the whole detector is suggestive.
 */

/**
 * The minimum cosine-style similarity (0..1, higher = more alike) for a pair to be a
 * contradiction CANDIDATE. Without the vector store there are no candidate pairs at
 * all (the high-similarity gate needs `vec0`). Deliberately high — the two items must
 * be about the SAME thing before an opposing signal means "they disagree" rather than
 * "they are unrelated". Tunable; exported for the service + tests.
 */
export const CONTRADICTION_SIMILARITY_MIN = 0.8;

/**
 * Relative tolerance for the numeric-divergence signal: two numbers stated for the
 * same context count as "diverging" only when they differ by MORE than this fraction
 * of the larger magnitude (so "7 days" vs "14 days" diverges, but "7" vs "7.1" does
 * not). A relative (not absolute) tolerance keeps it scale-free.
 */
export const CONTRADICTION_NUMERIC_TOLERANCE = 0.15;

/**
 * The minimum gap, in YEARS, between the two sides' source dates for the recency-
 * supersession signal to fire. A newer source within the same era is not "superseding"
 * — only a meaningful gap (a newer publication that may have updated the claim) counts.
 */
export const CONTRADICTION_RECENCY_GAP_YEARS = 3;

/**
 * The negation/polarity cue list (INTENTIONALLY minimal, extensible). A side is
 * "negated" when it contains one of these tokens that the other side lacks — a crude
 * polarity-divergence proxy. It is suggestive: it accepts false positives (a negation
 * inside a quote) and false negatives (an implicit negation). Lowercased, matched as
 * whole words.
 */
export const NEGATION_CUES: readonly string[] = [
  "not",
  "no",
  "never",
  "none",
  "cannot",
  "can't",
  "doesn't",
  "don't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "won't",
  "without",
  "neither",
  "nor",
  "false",
  "incorrect",
  "untrue",
];

/**
 * A small antonym map (extensible). When one side contains a word and the other
 * contains its antonym (around an otherwise-shared claim), that is a polarity
 * divergence. Bidirectional (both directions are checked). Minimal on purpose.
 */
const ANTONYM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["increase", "decrease"],
  ["increases", "decreases"],
  ["rise", "fall"],
  ["rises", "falls"],
  ["higher", "lower"],
  ["more", "less"],
  ["faster", "slower"],
  ["better", "worse"],
  ["positive", "negative"],
  ["true", "false"],
  ["safe", "dangerous"],
  ["beneficial", "harmful"],
  ["effective", "ineffective"],
  ["always", "never"],
];

/** The opposing/superseding signals a contradiction flag can carry. */
export type ContradictionReason = "negation" | "numeric" | "recency";

/**
 * One side of a candidate pair. The text + similarity + source dates are resolved
 * main-side (text from `EmbeddingService.buildText`, similarity from the `vec0`
 * distance, dates from the lineage source row). Every metadata field is optional so a
 * source-less / undated element degrades cleanly (just fewer signals, never a throw).
 *
 * EXTENSIBLE: T090/T091 add optional fields here (validity window, fact stability,
 * source reliability) WITHOUT changing the existing shape.
 */
export interface ContradictionSide {
  readonly id: string;
  readonly type: "card" | "extract";
  /** The text that was embedded (prompt+answer / extract body) — the signal source. */
  readonly text: string;
  /** A loose `publishedAt` date string (as stored at import), or `null`. */
  readonly sourcePublishedAt?: string | null;
  /** A loose `accessedAt` date string (when the source was captured), or `null`. */
  readonly sourceAccessedAt?: string | null;
}

/**
 * A candidate pair to evaluate. `similarity` is the cosine-style 0..1 closeness of
 * the two vectors (resolved from the `vec0` distance); the gate uses it directly.
 */
export interface ContradictionPair {
  readonly a: ContradictionSide;
  readonly b: ContradictionSide;
  /** Cosine-style similarity (0..1, higher = more alike). The high-similarity gate. */
  readonly similarity: number;
}

/**
 * A contradiction flag. `severity` is NEVER `"high"` — the whole thing is suggestive.
 * `newerSide` names which side's source is meaningfully newer (the supersession
 * direction), or `null` when recency did not fire / could not be determined.
 */
export interface ContradictionFlag {
  readonly aId: string;
  readonly bId: string;
  readonly reasons: readonly ContradictionReason[];
  readonly severity: "low" | "medium";
  readonly newerSide: "a" | "b" | null;
}

/** Extract a 4-digit year (1000–2999) from a loose date string, or `null`. */
function yearOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // A leading ISO/RFC year ("2019-11-05…" or "2019") — locale/timezone independent.
  const leading = trimmed.match(/^([12]\d{3})\b/);
  if (leading?.[1]) return Number(leading[1]);
  // Fall back to Date parsing for human-entered dates ("Nov 5, 2019").
  const t = Date.parse(trimmed);
  if (!Number.isNaN(t)) return new Date(t).getUTCFullYear();
  // Last resort: any 4-digit run that looks like a year.
  const any = trimmed.match(/\b([12]\d{3})\b/);
  return any?.[1] ? Number(any[1]) : null;
}

/** The best available year for a side: `publishedAt` first, else `accessedAt`. */
function sideYear(side: ContradictionSide): number | null {
  return yearOf(side.sourcePublishedAt) ?? yearOf(side.sourceAccessedAt);
}

/** Lowercase word tokens (letters/digits), for the negation/antonym proxies. */
function tokens(text: string): Set<string> {
  const set = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9']+/g)) set.add(m[0]);
  return set;
}

/**
 * Negation/polarity divergence: one side carries a negation cue (or an antonym of a
 * word on the other side) that the other side lacks. A crude, deliberately simple
 * proxy — suggestive, not a parser. Returns `true` on any asymmetric polarity signal.
 */
function hasNegationDivergence(aText: string, bText: string): boolean {
  const a = tokens(aText);
  const b = tokens(bText);

  // Asymmetric negation cue: a cue present in exactly one side.
  for (const cue of NEGATION_CUES) {
    const inA = a.has(cue);
    const inB = b.has(cue);
    if (inA !== inB) return true;
  }

  // Antonym across the two sides (one has the word, the other its antonym).
  for (const [x, y] of ANTONYM_PAIRS) {
    if ((a.has(x) && b.has(y)) || (a.has(y) && b.has(x))) return true;
  }
  return false;
}

/** A number + the (lowercased) unit/word that immediately follows it, if any. */
interface NumberWithUnit {
  readonly value: number;
  readonly unit: string | null;
}

/**
 * Pull the numbers from a text, each tagged with the word that follows it (its unit /
 * context). "7 days", "14 days", "50%". Percent signs and bare numbers are kept.
 */
function numbersOf(text: string): NumberWithUnit[] {
  const out: NumberWithUnit[] = [];
  // A number, optionally followed by a % sign or a trailing word (the unit).
  const re = /(\d+(?:\.\d+)?)\s*(%|[a-zA-Z]+)?/g;
  for (const m of text.matchAll(re)) {
    const value = Number(m[1]);
    if (!Number.isFinite(value)) continue;
    const unit = m[2] ? m[2].toLowerCase() : null;
    out.push({ value, unit });
  }
  return out;
}

/**
 * Numeric divergence: both sides state a number for the SAME unit and the two values
 * differ beyond {@link CONTRADICTION_NUMERIC_TOLERANCE} (relative). Pairs are matched
 * by unit (so "7 days" vs "14 days" diverges, "7 days" vs "50 dollars" does not). When
 * a side has bare unitless numbers they are compared to the other side's bare numbers
 * as a fallback. Missing numbers → no signal (returns `false`, never throws).
 */
function hasNumericDivergence(aText: string, bText: string): boolean {
  const a = numbersOf(aText);
  const b = numbersOf(bText);
  if (a.length === 0 || b.length === 0) return false;

  const diverges = (x: number, y: number): boolean => {
    const larger = Math.max(Math.abs(x), Math.abs(y));
    if (larger === 0) return false; // 0 vs 0 — not a divergence.
    return Math.abs(x - y) / larger > CONTRADICTION_NUMERIC_TOLERANCE;
  };

  // Group b's numbers by unit for a same-unit lookup.
  const bByUnit = new Map<string, number[]>();
  for (const n of b) {
    const key = n.unit ?? "";
    const list = bByUnit.get(key) ?? [];
    list.push(n.value);
    bByUnit.set(key, list);
  }

  for (const na of a) {
    const key = na.unit ?? "";
    const matches = bByUnit.get(key);
    if (!matches || matches.length === 0) continue;
    // A same-unit pair diverges only when EVERY counterpart value diverges (so a
    // shared value anywhere on the other side means "they agree on this number").
    if (matches.every((bv) => diverges(na.value, bv))) return true;
  }
  return false;
}

/**
 * Recency supersession: the two sides' source years differ by at least
 * {@link CONTRADICTION_RECENCY_GAP_YEARS}. Returns the newer side (or `null` when the
 * gap is too small / a year is missing). This is the roadmap's "newer source conflicts
 * with older card".
 */
function recencySupersession(a: ContradictionSide, b: ContradictionSide): "a" | "b" | null {
  const ya = sideYear(a);
  const yb = sideYear(b);
  if (ya == null || yb == null) return null;
  if (Math.abs(ya - yb) < CONTRADICTION_RECENCY_GAP_YEARS) return null;
  return ya > yb ? "a" : "b";
}

/**
 * Evaluate the candidate pairs and return the flagged contradictions. A pair is
 * flagged when its `similarity >= CONTRADICTION_SIMILARITY_MIN` AND at least one
 * opposing/superseding signal fires (negation, numeric, or recency).
 *
 * Severity is `"low"` for a single signal, `"medium"` for two or more — NEVER
 * `"high"` (the detector is suggestive). `newerSide` is set only when the recency
 * signal fired.
 *
 * Pure: no I/O, deterministic, order-preserving, never throws (a missing date/number
 * simply contributes no signal).
 */
export function detectContradictions(pairs: readonly ContradictionPair[]): ContradictionFlag[] {
  const flags: ContradictionFlag[] = [];

  for (const pair of pairs) {
    if (!(pair.similarity >= CONTRADICTION_SIMILARITY_MIN)) continue;

    const reasons: ContradictionReason[] = [];
    if (hasNegationDivergence(pair.a.text, pair.b.text)) reasons.push("negation");
    if (hasNumericDivergence(pair.a.text, pair.b.text)) reasons.push("numeric");

    const newerSide = recencySupersession(pair.a, pair.b);
    if (newerSide) reasons.push("recency");

    if (reasons.length === 0) continue;

    flags.push({
      aId: pair.a.id,
      bId: pair.b.id,
      reasons,
      severity: reasons.length >= 2 ? "medium" : "low",
      newerSide,
    });
  }

  return flags;
}

/**
 * Card-quality heuristics (T035).
 *
 * Before a `card_draft` becomes an active card the builder runs these heuristics
 * and surfaces them as the `qc` checklist (the RIGHT column of
 * `design/kit/app/screen-builder.jsx` `QualityCheck`). Each check is an ordered
 * `ok` / `warn` / `block` row with human text the UI renders verbatim.
 *
 * They live here — pure, framework-agnostic, DB-free domain functions, NOT in the
 * React component (the Architectural rule: card-quality heuristics belong in
 * `packages/core`) — so they are unit-testable, reusable by the renderer, by M7's
 * activation gate, and by M17 (T086), which extends this exact {@link evaluateCardQuality}
 * with more checks (multiple facts, long lists, similar-answer interference, outdated
 * source, oversized clozes). The report shape is designed to grow.
 *
 * ## Severity contract
 *
 * - `ok`    — the check passed; nothing to do.
 * - `warn`  — advisory: the card is weak (e.g. too long, multiple clozes, ambiguous
 *             pronoun, missing source). A `warn` NEVER blocks creation/activation —
 *             it explains *why* a card is weak, per the card-quality rules ("Warnings
 *             inform; the user can still proceed").
 * - `block` — the card is hollow (empty prompt/answer, or no cloze deletion) and
 *             cannot be activated until fixed. This is the ONLY hard gate; it must be
 *             precise (only truly empty/hollow cards) so it never silently prevents
 *             legitimate authoring.
 *
 * The minimum-information principle (one fact per card; short, atomic prompt + answer)
 * is the source of every threshold below — see `CLAUDE.md` "Card-quality rules".
 */

import { type ParsedCloze, parseCloze } from "./cloze";

/** Severity of a single quality check (`ok` < `warn` < `block`). */
export type CardQualitySeverity = "ok" | "warn" | "block";

/** A stable id for each check, so tests / UI / M17 can target a specific row. */
export type CardQualityCheckId =
  | "empty"
  | "prompt-too-long"
  | "answer-too-long"
  | "multiple-clozes"
  | "ambiguous-pronoun"
  | "missing-source"
  // T072: a code body's length is judged in LINES, not chars/words (the char/word
  // thresholds would over-warn on legitimate code).
  | "code-too-long"
  // T075: an audio card whose looped clip is over ~30 s warns (minimum-information).
  | "long-audio-clip"
  // T086 — the remaining minimum-information-principle heuristics. Each is advisory
  // (`warn`), never a new hard block (the only blocker stays the hollow-card `empty`).
  | "multiple-facts"
  | "long-list"
  | "vague-pronoun"
  | "unsupported-claim"
  | "outdated-source"
  | "oversized-cloze"
  // `similar-answer` is produced by the SEPARATE pure {@link detectInterference}
  // function (it needs caller-supplied sibling answers), not by the single-card
  // {@link evaluateCardQuality} — but it shares this id union + check shape.
  | "similar-answer";

/** One row of the quality checklist. */
export interface CardQualityCheck {
  /** Stable identifier for the heuristic that produced this row. */
  readonly id: CardQualityCheckId;
  /** `ok` / `warn` / `block` (see the severity contract above). */
  readonly severity: CardQualitySeverity;
  /** Human-readable text the `qc` checklist renders verbatim. */
  readonly message: string;
}

/** The full ordered result of {@link evaluateCardQuality}. */
export interface CardQualityReport {
  /** Every check, in a stable display order. */
  readonly checks: readonly CardQualityCheck[];
  /**
   * `true` when ANY check is `block` severity — the card is hollow and the builder
   * must disable Create / activation until it is fixed. (Convenience derived flag.)
   */
  readonly hasBlocker: boolean;
  /** `true` when any check is `warn` (advisory; does NOT gate creation). */
  readonly hasWarning: boolean;
}

/**
 * The audio signals (T075) shared by both card kinds: whether a looped clip carries
 * the prompt / answer face (so the empty-prompt/empty-answer `block` doesn't mis-fire
 * on an audio-only card — the audio IS that face's content), and the clip's length in
 * ms (so an over-long clip warns per the minimum-information principle). All optional,
 * backward-compatible — a text card omits them and behaves exactly as before.
 */
export interface AudioQualitySignals {
  /** True when a looped audio clip is the PROMPT face (an audio-prompt card). */
  readonly hasMediaPrompt?: boolean;
  /** True when a looped audio clip is the ANSWER face (an audio-answer card). */
  readonly hasMediaAnswer?: boolean;
  /** The looped clip's length in milliseconds, when this is an audio card. */
  readonly audioClipMs?: number | null;
}

/**
 * Optional source-recency signals (T086) the caller may supply from the originating
 * source's metadata, feeding the `outdated-source` time-sensitive check. Both are
 * backward-compatible — a caller that omits them behaves exactly as before, and the
 * check only escalates a card whose TEXT uses time-sensitive language (a version, a
 * year, "current"/"latest"/"as of") while carrying no anchoring date.
 *
 * Real fact-expiry (`valid_from`/`valid_until`/`review_by`/staleness scheduling) is
 * deferred to M18/T090 — T086 only WARNS at authoring time and exposes these inputs the
 * later task can feed.
 */
export interface SourceRecencySignals {
  /**
   * The source's publish/anchor date (ISO or any truthy string) when known. When a card
   * uses time-sensitive language but this is absent/empty, the claim has nothing dating
   * it → warn. A present date silences the time-sensitive warning (the claim is dated).
   */
  readonly sourceDate?: string | null;
  /**
   * A caller-supplied "this source is known to be stale" flag (e.g. the source is years
   * old, or superseded). When `true`, warn regardless of the card's wording.
   */
  readonly sourceIsStale?: boolean;
}

/** Discriminated quality input for a Q&A card. */
export interface QaQualityInput extends AudioQualitySignals, SourceRecencySignals {
  readonly kind: "qa";
  /** The card front / question. */
  readonly prompt: string;
  /** The card back / answer. */
  readonly answer: string;
  /** Whether the card inherits a source location (lineage to source). */
  readonly hasSource: boolean;
}

/** Discriminated quality input for a cloze card. */
export interface ClozeQualityInput extends AudioQualitySignals, SourceRecencySignals {
  readonly kind: "cloze";
  /** The canonical `{{c1::answer}}` cloze text. */
  readonly cloze: string;
  /**
   * The pre-parsed structured model (from {@link parseCloze}). Optional — when
   * omitted it is derived from `cloze`. The renderer already holds a parse, so it
   * can pass it to avoid re-parsing.
   */
  readonly parsed?: ParsedCloze;
  /** Whether the card inherits a source location (lineage to source). */
  readonly hasSource: boolean;
}

/** The discriminated input to {@link evaluateCardQuality}. */
export type CardQualityInput = QaQualityInput | ClozeQualityInput;

/**
 * Max characters for a Q&A FRONT before it warns "too broad / narrow it". Matches
 * the design kit's `qaFront.length < 110` threshold. A long prompt usually smuggles
 * in extra facts or context the answer should carry — the minimum-information
 * principle wants one short, clear question.
 */
export const PROMPT_MAX_CHARS = 110;

/**
 * Max characters for a Q&A BACK before it warns "holds multiple facts — split".
 * Matches the kit's `qaBack.length < 90` threshold. A long answer is the classic
 * sign of more than one fact crammed into a single card.
 */
export const ANSWER_MAX_CHARS = 90;

/**
 * Max WORDS in a cloze body before it warns "giant cloze paragraph". A cloze that
 * wraps a whole paragraph asks the user to recall too much at once; the kit caps the
 * extract draft at `< 40 words`, and we apply the same bound to the cloze body.
 */
export const CLOZE_MAX_WORDS = 40;

/**
 * Distinct cloze deletions allowed before "multiple clozes — split the card" warns.
 * One logical deletion per card keeps recall atomic (grouped `c1` repeats count once,
 * via {@link parseCloze}'s `clozeCount`). Matches the kit's `clozeCount <= 2` being
 * "ok" — we warn the moment there is MORE THAN ONE distinct deletion (`> 1`), which is
 * stricter than the kit on purpose (the minimum-information principle prefers one).
 */
export const MAX_CLOZE_DELETIONS = 1;

/**
 * Max LINES in a code body before "card spans too much code, narrow it" warns (T072).
 * A code card holds ONE construct/idea — a function, a signature, a key line. Code is
 * judged in LINES, not chars/words: a correct 8-line function is fine but would trip
 * the char/word thresholds, so for a detected code body we apply THIS line cap and
 * SKIP the char/word + ambiguous-pronoun heuristics (which are meaningless on code).
 */
export const CODE_MAX_LINES = 12;

/**
 * Max LENGTH (ms) of an audio card's looped clip before "long audio clip — consider a
 * shorter span" warns (T075). The minimum-information principle applies to audio too: a
 * 30-second clip usually bundles more than one phrase/idea. 30 s = 30_000 ms.
 */
export const LONG_AUDIO_CLIP_MS = 30_000;

/**
 * T086 — `multiple-facts`: an answer/cloze-body that holds MORE THAN this many distinct
 * assertions warns "split into one card per fact". A "fact unit" is a sentence (split on
 * `.`/`!`/`?`) OR an independent clause joined by a coordinating conjunction / `;`. The
 * minimum-information principle wants ONE fact per card — so even a SHORT two-sentence
 * answer warns (this is independent of the char-length `answer-too-long` check). A
 * documented heuristic, NOT a parser: false positives are acceptable for a `warn`.
 */
export const MAX_FACTS_HINT = 1;

/**
 * T086 — `long-list`: an answer/cloze-body that enumerates MORE THAN this many
 * delimiter-separated items warns "list/set too large — split it". A long enumeration
 * is better as several cards or an overlapping-cloze set. Tuned so a normal 2–3 item
 * answer stays `ok` and only a genuine long list (≥ 6 items) trips.
 */
export const LIST_ITEM_WARN_COUNT = 5;

/**
 * T086 — `oversized-cloze`: any SINGLE `{{cN::…}}` deletion span longer than this many
 * words asks the user to recall too much in one blank (distinct from the whole-body
 * {@link CLOZE_MAX_WORDS}). A `{{c1::a long phrase that is basically a whole sentence}}`
 * is not an atomic deletion. Tuned smaller than the whole-body cap on purpose.
 */
export const CLOZE_DELETION_MAX_WORDS = 6;

/**
 * T086 — `outdated-source`: phrases/patterns that mark a TIME-SENSITIVE claim (one that
 * silently rots without a date/version). Matched case-insensitively against the card
 * text; when present AND the card carries no `sourceDate`, the claim has nothing dating
 * it → warn. A small, documented list (not exhaustive), plus the version/year regexes
 * in {@link TIME_SENSITIVE_PATTERNS}.
 */
export const TIME_SENSITIVE_TERMS: readonly string[] = [
  "current",
  "currently",
  "latest",
  "as of",
  "right now",
  "nowadays",
  "today",
  "this year",
  "recent",
  "recently",
  "newest",
  "up to date",
  "up-to-date",
];

/**
 * Regex patterns for time-sensitive content the {@link TIME_SENSITIVE_TERMS} word list
 * cannot catch: a software/version token (`v1.2`, `Node 18`, `Python 3.11`), or a bare
 * 4-digit year (`2024`). A card that pins itself to a version/year is time-sensitive —
 * if it carries no anchoring `sourceDate`, the claim can silently rot.
 */
const TIME_SENSITIVE_PATTERNS: readonly RegExp[] = [
  // A version token: an optional leading `v`, OR a name immediately followed by a
  // dotted/integer version (`Node 18`, `Python 3.11`, `macOS 14`, `v1.2.3`).
  /\bv\d+(?:\.\d+)*\b/i,
  /\b[A-Za-z][\w.+#-]*\s+\d+(?:\.\d+)+\b/,
  // A bare 4-digit year in a plausible range (avoids matching arbitrary 4-digit ids).
  /\b(?:19|20)\d{2}\b/,
];

/**
 * T086 — `unsupported-claim`: shapes that mark an answer as a strong factual ASSERTION
 * (rather than a definition or a label) — so a SOURCELESS such answer escalates beyond
 * the generic `missing-source` advisory. Causal language, a comparative, a definitive
 * quantifier, or a number/percentage. Documented heuristic; advisory only.
 */
const CLAIM_SHAPE_PATTERNS: readonly RegExp[] = [
  /\b(causes?|caused|leads? to|results? in|due to|because|increases?|decreases?|reduces?|improves?|prevents?)\b/i,
  /\b(always|never|all|none|every|must|cannot|proven|proves?)\b/i,
  /\b\d+(?:\.\d+)?%/, // a percentage
  /\b\d{2,}\b/, // a multi-digit number (a quantitative claim)
];

/**
 * T086 — `vague-pronoun` (broadens the leading-pronoun `ambiguous-pronoun`): a bare
 * demonstrative/pronoun used MID-text with no concrete noun anywhere on the SAME face to
 * bind it to. A documented heuristic — we look for a standalone `this`/`that`/`it`/`they`
 * and, when the face names NO multi-letter noun-ish word besides pronouns/stopwords,
 * treat the reference as dangling. Kept conservative (advisory only).
 */
const VAGUE_PRONOUNS: readonly string[] = ["this", "that", "it", "they", "them", "these", "those"];

/**
 * Default Jaccard-over-word-shingles similarity at/above which two answers are judged
 * near-identical (likely to interfere) by {@link detectInterference}. A heuristic
 * interference WARN, NOT semantic dedup (semantic similarity + duplicate detection is
 * M18/T088). Tuned high so only truly near-duplicate answers trip.
 */
export const INTERFERENCE_SIMILARITY_THRESHOLD = 0.85;

/**
 * A fenced code block — ```` ```lang\n…\n``` ````. T072's code cards carry a code body
 * inside a fence; detecting one switches the length check to {@link CODE_MAX_LINES}
 * and suppresses the prose-only heuristics.
 */
const FENCED_CODE = /```[\w+#.-]*\n[\s\S]*?```/;

/** True when `text` contains a fenced code block (a code-bearing card body). */
function hasCodeBlock(text: string): boolean {
  return FENCED_CODE.test(text);
}

/** Count the code lines inside the FIRST fenced block of `text` (0 if none). */
function codeLineCount(text: string): number {
  const match = text.match(/```[\w+#.-]*\n([\s\S]*?)```/);
  if (!match) return 0;
  const body = (match[1] ?? "").replace(/\n$/, "");
  if (body.length === 0) return 0;
  return body.split("\n").length;
}

/**
 * Bare pronouns that, when a prompt/answer LEADS with one, usually lack an antecedent
 * — the card is ambiguous out of context ("It increases this." → it/this referring to
 * what?). A small, documented heuristic, NOT an NLP parser: false positives are
 * acceptable as advisory `warn`s. Kept lower-case; matched case-insensitively against
 * the first word.
 */
const AMBIGUOUS_LEADING_PRONOUNS: readonly string[] = [
  "it",
  "this",
  "that",
  "they",
  "them",
  "these",
  "those",
];

/** Count whitespace-separated words in a trimmed string (0 for empty/whitespace). */
function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/** The first word of a string, lower-cased and stripped of leading punctuation. */
function leadingWord(text: string): string {
  const match = text
    .trim()
    .toLowerCase()
    .match(/[a-z']+/);
  return match?.[0] ?? "";
}

/**
 * True when `text` LEADS with a bare ambiguous pronoun with no antecedent. We only
 * inspect the first word: a card that *starts* by referring to "it/this/that/they"
 * has nothing earlier to bind it to, so it is ambiguous on its own. A pronoun used
 * mid-sentence with a clear subject ("Sleep clears it from the brain.") is fine.
 */
function leadsWithAmbiguousPronoun(text: string): boolean {
  return AMBIGUOUS_LEADING_PRONOUNS.includes(leadingWord(text));
}

/**
 * Count the distinct "fact units" in prose (T086 `multiple-facts`). A unit is a
 * non-empty sentence (split on `.`/`!`/`?` terminators) PLUS each independent clause a
 * sentence joins with a coordinating conjunction (`and`/`but`/`or`/`;`) — so a single
 * sentence "X is true, and Y is false" counts as two. A documented heuristic, not a
 * grammar parser: an `and`/`or` inside a noun phrase ("salt and pepper") can over-count,
 * which is acceptable for an advisory `warn`. Returns 0 for empty/whitespace text.
 */
function factCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  // Split into sentences on terminal punctuation; drop empties.
  const sentences = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  // Each sentence is at least one fact; a coordinating conjunction / semicolon joining
  // two independent clauses inside it adds one more per join.
  let count = 0;
  for (const sentence of sentences) {
    const joins = sentence.match(/(;|\b(?:and|but|or)\b)/gi);
    count += 1 + (joins?.length ?? 0);
  }
  // A bare phrase with no terminal punctuation but internal joins ("a; b; c").
  if (sentences.length === 0) count = 1;
  return count;
}

/**
 * Count delimiter-separated enumeration items (T086 `long-list`). Splits on commas,
 * semicolons, newlines, and bullet markers, then drops empties. A list-shaped answer
 * ("a, b, c, d, e, f, g") returns its item count; ordinary prose with a comma or two
 * returns a small number (so it stays under {@link LIST_ITEM_WARN_COUNT}). Returns 0
 * for empty text.
 */
function listItemCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  const items = trimmed
    .split(/\s*(?:,|;|\n|•|·|•)\s*|\s+-\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length;
}

/**
 * True when `text` references a bare demonstrative/pronoun mid-text but names NO concrete
 * noun on the same face to anchor it (T086 `vague-pronoun`). Conservative: only fires
 * when a vague pronoun appears AND every other word is a short stopword/pronoun (so the
 * face is "What does this do?" with no subject, not "Sleep clears this from the brain.").
 */
function hasDanglingPronoun(text: string): boolean {
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z']+/g) ?? [];
  if (words.length === 0) return false;
  const usesVague = words.some((w) => VAGUE_PRONOUNS.includes(w));
  if (!usesVague) return false;
  // A "concrete noun candidate" is a word of length ≥ 4 that is NOT a pronoun and NOT a
  // common function/stop word — a documented, deliberately loose proxy for "names a
  // subject". If the face has any such word, the pronoun likely has an antecedent.
  const namesSubject = words.some(
    (w) => w.length >= 4 && !VAGUE_PRONOUNS.includes(w) && !STOPWORDS.has(w),
  );
  return !namesSubject;
}

/**
 * Short function/stop words that do NOT count as "naming a subject" for the dangling-
 * pronoun heuristic — so "What does this do?" (only stopwords + a pronoun) is flagged,
 * but "What does mitochondria do?" is not.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "what",
  "does",
  "what's",
  "when",
  "where",
  "which",
  "whom",
  "whose",
  "with",
  "from",
  "into",
  "that",
  "this",
  "they",
  "them",
  "then",
  "than",
  "have",
  "here",
  "there",
  "were",
  "will",
  "would",
  "could",
  "should",
  "about",
  "your",
  "ours",
  "very",
  "just",
  "only",
  "also",
  "such",
  "some",
  "many",
  "much",
]);

/** True when any time-sensitive term or pattern appears in `text` (T086). */
function isTimeSensitive(text: string): boolean {
  const lower = text.toLowerCase();
  if (TIME_SENSITIVE_TERMS.some((t) => lower.includes(t))) return true;
  return TIME_SENSITIVE_PATTERNS.some((re) => re.test(text));
}

/** True when an answer is "claim-shaped" — a strong factual assertion (T086). */
function isClaimShaped(text: string): boolean {
  return CLAIM_SHAPE_PATTERNS.some((re) => re.test(text));
}

/**
 * Lower-case word-shingle (single-word) Jaccard similarity in `[0,1]` between two
 * strings — the pure, deterministic string metric {@link detectInterference} uses. Two
 * identical normalized strings → `1`; fully disjoint → `0`. No NLP, no embeddings.
 */
export function answerSimilarity(a: string, b: string): number {
  const tokens = (s: string): Set<string> =>
    new Set((s.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => w.length > 0));
  const setA = tokens(a);
  const setB = tokens(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Evaluate a `card_draft`'s quality, returning an ordered {@link CardQualityReport}.
 *
 * Pure + deterministic (no NLP models, no DB): the same input always yields the same
 * checks, so the builder can run it live on every keystroke. The M6 check set:
 *
 *  - **empty** prompt/answer (Q&A) or no cloze deletion (cloze) → `block` (hollow card);
 *  - **prompt-too-long** (Q&A front over {@link PROMPT_MAX_CHARS}) → `warn`;
 *  - **answer-too-long** (Q&A back over {@link ANSWER_MAX_CHARS}, or a cloze body over
 *    {@link CLOZE_MAX_WORDS} words) → `warn`;
 *  - **multiple-clozes** (more than {@link MAX_CLOZE_DELETIONS} distinct deletions) → `warn`;
 *  - **ambiguous-pronoun** (prompt/answer leads with a bare pronoun) → `warn`;
 *  - **missing-source** (`hasSource === false`) → `warn`.
 *
 * The T086 minimum-information additions (all advisory `warn`, never a new blocker):
 *
 *  - **multiple-facts** (the answer/body holds more than one assertion);
 *  - **long-list** (the answer/body enumerates more than {@link LIST_ITEM_WARN_COUNT} items);
 *  - **vague-pronoun** (a bare demonstrative mid-face with no named subject);
 *  - **unsupported-claim** (a sourceless, claim-shaped answer);
 *  - **outdated-source** (time-sensitive language with no `sourceDate`, or `sourceIsStale`);
 *  - **oversized-cloze** (a single deletion span over {@link CLOZE_DELETION_MAX_WORDS} words).
 *
 * The **similar-answer** interference check needs sibling answers, so it is produced by
 * the separate caller-fed {@link detectInterference}, not here ({@link evaluateCardQuality}
 * stays single-card-pure).
 */
export function evaluateCardQuality(input: CardQualityInput): CardQualityReport {
  const checks: CardQualityCheck[] = input.kind === "qa" ? evaluateQa(input) : evaluateCloze(input);

  // Long-audio-clip warn (T075) — shared across kinds, shown only for an audio card
  // (a non-null `audioClipMs`). The minimum-information principle: a clip much over
  // ~30 s usually bundles more than one idea; advisory, never a blocker.
  if (typeof input.audioClipMs === "number") {
    const seconds = Math.round(input.audioClipMs / 1000);
    checks.push(
      input.audioClipMs > LONG_AUDIO_CLIP_MS
        ? {
            id: "long-audio-clip",
            severity: "warn",
            message: `Long audio clip (${seconds}s) — consider a shorter span`,
          }
        : {
            id: "long-audio-clip",
            severity: "ok",
            message: `Focused audio clip (${seconds}s)`,
          },
    );
  }

  // T086 — outdated-source / time-sensitive: shared across kinds. The card text is the
  // combined face(s); a version/year/"current"-style claim with NO anchoring sourceDate
  // (or an explicitly stale source) can silently rot. Advisory only — real fact expiry
  // is M18/T090.
  const faceText =
    input.kind === "qa"
      ? `${input.prompt} ${input.answer}`
      : (input.parsed ?? parseCloze(input.cloze)).rendered;
  const timeSensitive = isTimeSensitive(faceText);
  const dated = typeof input.sourceDate === "string" && input.sourceDate.trim().length > 0;
  if (input.sourceIsStale === true) {
    checks.push({
      id: "outdated-source",
      severity: "warn",
      message: "Source is marked stale — verify the claim is still current",
    });
  } else if (timeSensitive && !dated) {
    checks.push({
      id: "outdated-source",
      severity: "warn",
      message: "Time-sensitive claim with no date/version — add when it was true",
    });
  } else if (timeSensitive) {
    checks.push({
      id: "outdated-source",
      severity: "ok",
      message: "Time-sensitive claim is dated",
    });
  }

  // Missing source is shared across kinds and shown last (least urgent advisory).
  checks.push(
    input.hasSource
      ? { id: "missing-source", severity: "ok", message: "Source attached" }
      : {
          id: "missing-source",
          severity: "warn",
          message: "No source attached — a card should trace back to where it came from",
        },
  );

  return {
    checks,
    hasBlocker: checks.some((c) => c.severity === "block"),
    hasWarning: checks.some((c) => c.severity === "warn"),
  };
}

/** Q&A-specific checks (empty → block; long prompt/answer + ambiguous pronoun → warn). */
function evaluateQa(input: QaQualityInput): CardQualityCheck[] {
  const checks: CardQualityCheck[] = [];
  const prompt = input.prompt.trim();
  const answer = input.answer.trim();

  // T075: a looped audio clip IS the content of the face it plays on, so an
  // audio-prompt card with empty text is NOT a hollow prompt (and likewise the answer).
  // Treat a face the audio covers as "filled" for the hollow-card blocker.
  const promptFilled = prompt.length > 0 || input.hasMediaPrompt === true;
  const answerFilled = answer.length > 0 || input.hasMediaAnswer === true;

  // Hollow-card blocker: either side empty (and not carried by audio) → cannot activate.
  if (!promptFilled || !answerFilled) {
    checks.push({
      id: "empty",
      severity: "block",
      message:
        !promptFilled && !answerFilled
          ? "Empty card — add a question and an answer"
          : !promptFilled
            ? "Empty question — add a prompt"
            : "Empty answer — add the fact to recall",
    });
  } else {
    checks.push({ id: "empty", severity: "ok", message: "Has a question and an answer" });
  }

  // T072: a code body (a fenced block in the prompt or answer) is judged in LINES,
  // not chars/words, and the prose-only ambiguous-pronoun heuristic is skipped — both
  // would over-warn on legitimate code. A predict-output card (code prompt + short
  // answer) and a code Q&A both fall here.
  const promptIsCode = hasCodeBlock(input.prompt);
  const answerIsCode = hasCodeBlock(input.answer);

  // Prompt length (front). Code prompts use the line cap; prose uses the char cap.
  if (promptIsCode) {
    checks.push(codeLengthCheck("prompt-too-long", codeLineCount(input.prompt)));
  } else {
    checks.push(
      prompt.length > PROMPT_MAX_CHARS
        ? {
            id: "prompt-too-long",
            severity: "warn",
            message: `Question too long (${prompt.length} chars) — narrow it to one idea`,
          }
        : {
            id: "prompt-too-long",
            severity: "ok",
            message: "Clear, single-fact question",
          },
    );
  }

  // Answer length (back). Code answers use the line cap; prose uses the char cap.
  if (answerIsCode) {
    checks.push(codeLengthCheck("answer-too-long", codeLineCount(input.answer)));
  } else {
    checks.push(
      answer.length > ANSWER_MAX_CHARS
        ? {
            id: "answer-too-long",
            severity: "warn",
            message: `Answer too long (${answer.length} chars) — it may hold multiple facts; split it`,
          }
        : {
            id: "answer-too-long",
            severity: "ok",
            message: "Atomic answer",
          },
    );
  }

  // Ambiguous pronoun — meaningless on a code body, so skip it when EITHER side is code.
  // The T086 prose heuristics (multiple-facts/long-list/vague-pronoun/unsupported-claim)
  // are likewise prose-only and skipped when either side is code.
  if (!promptIsCode && !answerIsCode) {
    checks.push(ambiguousPronounCheck(`${prompt} ${answer}`, prompt, answer));
    checks.push(multipleFactsCheck(answer));
    checks.push(longListCheck(answer));
    checks.push(vaguePronounCheck(`${prompt} ${answer}`, prompt, answer));
    checks.push(unsupportedClaimCheck(answer, input.hasSource));
  }

  return checks;
}

/**
 * The shared code-length row (T072): warns when a code body exceeds
 * {@link CODE_MAX_LINES} lines, reusing the existing `prompt-too-long`/`answer-too-long`
 * check ids so the builder's `qc` checklist renders it without new wiring. The message
 * speaks of code LINES (not chars) so the user understands the different bound.
 */
function codeLengthCheck(
  id: "prompt-too-long" | "answer-too-long",
  lines: number,
): CardQualityCheck {
  return lines > CODE_MAX_LINES
    ? {
        id,
        severity: "warn",
        message: `Card spans too much code (${lines} lines) — narrow it to one construct`,
      }
    : {
        id,
        severity: "ok",
        message: `Focused code (${lines} line${lines === 1 ? "" : "s"})`,
      };
}

/** Cloze-specific checks (no deletion → block; multiple/giant clozes + pronoun → warn). */
function evaluateCloze(input: ClozeQualityInput): CardQualityCheck[] {
  const checks: CardQualityCheck[] = [];
  const parsed = input.parsed ?? parseCloze(input.cloze);

  // Hollow-card blocker: a cloze card with no deletion is unanswerable.
  if (parsed.clozeCount === 0) {
    checks.push({
      id: "empty",
      severity: "block",
      message: "No cloze deletion — wrap an answer in {{ }}",
    });
  } else {
    checks.push({
      id: "empty",
      severity: "ok",
      message: `${parsed.clozeCount} cloze deletion${parsed.clozeCount > 1 ? "s" : ""}`,
    });
  }

  // Multiple distinct deletions → split the card (minimum-information principle).
  checks.push(
    parsed.clozeCount > MAX_CLOZE_DELETIONS
      ? {
          id: "multiple-clozes",
          severity: "warn",
          message: `Multiple clozes (${parsed.clozeCount}) — split into one deletion per card`,
        }
      : {
          id: "multiple-clozes",
          severity: "ok",
          message: "Single cloze deletion",
        },
  );

  // T072: a code cloze (a fill-in over a fenced code body) is judged in LINES, not
  // words, and the ambiguous-pronoun heuristic is skipped — both would over-warn on
  // code. The fence lives in the canonical cloze text (markers may sit inside it).
  const bodyIsCode = hasCodeBlock(input.cloze);
  if (bodyIsCode) {
    checks.push(codeLengthCheck("answer-too-long", codeLineCount(input.cloze)));
  } else {
    // Giant cloze paragraph (the cloze body, markers stripped, over the word cap).
    const words = wordCount(parsed.rendered);
    checks.push(
      words > CLOZE_MAX_WORDS
        ? {
            id: "answer-too-long",
            severity: "warn",
            message: `Cloze too long (${words} words) — aim for one idea`,
          }
        : {
            id: "answer-too-long",
            severity: "ok",
            message: `Concise (${words} word${words === 1 ? "" : "s"})`,
          },
    );
  }

  // Ambiguous pronoun in the cloze body (skipped for a code body — meaningless there).
  // The T086 prose heuristics run on the rendered body too; oversized-cloze inspects each
  // DELETION span (independent of the whole-body word count) and applies even on code-free
  // bodies — a single over-long blank asks too much regardless of body length.
  if (!bodyIsCode) {
    checks.push(ambiguousPronounCheck(parsed.rendered, parsed.rendered, ""));
    checks.push(multipleFactsCheck(parsed.rendered));
    checks.push(longListCheck(parsed.rendered));
    checks.push(vaguePronounCheck(parsed.rendered, parsed.rendered, ""));
    checks.push(oversizedClozeCheck(parsed));
  }

  return checks;
}

/**
 * T086 `multiple-facts`: warn when the answer/body plausibly holds more than one fact
 * ({@link factCount} over {@link MAX_FACTS_HINT}). Targets FACT COUNT, not length — a
 * short two-sentence answer still warns. Advisory only.
 */
function multipleFactsCheck(text: string): CardQualityCheck {
  return factCount(text) > MAX_FACTS_HINT
    ? {
        id: "multiple-facts",
        severity: "warn",
        message: "Holds multiple facts — split into one card per fact",
      }
    : { id: "multiple-facts", severity: "ok", message: "One fact" };
}

/**
 * T086 `long-list`: warn when the answer/body is a long enumeration ({@link listItemCount}
 * over {@link LIST_ITEM_WARN_COUNT}). A long list/set is better as several cards or an
 * overlapping-cloze set. Advisory only.
 */
function longListCheck(text: string): CardQualityCheck {
  const items = listItemCount(text);
  return items > LIST_ITEM_WARN_COUNT
    ? {
        id: "long-list",
        severity: "warn",
        message: `Long list (${items} items) — split it or use an overlapping cloze set`,
      }
    : { id: "long-list", severity: "ok", message: "Not an over-long list" };
}

/**
 * T086 `vague-pronoun`: warn when a face uses a bare demonstrative/pronoun mid-text with
 * no concrete noun on the SAME face to anchor it ({@link hasDanglingPronoun}). Broadens
 * the leading-only `ambiguous-pronoun` (kept stable) without regressing it. Conservative.
 */
function vaguePronounCheck(
  _combined: string,
  primary: string,
  secondary: string,
): CardQualityCheck {
  const vague =
    hasDanglingPronoun(primary) || (secondary.length > 0 && hasDanglingPronoun(secondary));
  return vague
    ? {
        id: "vague-pronoun",
        severity: "warn",
        message: "Vague reference (this/that/it…) with no named subject — name what it refers to",
      }
    : { id: "vague-pronoun", severity: "ok", message: "References a named subject" };
}

/**
 * T086 `unsupported-claim`: warn when a SOURCELESS answer is "claim-shaped" — a strong
 * factual assertion (causal/comparative/definitive/quantitative). Stricter than the
 * generic `missing-source`: escalates a claim that needs evidence. When the card has a
 * source, or the answer is not claim-shaped, stays `ok`. No network/lookup.
 */
function unsupportedClaimCheck(answer: string, hasSource: boolean): CardQualityCheck {
  return !hasSource && isClaimShaped(answer)
    ? {
        id: "unsupported-claim",
        severity: "warn",
        message: "Factual claim with no source — attach where this is supported",
      }
    : { id: "unsupported-claim", severity: "ok", message: "No unsupported claim" };
}

/**
 * T086 `oversized-cloze`: warn when ANY single `{{cN::…}}` deletion span exceeds
 * {@link CLOZE_DELETION_MAX_WORDS} words — too much to recall in one blank, distinct from
 * the whole-body {@link CLOZE_MAX_WORDS}. Uses the parsed model's per-deletion answers.
 */
function oversizedClozeCheck(parsed: ParsedCloze): CardQualityCheck {
  let worst = 0;
  for (const deletion of parsed.deletions) {
    worst = Math.max(worst, wordCount(deletion.answer));
  }
  return worst > CLOZE_DELETION_MAX_WORDS
    ? {
        id: "oversized-cloze",
        severity: "warn",
        message: `A cloze blank is ${worst} words — shorten what each {{ }} hides`,
      }
    : { id: "oversized-cloze", severity: "ok", message: "Each cloze blank is concise" };
}

/**
 * Build the ambiguous-pronoun row. `primary`/`secondary` are the two faces inspected
 * for a leading bare pronoun; `combined` is unused for the decision but documents the
 * surface. Returns `ok` when neither side leads with a bare pronoun.
 */
function ambiguousPronounCheck(
  _combined: string,
  primary: string,
  secondary: string,
): CardQualityCheck {
  const ambiguous =
    leadsWithAmbiguousPronoun(primary) ||
    (secondary.length > 0 && leadsWithAmbiguousPronoun(secondary));
  return ambiguous
    ? {
        id: "ambiguous-pronoun",
        severity: "warn",
        message: "Ambiguous pronoun (it/this/that…) with no antecedent — name the subject",
      }
    : {
        id: "ambiguous-pronoun",
        severity: "ok",
        message: "No dangling pronoun",
      };
}

/** A candidate sibling/concept card to compare against for interference (T086). */
export interface InterferenceCandidate {
  /** The sibling card's element id (so the candidate never compares against itself). */
  readonly id: string;
  /** The sibling Q&A answer, when it is a Q&A card. */
  readonly answer?: string | null;
  /** The sibling cloze text, when it is a cloze card (its rendered body is compared). */
  readonly cloze?: string | null;
}

/**
 * Detect a likely INTERFERENCE pair (T086 `similar-answer`): warn when the candidate
 * card's answer is near-identical to an existing sibling/concept card's answer (two cards
 * whose answers are nearly the same are prone to interfere in review). This is the ONE
 * minimum-information check that needs more than the single card's text, so it is kept
 * SEPARATE from the single-card-pure {@link evaluateCardQuality}: the CALLER supplies the
 * comparison set (sibling cards under the same extract/concept, WITH their answer bodies),
 * and this function stays pure (no DB, no embeddings). The builder merges the returned row
 * into the rendered `qc` list.
 *
 * Returns `null` (no row) when the candidate has no answer text, the comparison set is
 * empty, or nothing is similar — so the check degrades gracefully to ABSENT. A heuristic
 * interference WARN over a normalized string similarity ({@link answerSimilarity} ≥
 * {@link INTERFERENCE_SIMILARITY_THRESHOLD}); true semantic similarity / duplicate
 * detection is M18/T088 and is NOT pulled into `packages/core`.
 */
export function detectInterference(
  candidate: CardQualityInput,
  siblings: readonly InterferenceCandidate[],
  threshold: number = INTERFERENCE_SIMILARITY_THRESHOLD,
): CardQualityCheck | null {
  const candidateAnswer = answerBodyOf(candidate);
  if (candidateAnswer.trim().length === 0 || siblings.length === 0) return null;

  for (const sibling of siblings) {
    const siblingAnswer = siblingAnswerBody(sibling);
    if (siblingAnswer.trim().length === 0) continue;
    if (answerSimilarity(candidateAnswer, siblingAnswer) >= threshold) {
      return {
        id: "similar-answer",
        severity: "warn",
        message: "Nearly identical to another card — they may interfere; merge or differentiate",
      };
    }
  }
  return null;
}

/** The comparable answer text of a quality input (Q&A answer, or rendered cloze body). */
function answerBodyOf(input: CardQualityInput): string {
  if (input.kind === "qa") return input.answer;
  return (input.parsed ?? parseCloze(input.cloze)).rendered;
}

/** The comparable answer text of a sibling candidate (Q&A answer, or rendered cloze). */
function siblingAnswerBody(candidate: InterferenceCandidate): string {
  if (typeof candidate.answer === "string" && candidate.answer.length > 0) return candidate.answer;
  if (typeof candidate.cloze === "string" && candidate.cloze.length > 0) {
    return parseCloze(candidate.cloze).rendered;
  }
  return "";
}

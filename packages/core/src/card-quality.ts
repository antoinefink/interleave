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
  | "code-too-long";

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

/** Discriminated quality input for a Q&A card. */
export interface QaQualityInput {
  readonly kind: "qa";
  /** The card front / question. */
  readonly prompt: string;
  /** The card back / answer. */
  readonly answer: string;
  /** Whether the card inherits a source location (lineage to source). */
  readonly hasSource: boolean;
}

/** Discriminated quality input for a cloze card. */
export interface ClozeQualityInput {
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
 */
export function evaluateCardQuality(input: CardQualityInput): CardQualityReport {
  const checks: CardQualityCheck[] = input.kind === "qa" ? evaluateQa(input) : evaluateCloze(input);

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

  // Hollow-card blocker: either side empty → cannot activate.
  if (prompt.length === 0 || answer.length === 0) {
    checks.push({
      id: "empty",
      severity: "block",
      message:
        prompt.length === 0 && answer.length === 0
          ? "Empty card — add a question and an answer"
          : prompt.length === 0
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
  if (!promptIsCode && !answerIsCode) {
    checks.push(ambiguousPronounCheck(`${prompt} ${answer}`, prompt, answer));
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
  if (!bodyIsCode) {
    checks.push(ambiguousPronounCheck(parsed.rendered, parsed.rendered, ""));
  }

  return checks;
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

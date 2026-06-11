/**
 * Source-yield scoring rule (T083).
 *
 * The incremental-reading failure mode this catches is the inverse of T046's
 * import/process imbalance: not "you imported too much", but "you spent time on a
 * source that never paid its way" — you read it (or ground its cards for review
 * time) yet it produced almost no durable knowledge. This module is the SINGLE,
 * pure, tunable place that turns a source's rollup signals (read %, extracts,
 * cards, mature cards, leeches, review time) into a `yieldScore` + a coarse
 * `band` so a ranked "Source yield" view can put the lowest-yield sources first
 * and the user can decide which to abandon.
 *
 * Why it lives in `@interleave/core` (not `packages/local-db`, not React):
 *  - the judgment is a pure function of a handful of counts, so it is trivially
 *    unit-testable and identical wherever it runs;
 *  - the SAME rule + constants back the domain aggregation (`SourceYieldQuery` in
 *    `packages/local-db`) AND any future preview/UI — they cannot disagree;
 *  - the band thresholds are documented defaults a future per-collection setting
 *    can tune, and a setting needs a home with no DB/Electron dependency.
 *
 * It is **advisory + read-only**. It never mutates, never schedules, never deletes
 * — "there is nothing to undo about looking at your stats". It only RANKS.
 *
 * ## The rule (documented + tunable)
 *
 * `yieldScore` is a non-negative number where **higher = more productive**. It
 * rewards what a source actually produced and penalizes wasted effort:
 *
 *   reward   = mature cards (most), then cards, then honorable extract exits /
 *              cards, then synthesis notes, then unresolved extracts produced;
 *   penalty  = a "read but barren" source (high read %, ~0 output) and a
 *              high leech ratio (lots of failing cards) and lots of review time
 *              spent per mature card (you ground it but little stuck).
 *
 * The three bands:
 *   - **low**     — the source has been worked (read OR reviewed) yet produced
 *                   little of value: its score is at/below {@link YIELD_LOW_SCORE}.
 *                   These lead the ranked view (the whole point).
 *   - **high**    — the source produced real durable knowledge: at/above
 *                   {@link YIELD_HIGH_SCORE}.
 *   - **medium**  — anything between.
 *
 * ## The un-started floor (false-alarm guard — load-bearing)
 *
 * A source with **no reading and no output** is *neutral*, NOT low-yield — it has
 * simply not been processed yet, exactly like a fresh inbox import. Flagging it red
 * would punish new material (the same instinct as T046's import floor and T084's
 * once-postponed extract). So `scoreSourceYield` returns `band: "neutral"` whenever
 * the source has neither been read past the floor NOR produced/reviewed anything.
 * "Worked" means `readPct >= UNSTARTED_READ_FLOOR` OR any extract/card/review
 * exists. Only a *worked* source can be ranked low/medium/high.
 */

/** The coarse yield band. `neutral` = un-started (never flagged); the rest rank a worked source. */
export type YieldBand = "high" | "medium" | "low" | "neutral";

/** The rollup signals the scorer reads — a DB-free snapshot of one source's yield. */
export interface SourceYieldInputs {
  /** How far the source has been read, in `[0, 1]` (read-point block position / block count). */
  readonly readPct: number;
  /** Live `extract` descendants created from the source. */
  readonly extractsCreated: number;
  /**
   * De-duplicated extract-level non-card value: live fated extracts plus live
   * extracts referenced by synthesis notes. These are stronger than raw extracts
   * because the user deliberately resolved the extract without forcing a card.
   */
  readonly honorableExtracts: number;
  /** Live synthesis notes that explicitly reference material from this source. */
  readonly synthesisNotesCreated: number;
  /** Live `card` descendants created from the source. */
  readonly cardsCreated: number;
  /** Cards whose FSRS stability crosses the maturity threshold (durable knowledge). */
  readonly matureCards: number;
  /** Cards currently flagged a leech (failing repeatedly). */
  readonly leeches: number;
  /** Summed review response time on the source's cards, in ms (the only durable time signal). */
  readonly timeSpentMs: number;
}

/** The verdict {@link scoreSourceYield} produces. */
export interface SourceYieldVerdict {
  /** Non-negative productivity score (higher = better). */
  readonly score: number;
  /** The coarse band the score (or the un-started floor) maps to. */
  readonly band: YieldBand;
}

/**
 * Read-% below which a source counts as "not really started reading" for the
 * un-started floor. A barely-opened source (≤ 5% read) with no output is neutral,
 * not low-yield. A named constant so a future setting can tune it.
 */
export const UNSTARTED_READ_FLOOR = 0.05;

/** Score reward per MATURE card — the strongest signal of durable yield. */
export const YIELD_WEIGHT_MATURE_CARD = 3;
/** Score reward per card created (a card is real output even before it matures). */
export const YIELD_WEIGHT_CARD = 1;
/** Score reward per resolved non-card extract (reference / synthesized / no-card). */
export const YIELD_WEIGHT_HONORABLE_EXTRACT = 1.25;
/** Score reward per synthesis note that references this source's material. */
export const YIELD_WEIGHT_SYNTHESIS_NOTE = 0.75;
/** Score reward per extract created (distillation progress, the weakest reward). */
export const YIELD_WEIGHT_EXTRACT = 0.5;

/**
 * Penalty applied to a source that has been substantially READ (`readPct` high)
 * but produced little output — "read but barren". Scaled by `readPct`, so a fully
 * read source with nothing to show is penalized most. Subtracted from the reward.
 */
export const YIELD_READ_BARREN_PENALTY = 2;
/** Output below which the read-but-barren penalty engages (≤ this is "barren"). */
export const YIELD_BARREN_OUTPUT_THRESHOLD = 1;

/**
 * Penalty per leech as a FRACTION of the source's cards (leech ratio × this). A
 * leech is a card that produced NEGATIVE value (it costs more review time than it
 * is worth), so on top of cancelling its own card reward (see below) a high leech
 * ratio drags the whole source's score down.
 */
export const YIELD_LEECH_RATIO_PENALTY = 2;

/**
 * Review-time penalty: hours of review time spent per mature card above this many
 * minutes-per-mature-card costs score (you ground the cards but little matured).
 * Only engages when there IS review time; an unreviewed source pays nothing.
 */
export const YIELD_MINUTES_PER_MATURE_PENALTY = 0.02;

/** A worked source scoring at/below this is **low** yield. */
export const YIELD_LOW_SCORE = 0.5;
/** A worked source scoring at/above this is **high** yield. */
export const YIELD_HIGH_SCORE = 2;

const MS_PER_MINUTE = 60_000;

/** Clamp a value into `[0, 1]` (defensive against a malformed `readPct`). */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A non-negative integer (defensive against malformed counts). */
function nonNegInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * Score a source's yield + assign a band. PURE — no I/O, no mutation. Higher score
 * = more productive. The bands + the un-started neutral floor are documented above.
 *
 * The score is `reward − penalties`, floored at `0`:
 *   reward    = mature×3 + honorableExtracts×1.25 + (cards − leeches)×1
 *               + synthesisNotes×0.75 + unresolvedExtracts×0.5
 *   penalties = read-but-barren (scaled by readPct) + leech-ratio + review-time-per-mature
 *
 * A leech does NOT earn its `YIELD_WEIGHT_CARD` reward (it is a card that costs more
 * than it is worth), AND a high leech ratio is penalized on top — so a source whose
 * cards are mostly leeches lands `low` even though it "produced" several cards.
 *
 * An un-started source (read ≤ floor AND no extracts/cards/review time) is
 * `neutral` regardless of score, so fresh material never lights up red.
 */
export function scoreSourceYield(inputs: SourceYieldInputs): SourceYieldVerdict {
  const readPct = clamp01(inputs.readPct);
  const extracts = nonNegInt(inputs.extractsCreated);
  const honorableExtracts = Math.min(nonNegInt(inputs.honorableExtracts), extracts);
  const synthesisNotes = nonNegInt(inputs.synthesisNotesCreated);
  const cards = nonNegInt(inputs.cardsCreated);
  const mature = Math.min(nonNegInt(inputs.matureCards), cards);
  const leeches = Math.min(nonNegInt(inputs.leeches), cards);
  const timeSpentMs = Math.max(0, Number.isFinite(inputs.timeSpentMs) ? inputs.timeSpentMs : 0);

  const unresolvedExtracts = Math.max(0, extracts - honorableExtracts);
  const output = unresolvedExtracts + honorableExtracts + synthesisNotes + cards;
  const durableNonCardOutput = honorableExtracts + synthesisNotes;
  const worked = readPct >= UNSTARTED_READ_FLOOR || output > 0 || timeSpentMs > 0;

  // The un-started floor: a never-read, never-processed source is neutral, never low.
  if (!worked) {
    return { score: 0, band: "neutral" };
  }

  // A leech earns NO card reward — it is a failing card, not durable knowledge. So only
  // the non-leech cards earn `YIELD_WEIGHT_CARD`; mature cards (never leeches) still earn
  // the mature reward on top.
  const productiveCards = Math.max(0, cards - leeches);
  const reward =
    mature * YIELD_WEIGHT_MATURE_CARD +
    honorableExtracts * YIELD_WEIGHT_HONORABLE_EXTRACT +
    productiveCards * YIELD_WEIGHT_CARD +
    synthesisNotes * YIELD_WEIGHT_SYNTHESIS_NOTE +
    unresolvedExtracts * YIELD_WEIGHT_EXTRACT;

  // Read-but-barren: a substantially-read source with ≤ threshold output is wasted
  // reading. Scaled by readPct so a fully-read barren source is penalized most.
  const barrenPenalty =
    durableNonCardOutput === 0 && output <= YIELD_BARREN_OUTPUT_THRESHOLD
      ? readPct * YIELD_READ_BARREN_PENALTY
      : 0;

  // Leech ratio: the fraction of the source's cards that are failing repeatedly.
  const leechPenalty = cards > 0 ? (leeches / cards) * YIELD_LEECH_RATIO_PENALTY : 0;

  // Review-time-per-mature: minutes of review per mature card. When NO card matured
  // but time was spent, treat it as time-per-(mature+1) so wasted grinding still costs.
  const minutes = timeSpentMs / MS_PER_MINUTE;
  const matureDenom = mature > 0 ? mature : 1;
  const timePenalty = minutes > 0 ? (minutes / matureDenom) * YIELD_MINUTES_PER_MATURE_PENALTY : 0;

  const score = Math.max(0, reward - barrenPenalty - leechPenalty - timePenalty);

  const band: YieldBand =
    score >= YIELD_HIGH_SCORE ? "high" : score <= YIELD_LOW_SCORE ? "low" : "medium";
  return { score, band };
}

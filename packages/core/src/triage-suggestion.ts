/**
 * Suggested-priority scorer (T127).
 *
 * Priority is the least-informed decision in the product: it is set cold, per
 * item, at the moment the user knows the material least. T127 turns three
 * deterministic signals that already exist in the system — semantic neighbors
 * (T087/T088), per-author/per-domain yield (T083), and source-reliability
 * metadata (T091) — into a grounded, advisory **suggested priority band**
 * (A/B/C/D) with an optional concept placement and a one-line justification.
 *
 * This module is the SINGLE, pure, tunable place that turns already-gathered
 * signal inputs into a {@link TriageSuggestionVerdict}. It mirrors
 * {@link scoreSourceYield} deliberately:
 *  - the judgment is a pure function of a handful of integer counts + bands, so
 *    it is trivially unit-testable and identical wherever it runs;
 *  - the SAME rule + constants back the read-model gathering (`packages/local-db`)
 *    AND the import-modal preview — they cannot disagree;
 *  - the floors + the confidence→cap map are named constants in ONE tunable place
 *    with no DB/Electron/React dependency.
 *
 * It is **advisory + read-only**. It never mutates, never schedules, never moves a
 * source. It only RANKS a single item's suggested band — the user accepts or
 * overrides with one keystroke; the actual write goes through the existing triage
 * command. The failure mode it engineers against is automation bias: when the
 * signals are thin it returns {@link TriageInsufficientReason} and the UI renders
 * nothing — never a confident-looking guess.
 *
 * ## The combination rule (documented + tunable — KTD3)
 *
 * Each of the three signals proposes a band **lean** ONLY when its own floor is
 * cleared (a thin signal contributes nothing — R3). The fired leans combine by one
 * pinned rule:
 *  - **0 leans fire** → `insufficient_signal("no_signal_fired")`.
 *  - **fired leans more than one band apart** (on the A>B>C>D ordinal) →
 *    `insufficient_signal("conflict_unresolved")`. Nothing reconciles a >1-band
 *    gap; there is no reconciliation step.
 *  - **otherwise** the combined band is the MOST-CONSERVATIVE (lowest-priority)
 *    of the fired leans on the A>B>C>D order — a wrong-low suggestion costs less
 *    than a wrong-high one. Exactly-one-band-apart resolves to the lower band; a
 *    same-band tie keeps that band.
 *
 * Reliability then **caps the band DOWN, never up**, driven by `confidence` (an
 * ordinal trust level), NOT by `reliabilityTier` (a scholarship-*kind* axis that
 * never moves the band). The justification is built from ONLY the signals that
 * fired (R4); if it empties, the band is not defensible →
 * `insufficient_signal("only_thin_signals")`. Finally, a suggestion equal to the
 * item's current band is a no-op → `insufficient_signal("matches_current")`.
 */

import type { PriorityLabel } from "./priority";
import type { ConfidenceLevel } from "./source-ref";
import { type SourceYieldInputs, scoreSourceYield, type YieldBand } from "./source-yield";

/**
 * Versioned evaluator signature embedded in {@link computeTriageSignalHash}. Bump
 * this string whenever the combination rule or floors change so a stored hash from
 * an older evaluator never collides with a new one (signal-hash advisory nudges).
 */
export const TRIAGE_EVALUATOR_VERSION = "t127-v1" as const;

/**
 * Minimum number of worked (non-`neutral`) prior sources an author/domain yield
 * signal needs before it fires (N=2). Below this the history is too sparse to be
 * evidence — the signal stays thin. A named constant so a future per-collection
 * setting can tune it.
 */
export const YIELD_WORKED_SOURCE_FLOOR = 2;

/**
 * Minimum number of KNN **source** neighbors carrying a non-default priority the
 * semantic signal needs before it fires (≥2). Below this the cluster is too thin
 * to lean on. A named constant in the one tunable place.
 */
export const SEMANTIC_NEIGHBOR_FLOOR = 2;

/**
 * The A/B/C/D bands ordered HIGH → LOW (strongest priority first). The combination
 * rule walks this order: index `0` (`A`) is the highest/strongest priority, index
 * `3` (`D`) is the lowest. "Most-conservative" therefore means the LARGER index
 * (the lower-priority band) — see {@link mostConservativeBand}.
 */
const BANDS_HIGH_TO_LOW: readonly PriorityLabel[] = ["A", "B", "C", "D"];

/** The ordinal of a band on the A>B>C>D order (`A`=0 … `D`=3). */
function bandOrdinal(band: PriorityLabel): number {
  return BANDS_HIGH_TO_LOW.indexOf(band);
}

/**
 * The YieldBand → priority-lean map. A `high`-yield author/domain leans toward a
 * high-priority `A`; `medium` → `B`; `low` → `C`. `neutral` never leans (the
 * caller must not pass a `neutral` band as a fired signal — its floor excludes it).
 * A named constant so the lean mapping lives in one tunable place.
 */
export const YIELD_BAND_TO_LEAN: Readonly<Record<Exclude<YieldBand, "neutral">, PriorityLabel>> = {
  high: "A",
  medium: "B",
  low: "C",
};

/**
 * The confidence → cap rule (documented + pinned — KTD3). Reliability NEVER raises
 * the band; it only caps it DOWN by a fixed number of A/B/C/D steps:
 *  - `low`    — caps the band down by one step always (e.g. `A`→`B`, `B`→`C`).
 *  - `medium` — caps the band down by one step only when the band is `A` (a strong
 *               `A` claim wants better-than-medium confidence; weaker bands are
 *               left alone — kept deliberately simple and documented).
 *  - `high`   — never caps (full trust).
 * A `null`/absent confidence never caps. `reliabilityTier` is NOT consulted here —
 * it is a scholarship-kind axis, not a trust ordinal, so it never moves the band.
 */
export const CONFIDENCE_CAP_STEPS: Readonly<Record<ConfidenceLevel, number>> = {
  high: 0,
  medium: 0, // medium only caps the strongest band (`A`); handled in capBandDown.
  low: 1,
};

/** The per-signal yield snapshot the scorer reads (author or domain). */
export interface TriageYieldSignal {
  /** The aggregate yield band over the key's worked sources (never `neutral` when fired). */
  readonly band: YieldBand;
  /** How many non-`neutral` worked prior sources backed the aggregate (for the floor + justification). */
  readonly workedSourceCount: number;
  /** Summed cards produced across those worked sources (an integer cited in the justification). */
  readonly totalCards: number;
  /** Summed mature cards across those worked sources (an integer cited in the justification). */
  readonly totalMatureCards: number;
}

/** The semantic-neighbor snapshot the scorer reads. */
export interface TriageSemanticSignal {
  /**
   * The band derived from the surviving neighbor priorities (already computed by
   * the gathering layer). This is the lean the semantic signal proposes when its
   * floor clears.
   */
  readonly lean: PriorityLabel;
  /** How many KNN source neighbors with a non-default priority backed the lean. */
  readonly sourceNeighborCount: number;
  /** True only when the seed was embedded with the real model (not the fallback). */
  readonly realModel: boolean;
}

/** The already-selected placement candidate (selection is deterministic upstream — KTD6). */
export interface TriagePlacementCandidate {
  /** The candidate concept element id. */
  readonly conceptId: string;
  /** The candidate concept's display name. */
  readonly conceptName: string;
  /** How many neighbors shared this concept (kept for upstream tie-break audit; not scored here). */
  readonly sharedByNeighborCount: number;
}

/**
 * The gathered signal inputs the scorer turns into a verdict. Every field is
 * optional/JSON-serializable: a signal that did not gather is simply absent, and
 * each present signal is re-checked against its own floor here so the floors live
 * in ONE place.
 */
export interface TriageSignalInputs {
  /** Semantic-neighbor signal, or absent when the seed is not embedded with the real model. */
  readonly semantic?: TriageSemanticSignal;
  /** Per-author yield aggregate, or absent when the author is unknown / below floor. */
  readonly authorYield?: TriageYieldSignal;
  /** Per-domain yield aggregate, or absent when the domain is unknown / below floor. */
  readonly domainYield?: TriageYieldSignal;
  /** The source's reliability confidence — caps the band DOWN only. `null`/absent never caps. */
  readonly confidence?: ConfidenceLevel | null;
  /** The item's current priority band; a suggestion equal to it is a no-op (`matches_current`). */
  readonly currentBand?: PriorityLabel;
  /** The deterministically-selected placement candidate, or absent (band-only suggestion). */
  readonly placementCandidate?: TriagePlacementCandidate;
}

/**
 * One justification clause — a discriminated record citing ONLY integer values
 * from a signal that fired. The renderer formats these into one short line and
 * never invents prose (R4).
 */
export type TriageJustificationSignal =
  | {
      readonly kind: "semantic";
      /** The number of non-default-priority KNN source neighbors that backed the lean. */
      readonly neighborCount: number;
      /** The band those neighbors leaned toward. */
      readonly lean: PriorityLabel;
    }
  | {
      readonly kind: "authorYield";
      /** The number of worked (non-`neutral`) prior sources by this author. */
      readonly workedSourceCount: number;
      /** The summed cards those sources produced. */
      readonly totalCards: number;
      /** The summed mature cards those sources produced. */
      readonly totalMatureCards: number;
      /** The aggregate yield band over those sources. */
      readonly band: YieldBand;
    }
  | {
      readonly kind: "domainYield";
      /** The number of worked (non-`neutral`) prior sources on this domain. */
      readonly workedSourceCount: number;
      /** The summed cards those sources produced. */
      readonly totalCards: number;
      /** The summed mature cards those sources produced. */
      readonly totalMatureCards: number;
      /** The aggregate yield band over those sources. */
      readonly band: YieldBand;
    };

/** The structured justification — only the signals that fired, in stable order. */
export interface TriageJustification {
  /** The fired clauses, ordered semantic → authorYield → domainYield (stable). */
  readonly signals: readonly TriageJustificationSignal[];
}

/**
 * Why a suggestion was suppressed. The scorer only ever emits the four it can
 * compute; `"not_inbox_source"` is produced by the query layer (U3) before the
 * scorer runs, but it shares this union so the reason type is one shape end-to-end.
 */
export type TriageInsufficientReason =
  | "no_signal_fired"
  | "conflict_unresolved"
  | "only_thin_signals"
  | "matches_current"
  | "not_inbox_source";

/** A banded suggestion with an optional concept placement and a cited justification. */
export interface TriageSuggestion {
  readonly kind: "suggestion";
  /** The suggested priority band (A/B/C/D), after the conservative combine + confidence cap. */
  readonly band: PriorityLabel;
  /** The optional concept placement, present only when a candidate was passed AND a band survived. */
  readonly placement?: { readonly conceptId: string; readonly conceptName: string };
  /** The structured justification citing only fired signals. */
  readonly justification: TriageJustification;
}

/** A suppressed suggestion carrying the reason (the UI renders nothing). */
export interface TriageInsufficientSignal {
  readonly kind: "insufficient_signal";
  readonly reason: TriageInsufficientReason;
}

/** The verdict {@link scoreTriageSuggestion} produces — a discriminated union. */
export type TriageSuggestionVerdict = TriageSuggestion | TriageInsufficientSignal;

/** Build an `insufficient_signal` verdict for a reason. */
function insufficient(reason: TriageInsufficientReason): TriageInsufficientSignal {
  return { kind: "insufficient_signal", reason };
}

/** A non-negative integer (defensive against malformed counts), mirroring source-yield. */
function nonNegInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * The most-conservative (lowest-priority) band among the fired leans — the LARGER
 * ordinal on the A>B>C>D order. With leans `[A, B]` this returns `B`; with a
 * same-band tie it returns that band. This is the documented combine rule: a
 * wrong-low suggestion costs less than a wrong-high one.
 */
function mostConservativeBand(leans: readonly PriorityLabel[]): PriorityLabel {
  let chosen = leans[0] as PriorityLabel;
  for (const lean of leans) {
    if (bandOrdinal(lean) > bandOrdinal(chosen)) chosen = lean;
  }
  return chosen;
}

/**
 * Cap a band DOWN (toward lower priority) by `confidence`, never up. Returns the
 * possibly-lowered band, clamped at `D`. See {@link CONFIDENCE_CAP_STEPS}: `low`
 * always steps down one; `medium` steps down one only when the band is `A`; `high`
 * and a `null`/absent confidence never cap.
 */
function capBandDown(
  band: PriorityLabel,
  confidence: ConfidenceLevel | null | undefined,
): PriorityLabel {
  if (confidence == null) return band;
  let steps = CONFIDENCE_CAP_STEPS[confidence];
  // `medium` only caps the strongest band (`A`) — weaker bands are left alone.
  if (confidence === "medium") {
    steps = band === "A" ? 1 : 0;
  }
  if (steps <= 0) return band;
  const lowered = Math.min(BANDS_HIGH_TO_LOW.length - 1, bandOrdinal(band) + steps);
  return BANDS_HIGH_TO_LOW[lowered] as PriorityLabel;
}

/** Whether a yield signal clears its floor (present, worked-count ≥ floor, non-neutral band). */
function yieldFires(signal: TriageYieldSignal | undefined): signal is TriageYieldSignal {
  return (
    signal != null &&
    nonNegInt(signal.workedSourceCount) >= YIELD_WORKED_SOURCE_FLOOR &&
    signal.band !== "neutral"
  );
}

/** Whether the semantic signal clears its floor (real model + ≥ floor non-default neighbors). */
function semanticFires(signal: TriageSemanticSignal | undefined): signal is TriageSemanticSignal {
  return (
    signal != null &&
    signal.realModel === true &&
    nonNegInt(signal.sourceNeighborCount) >= SEMANTIC_NEIGHBOR_FLOOR
  );
}

/**
 * Score gathered signal inputs into a suggested band + optional placement +
 * justification, or an `insufficient_signal` verdict. PURE + TOTAL — no I/O, no
 * `Date.now`, no `Math.random`, deterministic over `(semantic?, authorYield?,
 * domainYield?, confidence?, currentBand?, placementCandidate?)`. The combination
 * rule, floors, and confidence cap are documented at the top of this module.
 *
 * The pipeline (KTD3): evaluate each floor → 0 leans = `no_signal_fired` →
 * >1-band gap = `conflict_unresolved` → most-conservative combine → cap down by
 * confidence → filter justification to fired signals (empty = `only_thin_signals`)
 * → suppress when equal to the current band (`matches_current`) → attach placement
 * only when a candidate was passed AND a band survived.
 */
export function scoreTriageSuggestion(inputs: TriageSignalInputs): TriageSuggestionVerdict {
  const fired: TriageJustificationSignal[] = [];
  const leans: PriorityLabel[] = [];

  // Semantic: fires only when embedded with the real model AND ≥ the neighbor floor.
  if (semanticFires(inputs.semantic)) {
    const sem = inputs.semantic;
    leans.push(sem.lean);
    fired.push({
      kind: "semantic",
      neighborCount: nonNegInt(sem.sourceNeighborCount),
      lean: sem.lean,
    });
  }

  // Author yield: fires only when ≥ N worked, non-`neutral` prior sources by the author.
  const authorFired = yieldFires(inputs.authorYield);
  if (authorFired) {
    const a = inputs.authorYield as TriageYieldSignal;
    leans.push(YIELD_BAND_TO_LEAN[a.band as Exclude<YieldBand, "neutral">]);
    fired.push({
      kind: "authorYield",
      workedSourceCount: nonNegInt(a.workedSourceCount),
      totalCards: nonNegInt(a.totalCards),
      totalMatureCards: nonNegInt(a.totalMatureCards),
      band: a.band,
    });
  }

  // Domain yield: same floor as author. When BOTH fire we PREFER author (domain is
  // dropped from both the lean set AND the justification); domain only contributes
  // when author is absent.
  if (yieldFires(inputs.domainYield) && !authorFired) {
    const d = inputs.domainYield as TriageYieldSignal;
    leans.push(YIELD_BAND_TO_LEAN[d.band as Exclude<YieldBand, "neutral">]);
    fired.push({
      kind: "domainYield",
      workedSourceCount: nonNegInt(d.workedSourceCount),
      totalCards: nonNegInt(d.totalCards),
      totalMatureCards: nonNegInt(d.totalMatureCards),
      band: d.band,
    });
  }

  // 0 leans → nothing fired its floor.
  if (leans.length === 0) {
    return insufficient("no_signal_fired");
  }

  // A >1-band gap cannot be reconciled (there is no reconciliation step).
  const ordinals = leans.map(bandOrdinal);
  const spread = Math.max(...ordinals) - Math.min(...ordinals);
  if (spread > 1) {
    return insufficient("conflict_unresolved");
  }

  // Most-conservative (lowest-priority) of the fired leans, then cap DOWN by confidence.
  const combined = mostConservativeBand(leans);
  const band = capBandDown(combined, inputs.confidence);

  // DEFENSIVE / currently unreachable: `fired` and `leans` are populated together (one
  // justification clause per fired lean), so once the `leans.length === 0` guard above
  // has passed, `fired` is non-empty. This branch exists so that if a future signal ever
  // contributes a lean WITHOUT a citable justification clause, the band degrades to
  // `only_thin_signals` rather than shipping an uncited suggestion (R4 honesty). Keep it.
  if (fired.length === 0) {
    return insufficient("only_thin_signals");
  }

  // A suggestion equal to the item's current band is a no-op — suppress it (anti-slop).
  if (inputs.currentBand != null && band === inputs.currentBand) {
    return insufficient("matches_current");
  }

  const suggestion: TriageSuggestion = {
    kind: "suggestion",
    band,
    justification: { signals: fired },
  };
  // Placement rides along only when a candidate was passed AND a band survived.
  if (inputs.placementCandidate != null) {
    return {
      ...suggestion,
      placement: {
        conceptId: inputs.placementCandidate.conceptId,
        conceptName: inputs.placementCandidate.conceptName,
      },
    };
  }
  return suggestion;
}

/**
 * A stable, versioned signature for the evidence behind a suggested `band`. Same
 * inputs + band → byte-identical string. Built ONLY from the evaluator version,
 * the sorted fired signal kinds, the band, and INTEGER counters (neighbor count +
 * worked-source counts) — never floats-alone, never timestamps — so the same
 * evidence hashes identically for future acceptance-vs-override tuning.
 */
export function computeTriageSignalHash(inputs: TriageSignalInputs, band: PriorityLabel): string {
  const parts: string[] = [];

  if (semanticFires(inputs.semantic)) {
    parts.push(`semantic:${nonNegInt(inputs.semantic.sourceNeighborCount)}`);
  }
  const authorFired = yieldFires(inputs.authorYield);
  if (authorFired) {
    parts.push(
      `authorYield:${nonNegInt((inputs.authorYield as TriageYieldSignal).workedSourceCount)}`,
    );
  }
  if (yieldFires(inputs.domainYield) && !authorFired) {
    parts.push(
      `domainYield:${nonNegInt((inputs.domainYield as TriageYieldSignal).workedSourceCount)}`,
    );
  }

  // Sort so iteration order never affects the hash.
  parts.sort();
  return [TRIAGE_EVALUATOR_VERSION, `band:${band}`, ...parts].join("|");
}

/**
 * Collapse summed per-source yield tallies into ONE aggregate band by re-running
 * {@link scoreSourceYield} on the summed tallies. This is the single shared
 * collapse rule U1 and U2 both use — the aggregate band is NEVER a per-row average
 * or majority vote, always `scoreSourceYield(summed tallies).band`. The caller
 * supplies the summed tallies across a key's worked sources; the band comes from
 * the existing yield scorer so the two layers can never disagree.
 */
export function authorDomainYieldBand(summedTallies: SourceYieldInputs): YieldBand {
  return scoreSourceYield(summedTallies).band;
}

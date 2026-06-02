/**
 * Desired-retention RESOLVER (T079) — the CARD half of the two-scheduler split.
 *
 * FSRS no longer schedules every card against ONE global desired-retention number.
 * A card's EFFECTIVE target retention is RESOLVED from a small, ordered rule set —
 * a per-card override, else the card's concept target, else its A/B/C/D priority-
 * band target, else the global default — so high-value (A) / fragile concepts can
 * be held at, say, `0.92` while low-value (D) / background concepts sit at `0.85`
 * (longer intervals, less daily load).
 *
 * THE TWO-SCHEDULER SPLIT (load-bearing): this is a CARD-ONLY concept. It feeds
 * `CardSchedulerService` (FSRS) the resolved `request_retention`; it never touches
 * the attention scheduler. The per-card scheduler factory in the DB service maps a
 * card's concept memberships → concept NAMES before calling this, so `conceptNames`
 * and `byConcept`'s keys MATCH (both are concept *names*, not `ElementId`s).
 *
 * This module is PURE + deterministic: no DB, no IPC, no React, no `ts-fsrs`. Every
 * branch is CLAMPED to `[DESIRED_RETENTION_MIN, DESIRED_RETENTION_MAX]` so a corrupt
 * stored value (a near-zero override, an out-of-range band) can NEVER reach FSRS —
 * the same choke-point discipline as `@interleave/core`'s `coerceSettingValue`.
 */

import {
  DESIRED_RETENTION_MAX,
  DESIRED_RETENTION_MIN,
  type Priority,
  type PriorityLabel,
  priorityToLabel,
} from "@interleave/core";

/**
 * Which rule resolved a card's effective retention — surfaced by the
 * inspector/debug read (`retention.resolveFor`) so the user can see WHY a card
 * holds the target it does.
 */
export type RetentionSource = "card" | "concept" | "band" | "global";

/**
 * The full set of retention targets for the live DB, assembled by the
 * `RetentionService` from settings + the concept repository:
 *
 *  - `global`    — `settings.defaultDesiredRetention` (the T036 single number).
 *  - `byBand`    — `settings.retentionByBand` (a PARTIAL map; a MISSING band inherits
 *    `global`, so an absent/empty map is a clean no-op — see the settings model).
 *  - `byConcept` — `ConceptRepository.retentionTargets()`, keyed by concept NAME
 *    (the `Math.max`-by-name dedup), `null`/absent entries dropped.
 *  - `enabled`   — when `false`, bands/concepts are IGNORED (only `card` override +
 *    `global` apply), so toggling the feature off is a clean revert to T036.
 */
export interface RetentionTargets {
  readonly global: number;
  readonly byBand?: Partial<Record<PriorityLabel, number>>;
  readonly byConcept?: Readonly<Record<string, number>>;
  readonly enabled: boolean;
}

/** Input to {@link resolveDesiredRetention}. */
export interface RetentionResolveInput {
  /** The card's numeric priority (`elements.priority`); bucketed to A/B/C/D. */
  readonly priority: Priority;
  /**
   * The NAMES of the live concepts the card belongs to (mapped from
   * `ConceptRepository.conceptsForElement(cardId).map(c => c.name)`). Matched
   * against `targets.byConcept`'s name keys. Absent/empty = no concept rule.
   */
  readonly conceptNames?: readonly string[];
  /**
   * The per-card override (`cards.desired_retention`), or `null`/absent to inherit.
   * When finite it WINS over everything (clamped to the bounds — an override can
   * never reach a self-retiring near-zero target; T082's `is_retired` flag is the
   * retirement mechanism, not this).
   */
  readonly cardOverride?: number | null;
  /** The live retention targets for the DB. */
  readonly targets: RetentionTargets;
}

/** The resolved target + which rule won (for the inspector/debug read). */
export interface RetentionResolution {
  readonly target: number;
  readonly source: RetentionSource;
}

/** Clamp any candidate into the supported retention band. NaN/Inf → the floor. */
function clampRetention(value: number): number {
  if (!Number.isFinite(value)) return DESIRED_RETENTION_MIN;
  return Math.min(DESIRED_RETENTION_MAX, Math.max(DESIRED_RETENTION_MIN, value));
}

/**
 * Resolve a card's effective FSRS desired-retention target AND which rule won.
 *
 * Resolution order (first match wins):
 *  1. a finite `cardOverride`;
 *  2. when `enabled` and the card has a concept whose NAME has a `byConcept` entry —
 *     the HIGHEST target among the card's concept names (hold to the strictest
 *     concept, so a card shared by a fragile concept is protected);
 *  3. when `enabled`, the `byBand[priorityToLabel(priority)]` target (when present);
 *  4. `global`.
 *
 * Every branch is clamped to `[DESIRED_RETENTION_MIN, DESIRED_RETENTION_MAX]`. When
 * `enabled` is `false`, only `cardOverride` (if finite) and `global` apply.
 */
export function resolveDesiredRetentionDetailed(input: RetentionResolveInput): RetentionResolution {
  const { priority, conceptNames, cardOverride, targets } = input;

  // (1) A finite per-card override always wins (clamped — never near-zero).
  if (typeof cardOverride === "number" && Number.isFinite(cardOverride)) {
    return { target: clampRetention(cardOverride), source: "card" };
  }

  if (targets.enabled) {
    // (2) The HIGHEST (strictest) target among the card's concepts that have an
    // entry — averaging would silently under-protect a fragile card.
    const byConcept = targets.byConcept;
    if (byConcept && conceptNames && conceptNames.length > 0) {
      let best: number | null = null;
      for (const name of conceptNames) {
        const candidate = byConcept[name];
        if (typeof candidate === "number" && Number.isFinite(candidate)) {
          const clamped = clampRetention(candidate);
          if (best === null || clamped > best) best = clamped;
        }
      }
      if (best !== null) return { target: best, source: "concept" };
    }

    // (3) The priority-band target (an ABSENT band inherits `global`).
    const band = targets.byBand?.[priorityToLabel(priority)];
    if (typeof band === "number" && Number.isFinite(band)) {
      return { target: clampRetention(band), source: "band" };
    }
  }

  // (4) The global default.
  return { target: clampRetention(targets.global), source: "global" };
}

/**
 * The resolved effective retention target only (the scheduler factory's hot path).
 * See {@link resolveDesiredRetentionDetailed} for the resolution order + which rule
 * won; this is the value `CardSchedulerService` schedules against.
 */
export function resolveDesiredRetention(input: RetentionResolveInput): number {
  return resolveDesiredRetentionDetailed(input).target;
}

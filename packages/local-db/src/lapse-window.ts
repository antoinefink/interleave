/**
 * lapse-window — the ONE canonical definition of "a lapse happened in a recent
 * window across a live card" (T128, extracted from T114's `descendant-health-query`).
 *
 * The spec for both T114 (descendant-health source rescheduling) and T128 (lapse-cluster
 * detection) mandates that exactly one lapse-aggregation definition exists, so the two
 * surfaces can never contradict the leech screen. This module holds the shared primitive:
 *  - `windowStart` — the rolling-window lower bound.
 *  - `LIVE_CARD_STATUSES` — the lifecycle statuses a card must be in to count.
 *  - `liveCardLapseWhere` — the Drizzle predicate fragment selecting **true lapse
 *    increments** (`nextLapses > prevLapses`) on **live, non-retired** cards inside an
 *    inclusive `[since, asOf]` window, EXCLUDING T125 re-stabilization marker rows.
 *
 * Read-only: this module builds query predicates only. It never mutates and never appends
 * an `operation_log` row. Each caller adds its own scope clause (e.g. `eq(sourceId, …)`
 * for T114, grouping for T128) and its own thresholds — only the predicate is shared.
 */

import type { IsoTimestamp } from "@interleave/core";
import { cards, elements, reviewLogs } from "@interleave/db";
import { and, eq, gte, inArray, isNull, lte, type SQL, sql } from "drizzle-orm";

const DAY_MS = 86_400_000;

/** Lifecycle statuses a card must hold to count as a live, in-rotation card. */
export const LIVE_CARD_STATUSES = ["active", "scheduled"] as const;

/**
 * The rolling-window lower bound: `asOf − windowDays`, as an ISO timestamp.
 * Throws on an unparseable `asOf` (matches the prior T114 behavior).
 */
export function windowStart(asOf: IsoTimestamp, windowDays: number): IsoTimestamp {
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(asOfMs)) {
    throw new Error(`Invalid asOf timestamp: ${asOf}`);
  }
  return new Date(asOfMs - windowDays * DAY_MS).toISOString() as IsoTimestamp;
}

/**
 * The shared WHERE fragment for counting true lapse increments on live cards in a window.
 * Intended for a query joining `reviewLogs` → `elements` → `cards`. The caller supplies
 * the join and any additional scope clause via `extra` (e.g. `eq(elements.sourceId, id)`).
 *
 * Predicates (the canonical lapse definition — do not re-derive elsewhere):
 *  - `elements.type = "card"`, status in {@link LIVE_CARD_STATUSES}, `deletedAt IS NULL`,
 *    `cards.isRetired = false` — live, in-rotation, non-retired cards only.
 *  - `reviewedAt` within the inclusive `[since, asOf]` window.
 *  - `editMarkerAt IS NULL` — EXCLUDE T125 re-stabilization marker rows EXPLICITLY (kept
 *    grep-able even though the increment predicate already drops them by construction).
 *  - `nextLapses > prevLapses` — only true lapse increments (NULL-safe: legacy NULL
 *    lapse columns yield NULL → not matched → contribute 0).
 */
export function liveCardLapseWhere(
  since: IsoTimestamp,
  asOf: IsoTimestamp,
  ...extra: Array<SQL | undefined>
): SQL | undefined {
  return and(
    eq(elements.type, "card"),
    inArray(elements.status, [...LIVE_CARD_STATUSES]),
    isNull(elements.deletedAt),
    eq(cards.isRetired, false),
    gte(reviewLogs.reviewedAt, since),
    lte(reviewLogs.reviewedAt, asOf),
    isNull(reviewLogs.editMarkerAt),
    sql`${reviewLogs.nextLapses} > ${reviewLogs.prevLapses}`,
    ...extra,
  );
}

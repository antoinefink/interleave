import type { ElementId, IsoTimestamp } from "@interleave/core";
import { cards, elements, reviewLogs } from "@interleave/db";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { DbClient } from "./types";

export const DESCENDANT_HEALTH_WINDOW_DAYS = 30;
export const MIN_DESCENDANT_LAPSE_COUNT = 3;
export const MIN_DESCENDANT_AFFECTED_CARD_COUNT = 2;
export const MIN_DESCENDANT_LAPSE_RATE = 0.1;

const DAY_MS = 86_400_000;
const LIVE_CARD_STATUSES = ["active", "scheduled"] as const;

export interface DescendantHealth {
  readonly descendantLapseCount: number;
  readonly affectedCardCount: number;
  readonly descendantCardCount: number;
  readonly descendantLapseRate: number;
}

export interface DescendantHealthQueryInput {
  readonly sourceId: ElementId;
  readonly asOf: IsoTimestamp;
  readonly windowDays?: number;
}

function windowStart(asOf: IsoTimestamp, windowDays: number): IsoTimestamp {
  const asOfMs = Date.parse(asOf);
  if (Number.isNaN(asOfMs)) {
    throw new Error(`Invalid asOf timestamp: ${asOf}`);
  }
  return new Date(asOfMs - windowDays * DAY_MS).toISOString() as IsoTimestamp;
}

export class DescendantHealthQuery {
  constructor(private readonly db: DbClient) {}

  getSourceDescendantHealth(input: DescendantHealthQueryInput): DescendantHealth | null {
    const windowDays = input.windowDays ?? DESCENDANT_HEALTH_WINDOW_DAYS;
    const since = windowStart(input.asOf, windowDays);

    const countRow = this.db
      .select({ value: sql<number>`count(distinct ${elements.id})` })
      .from(elements)
      .innerJoin(cards, eq(cards.elementId, elements.id))
      .where(
        and(
          eq(elements.type, "card"),
          eq(elements.sourceId, input.sourceId),
          inArray(elements.status, [...LIVE_CARD_STATUSES]),
          isNull(elements.deletedAt),
          eq(cards.isRetired, false),
        ),
      )
      .get();

    const descendantCardCount = Number(countRow?.value ?? 0);
    if (descendantCardCount === 0) {
      return null;
    }

    const lapseRow = this.db
      .select({
        lapseCount: sql<number>`sum(${reviewLogs.nextLapses} - ${reviewLogs.prevLapses})`,
        affectedCardCount: sql<number>`count(distinct ${reviewLogs.elementId})`,
      })
      .from(reviewLogs)
      .innerJoin(elements, eq(elements.id, reviewLogs.elementId))
      .innerJoin(cards, eq(cards.elementId, elements.id))
      .where(
        and(
          eq(elements.type, "card"),
          eq(elements.sourceId, input.sourceId),
          inArray(elements.status, [...LIVE_CARD_STATUSES]),
          isNull(elements.deletedAt),
          eq(cards.isRetired, false),
          gte(reviewLogs.reviewedAt, since),
          lte(reviewLogs.reviewedAt, input.asOf),
          sql`${reviewLogs.nextLapses} > ${reviewLogs.prevLapses}`,
        ),
      )
      .get();

    const descendantLapseCount = Number(lapseRow?.lapseCount ?? 0);
    if (descendantLapseCount < MIN_DESCENDANT_LAPSE_COUNT) {
      return null;
    }

    const affectedCardCount = Number(lapseRow?.affectedCardCount ?? 0);
    if (affectedCardCount < MIN_DESCENDANT_AFFECTED_CARD_COUNT) {
      return null;
    }

    const descendantLapseRate = descendantLapseCount / descendantCardCount;
    if (descendantLapseRate < MIN_DESCENDANT_LAPSE_RATE) {
      return null;
    }

    return {
      descendantLapseCount,
      affectedCardCount,
      descendantCardCount,
      descendantLapseRate,
    };
  }
}

import type { ElementId, IsoTimestamp } from "@interleave/core";
import { priorityToLabel } from "@interleave/core";
import { elements, type InterleaveDatabase } from "@interleave/db";
import { and, count, eq, isNull, lte } from "drizzle-orm";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ParkedResurfacingRow {
  readonly element: {
    readonly id: ElementId;
    readonly type: "source";
    readonly title: string;
    readonly priority: number;
    readonly priorityLabel: string;
    readonly createdAt: IsoTimestamp;
  };
  readonly parkedAt: IsoTimestamp;
  readonly ageDays: number;
}

export interface ParkedResurfacingListOptions {
  readonly asOf: IsoTimestamp;
  readonly resurfaceAfterDays: number;
  readonly limit?: number;
}

export interface ParkedResurfacingListResult {
  readonly rows: readonly ParkedResurfacingRow[];
  readonly totalDue: number;
  readonly limit: number | null;
  readonly asOf: IsoTimestamp;
}

export function parkedResurfacingCutoff(
  asOf: IsoTimestamp,
  resurfaceAfterDays: number,
): IsoTimestamp {
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs)) {
    throw new Error(`Invalid parked resurfacing clock: ${asOf}`);
  }
  return new Date(asOfMs - resurfaceAfterDays * DAY_MS).toISOString() as IsoTimestamp;
}

export function isParkedDueForResurfacing(
  parkedAt: IsoTimestamp | null,
  asOf: IsoTimestamp,
  resurfaceAfterDays: number,
): boolean {
  if (!parkedAt) return false;
  return Date.parse(parkedAt) <= Date.parse(parkedResurfacingCutoff(asOf, resurfaceAfterDays));
}

export class ParkedResurfacingQuery {
  constructor(private readonly db: InterleaveDatabase) {}

  countDue(options: ParkedResurfacingListOptions): number {
    const cutoff = parkedResurfacingCutoff(options.asOf, options.resurfaceAfterDays);
    return (
      this.db
        .select({ value: count() })
        .from(elements)
        .where(
          and(
            eq(elements.type, "source"),
            eq(elements.status, "parked"),
            isNull(elements.deletedAt),
            lte(elements.parkedAt, cutoff),
          ),
        )
        .get()?.value ?? 0
    );
  }

  listDue(options: ParkedResurfacingListOptions): ParkedResurfacingListResult {
    const cutoff = parkedResurfacingCutoff(options.asOf, options.resurfaceAfterDays);
    const base = this.db
      .select()
      .from(elements)
      .where(
        and(
          eq(elements.type, "source"),
          eq(elements.status, "parked"),
          isNull(elements.deletedAt),
          lte(elements.parkedAt, cutoff),
        ),
      )
      .orderBy(elements.parkedAt, elements.updatedAt);
    const rows = (options.limit ? base.limit(options.limit) : base).all();
    const totalDue = this.countDue(options);
    const asOfMs = Date.parse(options.asOf);
    return {
      totalDue,
      limit: options.limit ?? null,
      asOf: options.asOf,
      rows: rows.map((row) => {
        const parkedAt = row.parkedAt as IsoTimestamp;
        return {
          element: {
            id: row.id as ElementId,
            type: "source",
            title: row.title,
            priority: row.priority,
            priorityLabel: priorityToLabel(row.priority),
            createdAt: row.createdAt as IsoTimestamp,
          },
          parkedAt,
          ageDays: Math.max(0, Math.floor((asOfMs - Date.parse(parkedAt)) / DAY_MS)),
        };
      }),
    };
  }
}

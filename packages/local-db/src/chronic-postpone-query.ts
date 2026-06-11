/**
 * ChronicPostponeQuery (T106) — read-only reckoning list.
 *
 * Items enter the list when their EFFECTIVE postpone count reaches the user setting
 * threshold. The count is folded from `operation_log` postpone/reset markers via
 * `OperationLogRepository.countPostpones`; there is no mutable counter column and
 * this query appends no log rows.
 *
 * Scope is intentionally narrower than "all elements": sources, topics, extracts,
 * synthesis notes, and cards. Tasks are excluded because verification tasks have
 * their own service path; concepts/media fragments are not part of the T106 forced
 * decision surface.
 */

import type { ElementId, ElementStatus, ElementType, IsoTimestamp } from "@interleave/core";
import { priorityToLabel } from "@interleave/core";
import { cards, elements, type InterleaveDatabase } from "@interleave/db";
import { and, asc, inArray, isNull } from "drizzle-orm";
import { OperationLogRepository } from "./operation-log-repository";
import { isQueueActionableStatus } from "./queue-repository";

export const CHRONIC_POSTPONE_TYPES = [
  "source",
  "topic",
  "extract",
  "synthesis_note",
  "card",
] as const satisfies readonly ElementType[];

export interface ChronicPostponeElementRef {
  readonly id: ElementId;
  readonly type: (typeof CHRONIC_POSTPONE_TYPES)[number];
  readonly title: string;
  readonly priority: number;
  readonly priorityLabel: string;
  readonly status: ElementStatus;
  readonly dueAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
}

export interface ChronicPostponeRow {
  readonly element: ChronicPostponeElementRef;
  readonly scheduler: "attention" | "fsrs";
  readonly postponeCount: number;
}

export interface ChronicPostponeListOptions {
  readonly threshold: number;
  readonly limit?: number;
}

export interface ChronicPostponeListResult {
  readonly rows: readonly ChronicPostponeRow[];
  readonly totalDue: number;
  readonly threshold: number;
  readonly limit: number | null;
}

function normalizeThreshold(threshold: number): number {
  return Number.isFinite(threshold) && threshold > 0 ? Math.floor(threshold) : 1;
}

export class ChronicPostponeQuery {
  private readonly operationLog: OperationLogRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.operationLog = new OperationLogRepository(db);
  }

  countDue(options: ChronicPostponeListOptions): number {
    return this.listCandidates(normalizeThreshold(options.threshold)).length;
  }

  listDue(options: ChronicPostponeListOptions): ChronicPostponeListResult {
    const threshold = normalizeThreshold(options.threshold);
    const candidates = this.listCandidates(threshold);
    const rows = options.limit ? candidates.slice(0, options.limit) : candidates;
    return {
      rows,
      totalDue: candidates.length,
      threshold,
      limit: options.limit ?? null,
    };
  }

  private listCandidates(threshold: number): ChronicPostponeRow[] {
    const retiredCards = new Set(
      this.db
        .select({ elementId: cards.elementId, isRetired: cards.isRetired })
        .from(cards)
        .all()
        .filter((row) => row.isRetired)
        .map((row) => row.elementId),
    );
    const rows = this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        status: elements.status,
        dueAt: elements.dueAt,
        createdAt: elements.createdAt,
      })
      .from(elements)
      .where(andLiveSupported())
      .orderBy(asc(elements.updatedAt), asc(elements.createdAt))
      .all();

    const out: ChronicPostponeRow[] = [];
    for (const row of rows) {
      if (!isQueueActionableStatus(row.status as ElementStatus)) continue;
      if (row.type === "card" && retiredCards.has(row.id)) continue;
      const postponeCount = this.operationLog.countPostpones(row.id);
      if (postponeCount < threshold) continue;
      out.push({
        element: {
          id: row.id as ElementId,
          type: row.type as ChronicPostponeElementRef["type"],
          title: row.title,
          priority: row.priority,
          priorityLabel: priorityToLabel(row.priority),
          status: row.status as ElementStatus,
          dueAt: row.dueAt as IsoTimestamp | null,
          createdAt: row.createdAt as IsoTimestamp,
        },
        scheduler: row.type === "card" ? "fsrs" : "attention",
        postponeCount,
      });
    }
    return out.sort(
      (a, b) =>
        b.postponeCount - a.postponeCount ||
        b.element.priority - a.element.priority ||
        String(a.element.dueAt ?? "").localeCompare(String(b.element.dueAt ?? "")),
    );
  }
}

function andLiveSupported() {
  return and(
    isNull(elements.deletedAt),
    inArray(elements.type, CHRONIC_POSTPONE_TYPES as readonly string[]),
  );
}

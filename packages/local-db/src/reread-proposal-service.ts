/**
 * RereadProposalService (T129) — turn a detected lapse cluster (T128) into scheduled
 * re-read WORK.
 *
 * A **proposal** is computed, never stored (mirrors T103 retirement suggestions): it is a
 * live `LapseClusterQuery` cluster MINUS (a dismissal whose state-hash still matches) MINUS
 * (a `reread_region` task for that region that is open OR completed within the grace window),
 * then capped to the strongest `cap` at once (a surfacing throttle, not an accept budget).
 *
 * - **Accept** schedules a system-owned `reread_region` `task` element (one transaction:
 *   `create_element` + N `references` `add_relation` to the failing cards) due now, targeting
 *   the cluster's nearest-live-source-region ancestor. One open re-read per region is enforced
 *   by the existing `tasks_open_link_type_uq` partial index (pre-checked + caught as a race
 *   belt). Reversal is a soft-delete of the task element ("creates are undone by deleting" —
 *   `create_element`/`add_relation` are NOT globally invertible).
 * - **Dismiss** remembers the cluster's state-hash (recompute-reject-stale + upsert +
 *   `update_element`, one transaction). The hash bands the lapse count, so a dismissed proposal
 *   reappears only on a MATERIAL worsening (a band step or a new member card), never on every
 *   single new lapse.
 *
 * Read-only for `listProposals` / `itemDetail` (no mutation, no op-log). FSRS card state
 * (`cards` / `review_states` / `review_logs`) is NEVER touched by any path here.
 */

import type { ElementId, IsoTimestamp, Priority } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import {
  cards,
  elementRelations,
  elements as elementsTable,
  type InterleaveDatabase,
  rereadProposalDismissals,
  reviewLogs,
  sourceLocations,
  tasks as tasksTable,
} from "@interleave/db";
import { and, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import { nowIso } from "./ids";
import { type LapseCluster, LapseClusterQuery } from "./lapse-cluster-query";
import { LIVE_CARD_STATUSES, liveCardLapseWhere, windowStart } from "./lapse-window";
import { OperationLogRepository } from "./operation-log-repository";
import { TASK_STAGE } from "./task-service";

/** State-hash version (KTD-4). Bump only when the hash composition changes. */
export const REREAD_STATE_HASH_VERSION = "v1";
/**
 * Grace window (days) after a re-read is scheduled OR completed during which the SAME region
 * is not re-proposed — the completed task is the suppression memory, no separate table (KTD-1).
 */
export const REREAD_GRACE_DAYS = 14;
/** A practically-unbounded limit for ancestor-scoped cluster recomputes in accept/dismiss. */
const RECOMPUTE_LIMIT = 100_000;

/** Closed (terminal) task statuses — an open task is one NOT in this set. */
const CLOSED_TASK_STATUSES = ["done", "parked", "dismissed", "deleted"] as const;

export interface RereadProposalThresholds {
  readonly minLapses: number;
  readonly windowDays: number;
  readonly minCards: number;
}

/** A surfaced re-read proposal — a live cluster plus its dismissal state-hash. */
export interface RereadProposal extends LapseCluster {
  /** The cluster state-hash; passed back to `dismiss` so a stale dismissal is rejected. */
  readonly stateHash: string;
  /** Always `true` for a surfaced proposal — the dismiss affordance gate. */
  readonly dismissable: boolean;
}

export interface ListRereadProposalsInput {
  /** When provided, restrict to proposals whose region points into THIS source. */
  readonly sourceId?: ElementId;
  readonly asOf: IsoTimestamp;
  readonly enabled: boolean;
  readonly thresholds: RereadProposalThresholds;
  /** Surfacing cap — at most this many ACTIVE proposals are returned, strongest-first. */
  readonly cap: number;
}

export interface RereadItemMember {
  readonly cardId: ElementId;
  readonly prompt: string;
  /** Current true in-window lapse increments for this card (re-derived live; 0 if recovered). */
  readonly windowLapseCount: number;
}

export interface RereadItemRegion {
  readonly sourceElementId: ElementId;
  readonly blockIds: string[];
  readonly label: string;
  readonly page: number | null;
}

export interface RereadItemDetail {
  readonly taskElementId: ElementId;
  readonly region: RereadItemRegion;
  readonly members: RereadItemMember[];
}

export interface RereadItemDetailInput {
  readonly taskElementId: ElementId;
  readonly asOf: IsoTimestamp;
  readonly windowDays: number;
}

export interface AcceptRereadProposalInput {
  readonly ancestorId: ElementId;
  readonly asOf: IsoTimestamp;
  readonly thresholds: RereadProposalThresholds;
  /** Explicit priority; default = the ancestor extract's priority, else `B`. */
  readonly priority?: Priority;
}

export interface AcceptRereadProposalResult {
  readonly created: boolean;
  readonly taskElementId: ElementId | null;
  /** The region already has an open re-read item — nothing created. */
  readonly alreadyOpen: boolean;
  /** The cluster no longer exists (cards recovered) — nothing created. */
  readonly stale: boolean;
}

export interface DismissRereadProposalInput {
  readonly ancestorId: ElementId;
  readonly stateHash: string;
  readonly asOf: IsoTimestamp;
  readonly thresholds: RereadProposalThresholds;
}

export interface DismissRereadProposalResult {
  readonly dismissed: boolean;
  /** The supplied hash no longer matches the recomputed cluster — nothing persisted. */
  readonly stale: boolean;
}

export interface UndoAcceptRereadResult {
  readonly removed: boolean;
}

/**
 * Pure, deterministic, banded + versioned cluster state-hash (KTD-4). Bands the lapse count
 * by the K threshold so a dismissed proposal reappears only on a MATERIAL step, not on every
 * new lapse. `affectedCardCount` is exact — a NEW member card legitimately re-surfaces it.
 */
export function rereadClusterStateHash(
  cluster: Pick<LapseCluster, "ancestorId" | "totalWindowLapses" | "affectedCardCount">,
  thresholds: RereadProposalThresholds,
): string {
  const band =
    thresholds.minLapses > 0
      ? Math.floor(cluster.totalWindowLapses / thresholds.minLapses)
      : cluster.totalWindowLapses;
  return [
    REREAD_STATE_HASH_VERSION,
    cluster.ancestorId,
    `k${thresholds.minLapses}`,
    `w${thresholds.windowDays}`,
    `c${thresholds.minCards}`,
    `band${band}`,
    `cards${cluster.affectedCardCount}`,
  ].join("|");
}

function parseBlockIds(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Whether an error is the `tasks_open_link_type_uq` (one-open-per-region) unique violation. */
function isOpenRereadUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error && /UNIQUE constraint failed|tasks_open_link_type_uq/i.test(err.message)
  );
}

export class RereadProposalService {
  private readonly elements: ElementRepository;
  private readonly operationLog: OperationLogRepository;
  private readonly lapseClusters: LapseClusterQuery;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.operationLog = new OperationLogRepository(db);
    this.lapseClusters = new LapseClusterQuery(db);
  }

  // ────────────────────────────── reads (U3) ──────────────────────────────

  /** The visible proposal set — read-only (no mutation, no op-log). */
  listProposals(input: ListRereadProposalsInput): RereadProposal[] {
    if (!input.enabled) return [];
    const clusters = this.lapseClusters.list({
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      asOf: input.asOf,
      minLapses: input.thresholds.minLapses,
      windowDays: input.thresholds.windowDays,
      minCards: input.thresholds.minCards,
      enabled: true,
    });
    const proposals: RereadProposal[] = [];
    for (const cluster of clusters) {
      if (proposals.length >= input.cap) break;
      const stateHash = rereadClusterStateHash(cluster, input.thresholds);
      if (this.isDismissed(cluster.ancestorId, stateHash)) continue;
      if (this.hasOpenOrRecentReread(cluster.ancestorId, input.asOf)) continue;
      proposals.push({ ...cluster, stateHash, dismissable: true });
    }
    return proposals;
  }

  /** Region + live failing cards for an accepted re-read item — read-only. */
  itemDetail(input: RereadItemDetailInput): RereadItemDetail | null {
    const task = this.db
      .select({
        linkedElementId: tasksTable.linkedElementId,
        taskType: tasksTable.taskType,
        deletedAt: elementsTable.deletedAt,
      })
      .from(tasksTable)
      .innerJoin(elementsTable, eq(elementsTable.id, tasksTable.elementId))
      .where(eq(tasksTable.elementId, input.taskElementId))
      .get();
    if (!task || task.taskType !== "reread_region" || task.deletedAt) return null;
    const ancestorId = (task.linkedElementId as ElementId | null) ?? null;
    if (!ancestorId) return null;

    const region = this.resolveRegion(ancestorId);
    if (!region) return null;

    // Attached member cards (references edges), DISTINCT by cardId (no edge uniqueness).
    const edgeRows = this.db
      .select({ cardId: elementRelations.toElementId })
      .from(elementRelations)
      .where(
        and(
          eq(elementRelations.fromElementId, input.taskElementId),
          eq(elementRelations.relationType, "references"),
        ),
      )
      .all();
    const cardIds = [...new Set(edgeRows.map((r) => r.cardId as ElementId))];
    if (cardIds.length === 0) {
      return { taskElementId: input.taskElementId, region, members: [] };
    }

    // Live, in-rotation, non-retired cards only — a member soft-deleted/retired after accept
    // is excluded from the DISPLAY set (KTD-3).
    const liveCards = this.db
      .select({ id: elementsTable.id, prompt: cards.prompt, cloze: cards.cloze })
      .from(elementsTable)
      .innerJoin(cards, eq(cards.elementId, elementsTable.id))
      .where(
        and(
          inArray(elementsTable.id, cardIds),
          eq(elementsTable.type, "card"),
          isNull(elementsTable.deletedAt),
          inArray(elementsTable.status, [...LIVE_CARD_STATUSES]),
          eq(cards.isRetired, false),
        ),
      )
      .all();
    if (liveCards.length === 0) {
      return { taskElementId: input.taskElementId, region, members: [] };
    }

    // Re-derive each survivor's current in-window lapse count via the shared predicate.
    const since = windowStart(input.asOf, input.windowDays);
    const liveIds = liveCards.map((c) => c.id as ElementId);
    const lapseRows = this.db
      .select({
        cardId: reviewLogs.elementId,
        windowLapseCount: sql<number>`sum(${reviewLogs.nextLapses} - ${reviewLogs.prevLapses})`,
      })
      .from(reviewLogs)
      .innerJoin(elementsTable, eq(elementsTable.id, reviewLogs.elementId))
      .innerJoin(cards, eq(cards.elementId, elementsTable.id))
      .where(liveCardLapseWhere(since, input.asOf, inArray(reviewLogs.elementId, liveIds)))
      .groupBy(reviewLogs.elementId)
      .all();
    const lapseByCard = new Map(
      lapseRows.map((r) => [r.cardId as string, Number(r.windowLapseCount ?? 0)]),
    );

    const members: RereadItemMember[] = liveCards
      .map((c) => ({
        cardId: c.id as ElementId,
        prompt: c.prompt ?? c.cloze ?? "",
        windowLapseCount: Math.max(0, lapseByCard.get(c.id as string) ?? 0),
      }))
      .sort((a, b) => b.windowLapseCount - a.windowLapseCount);
    return { taskElementId: input.taskElementId, region, members };
  }

  // ──────────────────────────── mutations (U4) ────────────────────────────

  /** Schedule a re-read item for a cluster — one atomic, op-logged transaction. */
  accept(input: AcceptRereadProposalInput): AcceptRereadProposalResult {
    const cluster = this.clusterForAncestor(input.ancestorId, input.asOf, input.thresholds);
    if (!cluster) {
      return { created: false, taskElementId: null, alreadyOpen: false, stale: true };
    }
    if (this.hasOpenReread(input.ancestorId)) {
      return { created: false, taskElementId: null, alreadyOpen: true, stale: false };
    }
    const ancestor = this.elements.findById(input.ancestorId);
    const priority: Priority = input.priority ?? ancestor?.priority ?? PRIORITY_LABEL_VALUE.B;
    const dueAt = input.asOf; // due now — re-read while the failure context is fresh

    try {
      const taskElementId = this.db.transaction((tx) => {
        const element = this.elements.createWithin(tx, {
          type: "task",
          status: "scheduled",
          stage: TASK_STAGE,
          priority,
          title: `Re-read: ${cluster.region.label}`,
          dueAt,
        });
        tx.insert(tasksTable)
          .values({
            elementId: element.id,
            taskType: "reread_region",
            dueAt,
            status: "scheduled",
            linkedElementId: input.ancestorId,
            note: cluster.region.label,
          })
          .run();
        for (const member of cluster.members) {
          this.elements.addRelationWithin(tx, {
            fromElementId: element.id,
            toElementId: member.cardId,
            relationType: "references",
          });
        }
        return element.id;
      });
      return { created: true, taskElementId, alreadyOpen: false, stale: false };
    } catch (err) {
      // Race belt: a concurrent accept won the one-open-per-region index.
      if (isOpenRereadUniqueViolation(err)) {
        return { created: false, taskElementId: null, alreadyOpen: true, stale: false };
      }
      throw err;
    }
  }

  /** Reverse an accept by soft-deleting the re-read task element (KTD-10; itself undoable). */
  undoAccept(taskElementId: ElementId): UndoAcceptRereadResult {
    const row = this.db
      .select({ taskType: tasksTable.taskType, deletedAt: elementsTable.deletedAt })
      .from(tasksTable)
      .innerJoin(elementsTable, eq(elementsTable.id, tasksTable.elementId))
      .where(eq(tasksTable.elementId, taskElementId))
      .get();
    if (!row || row.taskType !== "reread_region" || row.deletedAt) {
      return { removed: false };
    }
    // Soft-delete the element AND terminalize the tasks row, so the one-open-per-region
    // partial index (keyed on `tasks.status`) releases and the item leaves every read.
    this.db.transaction((tx) => {
      this.elements.softDeleteWithin(tx, taskElementId);
      tx.update(tasksTable)
        .set({ status: "deleted", dueAt: null })
        .where(eq(tasksTable.elementId, taskElementId))
        .run();
    });
    return { removed: true };
  }

  /** Remember a dismissal against the cluster's state-hash — recompute, reject stale. */
  dismiss(input: DismissRereadProposalInput): DismissRereadProposalResult {
    const cluster = this.clusterForAncestor(input.ancestorId, input.asOf, input.thresholds);
    if (!cluster) return { dismissed: false, stale: true };
    const currentHash = rereadClusterStateHash(cluster, input.thresholds);
    if (currentHash !== input.stateHash) return { dismissed: false, stale: true };

    this.db.transaction((tx) => {
      tx.insert(rereadProposalDismissals)
        .values({
          ancestorId: input.ancestorId,
          stateHash: currentHash,
          totalWindowLapses: cluster.totalWindowLapses,
          affectedCardCount: cluster.affectedCardCount,
          dismissedAt: input.asOf,
        })
        .onConflictDoUpdate({
          target: rereadProposalDismissals.ancestorId,
          set: {
            stateHash: currentHash,
            totalWindowLapses: cluster.totalWindowLapses,
            affectedCardCount: cluster.affectedCardCount,
            dismissedAt: input.asOf,
          },
        })
        .run();
      this.operationLog.append(tx, {
        opType: "update_element",
        elementId: input.ancestorId,
        payload: {
          id: input.ancestorId,
          rereadProposalDismissed: { stateHash: currentHash },
        },
      });
    });
    return { dismissed: true, stale: false };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** The cluster keyed by `ancestorId` (recomputed, scoped to the ancestor's source). */
  private clusterForAncestor(
    ancestorId: ElementId,
    asOf: IsoTimestamp,
    thresholds: RereadProposalThresholds,
  ): LapseCluster | null {
    const ancestor = this.elements.findById(ancestorId);
    const sourceId = (ancestor?.sourceId as ElementId | null) ?? null;
    const clusters = this.lapseClusters.list({
      ...(sourceId ? { sourceId } : {}),
      asOf,
      minLapses: thresholds.minLapses,
      windowDays: thresholds.windowDays,
      minCards: thresholds.minCards,
      enabled: true,
      limit: RECOMPUTE_LIMIT,
    });
    return clusters.find((c) => c.ancestorId === ancestorId) ?? null;
  }

  private isDismissed(ancestorId: ElementId, stateHash: string): boolean {
    const row = this.db
      .select({ stateHash: rereadProposalDismissals.stateHash })
      .from(rereadProposalDismissals)
      .where(eq(rereadProposalDismissals.ancestorId, ancestorId))
      .get();
    return row?.stateHash === stateHash;
  }

  /** True when an OPEN (non-terminal, live) re-read task exists for the region. */
  private hasOpenReread(ancestorId: ElementId): boolean {
    const row = this.db
      .select({ id: tasksTable.elementId })
      .from(tasksTable)
      .innerJoin(elementsTable, eq(elementsTable.id, tasksTable.elementId))
      .where(
        and(
          eq(tasksTable.taskType, "reread_region"),
          eq(tasksTable.linkedElementId, ancestorId),
          isNull(elementsTable.deletedAt),
          notInArray(tasksTable.status, CLOSED_TASK_STATUSES as unknown as string[]),
        ),
      )
      .get();
    return Boolean(row);
  }

  /** True when an OPEN re-read OR one COMPLETED within the grace window exists (KTD-1). */
  private hasOpenOrRecentReread(ancestorId: ElementId, asOf: IsoTimestamp): boolean {
    const graceCutoff = windowStart(asOf, REREAD_GRACE_DAYS);
    const row = this.db
      .select({ id: tasksTable.elementId })
      .from(tasksTable)
      .innerJoin(elementsTable, eq(elementsTable.id, tasksTable.elementId))
      .where(
        and(
          eq(tasksTable.taskType, "reread_region"),
          eq(tasksTable.linkedElementId, ancestorId),
          isNull(elementsTable.deletedAt),
          or(
            notInArray(tasksTable.status, CLOSED_TASK_STATUSES as unknown as string[]),
            and(eq(tasksTable.status, "done"), gte(elementsTable.updatedAt, graceCutoff)),
          ),
        ),
      )
      .get();
    return Boolean(row);
  }

  /** The ancestor's deterministic source-region anchor (same rule as the cluster's region). */
  private resolveRegion(ancestorId: ElementId): RereadItemRegion | null {
    const row = this.db
      .select({
        sourceElementId: sourceLocations.sourceElementId,
        blockIds: sourceLocations.blockIds,
        label: sourceLocations.label,
        page: sourceLocations.page,
      })
      .from(sourceLocations)
      .innerJoin(elementsTable, eq(elementsTable.id, sourceLocations.sourceElementId))
      .where(
        and(
          eq(sourceLocations.elementId, ancestorId),
          eq(elementsTable.type, "source"),
          isNull(elementsTable.deletedAt),
        ),
      )
      .orderBy(sourceLocations.id)
      .get();
    if (!row) return null;
    return {
      sourceElementId: row.sourceElementId as ElementId,
      blockIds: parseBlockIds(row.blockIds),
      label: row.label && row.label.length > 0 ? row.label : "Selected text",
      page: row.page ?? null,
    };
  }
}

/** Convenience: the current wall-clock ISO timestamp (re-exported for callers). */
export { nowIso };

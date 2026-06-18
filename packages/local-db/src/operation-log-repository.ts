/**
 * OperationLogRepository (T008) — the append-only command log.
 *
 * The `operation_log` exists **from day one**: every meaningful mutation appends
 * one command-shaped row here, INSIDE the same transaction as the mutation it
 * records. This is a load-bearing invariant — the deterministic, append-only log
 * is what later makes backup, audit, undo, and cloud sync tractable. We do not
 * build a sync engine now; we only keep mutations log-shaped.
 *
 * Other repositories never insert into `operation_log` directly; they call
 * {@link OperationLogRepository.append} (always passing the active transaction
 * client) so the op row and the data mutation commit or roll back together.
 */

import type { ElementId, OperationLogEntry, OperationType } from "@interleave/core";
import { operationLog } from "@interleave/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { newOperationId, nowIso } from "./ids";
import type { DbClient } from "./types";

/** Arguments for appending one operation-log row. */
export interface AppendOpInput {
  readonly opType: OperationType;
  /** Command-specific data; serialized to JSON text. */
  readonly payload: unknown;
  /** The element this op concerns; `null` if it targets no single element. */
  readonly elementId: string | null;
}

interface RawOpRow {
  id: string;
  opType: string;
  payload: string;
  elementId: string | null;
  createdAt: string;
  /** Denormalized `payload.batchId` (migration 0041); `null` for single-op rows. */
  batchId: string | null;
}

export type CurrentScheduleReasonKind =
  | "yield_shortened"
  | "yield_lengthened"
  | "recency_damped"
  | "postpone_recession"
  | "source_unresolved_shortened"
  | "source_exhausted_lengthened"
  | "descendant_lapses"
  | "band_base";

export interface CurrentScheduleReason {
  readonly kind: CurrentScheduleReasonKind;
  readonly baseIntervalDays: number | null;
  readonly finalIntervalDays: number | null;
  readonly intervalAfterMultiplierDays?: number | null;
  readonly priorMultiplier?: number | null;
  readonly newMultiplier?: number | null;
  readonly productiveOutputCount?: number | null;
  readonly unresolvedRatio?: number | null;
  readonly terminalRatio?: number | null;
  readonly ignoredRatio?: number | null;
  readonly daysSinceLastSeen?: number | null;
  readonly recencyCreditDays?: number | null;
  readonly intervalAfterPostponeDays?: number | null;
  readonly postponeCount?: number | null;
  readonly intervalAfterSourceProcessingDays?: number | null;
  readonly extractedOutputCount?: number | null;
  readonly descendantLapseCount?: number | null;
  readonly affectedCardCount?: number | null;
  readonly descendantCardCount?: number | null;
  readonly descendantLapseRate?: number | null;
  readonly intervalAfterDescendantDays?: number | null;
}

export interface CurrentScheduleProjection {
  /** Effective count after chronic-postpone reset/reset-undo folding. */
  readonly effectivePostponeCount: number;
  /**
   * Structured reason for the schedule currently governing `elements.due_at`.
   * `null` means either band-base/no learned deviation, no current schedule, or a
   * stale diagnostic superseded by a newer schedule op.
   */
  readonly reason: CurrentScheduleReason | null;
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : null;
}

/**
 * The bulk-action id buried in a command payload, or `null` for a single-op
 * action. Used to dual-write `operation_log.batch_id` at append time so batch
 * undo is an indexed lookup. Mirrors the `typeof … === "string"` guard the undo
 * reader uses; a non-string/absent `batchId` denormalizes to `null`.
 */
function batchIdFromPayload(payload: unknown): string | null {
  const obj = payloadObject(payload);
  return obj && typeof obj.batchId === "string" ? obj.batchId : null;
}

/** Parse a raw `operation_log` row into an {@link OperationLogEntry}. */
function rowToEntry(row: RawOpRow): OperationLogEntry {
  return {
    id: row.id as OperationLogEntry["id"],
    opType: row.opType as OperationType,
    payload: JSON.parse(row.payload) as unknown,
    elementId: row.elementId as OperationLogEntry["elementId"],
    createdAt: row.createdAt,
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteNonNegative(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function finitePositive(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function finitePositiveInteger(value: unknown): number | null {
  const number = finitePositive(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function intervalDaysBetween(start: unknown, end: unknown): number | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return Math.max(0, Math.round((endMs - startMs) / 86_400_000));
}

function adaptiveReasonFromPayload(payload: Record<string, unknown>): CurrentScheduleReason | null {
  const adaptive = payloadObject(payload.attentionAdaptive);
  const reason = payloadObject(adaptive?.reason);
  if (!reason) return null;
  const reasonKind = reason?.reasonKind;
  if (reasonKind === "yield_held" || reasonKind === "yield_input_malformed") return null;
  if (reasonKind !== "yield_shortened" && reasonKind !== "yield_lengthened") return null;
  const productiveOutputCount = finiteNumber(reason.productiveOutputCount);
  if (reasonKind === "yield_shortened" && (!productiveOutputCount || productiveOutputCount <= 0)) {
    return null;
  }
  if (reasonKind === "yield_lengthened" && productiveOutputCount !== 0) return null;
  return {
    kind: reasonKind,
    baseIntervalDays: finiteNumber(reason.baseIntervalDays),
    finalIntervalDays: finiteNumber(reason.finalIntervalDays),
    intervalAfterMultiplierDays: finiteNumber(reason.intervalAfterMultiplierDays),
    priorMultiplier: finiteNumber(reason.priorMultiplier),
    newMultiplier: finiteNumber(reason.newMultiplier),
    productiveOutputCount,
    unresolvedRatio: finiteNumber(reason.unresolvedRatio),
    terminalRatio: finiteNumber(reason.terminalRatio),
    ignoredRatio: finiteNumber(reason.ignoredRatio),
  };
}

function currentScheduleReasonFromPayload(
  value: unknown,
  effectivePostponeCount: number,
): CurrentScheduleReason | null {
  const reason = payloadObject(value);
  if (!reason || typeof reason.kind !== "string") return null;

  const baseIntervalDays = finiteNumber(reason.baseIntervalDays);
  const finalIntervalDays = finiteNumber(reason.finalIntervalDays);
  switch (reason.kind) {
    case "yield_shortened": {
      const productiveOutputCount = finiteNumber(reason.productiveOutputCount);
      if (productiveOutputCount === null || productiveOutputCount <= 0) return null;
      return {
        kind: "yield_shortened",
        baseIntervalDays,
        finalIntervalDays,
        intervalAfterMultiplierDays: finiteNumber(reason.intervalAfterMultiplierDays),
        priorMultiplier: finiteNumber(reason.priorMultiplier),
        newMultiplier: finiteNumber(reason.newMultiplier),
        productiveOutputCount,
        unresolvedRatio: finiteNumber(reason.unresolvedRatio),
        terminalRatio: finiteNumber(reason.terminalRatio),
        ignoredRatio: finiteNumber(reason.ignoredRatio),
      };
    }
    case "yield_lengthened":
      if (finiteNumber(reason.productiveOutputCount) !== 0) return null;
      return {
        kind: "yield_lengthened",
        baseIntervalDays,
        finalIntervalDays,
        intervalAfterMultiplierDays: finiteNumber(reason.intervalAfterMultiplierDays),
        priorMultiplier: finiteNumber(reason.priorMultiplier),
        newMultiplier: finiteNumber(reason.newMultiplier),
        productiveOutputCount: finiteNumber(reason.productiveOutputCount),
        unresolvedRatio: finiteNumber(reason.unresolvedRatio),
        terminalRatio: finiteNumber(reason.terminalRatio),
        ignoredRatio: finiteNumber(reason.ignoredRatio),
      };
    case "recency_damped": {
      const daysSinceLastSeen = finiteNumber(reason.daysSinceLastSeen);
      if (daysSinceLastSeen === null) return null;
      return {
        kind: "recency_damped",
        baseIntervalDays,
        finalIntervalDays,
        daysSinceLastSeen,
        recencyCreditDays: finiteNumber(reason.recencyCreditDays),
      };
    }
    case "postpone_recession":
      if (effectivePostponeCount <= 0) return null;
      return {
        kind: "postpone_recession",
        baseIntervalDays,
        finalIntervalDays,
        intervalAfterPostponeDays: finiteNumber(reason.intervalAfterPostponeDays),
        postponeCount: effectivePostponeCount,
      };
    case "source_unresolved_shortened":
      if (
        finitePositive(reason.unresolvedRatio) === null ||
        finiteNonNegative(reason.terminalRatio) === null ||
        finiteNonNegative(reason.ignoredRatio) === null ||
        finiteNonNegative(reason.extractedOutputCount) === null
      ) {
        return null;
      }
      return {
        kind: "source_unresolved_shortened",
        baseIntervalDays,
        finalIntervalDays,
        intervalAfterSourceProcessingDays: finiteNumber(reason.intervalAfterSourceProcessingDays),
        unresolvedRatio: finiteNumber(reason.unresolvedRatio),
        terminalRatio: finiteNumber(reason.terminalRatio),
        ignoredRatio: finiteNumber(reason.ignoredRatio),
        extractedOutputCount: finiteNumber(reason.extractedOutputCount),
      };
    case "source_exhausted_lengthened":
      if (
        finiteNonNegative(reason.unresolvedRatio) === null ||
        finiteNonNegative(reason.terminalRatio) === null ||
        finiteNonNegative(reason.ignoredRatio) === null ||
        finiteNumber(reason.extractedOutputCount) !== 0
      ) {
        return null;
      }
      return {
        kind: "source_exhausted_lengthened",
        baseIntervalDays,
        finalIntervalDays,
        intervalAfterSourceProcessingDays: finiteNumber(reason.intervalAfterSourceProcessingDays),
        unresolvedRatio: finiteNumber(reason.unresolvedRatio),
        terminalRatio: finiteNumber(reason.terminalRatio),
        ignoredRatio: finiteNumber(reason.ignoredRatio),
        extractedOutputCount: finiteNumber(reason.extractedOutputCount),
      };
    case "descendant_lapses": {
      const descendantLapseCount = finitePositiveInteger(reason.descendantLapseCount);
      const affectedCardCount = finitePositiveInteger(reason.affectedCardCount);
      const descendantCardCount = finitePositiveInteger(reason.descendantCardCount);
      const descendantLapseRate = finitePositive(reason.descendantLapseRate);
      const intervalAfterDescendantDays = finitePositive(reason.intervalAfterDescendantDays);
      const expectedRate =
        descendantLapseCount !== null && descendantCardCount !== null
          ? descendantLapseCount / descendantCardCount
          : null;
      if (
        descendantLapseCount === null ||
        descendantLapseCount < 3 ||
        affectedCardCount === null ||
        affectedCardCount < 2 ||
        descendantCardCount === null ||
        affectedCardCount > descendantCardCount ||
        descendantLapseRate === null ||
        descendantLapseRate < 0.1 ||
        expectedRate === null ||
        Math.abs(descendantLapseRate - expectedRate) > 0.000_001 ||
        intervalAfterDescendantDays === null ||
        (baseIntervalDays !== null && intervalAfterDescendantDays >= baseIntervalDays) ||
        (finalIntervalDays !== null && finalIntervalDays > intervalAfterDescendantDays)
      ) {
        return null;
      }
      return {
        kind: "descendant_lapses",
        baseIntervalDays,
        finalIntervalDays,
        descendantLapseCount,
        affectedCardCount,
        descendantCardCount,
        descendantLapseRate,
        intervalAfterDescendantDays,
      };
    }
    case "band_base":
      return null;
    default:
      return null;
  }
}

export class OperationLogRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Append one command-shaped row. Callers MUST pass the transaction client
   * (`tx`) so the op commits atomically with its mutation. Returns the created
   * entry.
   */
  append(tx: DbClient, input: AppendOpInput): OperationLogEntry {
    const id = newOperationId();
    const createdAt = nowIso();
    const payload = JSON.stringify(input.payload ?? null);
    const batchId = batchIdFromPayload(input.payload);
    tx.insert(operationLog)
      .values({ id, opType: input.opType, payload, elementId: input.elementId, createdAt, batchId })
      .run();
    return {
      id,
      opType: input.opType,
      payload: input.payload,
      elementId: input.elementId as OperationLogEntry["elementId"],
      createdAt,
    };
  }

  /**
   * All ops for one element, newest first. Ties on `createdAt` (two ops appended
   * in the same millisecond — e.g. flag-then-unflag) are broken by the implicit
   * insertion-order `rowid` so "newest first" is deterministic; callers that rely
   * on the latest marker winning (e.g. `CardEditService.flagState`) need this.
   */
  listForElement(elementId: string): OperationLogEntry[] {
    return this.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, elementId))
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .all()
      .map(rowToEntry);
  }

  /**
   * Latest `attentionAdaptive` diagnostic from a `reschedule_element` op for one
   * element, newest first. This keeps adaptive scheduling off the unbounded
   * `listForElement()` history scan while preserving the op-log payload as the
   * source of previous visit counters.
   */
  latestAttentionAdaptivePayload(elementId: string): unknown | null {
    const row = this.db
      .select({ payload: operationLog.payload })
      .from(operationLog)
      .where(
        and(
          eq(operationLog.elementId, elementId),
          eq(operationLog.opType, "reschedule_element"),
          sql`json_type(${operationLog.payload}, '$.attentionAdaptive') IS NOT NULL`,
        ),
      )
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .limit(1)
      .get();
    if (!row) return null;
    return payloadObject(JSON.parse(row.payload))?.attentionAdaptive ?? null;
  }

  /**
   * Evidence-only extras to preserve schedule explainability when undo restores an
   * older `due_at`. This intentionally copies no command markers (`postpone`,
   * `choice`, `queueSoon`, `batchId`) so undo does not create new semantic history.
   */
  scheduleEvidenceForDueAtBefore(
    elementId: string,
    dueAt: string | null,
    excludedOperationId: string,
  ): Readonly<Record<string, unknown>> | undefined {
    if (!dueAt) return undefined;
    for (const op of this.listForElement(elementId)) {
      if (op.id === excludedOperationId || op.opType !== "reschedule_element") continue;
      const payload = payloadObject(op.payload);
      if (!payload || payload.dueAt !== dueAt) continue;
      const extras: Record<string, unknown> = {};
      if (payload.scheduleReason !== undefined) extras.scheduleReason = payload.scheduleReason;
      if (payload.attentionAdaptive !== undefined) {
        extras.attentionAdaptive = payload.attentionAdaptive;
      }
      return Object.keys(extras).length > 0 ? extras : undefined;
    }
    return undefined;
  }

  /**
   * Read-side projection for the schedule reason that still governs the current
   * `elements.due_at`. It deliberately reads ONLY the latest `reschedule_element`
   * row, so an older adaptive diagnostic is suppressed after a newer explicit
   * schedule/postpone/undo supersedes it.
   */
  currentScheduleProjection(
    elementId: string,
    currentDueAt: string | null,
  ): CurrentScheduleProjection {
    const effectivePostponeCount = this.countPostpones(elementId);
    if (!currentDueAt) return { effectivePostponeCount, reason: null };

    const row = this.db
      .select({ payload: operationLog.payload })
      .from(operationLog)
      .where(
        and(eq(operationLog.elementId, elementId), eq(operationLog.opType, "reschedule_element")),
      )
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .limit(1)
      .get();
    if (!row) return { effectivePostponeCount, reason: null };

    const payload = payloadObject(JSON.parse(row.payload));
    if (!payload || payload.dueAt !== currentDueAt) {
      return { effectivePostponeCount, reason: null };
    }

    if (payload.choice !== undefined || payload.queueSoon === true) {
      return { effectivePostponeCount, reason: null };
    }

    const persistedReason = currentScheduleReasonFromPayload(
      payload.scheduleReason,
      effectivePostponeCount,
    );
    if (persistedReason) return { effectivePostponeCount, reason: persistedReason };

    const adaptiveReason = adaptiveReasonFromPayload(payload);
    if (adaptiveReason) return { effectivePostponeCount, reason: adaptiveReason };

    if (payload.postpone === true) {
      if (effectivePostponeCount <= 0) return { effectivePostponeCount, reason: null };
      const intervalDays = intervalDaysBetween(payload.scheduledAt, payload.dueAt);
      return {
        effectivePostponeCount,
        reason: {
          kind: "postpone_recession",
          baseIntervalDays: null,
          finalIntervalDays: intervalDays,
          intervalAfterPostponeDays: intervalDays,
          postponeCount: effectivePostponeCount,
        },
      };
    }

    return { effectivePostponeCount, reason: null };
  }

  /**
   * Batched twin of {@link countPostpones} and `rawPostponeCount` (in
   * `scheduler-consistency-query.ts`). One `operation_log` scan over
   * `WHERE element_id IN (ids) AND op_type IN ('reschedule_element', 'update_element')`,
   * folded per-element in JS, replacing per-element `countPostpones` /
   * `rawPostponeCount` in list/search/queue paths.
   *
   * Returns `{ effective, raw }` where:
   * - `effective` — the FULL `countPostpones` marker logic (including
   *   `update_element` reset/restore markers that zero/restore the count). Consumed
   *   by `QueueQuery.summaryForMany` (U1).
   * - `raw` — replicates `rawPostponeCount`: count ONLY `reschedule_element` rows
   *   with `payload.postpone === true`, NO reset-marker folding. Consumed by
   *   `SchedulerConsistencyQuery` (U13). The `raw > effective` detection would break
   *   if the reset fold were applied here.
   *
   * **Ordering:** `countPostpones` consumes `listForElement(id).reverse()` — i.e.
   * oldest-first — so rows are ordered `created_at ASC, rowid ASC` (the `rowid`
   * tiebreak is required; same-ms ops must fold in insertion order).
   *
   * Elements absent from the scan return 0 in BOTH maps. Empty `ids` → empty maps.
   */
  postponeCountsForMany(ids: readonly ElementId[]): {
    effective: Map<ElementId, number>;
    raw: Map<ElementId, number>;
  } {
    if (ids.length === 0) return { effective: new Map(), raw: new Map() };

    // One scan: reschedule_element (postpone markers) + update_element (reset markers).
    // Order: oldest-first so the effective-count fold mirrors listForElement().reverse().
    const rows = this.db
      .select({
        elementId: operationLog.elementId,
        opType: operationLog.opType,
        payload: operationLog.payload,
      })
      .from(operationLog)
      .where(
        and(
          inArray(operationLog.elementId, ids as ElementId[]),
          inArray(operationLog.opType, ["reschedule_element", "update_element"]),
        ),
      )
      .orderBy(asc(operationLog.createdAt), asc(sql`rowid`))
      .all();

    // Group rows by elementId (preserving oldest-first order from the query).
    const byElement = new Map<ElementId, typeof rows>();
    for (const row of rows) {
      const eid = row.elementId as ElementId;
      const list = byElement.get(eid);
      if (list) {
        list.push(row);
      } else {
        byElement.set(eid, [row]);
      }
    }

    const effective = new Map<ElementId, number>();
    const raw = new Map<ElementId, number>();

    for (const id of ids) {
      const elRows = byElement.get(id);
      if (!elRows || elRows.length === 0) {
        // No rows → 0 for both (matches countPostpones and rawPostponeCount).
        continue;
      }

      // Effective count: full countPostpones marker logic (oldest-first, same as
      // listForElement().reverse()).
      let effectiveCount = 0;
      for (const row of elRows) {
        const payload = payloadObject(JSON.parse(row.payload));
        if (row.opType === "reschedule_element" && payload?.postpone === true) {
          effectiveCount += 1;
          continue;
        }
        if (row.opType !== "update_element") continue;
        if (payload?.chronicPostponeReset === true) {
          effectiveCount = 0;
          continue;
        }
        if (payload?.chronicPostponeResetUndo === true) {
          const restored = payload.restoredEffectivePostponeCount;
          effectiveCount =
            typeof restored === "number" && Number.isFinite(restored) && restored >= 0
              ? Math.floor(restored)
              : effectiveCount;
        }
      }
      if (effectiveCount !== 0) effective.set(id, effectiveCount);

      // Raw count: ONLY reschedule_element rows with postpone===true, no reset folding.
      let rawCount = 0;
      for (const row of elRows) {
        if (row.opType !== "reschedule_element") continue;
        const payload = JSON.parse(row.payload) as unknown;
        if (
          typeof payload === "object" &&
          payload !== null &&
          (payload as { postpone?: unknown }).postpone === true
        ) {
          rawCount += 1;
        }
      }
      if (rawCount !== 0) raw.set(id, rawCount);
    }

    return { effective, raw };
  }

  /** The whole log, newest first (audit/backup helper). */
  listAll(limit?: number): OperationLogEntry[] {
    const base = this.db
      .select()
      .from(operationLog)
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`));
    const rows = limit === undefined ? base.all() : base.limit(limit).all();
    return rows.map(rowToEntry);
  }

  /** Total number of logged operations. */
  count(): number {
    return this.db.select().from(operationLog).all().length;
  }

  /**
   * Count how many times an element has been postponed, by scanning its
   * `reschedule_element` ops for the `postpone === true` marker and folding T106
   * chronic-postpone reset markers. This is the ONE
   * canonical, schema-churn-free postpone counter — the attention scheduler, the
   * queue read, the inspector readout, and the extract service all call THIS so the
   * marker shape lives in exactly one place (and the four call sites cannot drift).
   * The postpone count itself stays in the op payload (no schema column).
   *
   * T106 adds marker-only `update_element` rows:
   * - `{ chronicPostponeReset: true }` sets the effective count back to 0 after a
   *   user reckoning decision.
   * - `{ chronicPostponeResetUndo: true, restoredEffectivePostponeCount: N }`
   *   restores the pre-reset effective count when undo reverses that marker.
   */
  countPostpones(elementId: string): number {
    let count = 0;
    for (const op of this.listForElement(elementId).reverse()) {
      const payload = payloadObject(op.payload);
      if (op.opType === "reschedule_element" && payload?.postpone === true) {
        count += 1;
        continue;
      }
      if (op.opType !== "update_element") continue;
      if (payload?.chronicPostponeReset === true) {
        count = 0;
        continue;
      }
      if (payload?.chronicPostponeResetUndo === true) {
        const restored = payload.restoredEffectivePostponeCount;
        count =
          typeof restored === "number" && Number.isFinite(restored) && restored >= 0
            ? Math.floor(restored)
            : count;
      }
    }
    return count;
  }
}

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

import type { OperationLogEntry, OperationType } from "@interleave/core";
import { operationLog } from "@interleave/db";
import { desc, eq } from "drizzle-orm";
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
    tx.insert(operationLog)
      .values({ id, opType: input.opType, payload, elementId: input.elementId, createdAt })
      .run();
    return {
      id,
      opType: input.opType,
      payload: input.payload,
      elementId: input.elementId as OperationLogEntry["elementId"],
      createdAt,
    };
  }

  /** All ops for one element, newest first. */
  listForElement(elementId: string): OperationLogEntry[] {
    return this.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, elementId))
      .orderBy(desc(operationLog.createdAt))
      .all()
      .map(rowToEntry);
  }

  /** The whole log, newest first (audit/backup helper). */
  listAll(limit?: number): OperationLogEntry[] {
    const base = this.db.select().from(operationLog).orderBy(desc(operationLog.createdAt));
    const rows = limit === undefined ? base.all() : base.limit(limit).all();
    return rows.map(rowToEntry);
  }

  /** Total number of logged operations. */
  count(): number {
    return this.db.select().from(operationLog).all().length;
  }
}

/**
 * ExtractStagnationQuery (T084) — the "which extracts keep returning without
 * progressing?" scan.
 *
 * It is the attention-side mirror of the leech cleanup read: where leeches surface
 * FSRS *cards* that fail repeatedly, this surfaces attention *extracts* that never
 * advance. For every live `extract` it reads the charter's extract-scheduler signals
 * — stage, priority, created/updated, child count, postpone count, last stage advance
 * — off the durable tables + the op log, runs the PURE `@interleave/scheduler`
 * `isStagnant` heuristic, and returns ONLY the stagnant rows (most-stagnant first)
 * with their reasons + a recommended remediation.
 *
 * Architecture (non-negotiable, mirrors `analytics-query.ts` / `source-yield-query.ts`):
 *  - **Read-only.** It NEVER mutates and NEVER appends an `operation_log` row — there
 *    is nothing to undo about looking at your stats. No schedule change. The
 *    suggestions are LABELS; the actual rewrite/convert/postpone/delete are the
 *    EXISTING T024 `extracts.*` transactional, op-logged commands.
 *  - All detection lives in `@interleave/scheduler` (`isStagnant`, pure + unit-tested)
 *    and the scan lives HERE — never in React. The renderer reads one
 *    `ExtractStagnationSummary` payload over the typed `window.appApi` bridge.
 *  - Computed from durable signals (stage / children / op-log postpone markers), so
 *    the list recomputes correctly after an app restart.
 *  - The FSRS-vs-attention split stays LABELED: stagnation is an ATTENTION concern
 *    computed from stage/children/postpones — NEVER from FSRS `lapses` (extracts have
 *    no `review_states` row), and an extract is NEVER called a "leech".
 *
 * ## The signals (where each comes from)
 *
 * - **stage / priority / createdAt / updatedAt / dueAt** — the `elements` row.
 * - **childCount** — `ElementRepository.listChildren` (live children only).
 * - **postponeCount** — `OperationLogRepository.countPostpones` (scans the element's
 *   `reschedule_element` ops for the `postpone === true` marker — the ONE canonical,
 *   schema-churn-free counter the marker exists for; see the `ExtractService` header).
 * - **lastStageAdvanceAt** — the newest `update_element` op whose `payload.patch.stage`
 *   is set AND actually CHANGED the stage (`payload.prev.stage !== payload.patch.stage`).
 *   **We MUST filter to this stage-advance patch shape**: other `update_element` ops
 *   carry different payloads (`{ id, isLeech }` from `setCardLeech`, `{ id, flagged }`
 *   / `{ id, body }` from `CardEditService`) with no `patch`, so requiring `patch` to
 *   touch `stage` keeps those leech/flag/body ops from polluting the signal.
 *
 * ## Performance (grouped, not N+1)
 *
 * It runs a small fixed number of reads regardless of extract count: one live-extract
 * read, one live-children read grouped by `parentId`, and one `operation_log` read for
 * the extracts' postpone + stage-advance markers grouped by `elementId`. No per-extract
 * round-trips; no schema change (the op log is already indexed by `elementId`).
 */

import type { ExtractFate, IsoTimestamp, OperationLogEntry, Priority } from "@interleave/core";
import { elementRelations, elements, type InterleaveDatabase, operationLog } from "@interleave/db";
import {
  type ExtractStagnationSignals,
  isStagnant,
  type StagnationReason,
  type StagnationSuggestion,
} from "@interleave/scheduler";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { OperationLogRepository } from "./operation-log-repository";

/** Default cap so a broad scan can't return an unbounded list (like `LibraryQuery`). */
export const DEFAULT_EXTRACT_STAGNATION_LIMIT = 200;

/** A small extract descriptor embedded in each stagnant row. */
export interface StagnantExtractRef {
  readonly id: string;
  readonly title: string;
  readonly stage: string;
  /** Normalized numeric priority `0.0`–`1.0`. */
  readonly priority: number;
  /** The attention `due_at` (ISO-8601), or `null`. Extracts are attention items. */
  readonly dueAt: string | null;
  /** Explicit honorable terminal fate; normally null for stagnant rows. */
  readonly extractFate: ExtractFate | null;
  readonly createdAt: IsoTimestamp;
}

/** One stagnant extract + why it stalled + the recommended remediation. */
export interface StagnantExtractRow {
  readonly extract: StagnantExtractRef;
  /** How many times the extract has been postponed (op-log markers). */
  readonly postponeCount: number;
  /** How many live children (sub-extracts / cards) it produced (0 for a stagnant one). */
  readonly childCount: number;
  /** Live synthesis-note references to this extract. Normally 0 for stagnant rows. */
  readonly synthesizedReferenceCount: number;
  /** Whole days since the last stage advance (or `createdAt`). */
  readonly daysSinceProgress: number;
  /** Which conditions fired (rendered as calm chips). */
  readonly reasons: readonly StagnationReason[];
  /** The recommended remediation (advisory; invokes the existing `extracts.*` commands). */
  readonly suggestion: StagnationSuggestion;
}

/** The complete stagnation snapshot the maintenance view reads (one payload). */
export interface ExtractStagnationSummary {
  /** The `asOf` instant the scan was computed for (ISO-8601). */
  readonly asOf: IsoTimestamp;
  /** The stagnant rows, sorted most-stagnant first. */
  readonly rows: readonly StagnantExtractRow[];
  /** How many extracts are stagnant (`rows.length`). */
  readonly stagnantCount: number;
}

/** Options for {@link ExtractStagnationQuery.listStagnantExtracts}. */
export interface ExtractStagnationOptions {
  /** Cap the row count (defaults to {@link DEFAULT_EXTRACT_STAGNATION_LIMIT}). */
  readonly limit?: number;
  /** Skip the first `offset` rows (after sorting). */
  readonly offset?: number;
}

/** The op-log-derived signals for one extract, accumulated in the grouped pass. */
interface OpSignals {
  postponeCount: number;
  lastStageAdvanceAt: string | null;
}

/** Whether an op payload is the stage-advance `{ patch: { stage }, prev: { stage } }` shape. */
function stageAdvanceTimestamp(op: OperationLogEntry): boolean {
  if (op.opType !== "update_element") return false;
  const payload = op.payload;
  if (typeof payload !== "object" || payload === null) return false;
  const patch = (payload as { patch?: unknown }).patch;
  if (typeof patch !== "object" || patch === null) return false;
  const patchStage = (patch as { stage?: unknown }).stage;
  if (typeof patchStage !== "string") return false;
  // Confirm a REAL advance: the pre-image stage differs from the patched stage. (When
  // `prev` is absent we still count it — a stage patch with no prior is an advance.)
  const prev = (payload as { prev?: unknown }).prev;
  if (typeof prev === "object" && prev !== null) {
    const prevStage = (prev as { stage?: unknown }).stage;
    if (typeof prevStage === "string" && prevStage === patchStage) return false;
  }
  return true;
}

/** Whether an op is a `reschedule_element` postpone marker (`postpone === true`). */
function isPostponeMarker(op: OperationLogEntry): boolean {
  if (op.opType !== "reschedule_element") return false;
  const payload = op.payload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { postpone?: unknown }).postpone === true
  );
}

/**
 * Read-only extract-stagnation scan. Constructed once per open database (alongside
 * {@link Repositories}); the main process exposes it over validated IPC.
 */
export class ExtractStagnationQuery {
  private readonly operationLog: OperationLogRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.operationLog = new OperationLogRepository(db);
  }

  /**
   * Compute the full {@link ExtractStagnationSummary} for `asOf`. Read-only. See the
   * file header for every signal + the grouped (non-N+1) query plan.
   */
  listStagnantExtracts(
    asOf: IsoTimestamp,
    options: ExtractStagnationOptions = {},
  ): ExtractStagnationSummary {
    const limit = options.limit ?? DEFAULT_EXTRACT_STAGNATION_LIMIT;
    const offset = Math.max(0, options.offset ?? 0);

    // 1) Every live extract element (the universe the scan checks).
    const extractRows = this.db
      .select({
        id: elements.id,
        title: elements.title,
        stage: elements.stage,
        priority: elements.priority,
        dueAt: elements.dueAt,
        extractFate: elements.extractFate,
        createdAt: elements.createdAt,
        updatedAt: elements.updatedAt,
      })
      .from(elements)
      .where(and(eq(elements.type, "extract"), isNull(elements.deletedAt)))
      .all();

    if (extractRows.length === 0) {
      return { asOf, rows: [], stagnantCount: 0 };
    }

    const extractIds = extractRows.map((e) => e.id);

    // 2) One grouped pass over LIVE children, tallied by `parentId` (did it produce
    //    children?). Soft-deleted children are excluded by the `deletedAt` filter.
    const childCounts = new Map<string, number>();
    const children = this.db
      .select({ parentId: elements.parentId })
      .from(elements)
      .where(and(inArray(elements.parentId, extractIds), isNull(elements.deletedAt)))
      .all();
    for (const c of children) {
      if (!c.parentId) continue;
      childCounts.set(c.parentId, (childCounts.get(c.parentId) ?? 0) + 1);
    }

    // 3) One grouped pass over live synthesis-note references to extracts. A linked
    //    extract has produced synthesis value even if its cached fate is not yet set.
    const synthesizedReferenceCounts = new Map<string, number>();
    const liveSynthesisNoteIds = this.db
      .select({ id: elements.id })
      .from(elements)
      .where(and(eq(elements.type, "synthesis_note"), isNull(elements.deletedAt)))
      .all()
      .map((row) => row.id);
    if (liveSynthesisNoteIds.length > 0) {
      const references = this.db
        .select({ targetId: elementRelations.toElementId })
        .from(elementRelations)
        .where(
          and(
            eq(elementRelations.relationType, "references"),
            inArray(elementRelations.fromElementId, liveSynthesisNoteIds),
            inArray(elementRelations.toElementId, extractIds),
          ),
        )
        .all();
      for (const ref of references) {
        synthesizedReferenceCounts.set(
          ref.targetId,
          (synthesizedReferenceCounts.get(ref.targetId) ?? 0) + 1,
        );
      }
    }

    // 4) One grouped pass over the extracts' op log (postpone + stage-advance markers),
    //    bucketed by `elementId`. Newest-first so the FIRST stage-advance op we see per
    //    extract is its LAST advance. (The op log is indexed by `elementId`.)
    const opSignals = new Map<string, OpSignals>();
    const ensure = (id: string): OpSignals => {
      let s = opSignals.get(id);
      if (!s) {
        s = { postponeCount: 0, lastStageAdvanceAt: null };
        opSignals.set(id, s);
      }
      return s;
    };
    const ops = this.db
      .select()
      .from(operationLog)
      .where(inArray(operationLog.elementId, extractIds))
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .all()
      .map(
        (row): OperationLogEntry => ({
          id: row.id as OperationLogEntry["id"],
          opType: row.opType as OperationLogEntry["opType"],
          payload: JSON.parse(row.payload) as unknown,
          elementId: row.elementId as OperationLogEntry["elementId"],
          createdAt: row.createdAt,
        }),
      );
    for (const op of ops) {
      if (!op.elementId) continue;
      const s = ensure(op.elementId);
      if (isPostponeMarker(op)) {
        s.postponeCount = this.operationLog.countPostpones(op.elementId);
      } else if (s.lastStageAdvanceAt === null && stageAdvanceTimestamp(op)) {
        // Newest-first: the first stage-advance op encountered is the latest advance.
        s.lastStageAdvanceAt = op.createdAt;
      }
    }

    // 5) Run the PURE heuristic per extract; keep only the stagnant rows.
    const rows: StagnantExtractRow[] = [];
    for (const e of extractRows) {
      const op = opSignals.get(e.id);
      const signals: ExtractStagnationSignals = {
        stage: e.stage,
        priority: e.priority as Priority,
        createdAt: e.createdAt as IsoTimestamp,
        lastProcessedAt: (e.updatedAt as IsoTimestamp | null) ?? null,
        dueAt: (e.dueAt as IsoTimestamp | null) ?? null,
        postponeCount: op?.postponeCount ?? 0,
        childCount: childCounts.get(e.id) ?? 0,
        honorableFate: (e.extractFate as ExtractFate | null) ?? null,
        synthesizedReferenceCount: synthesizedReferenceCounts.get(e.id) ?? 0,
        lastStageAdvanceAt: (op?.lastStageAdvanceAt as IsoTimestamp | null) ?? null,
      };
      const verdict = isStagnant(signals, asOf);
      if (!verdict.stagnant) continue;
      rows.push({
        extract: {
          id: e.id,
          title: e.title,
          stage: e.stage,
          priority: e.priority,
          dueAt: (e.dueAt as string | null) ?? null,
          extractFate: (e.extractFate as ExtractFate | null) ?? null,
          createdAt: e.createdAt as IsoTimestamp,
        },
        postponeCount: signals.postponeCount,
        childCount: signals.childCount,
        synthesizedReferenceCount: signals.synthesizedReferenceCount,
        daysSinceProgress: verdict.daysSinceProgress,
        reasons: verdict.reasons,
        suggestion: verdict.suggestion,
      });
    }

    // Sort most-stagnant first: more postpones first, then staler, then id ASC (stable).
    rows.sort((a, b) => {
      if (a.postponeCount !== b.postponeCount) return b.postponeCount - a.postponeCount;
      if (a.daysSinceProgress !== b.daysSinceProgress) {
        return b.daysSinceProgress - a.daysSinceProgress;
      }
      return a.extract.id < b.extract.id ? -1 : a.extract.id > b.extract.id ? 1 : 0;
    });

    const stagnantCount = rows.length;
    const paged = rows.slice(offset, offset + limit);
    return { asOf, rows: paged, stagnantCount };
  }
}

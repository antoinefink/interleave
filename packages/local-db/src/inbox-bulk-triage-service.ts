/**
 * InboxBulkTriageService (T126) — the main-side BATCH boundary for inbox triage.
 *
 * Applies ONE triage verb (optionally combined with ONE priority band) to N inbox
 * ids as ONE wrapping transaction sharing ONE `batchId`, reusing the EXACT per-item
 * verb writes the single-item `triageInboxItem` path uses. It invents NO new op type,
 * NO new status, and NO new mutation shape — bulk is the per-item writes wrapped in a
 * single transaction with a shared batch tag:
 *
 *  - `accept`       → {@link SchedulerService.activateSourceWithReturnWithin}
 *    (`reschedule_element`, status `active` + a return `due_at`; KTD-4, no navigation).
 *  - `queueSoon`    → {@link SchedulerService.queueSourceSoonWithin}
 *    (`reschedule_element`, status `scheduled`, due now; NEVER creates a `review_states`
 *    row — sources are attention-scheduled, not FSRS).
 *  - `keepForLater` → {@link ElementRepository.updateWithin} (`update_element`, status
 *    `parked`, `dueAt:null`, `parkedAt:now`; T101 park semantics, priority preserved).
 *  - `setPriority`  → {@link ElementRepository.updateWithin} (`update_element`, numeric
 *    priority from the band; the item STAYS in the inbox).
 *  - `delete`       → {@link ElementRepository.softDeleteWithin} (`soft_delete_element`).
 *
 * Unlike the per-item path — which THROWS `"Inbox item is no longer available."` when a
 * row is stale — the bulk path SKIPS-AND-CLASSIFIES each ineligible id (it must not throw,
 * or one stale row would abort the whole batch). A genuine UNEXPECTED write error on an
 * eligible row aborts the entire transaction (better-sqlite3 rolls back on throw) with
 * zero partial application; the result's `errored` channel reports it distinctly from a
 * stale skip (KTD-2). The shape: `{ batchId, applied, skipped[], errored[] }`.
 *
 * UNDO (KTD-6): the batch is collected by its `batchId` and inverted by
 * {@link UndoService.undoBatch} with the OP-TYPE-AGNOSTIC movement guard
 * `requireCurrentBulkTriageStateMatch`, which refuses cleanly if ANY victim has moved
 * since the batch wrote it — across the HETEROGENEOUS op set (reschedule + update +
 * soft_delete) a single bulk verb can emit. The update-only origin guard
 * (`requireUpdateOriginKind`) would refuse undo for queueSoon/accept/delete and is NOT used.
 */

import type { ElementId, IsoTimestamp, PriorityLabel } from "@interleave/core";
import { priorityFromLabel } from "@interleave/core";
import { elements, type InterleaveDatabase } from "@interleave/db";
import { eq } from "drizzle-orm";
import type { ElementRepository } from "./element-repository";
import { newRowId, nowIso } from "./ids";
import type { SchedulerService } from "./scheduler-service";
import type { TransactionClient } from "./types";
import type { UndoResult, UndoService } from "./undo-service";

/** The single triage verb a bulk sweep applies to the whole selection. */
export type InboxBulkTriageAction =
  | "accept"
  | "queueSoon"
  | "keepForLater"
  | "delete"
  | "setPriority";

/** Why an id in the selection was skipped (not applied) — never a thrown error. */
export type InboxBulkTriageSkipReason =
  /** A live element that is NOT in `status:"inbox"` (e.g. already parked/active/scheduled). */
  | "not_inbox"
  /** Soft-deleted (`deletedAt` set) — gone from the inbox. */
  | "deleted"
  /** A live element that is not a `type:"source"` (e.g. a card/extract/task). */
  | "wrong_type"
  /** The id matched no element row at all (e.g. concurrently hard-deleted / never existed). */
  | "already_acted"
  /** Bulk-accept only (T127): the item had no banded suggestion (`insufficient_signal`). */
  | "no_suggestion";

/** One item to bulk-accept its own suggested band (T127 — KTD-8). */
export interface InboxBulkSuggestionItem {
  readonly id: string;
  /** The suggested band the read-model resolved for this id. */
  readonly band: PriorityLabel;
  /** The fired signal kinds, carried into the accepted-suggestion provenance marker. */
  readonly signalKinds: readonly ("semantic" | "authorYield" | "domainYield")[];
  /** The versioned signal hash, carried into the provenance marker. */
  readonly signalHash: string;
}

/** One skipped id with its classified reason. */
export interface InboxBulkTriageSkipped {
  readonly id: string;
  readonly reason: InboxBulkTriageSkipReason;
}

/** One errored id with a representable error (the whole tx aborts; this REPORTS it). */
export interface InboxBulkTriageErrored {
  readonly id: string;
  readonly error: string;
}

/** The result of one bulk sweep. */
export interface InboxBulkTriageResult {
  /** The shared batch id, so the whole sweep undoes as one (T044/T126). */
  readonly batchId: string;
  /** How many ids had the verb (and optional priority) applied. */
  readonly applied: number;
  /** Ineligible/stale ids, each with its classified skip reason (no throw). */
  readonly skipped: readonly InboxBulkTriageSkipped[];
  /** Ids whose write failed unexpectedly — the whole tx aborted (`applied` is 0). */
  readonly errored: readonly InboxBulkTriageErrored[];
}

/** The injected dependencies — mirrors how `triageInboxItem` reaches its writes. */
export interface InboxBulkTriageDeps {
  readonly elements: ElementRepository;
  /** The attention scheduler (a {@link SchedulerService}) for accept/queueSoon. */
  readonly scheduler: SchedulerService;
  readonly undo: UndoService;
}

export class InboxBulkTriageService {
  private readonly elements: ElementRepository;
  private readonly scheduler: SchedulerService;
  private readonly undo: UndoService;

  constructor(
    private readonly db: InterleaveDatabase,
    deps: InboxBulkTriageDeps,
  ) {
    this.elements = deps.elements;
    this.scheduler = deps.scheduler;
    this.undo = deps.undo;
  }

  /**
   * Apply one triage `action` (optionally + one `priority` band) to `ids` as ONE
   * transaction sharing ONE `batchId`. Dedupes `ids`; re-reads each row inside the
   * transaction and skip-and-classifies the ineligible (never throws for staleness).
   * Eligible rows get — under one `batchId` — an optional priority `update_element`
   * THEN the verb's existing `…Within` write. A genuine write error rolls the whole
   * transaction back (zero applied) and is reported via `errored`.
   */
  apply(
    ids: readonly string[],
    action: InboxBulkTriageAction,
    priority: PriorityLabel | null = null,
    now: IsoTimestamp = nowIso(),
  ): InboxBulkTriageResult {
    const batchId = newRowId();
    // A `setPriority` sweep IS the priority write — it carries no separate verb, so the
    // band is mandatory. The U4 zod contract enforces this at the IPC boundary; guard
    // here too so a malformed direct call fails loudly instead of counting empty writes.
    if (action === "setPriority" && priority === null) {
      throw new Error("InboxBulkTriageService: setPriority requires a priority band.");
    }
    // Dedupe while preserving first-seen order so the op order is deterministic.
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return { batchId, applied: 0, skipped: [], errored: [] };
    }

    const skipped: InboxBulkTriageSkipped[] = [];
    try {
      const applied = this.db.transaction((tx) => {
        let appliedCount = 0;
        for (const rawId of uniqueIds) {
          const id = rawId as ElementId;
          const current = tx.select().from(elements).where(eq(elements.id, id)).get();
          const reason = this.skipReason(current);
          if (reason) {
            skipped.push({ id: rawId, reason });
            continue;
          }
          // Optional priority FIRST so a combined verb+priority sweep records BOTH a
          // priority `update_element` AND the verb's write under one `batchId`.
          if (priority !== null) {
            this.elements.updateWithin(
              tx,
              id,
              { priority: priorityFromLabel(priority) },
              { batchId },
            );
          }
          this.applyVerbWithin(tx, id, action, batchId, now);
          appliedCount += 1;
        }
        return appliedCount;
      });
      return { batchId, applied, skipped, errored: [] };
    } catch (error) {
      // The transaction rolled back: NOTHING persisted (applied is 0). Surface the
      // failure honestly rather than swallow it. The skip classification gathered before
      // the throw is discarded too (the whole batch is atomic), so report only the error.
      const message = error instanceof Error ? error.message : String(error);
      return {
        batchId,
        applied: 0,
        skipped: [],
        errored: uniqueIds.map((id) => ({ id, error: message })),
      };
    }
  }

  /**
   * Bulk-accept each item's OWN suggested band (T127 — KTD-8). Unlike {@link apply}
   * (one uniform priority for all), this applies a DIFFERENT band per id, each through
   * the SAME per-item `setPriority` `update_element` write under ONE shared `batchId`,
   * carrying the `accepted`-suggestion provenance marker. Ineligible rows skip-and-classify
   * exactly like {@link apply} (never throws for staleness); the movement guard reverses
   * the whole batch via {@link undoBatch}. The caller (db-service) resolves the bands and
   * classifies `no_suggestion` ids before calling this; here every item already carries a band.
   */
  applySuggestions(items: readonly InboxBulkSuggestionItem[]): InboxBulkTriageResult {
    const batchId = newRowId();
    // Dedupe by id (first-seen) so the op order is deterministic.
    const seen = new Set<string>();
    const uniqueItems = items.filter((it) => {
      if (seen.has(it.id)) return false;
      seen.add(it.id);
      return true;
    });
    if (uniqueItems.length === 0) {
      return { batchId, applied: 0, skipped: [], errored: [] };
    }

    const skipped: InboxBulkTriageSkipped[] = [];
    try {
      const applied = this.db.transaction((tx) => {
        let appliedCount = 0;
        for (const item of uniqueItems) {
          const id = item.id as ElementId;
          const current = tx.select().from(elements).where(eq(elements.id, id)).get();
          const reason = this.skipReason(current);
          if (reason) {
            skipped.push({ id: item.id, reason });
            continue;
          }
          this.elements.updateWithin(
            tx,
            id,
            { priority: priorityFromLabel(item.band) },
            {
              batchId,
              extras: {
                triageSuggestion: {
                  decision: "accepted",
                  suggestedBand: item.band,
                  finalBand: item.band,
                  signalKinds: item.signalKinds,
                  signalHash: item.signalHash,
                },
              },
            },
          );
          appliedCount += 1;
        }
        return appliedCount;
      });
      return { batchId, applied, skipped, errored: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        batchId,
        applied: 0,
        skipped: [],
        errored: uniqueItems.map((it) => ({ id: it.id, error: message })),
      };
    }
  }

  /**
   * Undo a bulk batch by its `batchId`, refusing cleanly if any victim moved since the
   * batch wrote it (the op-type-agnostic movement guard, KTD-6). Restores every row in
   * the batch to its captured pre-image (status/dueAt/priority/parkedAt/deleted).
   */
  undoBatch(batchId: string): UndoResult {
    return this.undo.undoBatch(batchId, { requireCurrentBulkTriageStateMatch: true });
  }

  /**
   * Classify why a re-read row is ineligible, or `null` when it is a live inbox source
   * (the per-item predicate, split into reasons instead of a single throw).
   */
  private skipReason(
    current: { deletedAt: string | null; type: string; status: string } | undefined,
  ): InboxBulkTriageSkipReason | null {
    if (!current) return "already_acted";
    if (current.deletedAt) return "deleted";
    if (current.type !== "source") return "wrong_type";
    if (current.status !== "inbox") return "not_inbox";
    return null;
  }

  /** Dispatch the verb to the SAME `…Within` helper the per-item path uses. */
  private applyVerbWithin(
    tx: TransactionClient,
    id: ElementId,
    action: InboxBulkTriageAction,
    batchId: string,
    now: IsoTimestamp,
  ): void {
    switch (action) {
      case "accept":
        this.scheduler.activateSourceWithReturnWithin(tx, id, now, { batchId });
        break;
      case "queueSoon":
        this.scheduler.queueSourceSoonWithin(tx, id, now, { batchId });
        break;
      case "keepForLater":
        this.elements.updateWithin(
          tx,
          id,
          { status: "parked", dueAt: null, parkedAt: now },
          { batchId, extras: { action: "keepForLater" } },
        );
        break;
      case "delete":
        this.elements.softDeleteWithin(tx, id, { batchId });
        break;
      case "setPriority":
        // A pure priority sweep is the priority write itself; combined sweeps already
        // ran the priority write above, so here `setPriority` is a no-op verb when a
        // separate `priority` band was passed. Reaching it without a band means a
        // priority-only sweep was issued with no band — nothing to write.
        break;
    }
  }
}

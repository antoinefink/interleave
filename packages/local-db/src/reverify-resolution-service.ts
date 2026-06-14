/**
 * ReverifyResolutionService (T124 U4) — the per-source re-verify *drain* orchestrator.
 *
 * T123 made content-staleness VISIBLE (`element_reverify_provenance` rows ⇒
 * `elements.needs_reverify`). T124 builds the human-in-the-loop drain on top of the U2
 * primitives: a per-source, session-capped, fingerprinted preview; transactional
 * confirm/detach with in-transaction revalidation + per-item skip reasons; a settings-
 * persisted receipt keyed by local day + batchId; and receipt-scoped (and per-item)
 * batch undo with a four-part current-state guard.
 *
 * This mirrors `ExtractAgingPolicyService` exactly: `sessionPreview()` is read-only and
 * appends ZERO op-log rows; `resolve()` runs one `db.transaction` with a single
 * `batchId`, revalidates each decision in-tx, and dispatches to the U2 verb primitives;
 * the receipt is persisted via the settings JSON (key `REVERIFY_RESOLUTION_STATE_KEY`)
 * keyed by the local day with a retain-window prune; `undoReceipt()` guards before it
 * inverts, refusing to clobber a target that drifted after the resolution.
 *
 * Load-bearing decisions honored here (KTD1/KTD2/KTD5/KTD6/KTD7):
 *  - Resolutions NEVER touch `review_states` for any verb — card schedule
 *    re-stabilization is deferred to T125 (KTD7). T124 never re-derives card bodies.
 *  - The undo inverse calls `ReverifyResolutionRepository.restoreResolutionWithin`
 *    DIRECTLY inside this service's transaction (NOT `UndoService.invertWithin`, which
 *    opens its own transaction and cannot nest). The restore appends no globally-undoable
 *    op (re-insert provenance is not an op; recompute carries `propagation: true`), so a
 *    later global ⌘Z cannot partially reverse an already-undone receipt.
 *  - Rebase (verb `"rebase"`, U5) re-anchors a flagged output to the corrected source
 *    text. A raw/clean extract RE-DERIVES its body main-side (fail-closed) via the lifted
 *    `richSelectionToProseMirrorDoc` reconstruction + a direct `documents.upsertWithin`
 *    (NO rewrite scheduling — re-verify must not reschedule the extract); an
 *    atomic-statement extract / card / media_fragment is clear-only. After the clear the
 *    source block is reconciled out of `stale_after_edit` ONLY when the rebased element is
 *    the LAST live flagged anchor on that block (sibling protection, KTD4). The forward
 *    body + block-state writes are non-invertible by global undo, so their preimages ride
 *    the `reverifyResolution` op and the receipt undo restores them.
 */

import type {
  BlockId,
  ElementId,
  IsoTimestamp,
  SourceBlockProcessingState,
} from "@interleave/core";
import { richSelectionToProseMirrorDoc } from "@interleave/core";
import {
  documentBlocks,
  documents,
  elementDetachSnapshot,
  elementReverifyProvenance,
  elements,
  type InterleaveDatabase,
  sourceBlockProcessing,
  sourceLocations,
} from "@interleave/db";
import { aliasedTable, and, asc, eq, isNull, sql } from "drizzle-orm";
import { computeBlockContentHashes } from "./block-processing-service";
import { newRowId, nowIso } from "./ids";
import type { Repositories } from "./index";
import { REVERIFY_FLAGGABLE_TYPES } from "./reverify-propagation-repository";
import {
  type DetachSnapshotInput,
  type ReverifyBlockStatePreimage,
  type ReverifyBodyPreimage,
  ReverifyResolutionRepository,
  type ReverifyResolutionVerb,
} from "./reverify-resolution-repository";
import type { DbClient, TransactionClient } from "./types";

/**
 * The extract distillation stages whose body a rebase RE-DERIVES from the corrected
 * source text (KTD4). An `atomic_statement`-stage extract, a card, and a media_fragment
 * are clear-only (they have been distilled/authored away from a verbatim source selection,
 * so re-deriving would clobber user work). `raw_extract`/`clean_extract` still mirror the
 * source selection closely enough to re-derive.
 */
const REBASE_BODY_STAGES: ReadonlySet<string> = new Set(["raw_extract", "clean_extract"]);

/**
 * `element_reverify_provenance` joins the `elements` table TWICE — once as the flagged
 * TARGET output and once as its SOURCE element (for the title) — so each needs a distinct
 * alias to be unambiguous in the same query.
 */
const target = aliasedTable(elements, "reverify_target");
const source = aliasedTable(elements, "reverify_source");

/** Settings key for the per-day resolution receipt store (T117/T121 pattern). */
export const REVERIFY_RESOLUTION_STATE_KEY = "lineage.reverifyResolution.v1";
/** Default per-sitting session cap (O1 — a constant for now; tune in U8). */
export const REVERIFY_SESSION_CAP = 25;
/** How many local days of receipts to retain before pruning. */
const RETAIN_DAYS = 31;
/** A short-lived preview snapshot validity window (informational; revalidation is in-tx). */
const PREVIEW_TTL_MS = 10 * 60 * 1000;
/**
 * The fingerprint/opKey field separator — an ASCII Unit Separator that cannot appear in
 * any hash, id, ISO timestamp, or JSON-array string, so the joined components stay
 * unambiguously splittable (used to tell a block re-edit from a target change).
 */
const FINGERPRINT_DELIMITER = String.fromCharCode(31);

/** A resolution receipt is actionable until its batch undo marks it undone. */
export type ReverifyReceiptStatus = "actionable" | "undone";

/** Why one decision was skipped during `resolve` (T120 partial-batch pattern). */
export type ReverifyResolveSkipReason =
  | "not-flagged"
  | "block-re-edited"
  | "target-changed"
  | "deleted"
  | "rebase-failed";

/** One hydrated, fingerprinted preview item (drives the U7 surface). */
export interface ReverifySessionItem {
  readonly elementId: ElementId;
  readonly type: string;
  readonly stage: string;
  readonly title: string;
  readonly stableBlockId: BlockId;
  /** The OLD anchor text snapshot (`source_locations.selectedText`). */
  readonly oldAnchorText: string;
  /** The CURRENT block text, re-extracted from the live source `prosemirrorJson`. */
  readonly currentBlockText: string;
  /** The per-item revalidation token (see {@link fingerprintFor}). */
  readonly fingerprint: string;
}

/** The read-only per-source session preview payload. Appends ZERO op-log rows. */
export interface ReverifySessionPreview {
  readonly sourceElementId: ElementId;
  readonly asOf: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly cap: number;
  /** How many flagged items beyond the cap remain for a later sitting. */
  readonly remaining: number;
  readonly items: readonly ReverifySessionItem[];
}

/** One decision in a `resolve` batch. */
export interface ReverifyDecision {
  readonly elementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly verb: ReverifyResolutionVerb;
  readonly fingerprint: string;
}

/** One skipped decision + the reason it was not applied. */
export interface ReverifyResolveSkip {
  readonly elementId: ElementId;
  readonly reason: ReverifyResolveSkipReason;
}

/** One resolved item recorded on the receipt (for per-item undo). */
export interface ReverifyReceiptItem {
  readonly elementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly verb: ReverifyResolutionVerb;
}

/** Per-verb counts on a resolution receipt. */
export interface ReverifyReceiptCounts {
  readonly confirmed: number;
  readonly rebased: number;
  readonly detached: number;
  readonly skipped: number;
}

/** A persisted per-source resolution receipt, keyed by `batchId`. */
export interface ReverifyResolutionReceipt {
  readonly batchId: string;
  readonly localDay: string;
  readonly sourceElementId: ElementId;
  readonly status: ReverifyReceiptStatus;
  readonly createdAt: IsoTimestamp;
  readonly counts: ReverifyReceiptCounts;
  readonly items: readonly ReverifyReceiptItem[];
  readonly undoneAt?: IsoTimestamp;
}

/** The `resolve` result. */
export interface ReverifyResolveResult {
  readonly batchId: string;
  readonly applied: number;
  readonly skipped: readonly ReverifyResolveSkip[];
  readonly receipt: ReverifyResolutionReceipt | null;
}

/** The `undoReceipt` result. */
export interface ReverifyUndoResult {
  readonly undone: boolean;
  readonly count: number;
  readonly reason?: string;
  readonly skipped: readonly ReverifyReceiptItem[];
  readonly receipt: ReverifyResolutionReceipt | null;
}

/** One source with ≥1 live reverify-flagged output (drives the hub/source-page entry). */
export interface ReverifyFlaggedSource {
  readonly sourceElementId: ElementId;
  readonly title: string;
  /** Distinct live flagged outputs for this source (one element counted once). */
  readonly count: number;
}

/**
 * The light, read-only cross-source rollup powering the maintenance hub metric + the
 * "which sources have outstanding re-verify work" list. Appends ZERO op-log rows.
 */
export interface ReverifyFlaggedSourcesSummary {
  /** Total distinct live flagged outputs across every source (sum of `sources[].count`). */
  readonly totalOutputs: number;
  /** Every source with ≥1 live flagged output, ordered by count desc then title asc. */
  readonly sources: readonly ReverifyFlaggedSource[];
}

interface ReverifyResolutionState {
  readonly version: 1;
  readonly receiptsByBatchId: Record<string, ReverifyResolutionReceipt>;
  readonly batchIdsByLocalDay: Record<string, readonly string[]>;
}

export class ReverifyResolutionService {
  private readonly repo: ReverifyResolutionRepository;

  constructor(
    private readonly db: InterleaveDatabase,
    private readonly repos: Repositories,
    private readonly clock: () => IsoTimestamp = nowIso,
  ) {
    this.repo = new ReverifyResolutionRepository(db);
  }

  /**
   * Build a read-only, per-source, capped, fingerprinted session preview. Tolerates a
   * missing/deleted source id by returning a stable empty payload (KTD8 — the IPC layer
   * also guards, but a read should never throw on a stale id). Appends ZERO op-log rows.
   */
  sessionPreview(options: {
    readonly sourceElementId: ElementId;
    readonly cap?: number;
  }): ReverifySessionPreview {
    const asOf = this.clock();
    const cap = normalizeCap(options.cap);
    const expiresAt = new Date(Date.parse(asOf) + PREVIEW_TTL_MS).toISOString() as IsoTimestamp;
    const empty: ReverifySessionPreview = {
      sourceElementId: options.sourceElementId,
      asOf,
      expiresAt,
      cap,
      remaining: 0,
      items: [],
    };

    return this.db.transaction((tx) => {
      // A read-only tx (no writes ⇒ no op-log rows). Tolerate a stale source id.
      const flagged = this.repo.listFlaggedBySourceWithin(tx, options.sourceElementId);
      // One flagged (element, block) tuple per row in the preview, ordered stably.
      const tuples = flagged.flatMap((row) => row.blocks.map((blockId) => ({ row, blockId })));
      const total = tuples.length;
      if (total === 0) return empty;

      const currentBlockText = this.currentBlockTextMap(options.sourceElementId);
      const oldAnchorText = this.oldAnchorTextMap(tx, options.sourceElementId);

      const hydrated = tuples
        .slice(0, cap)
        .map(({ row, blockId }) =>
          this.hydrateItem(
            tx,
            options.sourceElementId,
            row,
            blockId,
            currentBlockText,
            oldAnchorText,
          ),
        );

      return {
        sourceElementId: options.sourceElementId,
        asOf,
        expiresAt,
        cap,
        remaining: Math.max(0, total - hydrated.length),
        items: hydrated,
      } satisfies ReverifySessionPreview;
    });
  }

  /**
   * Apply a batch of decisions in one transaction under a single `batchId`. Each
   * decision is REVALIDATED in-tx (its fingerprint recomputed from current state and
   * compared to the supplied one); drift yields an explicit skip reason without failing
   * the whole batch (T120). Confirm/detach dispatch to the U2 verb primitives; the
   * receipt is persisted by local day + batchId. Bulk-confirm is just `resolve` with
   * all-confirm decisions — no special path.
   */
  resolve(input: {
    readonly batchId?: string;
    readonly sourceElementId: ElementId;
    readonly decisions: readonly ReverifyDecision[];
  }): ReverifyResolveResult {
    const batchId = input.batchId ?? newRowId();
    const asOf = this.clock();
    const localDay = localDayOf(asOf);

    const result = this.db.transaction((tx) => {
      const skipped: ReverifyResolveSkip[] = [];
      const items: ReverifyReceiptItem[] = [];
      let confirmed = 0;
      let rebased = 0;
      let detached = 0;

      const currentBlockText = this.currentBlockTextMap(input.sourceElementId);
      const currentSourceJson = this.repos.documents.findById(
        input.sourceElementId,
      )?.prosemirrorJson;
      const currentBlockHashes = computeBlockContentHashes(currentSourceJson ?? null);

      for (const decision of input.decisions) {
        const reason = this.revalidate(tx, input.sourceElementId, decision, currentBlockText);
        if (reason) {
          skipped.push({ elementId: decision.elementId, reason });
          continue;
        }

        switch (decision.verb) {
          case "confirm": {
            this.repo.clearProvenanceWithin(tx, {
              elementId: decision.elementId,
              sourceElementId: input.sourceElementId,
              stableBlockId: decision.stableBlockId,
              batchId,
              verb: "confirm",
            });
            confirmed += 1;
            items.push({
              elementId: decision.elementId,
              stableBlockId: decision.stableBlockId,
              verb: "confirm",
            });
            break;
          }
          case "detach": {
            const snapshot = this.buildDetachSnapshot(
              tx,
              input.sourceElementId,
              decision,
              currentBlockText,
            );
            // R7/KTD7: detach NEVER touches `review_states`. A card detaches into a
            // standalone output but keeps its FSRS schedule untouched — the write
            // barrier for a material rewrite is deferred to T125.
            this.repo.detachWithin(
              tx,
              {
                elementId: decision.elementId,
                sourceElementId: input.sourceElementId,
                stableBlockId: decision.stableBlockId,
                snapshot,
              },
              batchId,
            );
            detached += 1;
            items.push({
              elementId: decision.elementId,
              stableBlockId: decision.stableBlockId,
              verb: "detach",
            });
            break;
          }
          case "rebase": {
            // Rebase re-anchors a flagged output to the corrected source text. For a
            // raw/clean extract it RE-DERIVES the body main-side (fail-closed); for an
            // atomic-statement extract / card / media_fragment it is clear-only (R7 —
            // card schedule never touched, body never re-derived). Either way it clears
            // provenance against the now-current block, then conditionally reconciles the
            // block out of `stale_after_edit` (only when this was the last flagged anchor).
            const reason = this.rebaseWithin(tx, {
              sourceElementId: input.sourceElementId,
              decision,
              batchId,
              currentSourceJson,
              currentBlockHashes,
            });
            if (reason) {
              skipped.push({ elementId: decision.elementId, reason });
              break;
            }
            rebased += 1;
            items.push({
              elementId: decision.elementId,
              stableBlockId: decision.stableBlockId,
              verb: "rebase",
            });
            break;
          }
          default: {
            const exhaustive: never = decision.verb;
            throw new Error(
              `ReverifyResolutionService.resolve: unknown verb ${String(exhaustive)}`,
            );
          }
        }
      }

      const applied = confirmed + rebased + detached;
      const receipt: ReverifyResolutionReceipt | null =
        applied > 0
          ? {
              batchId,
              localDay,
              sourceElementId: input.sourceElementId,
              status: "actionable",
              createdAt: asOf,
              counts: { confirmed, rebased, detached, skipped: skipped.length },
              items,
            }
          : null;
      if (receipt) this.writeReceiptWithin(tx, receipt);
      return { skipped, receipt, applied };
    });

    return {
      batchId,
      applied: result.applied,
      skipped: result.skipped,
      receipt: result.receipt,
    };
  }

  /**
   * Reverse a resolution receipt with a per-item four-part current-state guard (KTD6).
   * For each recorded item: (a) the op is `update_element`, (b) it carries the
   * `reverifyResolution` marker, (c) the target element still exists, (d) the target is
   * still in the SYSTEM-WRITTEN resolved state (confirm: no live provenance for that
   * triple ⇒ not re-staled since; detach: the detach snapshot row is still present). An
   * item that fails the guard is skipped (per-item). If NO item restored → refuse
   * (`{ undone: false, reason }`) rather than clobbering. The inverse calls
   * `restoreResolutionWithin` DIRECTLY in-tx (it appends no globally-undoable op).
   */
  undoReceipt(
    batchId: string,
    options: { itemIds?: readonly ElementId[] } = {},
  ): ReverifyUndoResult {
    const state = this.state();
    const receipt = state.receiptsByBatchId[batchId];
    if (!receipt) {
      return {
        undone: false,
        count: 0,
        reason: "receipt-not-actionable",
        skipped: [],
        receipt: null,
      };
    }
    if (receipt.status === "undone") {
      return {
        undone: false,
        count: 0,
        reason: "receipt-not-actionable",
        skipped: [],
        receipt,
      };
    }

    const filter = options.itemIds ? new Set<ElementId>(options.itemIds) : null;
    const targetItems = filter
      ? receipt.items.filter((item) => filter.has(item.elementId))
      : receipt.items;

    const ops = this.collectResolutionOps(batchId);

    const outcome = this.db.transaction((tx) => {
      const skipped: ReverifyReceiptItem[] = [];
      let restored = 0;
      for (const item of targetItems) {
        const op = ops.get(opKey(item.elementId, item.stableBlockId, item.verb));
        if (!op || !this.guardResolvedWithin(tx, item)) {
          skipped.push(item);
          continue;
        }
        // The inverse: re-insert the captured provenance, drop any detach snapshot, and
        // recompute the flag back to true. Appends NO globally-undoable op.
        this.repo.restoreResolutionWithin(tx, { elementId: item.elementId, payload: op.payload });
        restored += 1;
      }
      if (restored === 0) return { restored, skipped, receipt };

      // A whole-receipt undo marks it undone; a partial per-item undo keeps it
      // actionable so the still-resolved items can be undone in a later pass.
      const fullyUndone = restored === receipt.items.length && skipped.length === 0;
      const nextReceipt: ReverifyResolutionReceipt = fullyUndone
        ? { ...receipt, status: "undone", undoneAt: this.clock() }
        : receipt;
      if (fullyUndone) this.writeReceiptWithin(tx, nextReceipt);
      return { restored, skipped, receipt: nextReceipt };
    });

    if (outcome.restored === 0) {
      return {
        undone: false,
        count: 0,
        reason: filter ? "no-matching-items" : "items-drifted",
        skipped: outcome.skipped,
        receipt,
      };
    }
    return {
      undone: true,
      count: outcome.restored,
      skipped: outcome.skipped,
      receipt: outcome.receipt,
    };
  }

  /** All receipts persisted for one local day (mirrors extract-aging's receipt read). */
  receiptsForDay(localDay: string): readonly ReverifyResolutionReceipt[] {
    const state = this.state();
    return (state.batchIdsByLocalDay[localDay] ?? [])
      .map((batchId) => state.receiptsByBatchId[batchId])
      .filter((receipt): receipt is ReverifyResolutionReceipt => Boolean(receipt));
  }

  /** All receipts for the current local day. */
  receiptsForToday(): readonly ReverifyResolutionReceipt[] {
    return this.receiptsForDay(localDayOf(this.clock()));
  }

  /** A single receipt by batch id, or `null`. */
  receipt(batchId: string): ReverifyResolutionReceipt | null {
    return this.state().receiptsByBatchId[batchId] ?? null;
  }

  /**
   * The light, cross-source flagged-output rollup (drives the maintenance hub metric +
   * the source-page entry list). For every source with ≥1 live reverify-flagged output,
   * report its title and the distinct count of flagged elements (one element counted once
   * even when several source blocks flag it). Read-only — appends ZERO op-log rows;
   * soft-deleted targets and non-flaggable types are excluded. Ordered by count desc,
   * then title asc for a stable surface.
   */
  flaggedSourcesSummary(): ReverifyFlaggedSourcesSummary {
    // Distinct (source, element) pairs over LIVE flaggable targets — counting an element
    // once per source no matter how many of its blocks flag it. The source title rides
    // the same row via a join on the provenance row's `sourceElementId`.
    const rows = this.db
      .selectDistinct({
        sourceElementId: elementReverifyProvenance.sourceElementId,
        elementId: elementReverifyProvenance.elementId,
        type: target.type,
        sourceTitle: source.title,
      })
      .from(elementReverifyProvenance)
      .innerJoin(target, eq(target.id, elementReverifyProvenance.elementId))
      .innerJoin(source, eq(source.id, elementReverifyProvenance.sourceElementId))
      .where(and(isNull(target.deletedAt), isNull(source.deletedAt)))
      .all();

    const bySource = new Map<ElementId, ReverifyFlaggedSource & { count: number }>();
    for (const row of rows) {
      if (!REVERIFY_FLAGGABLE_TYPES.has(row.type)) continue;
      const sourceElementId = row.sourceElementId as ElementId;
      const existing = bySource.get(sourceElementId);
      if (existing) {
        bySource.set(sourceElementId, { ...existing, count: existing.count + 1 });
      } else {
        bySource.set(sourceElementId, {
          sourceElementId,
          title: row.sourceTitle,
          count: 1,
        });
      }
    }

    const sources = [...bySource.values()].sort(
      (a, b) => b.count - a.count || a.title.localeCompare(b.title),
    );
    return {
      totalOutputs: sources.reduce((sum, entry) => sum + entry.count, 0),
      sources,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────────────

  private hydrateItem(
    tx: DbClient,
    sourceElementId: ElementId,
    row: { elementId: ElementId; type: string; stage: string; title: string },
    blockId: BlockId,
    currentBlockText: ReadonlyMap<BlockId, string>,
    oldAnchorText: ReadonlyMap<ElementId, string>,
  ): ReverifySessionItem {
    return {
      elementId: row.elementId,
      type: row.type,
      stage: row.stage,
      title: row.title,
      stableBlockId: blockId,
      oldAnchorText: oldAnchorText.get(row.elementId) ?? "",
      currentBlockText: currentBlockText.get(blockId) ?? "",
      fingerprint: this.fingerprintWithin(
        tx,
        sourceElementId,
        row.elementId,
        blockId,
        currentBlockText,
      ),
    };
  }

  /**
   * Revalidate one decision against current state. Mismatch ⇒ explicit skip reason:
   *  - `deleted`        — the target element is gone or soft-deleted;
   *  - `not-flagged`    — no live provenance for the triple (already resolved / cleared);
   *  - `block-re-edited`/`target-changed` — the fingerprint drifted since the preview.
   */
  private revalidate(
    tx: DbClient,
    sourceElementId: ElementId,
    decision: ReverifyDecision,
    currentBlockText: ReadonlyMap<BlockId, string>,
  ): ReverifyResolveSkipReason | null {
    const element = tx
      .select({ deletedAt: elements.deletedAt })
      .from(elements)
      .where(eq(elements.id, decision.elementId))
      .get();
    if (!element || element.deletedAt !== null) return "deleted";

    const live = tx
      .select({ n: sql<number>`count(*)` })
      .from(elementReverifyProvenance)
      .where(
        and(
          eq(elementReverifyProvenance.elementId, decision.elementId),
          eq(elementReverifyProvenance.sourceElementId, sourceElementId),
          eq(elementReverifyProvenance.stableBlockId, decision.stableBlockId),
        ),
      )
      .get();
    if ((live?.n ?? 0) === 0) return "not-flagged";

    const current = this.fingerprintWithin(
      tx,
      sourceElementId,
      decision.elementId,
      decision.stableBlockId,
      currentBlockText,
    );
    if (current !== decision.fingerprint) {
      // A drifted current BLOCK component reads as a re-edit; an anchor/provenance/
      // element shift (the rest) reads as the target changing. The fingerprint is
      // delimited so each component is extractable for this distinction.
      const blockChanged =
        firstFingerprintComponent(current) !== firstFingerprintComponent(decision.fingerprint);
      return blockChanged ? "block-re-edited" : "target-changed";
    }
    // A missing anchor row (detach needs one to snapshot) is caught at the dispatch site
    // (`buildDetachSnapshot` → `target-changed`), so confirm/detach share this gate.
    return null;
  }

  /**
   * The per-item revalidation fingerprint (KTD5): a stable hash of the CURRENT block
   * content + the element's anchor blockIds + a signature of its live provenance rows
   * for this source + the element's `updatedAt` + `deletedAt`. A re-edited block, a
   * concurrent body edit (bumps `updatedAt`), or a soft-delete/restore round-trip all
   * change it, so a stale decision is caught at the service boundary and skipped.
   *
   * The block-content component is placed FIRST and delimited so `revalidate` can
   * cheaply tell a block re-edit (component changed) from a target change (rest changed).
   */
  private fingerprintWithin(
    tx: DbClient,
    sourceElementId: ElementId,
    elementId: ElementId,
    blockId: BlockId,
    currentBlockText: ReadonlyMap<BlockId, string>,
  ): string {
    const element = tx
      .select({ updatedAt: elements.updatedAt, deletedAt: elements.deletedAt })
      .from(elements)
      .where(eq(elements.id, elementId))
      .get();
    const anchor = tx
      .select({ blockIds: sourceLocations.blockIds })
      .from(sourceLocations)
      .where(eq(sourceLocations.elementId, elementId))
      .get();
    // Scope the provenance signature to THIS decision's exact (element, source, block)
    // triple — NOT every block of the element. A wider scope made a bulk batch
    // self-invalidate: resolving one block deletes its provenance row, which would shift
    // a sibling block's recomputed signature and skip it as `target-changed`, leaving a
    // multi-block-flagged element permanently flagged. Per-triple, each decision's
    // fingerprint is independent of its siblings' resolution.
    const provenance = tx
      .select({
        sourceElementId: elementReverifyProvenance.sourceElementId,
        stableBlockId: elementReverifyProvenance.stableBlockId,
        batchId: elementReverifyProvenance.batchId,
      })
      .from(elementReverifyProvenance)
      .where(
        and(
          eq(elementReverifyProvenance.elementId, elementId),
          eq(elementReverifyProvenance.sourceElementId, sourceElementId),
          eq(elementReverifyProvenance.stableBlockId, blockId),
        ),
      )
      .all();
    const provenanceSig = provenance
      .map((row) => `${row.sourceElementId}:${row.stableBlockId}:${row.batchId}`)
      .sort()
      .join("|");

    return [
      blockComponent(currentBlockText, blockId),
      anchor?.blockIds ?? "",
      provenanceSig,
      element?.updatedAt ?? "",
      element?.deletedAt ?? "",
    ].join(FINGERPRINT_DELIMITER);
  }

  /**
   * Apply the **rebase** verb to one revalidated decision (KTD4/R3/R7). Returns `null`
   * on success, or an explicit skip reason on a fail-closed branch (the caller records
   * it; nothing is written).
   *
   * Dispatch keys on the target's TYPE + STAGE:
   *  - **Raw/clean extract** (`type === "extract"` AND stage ∈ {raw_extract, clean_extract}):
   *    re-derive the body main-side from the CURRENT source doc + the element's IMMUTABLE
   *    `source_locations` anchor (blockIds/offsets/selectedText). Fail-closed: if the
   *    anchor is missing offsets or `richSelectionToProseMirrorDoc` returns `null`, skip
   *    with `rebase-failed` and write NOTHING (the flag stays set). On success, capture
   *    the extract's CURRENT body as `prevBody`, write the re-derived body via
   *    `documents.upsertWithin` (the child body gets fresh block ids; the anchor row is
   *    NEVER touched), then clear provenance carrying `prevBody` for undo.
   *  - **Atomic-statement extract / card / media_fragment**: clear-only — no body
   *    re-derivation (R7: a card's `review_states` is never touched).
   *
   * AFTER clearing the element's provenance the block is conditionally reconciled out of
   * `stale_after_edit` — but ONLY when this was the LAST live flagged anchor on
   * `(source, block)` (KTD4 sibling protection). If a sibling output still flags the
   * block, the block stays stale with its `pre_stale_hash` intact so the sibling keeps
   * its content-restore auto-clear. The reconcile is a DIRECT `upsertStateWithin` call
   * (no `unStaled` report ⇒ T123's `propagateReverify` does not mass-clear siblings).
   */
  private rebaseWithin(
    tx: DbClient,
    args: {
      readonly sourceElementId: ElementId;
      readonly decision: ReverifyDecision;
      readonly batchId: string;
      readonly currentSourceJson: unknown;
      readonly currentBlockHashes: ReadonlyMap<BlockId, string>;
    },
  ): ReverifyResolveSkipReason | null {
    const { sourceElementId, decision, batchId } = args;
    const target = tx
      .select({ type: elements.type, stage: elements.stage })
      .from(elements)
      .where(eq(elements.id, decision.elementId))
      .get();
    // `revalidate` already proved the element is live + flagged; this is a defensive read.
    if (!target) return "deleted";

    let prevBody: ReverifyBodyPreimage | undefined;
    const reDerivesBody = target.type === "extract" && REBASE_BODY_STAGES.has(target.stage);

    if (reDerivesBody) {
      // The element's own anchor into the source — IMMUTABLE; re-derivation reads it but
      // never rewrites it. A descent-flagged output without an own anchor is clear-only,
      // but a raw/clean extract always carries one.
      const anchor = tx
        .select({
          blockIds: sourceLocations.blockIds,
          startOffset: sourceLocations.startOffset,
          endOffset: sourceLocations.endOffset,
          selectedText: sourceLocations.selectedText,
        })
        .from(sourceLocations)
        .where(eq(sourceLocations.elementId, decision.elementId))
        .get();
      if (!anchor || anchor.startOffset == null || anchor.endOffset == null) {
        return "rebase-failed"; // no usable offsets ⇒ cannot reconstruct; fail closed.
      }
      let blockIds: BlockId[];
      try {
        blockIds = JSON.parse(anchor.blockIds) as BlockId[];
      } catch {
        return "rebase-failed";
      }

      // LIFT ONLY the reconstruction call from ExtractionService.createExtraction — re-run
      // it against the CURRENT source doc. Fail-closed on null (no partial write).
      const conversion = richSelectionToProseMirrorDoc({
        parentDoc: args.currentSourceJson ?? null,
        blockIds,
        startOffset: anchor.startOffset,
        endOffset: anchor.endOffset,
        selectedText: anchor.selectedText,
      });
      if (!conversion) return "rebase-failed";

      prevBody = this.readBodyPreimage(tx, decision.elementId);

      // Write the re-derived body via the SAME `DocumentRepository.upsert` path
      // `ExtractService.rewrite` uses — but DIRECTLY (no rewrite scheduling side-effects:
      // re-verify must NOT reschedule the extract). Logs `update_document`.
      this.repos.documents.upsertWithin(tx, {
        elementId: decision.elementId,
        prosemirrorJson: conversion.doc,
        plainText: conversion.plainText,
        blocks: conversion.blocks.map((b) => ({
          blockType: b.blockType,
          order: b.order,
          stableBlockId: b.stableBlockId,
        })),
      });
    }

    // Sibling protection (KTD4): is this the LAST live flagged anchor on (source, block)?
    // Count live provenance rows for the triple's block from OTHER non-deleted elements.
    const siblings = tx
      .select({ n: sql<number>`count(*)` })
      .from(elementReverifyProvenance)
      .innerJoin(elements, eq(elements.id, elementReverifyProvenance.elementId))
      .where(
        and(
          eq(elementReverifyProvenance.sourceElementId, sourceElementId),
          eq(elementReverifyProvenance.stableBlockId, decision.stableBlockId),
          sql`${elementReverifyProvenance.elementId} <> ${decision.elementId}`,
          isNull(elements.deletedAt),
        ),
      )
      .get();
    const lastAnchor = (siblings?.n ?? 0) === 0;

    let prevBlockState: ReverifyBlockStatePreimage | undefined;
    if (lastAnchor) {
      // Reconcile the block out of `stale_after_edit`: accept the corrected text as the
      // new baseline (block_content_hash := current). This DROPS `pre_stale_hash` (the
      // row leaves the stale state). Capture the PRIOR row as the undo preimage first.
      const prior = this.repos.blockProcessing.findRow(sourceElementId, decision.stableBlockId);
      if (prior && prior.state === "stale_after_edit") {
        prevBlockState = {
          stableBlockId: prior.stableBlockId,
          state: prior.state,
          blockContentHash: prior.blockContentHash,
          preStaleHash: prior.preStaleHash,
          metadata: prior.metadata,
        };
        const restoredState = restorableStateFromMetadata(prior.metadata);
        this.repos.blockProcessing.upsertStateWithin(tx, {
          sourceElementId,
          stableBlockId: decision.stableBlockId,
          state: restoredState,
          action: "reconcile_document_blocks",
          blockContentHash: args.currentBlockHashes.get(decision.stableBlockId) ?? null,
          preStaleHash: null,
          metadata: { reason: "rebase_reconciled", restoredTo: restoredState },
        });
      }
    }

    // Clear provenance for the triple (live + soft-deleted) + recompute the flag,
    // carrying the body/block-state preimages so the receipt undo restores them.
    this.repo.clearProvenanceWithin(tx, {
      elementId: decision.elementId,
      sourceElementId,
      stableBlockId: decision.stableBlockId,
      batchId,
      verb: "rebase",
      ...(prevBody ? { prevBody } : {}),
      ...(prevBlockState ? { prevBlockState } : {}),
    });
    return null;
  }

  /** Read the extract's CURRENT body + ordered stable blocks as the rebase undo preimage. */
  private readBodyPreimage(tx: DbClient, elementId: ElementId): ReverifyBodyPreimage {
    const row = tx
      .select({ prosemirrorJson: documents.prosemirrorJson, plainText: documents.plainText })
      .from(documents)
      .where(eq(documents.elementId, elementId))
      .get();
    const blocks = tx
      .select({
        blockType: documentBlocks.blockType,
        order: documentBlocks.order,
        stableBlockId: documentBlocks.stableBlockId,
      })
      .from(documentBlocks)
      .where(eq(documentBlocks.documentId, elementId))
      .orderBy(asc(documentBlocks.order))
      .all();
    return {
      prosemirrorJson: row
        ? (JSON.parse(row.prosemirrorJson) as unknown)
        : { type: "doc", content: [] },
      plainText: row?.plainText ?? "",
      blocks: blocks.map((b) => ({
        blockType: b.blockType,
        order: b.order,
        stableBlockId: b.stableBlockId as BlockId,
      })),
    };
  }

  /**
   * Build the detach snapshot input that freezes the element's evidence root.
   *
   * The PREFERRED anchor is the element's own `source_locations` row (raw/clean extracts
   * carry a direct anchor into the source block). A descent-flagged output — a card or
   * atomic statement whose flag T123 propagated DOWN the lineage without minting it a
   * direct `source_locations` row — has no own anchor; for those the snapshot falls back
   * to a BLOCK-LEVEL evidence root (the flagged `stableBlockId` + the current block text),
   * so detach still freezes a real evidence root rather than refusing. The `pre_stale_hash`
   * is read from `source_block_processing` for the source/block when present (KTD3).
   */
  private buildDetachSnapshot(
    tx: DbClient,
    sourceElementId: ElementId,
    decision: ReverifyDecision,
    currentBlockText: ReadonlyMap<BlockId, string>,
  ): DetachSnapshotInput {
    const anchor = tx
      .select({
        blockIds: sourceLocations.blockIds,
        startOffset: sourceLocations.startOffset,
        endOffset: sourceLocations.endOffset,
        selectedText: sourceLocations.selectedText,
      })
      .from(sourceLocations)
      .where(eq(sourceLocations.elementId, decision.elementId))
      .get();

    const processing = tx
      .select({ preStaleHash: sourceBlockProcessing.preStaleHash })
      .from(sourceBlockProcessing)
      .where(
        and(
          eq(sourceBlockProcessing.sourceElementId, sourceElementId),
          eq(sourceBlockProcessing.stableBlockId, decision.stableBlockId),
        ),
      )
      .get();

    return {
      elementId: decision.elementId,
      sourceElementId,
      stableBlockId: decision.stableBlockId,
      selectedText: anchor?.selectedText ?? currentBlockText.get(decision.stableBlockId) ?? "",
      blockIds: anchor?.blockIds ?? JSON.stringify([decision.stableBlockId]),
      startOffset: anchor?.startOffset ?? null,
      endOffset: anchor?.endOffset ?? null,
      preStaleHash: processing?.preStaleHash ?? null,
    };
  }

  /**
   * The fourth part of the undo guard: is the target still in the SYSTEM-WRITTEN
   * resolved state? Confirm: NO live provenance for the triple (a re-stale after the
   * confirm would have re-inserted one ⇒ skip, do not clobber). Detach: the matching
   * detach snapshot row is still present.
   */
  private guardResolvedWithin(tx: DbClient, item: ReverifyReceiptItem): boolean {
    // (c) target element still exists (resolution-undo restores the flag, which the
    // elements CHECK only permits on a live flaggable row).
    const element = tx
      .select({ id: elements.id })
      .from(elements)
      .where(eq(elements.id, item.elementId))
      .get();
    if (!element) return false;

    if (item.verb === "detach") {
      const snapshot = tx
        .select({ id: elementDetachSnapshot.id })
        .from(elementDetachSnapshot)
        .where(
          and(
            eq(elementDetachSnapshot.elementId, item.elementId),
            eq(elementDetachSnapshot.stableBlockId, item.stableBlockId),
          ),
        )
        .limit(1)
        .get();
      return snapshot !== undefined;
    }

    // confirm (and rebase, once U5 lands): still cleared ⇒ no live provenance for the
    // triple. A re-stale after the resolution re-inserts provenance ⇒ refuse.
    const live = tx
      .select({ n: sql<number>`count(*)` })
      .from(elementReverifyProvenance)
      .where(
        and(
          eq(elementReverifyProvenance.elementId, item.elementId),
          eq(elementReverifyProvenance.stableBlockId, item.stableBlockId),
        ),
      )
      .get();
    return (live?.n ?? 0) === 0;
  }

  /**
   * The `reverifyResolution` ops for a batch, keyed by `(elementId, block, verb)`. One
   * op per resolved item; the payload carries the provenance preimage + snapshot id.
   */
  private collectResolutionOps(
    batchId: string,
  ): Map<string, { elementId: ElementId; payload: Record<string, unknown> }> {
    const ops = this.repos.operationLog.listAll();
    const out = new Map<string, { elementId: ElementId; payload: Record<string, unknown> }>();
    for (const op of ops) {
      if (op.opType !== "update_element" || op.elementId === null) continue;
      const payload = op.payload as Record<string, unknown> | null;
      if (!payload || payload.batchId !== batchId) continue;
      const marker = payload.reverifyResolution as
        | { verb?: string; stableBlockId?: string }
        | undefined;
      if (!marker || typeof marker !== "object") continue;
      const key = opKey(
        op.elementId as ElementId,
        marker.stableBlockId as BlockId,
        marker.verb as ReverifyResolutionVerb,
      );
      out.set(key, { elementId: op.elementId as ElementId, payload });
    }
    return out;
  }

  /**
   * Map each live source block to its CURRENT normalized text, read from the live
   * source `prosemirrorJson` (already parsed by the document repository). The block walk
   * keys on the SAME block ids the propagation/fingerprint paths use.
   */
  private currentBlockTextMap(sourceElementId: ElementId): Map<BlockId, string> {
    const document = this.repos.documents.findById(sourceElementId);
    if (!document) return new Map();
    return blockTextMap(document.prosemirrorJson);
  }

  /** The OLD anchor text (`source_locations.selectedText`) per flagged element. */
  private oldAnchorTextMap(tx: DbClient, sourceElementId: ElementId): Map<ElementId, string> {
    const rows = tx
      .select({ elementId: sourceLocations.elementId, selectedText: sourceLocations.selectedText })
      .from(sourceLocations)
      .innerJoin(elements, eq(elements.id, sourceLocations.elementId))
      .where(and(eq(sourceLocations.sourceElementId, sourceElementId), isNull(elements.deletedAt)))
      .all();
    const out = new Map<ElementId, string>();
    for (const row of rows) {
      if (!out.has(row.elementId as ElementId)) {
        out.set(row.elementId as ElementId, row.selectedText);
      }
    }
    return out;
  }

  private writeReceiptWithin(tx: TransactionClient, receipt: ReverifyResolutionReceipt): void {
    const state = this.state();
    const batchIds = state.batchIdsByLocalDay[receipt.localDay] ?? [];
    const next = pruneState({
      ...state,
      receiptsByBatchId: { ...state.receiptsByBatchId, [receipt.batchId]: receipt },
      batchIdsByLocalDay: {
        ...state.batchIdsByLocalDay,
        [receipt.localDay]: [...new Set([...batchIds, receipt.batchId])],
      },
    });
    this.repos.settings.setManyWithin(tx, { [REVERIFY_RESOLUTION_STATE_KEY]: next });
  }

  private state(): ReverifyResolutionState {
    const raw = this.repos.settings.get<ReverifyResolutionState>(REVERIFY_RESOLUTION_STATE_KEY);
    if (
      !raw ||
      typeof raw !== "object" ||
      raw.version !== 1 ||
      !isRecord(raw.receiptsByBatchId) ||
      !isRecord(raw.batchIdsByLocalDay)
    ) {
      return { version: 1, receiptsByBatchId: {}, batchIdsByLocalDay: {} };
    }
    return raw;
  }
}

/** Compute current block hashes, then re-read normalized text per block from the doc. */
function blockTextMap(doc: unknown): Map<BlockId, string> {
  // `computeBlockContentHashes` walks the same block set the propagation/fingerprint
  // paths use; we re-walk for the raw text the surface shows, keyed by the same ids.
  const text = new Map<BlockId, string>();
  if (!doc || typeof doc !== "object") return text;
  const ROW_BLOCK_TYPES = new Set([
    "paragraph",
    "heading",
    "blockquote",
    "listItem",
    "codeBlock",
    "image",
    "horizontalRule",
  ]);
  const nodeText = (node: PmNode): string => {
    if (node.type === "text") return node.text ?? "";
    if (node.type === "hardBreak") return "\n";
    if (node.type === "image") {
      const alt = typeof node.attrs?.alt === "string" ? node.attrs.alt : "";
      const title = typeof node.attrs?.title === "string" ? node.attrs.title : "";
      return `${alt} ${title}`.trim();
    }
    return (node.content ?? []).map(nodeText).join(" ");
  };
  const shouldCarry = (type: string, parentType?: string): boolean => {
    if (!ROW_BLOCK_TYPES.has(type)) return false;
    if ((parentType === "listItem" || parentType === "blockquote") && type !== "listItem") {
      return false;
    }
    return true;
  };
  const visit = (node: PmNode, parentType?: string): void => {
    const type = node.type ?? "";
    if (shouldCarry(type, parentType)) {
      const blockId = node.attrs?.blockId;
      if (typeof blockId === "string" && blockId.length > 0) {
        text.set(blockId as BlockId, nodeText(node).replace(/\s+/g, " ").trim());
      }
    }
    for (const child of node.content ?? []) visit(child, type);
  };
  visit(doc as PmNode);
  return text;
}

interface PmNode {
  readonly type?: string;
  readonly text?: string;
  readonly attrs?: { readonly blockId?: unknown; readonly alt?: unknown; readonly title?: unknown };
  readonly content?: readonly PmNode[];
}

/** The block-content fingerprint component (a content hash of the current block text). */
function blockComponent(currentBlockText: ReadonlyMap<BlockId, string>, blockId: BlockId): string {
  // Reuse the same hashing the propagation path uses, over a single-block doc-shaped
  // map, so the component is a stable content hash (not the raw text).
  const text = currentBlockText.get(blockId) ?? "";
  const hashes = computeBlockContentHashes({
    type: "doc",
    content: [{ type: "paragraph", attrs: { blockId }, content: [{ type: "text", text }] }],
  });
  return hashes.get(blockId) ?? "";
}

function opKey(elementId: ElementId, blockId: BlockId, verb: ReverifyResolutionVerb): string {
  return [elementId, blockId, verb].join(FINGERPRINT_DELIMITER);
}

/**
 * The first (block-content) component of a delimited fingerprint. Comparing it across
 * the current vs. supplied fingerprint distinguishes a block re-edit (this component
 * drifted) from any other target change (a later component drifted).
 */
function firstFingerprintComponent(fingerprint: string): string {
  const index = fingerprint.indexOf(FINGERPRINT_DELIMITER);
  return index === -1 ? fingerprint : fingerprint.slice(0, index);
}

function normalizeCap(cap: number | undefined): number {
  if (cap === undefined || !Number.isFinite(cap) || cap <= 0) return REVERIFY_SESSION_CAP;
  return Math.floor(cap);
}

function pruneState(state: ReverifyResolutionState): ReverifyResolutionState {
  const days = Object.keys(state.batchIdsByLocalDay).sort();
  const keepDays = new Set(days.slice(Math.max(0, days.length - RETAIN_DAYS)));
  const batchIdsByLocalDay: Record<string, readonly string[]> = {};
  const receiptsByBatchId: Record<string, ReverifyResolutionReceipt> = {};
  for (const day of keepDays) {
    const ids = state.batchIdsByLocalDay[day] ?? [];
    batchIdsByLocalDay[day] = ids;
    for (const id of ids) {
      const receipt = state.receiptsByBatchId[id];
      if (receipt) receiptsByBatchId[id] = receipt;
    }
  }
  return { version: 1, receiptsByBatchId, batchIdsByLocalDay };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The processed states a `stale_after_edit` block can be restored to — mirrors
 * `BlockProcessingRepository`'s `RESTORABLE_PROCESSED_STATES`. A rebase reconciling the
 * block out of stale picks the state it was in before staling, recorded in metadata.
 */
const RESTORABLE_PROCESSED_STATES: ReadonlySet<SourceBlockProcessingState> = new Set([
  "extracted",
  "ignored",
  "processed_without_output",
  "needs_later",
]);

/**
 * The processed state to restore a `stale_after_edit` row to on a rebase reconcile, read
 * from the `previousState` recorded in metadata when the block was staled. Defaults to
 * `extracted` (the universal "a block with a live derived output" state) when the prior
 * state is missing/unknown, so a rebase always lands the block in a processed state.
 */
function restorableStateFromMetadata(
  metadata: Readonly<Record<string, unknown>> | null,
): SourceBlockProcessingState {
  const previousState = metadata?.previousState;
  if (
    typeof previousState === "string" &&
    RESTORABLE_PROCESSED_STATES.has(previousState as SourceBlockProcessingState)
  ) {
    return previousState as SourceBlockProcessingState;
  }
  return "extracted";
}

function localDayOf(iso: IsoTimestamp): string {
  const date = new Date(iso);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * MaintenanceService (T099) — the main-process composer behind the Maintenance view.
 *
 * It mirrors how {@link BackupService} composes {@link DbService} + the vault: the
 * read-only REPORTS that need both SQL and the filesystem (broken-source disk join, DB
 * + vault integrity) and the cleanup ACTIONS that compose the vault GC + the local-db
 * bulk wrappers all live HERE, on the trusted main side — never in React, never SQL in
 * the renderer.
 *
 * Reports (READ-ONLY — no `operation_log`):
 *  - `report()` — the hub rollup: every report's COUNT + the integrity-not-yet-run
 *    flag (the deep integrity check is on-demand only, never auto-run on view open).
 *  - `duplicates()` — the `DedupReportQuery` collection-wide cluster rollup.
 *  - `cardsWithoutSources()` — the `LineageGapQuery` sourceless-card scan.
 *  - `brokenSources()` — joins the `LineageGapQuery` SQL candidate set against
 *    `AssetVaultService.verifyIntegrity().missing` (the asset ids whose bytes are gone)
 *    to produce `{ source, reason: "missingFile" | "noSnapshot", missingAssetIds }`. The
 *    `noSnapshot` reason fires ONLY for a source that SHOULD have a snapshot
 *    (`sources.snapshot_key` recorded) — a manual source that never captured one is not
 *    "broken" (its content lives in `documents`), so it is never a false positive.
 *  - `lowValueCandidates()` — the `LineageGapQuery` low-priority-stale candidate list.
 *  - `checkIntegrity()` — `PRAGMA quick_check`/`integrity_check` + `foreign_key_check`
 *    (read-only) composed with the vault `verifyIntegrity` report.
 *
 * Actions (TRANSACTIONAL, op-logged, soft-delete / undoable — the ONLY hard deletes
 * stay `TrashRepository.purge` (elements) + `AssetVaultService.collectOrphans` (files)):
 *  - `dedupeCleanup({ removeIds })` — RE-VALIDATES each id is a non-canonical duplicate
 *    in a FRESH dedup report (never trusts a stale renderer id, never trashes a keeper)
 *    then soft-deletes the validated ids in ONE batch (`BulkActionService.bulkSoftDelete`).
 *  - `orphanMediaCleanup({ confirm, relativePaths? })` — the EXISTING
 *    `AssetVaultService.collectOrphans({ confirm: true })` (the vault-side hard delete)
 *    THEN `EmbeddingRepository.pruneOrphanVectors()` so the semantic index can't drift.
 *  - `bulkTrash` / `bulkArchive` / `bulkPostpone` — the thin `BulkActionService`
 *    wrappers, each sharing ONE `batchId` so `UndoService.undoLast` reverses the sweep.
 */

import type { ElementId } from "@interleave/core";
import type {
  BulkArchiveMode,
  ChronicPostponeApplyResult,
  ChronicPostponeDecision,
  ChronicPostponeListResult,
  DuplicateReport,
  LineageGapRow,
  LowValueRow,
  ParkedResurfacingApplyResult,
  ParkedResurfacingDecision,
  ParkedResurfacingListResult,
  SchedulerConsistencyRow,
} from "@interleave/local-db";
import { nowIso } from "@interleave/local-db";
import type { AssetVaultService, VaultIntegrityReport } from "./asset-vault-service";
import type { DbService } from "./db-service";

/** Construction deps (injected once, mirroring `BackupService`). */
export interface MaintenanceServiceDeps {
  readonly dbService: DbService;
}

/** A compact element descriptor crossing IPC (no asset ids, no raw paths). */
export interface MaintenanceRef {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly priority: number;
  readonly priorityLabel?: string;
  readonly createdAt: string;
}

/** One broken-source row: a source you can no longer open. */
export interface BrokenSourceRow {
  readonly source: MaintenanceRef;
  /** `missingFile` = a snapshot asset's bytes are gone; `noSnapshot` = no snapshot row. */
  readonly reason: "missingFile" | "noSnapshot";
  /** The asset ids whose bytes are missing (result-only; never a request input). */
  readonly missingAssetIds: readonly string[];
}

/** The DB + vault integrity report (the on-demand deep check). */
export interface IntegrityReport {
  readonly db: {
    readonly ok: boolean;
    /** The `integrity_check`/`quick_check` rows (`["ok"]` when healthy). */
    readonly integrityCheck: readonly string[];
    /** Count of `foreign_key_check` violated rows (0 with `foreign_keys = ON`). */
    readonly foreignKeyViolations: number;
    /** Which pragma ran (`quick_check` default, `integrity_check` deep option). */
    readonly mode: "quick_check" | "integrity_check";
  };
  readonly vault: {
    readonly ok: number;
    readonly mismatched: readonly string[];
    readonly missing: readonly string[];
    readonly extraFiles: readonly string[];
  };
}

/** The hub rollup: every report's COUNT + the deep-check-not-yet-run flag. */
export interface MaintenanceReport {
  readonly duplicateCount: number;
  readonly cardsWithoutSourcesCount: number;
  readonly schedulerConsistencyCount: number;
  /** Saved-for-later sources old enough to ask about again (T102). */
  readonly parkedResurfacingCount: number;
  /** Items whose effective postpone count reached the chronic reckoning threshold (T106). */
  readonly chronicPostponeCount: number;
  readonly orphanFileCount: number;
  readonly orphanBytes: number;
  readonly lowValueCount: number;
  /**
   * `null` — the DB+vault integrity deep check is on-demand (not auto-run on view
   * open, since it can take seconds on a 100k DB). The renderer shows "Run check".
   */
  readonly integrity: null;
}

/** The dedup rollup the drill-down reads (the full clusters). */
export type MaintenanceDuplicateReport = DuplicateReport;

/** The result of a bulk cleanup action. */
export interface MaintenanceBatchResult {
  readonly affected: number;
  readonly batchId: string;
}

export class MaintenanceService {
  private readonly dbService: DbService;

  constructor(deps: MaintenanceServiceDeps) {
    this.dbService = deps.dbService;
  }

  // --- reports (read-only) -------------------------------------------------

  /**
   * The hub rollup — one read returning every report's COUNT (the badges) + the
   * integrity-not-yet-run flag. The orphan file count/bytes come from the EXISTING
   * vault orphan scan; everything else from the local-db queries. Read-only.
   */
  async report(): Promise<MaintenanceReport> {
    const repos = this.dbService.repos;
    const dup = repos.dedupReport.report();
    const sourceless = repos.lineageGap.cardsWithoutSources();
    const lowValue = repos.lineageGap.lowValueCandidates();
    const schedulerConsistencyCount = repos.schedulerConsistency.count();
    const asOf = nowIso();
    const parkedResurfacingCount = repos.parkedResurfacingQuery.countDue({
      asOf,
      resurfaceAfterDays: repos.settings.getAppSettings().parkedResurfaceAfterDays,
    });
    const chronicPostponeCount = repos.chronicPostpone.countDue({
      threshold: repos.settings.getAppSettings().chronicPostponeThreshold,
    });
    const orphans = await this.dbService.findVaultOrphans();
    return {
      duplicateCount: dup.totalDuplicates,
      cardsWithoutSourcesCount: sourceless.length,
      schedulerConsistencyCount,
      parkedResurfacingCount,
      chronicPostponeCount,
      orphanFileCount: orphans.orphans.length,
      orphanBytes: orphans.totalBytes,
      lowValueCount: lowValue.length,
      integrity: null,
    };
  }

  /** The collection-wide duplicate cluster rollup (read-only). */
  duplicates(): MaintenanceDuplicateReport {
    return this.dbService.repos.dedupReport.report();
  }

  /** Live cards with no resolvable source lineage — SURFACED, never auto-deleted. */
  cardsWithoutSources(): { rows: LineageGapRow[] } {
    return { rows: this.dbService.repos.lineageGap.cardsWithoutSources() };
  }

  /** Low-priority, stale candidates for the bulk postpone / archive action. */
  lowValueCandidates(asOf?: string, limit?: number): { rows: LowValueRow[] } {
    return {
      rows: this.dbService.repos.lineageGap.lowValueCandidates({
        ...(asOf ? { asOf: asOf as never } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    };
  }

  /** Stale scheduler state that is hidden from Queue but should be inspected. */
  schedulerConsistency(limit?: number): { rows: SchedulerConsistencyRow[] } {
    return { rows: this.dbService.repos.schedulerConsistency.list(limit) };
  }

  /** Saved-for-later sources old enough to re-ask the user about (read-only). */
  parkedResurfacing(limit?: number): ParkedResurfacingListResult {
    const repos = this.dbService.repos;
    return repos.parkedResurfacingQuery.listDue({
      asOf: nowIso(),
      resurfaceAfterDays: repos.settings.getAppSettings().parkedResurfaceAfterDays,
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  /** Items whose effective postpone count reached the chronic reckoning threshold. */
  chronicPostpones(limit?: number): ChronicPostponeListResult {
    const repos = this.dbService.repos;
    return repos.chronicPostpone.listDue({
      threshold: repos.settings.getAppSettings().chronicPostponeThreshold,
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  /**
   * Broken sources — live sources you can no longer open. Joins the SQL candidate set
   * (each source's snapshot asset rows) against `verifyIntegrity().missing` (the asset
   * ids whose bytes are gone). A source whose snapshot file is missing → `missingFile`;
   * a source that SHOULD have a snapshot (`sources.snapshot_key` recorded) but has NO
   * snapshot asset row → `noSnapshot`. A hand-authored/manual source that legitimately
   * never captured a snapshot (no `snapshot_key`) is NOT flagged — its content lives in
   * `documents` and it is perfectly openable, so it is not "broken". Read-only on both sides.
   */
  async brokenSources(): Promise<{ rows: BrokenSourceRow[] }> {
    const candidates = this.dbService.repos.lineageGap.brokenSourceCandidates();
    if (candidates.length === 0) return { rows: [] };
    const vault: VaultIntegrityReport = await this.assetVault.verifyIntegrity();
    const missing = new Set<string>(vault.missing);
    const rows: BrokenSourceRow[] = [];
    for (const c of candidates) {
      if (!c.hasSnapshotRow) {
        // Only "broken" if the source's own metadata RECORDED a snapshot whose asset row
        // has since vanished — never a manual source that simply never had one.
        if (c.expectsSnapshot) {
          rows.push({ source: toRef(c.source), reason: "noSnapshot", missingAssetIds: [] });
        }
        continue;
      }
      // A source WITH snapshot rows whose bytes are gone on disk.
      const missingAssetIds = c.snapshotAssets
        .filter((a) => missing.has(a.assetId))
        .map((a) => a.assetId);
      if (missingAssetIds.length > 0) {
        rows.push({ source: toRef(c.source), reason: "missingFile", missingAssetIds });
      }
    }
    return { rows };
  }

  /**
   * The DB + vault integrity DEEP check (on-demand). `db` runs `PRAGMA quick_check`
   * (the default — fast, skips index-consistency; `integrity_check` is the deep option)
   * + `PRAGMA foreign_key_check`; `vault` is `AssetVaultService.verifyIntegrity()`.
   * READ-ONLY (these pragmas do not mutate). `db.ok` is `integrityCheck === ["ok"] &&
   * foreignKeyViolations === 0`.
   */
  async checkIntegrity(deep = false): Promise<IntegrityReport> {
    const db = this.dbService.checkDbIntegrity(deep);
    const vault = await this.assetVault.verifyIntegrity();
    return {
      db,
      vault: {
        ok: vault.ok,
        mismatched: vault.mismatched,
        missing: vault.missing,
        extraFiles: vault.extraFiles,
      },
    };
  }

  // --- actions (transactional, op-logged, soft-delete / undoable) -----------

  /**
   * Dedup cleanup — soft-delete the chosen redundant copies in ONE batch, NEVER a
   * keeper. RE-RUNS the dedup detection and validates each id is a current
   * non-canonical duplicate before deleting (a stale renderer id or a flipped keeper is
   * skipped, never trashed). No merge, no hard delete; reversible via Trash + undo.
   */
  dedupeCleanup(input: { removeIds: readonly ElementId[] }): MaintenanceBatchResult {
    const fresh = this.dbService.repos.dedupReport.report();
    // The set of ids the CURRENT report considers removable (non-canonical duplicates).
    const removable = new Set<string>();
    for (const cluster of [
      ...fresh.sourceClusters,
      ...fresh.cardClusters,
      ...fresh.extractClusters,
    ]) {
      for (const dup of cluster.duplicates) removable.add(dup.id);
    }
    const valid = input.removeIds.filter((id) => removable.has(id));
    if (valid.length === 0) {
      return { affected: 0, batchId: "" };
    }
    const res = this.dbService.repos.bulkActions.bulkSoftDelete(valid);
    return { affected: res.affected, batchId: res.batchId };
  }

  /**
   * Orphan-media cleanup — the EXISTING confirmed vault file GC
   * (`AssetVaultService.collectOrphans({ confirm: true })`) THEN
   * `EmbeddingRepository.pruneOrphanVectors()` so the semantic index can't drift. The
   * ONLY vault-side hard delete (guarded by `confirm: true`). Returns the freed counts.
   */
  async orphanMediaCleanup(input: {
    confirm: true;
    relativePaths?: readonly string[];
  }): Promise<{ removed: number; freedBytes: number; vectorsPruned: number }> {
    if (input.confirm !== true) {
      throw new Error("MaintenanceService.orphanMediaCleanup: confirm must be true");
    }
    const { removed, freedBytes } = await this.assetVault.collectOrphans({
      confirm: true,
      ...(input.relativePaths ? { relativePaths: [...input.relativePaths] } : {}),
    });
    // Backstop: drop any element_vectors rowid with no surviving embeddings sidecar.
    const vectorsPruned = this.dbService.repos.embeddings.pruneOrphanVectors();
    return { removed, freedBytes, vectorsPruned };
  }

  /** Bulk soft-delete (broken-source / sourceless-card trash) — one undoable batch. */
  bulkTrash(input: { ids: readonly ElementId[] }): MaintenanceBatchResult {
    const res = this.dbService.repos.bulkActions.bulkSoftDelete(input.ids);
    return { affected: res.affected, batchId: res.batchId };
  }

  /** Bulk archive (trash / dismiss / retire) — one undoable batch. */
  bulkArchive(input: { ids: readonly ElementId[]; mode: BulkArchiveMode }): MaintenanceBatchResult {
    const res = this.dbService.repos.bulkActions.bulkArchive(input.ids, input.mode);
    return { affected: res.affected, batchId: res.batchId };
  }

  /** Bulk postpone (low-priority recede) — one undoable batch (cards FSRS / attention split). */
  bulkPostpone(input: { ids: readonly ElementId[]; asOf?: string }): MaintenanceBatchResult {
    const res = this.dbService.repos.bulkActions.bulkPostpone(
      input.ids,
      (input.asOf ?? nowIso()) as never,
    );
    return { affected: res.elements.length, batchId: res.batchId };
  }

  /** Apply parked resurfacing decisions as one undoable `update_element` batch. */
  parkedResurfacingApply(input: {
    decisions: readonly ParkedResurfacingDecision[];
  }): ParkedResurfacingApplyResult {
    const repos = this.dbService.repos;
    return repos.parkedResurfacing.apply({
      decisions: input.decisions,
      asOf: nowIso(),
      resurfaceAfterDays: repos.settings.getAppSettings().parkedResurfaceAfterDays,
    });
  }

  /** Apply chronic-postpone reckoning decisions as one undoable batch. */
  chronicPostponesApply(input: {
    decisions: readonly ChronicPostponeDecision[];
  }): ChronicPostponeApplyResult {
    const repos = this.dbService.repos;
    return repos.chronicPostponeService.apply({
      decisions: input.decisions,
      threshold: repos.settings.getAppSettings().chronicPostponeThreshold,
    });
  }

  // --- internals -----------------------------------------------------------

  private get assetVault(): AssetVaultService {
    return this.dbService.assetVaultService;
  }
}

/** Map a local-db gap ref to the IPC-safe maintenance ref. */
function toRef(row: {
  id: string;
  type: string;
  title: string;
  priority: number;
  priorityLabel?: string;
  createdAt: string;
}): MaintenanceRef {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    priority: row.priority,
    ...(row.priorityLabel ? { priorityLabel: row.priorityLabel } : {}),
    createdAt: row.createdAt,
  };
}

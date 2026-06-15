/**
 * Asset vault metadata, operation log, settings (T006): `assets`,
 * `operation_log`, `settings`.
 *
 * `assets` stores ONLY metadata for large binaries (mirrors {@link Asset}): a
 * stable id, owning element, kind, the relative vault path + vault root, content
 * hash, MIME, size, optional media dimensions/duration, and a timestamp. The
 * bytes themselves live on the filesystem in the asset vault — storing blob
 * payloads in SQLite is forbidden. `vaultRoot` + `relativePath` together encode
 * a {@link LocalVaultPath}; Electron resolves them to an absolute path (the
 * renderer never does).
 *
 * `operation_log` exists **from day one**: every meaningful mutation appends one
 * command-shaped, append-only row (mirrors {@link OperationLogEntry}) inside the
 * same transaction as the mutation, so backup/audit/undo and the eventual cloud
 * sync stay tractable.
 *
 * `settings` is a simple key/value store for user/domain settings (daily review
 * budget, default retention, etc.); the canonical local store for these.
 */

import { ASSET_KINDS, OPERATION_TYPES, VAULT_ROOTS } from "@interleave/core";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";
import { elements } from "./elements";

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    /** The element that owns this asset (e.g. the `source` for its PDF). */
    owningElementId: text("owning_element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** Asset kind — one of the canonical `AssetKind` values. */
    kind: text("kind").notNull(),
    /** Logical vault root — one of the canonical `VaultRoot` values. */
    vaultRoot: text("vault_root").notNull(),
    /** Path relative to `vaultRoot` (POSIX `/`, no leading slash, no `..`). */
    relativePath: text("relative_path").notNull(),
    /** Content hash (e.g. sha-256 hex) for integrity checks and dedup. */
    contentHash: text("content_hash").notNull(),
    mime: text("mime").notNull(),
    /** Size in bytes. */
    size: integer("size").notNull(),
    /** Pixel width for images, else `null`. */
    width: integer("width"),
    /** Pixel height for images, else `null`. */
    height: integer("height"),
    /** Duration in milliseconds for audio/video, else `null`. */
    durationMs: integer("duration_ms"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("assets_kind_check", inList(table.kind, ASSET_KINDS)),
    check("assets_vault_root_check", inList(table.vaultRoot, VAULT_ROOTS)),
    index("assets_owning_element_idx").on(table.owningElementId),
    index("assets_content_hash_idx").on(table.contentHash),
  ],
);

export const operationLog = sqliteTable(
  "operation_log",
  {
    id: text("id").primaryKey(),
    /** Command type — one of the canonical `OperationType` values. */
    opType: text("op_type").notNull(),
    /** Command-specific data, stored as JSON; validated per `opType` upstream. */
    payload: text("payload").notNull(),
    /** The element this op concerns; `null` if it targets no single element. */
    elementId: text("element_id").references(() => elements.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull(),
    /**
     * Denormalized copy of `payload.batchId` for the ops that belong to a bulk
     * action (bulk-postpone, inbox bulk triage, auto-postpone/extract-aging
     * receipts), `null` for single-op actions. Promoted out of the JSON payload
     * into a real indexed column so batch undo (`UndoService.collectBatch`) is an
     * O(batch) indexed lookup instead of an O(total ops) full-table scan. Written
     * at append time AND backfilled from the payload for historical rows; the
     * payload still carries `batchId` as the canonical command record.
     */
    batchId: text("batch_id"),
  },
  (table) => [
    check("operation_log_op_type_check", inList(table.opType, OPERATION_TYPES)),
    index("operation_log_element_idx").on(table.elementId),
    index("operation_log_created_idx").on(table.createdAt),
    // PARTIAL index: the vast majority of op-log rows are single-op actions with a
    // NULL `batch_id`, and batch undo only ever looks up a concrete batch id. Indexing
    // only the non-NULL rows keeps the index tiny and removes index-maintenance cost
    // from the hot single-op `append` path. SQLite still uses it for `batch_id = ?`
    // (an equality literal implies `IS NOT NULL`). NOTE: Drizzle's SQLite generator can
    // drop the `.where()` predicate — the generated migration is hand-verified to emit
    // `WHERE "batch_id" IS NOT NULL` (see migration 0041 + the migration-level test).
    index("operation_log_batch_idx").on(table.batchId).where(sql`"batch_id" IS NOT NULL`),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  /** Value stored as JSON text; callers parse to the concrete setting type. */
  value: text("value").notNull(),
});

export const retirementSuggestionDismissals = sqliteTable(
  "retirement_suggestion_dismissals",
  {
    sourceElementId: text("source_element_id")
      .primaryKey()
      .references(() => elements.id, { onDelete: "cascade" }),
    signalHash: text("signal_hash").notNull(),
    dismissedAt: text("dismissed_at").notNull(),
  },
  (table) => [index("retirement_suggestion_dismissals_hash_idx").on(table.signalHash)],
);

/**
 * Re-read proposal dismissals (T129). Remembers that the user dismissed the re-read
 * proposal for a lapse cluster, keyed on the cluster's nearest live source-region
 * ancestor (`ancestorId`). The proposal stays hidden while the stored `state_hash`
 * still matches the recomputed cluster hash; it reappears only when the cluster
 * MATERIALLY worsens (a lapse band step or a new member card) — the stored counters
 * record the dismissed-at evidence so "materially worse" is a real delta, not an
 * opaque compare. Mirrors {@link retirementSuggestionDismissals} (the T103 pattern).
 */
export const rereadProposalDismissals = sqliteTable(
  "reread_proposal_dismissals",
  {
    ancestorId: text("ancestor_id")
      .primaryKey()
      .references(() => elements.id, { onDelete: "cascade" }),
    stateHash: text("state_hash").notNull(),
    totalWindowLapses: integer("total_window_lapses").notNull(),
    affectedCardCount: integer("affected_card_count").notNull(),
    dismissedAt: text("dismissed_at").notNull(),
  },
  (table) => [index("reread_proposal_dismissals_hash_idx").on(table.stateHash)],
);

export type AssetRow = typeof assets.$inferSelect;
export type NewAssetRow = typeof assets.$inferInsert;
export type OperationLogRow = typeof operationLog.$inferSelect;
export type NewOperationLogRow = typeof operationLog.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;
export type RetirementSuggestionDismissalRow = typeof retirementSuggestionDismissals.$inferSelect;
export type NewRetirementSuggestionDismissalRow =
  typeof retirementSuggestionDismissals.$inferInsert;
export type RereadProposalDismissalRow = typeof rereadProposalDismissals.$inferSelect;
export type NewRereadProposalDismissalRow = typeof rereadProposalDismissals.$inferInsert;

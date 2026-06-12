---
title: "SQLite table rebuilds with foreign_keys=ON fire ON DELETE actions into the replacement table, silently wiping copied columns"
date: "2026-06-12"
category: "database-issues"
module: "db-migrations"
problem_type: "database_issue"
component: "database"
severity: "critical"
symptoms:
  - "Inspector Lineage tree collapsed to a single self-node for every card/extract; Children showed 'No children yet'; library detail showed 'No source'."
  - "ALL elements.parent_id and elements.source_id were NULL in the live vault, while source_locations, element_relations, and operation_log rows were fully intact."
  - "operation_log contained zero update_element ops touching parentId/sourceId — the wipe happened outside the command path."
  - "Automatic backups bracketed the damage to the exact window where migrations 0030–0033 were applied; op logs on both sides were byte-identical."
  - "All tests passed: fresh databases have no rows to wipe, and the migration test asserted side-table row COUNTs, which cannot see nulled columns."
root_cause: "logic_error"
resolution_type: "migration"
related_components:
  - "tooling"
  - "testing_framework"
tags:
  - "sqlite"
  - "better-sqlite3"
  - "drizzle"
  - "migrations"
  - "foreign-keys"
  - "on-delete-set-null"
  - "table-rebuild"
  - "check-constraint"
  - "lineage"
  - "operation-log"
---

# SQLite table rebuilds with foreign_keys=ON fire ON DELETE actions into the replacement table, silently wiping copied columns

## Problem

`0030_parked_elements` had to widen the `elements.status` CHECK constraint (add `'parked'`),
which SQLite only allows via a table rebuild: `CREATE TABLE __new_elements` → `INSERT INTO …
SELECT` → `DROP TABLE elements` → `RENAME`. The app opens connections with
`PRAGMA foreign_keys = ON` before migrating, and the pragma is a no-op inside Drizzle's
migration transaction — so the rebuild ran under enforcement. `DROP TABLE elements` performs an
implicit `DELETE FROM elements`, and each deleted row fired the `ON DELETE SET NULL` actions of
`__new_elements.parent_id`/`source_id` (which `REFERENCES elements(id)` — the old table, by
name). Every freshly copied lineage link was nulled an instant after being copied. The migration
author had anticipated the cascades into the *side tables* (hence its TEMP-backup-and-restore
dance) but the replacement table itself was the one casualty the pattern cannot protect.

## Symptoms

Source lineage — the product's #1 invariant — silently vanished from a real vault: lineage trees
collapsed to one node, cards lost their source linkage, branch review and children sections went
empty. Everything else (locations, relations, review state, op log) looked pristine, which made
the damage read like a missing feature rather than corruption.

## What Didn't Work / Why It's Confusing

- The op log was innocent and complete — the wipe bypassed the command path entirely, so
  auditing mutations found nothing.
- Migrations 0031–0033 were plain `ADD COLUMN`s, and the live schema's column order proved no
  rebuild had happened *recently from the file's perspective* — the rebuild was 0030, applied
  late to this vault because the installed app predated it.
- The migration's own test seeded a lineage graph and still passed: it asserted side-table row
  COUNTs and column *presence*, never column *values* on `elements` itself.
- `PRAGMA foreign_keys=OFF` written inside the migration file does nothing: the pragma is
  silently ignored inside a transaction, and Drizzle wraps each migration in one.

## Solution

Three layers (commit references the lineage-wipe fix):

1. **Runner**: `migrateDatabase` now disables `foreign_keys` *outside* any transaction before
   `migrate()`, verifies the pragma actually changed (throws if a transaction is open), restores
   it after, and runs `PRAGMA foreign_key_check` whenever new migrations were applied — a
   violation-introducing migration now fails loudly instead of corrupting silently.
2. **Migration 0030** was rewritten to be correct under FKs OFF: each side-table restore is now
   `DELETE FROM x` + `INSERT … SELECT` so surviving rows can't collide with the restore, and the
   header documents the FKs-OFF requirement. (Already-migrated vaults never re-run it; Drizzle
   skips by journal `when`.)
3. **Repair migration 0034** backfills `elements.parent_id`/`source_id` from the append-only
   `create_element` operation-log payloads — fill only NULLs, only when the referenced element
   still exists, soft-deleted rows included. Verified against a copy of the damaged production
   vault: all 35 elements matched the pre-wipe backup exactly, `foreign_key_check` clean.

## Why This Works

With enforcement OFF, `DROP TABLE` drops the table without the implicit row-deletes' referential
actions, so the copied columns and all side-table rows survive untouched. The op log is the
source of truth for creation-time lineage, so the backfill restores exactly what was lost without
needing the user's backups. The post-migration `foreign_key_check` replaces the protection that
per-statement enforcement provided during migrations.

## Prevention

- Any migration that rebuilds a table referenced by FK actions (especially self-referencing
  parents like `elements`) MUST run with `foreign_keys = OFF` — that is now the runner's
  guarantee, not each migration's hope. This is SQLite's documented 12-step ALTER procedure.
- Migration tests for rebuilds must assert **column values survive on the rebuilt table
  itself**, not just side-table counts: seed a linked graph through the previous migration, run
  the chain to HEAD, and compare every preserved column.
- A useful audit invariant (also enforced as a test): zero rows where the `create_element`
  payload names a parent that still exists while `elements.parent_id` is NULL.
- Column order in `.schema` output is forensic gold: `ADD COLUMN` always appends, so a mid-table
  column proves a historical rebuild.
- The same `ON DELETE SET NULL` self-FK vector exists at the **user-facing delete path**, not only
  in migrations: any real `DELETE` (purge / Empty Trash) of a node that still anchors live
  descendants nulls their `parent_id`/`source_id`. T135 closes it there with a purge guard at
  *every* hard-delete seam — generalize the rule to "guard every real DELETE of a node with live
  dependents," not just migrations.

## Related

- `docs/solutions/architecture-patterns/lineage-aware-deletion-tombstone-purge-guard.md` — the
  delete-path counterpart (T135): the same FK-set-null orphan vector, closed for user-facing
  deletion via tombstone-and-keep, a purge guard at every hard-delete seam, and symmetric restore.
- `docs/solutions/database-issues/drizzle-migrator-high-water-mark-skips-out-of-order-migrations.md`
  — the other Drizzle-runner trap: journal `when` values must stay monotonic (respected by
  0034's hand-written journal entry).

---
title: "fix: Index operation_log.batch_id to bound batch-undo cost"
type: fix
date: 2026-06-15
status: ready
depth: standard
---

# fix: Index `operation_log.batch_id` to bound batch-undo cost

## Summary

`UndoService.collectBatch` (`packages/local-db/src/undo-service.ts:353-369`) issues
`SELECT * FROM operation_log` with no `WHERE` clause, loads every row synchronously on the
Electron main thread, and filters in JS for `payload.batchId === batchId`. `batchId` lives only
inside the JSON `payload` column, which is unindexed — so every batch undo is an `O(total ops)`
synchronous scan. T126 (bulk inbox triage) added a frequently-hit caller: the inbox snackbar
Undo runs `undoBatch(batchId)` → `collectBatch` after every sweep. On a long-lived vault (100k+
`operation_log` rows) this is a 100ms+ main-process stall per undo click. Flagged as PERF-01
(HIGH) and R-002 during the T126 review and deferred because the scan predates T126.

The fix promotes `batch_id` to a real nullable `TEXT` column on `operation_log` with an index,
populates it at write time in `OperationLogRepository.append` (dual-write alongside the existing
`payload.batchId`), backfills existing rows from the payload via an **additive** Drizzle
migration, and rewrites `collectBatch` to a single indexed `WHERE batch_id = ?` lookup. A
regression test seeds a large `operation_log` and asserts the lookup is index-bound, not a full
scan.

---

## Problem Frame

- **Hot path:** `collectBatch` reads the entire `operation_log` table on every batch undo. Cost
  grows linearly with vault age and is paid synchronously on the main process (better-sqlite3 is
  synchronous), so the UI stalls.
- **Why it was deferred:** the scan predates T126; expanding T126's scope to fix a pre-existing
  perf bug was out of bounds. It is now its own task.
- **Root cause:** `batchId` is buried in the JSON `payload` text column with no index. The only
  way to find a batch is to materialize and parse every row.

---

## Scope Boundaries

**In scope**
- Add `batch_id` (nullable `TEXT`) + index to the `operation_log` Drizzle table.
- Dual-write `batch_id` in `OperationLogRepository.append` from `payload.batchId`.
- Additive `ALTER TABLE ... ADD COLUMN` migration + `CREATE INDEX` + `json_extract` backfill.
- Rewrite `collectBatch` to `WHERE batch_id = ?` (preserving newest-first ordering).
- Migration test + bounded-cost regression test.

**Out of scope / deferred**
- Refactoring `collectBatch` onto `OperationLogRepository` as a named method (the learnings doc
  suggests it as a *consideration*; minimal in-place change is preferred here). Noted as a
  follow-up only if review insists.
- Removing `batchId` from the JSON payload (payload remains the canonical command record; the
  column is a denormalized index). Keeping both preserves backward compatibility and the
  `undoLast` read path.
- Backfilling/indexing any other payload key.

---

## Key Technical Decisions

### KTD-1 — Plain nullable `TEXT`, no CHECK constraint (avoids the 0030/0040 rebuild trap)
`batch_id` is a free-form id (string), so it needs no CHECK. This matters: `drizzle-kit generate`
proposes a **table rebuild** (`CREATE __new → copy → DROP → RENAME`) when a column is added *with*
a CHECK or NOT NULL constraint, and that rebuild shape is exactly what nulled all lineage in
migration 0030 (see `docs/solutions/database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md`).
A plain nullable column should generate a clean `ALTER TABLE ... ADD COLUMN`. The generated SQL
**must be verified** to be additive, not a rebuild, before commit (mirror the 0040 header note).

### KTD-2 — Dual-write at append, do not move `batchId` out of payload
`OperationLogRepository.append` currently has no `batchId` in `AppendOpInput`; callers embed it in
`payload`. Rather than thread an explicit field through every call site, `append` reads
`batchId` off `input.payload` when serializing and writes it to the new column too. This requires
**zero caller changes**, matches how `payload.batchId` is read everywhere else, and keeps the op
write inside the caller's transaction (the `operation_log`-in-same-transaction invariant in
`packages/local-db/AGENTS.md`). The backfill covers historical rows; this covers all future rows.
Without it, the index would be NULL for every post-migration op — the load-bearing half of the fix.

### KTD-3 — SQL-only `json_extract` backfill in the migration file
Backfill historical rows with pure SQLite JSON1 (idiomatic here; used by migration 0034's
lineage repair and elsewhere): `UPDATE operation_log SET batch_id = json_extract(payload,
'$.batchId') WHERE batch_id IS NULL AND json_extract(payload, '$.batchId') IS NOT NULL`. No
app code in the migration. Combine DDL + backfill in one migration file (0040's precedent).

### KTD-4 — Preserve `collectBatch` newest-first ordering
The indexed query keeps `ORDER BY created_at DESC, rowid DESC`. This ordering is load-bearing:
the batch is inverted in reverse insertion order, and the heterogeneous-batch undo
(`requireCurrentBulkTriageStateMatch`) depends on it (see
`docs/solutions/architecture-patterns/bulk-command-heterogeneous-batch-undo-guard.md`).

### KTD-5 — Monotonic journal `when`
The new migration (`0041`) must have a journal `when` strictly greater than 0040's, or the
Drizzle high-water-mark migrator silently skips it on already-migrated vaults (see
`docs/solutions/database-issues/drizzle-migrator-high-water-mark-skips-out-of-order-migrations.md`).
`db:generate` stamps current time, so this is automatic; `packages/db/src/journal-ordering.test.ts`
guards it.

---

## High-Level Technical Design

```
WRITE PATH (append)                         READ PATH (collectBatch)
─────────────────────                       ────────────────────────
caller payload {... batchId} ─┐             undoBatch(batchId) / undoLast
                              │                      │
OperationLogRepository.append │              SELECT * FROM operation_log
  • JSON.stringify(payload)   │              WHERE batch_id = ?            ◄── NEW indexed
  • extract payload.batchId ──┼──► batch_id  ORDER BY created_at DESC,         lookup (was: full
    (string|null) → column    │    column        rowid DESC                    scan + JS filter)
  • INSERT row in caller tx   │                      │
                              ▼              invert each op (reverse order)
            ┌──────────────────────────────────────────────┐
            │ operation_log                                 │
            │  id, op_type, payload(JSON), element_id,      │
            │  created_at, batch_id  ◄── NEW col + idx      │
            └──────────────────────────────────────────────┘
                              ▲
            MIGRATION 0041 (additive):
              ALTER TABLE operation_log ADD batch_id text
              CREATE INDEX operation_log_batch_idx ON operation_log(batch_id)
              UPDATE ... SET batch_id = json_extract(payload,'$.batchId')  ◄── backfill
```

Cost: read path goes from `O(total ops)` rows materialized + parsed → `O(batch size)` rows via
the index. Backfill is a one-time `O(total ops)` UPDATE at migrate time (acceptable; runs once).

---

## Implementation Units

### U1. Add `batch_id` column + index to the `operation_log` schema

**Goal:** Declare the new column and index in the Drizzle schema so generated migrations and
snapshots are consistent.

**Files:**
- `packages/db/src/schema/system.ts` (modify the `operationLog` table, lines ~62-79)

**Approach:**
- Add `batchId: text("batch_id")` (nullable — no `.notNull()`) to the column object.
- Add `index("operation_log_batch_idx").on(table.batchId)` to the table's index array, alongside
  the existing `operation_log_element_idx` / `operation_log_created_idx`.
- Do **not** add a CHECK constraint (KTD-1).
- Confirm `OperationLogRow` / `NewOperationLogRow` inferred types pick up the new optional field.

**Patterns to follow:** the existing two `index(...)` declarations on the same table; nullable
columns elsewhere in `system.ts`.

**Dependencies:** none.

**Test scenarios:** covered by U3's migration test (schema shape is exercised through the real
migration). `Test expectation: none directly — schema declaration, verified via U3.`

**Verification:** `pnpm typecheck` clean; `pnpm db:generate` produces a migration referencing
`batch_id` and `operation_log_batch_idx`.

---

### U2. Dual-write `batch_id` in `OperationLogRepository.append`

**Goal:** Populate the new column for every op written after the migration, derived from
`payload.batchId`, with no caller changes.

**Files:**
- `packages/local-db/src/operation-log-repository.ts` (modify `append`, lines ~296-318; possibly
  `RawOpRow` if it is used for reads that now surface `batchId`)
- `packages/local-db/src/operation-log-repository.test.ts` (add coverage)

**Approach:**
- In `append`, after `const payload = JSON.stringify(input.payload ?? null)`, extract the batch id
  safely: read `input.payload`, and if it is a non-null object with a string `batchId`, use it;
  otherwise `null`. (Mirror the existing `typeof ... === "string" ? ... : null` guard used in
  `undo-service.ts:157`.)
- Add `batchId` to the `.values({...})` insert so the column is written in the same statement /
  same transaction (`tx`). Do not change the transaction contract.
- Keep returning the existing `OperationLogEntry` shape (payload still carries `batchId`).

**Patterns to follow:** the existing `append` insert; the safe-string-guard idiom; the
`packages/local-db/AGENTS.md` rule that the op row is appended in the caller's transaction.

**Dependencies:** U1.

**Test scenarios:**
- Happy path: appending an op whose `payload` contains `batchId: "b1"` writes `batch_id = "b1"`
  to the column (assert by reading the raw row, e.g. via `OperationLogRepository` read helper or
  raw sqlite `SELECT batch_id`).
- Edge: appending an op with no `batchId` in payload (single-op action) writes `batch_id = NULL`.
- Edge: `payload` is `null`/non-object → `batch_id = NULL`, no throw.
- Edge: `payload.batchId` is present but not a string (defensive) → `batch_id = NULL`.
- Integration: the op row is written inside the same transaction as its mutation (existing
  append tests already assert transactional behavior — ensure they still pass).

**Verification:** new unit tests pass; existing `operation-log-repository.test.ts` green.

---

### U3. Additive migration 0041: ADD COLUMN + CREATE INDEX + backfill

**Goal:** Add the column and index to existing vaults additively and backfill `batch_id` from
historical payloads, without a table rebuild.

**Files:**
- `packages/db/drizzle/0041_<generated_name>.sql` (new)
- `packages/db/drizzle/meta/0041_snapshot.json` (new, generated)
- `packages/db/drizzle/meta/_journal.json` (modified, generated)
- `packages/db/src/migration-0041-batch-id-index.test.ts` (new)

**Approach:**
1. Run `pnpm db:generate` after U1. Inspect the generated `0041_*.sql`.
2. **If it emitted a rebuild** (`CREATE __new_operation_log` / `DROP TABLE operation_log` /
   `RENAME`), hand-edit it down to the additive form:
   ```sql
   ALTER TABLE `operation_log` ADD `batch_id` text;--> statement-breakpoint
   CREATE INDEX `operation_log_batch_idx` ON `operation_log` (`batch_id`);
   ```
   (It should already be additive given the plain nullable column, but verify — KTD-1.)
3. Append the backfill statement (KTD-3):
   ```sql
   --> statement-breakpoint
   UPDATE `operation_log` SET `batch_id` = json_extract(`payload`, '$.batchId')
     WHERE `batch_id` IS NULL AND json_extract(`payload`, '$.batchId') IS NOT NULL;
   ```
4. Add a header comment (mirror the 0040 header) explaining the additive intent and instructing
   future maintainers to hand-edit back to additive form if `db:generate` ever proposes an
   `operation_log` rebuild.
5. Re-run `pnpm db:generate` and confirm it reports **no schema changes** (snapshot drift-free).

**Patterns to follow:**
- `packages/db/drizzle/0040_strange_zarek.sql` — additive ADD COLUMN + backfill in one file, with
  the cautionary header.
- `packages/db/drizzle/0034_repair_lineage_links.sql` — `json_extract(payload, ...)` backfill from
  `operation_log`.
- Migration test templates: `packages/db/src/migration-0040-captured-via.test.ts` and
  `packages/db/src/migration-0034-repair-lineage-links.test.ts` (stage migrations through N, seed
  pre-migration rows via raw sqlite, run to HEAD, assert).

**Execution note:** Generate the migration via the tool, then hand-verify it is additive — do not
hand-author the snapshot/journal; let `db:generate` own those.

**Dependencies:** U1.

**Test scenarios (migration test):**
- Seed `operation_log` BEFORE 0041 with rows whose `payload` contains `batchId` (a batch of
  several rows sharing one id) and rows with no `batchId`; run migration to HEAD.
- Assert the `batch_id` column exists and the `operation_log_batch_idx` index exists
  (`PRAGMA index_list` / `PRAGMA table_info`).
- Assert backfill: rows with `payload.batchId` now have the matching `batch_id`; rows without it
  stay `NULL`.
- Assert pre-existing rows are otherwise untouched (id, op_type, payload, element_id, created_at
  preserved) — no rebuild data loss.
- Assert FK integrity / no lineage damage (run reaches HEAD with the runner's `foreign_key_check`
  passing — this is implicit in `createInMemoryDb` / `migrateDatabase`).
- Covers the additive-migration safety property documented for 0030/0040.

**Verification:** migration test green; `pnpm db:generate` reports no diff; `journal-ordering.test.ts`
green (monotonic `when`).

---

### U4. Rewrite `collectBatch` to an indexed `WHERE batch_id = ?` lookup

**Goal:** Replace the full-table scan + JS filter with a single indexed query.

**Files:**
- `packages/local-db/src/undo-service.ts` (modify `collectBatch`, lines ~353-369)

**Approach:**
- Change the query to `.where(eq(operationLog.batchId, batchId))` while keeping
  `.orderBy(desc(operationLog.createdAt), desc(sql\`rowid\`))` (KTD-4).
- Drop the JS-side `if (op.payload.batchId === batchId)` filter (the `WHERE` now does it); still
  `parse` each returned row into `ParsedOp`.
- Ensure `eq` and `operationLog` are imported (likely already imported in the file).
- `undoLast` (line ~157-158) still reads `batchId` from the most-recent op's `payload` then calls
  `collectBatch` — unchanged and consistent, since `append` dual-writes and the backfill covers
  history.

**Patterns to follow:** the existing scoped query idiom in `OperationLogRepository`
(`listForElement`, `countPostpones`); the existing `collectBatch` ordering.

**Dependencies:** U1, U2, U3 (the column must exist and be populated for the query to be correct).

**Test scenarios (in `packages/local-db/src/undo-service.test.ts`):**
- Happy path: a bulk batch (e.g. `QueueActionService.bulkPostpone([a,b,c])` → `{ batchId }`),
  then `undoLast()` / `undoBatch(batchId)` restores all 3 (the existing batch test at
  `undo-service.test.ts:294-320` must stay green).
- Correctness: `collectBatch` returns exactly the ops sharing `batchId`, newest-first, and none
  from other batches.
- Edge: `undoBatch` for a `batchId` with no rows returns an empty batch / no-op (no throw).
- Heterogeneous batch (T126): undo of an inbox bulk sweep mixing `reschedule_element`,
  `update_element`, and `soft_delete_element` still restores each verb's pre-image and still
  refuses a moved victim (`requireCurrentBulkTriageStateMatch`). Covers
  `bulk-command-heterogeneous-batch-undo-guard.md`.

**Verification:** `undo-service.test.ts`, `inbox-bulk-triage-service.test.ts`,
`standing-auto-postpone-service.test.ts`, `extract-aging-policy-service.test.ts` all green.

---

### U5. Bounded-cost regression test (large operation_log → index-bound lookup)

**Goal:** Lock in the fix: prove `collectBatch` is `O(batch)` via the index, not `O(total)`, so a
future regression that drops the index or reverts to a scan fails CI.

**Files:**
- `packages/local-db/src/undo-service.test.ts` (add a regression test), and/or
- `packages/local-db/bench/scale-budget.test.ts` (add a `gauge(...)` budget entry)

**Approach (primary, deterministic):**
- Seed a large `operation_log` (e.g. thousands of single ops via real services, plus one small
  batch sharing a `batchId`).
- Assert the access path is the index, not a scan: run `EXPLAIN QUERY PLAN` for the exact
  `collectBatch` query (`SELECT ... FROM operation_log WHERE batch_id = ? ORDER BY created_at
  DESC, rowid DESC`) via raw sqlite and assert the plan contains `USING INDEX
  operation_log_batch_idx` (i.e. `SEARCH`), not `SCAN operation_log`. This is deterministic and
  non-flaky — the strongest proof that cost is bounded by batch size.
- Assert `collectBatch(batchId)` returns exactly the seeded batch even though the log is large.

**Approach (secondary, optional cost ceiling):** mirror `bench/scale-budget.test.ts` using
`measure(...)` from `bench/bench-harness.ts` to assert `undoBatch`/`collectBatch` p95 stays under
a generous budget (e.g. well under the 100ms+ regression) with a large seeded log. Use the bench
gate config (`vitest.bench-gate.config.ts`) so it does not flake the default `pnpm test`.

**Patterns to follow:** `packages/local-db/bench/scale-budget.test.ts` (`gauge`/`measure`,
`buildBenchWorld`), the `asPrivate(...)` cast in `undo-service.test.ts:52-72` to reach
`collectBatch` directly.

**Execution note:** Prefer the deterministic `EXPLAIN QUERY PLAN` assertion as the must-have
guard; treat the timing budget as a complementary smoke check, not the primary gate, to avoid CI
flake.

**Dependencies:** U1-U4.

**Test scenarios:**
- Large log (N ≫ batch size): query plan uses `operation_log_batch_idx`; `collectBatch` returns
  only the batch.
- Negative guard (documents intent): if feasible, a comment/assert that a plan over the
  un-indexed column would be `SCAN` (the regression we are preventing).

**Verification:** new test green; intentionally dropping the index locally makes it fail (manual
sanity check, not committed).

---

## Test Strategy / Definition of Done

Per root `CLAUDE.md` Definition of Done and `packages/db/AGENTS.md`:

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test` (unit/migration/repository/undo)
4. E2E — run and confirm green (behavior unchanged):
   - `tests/electron/trash-undo.spec.ts` (global undo)
   - `tests/electron/auto-postpone.spec.ts` (standing-auto-postpone undo)
   - `tests/electron/inbox-bulk-triage.spec.ts` (T126 batch snackbar undo → the new hot path)
5. Persistence proofs: migration is additive (no table rebuild, no lineage loss), runs once,
   backfill correct, FK check passes, `operation_log` append stays transactional, `db:generate`
   reports no drift, journal `when` monotonic.

---

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| `db:generate` emits a table rebuild for `operation_log` | KTD-1 (no CHECK) makes a clean ALTER likely; U3 step 2 mandates hand-verifying + hand-editing to additive form (0040 precedent). |
| Backfill mis-parses payloads / corrupts column | SQL `json_extract` only; `WHERE ... IS NOT NULL` guards; migration test asserts backfill values + untouched rows. |
| Post-migration ops land with NULL `batch_id` (index useless) | KTD-2 dual-write in `append`; U2 tests assert the column is written for batched ops. |
| Ordering regression breaks reverse-replay undo | KTD-4 preserves `ORDER BY created_at DESC, rowid DESC`; U4 heterogeneous-batch test asserts per-verb restore. |
| Migration silently skipped on existing vaults | KTD-5 monotonic `when`; `journal-ordering.test.ts` guard. |
| Timing-based perf test flakes CI | U5 uses deterministic `EXPLAIN QUERY PLAN` as the primary guard; timing budget is secondary and lives in the bench gate. |

---

## References / Research

- `packages/db/src/schema/system.ts:62-79` — `operationLog` table.
- `packages/local-db/src/operation-log-repository.ts:296-318` — `append`.
- `packages/local-db/src/undo-service.ts:353-369` — `collectBatch`; `:126-194` `undoLast`;
  `:201-292` `undoBatch`.
- `packages/db/drizzle/0040_strange_zarek.sql` — additive ADD COLUMN + backfill exemplar (+ header).
- `packages/db/drizzle/0034_repair_lineage_links.sql` — `json_extract(payload, ...)` backfill.
- `packages/db/src/migrator.ts:75-108` — runner (FK off during migrate, `foreign_key_check` after).
- `packages/db/src/migration-0040-captured-via.test.ts`, `migration-0034-repair-lineage-links.test.ts`
  — migration test templates.
- `packages/local-db/bench/scale-budget.test.ts`, `bench/bench-harness.ts:152-163` — bounded-cost
  pattern (`measure`/`gauge`).
- `docs/solutions/database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md`
  — 0030 rebuild incident (the anti-pattern).
- `docs/solutions/database-issues/drizzle-migrator-high-water-mark-skips-out-of-order-migrations.md`
  — journal `when` monotonicity.
- `docs/solutions/architecture-patterns/bulk-command-heterogeneous-batch-undo-guard.md` — T126
  batch undo correctness constraints.
- Callers of `undoBatch`: `inbox-bulk-triage-service.ts:185-187`,
  `standing-auto-postpone-service.ts:158-185`, `extract-aging-policy-service.ts:237-260`.

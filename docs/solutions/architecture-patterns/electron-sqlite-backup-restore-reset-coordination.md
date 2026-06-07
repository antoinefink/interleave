---
title: "Restore and reset Electron SQLite backups with coordinated main-process shutdown"
date: "2026-06-07"
category: "docs/solutions/architecture-patterns/"
module: "desktop-backup-restore"
problem_type: "architecture_pattern"
component: "database"
severity: "high"
related_components:
  - "service_object"
  - "background_job"
  - "testing_framework"
  - "frontend_stimulus"
applies_when:
  - "A local-first Electron app needs to restore or reset a live SQLite database from a backup."
  - "Database replacement must coordinate with open connections, IPC handlers, and background jobs."
  - "A renderer settings page exposes destructive data operations through typed main-process contracts."
tags:
  - "backup-restore"
  - "reset"
  - "electron-main"
  - "sqlite"
  - "ipc"
  - "job-draining"
  - "data-durability"
  - "local-first"
---

# Restore and reset Electron SQLite backups with coordinated main-process shutdown

## Context

Interleave already created restore-ready local backups, but the restore path had to replace a live local store: the canonical SQLite database, WAL/SHM sidecars, and the filesystem asset vault. Settings also needed a destructive fresh-start reset that discards the current knowledge store while preserving backups, exports, and model caches.

This is not a normal domain mutation. A restore or reset changes the substrate underneath every repository, IPC handler, background job, and renderer view.

## Guidance

Treat backup restore and fresh-start reset as a whole-store replacement workflow owned by Electron main.

Verify and stage before touching current data. For restore, validate the app-managed backup timestamp, manifest format, asset root, file list, file sizes, SHA-256 hashes, unexpected files, SQLite integrity, foreign keys, and that the backup database schema matches the manifest schema. For reset, build an empty migrated database and vault skeleton in a stage directory first.

Acquire a local-data replacement lock before any awaited cleanup. Once the lock is active, ordinary DB access should fail immediately so concurrent IPC writes cannot commit to a store that is about to disappear. Then drain local writers such as the job runner and capture controller.

Replace through rollback, not direct deletion. Close the DB, move the current database, WAL/SHM files, and asset vault into a rollback directory, install the staged store, ensure the vault skeleton, and reopen through the normal DB service path. If install or reopen fails, restore the rollback store and reopen it before releasing the lock.

Keep the process restart-required after success. Even if the DB can reopen for rollback validation, the running Electron process has stopped lifecycle services and renderer state still represents the old store. A successful restore/reset should block further ordinary DB work until Interleave restarts.

Keep renderer contracts narrow. The renderer should restore by known backup timestamp and exact confirmation phrase, never by arbitrary filesystem path. Results should return display-safe metadata plus a restart/reload requirement.

## Why This Matters

SQLite, WAL sidecars, filesystem assets, and background writers can otherwise produce mixed old/new state. A direct delete-and-copy reset can also lose the user's only current store if reopen fails after deletion.

The lock-and-rollback pattern makes each phase explicit:

- preflight failures leave the current store untouched,
- install failures restore the previous store,
- unrecoverable rollback failures preserve the rollback directory and keep DB access blocked,
- successful replacements intentionally force a restart boundary.

That restart boundary is a data-integrity decision. It is safer than letting stale renderer state or stopped main-process services continue issuing ordinary mutations after the canonical local store has been replaced.

## When to Apply

- Backup restore replaces SQLite and the asset vault from a local artifact.
- Fresh-start reset discards the current knowledge store and creates an empty one.
- A future import-overwrite, vault migration rollback, or factory reset swaps local DB and filesystem state together.
- The operation crosses trusted Electron main capabilities and must not expose raw SQL or arbitrary filesystem access to the renderer.

Do not use this pattern for normal domain mutations. Those belong in repository/service transactions with operation-log entries.

## Examples

The restore service stages first, then locks and drains writers before installing:

```ts
const verified = this.verifyBackup(timestamp);
const stageDir = fs.mkdtempSync(path.join(this.deps.paths.dataDir, ".restore-stage-"));

copyBackupToStage(verified.backupDir, verified.manifest, stageDir);
this.deps.dbService.beginLocalDataReplacement();
await this.deps.beforeReplaceLocalData?.();
this.installStageWithRollback(stageDir);
this.deps.dbService.completeLocalDataReplacement();
```

The IPC handler wires the writer drain into the destructive operation:

```ts
const restoreService = new BackupRestoreService({
  dbService,
  paths: context.paths,
  migrationsDir: context.migrationsDir,
  nativeBinding: context.nativeBinding,
  beforeReplaceLocalData: async () => {
    await context.runner?.stopAndDrain();
    await context.captureController?.stop();
  },
});
```

The DB service exposes the lifecycle boundary as a lock rather than as implicit state:

```ts
beginLocalDataReplacement(): void {
  if (this.localDataReplacementMessage) {
    throw new Error(this.localDataReplacementMessage);
  }
  this.localDataReplacementMessage =
    "Local data replacement is in progress; restart Interleave before continuing.";
}
```

Settings mirrors the main-process safety model: exact phrases gate restore and reset, all backup controls are disabled while a destructive operation is in flight, and the success state tells the user to restart Interleave before continuing.

## Related

- [Run automatic rolling backups in Electron main, not the renderer](./electron-main-rolling-backups-over-renderer-reminders.md)
- [Battle-testing matrix and test-hardening execution for core app surfaces](./test-audit-driven-battle-testing.md)
- [Test operation-log and IPC invariants for extract-to-card mutation paths](./extract-card-ipc-invariant-test-hardening.md)
- [Backup restore service](../../../apps/desktop/src/main/backup-restore-service.ts)
- [Backup restore service tests](../../../apps/desktop/src/main/backup-restore-service.test.ts)
- [Settings backup controls](../../../apps/web/src/pages/Settings.tsx)
- [Backup E2E coverage](../../../tests/electron/backup.spec.ts)

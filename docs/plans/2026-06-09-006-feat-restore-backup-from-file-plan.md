---
title: "Restore A Backup From A File On Disk"
type: "feat"
status: "active"
date: "2026-06-09"
---

# Restore A Backup From A File On Disk

## Summary

The app can already list app-managed backups and restore one by timestamp from the unzipped
`backups/<timestamp>/` directory (see `docs/plans/2026-06-07-backup-restore-and-reset.md`,
`status: completed`). That covers the "select among the automated backups" half of this request.
The missing half is restoring a backup the app does not manage — a portable `.zip` the user picked
on disk (moved from another machine, recovered from external storage, or an old archive the
retention policy already pruned from the live list).

This plan adds a **restore-from-file** path: a native open-file picker (main-owned) chooses a
backup `.zip`, the main process extracts it into a staging directory, runs the **same** manifest /
hash / schema / SQLite-integrity verification the timestamp restore already uses, and converges on
the **same** atomic install-with-rollback. It deliberately reuses the proven pipeline in
`apps/desktop/src/main/backup-restore-service.ts` rather than forking it.

---

## Problem Frame

Restore today is keyed on an app-managed `timestamp` that resolves to `backupsDir/<timestamp>/`.
The request schema (`BackupTimestampSchema`) intentionally rejects anything path-like, so there is
no way to restore an archive the app is not already tracking. Users who keep backups off-device, or
who want to recover a backup older than the retention window keeps, have no path back in.

The constraint being relaxed — "restore by known timestamp, never an arbitrary path" (see
`docs/solutions/architecture-patterns/electron-sqlite-backup-restore-reset-coordination.md`) — is
relaxed **safely**, mirroring how local file imports already work: the path comes from a
**main-owned** `dialog.showOpenDialog`, and the new `restoreFile` command is a *narrow* capability
that can only attempt a backup-restore of the chosen `.zip` (extract → verify → install). It never
becomes a generic file-read primitive, and the renderer never gains arbitrary filesystem access.

This is a high-risk data-lifecycle surface (it replaces the canonical SQLite DB + asset vault) and
it now ingests an **untrusted** archive, so extraction must guard against zip-slip and every
preflight failure must leave the current store untouched.

---

## Requirements

- R1. Settings offers a "Restore from a file" action that opens a native picker filtered to `.zip`
  and, after the user types the existing restore confirmation phrase, restores the chosen archive.
- R2. The chosen archive is extracted in the main process and verified with the **same** checks as
  the timestamp restore: manifest shape, format version, asset root, file list (no extra/missing
  files), per-file size + SHA-256, SQLite `integrity_check` + `foreign_key_check`, and
  schema-not-newer-than-installed.
- R3. A verified archive replaces `app.sqlite` (+ clears WAL/SHM) and `assets/` through the existing
  `installStageWithRollback`, reopens + migrates the DB forward, and reports `restartRequired: true`.
- R4. Any failure — cancelled picker, non-`.zip`, corrupt/tampered archive, newer schema, zip-slip
  entry, extraction error — surfaces as a non-destructive error; the current DB + assets are
  unchanged and backups are preserved.
- R5. Restore-from-file uses confirmation-guarded typed IPC. The picker and restore are separate
  narrow commands in the `backups` namespace; no raw SQL, generic file read, or arbitrary
  filesystem access is exposed to the renderer.
- R6. The "select among the automated backups" path keeps working unchanged; both restore paths
  share one verification + install code path so they cannot drift.
- R7. Tests cover the extraction helper (incl. zip-slip + corrupt input), the service restore-from-
  file path (success + rollback-on-failure), IPC/contract/preload/appApi drift, the Settings UX,
  and an Electron restart-survival E2E.

---

## Key Technical Decisions

- KTD1. **Reuse `fflate` for unzip, do not add `yauzl`.** The repo already unzips with
  `fflate.unzipSync` (`packages/importers/src/epub.ts`, `anki.ts`) — pure-JS, no native build, so it
  bundles cleanly into the main process exactly like `yazl` does for writing. Add `fflate` as a
  **direct** dependency of `apps/desktop/package.json` (mirroring how `yazl` is declared directly)
  rather than leaning on a transitive resolution through `@interleave/importers`.
- KTD2. **Converge on the existing pipeline by splitting verify to accept a directory.** Refactor
  `verifyBackup(timestamp)` into `resolveBackupDir(...)` + `verifyBackupDir(backupDir)` so both the
  timestamp restore and the new file restore feed the **same** `verifyBackupDir` →
  `copyBackupToStage` → `beginLocalDataReplacement` → `beforeReplaceLocalData` →
  `installStageWithRollback` → `completeLocalDataReplacement` flow. The app-produced `.zip` already
  stores `manifest.json` / `app.sqlite` / `assets/...` at the archive root (see
  `zipDirectory` in `backup-service.ts`), so an extracted archive is byte-shaped exactly like a
  `backups/<timestamp>/` directory and verifies with no special-casing.
- KTD3. **Extract under `dataDir`, never `os.tmpdir()`.** Staging dirs are created with
  `fs.mkdtempSync(path.join(paths.dataDir, ".restore-...")` so the subsequent install is a
  same-filesystem `rename`. The extraction temp dir follows the same rule (`.restore-extract-`).
- KTD4. **Zip-slip is a first-class threat for untrusted archives.** The extraction helper validates
  every entry name (reject absolute paths, `..`, backslashes, empty segments) before writing, using
  the same discipline as the existing `safeJoin`. Verification then re-checks that the extracted
  directory contents match the manifest **exactly**, so a tampered archive fails before any install
  code runs.
- KTD5. **Two narrow `backups` commands, not a bundled one or a generic opener.** `backups.pickArchive`
  returns only the chosen path (or `cancelled`); `backups.restoreFile` takes `{ path, confirm, phrase }`.
  This keeps the picker → confirm → restore UX transparent (the user sees the chosen filename before
  confirming) and keeps each capability reviewable, per
  `docs/solutions/architecture-patterns/pathless-backups-open-folder-ipc.md`. Reuse the existing
  `RESTORE_BACKUP_CONFIRMATION_PHRASE` (`"RESTORE BACKUP"`) — no new phrase.
- KTD6. **E2E determinism via an env override.** Mirror the import pickers' `INTERLEAVE_<KIND>_IMPORT_PATH`
  convention with `INTERLEAVE_BACKUP_RESTORE_PATH`, honored only when `!app.isPackaged`, so Playwright
  can drive restore-from-file without a real native dialog.

---

## High-Level Technical Design

```mermaid
flowchart TB
  subgraph Renderer["Settings — Data & backup"]
    Choose["Choose backup file…"] --> Confirm["type RESTORE BACKUP"] --> RestoreBtn["Restore from file"]
  end
  Choose -->|backups.pickArchive| PickIpc
  RestoreBtn -->|backups.restoreFile {path,confirm,phrase}| RestoreIpc
  subgraph Main["Electron main"]
    PickIpc["dialog.showOpenDialog (zip)"] -->|path| Renderer
    RestoreIpc["zod parse + context guard"] --> Extract["extractBackupArchive (fflate, zip-slip guarded)"]
    Extract --> Verify["verifyBackupDir: manifest + sizes + sha256 + sqlite integrity + schema-not-newer"]
    Verify --> Stage["copyBackupToStage"]
    Stage --> Install["installStageWithRollback (close → move-to-rollback incl WAL/SHM → install → reopen)"]
    Install --> Result["{ restored, schemaVersion, counts, restartRequired }"]
  end
  Verify -->|any failure| Untouched["current DB + assets unchanged; backups preserved"]
```

The verify → stage → install half is the **existing** code path; only `extractBackupArchive` and the
directory-accepting `verifyBackupDir` split are new on the service side.

---

## Implementation Units

### U1. Backup Archive Extraction Helper

- **Goal:** A pure, unit-testable main-process helper that extracts a backup `.zip` into a target
  directory, rejecting unsafe entries (zip-slip) and malformed archives before writing anything that
  could escape the destination.
- **Requirements:** R2, R4 (extraction-side), R7.
- **Dependencies:** none.
- **Files:** create `apps/desktop/src/main/backup-archive.ts`,
  `apps/desktop/src/main/backup-archive.test.ts`; modify `apps/desktop/package.json` (add `fflate`).
- **Approach:** `extractBackupArchive(zipPath, destDir)` reads the file, `fflate.unzipSync` into an
  entry map, validates each entry path with a `safeJoin`-equivalent guard (reject absolute, `..`,
  `\`, empty segments), `mkdir`s parent dirs, and writes bytes. Directory entries (trailing `/`) are
  skipped. Mirror the path-safety logic already in `backup-restore-service.ts` `safeJoin` so the two
  stay consistent (extract a shared guard if it reads cleanly; otherwise duplicate with a comment).
  Keep the helper framework-free (no DB, no Electron) like `backup-manifest.ts`.
- **Patterns to follow:** `unzipSync` usage in `packages/importers/src/epub.ts`/`anki.ts`;
  `safeJoin` + `listBackupEntriesRelative` in `apps/desktop/src/main/backup-restore-service.ts`;
  pure-helper style of `apps/desktop/src/main/backup-manifest.ts`.
- **Test scenarios:**
  - Extracts a well-formed archive (manifest.json + app.sqlite + assets/...) to disk byte-for-byte;
    the extracted tree matches the input entries.
  - Rejects an entry with an absolute path.
  - Rejects an entry containing `..` (zip-slip) without writing outside `destDir`.
  - Rejects an entry with a backslash or empty segment.
  - Throws a clear error on a non-zip / truncated buffer (fflate parse failure is surfaced, not
    swallowed).
  - Skips directory entries and still writes the contained files.
- **Verification:** Unit tests prove no write lands outside `destDir` and malformed input fails fast.

### U2. Directory-Based Verify + Restore-From-Archive Service Method

- **Goal:** Split verification so it can run against an explicit directory, then add
  `restoreBackupFromArchive(zipPath)` that extracts, verifies, stages, and installs via the existing
  rollback machinery.
- **Requirements:** R2, R3, R4, R6, R7.
- **Dependencies:** U1.
- **Files:** modify `apps/desktop/src/main/backup-restore-service.ts`,
  `apps/desktop/src/main/backup-restore-service.test.ts`.
- **Approach:** Extract `verifyBackupDir(backupDir): { backupDir, manifest }` (manifest read →
  `validateManifestForRestore` → `verifyManifestFiles` → `verifySqliteFile`). `verifyBackup(timestamp)`
  becomes `resolveBackupDir(...)` + `verifyBackupDir(...)` (behavior unchanged). Add
  `restoreBackupFromArchive(zipPath: string)` that runs inside `BackupService.runSerialized`:
  `extractDir = mkdtemp(dataDir/.restore-extract-)` → `extractBackupArchive(zipPath, extractDir)` →
  `verifyBackupDir(extractDir)` → `stageDir = mkdtemp(...)` → `copyBackupToStage(extractDir, manifest,
  stageDir)` → `beginLocalDataReplacement` → `beforeReplaceLocalData?.()` →
  `installStageWithRollback(stageDir)` → `completeLocalDataReplacement`, with the same
  `LocalDataReplacementUnrecoverableError` handling as `restoreBackup`, and `finally` cleanup of BOTH
  `extractDir` and `stageDir`. Return a `RestoreBackupResult`-shaped object; reuse the existing
  interface (the `timestamp` field can carry the manifest's `createdAt`-derived label, or add an
  optional `source: "file"` discriminant — keep the renderer-safe shape minimal and documented).
- **Patterns to follow:** the existing `restoreBackup` / `resetLocalData` methods in the same file
  (serialize → stage → begin → before → install-with-rollback → complete → cleanup).
- **Test scenarios:**
  - Restore-from-archive of a freshly written backup zip swaps DB + assets and clears WAL/SHM; the
    reopened DB has the backup's row counts and the vault files exist.
  - A corrupt/tampered archive (hash mismatch, or extra/missing file vs manifest) fails verification
    and leaves the current DB + assets unchanged.
  - A newer-than-installed schema archive is rejected before install.
  - A zip-slip archive is rejected before install (extraction guard, surfaced as a restore failure).
  - Both temp dirs (`.restore-extract-`, `.restore-stage-`) are removed on both success and failure.
  - `verifyBackup(timestamp)` still behaves exactly as before (regression guard for the split).
- **Verification:** Service tests open the restored DB and assert counts + vault files; failure tests
  assert the pre-restore DB is intact.

### U3. Typed IPC: Archive Picker + File Restore

- **Goal:** Expose `backups.pickArchive` and `backups.restoreFile` end-to-end through the typed
  bridge, validated main-side, returning only renderer-safe shapes.
- **Requirements:** R1, R5, R7.
- **Dependencies:** U2.
- **Files:** modify `apps/desktop/src/shared/channels.ts`,
  `apps/desktop/src/shared/channels.test.ts`, `apps/desktop/src/shared/contract.ts`,
  `apps/desktop/src/shared/contract.test.ts`, `apps/desktop/src/preload/index.ts`,
  `apps/desktop/src/preload/index.test.ts`, `apps/desktop/src/main/ipc.ts`,
  `apps/desktop/src/main/ipc.test.ts`, `apps/web/src/lib/appApi.ts`,
  `apps/web/src/lib/appApi.test.ts`.
- **Approach:**
  - Channels: add `backupsPickArchive: "backups:pickArchive"` and
    `backupsRestoreFile: "backups:restoreFile"`. Add both to the exact-set array in
    `contract.test.ts` (the `Object.values(IPC_CHANNELS).sort()` assertion) and keep
    `channels.test.ts` uniqueness green.
  - Contract: `BackupsPickArchiveResult = { path: string } | { cancelled: true }`;
    `BackupsRestoreFileRequestSchema = z.object({ path: z.string().min(1), confirm: z.literal(true),
    phrase: z.literal(RESTORE_BACKUP_CONFIRMATION_PHRASE) }).strict()`; reuse the `RestoreBackupResult`
    type for the response. Add the two methods to the `AppApi.backups` interface block.
  - Preload: thin `ipcRenderer.invoke` wrappers (`pickArchive`, `restoreFile`) on the `backups` object.
  - Main IPC: register both handlers next to the existing backup handlers. `pickArchive` opens a
    main-owned `dialog.showOpenDialog` (single file, filter `{ name: "Backup", extensions: ["zip"] }`)
    scoped to the sender window, honoring `INTERLEAVE_BACKUP_RESTORE_PATH` only when `!app.isPackaged`,
    returning `{ path }` or `{ cancelled: true }`. `restoreFile` parses the request, requires
    `context`, constructs `BackupRestoreService` exactly like the existing restore handler (incl.
    `beforeReplaceLocalData` stopping `runner`/`captureController`), and calls
    `restoreBackupFromArchive(request.path)`.
  - appApi: mirror the request/result types and add `pickBackupArchive()` + `restoreBackupFromFile(...)`
    wrappers delegating to `requireAppApi().backups.*`.
- **Patterns to follow:** the existing `backups.restore` thread end-to-end; `pickImportFilePaths` +
  the `sources:pickImportFile` two-step in `ipc.ts`/contract; the `.strict()` + `z.literal(true)` +
  phrase-literal pattern in `BackupsRestoreRequestSchema`.
- **Test scenarios:**
  - Contract: `BackupsRestoreFileRequestSchema` rejects missing/empty `path`, `confirm !== true`, and
    a wrong `phrase`; accepts a valid payload. `BackupsPickArchiveResult` round-trips both variants.
  - Channels: the two new entries are unique and present in the exact-set assertion.
  - Preload: `pickArchive` / `restoreFile` route to their fixed channels with the given payload.
  - IPC: `restoreFile` rejects a malformed payload before constructing the service; rejects when no
    filesystem `context` is wired; `pickArchive` returns the env-override path in an unpackaged build
    and `{ cancelled: true }` when the dialog is canceled (mock `dialog.showOpenDialog`).
  - appApi: wrappers forward to the bridge; no `db:query` or raw-fs surface is introduced.
- **Verification:** All drift tests pass; the renderer can only reach the two narrow commands.

### U4. Settings "Restore From A File" UI

- **Goal:** Add a restore-from-file control to the existing "Data & backup" panel that picks an
  archive, shows the chosen filename, gates restore behind the typed phrase, and shares the panel's
  in-flight / restart-required locking.
- **Requirements:** R1, R4 (UX error surface), R7.
- **Dependencies:** U3.
- **Files:** modify `apps/web/src/pages/Settings.tsx`, `apps/web/src/pages/Settings.test.tsx`.
- **Approach:** Add a `SettingRow` ("Restore from a file") below the existing "Restore selected
  backup" row: a "Choose backup file…" button calls `appApi.pickBackupArchive()` and stores the
  returned path + a display basename in local state (ignore `cancelled`). When a path is chosen, show
  the basename and a typed-phrase confirm input (reuse `RESTORE_BACKUP_CONFIRMATION_PHRASE`) plus a
  "Restore from file" button. Reuse the existing `replacementInFlight` ref,
  `backupControlsLocked`/`dataReplacementBusy` gating, and on success set `dataRestartRequired(true)`
  with the same "Restart Interleave before continuing" message. Surface errors in a
  `SettingRow` like the existing restore error. New `data-testid`s:
  `settings-restore-file-choose`, `settings-restore-file-path`, `settings-restore-file-confirm`,
  `settings-restore-file`, `settings-restore-file-error`, `settings-restore-file-success`.
- **Patterns to follow:** `restoreSelectedBackup` state/guards in `Settings.tsx`; the
  pick-then-act two-step in `apps/web/src/pages/inbox/ImportFileModal.tsx`; the confirmation-input
  gating already used for restore/reset.
- **Test scenarios:**
  - "Choose backup file…" calls `pickBackupArchive`; a returned path shows the basename and reveals
    the confirm input; a `cancelled` result leaves the UI unchanged.
  - "Restore from file" is disabled until the exact phrase is typed and a path is chosen; enabled
    after both; clicking calls `restoreBackupFromFile({ path, confirm: true, phrase })`.
  - On success the panel locks and shows the restart-required note; on error the error row renders and
    the panel does not enter restart-required state.
  - All backup controls (incl. the new ones) are disabled while a replacement is in flight or after
    restart-required.
- **Verification:** Component tests cover success + failure + cancel with a mocked `appApi`; no
  SQLite/filesystem access from the renderer.

### U5. Restart-Survival E2E For File Restore

- **Goal:** Prove the file-restore path survives an app restart end-to-end against the real Electron
  app, using the env-override picker.
- **Requirements:** R3, R7.
- **Dependencies:** U4.
- **Files:** add/extend an Electron Playwright spec under `tests/` (mirror the existing backup
  restore/reset E2E if one exists; otherwise add `tests/backup-restore-file.e2e.ts`).
- **Approach:** Create a backup (or use a fixture zip) so a known archive exists on disk; set
  `INTERLEAVE_BACKUP_RESTORE_PATH` to that zip; drive the Settings restore-from-file flow (choose →
  type phrase → restore); assert the restart-required state; relaunch the app against the same data
  dir and assert the restored content (counts/vault) is present.
- **Patterns to follow:** existing Electron E2E setup in `tests/`; the import E2Es that use
  `INTERLEAVE_<KIND>_IMPORT_PATH`; any existing backup restore/reset E2E.
- **Test scenarios:**
  - File restore replaces data and the result reports restart-required.
  - After relaunch, the restored DB content persists (data survives restart).
  - A verification failure (corrupt fixture) shows the non-destructive error and leaves data intact.
- **Verification:** `pnpm e2e` (or the targeted Electron spec) passes; data survives restart.

---

## Scope Boundaries

- This adds restore from an arbitrary backup `.zip` on disk. It does not change how backups are
  *created* or the manifest format.
- The "select among the automated backups" path is already shipped and stays as-is; this plan only
  shares its verification + install code path. (If light polish to the existing list is warranted
  during implementation — e.g. clearer Automatic/Manual grouping — keep it minimal and in `Settings.tsx`.)
- Reset / "Fresh start" is unchanged.
- This is local restore only; it is not the future encrypted off-device backup server.
- No new schema migration is expected.

### Deferred to Follow-Up Work

- Drag-and-drop of a backup file onto the window.
- Restoring from a non-app archive shape (only the app's own `.zip` layout is supported; others fail
  verification cleanly).
- A solution note capturing the relaxed "restore by path" boundary + the zip-slip threat model
  (candidate for `/ce-compound` after landing).

---

## Risks & Mitigations

- **Untrusted archive → zip-slip / path traversal.** Mitigation: validate every entry name before
  writing (U1), then re-verify extracted contents match the manifest exactly (U2); both run before
  any install code.
- **Relaxing "restore by timestamp only".** Mitigation: the path originates from a main-owned dialog,
  `restoreFile` is a narrow capability (extract+verify+install only), and main re-validates the
  request; it is not a generic file-read surface.
- **Partial/failed install corrupting the live store.** Mitigation: reuse `installStageWithRollback`
  unchanged — close DB, move current store (incl. WAL/SHM) to a rollback dir, install, reopen, and
  roll back on any failure.
- **`fflate` bundling into main.** Mitigation: pure-JS, already proven in `@interleave/importers`;
  declared as a direct `apps/desktop` dependency to match `yazl`.
- **Verify refactor regressing the timestamp restore.** Mitigation: keep `verifyBackup(timestamp)`
  behavior identical via the `resolveBackupDir` + `verifyBackupDir` split and add a regression test.

---

## Sources / Research

- `apps/desktop/src/main/backup-restore-service.ts` — the verify + install-with-rollback pipeline to
  reuse; `safeJoin`, `verifyManifestFiles`, `verifySqliteFile`, `copyBackupToStage`.
- `apps/desktop/src/main/backup-service.ts` — backup archive layout (`zipDirectory`: root-level
  `manifest.json` / `app.sqlite` / `assets/...`), `yazl` bundling rationale.
- `apps/desktop/src/main/backup-manifest.ts` — manifest model + schema-version comparison.
- `apps/desktop/src/main/ipc.ts` — `pickImportFilePaths` native-dialog pattern + env override; the
  `backups.restore` handler + `beforeReplaceLocalData` wiring + `IpcHandlerContext`.
- `apps/desktop/src/shared/contract.ts` / `channels.ts` / `contract.test.ts` — the typed-bridge seams
  and the exact-set channel drift test.
- `apps/web/src/pages/Settings.tsx` + `apps/web/src/pages/inbox/ImportFileModal.tsx` — the
  restore confirmation UX and the pick-then-act two-step.
- `packages/importers/src/epub.ts` / `anki.ts` — `fflate.unzipSync` precedent.
- `docs/solutions/architecture-patterns/electron-sqlite-backup-restore-reset-coordination.md` — the
  whole-store-replacement contract and the "restore by timestamp, not path" rule this plan relaxes.
- `docs/solutions/architecture-patterns/pathless-backups-open-folder-ipc.md` — product-specific,
  reviewable IPC over generic openers.
- `docs/plans/2026-06-07-backup-restore-and-reset.md` — the completed restore/reset feature this
  extends.

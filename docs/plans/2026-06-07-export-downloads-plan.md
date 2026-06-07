---
title: Export artifacts to Downloads
status: completed
date: 2026-06-07
origin: user request
execution: code
---

# Export Artifacts To Downloads

## Problem Frame

Markdown, Anki package, and Anki CSV exports currently write into the app-data
`exports/` vault. That is technically controlled by Electron, but it is not useful
as a user-facing export/download destination. The task is to make these artifacts
land in the OS-standard Downloads location while preserving the renderer boundary:
React still invokes typed IPC and never chooses or writes arbitrary filesystem
paths.

Backups are out of scope. Backup archives remain in the app-managed `backups/`
area because they are recovery artifacts with retention/restore behavior.

Current export IPC results expose `absPath`. This task should close that leak:
main-process services may keep absolute paths internally for tests and follow-on
main-side operations, but the renderer-facing contract should return display-safe
metadata only.

## Requirements Trace

- User request: exports should not export to an app folder; they should export to
  the Downloads folder or the standard place for these files.
- User request: this also applies when downloading a CSV or Anki package.
- Project invariant: Electron main owns trusted filesystem paths; renderer uses a
  narrow typed API and receives only result metadata.

## Existing Patterns

- `apps/desktop/src/main/paths.ts` resolves app data/vault paths via Electron.
- `apps/desktop/src/main/index.ts` injects resolved paths into `DbService.open`.
- `apps/desktop/src/main/document-import-service.ts` has
  `DocumentImportService.exportToMarkdown`.
- `apps/desktop/src/main/anki-export-service.ts` has
  `AnkiExportService.exportApkg` and `exportCsv`.
- `apps/web/src/components/inspector/Inspector.tsx` surfaces the returned
  `relativePath` text in the inspector.

## Scope Boundaries

- Do not add a save dialog or renderer-selected destination.
- Do not expose raw paths, file handles, or generic filesystem access to the
  renderer.
- Do not change backup behavior.
- Do not create a database migration or operation-log entry; exports are read-only
  artifact writes.

## Implementation Units

### U1: Add A Downloads Export Destination

Files:
- Modify: `apps/desktop/src/main/paths.ts`
- Modify: `apps/desktop/src/main/paths.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/index.test.ts`
- Modify: `tests/electron/launch.ts`

Approach:
- Add `resolveDownloadsDir(): string`, implemented as Electron
  `app.getPath("downloads")`, with an unpackaged-only
  `INTERLEAVE_DOWNLOADS_DIR` override for E2E isolation.
- Add `downloadsDir` to `AppPaths`.
- Keep `computeAppPaths(dataDir)` as the pure app-data/vault derivation by
  accepting an optional second parameter: `computeAppPaths(dataDir,
  downloadsDir = resolveDownloadsDir())`.
- Keep `exportsDir` under the app data directory for vault skeleton compatibility.
- Pass the Downloads path, not the app-data `exportsDir`, as the destination for
  user-facing Markdown/Anki/CSV export services.

Test Scenarios:
- `computeAppPaths` exposes both app-data `exportsDir` and OS Downloads path.
- `ensureVaultSkeleton` still creates the app-data vault directories.
- Main startup passes the Downloads export destination into `DbService.open`.
- Electron E2E launches isolate Downloads under the temp test data directory.

Verification:
- `pnpm test -- apps/desktop/src/main/paths.test.ts apps/desktop/src/main/index.test.ts`

### U2: Route Markdown And Anki/CSV Exports To Downloads

Files:
- Modify: `apps/desktop/src/shared/contract.ts`
- Modify: `apps/desktop/src/shared/contract.test.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/ipc.test.ts`
- Modify: `apps/desktop/src/main/document-import-service.ts`
- Modify: `apps/desktop/src/main/document-import-service.test.ts`
- Modify: `apps/desktop/src/main/anki-export-service.ts`
- Modify: `apps/desktop/src/main/anki-export-service.test.ts`
- Modify: `apps/desktop/src/main/anki-import-service.test.ts`
- Modify: `apps/desktop/src/main/backup-restore-service.test.ts`
- Modify: `apps/desktop/src/main/db-service.ts`
- Modify: `apps/web/src/lib/appApi.ts`

Approach:
- Rename comments/constructor docs from managed `exports/` vault language to the
  injected export destination where appropriate.
- Rename the `DbService.open` export path option and service dependencies to
  `exportDestinationDir` so app-data `exportsDir` keeps one meaning.
- Keep absolute paths service-internal. `DocumentImportService.exportToMarkdown`
  and `AnkiExportService` may still return `absPath` to `DbService` and main-side
  tests.
- Change renderer-facing `DbService.exportMarkdown` / `exportAnki` and the shared
  IPC result types to return only `relativePath` (filename), `directoryLabel:
  "Downloads"`, and `cardCount` for Anki.
- Ensure all three artifact writers create the injected destination and write
  directly under it.

Test Scenarios:
- Markdown export writes into the injected Downloads directory, not app-data
  `exports/`, and remains read-only on the DB.
- Anki `.apkg` export writes into the injected Downloads directory.
- Anki CSV export writes into the injected Downloads directory and preserves rows,
  tags, and source references.
- Round-trip `.apkg` export/import still works from the produced file path.
- IPC/app API result fixtures no longer contain absolute filesystem paths.
- Public `DbService` export methods strip absolute paths before IPC.

Verification:
- `pnpm test -- apps/desktop/src/main/document-import-service.test.ts apps/desktop/src/main/anki-export-service.test.ts apps/desktop/src/shared/contract.test.ts`

### U3: Update User-Facing Copy

Files:
- Modify: `apps/web/src/components/inspector/Inspector.tsx`
- Modify: `apps/web/src/components/inspector/Inspector.test.tsx`
- Modify: `apps/web/src/help/help-bodies.ts`
- Modify: `tests/electron/markdown-import.spec.ts`
- Modify: `tests/electron/anki.spec.ts`

Approach:
- Change inspector success text from `exports/{filename}` to Downloads-oriented
  copy.
- Update help text that tells users exports land in app-data `exports/`.
- Preserve the existing button labels and typed API calls.

Test Scenarios:
- Inspector Markdown export success displays Downloads copy.
- Inspector Anki export success displays Downloads copy and card count.
- Existing inspector export button behavior remains unchanged.
- E2E Markdown, APKG, and CSV exports assert Downloads output and no public
  `absPath`.

Verification:
- `pnpm test -- apps/web/src/components/inspector/Inspector.test.tsx`

## Full Verification

- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- `pnpm e2e tests/electron/anki.spec.ts --workers=1`
- `pnpm e2e tests/electron/markdown-import.spec.ts --workers=1`

## Result

Completed. Markdown exports, Anki packages, and Anki CSV files now write to the
trusted export destination resolved by Electron main. In production that
destination is the OS Downloads folder; E2E uses `INTERLEAVE_DOWNLOADS_DIR` to
redirect Downloads into the test data directory. Renderer-facing export results
return display-safe metadata only and no longer expose absolute filesystem paths.

---
title: "Open managed backup folders with pathless IPC"
date: "2026-06-07"
last_updated: "2026-06-07"
category: "docs/solutions/architecture-patterns/"
module: "desktop-filesystem-actions"
problem_type: "architecture_pattern"
component: "service_object"
severity: "medium"
related_components:
  - "electron-main-ipc"
  - "preload-bridge"
  - "settings-ui"
  - "desktop-backups"
  - "desktop-exports"
applies_when:
  - "A renderer needs to trigger a managed filesystem action without choosing a path."
  - "An Electron feature should open a known app-data folder while preserving main-process filesystem authority."
  - "A Settings affordance exposes local durability artifacts such as backup ZIPs."
  - "A main-process service writes a user-facing export artifact and the renderer only needs display-safe metadata."
  - "A generic file-opening IPC would widen the renderer filesystem surface unnecessarily."
tags:
  - "electron-main"
  - "ipc"
  - "backup-folder"
  - "downloads"
  - "exports"
  - "filesystem-boundary"
  - "settings"
  - "local-first"
  - "renderer-boundary"
  - "pathless-command"
---

# Open managed backup folders with pathless IPC

## Context

Interleave needed a Settings action that opens the local `backups/` folder so users can copy backup ZIPs off-device. The tempting shortcut is a generic renderer command such as `openPath(path)`, but that would let untrusted UI code choose filesystem targets.

The durable pattern is a product-specific, payload-free IPC command. The renderer asks for the known workflow, and Electron main resolves the trusted path.

The same boundary applies to user-facing export artifacts. Markdown, CSV, and Anki package exports should land somewhere standard, such as the OS Downloads folder, but the renderer still should not choose that destination or receive the absolute filesystem path.

## Guidance

When adding a UI action that opens an app-managed local folder, define a narrow IPC capability for that exact action. Keep the request void unless the user workflow truly needs a constrained identifier, and resolve every absolute path in Electron main.

For the backups folder action, the shared contract is pathless:

```ts
export const BackupsOpenFolderRequestSchema = z.void();
```

The main handler validates that void request, uses `context.paths.backupsDir`, and calls Electron's shell API:

```ts
BackupsOpenFolderRequestSchema.parse(rawRequest);
const openError = await shell.openPath(context.paths.backupsDir);
```

The renderer wrapper stays payload-free:

```ts
openBackupsFolder(): Promise<BackupsOpenFolderResult> {
  return requireAppApi().backups.openFolder();
}
```

Do not add a generic filesystem opener. If another managed folder needs the same affordance, add another product-specific command such as `exports.openFolder()` so each capability remains reviewable.

When the workflow writes an artifact instead of opening a folder, keep the same main-owned path rule but return display-safe metadata rather than an absolute path. The main process resolves the destination once from trusted app paths:

```ts
dbService.open(dbPath, migrationsDir, {
  assetsDir: paths.assetsDir,
  exportDestinationDir: paths.downloadsDir,
});
```

The export service can keep an internal absolute path for file I/O:

```ts
const absPath = path.join(this.exportDestinationDir, relativePath);
await writeFile(absPath, markdown, "utf8");
```

The public IPC result strips that path before crossing into the renderer:

```ts
return {
  relativePath: result.relativePath,
  directoryLabel: "Downloads",
};
```

Use a test-only override, such as `INTERLEAVE_DOWNLOADS_DIR`, when E2E needs deterministic filesystem assertions without writing to the user's real Downloads folder.

## Why This Matters

This preserves Interleave's Electron security boundary. The renderer gets a useful desktop affordance without raw filesystem access, arbitrary path input, or a reusable escape hatch.

It also keeps tests crisp. The IPC tests can assert that `{ path: "/tmp" }` is rejected before `shell.openPath` is called, while the Settings tests can focus on user behavior: click opens the folder command, duplicate clicks are disabled while Finder is opening, and folder-open errors do not block backup creation.

For export writes, the same pattern keeps user-visible files discoverable while preserving filesystem privacy. Tests should assert both sides: the file exists in the controlled destination, and the bridge result contains only `relativePath` plus a stable directory label, never `absPath`.

## When to Apply

- A renderer action needs to open backups, exports, logs, diagnostics, or another known app-managed folder.
- A renderer action needs to report a written Markdown, CSV, Anki package, or similar user-facing export artifact.
- The path is already part of trusted app configuration such as `AppPaths`.
- A generic `openPath(path)` would be convenient but too broad.
- The action belongs in Settings or help copy because users need to find local artifacts.
- E2E needs a deterministic substitute for an OS-standard destination such as Downloads.

## Examples

The backup-folder action follows the full typed bridge path:

- `apps/desktop/src/shared/channels.ts` adds `backups:openFolder`.
- `apps/desktop/src/shared/contract.ts` adds a void request schema and result type.
- `apps/desktop/src/preload/index.ts` exposes `backups.openFolder()`.
- `apps/desktop/src/main/ipc.ts` opens `context.paths.backupsDir`.
- `apps/web/src/lib/appApi.ts` exposes `appApi.openBackupsFolder()`.
- `apps/web/src/pages/Settings.tsx` renders the secondary "Open backups folder" action.

The focused tests cover every seam:

- contract schema accepts no payload,
- preload invokes the fixed channel,
- main uses the managed backups directory and rejects injected payloads,
- renderer wrapper forwards without arguments,
- Settings button handles success, pending, and error states.

The export-artifact variant uses the same ownership split:

- `apps/desktop/src/main/paths.ts` resolves `downloadsDir` with a dev/test override.
- `apps/desktop/src/main/index.ts` passes `paths.downloadsDir` as `exportDestinationDir`.
- `DocumentImportService` and `AnkiExportService` write files to that destination.
- `DbService` maps internal `{ relativePath, absPath }` service results to display-safe contract results.
- Renderer help and inspector copy display `Downloads/<filename>`.
- Electron E2E asserts the Markdown, CSV, and `.apkg` files exist in the controlled Downloads directory and that IPC results do not expose `absPath`.

## Related

- [Run automatic rolling backups in Electron main, not the renderer](./electron-main-rolling-backups-over-renderer-reminders.md)
- [Use protocol URLs for imported article images instead of raw paths](./url-import-article-images-asset-vault-protocol.md)
- [Test operation-log and IPC invariants for extract->card mutation paths](./extract-card-ipc-invariant-test-hardening.md)
- [Test-audit driven battle testing](./test-audit-driven-battle-testing.md)
- [URL-imported articles inbox processing](../ui-bugs/url-imported-articles-inbox-processing.md)
- [Open backups folder plan](../../plans/2026-06-07-open-backups-folder.md)
- [Safety, analytics, and backup tasks](../../tasks/M9-safety-analytics-backup.md)
- [Desktop architecture](../../architecture.md)

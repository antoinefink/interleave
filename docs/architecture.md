# Architecture

This describes the chosen stack, *why* each piece was chosen, the monorepo layout, and the
runtime/tooling workflow. Treat it as the default; a task may override a choice only if it
says so explicitly.

> **Architecture pivot.** Interleave is a long-lived **personal knowledge database** — closer
> to Anki/Zotero/Obsidian than a web app — holding years of sources, extracts, cards,
> review-logs, PDFs, snapshots, media, and lineage. Durability and recoverability beat
> browser-only convenience. The canonical app is therefore an **Electron desktop app** with a
> **native SQLite database** and a **filesystem asset vault** — not a PGlite/browser-first
> PWA. SQLite is boring, proven, inspectable, backup-friendly, and fits this
> relational/scheduling-heavy domain; large assets live on the filesystem, not in the DB.

## Guiding principles

- **Local-first, single-user-first.** The app must be genuinely usable with no server.
  Instant interaction, offline access, keyboard workflows, long-lived personal data. A
  server exists *later* **only as an end-to-end-encrypted backup target** — it stores opaque
  archives and never mirrors the domain model, syncs live, or processes content. Import, OCR,
  embeddings, and search run **on-device**; AI assistance can run on-device or through the
  user's explicitly configured own-key provider.
- **Boring, explicit, type-safe over clever.** Favor small composable domain functions
  with tests over large UI-coupled handlers.
- **Domain logic out of React.** See the layering rule below and in `CLAUDE.md`.
- **One universal object model: `Element`.** See [`domain-model.md`](./domain-model.md).
- **Source lineage is sacred.** A card must always trace back to its extract → source
  location → source metadata → original document context.

## Stack & rationale

### Frontend
- **React 19 + TypeScript + Vite RENDERER** — best ecosystem, editor integrations, testing,
  and agent-coding support. The React app is **UI only**: it is the Electron **renderer** and
  never touches SQLite or the filesystem directly. The **Electron desktop shell** owns all
  trusted local capabilities (main process, preload, lifecycle, windows, native menus, IPC,
  filesystem paths, backups). The renderer reaches them through a narrow typed bridge
  (`window.appApi.*`) exposed by the **preload** script. In dev, Electron loads the Vite dev
  server; in production it loads the built renderer files.
- **TanStack Router** — type-safe routing and typed search params; this app has many deep
  states (queue filters, source views, review modes, search).
- **Tiptap / ProseMirror** for rich documents — chosen over Lexical because incremental
  reading needs source ranges, structured document transforms, custom marks (highlight /
  extracted-span / processed-span / cloze), stable serialization, and a mature document
  model. Documents are the **substrate for extraction lineage**, not just display.
- **Tailwind CSS v4 + Radix/shadcn-style primitives** — modern-browser baseline; dense,
  calm, keyboard-first workspace aesthetic.
- **Zustand or Jotai** for small client UI state only (never domain logic).

### Local data
- **Native SQLite via `better-sqlite3` + Drizzle ORM (SQLite dialect)** — SQLite is the
  canonical local database. It is boring, proven, inspectable, backup-friendly, and fits a
  relational, scheduling-heavy, audit-heavy, long-lived domain. The database is opened on the
  Electron **main/DB-service side** (main process or a worker); the renderer never opens it.
  Drizzle keeps schema/query thinking shared with the eventual Postgres server.
- **Filesystem asset vault** — PDFs, HTML snapshots, images, audio/video, exports, and backups
  live on the filesystem (the canonical local **asset vault**), never as blobs in SQLite.
  SQLite stores only asset metadata: stable IDs, relative paths, content hashes, MIME types,
  sizes, timestamps, and owning element IDs.
- All data access goes through **repository interfaces** (in `packages/local-db`) behind the
  Electron/IPC boundary, so the implementation can be synced to a server later.

> **Core principle.** SQLite is the canonical local database. The filesystem is the canonical
> local asset vault. The React app is the UI. Electron owns trusted local capabilities. The
> **renderer never talks directly to SQLite or arbitrary filesystem APIs.**

### Backend (later — encrypted backup only)
The server is **only an end-to-end-encrypted backup target** — not a sync peer and not a
processing tier. It stores opaque archives + minimal metadata and never sees plaintext content,
mirrors the domain model, or replays the op-log.
- **Node.js + TypeScript + Hono** — a SMALL typed surface: auth + upload/list/download encrypted
  backup archives. No domain RPC, no `db.query`, no server-side domain logic.
- **PostgreSQL** — minimal: `users`, `devices`, `backup_manifests` (metadata only). It does
  **not** mirror `elements`/`cards`/`documents`/etc. No `pgvector` — semantic search is local.
- **Drizzle ORM** — same schema language as local.
- **S3-compatible object storage** — holds the **encrypted archive bytes** (the only object
  storage in the system; the app itself uses the local filesystem vault).
- **On-device background runner** — import fetch, snapshots, OCR, embeddings, AI, and cleanup run
  in a **local** Electron utility process / `worker_threads` queue, **not** a server worker.
  `pg-boss` is not used.

### Scheduling
- **FSRS (`ts-fsrs`)** wrapped behind our own interface for active-recall **cards** only.
- **Custom priority/topic scheduler** for **sources/topics/extracts** — a different mental
  model (see [`scheduling-and-priority.md`](./scheduling-and-priority.md)).

### Later platforms
- **Manifest V3 browser extension** for capture (service worker + Side Panel API) — sends
  captures to the Electron app over a local `127.0.0.1` **loopback** server (token-protected,
  off until paired); it never writes the database directly and makes no cloud call.
- **PDF.js** for PDF rendering/extraction; **Mozilla Readability** for article extraction.
- **Tauri 2** is **deprioritized** to a possible future alternative shell only. We build
  **Electron**, not both. A PWA/browser version is likewise deprioritized (possible later via
  a separate adapter); the canonical app is the desktop app.

### Testing
- **Vitest** for unit/domain tests; **Playwright** for E2E flows; **Storybook** for complex
  UI states; **MSW** for mocked API/import flows.

## Monorepo layout

A **pnpm workspace**, orchestrated with **Turborepo** (task running only — not architectural
complexity).

```txt
apps/
  desktop/     Electron shell: main process, preload bridge, lifecycle, windows, native menus,
               IPC, app-data paths, backups + the local background runner (trusted capabilities)
  web/         React + Vite app — the pure UI RENDERER; calls window.appApi in desktop mode
  api/         Hono encrypted-backup API (later-only): auth + upload/list/download archives
  extension/   Manifest V3 browser extension for capture via local loopback (later)
  # No apps/worker: on-device jobs (import/OCR/embeddings/AI) run in desktop's local runner

packages/
  core/        domain types: Element model, scheduler interfaces, enums
  db/          Drizzle schema, migrations, generated types (SQLite dialect now)
  local-db/    SQLite adapter (better-sqlite3): repositories + transactional domain
               operations + operation-log append, behind the Electron/IPC boundary
  scheduler/   FSRS wrapper + topic/extract scheduler
  editor/      Tiptap extensions, cloze marks, extraction commands
  importers/   Readability, PDF, EPUB, video, RSS, email import logic
  ui/          shared components
  testing/     factories, fixtures, mock sources
```

## Layering (enforced)

```txt
React UI (renderer)
  → typed client API wrapper
  → Electron preload bridge (window.appApi)
  → Electron main / DB service
  → local-db repositories/services (packages/local-db)
  → SQLite + filesystem asset vault
```

React components may orchestrate UI state — selection, dialogs, optimistic state — but must
**not** contain SQL, scheduling rules, document-transformation algorithms, card-quality
heuristics, extraction-lineage logic, review-state transitions, or backup logic. Persistence
and domain operations live in repository/service modules: `ElementRepository`,
`DocumentRepository`, `SourceRepository`, `ReviewRepository`, `QueueRepository`,
`SearchRepository`, `AssetRepository`, `SettingsRepository`, `OperationLogRepository`,
`SchedulerService`, `ExtractionService`, `CardService`, `QueueService`. The renderer reaches
them **only** through typed `window.appApi` commands — never directly.

## Electron runtime & security

The Electron shell is the trust boundary. Locked-down by default:

- `contextIsolation: true`, `nodeIntegration: false`, `enableRemoteModule: false`, and
  `sandbox: true` where practical. The renderer has **no** raw Node, filesystem, or SQLite
  access.
- The **preload** exposes a single narrow, typed surface, `window.appApi.*`, with **validated
  IPC payloads** (Zod or equivalent on the main side). Example commands: `app.health()`,
  `db.getStatus()`, `settings.get/update()`, `elements.create/update()`,
  `sources.importManual()`, `extractions.create()`, `cards.review()`, `queue.next()`,
  `search.query()`, `backups.create()`.
- **Never** expose a generic `db.query(sql)` (or arbitrary file read/write) to the renderer.
- In dev, Electron loads the Vite dev server; in production it loads the built renderer files.

## SQLite rules

- `better-sqlite3` + Drizzle (SQLite dialect). On open, set `PRAGMA foreign_keys = ON`,
  `journal_mode = WAL`, and `busy_timeout = 5000`.
- Multi-table domain operations run inside **transactions**; foreign keys are enforced.
- **FTS5** powers local full-text search (added with search later).
- The database lives under the OS app-data directory, e.g.
  `~/Library/Application Support/<app>/app.sqlite` (plus `-wal`/`-shm` siblings), alongside
  `assets/` and `backups/`.
- **No large blobs in SQLite.** PDFs, images, audio, and video go to the asset vault; SQLite
  keeps metadata, hashes, relative paths, source-refs, and lifecycle.
- IDs are stable UUID/ULID-style values generated in domain services.

## Asset vault (Electron-managed)

The asset vault is owned by Electron (never the renderer). Layout under the app-data
directory:

```txt
assets/
  sources/<source_id>/   original.html, cleaned.html, original.pdf, snapshot.json
  media/<asset_id>/      original.bin, thumbnail.webp, ocr.json
exports/
backups/<timestamp>/     app.sqlite, assets-manifest.json
```

SQLite stores stable asset IDs, relative paths, content hashes, MIME types, sizes,
timestamps, and owning element IDs. Arbitrary file read/write is **never** exposed to the
renderer; the renderer requests assets through typed `window.appApi` commands.

## Operation log (from day one)

An `operation_log` table exists from the first schema. Every meaningful mutation is
representable as a command/op and is appended to the log: `create_element`, `update_element`,
`soft_delete_element`, `restore_element`, `create_source`, `update_document`,
`set_read_point`, `create_extract`, `create_card`, `add_review_log`, `reschedule_element`,
`add_relation`, `remove_relation`, `add_tag`, `remove_tag`. This makes the app testable now
and supports undo, audit, and **incremental backup** (ship only the ops/assets changed since the
last backup) — it is **not** replayed into a server domain DB; the server is an encrypted-backup
target only, with no live sync. Do **not** overbuild backup now — just make mutations
command-like and logged. Never silently destroy user data — prefer soft delete (`deleted_at`),
trash, and undo.

## Runtime & tooling

**Native `pnpm` is the canonical way to run, develop, and test the desktop app.** Because the
app uses a native module (`better-sqlite3`) and an Electron shell, the desktop dev loop runs
on the host, not in a container. The Definition of Done uses:

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Start the full Electron desktop app with the Vite dev server (hot reload) — drives `apps/desktop/scripts/dev.mjs` (Vite + main/preload bundle + Electron). Canonical dev loop; `window.appApi`/live data exist only inside Electron. |
| `pnpm dev:renderer` | Start the **bare** Vite renderer only (no Electron, no `window.appApi`) — isolated UI work that needs no live data |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm test` | Vitest unit/domain tests |
| `pnpm e2e` | Playwright (drives the Electron app where feasible) |
| `pnpm lint` | Biome format/lint check |
| `pnpm db:generate` | Generate Drizzle (SQLite dialect) migrations |
| `pnpm db:migrate` | Run Drizzle migrations against the local SQLite DB |
| `pnpm db:reset:dev` | Reset the dev SQLite DB |
| `pnpm seed` | Load demo fixtures into the dev SQLite DB |

> **Docker is no longer canonical for the desktop app.** The existing
> Docker/`docker-compose.yml`/`Makefile` setup is **kept but re-scoped to the future
> encrypted-backup server only** — a thin `api` (Hono backup API), a minimal `db` (Postgres for
> accounts + backup manifests, **no** `pgvector`), and `minio` (S3-compatible blob store for
> encrypted archives). There is **no** server `worker` and no sync tier — on-device background
> work runs in a local runner. It does not run the Electron desktop app, and the MVP no longer
> ships any browser/PGlite database service. Compose grows only when the backup-server work
> begins.

## What we are explicitly NOT building yet

Per MVP boundaries: no backup server, browser extension, PDF/EPUB import, AI features, semantic
search, video/audio, image occlusion, complex encryption, or collaboration until the core
loop is solid. These are scheduled in the gold-standard milestones (M11–M20).

Also explicitly **not** part of the canonical app:

- **PGlite / browser-WASM databases.** The canonical local store is native SQLite via
  `better-sqlite3`. PGlite is not used.
- **A PWA / browser-first build.** The canonical app is the Electron desktop app; a
  browser version is deprioritized and would only ever arrive later via a separate adapter.
- **Tauri.** Deprioritized to a possible future alternative shell only — we build Electron,
  not both.
- **Live multi-device sync / a server-side domain mirror.** The server is an encrypted-backup
  target only; there is no two-way sync, no conflict resolution, and no server copy of the
  domain model. One canonical device + restore-to-a-fresh-install.

When the server arrives (M11+), it is an **encrypted-backup target only**: the desktop encrypts
the SQLite DB + asset vault client-side and uploads opaque archives, restoring them onto a fresh
install. The local `operation_log` makes backups **incremental** (upload only what changed); it
is **not** replayed into a server domain DB. There is **no live multi-device sync** and therefore
no conflict resolution. Electric/PGlite/PowerSync are not used. Semantic search (T087) uses a
**local vector store** (`sqlite-vec` on the same SQLite DB), not Postgres/`pgvector`. AI (T093)
runs from the Electron main with a local model or the user's own API key; an **optional,
off-by-default** managed proxy may route calls through the backup server, and enabling it
discloses that content is sent.
</content>

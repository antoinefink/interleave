# Architecture

This describes the chosen stack, *why* each piece was chosen, the monorepo layout, and
the Docker-first workflow. Treat it as the default; a task may override a choice only if it
says so explicitly.

## Guiding principles

- **Local-first, single-user-first.** The app must be genuinely usable with no server.
  Instant interaction, offline access, keyboard workflows, long-lived personal data. A
  server exists *later* for sync, AI/import workers, object storage, and backups.
- **Boring, explicit, type-safe over clever.** Favor small composable domain functions
  with tests over large UI-coupled handlers.
- **Domain logic out of React.** See the layering rule below and in `CLAUDE.md`.
- **One universal object model: `Element`.** See [`domain-model.md`](./domain-model.md).
- **Source lineage is sacred.** A card must always trace back to its extract → source
  location → source metadata → original document context.

## Stack & rationale

### Frontend
- **React 19 + TypeScript + Vite** — best ecosystem, editor integrations, testing, and
  agent-coding support. Vite fits a no-SEO local-first app and targets modern browsers.
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
- **PGlite + Drizzle ORM** — a real Postgres-like relational model in the browser via WASM,
  with Drizzle support, so schema/query thinking is shared with the eventual server. Use
  the **IndexedDB VFS** in browsers (OPFS isn't supported in Safari).
- All data access goes through **repository interfaces** so the implementation can be
  swapped or synced later.

### Backend (later — gold-standard phase)
- **Node.js + TypeScript + Hono** — small, Web-Standards-based, typed RPC to share API
  types with the client.
- **PostgreSQL 18** — relational, source-linked, audit-heavy, long-lived; `pgvector` later
  for semantic search.
- **Drizzle ORM** — same schema language as local.
- **pg-boss** — reliable Postgres-backed background jobs (imports, snapshots, AI,
  embeddings, OCR, cleanup).
- **S3-compatible object storage** — PDFs, images, audio/video clips, snapshots, backups,
  via presigned URLs.

### Scheduling
- **FSRS (`ts-fsrs`)** wrapped behind our own interface for active-recall **cards** only.
- **Custom priority/topic scheduler** for **sources/topics/extracts** — a different mental
  model (see [`scheduling-and-priority.md`](./scheduling-and-priority.md)).

### Later platforms
- **Tauri 2** desktop shell (smaller/more native than Electron; same React frontend).
- **Manifest V3 browser extension** for capture (service worker + Side Panel API).
- **PDF.js** for PDF rendering/extraction; **Mozilla Readability** for article extraction.

### Testing
- **Vitest** for unit/domain tests; **Playwright** for E2E flows; **Storybook** for complex
  UI states; **MSW** for mocked API/import flows.

## Monorepo layout

A **pnpm workspace**, orchestrated with **Turborepo** (task running only — not architectural
complexity).

```txt
apps/
  web/         React + Vite app (the MVP lives almost entirely here)
  api/         Hono API server (gold-standard phase)
  worker/      background jobs: imports, AI, embeddings, OCR, sync cleanup
  extension/   Manifest V3 browser extension for capture
  desktop/     Tauri wrapper around the web app

packages/
  core/        domain types: Element model, scheduler interfaces, enums
  db/          Drizzle schemas, migrations, repositories
  scheduler/   FSRS wrapper + topic/extract scheduler
  editor/      Tiptap extensions, cloze marks, extraction commands
  importers/   Readability, PDF, EPUB, video, RSS, email import logic
  ui/          shared components
  testing/     factories, fixtures, mock sources
```

## Layering (enforced)

```txt
UI components
  → route/actions/hooks
  → repositories/services
  → domain packages (packages/core, packages/scheduler, packages/editor)
  → database (packages/db → PGlite / PostgreSQL)
```

React may orchestrate UI state but must not contain SQL, scheduling rules, document-
transformation algorithms, or card-quality heuristics. Persistence and domain operations
live in repository/service modules: `ElementRepository`, `DocumentRepository`,
`ReviewRepository`, `SourceRepository`, `SettingsRepository`, `SchedulerService`,
`ExtractionService`, `CardService`, `QueueService`.

## Operation-log-shaped mutations

Every important mutation must be designed as if it will become an operation-log entry
(`create_element`, `update_element`, `delete_element`, `create_extract`, `create_card`,
`update_document`, `set_read_point`, `add_review_log`, `reschedule_element`). This makes the
MVP testable and the eventual sync layer tractable. Never silently destroy user data —
prefer soft delete, trash, and undo.

## Docker-first workflow

**Everything runs in Docker.** Agents must not depend on host Node/pnpm versions. The
canonical commands are thin wrappers (a `Makefile`) over `docker compose`:

| Command | What it does |
|---------|--------------|
| `make dev` | Start the dev stack (web + deps) with hot reload |
| `make typecheck` | `pnpm typecheck` across the workspace, in a container |
| `make test` | Vitest unit/domain tests, in a container |
| `make e2e` | Playwright E2E (uses the official Playwright image) |
| `make lint` | Biome format/lint check |
| `make migrate` | Run Drizzle migrations (server phase) |
| `make seed` | Load demo fixtures |
| `make shell` | Open a shell in the toolchain container |
| `make down` | Stop the stack |

`docker-compose.yml` grows by phase:

- **MVP (local-first):** one Node toolchain service (`app`) running pnpm/Vite/Vitest, plus a
  Playwright service for E2E. No server database — PGlite runs in the browser.
- **Gold-standard:** add `api`, `worker`, `db` (PostgreSQL 18), and `minio` (S3-compatible),
  plus `pgvector` on the db image.

> The Dockerfiles, `docker-compose.yml`, and `Makefile` are created in **Milestone 1**
> (tasks T001–T002). The Definition of Done in `CLAUDE.md` runs these Docker commands.

## What we are explicitly NOT building yet

Per MVP boundaries: no cloud sync, browser extension, PDF/EPUB import, AI features, semantic
search, video/audio, image occlusion, complex encryption, or collaboration until the core
loop is solid. These are scheduled in the gold-standard milestones (M11–M20).
</content>

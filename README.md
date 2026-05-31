# Interleave

A desktop-first, local-first **incremental reading** application. Import sources, read
them gradually, extract useful fragments, distill them into clean notes, and convert the
most valuable ideas into spaced-repetition flashcards — all while keeping every card
traceable back to its source.

```txt
Source → Topic → Extract → Clean extract → Atomic statement → Card → Review → Mature knowledge
```

See [`CLAUDE.md`](./CLAUDE.md) for the engineering charter and [`docs/`](./docs/) for the
concept, architecture, domain model, and the build roadmap.

## Native pnpm workflow (canonical)

The canonical app is a local-first **Electron desktop app** with a **native SQLite**
database — it needs host access to a native module (`better-sqlite3`), the app data
directory, and a real window, so it runs natively with **pnpm**, not in Docker.

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Start the full Electron desktop app + Vite renderer with hot reload (drives `apps/desktop/scripts/dev.mjs`: Vite renderer + main/preload bundle + Electron). Canonical dev loop — live data + `window.appApi` only exist inside Electron. |
| `pnpm dev:renderer` | Start the **bare** Vite renderer only (no Electron, no `window.appApi`) — for isolated UI work that does not need live data |
| `pnpm typecheck` | Typecheck the whole workspace (strict TypeScript) |
| `pnpm test` | Run Vitest unit/domain/repository tests |
| `pnpm e2e` | Run Playwright (chromium smoke + the Electron desktop E2E) |
| `pnpm lint` | Run the Biome format + lint check (JS/TS/JSON/CSS) |
| `pnpm format` | Auto-format the workspace with Biome |
| `pnpm db:generate` | Generate Drizzle (SQLite dialect) migrations |
| `pnpm db:migrate` | Run Drizzle migrations against the local dev SQLite DB |
| `pnpm db:reset:dev` | Reset the dev SQLite DB |
| `pnpm seed` | Reset the dev SQLite DB and load the demo collection (through the repositories) |

### First run

```bash
pnpm install    # installs deps and rebuilds better-sqlite3 for the Electron ABI
pnpm dev        # start the Electron desktop app (renderer hot-reloads via Vite)
```

`pnpm install` runs the `@interleave/desktop` postinstall, which builds an Electron-ABI
copy of the native `better-sqlite3` addon into `apps/desktop/native/` (the shared package
keeps its Node-ABI binary for Vitest and the dev scripts). Run
`pnpm --filter @interleave/desktop rebuild:native` to rebuild it manually.

> **Docker is no longer canonical for the desktop app.** The
> [`Makefile`](./Makefile)/[`docker-compose.yml`](./docker-compose.yml)/[`docker/`](./docker/)
> setup is kept but **re-scoped to the future server phase only** (`api`/`worker`/`db`/`minio`).
> Do not use it to build, run, or test the local desktop app.

## What's wired today

This is early in the [roadmap](./docs/roadmap.md). As of **T007 (Electron desktop shell +
native SQLite persistence)** the repo is a pnpm + Turborepo monorepo with:

- **Strict TypeScript** baseline ([`tsconfig.base.json`](./tsconfig.base.json)) inherited
  by every package/app.
- **Biome** for format + lint ([`biome.json`](./biome.json)).
- **Vitest** (workspace-aware) with domain, schema, and DB-service tests.
- **Playwright** with the chromium shell smoke E2E plus an **Electron desktop E2E** that
  drives the real app, checks the secure window flags + `window.appApi` bridge, and proves
  a value persists across an app restart.
- The **React 19 + TanStack Router renderer** in [`apps/web`](./apps/web).
- The **Electron desktop shell** in `apps/desktop` (main process, preload bridge, lifecycle,
  app-data dir + asset vault, native SQLite via `better-sqlite3`, startup migrations, and the
  validated IPC surface `app.health()` / `db.getStatus()` / `settings.get()/update()`).
- The **native SQLite schema + migrations** (SQLite dialect) in [`packages/db`](./packages/db).

## Layout

```txt
apps/
  desktop/     Electron shell: main process, preload bridge, IPC, app-data + asset vault
  web/         React + Vite renderer (UI only; calls window.appApi in desktop mode)
  api/         Hono API server (gold-standard phase; stub for now)
packages/
  core/        domain types: Element model, scheduler interfaces, enums
  db/          Drizzle schema + migrations (SQLite dialect), client, migrator
  scheduler/   FSRS wrapper + topic/extract scheduler
  editor/      Tiptap extensions, cloze marks, extraction commands
  ui/          shared components
  testing/     factories, fixtures, mock sources
```

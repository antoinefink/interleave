# AGENTS.md

## Project

This is a desktop-first, local-first incremental reading application. Users import sources such as articles, notes, PDFs, books, and media; read them gradually; extract useful fragments; distill those fragments into cleaner notes; and eventually convert the most valuable ideas into active-recall flashcards reviewed with spaced repetition.

The product is **not** a read-it-later app, **not** a generic note app, and **not** only a flashcard app. It is a long-term knowledge-processing system built around this pipeline:

```txt
Source → Topic → Extract → Clean extract → Atomic statement → Card → Review → Mature knowledge
```

The application should feel efficient, minimal, serious, keyboard-first, and durable enough to hold years of personal knowledge.

## How this project is built (read this first)

This product is built **one feature at a time**, each by a dedicated agent, against a
documented plan in [`docs/`](./docs/). Before starting any work:

1. Read [`docs/README.md`](./docs/README.md) — the doc system + orchestration loop.
2. The task queue is [`docs/roadmap.md`](./docs/roadmap.md): 100 numbered tasks
   (`T001`–`T100`) with `Depends on` + `Done when`. **Pick the lowest-numbered unchecked
   task whose dependencies are all `[x]`.**
3. Detailed, buildable specs live in [`docs/tasks/`](./docs/tasks/), one milestone file
   at a time (e.g. `M1-foundations.md`). If a task has no detailed spec yet, its roadmap
   line is the spec; generate the next milestone's spec file before starting it.
4. Reference docs (read the ones relevant to your task): [`docs/concept.md`](./docs/concept.md),
   [`docs/architecture.md`](./docs/architecture.md), [`docs/domain-model.md`](./docs/domain-model.md),
   [`docs/scheduling-and-priority.md`](./docs/scheduling-and-priority.md),
   [`docs/design-system.md`](./docs/design-system.md) (for any UI task).
5. After finishing: check the box in `roadmap.md`, record the commit, note anything that
   changes downstream tasks, and commit as a single coherent change referencing the task ID.

## Runtime & tooling (native pnpm is canonical)

**The desktop app runs natively, not in Docker.** The canonical app is an Electron desktop
shell with a native SQLite database (better-sqlite3) — that needs host access to the app data
directory, native modules, and a real window, so it cannot live in a container. Use native
`pnpm` to run, develop, and test the desktop app:

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start the full Electron desktop app + Vite renderer with hot reload (drives `@interleave/desktop`'s `dev.mjs`: Vite + main/preload bundle + Electron). This is the canonical dev loop — the renderer only has `window.appApi`/live data inside Electron. |
| `pnpm dev:renderer` | Start the **bare** Vite renderer only (`@interleave/web`), no Electron/`window.appApi` — for isolated UI work that does not need live data |
| `pnpm typecheck` | Typecheck the workspace |
| `pnpm test` | Vitest unit/domain/repository tests |
| `pnpm e2e` | Playwright E2E against the Electron app |
| `pnpm lint` | Biome format/lint check |
| `pnpm db:generate` | Generate Drizzle (SQLite dialect) migrations |
| `pnpm db:migrate` | Run Drizzle migrations against the local SQLite DB |
| `pnpm db:reset:dev` | Reset the dev SQLite DB |
| `pnpm seed` | Load demo fixtures into the dev SQLite DB |

Docker is **not** canonical for the desktop app. The existing `docker compose` / `Makefile`
setup is kept but **re-scoped to the future server phase only** — it provisions the
gold-standard services (`api`, `worker`, `db` = PostgreSQL 18 + pgvector, `minio`) when cloud
sync work begins. Do not use it to build, run, or test the local desktop app.

## Design system (visual source of truth)

UI is **not** invented per task — it follows the design kit in [`design/`](./design/),
summarized in [`docs/design-system.md`](./docs/design-system.md). For any UI-bearing task:

- Use the canonical tokens in [`design/tokens.css`](./design/tokens.css) (IBM Plex,
  OKLCH, light + dark; priority/element-type/scheduler color tokens). Derive the Tailwind v4
  theme from these variables — never hard-code colors/spacing.
- Use **`lucide-react`** for icons via [`design/icon-map.md`](./design/icon-map.md).
- Match the prototype's *visual output* (see `design/kit/` screens + screenshots)
  pixel-for-pixel, but rebuild structure to fit our stack and layering — do not ship the
  Babel-in-browser prototype. `design/kit/` is immutable reference.
- Honor the two load-bearing patterns: the **FSRS vs attention `SchedulerChip`** split, and
  **actionable lineage** (jump-to-source-location + `LineageTree`).

## Preferred stack

Use the planned stack unless a task explicitly says otherwise:

- React + TypeScript + Vite **renderer** (UI only)
- Electron desktop shell (main process, preload bridge, lifecycle, windows, native menus, IPC)
- Native SQLite via **better-sqlite3** (Electron main/worker side) as the canonical local database
- Drizzle ORM + migrations (**SQLite dialect**)
- Filesystem **asset vault** for PDFs, HTML snapshots, images, media, exports, backups
- TanStack Router
- Tiptap / ProseMirror for rich-text documents
- FSRS for active-recall card scheduling
- Custom attention scheduler for sources/topics/extracts
- Vitest for unit/domain/repository tests
- Playwright for end-to-end flows (against the Electron app)
- Tailwind/Radix-style primitives for UI; `lucide-react` for icons
- Later (server phase only): Hono API, PostgreSQL + pgvector, background workers, operation-log
  cloud sync, browser extension

Core principle: **SQLite is the canonical local database. The filesystem is the canonical
local asset vault. The React app is the UI. Electron owns trusted local capabilities. The
renderer never talks directly to SQLite or arbitrary filesystem APIs.**

Tauri is deprioritized to a possible future alternative shell only — do not build both Electron
and Tauri. A PWA/browser version is deprioritized (possibly added later via a separate adapter);
the canonical app is the desktop app.

Favor boring, explicit, type-safe architecture over clever abstractions.

## Core domain invariants

The universal primitive is **Element**.

Every source, extract, card, task, concept, media fragment, and synthesis note is either an element or belongs to an element.

Core element types:

- `source`
- `topic`
- `extract`
- `card`
- `task`
- `concept`
- `media_fragment`
- `synthesis_note`

Core lifecycle statuses:

- `inbox`
- `pending`
- `active`
- `scheduled`
- `done`
- `dismissed`
- `suspended`
- `deleted`

Core distillation stages:

- `raw_source`
- `rough_topic`
- `raw_extract`
- `clean_extract`
- `atomic_statement`
- `card_draft`
- `active_card`
- `mature_card`
- `synthesis`

Do not implement features in a way that breaks source lineage. A card must be able to point back to its extract, source location, source metadata, and original document context.

## Architectural rules

Keep domain logic out of React components.

Use this layering:

```txt
React UI (renderer)
  → typed client API wrapper
  → Electron preload bridge (window.appApi)
  → Electron main / DB service (validated IPC)
  → local-db repositories/services + domain packages
  → SQLite + filesystem asset vault
```

The **renderer never touches SQLite or arbitrary filesystem APIs**. It calls the narrow typed
`window.appApi` surface; the Electron main process owns all trusted local capabilities and runs
the repositories/services. React components may orchestrate UI state — selection, dialogs,
optimistic state — but they must not contain SQL, scheduling rules, extraction-lineage logic,
review-state transitions, document-transformation algorithms, card-quality heuristics, or
backup logic.

Repositories and transactional domain operations live in `packages/local-db` (SQLite adapter via
better-sqlite3), behind the Electron/IPC boundary:

- `ElementRepository`
- `DocumentRepository`
- `SourceRepository`
- `ReviewRepository`
- `QueueRepository`
- `SearchRepository`
- `AssetRepository`
- `SettingsRepository`
- `OperationLogRepository`

Domain services (`SchedulerService`, `ExtractionService`, `CardService`, `QueueService`) compose
these repositories. The Drizzle schema, migrations, and generated types (SQLite dialect) live in
`packages/db`. New domain types (`Asset`, `AssetLocation`, `OperationLogEntry`, `LocalVaultPath`,
alongside the existing `Element` family) live in `packages/core`. The Electron main/preload/
lifecycle/windows/IPC/paths/backups live in `apps/desktop`; `apps/web` stays a pure UI renderer
that calls `window.appApi` in desktop mode. `apps/api` and `apps/worker` remain later-only.

Prefer small composable domain functions with tests over large UI-coupled handlers.

## Electron runtime & security

The desktop shell (`apps/desktop`) owns the main process, preload bridge, lifecycle, windows,
native menus, IPC, filesystem paths, and backups. Security defaults are non-negotiable:

- `contextIsolation: true`, `nodeIntegration: false`, `enableRemoteModule: false`,
  and `sandbox: true` where practical.
- The renderer has **no** raw Node, filesystem, or SQLite access.
- The preload exposes a **narrow typed** `window.appApi` with **validated IPC payloads**
  (Zod or equivalent). Example surface: `app.health()`, `db.getStatus()`,
  `settings.get/update()`, `elements.create/update()`, `sources.importManual()`,
  `extractions.create()`, `cards.review()`, `queue.next()`, `search.query()`, `backups.create()`.
- **Never** expose a generic `db.query(sql)` to the renderer.
- In dev, Electron loads the Vite dev server; in production it loads the built renderer files.

## SQLite rules

- Use **better-sqlite3** + Drizzle (SQLite dialect).
- On open, set `PRAGMA foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000`.
- Multi-table domain operations run in transactions.
- Local full-text search uses FTS5 (`source_fts`, `extract_fts`, `card_fts`) when search lands.
- The DB lives under the app data directory, e.g.
  `~/Library/Application Support/<app>/app.sqlite` (plus `-wal`/`-shm`), with sibling
  `assets/` and `backups/` directories.
- **Do not** store large PDF/image/audio/video blobs in SQLite. Store the bytes in the asset
  vault and keep metadata/hashes/relative paths/source-refs/lifecycle in SQLite.
- Generate stable UUID/ULID-style IDs in domain services.

Initial M1 SQLite tables: `elements`, `documents`, `document_blocks`, `document_marks`,
`sources`, `source_locations`, `element_relations`, `read_points`, `cards`, `review_states`,
`review_logs`, `concepts`, `tags`, `element_tags`, `tasks`, `assets`, `operation_log`,
`settings`. FTS tables arrive with search later.

## Asset vault

Large assets live on the filesystem, managed exclusively by Electron (**never the renderer**).
SQLite stores stable asset IDs, relative paths, content hashes, MIME types, sizes, timestamps,
and owning element IDs. Layout under the app data directory:

- `assets/sources/<source_id>/` — `original.html`, `cleaned.html`, `original.pdf`, `snapshot.json`
- `assets/media/<asset_id>/` — `original.bin`, `thumbnail.webp`, `ocr.json`
- `exports/`
- `backups/<timestamp>/` — `app.sqlite`, `assets-manifest.json`

Do not expose arbitrary file read/write to the renderer; all vault access goes through typed
`window.appApi` commands.

## Data rules

All important user actions should be persistable, testable, and eventually syncable.

There is an `operation_log` table **from day one**. Every meaningful mutation is representable
as a command/op and appended to the log inside the same transaction as the mutation:

- `create_element`
- `update_element`
- `soft_delete_element`
- `restore_element`
- `create_source`
- `update_document`
- `set_read_point`
- `create_extract`
- `create_card`
- `add_review_log`
- `reschedule_element`
- `add_relation`
- `remove_relation`
- `add_tag`
- `remove_tag`

The operation log later supports backup, audit, undo, and cloud sync. Do **not** overbuild sync
now — just make mutations command-like and logged.

Persistence rules:

- SQLite runs with `foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000`
  (see [SQLite rules](#sqlite-rules)).
- Multi-table domain mutations run in a single transaction.
- Large assets (PDFs, snapshots, images, media) live in the filesystem **asset vault**; only
  their metadata/hashes/relative paths/owning element IDs live in SQLite
  (see [Asset vault](#asset-vault)).

Do not silently destroy user data. Prefer soft delete (`deleted_at`), undoable actions, trash,
and explicit destructive confirmations for bulk operations.

Stable IDs matter. Document blocks should have stable IDs because source locations, extracts, read-points, and future sync depend on them.

## Document/editor rules

Tiptap/ProseMirror documents are not just display content; they are the substrate for extraction lineage.

When editing source documents, preserve:

- stable block IDs
- marks for highlights/extracted spans/processed spans
- source locations
- parent-child relationships
- read-points
- references

When implementing extraction, always store:

- parent element ID
- source element ID
- source block IDs
- start/end offsets when available
- selected text snapshot
- inherited source metadata
- inherited concept/tags/priority where appropriate

Extracts are independent scheduled elements, not highlights.

## Scheduling rules

Cards and topics are scheduled differently.

Use FSRS only for active-recall card scheduling.

Cards answer:

> Can the user recall this?

Sources, topics, and extracts answer:

> Should the user process this again, and when?

Do not force topic/extract scheduling into the same mental model as card review.

A topic/extract scheduler should consider:

- priority
- stage
- last processed date
- user action
- whether it produced useful children
- whether it is stagnant
- whether it has been postponed repeatedly

## Priority rules

Priority is first-class. Every source, extract, card, and task should be prioritizable.

Internally, use numeric priority. In the UI, expose simple labels initially:

- **A** = high value
- **B** = useful
- **C** = maybe
- **D** = low / background

High-priority fragile memory should be protected. Low-priority topics should be sacrificed first during overload.

Do not let newly imported material automatically dominate older high-value material.

## Review rules

Review sessions must be fast, repairable, and source-grounded.

During card review, the user must be able to:

- reveal answer
- grade Again / Hard / Good / Easy
- see next interval previews
- edit prompt/answer
- open source
- suspend
- delete
- mark leech
- add context

Every review should create a durable review log.

Sibling cards should not be shown back-to-back unless explicitly requested.

## Card-quality rules

Cards should follow the minimum information principle.

Warn or prevent when possible:

- prompt too long
- answer too long
- multiple facts in one card
- ambiguous pronouns
- missing source
- giant cloze paragraph
- list/set too large
- similar card likely causing interference
- time-sensitive claim with no date/version

AI-generated cards, when implemented later, must be drafts until explicitly approved by the user.

## UX rules

Design desktop-first for the Electron desktop app (the renderer is a modern Chromium runtime).

The app should feel like a professional knowledge workspace:

- dense but calm
- minimal but not sparse
- keyboard-first
- fast interactions
- excellent typography
- subtle borders
- restrained status/priority colors
- no playful gamification
- no cartoon learning-app aesthetic

The main shell should usually follow:

- left navigation
- top command/search bar
- main work area
- right inspector/context panel

Frequent actions need keyboard shortcuts and command-palette access.

## Key screens

Preserve these product surfaces:

- Daily Queue / Home Command Center
- Import & Inbox Triage
- Source Reader / Incremental Reading Workspace
- Extract Distillation & Card Builder
- Active Recall Review Session
- Library / Search / Knowledge Map
- Analytics / Maintenance
- Settings

Do not create isolated feature UIs that cannot later fit into these surfaces.

## MVP boundaries

The MVP ships as a **local-first Electron desktop app** (macOS at minimum), with native SQLite
in the app data directory and assets in the filesystem vault — **not** a PWA.

For the MVP, prioritize:

- local-first persistence (native SQLite + filesystem asset vault)
- manual source import
- inbox triage
- source reader
- read-points
- highlights
- extracts
- sub-extracts
- hierarchy navigation
- priorities
- topic/extract scheduling
- due queue
- Q&A cards
- cloze cards
- FSRS review
- sibling burying
- leech warnings
- search
- concepts/tags
- backup/export
- keyboard workflow

Avoid implementing these until the core loop is solid, unless explicitly requested:

- PGlite / browser-storage-as-source-of-truth (replaced by native SQLite — do not reintroduce)
- a PWA / browser-first build (the canonical app is the Electron desktop app)
- cloud sync
- browser extension
- PDF/EPUB import
- AI features
- semantic search
- video/audio
- image occlusion
- complex encryption
- collaboration

## Testing expectations

Every meaningful feature should include tests at the right level.

Use unit tests for:

- scheduling
- priority scoring
- card-quality heuristics
- extraction/source-location logic
- review-state transitions
- repository behavior

Use Playwright for end-to-end flows:

- import source
- activate source
- set read-point
- extract text
- create card
- review card
- reschedule card
- search for card
- open original source
- backup/export

Playwright runs against the Electron app where feasible; the MVP flow adds a restart-app +
verify-persistence step. A feature is not complete unless it works after **app restart**.

## Definition of done

A task is done only when:

- `pnpm typecheck` passes
- `pnpm test` passes (Vitest)
- relevant Playwright/Electron tests pass where applicable
- database migrations are included if schema changed
- repositories/services have tests for important domain logic
- fixtures/seed data are updated if useful
- the feature survives **app restart**
- source lineage is preserved
- meaningful mutations append `operation_log` entries
- **no raw DB or filesystem access is exposed to the renderer**
- no unrelated refactors are included
- the roadmap box is checked `[x]` with the commit reference

For persistence features, additionally:

- data is written to SQLite and remains after restart
- multi-table mutations run in transactions
- foreign keys are enforced
- dangerous actions soft-delete and/or are undoable

For risky data changes, include migration/backfill notes.

## Working style for agents

Before coding, inspect the relevant existing schema, repositories, services, and tests.

Prefer implementing one coherent feature at a time. A good task is:

> Implement extraction from selected document text into a scheduled child extract,
> including source-location persistence, visual extracted-span marking, and tests.

A bad task is:

> Improve the reader.

Do not rewrite unrelated files. Do not rename concepts casually. Do not change public data shapes without updating migrations, tests, fixtures, and affected services.

When uncertain, preserve data integrity and source lineage over UI convenience.

## Product north star

Every piece of knowledge should know:

- where it came from
- why it matters
- what stage it is in
- when it should return
- how important it is
- what action is needed next

The application succeeds when users can import too much material without drowning, progressively extract value from it, and retain the small subset that truly matters.

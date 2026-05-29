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

## Docker-first workflow

**Everything runs in Docker.** Do not depend on host Node/pnpm. The canonical commands are
`make` targets that wrap `docker compose` (defined in T002):

| Command | Purpose |
|---------|---------|
| `make dev` | Start the dev stack with hot reload |
| `make typecheck` | Typecheck the workspace (in a container) |
| `make test` | Vitest unit/domain tests (in a container) |
| `make e2e` | Playwright E2E (official Playwright image) |
| `make lint` | Biome format/lint check |
| `make migrate` | Run Drizzle migrations (server phase) |
| `make seed` | Load demo fixtures |
| `make shell` | Shell into the toolchain container |
| `make down` | Stop the stack |

Compose grows by phase: MVP = one Node `app` service + a Playwright `e2e` service (PGlite
runs in the browser, so there is no server DB yet). Gold-standard adds `api`, `worker`,
`db` (PostgreSQL 18 + pgvector), and `minio`.

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

- React + TypeScript + Vite
- TanStack Router
- Tiptap / ProseMirror for rich-text documents
- PGlite for local-first browser persistence
- Drizzle ORM for schema and migrations
- FSRS for active-recall card scheduling
- Custom scheduler for sources/topics/extracts
- Vitest for unit/domain tests
- Playwright for end-to-end flows
- Tailwind/Radix-style primitives for UI; `lucide-react` for icons
- Later: Hono API, PostgreSQL, background workers, browser extension, Tauri desktop app

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
UI components
  → route/actions/hooks
  → repositories/services
  → domain packages
  → database
```

React components may orchestrate UI state, but they should not contain scheduling rules, SQL, document-transformation algorithms, or card-quality heuristics.

Use repository/service modules for persistence and domain operations:

- `ElementRepository`
- `DocumentRepository`
- `ReviewRepository`
- `SourceRepository`
- `SchedulerService`
- `ExtractionService`
- `CardService`
- `QueueService`

Prefer small composable domain functions with tests over large UI-coupled handlers.

## Data rules

All important user actions should be persistable, testable, and eventually syncable.

Design every mutation as if it may later become an operation-log entry:

- `create_element`
- `update_element`
- `delete_element`
- `create_extract`
- `create_card`
- `update_document`
- `set_read_point`
- `add_review_log`
- `reschedule_element`

Do not silently destroy user data. Prefer soft delete, undoable actions, trash, and explicit destructive confirmations for bulk operations.

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

Design desktop-first for modern browsers.

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

For the MVP, prioritize:

- local-first persistence
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

A feature is not complete unless it works after reload.

## Definition of done

A task is done only when:

- `make typecheck` passes (runs `pnpm typecheck` in Docker)
- `make test` passes (Vitest in Docker)
- relevant `make e2e` (Playwright) tests pass
- database migrations are included if schema changed
- fixtures/seed data are updated if useful
- the feature survives page reload
- source lineage is preserved
- no unrelated refactors are included
- the roadmap box is checked `[x]` with the commit reference

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

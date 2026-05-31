# Interleave

A desktop-first, **local-first incremental reading** application. Import sources, read them
gradually, lift out the fragments that matter, distill those into clean notes, and turn the
most valuable ideas into spaced-repetition flashcards — while every card stays traceable all
the way back to the sentence it came from.

```txt
Source → Topic → Extract → Clean extract → Atomic statement → Card → Review → Mature knowledge
```

It is **not** a read-it-later app, **not** a generic note app, and **not** only a flashcard
app. It is a long-term knowledge-processing system for people who import more than they can
read and want to retain the small subset that truly matters.

> **Download:** grab the macOS build from the [latest release](https://github.com/antoinefink/incremental-reading/releases).
> The `.dmg` is currently **unsigned** — on first launch, right-click the app → **Open**.

---

## Screenshots

**The incremental reading workspace** — read a source, drop a read-point, and lift passages
into independent *scheduled* extracts; the scheduler-aware inspector (priority, stage, last-seen,
source provenance) sits on the right.

![Source reader](docs/screenshots/reader.png)

**The library** — browse every element (sources, extracts, cards) with faceted filters by type,
concept, priority, and status; everything traces back to its source.

![Library](docs/screenshots/library.png)

**The Home command center** (your daily landing dashboard) and **the Concepts knowledge map**:

![Home command center](docs/screenshots/home.png)
![Concepts knowledge map](docs/screenshots/concepts.png)

---

## What it does

A single, coherent loop — the whole pipeline above, implemented end to end:

- **Capture & inbox** — import sources by hand (title/URL/author/date/body), triage them, set priorities.
- **Read** — a Tiptap reader with **read-points** (resume where you left off) and stable block IDs.
- **Extract with lineage** — lift a passage into an independent, *scheduled* extract that
  remembers its parent, source, exact block + offsets, and a verbatim snapshot. Sub-extracts
  preserve the chain `source → extract → sub-extract`. **Lineage is never broken.**
- **Distill** — move an extract `raw → clean → atomic` in a focused review mode.
- **Cards** — turn extracts into Q&A or cloze cards, with minimum-information **quality warnings**.
- **Two schedulers, on purpose** — **FSRS** (`ts-fsrs`) schedules *cards* ("can I recall this?");
  a separate **attention scheduler** schedules *sources/extracts* ("should I process this again,
  and when?"). They never bleed into each other.
- **Review** — grade Again/Hard/Good/Easy with interval previews, sibling burying, leech
  detection, and one-keystroke jump-back to the source.
- **Queue & process loop** — a priority-sorted due queue and a one-at-a-time processing mode.
- **Organize** — hierarchical concepts, flat tags, a dedicated library, and fast local **FTS5 search**.
- **Safety** — soft-delete + trash + command-level **undo**, basic analytics, and a
  restore-ready **backup** (SQLite + asset vault + hashed manifest, zipped).
- **Keyboard-first** — a command palette (⌘K), a `?` cheat sheet, and a mouse-free workflow.

Everything persists in a real database and **survives an app restart** — that's an explicit gate
on every feature, not an afterthought.

## Architecture

Interleave is a long-lived personal knowledge database — closer to Anki/Zotero/Obsidian than a
web app — so it favors durability over browser convenience:

- **React + TypeScript + Vite** renderer (UI only) inside an **Electron** desktop shell.
- **Native SQLite** via `better-sqlite3` + **Drizzle ORM** is the canonical local store; the
  **filesystem** is the canonical asset vault. Large files never live in the database.
- The **renderer never touches SQLite or the filesystem.** It calls a narrow, typed,
  Zod-validated `window.appApi` preload bridge; Electron's main process owns all trusted
  capabilities and runs the repositories/services.
- Every meaningful mutation is **transactional** and appended to an `operation_log` from day
  one (the foundation for undo, backup, and eventual sync).

```txt
React UI (renderer) → typed client wrapper → Electron preload (window.appApi)
  → Electron main / DB service → local-db repositories/services → SQLite + asset vault
```

**Stack:** Electron · React 19 · Vite · TanStack Router · Tailwind v4 · Tiptap/ProseMirror ·
better-sqlite3 + Drizzle (SQLite) · ts-fsrs · Vitest · Playwright · electron-builder.

```txt
apps/        desktop (Electron shell) · web (renderer) · api/worker (later, server phase)
packages/    core · db · local-db · scheduler · editor · ui · testing
docs/        concept · architecture · domain-model · scheduling · design-system · roadmap · task specs
design/      the design kit (tokens, icon map, reference screens)
```

## Run it

The canonical app runs **natively with pnpm** (a native module + a real window + the app-data
directory mean it can't live in a container):

```bash
pnpm install      # installs deps and rebuilds better-sqlite3 for the Electron ABI
pnpm dev          # launch the full Electron app (Vite + main/preload + Electron, hot reload)
pnpm dev:renderer # bare Vite renderer only (no window.appApi / live data) — isolated UI work

pnpm typecheck    # workspace typecheck
pnpm test         # Vitest unit/domain/repository tests
pnpm e2e          # Playwright E2E against the Electron app
pnpm seed         # load a demo collection into the dev SQLite DB
```

To package the desktop app: `pnpm --filter @interleave/desktop dist` → an installable `.dmg`
in `apps/desktop/release/`.

---

## How this was built

The interesting part: **Interleave was built almost entirely by AI agents (Claude), with a human
directing scope** — not hand-typed feature by feature, but orchestrated through **dynamic
multi-agent workflows** with a hard quality bar at every step.

**A documented control plane.** Before any code, the project laid down a control plane in
[`docs/`](./docs/): a 100-task [`roadmap`](./docs/roadmap.md) (each task with dependencies and a
*Done-when*), per-milestone build specs in [`docs/tasks/`](./docs/tasks/), and an engineering
charter ([`CLAUDE.md`](./CLAUDE.md)) holding the invariants. Agents derive each task from these,
so almost no context is rebuilt per task — and the plan stays coherent across dozens of steps.

**The build loop.** Work was done **one task at a time, in dependency order**, each by a fresh
workflow:

1. A **builder** agent implements the task against its spec.
2. A **fresh, independent reviewer** re-runs the *full* verification itself (typecheck, lint,
   Vitest, and Playwright/Electron E2E) and audits the diff against the spec, the design kit, and
   the architecture invariants.
3. A **correct-by-construction blocking gate** loops build → fix → review until the reviewer
   signs off with zero blocking findings — it cannot commit otherwise.
4. **One commit per task** on the main branch — so the history is bisectable and every commit is green.

Each milestone's detailed spec was generated *after* the previous milestone existed, so it could
cite real files and signatures instead of guesses.

**Beyond the MVP.** Once the 50-task MVP (Part I of the roadmap) was complete, the same machinery
ran two more passes:

- A **17-component hardening audit** — each component (domain core, schema, repositories,
  schedulers, editor, Electron/IPC, every feature surface, design fidelity, end-to-end integrity)
  independently re-audited with a fix-loop. It caught and fixed *real* cross-system bugs no
  single-task gate could see — e.g. cross-source editor save-bleed, soft-deleted cards leaking
  into search, an FSRS learning-step cursor that never persisted.
- A **UI-completeness pass** — hunting placeholder/unwired bits (the sidebar identity, the streak,
  live menu counters, an exclusive-highlight navigation fix) and finishing them with real data.

**Quality bars enforced throughout:** source lineage is sacred; the renderer never touches the
database; every mutation is transactional and operation-logged; **every feature must survive an
app restart** (proven by a full restart-persistence E2E).

**Roughly where it stands today:** ~70 commits · **985 unit/integration tests** · **158
Playwright/Electron E2E** · a packaged macOS build · the complete import → extract → card → review
loop. Part II of the roadmap (server + operation-log sync, PDF/EPUB import, AI-assisted
distillation, semantic search) is planned but not yet built.

---

*A personal project by [@antoinefink](https://github.com/antoinefink). See [`docs/`](./docs/)
and [`CLAUDE.md`](./CLAUDE.md) for the full design and build system.*

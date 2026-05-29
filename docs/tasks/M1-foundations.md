# M1 — Foundations & local persistence (T001–T011)

Detailed, buildable specs for the first milestone. After these eleven tasks the app is an
empty-but-real local-first shell: a containerized pnpm monorepo, a typed domain, a PGlite
database behind repositories, seed data, an inspector, and settings. No reading features
yet — those start in M2.

Read first: [`../architecture.md`](../architecture.md), [`../domain-model.md`](../domain-model.md),
[`../design-system.md`](../design-system.md) (for T003/T004/T010/T011),
[`../../CLAUDE.md`](../../CLAUDE.md). Spec contract: [`_TEMPLATE.md`](./_TEMPLATE.md).

Build order is the task order; each depends on the previous unless noted. T005 can be built
in parallel with T003/T004 (it only depends on T001).

---

## T001 — Create the monorepo

- **Status:** `[ ]`  · **Depends on:** none

### Goal
A pnpm + Turborepo workspace with the full app/package skeleton, so every later task has a
home and root-level task commands exist.

### Deliverables
- [ ] `pnpm-workspace.yaml`, root `package.json`, `turbo.json`, root `tsconfig.json`.
- [ ] App dirs `apps/web`, `apps/api` (api may be a stub package for now).
- [ ] Package dirs `packages/{core,db,scheduler,editor,ui,testing}`, each with its own
      `package.json` + `tsconfig.json` and an `index.ts` that exports something trivial.
- [ ] Root scripts that Turbo fans out: `dev`, `build`, `test`, `typecheck`, `lint`.
- [ ] `.gitignore`, `.nvmrc`/`engines` pin (informational; Docker is canonical).

### Done when
- The workspace installs cleanly and `make dev`, `make test`, `make typecheck`, `make lint`
  all run from the repo root (they may be near-empty but must succeed). The `make` targets
  themselves are created in T002 — for T001 the underlying `pnpm` scripts must exist.

### Notes
- Keep package names scoped, e.g. `@interleave/core`. Use TS project references so
  `packages/core` can be imported by `apps/web` without a build step in dev.

---

## T002 — Tooling + Docker + CI gates

- **Status:** `[ ]`  · **Depends on:** T001

### Goal
Make Docker the canonical way to run everything and make CI reject bad changes. This task
defines the `make` command contract referenced by the Definition of Done.

### Deliverables
- [ ] **Strict TypeScript** baseline (`strict: true`, `noUncheckedIndexedAccess`, etc.).
- [ ] **Biome** config for format + lint (JS/TS/JSON/CSS).
- [ ] **Vitest** config (workspace-aware) with one passing sample unit test.
- [ ] **Playwright** config with one passing smoke E2E (loads the app shell).
- [ ] **Docker:**
  - `docker/Dockerfile.app` — Node toolchain image (pnpm) for dev/test/typecheck/lint.
  - `docker/Dockerfile.e2e` — based on the official Playwright image.
  - `docker-compose.yml` — MVP services: `app` (vite dev + vitest), `e2e` (playwright).
    No server database yet (PGlite runs in the browser). Volume-mount the repo; cache
    `node_modules`/pnpm store in a named volume for speed.
  - `Makefile` with: `dev`, `typecheck`, `test`, `e2e`, `lint`, `seed`, `shell`, `down`
    (and stubs for `migrate` to be filled when the server DB arrives). Each target shells
    out to `docker compose run --rm app …` (or `e2e`).
- [ ] **CI** (GitHub Actions or equivalent) running `make typecheck`, `make lint`,
      `make test`, and the smoke `make e2e` in containers.

### Done when
- CI fails on a type error, a lint error, a unit-test failure, and a smoke-E2E failure
  (verify by temporarily introducing each, then reverting).
- All checks run inside Docker; no reliance on host Node.

### Notes
- Document the `make` commands in the root `README` and confirm they match
  `architecture.md` and the Definition of Done in `CLAUDE.md`.
- Keep image builds layer-cached; mounting source for dev, copying for CI is fine.

---

## T003 — Scaffold the React app

- **Status:** `[ ]`  · **Depends on:** T002

### Goal
A running web app with routing and styling, ready to host screens.

### Deliverables
- [ ] `apps/web` on Vite + React 19 + TS.
- [ ] TanStack Router with typed routes: `/`, `/inbox`, `/queue`, `/source/$id`, `/review`,
      `/search`, `/settings`. Each route renders a placeholder for now.
- [ ] **Adopt the design tokens:** import [`../../design/tokens.css`](../../design/tokens.css)
      globally and derive the Tailwind v4 `@theme` from those variables (do not re-declare
      colors/spacing). Wire `data-theme` light/dark and the IBM Plex font load.
- [ ] **Icons:** add `lucide-react` and a thin `Icon` wrapper per
      [`../../design/icon-map.md`](../../design/icon-map.md) (default `strokeWidth ≈ 1.75`).

### Done when
- `make dev` serves the app; all seven routes load and are reachable by URL.
- Tokens are live: toggling `data-theme` switches light/dark; Tailwind utilities resolve to
  token values (spot-check accent + surface).
- The smoke E2E from T002 navigates between at least two routes.

### Notes
- No domain logic in components (see layering). Routes are placeholders; data wiring comes
  after PGlite (T007).
- This is the first UI task — read [`../design-system.md`](../design-system.md). The full
  screens come later; here you only stand up the token/theme/icon foundation + routing.

---

## T004 — App shell skeleton

- **Status:** `[ ]`  · **Depends on:** T003

### Goal
The persistent workspace chrome every screen shares.

### Deliverables
- [ ] Layout matching `design/kit/app/shell.jsx`: left sidebar (brand, primary nav +
      "Organize" group, streak, user/"Local vault" chip), top command bar, central work
      area, right inspector, bottom status bar — using the layout dim tokens
      (`--sidebar-w`, `--inspector-w`, `--topbar-h`).
- [ ] `⌘K` **command palette** and `?` **cheat sheet** (`CheatSheet`), plus `g`+letter
      navigation, per the prototype.
- [ ] All seven routes render inside this shell.

### Done when
- Every main route uses the same shell and is navigable by keyboard; ⌘K and ? work.
- The shell matches the design in both light and dark (compare to `screenshots/`).

### Notes
- The right panel is a placeholder container now; T010 fills it with the inspector.
- Match the prototype's *visual output*, rebuilt in our components — don't copy its
  Babel-in-browser structure. Keep it "dense but calm."

---

## T005 — Domain language in `packages/core`

- **Status:** `[ ]`  · **Depends on:** T001  · _(parallelizable with T003/T004)_

### Goal
The shared, documented vocabulary the whole codebase imports. This is where the
[`domain-model`](../domain-model.md) becomes code.

### Deliverables
- [ ] TS types/enums for: `Element`, `ElementType`, `ElementStatus`, `DistillationStage`,
      `Priority` (numeric type + A/B/C/D mapping), `ReviewState`, `ReviewLog`, `Source`,
      `Document`, `ElementRelation`, `ElementLocation`.
- [ ] Doc comments on each, citing the invariant they protect (lineage, stage vs status).
- [ ] Unit tests for any helpers (e.g. priority numeric↔label conversion).

### Done when
- Types are exported from `@interleave/core` and consumed by both `apps/web` and tests.
- `make typecheck` and `make test` pass.

### Notes
- Match the enum values exactly to `domain-model.md` and `CLAUDE.md` (no casual renames).
- Keep these framework-agnostic — no React, no Drizzle imports here.

---

## T006 — Initial Drizzle schema

- **Status:** `[ ]`  · **Depends on:** T005

### Goal
The relational schema and a migration that can create/reset a dev database.

### Deliverables
- [ ] Drizzle tables in `packages/db`: `elements`, `documents`, `sources`,
      `element_relations`, `element_locations`, `review_states`, `review_logs`,
      `concepts`, `tags`, `element_tags`, `settings`.
- [ ] Columns aligned with [`domain-model`](../domain-model.md) (only what M1–M10 needs;
      leave sync/media/server-only fields for later milestones).
- [ ] Drizzle migration files + a script to create and reset a local dev database.
- [ ] Schema-level tests (round-trip insert/select for a couple of tables) where practical.

### Done when
- Migrations create the schema from empty and reset cleanly.
- Types inferred from Drizzle align with `@interleave/core` (no drift).

### Notes
- This schema targets PGlite locally and PostgreSQL later — keep types portable.
- Any future schema change ships its own migration (Definition of Done).

---

## T007 — PGlite local persistence

- **Status:** `[ ]`  · **Depends on:** T006, T003

### Goal
Real persistence in the browser, behind a swappable data-layer interface.

### Deliverables
- [ ] PGlite (IndexedDB VFS) initialized in `apps/web`, running the Drizzle schema.
- [ ] A `Database`/client abstraction so the implementation can be swapped or synced later
      (no direct PGlite calls scattered through the app).
- [ ] App startup runs migrations against the local DB.

### Done when
- Data written persists after page reload **and** browser restart.
- An E2E confirms a value survives a reload.

### Notes
- Use IndexedDB VFS (OPFS unsupported in Safari). Surface a clear error if persistence is
  unavailable (private mode, etc.).

---

## T008 — Repository classes

- **Status:** `[ ]`  · **Depends on:** T007

### Goal
The persistence/domain seam. React never touches SQL.

### Deliverables
- [ ] `ElementRepository`, `DocumentRepository`, `ReviewRepository`, `SourceRepository`,
      `SettingsRepository` in `packages/db` (or a `repositories` module), each with CRUD +
      the queries M1 needs.
- [ ] Mutations shaped as operation-log entries internally (see `domain-model.md`), even if
      the log isn't persisted yet.
- [ ] Unit tests per repository (run against an in-memory/temp PGlite instance via
      `packages/testing`).

### Done when
- All data access in the app goes through repositories; no SQL in components.
- `make test` covers each repository's core behavior.

### Notes
- Keep repository methods small and composable. Soft-delete semantics start here
  (`deleted_at`), even before the trash UI (T044).

---

## T009 — Seed data & fixtures

- **Status:** `[ ]`  · **Depends on:** T008

### Goal
A realistic demo collection for development and tests.

### Deliverables
- [ ] `make seed` populates the local DB with: ≥1 source that has child extracts, ≥1
      full extract chain (raw → clean → atomic), ≥1 card, plus a few concepts/tags.
- [ ] Shared factories/fixtures in `packages/testing` reused by Vitest and Playwright.

### Done when
- `make seed` yields a usable demo collection; tests can build deterministic fixtures.

### Notes
- Content should exercise lineage (card → extract → source location) so later screens have
  something meaningful to render.

---

## T010 — Universal element inspector

- **Status:** `[ ]`  · **Depends on:** T008, T004

### Goal
One consistent right-panel view of any element's metadata.

### Deliverables
- [ ] Inspector built from the design primitives (`MetaRow`, `TypeIcon`, `Prio`, `Stage`,
      `Status`) showing: type, status, stage, priority, due date, parent, children, source,
      tags, review metadata.
- [ ] **Scheduler-aware:** show a `SchedulerChip` — FSRS signals (retrievability/stability)
      for cards vs attention signals (stage/priority/last-processed/postponed×N) for
      sources/extracts/topics. Wire the presentation now from seeded data; real values land
      with T028/T036.
- [ ] A selection mechanism (selected-element state) the rest of the app can set.

### Done when
- Selecting any element shows consistent, type-appropriate metadata and the correct
  scheduler chip, matching [`../design-system.md`](../design-system.md).

### Notes
- Read-only for M1 (editing priority/stage comes with T027 and the relevant features).
- Pull data through repositories, not direct DB calls.

---

## T011 — Local settings

- **Status:** `[ ]`  · **Depends on:** T008

### Goal
Persisted user settings that scheduling and UI read.

### Deliverables
- [ ] Settings model + `SettingsRepository`-backed read/write for: daily review budget,
      default desired retention, default topic interval, default source priority, keyboard
      layout, theme.
- [ ] A `/settings` UI to view/edit them.

### Done when
- Settings persist locally and are read by scheduler code (verify the scheduler/queue picks
  up at least the daily budget + default priority once those exist).

### Notes
- These values feed T028 (topic scheduler) and T036/T037 (FSRS review). Keep keys stable —
  they'll be part of backup/export (T047).

---

## Exit criteria for M1

- All of T001–T011 are `[x]` in [`../roadmap.md`](../roadmap.md).
- The app boots in Docker, persists across reload/restart, shows seeded elements in the
  inspector, and respects settings.
- `make typecheck`, `make test`, and the smoke `make e2e` are green in CI.

When M1 is complete, generate `tasks/M2-capture-and-inbox.md` from the roadmap before
starting T012.
</content>

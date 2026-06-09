---
title: "feat: Integrate desktop diagnostics into a native Settings 'System' section"
type: feat
status: completed
date: 2026-06-09
---

# feat: Integrate desktop diagnostics into a native Settings "System" section

## Summary

Implement the "Improved Settings" design handoff. The whole Settings page already
matches the design (it was ported from the same kit) **except** the diagnostics block.
Today, `DesktopStatusPanel` renders as a detached, narrow (`max-w-md`), centered card
**outside** `<Settings/>` — mounted by `SettingsScreen()` in the router — showing a raw
7-row `<dl>` key/value dump. The user called this "strange… always on top."

The redesign folds that diagnostics data into a native, full-width **"System"** section
at the bottom of the Settings column, using the exact same `SectionPanel` / `SettingRow` /
badge / token vocabulary as every other section. The seven raw values are regrouped into
four readable rows. **No feature is removed** — the same health/DB-status data and the same
write/read-back persistence proof remain reachable.

This is fundamentally a **re-skin-and-relocate under a test contract**: the panel's
`data-testid` hooks are load-bearing for the T007 Electron E2E (bridge proof) and a unit
test. The plan's main job is to preserve those proofs while changing the presentation.

## Problem Frame

- **What's wrong:** The diagnostics live in a floating, centered `max-w-md` card detached
  from the left-aligned, full-width settings sections — visually an orphan, and it invents
  its own layout (a 2-col `<dl>`) instead of the app's row vocabulary.
- **Design intent (from the handoff `chats/chat3.md`):** "the diagnostics block reframed as a
  proper, full-width, de-emphasized **System** section in normal column flow, with a health
  summary chip… same visual language as every other section. No features changed."
- **Target source of truth:** `Improved Settings.html` (the `data-variant="after"` block) and
  `settings.css` (`.set-ok`, `.set-token`, `.set-row--top`, `.set-ctlrow`).

### Design target — the four System rows

| Row | Label | Hint | Right-side control |
| --- | --- | --- | --- |
| 1 | Local database | On-device SQLite store backing this vault — fully local. | Green **Healthy** chip (`circle-check`) |
| 2 | Schema | Migrations applied to the local store. | `{n} migrations` token + **Up to date** chip (`check`) |
| 3 | Connection | Journal mode, foreign keys, and write-lock timeout. | tokens: `wal` · `FK on` · `5000 ms` |
| 4 | Persistence check | Write a timestamped value and read it back to confirm writes survive a restart. | persisted value + **Write check** button |

## Requirements

- **R1.** Render the four-row "System" section inside the Settings column (after "Browser
  capture", before the trailing error `<p>`), matching the design labels/hints/controls.
- **R2.** Use the app's existing vocabulary: `SectionPanel`-equivalent section chrome,
  `SettingRow` for each row, the `bg-ok-soft text-ok` OK chip, and a neutral mono token pill
  built from existing tokens (`border-border bg-surface font-mono text-text-2`). No new CSS
  variables; no edits to `design/kit/`.
- **R3.** Preserve all diagnostics data and the persistence proof: `appApi.health()`,
  `appApi.dbStatus()`, `appApi.getSettings({key:"desktop.lastCheck"})`, and the
  `appApi.updateSetting(...)` write/read-back — all through the typed bridge only.
- **R4.** Remove the floating `DesktopStatusPanel` mount + import from the router so the page
  renders a single, integrated column.
- **R5.** Keep the desktop-only fallback behavior: when `!isDesktop()`, Settings shows its
  existing `settings-desktop-only` card and the System section does not attempt bridge calls.
- **R6.** Keep graceful degradation: a loading state (before data resolves) and an error state
  (`desktop-status-error`) for failed bridge calls.
- **R7.** Keep every existing test green: the T007 restart-survival + bridge-proof E2E and the
  unit suites. Tests whose *assertions* are tied to the old presentation are updated in
  lockstep to assert the new, intended structure (not satisfied by hidden crumbs).

### Test-contract facts (verified, must honor)

- `tests/electron/desktop.spec.ts` "renders the desktop status panel from the bridge"
  (`:241-264`) asserts: `desktop-status` visible + `data-desktop="true"`; `health-status`
  `toHaveText("ok")` (**exact**); `db-journal-mode` `toHaveText("wal")` (**exact**); clicks
  `persist-button`; `persisted-value` `toContainText("checked-")`. → The `toHaveText` calls are
  exact, so the visible chip text changes (`ok`→`Healthy`) **require updating this E2E test**.
- `tests/electron/desktop.spec.ts` restart-survival (`:212-239`) and pragma check (`:65-102`)
  read the bridge directly via `page.evaluate` — DOM-decoupled, **stay green untouched**.
- `apps/web/src/components/DesktopStatusPanel.test.tsx` asserts old text on every `db-*` testid
  (`5000ms`, `true`, `12`, …). Since the component is removed, this file is replaced by
  System-section coverage in `Settings.test.tsx`.
- `apps/web/src/pages/Settings.test.tsx` mocks `appApi` as a flat object **without**
  `health/dbStatus/getSettings/updateSetting`. After the panel moves into `<Settings/>`, those
  methods are invoked on mount → the mock **must** add them or all 24 tests throw.

## Key Technical Decisions

- **KTD1 — Inline `SystemPanel` in `Settings.tsx`, delete the standalone component.**
  Mirror the established `SemanticSearchPanel` / `AiAssistancePanel` pattern (co-located
  section components in `Settings.tsx` that own their own bridge state). Rationale: matches the
  codebase's idiom exactly, and avoids a circular import that would arise if a separate
  `DesktopStatusPanel.tsx` imported the `SettingRow` primitive from `Settings.tsx` while
  `Settings.tsx` imported the panel. (Alternative — extract `SectionPanel`/`SettingRow` into a
  shared module and keep `DesktopStatusPanel` — is more files for no benefit here.)
- **KTD2 — Hand-roll the System `<section>` wrapper (like "Browser capture" does), not
  `SectionPanel`.** The section must carry `data-testid="desktop-status"` + `data-desktop` for
  the E2E, and `SectionPanel` takes no testid prop. "Browser capture" already hand-rolls the
  identical `mb-6` + label + `rounded-lg border border-border bg-surface-2 px-4` chrome with a
  `data-testid`, so this is a precedented, zero-risk choice that leaves `SectionPanel` untouched.
- **KTD3 — Preserve the meaningful testids, change only their host node + visible text.**
  Keep `health-status` (Healthy chip), `db-migrated` ("Up to date" chip),
  `db-applied-migrations` (`{n} migrations` token), `db-journal-mode` (`wal` token),
  `db-foreign-keys` (`FK on/off` token), `db-busy-timeout` (`{ms} ms` token), `persist-button`,
  `persisted-value`, plus the section's `desktop-status`/`data-desktop`. Fold `db-open` into the
  Healthy chip (no separate node). This keeps both unit + E2E anchored to stable hooks.
- **KTD4 — Update the two text-coupled E2E assertions** (`health-status` → `Healthy`,
  and keep `db-journal-mode` → `wal` which already matches the token text). The persistence
  round-trip assertions are unchanged. This keeps the *intent* (prove the bridge + persistence)
  while reflecting the new UI honestly.
- **KTD5 — Icons:** use the local `Icon` map names that already exist — `checkCircle`
  (CircleCheck) for Healthy, `check` for Up to date, `edit` (Pencil) for the Write-check button.
  Do **not** add new entries to `Icon.tsx` (avoids touching a shared map; `pencil-line` isn't
  mapped and `edit`/Pencil is an acceptable, in-vocabulary substitute).
- **KTD6 — Health semantics:** show **Healthy** when `health.status === "ok" && dbStatus.open`;
  otherwise a neutral "Checking…" (loading) or a non-OK chip. "Up to date" shows when
  `dbStatus.migrated`. `FK on` when `dbStatus.foreignKeys` is truthy (`1` live / `true` in the
  unit mock — both truthy, so the mapping is safe for both).

## High-Level Technical Design

```
router.tsx                                  Settings.tsx
──────────                                  ────────────
SettingsScreen()                            export function Settings()
  <div col>                                   ...desktop-only early return (R5)
    <Settings/>          ── becomes ──>        <SectionPanel "Review & scheduling">…
    <div max-w-md>                             …(unchanged sections)…
      <DesktopStatusPanel/>   DELETE           <section "Browser capture" …/>
    </div>                                     <SystemPanel/>            ◀── NEW (R1)
  </div>                                       {error ? <p settings-error/> : null}

SystemPanel (NEW, inline)
  state: health, status, persisted, error  (appApi.health/dbStatus/getSettings — R3)
  <section mb-6 data-testid="desktop-status" data-desktop="true">   (KTD2, E2E hook)
    <div label>System</div>
    <div card>
      <SettingRow "Local database">  → <OkChip testid=health-status>Healthy</>   (row 1)
      <SettingRow "Schema">          → <Token testid=db-applied-migrations/> <OkChip testid=db-migrated>Up to date</>  (row 2)
      <SettingRow "Connection">      → <Token db-journal-mode/> <Token db-foreign-keys/> <Token db-busy-timeout/>     (row 3)
      <SettingRow "Persistence check" top> → <span persisted-value/> <button persist-button>Write check</>           (row 4)
      {error ? <SettingRow> <span desktop-status-error/> </SettingRow> : null}   (R6)
    </div>
  </section>
```

## Implementation Units

### U1. Build the integrated `SystemPanel` and render it in the Settings column

**Goal:** Add the four-row, full-width "System" section to `Settings.tsx`, owning its own
bridge-backed state, matching the design and the app's vocabulary.

**Requirements:** R1, R2, R3, R5, R6; KTD1, KTD2, KTD3, KTD5, KTD6.

**Dependencies:** none.

**Files:**
- `apps/web/src/pages/Settings.tsx` (add `SystemPanel` component near
  `SemanticSearchPanel`/`AiAssistancePanel`; render `<SystemPanel />` after the Browser-capture
  `<section>` at ~`:1740`, before the `error` paragraph at ~`:1742`).

**Approach:**
- Move the data flow from `DesktopStatusPanel.tsx` verbatim: `PERSIST_KEY = "desktop.lastCheck"`,
  a `refresh()` doing `Promise.all([appApi.health(), appApi.dbStatus(), appApi.getSettings({key})])`
  on mount, `writeSetting()` calling `appApi.updateSetting({key, value: ` + "`checked-${new Date().toISOString()}`" + `})` then `refresh()`.
- Hand-roll the section wrapper (KTD2): `<section className="mb-6" data-testid="desktop-status"
  data-desktop="true">` + the uppercase label `<div>` + `<div className="rounded-lg border
  border-border bg-surface-2 px-4">`.
- Reuse the in-file `SettingRow` for all four rows. Build two tiny inline helpers (or inline
  spans): an **OK chip** = `inline-flex items-center gap-1.5 rounded-md bg-ok-soft px-2.5 py-1
  text-ok text-xs` + `<Icon>`; a **token pill** = `inline-flex items-center rounded-md border
  border-border bg-surface px-2 py-0.5 font-mono text-text-2 text-xs whitespace-nowrap`. Use a
  `flex items-center gap-2 flex-wrap` wrapper for multi-control rows (`.set-ctlrow`).
- Row mapping per the design table + KTD3 testids. Row 4 uses `items-start` (`.set-row--top`)
  via passing a row whose control wraps; persisted value shows `(unset)` when `undefined`.
- Loading: while `health`/`status` are `null`, the chips read "Checking…"/neutral and tokens
  show `…` (mirrors the old `"…"` placeholders). Error: render an extra `SettingRow` (or inline
  note) carrying `data-testid="desktop-status-error"` when a bridge call throws.
- The component does **not** need its own `!isDesktop()` branch — `Settings()` already returns
  the `settings-desktop-only` card before reaching any section (R5). Guard the effect with
  `if (!isDesktop()) return;` for the `pnpm dev:renderer` (bridge-absent) case.

**Patterns to follow:** `SemanticSearchPanel` (`Settings.tsx:294-469`) and `AiAssistancePanel`
(`:479-647`) for component shape + own-state effects; the Browser-capture `<section>`
(`:1639-1643`) for the hand-rolled, testid-bearing section chrome; the backup-result OK chip
(`:1340-1346`) and capture token `<code>` (`:1691-1697`) for chip/token classes.

**Test scenarios** (implemented in U3, but specified here):
- Renders the **Healthy** chip (`health-status`, text "Healthy") when `health.status==="ok"` and
  `dbStatus.open`.
- Renders **Up to date** (`db-migrated`) when `migrated`; renders `{n} migrations`
  (`db-applied-migrations`, contains the count).
- Renders the three Connection tokens: `db-journal-mode`="wal", `db-foreign-keys`="FK on",
  `db-busy-timeout`="5000 ms".
- Write-check round-trip: clicking `persist-button` calls `appApi.updateSetting` with
  `{key:"desktop.lastCheck", value:"checked-<iso>"}` and updates `persisted-value`.
- Error path: a rejecting bridge call surfaces `desktop-status-error`.
- Section carries `data-testid="desktop-status"` + `data-desktop="true"`.

**Verification:** The bottom of `/settings` shows a full-width "System" section visually
consistent with the other sections (light + dark), with Healthy/Up-to-date chips, three
connection tokens, and a working Write-check row. No detached centered card remains.

### U2. Remove the floating `DesktopStatusPanel` and its dead references

**Goal:** Make the page render a single integrated column; delete the now-superseded component.

**Requirements:** R4.

**Dependencies:** U1 (the System section must exist before removing the old mount, to avoid a
window with no diagnostics surface — both land in the same commit).

**Files:**
- `apps/web/src/router.tsx` (remove the `DesktopStatusPanel` import at `:36`; simplify
  `SettingsScreen()` `:321-330` to render `<Settings />` within the scroll container, dropping
  the `<div className="mx-auto w-full max-w-3xl px-7 pb-10"><DesktopStatusPanel/></div>` wrapper;
  update the stale doc comment at `:313-319`).
- `apps/web/src/components/DesktopStatusPanel.tsx` (delete).
- `apps/web/src/components/DesktopStatusPanel.test.tsx` (delete — coverage moves to U3).
- `apps/web/src/pages/source/useDocument.ts` (`:12` comment references `DesktopStatusPanel`'s
  guard — reword to avoid the stale reference, e.g. "mirroring the Settings panel's `isDesktop`
  guard").

**Approach:** Pure deletion + rewiring. Confirm no other importers via a repo-wide grep for
`DesktopStatusPanel` after deletion (expected: zero matches).

**Patterns to follow:** existing route component definitions in `router.tsx`.

**Test scenarios:** `Test expectation: none -- removal/rewiring; behavior is covered by U3
(Settings renders the System section) and the unchanged E2E navigation.` A `grep -r
DesktopStatusPanel apps/web/src` returning no matches is the completeness check.

**Verification:** `pnpm typecheck` passes with no dangling import; the Settings route renders
only the integrated `<Settings/>` column.

### U3. Replace unit coverage: extend the Settings mock and test the System section

**Goal:** Keep the existing 24 Settings tests green after the panel moves in, and add focused
coverage for the System section's data flow and persistence proof.

**Requirements:** R7; KTD3.

**Dependencies:** U1.

**Files:**
- `apps/web/src/pages/Settings.test.tsx` (extend the `appApi` mock to include `health`,
  `dbStatus`, `getSettings`, `updateSetting` with sensible defaults; add a `describe("System
  section")` block).

**Approach:**
- Add to the hoisted mock factory: `health: () => Promise.resolve({status:"ok", appVersion:"…",
  dbOpen:true, migrated:true, time:"…"})`, `dbStatus: () => Promise.resolve({open:true,
  migrated:true, journalMode:"wal", foreignKeys:1, busyTimeoutMs:5000, appliedMigrations:12})`,
  `getSettings: () => Promise.resolve({settings:{"desktop.lastCheck":"checked-before"}})`,
  `updateSetting: () => Promise.resolve({key:"desktop.lastCheck", value:"…"})`. Use `vi.fn()`
  wrappers where a test needs call assertions (the write-check test).
- Mirror the three intents of the deleted unit test, adapted to the new text:
  Healthy chip; tokens `wal`/`FK on`/`5000 ms`; `{n} migrations`; persisted-value; write-check
  round-trip (`persist-button` → `updateSetting` with the `desktop.lastCheck` key → updated
  `persisted-value`).

**Patterns to follow:** the existing `Settings.test.tsx` hoisted-mock + `vi.mock("../lib/appApi")`
harness; the deleted `DesktopStatusPanel.test.tsx` (`:58-94`) for the round-trip shape.

**Test scenarios:**
- Happy path: System section renders Healthy + Up to date + three tokens + `{n} migrations`.
- Persistence proof: clicking `persist-button` calls `updateSetting({key:"desktop.lastCheck",
  value:"checked-<stubbed-iso>"})` and `persisted-value` reflects the new value.
- Regression guard: an existing Settings test (e.g. theme toggle) still passes — proving the
  expanded mock didn't break the suite.
- Error path (optional): a rejecting `dbStatus` surfaces `desktop-status-error`.

**Verification:** `pnpm test` passes (all Settings tests + new System tests); no orphaned
`DesktopStatusPanel.test.tsx`.

### U4. Update the Electron E2E to assert the integrated System section

**Goal:** Keep the T007 bridge + persistence proof, retargeted to the new System UI.

**Requirements:** R7; KTD4.

**Dependencies:** U1, U2.

**Files:**
- `tests/electron/desktop.spec.ts` (update only the "renders the desktop status panel from the
  bridge" test, `:241-264`).

**Approach:**
- Keep `getByTestId("desktop-status")` visible + `data-desktop="true"` (the System section
  still carries these).
- Change `expect(getByTestId("health-status")).toHaveText("ok")` →
  `toHaveText("Healthy")` (the chip's visible text), per KTD4.
- Keep `expect(getByTestId("db-journal-mode")).toHaveText("wal")` (token text is exactly "wal").
- Keep the `persist-button` click + `persisted-value` `toContainText("checked-")` round-trip.
- Do **not** touch the restart-survival test (`:212-239`) or the direct pragma test
  (`:65-102`) — they're DOM-decoupled and already green.

**Patterns to follow:** the existing test's `getByTestId` + navigation via the `user-chip` menu.

**Test scenarios:**
- `Covers T007.` Settings route shows the System section from the bridge; health reads
  "Healthy", journal mode "wal"; the write-check round-trip persists and reads back
  "checked-…".
- Restart-survival (unchanged) still proves a bridge write survives an Electron relaunch.

**Verification:** `pnpm e2e --project=electron` passes (notably `desktop.spec.ts`). Per the
learnings doc, run `pnpm build` before the Electron project so Playwright loads fresh `dist`.

## Scope Boundaries

**In scope:** the System-section integration, router rewiring, component deletion, and the
unit + E2E test updates described above.

**Out of scope / unchanged (no feature changes — design is a simplified snapshot):**
- The "Restore from a file", last-backup, and restart-required rows in Data & backup (added in
  T056) — the design omits them but they are existing features; keep them.
- The expanded Browser-capture rows (status / token / paired-with) — keep.
- `WorkloadSimulator`, `OptimizationPanel`, Semantic search, AI assistance, Interface,
  Review & scheduling, Retention by priority — already match the design; no changes.

### Deferred to Follow-Up Work

- A `docs/solutions/` note capturing the "fold a floating diagnostics surface into the native
  Settings vocabulary" pattern (extends the design-kit-port lineage). Handled by `ce-compound`
  after the change lands.

## Risks & Mitigations

- **Breaking the 24 existing Settings tests** when the panel mounts inside `<Settings/>` and the
  mock lacks the new methods → **Mitigation (U3):** extend the mock first; add a regression-guard
  assertion that a pre-existing test still passes.
- **Exact-text E2E assertions** (`toHaveText`) silently breaking → **Mitigation (U4):** update
  the two coupled assertions deliberately; keep `wal` token text exact.
- **Stale Electron `dist`** masking the change in E2E → **Mitigation:** `pnpm build` before
  `pnpm e2e --project=electron` (per `docs/solutions/.../three-zone-scroll-owned-review-card-surface.md`).
- **Circular import** if a separate component imported `Settings.tsx` primitives →
  **Mitigation (KTD1):** inline `SystemPanel` in `Settings.tsx`.

## Verification (Definition of Done)

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm build` then `pnpm e2e --project=electron` (at minimum `desktop.spec.ts`), plus the
   chromium smoke if quick.
5. Manual/visual: `/settings` bottom shows the integrated System section in light + dark, no
   detached card; all features (health, schema, connection, write-check) reachable.

## Sources & Research

- Design handoff: `Improved Settings.html` (`data-variant="after"`), `settings.css`
  (`.set-ok`, `.set-token`, `.set-row--top`, `.set-ctlrow`), and `chats/chat3.md` (intent).
- Codebase: `apps/web/src/pages/Settings.tsx`, `apps/web/src/components/DesktopStatusPanel.tsx`,
  `apps/web/src/router.tsx`, `apps/web/src/lib/appApi.ts` (`HealthResult`/`DbStatus`),
  `apps/web/src/components/Icon.tsx`.
- Tests: `tests/electron/desktop.spec.ts`, `apps/web/src/pages/Settings.test.tsx`,
  `apps/web/src/components/DesktopStatusPanel.test.tsx`.
- Learnings: `docs/solutions/design-patterns/three-zone-scroll-owned-review-card-surface.md`
  (design-kit-port playbook: reuse canonical components, de-dup to one owner, dual
  jsdom+Electron verification, rebuild before Electron e2e),
  `docs/solutions/architecture-patterns/electron-sqlite-backup-restore-reset-coordination.md`
  (preserve destructive-control safety contract + testids).

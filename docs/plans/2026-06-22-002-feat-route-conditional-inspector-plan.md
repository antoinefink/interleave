---
title: "feat: Show the shell Inspector only on routes that use it"
type: feat
date: 2026-06-22
status: ready
depth: standard
deepened: 2026-06-22
---

# feat: Show the shell Inspector only on routes that use it

## Summary

The shell's right-hand **Inspector** (`<aside className="shell-inspector">`) is rendered
unconditionally on every route from `apps/web/src/shell/Shell.tsx`. On roughly half of the app's
routes the screen never drives a selection or injects a panel, so the Inspector only ever shows its
empty "Select an element to see its details…" placeholder — visual noise that also steals ~296px
(`--inspector-w`) of width from read-only dashboards, forms, and focused work sessions.

This change makes the Inspector **route-conditional**, mirroring the existing `hideTopbar`
precedent: a tested pure predicate decides per route whether the Inspector mounts. Because
`.app-shell` is a flexbox row (not a grid) and the Inspector is a `flex: none` sibling next to the
`flex: 1` main column, simply not rendering it lets the work area reclaim the width with **no CSS
change and no leftover gap**. Entering a hide-route also clears any inherited element selection, so
the global element actions never operate on an element the user can no longer see.

The decision of *which* routes show it is the substance of this task and is grounded in a per-route
analysis of which screens (or their descendants) actually use the Inspector — drive
`useSelection().select(...)`, inject via `useLibraryInspectorPanel` / `useInboxTriagePanel`, or call
`requestInspectorRefresh()`. The split is **11 SHOW / 13 HIDE**.

---

## Problem Frame

- **Today:** `ShellInner` renders `<Inspector />` once, after the `.shell-main` column, on every
  route (`apps/web/src/shell/Shell.tsx:690`). The `Inspector` component itself always returns its
  `<aside data-testid="inspector">` and, when nothing is selected, an empty placeholder + element
  picker (`apps/web/src/components/inspector/Inspector.tsx:3091`, `:3150-3161`).
- **Consequence:** On routes that never select anything (Settings, Analytics, Trash, Maintenance,
  Concepts, Weekly, Convert, the transient Synthesis-create screen), the panel is permanently empty —
  it adds no information and narrows the work area.
- **Goal:** Show the Inspector only where a screen actually uses it; hide it everywhere else, letting
  the main column expand. Keep all selection/command-palette/global-action wiring intact (those live
  in context above the Inspector and must not regress), and clear an inherited selection on
  hide-route entry so no invisible element remains the target of global actions.

### Scope Boundaries

- **In scope:** A route→visibility predicate; gating the `<Inspector />` mount in `ShellInner`;
  clearing a stale selection on hide-route entry; unit tests for the predicate and the shell wiring;
  updating the e2e specs' inspector assertions to be route-aware; a light visual check that
  hide-routes look correct at full width.
- **Out of scope (non-goals):**
  - Changing the Inspector's internal contents, the selection model itself, or the context bridges.
  - Removing or refactoring the empty-placeholder/element-picker. It still appears on SHOW routes
    when nothing is selected — that is correct behavior there, and the picker remains reachable on
    the 11 SHOW routes (Home, Queue, Process, the readers, Library, Search, Review), so the
    "browse-and-inspect an arbitrary element" affordance is not lost.
  - Animating the panel's appearance/disappearance, a user collapse/expand toggle, or responsive
    breakpoints (see the reflow decision in KTD3).
  - Re-laying-out any hide-route screen beyond fixing an obvious full-width regression if one is
    found during verification.

#### Deferred to Follow-Up Work

- If a hide-route screen needs a proper max-width content container rather than a trivial fix to look
  right at full width, capture it as its own task rather than expanding this one.
- Capturing the route-conditional-Inspector decision as a `docs/solutions/` learning (a good
  `ce-compound` candidate once this lands).

---

## The Decision: which routes show the Inspector

The verdict per route is whether the screen **or any of its descendants** drives Inspector usage
**today** — drives a selection, injects a panel into the Inspector, or refreshes it. This is a
current-state criterion, not a judgment that a HIDE route could *never* benefit from element details.
Two HIDE routes already surface element detail through their own UI (`/concepts` drills into the
reader; the others are read-only dashboards or forms); if a future direction consolidates element
detail into the shell Inspector, those routes would simply move to SHOW — the hide-list is reversible
policy, not a ceiling.

The complete set of selection-driving files was found by grepping the entire `apps/web/src` tree for
`select(` callers (not just route components — selection is a context write any descendant can
perform, which is why `/card` qualifies via its `CardDetailPanel` child).

| Route | Component(s) | Uses Inspector? (evidence) | Verdict |
| --- | --- | --- | --- |
| `/` | HomeScreen | Drives selection — selects resume source + top-due rows | **SHOW** |
| `/inbox` | InboxScreen | Drives selection + injects triage cluster via `useInboxTriagePanel` | **SHOW** |
| `/queue` | QueueScreen | Drives selection on row click | **SHOW** |
| `/process` | ProcessQueue | Drives selection per item + `requestInspectorRefresh` | **SHOW** |
| `/source/$id` | SourceReader | Selects the source; "reuses the shell's right panel" | **SHOW** |
| `/extract/$id` | ExtractView | Selects the extract + `requestInspectorRefresh` | **SHOW** |
| `/card/$id` | CardScreen → CardDetailPanel | Child `CardDetailPanel` selects the loaded card; Inspector shows its lineage/scheduler/priority/expiry (complementary to the panel's content edit) | **SHOW** |
| `/synthesis/$id` | SynthesisNote | Selects the note + `requestInspectorRefresh` | **SHOW** |
| `/review` | ReviewScreen | Selects each due card; repair actions drive selection | **SHOW** |
| `/search` | LibraryScreen | Drives selection + injects preview via `useLibraryInspectorPanel` | **SHOW** |
| `/library` | BrowseScreen | Drives selection + injects detail via `useLibraryInspectorPanel` | **SHOW** |
| `/convert` | ConversionSession | No selection anywhere in subtree; focused keyboard work surface | **HIDE** |
| `/weekly` | WeeklyReviewScreen | No selection; focused session | **HIDE** |
| `/synthesis/new` | SynthesisCreate | No selection; transient create form that redirects | **HIDE** |
| `/maintenance` | MaintenanceScreen | No selection; read-only reports + remediation | **HIDE** |
| `/maintenance/leeches` | LeechRemediation | No selection | **HIDE** |
| `/maintenance/retired` | RetiredCards | No selection | **HIDE** |
| `/maintenance/stagnant` | StagnantExtracts | No selection | **HIDE** |
| `/maintenance/reverify` | ReverifyScreen | No selection | **HIDE** |
| `/concepts` | ConceptsScreen | No selection (drills into reader, not the Inspector) | **HIDE** |
| `/trash` | TrashScreen | No selection; own restore/purge actions | **HIDE** |
| `/analytics` | AnalyticsScreen | No selection; read-only dashboard | **HIDE** |
| `/analytics/sources` | SourceYield | No selection; read-only dashboard | **HIDE** |
| `/settings` | Settings | No selection; preferences form | **HIDE** |

**Modeling choice — hide-list, not show-list.** The predicate is expressed as the set of HIDE routes
(everything else shows the Inspector). Rationale:

- It mirrors the established `hideTopbar` precedent (a route hide-list), keeping the two route-aware
  shell decisions structurally consistent.
- The failure mode for a *forgotten* route is benign and matches today's behavior: an unlisted future
  route shows the Inspector (empty placeholder until it selects), exactly as now. A show-list would
  instead make a new selection-driving screen *silently lose* its detail panel — a real regression.
  Hide-list fails safe.

---

## Key Technical Decisions

### KTD1 — Gate the mount in `ShellInner`, never inside `Inspector`
The `Inspector` component always returns its `<aside>`; visibility must be decided by the parent, so
`ShellInner` conditionally renders `{showInspector ? <Inspector /> : null}` exactly as it does
`{hideTopbar ? null : <Topbar … />}`. This keeps `Inspector` a dumb, always-rendering panel and puts
route policy in one place.

### KTD2 — A pure, unit-tested predicate in `nav.ts` (not an inline `pathname === …` chain)
`hideTopbar` is an inline two-route equality because it is trivial (`/queue || /process`, no
families). This decision spans 13 hide routes including dynamic-param families (`/maintenance/*`,
`/analytics/*`) and one exact-vs-family distinction (`/synthesis/new` hides but `/synthesis/$id`
shows). An inline boolean would be ~20 OR-clauses with real family-bleed risk; that complexity earns
a pure function alongside `resolveActiveNavId` in `apps/web/src/shell/nav.ts`, tested in
`nav.test.ts`. Matching rule: an exact-match set plus a small family-prefix list, using
`pathname === base || pathname.startsWith(`${base}/`)` for families so a family never bleeds onto a
sibling (e.g. `/synthesis/new` must hide while `/synthesis/$id` shows; a `startsWith("/synthesis")`
would wrongly hide both, so `/synthesis/new` is an *exact* entry, never a family).

### KTD3 — No CSS / token changes; accept the instantaneous reflow
`.app-shell` is `display: flex` with the Inspector as a `flex: none; width: var(--inspector-w)` child
and `.shell-main` as `flex: 1; min-width: 0` (`apps/web/src/shell/shell.css`). Unmounting the flex
child lets the main column reclaim the width automatically — no grid track to collapse, no gap. We
touch **no** CSS and **no** layout tokens.

On a SHOW↔HIDE navigation the main column's width changes by ~296px in one frame. We **accept this
instantaneous reflow without animation**, because it co-occurs with a full route content swap (the
`<Outlet>` replaces the entire screen on navigation): the width change rides the page transition
rather than being an in-place jolt, so there is no jarring shift of stable content. Animating would
require keeping the panel mounted and transitioning its width to zero — added complexity for a
transition the content swap already masks — so it stays out of scope.

### KTD4 — Keep all selection/global wiring mounted unconditionally
`SelectionProvider`, the panel-bridge providers, `useGlobalActions`, the `⌘K` palette, and
`useShellShortcuts` already wrap/live in `ShellInner` independently of `<Inspector />`. They stay
mounted on hide-routes, matching how `hideTopbar` keeps the palette + g-nav alive.

### KTD5 — Clear the selection on hide-route entry
Selection state lives in `SelectionProvider` with no route-awareness, so a selection made on a SHOW
route persists when navigating to a HIDE route. Without the Inspector there is then no UI showing
*which* element is selected, yet the global element actions (`o` open-source, `+`/`-` priority via
shortcut or `⌘K`) would still target it — letting a user fire a logged `update_element` mutation
against an element they can no longer see. To prevent this, `ShellInner` clears the selection when on
a hide-route (`select(null)` while `!showInspector`). This is race-free precisely because every HIDE
route is selection-free (verified by the tree-wide `select(` sweep) — no hide-route screen re-sets a
selection that the clear would fight. Re-entering a SHOW route lets that screen establish its own
selection as before.

---

## Implementation Units

### U1. Route-visibility predicate in `nav.ts`

**Goal:** Add an exported pure function returning whether the Inspector is hidden for a pathname,
encoding the hide-list from the decision table.

**Requirements:** Implements the SHOW/HIDE decision (the core of the task).

**Dependencies:** none.

**Files:**
- `apps/web/src/shell/nav.ts` (add `isInspectorHidden` — or equivalently named — pure function + the
  hide-route constants, with a doc comment explaining the hide-list rationale)
- `apps/web/src/shell/nav.test.ts` (unit tests)

**Approach:**
- Exact-match set: `/convert`, `/weekly`, `/synthesis/new`, `/concepts`, `/trash`, `/settings`.
- Family list matched via `pathname === base || pathname.startsWith(`${base}/`)`: `/maintenance`,
  `/analytics`.
- `isInspectorHidden(pathname)` returns `true` if the exact-set has it OR any family matches.
- Mirror the style/placement/doc-comment density of `resolveActiveNavId`. Keep it pure — no React, no
  DOM, no router import.

**Patterns to follow:** `resolveActiveNavId` in `apps/web/src/shell/nav.ts`; the exact-match
discipline in `docs/solutions/ui-bugs/hide-queue-route-shell-topbar.md`.

**Test scenarios** (`apps/web/src/shell/nav.test.ts`):
- Returns `false` (shown) for each SHOW route: `/`, `/inbox`, `/queue`, `/process`, `/review`,
  `/search`, `/library`, and dynamic-param instances `/source/demo-1`, `/extract/demo-1`,
  `/card/demo-1`, `/synthesis/abc-123`.
- Returns `true` (hidden) for each HIDE route: `/convert`, `/weekly`, `/synthesis/new`, `/concepts`,
  `/trash`, `/settings`, `/maintenance`, `/maintenance/leeches`, `/maintenance/retired`,
  `/maintenance/stagnant`, `/maintenance/reverify`, `/analytics`, `/analytics/sources`.
- Family/sibling guards: `/synthesis/new` → hidden but `/synthesis/abc` → shown; `/analytics/sources`
  → hidden but `/` and `/search` → shown; a `/maintenancex` (no such route, proving no false-prefix
  bleed) → shown.
- An unknown/future route (e.g. `/totally-new`) → shown (hide-list fails safe).

### U2. Gate the Inspector mount + clear selection on hide-route entry

**Goal:** Use the predicate to conditionally render `<Inspector />`, and clear an inherited selection
when on a hide-route (KTD5).

**Requirements:** Wires U1 into the shell so the Inspector appears/disappears per route; closes the
invisible-selection footgun.

**Dependencies:** U1.

**Files:**
- `apps/web/src/shell/Shell.tsx` (compute `const showInspector = !isInspectorHidden(pathname);` next
  to `hideTopbar` at ~line 373; change line 690 to `{showInspector ? <Inspector /> : null}`; add the
  import; also destructure `select` from `useSelection()` and add a small effect that clears the
  selection while `!showInspector`)
- `apps/web/src/shell/Shell.test.tsx` (unit tests)

**Approach:** Reuse the single existing `pathname` from `useRouterState` (do not add a second read).
Place the boolean adjacent to `hideTopbar`, mirroring its comment style. Gate only the `<Inspector />`
line. For KTD5, add an effect such as `useEffect(() => { if (!showInspector && selectedId)
select(null); }, [showInspector, selectedId, select]);`. Leave the providers, palette, shortcuts,
toasts, and onboarding layers untouched.

**Patterns to follow:** `hideTopbar` (`apps/web/src/shell/Shell.tsx:373`, `:683`).

**Test scenarios** (`apps/web/src/shell/Shell.test.tsx`, flipping the hoisted `h.pathname` knob and
asserting on the `mock-inspector` testid, exactly like the existing `hideTopbar` tests):
- Shows the Inspector on SHOW routes: `h.pathname = "/queue"`, `"/"`, `"/library"`, `"/card/x"` →
  `getByTestId("mock-inspector")` present.
- Hides the Inspector on HIDE routes: `h.pathname = "/settings"`, `"/analytics"`,
  `"/maintenance/leeches"` → `queryByTestId("mock-inspector")` absent.
- Independence guard: on `/settings` the command-bar (topbar) is present while the Inspector is
  absent — proving the two route decisions are independent.
- Integration: the route `<Outlet>` (`route-outlet` testid) still renders on a hide route.
- Selection clearing (KTD5): with a non-null selection seeded, rendering on a hide route invokes
  `select(null)` (assert via the selection-context mock/spy); rendering on a SHOW route does not
  clear it.

### U3. Route-aware e2e smoke inspector assertion

**Goal:** `tests/e2e/smoke.spec.ts`'s `expectShell` asserts the Inspector visible on every looped
route; after this change `/settings` (in that loop) must show it **absent**, or the suite fails.

**Requirements:** Keeps the Definition-of-Done e2e gate green and adds positive coverage that the
Inspector is correctly absent on a hide route.

**Dependencies:** U2.

**Files:**
- `tests/e2e/smoke.spec.ts` (add an `inspector?: boolean` option to `expectShell`, mirroring the
  existing `commandBar?` option; pass it per route so `/settings` expects the Inspector absent and the
  other looped routes — `/`, `/inbox`, `/queue`, `/source/demo-1`, `/review`, `/search` — expect it
  present)

**Approach:** Mirror the established `commandBar` route-conditional pattern already in `expectShell`
(`options.commandBar !== false ? expect(...).toBeVisible() : expect(...).not...`). Add symmetric
`inspector` handling, then pass `{ inspector: url !== "/settings" }` (keeping the existing
`commandBar` condition) in the `ROUTES` loop.

**Patterns to follow:** the `commandBar` option in `expectShell` and the `{ commandBar: url !==
"/queue" }` call-site pattern in `tests/e2e/smoke.spec.ts`.

**Test scenarios:**
- Looped SHOW routes continue to assert the Inspector visible.
- `/settings` asserts the Inspector absent.
- The rest of `expectShell` is unchanged.

**Verification:** `pnpm e2e` smoke suite passes; the `/settings` iteration proves absence.

### U4. Inspector-assertion audit across the whole test suite + full-width visual check

**Goal:** Ensure no test asserts Inspector presence on a now-hidden route, and that hide-route screens
look correct when the work area expands to full width (light + dark).

**Requirements:** No silent test breakage; no visual regression from the reclaimed width.

**Dependencies:** U2.

**Files:**
- (audit only) every test referencing the Inspector. The repo research initially narrowed e2e usage
  to `tests/e2e/smoke.spec.ts`, but that is incomplete: ~18 specs under `tests/electron/`
  (`inspector.spec.ts`, `lineage*.spec.ts`, `priority.spec.ts`, `verification-tasks.spec.ts`,
  `source-reliability.spec.ts`, `schedule-explainability.spec.ts`, `concepts-tags.spec.ts`,
  `analytics.spec.ts`, `staleness-expiry.spec.ts`, `fallow-topic.spec.ts`, `related-items.spec.ts`,
  `contradiction.spec.ts`, `keyboard.spec.ts`, `search.spec.ts`, `library.spec.ts`, `mvp-flow.spec.ts`,
  `extraction.spec.ts`, `lineage-context-menu.spec.ts`) drive the Inspector via `inspector-content` /
  `inspector-title` / `element-picker` / `.shell-inspector`. The audit must reconcile each against the
  route it runs on.

**Approach:**
- Grep across `tests/e2e/`, `tests/electron/`, and `apps/web/src` for **all** Inspector signals —
  not only `getByTestId("inspector")` / `mock-inspector` / `data-testid="inspector"`, but also
  `inspector-content`, `inspector-title`, `.shell-inspector`, `element-picker`. For each hit, confirm
  the spec operates on a SHOW route (e.g. `concepts-tags`/`fallow-topic` act on source/topic via
  `/source` or `/library`, not `/concepts`; `analytics.spec.ts` must not assert the Inspector on
  `/analytics`). Fix or note any that would break.
- Run the app (`pnpm dev`) and spot-check the hide routes most likely to widen unattractively —
  **Settings, Analytics (`/analytics`), and a Maintenance view** — in light and dark. Acceptance: the
  content body stays within a sensible measure (already has a max-width/centering container) rather
  than stretching edge-to-edge. If a screen is clearly stretched and the fix is trivial and in-scope,
  apply it; otherwise defer per Scope Boundaries.

**Test scenarios:** `Test expectation: none — this unit is an audit + manual visual verification, not
a behavioral change. Behavioral coverage lives in U1–U3.`

**Verification:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` all green; manual screenshots
of the named hide routes look correct in both themes.

---

## System-Wide Impact

- **Renderer only.** No IPC, no `packages/*`, no DB, no main-process change. The renderer-boundary
  rules (`apps/web/CLAUDE.md`) are unaffected — pure UI composition.
- **Design-system note.** The immutable kit (`design/kit/app/shell.jsx`) treats the Inspector as
  permanent chrome; making it route-conditional is a deliberate product departure (the kit is not
  edited). No tokens or px change, so `design/AGENTS.md` token rules remain satisfied.
- **Reversible policy, not capability loss.** Because selection and the panel bridges stay mounted, a
  future "inspect from anywhere" direction would simply shrink the hide-list — no architectural
  unwind.
- **Deep-link safety.** On a cold deep-link straight to a hide route the Inspector never mounts and
  `selectedId` starts null, so the persisted-selection case does not arise; no hide-route screen
  depends on Inspector-side fetches (`listInspectableElements`/`listConcepts`), so nothing
  assumed-present is missing.
- **Behavioral parity.** Selection, `⌘K` element actions, and global shortcuts continue to function on
  SHOW routes; on hide-routes the selection is cleared (KTD5) so those actions have no stale target.

## Risks & Mitigations

- **Risk:** A hide-route screen looks stretched at full width. **Mitigation:** U4 visual check of the
  named screens; trivial fix in-scope, larger re-layout deferred.
- **Risk:** A test asserts the Inspector on a now-hidden route. **Mitigation:** U4 audits the full
  `tests/electron/` + `tests/e2e/` surface with broadened grep terms (not just the smoke spec).
- **Risk:** Family prefix bleeds onto a sibling (e.g. hiding `/synthesis/$id`). **Mitigation:**
  exact-vs-family matching in U1 with explicit sibling-guard tests.
- **Risk:** Unmount/navigation leaves dangling state. **Mitigation:** the Inspector already tears down
  cleanly — its fetches are guarded by `cancelled` flags and it removes the `INSPECTOR_REFRESH_EVENT`
  listener on unmount, so no fetch resolves into a dead component and no listener leaks. The genuine
  residual was the persisted `selectedId` outliving the hidden UI, which KTD5 now clears on hide-route
  entry.

## Verification (Definition of Done)

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test` (new `nav.test.ts` + `Shell.test.tsx` cases, incl. selection-clearing)
4. `pnpm e2e` (smoke suite with the route-aware inspector assertion; full `tests/electron/` audit)
5. Manual: named hide routes look correct full-width in light + dark.

## Sources & Research

- Tree-wide `select(` sweep establishing the 11 selection-driving routes (incl. `/card` via
  `CardDetailPanel`).
- `apps/web/src/shell/Shell.tsx` (`hideTopbar` precedent, render order, providers, `useSelection`).
- `apps/web/src/shell/shell.css` (`.app-shell` flex; `.shell-main` flex:1; `.shell-inspector`
  flex:none/width token).
- `apps/web/src/shell/nav.ts` (`resolveActiveNavId` pure-function convention).
- `apps/web/src/shell/Shell.test.tsx` (mock-inspector stub; `h.pathname` knob; hideTopbar tests).
- `apps/web/src/review/CardDetailPanel.tsx` (child driving selection on `/card`).
- `tests/e2e/smoke.spec.ts` (`expectShell` + `commandBar` route-conditional precedent) and
  `tests/electron/*.spec.ts` (~18 specs asserting on the Inspector).
- `docs/solutions/ui-bugs/hide-queue-route-shell-topbar.md` (omit-don't-CSS-hide; exact match; test
  both sides).
- `docs/solutions/architecture-patterns/relocate-screen-ui-into-shell-inspector-context-bridge.md`
  (Library/Inbox inject into the Inspector — must stay in the show-set).

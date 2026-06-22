---
title: "Route-conditional shell Inspector: a tested predicate, flexbox auto-collapse, and selection clearing"
date: "2026-06-22"
category: "docs/solutions/architecture-patterns/"
module: "apps/web shell Inspector + nav route gating"
problem_type: "architecture_pattern"
component: "frontend_stimulus"
severity: "low"
applies_when:
  - "Showing or hiding always-mounted shell chrome (inspector, rail, panel) per route"
  - "Deciding which routes a selection-driven shell panel is useful on"
  - "Auditing whether a route uses a shared panel — selection can be driven by any descendant, not just the route screen"
  - "A persisted selection (or similar global state) could outlive the UI that displays it when chrome is hidden"
related_components:
  - "apps/web/src/shell/nav.ts"
  - "apps/web/src/shell/Shell.tsx"
  - "apps/web/src/shell/selection.tsx"
  - "apps/web/src/components/inspector/Inspector.tsx"
  - "tests/e2e/smoke.spec.ts"
tags: [shell, inspector, route-conditional, selection, flexbox, nav]
---

# Route-conditional shell Inspector: a tested predicate, flexbox auto-collapse, and selection clearing

## Context

The shell's right-hand Inspector (`<aside className="shell-inspector">`) was rendered
unconditionally in `ShellInner` on every route. It is selection-driven: when nothing is selected it
shows only an empty "Select an element…" placeholder. On routes whose screens never drive a
selection (Settings, Analytics, Trash, Maintenance, Concepts, Weekly, Convert, the transient
Synthesis-create form), that placeholder is permanent visual noise that also consumes ~296px
(`--inspector-w`) of work-area width. We made the Inspector route-conditional — shown only where it
is used — extending the existing `hideTopbar` route-conditional-chrome precedent
(`docs/solutions/ui-bugs/hide-queue-route-shell-topbar.md`) from the topbar to the right column.

## Guidance

Four pieces, each with a non-obvious detail worth keeping.

**1. A pure, tested predicate in `nav.ts`, not an inline boolean.** `hideTopbar` is an inline
two-route equality (`pathname === "/queue" || pathname === "/process"`) because it is trivial. The
Inspector spans more routes including dynamic-param families and an exact-vs-family distinction, so
it earns a pure function next to `resolveActiveNavId`, unit-tested in `nav.test.ts`:

```ts
const INSPECTOR_HIDDEN_EXACT: ReadonlySet<string> = new Set([
  "/convert", "/weekly", "/synthesis/new", "/concepts", "/trash", "/settings",
]);
const INSPECTOR_HIDDEN_FAMILIES: readonly string[] = ["/maintenance", "/analytics"];

export function isInspectorHidden(pathname: string): boolean {
  if (INSPECTOR_HIDDEN_EXACT.has(pathname)) return true;
  return INSPECTOR_HIDDEN_FAMILIES.some((base) => matchesRouteFamily(pathname, base));
}
```

Model it as a **hide-list, not a show-list** — like `hideTopbar`. A forgotten/future route then keeps
the Inspector (the benign default that matches the old always-on behavior); a show-list would instead
make a new selection-driving screen *silently lose* its panel. The hide-list fails safe.

`/synthesis/new` is an **exact** entry, never a family: a `startsWith("/synthesis")` would wrongly hide
the selection-driving `/synthesis/$id` editor too. Family matching shares one boundary-safe helper with
`resolveActiveNavId` so the rule has a single definition:

```ts
// exact base, or a `${base}/…` child — the trailing slash stops `/maintenance`
// from bleeding onto a same-prefix sibling like `/maintenancex`.
function matchesRouteFamily(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}
```

**2. Gate the mount in the parent; flexbox reclaims the width for free.** The `Inspector` component
always returns its `<aside>`, so visibility is decided by the parent: `{showInspector ? <Inspector /> :
null}` in `ShellInner`, mirroring `{hideTopbar ? null : <Topbar />}`. **No CSS or token change is
needed** because `.app-shell` is `display: flex` (not grid) and the Inspector is a `flex: none; width:
var(--inspector-w)` sibling next to the `flex: 1` main column — unmounting the flex child lets the main
column reclaim the width automatically, with no leftover gap. (A CSS-grid layout with a fixed third
track would instead leave a dead 296px column; verify the layout primitive before assuming a hide is
free.)

**3. The hide/show decision criterion is "any descendant drives the panel today," not "the route screen
selects."** A per-route map built only from top-level screen components under-counts, because selection
is a context write any descendant can perform. `/card`'s screen (`CardScreen`) never selects, but its
grandchild `CardDetailPanel` calls `select(loadedCardId)` — so the Inspector there shows the card's
lineage/scheduler/priority/expiry as a *complementary* panel, and `/card` is a SHOW route. Build the
map by grepping the whole `apps/web/src` tree for `select(` callers (plus `useLibraryInspectorPanel` /
`useInboxTriagePanel` injectors), not just route components.

**4. Clear the inherited selection on hide-route entry.** Selection lives in `SelectionProvider` with no
route-awareness, so it persists across navigation. On a hide-route the Inspector is gone, but the global
element actions (open-source, raise/lower priority via shortcut or ⌘K) stay mounted and would still
target the persisted selection — letting a user fire a logged `update_element` against an element they
can no longer see. Clear it on entry:

```ts
useEffect(() => {
  if (!showInspector && selectedId !== null) select(null);
}, [showInspector, selectedId, select]);
```

This is **race-free precisely because every hide-route is selection-free** (verified by the tree-wide
`select(` sweep): no hide-route screen re-sets a selection the clear would fight. The parent-effect /
child-effect ordering trap (React fires child effects before parent effects, so a parent `select(null)`
could clobber a child's `select(id)`) cannot bite here because the effect is gated on `!showInspector`
and no SHOW route is ever hidden. `select` is the raw `useState` setter (React-stable), so the dependency
never re-fires spuriously.

## Why This Matters

- **The freed-width win is only free under flexbox.** Conflating "hide the chrome" with "the layout
  collapses" is the trap — a fixed grid track does not collapse. Knowing `.app-shell` is flex is what
  let this ship with zero CSS change.
- **The descendant criterion is the subtle correctness point.** A naive screen-level audit would have
  classified `/card` as a hide route and deleted a complementary lineage/scheduler/priority/expiry panel
  that users rely on. The bug was invisible until the selection-driver sweep covered child components.
- **Hiding chrome can silently weaponize global state.** The persisted-selection footgun is the kind of
  defect that only surfaces as "I changed an element's priority and didn't realize which one." Clearing
  on hide-route entry closes it; the clear is safe only because the hide-set is provably selection-free.

## When to Apply

- Making any always-mounted, selection/context-driven shell panel route-conditional.
- Deciding the SHOW/HIDE set for such a panel — audit by *who writes the driving state anywhere in the
  subtree*, not by the route component alone.
- Whenever hiding a surface that displays a piece of global state, ask: does an action elsewhere still
  read that state while its display is gone? If so, clear or gate it.

## Examples

Route decision (this change): **HIDE** (13, none drive selection) `/convert`, `/weekly`,
`/synthesis/new`, `/maintenance` (+ children), `/concepts`, `/trash`, `/analytics` (+ `/analytics/sources`),
`/settings`. **SHOW** (11, a screen or descendant drives the panel) `/`, `/inbox`, `/queue`, `/process`,
`/source/$id`, `/extract/$id`, `/card/$id`, `/synthesis/$id`, `/review`, `/search`, `/library`.

Testing both sides (mirrors the `hideTopbar` precedent's "test presence and absence"):
- `nav.test.ts` — `isInspectorHidden` over every SHOW/HIDE route, the `/synthesis/new`-vs-`/synthesis/$id`
  split, family-boundary non-bleed (`/maintenancex` shows), and the fail-safe unknown route.
- `Shell.test.tsx` — inspector mounts on SHOW routes / unmounts on HIDE routes (independent of the
  topbar), selection cleared on a show→hide navigation, and *not* cleared on a show route or when nothing
  is selected.
- `tests/e2e/smoke.spec.ts` — each route carries its inspector expectation in the `ROUTES` tuple (so the
  assertion can't silently desync as routes are added), exercising the real unmount on `/settings`,
  `/analytics`, and `/trash`.

## Related

- `docs/solutions/ui-bugs/hide-queue-route-shell-topbar.md` — the topbar precedent for route-conditional
  shell chrome (omit don't CSS-hide; exact match not loose prefix; keep global wiring mounted; test both
  sides). Same pattern family, complementary angle (topbar height vs. Inspector column width).
- `docs/solutions/architecture-patterns/relocate-screen-ui-into-shell-inspector-context-bridge.md` —
  which screens inject UI *into* the Inspector (Library/Search, Inbox triage). Those routes must stay in
  the SHOW set; before relocating UI into the Inspector, confirm the target route is not inspector-hidden.
- `docs/solutions/design-patterns/shell-status-hint-page-publishes-chrome-context.md` — the complementary
  direction (a page pushes chrome up into the shell), forming a triad with the two docs above.

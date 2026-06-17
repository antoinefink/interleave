---
title: "fix: Reader/session-view UI polish (command bar, footer shortcuts, vault chrome, convert tooltip, gutter scroll, clickable links)"
type: fix
date: 2026-06-17
status: ready
depth: standard
origin: none (direct request, screenshots)
---

# fix: Reader/session-view UI polish

## Summary

Six small, bounded UI fixes to the Interleave desktop renderer (`apps/web/`), all observed on the
**process session view** (`/process` route → `ProcessQueue` → `ProcessCard`) and the shared reader
chrome:

1. Remove the top command/search bar on the `/process` session view to reclaim vertical space.
2. Move the per-session action-hint row (`d done · p postpone · …`) out of the card and into the
   existing bottom status-bar row, where the global shortcut hints already live.
3. Remove the "Local vault · offline-first" chrome text everywhere it appears as persistent chrome.
4. Add a concise tooltip to the "Convert now" button and re-pin the floating suggestion bar to a
   balanced bottom-right corner.
5. Fix mouse-wheel scrolling when the cursor is over the empty left/right gutter zones beside the
   reader text in the process card.
6. Make anchor links inside rendered reader content clickable (open externally).

This is presentation/chrome work in the renderer only. No domain logic, no IPC surface, no schema or
persistence changes. The one cross-package touch is the shared editor (`packages/editor/`) for
clickable links, which fixes both the standalone reader and the process card in one place.

---

## Problem Frame

The process session reader is the primary "do the work" surface, and several chrome details are
costing vertical space or are outright broken:

- The global command/search bar sits at the top of `/process`, eating a row of vertical space on the
  one screen where reading area matters most. (The `/queue` route already hides it; `/process` does
  not.)
- Two stacked footer rows — the card's `.pq-keys` action hints and the shell `StatusBar` — duplicate
  "footer" real estate. Collapsing them into one row reclaims a line for the article.
- "Local vault · offline-first" is honest but redundant chrome that the user finds cluttering.
- The "Convert now" suggestion bar floats in the lower-right *quadrant* rather than hugging the
  corner, and the button gives no hint about what converting does.
- Wheel scrolling dies when the pointer is over the wide empty side-gutters of the process-card
  reader, because the scroll owner is the narrow (~720px) text column, not a full-width container.
- In-content anchors render as `<a>` but never navigate, because the editor's link mark is
  `openOnClick: false` and the reader runs the editor in `editable` mode.

---

## Requirements

- **R1** — On `/process`, the top command/search bar (`.shell-topbar` / `data-testid="command-bar"`)
  is not rendered; the `--topbar-h` row is reclaimed. The `⌘K`/`/` command palette and `G`/`?`
  shortcuts still work (chrome removed, behavior preserved).
- **R2** — The process-session action hints render in the bottom status-bar row (not as a separate
  card row). The standalone `.pq-keys` row is removed. Hints appear only during an active session and
  reflect the current item (card vs. attention item, undo availability).
- **R3** — "Local vault · offline-first" no longer appears as persistent chrome (status bar + sidebar
  user menu). Conceptual/onboarding explanations of offline-first (Welcome modal, help-center prose)
  are left intact — they explain the product, they are not per-page chrome.
- **R4** — The "Convert now" button has a concise tooltip explaining the action. The suggestion bar
  is pinned to the bottom-right corner with symmetric (equal) `right`/`bottom` insets, clearly in the
  corner and not overlapping the bottom action toolbar.
- **R5** — Mouse-wheel scrolling works when the cursor is anywhere over the process-card reader,
  including the empty left/right gutter zones beside the centered text.
- **R6** — Clicking an anchor link inside rendered reader content opens the link externally (new tab
  / system browser), in both the standalone reader and the process card, without breaking
  editing/selection behavior. The constrained ProseMirror render path is preserved (no raw HTML).

---

## Key Technical Decisions

- **KTD1 — Hide the topbar by extending the existing `hideTopbar` route check, not by CSS.** Mirror
  the documented `/queue` precedent (`docs/solutions/ui-bugs/hide-queue-route-shell-topbar.md`): omit
  the `<Topbar>` element on the exact `/process` route so `--topbar-h` is reclaimed; keep
  `useShellShortcuts` and `CommandPalette` mounted unconditionally. CSS-hiding `.shell-cmdbar` is
  wrong — it leaves the row height reserved. Use an exact match (`pathname === "/process"`), not a
  prefix.

- **KTD2 — Bridge session hints into the status bar via a small shell context, modeled on
  `SelectionProvider`.** There is no existing slot/portal for a page to publish into the shell
  `StatusBar`. Add a minimal `StatusHintProvider` (context) exposing a setter; `ProcessCard` publishes
  its computed hint content via an effect (clearing on unmount), and `StatusBar` renders it on the
  right — exactly where the removed vault text was (R3 frees that space, so R2 depends on R3). This
  keeps domain/session logic in `ProcessCard` and keeps `StatusBar` a dumb consumer. Rejected
  alternative: lifting session state to `Shell` and prop-drilling — `ProcessQueue` is an `Outlet`
  child, so context is the idiomatic bridge.

- **KTD3 — Fix gutter scroll by mirroring the standalone reader's scroll structure in the process
  card.** Make a full-width element own vertical scroll (so the side gutters are inside the scroll
  hit-area, like `.reader-page`) and apply the ~720px `--reader-text-measure` + centering to an inner
  element (like `.reader-rail`). Today the measure sits on `.pq-source__rail`, an *ancestor* of the
  scroll owner (`.pq-source__editor .reader`), which makes the scroller narrow. Rejected alternative:
  attaching `wheel` listeners to the gutters and forwarding `scrollTop` — fragile, fights native
  scrolling, and diverges from the single-scroll-owner contract in
  `docs/solutions/ui-bugs/source-reader-scroll-extents-rich-source-rendering.md`.

- **KTD4 — Make links clickable in the shared editor, gated on `readerDecorations`, not per-reader.**
  Both reader surfaces render the same `SourceEditor` with `readerDecorations`. Add anchor-click
  handling in `packages/editor/` that, in reader mode, opens `a[href]` externally and prevents the
  default editable-caret behavior. This fixes both surfaces once. Keep the schema's `openOnClick:
  false` (so plain editing never navigates); the reader-mode handler is the controlled opt-in. Open
  via the established `target="_blank" rel="noreferrer noopener"` / `window.open(..., "noopener")`
  convention (Electron's `setWindowOpenHandler` routes `http(s)` to `shell.openExternal`) — no new
  IPC. Preserve the constrained render path (no raw imported HTML).

- **KTD5 — Reposition the suggestion bar with viewport-relative, symmetric insets and a clamp.** Per
  `docs/solutions/ui-bugs/large-selection-toolbar-visible-viewport-anchoring.md`, fixed reader
  overlays use viewport coordinates. Reduce `--atomic-extract-prompt-inset` to a small, balanced
  value so equal `right`/`bottom` insets place it cleanly in the corner; keep `--shadow-lg` (it floats
  — `docs/solutions/conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md`). Verify the
  final inset visually so it clears the bottom action toolbar.

- **KTD6 — Update CSS-contract and shell tests in lockstep.** `process-queue-css.test.ts`,
  `shell-css.test.ts` / `reader-css.test.ts`, and `Shell.test.tsx` assert the literal CSS/markup being
  changed (e.g. `.pq-source__rail { max-width … }`, the status-bar vault hint). These are contracts to
  update with the change, not regressions. Also reconcile the help-center body that documents the
  literal status-bar footer copy (`apps/web/src/help/help-bodies.ts`).

---

## Scope Boundaries

In scope: the six changes above, their tests (unit + CSS-contract + Electron E2E where user-facing),
and lockstep updates to help-center chrome copy that documents the literal status-bar string.

Out of scope (true non-goals):
- Changing what "Convert now" *does* (conversion logic / `/convert` session) — tooltip + position only.
- Changing the global command palette / shortcut behavior — chrome only (R1).
- Removing offline-first as a *concept* from onboarding or help prose (R3 keeps these).
- `LOCAL_VAULT_LABEL` in `apps/web/src/shell/identity.ts` (the vault display-name fallback, a
  different concept from the "· offline-first" chrome).

### Deferred to Follow-Up Work
- None.

---

## Implementation Units

### U1. Hide the command/search bar on the `/process` session route

**Goal:** Reclaim the top `--topbar-h` row on the process session view (R1).

**Requirements:** R1.

**Dependencies:** none.

**Files:**
- `apps/web/src/shell/Shell.tsx` — `hideTopbar` (≈ line 379).
- `apps/web/src/shell/Shell.test.tsx` — route-conditioned topbar assertions.

**Approach:** Extend the existing exact-match check from `pathname === "/queue"` to also cover
`"/process"` (e.g. a small set/array membership check). Leave `useShellShortcuts` + `CommandPalette`
mounted unconditionally (they already are). Confirm `/source/$id` and other routes are unaffected.

**Patterns to follow:** `docs/solutions/ui-bugs/hide-queue-route-shell-topbar.md`; the existing
`/queue` branch.

**Test scenarios:**
- On `/process`, `command-bar` testid is absent and `--topbar-h` chrome is not rendered.
- On `/queue`, topbar still absent (unchanged).
- On `/source/$id` (and a default route), topbar still present.
- With the topbar hidden on `/process`, the command-palette open handler / `?` shortcut path still
  fires (assert the palette can still be opened — mirror the precedent's both-sides test).

**Verification:** `Shell.test.tsx` green; manual: `/process` shows no top search bar, `⌘K` still opens
the palette.

### U2. Remove "Local vault · offline-first" persistent chrome

**Goal:** Remove the redundant chrome string from the status bar and sidebar user menu (R3).

**Requirements:** R3.

**Dependencies:** none. (U3 builds on the freed status-bar right side.)

**Files:**
- `apps/web/src/shell/Shell.tsx` — `StatusBar` (≈ line 360-362) and the user-menu status line
  (≈ line 303-306).
- `apps/web/src/shell/shell.css` — `.shell-usermenu__status` / status-bar spacer rules if they become
  dead after removal.
- `apps/web/src/shell/Shell.test.tsx` — vault-hint assertion (≈ line 339).
- `apps/web/src/help/help-bodies.ts` — only the passage documenting the literal status-bar footer copy.

**Approach:** Delete the two chrome occurrences. Keep `.shell-statusbar__spacer` (U3 uses it to push
session hints right) unless it is provably unused. Do **not** touch `WelcomeModal` or conceptual
offline-first help prose. Do **not** touch `LOCAL_VAULT_LABEL` in `identity.ts`.

**Patterns to follow:** existing `StatusBar` markup; the learnings note that this footprint spans
test + help (`Shell.test.tsx`, `help-bodies.ts`).

**Test scenarios:**
- `Shell.test.tsx`: status bar no longer contains "Local vault · offline-first"; the global hint group
  (`⌘K Command`, `G …`, `? Shortcuts`) is still present.
- Sidebar user-menu (`shell-vault-status`) no longer renders the "· offline-first" chrome; the vault
  display name (`LOCAL_VAULT_LABEL`) still renders.

**Verification:** tests green; grep shows no remaining persistent-chrome occurrence of the literal
string (Welcome/help conceptual mentions excepted).

### U3. Move session action hints into the bottom status-bar row

**Goal:** Collapse the two stacked footer rows into one by relocating `ProcessCard`'s `.pq-keys`
hints into the shell `StatusBar` (R2), reclaiming a line for the article.

**Requirements:** R2.

**Dependencies:** U2 (frees the status-bar right region).

**Files:**
- `apps/web/src/shell/statusHint.tsx` *(new)* — minimal context (provider + `useStatusHint` setter +
  consumer hook), modeled on `apps/web/src/shell/selection.tsx`.
- `apps/web/src/shell/Shell.tsx` — wrap `ShellInner` with the provider (alongside `SelectionProvider`);
  `StatusBar` consumes and renders the published hint on the right (after `.shell-statusbar__spacer`).
- `apps/web/src/shell/shell.css` — a `.shell-statusbar__keys` group styled to match existing
  `.shell-statusbar__hint` (small, `--text-3`, kbd chips via tokens).
- `apps/web/src/pages/queue/ProcessQueue.tsx` — `ProcessCard` computes the hint content (the existing
  `isCard` / non-card / `canUndo` variants) and publishes it via effect; remove the `.pq-keys` `<p>`.
- `apps/web/src/pages/queue/process-queue.css` — remove now-dead `.pq-keys` rules.
- `apps/web/src/pages/queue/process-queue-css.test.ts`, `apps/web/src/shell/Shell.test.tsx`,
  `apps/web/src/shell/shell-css.test.ts` — update contracts.
- `apps/web/src/help/help-bodies.ts` — reconcile footer-shortcut documentation if it enumerates rows.

**Approach:** The context holds a `ReactNode | null`. `ProcessCard` sets it in an effect keyed on the
current item / `isCard` / `canUndo`, and clears it on unmount (route change) so other routes show an
empty right side. `StatusBar` renders `{hint}` after the spacer. Keep the keycap visual language
consistent with the status bar (reuse `Kbd` or a `.shell-statusbar__keys kbd` style). Render nothing
when there is no active session.

**Patterns to follow:** `apps/web/src/shell/selection.tsx` (context shape, provider placement); the
status-bar hint markup.

**Test scenarios:**
- Status-bar context: provider renders children; setting a hint exposes it to the consumer; clearing
  resets to null.
- `Shell.test.tsx`: when a hint is published, the status bar renders it on the right; when none, the
  right region is empty.
- `ProcessQueue`: in a source/attention session the published hint contains `d`/`p`/`x`/`o`/`n`
  hints; in a card session it contains the reveal/grade variant; `⌘Z undo` appears only when
  `canUndo`.
- The standalone `.pq-keys` row is no longer rendered in the card.
- `process-queue-css.test.ts` no longer asserts `.pq-keys` (and asserts its removal isn't breaking the
  `.pq-card` flex column).

**Verification:** tests green; manual: `/process` shows one footer row (global hints left, session
hints right); article body gains the reclaimed line.

### U4. Tooltip on "Convert now" + reposition the suggestion bar

**Goal:** Explain the action and pin the bar to a balanced bottom-right corner (R4).

**Requirements:** R4.

**Dependencies:** none.

**Files:**
- `apps/web/src/reader/AtomicExtractPrompt.tsx` — wrap the Convert-now `<button>` with the existing
  `Tooltip` (`apps/web/src/components/Tooltip.tsx`).
- `apps/web/src/reader/AtomicExtractPrompt.css` — adjust `--atomic-extract-prompt-inset` to a small,
  symmetric value; keep `position: fixed; right; bottom` and `--shadow-lg`.
- `apps/web/src/reader/AtomicExtractPrompt.test.tsx` *(new or extend)* — tooltip label + structure.

**Approach:** Tooltip copy must be concise and explain the outcome — recommended:
"Create a review card from this statement" (final wording at implementation; keep it tooltip-short).
Wrap the button (the bubble is `aria-hidden`; keep the button's accessible name). For position, set
equal `right`/`bottom` insets at a modest value (e.g. `var(--s-6)`–`var(--s-8)`) so the bar sits in
the corner; verify the chosen inset visually so it clears the bottom action toolbar and looks
balanced. Clamp to viewport if needed (it already uses `max-width: min(…, calc(100vw - …))`).

**Patterns to follow:** `Tooltip` usage in `apps/web/src/components/queue/ScheduleMenu.tsx` etc.;
viewport-anchoring + clamp learning; shadow-taxonomy learning.

**Test scenarios:**
- Rendering the prompt and hovering/focusing the Convert-now button surfaces a tooltip with the
  concise label; the button retains its accessible name (no double-labeling).
- CSS-contract (if a `*-css.test.ts` exists for this file): `right` and `bottom` use the same inset
  token (symmetric); `position: fixed`; shadow retained.
- Dismiss button behavior unchanged.

**Verification:** tests green; screenshot confirms the bar hugs the bottom-right corner with equal
margins and the tooltip reads clearly.

### U5. Fix gutter wheel-scroll in the process-card reader

**Goal:** Make wheel scrolling work over the empty side-gutters by making a full-width element the
scroll owner (R5).

**Requirements:** R5.

**Dependencies:** none.

**Files:**
- `apps/web/src/pages/queue/process-queue.css` — `.pq-source__rail`, `.pq-source__editor`,
  `.pq-source__editor .reader` scroll/width/centering rules.
- `apps/web/src/pages/queue/ProcessQueue.tsx` — only if a wrapper element is needed to separate the
  full-width scroll owner from the centered measure.
- `apps/web/src/pages/queue/process-queue-css.test.ts` — update the scroll-ownership assertions.

**Approach:** Restructure so vertical scroll is owned by a full-width container (gutters inside it),
with `--reader-text-measure` + `margin: 0 auto` applied to an inner element that holds the editor
content — mirroring `.reader-page` (full-width `overflow-y:auto`) + `.reader-rail` (centered measure).
Concretely: move `overflow-y: auto` off the narrow chain and onto a full-width owner; relocate
`max-width: var(--reader-text-measure)` from the scroll ancestor to the inner content wrapper.
Preserve the single-scroll-owner contract (no second scroller) and the `min-height: 0` chain. Confirm
the standalone `/source/$id` reader is unaffected (its `.reader-page` is already full-width).

**Patterns to follow:** `apps/web/src/pages/source/reader.css` (`.reader-page` / `.reader-rail`);
`docs/solutions/ui-bugs/source-reader-scroll-extents-rich-source-rendering.md`;
`three-zone-scroll-owned-review-card-surface.md` (`min-height:0` chain).

**Test scenarios:**
- CSS-contract: the full-width element owns `overflow-y: auto`; the measure/centering moved to the
  inner element; `min-height: 0` preserved on the chain; exactly one `overflow-y: auto` in the source
  scroll path.
- Electron E2E (extend `tests/electron/source-reader.spec.ts` or a process-session spec): open a long
  source in the process session, dispatch a wheel/scroll with the pointer over a side-gutter zone, and
  assert the content scrolls (scrollTop increases).

**Verification:** tests green; manual: wheel over the left/right empty zones scrolls the article.

### U6. Make in-content anchor links clickable in reader mode

**Goal:** Clicking an anchor in rendered reader content opens it externally, in both reader surfaces
(R6).

**Requirements:** R6.

**Dependencies:** none.

**Files:**
- `packages/editor/src/SourceEditor.tsx` (and/or a small ProseMirror plugin in `packages/editor/src/`)
  — add reader-mode anchor-click handling gated on `readerDecorations`.
- `apps/web/src/pages/source/reader.css` — `.reader a { cursor: pointer }` (and confirm no
  `pointer-events` block) so links read as clickable.
- `packages/editor/src/SourceEditor*.test.tsx` — unit coverage for the handler.
- `tests/electron/` — E2E asserting a content link opens externally (intercept `window.open` /
  new-window handler).

**Approach:** In reader mode, intercept clicks on `a[href]` within the editor content (ProseMirror
`handleClickOn` / `handleDOMEvents.click`, or a `document`-level capture listener mirroring the
highlight/processed-mark handlers in `SourceReader.tsx`). On a modifier-free left click of an anchor,
`preventDefault()` the editable caret placement and open the href externally via the established
new-tab convention (`window.open(href, "_blank", "noopener,noreferrer")`), which Electron's
`setWindowOpenHandler` routes to `shell.openExternal` for `http(s)`. Validate the protocol
(`http(s)` only, reuse `externalHref` semantics from `ExternalUrlLink.tsx`). Keep `openOnClick: false`
in the schema so editing never navigates; the gate is `readerDecorations`. Do not weaken the
constrained render path (no raw HTML).

**Patterns to follow:** `apps/web/src/components/ExternalUrlLink.tsx` (`externalHref`, `target=_blank`,
`rel`); the `document.addEventListener("click", …)` mark handlers in
`apps/web/src/pages/source/SourceReader.tsx`; `apps/desktop/src/main/window.ts` `setWindowOpenHandler`.

**Test scenarios:**
- Editor unit: in `readerDecorations` mode, a left-click on an `a[href="https://…"]` triggers the
  external-open path and prevents default; in plain editable mode (no `readerDecorations`), clicks do
  not navigate (caret behavior preserved).
- Non-`http(s)` / missing href is ignored safely (no open).
- Modifier clicks / text selection still work (don't hijack drag-select).
- Electron E2E: open an imported article with links in the process session, click a link, assert an
  external-open is requested (new-window/`openExternal` intercepted).

**Verification:** tests green; manual: clicking "take a leap" / "mind-numbing jobs" in the reader opens
the URL externally; editing/selection unaffected.

---

## Risks & Dependencies

- **CSS global-leak trap** (`docs/solutions/design-patterns/scope-ported-design-kit-css-under-page-root.md`):
  per-screen CSS is global. Scope new generic classes (e.g. `.shell-statusbar__keys`) under their page
  root; if Biome `noDescendingSpecificity` trips, reorder rather than unscope. Use tokens only — no raw
  px/hex.
- **Shell-scroll coupling**: `.shell-page:has(.source-reader-screen){overflow-y:hidden}` couples shell
  scroll to the reader marker. U5 edits must not disturb the `source-reader-screen` marker or other
  routes' scroll.
- **Contract-test drift**: U2/U3/U5 touch strings asserted by `Shell.test.tsx`, `shell-css.test.ts`,
  `process-queue-css.test.ts`. Update them in the same change; a red contract test here is expected,
  not a regression.
- **Editor change blast radius (U6)**: a `packages/editor/` change affects every `SourceEditor`
  consumer. Gating strictly on `readerDecorations` keeps non-reader editors (extract distillation,
  card editing) unchanged — verify those still place the caret on link click.
- **R2 depends on R3**: the session hints land where the vault text was; sequence U2 before U3.

---

## System-Wide Impact

- **Surfaces affected**: shell chrome (topbar, status bar, sidebar user menu) on all routes; the
  `/process` session view; the standalone `/source/$id` reader (links); the shared editor package.
- **Users**: keyboard-first readers gain vertical space and working scroll/links; no behavior the user
  relied on is removed (palette + shortcuts preserved).
- **Tests**: Vitest unit + `*-css.test.ts` contracts + Electron Playwright (`pnpm test`, `pnpm e2e`).

---

## Verification Strategy

Definition of Done (root `CLAUDE.md`): `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant
`pnpm e2e` (Electron) all green. Manual visual check of the `/process` session: no top search bar; one
footer row; no "offline-first" chrome; Convert-now tooltip + corner-pinned bar; wheel-scroll works
over gutters; content links open externally. Confirm the standalone reader and other routes are
unregressed (topbar present where expected, links clickable, scroll intact).

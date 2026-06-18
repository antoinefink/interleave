---
title: "feat: Relocate the Library open action into the inspector and remove the redundant detail column"
date: "2026-06-18"
type: feat
depth: standard
status: planned
---

# feat: Relocate the Library open action into the inspector and remove the redundant detail column

## Summary

The Library view (`/library` Browse and `/search`) renders a 320px middle "detail"
column (`.lib-detail`) between the elements list and the shared shell `Inspector`. For the
selected element it shows the title, status chips, source reference, an **Open {type}** button,
and — for parked sources — Move-to-inbox / Queue-soon / Dismiss quick-actions. Everything in that
column **except the action buttons** duplicates the shell `Inspector` (header = title, Properties =
priority/status, Attention = scheduler/return, Source = the reference RefBlock).

This change relocates the column's unique controls into the shared `Inspector` and deletes the
column, reflowing its 320px back into the elements list. It follows the established
context-bridge pattern (`docs/solutions/architecture-patterns/relocate-screen-ui-into-shell-inspector-context-bridge.md`),
which the Inbox triage relocation used last week
(`docs/plans/2026-06-18-001-feat-inbox-triage-into-inspector-plan.md`).

## Problem Frame

The middle detail column is redundant chrome. It repeats inspector facts and consumes width that
belongs to the elements list. The only things it owns that the inspector does not are: (1) the
**Open {type}** action (open the selected element in its dedicated view — source reader, extract,
card, task, synthesis note), and (2) the **parked-source quick-actions**. The shell `Inspector`
cannot receive these handlers through the router tree because it is mounted once in `Shell.tsx`, a
sibling of the route `<Outlet/>`, and is shared by every route. A one-way UI context bridge solves
this, exactly as `inboxTriagePanel.tsx` already does for Inbox triage.

The redesign target is the screenshot annotation: move the "Open source" button into the right
SOURCE inspector panel (styled to match), then remove the middle column to give the elements list
more horizontal space.

## Requirements

- **R1.** The selected element's **Open {type}** action moves into the shell `Inspector`, styled to
  match the inspector's existing button idioms. Label adapts to the element type ("Open source",
  "Open extract", …), reading "Open source" for a selected source as in the screenshot.
- **R2.** The middle detail column (`.lib-detail`) is removed from both `BrowseScreen` (`/library`)
  and `LibraryScreen` (`/search`); the freed 320px reflows into the elements list (`.lib-results`).
- **R3.** Parked-source quick-actions (Move to inbox / Queue soon / Dismiss) are not lost — they
  relocate into the inspector, gated to parked sources.
- **R4.** No functional regression: open routing per type is preserved exactly (no re-derivation of
  routing in the inspector — pass the screen's existing `open` closure across the bridge), and the
  inspector controls never leak onto other routes (queue, reader, review, card).
- **R5.** Row selection still highlights the active row and still populates the inspector
  (`select(id)` / `selId`), independent of the removed column.

## Key Technical Decisions

- **KTD1 — Use a UI-only context bridge, not props or inspector-side re-derivation.** Model a new
  `libraryInspectorPanel.tsx` context on `apps/web/src/shell/selection.tsx` /
  `inboxTriagePanel.tsx`. The Library screen publishes `{ targetId, openLabel, onOpen, parked }` and
  the inspector consumes it. Rationale: the inspector is shell-level and unreachable through the
  router tree; passing the screen's already-correct `open` closure avoids re-deriving open routing
  in the inspector, which previously caused a silent routing bug
  (`docs/solutions/ui-bugs/library-open-task-weekly-routing-missing-tasktype.md`).
- **KTD2 — Simpler bridge than Inbox: no reveal/focus machinery.** The Inbox bridge carries
  registration refs + a `registrationTick`; the **only** consumer of that machinery is its
  scroll-to/focus reveal affordance (the screen focuses the relocated Read-now node after the
  inspector registers it, retrying on the tick once the inspector's own async fetch lands). The
  Library relocation has no action that must fire against the relocated DOM node, so it needs no
  refs and no tick — the context is just `{ panel, setPanel }` plus a `useLibraryInspectorPanel()`
  hook. (The two-fetch ordering the tick guards against still exists — see KTD3 — but it only
  affects *when the button paints*, which is self-correcting, not *whether an action can fire*.)
- **KTD3 — Gate strictly and clear aggressively (leak guard).** The inspector renders the relocated
  controls only when `panel !== null && panel.targetId === element.id`. Note the gate compares
  against the inspector's **own async-loaded** `element.id` (from its independent
  `getInspectorData({ id: selectedId })` fetch), which lags `selectedId` until it resolves. The
  screen publishes eagerly on `selected` (synchronous, from the already-loaded browse list), so on
  each selection change the new `panel.targetId` transiently mismatches the still-loading
  `element.id` and the relocated controls paint only **after** the inspector fetch lands. This is a
  brief, self-correcting delay on local IPC — acceptable, not a leak (the inverse — a stale payload
  on a new element — cannot occur because the gate keys on the freshly-loaded `element.id`). The
  publishing screen clears the payload on unmount (`useEffect(() => () => setPanel(null),
  [setPanel])`) **and** before any navigation the `open`/parked handlers trigger, so the controls
  never flash on the destination route during the navigate→unmount frame. The clear-before-navigate
  is the load-bearing leak guard and must not be dropped. Belt and suspenders, per the playbook.
- **KTD4 — Relocated controls get their own dedicated inspector block, not an injected pill.** Add a
  single new `insp-sec`-style block at the top of `InspectorBody` — immediately after `insp-head`
  and before/around the existing Inbox-triage slot — that owns the relocated Library controls. This
  mirrors how the Inbox triage relocation placed its section (its own block above Properties) rather
  than threading controls into an existing section. The block contains, in order: any context lines
  (`parkedAt` date, `notInQueueReason`) styled like the inspector's existing muted text; the parked
  quick-actions (only for parked sources); and the **primary Open action as a full-width accent
  button** (`.insp-add__btn` full-width variant, matching the Inbox "Read now" primary CTA weight
  and the screenshot's prominent blue button — **not** the smaller `.insp-jump` title-row pill,
  which reads as secondary). Parked verbs use `.insp-add__btn--inline`. Do **not** inject the open
  button into the Properties or Attention section title rows, and do not add a new `.lib-btn` to the
  inspector. Single-owner rule: the inspector has no pre-existing generic "open this element" button
  or parked quick-actions, so no suppression is needed.
- **KTD5 — Reflow by deletion, not CSS.** Removing the `.lib-detail` JSX + its `library.css` rules
  lets `.lib-results` (`flex: 1`) reclaim the 320px automatically; no width edits needed
  (`docs/solutions/ui-bugs/source-reader-taller-middle-area.md`).

## Assumptions

- **Both Library surfaces change.** The change applies to `BrowseScreen` (`/library`) and its twin
  `LibraryScreen` (`/search`), since both render the same `.lib-detail` block and the Browse/Search
  toggle implies one consistent Library surface. If only Browse was intended, U2's `LibraryScreen`
  edits are dropped (and its tests).
- **The open action generalizes to every element type the screen can surface**, not just sources —
  otherwise removing the column strips the open affordance for the other types. The label is
  type-driven (`typeLabel(selected.type)`) and reads "Open source" for sources. Note the two
  screens carry different type sets: `BrowseScreen` (`/library`) can show source/extract/card/topic/
  task/synthesis-note (its `open` closure routes all of them); `LibraryScreen` (`/search`) only ever
  surfaces source/extract/card, so its `open` (and the relocated button) covers exactly those three.
  This asymmetry is intentional, not a missing case — do not add task/synthesis routing to /search.
- **Parked actions relocate rather than disappear.** They are parked-source-specific and have no
  other home; dropping them would be a regression (R3).

## High-Level Technical Design

```text
 BEFORE                                          AFTER
 ┌─────────┬───────────┬──────────┬───────────┐  ┌─────────┬──────────────────────┬───────────┐
 │ filter  │ elements  │ detail   │ Inspector │  │ filter  │ elements (wider)     │ Inspector │
 │ rail    │ list      │ (320px)  │ (shell)   │  │ rail    │ list  flex:1         │ (shell)   │
 │         │ flex:1    │ • title  │ • header  │  │         │                      │ • header  │
 │         │           │ • chips  │ • props   │  │         │  reclaims the 320px  │ • OPEN ▸  │ ← relocated
 │         │           │ • ref    │ • attention│ │         │                      │ • props   │
 │         │           │ • OPEN   │ • source  │  │         │                      │ • attention│
 │         │           │ • parked │ • …       │  │         │                      │   + parked │ ← relocated
 └─────────┴───────────┴──────────┴───────────┘  └─────────┴──────────────────────┴───────────┘

 State channel (one-way, UI-only):
   BrowseScreen / LibraryScreen ──setPanel({targetId, openLabel, onOpen, parked})──▶ libraryInspectorPanel context
   Inspector ──useLibraryInspectorPanel()──▶ render gated on panel.targetId === element.id
   clear: onUnmount + before navigate  (leak guard)
```

Directional only; the inspector section ordering and exact placement are the implementer's call
within KTD4.

---

## Implementation Units

### U1. Library inspector panel context bridge

**Goal:** Add the one-way UI context that lets the Library screens publish the selected element's
open + parked handlers to the shared shell `Inspector`.

**Requirements:** R1, R3, R4.

**Dependencies:** none.

**Files:**
- `apps/web/src/shell/libraryInspectorPanel.tsx` (new)
- `apps/web/src/shell/libraryInspectorPanel.test.tsx` (new)
- `apps/web/src/shell/Shell.tsx` (wrap subtree in the new provider, alongside
  `InboxTriagePanelProvider` at lines ~745-751)

**Approach:** Model on `apps/web/src/shell/selection.tsx` (and the simpler half of
`inboxTriagePanel.tsx`). Export `LibraryInspectorPanel` interface:

```ts
interface LibraryInspectorPanel {
  targetId: string;
  openLabel: string;            // e.g. "Open source" — typeLabel(type)
  onOpen(): void;
  parkedAt: string | null;      // carried so the relocated block can show "Parked {date}"
  notInQueueReason: string | null; // carried so the queue-exclusion reason is not lost
  parked: { busy: boolean; onMoveToInbox(): void; onQueueSoon(): void; onDismiss(): void } | null;
}
```

`parkedAt` and `notInQueueReason` are on the payload because the deleted `.lib-detail` column was
their only renderer (`library-detail-parked-date` / `library-detail-queue-reason`); dropping them
silently would regress parked sources and queue-excluded elements (design finding). Add a
`LibraryInspectorPanelProvider` holding `useState<LibraryInspectorPanel | null>`, and a
`useLibraryInspectorPanel()` hook that throws outside the provider. **Per KTD2, do not add
registration refs or a registration tick** — there is no reveal affordance. Wrap the shell subtree
in `Shell.tsx`.

**Patterns to follow:** `apps/web/src/shell/selection.tsx` (provider + hook + throw-outside),
`apps/web/src/shell/inboxTriagePanel.tsx` (payload-shape doc comment, `useMemo` value).

**Test scenarios:**
- `useLibraryInspectorPanel()` throws when used outside the provider.
- `setPanel(payload)` then read returns the same payload; `setPanel(null)` clears it.
- Re-publishing with only `parked.busy` changed updates `panel` without throwing (payload identity
  may change; this just guards the setter contract).

**Verification:** Context compiles, unit tests pass, provider mounted in `Shell.tsx` without
disturbing existing providers.

### U2. Publish from the Library screens and remove the detail column

**Goal:** Both Library screens publish the panel for the selected element and stop rendering
`.lib-detail`.

**Requirements:** R1, R2, R3, R4, R5.

**Dependencies:** U1.

**Files:**
- `apps/web/src/library/BrowseScreen.tsx` (publish panel; remove `.lib-detail` block at lines
  ~559-658; keep `selId`/`select`/`selected` and `runParkedAction`/`parkedActionId`; clear panel on
  unmount and before navigation in `open`)
- `apps/web/src/library/LibraryScreen.tsx` (twin: publish panel; remove its `.lib-detail` block at
  lines ~1012-1080; its `open` at lines ~754-761 has no parked actions, so `parked: null`)
- `apps/web/src/library/BrowseScreen.test.tsx` (update — see test scenarios)
- `apps/web/src/library/LibraryScreen.test.tsx` (update)

**Approach:** In each screen, a `useEffect` keyed on `selected` calls `setPanel(selected ? {
targetId: selected.id, openLabel: \`Open ${typeLabel(selected.type).toLowerCase()}\`, onOpen: () =>
open(selected), parkedAt: selected.parkedAt ?? null, notInQueueReason: selected.notInQueueReason ??
null, parked: <parked-source actions or null> } : null)`. For `BrowseScreen`, `parked` is populated
only when `selected.status === "parked" && selected.type === "source"`, wiring
`runParkedAction(selected, …)` and `busy: parkedActionId !== null`. Per KTD3, clear before
navigation: have the published `onOpen`/parked handlers call `setPanel(null)` before the navigate
that unmounts the screen, and add `useEffect(() => () => setPanel(null), [setPanel])`. Note
`runParkedAction` already nulls `selId`/`select` when it removes the acted row, so the publish
effect self-clears the panel in that path — the explicit clear-before-navigate covers the `open`
path. Delete the `.lib-detail` JSX. Keep `selId`/`select(r.id)`/`selected` (row highlight +
inspector population) and `runParkedAction`/`parkedActionId` (now consumed by the published
payload). Remove imports that become unused (e.g. `RefBlock`, `SchedulerChip`, `DueBadge`,
`formatShortDate`, `ConceptTag`, `Status`, `TypeIcon`) **only if** no longer referenced elsewhere in
the file — verify each.

**Test provisioning:** `BrowseScreen.test.tsx` / `LibraryScreen.test.tsx` currently `render()` the
screen directly. Because the screen now calls `useLibraryInspectorPanel()` (which throws outside a
provider), every existing render must be wrapped in `LibraryInspectorPanelProvider` (or a shared
test harness that includes it) — mirror whichever provisioning `InboxScreen.test.tsx` uses for
`InboxTriagePanelProvider`. To assert publish behavior, render a small probe under the same provider
that reads `useLibraryInspectorPanel().panel` and exposes it, then assert `targetId`/`openLabel`/
`parked` after selecting a row.

**Execution note:** Run `pnpm typecheck` after deletion to surface now-unused imports rather than
eyeballing them.

**Patterns to follow:** `apps/web/src/pages/inbox/InboxScreen.tsx` (publish-on-select + clear
pattern from the Inbox relocation).

**Test scenarios:**
- BrowseScreen: selecting a row publishes a panel whose `targetId` equals the row id and `openLabel`
  matches the type; `.lib-detail` / `library-detail` is **absent** from the DOM (test presence of
  publish, absence of the old column).
- BrowseScreen: selecting a parked source publishes `parked` non-null with the three handlers;
  selecting a non-parked source or a non-source publishes `parked: null`.
- BrowseScreen: the existing "Open navigates per type" / "Open task → /process|/weekly" assertions
  are rewritten to invoke `panel.onOpen()` (or its inspector button in U3) and assert the same
  navigation targets — **preserving** the taskType routing coverage from
  `library-open-task-weekly-routing-missing-tasktype.md`.
- BrowseScreen: row highlight (`result--on`) still tracks `selId` after the column removal.
- LibraryScreen: same publish + absence assertions; `parked: null` (no parked actions on this twin).
- Both: unmount clears the panel (`setPanel(null)` called on cleanup).

**Verification:** Both screens render without the detail column; the elements list visibly widens;
selection still drives the inspector; `pnpm typecheck` clean (no unused imports).

### U3. Render the relocated controls in the shell Inspector

**Goal:** The shell `Inspector` renders the Open button and (for parked sources) the parked
quick-actions, gated to the selected element.

**Requirements:** R1, R3, R4.

**Dependencies:** U1, U2.

**Files:**
- `apps/web/src/components/inspector/Inspector.tsx` (consume `useLibraryInspectorPanel()`; render
  gated Open button in the header/identity area; render gated parked actions in the
  scheduler/Attention block)
- `apps/web/src/components/inspector/inspector.css` (only if existing `.insp-jump` /
  `.insp-add__btn` need a small layout wrapper; prefer reuse)
- `apps/web/src/components/inspector/Inspector.test.tsx` (add coverage)

**Approach:** In `InspectorBody`, read `const { panel } = useLibraryInspectorPanel()` and compute
`const showLibraryOpen = panel !== null && panel.targetId === element.id`. When `showLibraryOpen`,
render the dedicated block (KTD4) at the top of the body containing, in order: the context lines —
`panel.parkedAt` as "Parked {formatShortDate}" and `panel.notInQueueReason` — styled with the
inspector's existing muted text class (do not render an empty line when a field is null); the parked
quick-actions when `panel.parked` is non-null (three buttons,
`data-testid="inspector-parked-inbox|schedule|dismiss"`, disabled while `panel.parked.busy`, styled
`.insp-add__btn--inline`); and the primary **Open button** as a full-width accent
`.insp-add__btn` (label `panel.openLabel`, icon `external`, `data-testid="inspector-open-element"`,
`onClick={panel.onOpen}`). Per KTD4 there is no existing duplicate to suppress. Keep the gate strict
(`panel.targetId === element.id`) so nothing renders on other routes.

**Patterns to follow:** the gate + single-owner section in
`relocate-screen-ui-into-shell-inspector-context-bridge.md`; existing `.insp-jump` "Jump to source"
button (`Inspector.tsx` ~lines 2218-2228) and `.insp-add__btn` usages.

**Test scenarios:**
- With a published panel whose `targetId` matches the inspected element, the Open button renders
  with the correct label and invokes `panel.onOpen` on click.
- With `panel === null` or `panel.targetId !== element.id`, **no** Open button and **no** parked
  actions render (absence test — the cross-route leak guard).
- With `panel.parked` non-null, the three parked buttons render and call their handlers; with
  `panel.parked === null`, none render.
- Parked buttons are disabled while `panel.parked.busy` is true.
- With `panel.parkedAt` set, the "Parked {date}" context line renders; with `panel.notInQueueReason`
  set, the reason renders; with both null, neither line renders (no empty placeholder) — the
  non-regression guard for the dropped `library-detail-parked-date` / `library-detail-queue-reason`.

**Verification:** Inspector shows the Open button for the selected Library element, matching the
inspector's visual style; parked actions appear only for parked sources; nothing leaks to other
routes.

### U4. Remove dead `.lib-detail` styles and reflow

**Goal:** Delete the now-unused detail-column CSS so the elements list reclaims the width cleanly.

**Requirements:** R2.

**Dependencies:** U2.

**Files:**
- `apps/web/src/library/library.css` (remove `.lib-detail*` rules at lines ~336+ and any
  `.lib-detail`-scoped descendants; remove `.lib-btn` / `.lib-actions` rules **only if** no longer
  referenced after U2/U3 — verify with a grep)

**Approach:** Remove `.lib-detail` and its descendant rules. `.lib-results` (`flex: 1`) reclaims the
space with no width edits (KTD5). Grep `lib-btn` / `lib-actions` / `lib-detail` across `apps/web`
before deleting their rules to avoid removing styles still used elsewhere.

**Test expectation:** none — pure dead-CSS removal; covered indirectly by U2's "column absent" DOM
assertions and the e2e in U5.

**Verification:** `grep -rn "lib-detail" apps/web/src` returns no JSX/CSS references;
`pnpm lint`/`pnpm typecheck` clean; the Library list is visibly wider in the running app.

### U5. Update Electron E2E coverage

**Goal:** E2E reflects the relocated controls and the removed column.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** U2, U3.

**Files:**
- `tests/electron/library.spec.ts` (replace `library-detail*` / `library-detail-open` assertions at
  lines ~82-89, ~109, ~152-196 with inspector-based open assertions)
- `tests/electron/inspector.spec.ts` (add: selecting a Library element shows the inspector Open
  button and it navigates; parked-source actions appear and act)

**Approach:** Update the Open-task flow to select the row, click the inspector Open button
(`inspector-open-element`), and assert the same destination route. Add an inspector assertion for a
parked source's relocated quick-actions. Assert `library-detail` is absent after selection.

**Execution note:** This is the IPC round-trip proof required by the project Definition of Done for
search/UI/IPC-adjacent work; do not rely on unit tests alone for the open routing.

**Test scenarios:**
- Select a card row → inspector Open button → URL becomes `/card/...`.
- Select a task row → inspector Open button → `/process` or `/weekly` per taskType (the regression
  guard from `library-open-task-weekly-routing-missing-tasktype.md`).
- Select a parked source → inspector parked actions visible → Dismiss/Queue-soon act.
- After selecting any row, `library-detail` test id is absent.

**Verification:** `pnpm e2e` (or the targeted library/inspector specs) green.

---

## Scope Boundaries

In scope: relocating the open + parked actions into the inspector, deleting the detail column on
both Library surfaces, reflow, and test updates.

### Deferred to Follow-Up Work
- Adding a generic "open this element" inspector button for routes **other** than Library (queue,
  review) — out of scope; the bridge keeps this Library-only.
- Any redesign of the inspector section ordering beyond placing the two relocated control clusters.

## Risks & Dependencies

- **Cross-route leak (medium).** The inspector is shared; an unflushed payload could paint the Open
  button on the reader/queue route for a frame. Mitigated by KTD3 (gate on `targetId` + clear on
  unmount and before navigate). Covered by U3's absence tests and the playbook.
- **Open-routing regression (medium).** Re-deriving open routing in the inspector would risk the
  taskType bug. Mitigated by KTD1 (pass the screen's `open` closure) and U2/U5 taskType coverage.
- **Unused-import / dead-CSS churn (low).** Mitigated by typecheck (U2) and grep-before-delete (U4).

## Sources & Research
- `docs/solutions/architecture-patterns/relocate-screen-ui-into-shell-inspector-context-bridge.md`
  — the playbook (context bridge, gating, leak guard, single-owner).
- `docs/plans/2026-06-18-001-feat-inbox-triage-into-inspector-plan.md` — the Inbox precedent.
- `docs/solutions/ui-bugs/library-open-task-weekly-routing-missing-tasktype.md` — open-routing
  regression to avoid.
- `docs/solutions/ui-bugs/source-reader-taller-middle-area.md` /
  `process-source-reader-scroll-owner-full-width-measure-on-content.md` — reflow-by-deletion.
- `docs/solutions/ui-bugs/extract-inspector-single-responsibility-lineage-scheduler.md` —
  inspector single-owner rule, test presence + absence.
</content>
</invoke>

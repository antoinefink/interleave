---
title: "feat: ⌘←/⌘→ back/forward page-history navigation shortcuts"
date: 2026-06-15
type: feat
status: planned
depth: lightweight
---

# feat: ⌘←/⌘→ back/forward page-history navigation shortcuts

## Summary

Add two global keyboard shortcuts — `⌘←` / `⌘→` (Ctrl on non-mac) — that walk
backward and forward through the renderer's page-navigation history, mirroring
the browser/Electron back-forward gesture. They route through the existing
single-source-of-truth shortcut pattern (registry → global hook → shell
handler) and are suppressed while the user is typing so they keep their native
"move cursor to line start/end" meaning inside inputs, textareas, and the
reader's contenteditable editor.

## Problem Frame

The app is a keyboard-first incremental-reading workspace. Users move between
sources, extracts, queue, review, inbox, and search constantly, but there is no
keyboard way to retrace that path — only `g`-prefix jumps to fixed
destinations. A standard `⌘←`/`⌘→` back/forward pair closes that gap using the
muscle memory users already have from browsers, and TanStack Router already
maintains the history stack, so the behavior is a thin binding over an existing
capability rather than new navigation infrastructure.

## Scope Boundaries

In scope:
- Two new global shortcuts bound in the shell, plus their cheat-sheet rows
  (derived automatically from the registry).
- A behavioral test proving they fire / are suppressed correctly.

### Deferred to Follow-Up Work
- A native Electron menu accelerator (File/History menu) for back/forward — not
  required for the keyboard shortcut and adds IPC plumbing. Out of scope here.
- On-screen back/forward buttons in the topbar.
- ⌘K command-palette entries for back/forward (browser-style history is an
  unusual palette action; cheat-sheet documentation is sufficient).

## Requirements

- **R1** — `⌘←` (or `Ctrl+←`) navigates back one entry in page history; `⌘→`
  (or `Ctrl+→`) navigates forward, when focus is not in a text-entry surface.
- **R2** — While typing in an `input`, `textarea`, or `contenteditable`
  element, the shortcuts do **not** fire, preserving native line-cursor
  behavior (this includes the reader's Tiptap editor).
- **R3** — The shortcuts carry no `Shift`/`Alt` modifier (so `⌘⇧←` text
  selection and other chords are untouched).
- **R4** — The `?` cheat sheet lists Back and Forward under Navigation, derived
  from the registry (no hand-maintained doc).
- **R5** — `pnpm lint`, `pnpm typecheck`, and `pnpm test` all pass, including
  the shortcut drift-guard and cheat-sheet derivation tests.

## Key Technical Decisions

- **Bind in the global shell hook, not per-route.** Per
  `docs/solutions/ui-bugs/hide-queue-route-shell-topbar.md`, global command
  behavior must live in `apps/web/src/shell/useShellShortcuts.ts` so it never
  becomes route-dependent or drifts from the command surface. Back/forward is
  inherently global, so this is the correct scope.
- **Navigate via `useRouter().history`, not `window.history`.** TanStack Router
  (`@tanstack/react-router` 1.170.9) owns the history stack; `router.history`
  exposes `back()`, `forward()`, and `canGoBack()`. Using the router's history
  keeps navigation consistent with every other in-app transition (which all go
  through the router) and is agnostic to the underlying history implementation.
- **Guard with `(metaKey || ctrlKey) && !shiftKey && !altKey && !typing`,
  mirroring the existing `⌘B` block.** This is the established guard shape in
  the same hook; reusing it keeps the modifier semantics identical to ⌘Z/⌘B and
  satisfies R2/R3.
- **Match on `e.key === "ArrowLeft" | "ArrowRight"`** (not `e.code`), consistent
  with how the hook reads other keys, and place the new blocks **before** the
  `if (typing || e.metaKey || e.ctrlKey || e.altKey) return;` early-return so
  the meta-modified arrows are handled in the same section as ⌘K/⌘Z/⌘B.
- **Registry first keycap stays `⌘`.** The drift-guard test
  (`shortcuts.test.ts`) only checks that the first keycap's handler literal
  (`"metaKey"`) appears in the owning hook's source — already true — so the
  guard passes without test edits. Because that guard is weak for this change, a
  dedicated behavioral test is added (see U1 test scenarios) to actually prove
  the bindings.

## Implementation Units

### U1. Wire ⌘←/⌘→ back/forward through the global shortcut pattern

**Goal:** Declare, bind, and implement the two shortcuts end-to-end so they
navigate page history and are suppressed during text entry.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** none

**Files:**
- `apps/web/src/shell/shortcuts.ts` — add two `ShortcutDef` entries in the
  Navigation group: `nav-back` (`keys: ["⌘", "←"]`) and `nav-forward`
  (`keys: ["⌘", "→"]`), both `group: "Navigation"`, `scope: "global"`, no
  `palette` spec. Place them adjacent to `command-palette` so the ⌘-combos
  group together in the cheat sheet.
- `apps/web/src/shell/useShellShortcuts.ts` — add `onNavigateBack` and
  `onNavigateForward` to the `ShellShortcutHandlers` type (with doc comments
  matching the file's style), and add two guarded blocks in `onKey` right after
  the `⌘B` block that call the respective handler and `preventDefault()`.
- `apps/web/src/shell/Shell.tsx` — add `useRouter` to the existing
  `@tanstack/react-router` import, obtain `const router = useRouter();` in
  `ShellInner`, define `onNavigateBack`/`onNavigateForward` calling
  `router.history.back()` / `.forward()`, and pass them into the
  `useShellShortcuts({ … })` call.
- `apps/web/src/shell/useShellShortcuts.test.ts` (new, or extend an existing
  shell shortcut test if one already covers `onKey`) — behavioral tests for the
  new bindings.

**Approach:** Pure wiring over existing infrastructure. The registry entry is
declarative; the hook block follows the ⌘B precedent verbatim (same modifier
guard, same `!typing` exclusion, same `e.preventDefault(); handler(); return;`
shape); the Shell handlers are one-liners delegating to `router.history`. The
cheat sheet (`nav.ts` `CHEAT_SHEET`) and ⌘K palette derive from the registry, so
no doc edits are needed.

**Patterns to follow:** the `create-backup` / `⌘B` path across all three files
(`shortcuts.ts` registry entry → `useShellShortcuts.ts` guarded block + handler
type → `Shell.tsx` handler + `useShellShortcuts({...})` wiring), and the
existing `useRouter`/`useNavigate` usage already in `Shell.tsx`.

**Test scenarios** (file: `apps/web/src/shell/useShellShortcuts.test.ts`):
- Covers R1. Dispatching a `keydown` with `key: "ArrowLeft"` and `metaKey: true`
  on a non-input target invokes `onNavigateBack` exactly once and does not
  invoke `onNavigateForward`.
- Covers R1. Same with `key: "ArrowRight"`, `metaKey: true` invokes
  `onNavigateForward` once.
- Covers R1. `ctrlKey: true` + `ArrowLeft`/`ArrowRight` (non-mac path) invokes
  the same handlers.
- Covers R2. A `keydown` `metaKey: true` + `ArrowLeft` whose `target` is an
  `<input>` / `<textarea>` / a `contenteditable` element does **not** invoke
  `onNavigateBack` (native cursor behavior preserved).
- Covers R3. `metaKey: true` + `shiftKey: true` + `ArrowLeft`, and
  `metaKey: true` + `altKey: true` + `ArrowLeft`, do **not** invoke the
  handlers.
- Plain `ArrowLeft`/`ArrowRight` with no modifier does **not** invoke the
  handlers (arrows remain free for other surfaces).
- (Registry/derivation) `shortcuts.test.ts` continues to pass unchanged: the new
  entries' first keycap `⌘` maps to `"metaKey"` (present in the hook source) for
  the drift guard, and the derived `CHEAT_SHEET` Navigation group now includes
  Back and Forward in registry order.

**Verification:** The two shortcuts navigate history in the running app and are
inert inside text fields and the reader editor; `pnpm lint`, `pnpm typecheck`,
and `pnpm test` (including `shortcuts.test.ts` and the new hook test) pass.

## Risks & Notes

- **Weak drift guard (addressed).** The existing drift guard would not catch a
  missing arrow binding. The new behavioral test in U1 closes this — it is the
  real proof of correctness, not the registry scan.
- **Overlay focus.** When the ⌘K palette is open its search input holds focus,
  so `typing` is true and the arrows are inert — consistent with ⌘Z/⌘B, which
  also do not special-case overlays. No extra guard added (keeps the change
  minimal and matches precedent).
- **Cheat-sheet glyphs.** `←`/`→` render as plain keycap strings in the kit's
  `.kbd`; no token changes needed.
- **`canGoBack()` available but unused.** `router.history.forward()`/`back()`
  are safe no-ops at the ends of the stack, so an explicit guard is unnecessary;
  `canGoBack()` is noted for a future affordance (e.g., disabling a back button)
  but not needed for the keyboard shortcut.

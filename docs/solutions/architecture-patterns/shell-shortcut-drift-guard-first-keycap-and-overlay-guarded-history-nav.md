---
title: "Shell shortcut drift guard only verifies the FIRST keycap; global history nav needs an overlay guard"
date: 2026-06-15
category: architecture-patterns
problem_type: architecture_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "Adding a new GLOBAL keyboard shortcut to the single-source-of-truth registry (apps/web/src/shell/shortcuts.ts)."
  - "The new shortcut is a modifier chord (a leading cap like the Cmd glyph, Ctrl, or Shift plus another key) — the drift guard only checks the leading cap."
  - "Adding a global navigation or history command that should fire regardless of the active per-screen scope."
tags: [shortcuts, keyboard, shell, drift-guard, tanstack-router, command-palette, testing, renderer, react]
---

# Shell shortcut drift guard only verifies the FIRST keycap; global history nav needs an overlay guard

## Context

The shell's keyboard surface is a single source of truth: every shortcut is
declared once in `apps/web/src/shell/shortcuts.ts`, the `?` cheat sheet and the
Cmd-K palette are DERIVED from that registry, and a Vitest drift guard
(`apps/web/src/shell/shortcuts.test.ts`) asserts each registry entry is actually
wired in its scope hook. Adding global back/forward page-history shortcuts
(Cmd+Left / Cmd+Right, Ctrl on non-mac) surfaced two non-obvious traps that any
future shortcut work in this area will hit. See also
[[hide-queue-route-shell-topbar]] (global shortcut handling must live in the
shell hook, never per-route).

## Guidance

### 1. The drift guard only checks each shortcut's FIRST keycap

The per-scope loop in `shortcuts.test.ts` reads `s.keys[0]` and looks up its
handler literal via `handlerLiterals()`. For a chord like `["⌘", "←"]` it only
ever verifies `"metaKey"` — a literal already present in the hook source for
Cmd-K / Cmd-Z / Cmd-B. **The second cap (the actual distinguishing key) is never
checked.** So a new `Cmd+X` shortcut passes the drift guard even if its real key
binding is missing, wrong, or renamed.

Three consequences for future work:

- **Do not trust the drift guard to prove a chord is wired.** It proves the
  modifier is read, nothing more.
- **The reviewers' instinct — "just add a `case "←"`/`"→"` to
  `handlerLiterals()`" — is DEAD CODE.** The loop only passes `keys[0]`, so a
  case for the second cap is never invoked.
- **You cannot simply make the loop check the last cap instead.** The
  `goto-queue` / `goto-review` / `goto-library` shortcuts (`["G","Q"]` etc.)
  bind their destination letters through `GOTO_MAP` in `nav.ts`, NOT as literals
  in the hook source, so a generic last-cap check would fail them.

The correct mitigation is two real tests, not a drift-guard tweak:
(a) a behavioral hook test in `useShellShortcuts.test.tsx` that fires the chord
and asserts the handler runs (this is what actually catches a rename), and
(b) an explicit per-shortcut assertion that the distinguishing literal appears
in the hook source (e.g. `expect(shellSrc).toContain('"ArrowLeft"')`).

### 2. Global history nav fires above the scope gate — but must respect overlays

Universal commands (Cmd-Z undo, Cmd-B backup, and now history back/forward) are
intentionally bound ABOVE the `hasActiveScope()` gate in `useShellShortcuts`, so
they work mid-reader/review/queue just like clicking a nav link does. That part
is correct and matches the existing universal-command pattern.

The trap: the hook's `typing` guard only suppresses shortcuts when the focused
element is an `input`, `textarea`, or `contenteditable`. **A modal/overlay
(command palette with focus off its input, the `?` cheat sheet, the help center,
the welcome modal) keeps focus on a NON-input element, so `typing` is `false`
and the global shortcut still fires — walking the route out from under the
floating dialog.** The fix is to gate the navigation in the Shell-level handler
(`onNavigateBack`/`onNavigateForward`), where the overlay state
(`commandOpen`/`cheatOpen`/`helpOpen`/`welcomeOpen`) is in scope — not in the
hook, which has no view of overlay state.

### 3. TanStack Router history specifics

`router.history.back()` / `.forward()` (from `useRouter()`) are safe no-ops at
the ends of the stack, so no `canGoBack()` / `canGoForward()` guard is needed.
For the Electron e2e, build a real history stack with the app's OWN navigation
(g-prefix nav pushes through the router) rather than `page.goto`, so back/forward
walk genuine router entries.

## Why This Matters

The drift guard's name implies it proves shortcuts are wired; trusting it for a
chord gives false confidence and lets a broken binding ship green. And a global
navigation command that ignores overlay state is a subtle UX bug that unit tests
keyed only on `typing` will miss — the route changes silently behind an open
dialog. Both traps are invisible unless you know the guard's scope and the
`typing` guard's blind spot.

## When to Apply

- Any time you add or rename a GLOBAL multi-cap shortcut: add a behavioral test
  in `useShellShortcuts.test.tsx`; never rely on the drift guard alone.
- Any time you add a global command that navigates or otherwise acts at the app
  level: decide explicitly whether it fires above the scope gate (universal) and
  whether it must be suppressed while an overlay is open.

## Examples

Overlay guard in the Shell handler (not the hook):

```ts
// Shell.tsx — overlay state is in scope here; the hook's `typing` guard is not enough.
const overlayOpen = commandOpen || cheatOpen || helpOpen || welcomeOpen;
const onNavigateBack = () => {
  if (overlayOpen) return;
  router.history.back();
};
```

Real coverage for a chord, since the drift guard can't see the second cap:

```ts
// useShellShortcuts.test.tsx — the test that actually catches a rename.
fireEvent.keyDown(window, { key: "ArrowLeft", metaKey: true });
expect(h.onNavigateBack).toHaveBeenCalledTimes(1);

// shortcuts.test.ts — explicit assertion the drift loop cannot make.
expect(shellSrc).toContain('"ArrowLeft"');
expect(shellSrc).toContain('"ArrowRight"');
```

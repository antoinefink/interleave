---
title: "Queue Route Hides Shell Topbar Without Breaking Global Shortcuts"
date: "2026-06-09"
category: "ui-bugs"
module: "apps/web shell queue route"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "The Queue route showed the shell command/search topbar even when queue content needed the vertical space."
  - "Removing the visible topbar risked disabling global search and command-palette shortcuts."
root_cause: "logic_error"
resolution_type: "code_fix"
related_components:
  - "apps/web/src/shell/Shell.tsx"
  - "apps/web/src/shell/useShellShortcuts.ts"
  - "apps/web/src/shell/Shell.test.tsx"
tags:
  - "queue"
  - "shell"
  - "topbar"
  - "shortcuts"
  - "command-palette"
---

# Queue Route Hides Shell Topbar Without Breaking Global Shortcuts

## Problem

The `/queue` view needed more vertical space for due work, but the persistent shell still rendered the top command/search bar. That bar is useful on most routes, but in the Queue it competes with the core workspace.

The risky part is that the visible bar is adjacent to global command behavior. Hiding the UI must not disable `/` search or Cmd/Ctrl+K command-palette access.

## Symptoms

- `/queue` rendered the same `Topbar` and `command-bar` as non-Queue routes.
- Hiding only the inner button would leave `.shell-topbar` mounted and still reserve `--topbar-h`.
- Moving search handling into the Queue screen would duplicate the shell's global command path.

## What Didn't Work

- CSS-hiding only `.shell-cmdbar` or changing visibility would remove the visual control without reclaiming vertical layout space.
- Treating `/queue` as a prefix-style match would risk hiding shell chrome on adjacent routes such as `/process`.
- Adding Queue-local shortcut handling would make global command behavior route-dependent and harder to keep aligned with the command palette.

## Solution

Keep global shortcuts owned by the shell, and make only the visible topbar route-aware:

```tsx
const hideTopbar = pathname === "/queue";
```

Then omit the whole `Topbar` on that exact route:

```tsx
<div className="shell-main">
  {hideTopbar ? null : <Topbar onOpenCommand={() => setCommandOpen(true)} />}
  <main className="shell-page">
    <Outlet />
  </main>
</div>
```

Leave `useShellShortcuts` mounted unconditionally in `ShellInner`, with `onSearch` still wired to the existing global action:

```tsx
useShellShortcuts({
  toggleCommandPalette: () => setCommandOpen((o) => !o),
  onSearch: globalActions.search,
  // ...
});
```

The regression tests should cover both sides of the split:

- `/queue` does not render `command-bar`.
- The shell shortcut handlers still open Search and the command palette while on `/queue`.
- Non-Queue routes still render the topbar and can open the palette by clicking it.

## Why This Works

The topbar is visible chrome; it is not the owner of global command behavior. Omitting it on `/queue` removes the reserved topbar height, while leaving `useShellShortcuts` and `CommandPalette` mounted preserves keyboard-first access.

Exact route matching keeps the change scoped to the due queue. `/process`, `/search`, and other shell routes continue to use the normal topbar unless product direction explicitly changes their layout.

## Prevention

- Separate visible shell chrome from global command/action wiring when making route-specific layout changes.
- Prefer exact route checks for shell chrome exceptions unless the product explicitly names a route family.
- Test both the absence of the visible control and the continued shortcut behavior.
- Keep search and command-palette behavior in the shell/global action layer rather than reimplementing it inside route screens.

## Related Issues

- [Command palette source search should use compact typed search and reset stale async state](./command-palette-source-lookup-search-query.md) covers the command/search system as shell-owned behavior.
- [Route-owned Collection Explorer modes with URL handoff](../architecture-patterns/collection-explorer-route-owned-modes.md) covers exact route-owned UI state and avoiding leakage across adjacent routes.
- [Process Queue Source Reader Unframed Workbench](./process-queue-source-reader-unframed-workbench.md) covers removing visible queue/process chrome while preserving action flow.
- [Process Queue Source Reader Library Header](./process-queue-source-reader-library-header.md) covers queue workbench chrome ownership.
- [Daily work read model routes inbox-only days honestly](./daily-work-read-model-inbox-only-routing.md) covers keeping `/queue` route semantics precise.

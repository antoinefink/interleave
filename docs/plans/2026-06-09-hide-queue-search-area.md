---
title: Hide Queue Search Area
status: active
date: 2026-06-09
origin: user request
execution: code
---

# Hide Queue Search Area

## Problem

The persistent shell topbar includes the visible "Search, import, or run command..."
command/search area on every route. In the Queue view, that vertical chrome competes
with the due-item workspace. The Queue route should reclaim that space while keeping
global keyboard access to search and commands.

## Scope

- Hide the shell topbar only for the exact `/queue` route.
- Do not hide or change `/process`, `/search`, or other routes.
- Keep global shortcuts mounted: `/` still opens Search and Cmd/Ctrl+K still opens
  the command palette.
- Do not add Queue-specific shortcut handling.

## Implementation Unit

### U1: Route-Aware Shell Topbar

Files:
- Modify: `apps/web/src/shell/Shell.tsx`
- Modify: `apps/web/src/shell/Shell.test.tsx`

Approach:
- Derive a small boolean from `pathname === "/queue"` in `ShellInner`.
- Omit the whole `Topbar` component when that boolean is true, rather than hiding
  only `.shell-cmdbar`, so `.shell-topbar` does not reserve `--topbar-h`.
- Leave `useShellShortcuts` wiring unchanged.

Test Scenarios:
- `/queue` renders the route outlet and inspector but no `command-bar`.
- `/queue` still passes shortcut handlers that can open Search and the command palette.
- A non-queue route, such as `/inbox`, still renders `command-bar`, and clicking it
  opens the command palette.
- Existing `useShellShortcuts` coverage continues proving `/` is suppressed while
  typing and active outside fields.

Verification:
- Run the targeted shell tests.
- Run typecheck if the targeted test passes.

## Risks

- Existing shell tests default to `/queue`, so tests that click the visible command
  bar must explicitly set a non-queue pathname.
- Over-broad route matching would hide chrome on adjacent workflows. Use exact
  matching unless product direction expands the behavior.

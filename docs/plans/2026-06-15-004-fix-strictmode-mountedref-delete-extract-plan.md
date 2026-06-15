---
title: "fix: Delete-extract button is dead under StrictMode (mountedRef never reset on remount)"
type: fix
date: 2026-06-15
status: ready
depth: lightweight
---

# fix: Delete-extract button is dead under StrictMode (mountedRef never reset on remount)

## Summary

The "Delete extract" trash button in the extract reader does nothing when clicked in the
running app. The full delete chain (component → `useLineageDelete` → `appApi.deleteExtract`
→ IPC → `extract-service` soft-delete + `operation_log`) is correctly wired and fully
tested — but `LineageDeleteMenu.handleTrigger` bails out at `if (!mountedRef.current) return`
*after* awaiting `countDescendants`, and under React 18 **StrictMode** (enabled at
`apps/web/src/main.tsx:41`) `mountedRef.current` is permanently `false`. The fix is a
two-line correction to the mount-effect in two components that use the same broken
`mountedRef` idiom.

## Problem Frame

`LineageDeleteMenu.tsx` declares:

```tsx
const mountedRef = useRef(true);
useEffect(() => {
  return () => { mountedRef.current = false; };  // only ever sets FALSE
}, []);
```

A `useRef` object survives StrictMode's dev-only mount → unmount → remount cycle (same
fiber, ref is not recreated). The sequence is: init `true` → mount → cleanup sets `false`
→ remount runs the effect body, which only *registers a cleanup* and never restores `true`.
Result: after the StrictMode cycle, `mountedRef.current === false` for the entire lifetime
of the component.

`handleTrigger` then does:

```tsx
result = await appApi.countDescendants({ id: target.id });
if (!mountedRef.current) return;   // ← always true in dev → delete never fires
...
```

Both the success branch (leaf quiet-delete + popover open) and the `catch` fallback
(`quietAfterCountError`) are gated on `mountedRef.current`, so the delete is fully dead in
dev — clicking does nothing, silently.

**Why it escaped every test:** React Testing Library's `render()` does not wrap trees in
`StrictMode`, so `mountedRef.current` stays `true` in tests and all 61 renderer + 117
server-side tests pass. This is a "green tests, broken app" gap, not a logic error the
existing suite could catch. Only the delete button is affected because it is the only
extract action that guards on `mountedRef` after an `await` (Postpone / Mark done / Trim
have no such post-await guard).

The repo already contains the **correct** idiom — `ReviewScreen.tsx:232` and
`ReviewRepairBar.tsx:129` both use `useRef(false)` and set `mountedRef.current = true`
inside the mount effect. `LineageDeleteMenu` and `DoneIntentMenu` are the two that drifted
from it.

## Scope

- **In scope:** correct the `mountedRef` reset in `LineageDeleteMenu.tsx` and the
  identical twin defect in `DoneIntentMenu.tsx` (the queue "Mark done" intent fast-path,
  dead under StrictMode for the same reason). Add regression coverage that exercises the
  bug under `StrictMode`.
- **Out of scope:** any change to the delete domain logic, IPC contract, soft-delete /
  `operation_log` behavior, or the lineage-deletion UX. The backend is correct and stays
  untouched.

### Deferred to Follow-Up Work

- A lightweight lint guard / shared `useIsMounted()` hook to prevent the broken idiom from
  reappearing. Noted, not done here — keep this fix minimal.

## Key Technical Decisions

- **Fix the idiom in place, matching the existing correct pattern.** Use `useRef(false)`
  and set `mountedRef.current = true` at the top of the mount effect, mirroring
  `ReviewScreen.tsx` / `ReviewRepairBar.tsx`. This is the smallest change that is also
  consistent with the codebase's own established convention.
- **Fix both occurrences in one change.** `DoneIntentMenu` carries the byte-identical
  defect and the same after-`await` `mountedRef` guard; fixing only the reported button
  would leave a known twin bug live. Both are the same root cause.
- **Regression test must use `StrictMode`.** A test that renders normally cannot reproduce
  this. The new test renders the component inside `<StrictMode>` and asserts the click
  still reaches the delete command.

## Implementation Units

### U1. Reset `mountedRef` on mount in `LineageDeleteMenu`

**Goal:** Make the delete trigger fire under StrictMode.
**Files:**
- `apps/web/src/components/lineage/LineageDeleteMenu.tsx`
**Approach:** Change `const mountedRef = useRef(true)` → `useRef(false)` and update the
mount effect to set `mountedRef.current = true` before returning the cleanup that sets it
`false`. No other logic changes.
**Patterns to follow:** `apps/web/src/review/ReviewScreen.tsx:232-251`,
`apps/web/src/review/ReviewRepairBar.tsx:129-156`.
**Test scenarios** (`apps/web/src/components/lineage/LineageDeleteMenu.test.tsx`):
- Under `<StrictMode>`, with `countDescendants` mocked to `total: 0`, clicking the trigger
  invokes `actions.quiet` (the delete path). This test FAILS before the fix and passes
  after — the core regression guard.
- Under `<StrictMode>`, with `countDescendants` mocked to `total > 0`, clicking opens the
  popover (`lineage-delete-pop` present).
- Existing non-StrictMode tests continue to pass unchanged.

### U2. Reset `mountedRef` on mount in `DoneIntentMenu`

**Goal:** Fix the identical twin defect in the queue "Mark done" intent fast-path.
**Files:**
- `apps/web/src/components/queue/DoneIntentMenu.tsx`
**Approach:** Same correction as U1: `useRef(false)` + set `true` in the mount effect,
preserving the existing `forceOpenRequestRef.current += 1` cleanup line.
**Patterns to follow:** U1.
**Test scenarios** (`apps/web/src/components/queue/DoneIntentMenu.test.tsx`):
- Under `<StrictMode>`, with the summary mocked to `canMarkDoneWithoutConfirmation: true`,
  clicking the trigger invokes `onResolved("finished")`. Fails before, passes after.
- Existing tests continue to pass unchanged.

## Verification

- New StrictMode regression tests fail on the pre-fix code and pass after (prove the bug,
  prove the fix).
- `pnpm lint`, `pnpm typecheck`, `pnpm test` all green.
- Manual / E2E confirmation that clicking "Delete extract" in the running app soft-deletes
  the extract (relevant `tests/electron/lineage-deletion.spec.ts` still green; a real
  Electron run is the ground truth since the runtime is where the bug lived).

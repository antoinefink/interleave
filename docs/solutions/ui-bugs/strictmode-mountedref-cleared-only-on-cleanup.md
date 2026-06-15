---
title: "Mount-guard ref dead under StrictMode when only cleared on cleanup (silent no-op UI actions)"
date: 2026-06-15
last_updated: 2026-06-15
category: ui-bugs
module: apps/web (React renderer)
problem_type: ui_bug
component: "frontend_stimulus"
symptoms:
  - "Clicking the extract reader's Delete button does nothing — no delete, no error, no toast"
  - "An async UI action (delete, mark-done, load) silently no-ops only in the running app, never in tests"
  - "Bug reproduces in dev / the packaged app but every unit test for the action passes green"
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [react, strictmode, mountedref, useref, useeffect, post-await-guard, test-gap]
---

# Mount-guard ref dead under StrictMode when only cleared on cleanup (silent no-op UI actions)

## Problem

A `mountedRef` declared as `useRef(true)` and only set back to `false` in the
effect's cleanup (never re-set to `true` on mount) is permanently `false` for the
component's whole life under React **StrictMode**. Any `if (!mountedRef.current) return`
guard that runs after an `await` then silently bails, so the action it guards never
runs. The reported symptom was the extract reader's "Delete extract" button doing
nothing; the same defect was live in three other components.

## Symptoms

- Clicking "Delete extract" in the extract reader did nothing — no soft-delete, no
  snackbar, no error.
- The full delete chain (component → `useLineageDelete` → `appApi.deleteExtract` → IPC →
  `extract-service` soft-delete + `operation_log`) was correctly wired, yet nothing fired.
- Reproduced only in the running app (dev + packaged Electron, where StrictMode is active),
  never in the test suite.

## What Didn't Work

- **Tracing the IPC / db chain.** Every layer — preload bridge, `IPC_CHANNELS.extractsDelete`
  handler, `ExtractService.delete`, `ElementRepository.softDelete`, the `operation_log`
  append — was correctly registered and wired. The chain was not the problem.
- **Suspecting a CSS / stacking regression.** `.lindel`/`.tt` are inline-flex with no
  overlap; the tooltip bubble is `pointer-events: none`. The button received clicks fine.
- **Running the existing tests.** All renderer tests (`LineageDeleteMenu.test.tsx`,
  `ExtractView.test.tsx`) and all server-side tests passed. They could not reproduce it —
  see "Why This Works" for the reason.

## Solution

Set the ref to `true` on mount inside the effect body, mirroring the codebase's already-correct
sites (`apps/web/src/review/ReviewScreen.tsx`, `apps/web/src/maintenance/ReverifyScreen.tsx`).

Before (broken):

```tsx
const mountedRef = useRef(true);
useEffect(() => {
  return () => {
    mountedRef.current = false; // only ever sets false
  };
}, []);
```

After (correct):

```tsx
const mountedRef = useRef(false);
useEffect(() => {
  mountedRef.current = true;          // set on mount
  return () => {
    mountedRef.current = false;       // clear on unmount
  };
}, []);
```

Four components carried the defect and were fixed the same way:
`apps/web/src/components/lineage/LineageDeleteMenu.tsx` (the reported delete button),
`apps/web/src/components/queue/DoneIntentMenu.tsx` (queue mark-done fast path),
`apps/web/src/pages/source/SourceReader.tsx` (dropped toasts, stuck exit-busy, missing
inspector data), and the outer `Settings` component in `apps/web/src/pages/Settings.tsx`
(dropped backup-list loader results). Keeping `useRef(true)` and adding the on-mount set is
equally correct — the load-bearing change is the assignment inside the effect.

## Why This Works

A `useRef` object survives StrictMode's dev-only mount → unmount → remount cycle — it is the
same fiber, the ref is not recreated. With the broken idiom the trajectory is:
init `true` → mount (effect registers cleanup only) → StrictMode unmount (cleanup sets `false`)
→ StrictMode remount (effect runs again but only registers cleanup) → **stays `false`**. With
the fix the remount runs `mountedRef.current = true`, so the trajectory ends `true`, and a
genuine later unmount still sets it `false` — the guard's real purpose (don't touch state after
the host navigated away) is preserved.

**Why every test passed while the app was broken:** React Testing Library's `render()` does
**not** wrap the tree in `<StrictMode>`. So in tests `mountedRef.current` stayed `true` and the
guarded action fired; only the real app (which renders under `<StrictMode>` in
`apps/web/src/main.tsx`) exercised the remount cycle that poisoned the ref. This is the classic
"green tests, broken app" blind spot.

## Prevention

- **Mount-guard refs must be set in the effect body, not just cleared in cleanup.** The
  canonical form is `useRef(false)` + `mountedRef.current = true` on mount + `false` on
  cleanup. A `useRef(true)` whose effect only clears on cleanup is wrong under StrictMode.
- **Regression-test the StrictMode path explicitly.** Because RTL `render()` skips StrictMode,
  wrap the component in `<StrictMode>` in the test that guards the async action. This test fails
  on the broken idiom and passes on the fix:

  ```tsx
  import { StrictMode } from "react";

  it("still fires the guarded action after the StrictMode remount cycle", async () => {
    render(
      <StrictMode>
        <LineageDeleteMenu target={EXTRACT} actions={actions} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByTestId("lineage-delete-trigger"));
    await waitFor(() => expect(actions.quiet).toHaveBeenCalledWith(EXTRACT));
  });
  ```

- **Cover every ENTRY POINT into a shared guarded component, not just one.** A component
  carrying the post-await guard is often reached through more than one trigger, and each is a
  separate code path that must survive the remount cycle. `LineageDeleteMenu` is reached two
  ways: a **visible trigger** (the extract reader / queue / source surfaces call
  `fireEvent.click` on the `lineage-delete-trigger` button) and a **hidden, signal-driven
  trigger** — the inspector lineage **context-menu** "Delete" item does not click the button; it
  bumps a `triggerSignal` prop that a `useEffect` in `LineageDeleteMenu` watches. A StrictMode
  test through the visible trigger does **not** protect the signal-driven path. Add a StrictMode
  regression test per distinct entry point (the inspector context-menu path is covered in
  `apps/web/src/components/inspector/LineageContextMenu.test.tsx`, exercising leaf fast-path,
  descendant popover, and the count-error fall-through — each fails on the broken idiom). Same
  rule for the `submittingRef`/post-await guard's error branches: the `catch` block has its own
  `if (!mountedRef.current) return`, so cover the failure path too, not only the happy path.
- **Audit siblings when fixing one instance.** Grep `useRef(true)` across the renderer and
  check each for a cleanup-only effect — the idiom tends to be copied. (A follow-up to extract a
  shared `useIsMounted()` hook + a lint guard is tracked separately.)
- **Treat "tests green, app broken" as a signal to check StrictMode / real-runtime-only
  behavior**, not just to trust the suite.

## Related Issues

- `docs/solutions/ui-bugs/embedded-active-card-detail-in-extract-workspace.md` — establishes
  the team convention of guarding async UI with `mountedRef` + request-sequence refs; this doc
  adds the StrictMode failure mode of that same guard.
- `docs/solutions/design-patterns/non-modal-intent-menu-replacing-confirm-gate.md` — documents
  `DoneIntentMenu`'s in-flight guard / post-await `mountedRef` surface, one of the components
  fixed here.
- `docs/solutions/architecture-patterns/lineage-aware-deletion-tombstone-purge-guard.md` (T135)
  — the lineage delete flow whose reader entry point was the reported dead button.

---
title: Fix Balance Banner Inbox Triage Action and Dismissal UX
status: completed
date: 2026-06-08
origin: user request
execution: code
---

# Fix Balance Banner Inbox Triage Action and Dismissal UX

## Problem Frame

The import/process balance warning's **Triage inbox** button is actionable only when the user is away from `/inbox`. On the inbox screen itself it calls `navigate({ to: "/inbox" })`, so clicking it appears broken. The same warning also needs a low-friction way to hide it temporarily or permanently without visiting Settings.

Scope is limited to the shared balance warning UI, its renderer persistence wiring, inbox focus behavior, tests, and visual verification. The balance math, inbox triage domain operations, analytics counts, and Settings screen slider/toggle remain unchanged.

## Requirements Trace

- Clicking **Triage inbox** from any route must navigate to `/inbox`.
- Clicking **Triage inbox** while already on `/inbox` must do something visible and useful: focus the inbox list / first row and scroll the inbox work area into view.
- The warning must offer dismissal for one week.
- The warning must offer permanent dismissal.
- One-week dismissal must survive app restart and automatically expire.
- Permanent dismissal must reuse the existing durable `balanceWarnings = false` typed setting so Settings stays the source of truth for re-enabling.
- Renderer code must use the typed/generic `window.appApi` settings bridge only; no raw SQLite/filesystem/localStorage for this preference.

## Current Pattern References

- `apps/web/src/components/BalanceBanner.tsx` reads `appApi.getAppSettings()` and `appApi.getBalance()` and renders **Open queue** / **Triage inbox** actions.
- `apps/web/src/pages/inbox/InboxScreen.tsx` mounts `<BalanceBanner refreshKey={balanceRefresh} />` above the inbox body.
- `apps/web/src/shell/Shell.tsx` uses generic SQLite-backed settings keys for durable UI notices (`ui.seenOnboarding`, `ui.tipsEnabled`, `ui.coachSeen`).
- `apps/web/src/components/queue/ScheduleMenu.tsx` is the local pattern for compact popover menus with outside-click and Escape handling.
- `apps/web/src/components/BalanceBanner.test.tsx` is the focused renderer unit test target.
- `tests/electron/balance.spec.ts` is the existing visual/E2E surface for this warning.

## Decisions

1. Store temporary notice dismissal in generic settings under `ui.noticeDismissals`.
   Rationale: this is a restart-surviving UI acknowledgement, not a domain setting. The generic settings API is already SQLite-backed and avoids expanding the typed `AppSettings` model for a single notice timestamp.

2. Store permanent dismissal by updating typed settings with `{ balanceWarnings: false }`.
   Rationale: the Settings screen already exposes "Import / process balance warnings"; using the existing field keeps one permanent source of truth.

3. Use a compact overflow menu on the banner.
   Rationale: the main action row stays focused on work actions. The menu can contain `Hide for a week` and `Turn off warning` without crowding the banner.

4. Make same-route inbox triage focus the inbox list instead of auto-triaging.
   Rationale: a warning action should not mutate the user's data. Focusing the first inbox row makes the click visibly work and positions the user at the triage controls.

## Implementation Units

### U1: Durable Notice Dismissal Helpers

Files:
- Modify: `apps/web/src/components/BalanceBanner.tsx`
- Test: `apps/web/src/components/BalanceBanner.test.tsx`

Approach:
- Add a constant notice id for the balance banner and generic settings key `ui.noticeDismissals`.
- On load, read `appApi.getSettings({ key: "ui.noticeDismissals" })` alongside app settings and balance data.
- Hide the banner when the dismissal entry has `forever: true` or `until` later than `Date.now()`.
- For `Hide for a week`, write an ISO timestamp seven days from now via `appApi.updateSetting`.
- For `Turn off warning`, call `appApi.updateAppSettings({ patch: { balanceWarnings: false } })` and hide immediately.

Test scenarios:
- Renders warning when imbalanced, enabled, and not dismissed.
- Hides warning when the generic dismissal timestamp is still in the future.
- Shows warning when the generic dismissal timestamp is expired.
- Clicking `Hide for a week` writes `ui.noticeDismissals` with a future ISO timestamp and hides the warning.
- Clicking `Turn off warning` writes `{ balanceWarnings: false }` through typed settings and hides the warning.

### U2: Useful Triage Inbox Click

Files:
- Modify: `apps/web/src/components/BalanceBanner.tsx`
- Modify: `apps/web/src/pages/inbox/InboxScreen.tsx`
- Test: `apps/web/src/components/BalanceBanner.test.tsx`
- Test: `apps/web/src/pages/inbox/InboxScreen.test.tsx`

Approach:
- Let `BalanceBanner` accept an optional `onTriageInbox` callback.
- If supplied, call it instead of same-route navigation; otherwise navigate to `/inbox`.
- In `InboxScreen`, pass a callback that scrolls the inbox list into view and focuses the first selected row or first row.
- Add refs to the inbox list container/rows without changing existing triage behavior.

Test scenarios:
- Without callback, **Triage inbox** navigates to `/inbox`.
- With callback, **Triage inbox** calls the callback and does not navigate.
- Inbox screen callback focuses an inbox row when the banner triage action is clicked.

### U3: Visual Verification

Files:
- Modify: `tests/electron/balance.spec.ts`

Approach:
- Extend the existing balance warning E2E coverage to click the warning's inbox action on `/inbox` and assert the inbox row focus/active target becomes visible.
- Add coverage for opening the dismissal menu and visually asserting both menu choices are present.
- Prefer a screenshot after opening the menu so the UX can be inspected in the test artifacts.

Test scenarios:
- On `/inbox`, clicking **Triage inbox** focuses the inbox list rather than doing nothing.
- Dismiss menu opens and presents `Hide for a week` and `Turn off warning`.

## Verification

- `pnpm --filter @interleave/web test -- BalanceBanner.test.tsx InboxScreen.test.tsx`
- `pnpm typecheck`
- `pnpm test`
- Relevant Electron visual verification for the balance warning route, using the existing E2E target when feasible.

## Risks

- Generic settings values are untyped JSON; parsing must be defensive and ignore malformed values.
- Permanent dismissal should not erase the generic snooze object; the existing typed setting is enough to hide the warning.
- Tests must not depend on the current real date except by asserting "future" relative to `Date.now()`.

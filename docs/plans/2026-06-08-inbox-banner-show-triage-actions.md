---
title: "Inbox Banner Show Triage Actions"
type: fix
status: completed
date: 2026-06-08
origin: user-request
execution: code
---

# Inbox Banner Show Triage Actions

## Summary

Improve the import/process balance banner so its inbox CTA always produces a visible, useful result. Cross-route usage still navigates to `/inbox`; same-route usage on `/inbox` changes copy to `Show triage actions`, focuses the selected item's `Read now` action, and briefly highlights the triage section.

## Problem Frame

The current inbox-page callback scrolls and focuses the active inbox row. When the row is already visible, the banner button appears inert even though the click handler ran. The CTA label also says `Triage inbox`, which implies it will perform triage rather than point the user to the actual per-item triage controls.

## Requirements

- R1. On non-inbox pages, the balance banner keeps the `Triage inbox` CTA and navigates to `/inbox` when inbox work exists.
- R2. On `/inbox`, the balance banner CTA label becomes `Show triage actions` when inbox work exists.
- R3. On `/inbox`, clicking the banner CTA scrolls the selected item's triage section into view and focuses the `Read now` button.
- R4. On `/inbox`, clicking the banner CTA creates a short-lived visual highlight on the triage section so the user sees the effect even when nothing moves.
- R5. Existing action gating remains based on `dueQueueItems` and `inboxSources`; do not use `reviewsDueThisWeek` to decide whether `Open queue` or inbox action is offered.
- R6. The change is renderer-only and must not alter inbox mutations, balance math, IPC contracts, or source lifecycle behavior.

## Key Technical Decisions

- **Keep `BalanceBanner` generic:** Extend the component with route-provided label/callback props rather than teaching it about the inbox layout. This preserves the existing same-route callback pattern in `BalanceBanner.tsx`.
- **Focus the action rail instead of the list row:** `InboxScreen` owns refs to the triage section and `Read now` button because those are the controls that complete the task the CTA promises.
- **Use transient local UI state for the pulse:** The highlight is a visible affordance, not persisted state. A short timeout in `InboxScreen` is enough and avoids changing app settings or domain data.
- **Keep the test surface focused:** Component tests should cover cross-route label/navigation and same-route label/callback. Inbox tests should cover focus and highlight behavior.

## Implementation Units

### U1. Route-specific banner copy

- **Goal:** Let a route customize the inbox CTA label while preserving the default `Triage inbox` copy and navigation behavior.
- **Files:** Modify `apps/web/src/components/BalanceBanner.tsx`; update `apps/web/src/components/BalanceBanner.test.tsx`.
- **Patterns:** Follow the existing `onTriageInbox` optional callback at `apps/web/src/components/BalanceBanner.tsx`.
- **Test Scenarios:** Default render with inbox work shows `Triage inbox`; passing route-specific copy shows `Show triage actions`; default click navigates to `/inbox`; callback click does not navigate.
- **Verification:** Focused BalanceBanner tests pass.

### U2. Inbox triage action focus and pulse

- **Goal:** Replace row focus with triage-section focus behavior on `/inbox`.
- **Files:** Modify `apps/web/src/pages/inbox/InboxScreen.tsx`; update `apps/web/src/pages/inbox/InboxScreen.test.tsx`.
- **Patterns:** Follow existing refs and selected-item repair in `InboxScreen`; use design tokens/classes rather than hard-coded colors.
- **Test Scenarios:** Clicking the mocked banner CTA focuses `inbox-read-now`; the triage section receives a transient highlighted state; when the selected item changes or the timeout expires, highlight clears.
- **Verification:** Focused InboxScreen tests pass.

### U3. Quality gates and final evidence

- **Goal:** Verify the renderer change and preserve project quality gates.
- **Files:** No new behavior files expected beyond U1 and U2.
- **Patterns:** Use native `pnpm`; do not use Docker for desktop app work.
- **Test Scenarios:** Run the focused tests first, then broader workspace checks appropriate for this small renderer fix.
- **Verification:** `pnpm --filter @interleave/web test -- BalanceBanner InboxScreen` or equivalent focused Vitest command passes; `pnpm typecheck` and `pnpm test` pass before landing.

## Scope Boundaries

- Do not change balance analytics, queue predicates, source scheduling, inbox triage mutations, or dismissal persistence.
- Do not add a new route or modal.
- Do not hide the banner's inbox CTA on `/inbox`; this plan chooses a visible action target instead.

## Sources

- `apps/web/src/components/BalanceBanner.tsx`
- `apps/web/src/components/BalanceBanner.test.tsx`
- `apps/web/src/pages/inbox/InboxScreen.tsx`
- `apps/web/src/pages/inbox/InboxScreen.test.tsx`
- `docs/solutions/ui-bugs/balance-banner-queue-inbox-action-gating.md`

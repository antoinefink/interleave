---
title: "Balance banner actions should stay actionable and dismissible"
date: "2026-06-07"
category: "docs/solutions/ui-bugs/"
module: "import-process-balance-banner"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "Fresh article imports triggered the import/process balance banner."
  - "Clicking Open queue after those imports navigated to an empty /queue."
  - "Reviews due later this week could imply queue work even when no item was due now."
  - "Clicking Triage inbox while already on /inbox looked broken because it only re-navigated to the current route."
  - "The warning could not be durably hidden for a week or forever from the banner itself."
root_cause: "logic_error"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "service_object"
  - "database"
  - "testing_framework"
tags:
  - "balance-banner"
  - "import-balance"
  - "queue"
  - "inbox"
  - "focus-management"
  - "settings"
  - "ipc"
  - "actionable-counts"
  - "dismissal"
---

# Balance banner actions should stay actionable and dismissible

## Problem

Fresh imports made the import/process balance banner show a warning, but the banner routed users to `Open queue` even though newly imported sources live in the inbox with no due date. Since `/queue` only shows currently due work, users landed on an empty queue instead of the actionable inbox triage surface.

A later follow-up exposed the same product rule from another angle: after the banner correctly offered `Triage inbox`, clicking that button while already on `/inbox` still appeared broken because it only navigated to the current route. The warning also needed durable dismissal controls so users could hide it for a week or forever without leaving the banner.

## Symptoms

- Fresh source imports triggered "You're importing faster than you process."
- `Open queue` appeared even when no queue item was due now.
- `/queue` was empty because inbox sources are not due queue items.
- Forward-looking "reviews due this week" could be nonzero before any review was due now.
- The warning was analytically correct but operationally misleading.
- On `/inbox`, `Triage inbox` produced no focus movement, scroll, or visible confirmation.
- Focusing the inbox row was still too weak: when the row was already visible, the click looked inert and did not point to `Read now`, `Save for later`, or `Delete`.
- Temporary dismissal needed to survive restart and then expire.
- Permanent dismissal needed to reuse the existing balance-warning setting instead of local UI state.

## What Didn't Work

- Using the weekly imbalance alone to decide banner actions was too coarse.
- Treating "reviews due this week" as queue work was wrong because it includes future reviews, not only work due at `asOf`.
- Routing all imbalances to `/queue` ignored the product split between inbox triage and due queue processing.
- Scheduling fresh imports as part of this fix would have changed source lifecycle behavior and mixed an advisory banner with scheduler side effects.
- Suppressing the raw imbalance judgment in the domain result would have hidden a truthful analytics signal from the renderer.
- Keeping `Triage inbox` as plain route navigation was only useful from other routes; same-route navigation did not create an actionable local effect.
- Focusing the selected inbox row on the same route improved keyboard position but still targeted navigation context, not the controls that complete triage.
- A simple immediate focus call also missed the async detail-loading case, where the selected item's preview and triage rail may not be mounted yet.
- Keeping warning dismissal in React state would have hidden it only until remount or restart.
- Writing Playwright screenshots to a hard-coded local checkout path made visual verification non-portable; use Playwright-managed output paths.

## Solution

Keep the balance query responsible for the raw weekly judgment, but add live actionable counts:

```ts
const inboxSources = this.queue.inboxCount("source");
const dueQueueItems = this.queue.dueCardCount(asOf) + this.queue.dueAttentionCount(asOf);
```

`QueueRepository.inboxCount` owns the inbox predicate: live elements with `status: "inbox"`, optionally filtered by type. `dueQueueItems` mirrors `/queue`: due FSRS cards plus due attention items at `asOf`.

Keep `reviewsDueThisWeek` as a separate forward-looking count, implemented with SQL `COUNT(*)` in `dueCardsBetween(from, to)`, so it remains a headline metric without controlling the queue action.

Expose the new counts through the desktop/shared/web contracts:

```ts
readonly inboxSources: number;
readonly dueQueueItems: number;
```

Then make `BalanceBanner` action rendering honest:

```tsx
const hasDueQueueWork = (data?.dueQueueItems ?? 0) > 0;
const hasInboxWork = (data?.inboxSources ?? 0) > 0;

if (!enabled || !data?.imbalanced || (!hasDueQueueWork && !hasInboxWork)) return null;
```

Render `Open queue` only when `dueQueueItems > 0`; render `Triage inbox` only when `inboxSources > 0`. If the raw imbalance exists but neither action has current work, hide the banner rather than offering a dead end.

For route actions that can target the current page, keep the banner reusable but let the current route supply a local effect:

```tsx
export interface BalanceBannerProps {
  readonly onTriageInbox?: () => void;
  readonly triageInboxLabel?: string;
}

const triageInbox = () => {
  if (onTriageInbox) onTriageInbox();
  else void navigate({ to: "/inbox" });
};
```

Use the default `triageInboxLabel = "Triage inbox"` for cross-route navigation. On `/inbox`, pass `triageInboxLabel="Show triage actions"` so the label describes the local effect instead of pretending to navigate somewhere new.

`InboxScreen` owns the preview-pane refs, so its callback scrolls the actual triage section into view, focuses the primary `Read now` action, and applies a short motion-safe highlight ring:

```tsx
const revealInboxTriageActions = () => {
  const triageActions = triageActionsRef.current;
  const readNowButton = readNowButtonRef.current;
  if (!triageActions || !readNowButton) return false;

  triageActions.scrollIntoView({ block: "nearest" });
  readNowButton.focus({ preventScroll: true });
  setTriageHighlighted(true);
  return true;
};
```

If the selected item detail has not mounted yet, record the pending focus target by element id and replay only when that same detail appears. Clear the pending id on selection change and detail-fetch failure so a click intended for one inbox item never focuses or highlights another.

For durable dismissal, persist through the existing settings bridge rather than local storage or renderer-only state:

```ts
const NOTICE_DISMISSALS_KEY = "ui.noticeDismissals";
const BALANCE_NOTICE_ID = "balance.importProcess";
```

`Hide for a week` writes a future ISO timestamp under the generic SQLite-backed settings key. The banner hides while that timestamp is in the future, schedules an in-session expiry reload, and shows again after expiry. `Hide forever` reuses the typed app setting:

```ts
await appApi.updateAppSettings({ patch: { balanceWarnings: false } });
```

Hide only after persistence succeeds. If saving fails, keep the warning visible and show a small inline error so the UI does not promise durable dismissal that did not persist.

## Why This Works

The fix separates analytics truth from UI actionability. `imbalanced` still means imports outpaced extracts/cards over the weekly window, but the banner only offers destinations that currently contain work.

Inbox imports are represented as inbox work, not queue work. Future reviews remain visible in the weekly count, but they no longer make `/queue` look actionable before they are due. All counting stays behind the Electron/IPC boundary, so React renders a typed snapshot instead of duplicating queue or inbox predicates.

The same-route callback keeps destination-specific behavior where the destination state lives. The banner does not need to know how `/inbox` renders rows or preview panes, but `/inbox` can make the CTA visibly useful by focusing the controls the user can act on next.

The route-specific label prevents a misleading navigation promise: `Triage inbox` remains correct from other routes, while `Show triage actions` is correct when the user is already on `/inbox`. Focusing `Read now` puts keyboard users on the first concrete triage command, and the motion-safe ring gives visible feedback even when the section was already in view.

Tying pending focus to the selected element id makes async detail loading safe. If the user changes selection before the old detail resolves, the pending reveal is cleared instead of replaying onto the wrong item.

The dismissal split matches product semantics. A one-week snooze is a notice acknowledgement, so generic settings are enough and avoid expanding typed domain settings for one timestamp. A forever hide is the existing product preference, so `balanceWarnings` remains the single source of truth and Settings can re-enable it later.

## Prevention

- Keep `/queue` action gating tied to due-now queue work, never to forward-looking review counts.
- Keep inbox triage gating tied to live inbox sources.
- Keep queue and inbox predicates owned by `QueueRepository` so UI and analytics cannot drift.
- Test inbox-only imports, due-now queue work, future-only reviews, and imbalanced/no-action snapshots.
- Preserve E2E coverage that imports fresh sources and asserts `Open queue` is absent while `Triage inbox` is visible.
- Include contract tests whenever balance snapshot fields change across local-db, desktop IPC, preload, and renderer wrappers.
- For CTAs that can target the current route, test cross-route navigation, same-route label copy, focus movement to the next actionable control, visible feedback, async mount replay, and stale-selection cancellation.
- For dismissals that claim to be durable, add Electron restart coverage proving the setting survives outside mocked renderer APIs.
- Capture visual verification with `test.info().outputPath(...)` so artifacts are portable across worktrees and CI.
- Hide warnings only after persistence succeeds, or keep the warning visible with a clear error if saving fails.

## Related Issues

- [URL and browser-captured articles should open as internal readable sources](./url-imported-articles-inbox-processing.md) documents the lifecycle invariant that imported articles remain inbox work until accepted or opened.
- [Daily work read model routes inbox-only days honestly](./daily-work-read-model-inbox-only-routing.md) documents the same invariant at the home/daily-work layer: primary CTAs should point at the current actionable work, not an analytically related empty surface.
- [Extract inspector single-responsibility layout and scheduler refresh](./extract-inspector-single-responsibility-lineage-scheduler.md) is a queue membership precedent: mutations from one surface must refresh the surfaces that render queue state.
- [Active card rows should open a protected card detail surface](./active-card-rows-open-card-detail-surface.md) is a routing precedent: a due-session route is not a generic destination for every item-related action.
- Plan artifact: `docs/plans/2026-06-07-fix-balance-empty-queue.md`.
- Follow-up plan artifact: `docs/plans/2026-06-08-fix-triage-inbox-warning.md`.
- Follow-up plan artifact: `docs/plans/2026-06-08-inbox-banner-show-triage-actions.md`.

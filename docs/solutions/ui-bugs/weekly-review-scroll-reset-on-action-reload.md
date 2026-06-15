---
title: "Weekly Review scroll resets to top on action reload (stale-while-revalidate, not a loading-placeholder remount)"
date: "2026-06-15"
category: "docs/solutions/ui-bugs/"
module: "apps/web weekly review screen"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "Clicking Done/Skip on a Weekly Review section scrolled the page back to the top, losing scroll position"
  - "Same scroll jump on Complete, Snooze, and Apply parked/chronic decisions — every in-screen action"
  - "A one-frame flash of the full-page \"Loading weekly review...\" placeholder on every in-screen mutation"
  - "A failed post-action reload replaced the whole screen with the full-page error state instead of an inline message"
root_cause: "logic_error"
resolution_type: "code_fix"
severity: "medium"
tags:
  - "weekly-review"
  - "scroll-position"
  - "scroll-ownership"
  - "stale-while-revalidate"
  - "keep-previous-data"
  - "shell-scroller"
  - "loading-placeholder"
  - "background-refetch"
related_components:
  - "apps/web/src/weekly/WeeklyReviewScreen.tsx"
  - "apps/web/src/weekly/WeeklyReviewScreen.test.tsx"
  - "apps/web/src/shell/shell.css"
---

# Weekly Review scroll resets to top on action reload

## Problem

On the Weekly Review screen (`/weekly`), clicking **Done** or **Skip** on a section — and **Complete**, **Snooze**, or the parked/chronic **Apply** buttons — scrolled the page back to the top, losing the user's place mid-review. Every one of those handlers refetched the summary through `load()`, which flipped the whole screen to a loading placeholder, unmounting the rendered body for a frame.

## Symptoms

- Scroll position resets to the top on every section toggle and every forced-decision apply.
- A momentary flash of the full-page `Loading weekly review...` placeholder on each mutation.
- The further you had scrolled, the more jarring the jump.
- When the post-action reload failed, the entire screen was replaced by the full-page error state rather than surfacing an inline banner.

## What Didn't Work

The obvious browser-default culprits were ruled out before finding the real cause:

- **NOT a form default-submit.** There is no `<form>` on the screen; the buttons are `type="button"` with `onClick`, so no implicit submit/navigation fires.
- **NOT an `<a href="#">`.** Toggles are `<button>` elements, not anchors — no hash navigation to the top.
- **NOT router scroll restoration.** Toggling a section does not change the route, so no router scroll-restore logic runs (the router is unconfigured for scroll restoration anyway).

The cause was the data-loading cycle, not an event default. Each handler did `await onReload()`, and `onReload` was wired straight to `load`, which began with `setState({ status: "loading" })`. That flipped `WeeklyReviewScreen` to its loading branch, **unmounting `<WeeklyReviewBody>`** and rendering the bare placeholder. The app's scroll is owned by the shell route scroller `<main className="shell-page">` (`apps/web/src/shell/shell.css`, `overflow-y: auto`); collapsing its content to the placeholder reset `scrollTop` to 0, and when `ready` data returned a frame later the body remounted with the scroll position gone.

## Solution

Switch the in-screen refetch to **stale-while-revalidate**: keep the current `ready` data rendered during a reload so the body never unmounts. `load()` gained a `{ background }` option — only the initial load shows the placeholder, and background-mode failures re-throw so the action handler surfaces them inline instead of tearing down the screen.

```ts
// BEFORE — every reload flips to the loading placeholder, unmounting the body
const load = useCallback(async () => {
  setState({ status: "loading" });
  try {
    setState({ status: "ready", data: await appApi.getWeeklyReviewSummary() });
  } catch (error) {
    setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
  }
}, []);
// ...
return <WeeklyReviewBody summary={state.data} onReload={load} />;

// AFTER — background reloads keep current data rendered (stale-while-revalidate)
const load = useCallback(async (opts?: { background?: boolean }) => {
  const background = opts?.background ?? false;
  if (!background) setState({ status: "loading" });
  try {
    setState({ status: "ready", data: await appApi.getWeeklyReviewSummary() });
  } catch (error) {
    // Background failures re-throw so the calling action handler surfaces them
    // inline (setActionError) instead of replacing the mounted body with the
    // full-page error state.
    if (background) throw error;
    setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
  }
}, []);
// ...
return <WeeklyReviewBody summary={state.data} onReload={() => load({ background: true })} />;
```

Every action handler already wrapped `await onReload()` in a try/catch that calls `setActionError(...)`, so the re-thrown background error lands there. A follow-up review fix also corrected banner precedence so a stale success message can't render alongside the new error:

```tsx
// BEFORE: success + error banners could show at once after a failed reload
{message ? <div className="wk-msg">{message}</div> : null}
// AFTER: the error banner takes precedence
{message && !actionError ? <div className="wk-msg">{message}</div> : null}
```

## Why This Works

The route-level shell scroller (`.shell-page`) owns scroll position, and React preserves the DOM (and therefore `scrollTop`) of any component that stays mounted. With keep-previous-data, a refetch never enters the `loading` branch, so `<WeeklyReviewBody>` is never unmounted; the scroll container keeps its height and offset across the await. The mutation completes, fresh data swaps into the already-mounted body, and the user stays exactly where they were. Re-throwing on background failure preserves the original guarantee for the *initial* load (a full-page error is meaningful when there is nothing to show) while letting in-flight refetch failures surface as an inline banner instead of destroying scroll and context.

## Prevention

- **Don't flip a whole screen to a loading placeholder on an in-screen refetch.** When a refetch does not change the route — a toggle, an apply, an inline mutation that re-pulls the same view — prefer stale-while-revalidate: keep the last good data on screen and revalidate underneath. Reserve full-page loading/error states for the genuine initial load. Unmounting the body is what collapses the `.shell-page` scroll container. This is the complement of [[source-reader-scroll-extents-rich-source-rendering]]: that screen scopes scroll *away* from `.shell-page` to an inner scroller; this screen relies on `.shell-page` *being* the scroller, so its body must not be unmounted mid-session.
- **jsdom regression-test technique — freeze the in-flight reload.** jsdom has no layout or real scrolling, so `scrollTop` cannot be asserted directly. The provable proxy is "the full-page loading placeholder never reappears after the first render" — if the body never unmounts, scroll is preserved. Gate the *second* summary fetch (the post-toggle reload) on a hand-resolved promise to freeze the in-flight window, then assert the placeholder is absent throughout:

  ```ts
  const reloadGate: { resolve: ((v: WeeklyReviewSummaryResult) => void) | null } = { resolve: null };
  h.getWeeklyReviewSummary.mockReset();
  h.getWeeklyReviewSummary
    .mockResolvedValueOnce(BASE_SUMMARY)
    .mockImplementationOnce(() => new Promise((resolve) => { reloadGate.resolve = resolve; }));
  // render, click Done, wait for the persist call + 2nd fetch + reloadGate.resolve to be set, then:
  expect(screen.queryByText(/Loading weekly review/i)).toBeNull();   // placeholder never returns
  expect(screen.getByTestId("weekly-review")).toBeInTheDocument();   // body stays mounted
  ```

  A first version that did a synchronous `queryByText` immediately after the click was a **false positive** — it passed against the unmodified component, because `setState({ status: "loading" })` only flushes between awaits. The hand-resolved-promise gating is what makes the test genuinely fail red before the fix. Pair it with an inline-error test (mock the second fetch to reject; assert `weekly-action-error` shows while `weekly-error` and the placeholder stay absent), and add caller-level coverage for *each* handler sharing the `onReload` closure (section toggle, Complete, Snooze) — they all go through the same re-throw path.
- **Real `scrollTop` needs an Electron Playwright geometry test.** Asserting an actual preserved scroll offset requires a real layout engine and is only possible in an Electron Playwright test measuring `scrollTop` before/after a toggle. That was deferred; the jsdom proxy above is the unit-level guard. See the dual jsdom-contract + Electron-geometry verification recipe in [[three-zone-scroll-owned-review-card-surface]].

## Related Issues

- [[source-reader-scroll-extents-rich-source-rendering]] — the complementary scroll-ownership case: scope scroll *away* from `.shell-page` to an inner scroller. This doc is the inverse failure on a screen where `.shell-page` legitimately owns scroll.
- [[three-zone-scroll-owned-review-card-surface]] — owns the general scroll-ownership lesson and the dual jsdom + Electron-geometry verification recipe.
- [[scope-ported-design-kit-css-under-page-root]] — same screen (`WeeklyReviewScreen.tsx` + `weekly-review.css`); the other failure mode of the same Claude Design handoff port (scope-wrong vs. refetch-wrong).
- [[hover-uses-border-not-shadow-and-shadow-taxonomy]] — the same change removed the green `.wk-sec--done` left band; that convention doc records the contract-test-pinned removal.

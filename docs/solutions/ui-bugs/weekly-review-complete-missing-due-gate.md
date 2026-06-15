---
title: "Weekly Review Complete looked like it erased all marks: the screen gated on session presence, never the due boolean"
date: "2026-06-15"
category: "docs/solutions/ui-bugs/"
module: "apps/web weekly review screen"
problem_type: "ui_bug"
component: "frontend_stimulus"
root_cause: "logic_error"
resolution_type: "code_fix"
severity: "high"
related_components:
  - "packages/local-db weekly-review-service"
  - "packages/local-db weekly-review-query"
tags:
  - "weekly-review"
  - "due-vs-actionable"
  - "render-gating"
  - "escape-hatch-flag-reset"
  - "stale-while-revalidate"
  - "double-submit-guard"
symptoms:
  - "Clicking Complete on the Weekly Review re-rendered an identical-looking but fully-reset session, appearing to undo every Done/Skipped mark"
  - "The progress ring snapped back to 0/5 on a form that looked exactly like the one just completed"
  - 'A session opened early via "Review now" stayed editable after Complete, reintroducing the reset-looking bug through the very mitigation meant to fix it'
---

# Weekly Review Complete looked like it erased all marks (missing `summary.due` gate)

## Problem

On the Weekly Review screen (`apps/web/src/weekly/WeeklyReviewScreen.tsx`), clicking
**Complete** re-rendered the full editable form for a fresh, all-pending session — so it
looked like completing the review silently **reset (undid)** every Done/Skipped section mark
instead of finishing it. The fix was renderer-only: gate the form on the backend's
already-computed `summary.due` actionability signal and show a calm acknowledgment when a
session exists but is not due.

## Symptoms

- After **Complete**, the screen returned to an identical-looking editable form with the
  progress ring back at **0/5** — indistinguishable from an undo.
- The next session's all-pending state was presented as if the user's just-completed work had
  been wiped.
- A secondary surface: a brand-new user who simply *enabled* weekly review (session created
  not-yet-due) would be shown the form/"complete" state before ever doing a review.

## What Didn't Work (tempting but wrong)

- **Re-deriving due-ness in React from the raw `dueAt` timestamp.** Tempting to write
  `Date.parse(session.dueAt) <= Date.now()` inside the component. But `weekly-review-query.ts`
  already computes this authoritative signal in `isDue()` and ships it as `summary.due` through
  IPC — re-deriving it duplicates the rule, drifts from the backend's `asOf`, and re-introduces
  null handling (`dueAt` can be `null`). See
  [queue-eligibility-inventory-scheduler-state](../logic-errors/queue-eligibility-inventory-scheduler-state.md):
  due-vs-actionable is a backend fact, read as a boolean, not inferred in the renderer.
- **Adding a separate "just completed" loading/transition state (or a `mountedRef`)** to paper
  over the apparent flash. The screen already does stale-while-revalidate background reloads; the
  body never unmounts. The problem was never a loading race — it was rendering the *wrong branch*.
  A mount-guard ref here would have re-created the
  [strictmode-mountedref-cleared-only-on-cleanup](strictmode-mountedref-cleared-only-on-cleanup.md)
  defect family, and a full-page loading flip would have re-created
  [weekly-review-scroll-reset-on-action-reload](weekly-review-scroll-reset-on-action-reload.md).
- **Treating `summary.session != null` as "show the form."** That was the original gate, and it
  is exactly why a non-null-but-not-due *next* session rendered the editable form.

## Solution

The backend already did the right thing — `completeSession` marks the task done, deletes
per-session progress, and creates the **next** session a cadence ahead, so `summary.due` flips
false while `summary.session` stays non-null (this is the
[system-owned-recurring-tasks](../architecture-patterns/system-owned-recurring-tasks.md)
lifecycle):

```ts
// packages/local-db/src/weekly-review-service.ts — completeSession
const dueAt = addDays(asOf, cadenceDays);
// ...mark current task done, delete WEEKLY_PROGRESS_KEY...
return this.createSessionWithin(tx, dueAt, dueAt);   // next session: dueAt = now + cadence

// packages/local-db/src/weekly-review-query.ts
due: isDue(session, asOf),                            // already plumbed through IPC
function isDue(session, asOf) {
  if (!session?.dueAt) return false;
  return Date.parse(session.dueAt) <= Date.parse(asOf);
}
```

**1. Three-branch gate on the consumed `summary.due` (not `summary.session` alone):**

```tsx
// WeeklyReviewBody
if (!summary.session) return <WeeklyReviewOff />;          // off-state
if (!summary.due && !reviewNow) {                          // session exists but not due
  return (
    <WeeklyReviewNotDue
      session={summary.session}
      justCompleted={justCompleted}
      onReviewNow={() => setReviewNow(true)}
    />
  );
}
return ( /* existing editable form */ );                   // due -> form
```

**2. A `justCompleted` copy split** — distinguishes "I just finished one" (celebratory) from
"I just landed early / never started" (idle), so a brand-new user is not told the review is
"complete":

```tsx
const title = justCompleted ? "Weekly review complete" : "You're all caught up";
const body  = justCompleted
  ? "Your weekly session is done — the next one is scheduled below."
  : "No weekly review is due right now.";
```

**3. The headline lesson — reset the `reviewNow` escape-hatch flag on the terminal action.**
"Review now" opens the not-yet-due form by setting `reviewNow = true`. If `complete()` does not
clear it, the post-complete reload (`due === false`) re-renders the editable form for the *next*
session — reintroducing the exact bug, now reachable via the escape hatch:

```tsx
const complete = async () => {
  if (!summary.session) return;
  try {
    await appApi.completeWeeklyReview({ taskId: summary.session.id });
    setReviewNow(false);     // <- without this, "Review now" -> Complete re-opens the form
    setJustCompleted(true);
    await onReload();
  } catch (error) { setActionError(/* ... */); }
};
```

**4. A `justCompleted` double-submit guard** — if the mutation succeeds but the reload fails,
the still-`due` form stays mounted with the button re-enabled, and a second click would
re-complete an already-done session (which the one-open-weekly-task unique index then rejects):

```tsx
disabled={busySection !== null || locked || justCompleted}   // Complete button
```

**5. A null-`dueAt` guard** in the panel so a session with no `dueAt` never formats into
"Invalid Date":

```tsx
{session.dueAt ? <p>Next session due <span className="mono">{formatDate(session.dueAt)}</span></p> : null}
```

## Why This Works

`summary.due` is the **backend's authoritative actionability signal** — `isDue()` owns the
"is there review work to do right now?" rule against a single server `asOf`. Consuming it
instead of re-deriving from `dueAt` keeps one source of truth and inherits null handling for
free. The bug was a *missing read*, not a missing computation: the data was already on the wire.

The escape-hatch fix works because a renderer-local "show it anyway" flag temporarily overrides
a gate that hides a state. The moment the terminal action (`complete()`) changes the underlying
state back into the hidden one, the override must be cleared — otherwise it silently re-exposes
exactly what the gate exists to hide.

## Prevention

1. **When the backend already computes an actionability/eligibility boolean, the renderer must
   CONSUME it — never infer from raw fields.** If you find yourself parsing a
   `dueAt`/`expiresAt`/`status` timestamp in a component to decide what to render, check whether
   a service already exposes the derived boolean. Gate the regression test on that boolean:

   ```tsx
   h.getWeeklyReviewSummary.mockResolvedValue(makeSummary({ due: true }));
   expect(await screen.findByTestId("weekly-review")).toBeInTheDocument();      // due -> form

   h.getWeeklyReviewSummary.mockResolvedValue(notDueSummary());                 // due:false, session non-null
   expect(await screen.findByTestId("weekly-complete")).toBeInTheDocument();    // -> acknowledgment
   expect(screen.queryByTestId("weekly-review")).toBeNull();
   ```

2. **Any renderer-local "show it anyway" / escape-hatch view flag must be reset by the terminal
   action that changes the underlying state** — or it re-exposes the state the gate was hiding.
   Add a regression test for the **escape-hatch -> terminal-action** path specifically; the happy
   path works, so this one is easy to miss:

   ```tsx
   await screen.findByTestId("weekly-complete");
   fireEvent.click(screen.getByTestId("weekly-review-now"));                    // reviewNow = true
   await screen.findByTestId("weekly-review");                                  // form opens early
   fireEvent.click(screen.getByRole("button", { name: "Complete" }));
   expect(await screen.findByTestId("weekly-complete")).toBeInTheDocument();    // back to acknowledgment
   expect(screen.queryByTestId("weekly-review")).toBeNull();                    // NOT a reset form
   ```

3. **Test the null-field branch.** The actionability boolean handles `dueAt === null`, but the
   *display* still reads `dueAt`. Pin that the panel renders without "Invalid Date".

4. **Pin the copy split, not just the panel id.** A regressed `justCompleted` would still render
   the acknowledgment but with the wrong (idle) copy — assert the celebratory string after a real
   Complete and the idle string on a bare not-due landing. Lock it under `<StrictMode>` too, since
   double-invoke is where a `justCompleted`/mount-guard regression surfaces.

## Related

- [weekly-review-scroll-reset-on-action-reload](weekly-review-scroll-reset-on-action-reload.md)
  — sibling "an action looked like it broke the screen" bug on the same `WeeklyReviewScreen`;
  that one is a stale-while-revalidate remount, this one is a missing `summary.due` gate
  (different root cause). The fix here deliberately preserves that doc's stale-while-revalidate
  model (no full-page loading flip on Complete).
- [library-open-task-weekly-routing-missing-tasktype](library-open-task-weekly-routing-missing-tasktype.md)
  — closest root-cause analog: a weekly-review read-model field is plumbed end-to-end but a
  renderer consumer never reads it (`taskType` there, `summary.due` here).
- [system-owned-recurring-tasks](../architecture-patterns/system-owned-recurring-tasks.md)
  — the write-side lifecycle pattern that makes `summary.due` flip false on `complete()` while
  the session row persists; this doc is the read-side consumer that must gate on that flag.
- [queue-eligibility-inventory-scheduler-state](../logic-errors/queue-eligibility-inventory-scheduler-state.md)
  — the "due/actionable is canonical and must be consumed everywhere" precedent this fix applies.

> Follow-up noted separately: on a fresh vault, `initializeSession` runs at DB-open time before
> the first-run seed, so the first weekly session is created not-yet-due even when material
> exists. That is a session-scheduling question, independent of this renderer gate.

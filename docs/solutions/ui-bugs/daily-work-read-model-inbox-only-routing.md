---
title: "Daily work read model routes inbox-only days honestly"
date: "2026-06-08"
last_updated: "2026-06-08"
category: "docs/solutions/ui-bugs/"
module: "daily-work-routing"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "Inbox-only imports made Home and Queue present Start session even though no due queue work existed."
  - "Direct Process Queue loads could show Queue clear or processed 0 items when nothing had been due."
  - "Active unscheduled sources had no concrete reader exit actions to schedule, finish, or lower priority."
  - "Read now sources could leave Inbox and open the reader without receiving a scheduler-owned return date."
root_cause: "logic_error"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "service_object"
  - "database"
  - "testing_framework"
tags:
  - "daily-work"
  - "queue"
  - "inbox"
  - "source-reader"
  - "read-now"
  - "attention-scheduler"
  - "read-points"
  - "ipc"
---

# Daily work read model routes inbox-only days honestly

## Problem

Inbox-only or unscheduled-source days were being treated like completed due-queue days. Home and Queue exposed an unconditional "Start session" action into `/process`, and `/process` could render "Queue clear" or "You processed 0 items" even though the user still had actionable inbox triage or unscheduled reading work.

The follow-up return-path bug had the same underlying shape from the opposite direction: `Read now` correctly moved a source out of Inbox and opened the reader, but it could leave `elements.due_at = null`. That made read position durable while leaving the source without a scheduler-owned "when should this return?" answer.

## Symptoms

- Fresh imported sources existed in `status: "inbox"` with `dueAt: null`, but Home and Queue looked empty or complete.
- "Start session" navigated to `/process` when no scheduled queue work was due.
- Direct `/process` zero-load states looked like completed sessions.
- Active unscheduled sources could be resumed, but the reader did not consistently offer working schedule, done, priority, and delete exits across source formats.
- Reader lifecycle mutations could overlap without one shared busy guard.
- Started sources could have a saved read point for where to resume but no attention `due_at` for when Queue/Home should surface them again.

## What Didn't Work

- Widening `queue.list` would have blurred the due queue with inbox triage and unscheduled reading.
- Auto-scheduling fresh imports into today would have violated the import/inbox pipeline and let new material dominate older high-value due work.
- Using `balance.get` as the primary workflow gate was too advisory and indirect.
- Duplicating due queue and inbox predicates in React would have moved scheduling semantics into the renderer.
- Showing a generic clear state from `queue.counts.all === 0` ignored the difference between no due work, inbox work, resumable source work, and a failed read.

## Solution

Add a main-side daily workflow read model and expose it through typed IPC:

```ts
export interface DailyWorkSummary {
  readonly dueQueueItems: number;
  readonly inboxSources: number;
  readonly activeUnscheduledSources: number;
  readonly resumeSource: DailyWorkResumeSource | null;
  readonly recommendedAction:
    | "process_due_queue"
    | "triage_inbox"
    | "resume_unscheduled_source"
    | "clear";
}
```

`DailyWorkQuery` composes the canonical repository predicates:

```ts
const dueQueueItems =
  repos.queue.dueCardCount(asOf) + repos.queue.dueAttentionCount(asOf);
const inboxSources = repos.queue.inboxCount("source");
```

Resume candidates stay outside the due queue: live active sources with `dueAt === null`, sorted by unresolved block-processing work, then recency, then title.

Treat that resume path as a fallback for legacy or explicitly unscheduled active sources, not the default `Read now` path. Starting a source from Inbox should keep lifecycle `active` and write an attention-scheduler return date in the same triage transaction:

```ts
case "accept": {
  this.attentionScheduleService.activateSourceWithReturnWithin(tx, id);
  break;
}
```

Keep the scheduler decision inside the scheduling service, not in the renderer or the inbox service branch:

```ts
const decision = nextDueAt(this.toSchedulable(element, "activate"), now);
const rescheduled = this.elements.rescheduleWithin(tx, element.id, decision.dueAt, "active", {
  action: "activate",
});
```

This writes `elements.due_at` and a `reschedule_element` operation while preserving `status: "active"`. The read point is still written only by the reader and answers a separate question: where to resume.

Home and Queue now gate their primary CTA from `recommendedAction`:

- `process_due_queue` -> `/process`
- `triage_inbox` -> `/inbox`
- `resume_unscheduled_source` -> `/source/$id`
- `clear` -> true clear state with inbox as the safe next surface

`ProcessQueue` tracks the first queue load explicitly:

```ts
const zeroLoad = deckLoaded && total === 0 && processed === 0;
```

Zero-load now says "No due items today" and may show `Triage inbox` or `Resume source`. Only a real session that processed items keeps the "Queue clear" completion copy.

`SourceReader` wires source-level exits to existing command paths:

- Postpone -> `scheduleQueueItem`
- Mark done and Delete -> `actOnQueueItem`
- Lower priority -> `setElementPriority`

All reader exit actions share a ref-backed busy guard so schedule, mark done, lower priority, and delete cannot overlap. The same controls render for article, PDF, and video reader branches.

Due source rows in Queue and Home should describe the user-facing resume action, not the storage mechanism:

```ts
if (item.type === "source") {
  return { icon: "eye", label: "Continue reading from read point" };
}
```

## Why This Works

The due queue remains semantically pure: it contains only due scheduled work. The daily-work read model answers a different question: which pipeline stage should the user's primary daily action open?

That preserves the intended order:

1. Due scheduled work
2. Inbox triage
3. Resume active unscheduled source
4. True clear state

Newly started sources now rejoin step 1 when their attention return date arrives. The active-unscheduled branch remains useful for older data, manual schedule removal, and explicit edge cases, but it is no longer the ordinary continuation path for `Read now`.

All routing predicates stay on the trusted side of the Electron boundary, so React renders a typed recommendation instead of reimplementing queue SQL or scheduler logic. The reader exit fixes also close the lifecycle loop for active unscheduled sources: when the app routes the user back to a source, the user can schedule a return, finish it, lower its priority, or delete it without leaving the reader.

Keeping read point and `due_at` separate preserves the domain model. Lifecycle status answers "is this source in active reading?", `due_at` answers "when should attention return?", and read point answers "where should the reader resume?". Collapsing any two of those would either put partial reading back in Inbox, hide active work from the queue, or make reader position responsible for scheduling.

## Prevention

- Keep daily workflow routing behind `dailyWork.summary`; do not infer the next action from `queue.counts.all === 0` in React.
- Keep fresh imports as inbox work until the user accepts, reads, schedules, or deletes them.
- When `Read now` accepts an inbox source, assign an attention `due_at` while keeping lifecycle `active`.
- Keep read-point writes separate from scheduling writes; setting a read point must not implicitly reschedule the source.
- Treat active sources with `dueAt === null` as fallback resume work, not the normal started-source path.
- Fetch daily-work recommendations independently from queue reads or with `Promise.allSettled`; a secondary recommendation failure must not discard valid queue data.
- Disable primary workflow CTAs until the recommendation read has resolved.
- In `/process`, distinguish initial load, failed queue read, zero-load, and completed session states.
- Put all source reader lifecycle exits behind one shared busy guard and render them for every source format branch.
- Test due-work, inbox-only, scheduled started-source, resume-source fallback, dismissed/done exclusion, clear, daily-summary failure, queue-read failure, reader mutation failure, and restart persistence paths.

## Related Issues

- [Balance banner should not route fresh imports to an empty queue](./balance-banner-queue-inbox-action-gating.md) documents the same actionability invariant for the import/process balance banner.
- [URL and browser-captured articles should open as internal readable sources](./url-imported-articles-inbox-processing.md) documents the inbox-source lifecycle invariant that fresh imports remain inbox work until accepted or opened; `Read now` now also creates the attention return path described here.
- [Durable source block processing state](../architecture-patterns/durable-source-block-processing-state.md) is the source-reader precedent for deriving completion and resume decisions from durable source progress.
- [Review activity heatmap read model](../architecture-patterns/review-activity-heatmap-read-model.md) is an adjacent read-model precedent: computed UI-facing counts belong behind typed IPC, not in React.

---
title: Started Source Return Path
status: complete
date: 2026-06-08
origin: user request
execution: code
---

# Started Source Return Path

## Problem

`Read now` correctly removes an imported source from Inbox, but it currently leaves the source
`active` with no `due_at`. That preserves the Inbox-as-triage invariant, but creates a weak
return path: the source is only discoverable through legacy active-unscheduled resume affordances
until the user explicitly schedules it.

The desired behavior is that a started source has both:

- a read point for **where** to resume; and
- an attention-scheduler `due_at` for **when** it returns.

## Scope

In scope:

- `Read now` / inbox `accept` keeps moving a source out of Inbox and into started reading.
- The accepted source receives an attention-scheduler `due_at` by default.
- Read point persistence remains independent from scheduling.
- Due scheduled sources surface through existing Queue/Home attention reads.
- Queue copy for due sources makes the resume behavior explicit.
- Focused unit/component/Electron tests prove scheduling, resume persistence, queue surfacing,
  and terminal status exclusions.

Out of scope:

- Returning partially read sources to Inbox.
- Adding a blocking reader-leave prompt.
- Changing `Save for later` semantics from `dismissed`.
- Adding schema or migration changes.
- Introducing a new lifecycle status or operation-log type.

## Decisions

1. Keep started-source lifecycle as `active` on `Read now`, while assigning `due_at`.

   Rationale: the user-facing action says the source is active work. The queue already includes
   non-card attention items with non-null due dates unless they are terminal statuses.

2. Add a small scheduler-service activation seam instead of duplicating scheduler math in
   `DbService`.

   Rationale: `SchedulerService` already owns persistence of attention-scheduler decisions and
   operation-log shape. The new seam should compute `nextDueAt(..., "activate")` and persist
   `status: "active"` plus `due_at` through `ElementRepository.rescheduleWithin`.

3. Preserve the legacy `active + dueAt null` daily-work fallback.

   Rationale: old data, manual repair, and explicit unscheduling can still produce active
   unscheduled sources. New `Read now` sources should not enter that bucket.

4. Make due source rows say `Continue reading from read point`.

   Rationale: the source reader already jumps to the saved read point on open. The queue row
   should describe the user outcome, while the read point itself remains the independent resume
   location.

## Existing Patterns

- `apps/desktop/src/main/db-service.ts` owns validated inbox triage and already guards stale
  non-inbox sources before mutation.
- `packages/local-db/src/scheduler-service.ts` owns attention-scheduler persistence and
  `reschedule_element` logging.
- `packages/local-db/src/queue-repository.ts` already surfaces due non-card attention items via
  `elements.due_at`.
- `packages/local-db/src/daily-work-query.ts` already prioritizes due queue work before inbox
  triage and unscheduled source resume.
- `apps/web/src/pages/source/useReadPoint.ts` and `SourceReader.tsx` already load, set, and jump
  to read points without touching schedule state.
- `apps/web/src/pages/queue/openQueueItem.ts` already opens source queue rows in the source
  reader.

## Implementation Units

### U1: Scheduler Activation Seam

Files:

- Modify `packages/local-db/src/scheduler-service.ts`
- Modify `packages/local-db/src/scheduler-service.test.ts`

Approach:

- Add a method for starting a source with a default return date, using the existing
  `nextDueAt(..., "activate")` decision.
- Persist with `ElementRepository.rescheduleWithin(tx, id, dueAt, "active", { action:
  "activate" })`.
- Keep card rejection and deleted-element rejection through the existing attention-element guard.
- Do not write FSRS review state.

Tests:

- Starting a source assigns future `due_at`, keeps status `active`, and appends
  `reschedule_element`.
- The method rejects cards and deleted/missing elements through existing guard behavior.

### U2: Inbox Read Now Scheduling

Files:

- Modify `apps/desktop/src/main/db-service.ts`
- Modify `apps/desktop/src/main/db-service.test.ts`
- Modify `packages/local-db/src/inbox-query.test.ts` if existing accept semantics are asserted
  there.

Approach:

- In the inbox `accept` branch, replace the plain `status: "active"` update with the new
  scheduler activation seam.
- Preserve stale item guards and transactionality.
- Leave `keepForLater`, `setPriority`, and `delete` unchanged.
- Update comments/types where they describe accept as only a status update.

Tests:

- Accepting an inbox source returns an active summary and persists non-null `due_at`.
- The source leaves Inbox immediately.
- A repeated/stale accept still throws and does not mutate.
- `keepForLater` remains dismissed and unscheduled.

### U3: Queue and Daily Work Read Models

Files:

- Modify `packages/local-db/src/daily-work-query.test.ts`
- Modify `packages/local-db/src/queue-query.test.ts`
- Modify `packages/local-db/src/queue-repository.test.ts` if lower-level due attention behavior
  needs a regression case.

Approach:

- The production read model should need little or no change because due attention items already
  read `elements.due_at`.
- Strengthen tests so scheduled active sources are due queue work, not active-unscheduled resume
  work.
- Prove dismissed/done sources leave the loop even if they retain a due date.

Tests:

- Active source with future `due_at` is not counted as `activeUnscheduledSources`.
- Active source with due `due_at` contributes to `dueQueueItems`.
- Due source appears as an attention queue item.
- Dismissed and done due sources are excluded.

### U4: Queue/Home Copy and Resume Surface

Files:

- Modify `apps/web/src/pages/queue/queueRow.tsx`
- Modify `apps/web/src/pages/queue/queueRow.test.tsx`
- Modify `apps/web/src/pages/queue/QueueScreen.test.tsx` and/or `apps/web/src/pages/home/HomeScreen.test.tsx`
  if due-source copy is asserted outside queue rows.

Approach:

- Change the source row action from generic `Read` to `Continue reading from read point`.
- Keep routing unchanged: source queue rows open `/source/$id`, and the reader jumps to the saved
  read point.
- Keep legacy unscheduled-source Home/Queue fallback copy available for old unscheduled sources.

Tests:

- Source queue row exposes `Continue reading from read point`.
- Existing card/extract/task action labels remain unchanged.

### U5: Electron Persistence Flow

Files:

- Modify `tests/electron/inbox.spec.ts` or `tests/electron/source-reader.spec.ts`
- Modify `tests/electron/mvp-flow.spec.ts` only if it is the narrowest existing restart flow.

Approach:

- Add a focused Electron flow: import source, `Read now`, set read point, restart, assert the
  source is not in Inbox and the reader resumes at the read point.
- Also assert the source has a scheduled return path visible in Queue when `asOf` reaches the
  persisted due date if test helpers can read through `window.appApi`.

Tests:

- Partial read-point resume survives restart.
- Started source remains outside Inbox after restart.
- Due scheduled source can be opened from Queue/Home and resumes in reader.

## Verification

Required:

- `pnpm --filter @interleave/local-db test`
- `pnpm --filter @interleave/desktop test`
- `pnpm --filter @interleave/web test`
- Focused Electron spec for the restart/resume path
- `pnpm typecheck`
- `pnpm test`

Run narrower tests while iterating, then the full workspace checks before final review.

## Risks

- Undo semantics depend on `reschedule_element` preimage restoring the previous `inbox` status.
  Verify this through existing undo coverage or add a focused assertion if the behavior is not
  already covered.
- Existing tests may assume `accept` writes `update_element`; update them to the new
  scheduler-backed operation while keeping the user-visible status `active`.
- Queue copy must stay compact enough for dense desktop rows.

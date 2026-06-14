---
title: "fix: Library \"Open task\" routes weekly-review task to /weekly, not the queue's next card"
type: fix
date: 2026-06-14
status: ready
depth: standard
---

# fix: Library "Open task" opens a Q&A card instead of the task

## Summary

In the Library browse screen (`/library` → `BrowseScreen.tsx`), clicking **Open task** on a
"Weekly review" task lands the user on a Q&A review card ("What is BA +B?") instead of the weekly
review surface. The task-routing helper `openQueueItem` already has the correct branch
(`taskType === "weekly_review"` → `/weekly`), but the **Library browse IPC contract never carries
`taskType`**, so that branch can't fire. With no `taskType` and a `null` link, the weekly-review
task falls through to `routeToProcess` → `/process` (the combined attention+review queue loop),
which immediately surfaces the next due card.

The fix adds the single missing `taskType` field to the `LibraryItem` contract on both sides of
the IPC boundary and populates it in the backend browse mapping. No routing logic changes.

---

## Problem Frame

**Observed:** Library detail panel shows a selected "Weekly review" task (badges: D, SCHEDULED,
Topic, OVERDUE; "No Source"; "Not in queue: summary unavailable"). Clicking the blue **Open task**
button opens a Q&A review card with a reveal-answer prompt, not the weekly review.

**Expected:** Clicking **Open task** on the weekly-review task opens the weekly review surface
(`/weekly`).

**Root cause (verified in code):**

- The weekly-review task is created with `taskType: "weekly_review"` and `linkedElementId: null`
  (`packages/local-db/src/weekly-review-service.ts:160-170`).
- `openQueueItem` routes a task to `/weekly` only when `item.taskType === "weekly_review"`
  (`apps/web/src/pages/queue/openQueueItem.ts:56-59`). `BrowseScreen` already delegates the whole
  `LibraryItem` to this helper (`apps/web/src/library/BrowseScreen.tsx:242-252`).
- But `LibraryItem` has **no `taskType` field** — neither the desktop contract
  (`apps/desktop/src/shared/contract.ts:5670-5706`) nor the renderer mirror
  (`apps/web/src/lib/appApi.ts:3824-3847`) declares it, and the browse mapper
  `libraryItemFor` (`apps/desktop/src/main/db-service.ts:5748-5798`) never sets it.
- So `item.taskType` is `undefined`. The `weekly_review` branch is skipped; `linkedElementId` is
  `null`, so the linked-element branch is skipped; control falls to
  `routeToProcess` → `/process` (`openQueueItem.ts:70-71`). The `/process` loop renders the next
  due queue item — here, the overdue Q&A card — which the user perceives as "Open task opened a
  Q&A card".

**Why other surfaces are unaffected:** the queue/home read model populates `taskType`
(`packages/local-db/src/queue-query.ts:873`), so "Open" from Home/Queue routes weekly-review
correctly. Only the **Library browse** mapping omits the field.

---

## Key Technical Decisions

1. **Fix at the data contract, not the router.** `openQueueItem`'s logic is correct and already
   unit-tested; the defect is a dropped field in the browse read model. Adding `taskType` to
   `LibraryItem` and populating it is the minimal, root-cause fix and keeps a single routing helper
   (honors `docs/solutions/ui-bugs/active-card-rows-open-card-detail-surface.md`: one central
   element-type dispatcher).

2. **`taskType: TaskType | null`** — non-null only for `task` rows, `null` otherwise. This mirrors
   the existing shape on `QueueItemSummary` (`apps/web/src/lib/appApi.ts:650`,
   `packages/local-db/src/queue-query.ts:141`). `TaskType` is already imported in both
   `contract.ts` (line 81) and used in `appApi.ts`, so no new imports/enums are needed.

3. **Reuse the existing `findTask` lookup in `libraryItemFor`.** The mapper already calls
   `this.repos.tasks.findTask(element.id)` to resolve `linkedElement`
   (`db-service.ts:5760-5763`). Capture that task summary once and read both `linkedElement` and
   `taskType` from it — no extra query, no double lookup. `findTask` returns `taskType`
   (`packages/local-db/src/task-service.ts:84,100`).

4. **Do not touch the `/search` screen (`LibraryScreen.tsx`).** Its local `open` handles only
   source/extract/card, but the FTS backend cannot emit `task` rows
   (`packages/local-db/src/search-repository.ts` `SEARCHABLE_TYPES`), so that path is unreachable
   for tasks and is not this bug. Tracked under Deferred to Follow-Up Work.

---

## Implementation Units

### U1. Add `taskType` to the `LibraryItem` IPC contract (both sides)

**Goal:** Make `taskType` part of the browse row contract so it survives the IPC boundary and
reaches `openQueueItem`.

**Files:**
- `apps/desktop/src/shared/contract.ts` — add `readonly taskType: TaskType | null;` to the
  `LibraryItem` interface (after `linkedElementType`, ~line 5705). `TaskType` is already imported
  (line 81).
- `apps/web/src/lib/appApi.ts` — add the identical field to the renderer's `LibraryItem` interface
  (after `linkedElementType`, ~line 3846). `TaskType` is already in scope (used at line 650).

**Approach:** Type-only change. Keep the two declarations in lock-step (they are parallel mirrors,
not a shared import). Add a doc comment matching the surrounding style.

**Patterns to follow:** `QueueItemSummary.taskType` (`appApi.ts:650`) for the exact field shape and
doc-comment tone.

**Test scenarios:** `Test expectation: none -- pure type declaration; behavior is exercised by U2/U3 tests.`

**Verification:** `pnpm typecheck` passes; `libraryItemFor` (U2) now type-errors until it provides
`taskType`, confirming the contract is enforced.

---

### U2. Populate `taskType` in the backend browse mapper

**Goal:** Set `taskType` on every browsed row — the task's type for `task` elements, `null`
otherwise.

**Files:**
- `apps/desktop/src/main/db-service.ts` — in `libraryItemFor` (~5748-5798): hoist the existing
  `findTask` call into a single `task` local, derive `linked` from it, and add
  `taskType: task?.taskType ?? null` to the returned object.
- `apps/desktop/src/main/db-service.test.ts` — backend regression coverage (see scenarios).

**Approach:**
```text
// directional, not literal:
const task = element.type === "task" ? this.repos.tasks.findTask(element.id) : null;
const linked = task?.linkedElement ?? null;
...
return { ...existing fields..., taskType: task?.taskType ?? null };
```
This collapses the current task lookup into one call and adds the field with no behavior change for
non-task rows.

**Patterns to follow:** `queue-query.ts:873` (`taskType: task?.taskType ?? null`) — same null-safe
derivation already used by the queue read model.

**Test scenarios (in `db-service.test.ts`):**
- Happy path: browse a vault containing a weekly-review task → the task's `LibraryItem` has
  `taskType: "weekly_review"`. **Covers the root cause.**
- A linked verification task (e.g. `verify_claim` linked to a card) → row has its real `taskType`
  *and* retains correct `linkedElementId`/`linkedElementType` (proves the `findTask` hoist didn't
  regress link resolution).
- Non-task row (source/extract/card) → `taskType` is `null`.

**Verification:** New tests pass; existing `db-service.test.ts` browse tests still pass;
`pnpm typecheck` green.

---

### U3. Renderer regression: Library "Open task" on a weekly-review task routes to `/weekly`

**Goal:** Lock in the user-facing fix at the screen level and prevent re-regression of the
end-to-end routing.

**Files:**
- `apps/web/src/library/BrowseScreen.test.tsx` — add a task-row case.
- `apps/web/src/pages/queue/openQueueItem.test.ts` — confirm/add a `weekly_review` → `/weekly`
  assertion if not already present (the branch exists; guard it).

**Approach:** Reuse the existing BrowseScreen test harness (mocks `@tanstack/react-router`,
`../shell/selection`, `appApi`). Build a `LibraryItem` fixture with
`type: "task", taskType: "weekly_review", linkedElementId: null`, render, click
`data-testid="library-detail-open"`, assert `navigate` called with `{ to: "/weekly", search: {} }`
(and `select` called with the task id, per `openQueueItem.ts:57`). Mirror the existing
`library-detail-open` assertion pattern already in the file.

**Test scenarios:**
- Covers AE: weekly-review task row → **Open task** → `navigate({ to: "/weekly" })`, NOT `/process`
  and NOT `/card/$id`.
- Regression guard: a card-linked task row still routes to the protected card surface
  (`/card/$id`) — the existing behavior the BrowseScreen test already asserts must remain green.
- `openQueueItem.test.ts`: `{ type: "task", taskType: "weekly_review" }` → `/weekly`; selection set
  to the task id.

**Verification:** `pnpm test` green for both files; the new BrowseScreen assertion fails against
the pre-fix contract (taskType absent) and passes after U1+U2.

---

## Scope Boundaries

**In scope:** Adding `taskType` to the `LibraryItem` contract (both mirrors), populating it in
`libraryItemFor`, and regression tests at the backend mapper, the routing helper, and the Library
screen.

### Deferred to Follow-Up Work
- `LibraryScreen.tsx` (`/search`) local `open` only handles source/extract/card and silently
  no-ops for `task`. Unreachable today (FTS excludes tasks), so not part of this bug. A future
  cleanup could delegate it to `openQueueItem` for parity with `BrowseScreen`.

---

## Risks & Dependencies

- **Low risk.** Additive contract field + one null-safe assignment; no routing or persistence
  change. Non-task rows get `taskType: null`.
- **IPC mirror drift:** the two `LibraryItem` declarations must stay identical. Mitigated by
  `pnpm typecheck` (the mapper won't compile until the desktop contract has the field) and the new
  tests.
- **No migration / no `operation_log` impact:** read-model-only change; no schema or durable-state
  mutation.

---

## Definition of Done

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test` (new + existing green)
4. Manual/E2E sanity: in the running app, Library → select "Weekly review" → **Open task** →
   lands on `/weekly` (the weekly review surface), not a Q&A card. Run the routing-adjacent
   Electron spec if affected.

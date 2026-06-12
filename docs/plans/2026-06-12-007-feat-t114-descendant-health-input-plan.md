---
title: "feat: T114 descendant-health input"
type: feat
date: 2026-06-12
---

# feat: T114 descendant-health input

## Summary

T114 adds the first review-to-attention back-edge: recent true lapse increments on live descendant cards can pull their source back sooner on the attention scheduler. The change keeps cards on FSRS, stores the source schedule explanation on the governing `reschedule_element` operation, and leaves exact lapse-cluster remediation to M28.

---

## Problem Frame

The adaptive attention scheduler now consumes recency, visit yield, and structured schedule reasons, but it still ignores the strongest signal that a source may need re-exposure: cards derived from that source repeatedly failing in review. The T114 spec in `docs/tasks/M23-adaptive-scheduler.md` calls for descendant-card lapse rate to shorten the parent source return interval, with capped influence and a visible `descendant_lapses` reason.

---

## Requirements

- R1. Compute descendant-health evidence from durable `review_logs` and live card descendants, not from renderer inference or cumulative lifetime `review_states.lapses`.
- R2. Treat a lapse as a true increment where `next_lapses > prev_lapses`, inside a 30-day window.
- R3. Suppress noise unless the source has at least 3 true lapse increments across at least 2 affected live descendant cards and a descendant lapse rate of at least 10%.
- R4. Descendant lapse pressure can shorten a source attention interval only; it must never lengthen an interval, touch descendant card FSRS scheduling, or create `review_states` rows for sources/extracts.
- R5. The shortening is capped as one transient schedule-decision adjustment, bounded by the existing attention multiplier floor and a minimum 1-day final interval.
- R6. Persist `descendant_lapses` on the source's governing `reschedule_element` operation only when descendant pressure makes the final source due date earlier than the no-descendant baseline.
- R7. Queue, home, and inspector surfaces show the existing trusted `descendant_lapses` schedule reason only while that operation still governs `elements.due_at`; explicit manual schedules remain silent.
- R8. Update `docs/scheduling-and-priority.md`, `docs/tasks/M23-adaptive-scheduler.md`, and `docs/roadmap.md` so the documentation no longer describes `descendant_lapses` as only reserved.

---

## Key Technical Decisions

- **Review-triggered source reschedule:** The parent source is evaluated immediately after a descendant card review increments lapses, so the source returns sooner because of review trouble rather than waiting for a future source-processing action.
- **Manual schedules only supersede reasons:** T114 does not recompute descendant health during `scheduleAt`, queue-soon, or manual choices. Those explicit schedules can supersede and hide an older descendant-lapse reason through the existing governing-op projection.
- **Source-only T114 scope:** Use active/scheduled live card descendants with `elements.source_id = source.id`; exclude soft-deleted, retired, and suspended cards. Exact extract-region clustering and re-read proposal workflows stay in M28/T128.
- **Transient pressure, not permanent multiplier mutation:** Descendant lapses affect the current source schedule decision and reason payload, but they do not lower `attention_interval_multiplier` without a recovery rule.
- **Reason payload validates the floor:** The durable `descendant_lapses` reason includes at least `descendantLapseCount`, `affectedCardCount`, `descendantCardCount`, `descendantLapseRate`, and `intervalAfterDescendantDays` so read-side projection can reject under-evidenced reasons.
- **No queue-time scans:** Compute descendant health only during review-triggered source scheduling, not while materializing queue rows.
- **Current-due policy:** Review-triggered descendant pressure is a no-op when the source is missing, soft-deleted, not a `source`, not `active`/`scheduled`, has no current `due_at`, or is already due earlier than the proposed descendant-pressure due date.

---

## Implementation Units

### U1. Add pure descendant-health scheduler input

- **Goal:** Extend the pure attention scheduler with a source-only descendant lapse signal that shortens within cap and emits `descendant_lapses` only when it changes the interval.
- **Requirements:** R3, R4, R5, R6.
- **Dependencies:** None.
- **Files:** `packages/scheduler/src/attention-scheduler.ts`, `packages/scheduler/src/attention-scheduler.test.ts`.
- **Approach:** Add a small `descendantHealth` descriptor input with `descendantLapseCount`, `affectedCardCount`, and `descendantCardCount`. Derive `descendantLapseRate = descendantLapseCount / descendantCardCount`; ignore signals below 3 lapses, below 2 affected cards, below 10% rate, zero-card, malformed, or non-source inputs. Compute the final interval twice, with and without descendant health, and emit `descendant_lapses` only when the descendant version is earlier than the no-descendant baseline. Cap the pressure as `min(0.25, descendantLapseRate)` of the current interval, with a 1-day floor, applied before recency.
- **Patterns to follow:** `adjustForSourceProcessing`, `applyAdaptiveIntervalMultiplier`, and existing reason precedence in `nextDueAt`.
- **Test scenarios:** Struggling source input shortens a C-source interval within cap and emits `descendant_lapses`; below-floor lapses are no-op; one affected card is no-op; three lapses among three cards produce stronger pressure than three lapses among many cards; zero/malformed descendant counts are no-op; the adjustment never lengthens and never drops below a 1-day interval; an existing stronger shortening reason remains visible when descendant pressure does not make the no-descendant baseline earlier.
- **Verification:** Pure scheduler tests prove capped interval math and reason emission.

### U2. Add local-db descendant-health evidence query

- **Goal:** Compute the source descendant lapse evidence from live descendant cards and recent review log deltas.
- **Requirements:** R1, R2, R3, R4.
- **Dependencies:** U1.
- **Files:** `packages/local-db/src/descendant-health-query.ts`, `packages/local-db/src/descendant-health-query.test.ts`, `packages/local-db/src/index.ts`.
- **Approach:** Add a read-only query over `elements`, `cards`, and `review_logs` that accepts a `TransactionClient`/database client, finds active or scheduled non-retired card descendants by `source_id`, excludes soft-deleted and suspended cards, counts only `next_lapses > prev_lapses` with `reviewed_at` inside the 30-day window, and returns a no-op signal unless the lapse, affected-card, and rate floors are met.
- **Patterns to follow:** `SourceYieldQuery` for source-descendant rollups and `topic-knowledge-state-query` for descendant/read-model style.
- **Test scenarios:** Counts true lapse increments in-window; ignores old logs; ignores `rating` rows that did not increment lapses; ignores soft-deleted, suspended, and retired cards; returns no-op below lapse, affected-card, and rate floors; preserves source-only scope; sees review logs inserted earlier in the same transaction.
- **Verification:** Local-db query tests pass against migrated in-memory SQLite.

### U3. Wire review-triggered source rescheduling

- **Goal:** After a card review creates a true lapse increment, evaluate the source and reschedule it sooner when descendant pressure bites.
- **Requirements:** R1, R4, R5, R6.
- **Dependencies:** U1, U2.
- **Files:** `packages/local-db/src/review-repository.ts`, `packages/local-db/src/scheduler-service.ts`, `packages/local-db/src/scheduler-service.test.ts`, `packages/local-db/src/review-repository.test.ts`.
- **Approach:** Add a transaction-composable scheduler-service method that loads the source row inside the review transaction, no-ops when the source is missing/deleted/not `source`/not `active` or `scheduled`/missing `due_at`, computes descendant-health evidence through the same transaction client, and writes a source `reschedule_element` only when the descendant-pressure due date is earlier than the current source due date. Call it from the review transaction after the review log/state update only when `next_lapses > prev_lapses` and the reviewed card has a source id. Keep card review state mutation unchanged.
- **Patterns to follow:** `rescheduleProcessedVisitWithin` for transaction-composable scheduling, `ElementRepository.rescheduleWithin` for op-log preimages, and review repository stale-preimage guards.
- **Test scenarios:** Qualifying descendant lapses write one source `reschedule_element` with `descendant_lapses`; healthy review writes no source op; null-due, deleted, terminal, and already-sooner sources no-op without rolling back the card review; transaction failure rolls back the card review and source reschedule together; card `review_states` changes as before and no source `review_states` row appears; manual schedules suppress stale reason after override.
- **Verification:** Scheduler/review integration tests prove transactional op-log writes and FSRS separation.

### U4. Surface and document the shipped reason

- **Goal:** Ensure the reason already reserved in T113 is visible end-to-end and update docs/spec status.
- **Requirements:** R6, R7, R8.
- **Dependencies:** U3.
- **Files:** `packages/local-db/src/operation-log-repository.ts`, `packages/local-db/src/operation-log-repository.test.ts`, `apps/desktop/src/shared/contract.ts`, `apps/web/src/lib/appApi.ts`, `apps/web/src/components/inspector/primitives.test.tsx`, `apps/web/src/pages/home/HomeScreen.test.tsx`, `apps/web/src/pages/queue/QueueScreen.test.tsx`, `tests/electron/schedule-explainability.spec.ts`, `docs/scheduling-and-priority.md`, `docs/tasks/M23-adaptive-scheduler.md`, `docs/roadmap.md`.
- **Approach:** Extend durable reason parsing and typed bridge contracts if the new evidence fields are added. Reuse existing formatter copy unless tests reveal it is missing from a surface. Add coverage that verifies the source reason on queue, home, and inspector surfaces, then confirms a matched healthy source stays silent and a manual schedule hides the reason.
- **Patterns to follow:** `tests/electron/schedule-explainability.spec.ts` and T113 queue/inspector reason tests.
- **Test scenarios:** Queue, home, and inspector show `Returning sooner: descendant cards are struggling.` for a source with a governing `descendant_lapses` schedule; a healthy source has no reason; explicit manual schedule hides the reason; under-evidenced reason payloads do not project.
- **Verification:** Focused renderer/Electron tests pass, and task docs record completion notes.

---

## Acceptance Examples

- AE1. Given a C-priority source with five live descendant cards and four true lapse increments across two cards in the last 30 days, when a descendant card review increments lapses, then the source attention due date moves sooner within cap and the governing op carries validated `descendant_lapses` evidence.
- AE2. Given the same source with only successful reviews or one recent lapse, when a descendant card is reviewed, then the card FSRS state updates but the source schedule remains unchanged.
- AE3. Given qualifying lapses outside the 30-day window, when the source is evaluated, then descendant health is a no-op.
- AE4. Given a source rescheduled by descendant lapses, when the user manually schedules that source afterward, then the descendant-lapse reason no longer projects.

---

## Risks & Dependencies

- **Reason precedence:** If another adjustment already shortened the interval more than descendant pressure, keep that stronger existing reason rather than misattributing the schedule to descendant lapses.
- **Review transaction coupling:** The review-triggered source reschedule must not weaken the review preimage/staleness guard or leave a card review partially applied.
- **Lineage semantics:** T114 uses `source_id` for source-level pressure; a later M28 cluster query may refine exact source regions without changing this broad source-health signal.
- **Performance:** The descendant query must be single-source and review-triggered, not part of queue listing.
- **Imported review history:** T114 counts only `review_logs` with `next_lapses > prev_lapses`; imported lapse counters without local review-log rows do not create descendant pressure until Interleave records reviews.

---

## Sources & Research

- `docs/tasks/M23-adaptive-scheduler.md` defines T114 scope and shared M23 scheduler invariants.
- `packages/scheduler/src/attention-scheduler.ts` already reserves `descendant_lapses` in the reason vocabulary.
- `packages/local-db/src/operation-log-repository.ts` already projects valid `descendant_lapses` reasons from governing schedule ops.
- `docs/solutions/architecture-patterns/trusted-schedule-reasons-from-governing-reschedule-ops.md` requires schedule reasons to come from the governing operation log row.
- `docs/solutions/architecture-patterns/review-analytics-data-capture-in-review-logs.md` supports using review logs as the durable source of review-derived analytics.

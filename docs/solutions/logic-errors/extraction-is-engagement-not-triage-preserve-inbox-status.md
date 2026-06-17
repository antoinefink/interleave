---
title: "A processed-visit reschedule must not triage an untriaged inbox source"
date: "2026-06-17"
category: "docs/solutions/logic-errors/"
module: "packages/local-db extraction + attention scheduler"
problem_type: "logic_error"
component: "service_object"
symptoms:
  - "Extracting a passage from a freshly-imported (inbox) source silently removed the source from the inbox."
  - "markdown-import E2E: after import + extract + app restart, the inbox row count was 0 instead of 1."
  - "pdf-import E2E: a later serial test's firstInboxId() returned undefined (the earlier page-text extract had emptied the inbox), so the PDF reader never mounted."
root_cause: "logic_error"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "packages/local-db extraction-service"
  - "packages/local-db scheduler-service"
  - "database"
  - "testing_framework"
tags:
  - "extraction"
  - "inbox"
  - "triage"
  - "attention-scheduler"
  - "adaptive-scheduling"
  - "processed-visit"
---

# A processed-visit reschedule must not triage an untriaged inbox source

## Problem

Extracting a passage from a source that was still in the **inbox** (untriaged) silently
flipped that source's `status` from `inbox` to `scheduled`, removing it from the inbox.
Triage is supposed to be an explicit, user-owned decision — extracting is not it.

## Symptoms

- An imported article vanished from the inbox after the user opened it and pulled one
  extract, with no triage action taken.
- `tests/electron/markdown-import.spec.ts:217` — after import + extract + restart, the
  inbox row count was `0`, expected `1`.
- `tests/electron/pdf-import.spec.ts:198` — `pdf-reader` never became visible (20s
  timeout). The real cause was upstream: an earlier serial test extracted page-2 text
  from the PDF **inbox** source, which flipped it to `scheduled`, so this test's
  `firstInboxId()` resolved to `undefined` and the route rendered an empty text reader
  ("element no longer available"), not the PDF branch.

## What Didn't Work

- Treating the `pdf-reader` timeout as a PDF-rendering/flakiness problem. It was a
  deterministic data problem (empty inbox), reproducible in isolation — a single product
  regression broke **two** unrelated-looking specs.

## Root Cause

When extracting from a top-level source with `scheduler.adaptiveAttentionIntervals`
enabled (default ON), `ExtractionService.createExtraction` records a *processed visit* by
calling `scheduler.rescheduleProcessedVisitWithin(...)`. That helper
(`packages/local-db/src/scheduler-service.ts`) **hardcodes** `status: "scheduled"` on the
reschedule write. For a source already in the reading flow (`active` / `scheduled`) that
is correct — a processed visit reschedules it for the next pass. For an **inbox** source
it is a silent triage side-effect.

This was introduced by the yield-adaptive interval work (T112, commit `d4489520`), whose
verification exercised seeded `active` sources and never an `inbox` source — so the
inbox interaction was unconsidered. (`extraction.spec.ts` passes because its seed source
is `status: "active"`, making the flip a no-op there.)

Inbox membership is defined narrowly: `type === "source"` AND `status === "inbox"`
(`packages/local-db/src/inbox-query.ts`). Any write that flips the status drops the source
out of the inbox query.

## Solution

Guard the **source** processed-visit reschedule at the extraction call site so it never
fires for an untriaged inbox source. Read the source's status before the transaction
(mirroring the existing pre-transaction `captureAdaptiveVisitBaseline` read) and gate on
it:

```ts
// packages/local-db/src/extraction-service.ts
const sourceStatusBeforeExtract =
  locationSource === input.sourceElementId
    ? (this.elements.findById(input.sourceElementId)?.status ?? null)
    : null;

// ... inside the transaction, in the `locationSource === sourceElementId` block:
if (
  this.scheduler.adaptiveAttentionIntervalsEnabled() &&
  sourceStatusBeforeExtract !== "inbox"
) {
  this.scheduler.rescheduleProcessedVisitWithin(tx, input.sourceElementId, "extract", scheduledAt, sourceBaseline);
}
```

Guard at the **call site**, not inside `rescheduleProcessedVisitWithin`: the helper is
shared with the extract-rewrite path (`extract-service.ts` `setStage`), whose target is an
*extract* element (never `inbox`), so a helper-level change would add surface area for no
benefit and risk that path.

The extract itself is still created and attention-scheduled — only the source's reschedule
is skipped. When the guard fires, no `reschedule_element` op is written for the source,
which is correct: there is no source state change to record, so `operation_log` stays
coherent.

## Why This Works

The domain rule is that **triage is user-owned and explicit**: `Read now` -> `active`,
`Queue soon` -> `scheduled`, `Save for later` -> `parked`. Extraction is *engagement*, not
triage, so it must not change a source's triage status. An untriaged inbox source stays
`inbox` (with `dueAt` null) until the user triages it — the same clean state a
never-extracted inbox source has. Engagement is still captured (the extract, its lineage,
the `extracted_span` mark, and block-processing state are all written); only the triage
**status** is left for the user to author.

## Prevention

- A "processed visit" reschedule (or any heuristic engagement signal) must be checked
  against the *untriaged* state. Status-changing writes belong to explicit triage commands,
  not to extraction/engagement.
- When adding adaptive/scheduling behavior, exercise it against an **inbox** source, not
  just seeded `active`/`scheduled` ones. A new feature's verification list is not the full
  set of affected behaviors.
- Unit coverage to pin the invariant (`packages/local-db/src/extraction-service.test.ts`):

  ```ts
  // inbox source stays untriaged; the extract is still created & scheduled
  const { element: extract } = service.createExtraction({ sourceElementId: inboxId, ... });
  expect(extract.type).toBe("extract");
  expect(extract.status).toBe("scheduled");      // the extract IS scheduled...
  const after = elements.findById(inboxId);
  expect(after?.status).toBe("inbox");            // ...the source is NOT triaged
  expect(after?.dueAt).toBeNull();
  expect(reschedulePayloads(inboxId).filter((p) => p.action === "extract")).toHaveLength(0);

  // an already-active source IS still rescheduled (guard is inbox-only)
  // -> after extracting, source.status === "scheduled"
  ```

## Related

- [Persist adaptive attention intervals as bounded, undoable scheduler state](../architecture-patterns/yield-adaptive-attention-interval-multiplier.md)
  — the feature (T112) whose processed-visit reschedule this learning constrains.
- [Inbox "Queue soon" routes through attention scheduling](../workflow-issues/inbox-triage-queue-soon-attention-scheduling.md)
  — the explicit triage seam that *should* move a source out of the inbox.
- [Save for later is a first-class parked state](../workflow-issues/save-for-later-first-class-parked-state.md)

---
title: "Model honorable non-card extract fates as first-class value output"
date: "2026-06-11"
category: "architecture-patterns"
module: "extract value model"
problem_type: "architecture_pattern"
component: "service_object"
severity: "high"
related_components:
  - "database"
  - "testing_framework"
  - "frontend_stimulus"
applies_when:
  - "Extracts can produce durable value without becoming cards."
  - "Synthesis-note lineage should count as productive source output."
  - "Source-yield, stagnation, analytics, and undo all need the same terminal extract semantics."
  - "A cached state mirrors authoritative lineage and must stay consistent through unlink, delete, and undo paths."
tags:
  - "extract-fate"
  - "value-model"
  - "source-yield"
  - "stagnation"
  - "synthesis-notes"
  - "lineage"
  - "undo"
  - "local-db"
---

# Model honorable non-card extract fates as first-class value output

## Context

The original source-yield model treated production as a ladder from extract to card to mature card.
That made synthesis-heavy or reference-heavy reading look like failure: sources could appear barren,
extracts could appear stagnant, and users were nudged toward unnecessary cards.

T104 added a durable value model for honorable non-card extract outcomes. Extracts can now terminate
as `reference`, `synthesized`, or `done_without_card`; live synthesis-note `references` edges count
as productive lineage; source-yield and stagnation scans recompute those signals from durable tables.

## Guidance

Store honorable extract outcomes in `elements.extract_fate`, not in global `status` or `stage`.
Keep the meanings separate:

- `status` is lifecycle and queue eligibility.
- `stage` is the extract distillation ladder.
- `extract_fate` is terminal extract meaning.

Direct user commands may set `reference` or `done_without_card`. `synthesized` is synthesis-owned:
a live `synthesis_note` with a live `references` edge is the authoritative fact, and the cached
`extract_fate = "synthesized"` state must be maintained from link/unlink/delete/restore flows.

Keep these invariants together:

- Fated extracts leave the attention queue with `status: "done"` and `dueAt: null`.
- Fated extracts cannot continue stage advancement, postponement, or card creation until
  reactivated.
- Reactivation writes `status: "scheduled"`, `dueAt: now`, `parkedAt: null`, and
  `extractFate: null`.
- Direct reactivation must reject a `synthesized` fate while live synthesis-note lineage still
  references the extract.
- Source-yield de-duplicates extract value across explicit fates and live synthesis references.
- Stagnation treats either an honorable fate or a live synthesis reference as progress.

## Why This Matters

Incremental reading produces more than cards. Keeping reference material, using extracts in
synthesis, and deliberately deciding that no card is warranted are all legitimate outcomes. If those
outcomes are invisible to the value model, later features that depend on yield or stagnation will
misclassify good work as failure.

The cache consistency rules matter because `extract_fate = "synthesized"` is a convenience, not the
source of truth. Undo, unlink, delete, restore, and stale-cache states must not let the cache diverge
from live synthesis lineage. Card creation and maintenance guards should check live synthesis
references as well as the cached fate.

## When to Apply

- Adding extract terminal states, queue eligibility, or card-conversion behavior.
- Changing synthesis-note link/unlink/delete/restore behavior.
- Updating source-yield, stagnation, analytics, or maintenance suggestions.
- Adding undoable commands that touch `status`, `dueAt`, `parkedAt`, or `extractFate`.

Do not apply this by widening global statuses, creating a parallel synthesis table, inferring
synthesis from note text, or scheduling synthesis notes with FSRS.

## Examples

Setting a direct fate should be one transactional `update_element` patch with a full preimage:

```ts
{
  status: "done",
  dueAt: null,
  parkedAt: null,
  extractFate: "reference"
}
```

Reactivation should avoid the ambiguous `status: done` plus no-fate state:

```ts
{
  status: "scheduled",
  dueAt: nowIso(),
  parkedAt: null,
  extractFate: null
}
```

Yield and stagnation should read both durable signals:

```ts
productiveExtracts = distinct(fatedExtractIds union synthesisReferencedExtractIds)
notStagnant = extractFate !== null || synthesizedReferenceCount > 0
```

Undo/cache consistency needs explicit tests:

```ts
// Link: set synthesized cache and add the references edge in the same transaction.
// Unlink/delete note: clear synthesized cache only if no other live note references it.
// Restore note: restore synthesized cache for still-live extract targets.
// Deleted targets: clear stale synthesized cache without rescheduling deleted rows.
// Card creation: reject live synthesis references even if the cached fate is stale.
```

## Related

- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md)
- [Durable source block processing state](./durable-source-block-processing-state.md)
- [Save-for-later as a first-class parked state](../workflow-issues/save-for-later-first-class-parked-state.md)
- [Signal-hash advisory nudges](../design-patterns/signal-hash-advisory-nudges.md)
- [Test-audit driven battle testing](./test-audit-driven-battle-testing.md)

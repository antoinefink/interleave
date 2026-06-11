---
title: "Save for later parks sources instead of dismissing them"
date: "2026-06-11"
last_updated: "2026-06-11"
category: "docs/solutions/workflow-issues/"
module: "inbox-triage-parked-state"
problem_type: "workflow_issue"
component: "service_object"
severity: "high"
applies_when:
  - "Adding an inbox triage verb that means defer with intent rather than abandon"
  - "A lifecycle state must stay visible in inventory while excluded from inbox, queue, and daily work"
  - "A state transition needs SQLite persistence, typed IPC, operation logging, and undo preimages"
  - "A deferred lifecycle state needs a maintenance sweep so later does not become never"
related_components:
  - "database"
  - "frontend_stimulus"
  - "testing_framework"
tags: [inbox-triage, save-for-later, parked-state, parked-resurfacing, sqlite-migration, library-facet, undo, ipc]
---

# Save for later parks sources instead of dismissing them

## Context

Inbox triage has two different negative-looking outcomes that should not share one state:
abandoning a source, and deliberately setting it aside for later. Reusing `dismissed` for both
made saved-for-later material indistinguishable from abandoned material, impossible to count
separately, and hard to recover without broad inventory spelunking.

The durable product distinction is: Save for later creates a parked source. It is out of current
work routing, but still visible, dated, reversible, and separate from dismissal.

## Guidance

Model defer-with-intent as its own lifecycle state when it drives routing, inventory, or future
actions. For Interleave, that means `status = "parked"` plus a timestamp recording when the
source was parked.

Do not retroactively reclassify old dismissed rows unless the old data can prove user intent.
When the historical state conflates Save for later with Abandon, leave it dismissed and start
recording parked state only for new actions.

## Why This Matters

Lifecycle states are product semantics, not just labels. If two intents write the same state, every
later read model has to guess what the user meant. That breaks trust in a local-first incremental
reading app because overloaded users press Save for later exactly when they most need the system
to preserve intent.

Parking also keeps queue semantics clean. A parked source is intentionally not Inbox, not Due
queue, and not Daily Work. It should not surface as actionable work until the user chooses to move
it back to Inbox or schedule it. At the same time, it must remain queryable in Library with its
parked date so "later" does not silently become "never."

Undo stays straightforward when parked transitions use ordinary `update_element` operations. The
operation log needs the old `status`, `dueAt`, and `parkedAt` preimage; no custom operation type is
necessary.

The same distinction needs a maintenance loop once parked rows can age. A parked source should not
re-enter the queue automatically, but old parked rows should be discoverable as a calm resurfacing
sweep where the user decides whether to keep parking, queue now, or let go.

## When to Apply

- An action means "not now, but keep this deliberately" rather than "discard" or "complete."
- The state affects multiple read models, such as Inbox, Due queue, Daily Work, Library facets, or
  workload projections.
- The user must be able to count, inspect, restore, or schedule the deferred material later.
- Historical data cannot safely infer the new distinction, so migration must be additive and
  forward-looking.

Do not use this pattern for Queue soon. Queue soon accepts a source into due attention work now;
parking explicitly avoids creating due work.

Use the resurfacing-sweep extension when the deferred state can otherwise accumulate indefinitely.
The read side should only surface candidates; the write side should still wait for explicit user
decisions.

## Examples

Save for later should be a single trusted mutation with a clear audit payload:

```ts
this.repos.elements.updateWithin(
  tx,
  id,
  { status: "parked", dueAt: null, parkedAt: nowIso() },
  { extras: { action: "keepForLater" } },
);
```

Parked actions can stay ordinary updates with explicit audit markers:

```ts
this.repos.elements.updateWithin(
  tx,
  id,
  { status: "scheduled", dueAt: now, parkedAt: null },
  { extras: { action: "queueSoonFromParked" } },
);
```

Parked resurfacing is the maintenance version of the same lifecycle rule:

- keep due discovery read-only and based on trusted settings;
- re-read each renderer-provided id at apply time because the drill-down may be stale;
- skip stale or ineligible ids with explicit reasons instead of treating them as fatal;
- apply all valid decisions in one transaction with one shared `batchId`;
- use existing `update_element` preimages rather than inventing a special operation type.

The command service shape should look like one logical batch, not one transaction per row:

```ts
return this.db.transaction((tx) => {
  for (const decision of decisions) {
    const element = this.elements.getByIdWithin(tx, decision.id);
    if (!isStillParkedAndDue(element)) continue;

    this.elements.updateWithin(tx, decision.id, patchFor(decision.kind), {
      batchId,
      extras: { action: `parkedResurfacing:${decision.kind}` },
    });
  }
});
```

The renderer should remain an intent UI. It can show a Maintenance card, load the due rows, collect
Keep / Queue / Let go decisions, and call a typed `maintenance.parkedResurfacingApply` command. It
should not decide eligibility or write storage directly. For large drill-downs, preserve list and
selected-state semantics even when virtualization replaces native `<ul>/<li>` markup with absolute
row wrappers.

The migration should prove more than the new column exists. Rebuilding a CHECK-constrained SQLite
table is risky when many side tables reference the rebuilt table, so tests should seed dependent
rows and assert they survive. If the migration drops and recreates FTS triggers, tests should also
update searchable rows after the migration and query the FTS tables.

## Prevention

- Treat new lifecycle states as cross-cutting changes. Let typecheck find exhaustive status
  switches, then add focused tests for each read model.
- Keep parking behind typed IPC and repository methods; never let the renderer infer or write
  persistence directly.
- Update the lifecycle vocabulary, SQLite CHECK constraints, migration journal, row mappers,
  typed contracts, bridge methods, inventory facets, exclusion rules, and undo preimages together.
- Preserve old conflated rows unless the migration has evidence strong enough to reclassify them.
- Refresh Library counts from the backend after parked actions so facet counts and rows come from
  the same read model.
- Clear shared selection when an action removes the selected row from the active facet.
- Add Electron coverage for the full user story: park from Inbox, find in Library Parked, restart,
  and restore or schedule.
- For resurfacing sweeps, add an atomicity test that forces one write in the batch to fail and
  proves earlier decisions roll back with it.
- Add Electron coverage that applies every resurfacing decision, restarts the app, verifies the
  durable statuses through `window.appApi`, and only then undoes the batch.
- Keep the Maintenance UI accessible: expandable metric cards should expose expanded state, and
  segmented decisions should expose the selected state, not only visual styling.

## Related

- [Inbox Queue soon schedules sources due now without opening the reader](inbox-triage-queue-soon-attention-scheduling.md) documents the contrasting triage path that creates due attention work.
- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md) documents the backend-owned queue membership and undo-preimage rules parking relies on.
- [Test operation-log and IPC invariants for extract→card mutation paths](../architecture-patterns/extract-card-ipc-invariant-test-hardening.md) documents the broader mutation-path testing pattern for command validation, operation logs, and multi-write invariants.
- [Test audit driven battle testing](../architecture-patterns/test-audit-driven-battle-testing.md) documents why persistence-sensitive mutation paths need restart coverage rather than only same-process assertions.
- [Daily work read model routes inbox-only days honestly](../ui-bugs/daily-work-read-model-inbox-only-routing.md) documents trusted-side routing and the separation between lifecycle status, due date, and read point.
- [Route-owned Collection Explorer modes with URL handoff](../architecture-patterns/collection-explorer-route-owned-modes.md) documents the Library/Browse route-state pattern used by the Parked facet.
- [Drizzle migrator tracks only a high-water mark](../database-issues/drizzle-migrator-high-water-mark-skips-out-of-order-migrations.md) documents why migration journal ordering needs explicit attention.

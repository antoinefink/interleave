---
title: "Model topic knowledge state as current read-only maturity receipts"
date: 2026-06-12
category: architecture-patterns
module: topic-knowledge-state
problem_type: architecture_pattern
component: database
severity: medium
related_components:
  - "service_object"
  - "testing_framework"
  - "ipc-contract"
  - "renderer-api"
applies_when:
  - "A topic or concept needs a maturity receipt derived from existing durable local facts."
  - "Analytics must combine live hierarchy, concept membership, review logs, review state, retention targets, and verification tasks without storing snapshots."
  - "Graduation events should be deterministic current-state receipts rather than persisted mutations."
  - "The renderer needs a typed analytics surface without raw SQLite or filesystem access."
tags: [topic-knowledge-state, analytics, read-model, maturity, graduation, retention, concepts, ipc]
---

# Model topic knowledge state as current read-only maturity receipts

## Context

T108 needed to define "mature knowledge" operationally for topics and concepts. The model had to
answer whether work had moved through the source-to-card pipeline, whether active cards were stable,
whether measured retention was near the target, and whether stale or open verification work blocked
confidence.

The reusable pattern is a current-state receipt over durable local facts. `TopicKnowledgeStateQuery`
reads live elements, concept membership, topic descendants, block-processing summaries, extract
fates, synthesis references, card review state, review logs, per-concept retention targets, and open
verification tasks. It does not create analytics tables, store graduation history, mutate schedules,
or append `operation_log`.

## Guidance

Keep topic knowledge state a receipt, not a workflow engine. Graduation events are deterministic
current candidates with stable ids, not historical threshold-crossing rows:

```ts
eventId = `${subjectType}:${subjectId}:graduated:v1`;
eventType = "current_graduated";
```

Make subject expansion explicit and narrow:

- Concepts aggregate direct concept members plus descendants of those members.
- Topics aggregate only the live `parentId` subtree rooted at the topic.
- `sourceId` is provenance only. It must not pull sibling chapters, sibling extracts, or detached
  source-provenance rows into a topic or concept rollup.

Use adjacent funnel ratios instead of one absolute completion percentage. Topics grow as new sources
arrive, so the safer receipt is stage-to-stage movement: read, extracted, distilled, carded, mature.
T104 value outputs count as productive distilled output; fated extracts and live synthesis references
are not failed carding.

Separate visible retired history from active graduation math. Retired cards can appear in stability
buckets, but active non-retired cards own `carded`, `mature`, review-count floors, retention, and
graduation:

```ts
const activeCardIds = cardIds.filter((id) => !cardInfo.get(id)?.isRetired);

funnel.carded = activeCardIds.length;
stability.retired += cardIds.length - activeCardIds.length;
```

Measure retention from real review logs, not FSRS prediction. Use a bounded rolling window, compute
the non-Again share, and build half-open snapshots so boundary reviews cannot appear in two buckets:

```ts
const inBucket = ms >= startMs && (isLastBucket ? ms <= endMs : ms < endMs);
```

Gate graduation on current data quality:

- minimum active-card floor
- minimum in-window review floor
- mature-card ratio
- retention target tolerance
- no stale source-processing state
- no live open verification tasks

Expose the receipt through the analytics bridge namespace. The renderer gets
`analytics.topicKnowledgeState` and a convenience wrapper; it never groups raw rows, bypasses Zod
validation, or receives arbitrary database or filesystem capability.

## Why This Matters

Maturity analytics are easy to overstate. If concept rollups use provenance as membership, unrelated
material makes a topic look broader or healthier than it is. If retired cards count as active
maturity, archived knowledge can make current learning look graduated. If graduation is written as
history before a ledger exists, the app invents lifecycle events it cannot faithfully undo or
reconcile.

Keeping the model current and read-only preserves provenance. Every number traces back to durable
local state, while T109 and T110 can render or compose the receipt without reimplementing maturity
semantics in React.

## When to Apply

- A feature summarizes maturity, integrity, yield, or confidence from facts already stored elsewhere.
- The read crosses hierarchy, lineage, review logs, scheduler state, and settings.
- The result may later drive a surface, warning, daily summary, or weekly ritual.
- The app needs a typed Electron bridge read without exposing raw SQLite or filesystem access.

Do not apply this pattern to commands, scheduling changes, cleanup, or anything that needs undo.
Those paths should stay command-shaped, transactional, and operation-logged.

## Examples

Pin read-only behavior in tests:

```ts
const before = db.select().from(operationLog).all().length;
const summary = new TopicKnowledgeStateQuery(db).getTopicKnowledgeState(asOf);

expect(summary.subjects).toHaveLength(1);
expect(db.select().from(operationLog).all()).toHaveLength(before);
```

Assert subject expansion against the common provenance trap:

```ts
// Topic rollup: parent subtree only.
includedIds = descendantSubtree(topic.id);

// Concept rollup: direct members plus their descendants.
for (const memberId of directConceptMembers) {
  included.add(memberId);
  for (const childId of descendantSubtree(memberId)) included.add(childId);
}
```

Keep verification blockers live and open:

```ts
const openTask =
  task.status !== "done" &&
  task.status !== "dismissed" &&
  task.status !== "cancelled" &&
  taskElement.deletedAt === null;
```

Test the full boundary, not only the query:

- local-db fixtures for ratios, stability buckets, retention snapshots, and graduation edges
- contract tests for valid and rejected request payloads
- IPC/preload/appApi forwarding tests
- a non-desktop renderer fallback that returns an empty typed receipt
- Electron E2E proving `window.appApi.analytics.topicKnowledgeState` exists and no generic
  `db.query` is exposed

## Related

- [Model priority integrity as read-only analytics over durable logs](./priority-integrity-read-model.md)
- [Build review activity heatmaps as trusted analytics read models](./review-activity-heatmap-read-model.md)
- [Capture review analytics facts in review_logs, not parallel state](./review-analytics-data-capture-in-review-logs.md)
- [Model honorable non-card extract fates as first-class value output](./extract-fates-value-model-v2-source-yield-stagnation.md)
- [Durable source block processing state](./durable-source-block-processing-state.md)
- [Topic fallow rest with operation-log preimages](./topic-fallow-rest-operation-log-preimages.md)

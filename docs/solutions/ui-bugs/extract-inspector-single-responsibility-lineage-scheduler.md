---
title: "Extract inspector single-responsibility layout and scheduler refresh"
date: "2026-06-07"
category: "docs/solutions/ui-bugs/"
module: "apps/web inspector and queue scheduling"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "Extract inspector repeated priority, status, stage, source reference, and source location across multiple sections."
  - "Source context exposed duplicate jump/open-source actions instead of one lineage-owned action."
  - "Inspector attention rescheduling could complete against stale selection state and leave queue surfaces stale."
  - "Review-scope card source context needed explicit redaction coverage after the source-lineage merge."
root_cause: "logic_error"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "apps/web/src/components/inspector/Inspector.tsx"
  - "apps/web/src/components/queue/ScheduleMenu.tsx"
  - "apps/web/src/components/queue/queueRefresh.ts"
  - "apps/web/src/pages/queue/QueueScreen.tsx"
  - "apps/web/src/pages/queue/ProcessQueue.tsx"
tags:
  - "inspector"
  - "extracts"
  - "source-lineage"
  - "attention-scheduler"
  - "fsrs"
  - "queue-refresh"
  - "source-context"
  - "stale-async"
---

# Extract inspector single-responsibility layout and scheduler refresh

## Problem

The extract inspector made users reconcile the same facts across header chips, metadata rows, scheduler rows, and separate source sections. Source evidence was split across "From source", "Source reference", and "Source location", with both "Open source at this location" and "Jump to source" actions representing the same navigation.

## Symptoms

- Priority, status, and stage appeared in several places instead of having one clear owner.
- The attention section restated metadata instead of summarizing scheduling state.
- Source title, quote, citation, link, and source location were split across multiple cards.
- Two source-opening actions pointed at the same lineage location.
- Adding inspector-side scheduling created stale async risks: a delayed response could overwrite a newer selection, and queue/process surfaces could keep showing an item after it was rescheduled away.

## What Didn't Work

- Keeping `SchedulerChip` in the header and also showing stage rows in metadata and attention. The chip remained useful, but the header became a pile of repeated state rather than an identity summary.
- Rendering `RefBlock` with its own `onOpenSource` action beside a separate source-location jump. That preserved existing components but duplicated the user action.
- Re-reading only inspector data after `scheduleQueueItem`. The mutation affects queue membership, so mounted queue surfaces also need to re-read.
- Applying `getInspectorData` results after an awaited schedule call without checking whether the same element is still selected.

## Solution

Give every inspector fact one canonical owner:

- Header owns identity and a compact state line: `Type · Priority · Status · Stage`.
- Properties owns editable metadata and controls: type, status, priority, priority editor, and due date. It no longer repeats stage.
- Scheduler owns the canonical scheduler signal. It still renders `SchedulerChip`, then shows FSRS stats for cards or a compact attention summary plus `ScheduleMenu` for attention items.
- Source lineage owns all source evidence: source title, selected quote, citation/link metadata, location metadata, and exactly one `Jump to source` action.
- Export remains a lower-priority utility section after the primary source-lineage context.

The core shape is:

```tsx
<div data-testid="inspector-state-line">{headerStateLine(element, review)}</div>

<SchedulerChip scheduler={scheduler} />
{scheduler.kind === "fsrs" ? (
  <FsrsStats scheduler={scheduler} />
) : (
  <AttentionSummary scheduler={scheduler} />
)}

<SourceLineageSection
  source={source}
  sourceRef={sourceRef}
  location={location}
  onJumpToLocation={onJumpToLocation}
/>
```

The source-lineage block keeps `RefBlock` for citation/link/reliability display but suppresses its duplicate source-opening affordance. The lineage section owns the single jump button:

```tsx
{canJump && location ? (
  <button type="button" data-testid="location-jump" onClick={() => onJumpToLocation(location)}>
    Jump to source
  </button>
) : null}
```

Inspector scheduling still uses the typed bridge command, but the state update is target-bound and stale-safe:

```ts
await appApi.scheduleQueueItem({ id: elementId, choice });
requestQueueRefresh();

const res = await appApi.getInspectorData({ id: elementId });
if (selectedIdRef.current !== elementId) return;
if (!res.data) {
  setData(null);
  setError("Element unavailable.");
  return;
}

setData(res.data);
```

Because queue membership can change from outside the queue pages, add a narrow UI-only refresh event rather than sharing queue component state:

```ts
export const QUEUE_REFRESH_EVENT = "interleave:queue-refresh";

export function requestQueueRefresh(): void {
  window.dispatchEvent(new Event(QUEUE_REFRESH_EVENT));
}

export function listenQueueRefresh(handler: () => void): () => void {
  window.addEventListener(QUEUE_REFRESH_EVENT, handler);
  return () => window.removeEventListener(QUEUE_REFRESH_EVENT, handler);
}
```

`QueueScreen` and `ProcessQueue` listen to this event and re-read through their existing `appApi.listQueue` paths.

## Why This Works

The inspector becomes scannable because each fact has one owner. The header identifies the element; properties are the editable surface; scheduler describes return behavior; lineage composes source evidence and source navigation.

The scheduler section preserves the load-bearing split between FSRS and attention scheduling. Cards answer "Can the user recall this?" through FSRS stats. Extracts and other attention items answer "Should this return?" through the attention summary and explicit reschedule menu.

The source-lineage block preserves source grounding without making the user choose between equivalent actions. Redaction remains centralized: when a hidden card review scope is active, source lineage, parent, and full lineage sections stay hidden.

The queue refresh event keeps cross-surface effects consistent without expanding the renderer API or exposing persistence details. The stale-selection guard follows the same pattern as other source-navigation fixes: async responses only apply when the request target is still current.

## Prevention

- Start inspector changes with an ownership map: header, properties, scheduler, lineage, utilities.
- Test both presence and absence. Assert new sections render and old duplicate sections/actions stay gone.
- Keep FSRS and attention scheduling visibly distinct in tests; an attention schedule menu should never appear for FSRS-only card state.
- When a mutation in one mounted surface affects another surface's membership, add a narrow refresh signal or reuse an existing one.
- Bind async mutations to the rendered element ID, then compare that ID to current selection before applying delayed results.
- Move reusable control styling into the reusable component when the control leaves its original row context.

## Related Issues

- `docs/solutions/ui-bugs/embedded-active-card-detail-in-extract-workspace.md` — closest predecessor for extract/card UI, source-context safety, and stale async guards.
- `docs/solutions/ui-bugs/active-card-rows-open-card-detail-surface.md` — protected card routing, inspector source redaction, and FSRS session separation.
- `docs/solutions/architecture-patterns/extract-card-ipc-invariant-test-hardening.md` — source-lineage persistence and mutation-boundary test invariants.
- `docs/solutions/ui-bugs/url-imported-articles-inbox-processing.md` — narrow event-driven navigation/refresh precedent.

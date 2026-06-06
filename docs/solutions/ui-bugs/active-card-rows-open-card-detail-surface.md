---
title: "Active card rows should open a protected card detail surface"
date: "2026-06-06"
category: "docs/solutions/ui-bugs/"
module: "apps/web card routing and review"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "Clicking an active_card row did not open a usable card detail or edit surface."
  - "Card-linked tasks and card rows opened the generic review session instead of the clicked card."
  - "Hidden answer and source context could leak through Inspector or global source actions before reveal."
root_cause: "missing_workflow_step"
resolution_type: "code_fix"
related_components:
  - "routing"
  - "review"
  - "inspector"
  - "testing_framework"
tags:
  - "active-card"
  - "card-detail"
  - "card-routing"
  - "review"
  - "inspector"
  - "reveal-state"
  - "source-context"
  - "tanstack-router"
---

# Active card rows should open a protected card detail surface

## Problem

Clicking an `active_card` row or a task linked to a card did not open a usable card detail/edit surface. The app treated card clicks as "start review session" or "select card in inspector", so the clicked card was not reliably addressable as a single repairable object.

## Symptoms

- Card rows from queue, home, library, concepts, synthesis, or linked tasks navigated to `/review`.
- `/review` opened the FSRS due-card session, not necessarily the clicked card.
- Selecting a card only exposed inspector context, not a full prompt/answer/edit surface.
- Source context could leak before reveal if global selection, the persistent Inspector, or global shortcuts still targeted the hidden card.
- Delayed "open source" responses could navigate from stale card/source state after the selected element or route changed.

## What Didn't Work

- Using `/review` as a generic card destination. That route is a session loop driven by the next due card, not an id-addressable detail page.
- Relying on global shell selection to "open" a card. Selection drives the Inspector, but it does not provide the card answer, reveal state, or repair workflow.
- Selecting card-linked tasks before navigation. That made global actions and Inspector data point at a hidden review object before the card was revealed.
- Letting async source navigation complete without checking whether the user was still on the same card or selection.

## Solution

Add a dedicated card detail route:

```ts
const cardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/card/$id",
  component: CardScreen,
});
```

Centralize card row/task opening so card targets clear Inspector selection and navigate by id:

```ts
function routeToCard(navigate: NavigateFn, id: string): void {
  void navigate({ to: "/card/$id", params: { id } });
}

export function openQueueItem({ item, navigate, select, asOf }: OpenQueueItemOptions): void {
  if (item.type === "task" && item.linkedElementId) {
    select(item.linkedElementType === "card" ? null : item.linkedElementId);
    routeToElement(item.linkedElementType ?? null, item.linkedElementId, navigate, asOf, {
      linkedTaskTarget: true,
    });
    return;
  }

  select(item.type === "card" ? null : item.id);
  routeToElement(item.type, item.id, navigate, asOf);
}
```

Make every direct card caller route to `/card/$id`, not `/review`:

```ts
if (item.type === "card") {
  void navigate({ to: "/card/$id", params: { id: item.id } });
}
```

Build `CardScreen` as a targeted card loader that reuses the existing review repair UI:

```ts
const { id } = useParams({ from: "/card/$id" });

useEffect(() => {
  setCard(null);
  select(null);
  setRevealed(false);
  setDrawerOpen(false);

  void appApi.reviewCard({ cardId: id }).then((res) => {
    setCard(res.card);
  });
}, [id, select]);
```

Only select the card after reveal, and suppress global element actions while hidden:

```ts
useActiveScope("review", desktop && !revealed && (loading || card !== null));

useEffect(() => {
  if (!desktop) return;
  if (revealed && cardId) {
    select(cardId);
  } else {
    select(null);
  }
}, [desktop, revealed, cardId, select]);
```

Redact Inspector source context while a hidden card review scope is active. Source, location, parent, and full lineage can all reveal context, so the redaction must cover more than just the refblock:

```ts
const redactCardSourceContext = element.type === "card" && isScopeActive("review");

{!redactCardSourceContext && sourceRef && <RefBlock ref={sourceRef} />}
{!redactCardSourceContext && location && <SourceLocation location={location} />}
{!redactCardSourceContext && parent && <ParentLineage parent={parent} />}
{!redactCardSourceContext && lineage && <LineageTree nodes={lineage.nodes} />}
```

Reuse the existing card repair path instead of adding parallel mutation behavior:

```tsx
{revealed ? (
  <ReviewRepairBar
    card={card}
    busy={false}
    onOpenSource={openSource}
    onCardUpdated={patchCard}
    onCardRemoved={leaveAfterRemoval}
    drawerOpen={drawerOpen}
    onDrawerOpenChange={setDrawerOpen}
  />
) : null}
```

Guard stale global/source navigation:

```ts
const requestedId = selectedId;
const res = await appApi.getInspectorData({ id: requestedId });

if (selectedIdRef.current !== requestedId || hasActiveScope()) return;
```

## Why This Works

`/review` remains the FSRS session surface, while `/card/$id` becomes the stable "open this card" surface. Row clicks now carry the card id through the router instead of hoping the review session or inspector selection resolves the same object.

Clearing selection before card navigation prevents the Inspector and global shortcuts from exposing source context before reveal. After reveal, selecting the card restores normal Inspector/source affordances; hiding the answer clears selection again.

Using `ReviewRepairBar` keeps edits, suspend/delete, flag, leech, and source navigation on the existing typed bridge paths, so the fix does not create a parallel card-edit model.

The stale-response guards make async navigation conditional on the same card/selection still being current.

## Prevention

- Treat `/review` only as a session route. Any UI that opens one specific card should route to `/card/$id`.
- For card-linked tasks, route to the linked card id and clear selection before navigation.
- Keep reveal-sensitive screens behind an active scope until the answer/source context is intentionally revealed.
- When hiding source context, audit every shared surface that reads selection: Inspector source sections, parent/lineage sections, global actions, and direct page buttons.
- Add route/caller tests for every card-opening surface: queue, home preview, process queue, library browse/search, concepts, synthesis links, and inspector lineage.
- Add async race tests for delayed source navigation after route id or selection changes.

## Related Issues

- [URL-imported articles should render as internal readable sources](./url-imported-articles-inbox-processing.md) - loose precedent for separating internal navigation from source/provenance affordances and testing stale navigation state.

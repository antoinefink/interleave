---
title: "Embedded active card detail in extract workspace"
date: "2026-06-06"
last_updated: "2026-06-06"
category: "docs/solutions/ui-bugs/"
module: "apps/web extract card detail and review repair flows"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "Clicking an active_card lineage node in ExtractView did not open a main-area card editor or stats surface."
  - "The center distillation panel stayed focused on the extract even after the user chose a linked card."
  - "A card detail surface embedded in the extract workspace needed to avoid hidden answer and source-context leaks."
  - "Stale async card, preview, source, or lineage responses could update UI after route/card changes."
  - "Pending repair operations or dirty autosaves could race with grading, removal, and source shortcuts."
root_cause: "async_timing"
resolution_type: "code_fix"
related_components:
  - "apps/web/src/reader/ExtractView.tsx"
  - "apps/web/src/reader/ExtractView.test.tsx"
  - "apps/web/src/review/CardDetailPanel.tsx"
  - "apps/web/src/review/CardScreen.tsx"
  - "apps/web/src/review/CardScreen.test.tsx"
  - "apps/web/src/review/ReviewRepairBar.tsx"
  - "apps/web/src/review/ReviewRepairBar.test.tsx"
  - "apps/web/src/review/ReviewScreen.tsx"
  - "apps/web/src/review/ReviewScreen.test.tsx"
  - "tests/electron/lineage.spec.ts"
tags:
  - "extract-view"
  - "active-card"
  - "card-detail"
  - "lineage"
  - "review-repair"
  - "reveal-state"
  - "race-condition"
  - "test-hardening"
---

# Embedded active card detail in extract workspace

## Problem

An `active_card` node in the extract lineage tree represented a real card, but clicking it did not replace the extract's main distillation workspace with a card-oriented surface. The user could see the card in lineage without getting an in-context place to inspect its FSRS stats or edit it.

The final fix also had to preserve recall safety and async correctness. The shared card detail surface should not leak answer/source context before reveal, and stale card/source/lineage responses should not mutate the wrong card or extract after the user changes route or selection.

## Symptoms

- Clicking a card node in `/extract/$id` did not open a main-area card detail section.
- The center panel remained `extract-distill` even though the chosen lineage item was a card.
- Opening an existing card while `CardBuilder` was visible could leave the screen split between creating a new card and inspecting an existing one.
- The lineage active marker could remain on the extract while the main area was showing card context.
- Source lookup, preview, card load, edit autosave, and removal callbacks could complete after the user had moved to another card or extract.
- Pending repair operations or dirty edits could overlap with grading, back/hide actions, source jumps, or removal actions.

## What Didn't Work

- Routing card lineage nodes to `/review` is the wrong model because `/review` is a due-card grading session, not a targeted editor for one card.
- Routing away to `/card/$id` is usable from global surfaces, but it drops the extract workspace context where the user clicked the lineage node.
- Selecting the card only in the Inspector is too weak for a lineage link in the main extract workflow; it does not provide answer display, FSRS stats, or repair controls.
- Rendering full edit/source controls while the card answer was hidden leaked the answer through edit fields and could leave source context visible after hiding.
- Adding the embedded panel without busy and stale-response guards left races between edit autosave, removal, grading, source jumps, and route/card changes.

## Solution

Extract the targeted card UI from the standalone card route into a shared panel:

```tsx
<CardDetailPanel
  cardId={id}
  backLabel="Back to queue"
  onBack={backToQueue}
  onCardRemoved={backToQueue}
/>
```

In `ExtractView`, keep a local `activeCardId` for the embedded drill-in. Card lineage clicks clear global selection while the card loads, close the new-card builder, and replace the center distill section with the shared card panel:

```tsx
if (n.type === "card") {
  select(null);
  setBuilder(null);
  setActiveCardId(n.id);
}

{activeCardId ? (
  <section className="extract-card-detail" data-testid="extract-card-detail">
    <CardDetailPanel
      cardId={activeCardId}
      initiallyRevealed={true}
      backLabel="Back to extract"
      onBack={closeActiveCard}
      onCardRemoved={onEmbeddedCardRemoved}
    />
  </section>
) : (
  <section className="extract-distill" data-testid="extract-distill">
    ...
  </section>
)}
```

Mark the active card in the lineage tree while the embedded panel is open:

```tsx
const visibleLineageNodes = activeCardId
  ? lineageNodes.map((node) => ({ ...node, active: node.id === activeCardId }))
  : lineageNodes;
```

The embedded panel opens revealed because it is an edit/stats surface, not a recall prompt. If the user hides the answer, `CardDetailPanel` closes the source drawer and clears selection again through the same revealed-state selection effect the standalone card route uses.

`ReviewRepairBar` is also hardened so repair and source actions only exist while the card is revealed. Hiding the answer unmounts those controls and closes source context instead of leaving answer-adjacent data visible.

Propagate repair/edit busy state upward through `onBusyChange` so parent surfaces can disable conflicting actions while a dirty autosave, suspend, delete, retire, flag, leech, or context operation is in flight. Edit autosave is serialized by patch fingerprint: duplicate blur/done saves reuse one request, newer edits wait behind the active request, and stale completions do not patch the visible card.

Guard async UI state with mounted refs, current card/extract ids, and request sequence refs. `ExtractView`, `CardDetailPanel`, `CardScreen`, and `ReviewScreen` ignore stale loads, source lookups, interval previews, next-card responses, and removal callbacks when the user has moved on.

## Why This Works

The renderer still uses the narrow typed bridge: `appApi.reviewCard`, `appApi.updateCard`, and the existing card repair commands. No raw DB, filesystem access, schema change, or new IPC surface is needed.

`CardScreen` and the extract-embedded card section now share one targeted-card implementation, so answer rendering, FSRS stats, edit patching, source jumps, suspend/delete, flagging, and leech handling stay consistent.

The local `activeCardId` keeps this interaction contextual to the extract workspace. Global card openers can still use `/card/$id`; the extract lineage tree gets a scoped exception that preserves the user's current work area.

Busy propagation prevents simultaneous repair/edit and review mutations from racing each other. Sequence guards make each async completion conditional on the card or extract that requested it, so stale responses become no-ops rather than updating the current surface.

## Prevention

- Treat `/review` only as the active-recall session. Specific card targets should use either `/card/$id` or a contextual embedded targeted-card panel.
- For card drill-ins, clear selection before loading the card, then select the card only after the visible detail surface is ready.
- Keep hidden card state and source-context state coupled: hiding the answer must close drawers and unmount repair/source actions.
- Treat dirty edits and repair operations as busy in both targeted card detail and review sessions; block back, hide, grade, source shortcuts, and destructive repair actions while they are pending.
- Pair async request sequence checks with current card or extract id checks in route-scoped UI.
- Test both standalone and embedded card surfaces when refactoring shared review UI.
- For lineage card clicks, assert that the URL stays on `/extract/$id`, `extract-distill` is removed, `extract-card-detail` is visible, `appApi.reviewCard({ cardId })` is called, the card can be edited, FSRS stats sit at the bottom without overlap, the lineage active marker moves to the card, stale responses are ignored, and removal returns to distill.

## Related Issues

- [Active card rows should open a protected card detail surface](./active-card-rows-open-card-detail-surface.md) - direct predecessor for targeted card opening and reveal/source-context safety. This embedded extract flow is a scoped exception to the older "route to `/card/$id`" default.
- [Test operation-log and IPC invariants for extract->card mutation paths](../architecture-patterns/extract-card-ipc-invariant-test-hardening.md) - adjacent testing guidance for lineage-sensitive card workflows that must stay on typed IPC/domain paths.

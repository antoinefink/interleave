---
title: "Advisory suggestion-engine patterns: dispersion suppression, id-signature fetch keys, OpContext provenance"
date: 2026-06-15
category: architecture-patterns
module: suggestion-engine
problem_type: architecture_pattern
component: service_object
severity: medium
related_components:
  - "database"
  - "frontend_stimulus"
  - "testing_framework"
applies_when:
  - "Averaging a neighbor/KNN signal can manufacture a band or value no contributing neighbor actually holds."
  - "A React fetch effect keyed on an array/object re-runs a per-row batch on every unrelated content change."
  - "An advisory suggestion must stay measurable (accept vs override) without minting a new op type."
  - "A new signal must not feed back into the inputs that generate future suggestions."
  - "Surfacing a deterministic suggestion that must never be auto-applied (suppress rather than guess)."
tags:
  - "triage"
  - "suggestions"
  - "priority"
  - "semantic-neighbors"
  - "automation-bias"
  - "react-effect-key"
  - "op-log-provenance"
  - "read-model"
---

# Advisory suggestion-engine patterns (T127)

## Context

T127 ("Suggested priority & placement") turns three dormant deterministic signals —
semantic neighbors (local KNN over source vectors), per-author/per-domain yield, and
source reliability — into an **advisory** suggested priority band + concept placement on
inbox triage. The product law the feature is built around: *never auto-apply, and if the
numbers wouldn't convince you, suppress the suggestion rather than guess.* Three design
decisions made that law hold without contaminating the system that produces the signal.
They share one through-line — **suggest, never auto-apply, and stay measurable without
polluting the inputs** — so they live together.

---

## 1. Dispersion suppression for averaged signals

### Guidance

When a suggestion is derived by **averaging a set of neighbor values** (here: the priority
of KNN source neighbors), guard against the average landing on a value **no contributing
neighbor actually holds**. Before trusting the average, check the spread of the
contributors; if they span more than one band/bucket, the set is bimodal and the average
is a fabrication — suppress that signal instead of emitting it.

```ts
// packages/local-db/src/triage-suggestion-query.ts — gatherSemantic()
const bandOrdinals: number[] = [];
for (const hit of hits) {
  const neighbor = this.repos.elements.findById(hit.elementId);
  if (!neighbor || neighbor.priority === DEFAULT_PRIORITY) continue; // no explicit signal
  prioritySum += neighbor.priority;
  bandOrdinals.push(PRIORITY_LABELS.indexOf(priorityToLabel(neighbor.priority)));
}
// Two A's and two D's would average to a confident MIDDLE band (B/C) no neighbor holds,
// justified "Near 4 priority-B neighbors". Suppress when the set spans >1 band.
if (Math.max(...bandOrdinals) - Math.min(...bandOrdinals) > 1) return undefined;
const lean = priorityToLabel(prioritySum / neighborIds.length);
```

The pure scorer (`packages/core/src/triage-suggestion.ts`) reinforces this at the
combination layer: it is a **total function** that returns `insufficient_signal` when 0
signals clear their floor, when fired leans are more than one band apart
(`conflict_unresolved`), or after honesty-filtering empties the justification — and a
reliability cap only ever moves a band *down*, never up.

### Why this matters

Averaging is the obvious way to combine neighbor signals and the obvious way to
manufacture automation bias. A confident "B" backed by a polarized A/D cluster is exactly
the plausible-but-wrong suggestion the spec engineers against — and it reads as *more*
authoritative than no suggestion because it cites a count ("Near 4 neighbors"). The
dispersion guard is cheap (min/max of ordinals already in hand) and converts the failure
into the honest outcome: show nothing.

### When to apply

Any suggestion/score derived from a mean/median over a heterogeneous neighbor or
member set, where the consumer treats the output as a confident point value. Pair it with
a **minimum-contributor floor** (here ≥2 non-default neighbors) so a single outlier can't
carry the signal either.

---

## 2. Stable id-signature key for a per-row batched fetch

### Guidance

A React effect that batch-fetches per-row data for a list must key on a **stable
signature of the row id SET**, not on the list array/object reference. Otherwise any
content-only change to the list (a single row's field rewrite) produces a fresh array
reference, refires the effect, and re-runs the entire batch — plus blanks every row's
derived state back to "pending".

```ts
// apps/web/src/pages/inbox/useInboxSuggestions.ts
const idSignature = useMemo(() => itemIds.join("\n"), [itemIds]); // value-stable string
useEffect(() => {
  const ids = idSignature.split("\n").slice(0, SUGGESTION_FETCH_CAP); // cap at the IPC bound
  // Carry forward verdicts already known for surviving ids (no flash); new ids render
  // pending until the fetch resolves; merge single-verdict updates instead of replacing.
  setSuggestions((prev) => {
    const carried = new Map();
    for (const id of ids) { const known = prev.get(id); if (known) carried.set(id, known); }
    return carried;
  });
  void appApi.suggestTriage({ ids }).then(({ results }) =>
    setSuggestions((prev) => { const next = new Map(prev); for (const e of results) next.set(e.id, e.suggestion); return next; }),
  );
}, [idSignature]); // refetch only when the id SET changes — not on a row's content edit
```

### Why this matters

In an inbox of N rows, the broken version re-ran N KNN passes + a full-library yield
rollup on **every** accept/queue/delete/re-prioritize — a per-keystroke storm over the
exact large-inbox flow the feature targets — and flashed every chip to pending each time.
Keying on the id-set signature makes a content edit a no-op for the fetch, and merging
(rather than replacing) the verdict map keeps surviving rows from flickering. Two bonus
properties fell out of the same hook: a `slice(cap)` so a >1000-row inbox still suggests
the first N instead of having the whole `ids` batch rejected by the channel's `max(1000)`
guard, and a testable seam — assert the fetch fires once and does NOT refire when the
array ref changes but the ids don't.

### When to apply

Any list-bound `useEffect` (fetch, subscription, expensive derivation) whose work depends
on *which* rows exist, not on their content. The tell: the effect's dependency is the list
state and the list state is replaced wholesale on every item mutation.

---

## 3. Advisory-suggestion provenance via an OpContext.extras marker

### Guidance

When a user accepts an advisory suggestion, route the write through the **existing
command** (no new op type) and attach a provenance marker via the operation's
`OpContext.extras`. This makes accept-vs-override measurable from the op-log without a new
table or mutation shape, and keeps the marker out of the signal the suggestion was derived
from.

```ts
// apps/desktop/src/main/db-service.ts — triageInboxItem(), setPriority case
const suggestionExtras = action.suggestion
  ? { extras: { triageSuggestion: {
      decision: action.suggestion.decision,        // "accepted" | "overridden"
      suggestedBand: action.suggestion.suggestedBand,
      finalBand: action.priority,
      signalKinds: action.suggestion.signalKinds,
      signalHash: action.suggestion.signalHash,
    } } }
  : undefined;
this.repos.elements.updateWithin(tx, id, { priority: priorityFromLabel(action.priority) }, suggestionExtras);
// `updateWithin` spreads opContext.extras into the payload ROOT → payload.triageSuggestion
// (NOT payload.extras.triageSuggestion). A plain manual setPriority carries no marker.
```

### Why this matters

A second mutation path or a shadow "acceptances" table would drift from the real write and
add undo/lineage surface. Riding the existing `update_element` op keeps one source of
truth, reuses the existing undo guard, and the marker is forward-compatible (op-log
payloads already absorb unknown extras). Crucially, the marker is for **measurement only**
— it never becomes a signal input. The audited risk is the feedback loop: an accepted band
must not inflate the very signals that generate the next suggestion. Priority is not a
`SourceYieldInputs` field (no direct yield loop), and the rollup excludes `neutral`
(un-worked) sources. Two slow **indirect** loops remain and are accepted as
self-correcting: an elevated source gets reviewed more (earning real yield later), and it
reads as a non-default-priority neighbor for the semantic signal — both bounded by the
dispersion suppression and the ≥2-neighbor floor from pattern #1.

### When to apply

Any advisory/derived action whose acceptance you want to measure or audit, where a
command for the underlying mutation already exists. Carry the provenance on that command's
op payload; never let the provenance feed back into the signal that produced the
suggestion.

---

## Related

- [`signal-hash-advisory-nudges.md`](../design-patterns/signal-hash-advisory-nudges.md) — the
  advisory-signal family. Contrast: that pattern adds a dismissal command + dismissal row;
  this is the lighter "mark the existing op via `extras`, measure accept-vs-override" mechanism.
  Pick deliberately.
- [`trusted-schedule-reasons-from-governing-reschedule-ops.md`](./trusted-schedule-reasons-from-governing-reschedule-ops.md)
  — provenance/evidence carried on an existing op payload, with the advisory-vs-explicit
  marker discipline.
- [`search-typing-stutter-is-renderer-rerender-not-async-work.md`](../performance-issues/search-typing-stutter-is-renderer-rerender-not-async-work.md)
  — the renderer keying-on-a-stable-signature discipline behind pattern #2.
- [`priority-integrity-read-model.md`](./priority-integrity-read-model.md) — backend-flag-driven
  advisory + don't-pollute-the-measurement-signal, in the same priority domain.
- [`extract-fates-value-model-v2-source-yield-stagnation.md`](./extract-fates-value-model-v2-source-yield-stagnation.md)
  — the yield-signal purity constraint pattern #3 respects.

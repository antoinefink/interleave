---
title: "Computed proposals over a detected signal: the bounded, reversible command layer above a read-only detector"
date: 2026-06-15
category: architecture-patterns
module: "local-db/reread-proposals"
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - "A read-only detector surfaces a signal (a cluster, a stagnation, a leech) and you now want to turn it into capped, dismissible, accept/dismiss WORK without the detector itself mutating anything."
  - "Accepting a suggestion CREATES a new element, and you need that creation to be reversible by the user."
  - "A dismissible suggestion must stick when the user says no but still resurface if the situation genuinely worsens — and must not flap on noise or on improvement."
  - "Completing the suggested work cannot, by itself, clear the signal (the real remedy is downstream/async), yet the surface must still 'quiet' honestly after the user acts."
related_components:
  - database
  - testing_framework
  - scheduler
tags:
  - proposals
  - advisory-signal
  - dismissal-memory
  - hysteresis
  - soft-delete
  - undo
  - operation-log
  - surfacing-cap
  - system-tasks
---

# Computed proposals over a detected signal

## Context

T128 ships a **read-only** detector (`LapseClusterQuery`): it finds source regions whose descendant cards keep lapsing together and surfaces them with navigation-only affordances, never mutating anything (pinned by an all-tables row-count snapshot). T129's job was the layer above it — turn that signal into *scheduled re-read work*: a quiet, capped, dismissible **proposal** the user can accept (which schedules an attention item that opens the source at the failing region) or dismiss.

That "read model → bounded reversible command layer on top" seam recurs whenever a detector produces a list the user should be able to *act on without auto-application*. The non-obvious decisions are not in the detector (already documented) — they are in how the action layer stays advisory, capped, reversible, and honest. This doc captures the four decisions that were genuinely new in building that layer; two adjacent decisions (use a `task` type not a new element type; the partial-unique "one-open" index) are owned by [[system-owned-recurring-tasks]] and are only referenced here.

## Guidance

### 1. Compute proposals live; never store them

A proposal is not a row. Compute it every read from durable inputs: `proposals = detector.signal() − dismissals − already-scheduled-or-recently-done work`, then apply the surfacing cap. Only **dismissals** and **accepted work items** are persisted. This mirrors [[signal-hash-advisory-nudges]] (T103) and avoids a parallel table that drifts from the signal's source of truth (here, `review_logs`). The detector stays the single source of truth; the action layer is a thin filter over it.

### 2. Dismissal memory with *material-worsening hysteresis* (the headline novelty)

T103 persists a dismissal against a signal hash and resurfaces on *any* hash change. That flaps: a rolling-window signal naturally drifts, so a plain hash re-surfaces a dismissed item even when it **improves** (a card recovers, lapses age out). T129 hardens this:

- The dismissal row stores the **dismissed-at integer counters** (e.g. `total_window_lapses`, `affected_card_count`) alongside the hash.
- On read, the dismissal is honored (suppresses) **unless the signal is materially WORSE** than the dismissed-at evidence — a banded step up in magnitude, or a *new* member joining — computed from the stored counters. Improvement and sub-band noise stay suppressed.
- The dismissal is invalidated entirely (re-proposed) only when the *threshold signature* or *hash version* changed since dismissal — detected by recomputing the hash **at the dismissed-at counters** and comparing to the stored hash. A mismatch means the evaluator, not the evidence, moved.

This makes "dismissals stick, but a genuinely worsening situation comes back" true by construction, without resurfacing on every tick.

### 3. A created item is reversed by SOFT-DELETE, not by command-undo

The global command-level undo inverts only ops that carry a usable pre-image (`soft_delete_element` / `restore_element` / `update_element` / `reschedule_element`); **creations are not invertible** ("creates are undone by deleting"). So an accept that does `create_element` + N `add_relation` **cannot** be reversed by `undoLast`. The reversal is therefore an explicit **soft-delete of the created item** (which IS globally undoable/redoable), surfaced as the "Undo" affordance — *not* routed through the shared `undoLast`. The accepted item also reuses an existing element type (a system-owned `task`), so no new element type or op type is introduced — see [[system-owned-recurring-tasks]] and [[narrow-element-mutation-reusing-update-element-op]].

Corollary (the index hazard, generalized from [[system-owned-recurring-tasks]]): a partial-unique "one-open-per-target" index keys on `tasks.status`, but a *generic* soft-delete sets `elements.deleted_at` and leaves `tasks.status` open — stranding the slot. The action layer must **repair** any such stranded slot before creating (terminalize the soft-deleted row's `tasks.status`), exactly as the weekly-review singleton repair does. This hazard is not singleton-specific; it bites any system task whose status-keyed index is bypassed by a `deleted_at`-only delete path.

### 4. The cap is a SURFACING THROTTLE, not an accept budget

"Cap proposals" is ambiguous. The wrong reading is an **accept budget** (≤N accepts per rolling window): it perversely *punishes engagement* — a user who accepts the system's help is then shown *less* help precisely when a stronger signal appears, and a completed-but-historical accept keeps consuming the budget. The right reading is a **surfacing throttle**: at most N *active* proposals shown at once, decoupled from accept history. Re-proposing the same target is already prevented by the "already-scheduled-or-recently-done" filter (decision 1) + the one-open index — so the cap only bounds visible noise, never detection.

### 5. Completion suppresses via a grace window — the completed work *is* the memory

When the real remedy is downstream (here, the cards only recover on later FSRS review, which the action layer must NOT touch), "complete the work → the signal quiets" has no mechanism and would read as "the system ignored my effort." Close the loop honestly: a *completed* work item suppresses its target from proposals for a **grace window** (the completed task's existence IS the suppression memory — no extra table). After the window, if the signal still crosses the floor, it re-proposes (the work didn't help; worth another look). Set user expectations in copy ("these will be retested when they next come up") rather than pretending instant recovery.

## Why This Matters

- **The detector's read-only invariant is preserved.** The action layer lives strictly *above* the detector and never feeds accepted-work or dismissal state back into detection inputs (the same "don't pollute the signal you derived from" rule [[advisory-suggestion-engine-patterns]] enforces). Breaking this would make the detector's all-tables read-only proof a lie.
- **Reversibility is real, not aspirational.** Plenty of "undoable" features quietly aren't, because the author assumed a create is invertible. Naming the reversal path (soft-delete) at design time is what makes the Undo button actually work — a passing happy-path test hides the gap.
- **Advisory features earn or lose trust on the dismissal contract.** Flapping ("I said no and it came back") and nagging (an accept-budget that hides worsening problems) are how captive-tool users come to resent a feature. Hysteresis + a surfacing throttle are the difference between "quiet help" and "an alarm."

## When to Apply

Reach for this whole pattern when you have a **read-only detector** and want a bounded, reversible, dismissible action layer on top of it. Take the pieces individually when: you need dismissal memory that survives improvement (decision 2); your "accept" creates an element and needs an Undo (decision 3); you're tempted to cap by accepts (decision 4 — don't); or completing the work can't itself clear the underlying signal (decision 5).

Do **not** reach for it when the suggestion can be safely auto-applied (then it's not a proposal), or when the accepted action is a pure `update_element` with a pre-image (then the standard command-undo already reverses it and decision 3 doesn't apply — see [[extract-aging-policy-receipt-demotion]] for that simpler shape).

## Examples

**Material-worsening suppression (decision 2)** — recompute the hash at the *dismissed-at* counters to separate "evaluator changed" from "evidence changed", then suppress unless strictly worse:

```ts
// stored dismissal row: { stateHash, totalWindowLapses, affectedCardCount }
const expectedAtDismissal = stateHash(
  { targetId, totalWindowLapses: row.totalWindowLapses, affectedCardCount: row.affectedCardCount },
  thresholds,
);
if (expectedAtDismissal !== row.stateHash) return false; // thresholds/version moved → re-propose
const band = (n: number) => Math.floor(n / thresholds.minLapses);
const materiallyWorse =
  band(signal.totalWindowLapses) > band(row.totalWindowLapses) ||
  signal.affectedCardCount > row.affectedCardCount;
return !materiallyWorse; // suppress through improvement + sub-band noise
```

**Accept reversal + stranded-slot repair (decision 3)** — create is op-logged but reversed by soft-delete; the create path first frees any slot a generic soft-delete stranded:

```ts
accept(targetId) {
  // ... recompute the signal, validate it still crosses the floor ...
  this.repairStrandedOpenSlot(targetId);      // terminalize tasks.status of soft-deleted items
  if (this.hasOpenWork(targetId)) return { created: false, alreadyOpen: true };
  const id = this.db.transaction((tx) => {
    const el = this.elements.createWithin(tx, { type: "task", /* ... */ });   // create_element
    // ... insert the side-table row + N references edges (add_relation) ...
    tx.delete(dismissals).where(eq(dismissals.targetId, targetId)).run();      // accept supersedes dismiss
    return el.id;
  });
  return { created: true, taskElementId: id };
}
// Reversal (the "Undo" affordance): elements.softDelete(id) + terminalize tasks.status — NOT undoLast.
```

## Related

- [[sibling-clustering-over-the-lineage-dag]] — the read-only T128 detector this action layer sits on top of (the foundation; it detects and refuses to act).
- [[signal-hash-advisory-nudges]] — T103's dismissal-memory ancestor; decision 2 is "T103 hardened against flapping."
- [[advisory-suggestion-engine-patterns]] — the "suggest, never auto-apply; pick your advisory mechanism deliberately" family; this is a fourth point on that spectrum (computed proposal + dismissal row + accept-creates-a-task).
- [[system-owned-recurring-tasks]] — owns "add a task type, not an element type" and the partial-unique one-open index + soft-delete repair; decision 3's corollary generalizes its stranded-slot hazard.
- [[extract-aging-policy-receipt-demotion]] — sibling "read-only signal → opt-in reversible mutation," but it *demotes via `update_element`* (command-undoable) rather than creating + soft-delete-reversing, and has neither a surfacing throttle nor a completion grace window.
- [[command-level-undo-atomic-batch-inversion]] / [[card-edit-write-barrier-restabilization]] — the "non-invertible op owns its own reversal path" lineage decision 3 belongs to.

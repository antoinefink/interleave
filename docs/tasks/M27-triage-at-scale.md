# M27 — Triage at scale (T126–T127)

> The product ships three high-volume feeders — extension capture, URL import, and T069
> Kindle/Readwise highlight import — that can land dozens of inbox items at once, while the four
> triage verbs (Read now / Queue soon / Save for later / Delete) are strictly per-item: no
> multi-select exists anywhere in `apps/web/src/pages/inbox/` (T099's bulk ops are
> maintenance-side sweeps over old material, not the inbox). And priority — the input every
> downstream protection keys off (auto-sort, auto-postpone victim order, retention bands) — is
> the least-informed decision in the system: set cold, per item, at the moment the user knows
> the material least, while embeddings (T087/T088), per-source yield history (T083), and
> source-reliability metadata (T091) sit unwired at the intake boundary. Ideation survivor #9
> (b + c; #9a "parked" landed as T101).
>
> **Shared context for every task in this file.** Read
> `docs/solutions/workflow-issues/inbox-triage-queue-soon-attention-scheduling.md` (the verb
> set, "each surface answers exactly one question", "eligible now" never means "force to top")
> and `docs/solutions/ui-bugs/daily-work-read-model-inbox-only-routing.md` (never auto-schedule
> imports — suggestions are accept-or-override, NEVER auto-applied).
>
> **Standard gates (inherited by every task below):** `pnpm lint` · `pnpm typecheck` ·
> `pnpm test` · relevant `pnpm e2e`; persistence survives restart; mutations transactional +
> op-logged with single-batch undo; no unrelated refactors.
>
> **File/line references** verified 2026-06-09/10; re-verify with grep before editing.

---

# T126 — Bulk inbox triage

- **Milestone:** M27 — Triage at scale
- **Status:** `[x]` done — 2026-06-15, plan `docs/plans/2026-06-14-003-feat-t126-bulk-inbox-triage-plan.md`, commits `feat: T126 U1..U7` + `fix(review): T126 …`
- **Depends on:** T012, T069, T099
- **Roadmap line:** the inbox supports multi-select and group-by (origin/domain/type) with
  keyboard-driven verbs + priority applied to a selection as one batched, op-logged operation
  with single undo — a 50-item morning is triageable in a few sweeps.

## Goal

Capture throughput exceeds triage throughput by an order of magnitude; this closes the gap.
Group the morning's arrivals by where they came from, sweep a selection with one verb + one
priority, undo the whole sweep if it was wrong.

## Context to load first

- Existing code: `apps/web/src/pages/inbox/` (InboxScreen + import modals — the per-item verb
  wiring to extend), the triage command paths in `db-service`/`QueueActionService`-adjacent
  services (find the four verbs' write paths; bulk wraps THEM, not new logic), the auto-postpone
  `batchId` pattern (one batch, one undo), T099 bulk-op plumbing (maintenance precedent for
  batched commands), keyboard/scope machinery (`apps/web/src/shell/shortcuts.ts`, T048).
- Invariants: bulk = the same per-item commands executed in one transaction with one `batchId`
  and preimages — never a new mutation shape; T101's parked semantics for Save-for-later;
  selection is renderer state, the batch boundary is main-side.

## Deliverables

- [x] Inbox multi-select (click/shift/keyboard) + select-group affordances; group-by header rows
      for origin (extension / URL / highlight-import / manual / file / Other), domain, and type.
      Origin is now a persisted, queryable `sources.captured_via` column (additive migration 0040,
      written at every import seam).
- [x] Bulk action panel: the four triage verbs + priority chips applied to the selection as ONE
      transactional, op-logged batch (single undo restores all preimages); ineligible/stale ids are
      skip-and-classified without aborting, and a genuine write error aborts atomically with a
      distinct `errored` channel (partial-success surfaced honestly). Priority chips arm-then-apply
      so "queue this group at B" is one combined batch / one undo (AE-2).
- [x] Keyboard path: cursor move (j/k/arrows), range-extend, select-rest-of-group, select-all,
      verb keys (1/2/3/6), priority-band arming (a/b/c/d), Esc — a mixed-origin morning is
      triageable without the mouse; routed through the `triage` scope so global `+`/`-`/`o` defer.
- [x] Tests: service-level batch tests (atomicity, all four skip reasons, errored channel, undo
      symmetry for every verb + refuse-on-moved-victim); renderer selection/grouping/undo tests;
      e2e (`tests/electron/inbox-bulk-triage.spec.ts`) — seed ~27 mixed-origin items, group,
      bulk-queue one group at priority B in one sweep, bulk-park another, single undo restores,
      restart-safe, op-log carries one batchId/sweep, lineage intact.

## Done when

- A 50-item inbox is dispatchable in a few keyboard sweeps; every sweep is one undoable batch;
  groups reflect real origin metadata; nothing about per-item triage regresses.
- Standard gates pass.

## Notes / risks

- Origin metadata: verify capture/import paths actually persist a queryable origin (extension
  vs URL vs highlight import); if any path doesn't, add it here — group-by depends on it.

---

# T127 — Suggested priority & placement

- **Milestone:** M27 — Triage at scale
- **Status:** `[x]` done — 2026-06-15, plan
  [`docs/plans/2026-06-15-001-feat-t127-suggested-priority-placement-plan.md`](../plans/2026-06-15-001-feat-t127-suggested-priority-placement-plan.md),
  commit `feat: T127 suggested priority & placement`. Learnings:
  [`docs/solutions/architecture-patterns/advisory-suggestion-engine-patterns.md`](../solutions/architecture-patterns/advisory-suggestion-engine-patterns.md).
- **Depends on:** T083, T087, T088, T091
- **Roadmap line:** inbox items show a suggested band + topic placement chip with a one-line
  justification computed from existing signals (semantic neighbors, per-source yield history,
  source reliability) — accept-or-override, never auto-applied, deterministic-heuristic first.

## Goal

Priority stops being a cold guess: each inbox item arrives with a suggested band and topic
placement, justified in one line ("near your high-yield 'distributed systems' cluster; this
author's last 3 sources averaged 11 cards") — the user confirms or corrects instead of deciding
from nothing. Better entry priorities make every downstream protection rule (M16/M24) optimize
something real.

## Context to load first

- Existing code: T087 local embeddings + T088 related-item/neighbor queries (the semantic
  signal), T083 per-source yield rollup (aggregate by author/site for the yield signal — check
  what source metadata supports the join), T091 source-reliability metadata, the priority chip
  groups in inbox/import surfaces (`ImportFileModal.tsx` etc. — where the suggestion renders),
  M18's grounding discipline (suggestions must cite their inputs).
- Invariants: NEVER auto-applied — the user's explicit chip pick (or accept keystroke) writes
  priority; deterministic heuristic only in this task (an AI refinement can come later through
  M18 patterns — out of scope); suggestion computation is main-side behind typed IPC; thin
  signals degrade to no suggestion, not a confident-looking guess.

## Deliverables

- [x] `TriageSuggestionQuery` in `packages/local-db`: per inbox item — suggested band + optional
      topic/concept placement + a structured justification (signal kinds + values), computed
      from semantic-neighbor priorities/yields, author/site yield history, and reliability
      metadata; explicit `insufficient_signal` result when inputs are thin. (Pure scorer in
      `packages/core/src/triage-suggestion.ts`; net-new author/domain yield rollup in
      `source-yield-query.ts`; dispersion suppression so a bimodal neighbor set never averages
      to a phantom band.)
- [x] UI: suggestion chip + one-line justification on inbox rows and import modals;
      accept = one keystroke (Enter, writes priority via the existing command), override = pick
      another chip; bulk-accept for a selection composes with T126 (`inbox:bulkApplySuggestions`,
      per-item bands under one `batchId`, `no_suggestion` skip). Import-modal coverage is the
      URL + manual modals; `ImportFileModal` has no intake metadata and is intentionally not wired.
- [x] Suggestion provenance: accepted suggestions logged distinguishably via an `OpContext.extras`
      marker on the existing `update_element` op (accepted vs overridden, suggested/final band,
      signal kinds + hash) so future tuning can measure acceptance vs override rates — and never
      polluting the yield signal that feeds future suggestions.
- [x] Tests: unit — seeded fixtures produce the documented suggestions and justifications;
      thin-signal/dispersed/placement-tie fixtures produce none; acceptance writes exactly the
      normal priority op (+ marker); e2e (`tests/electron/inbox-suggestions.spec.ts`) — the
      suppression law + read-only + bulk-accept skip + restart through the real app (the positive
      accept-with-provenance path is proven at the unit/component layer — see the spec header).

## Done when

- Inbox items with sufficient signal show a justified suggestion; accept/override are one
  keystroke each; nothing is ever auto-applied; thin signal shows nothing rather than guessing.
- Standard gates pass.

## Notes / risks

- Justification honesty: the one-liner must come from the structured signals (renderer formats,
  never invents). If the numbers wouldn't convince you, suppress the suggestion — automation
  bias is the failure mode (the ideation's rejection of percentile-anchoring chose THIS design
  precisely for lower ceremony + honest grounding).

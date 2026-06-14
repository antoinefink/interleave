# M26 — Lineage integrity (T123–T125)

> "Source lineage is sacred" is the product's deepest invariant — but lineage currently only
> points backward; it never pushes change forward. When a source edit marks blocks
> `stale_after_edit`, the extracts/statements/cards derived from those blocks keep circulating
> with untouched schedules (the only card staleness is T090's *calendar* expiry), so a user who
> corrects an error then reviews the superseded fact for months while FSRS faithfully
> strengthens it. And the M7 rule "edit the body only; never touch `review_states` from an
> edit" (`docs/tasks/M7-fsrs-review.md:472`) — written to protect in-flight session state —
> leaves a substantively rewritten card holding stability its OLD formulation earned, while
> T085's leech flow actively encourages such rewrites. This milestone is about the system being
> quietly *wrong*, not inefficient. External models: incremental build systems invalidate the
> transitive closure of a changed input; generational GCs re-scan mutated tenured objects.
> Ideation survivor #7.
>
> **Shared context for every task in this file.** Read
> `docs/solutions/architecture-patterns/durable-source-block-processing-state.md`
> (`stale_after_edit` semantics, content-hash reconciliation — the propagation rides this
> moment) and
> `docs/solutions/logic-errors/rich-extractions-preserve-paragraphs-and-images.md` (lineage
> anchors immutable; extract bodies rebuilt main-side).
>
> **Standard gates (inherited by every task below):** `pnpm lint` · `pnpm typecheck` ·
> `pnpm test` · relevant `pnpm e2e`; persistence survives restart; mutations transactional +
> op-logged with undo preimages; lineage anchors never mutated in place; no unrelated refactors.
>
> **File/line references** verified 2026-06-09/10; re-verify with grep before editing.

---

# T123 — Stale propagation through the lineage DAG

- **Milestone:** M26 — Lineage integrity
- **Status:** `[x]` complete — landed on `main` (see `docs/roadmap.md` T123). Learning:
  [`downward-dirty-bit-propagation-through-lineage-dag.md`](../solutions/architecture-patterns/downward-dirty-bit-propagation-through-lineage-dag.md).
- **Depends on:** T022, T090
- **Roadmap line:** when reconciliation marks source blocks `stale_after_edit`, live downstream
  outputs (extracts → statements → cards anchored to those blocks) gain a queryable
  needs-reverify flag in the same transaction; counts appear in source progress and the
  Done-intent breakdown.

## Goal

The dirty bit flows downstream: editing or reimporting a source flags every live derived
artifact whose anchor text changed, so "this might no longer match its source" becomes a
queryable fact on extracts, statements, and cards — not just on blocks nobody re-reads.

## Context to load first

- Existing code: the block reconciliation path in
  `packages/local-db/src/block-processing-service.ts` (where `stale_after_edit` is written —
  the propagation joins this transaction), `source_locations` anchors (block IDs + offsets —
  the join key from blocks to extracts), lineage relations (extract → statement → card),
  T090's `valid_until`/`review_by` fields (calendar staleness — keep distinct; this flag is
  *content* staleness), DoneIntentMenu breakdown derivation.
- Invariants: same-transaction propagation (a crash never leaves blocks flagged but descendants
  clean); flags are additive metadata — schedules, lineage, and bodies are untouched here
  (resolution is T124).

## Deliverables

- [x] Schema: `needs_reverify` + `stale_since` on `elements` (type-coupled CHECK) and a new
      `element_reverify_provenance` table; `pre_stale_hash` on `source_block_processing`. Additive
      migration `0037` (hand-edited to `ALTER ADD COLUMN` + `CREATE TABLE` to avoid the 0030
      `elements`-rebuild lineage wipe); migration test asserts column-value survival + row-count
      invariance.
- [x] Propagation: `reconcileStaleWithin` returns a `{ staled, unStaled }` transition report;
      `ReverifyPropagationRepository.propagateReverify` walks live lineage from each newly-stale
      block and maintains `needs_reverify` as a self-healing `EXISTS(provenance)` projection in the
      same `saveDocument`/OCR transaction; idempotent (`ON CONFLICT DO NOTHING` + recompute-no-op);
      un-staling clears by `(source, block)` across live + soft-deleted targets via the
      `pre_stale_hash` capture-once recognition. Op-logged with a `propagation` marker the global
      undo skips.
- [x] Read surfaces: `needsReverifyOutputs` in source progress (skipped when no block is stale),
      the DoneIntentMenu breakdown segment (pluralized), and inventory/inspector rows
      (`needsReverify` on the queue/inspector signals + an inert `ReverifyChip` + inspector
      advisory).
- [x] Tests: unit (`reverify-propagation-repository.test.ts`) — flag exactly live descendants,
      dead/soft-deleted ignored, idempotence, un-stale clears, multi-block, self-heal,
      block_missing, malformed anchor, undo-skip, transaction rollback; migration test; renderer
      tests (breakdown, chip, inspector, QueueScreen integration); e2e
      (`tests/electron/reverify-propagation.spec.ts`) — edit source → derived card flagged →
      restart-safe → restore clears.

## Done when

- Editing a source flags exactly the affected live downstream artifacts, atomically, visibly in
  source progress and the Done-intent breakdown, reversibly when content is restored.
- Standard gates pass.

## Notes / risks

- Large reimports flag many artifacts at once — that is correct; the per-session cap lives in
  T124's workflow, not here. Just make the counts honest.

---

# T124 — Re-verify workflow

- **Milestone:** M26 — Lineage integrity
- **Status:** `[x]` complete — landed on `main` (see `docs/roadmap.md` T124). Learning:
  [`docs/solutions/architecture-patterns/detach-tombstone-receipt-only-undo-and-per-triple-fingerprint-for-flag-resolution.md`](../solutions/architecture-patterns/detach-tombstone-receipt-only-undo-and-per-triple-fingerprint-for-flag-resolution.md).
  Implemented as: `element_detach_snapshot` table (additive migration `0038`) + a
  `ReverifyResolutionRepository`/`ReverifyResolutionService` drain (confirm/rebase/detach,
  per-source session preview with a per-`(element,source,block)`-triple revalidation fingerprint,
  receipt-scoped four-part-guard undo), the detach snapshot doubling as a re-flag tombstone in
  `ReverifyPropagationRepository` (applied to descendants too), receipt-only global-undo deferral in
  `UndoService`, a typed `reverify.*` IPC surface, and a `/maintenance/reverify` keyboard-first
  drain screen + actionable `ReverifyChip`. Card schedules are left untouched (the T125 seam is
  noted in code). Verified by `pnpm lint`/`typecheck`/`test` (4081) and
  `pnpm e2e tests/electron/reverify-workflow.spec.ts tests/electron/reverify-propagation.spec.ts`.
- **Depends on:** T123
- **Roadmap line:** flagged items resolve as confirm / rebase / detach (rebase re-anchors to
  current text, hash-diff assisted; detach freezes a provenance snapshot), batched per source,
  capped per session, op-logged and undoable; resolving clears the flag everywhere.

## Goal

A cheap pass that drains the re-verify queue: confirm (drift immaterial — most cases, one
keystroke), rebase (re-anchor/update from the corrected text), or detach (keep standalone with
provenance frozen at the old snapshot). Derived knowledge converges back to consistency with
its sources.

## Context to load first

- Existing code: T123 flags + provenance; anchor re-resolution machinery (content-hash
  reconciliation has the diff primitives — reuse for the "what changed" display and rebase
  assist); maintenance hub patterns (host surface); extract-body rebuild rules (rebase of an
  extract re-derives main-side, fail-closed).
- Invariants: per-source batching (review a source's flagged outputs together with the old→new
  text diff shown once); session caps (never a wall of 400 confirmations — cap and resume);
  each resolution op-logged with undo; detach writes an explicit frozen-provenance marker
  (lineage is never silently severed).

## Deliverables

- [ ] Re-verify surface (maintenance section + entry from source page/Done-intent breakdown):
      grouped by source, old→new anchor text diff shown, per-item confirm / rebase / detach;
      bulk-confirm for a selection; one `batchId` per sitting.
- [ ] Resolution semantics: confirm clears the flag; rebase re-anchors (and for extracts,
      re-derives the body main-side) then clears; detach freezes provenance (marker + snapshot
      reference) and clears; all undoable.
- [ ] Card schedule interplay: resolving a card's flag does NOT change its schedule here —
      unless the resolution materially rewrites the card body, in which case route through
      T125's write barrier (dep note: if T125 is unbuilt, leave the schedule untouched and note
      it).
- [ ] Tests: unit per resolution (flag cleared, lineage state correct, undo symmetric); e2e —
      edit source, open re-verify, walk all three resolutions, restart-safe.

## Done when

- A flagged backlog drains in batched, capped sittings; each resolution does what it says,
  clears the flag everywhere it showed, and is undoable.
- Standard gates pass.

## Notes / risks

- UX tone: confirm must be nearly free (enter-enter-enter through immaterial drift) or users
  will ignore the queue and the flags become noise.

---

# T125 — Card-edit write barrier

- **Milestone:** M26 — Lineage integrity
- **Status:** `[ ]` not started
- **Depends on:** T038, T080
- **Roadmap line:** a substantive card edit offers keep-schedule vs re-stabilize (demote to a
  short confirmation interval); the choice + edit linkage land on review logs so T080
  optimization can exclude pre-edit history; in-flight review state stays uncorrupted.

## Goal

A rewritten card stops inheriting the stability its old formulation earned. Typo fixes keep
their schedule; substantive rewrites re-stabilize on a short confirmation interval — so the
next encounter verifies the NEW formulation instead of surfacing in nine months and failing as
"user error". Review history gains the edit linkage that keeps FSRS optimization honest.

## Context to load first

- Existing code: `CardEditService` (T038 — body edits via `update_element`, the "never touch
  `review_states` from an edit" rule and its original intent: protecting IN-FLIGHT session
  state), T085 leech remediation (routes users to rewrites — the biggest caller), FSRS
  rescheduling paths in `SchedulerService`/`card-scheduler` (what "demote to confirmation
  interval" means mechanically — e.g., a rating-free reschedule to a short due with stability
  reduction; decide against ts-fsrs semantics and document), `review_logs` shape (add the edit
  marker), T080 optimizer input filtering.
- Invariants: mid-review in-flight state stays uncorrupted (the demotion applies to the
  persisted state, never the in-session snapshot — honor the M7 rule's real intent); the choice
  is the user's (heuristic only pre-selects); everything op-logged with preimages (undo of a
  re-stabilize restores the prior FSRS state exactly — preimage discipline from the
  queue-eligibility solutions doc).

## Deliverables

- [ ] Substantive-edit heuristic in `packages/core` (pure): normalized diff on the
      answer-bearing side (answer text / cloze answers) above a threshold → "substantive";
      prompt-only and small edits → "typo". Table-tested.
- [ ] Edit flow: on save, typo-class edits behave as today; substantive-class edits surface a
      compact choice — keep schedule / re-verify soon (default per heuristic, one keystroke to
      flip) — applying the demotion transactionally with the body edit.
- [ ] Demotion semantics: a documented short-interval re-stabilization (FSRS state adjusted via
      the scheduler service, not raw field pokes); preimage logged.
- [ ] Review-log linkage: an edit marker (timestamp + class + choice) so T080 optimization
      excludes pre-edit grades for that card (wire the exclusion into the optimizer input
      query).
- [ ] Callers: card edit surfaces (T038 repair bar, extract-workspace card editing, T085 leech
      rewrites) all route through the barrier — grep every body-edit path.
- [ ] Tests: heuristic table-tests; service tests (demotion + undo restores exact FSRS
      preimage; in-flight session unaffected); optimizer exclusion test; e2e — rewrite a leech
      card via T085, choose re-verify, card surfaces soon instead of months out, restart-safe.

## Done when

- A substantive rewrite offers (and defaults sensibly to) re-stabilization; a typo edit changes
  nothing; review history carries the edit linkage and the optimizer excludes contaminated
  grades; undo restores the exact prior scheduling state.
- Standard gates pass.

## Notes / risks

- This deliberately amends a written M7 rule — update `docs/tasks/M7-fsrs-review.md` (and any
  doc repeating the rule) to state the refined invariant: "an edit never corrupts *in-flight*
  review state; substantive edits re-stabilize the *persisted* state through the scheduler
  service." Keep the history honest about why.

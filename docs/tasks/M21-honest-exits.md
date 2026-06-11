# M21 — Honest exits & the value model (T101–T104)

> Part III opener: two near-bug trust fixes (a triage verb that silently abandons, a computed
> retirement signal that is never shown) plus the value-model correction every later yield-keyed
> behavior depends on. Source analysis:
> [`../ideation/2026-06-09-gold-standard-incremental-reading-ideation.md`](../ideation/2026-06-09-gold-standard-incremental-reading-ideation.md)
> (survivors #9a, #1 first slice, and the binding value-model constraint).
>
> **Shared context for every task in this file.** Read
> `docs/solutions/workflow-issues/inbox-triage-queue-soon-attention-scheduling.md` (each surface
> answers exactly one question; the four triage verbs),
> `docs/solutions/design-patterns/non-modal-intent-menu-replacing-confirm-gate.md` (the
> DoneIntentMenu house pattern: intent collection, honest breakdowns, server-authoritative gate,
> in-flight guard gotcha), and
> `docs/solutions/logic-errors/queue-eligibility-inventory-scheduler-state.md` (backend-canonical
> eligibility, transactional schedule clears, undo preimages).
>
> **Standard gates (inherited by every task below, in addition to its own Done-when):**
> `pnpm lint` · `pnpm typecheck` · `pnpm test` · relevant `pnpm e2e`; persistence survives app
> restart; multi-table mutations are transactional; source lineage preserved; `operation_log`
> entries written; no unrelated refactors.
>
> **File/line references** were verified 2026-06-09/10 (around commit `e284cebf`). Re-verify with
> grep before editing — code moves.

---

# T101 — "Save for later" becomes parked, not dismissed

- **Milestone:** M21 — Honest exits & the value model
- **Status:** `[x]` done
- **Depends on:** T012, T044
- **Commit:** `feat: T101 parked save-for-later state`
- **Roadmap line:** the inbox "Save for later" verb writes a distinct parked state; parked items
  are visible/filterable in the library with their parked date, still excluded from
  inbox/queue/daily-work, distinguishable from dismissed in data and UI, op-logged and undoable.

## Goal

Pressing "Save for later" currently exits the pipeline forever: it is the verb users press most
under overload, and it writes the same terminal status as Abandon. After this task, "later" is a
real, first-class state — set aside deliberately, visibly, and reversibly — and the data model
can finally distinguish deferred-with-intent from abandoned.

## Context to load first

- Reference: `domain-model.md` (element status enum), `concept.md` (triage verbs).
- Existing code to inspect:
  - `apps/desktop/src/main/db-service.ts:2698-2700` — `case "keepForLater": { this.repos.elements.updateWithin(tx, id, { status: "dismissed" }); }` — the bug-shaped line this task replaces.
  - `packages/local-db/src/daily-work-query.ts:60-64` — resume routing scans `status: "active"` + `dueAt === null` only; confirm parked items stay excluded (by design) but become *queryable*.
  - `packages/core` status enums + the DB CHECK constraints (see how `JOB_STATUSES` keeps enum/DB in sync in `packages/db/src/schema/jobs.ts` — follow the same pattern).
  - Library/Collection Explorer filters (`apps/web`), Trash view (T044) for the undo pattern.
- Invariants in play: status transitions are command-shaped + op-logged; soft-delete semantics
  unchanged; "eligible now" never means "force to top".

## Deliverables

- [x] Schema/enum: a distinct parked representation — either a new element status (preferred;
      update enum + CHECK constraint via Drizzle migration) or a status-adjacent marker if a
      migration is deemed too invasive (document the choice). Record `parkedAt`.
- [x] `keepForLater` (and any other Save-for-later entry point — grep all call sites) writes the
      parked state; Abandon/dismiss paths untouched.
- [x] Library/Collection Explorer: parked filter + parked-date display; inbox/queue/daily-work
      provably still exclude parked items (tests).
- [x] Un-park verbs: re-queue (schedule), move back to inbox (undecided), or dismiss — each
      op-logged with undo preimages.
- [x] Migration note in the spec + code comment: pre-existing `dismissed` rows are conflated
      (saved vs abandoned) and are NOT retroactively reclassified; only new saves get the state.
- [x] Tests: repository/service unit tests; Playwright e2e — park from inbox, find in library,
      un-park, survives restart.

## Done when

- Pressing "Save for later" in the inbox produces an element that is (a) not `dismissed`,
  (b) visible under a library "Parked" filter with its parked date, (c) absent from inbox, queue,
  and daily-work routing, and (d) restorable to inbox or schedulable in one action with undo.
- A data-level query can count parked vs dismissed separately.
- Standard gates pass.

## Notes / risks

- Adding a status value touches every exhaustive status switch — let the compiler find them
  (`pnpm typecheck` is the map); do not leave a default-case swallow.
- Decide and document whether DoneIntentMenu's "Return later" intent should also use parked
  semantics for sources exiting the reader (likely yes — but keep that as a follow-up note for
  T102/T110 rather than scope-creeping this task).

## Completion notes

- Implemented `status = "parked"` plus nullable `elements.parked_at` via migration `0030`.
  Existing `dismissed` rows stay dismissed with `parked_at = NULL`; only new Save-for-later
  actions are parked.
- `keepForLater` now parks and clears `due_at`; Library exposes a Parked facet, parked-date
  display, and actions to move to Inbox, queue soon, or dismiss.
- Parked rows are excluded from Inbox, Queue, Daily Work, and Workload baselines while remaining
  countable separately from dismissed rows.
- Verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm e2e tests/electron/parked-save-for-later.spec.ts`.

---

# T102 — Parked resurfacing sweep

- **Milestone:** M21 — Honest exits & the value model
- **Status:** `[x]` done
- **Depends on:** T101
- **Roadmap line:** parked items resurface on a schedule (default ~90 days) in a calm review
  surface offering keep-parked / schedule / let-go per item, with bulk apply and single-batch
  undo.

## Goal

Parking is only honest if parked things come back. A periodic, low-pressure sweep walks parked
items past their resurface date through keep / schedule / let-go — closing the deferral loop
that Polar-style tools leave open (material drifting out silently).

## Context to load first

- Existing code to inspect: T101's parked state + `parkedAt`; the maintenance hub surfaces
  (M17/M20 — `apps/web/src/maintenance/`); auto-postpone's `batchId` batch-undo pattern
  (`docs/tasks/M16-sort-overload.md`, T077 apply path); settings plumbing in
  `packages/core/src/settings.ts` for the resurface-after default.
- Invariants: advisory surfaces route from actually-actionable counts and are durably
  dismissible (`docs/solutions/ui-bugs/balance-banner-queue-inbox-action-gating.md`); never
  auto-schedule on the user's behalf — the sweep *asks*.

## Deliverables

- [x] Read model: parked items past `parkedAt + resurfaceAfter` (setting, default 90d), with
      age and origin context.
- [x] Sweep surface (maintenance section now; T110 will also host it): per-item
      keep-parked (resets the clock) / schedule (sets priority + enters scheduling) /
      let-go (dismiss), with multi-select bulk apply, one `batchId`, single undo.
- [x] A quiet entry-point indicator (badge/count) when items are due for resurfacing — no modal,
      no nag.
- [x] Tests: unit for the read model boundary math; e2e — park, time-travel past the window
      (fixture clock), sweep all three verbs, undo restores.

## Done when

- An item parked 90+ days ago appears in the sweep; each verb does what it says; a bulk sweep is
  one undoable operation; nothing resurfaces before its window.

## Completion notes

- Added `parkedResurfaceAfterDays` to typed app settings (default `90`, clamped `1..3650`) and
  surfaced it in Settings.
- Added `ParkedResurfacingQuery` and `ParkedResurfacingService` in `packages/local-db`: due reads
  are read-only UTC-duration checks; apply revalidates stale ids, writes existing `update_element`
  ops under one `batchId`, and skips missing/deleted/non-source/non-parked/not-due rows.
- Extended the trusted maintenance surface with `maintenance.parkedResurfacing`,
  `maintenance.parkedResurfacingApply`, and `parkedResurfacingCount`.
- Added a Maintenance card with per-row Keep / Queue / Let go decisions and single batch apply.
- Coverage: local-db boundary/undo tests, settings/contract/preload/appApi tests,
  `MaintenanceScreen.test.tsx`, and `tests/electron/maintenance.spec.ts`.
- Standard gates pass.

## Notes / risks

- Read-clock discipline: compute "due for resurfacing" main-side with the same clock source the
  queue uses (see queue-eligibility solutions doc) — no renderer date math.

---

# T103 — Proactive Done: surface `retirementSuggestion`

- **Milestone:** M21 — Honest exits & the value model
- **Status:** `[x]` complete
- **Depends on:** T028, T083
- **Roadmap line:** the scheduler's already-computed `retirementSuggestion` surfaces as a calm
  nudge on queue rows and in the reader — one tap into the existing DoneIntentMenu with
  Finished/Abandon prefilled — server-authoritative, dismissible, dismissals remembered.

## Goal

The scheduler already knows when a source looks finished or dead — it computes
`retirementSuggestion`, threads it through `SchedulerService`, and the UI throws it away. After
this task the system proposes the terminal action ("96% processed, 14 extracts — mark
Finished?" / "cycled 4× with nothing extracted — Abandon?") one tap from the existing intent
surface. Cheapest loop-closure in Part III: the signal pipeline exists end-to-end minus the
last hop.

## Context to load first

- Existing code to inspect:
  - `packages/scheduler/src/attention-scheduler.ts` — `adjustForSourceProcessing` sets
    `retirementSuggestion: true` when a source is dead (≥90% terminal blocks, zero extracted
    output, ≥50% ignored).
  - `packages/local-db/src/scheduler-service.ts:190,265` — the flag is carried through results.
  - `grep -rn retirementSuggestion apps/web/src` → currently zero hits (the gap).
  - The DoneIntentMenu (`apps/web` — shared across ProcessQueue, QueueScreen, SourceReader;
    commits `a17c24ff`/`b50a046e`) and its solutions doc — note the in-flight-guard gotcha
    (reset guards on the host's `busy` settling, not popover open/close).
- Invariants: the Done gate stays server-authoritative (renderer passes an override flag only);
  nudges are advisory — never auto-complete; agent-native parity comes free if the gate stays
  domain-side.

## Deliverables

- [x] Thread `retirementSuggestion` into queue-row data and the reader header via existing typed
      read paths. The "looks finished" sibling was deferred because T103's existing scheduler
      signal is the load-bearing scope; productive-output scoring belongs with T104.
- [x] Nudge UI: quiet queue-row and reader affordances open the shared DoneIntentMenu with
      Abandon marked as suggested while keeping Return later as the safe focused action.
- [x] Dismissal memory: per-source dismissal is keyed by the current retirement signal hash, is
      persisted in SQLite, and is rechecked server-side before writes.
- [x] Tests: scheduler helper/hash, repository dismissal/oplog, queue and inspector read models,
      IPC/preload/web API, renderer nudges, async stale guards, and Electron restart persistence.

## Done when

- A source meeting the deadness thresholds shows the nudge in queue and reader; accepting it
  routes through the existing DoneIntentMenu (same ops, same gate); dismissing it is remembered;
  sources below thresholds never show it.
- Standard gates pass.

## Completion

- Commit: T103 final implementation commit.
- Verification:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm e2e tests/electron/done-intent.spec.ts`
- Downstream notes:
  - Dismissal is intentionally advisory state logged as `update_element`; it is not a separate
    undoable source lifecycle action.
  - Future yield-keyed "looks finished with output" behavior should wait for T104's value-model
    expansion rather than extending the T103 abandon-only heuristic.

## Notes / risks

- Do NOT add a second Done path — this is a shortcut into the existing one. If the menu needs a
  "suggested" visual state, extend it; do not fork it.
- Thresholds live in the scheduler (domain), not the renderer.

---

# T104 — Value model v2: honorable non-card fates

- **Milestone:** M21 — Honest exits & the value model
- **Status:** `[x]` complete
- **Depends on:** T024, T084, T095
- **Commit:** `feat: T104 value model v2`
- **Roadmap line:** extracts can terminate as reference / synthesized / done-without-card;
  `synthesis_note` lineage counts as productive output in source-yield; stagnation detector,
  T084 suggestions, and analytics respect the new fates. Prerequisite for T112 and T121.

## Goal

The system's value function currently says cards-or-failure: `source-yield.ts` rewards
"mature cards (most), then cards, then extracts", and stagnation remediation offers only
rewrite/convert/postpone/delete. Yet T095 shipped synthesis notes as a real second output
channel — invisible to yield. After this task an extract can end honorably without becoming a
card, synthesis counts as production, and every downstream consumer (stagnation, yield,
analytics — and later the T112 multiplier and T121 aging) scores reality instead of punishing
legitimate synthesis-driven reading. This task BLOCKS T112 and T121 by design.

## Context to load first

- Existing code to inspect:
  - `packages/core/src/source-yield.ts` (~lines 29-31) — the reward comment/weights to revise.
  - `packages/scheduler/src/stagnation.ts:16-22` — extract-scoped stagnation heuristic.
  - T084 surfaces (`docs/tasks/M17-analytics.md` — "labels, not actions"; the suggestion verb
    set) and T095 synthesis-note linkage (which relation/lineage rows record
    extract→synthesis_note membership — inspect before designing the yield join).
  - Extract stage/status machinery in `packages/local-db/src/extraction-service.ts` and the
    extract terminal actions in `ExtractView`.
- Invariants: stage ladder semantics unchanged for extracts that *are* heading to cards;
  lineage is the source of truth for "synthesized" (an extract is synthesized because a live
  synthesis note links it, with an explicit user action — not by inference alone).

## Deliverables

- [x] Domain: extract terminal fates — `reference` (keep as quotable material, no further
      distillation pressure), `synthesized` (fed a synthesis note), `done_without_card`
      (processed, nothing more to produce) — as explicit states/stage-exits, each op-logged,
      reversible, distinct from delete. Drizzle migration if a new column/value is needed.
- [x] Verbs: ExtractView + queue actions + T084 suggestion set gain the new fates (T084's
      remediation becomes rewrite / convert / **keep-as-reference** / **mark-synthesized** /
      postpone / delete).
- [x] `source-yield.ts` v2: synthesis-note lineage and honorable fates count as productive
      output (weights documented in-code); yield consumers recompute correctly.
- [x] Stagnation detector: extracts in honorable fates are not stagnant; tests prove a
      synthesized extract stops being flagged.
- [x] Analytics: source-yield and extract-stagnation surfaces display the new categories.
- [x] Tests: unit across core/scheduler/local-db; e2e — mark an extract reference/synthesized,
      verify it leaves stagnation and counts in yield, survives restart.

## Done when

- An extract can exit to each of the three fates and back; a source whose extracts fed a
  synthesis note scores as productive in yield; stagnation no longer flags honorably-terminal
  extracts; the fates appear in analytics.
- Standard gates pass.

## Notes / risks

- Weighting question (decide in-code, document): does `synthesized` weigh like a card or like
  an extract? Recommendation: between the two — the point is non-zero, not equivalence.
- Keep fate-entry cheap to undo: users will mis-file; everything reverses through the op log.

## Completion

- Added nullable `elements.extract_fate` with the closed `reference` / `synthesized` /
  `done_without_card` vocabulary and an extract-only CHECK constraint.
- Added typed extract fate commands through local-db, DB service, IPC, preload, and renderer APIs.
  Direct commands set only `reference` and `done_without_card`; `synthesized` is maintained by
  live synthesis-note `references` lineage.
- Source-yield v2 now counts de-duplicated productive non-card output, including fated extracts,
  live synthesis-referenced extracts, and synthesis notes per represented source.
- Stagnation v2 excludes honorable fates and live synthesis references, and the maintenance UI can
  keep a stagnant extract as reference or show the synthesized remediation label.
- Card creation rejects fated extracts until they are reactivated, preventing `done_without_card`
  or `reference` output from being double-counted with live cards.
- Verification:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm e2e -- tests/electron/extract-review.spec.ts tests/electron/source-yield.spec.ts tests/electron/extract-stagnation.spec.ts`

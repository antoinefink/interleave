# M22 — Receipts: priority integrity & knowledge maturity (T105–T110)

> The accountability layer. M16 built mechanisms that silently sacrifice work (auto-postpone,
> geometric postpone recession to a 180-day ceiling); the pipeline's terminal stage ("Mature
> knowledge") has no definition, metric, or screen. M22 builds the read models and the one
> weekly ritual that make both visible. Everything here is a read model over durable facts —
> `review_logs` (captured at the grading write path), `operation_log`, block-processing rows —
> per the house pattern: NO parallel analytics tables, NO renderer aggregation. M22 deliberately
> precedes M23/M24: automation rides on receipts. Source analysis: ideation survivors #3 and #4.
>
> **Shared context for every task in this file.** Read
> `docs/solutions/architecture-patterns/review-analytics-data-capture-in-review-logs.md` and
> `docs/solutions/architecture-patterns/review-activity-heatmap-read-model.md` (the read-model
> precedents), plus `docs/scheduling-and-priority.md`. Key verified facts:
> `postponeIntervalForPriority` grows intervals by `(1 + 0.5 × postponeCount)` toward
> `POSTPONE_CEILING_DAYS = 180` with zero surfacing; postpone provenance is durably captured
> (`reschedule_element` ops, auto-postpone `batchId`, `schedulerSignals.postponed`) and never
> aggregated; `docs/test-battle-audit.md:58-59` flags "repeated postpones and starvation
> detection" as untested; `AnalyticsScreen.tsx:15-16` still defers concept-level retention; T079
> stores per-concept targets nothing reads back.
>
> **Standard gates (inherited by every task below):** `pnpm lint` · `pnpm typecheck` ·
> `pnpm test` · relevant `pnpm e2e`; persistence survives restart; read models behind typed IPC;
> mutations transactional + op-logged; no unrelated refactors.
>
> **File/line references** verified 2026-06-09/10; re-verify with grep before editing.

---

# T105 — Priority-integrity read model

- **Milestone:** M22 — Receipts
- **Status:** `[x]` complete
- **Depends on:** T045, T077
- **Roadmap line:** a typed read model reports, per band and per topic: due attention serviced
  vs deferred over a window, cumulative postpone debt, and band-share inflation — computed from
  `review_logs` + operation-log facts, surfaced in analytics.

## Goal

Answer "did executed attention match declared priorities?" — the SuperMemo "Priorities missed"
analog. The user can finally distinguish "the system is protecting my A-items" from "the system
is quietly losing my library", and priority inflation becomes measurable instead of invisible.

## Context to load first

- Existing code: `packages/scheduler/src/attention-scheduler.ts` (recession math, descriptor
  comment "read from `reschedule_element` ops"); the T077 apply path's `batchId`; analytics
  read-model wiring (`packages/local-db` analytics queries → `contract.ts` → `appApi.ts` →
  `apps/web/src/analytics/`).
- Invariants: read model only — this task mutates nothing.

## Deliverables

- [x] `PriorityIntegrityQuery` in `packages/local-db`: per band (and per topic where linkable):
      due-days serviced vs deferred over a rolling window, postpone debt (items × cumulative
      recession), band share of the live collection with an inflation threshold (e.g. warn when
      A > 35–40%), and a "sacrificed recently" list (most-postponed items, with counts).
- [x] Typed IPC surface (`channels.ts`/`contract.ts`/`ipc.ts`/preload/`appApi.ts`) + an
      analytics panel ("Priority integrity") rendering it calmly — numbers and a short list, not
      a dashboard wall.
- [x] A quiet queue-header indicator when fidelity degrades past thresholds (durably dismissible
      per the balance-banner precedent).
- [x] Tests: unit with seeded op-log/review-log fixtures proving the math (serviced vs deferred,
      debt accumulation, inflation trigger); contract tests.

## Completion notes

- Implemented `PriorityIntegrityQuery` as a read-only local-db model over `operation_log`,
  `review_logs`, live `elements`, and `cards.is_retired`; it uses current priority attribution,
  suppresses strong A-band defer warnings when an in-window priority edit occurred, and ignores
  deferred markers for ineligible/not-yet-due rows.
- Added the typed `analytics.priorityIntegrity` IPC/preload surface and renderer wrapper.
- Added the Analytics "Priority integrity" panel and a quiet Queue warning driven only by backend
  threshold flags; queue dismissal is persisted under `ui.noticeDismissals.priorityIntegrity.queue`.
- Verification before landing: focused `priority-integrity-query`, `AnalyticsScreen`, and
  `QueueScreen` tests; full standard gates recorded in the roadmap entry.
- Reusable implementation learning captured in
  [`docs/solutions/architecture-patterns/priority-integrity-read-model.md`](../solutions/architecture-patterns/priority-integrity-read-model.md).

## Done when

- [x] With a fixture collection containing postponed A/B/C material, the read model reports
  serviced/deferred shares per band, debt, and an inflation warning exactly as seeded; the
  analytics panel renders it; nothing mutates.
- [x] Standard gates pass.

## Notes / risks

- Window semantics: use the local-calendar conventions from the heatmap read model
  (local-day boundaries, not UTC).
- Keep "missed" honest: an item is missed only if it was *due and eligible* and was deferred —
  reuse `QueueQuery` eligibility semantics, do not re-derive.

---

# T106 — Chronic-postpone reckoning

- **Milestone:** M22 — Receipts
- **Status:** `[x]` completed in this commit
- **Depends on:** T105
- **Roadmap line:** items postponed ≥N times surface in a decision surface forcing keep /
  demote / done / delete per item — no further silent recession past the threshold — batched,
  undoable, op-logged, with drift-diagnostic cases.

## Goal

The GTD-style forced reckoning: past a postpone threshold, recession stops being silent and the
user makes one explicit call per item. Converts the 180-day-ceiling oblivion path into a
decision point.

## Context to load first

- Existing code: T105's read model (the chronic list is a view over it); queue-action service
  verbs (postpone/done/dismiss/delete with undo preimages); the maintenance drift diagnostic
  (add cases); `stagnation.ts` (extract-only — this task covers sources/topics/cards too).
- Invariants: forced means *surfaced and sticky*, not modal-blocking — the user can leave; the
  item just stays in the reckoning list and does not silently recede further.

## Deliverables

- [x] Chronic detection: `postponeCount >= N` (setting, default ~5) → item enters the reckoning
      list; while listed, automatic recession growth pauses (document the rule in-scheduler).
- [x] Reckoning surface (maintenance section now; T110 hosts it weekly): per-item
      keep (resets count, returns to normal scheduling) / demote (band down) / done / delete —
      multi-select, one `batchId`, single undo, op-logged.
- [x] Drift diagnostic: new cases (recession paused while listed; count reset on keep).
- [x] Tests: unit (threshold entry, recession pause, verb effects incl. undo symmetry); e2e —
      fixture with a 6×-postponed item, walk all four verbs.

## Done when

- A ≥N-postponed item appears in the reckoning list and stops receding; each verb works and is
  undoable in batch; the drift diagnostic covers the new states.
- Standard gates pass.

## Completion notes

- Effective postpone counts fold `operation_log` postpones, chronic reset markers, and reset-undo
  markers without adding a mutable counter column.
- Maintenance now exposes a typed chronic-postpone report and one-batch keep / demote / done /
  delete apply command through desktop IPC and the renderer panel.
- Non-task attention postpones pause interval growth at the threshold while still logging future
  postpone markers; extract stagnation and scheduler consistency use the effective reset-aware
  count.
- Verification: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm e2e tests/electron/maintenance.spec.ts`.
- Learning captured in
  `docs/solutions/architecture-patterns/chronic-postpone-reckoning-from-operation-log-reset-markers.md`.

## Notes / risks

- Undo-of-undo symmetry: log preimages for the count reset too (see queue-eligibility solutions
  doc — "every undo that restores FSRS due must log the preimage"; same discipline here).

---

# T107 — Fallow: deliberate topic rest

- **Milestone:** M22 — Receipts
- **Status:** `[x]` completed in this commit
- **Depends on:** T105
- **Roadmap line:** a topic can be rested to a chosen return date — distinct from postpone (no
  recession growth, excluded from missed-priority accounting) and from abandon (it provably
  returns) — visible, reversible, op-logged.

## Goal

Today neglecting a topic is either accidental (starvation) or terminal (abandon). Fallowing
makes rest a deliberate, scheduled act: "not now, all of it, back on March 1" — managed land,
not abandoned land. It also keeps T105's ledger honest: fallowed work is not "missed".

## Context to load first

- Existing code: vacation/catch-up modes (T078 — the collection-wide analog; this is per-topic);
  topic/concept element handling; T105's accounting (fallow exclusion).
- Invariants: fallow is attention-scheduler-only — `review_states` (FSRS cards) are NOT touched;
  decide and document whether descendant cards keep reviewing (recommended: yes — memory decays
  during rest; only *attention* work rests). State this in the UI copy.

## Deliverables

- [x] Domain: fallow state on a topic with `fallowUntil` + reason; entering it reschedules the
      topic's attention-scheduled descendants past the date in one transaction (op-logged,
      undoable); exiting (manually or on date) restores normal cadence.
- [x] T105 integration: fallowed items excluded from missed/deferred accounting, listed in their
      own ledger line ("resting: 2 topics, back 2026-03-01").
- [x] UI: fallow/unfallow verbs on the topic (and from the reckoning surface as a fifth option
      where the item is a topic), visible state on topic pages and queue inventory
      (`notInQueueReason: "fallow"` per the backend-canonical-eligibility pattern).
- [x] Tests: unit (transactional reschedule + restore, accounting exclusion); e2e — fallow a
      topic, queue empties of it, returns on date, cards kept reviewing throughout.

## Done when

- Fallowing a topic removes its attention work until the chosen date with one undoable
  operation, shows everywhere as deliberate rest, never touches card review states, and returns
  on schedule.
- Standard gates pass.

## Notes / risks

- Eligibility surface: every row hidden by fallow must carry the reason — no read-side filter
  hiding without explanation (the queue-eligibility lesson).

## Completion notes

- Added nullable fallow fields to `elements` and the core `Element` model, plus migration coverage
  for upgraded databases.
- Added `FallowService` as the transactional owner of topic rest. It reschedules the topic and
  eligible attention descendants, leaves descendant FSRS `review_states` untouched, records
  command-shaped fallow operations, and supports undo/direct clear-rest semantics.
- Scoped unfallow restoration by both topic id and fallow batch, preserving original pre-rest
  schedules across refallow and skipping descendants with newer manual schedule intent.
- Added typed `topics.fallow` / `topics.unfallow` IPC, preload, and renderer API surfaces with
  canonical UTC ISO timestamp validation at IPC and service boundaries.
- Surfaced rest state in the Inspector, queue inventory, review context, chronic-postpone reckoning
  as a topic-only fifth decision, and priority-integrity resting-topic receipts.

## Verification

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm e2e -- tests/electron/fallow-topic.spec.ts`

## Learning

- Captured in
  [`docs/solutions/architecture-patterns/topic-fallow-rest-operation-log-preimages.md`](../solutions/architecture-patterns/topic-fallow-rest-operation-log-preimages.md).

## Downstream notes

- T108 should treat fallow metadata as deliberate topic rest context, not maturity failure.
- T110 can compose priority-integrity resting-topic rows into the weekly ledger.

---

# T108 — Topic knowledge-state read model

- **Milestone:** M22 — Receipts
- **Status:** `[x]` completed in this commit
- **Depends on:** T079, T083, T104
- **Roadmap line:** per topic/concept, a typed read model reports the funnel as stage-to-stage
  ratios (read → extracted → distilled → carded → mature), stability distribution, and measured
  retention trend vs the T079 target, emitting graduation events when thresholds cross.

## Goal

Define "Mature knowledge" — the pipeline's terminal stage — operationally, per topic. The model
answers the learner's real questions: which topics am I effectively done with, where are the
coverage gaps, is retention trending toward my target.

## Context to load first

- Existing code: per-card maturity (`isCardMature`, T082), T083 per-source rollup, T079 targets
  storage, review_logs aggregation precedents, block-processing rows (read% input), T104 fates
  (synthesized/reference count in the funnel).
- The denominator problem (from the ideation): topics grow as new sources import — use
  **stage-to-stage ratios** (extracted-of-read, carded-of-distilled, mature-of-carded) plus
  per-period snapshots for trend, NOT absolute percent-of-topic. Keep it falsifiable, not a
  vanity metric.

## Deliverables

- [x] `TopicKnowledgeStateQuery` in `packages/local-db`: per topic/concept — funnel counts +
      adjacent-stage ratios, stability buckets (young / maturing / mature / retired), measured
      retention (rolling 90d) vs T079 target, staleness/needs-reverify counts (T090 now; T123
      later), and threshold-crossing graduation events (computed, idempotent — an event is a
      state read, not a stored row).
- [x] Typed IPC surface; contract tests.
- [x] Tests: seeded-fixture unit tests for ratios, buckets, trend, and graduation edges
      (crossing up AND regressing back down).

## Done when

- [x] For a seeded topic with known composition, the model returns the exact expected funnel,
  buckets, trend, and graduation state; surfaces are T109's job — this task ships the model +
  contract only.
- [x] Standard gates pass.

## Notes / risks

- Concept vs topic linkage: elements relate to concepts (T041) and to topic elements — decide
  the aggregation key (recommendation: concepts, with topic elements mapping through their
  concept links) and document it in the query header.

## Completion notes

- Added `TopicKnowledgeStateQuery` as a read-only local-db model over live elements,
  concept membership, topic descendants, block-processing summaries, review states/logs,
  source-yield fates, retention targets, and open verification tasks.
- Concepts aggregate direct concept membership plus descendant concepts. Topic elements aggregate
  their live `parentId` subtree only; `sourceId` remains provenance and is not used as membership.
- Graduation is a deterministic current-state receipt, not a stored mutation: active non-retired
  cards must satisfy minimum card/review floors, mature ratio, retention target tolerance, and no
  stale/reverify flags. The event id is stable for current graduated subjects.
- Added typed `analytics.topicKnowledgeState` IPC/preload/appApi support with non-desktop fallback
  preserving the renderer boundary and exposing no generic SQL or filesystem API.

## Verification

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm e2e`
- Focused: `pnpm test -- packages/local-db/src/topic-knowledge-state-query.test.ts packages/local-db/src/index.test.ts apps/desktop/src/shared/channels.test.ts apps/desktop/src/shared/contract.test.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/preload/index.test.ts apps/web/src/lib/appApi.test.ts`
- Focused: `pnpm exec playwright test tests/electron/analytics.spec.ts --project=electron --workers=1`

## Learning

- Captured in
  [`docs/solutions/architecture-patterns/topic-knowledge-state-read-model.md`](../solutions/architecture-patterns/topic-knowledge-state-read-model.md).

---

# T109 — Maturity surfaces

- **Milestone:** M22 — Receipts
- **Status:** `[ ]` not started
- **Depends on:** T108
- **Roadmap line:** topic pages render the knowledge-state panel; analytics gains the
  concept-level retention view (replacing the deferred stub in `AnalyticsScreen.tsx`);
  graduation events appear in the daily summary.

## Goal

Make accumulation visible. Daily counters prove the work happened; these surfaces prove it
*adds up* — the strongest answer to "no feedback the system is working", and the natural home
for graduation moments.

## Context to load first

- Existing code: `apps/web/src/analytics/AnalyticsScreen.tsx:15-16` (the deferred-panels
  comment — this task deletes it), topic/concept pages, daily-work summary surface,
  `design/` tokens + kit for panel styling.
- Invariants: renderer renders; all aggregation stays in T108's query.

## Deliverables

- [ ] Topic/concept page: knowledge-state panel (funnel ratios, stability buckets, retention
      trend vs target, flags) following the design kit.
- [ ] Analytics: concept-level retention view wired to T108 (replace the stub comment).
- [ ] Daily summary: graduation events as quiet celebratory lines ("'Bayesian statistics'
      reached mature"), each linking to the topic panel; no event spam (one per crossing).
- [ ] T096 hook: from a weak-topic panel, one click starts a subset review session scoped to it
      (consume the existing review-modes machinery — no new session type).
- [ ] Tests: renderer units; e2e — seeded topic shows the panel, a graduation event renders in
      the daily summary, click-through to subset review works.

## Done when

- A user can open any topic and see its knowledge state; analytics answers retention per
  concept; graduations surface in the daily summary and link through; the deferred-stub comment
  is gone.
- Standard gates pass.

## Notes / risks

- Tone: calm, not gamified — one line per graduation, no streaks/confetti (product voice).

---

# T110 — Weekly ledger & integrity session

- **Milestone:** M22 — Receipts
- **Status:** `[ ]` not started
- **Depends on:** T106, T109
- **Roadmap line:** a weekly, dismissible session — itself a scheduled attention element —
  combines the week's ledger with the integrity sweep (T106 decisions, fallow suggestions,
  parked resurfacing when due): one ritual, not another dashboard.

## Goal

The delivery vehicle: a GTD-style weekly session that *arrives* (scheduled like a synthesis
note) instead of waiting in a dashboard. One sitting answers "what did my reading produce this
week, what did the system sacrifice on my behalf, and what needs a decision from me?"

## Context to load first

- Existing code: T095 synthesis-note scheduling (the "session as scheduled element" precedent),
  daily-work read model + `recommendedAction` (the session must plug in, not bypass —
  `docs/solutions/ui-bugs/daily-work-read-model-inbox-only-routing.md`), T105/T106/T107/T102
  surfaces (this composes them), T108 ledger numbers.
- Invariants: dismissible and reschedulable like any attention element; decisions inside it are
  the SAME commands as the standalone surfaces (composition, not duplication).

## Deliverables

- [ ] A `weekly_review` scheduled element (attention scheduler, default weekly, configurable/
      disableable in settings) that routes through normal queue/daily-work surfacing.
- [ ] Session surface composing: the week's ledger (sources read → extracts → cards → matured;
      priorities-missed by band from T105; graduations from T108), then the decision queue
      (T106 chronic items, T102 parked-resurfacing batch when due, fallow suggestions for
      starved topics), each section skippable.
- [ ] Completing/dismissing reschedules the element; partial completion resumes (the decision
      queue remembers what was decided).
- [ ] Tests: unit (session composition read model); e2e — fixture week, open session, make
      decisions in two sections, dismiss, element reschedules, decisions persisted.

## Done when

- A weekly session arrives through the normal queue, renders ledger + decisions from live read
  models, executes decisions through the existing commands with undo, and reschedules itself.
- Standard gates pass.

## Notes / risks

- Surface-ownership rule: the session COMPOSES T102/T106/T107 surfaces; those remain usable
  standalone in maintenance. One implementation, two hosts — do not fork the logic.

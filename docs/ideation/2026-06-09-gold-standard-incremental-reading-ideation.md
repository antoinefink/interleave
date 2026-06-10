---
date: 2026-06-09
topic: gold-standard-incremental-reading
focus: >
  Determine precisely what is missing or inadequate for Interleave to be a gold-standard
  incremental reading application. No scope creep — key workflows and features only.
mode: repo-grounded
---

# Ideation: What separates Interleave from gold-standard incremental reading

**Verdict:** Interleave has gold-standard *sensors* and MVP-grade *actuators*. The mechanics the
canon demands (importers, two schedulers, priority bands, block-level processing states,
analytics, AI infrastructure) are built; what is missing is the closed loop. Signals are
computed, threaded through the type system, durably persisted — and then dropped before they
change what the system does. Nearly every survivor below consumes data the app already
captures: these are completions of existing systems, not new surfaces.

Evidence trail for the open-loop pattern:

- `packages/scheduler/src/attention-scheduler.ts:104` marks `lastSeenAt` "RESERVED —
  deliberately NOT consumed by `nextDueAt`".
- `retirementSuggestion` is computed in the scheduler and threaded through `SchedulerService`;
  zero consumers exist in `apps/web` (verified by grep).
- `stagnation.ts` self-describes as "advisory + read-only. It never mutates, never schedules."
- Postpone provenance is op-logged per element (`reschedule_element`, auto-postpone `batchId`)
  and never aggregated anywhere.
- T079 lets users set per-concept retention targets; nothing reports per-concept results back.
- `needs_later` block deferrals are recorded and counted at exit, then never honored on return.
- `stale_after_edit` stops at block rows; cards derived from those blocks keep their schedules.

## Grounding Context

**Codebase Context.** Desktop-first, local-first Electron app; React 19 renderer behind a typed
`window.appApi` bridge; better-sqlite3 + Drizzle; filesystem asset vault; mutations
command-shaped and op-logged. Pipeline: Source → Topic → Extract → Clean extract → Atomic
statement → Card → Review → Mature knowledge. FSRS for cards only; attention scheduler for
everything else. Roadmap status at ideation time: Part I (T001–T050) complete; Part II
(T051–T100) complete except M11 encrypted-backup server (T051–T057, planned). Multi-device sync
out of scope by design.

**Past learnings (docs/solutions/).** Daily-work routing is a trusted-side read model with
`recommendedAction`; inbox triage has four verbs; 7-state durable block-processing model with
the explicitly documented unbuilt seam "scheduler inputs based on how much useful output a
source produced"; queue eligibility backend-canonical; DoneIntentMenu intent-collection pattern
at HEAD; analytics are read models over durable domain facts; noted absences — topic-level
synthesis workflows, knowledge-maturity tracking, media-specific reading depth, spaced source
re-reading strategy, cross-source interleaving.

**External research.** SuperMemo canon checklist (reading points, 0–100 priority, auto-sort,
pre-session auto-postpone, A-Factor, extracts as scheduled elements, provenance propagation,
cloze with one-sentence rule, Done vs Dismiss, semantic order, overload tolerance by design,
"Priorities missed" metric, incremental media, subset learning). Tool failures: Polar (reading
phase unscheduled → silent drift), Anki IR add-on (extract backlogs invisible), RemNote (broken
plugin, unmet demand for native priority-queue IR), Readwise Reader (passive resurfacing, no
pipeline). Abandonment causes: queue bankruptcy, extract graveyards, priority inflation,
overwhelm at totals, no feedback the system works. Market gap: no modern tool combines native
priority queue + auto-postpone + scheduled reading phases + lineage through extraction levels.

Process: 9 agents (codebase scan, learnings researcher, web researcher, 6 ideation frames),
48 raw ideas, all claims verified against the repo before surfacing. All six frames
independently converged on idea #1; five of six on idea #3.

## Topic Axes

1. capture-triage — import surfaces, dedupe, inbox triage verbs, priority at entry
2. reading-extraction — reader UX, reading points, block states, extract creation, source completion
3. queue-overload — priority queue, auto-postpone, priority bias, audits, overload tolerance, scheduling inputs
4. extract-to-card — statement/card production cadence, cloze, quality gates, graveyard prevention
5. review-feedback — review UX/ordering, analytics closing the loop, maturity signals, integrity checks

## Ranked Ideas

### 1. Yield-adaptive attention scheduling (close the A-Factor seam)

**Description:** Replace the static interval lookup (`{A:1, B:7, C:30, D:90}` band floors) with
a continuous per-element interval multiplier driven by what each element produces: extraction
yield per visit, descendant card health, recency. Productive sources return sooner within their
band; barren ones recede automatically. First shippable slice: wire the already-computed
`retirementSuggestion` into the DoneIntentMenu surface as system-proposed "Finished?/Abandon?"
nudges. Binding constraint: the value function must count `synthesis_note` lineage and
honorable non-card fates — `packages/core/src/source-yield.ts` currently defines reward as
cards-only, so yield-driven scheduling built on it would punish legitimate synthesis-driven
reading.
**Axis:** queue-overload
**Basis:** `direct:` attention-scheduler.ts:104-112 ("RESERVED — deliberately NOT consumed");
yield reduces to binary `retirementSuggestion` with zero UI consumers (verified);
docs/scheduling-and-priority.md promises inputs the engine ignores; docs/solutions names this
the unbuilt seam. `external:` SuperMemo A-Factor is core canon.
**Rationale:** The only idea all six frames generated independently. The difference between a
priority-sorted to-do list and an engine that learns; without it attention load grows linearly
with collection size and never amortizes.
**Downsides:** Scheduling changes are trust-sensitive — extend the drift diagnostic and surface
the multiplier ("returning sooner because last visit produced 6 extracts"); curve tuning takes
iteration.
**Confidence:** 92%
**Complexity:** Medium-High
**Status:** Unexplored

### 2. Ambient, time-denominated overload control

**Description:** (a) Promote auto-postpone from manual ceremony (OverloadBanner → preview →
confirm, every overloaded morning) to an opt-in standing policy at day rollover — the user
opens onto an already-trimmed day with a calm receipt ("14 low-priority items slipped — undo").
(b) Re-denominate the budget in minutes, not item counts (`dailyReviewBudget` default 60 items;
one 6-second cloze and one 90-minute PDF pass both cost "1"), learning per-type unit costs from
existing telemetry (seconds-per-card in review logs, reading pace per format), with a reserve
buffer and a "what fits in 25 minutes" assembly mode.
**Axis:** queue-overload
**Basis:** `direct:` apps/web/src/pages/queue/OverloadBanner.tsx (manual flow);
packages/core/src/settings.ts:42 (count-based budget); "est. minutes" is display-only.
`external:` SuperMemo auto-postpone runs pre-session by design; "overwhelm at totals" is a
documented abandonment trigger.
**Rationale:** Queue bankruptcy is the #1 abandonment cause; the user who most needs the valve
is least likely to operate it daily. Planner, preview, batchId undo, and op-log audit all
exist — only the trigger is backwards. Minutes are the unit the user actually runs out of.
**Downsides:** Unattended mutation needs an airtight receipts-and-undo contract; early time
estimates are noisy — start with coarse per-type costs.
**Confidence:** 88%
**Complexity:** Medium
**Status:** Unexplored

### 3. Priority-integrity ledger and chronic-postpone reckoning

**Description:** A read model answering "did executed attention match declared priorities?" —
per band/topic service rates vs deferrals, cumulative postpone debt, an A-band inflation
warning — plus the active half: a periodic integrity sweep forcing keep / demote / done /
delete on items postponed ≥N times instead of silent recession toward the 180-day ceiling.
Includes a per-topic fallowing verb (deliberate rest with scheduled return). Natural delivery:
a weekly session that is itself a scheduled attention element.
**Axis:** review-feedback
**Basis:** `direct:` verified absence of any priorities-missed/bias/drift concept in docs,
renderer, scheduler; `postponeIntervalForPriority` grows toward `POSTPONE_CEILING_DAYS = 180`
unsurfaced; postpone provenance captured but never read back. `external:` SuperMemo's
"Priorities missed" statistic; GTD weekly review.
**Rationale:** Ideas #1/#2 make the system act autonomously; this is the accountability layer
that makes autonomy trustworthy — without it the user cannot distinguish "protecting my
A-items" from "quietly losing my library."
**Downsides:** Must route through daily-work/maintenance patterns rather than a new dashboard;
forced-decision cadence needs tuning to avoid nagging.
**Confidence:** 90%
**Complexity:** Medium
**Status:** Unexplored

### 4. Topic-level knowledge maturity (define the pipeline's terminal stage)

**Description:** "Mature knowledge" — the pipeline's stated endpoint — has no operational
definition, metric, or screen. Build the per-topic knowledge-state read model: coverage funnel
(read % → extracts → statements → cards → mature share), stability distribution, measured
retention trend, graduation events ("Bayesian statistics reached mature"). Feed the consumers
that already exist (T096 subset review targeting, T095 synthesis prompts).
**Axis:** review-feedback
**Basis:** `direct:` apps/web/src/analytics/AnalyticsScreen.tsx:15-16 still notes concept-level
retention "deferred"; T079 sets per-concept targets with no readback; maturity exists only as a
per-card FSRS cut. `reasoned:` users think in topics; per-card stability cannot answer "do I
know X?" without a coverage dimension.
**Rationale:** "No feedback that the system is working" is a named abandonment cause daily
counters cannot answer — only maturity progression proves the work accumulates. The same read
model powers retirement confidence, subset targeting, and synthesis prompts.
**Downsides:** The coverage denominator is genuinely hard to define (percent of a moving
target); design honestly or it becomes a vanity metric.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 5. Long-form reading geometry and the re-entry payoff

**Description:** Make books, papers, and lectures first-class. (a) Extend the 7-state block
model to PDF (page/region) and media (segments) — currently ProseMirror-only, so the heaviest
formats are invisible to done-gates, yield, and scheduling. (b) Structural skim pass:
per-section verdicts (extract-worthy / later / ignore) over the TOC bulk-setting block states,
with per-section scheduling, replacing the one-linear-cursor model. (c) Re-entry briefing on
every scheduled return ("since last visit: 62% read, 3 deferred, 2 stale; cards from this
source at 91%") computed from existing block rows. (d) Honor `needs_later`: jump-to-deferred on
reopen — today it is write-only bookkeeping.
**Axis:** reading-extraction
**Basis:** `direct:` zero blockProcessing references in PdfReader.tsx/MediaReader.tsx
(verified); packages/db relations doc "One read-point per element"; docs/concept.md's own
"skim and triage" step has no feature (verified); `needs_later` absent from packages/scheduler
(verified). `external:` SuperMemo article-splitting canon; Polar's pagemark-without-scheduling
failure.
**Rationale:** A 400-page PDF is the canonical IR object; without geometry, format support is
cosmetic and everything past the cursor silently drifts. The block model means the hard part —
durable per-unit state with reconciliation — is already designed; this is extension.
**Downsides:** Largest build in the set; PDF segmentation has no DOM (page/region heuristics).
Slice: skim verdicts + briefing first, full block parity second.
**Confidence:** 87%
**Complexity:** High
**Status:** Unexplored

### 6. Extract-pipeline flow control (graveyard prevention with teeth)

**Description:** The system detects graveyards (T084) and warns (T046) but structurally creates
them: queue scoring up-weights cards first; auto-postpone sacrifices topics first; daily-work's
four actions never include "convert"; stagnation is read-only by spec. Add flow control — pick
two or three levers from: protected daily distillation quota; WIP-aware `recommendedAction`
(kanban pull, not banners); batch conversion sessions across sources; extract aging policy
(untouched after N returns → recoverable demotion, batched, undoable); shape-aware staging
(atomic captures born `atomic_statement` instead of hardcoded `raw_extract` walking three
scheduled rungs); background AI pre-drafting into `ai_suggestions` so due statements arrive
approve/edit/dismiss (drafts-only invariant).
**Axis:** extract-to-card
**Basis:** `direct:` packages/scheduler/src/queue-score.ts:133 ("due cards first, then
reading"); T077 victim order; daily-work-query.ts four actions; M17 "labels, not actions";
extraction-service.ts:228,343 hardcodes `raw_extract`. `external:` graveyards are the #2
abandonment cause; Anki IR add-on died on invisible backlogs; Little's Law.
**Rationale:** A pipeline whose output stage depends on a middle stage every overload mechanism
deprioritizes converges on graveyards exactly when the user is busiest; detection without flow
control is watching debt grow with better instruments. Soft-delete/undo invariants make
automated demotion safe here.
**Downsides:** Six levers is too many — choose a coherent minimal set (quota + batch sessions +
aging); AI pre-drafting needs a consent boundary.
**Confidence:** 85%
**Complexity:** Medium-High
**Status:** Unexplored

### 7. Lineage integrity loop (edits propagate, schedules re-stabilize)

**Description:** Forward: propagate `stale_after_edit` down the derivation DAG — affected
extracts/statements/cards land in a re-verify pass with confirm / rebase / detach resolutions;
today cards built from a corrected paragraph keep circulating and FSRS strengthens the
superseded fact. Backward: a write barrier on substantive card edits — the M7 rule "never touch
`review_states` from an edit" leaves a rewritten card scheduled on its old formulation's
stability; offer keep-schedule (typo) vs demote-to-confirmation-interval, and flag edits in
review logs so T080 optimization can exclude contaminated history.
**Axis:** extract-to-card
**Basis:** `direct:` stale_after_edit reconciliation marks block rows only (verified — no
propagation flag on extracts/cards; only T090 calendar staleness); M7 spec edit rule; T085
leech flow actively encourages rewrites. `external:` incremental build invalidation; GC write
barriers (mutated tenured objects get re-scanned).
**Rationale:** "Source lineage is sacred" is the deepest invariant, but lineage only points
backward — it never pushes change forward. The one survivor about the system being quietly
wrong rather than inefficient.
**Downsides:** "Substantive edit" detection is heuristic — offer the choice; batch re-verify
gracefully after large reimports.
**Confidence:** 88%
**Complexity:** Medium
**Status:** Unexplored

### 8. Lapse-driven re-reading (the Review→Source back-edge)

**Description:** When several cards under one source region keep lapsing, that is comprehension
debt, not memory debt — the remedy is re-reading context, which nothing generates. Cluster
lapses over review logs + lineage anchors; above threshold, propose a scheduled re-read of the
exact source region with the failing cards attached. T085 offers "open source" as a manual
button; the attention scheduler takes no lapse input.
**Axis:** review-feedback
**Basis:** `direct:` zero lapse/leech references in packages/scheduler (verified); T085 verbs
manual and per-card; review logs, immutable anchors, and the block model make targeting cheap.
`reasoned:` FSRS can only adjust intervals on a weak trace; only the attention scheduler can
repair the trace — Interleave uniquely holds both schedulers plus exact provenance.
**Rationale:** Closes the pipeline into an actual cycle (Review → Source); converts spaced
source re-reading from calendar guess to need-driven mechanic; no shipping competitor does it
well.
**Downsides:** Clustering thresholds must avoid queue spam; cap proposals per week, cheap
dismissal.
**Confidence:** 80%
**Complexity:** Medium
**Status:** Unexplored

### 9. Triage verbs that survive contact (resurfacing + bulk + informed defaults)

**Description:** (a) "Save for later" writes `status: "dismissed"` — the same status as
Abandon — so the verb users press most under overload silently exits the pipeline forever (no
schedule, unreachable by daily-work routing, indistinguishable from abandoned in the data).
Give it real semantics: a distinct state plus a periodic resurfacing sweep ("you saved these 12
items 90 days ago — keep, schedule, or let go"). (b) Bulk triage: four verbs are strictly
per-item with no multi-select while extension/URL/Kindle-Readwise feeders land dozens at once —
add grouping, keyboard verb-at-scale, one batchId undo. (c) Informed defaults: suggested
priority/placement chips from existing signals (embeddings, per-author/domain yield history,
source reliability), confirm-or-correct instead of deciding cold.
**Axis:** capture-triage
**Basis:** `direct:` apps/desktop/src/main/db-service.ts:2698-2700 (`keepForLater` →
`status: "dismissed"`); daily-work resume scans `active` only (verified); no bulk affordances
in apps/web/src/pages/inbox/ (verified); M18 AI action union has no triage action. `external:`
Polar's death mechanism reproduced inside the surface built to prevent it; SuperMemo priority
degrades through hand-ranking fatigue.
**Rationale:** Triage is the pipeline's front door and one of its four verbs is a trapdoor —
close to a bug report. Capture throughput exceeds triage throughput by an order of magnitude,
and priority — the input every downstream protection keys off — is the least-informed decision
in the system.
**Downsides:** Bulk mutations must preserve op-log/undo invariants (batchId precedent exists);
suggested priorities need visible justifications to avoid automation bias.
**Confidence:** 84%
**Complexity:** Low-Medium
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Wire `retirementSuggestion` into UI | Folded into #1 as the first shippable slice |
| 2 | Shape-aware extract staging | Folded into #6 as a lever |
| 3 | Background AI drafting sweep | Folded into #6 as a lever (drafts-only invariant) |
| 4 | Non-card terminal fates / synthesis counts as yield | Promoted into #1/#6 as a binding design constraint rather than a standalone feature |
| 5 | Honor `needs_later` on return | Folded into #5 |
| 6 | Source re-entry briefing | Folded into #5 |
| 7 | Save-for-later resurfacing | Folded into #9 (lead element) |
| 8 | Bulk inbox triage | Folded into #9 |
| 9 | Suggested priority at triage | Folded into #9 |
| 10 | Per-topic fallowing verb | Folded into #3 |
| 11 | Weekly knowledge ledger ritual | Folded into #3/#4 as the delivery surface |
| 12 | Minutes-denominated budget | Folded into #2 |
| 13 | Daily plan compiler (synthesis) | Folded into #2 + #6 (composed expression of both) |
| 14 | Percentile-anchored priority entry | Weaker than #9 + #3's inflation warning; adds per-item ceremony — the opposite of triage-at-scale |
| 15 | Capacity-priced intake | Largely redundant once #2 prices time and #6 applies backpressure; T046 ships advisory nudges; revisit if overload persists |
| 16 | Knowledge-aware novelty (delta) triage | Genuine differentiator but beyond the gold-standard bar asked about; overlap estimates carry trust risk; future differentiator round |
| 17 | Commissioning briefs (entry-side reading contracts) | New domain concept whose payoff depends on redefining Done/yield denominators; brainstorm variant inside #5/#6 |
| 18 | Blocked-on-prerequisite readiness | Close call: founding problem #3 in concept.md with no mechanism, but lower frequency than survivors; needs new relation type + scheduler input; strong next-round candidate |
| 19 | Park-it tangent capture in reader | Flow value real but partially served by extension; source→source citation lineage alone doesn't clear this field |

Axis coverage: all five axes have survivors (queue-overload #1 #2; review-feedback #3 #4 #8;
reading-extraction #5; extract-to-card #6 #7; capture-triage #9). No deliberate gaps.

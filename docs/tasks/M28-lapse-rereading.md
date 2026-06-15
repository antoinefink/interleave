# M28 — Lapse-driven re-reading (T128–T129)

> The missing back-edge of the pipeline: data flows Source → Card and never returns. When
> several cards descended from one extract or source region keep lapsing, that is comprehension
> debt, not memory debt — the encoding was thin, and the remedy is re-reading the context.
> Nothing generates that today: T085's leech screen offers "open source" as a manual per-card
> button, and the attention scheduler takes no lapse input (verified: zero lapse/leech
> references in `packages/scheduler` scheduling paths). Interleave is the rare system holding
> BOTH schedulers plus exact provenance (`source_locations` pin regions; lineage anchors are
> immutable) — this milestone closes the loop no shipping competitor closes. FSRS can only
> adjust intervals on a weak memory trace; only the attention scheduler can repair the trace.
> Ideation survivor #8. (T114 already feeds lapse pressure into the parent's interval; this
> milestone produces the explicit re-read WORK.)
>
> **Shared context for every task in this file.** Read
> `docs/solutions/architecture-patterns/review-analytics-data-capture-in-review-logs.md`
> (review logs carry FSRS transitions at the grading write path — the lapse source of truth)
> and `docs/solutions/logic-errors/rich-extractions-preserve-paragraphs-and-images.md`
> (anchors immutable — the targeting mechanism).
>
> **Standard gates (inherited by every task below):** `pnpm lint` · `pnpm typecheck` ·
> `pnpm test` · relevant `pnpm e2e`; persistence survives restart; mutations transactional +
> op-logged; FSRS card states never touched by attention-side work; no unrelated refactors.
>
> **File/line references** verified 2026-06-09/10; re-verify with grep before editing.

---

# T128 — Lapse-cluster detection

- **Milestone:** M28 — Lapse-driven re-reading
- **Status:** `[x]` done — `feat: T128 lapse-cluster detection`
- **Depends on:** T040, T083
- **Roadmap line:** a read model over `review_logs` joined to lineage anchors detects
  K-lapses-in-window clusters sharing an extract/source-region ancestor — thresholds tuned to
  stay rare — surfaced in maintenance and on the source page.

## Goal

See the correlation no per-card view can: five sibling cards failing under one paragraph is one
comprehension problem, not five formulation bugs. A read model finds those clusters and names
the exact source region they share.

## Context to load first

- Existing code: `review_logs` lapse semantics (T040's leech detection counts lapses per card —
  reuse its definitions, do not re-derive "lapse"), lineage joins card → extract →
  source_location (block IDs/offsets — the cluster key is the shared ancestor region), T114's
  descendant-lapse input (share the underlying query if T114 landed; otherwise build here and
  let T114 consume it — coordinate so ONE lapse-aggregation query exists),
  maintenance hub + source-page surfaces.
- Invariants: read model only; cluster thresholds conservative (rare and high-confidence beats
  sensitive and noisy — the queue-spam failure mode is named in the ideation).

## Deliverables

- [x] `LapseClusterQuery` in `packages/local-db`: clusters = K+ lapses within a rolling window
      across 2+ live cards sharing an extract/source-region ancestor (defaults K=5 / 30d / ≥2
      cards — settings-tunable, documented); returns the shared region (source + block range),
      member cards with lapse counts, and a cluster strength score. Built on a SHARED
      `lapse-window` predicate extracted from T114's descendant-health (one lapse definition).
- [x] Surfacing: a maintenance "Struggling card groups" section listing active clusters; a quiet
      indicator on the source page linking to them; the leech screen (T085) gains a "part of a
      struggling group" cross-link. All navigation-only (no mutation paths).
- [x] Tests: unit — seeded review-log fixtures produce exactly the expected clusters and
      near-miss fixtures produce none (below-K, single-card, dead/tombstoned lineage,
      outside-window, marker-only, sourceless, retired member, source-shared-not-extract-shared,
      multi-anchor determinism, soft-deleted source, topic-anchored, partial-window, inclusive
      boundary); read-only "no writes to any table" + contract + component + Electron E2E.

## Done when

- A seeded sibling-failure fixture yields one cluster naming the right region and cards;
  healthy and noisy fixtures yield none; surfaces render with no mutation paths. ✓
- Standard gates pass. ✓ (`pnpm lint`, `pnpm typecheck`, `pnpm test` (4428),
  `pnpm e2e tests/electron/lapse-clusters.spec.ts`)

## Outcome

Done via ce-plan → ce-doc-review → ce-work → ce-code-review → fixes → ce-compound.
Plan: [`../plans/2026-06-15-003-feat-t128-lapse-cluster-detection-plan.md`](../plans/2026-06-15-003-feat-t128-lapse-cluster-detection-plan.md).
Learning: [`../solutions/architecture-patterns/sibling-clustering-over-the-lineage-dag.md`](../solutions/architecture-patterns/sibling-clustering-over-the-lineage-dag.md).
Key decisions: cluster key = nearest live source-region ancestor (not `source_id`, not direct
parent); read-only with all-tables no-write proof; deterministic source-anchor resolution
(non-unique `source_locations.elementId` required a `type='source'`+live join with `ORDER BY`).
Follow-up (deferred): ancestor-walk batch-prefetch + decouple the maintenance cluster re-read
from unrelated `UNDO_EVENT`s.

## Notes / risks

- Definition reuse: "lapse" must mean exactly what T040/FSRS logs say it means — divergent
  definitions here would make the cluster list contradict the leech screen.

---

# T129 — Re-read proposals

- **Milestone:** M28 — Lapse-driven re-reading
- **Status:** `[ ]` not started
- **Depends on:** T128
- **Roadmap line:** accepting a proposal schedules a re-read attention item targeting the exact
  source region (via anchors) arriving with the failing cards attached for context; proposals
  capped per week, cheap to dismiss, dismissals remembered.

## Goal

Turn a detected cluster into scheduled work: the system proposes "re-read this section", and
accepting enqueues an attention item that opens the source AT the region with the failing cards
shown alongside — re-exposure with the failure context in hand, then optional re-extract or
card rewrite on the spot.

## Context to load first

- Existing code: T128 clusters; attention-scheduler item creation paths (what a scheduled
  element needs — this adds a re-read item kind or a task-element usage; inspect how T092
  verification `task` elements were modeled and prefer reusing that shape over inventing a new
  element type), reader deep-linking to a block/region (jump machinery from
  extract→source navigation), T103's dismissal-memory pattern (state-hash, not timer), T125's
  write barrier (rewrites made from this surface route through it once it exists).
- Invariants: proposals are advisory until accepted (nothing auto-enqueues); accepted items are
  normal attention-scheduled elements (queue eligibility, postpone, done — all standard verbs
  work); caps enforced domain-side (default ≤2 active proposals/week); FSRS states of the
  failing cards untouched by any of this.

## Deliverables

- [ ] Proposal lifecycle: cluster → proposal (visible in maintenance/source page + a quiet
      daily-summary line when one is fresh) → accept (creates the scheduled re-read item,
      op-logged) or dismiss (remembered against the cluster's state-hash — reappears only if
      the cluster materially worsens).
- [ ] Re-read item + surface: due like any attention item; opening it lands in the reader at
      the region (anchor jump) with a side panel listing the failing cards (prompt + lapse
      count, click-through to card detail); completing it offers the standard processing verbs
      (extract, rewrite-card → T125 barrier when present, done).
- [ ] Caps + settings: weekly active-proposal cap, cluster thresholds passthrough, feature
      toggle.
- [ ] Tests: unit (lifecycle, cap enforcement, dismissal memory, item creation ops); e2e —
      seeded cluster → accept → item appears in queue → opening lands at the region with cards
      attached → complete → cluster quiets; restart-safe.

## Done when

- A struggling cluster becomes, with one tap, a scheduled re-read that opens at the exact
  region with its failing cards attached; dismissals stick; proposals never exceed the cap;
  everything is undoable and restart-safe.
- Standard gates pass.

## Notes / risks

- Tone: one quiet proposal line, not an alarm — the user is already frustrated by the lapses;
  the system is offering help, not assigning blame.

# M25 — Extract-pipeline flow control (T119–T122)

> Extract graveyards are the #2 documented abandonment cause for incremental-reading tools, and
> the system currently *creates* the conditions for them while only *detecting* the result:
> queue scoring up-weights "due cards first, then reading"
> (`packages/scheduler/src/queue-score.ts:133`); T077's victim order postpones topics first —
> distillation is the designated loser under load; the daily-work model's four recommended
> actions never include "convert" (`packages/local-db/src/daily-work-query.ts`); statements nag
> one-at-a-time at +1d (`atomic_statement → return 1`); stagnation detection is read-only by
> spec (`docs/tasks/M17-analytics.md` — "labels, not actions"). M25 gives the pipeline teeth:
> protected throughput, batch drainage, consequences for aging, and less ceremony at birth.
> Ideation survivor #6 (minimal lever set chosen there: quota + batch sessions + aging; staging
> is the cheap fourth).
>
> **Order note:** T104 (value model v2) must be `[x]` before T121 — aging demotes INTO an
> honorable T104 fate, and aging on the cards-only value model would demote synthesis material.
>
> **Standard gates (inherited by every task below):** `pnpm lint` · `pnpm typecheck` ·
> `pnpm test` · relevant `pnpm e2e`; persistence survives restart; mutations transactional +
> op-logged with undo preimages; lineage preserved; no unrelated refactors.
>
> **File/line references** verified 2026-06-09/10; re-verify with grep before editing.

---

# T119 — Protected distillation quota

- **Milestone:** M25 — Extract-pipeline flow control
- **Status:** `[x]` complete
- **Commit:** `this commit`
- **Depends on:** T076, T115
- **Roadmap line:** day composition guarantees a configurable minimum share for distillation
  work so conversion throughput never silently drops to zero under card load — the share is
  visible, and an overloaded fixture provably still surfaces distillation items.

## Goal

A pipeline whose output stage depends on a middle stage that every overload mechanism
deprioritizes converges on graveyards exactly when the user is busiest. The quota guarantees a
small floor of extract/statement work per day — card production never starves completely.

## Context to load first

- Existing code: `queue-score.ts` type weighting (:133 — the cards-first up-weight this
  carves an exception into), T077/T117 trim paths (the quota's floor must survive trimming),
  T115 pricing (the quota is naturally minutes-shaped; fall back to item-count if T116 hasn't
  landed — but T115 is a dep, so minutes are available), daily-work summary (the share shown).
- Invariants: the quota reorders *composition*, not due dates; priority order holds *within*
  the distillation share; an empty distillation backlog yields the share back to cards
  (no make-work).

## Deliverables

- [x] Composition rule in the queue/day plan: a configurable minimum share (setting, default
      ~15% of budget or ~10 min) reserved for due extract/statement processing before pure card
      fill; trim paths (T077/T117) treat the floor as protected.
- [x] Visibility: the gauge/day plan shows the split ("~38 min cards · ~10 min distillation");
      the share setting lives with the budget setting.
- [x] Tests: unit — an overloaded all-types fixture still surfaces distillation items up to the
      floor; an empty-distillation fixture gives the share back; trim never eats the floor.
      E2e — overloaded day shows mixed composition.

## Done when

- On a 100%-card-pressure fixture day, distillation throughput is provably non-zero up to the
  configured floor, visibly, and the floor survives auto-postpone.
- Standard gates pass.

## Notes / risks

- Interplay with T076 scoring: implement as a composition constraint on top of the score (fill
  share-buckets by score) rather than mutating the score function — keep the score pure.
- Completion notes: T119 keeps `queue-score` pure and implements quota as planner composition.
  `planSession` now returns required composition metadata; queue/day composition uses the full
  time-estimated due universe while trimming only displayed estimate rows for the visible list.
  Auto-postpone and standing auto-postpone share the same protected floor metadata. The setting is
  persisted as `review.distillationQuotaPercent` and surfaced next to the Daily budget setting.
- Verification: `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm e2e tests/electron/auto-postpone.spec.ts tests/electron/process-queue.spec.ts`.
- Learning captured in
  [`docs/solutions/architecture-patterns/protected-distillation-quota-daily-workload-share.md`](../solutions/architecture-patterns/protected-distillation-quota-daily-workload-share.md).

---

# T120 — Batch conversion sessions

- **Milestone:** M25 — Extract-pipeline flow control
- **Status:** `[ ]` not started
- **Depends on:** T024, T032, T093
- **Roadmap line:** a session view gathers card-ready atomic statements across sources for
  keyboard-first batch card authoring, with optional AI pre-drafts (existing `ai_suggestions`
  path, drafts-only invariant, explicit per-session consent); produced cards keep full lineage.

## Goal

Drain the backlog efficiently: instead of meeting card-ready statements one-at-a-time on +1d
cycles, a conversion session lines them up across sources for rapid batch authoring —
approve/edit/skip with the keyboard, optionally pre-drafted by AI.

## Context to load first

- Existing code: atomic-statement stage + due semantics (`extraction-service.ts`,
  `attention-scheduler.ts` extract-stage intervals), CardBuilder + card-quality checks
  (`docs/solutions/design-patterns/compact-card-quality-check-disclosure.md`), the M18 AI path
  (`ai.run`, `ai_suggestions` drafts table, grounding/lineage rules in
  `docs/tasks/M18-ai.md`), T058 runner `ai` job type (for the optional pre-draft sweep),
  ProcessQueue keyboard patterns.
- Invariants: drafts-only — nothing AI-produced is ever scheduled without explicit approval;
  every produced card carries full lineage to its statement/source; AI runs only with
  per-session consent (the user starts a session knowing drafts will be generated; running AI
  over content the user didn't just select is the consent boundary called out in the ideation).

## Deliverables

- [ ] Session source: a read model gathering due + card-ready atomic statements (and optionally
      stagnant clean extracts) across sources, ordered by priority.
- [ ] Conversion surface: one statement at a time with source context; keyboard-first
      create-Q&A / create-cloze / skip / honorable-fate (T104 verbs if landed); quality checks
      inline; each creation transactional + op-logged.
- [ ] Optional AI pre-drafting: a per-session opt-in that enqueues draft generation (runner `ai`
      job → `ai_suggestions`) for the session's items; UI shows approve/edit/dismiss on arrival;
      a batch "N drafts awaiting review" entry point.
- [ ] Processing actions update attention schedules exactly as the one-at-a-time path does (no
      bypass).
- [ ] Tests: unit (session gathering, draft linkage); e2e — run a session over a fixture
      backlog, author two cards (one from an AI draft), lineage intact, restart-safe.

## Done when

- A backlog of card-ready statements is convertible in one sitting at keyboard speed; AI
  pre-drafts arrive as drafts only after explicit opt-in; conversion writes the same ops as the
  existing single-item path.
- Standard gates pass.

## Notes / risks

- The drafts-only invariant is load-bearing for trust in the whole AI surface — test the
  negative (an unapproved draft never gains a review state) explicitly.

---

# T121 — Extract aging policy

- **Milestone:** M25 — Extract-pipeline flow control
- **Status:** `[ ]` not started
- **Depends on:** T084, T104
- **Roadmap line:** extracts crossing an age/unproductive-returns threshold auto-demote to a
  recoverable T104 reference state via batched, op-logged, undoable sweeps — opt-in policy with
  preview, mirroring the auto-postpone receipt pattern — with age bands visible wherever
  extracts list.

## Goal

A dashboard the user must visit cannot prevent a graveyard; only default pressure can. With the
policy on, an extract that keeps returning unproductively eventually steps aside *honorably* —
demoted to reference (recoverable, not deleted) instead of haunting the queue forever. The
soft-delete/undo house invariants make this safe to automate in a way competitors can't.

## Context to load first

- Existing code: T084 stagnation detection (`isStagnant` — the trigger predicate; this task
  adds consequence), T104 fates (`reference` is the demotion target), the T077/T117 receipt
  pattern (preview → batch → `batchId` → receipt + undo — copy it), extract list surfaces (age
  bands).
- Invariants: opt-in policy, preview-able, every sweep one undoable batch; demotion is a T104
  fate transition (reversible), never delete; T105/T110 surfaces attribute the sweeps.

## Deliverables

- [ ] Policy setting: off / suggest / automatic, plus thresholds (returns-without-progress
      count and/or age; defaults conservative, e.g. 5 unproductive returns).
- [ ] Sweep mechanics: candidates from the stagnation predicate + thresholds → preview list →
      batched demotion to `reference` with one `batchId`, receipt line (daily summary/weekly
      session), one-tap undo.
- [ ] Age visibility: age/returns bands on extract rows (list + queue inventory), so pressure is
      legible before the sweep fires.
- [ ] Tests: unit (candidate selection respects T104 fates — synthesized/reference extracts are
      never candidates; batch undo symmetric); e2e — automatic policy demotes a fixture
      graveyard with receipt; undo restores.

## Done when

- With the policy on, unproductive extracts past threshold demote to reference in visible,
  undoable batches; honorably-terminal extracts are never touched; age bands render.
- Standard gates pass.

## Notes / risks

- Pair the nudge with capacity, not guilt: the receipt should link to a T120 conversion session
  ("or convert them now") — drain or demote, both one tap.

---

# T122 — Shape-aware extract staging

- **Milestone:** M25 — Extract-pipeline flow control
- **Status:** `[ ]` not started
- **Depends on:** T021, T024
- **Roadmap line:** extract creation classifies shape, so card-ready captures are born
  `atomic_statement` with a convert-now affordance instead of walking the hardcoded
  `raw_extract` ladder; misclassification is one keystroke to correct.

## Goal

Stop taxing every capture three scheduled touches: a single-sentence definition is already
atomic at birth, and forcing it through raw → clean → atomic multiplies queue load and delays
its card by days — the opposite of graveyard prevention. The ladder stays for prose; the
*default entry rung* becomes shape-aware.

## Context to load first

- Existing code: `packages/local-db/src/extraction-service.ts:228,343` — `stage: "raw_extract"`
  hardcoded at both creation paths; `extractStageIntervalDays` (+1..7d raw, +3..14d clean, +1d
  atomic); ExtractView stage-transition verbs (the correction affordance);
  `docs/solutions/logic-errors/rich-extractions-preserve-paragraphs-and-images.md` (extract
  bodies are rebuilt main-side — classification must run there too, on the rebuilt body).
- Invariants: classification is a deterministic main-side heuristic (sentence count, length,
  self-containedness markers — no pronoun-dangling starts); NO AI in the creation path (an AI
  assist may come later via M18 patterns; out of scope here); stage transitions remain op-logged
  so birth-stage is auditable.

## Deliverables

- [ ] Shape heuristic in `packages/core` (pure, unit-tested): `atomic-ready` vs `prose`
      (conservative — when unsure, prose/raw as today).
- [ ] Creation paths set the birth stage from the heuristic; atomic-born extracts get the
      atomic-statement due semantics (+1d convert pressure) and surface a convert-now affordance
      in the reader flow.
- [ ] One-keystroke correction both ways in ExtractView (demote to raw / promote to atomic),
      op-logged.
- [ ] Tests: heuristic table-tests (definitions, single facts, formulas → atomic; multi-sentence
      paragraphs, lists → raw); service tests (birth stage + due); e2e — extract a one-liner,
      see convert-now, make the card same-session.

## Done when

- A single-sentence capture becomes a card in one session without ladder ceremony; prose
  captures behave exactly as today; corrections are one keystroke; birth stages are audited in
  the op log.
- Standard gates pass.

## Notes / risks

- Conservative bias matters: a false "atomic" puts convert pressure on un-distilled material —
  tune the heuristic toward raw and let T120 drain the rest.

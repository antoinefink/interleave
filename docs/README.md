# Documentation & build-orchestration system

This `docs/` tree is the control plane for building **Interleave**, a local-first
incremental reading application. It exists so that we can build the product
**one feature at a time, each by a dedicated agent**, while keeping the whole
plan coherent across hundreds of small steps.

Read this file first if you are an agent picking up work.

## How the docs fit together

| File | Role | Changes how often |
|------|------|-------------------|
| [`concept.md`](./concept.md) | What incremental reading is and why it works. The product "why". | Rarely |
| [`architecture.md`](./architecture.md) | Stack, rationale, monorepo layout, Docker. | Occasionally |
| [`domain-model.md`](./domain-model.md) | The universal `Element` model, types/statuses/stages, schema. | When the data model evolves |
| [`scheduling-and-priority.md`](./scheduling-and-priority.md) | FSRS card scheduling vs. the topic/extract scheduler, priority model. | When scheduling rules evolve |
| [`roadmap.md`](./roadmap.md) | **The task queue.** All 100 steps as a checklist with dependencies and done-criteria. | After every completed task |
| [`tasks/_TEMPLATE.md`](./tasks/_TEMPLATE.md) | The contract every detailed task spec follows. | Rarely |
| [`tasks/M*.md`](./tasks/) | Expanded, ready-to-build specs for one milestone at a time. | Per milestone |
| [`../CLAUDE.md`](../CLAUDE.md) | The engineering charter: invariants, layering, Docker commands, definition of done. | Rarely |

The split is deliberate: an agent rebuilds almost no context per task because the
stable knowledge lives in the reference docs and only the *next thing to do* lives
in the roadmap.

## The orchestration loop

Each unit of work is one roadmap task (`T001`…`T100`). To build one:

1. **Pick a task.** Choose the lowest-numbered unchecked task in `roadmap.md`
   whose `Depends on` tasks are all checked `[x]`. (Independent tasks may be run
   in parallel by separate agents — see "Parallelism" below.)
2. **Load context.** Read `CLAUDE.md`, the relevant reference docs, and the task's
   detailed spec in `tasks/M*.md` if one exists. If no detailed spec exists yet,
   the roadmap entry (`Goal` + `Done when` + `Depends on`) is the spec.
3. **Inspect first.** Look at the existing schema, repositories, services, and
   tests touched by the task before writing anything. Do not rewrite unrelated code.
4. **Build the feature + its tests** in one coherent change.
5. **Verify in Docker.** Run the checks (`make typecheck`, `make test`, and
   `make e2e` when relevant — see `CLAUDE.md`). Everything runs in containers; do
   not rely on host toolchains.
6. **Confirm the Definition of Done** (see `CLAUDE.md`). A task is not done unless
   it survives reload and preserves source lineage.
7. **Update the roadmap.** Check the box `[x]`, add the PR/commit reference, and
   note anything that changes downstream tasks.
8. **Commit** as a single coherent change referencing the task ID
   (e.g. `T021: extraction into scheduled child extract`).

## Just-in-time task specs

Detailed task files (`tasks/M*.md`) are written **one milestone ahead**, not all at
once. The roadmap already records every step's intent and done-criteria, so nothing
is lost — but expanding a spec *after* the prior milestone is built lets it reference
real files, real repository signatures, and real test helpers instead of guesses.

When a milestone's tasks are all checked, generate the next milestone's spec file
from the roadmap before starting it.

## Parallelism

Tasks with disjoint `Depends on` chains and disjoint file footprints can be built
concurrently by separate agents (e.g. "concepts/tags" and "search" late in the MVP).
The roadmap's `Depends on` column is the contract. When in doubt, serialize — this
product values data-integrity and lineage over throughput.

## Status legend (used in `roadmap.md`)

- `[ ]` not started
- `[~]` in progress (note the agent/branch)
- `[x]` done (note the commit/PR)
- `[!]` blocked (note the blocker)
</content>
</invoke>

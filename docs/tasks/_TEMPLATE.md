# T### — <short feature title>

> Copy this file when expanding a roadmap step into a buildable spec. One coherent
> feature per task. Keep it tight; link to reference docs instead of repeating them.

- **Milestone:** M# — <name>
- **Status:** `[ ]` not started <!-- update to [~]/[x]/[!] and note branch/commit -->
- **Depends on:** T###, T### (must be `[x]` before starting)
- **Roadmap line:** <paste the one-line Goal + Done-when from roadmap.md>

## Goal

What capability exists after this task that didn't before. One paragraph, user-facing.

## Context to load first

- Reference: <which of concept / architecture / domain-model / scheduling docs apply>
- Existing code to inspect: <files / repositories / services / schema / tests>
- Invariants in play: <e.g. source lineage, stable block IDs, operation-log shape>

## Deliverables

- [ ] <code: the smallest set of files/modules to add or change>
- [ ] <schema: Drizzle migration if the data model changes>
- [ ] <tests: unit/domain tests at the right level>
- [ ] <tests: Playwright E2E if this touches a core flow>
- [ ] <fixtures/seed updates if useful>
- [ ] <docs: update roadmap status + any reference doc the change invalidates>

## Done when

- <the roadmap's "Done when" criterion, made concrete and checkable>
- `make typecheck` passes
- `make test` passes
- relevant `make e2e` passes
- the feature survives page reload
- source lineage is preserved
- no unrelated refactors are included

## Notes / risks

- <data-migration or backfill notes for risky changes>
- <decisions deferred, or downstream tasks this affects>
</content>

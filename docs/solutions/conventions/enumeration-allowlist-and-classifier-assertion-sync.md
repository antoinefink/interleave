---
title: "Keep enumeration allowlists and classifier-driven assertions in sync when features land"
date: 2026-06-15
module: testing_framework
category: conventions
problem_type: convention
component: schema-registry-and-e2e
severity: medium
tags: [test-fixtures, enumeration-allowlist, fixture-drift, e2e-assertions, classifier-strings, schema-roundtrip, settings-persistence]
applies_when:
  - "A feature adds a Drizzle table (the schema.roundtrip expected-tables allowlist must be updated)"
  - "A feature adds a repository to createRepositories (the local-db repository-bag key allowlist must be updated)"
  - "A feature adds an AppSettings key (the desktop settings-roundtrip allowlist must be updated)"
  - "A feature changes a user-facing string that a runtime classifier decides (e2e assertions on that string must follow)"
  - "You are about to assert a classifier-dependent value by reasoning about the input rather than running the classifier"
---

# Keep enumeration allowlists and classifier-driven assertions in sync when features land

## Context

Two unrelated features each landed green on their own branch yet left `main` red, via the
same shape of mistake: a test was written against the concrete value that existed *before* the
feature, and the feature changed that value without updating the test in the same commit. We call
this **fixture drift**. It showed up in two distinct layers.

**1. Exhaustive enumeration allowlists.** Interleave guards three cross-cutting surfaces with
tests that assert the *complete* set, not a subset:

- `packages/db/src/schema.roundtrip.test.ts` — the full ordered list of SQLite tables after all
  migrations run (`expect(names).toEqual([...])`).
- `packages/local-db/src/index.test.ts` — the full set of keys returned by `createRepositories(...)`
  (`expect(Object.keys(repos)).toEqual([...])`).
- `apps/desktop/src/main/db-service.test.ts` — the full typed `AppSettings` object round-tripped
  through a close/reopen (`expect(settings).toEqual({...})`).

These are **registry-integrity tests by design**: deliberately exhaustive so that every new table,
repository, or settings key must be *consciously acknowledged*. The price of that integrity is that
the allowlist and the implementation must move together. A maintenance feature added a table
(`reread_proposal_dismissals`), a repository (`rereadProposals`), and two settings
(`rereadProposalsEnabled`, `rereadProposalWeeklyCap`) but did not touch the three allowlists — so
three tests failed on `main`. The same feature also skipped `biome`, leaving lint errors in the new
files; same root discipline gap.

**2. Classifier-driven UI strings.** The extract-flash text is not a constant — it is decided at
runtime by `classifyExtractShape` in `packages/core/src/extract-shape.ts`. The ternary
(`apps/web/src/pages/queue/ProcessQueue.tsx`, mirrored in `SourceReader.tsx`) is:

```ts
toast(result.extract.stage === "atomic_statement" ? "Atomic extract ready" : "Extracted");
```

A shape-aware-staging feature introduced this ternary but never updated the electron e2e
(`tests/electron/process-queue.spec.ts`), which still asserted the pre-feature constant
`"Extracted"`. The e2e went red.

The subtle trap is *how* you derive the expected string. The e2e helper
`selectProcessSourceBodyText` triple-clicks the **first** `[data-block-id]` block. In the seed
factory (`packages/testing/src/factories.ts`) that first block is *"To make deliberate progress
towards more intelligent…"* — a single finite-verb sentence with no leading pronoun, which the
classifier stages as `atomic_statement` → flash `"Atomic extract ready"`. It is tempting to instead
reason about the seed's *definition* paragraph (*"We define the intelligence of a system…"*) and
conclude it stages atomic — but that sentence's leading **"we"** matches `DANGLING_PRONOUN_RE`, so it
actually stages `raw_extract`. Two errors cancel into a plausible-but-wrong story; only *executing*
the classifier on the actually-selected block reveals the truth.

## Guidance

**A. Update every companion allowlist in the same commit as the schema/code change.** When a
migration or feature adds a table, a repository export, or a settings key, edit all three allowlist
tests alongside it — never defer to a follow-up commit. Running `pnpm test` from the workspace root
before committing is the mechanical catch (the full suite, not just the package you touched).

**B. Make classifier-driven e2e assertions follow the user-facing contract, and verify by
executing.** When a UI string becomes classifier-decided:

1. Update e2e assertions to the new user-facing contract, not the old implementation constant.
2. Derive the expected value by **running the classifier on the exact input the test selects** —
   check which DOM node the helper selects (here: the *first* block, not the seed extract's block) —
   never by eyeballing which input "looks atomic".
3. Remember that a unit test which *mocks* the stage (e.g. `SourceReader.test.tsx` mocking
   `raw_extract`) proves the branch but not that real input reaches it. The e2e through the real
   classifier is the stronger coverage and is what catches this drift.

## Why This Matters

Both failures convert a successfully landed feature into a red `main` for everyone downstream — the
most expensive place to discover the gap. The allowlist pattern is intentional: it forces explicit
acknowledgment of every new entry rather than letting the surface silently expand, so silently
leaving it stale defeats the test's whole purpose. The classifier-assertion trap is epistemically
worse: a confident static argument can be wrong in a way that looks right, and only running the code
settles it. Both are cheap to prevent (one extra edit, one classifier run) and cheap to catch
(`pnpm test` / `pnpm e2e`) — but only if the discipline is applied *before* the commit.

## When to Apply

- Every time you add a Drizzle table / run `pnpm db:generate` → update the schema-roundtrip table allowlist.
- Every time you add a repository to `createRepositories` → update the repository-bag key allowlist.
- Every time you add an `AppSettings` key → update the desktop settings-roundtrip allowlist (with the shipped default value).
- Every time you turn a UI string from a constant into a classifier-gated expression → audit every e2e assertion that matched the old constant and re-verify each by executing the classifier on the real selected input.

## Examples

Enumeration allowlist additions (one line each, in the right ordered position):

```diff
// packages/db/src/schema.roundtrip.test.ts
   "read_points",
+  "reread_proposal_dismissals",
   "retirement_suggestion_dismissals",

// packages/local-db/src/index.test.ts
   "retirementSuggestions",
+  "rereadProposals",
   "embeddings",

// apps/desktop/src/main/db-service.test.ts (defaults must match the runtime)
   lapseClusterMinCards: 2,
+  rereadProposalsEnabled: true,
+  rereadProposalWeeklyCap: 2,
```

Classifier-driven e2e assertion fix:

```ts
// Before — asserts the pre-feature constant that no longer fires for atomic extracts:
await expect(page.getByTestId("process-flash")).toContainText("Extracted");

// After — what classifyExtractShape actually returns for the first seed block:
await expect(page.getByTestId("process-flash")).toContainText("Atomic extract ready");
```

The rule that decided the outcome (`packages/core/src/extract-shape.ts`):

```ts
const DANGLING_PRONOUN_RE =
  /^(it|this|that|these|those|they|them|he|she|we|its|their|his|her|which)\b/i;
```

First seed block "To make deliberate progress…" → no leading pronoun → `atomic_statement` →
`"Atomic extract ready"`. The definition paragraph "We define the intelligence…" → leading "we"
matches → `dangling_pronoun` → `raw_extract` → `"Extracted"`. The e2e selects the first block, not
the definition paragraph — which is why only running the classifier gives the right expected string.

## Related

- [extract-card-ipc-invariant-test-hardening](../architecture-patterns/extract-card-ipc-invariant-test-hardening.md) — the complement: *adding* invariant coverage where none existed (this doc is about *keeping existing* exhaustive coverage current).
- [shape-aware-extract-birth-stage-audit](../architecture-patterns/shape-aware-extract-birth-stage-audit.md) — how the shape-aware birth-stage classifier works; this doc is its test-hygiene consequence.
- [electron-e2e-stale-build-lock-and-lineage-contract](../test-failures/electron-e2e-stale-build-lock-and-lineage-contract.md) — adjacent discipline: update e2e assertions to user-facing contracts, not old implementation details.

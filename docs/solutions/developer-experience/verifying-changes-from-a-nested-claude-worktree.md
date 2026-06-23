---
title: "Run authoritative lint/typecheck/test from the primary checkout, not a nested worktree"
date: "2026-06-23"
category: "developer-experience"
problem_type: "developer_experience"
component: "tooling"
applies_when:
  - "Working in a nested git worktree under .claude/worktrees/ that has no node_modules of its own."
  - "vitest fails to load its config or project-mode tsc reports 'Cannot find module react' from inside the worktree."
  - "Deciding where to run the Definition-of-Done gates for work done in an isolated worktree."
tags:
  - "worktree"
  - "pnpm"
  - "vitest"
  - "typecheck"
  - "tooling"
  - "verification"
  - "monorepo"
---

# Run authoritative lint/typecheck/test from the primary checkout, not a nested worktree

## Context

Isolated work often happens in a git worktree nested under the primary checkout (e.g.
`/<repo>/.claude/worktrees/<name>`). These worktrees share `.git` but **not** `node_modules`
— that directory is per-checkout and gitignored, so a fresh worktree has none. Some tools
cope with this and some do not, and the difference quietly determines where the
Definition-of-Done gates can actually run.

## Guidance

Treat the nested worktree as a place to **edit and commit**, and the **primary checkout** as
the place to **verify**. Concretely:

- **Biome (lint) works from the worktree** via a full path to the root binary, because Node
  module resolution walks *up* from the nested worktree into the primary checkout's
  `node_modules`:
  `/<repo>/node_modules/.bin/biome check .` (run with the worktree as cwd).
  A single-file `tsc --version` likewise resolves.
- **vitest does NOT work from the worktree.** Vitest loads its Vite config from a temp dir as
  ESM, and Node's ESM resolver does not perform the same upward walk for the config's own
  imports — so `@vitejs/plugin-react` fails to resolve and the run aborts before any test.
- **Project-mode `tsc -p <pkg>/tsconfig.json` does NOT work from the worktree** either: types
  like `react` / `react/jsx-runtime` resolve inconsistently, producing "Cannot find module"
  errors across *every* file (a tell that it's an environment failure, not your code).
- `pnpm exec <bin>` fails in the worktree (no local `.bin`); `pnpm <script>` is unreliable for
  the same reason.

So: implement in the worktree, commit there, then run the authoritative
`pnpm lint && pnpm typecheck && pnpm test` (and Electron `pnpm e2e`) **in the primary
checkout**. Because both worktrees share `.git`, the commits are already visible — remove the
worktree (`git worktree remove`) and `git checkout <branch>` in the primary checkout to verify
and land via fast-forward. Don't try to `pnpm install` inside the worktree to "fix" it; that
defeats the point of a lightweight isolated worktree and the primary checkout already has a
working install.

## Why This Matters

A green Biome run in the worktree gives false confidence that the gates pass — but lint is the
*only* gate that runs there. Typecheck and tests silently can't run, so a refactor can look
"verified" from the worktree while typecheck or tests are actually red. Knowing the split up
front saves a cycle of "tests pass locally" → "CI/primary checkout is red".

## When to Apply

Any time work is done in a nested `.claude/worktrees/*` (or similarly node_modules-less)
worktree and you need real lint/typecheck/test/e2e signal before landing. For a quick
format/lint sanity check the worktree's root-binary Biome is fine; for the Definition of Done,
move to the primary checkout.

## Examples

```bash
# In the worktree — fast format/lint feedback only (works via nested resolution):
cd /<repo>/.claude/worktrees/<name>
/<repo>/node_modules/.bin/biome check --write apps/web/src/...   # OK
/<repo>/node_modules/.bin/vitest run apps/web/...               # FAILS: @vitejs/plugin-react not resolvable
/<repo>/node_modules/.bin/tsc -p apps/web/tsconfig.json         # FAILS: Cannot find module 'react' (every file)

# Authoritative gates — in the primary checkout, on the same branch:
cd /<repo>
git worktree remove /<repo>/.claude/worktrees/<name>   # work is already committed + shared via .git
git checkout <branch>
pnpm lint && pnpm typecheck && pnpm test
pnpm exec playwright test --project=electron tests/electron/<relevant>.spec.ts
git checkout main && git merge --ff-only <branch>      # land
```

---
title: Ensure pnpm e2e passes
status: active
date: 2026-06-08
origin: user request
execution: code
---

# Ensure pnpm e2e passes

## Problem Frame

`pnpm e2e` is the repo-wide acceptance gate. It runs the Chromium renderer smoke tests and the Electron Playwright suite against the built desktop app. The task is to make the full command pass from a clean checkout state without weakening product coverage or skipping specs.

Scope is limited to defects exposed by the current e2e suite and the minimal supporting tests needed to keep the fixes stable. Do not rewrite unrelated UI, schema, or domain flows.

## Requirements Trace

- Run and diagnose `pnpm e2e` in an isolated worktree.
- Fix real app, harness, or fixture drift that causes failures.
- Preserve Electron security boundaries: renderer uses `window.appApi`; no direct DB or filesystem access.
- Preserve restart/persistence assertions in specs.
- Keep roadmap state untouched unless the task explicitly maps to an unchecked roadmap item; this is a quality repair, not a new roadmap feature.

## Existing Patterns

- E2E harness: `tests/electron/launch.ts`, `playwright.config.ts`.
- Electron shell and IPC: `apps/desktop/src/main`, `apps/desktop/src/preload`.
- Renderer flows: `apps/web/src`.
- Shared factories and fixtures: `packages/testing/src`, `tests/electron/fixtures`.
- Prior learning search area: `docs/solutions/`.

## Implementation Units

### U1: Reproduce and classify failures

Files:
- Modify: none expected.
- Test: `tests/e2e/*`, `tests/electron/*`.

Approach:
- Run `pnpm e2e` once to capture the failing specs and first actionable errors.
- If the suite is too broad for fast iteration, shard by project/spec after the first run.
- Classify each failure as harness setup, selector/UI drift, data/fixture drift, async timing, or product behavior.

Test scenarios:
- Full command reports all initial failures.
- Targeted reruns reproduce each failure before a fix is applied.

Verification:
- Failure log is concrete enough to identify owned files for U2.

### U2: Repair failing behavior with focused tests

Files:
- Modify: only files directly implicated by U1.
- Test: existing Vitest or Playwright specs adjacent to the repaired behavior.

Approach:
- Prefer product fixes over test changes when the spec describes intended behavior.
- Update selectors or harness waits only when product behavior is correct and the test is stale or racing.
- Add or strengthen lower-level tests when a bug is in domain/main-process logic.

Test scenarios:
- Each fixed failure has a targeted command that passes.
- Restart/persistence specs still relaunch against the same data directory where required.
- Mutations still go through typed IPC and operation logging where applicable.

Verification:
- Targeted e2e specs pass.
- Relevant `pnpm test` subset passes when non-UI code changed.

### U3: Full verification and review hardening

Files:
- Modify: `docs/solutions/**` only during final compound step, if a reusable learning emerges.

Approach:
- Run `pnpm typecheck`, `pnpm test`, and `pnpm e2e`.
- Run `compound-engineering:ce-code-review` in report mode over the final diff and fix issues that are real defects or important test gaps.
- Run `compound-engineering:ce-compound mode:headless` without session-history search after all verification.

Test scenarios:
- Full `pnpm e2e` passes.
- Typecheck and unit tests pass.
- Review findings are resolved or explicitly rejected with rationale.

Verification:
- Final isolated worktree is green and committed.
- Result is landed on `main`, and `~/Code/interleave` is clean, on `main`, and at the final commit.

## Risks

- The full Electron suite is large and may expose multiple unrelated failures. Fix one cluster at a time and rerun targeted specs before the full command.
- Browser/Electron timing failures can tempt broad timeouts. Prefer deterministic readiness signals and stable selectors.
- Shared git metadata lives under `~/Code/interleave/.git`; branch/worktree and final landing may need sandbox escalation.

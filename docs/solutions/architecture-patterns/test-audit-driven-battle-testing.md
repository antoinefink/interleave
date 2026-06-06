---
title: Battle-testing matrix and test-hardening execution for core app surfaces
date: 2026-06-06
module: testing_framework
category: architecture-patterns
problem_type: workflow_issue
component: testing_framework
severity: low
tags: [testing, test-audit, battle-testing, ipc, shell, e2e]
---

# Battle-testing matrix and test-hardening execution for core app surfaces

## Problem

The application has broad domain scope, and risk was concentrated in places where UI actions cross into `window.appApi`, create persistence mutations, or drive scheduler/review state that must survive restarts. We needed a concrete matrix and focused test hardening on those seams, instead of only feature-focused checks.

## Context

- The objective covered renderer shell/help surfaces, local-db lineage and operation-log invariants, IPC contract validation, queue/review persistence, and restart continuity.
- The work is organized as a pragmatic first hardening slice, prioritized by failure impact and recovery cost.
- The canonical area list lives in `docs/test-battle-audit.md` (45 key areas, with coverage-gap mapping).

## Why This Matters

Battle testing needs both breadth and depth:
- breadth comes from a stable inventory of critical areas,
- depth comes from explicit invariants for schema boundaries, lineage, and restart behavior.

Without both, regressions appear in production paths that pass happy-path unit tests.

## Solution

1. Produced a 45-item test coverage matrix in `docs/test-battle-audit.md` to prioritize high-risk coverage gaps.
2. Expanded and added test coverage across the highest-impact surfaces:
   - `apps/web/src/help/help-data.test.ts`
     - deterministic normalization and synonyms,
     - duplicate suppression,
     - malformed input resilience,
     - stable ordering and perf guard.
   - `apps/web/src/help/HelpContext.test.tsx`
     - provider/no-provider behavior.
   - `apps/web/src/help/primitives.test.tsx`
     - primitive rendering invariants.
   - `apps/web/src/help/help-bodies.test.ts`
     - shape and integrity checks for help entries.
   - `apps/web/src/lib/appApi.test.ts`
     - fallback/no-op coverage for optional renderer-only settings/maintenance/backup app-API contracts.
   - `packages/local-db/src/extraction-to-card-operation-log.test.ts` (new)
     - end-to-end relation + log consistency for source→extract→card hops.
   - `apps/desktop/src/main/ipc.test.ts` (new)
     - malformed payload rejection before service invocation,
     - valid payload forwarding for high-risk IPC channels.
   - `apps/web/src/shell/CommandPalette.test.tsx` (new)
     - routed actions, context gates, and help event dispatch coverage (`interleave:open-help`, `interleave:start-tour`).
   - `apps/web/src/shell/Shell.test.tsx` (new)
     - shell help open/close event handling,
     - user menu help path navigation.
   - `tests/electron/mvp-flow.spec.ts` (new)
     - render-loop continuity check for review preview state across relaunch.
   - `packages/local-db/src/queue-action-service.test.ts` (in same hardening slice)
     - batch postpone + undo invariants and card defer behavior.

## What Didn't Work

- A narrow help-only test pass did not address IPC/lineage persistence seams.
- A manual checklist alone did not guarantee contract-level failures were blocked at boundary inputs.

## Why This Works

- The matrix provides stable priorities for future cycles.
- The added tests target high-risk seams with persistent effects.
- The suite now verifies both command contracts and durable state invariants before relying on renderer behavior.

## Prevention

- Keep `docs/test-battle-audit.md` as the canonical source for prioritized test work.
- Extend this slice in order:
  - remaining IPC channels and command payload variants,
  - queue catch-up/vacation adversarial edge cases,
  - restart replay for mixed source/extract/card graphs,
  - vault IO fault and corruption paths.
- For future mutation-path changes, add invariant tests for both `element_relations` and `operation_log` in the same commit.

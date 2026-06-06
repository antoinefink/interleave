---
title: "Test operation-log and IPC invariants for extract→card mutation paths"
date: 2026-06-06
module: testing_framework
category: architecture-patterns
problem_type: workflow_issue
component: local-db-ipc
severity: medium
tags: [testing, local-db, operation-log, ipc, schema-validation]
---

# Test operation-log and IPC invariants for extract→card mutation paths

## Problem

The extract-to-card pipeline crosses three risk surfaces at once:

- mutation logic in local domain repositories/services,
- persisted lineage rows in the relation graph,
- command validation at the IPC boundary.

A previously committed test for operation-log ordering existed, but the relation-row assertions were left as a broken placeholder and the `window.appApi` mutation path had limited malformed-payload coverage beyond a single queue command.

## Context

The work focused on making the test audit actionable rather than hypothetical by turning two concrete gaps into executable coverage:

1. End-to-end relation/log coherence for source → extract → card hops.
2. IPC payload validation before DB service invocation for `cards.create`.

## Why This Matters

In a local-first desktop system, mutation paths must be durable and deterministic. If:

- derived lineage edges and operation-log payloads diverge,
- IPC handlers accept malformed payloads before DB validation,

then recovery, review scheduling, and lineage-driven UI surfaces become inconsistent in ways that are expensive to debug after restart or after partial writes.

## Solution

### 1) Source → extract → card relation integrity test

In `packages/local-db/src/extraction-to-card-operation-log.test.ts`:

- Replaced the placeholder query with real assertions against `element_relations`.
- Added assertions for both edges:
  - `extract -> source (derived_from)`
  - `card -> extract (derived_from)`
- Kept payload checks against `operation_log` rows so operation events remain aligned with graph materialization.

### 2) IPC command schema hardening test

In `apps/desktop/src/main/ipc.test.ts`:

- Added test coverage for `cardsCreate` to verify the boundary rejects malformed payloads before calling the DB service.
- Added a positive-path assertion that a valid payload is forwarded unchanged to `dbService.createCard`.

### 3) Audit map update

In `docs/test-battle-audit.md`:

- Kept the full 45-area matrix.
- Marked newly implemented hardening in the pass summary.
- Reframed remaining gaps toward command paths and restart/e2e coverage not yet implemented.

## Why This Works

This pass converts silent blind spots into assertive checks at the two seams most likely to rot silently:

- persisted lineage graph state (`element_relations`), and
- schema-gated entry to mutation handlers.

The added tests are low-cost and high-signal for regressions while still leaving broader restart/E2E hardening work explicit for future cycles.

## When to Apply

Apply this pattern when introducing or refactoring any multi-step mutation path that is both lineage-sensitive and review-critical:

- extraction → card transformation,
- queue/maintenance/bulk updates,
- any command where one logical operation implies multiple DB writes.

## Prevention

- Keep mutation tests anchored to both operation-log and lineage assertions.
- Assert both negative (reject malformed input) and positive (forward valid payload) behavior at IPC boundaries.
- Keep a running test audit doc updated so follow-up work is explicitly prioritized, not deferred by assumption.

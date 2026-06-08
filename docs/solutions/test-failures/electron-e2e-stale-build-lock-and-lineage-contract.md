---
title: "Stabilize Electron E2E build locks and lineage contracts"
date: 2026-06-08
category: test-failures
module: Electron E2E harness
problem_type: test_failure
component: testing_framework
symptoms:
  - "`pnpm e2e` failed across Electron Playwright specs instead of isolating to one assertion."
  - "Electron E2E runs could wait on stale build locks or run against stale built artifacts."
  - "EPUB chapter extraction assertions disagreed with the source lineage contract."
  - "Keyboard queue tests depended on relative postpone state instead of deterministic due scheduling."
root_cause: test_isolation
resolution_type: test_fix
severity: high
related_components:
  - "apps/desktop DbService extraction contract"
  - "tests/electron launch helper"
  - "EPUB import E2E"
  - "keyboard queue E2E"
tags: [electron, playwright, e2e, build-lock, extraction-lineage, epub, queue]
---

# Stabilize Electron E2E build locks and lineage contracts

## Problem

`pnpm e2e` was failing and flaking across the Electron Playwright suite because several test contracts had drifted at once: the Electron launch helper could reuse stale bundles or collide during rebuilds, EPUB chapter extraction no longer proved the real lineage contract, and queue keyboard setup mutated the same state the shortcut assertion was meant to prove.

## Symptoms

- Electron E2E could run against old `dist` output after source changes.
- Parallel Playwright workers could collide on rebuilds or wait behind stale build locks.
- EPUB tests selected from a book-level route when the user contract required extracting from a chapter topic.
- The queue keyboard test used a postpone mutation as setup, then asserted that a keyboard postpone moved the due date later.

## What Didn't Work

- Checking only whether built Electron artifacts existed was too weak. Playwright launches the built main/preload and renderer output, so stale artifacts can satisfy an existence check while no longer matching source.
- A stale-lock threshold longer than the lock wait timeout made fresh orphaned locks unrecoverable during the failing run.
- Removing a stale lock path directly was unsafe because another worker could acquire a fresh lock between stale detection and deletion.
- Treating EPUB chapter extraction as book-level extraction missed the actual domain shape: a book source can own document-bearing chapter topics, and user selections happen in the chapter document.
- Using `extracts.postpone()` as E2E setup blurred setup and behavior under test, making the shortcut assertion dependent on previous scheduler state.

## Solution

Make the Electron E2E launch helper rebuild when runtime artifacts are missing or older than source roots that affect the desktop app:

```ts
function needsBuild() {
  const artifactMt = oldestMtime(requiredBuildArtifacts);
  if (!artifactMt) return true;

  const sourceMt = newestMtime(buildInputRoots);
  return !sourceMt || sourceMt > artifactMt;
}
```

Serialize rebuilds across Playwright workers with a repo-keyed lock. Record owner metadata, check whether the owner process is still alive, steal stale locks with an atomic rename, and put a timeout on each build step so a hung build releases the lock through `finally`:

```ts
function isLockStale(now = Date.now()) {
  const owner = readBuildLockOwner();
  if (owner?.pid) return !isPidAlive(owner.pid);

  const stat = fs.statSync(buildLockPath, { throwIfNoEntry: false });
  return stat ? now - stat.mtimeMs > staleBuildLockMs : false;
}

execFileSync("pnpm", ["--filter", "@interleave/web", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
  timeout: buildStepTimeoutMs,
});
```

Restore the EPUB E2E contract so the test opens a chapter topic, sets a chapter read point, extracts selected chapter text, and asserts both sides of lineage:

```ts
expect(location.sourceElementId).toBe(chapterId);
expect(data.source?.id).toBe(bookId);
```

Fix the extraction service contract behind that test. When extracting from a non-source document-bearing element, use the selected element as the parent/location anchor and preserve its root source as the lineage source:

```ts
const lineageSourceId =
  explicitParentId || originElement.type === "source"
    ? originElementId
    : originElement.sourceId;

this.extractionService.createExtraction({
  sourceElementId: lineageSourceId,
  parentId: explicitParentId ?? (originElement.type === "source" ? undefined : originElement.id),
  locations: request.locations,
});
```

Keep keyboard queue setup deterministic by scheduling the target item to a fixed due date with the queue scheduler API, then assert that pressing `p` moves that due date later.

## Why This Works

The E2E runner now executes against current source-derived bundles and prevents parallel workers from rebuilding the same output at the same time. Stale owner detection makes orphaned locks recoverable inside the wait budget, while atomic stale-lock stealing avoids deleting another worker's fresh lock.

The EPUB fix aligns the test with source lineage semantics. The selected text belongs to the chapter document the user opened, but the extract still traces evidence back to the imported book source. That keeps extracted-span marks, read points, jump-to-source behavior, and restart persistence coherent.

The queue keyboard test now isolates setup from the behavior under test. The shortcut assertion proves the keyboard path drove `queue.act` to postpone the current item, rather than re-observing a date produced by setup.

## Prevention

- Keep Electron Playwright launch helpers staleness-aware whenever tests run built artifacts instead of live source.
- Put timeouts and owner-liveness checks around cross-process test locks.
- When introducing document-bearing child elements, test both the local source-location anchor and the root lineage source.
- Prefer deterministic setup APIs in E2E tests; do not use the same mutation as both setup and assertion target.
- Update E2E selectors around user-facing contracts, not old implementation details.

## Related Issues

- [Battle-testing matrix and test-hardening execution for core app surfaces](../architecture-patterns/test-audit-driven-battle-testing.md) — related broad testing pattern; this learning is the concrete Electron E2E failure mode.
- [Test operation-log and IPC invariants for extract->card mutation paths](../architecture-patterns/extract-card-ipc-invariant-test-hardening.md) — related lineage/contract testing pattern.
- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md) — related queue contract documentation.

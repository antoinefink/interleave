# fix: Make /search result application interruptible with startTransition

**Plan type:** fix · **Depth:** Lightweight · **Date:** 2026-06-15

## Summary

The `/search` (Collection Explorer Search) input still stutters at normal typing
cadence even after two prior fixes (input isolation in `LibrarySearchField`, and
`useDeferredValue` + memoized rows). The residual cost is the **result-arrival
reconciliation**: when a search response lands, the success handlers call
`setResults` / `setSearchCounts` / `setSearchMode` as ordinary (urgent) updates, so
React reconciles the entire grouped result list synchronously — re-running
`highlight()` on every row because each response is a fresh object identity. At a
150 ms debounce this fires between essentially every keystroke, blocking the input.

The fix (solution #1): wrap the **result-application** setters in React 19
`startTransition` so that reconciliation runs at low priority and yields to
keystrokes, while keeping loading/error status updates urgent. The code already
*claims* this is done — comments at `apps/web/src/library/LibraryScreen.tsx`
(~line 370 and ~line 534) say result-arrival is "wrapped in a transition" — but no
`startTransition` exists anywhere in `apps/web/src`. This makes the comments true.

This is renderer-only, surgical, and behavior-preserving.

## Problem Frame

- **Symptom:** typing in `/search` lags a beat behind keystrokes at normal/deliberate
  cadence; a fast continuous burst is smooth (the debounce never settles mid-burst).
  That asymmetry confirms the cost is on the debounce-settle path, not the keystroke
  path.
- **Confirmed root cause:** result-arrival `setResults`/`setSearchCounts`/`setSearchMode`
  run as urgent updates → full, synchronous, non-interruptible reconciliation of the
  inline result list (`highlight()` per row, new object identity per response) landing
  between keystrokes. See `docs/solutions/performance-issues/search-typing-stutter-is-renderer-rerender-not-async-work.md`.
- **What's already in place (do not redo):** `LibrarySearchField` isolates the raw
  input + 150 ms debounce; `ResultRow`/`FilterBar` are `memo`-wrapped;
  `useDeferredValue(debouncedQuery)` defers the highlight. The missing piece is making
  the *result data* update itself interruptible.

## Requirements

- R1. Result-application updates (results, counts, mode) in all three async success
  paths of the search effect run as React Transitions (low priority, interruptible).
- R2. Loading and error UI stay urgent so spinners and errors still feel instant.
- R3. The existing out-of-order (`cancelled`) guard remains correct — stale responses
  must never overwrite a newer query's results/counts.
- R4. No behavior change to what renders: same results, same counts, same highlight,
  same empty/loading/error states, same stale-response protection.
- R5. The two false "wrapped in a transition" comments become accurate.
- R6. A regression guard exists for the deferral, and all existing LibraryScreen /
  LibrarySearchField tests still pass (adjusted only where transition timing requires
  async assertions — never weakened).

## Key Technical Decisions

- **KTD1 — Use standalone `startTransition` from `react`, not `useTransition`.** We do
  not need an `isPending` flag (no new spinner); the screen already has its own
  `loading` state. `startTransition(() => { setResults(...); setSearchCounts(...);
  setSearchMode(...) })` marks exactly those updates as Transitions. Called
  synchronously inside the promise `.then` (after the `await` has resolved, with only
  sync setState inside the callback) this is the supported React 18/19 pattern — the
  post-`await` location does not disqualify it because there is no `await` *inside* the
  `startTransition` callback.

- **KTD2 — Split urgent vs transition within each handler.** Keep `setError(null)` and
  `setLoading(false)` urgent on the failure path so errors/spinners are instant (R2).
  On the **success** path, decide and verify whether `setLoading(false)` should
  co-commit *inside* the transition with the results: keeping it urgent while results
  defer can cause a one-frame "No matches" flash on a *cold* search (loading flips off
  before the deferred rows commit). Co-committing `setLoading(false)` with the results
  on success avoids the flash (spinner persists until rows are ready) and still leaves
  the failure path instant. Resolve by observing both cold and warm searches in the
  running app; warm searches already skip `setLoading(true)` so they are unaffected.

- **KTD3 — The `cancelled` guard stays outside/before the transition.** The
  `if (cancelled) return;` check runs first; only the surviving (non-stale) update is
  wrapped. Wrapping changes the *priority* of the resulting render, not *whether*
  setState is called, so the stale-response invariant is preserved (R3).

- **KTD4 — `useDeferredValue(debouncedQuery)` stays.** It defers the highlight relative
  to the query; the new transition defers the result-data render. They are
  complementary, not redundant — one covers the highlight on a query change, the other
  covers the heavier full-list reconcile on data arrival. No conflict.

## Implementation Units

### U1. Wrap result-application setters in `startTransition`; correct the comments

**Goal:** Make result-arrival reconciliation interruptible in all three async success
paths of the search effect, keep status updates urgent, and make the two comments true.

**Requirements:** R1, R2, R3, R4, R5.

**Files:**
- `apps/web/src/library/LibraryScreen.tsx` (modify)

**Approach:**
- Import `startTransition` from `react`.
- In the search effect (the `useEffect` keyed on
  `[debouncedTerm, typeFilter, conceptFilter, priorityFilter, semanticAvailable]`),
  three async success handlers apply results:
  1. **Empty-query browse** `.then`: wrap `setSearchCounts(...)`, `setResults([])`,
     `setSearchMode(...)` in `startTransition`; keep `setError(null)` and the
     `.finally` `setLoading(false)` per KTD2.
  2. **Semantic** `.then`: wrap `setResults(res.results)`, `setSearchCounts(res.counts)`,
     `setSearchMode(res.mode)`.
  3. **FTS keyword** `.then`: wrap `setResults(res.results)`, `setSearchCounts(res.counts)`,
     `setSearchMode(...)`.
- In every case the `if (cancelled) return;` guard remains the first statement, before
  `startTransition` (KTD3).
- Keep `setError(null)` urgent (clearing an error should feel instant). Apply the KTD2
  decision for `setLoading(false)` on success consistently across the three paths.
- Update the two comments at ~line 370 ("The results-arrival reconciliation is
  additionally wrapped in a transition…") and ~line 534 to describe what the code now
  actually does, and remove any wording that implied it was already wrapped.

**Patterns to follow:** the existing per-path `let cancelled = false; … return () => {
cancelled = true; }` structure; the existing `useDeferredValue` import line for adding
`startTransition` to the `react` import.

**Test scenarios:** behavior covered by U2 (this unit changes update priority, not
output). Manual: in `pnpm dev`, type a multi-word query at normal cadence on a
populated vault and confirm the input no longer lags; confirm no "No matches" flash on
a cold search; confirm results, counts, highlight, empty, and error states are
unchanged.

**Verification:** `pnpm typecheck` clean; the running app shows smoother typing with
identical results.

### U2. Regression coverage + adjust transition-sensitive existing tests

**Goal:** Guard the fix and keep the suite green, converting only the assertions whose
timing changes under transitions to async — without weakening what they assert.

**Requirements:** R3, R4, R6.

**Files:**
- `apps/web/src/library/LibraryScreen.test.tsx` (modify)

**Approach:**
- Run the existing suite first. The stale-response tests ("keeps stale async search
  responses from overwriting filterbar counters", "keeps a stale empty-query browse
  response from overwriting a later keyword search") assert counts **synchronously**
  immediately after `await act(async () => resolve(...))`. Under a transition the
  applied update may settle after the `act` returns. If these assertions break, convert
  them to `await waitFor(...)` / `findBy*` — **preserving every assertion**, including
  the negative ones (the stale `"99"` must still never appear, the correct value must
  still show). This proves KTD3 (the `cancelled` guard) survives the change.
- Keep the existing U1 stutter regression test ("does NOT re-render the heavy results
  subtree on a keystroke") passing — it uses fake timers + `h.prioRenderCount`.
- Add one focused test asserting result application is deferred: using the existing
  `deferred<T>()` + `h.prioRenderCount` harness, after a result resolves, assert the
  rows still render correctly (the deferral does not drop or reorder results) and the
  stale-response ordering still holds. Note in a comment that jsdom flushes transitions
  within `act`, so the user-visible "interruptible" benefit is verified in the running
  app (before/after), while this test guards against output/ordering regressions.

**Patterns to follow:** the `h` hoisted mock block, `vi.mock("../lib/appApi", …)`, the
`deferred<T>()` helper, the partial-mock of `Prio` for `h.prioRenderCount`, and the
`await act(async () => { … })` flushing idiom — all already in
`apps/web/src/library/LibraryScreen.test.tsx`.

**Test scenarios:**
- Happy path: typing a query renders grouped results with the term highlighted (must
  still pass unchanged).
- Out-of-order: a later query's results/counts win over an earlier slow response
  (stale `"99"` never appears) — under transitions.
- Empty→results and results→empty transitions still show the right prompt/empty/loading
  states.
- Keystroke does not re-render the heavy subtree (existing U1 guard, must stay green).

**Verification:** `pnpm test` green for the library suite (and the full unit suite);
`pnpm lint` and `pnpm typecheck` clean.

## Scope Boundaries

### In scope
- Wrapping result-application setters in `startTransition` in `LibraryScreen.tsx`.
- Correcting the two now-false comments.
- Regression coverage and minimal transition-timing test adjustments.

### Deferred to Follow-Up Work (explicitly NOT in this change)
- **Solution #2** — stabilizing result-row object identity across responses (reconcile
  by id so unchanged rows skip re-render).
- **Solution #3** — tuning the 150 ms debounce length / idle-based debounce.
- **Solution #4** — reducing per-settle fan-out (the two `ReviewModeButton`
  `reviewModeCount` IPC round-trips; redundant `setResults` churn).

## Risks & Mitigations

- **R-A: Transition timing breaks synchronous test assertions.** Likely for the
  stale-response tests. Mitigation: convert those specific assertions to `await
  waitFor`/`findBy` without weakening them (U2). This is the expected, correct idiom for
  deferred updates.
- **R-B: Cold-search empty-state flash** if `setLoading(false)` stays urgent while
  results defer. Mitigation: KTD2 — co-commit `setLoading(false)` with results on
  success; verify cold + warm in the running app.
- **R-C: No observable behavior change / fix is inert.** Mitigation: manual before/after
  in `pnpm dev` on a populated vault is the primary proof (jsdom cannot observe frame
  yielding). The tests guard against regressions, not the perf win itself.

## Verification (Definition of Done)

1. `pnpm lint` clean.
2. `pnpm typecheck` clean.
3. `pnpm test` green (library suite + full unit suite).
4. Relevant Electron e2e for `/search` still passes (search typing/results path).
5. Manual before/after in `pnpm dev`: typing at normal cadence on a populated vault no
   longer stutters; results/counts/highlight/empty/error/stale-protection all unchanged;
   no cold-search empty flash.

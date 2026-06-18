---
title: "Search typing stutter is renderer re-render cost, not the nearby async work"
date: "2026-06-15"
last_updated: "2026-06-18"
category: "performance-issues"
module: "apps/web Collection Explorer search input"
problem_type: "performance_issue"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "Typing in the /search box stutters; characters lag a beat behind keystrokes."
  - "The lag is most noticeable on /search where semantic (embedding) results are shown."
  - "The faster you type, the more dropped/late frames in the input."
root_cause: "logic_error"
resolution_type: "code_fix"
related_components:
  - "service_object"
  - "testing_framework"
tags:
  - "search"
  - "react-rerender"
  - "input-lag"
  - "debounce"
  - "controlled-input"
  - "memoization"
  - "renderer-performance"
  - "embeddings"
  - "startTransition"
  - "concurrent-react"
  - "render-priority"
  - "css-custom-highlight-api"
  - "paint-cost"
  - "commit-phase"
  - "input-latency"
  - "throttle"
  - "background-jobs"
  - "performance-harness"
---

# Search typing stutter is renderer re-render cost, not the nearby async work

## Problem

Typing in the `/search` box stuttered — characters appeared a beat behind the
keystrokes. The natural hypothesis was that semantic search was generating the
query embedding *synchronously* on each keystroke and freezing the UI. That
hypothesis was wrong, and chasing it would have moved work that was already off
the hot path while leaving the stutter untouched.

## Symptoms

- Visible input lag while typing in `/search`; the field does not keep up with a fast typist.
- Correlated in the user's mind with embeddings ("it stutters when semantic search is on").
- Worse with a populated result list on screen.

## What Didn't Work (and why)

- **Assuming synchronous embedding generation was the freeze.** The query embedding
  already runs only in a DB-free `utilityProcess` worker (`apps/desktop/src/worker/embedding-model.ts`),
  reached over async `ipcRenderer.invoke` — there is no `sendSync` anywhere in the
  codebase. The query is also **debounced 150 ms** before any bridge call, so a fast
  typist fires **zero** embeds while typing. Moving or "awaiting less" of that work
  would have changed nothing the user feels.
- **Reaching for `useDeferredValue` on the query.** The heavy subtree does not derive
  from the raw input value at all — it derives from the *debounced* query and from
  search results. Deferring the input value solves a problem this screen does not have.

## Solution

The stutter was ordinary React controlled-input cost. `rawQuery` lived in the large
`LibraryScreen` component, so every keystroke called `setRawQuery` → a **synchronous
re-render of the whole screen**: the grouped result list (each row re-running a
`highlight()` tokenization pass) and the concept-heavy filterbar — none of whose data
changes on a keystroke. Only the input value changed.

Fix: **isolate the fast-updating input state.** Extract a small, memoized
`LibrarySearchField` (`apps/web/src/library/LibrarySearchField.tsx`) that owns the raw
text and its 150 ms debounce locally and emits only the debounced value upward via
`onDebouncedChange`. `LibraryScreen` keeps only the debounced query, which drives the
search effect and `highlight()`.

```tsx
// LibrarySearchField.tsx — owns the fast state; parent never re-renders on a keystroke
export const LibrarySearchField = memo(function LibrarySearchFieldImpl({
  syncQuery, syncToken, onDebouncedChange,
}: LibrarySearchFieldProps) {
  const [value, setValue] = useState(syncQuery);
  const emitRef = useRef(onDebouncedChange);            // latest emitter without
  useEffect(() => { emitRef.current = onDebouncedChange; }, [onDebouncedChange]); // restarting the timer
  useEffect(() => {                                      // external (route) sync + refocus
    setValue(syncQuery); inputRef.current?.focus();
  }, [syncToken]);                                       // keyed on a token, not the value
  useEffect(() => {                                      // debounce: depends only on `value`
    const id = setTimeout(() => emitRef.current(value), 150);
    return () => clearTimeout(id);
  }, [value]);
  // ...controlled <input value={value} onChange={e => setValue(e.target.value)} />
});
```

Because `rawQuery` no longer lives in `LibraryScreen`, a keystroke re-renders only the
tiny field; the parent (and its results/filterbar subtree) re-renders at most once per
150 ms debounce tick. Route-`q` changes still reset and refocus the field via a
monotonic `syncToken` (so a reset to the *same* `q` still re-syncs).

## Why This Works

A controlled `<input>`'s value only repaints after the owning component's render
commits. If the owner is large and its children are not memoized, every keystroke pays
the full reconciliation cost of the whole subtree synchronously — that latency *is* the
stutter. Moving the fast-changing state out of the heavy component removes the heavy
subtree from the keystroke→render path entirely. This is structurally guaranteed,
unlike wrapping the heavy children in `React.memo` (a valid alternative that breaks
silently the moment any downstream prop stops being referentially stable).

The `emitRef` indirection matters: if the debounce effect depended directly on
`onDebouncedChange`, a new callback identity from the parent would restart the timer and
drop or duplicate emissions. Pinning the latest callback in a ref and depending only on
`value` decouples *what to call* from *when to fire*.

## Prevention

- **Diagnose where the cost actually is before optimizing the obvious suspect.** "Input
  stutter near expensive async work" is usually renderer re-render cost, not the async
  work — especially when that work is already debounced and off-thread. Confirm with the
  React Profiler (which component commits on a keystroke) before moving anything.
- **Keep fast-updating input state out of large components.** A search/filter input that
  shares a component with a heavy result list will lag; isolate it.
- **Add a non-vacuous regression guard** that typing does not re-render the heavy subtree.
  Use a render counter on a row child and assert it is unchanged across a keystroke — and
  assert the counter is `> 0` first, so the test cannot pass trivially if the counted
  element is ever refactored away:

  ```tsx
  const before = h.prioRenderCount.current;
  expect(before).toBeGreaterThan(0);                 // guard: the counter is actually counting
  fireEvent.change(searchInput, { target: { value: "intelligencee" } });
  expect(searchInput.value).toBe("intelligencee");   // input updates immediately…
  expect(h.prioRenderCount.current).toBe(before);    // …heavy subtree did NOT re-render
  ```

## Follow-up (2026-06-15): the residual stutter was the *result-arrival* reconcile — fixed with `startTransition`

Isolating the input (above) removed the keystroke→parent-render cost, but typing at a
normal cadence still stuttered. At a ~150 ms debounce ≈ a normal inter-keystroke interval,
the debounce settles between essentially every character, and each settle applied the
search response with **urgent** `setState` (`setResults`/`setSearchCounts`/`setSearchMode`).
Because each IPC response is a fresh array with new row object identities, that busts the
`ResultRow` memo and forces a full, synchronous, non-interruptible reconcile of the whole
grouped list (`highlight()` per row) — landing right between keystrokes.

Two comments in `LibraryScreen.tsx` already *claimed* this reconcile was "wrapped in a
transition (see the search effect)". **It wasn't** — `grep -r startTransition apps/web/src`
returned zero hits. Lesson: verify the mechanism exists; don't trust a "we already do this"
comment. The fix was to actually do it — wrap the result-application setters in React 19
`startTransition` in all three async paths (empty-query browse, semantic, FTS):

```tsx
const applyResults = (apply: () => void) => {
  setError(null);                 // URGENT: clearing an error is instant
  startTransition(() => {         // LOW priority: interruptible, yields to keystrokes
    apply();                      // setResults / setSearchCounts / setSearchMode
    setLoading(false);            // co-commit with the rows (no cold-search empty flash)
  });
};
const handleError = (e: unknown) => {            // URGENT on failure
  if (cancelled) return;
  setError(e instanceof Error ? e.message : String(e));
  setLoading(false);
};
// each .then: `if (cancelled) return;` <eager ref sync>; `applyResults(() => { ...setters })`
```

### Gotchas this surfaced

- **`startTransition` is complementary to `useDeferredValue`, not redundant.** The existing
  `useDeferredValue(query)` defers only the *highlight* relative to the query; it does
  nothing for the *result-data* reconcile that `setResults` forces (new identities every
  response). You need the transition around the setState for that.
- **State derived-via-effect from transition-committed state can be read stale by urgent
  code.** `hasResultsRef` (the warm-search "keep old rows, skip the spinner" guard) was
  maintained by `useEffect(() => { hasResultsRef.current = results.length > 0 }, [results])`.
  Once `results` commits via a *low-priority* transition, that effect lags — a rapid
  follow-up query's *urgent* search effect can read the stale ref and re-flash the spinner.
  Fix: set the ref **eagerly/synchronously** in each success handler (before
  `startTransition`), where the urgent path needs it.
- **`.finally(() => setLoading(false))` doesn't survive being split across a transition.**
  Moving `setLoading(false)` into the success transition *and* the `.catch` scattered it to
  six sites (a stuck-spinner trap). An `applyResults()`/`handleError()` helper pair restores
  "loading clears on exactly one outcome — never both, never neither".

### Testing impact (important)

Wrapping result application in a transition breaks tests that read result-derived DOM
**synchronously right after `await waitFor(() => expect(mock).toHaveBeenCalled())`** —
`waitFor` resolves when the mock was *called*, before the `.then`/transition *commits*. The
correct idiom is to await the **content**, not the mock:

```tsx
// BEFORE (flaky under transitions): waitFor on the mock, then a sync DOM read
await waitFor(() => expect(h.searchQuery).toHaveBeenCalled());
expect(within(chip).getByText("7")).toBeTruthy();          // reads pre-commit state -> fails
// AFTER: await the rendered value
await waitFor(() => expect(within(chip).getByText("7")).toBeTruthy());
```

`await act(async () => promise.resolve())` **does** flush transitions in jsdom, so
`act`-based tests keep passing — which can *mask* the issue and means jsdom cannot observe
the interruptibility itself. Verify the actual smoothness in the running app (`pnpm dev`).
A falsifiable signature: a fast *continuous* typing burst stays smooth (the debounce never
settles mid-burst) while *deliberate* typing is what stutters — so the cost is on the
debounce-settle path, not the keystroke path.

## Follow-up (2026-06-18): `startTransition` was NOT enough — the real cost is the synchronous COMMIT+PAINT, and it has TWO triggers

The `startTransition` fix shipped in v0.6.0 and the user reported the box **still** stuttered.
Re-debugging with a **real-renderer performance harness** (Playwright driving the *production*
Electron build, a CDP `Tracing` capture parsed into main-thread **self-time** buckets, plus the
in-page **Event Timing API** for per-keystroke input latency, plus an A/B on result-row count)
falsified the earlier conclusion and found two *distinct* causes. jsdom cannot see either — both
are paint/commit costs — which is why every prior render-phase fix "passed tests" yet did nothing.

**Lesson 0 (method): measure, don't reason.** Three consecutive fixes (input isolation,
`useDeferredValue`, `startTransition`) were all plausible and all useless because nobody profiled
the running app. The harness made every claim falsifiable: it caught a wrong fix in the act —
`content-visibility: auto` on `.result` rows (a "skip off-screen paint" idea) measured **worse**
(~4× the paint events, no drop in dropped frames), because it adds per-frame intersection/size
reconciliation. Do not retry it. The headline metric is **slow keystrokes (>50ms input latency)**;
the in-run **bare-`<input>` baseline** controls for machine/harness overhead.

**Cause A — the dominant one, present even with the index fully built.** `startTransition` makes
the *render* interruptible, but React's **commit** and the browser's **style→layout→paint** are
synchronous and uninterruptible. Highlighting was an `<em>` produced inside every `ResultRow` from
a `query` prop, so each debounce-settle (≈ every keystroke at deliberate speed) re-rendered every
row AND mutated each row's DOM (splitting text around the moving `<em>`) → a synchronous
recalc/layout/paint whose cost **scaled with the visible row count** (measured: ~25–35% of
keystrokes dropped frames at 34–50 rows; **near-zero at 0 rows**; Paint/Composite-bound, Script
minor). Fix: take highlighting **out of React** via the **CSS Custom Highlight API**
(`useSearchHighlight` + `::highlight(library-search-hit)` in `library.css`). Rows render plain text
once; a query change becomes a paint-only highlight-registry update — no re-render, no DOM
mutation. `RecalcStyle` 24→4ms, `Layout` 46→18ms, **slow keystrokes 26→9 at 34 rows** (≈ the
bare-input baseline). Note: highlight pseudos only honor a few properties, so the former `<em>`'s
rounded padding is dropped for a plain background — the deliberate trade.

**Cause B — distinct, only while indexing (the "stutters when I add lots of elements" case).**
`LibraryScreen`'s `appApi.subscribeJobs(... if embed → refreshSemantic())` was **unthrottled**.
The job runner emits *hundreds of `embed` events/sec* during a large add; each did an IPC round-trip
(`semanticStatus`) + 3 `setState`s, re-rendering the whole screen. The harness saw `/search` sit at
**~90fps continuous repaint while idle** (Home = 0fps) with ~350 IPC msgs/sec, the loop decaying
exactly as embeddings drained. Fix: an **immediate-then-coalesce throttle**
(`EMBED_REFRESH_THROTTLE_MS`) — the readout still advances live, but a burst can't pin the main
thread. Beware the trap that wasted a profiling pass: seeding ~1000 elements to reproduce the bug
*triggered mass embedding*, so Cause B masqueraded as the whole problem until the index was driven
to a genuinely quiesced state and typing was re-measured (still stuttered → Cause A).

### Prevention

- **Keep highlighting (and any per-keystroke decoration) off the per-row React render.** A row that
  takes the live query as a prop will re-render + repaint the whole result list every keystroke.
- **Throttle anything driven by background-job events** before it calls `setState` — embed/clean/OCR
  progress can fire at hundreds/sec.
- Regression guards added: `firstMatchIndex` unit test (the match rule); a guard that result rows
  contain **no inline `<em>`** (a regression to per-row highlight would reintroduce the stutter); a
  throttle unit test (a 25-event burst → ≤2 `semanticStatus` reads); and an Electron e2e asserting
  the `CSS.highlights` registry is populated with the matched term (the highlight is invisible to
  jsdom, so it must be checked in real Chromium).

## Related

- [[command-palette-source-lookup-search-query]] — the ⌘K palette shares the same debounce + stale-response discipline.
- [[local-only-semantic-search-sqlite-vec-model-isolation]] — why the query embed is off-thread (worker) in the first place.

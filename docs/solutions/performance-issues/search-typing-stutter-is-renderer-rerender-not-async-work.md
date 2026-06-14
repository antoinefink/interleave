---
title: "Search typing stutter is renderer re-render cost, not the nearby async work"
date: "2026-06-15"
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

## Related

- [[command-palette-source-lookup-search-query]] — the ⌘K palette shares the same debounce + stale-response discipline.
- [[local-only-semantic-search-sqlite-vec-model-isolation]] — why the query embed is off-thread (worker) in the first place.

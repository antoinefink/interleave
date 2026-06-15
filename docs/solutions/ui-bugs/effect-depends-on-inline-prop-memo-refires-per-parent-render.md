---
title: Effect keyed on an inline-prop-derived object memo refires every parent render
date: 2026-06-15
category: ui-bugs
module: apps/web (React renderer) — queue SessionAssemblyPreview
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "A useEffect that fetches/derives per-item state re-runs on every unrelated parent re-render"
  - "Derived UI (preset card consequences) blanks and refills repeatedly; redundant IPC/network calls fire"
  - "An in-code comment claims the dependency is stable, but it churns identity each render"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [react, useeffect, referential-stability, inline-prop, json-key, strictmode, seq-guard, playwright-innertext]
---

# Effect keyed on an inline-prop-derived object memo refires every parent render

## Problem

A React effect that depends on an object produced by `useMemo([...inlineProp])` re-fires on
**every parent re-render**, not just when the dependency's *content* changes. Both mount sites of
`SessionAssemblyPreview` pass `request` as a fresh inline object literal, so the panel's preset-
preview effect refired constantly — firing three redundant `appApi.previewSessionPlan` IPC calls
and blanking each preset card's "N items / X% full" consequence on every Home/Queue re-render.

## Symptoms

- The preset-preview effect (keyed on `[baseRequest, open]`, where `baseRequest = useMemo(() => ({...request, ...asOf}), [asOf, request])`) re-ran whenever the parent re-rendered for any reason (queue poll, undo event, row action).
- Each re-run called `setPresetOutcomes(new Map())`, visibly wiping all preset card consequence labels, then refetched all three previews.
- An in-code comment asserted the dependency was "stable across re-renders" — it was not. The defect was invisible to the test suite (no test re-rendered the component with a fresh prop).

## What Didn't Work

- **Reasoning by analogy to the main `load`.** The existing `load` "tolerates" the same inline prop, so the new effect was keyed on the object the same way. But `load` is actually keyed on the **stringified** `requestKey` (a value-stable string), while the preset effect was keyed on the **object** `baseRequest` (identity-unstable). Same-looking, opposite stability — the analogy was wrong.
- **Stabilizing only the mount sites.** Memoizing/hoisting the `request` prop at `HomeScreen`/`QueueScreen` would help, but it leaves the component fragile: any future caller passing an unstable prop reintroduces the thrash. The fix belongs in the component.

## Solution

Derive a **value-stable object** from a stable JSON key, then depend on that object:

```tsx
// Before — `baseRequest` gets a fresh identity whenever the parent re-renders
// with a new `request` literal, so the effect refires.
const baseRequest = useMemo(() => ({ ...(request ?? {}), ...(asOf ? { asOf } : {}) }), [asOf, request]);
useEffect(() => { /* fetch 3 presets */ }, [baseRequest, open]);

// After — the JSON string is value-stable across parent re-renders (equal content
// produces an === string), so the parsed object keeps a constant identity too.
const baseRequestKey = useMemo(
  () => JSON.stringify({ ...(request ?? {}), ...(asOf ? { asOf } : {}) }),
  [asOf, request],
);
const baseRequest = useMemo(() => JSON.parse(baseRequestKey), [baseRequestKey]);
useEffect(() => {
  const seq = presetSeqRef.current + 1;
  presetSeqRef.current = seq;
  // ...fetch, guarding each resolve with `if (presetSeqRef.current !== seq) return;`
  return () => { presetSeqRef.current += 1; }; // invalidate in-flight on dep-change/unmount
}, [baseRequest, open]);
```

The `JSON.stringify` → `JSON.parse` round-trip is the trick: depending on the parsed object (not the raw string) lets the effect consume an object-shaped dependency while inheriting the string's value-stability.

## Why This Works

`useMemo([request])` recomputes whenever `request`'s **identity** changes, and a child receives a new prop identity every time its **parent** re-renders with an inline literal (`request={{ mode: "full" }}`). A child's own `setState` re-render keeps the same prop reference, which is why the bug only surfaces on parent renders. Routing the dependency through `JSON.stringify` collapses identity churn to value equality: equal content yields an `===` string, so the downstream `JSON.parse` memo returns a cached object with stable identity, and the effect's dependency only changes when the filters/clock actually change.

The seq-counter guard (`presetSeqRef`, mirroring the existing `loadSeqRef`) keeps it StrictMode-safe and lets the cleanup invalidate in-flight previews — deliberately **not** a `mountedRef` (see related doc).

## Secondary gotcha — CSS `text-transform` changes Playwright `innerText()`

The split layout styles the left-out header as an uppercase section label
(`text-transform: uppercase`). Playwright's `innerText()` returns the **rendered** text (it applies
`text-transform`), so `getByTestId("session-cut-count").innerText()` read `"LEFT OUT 2 ITEMS"`,
while a cross-component assertion compared it against the `/process` summary's sentence-case
`"Left out 2 items"` — a false failure. Fix: compare case-insensitively (a `RegExp(..., "i")`), or
read `textContent` (the un-transformed DOM string) when the casing is incidental. jsdom does **not**
apply CSS, so unit tests using `toHaveTextContent` never see this — it only bites in real-browser
Electron e2e.

## Prevention

- When an effect depends on an object/array derived from a prop, ask "does this prop come from an inline literal in the parent?" If so, key the effect on a value-stable signature (JSON string, or `JSON.parse` of one for an object dep), never the raw memo.
- Add a regression test that **re-renders with a fresh, value-equal prop** and asserts the effect did not refire (e.g., a specific preview's call count stays constant). RTL `render().rerender(...)` with a new object literal reproduces the parent-render trigger; isolate on a value only the effect (not the main load) requests.
- Prefer the seq-counter idiom over `mountedRef` for async-effect guards; add an effect cleanup that bumps the seq so late resolves can't write stale state.
- In Electron e2e, prefer case-insensitive matches or `textContent` for text that a component may style with `text-transform`.

## Related

- [[advisory-suggestion-engine-patterns]] — same root-cause family (unstable-ref effect refire blanking derived state); that doc stops at a stable string signature, this is the inline-prop-from-parent variant whose fix reconstitutes an object via `JSON.parse`.
- [[session-assembly-read-model-accepted-deck-handoff]] — owns the `previewSessionPlan` preview architecture and the `loadSeqRef`/`requestKey` seq-guard idiom this fix mirrors.
- [[strictmode-mountedref-cleared-only-on-cleanup]] — the inverse StrictMode async-effect failure (a guard that wrongly *suppresses*); this learning is StrictMode-safe via a seq-counter, deliberately not a `mountedRef`.
- [[search-typing-stutter-is-renderer-rerender-not-async-work]] — same referential-stability family; that one isolates fast input state, this one stabilizes an unstable prop-derived dependency.

---
title: "Inbox list rows: a Tailwind ring stacks on the border, and the native focus outline leaks"
date: 2026-06-15
category: ui-bugs
module: apps/web Import & Inbox (InboxGroupedList GroupedRow)
problem_type: ui_bug
component: frontend_stimulus
symptoms:
  - "Focused inbox row drew a thick orange ring, heavier than focus cues anywhere else in the app"
  - "Selected inbox row drew a doubled ~2px edge (a 1px accent border with a 1px inset ring on top)"
root_cause: incomplete_setup
resolution_type: code_fix
severity: low
tags: [focus-ring, focus-visible, outline, tailwind, design-system, accessibility, inbox, native-focus-outline]
---

# Inbox list rows: a Tailwind ring stacks on the border, and the native focus outline leaks

## Problem
The focused / selected row in the Import & Inbox list (`apps/web/src/pages/inbox/InboxGroupedList.tsx`, the `GroupedRow` component) rendered a border visibly thicker than the equivalent cue everywhere else in the app. Two independent causes stacked: a leaked native browser focus outline, and a Tailwind `ring` painted on top of the row's `border`.

## Symptoms
- The keyboard-cursor row showed a thick **orange** ring that matched no design token.
- A clicked (selected) row showed a doubled ~2px edge instead of one clean line — heavier than the queue's active row or any other list selection.

## What Didn't Work
- **Assuming the orange came from app CSS.** The cursor ring was `ring-2 ring-border-strong ring-inset`, and `--border-strong` is a neutral light gray — it cannot render orange. The orange was Chromium's **native `:focus-visible` outline**, which on macOS is drawn with `-webkit-focus-ring-color` = the user's **system accent color**. It leaked because `GroupedRow` was the only focusable list-row in the app that never reset `outline` (`.btn`, `.chip`, `.tree-node`, the queue's `display:contents` open button, and Settings inputs all already do `focus:outline-none` or draw no box). There is **no global outline reset** in the renderer, so any custom focusable element that omits it leaks the OS-accent ring.
- **First-pass fix: `ring-2` → `ring-1` plus `focus:outline-none` and a `focus-visible:ring-1` fallback.** This killed the orange outline and halved the cursor ring, but a **selected + cursor** row still stacked a 1px `border` and a 1px `ring` → a doubled ~2px edge. Still too thick. The lesson: a Tailwind `ring` is a **box-shadow painted in addition to the element's `border`**, so any `border` + `ring` combination reads as two edges no matter how thin each one is.

## Solution
Suppress the native outline, then collapse to a **single 1px border** that changes color by state — no `ring` at all. Selection wins the border color + soft fill; the roving keyboard cursor takes a stronger border only on rows that are not already selected. This mirrors the queue's active-row treatment (`.qitem--active` = a 1px `border-color` change, no ring).

```tsx
// BEFORE — accent border + an inset ring stacked on top (doubled edge),
// and no outline reset (native OS-accent outline leaks on focus).
const base =
  "flex w-full cursor-pointer items-start gap-2.5 rounded-md border px-3.5 py-3 text-left";
const fill = selected
  ? "border-accent-soft-bd bg-accent-soft"
  : "border-transparent hover:bg-surface-2";
const ring = cursor ? "ring-2 ring-border-strong ring-inset" : "";
// className={`${base} ${fill} ${ring}`}

// AFTER — one 1px border carries both cues; native outline suppressed.
const base =
  "flex w-full cursor-pointer items-start gap-2.5 rounded-md border px-3.5 py-3 text-left focus:outline-none focus-visible:border-border-strong";
const fill = selected ? "bg-accent-soft" : "hover:bg-surface-2";
const border = selected
  ? "border-accent-soft-bd"
  : cursor
    ? "border-border-strong"
    : "border-transparent";
// className={`${base} ${fill} ${border}`}
```

The base keeps a (transparent) `border` on every row, so switching color per state never shifts layout by a pixel.

## Why This Works
- A `ring` and a `border` are two separately painted edges; the only way to a true single 1px edge is to fold both visual states into one `border-color`. Removing the ring removes the second edge.
- `focus:outline-none` removes the leaked native `:focus-visible` outline (the orange OS-accent ring), bringing the row in line with every other interactive surface, which already suppresses the native outline and supplies its own controlled indicator.
- `focus-visible:border-border-strong` keeps a 1px keyboard-focus indicator (a11y) without reintroducing a ring; the roving-cursor state reuses the same color, so cursor and keyboard focus look identical and stay 1px.

## Prevention
- **For focusable list rows, change `border-color` rather than adding a `ring`.** Reserve `ring-*` for elements that have no border. A `ring` always stacks on top of a `border`, so the two together read as a doubled edge even at `ring-1`.
- **Every custom focusable element needs `focus:outline-none` (plus a controlled indicator).** The renderer has no global outline reset, and the native `:focus-visible` outline uses the OS accent color — it will leak and look inconsistent across machines (orange here, blue elsewhere) until suppressed.
- **When a focus ring's color matches no design token, suspect the native outline first** (`-webkit-focus-ring-color` / macOS system accent) before hunting through app CSS.
- Match the established convention: the queue's `.qitem--active` (a 1px `border-color` change) is the reference treatment for an active/cursor row.

## Related Issues
- `docs/solutions/ui-bugs/renderer-button-cursor-baseline.md` — sibling "drop the native OS affordance, supply a controlled replacement" fix (cursor affordance, set globally in `@layer base`); this doc completes it for the one focusable list-row that still leaked the native focus outline.
- `docs/solutions/design-patterns/scope-ported-design-kit-css-under-page-root.md` — the scoping/cascade discipline that keeps such baselines in one place instead of scattered per-component.
- `docs/solutions/ui-bugs/inbox-row-metadata-nowrap-compact-counts.md` — adjacent incremental polish on the same inbox row.
- **Gotcha when editing this file:** `InboxGroupedList.tsx` contains an intentional NUL-byte sentinel (`OTHER_KEY = "\x00other"`), so git treats it as **binary** — `git diff` shows "Binary files differ", commit stats read `0 insertions/0 deletions`, and `grep`/`rg` suppress matches. Use `grep -a` / decode the blob to review changes. Do not "fix" the NUL; it's load-bearing.

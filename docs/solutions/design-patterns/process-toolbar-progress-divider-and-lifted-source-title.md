---
title: "Process toolbar: full-width progress line as divider, source-gated band title, sr-only readout"
date: 2026-06-21
category: docs/solutions/design-patterns
module: apps/web process queue session band (ProcessSessionControls, process-queue.css)
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "A session/queue band needs a bottom divider AND a progress indicator — make the full-width progress line double as the divider instead of stacking a separate border-bottom"
  - "Lifting a per-type field (e.g. a title) into a shared band that also renders loading/done/empty panels"
  - "A per-type value must not flash on the shared loading/done panels during a reload — gate it on an already-derived isRenderingX guard, not the raw data type"
  - "Building a screen-reader readout for a visually separator-joined count/estimate (e.g. 'N / total · M left') that would otherwise be announced literally"
  - "Choosing an unfilled-track / structural color on the dark canvas where --sunken washes out"
tags: [process-queue, review-session, progress-indicator, divider, dark-mode, design-tokens, accessibility, sr-only, shared-band, ellipsis]
---

# Process toolbar: full-width progress line as divider, source-gated band title, sr-only readout

## Context

The Process queue's session band (`.pq-session`) carries the run-wide chrome: a progress readout, the mode segmented control, and the End-session button. Three frictions accumulated as that band evolved:

1. **The progress signal was split awkwardly.** A textual "N / total · M left" readout lived inline in the row, but there was no continuous *visual* progress, and the band's bottom edge was just a flat `border`. Two separate affordances (a border + a text readout) were doing one job. The visual bar that did exist was capped at `max-width: 360px`, so the "line" was a short segment, not full width.
2. **The source title had no home.** A source document used to render its heading in a dedicated `.pq-source__header` band below the toolbar — a whole vertical band spent on one line of text, shrinking the reading viewport.
3. **The "·"-separated readout read badly to screen readers.** `1 / 3 · 2 left` is spoken as "one slash three middle-dot two left" — noise. The visually compact readout actively hurt the non-visual experience.

The fix folded all three into the shared band: a full-width progress *line* that doubles as the band's divider, the source title lifted into the toolbar row, and a visually-hidden spoken label decoupled from the visual spans. The three lessons below generalize beyond this one toolbar.

## Guidance

### 1. A full-width progress line that doubles as the band's bottom divider

Split the band into a content **row** plus a flush **full-width bar**. The bar replaces the band's bottom `border`, so the unfilled track must use the **divider** token, not a recessed/sunken one — a sunken fill is invisible on the dark canvas.

```css
.pq-session {            /* the band is now a flex COLUMN: row on top, bar below */
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding-bottom: var(--s-3);
}
.pq-session__row {
  display: flex;
  align-items: center;
  min-height: var(--s-9);
  gap: var(--s-4);
}
.pq-progress__bar {
  width: 100%;
  height: 3px;
  /* The line doubles as the band's bottom divider (it replaced the border), so
     the unfilled track uses the divider token — visible in light AND dark, unlike
     the recessed --sunken which washes out on the dark canvas. */
  background: var(--border);   /* NOT var(--sunken) */
  overflow: hidden;
}
.pq-progress__fill {
  height: 100%;
  background: var(--accent);
  transition: width var(--fast) var(--ease);
}
```

```tsx
<div className="pq-session">
  <div className="pq-session__row">{/* readout · title · modes · End */}</div>
  <div className="pq-progress__bar" aria-hidden>
    <span className="pq-progress__fill" style={{ width: `${fillPct}%` }} />
  </div>
</div>
```

The compact textual readout stays `flex: 0 0 auto` so it never grows — the title slot beside it absorbs the slack, and the *visual* progress is carried entirely by the bar.

### 2. Lift a per-type item title into the shared band via an optional, source-gated prop

The title moves out of the type-specific header into the shared `ProcessSessionControls`, but only for sources. Pass it as an **optional** prop computed from the render-state-derived `isRenderingSource` — never from raw `current?.type`, so the loading/done panels (which also render the band) don't flash the previous item's title mid-reload.

```tsx
// isRenderingSource = !deckLoading && !done && current?.type === "source"
const sessionControls: ProcessSessionControlsProps = {
  cursor, total, done, remaining, mode,
  // Gated on isRenderingSource (NOT deckLoading, NOT done) so the loading/done
  // panels never flash the prior source's title mid-reload.
  itemTitle: isRenderingSource ? (inspector?.element.title ?? current?.title) : undefined,
  onModeChange, onAdjust, onEnd,
};
```

```tsx
type ProcessSessionControlsProps = {
  /* … */
  /** Source heading, lifted into the toolbar row. Source items only;
      omitted/empty for every other type and the loading/done panels. */
  itemTitle?: string | undefined;
};

function ProcessSessionControls({ itemTitle, /* … */ }: ProcessSessionControlsProps) {
  const title = itemTitle?.trim();
  return (
    <div className="pq-session__row">
      {/* …readout… */}
      {title ? <h1 className="pq-session__title" title={title}>{title}</h1> : null}
      {/* …modes, End… */}
    </div>
  );
}
```

Render it as the single document `h1`, truncated, with the full text on a hover `title` attribute:

```css
.pq-session__title {
  flex: 1 1 auto;     /* absorbs the row's slack */
  min-width: 0;       /* REQUIRED for ellipsis inside a flex child */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--t-sm);
  font-weight: 600;
}
```

Preserve the **"title appears exactly once"** invariant. The generic card-body title block is already suppressed for sources and cards, so lifting the source title in does not create a second heading:

```tsx
{/* metadata row — cards carry identity in .pq-rc header; sources now in the band */}
{!isSource && !isCard ? (
  <>
    <div className="pq-card__meta">{/* chips */}</div>
    <h1 className="pq-card__title">{titleFor(item)}</h1>
  </>
) : null}
```

When the inline title is dropped at narrow widths, drop only the *visual* node — the text still lives on the hover `title` and in the Inspector, so nothing is lost:

```css
@media (max-width: 760px) {
  .pq-session__title { display: none; }
}
```

### 3. Visually-hidden progress readout: spoken label + aria-hidden visual spans

Emit one clean spoken string in an sr-only node, and mark every visual span `aria-hidden` so the "·"-separated readout is never read literally.

```tsx
const spokenProgress = done
  ? "Session complete"
  : `${position} of ${total}, ${remaining} remaining`;

<div className="pq-progress">
  <span className="pq-progress__sr">{spokenProgress}</span>
  <span className="pq-progress__count" aria-hidden>{position} / {total}</span>
  <span className="pq-progress__sep" aria-hidden>·</span>
  <span className="pq-progress__est" aria-hidden>{done ? "all done" : `${remaining} left`}</span>
</div>
```

Hide the spoken node with the `clip` + `clip-path` recipe (do **not** use `display:none` or `visibility:hidden` — those drop it from the accessibility tree too):

```css
.pq-progress__sr {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  clip-path: inset(50%);   /* `clip` is deprecated; keep both */
  white-space: nowrap;
  border: 0;
}
```

## Why This Matters

Each pattern closes a specific failure mode:

- **Divider token, not `--sunken`, for the unfilled track.** When a progress line replaces a divider it is on-canvas at all times — including the dark theme. `--sunken` is tuned to recede against light surfaces and washes out to near-invisibility on the dark canvas, so the bar (and with it the band's only bottom edge) silently disappears in dark mode. `--border` is the divider contrast token by definition and reads in both themes. (Caught only in a dark-mode screenshot pass — jsdom/css-contract tests cannot see it.)
- **Source-gated `itemTitle` on the render state, not the raw type.** The shared band renders on the active item *and* on the loading and done panels. If the title were gated on `current?.type === "source"` (or passed unconditionally), the band would keep showing the just-finished source's heading while the next deck loads, or on the "Queue clear" panel — a stale-content flash. Gating on `isRenderingSource` (`!deckLoading && !done && type === "source"`) makes the title strictly a property of "we are actively showing a source right now," so panels render titleless. (This exact leak was flagged in code review by two independent reviewers.)
- **Optional prop + the existing `{!isSource && !isCard}` guard = one h1.** Lifting the title without removing the old source header, or without the body-title suppression, would produce two document headings — bad for both visual hierarchy and assistive navigation. The optional prop plus the pre-existing guard keeps the "title appears exactly once" invariant intact while moving *where* that once-title lives.
- **sr-only spoken label + aria-hidden spans.** A screen reader voicing `1 / 3 · 2 left` produces "one slash three middle-dot two left" — the typographic separators become spoken garbage. Splitting concerns (one human-readable spoken string; the compact glyphs hidden from the a11y tree) gives sighted users the dense readout and screen-reader users a clean sentence, with no duplication. `clip`/`clip-path` (not `display:none`) keeps the spoken node in the accessibility tree while removing it visually.

## When to Apply

- **Pattern 1** — any toolbar/header band that wants a continuous progress indicator *and* a bottom edge. Fuse them: one full-width line, divider token for the track, accent for the fill. Reach for this instead of stacking a separate border under a separate progress widget.
- **Pattern 2** — when content (a title, status, breadcrumb) currently renders per-variant and you want to hoist it into a shared chrome component that is *also* shown in transitional states (loading/empty/done). Make the prop optional and gate it on a render-state-derived boolean, not the raw data type. Always check whether hoisting breaks an "appears exactly once" invariant before shipping.
- **Pattern 3** — any compact readout that uses non-alphanumeric separators (`·`, `/`, `|`, `→`) or glyph-only state. Provide a spoken alternative and `aria-hidden` the decorative spans. Use the `clip`/`clip-path` sr-only recipe, never `display:none`.

## Examples

**Track token swap (the dark-mode fix in one line):**

```css
/* Invisible on the dark canvas — DON'T */
.pq-progress__bar { background: var(--sunken); }
/* Visible in light AND dark, and serves as the divider — DO */
.pq-progress__bar { background: var(--border); }
```

**Stale-flash prevention (the gate is load-bearing):**

```tsx
// WRONG — band shows the finished source's title while the next deck loads / on "done"
itemTitle: current?.type === "source" ? current.title : undefined,
// RIGHT — title is a property of "actively rendering a source", so panels stay titleless
itemTitle: isRenderingSource ? (inspector?.element.title ?? current?.title) : undefined,
```

**Truncating title in a flex row (the `min-width:0` gotcha):**

```css
.pq-session__title {
  flex: 1 1 auto;
  min-width: 0;          /* without this, the flex child refuses to shrink and ellipsis never triggers */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

## Related

- [Process Queue Inline Session Controls](../ui-bugs/process-queue-inline-session-controls.md) — the parent decision that moved progress *into* the per-item `ProcessSessionControls` band (no page-level bar). This doc extends that same band with the full-width progress divider and the optional `itemTitle`.
- [Process Queue Source Reader Library Header](../ui-bugs/process-queue-source-reader-library-header.md) — the source single-owner / "title appears exactly once" rule; the title's owner moved here (toolbar) while the rule held.
- [Process Queue Source Reader Metadata Row Chrome](../ui-bugs/process-queue-source-reader-metadata-row-chrome.md) — where the source title/caption previously lived; the `.pq-source__header` band was removed here.
- [Hover States Use Border, Not Shadow (+ shadow taxonomy)](../conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md) — the token-discipline convention behind "use `--border` for structural lines that must read in dark mode."
- [Three-Zone Scroll-Owned Review Card Surface](./three-zone-scroll-owned-review-card-surface.md) — adjacent layout pattern on the same ProcessQueue surface; removing the `.pq-source__header` band had to preserve its `min-height: 0` scroll chain.
- [Action-Bar Overflow Menu + Upward Popovers](./action-bar-overflow-menu-and-upward-popovers.md) — the other half of the same 2026-06-21 process-toolbar redesign arc.
- Plan: `docs/plans/2026-06-21-002-feat-process-session-toolbar-fullwidth-title-plan.md`.

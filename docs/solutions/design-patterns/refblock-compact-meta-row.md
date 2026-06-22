---
title: "RefBlock compact meta-row: collapse provenance citation, badge, and URL into one wrapping flex line"
date: 2026-06-22
category: docs/solutions/design-patterns
module: apps/web RefBlock source-reference component (RefBlock.tsx, ref-block.css)
problem_type: design_pattern
component: frontend_stimulus
severity: low
applies_when:
  - A shared display component stacks short metadata atoms (label/badge, variable text, a link) on separate block rows when most instances would fit on one line
  - A badge or label must share a line with variable-length text and an optional link but degrade gracefully when the text is long
  - The component renders at very different widths (a wide reading view and a narrow ~296px inspector column) and must adapt without a width-specific override
  - Reading/visual/DOM order must match for WCAG 1.3.2 (Meaningful Sequence)
tags: [refblock, flex-wrap, meta-row, source-provenance, align-items, overflow-wrap, design-tokens, wcag]
---

# RefBlock compact meta-row: collapse provenance citation, badge, and URL into one wrapping flex line

## Context

`RefBlock` (`apps/web/src/components/RefBlock.tsx` + `ref-block.css`) is the single component
that renders source provenance — the "where did this come from" block — for an extract or card.
It is reused by ~8 surfaces (review `ReviewScreen` + `CardDetailPanel`, the extract distillation
view `ExtractView`, the Inspector SOURCE column, `AiAssist`, `ConversionSession`, `ConflictSection`,
and the raw-extract reading view in `ProcessQueue`).

Beneath the source snippet, three short atoms — the citation/locator line, a source-type /
reliability badge (e.g. `ARTICLE`), and the source URL — were rendered on **three separate block
rows**, even when each was short. The badge in particular had a deliberate own-row wrapper
(`.refblock__reliability`) whose comment stated it "sits on its own row beneath the
citation/location, never inline with the URL." For a typical short ref (a one-line citation, a
compact badge, a hostname), this stacked ~3 rows of chrome where one line would do — wasting
vertical reading space on every surface, and most acutely in the narrow Inspector column (~296px)
where vertical space is scarcest. Because `RefBlock` is the one shared renderer, fixing it once
propagates to all reuse surfaces.

## Guidance

Group the short metadata atoms into a single **wrapping flex "meta" row** that reads on one line
when it fits and wraps gracefully when it does not. Keep genuinely block-level content (the verbatim
snippet quote above; the free-text reliability note and the action button below) outside the row.

```css
/* ref-block.css — the wrapping meta row */
.refblock__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  column-gap: var(--s-3, 8px);
  row-gap: var(--s-2, 6px);
  margin-top: var(--s-2, 6px);
}

.refblock__cite {
  min-width: 0;            /* override flex min-width:auto so the item can shrink */
  overflow-wrap: anywhere; /* break a pathologically long token instead of overflowing */
  /* no margin-top — the row owns spacing */
}
```

The load-bearing decisions:

- **`align-items: flex-start`, not `baseline` or `center`.** This is the non-obvious one.
  `baseline` aligns the badge to the citation's *last* wrapped line, so on a two-line citation the
  badge sinks to the bottom. `center` floats every item to the vertical midpoint of the tallest
  child. Only `flex-start` anchors the badge and URL to the citation's **first** line — where the
  eye starts reading — which is the only correct anchor when the citation wraps.

- **The container owns spacing; children carry no block `margin-top`.** `column-gap`/`row-gap`
  (tokenized) replace per-child top margins. Leaving a stray child `margin-top` reintroduces an
  extra row gap once items wrap.

- **`min-width: 0` + `overflow-wrap: anywhere` on the flexible child.** A flex item defaults to
  `min-width: auto`, so it refuses to shrink below its longest unbreakable token and forces
  horizontal overflow instead of wrapping. `flex-wrap` hides this for space-separated text but not
  for a single long token (a DOI, a query-string URL) on the narrow Inspector. The pair lets the
  citation shrink and break a pathological token as a last resort.

- **Render the row only when it has content.** A `hasMeta` guard
  (`Boolean(f.reliability || f.citation || f.locationLabel || f.href)`) prevents an empty `<div>`
  (and its `margin-top`) from rendering when none of the atoms resolve.

- **DOM order == visual/reading order — no CSS `order`.** Authoring the children in the same order
  they appear visually (badge → citation → URL) keeps screen-reader and keyboard traversal aligned
  with the visual layout, satisfying WCAG 1.3.2 (Meaningful Sequence). The badge is a
  non-interactive `span`, so the URL anchor is the row's only tab stop and follows the citation
  naturally — no `tabindex` work needed.

- **Preserve testIds and `data-*` on the children.** The regroup only changes nesting; the
  `data-testid`, `data-reliability-tier`, and `data-reliability-confidence` attributes are
  untouched, so the ~8 consuming surfaces and the e2e suite (which query by testId / text, not by
  DOM depth) are unaffected.

- **Pin the layout with a CSS-contract test.** jsdom can't measure layout, so the "does it actually
  collapse to one line" property is unverifiable in a unit test. Assert the structural declarations
  by reading the CSS source instead (see Examples) — this catches a future revert (re-added
  `margin-top`, `align-items: center`, dropped `flex-wrap`) without a headed browser.

## Why This Matters

The vertical-space win scales with content density and lands on every reuse surface from one edit,
consistently — a shared primitive is the right altitude for this change. In review, reclaimed
pixels at the bottom of the source block are attention returned to the prompt; in the narrow
Inspector, three stacked rows for a short ref shrink to one line plus a wrap fallback. The approach
is accessibility-safe (authored order preserved) and regression-proof (CSS-contract test) — and it
holds for the long-content case too: the row simply wraps to the minimum number of lines the
content genuinely needs, rather than always spending three.

## When to Apply

- A shared display component stacks short metadata atoms (labels, badges, timestamps, links) on
  separate block rows when most instances would fit on one line.
- A badge or label should share a line with variable-length text and an optional link, but must
  wrap gracefully when the text is long.
- The component renders at very different widths (a wide reading view and a narrow inspector column)
  and the layout must adapt to both without a width-specific override.
- The atoms are sibling-level (no hierarchy) so DOM/reading order can match visual order without CSS
  reordering.

Do **not** fold genuinely block-level content into the row: long-form prose (a snippet quote, a
free-text caveat) and primary actions keep their own line so nothing reads cramped.

## Examples

**Before — three stacked block rows.** The badge lived in its own flex-row wrapper; the citation
and URL each carried a block `margin-top`:

```css
.refblock__cite { margin-top: var(--s-3, 10px); /* … */ }
.refblock__reliability {                 /* the badge's own row */
  display: flex; flex-wrap: wrap; align-items: center;
  gap: 6px; margin-top: var(--s-2, 6px);
}
.refblock__url { display: inline-flex; margin-top: var(--s-2, 6px); /* … */ }
```

```tsx
{f.citation ? <div className="refblock__cite" …>{f.citation}…</div> : null}
{f.reliability ? <div className="refblock__reliability"><span className="badge …">…</span></div> : null}
{f.href ? <ExternalUrlLink className="refblock__url" … /> : null}
```

**After — one wrapping flex row** (badge leading), rendered only when non-empty:

```tsx
{hasMeta ? (
  <div className="refblock__meta" data-testid={`${testId}-meta`}>
    {f.reliability ? <span className={`badge ${reliabilityBadgeClass(f.reliability)}`} …>…</span> : null}
    {f.citation ? <div className="refblock__cite" …>{f.citation}…</div> : null}
    {f.href ? <ExternalUrlLink className="refblock__url" … /> : null}
  </div>
) : null}
```

**The CSS-contract test that pins it** (`ref-block-css.test.ts`, reading raw CSS, not the DOM):

```ts
const meta = cssBlock(".refblock__meta");
expect(meta).toContain("display: flex;");
expect(meta).toContain("flex-wrap: wrap;");
expect(meta).toContain("align-items: flex-start;");
expect(meta).toContain("column-gap: var(--s-3");
expect(meta).toContain("row-gap: var(--s-2");
// the row owns spacing — children carry no block margin-top
expect(cssBlock(".refblock__url")).not.toContain("margin-top:");
expect(cssBlock(".refblock__cite")).not.toContain("margin-top:");
```

## Related

- [process-toolbar-progress-divider-and-lifted-source-title](../design-patterns/process-toolbar-progress-divider-and-lifted-source-title.md) — the flex-ellipsis `min-width: 0` gotcha and lifting a per-type field into a shared band; same `min-width:0` discipline.
- [inbox-row-metadata-nowrap-compact-counts](../ui-bugs/inbox-row-metadata-nowrap-compact-counts.md) — the sibling "keep metadata on one line" flex contract (`min-width:0` + `shrink-0` + the variable child absorbing pressure).
- [extract-inspector-single-responsibility-lineage-scheduler](../ui-bugs/extract-inspector-single-responsibility-lineage-scheduler.md) — RefBlock is the single owner of citation/link/reliability display; this change restructures layout within that ownership, it does not add a new owner.
- [hover-uses-border-not-shadow-and-shadow-taxonomy](../conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md) — the per-screen `*-css.test.ts` discipline this pattern follows for pinning layout.

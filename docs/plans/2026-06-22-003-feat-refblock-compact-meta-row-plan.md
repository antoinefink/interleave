---
title: "feat: Collapse RefBlock provenance metadata onto a wrapping single row"
date: 2026-06-22
type: feat
status: ready
depth: standard
origin: null
---

# feat: Collapse RefBlock provenance metadata onto a wrapping single row

## Summary

The shared source-reference block (`RefBlock`) currently stacks its provenance metadata —
the citation/locator line, the source-type/reliability badge, and the source URL — on three
separate rows even when each is short. This wastes vertical space in the raw-extract reading
view and every other surface that reuses the block. Reorganize the citation, locator, badge,
and URL into a single `flex-wrap` "meta" row (badge leading) that collapses to one line when
content is short and wraps gracefully to additional lines when content is long, staying usable
on small / short-height screens. The verbatim snippet quote stays a block above; the reliability
note and "Open source" action stay blocks below.

This is a global change to the one shared primitive, preserving every existing test id, the
badge label text, and the `data-reliability-*` attributes that the e2e suite asserts.

---

## Problem Frame

`RefBlock` (`apps/web/src/components/RefBlock.tsx`) is the single component that draws the
"where did this come from" block for an extract or card. In the raw-extract reading view
(`apps/web/src/pages/queue/ProcessQueue.tsx:2065-2073`, test id `process-extract-refblock`) the
common short case renders as three stacked rows:

1. `.refblock__cite` — citation + locator, e.g. `Kevin Simler. Crony Beliefs | Melting Asphalt · ¶5`
2. `.refblock__reliability` — the badge, e.g. `ARTICLE` (a shield icon + the source-type label, uppercased by CSS)
3. `.refblock__url` — the external source link

Each of those three pieces is short in the common case, yet each consumes its own line because
`ref-block.css` deliberately lays the badge "on its own row beneath the citation/location, never
inline with the URL" and gives the URL a block-flow `margin-top`. The user wants this collapsed —
ideally one line, badge first — while still formatting cleanly when any piece is long and on
short-viewport machines.

**Why not hoist into the Inspector instead?** Recent solution docs
(`docs/solutions/ui-bugs/process-queue-source-reader-metadata-row-chrome.md`,
`docs/solutions/ui-bugs/process-queue-source-reader-library-header.md`, both 2026-06-21) show the
team removing duplicated per-surface *identity* chrome in favor of the Inspector SOURCE column.
That trajectory targets the source **reader's** identity row, which duplicated the Inspector. The
`RefBlock` in the reading view is a deliberate *in-context evidence panel* (the snippet + its
citation, shown right where you read), explicitly distinct from that removed row
(`docs/solutions/ui-bugs/extract-inspector-single-responsibility-lineage-scheduler.md` assigns
"all source evidence" to the lineage owner; the reading-surface RefBlock is the evidence-at-point-
of-reading view of the same data). Compacting it in place is complementary to the hoist direction,
not a re-densification of something slated for removal.

---

## Scope Boundaries

**In scope**
- Restructure `RefBlock`'s citation + locator + badge + URL into one wrapping meta row.
- Adjust `ref-block.css` to drive the new row with design tokens only.
- Extend the existing CSS-contract test and the component unit test to pin the new layout.
- Keep the change global to the shared `RefBlock` (benefits all reuse surfaces consistently).

**Out of scope / non-goals**
- Changing the citation/label assembly in `packages/core` (`formatSourceRef`,
  `summarizeReliability`) — the text content and badge label are unchanged.
- Truncating or ellipsizing the URL or citation text — full provenance text is preserved; long
  content wraps rather than being cut.
- The separate `SourceReader` header (`apps/web/src/pages/source/SourceReader.tsx`) — a different,
  separately-styled provenance treatment, untouched here.
- Hoisting provenance into the Inspector (a different, already-tracked direction — see Problem Frame).

### Deferred to Follow-Up Work
- The `.pq-extract__ref` wrapper keeps its `max-height: 160px; overflow-y: auto` safety cap. With
  the collapse the common case is well under that, so no change is needed now; revisiting the cap
  is a separate, optional tweak.
- A `/ce-compound` learning doc capturing the reading-view provenance-layout pattern (there is no
  extract-view-specific provenance-layout learning yet) — handled by the compounding step after this lands.

---

## Key Technical Decisions

**KTD1 — Single `flex-wrap` meta row, badge leading, top-aligned.**
Wrap the citation/locator, the reliability badge, and the URL in one `.refblock__meta` container
styled `display: flex; flex-wrap: wrap; align-items: flex-start` with tokenized `column-gap` and
`row-gap`. Order: badge → citation+locator → URL (matches the user's "article label before"
suggestion). When everything is short the items sit on one line; when any item is long, normal
flex wrapping moves it to the next line and existing `overflow-wrap: anywhere` on the URL breaks
an over-long URL within its own line. This is the proven single-line-that-wraps pattern already
used in the inbox row and process toolbar
(`docs/solutions/ui-bugs/inbox-row-metadata-nowrap-compact-counts.md`,
`docs/solutions/design-patterns/process-toolbar-progress-divider-and-lifted-source-title.md`):
the container owns the spacing, child block-flow `margin-top`s are zeroed.

`align-items: flex-start` is the committed choice, not `baseline` or `center`. The badge is a
padded pill (`.badge`: `padding: 3px 7px; line-height: 1`); `baseline` would align it to the
*last* wrapped line of a long citation (badge sinks to the bottom of a 2-line citation), and
`center` would float it mid-block. `flex-start` pins the badge — and the URL — to the *first*
line of the citation, which is where the eye starts reading and is the only correct anchor when
the citation wraps. The alignment invariant to verify is "the badge aligns to the **first** line
of a 2-line citation," not merely "the single-line case looks fine."

The meta children render in DOM order (badge → citation → URL) with **no** CSS `order` property,
so DOM order equals visual and reading order (WCAG 1.3.2 meaningful sequence). The badge is a
non-interactive `span`, so the only tab stop in the row is the URL anchor, which follows the
citation in reading order — no `tabindex` manipulation is needed.

**KTD2 — Keep the snippet quote and the note/action as their own blocks.**
The verbatim snippet (`.refblock__quote`, serif body text) stays a block *above* the meta row; the
reliability note (`.refblock__rel-note`, a free-text caveat sentence) and the "Open source at this
location" button (`.refblock__src`, an action) stay blocks *below*. Only the short, atomic
metadata (citation/badge/url) collapses — long-form and interactive content keeps its own line, so
nothing reads cramped.

The note only renders for an *uncertain* source (low confidence or a caveat note present); the
common case (e.g. the screenshot's `ARTICLE` source: type only, no tier/confidence/note) has no
note at all, so the badge inlines cleanly. When a note *is* present, the badge leads the meta row
and the note sits directly beneath that row — adjacent on the next line in the common one-line
case. The badge is warn-tinted in the uncertain case (`.badge--uncertain`), so it self-signals
"be careful" even before the eye reaches the note. This is an accepted trade-off versus the old
badge-directly-above-note coupling (see Open Questions); the note moves from *above* the URL to
*below* the meta row, which is an intentional reflow, not a no-op.

**KTD3 — Global change to the shared primitive, not a queue-scoped variant.**
The vertical-space win and the "reads consistently" design value both argue for changing
`RefBlock` itself rather than adding a prop/variant or scoping CSS under `.pq-extract__ref`. A
`flex-wrap` row degrades gracefully at every width, so the narrower surfaces (inspector, library
detail, review reveal panel) wrap instead of overflowing. All existing test ids, the badge label
text, and `data-reliability-tier`/`data-reliability-confidence` attributes are preserved, so unit
and e2e assertions stay valid (they query by test id / text, not by DOM nesting depth).

**KTD4 — Tokens only; pin with a CSS-contract test.**
Per `design/AGENTS.md` and the repo's `*-css.test.ts` discipline, every gap/space uses a
`design/tokens.css` value (`--s-2`, `--s-3`) and the layout invariant (flex + wrap + tokenized
gaps) is asserted in `ref-block-css.test.ts` so a future edit can't silently revert the collapse.

---

## High-Level Technical Design

Render structure before → after (block rows shown top to bottom):

```text
BEFORE (block-flow rows)            AFTER (.refblock__meta = flex-wrap row)
─────────────────────────           ───────────────────────────────────────
[ snippet quote ]        (block)     [ snippet quote ]              (block, unchanged)
citation · locator       (block)     ┌ .refblock__meta (flex, wrap, flex-start) ──┐
[BADGE]                  (block)     │ [BADGE]  citation · locator   ↗ url …       │  ← one line when short
reliability note         (block)     └────────────────────────────────────────────┘     wraps when long
↗ url                    (block)     reliability note      (block, now below meta — was above url)
[Open source…]           (block)     [Open source…]                 (button, unchanged)
```

Wrapping behavior (same DOM, different widths):

```text
short content, wide:   [ARTICLE]  Kevin Simler. Crony Beliefs | Melting Asphalt · ¶5   ↗ https://…
long content, narrow:  [ARTICLE]  A Very Long Author Name. A Very Long Title (2026) · ¶12
                       ↗ https://example.com/a/very/long/path?with=query&params=here
```

---

## Implementation Units

### U1. Regroup RefBlock metadata into a single meta container

**Goal:** Move the citation/locator `div`, the reliability badge, and the URL link into one
`.refblock__meta` wrapper (badge first), leaving the snippet quote above and the reliability note +
open-source button below. Preserve all existing test ids, badge label/icon, and `data-*`
attributes.

**Requirements:** Advances the user request (single-line-when-short, graceful-when-long provenance).

**Dependencies:** none.

**Files:**
- `apps/web/src/components/RefBlock.tsx` (modify — JSX grouping)
- `apps/web/src/components/RefBlock.test.tsx` (modify — add structural assertion)
- `tests/electron/process-queue.spec.ts` (modify — assert the meta container renders on the raw-extract surface)

**Approach:**
- Introduce a `.refblock__meta` container `div` (with `data-testid={`${testId}-meta`}`) that holds,
  in DOM order: the reliability badge span (when `f.reliability`), the citation `div`
  (`.refblock__cite`, when present), and the `ExternalUrlLink` (when `f.href`). DOM order is the
  visual order — do **not** use a CSS `order` property — so reading order matches the rendered
  order (WCAG 1.3.2). The badge is a non-interactive `span`; the URL anchor is the row's only tab
  stop and follows the citation naturally, so no `tabindex` work is needed.
- Render `.refblock__meta` only when at least one of {`f.reliability`, `f.citation`, `f.href`} is
  present, so a ref with none of them adds no empty container and no stray `margin-top`. The row
  degrades acceptably for any subset (a single child renders as just that child; e.g. URL-only
  reads as a plain link, badge-only as a lone chip).
- The badge currently sits inside a `.refblock__reliability` wrapper used only to force its own
  row; render the badge span directly in `.refblock__meta` (drop the row wrapper) while keeping the
  badge's `data-testid`, `data-reliability-tier`, `data-reliability-confidence`, icon, and label
  exactly as today.
- Keep the snippet quote (`.refblock__quote`) rendered *before* the meta container, and the
  reliability note (`.refblock__rel-note`) and open-source button (`.refblock__src`) rendered
  *after* it (the note thus moves from above the URL to below the whole meta row — an intentional
  reflow, see KTD2). The orphan/empty placeholder branch is unchanged.
- No change to `formatSourceRef`/`summarizeReliability` or any prop contract.

**Patterns to follow:** the existing conditional-render style already in `RefBlock.tsx`; test-id
naming `${testId}-*`.

**Test scenarios** (`apps/web/src/components/RefBlock.test.tsx`):
- Happy path: for the `FULL` ref, the `${testId}-meta` container is present and contains the
  citation (`-citation`), and the URL (`-url`) — assert each is found *within* the meta container
  (`within(metaEl).getByTestId(...)`).
- Badge case: for a ref with `reliabilityTier`/`confidence`, the reliability badge (`-reliability`)
  is found within the meta container, still carrying `data-reliability-tier` and the
  `"Secondary source · low confidence"` label text (keep the existing assertion green).
- Snippet stays outside: the `-quote` element is present but is NOT inside the meta container
  (it remains a block above).
- Subset render: a ref with only a URL (no citation, no reliability) renders the `-url` inside the
  meta container and renders no `-citation`/`-reliability`; a ref with none of citation/badge/url
  (but with a snippet, so `hasSource` is true) renders no `-meta` container at all (guards the
  empty-container margin case).
- Preserve all current passing assertions (citation text, URL href, open-source wiring, snippet
  dedupe/suppression, orphan placeholder, "nothing extra" for no-reliability ref) unchanged.
- Integration (`tests/electron/process-queue.spec.ts`): on the raw-extract surface, assert the
  `process-extract-refblock-meta` element is present (pins the regrouping end-to-end so a future
  revert to stacked rows is caught at the integration level, not only by the unit test).

**Verification:** `pnpm test` passes for `RefBlock.test.tsx`; the new structural assertions hold
and no prior assertion regresses; the added `process-queue.spec.ts` assertion passes.

### U2. Style the meta row to collapse-and-wrap with tokens, and pin it with the contract test

**Goal:** Make `.refblock__meta` a single wrapping row driven entirely by design tokens, zero the
now-internal child block margins, and assert the layout invariant in the CSS-contract test.

**Requirements:** Advances the user request (compact when short, well-formatted when long, small-screen safe).

**Dependencies:** U1.

**Files:**
- `apps/web/src/components/ref-block.css` (modify)
- `apps/web/src/components/ref-block-css.test.ts` (modify — extend contract)

**Approach:**
- Add `.refblock__meta { display: flex; flex-wrap: wrap; align-items: flex-start;
  column-gap: var(--s-3); row-gap: var(--s-2); margin-top: var(--s-2); }` so the container owns
  spacing and wraps cleanly. `align-items: flex-start` (not `baseline`/`center`) pins the badge and
  URL to the first line of a wrapping citation (see KTD1). Leave `overflow` at its default
  (`visible`) so a focused URL link's focus ring is not clipped by the flex container.
- Remove the block-flow `margin-top` from the base `.refblock__cite` and base `.refblock__url`
  rules (the meta row's gaps now own spacing); keep their typography/color tokens. Keep
  `.refblock__url`'s `overflow-wrap: anywhere` so a long URL breaks within its line. (The
  `.refblock__url:hover` rule is a separate block and is untouched.)
- Remove `.refblock__reliability` (the old "own row" wrapper) since the badge now sits directly in
  the meta row; grep first to confirm only `RefBlock.tsx` referenced it. Delete its now-stale
  comment ("sits on its own row beneath the citation/location, never inline with the URL") and add
  a one-line note on `.refblock__meta` recording that the inline meta row intentionally reverses
  that prior own-row decision (so the reversed invariant leaves a breadcrumb). The `.badge--tier-*`
  / `.badge--uncertain` / `.badge--reliability` variants are unchanged.
- Keep `.refblock__quote` and `.refblock__rel-note` block-level and unchanged.
- Tokens only — no hard-coded px for spacing/color (the `var(--s-*, fallback)` form already used in
  this file is fine).

**Patterns to follow:** the flex-ellipsis/wrap contract in
`docs/solutions/design-patterns/process-toolbar-progress-divider-and-lifted-source-title.md` and
`docs/solutions/ui-bugs/inbox-row-metadata-nowrap-compact-counts.md` (container owns spacing,
tokenized gaps); the existing token usage in `ref-block.css`.

**Test scenarios** (`apps/web/src/components/ref-block-css.test.ts`):
- Keep the existing assertion: `.refblock__quote` is `display: block` with `margin-top: var(--s-2, 6px)`.
- New: `.refblock__meta` contains `display: flex;`, `flex-wrap: wrap;`, `align-items: flex-start;`,
  and tokenized gaps (`column-gap: var(--s-3` and `row-gap: var(--s-2`).
- New: the base `.refblock__url` rule no longer carries a block `margin-top` (the meta row owns
  spacing) — assert the `.refblock__url` block does not contain `margin-top:` (guards against
  re-adding a stray row gap). Note the test helper `cssBlock(".refblock__url")` matches the *base*
  rule, not `.refblock__url:hover` (the `:hover` text sits between selector and `{`, so the regex
  skips it), so this assertion targets the base rule as intended.

**Verification:** `pnpm test` passes for `ref-block-css.test.ts`; `pnpm lint` and `pnpm typecheck`
are clean.

---

## System-Wide Impact

`RefBlock` is imported by exactly 8 files (verified via grep, excluding `RefBlock.tsx` itself):
review (`ReviewScreen`, `CardDetailPanel`), the extract distillation view (`ExtractView`), the
Inspector SOURCE column (`Inspector.tsx`), AI-assist (`AiAssist`), the conversion session
(`ConversionSession`), conflict sections (`ConflictSection`), and the raw-extract queue surface
(`ProcessQueue`). (There is no standalone "library detail" importer — the library selection detail
renders through the Inspector.) Because the change keeps the same DOM elements (just regrouped
under a wrapping container) and the same test ids / badge text, those surfaces gain the same
compaction with no contract break. The `flex-wrap` row wraps rather than overflows on the narrower
panels, which is the desired graceful-when-long behavior.

The narrowest, most-likely-to-wrap surface is the **Inspector SOURCE column**, which renders
`<RefBlock … showSnippet={false} />` — there the meta row is essentially the whole block (no quote
above to anchor the eye) at the inspector width (`--inspector-w: 296px`). The `flex-start`
alignment (KTD1) and the Inspector-specific visual check (Verification §5) exist precisely to
cover this worst case, so the "benefits all surfaces" claim is verified there, not just asserted.

---

## Risks & Mitigations

- **Shared-primitive blast radius (8 surfaces).** Mitigation: preserve all test ids, badge text,
  and `data-*` attributes (queried by id/text, not nesting); rely on `flex-wrap` graceful
  degradation; run the full unit + Electron e2e suites that exercise the refblock
  (`tests/electron/reference-display.spec.ts`, `tests/electron/source-reliability.spec.ts`,
  `tests/electron/process-queue.spec.ts`).
- **Badge alignment against a multi-line (wrapping) citation.** Both `align-items: baseline` (tracks
  the citation's *last* line) and `center` (floats mid-block) misalign a wrapping citation.
  Mitigation: commit to `align-items: flex-start` (KTD1), which anchors the badge to the citation's
  first line; verify the invariant "badge aligns to the first line of a 2-line citation" in a
  light + dark screenshot pass, not just the single-line happy path.
- **Dark-mode regressions** that jsdom/contract tests cannot catch. Mitigation: this change adds no
  new colors or dividers (no `--sunken` use), but include a light + dark screenshot check of the
  raw-extract surface during verification per the documented dark-mode trap.
- **Long URL dominating the row.** Acceptable by design — it wraps to its own line and breaks with
  `overflow-wrap: anywhere`; full provenance text is intentionally preserved (no truncation).

---

## Open Questions / Accepted Trade-offs

- **Badge-first ordering re-ranks trust above identity on every surface.** Moving the badge to the
  head of the row elevates source-type/reliability ahead of the citation on all 8 surfaces,
  including review (where the reading task is "verify the source"). Decision: keep badge-first — it
  honors the user's explicit "article label before" request and reads as a leading type chip; the
  badge is absent on most refs anyway (only present with reliability metadata), so the leading
  element is the citation in the common no-badge case. Revisit only if the review surface reads
  worse in the screenshot pass.
- **Reliability note moves below the meta row, away from its badge.** In the uncertain case the
  warn-tinted badge leads the row and the caveat note sits on the next line below. Decision:
  accepted — the warn tint self-signals, the note follows directly beneath in the common one-line
  case, and the note is absent entirely for the common (non-uncertain) source. Not worth a separate
  badge+note coupling structure for the minority uncertain case.

## Verification / Definition of Done

1. `pnpm lint` clean.
2. `pnpm typecheck` clean.
3. `pnpm test` green (notably `RefBlock.test.tsx`, `ref-block-css.test.ts`, `ProcessQueue.test.tsx`,
   `ExtractView.test.tsx`).
4. Relevant Electron e2e green: `tests/electron/reference-display.spec.ts`,
   `tests/electron/source-reliability.spec.ts`, `tests/electron/process-queue.spec.ts` (including
   the new `process-extract-refblock-meta` presence assertion).
5. Visual check (light + dark) on **two** surfaces:
   - Raw-extract reading view: short ref collapses to one line (badge → citation/locator → URL); a
     long citation/URL wraps cleanly with the badge still anchored to the citation's **first** line;
     snippet quote and "Open source" action keep their own lines; layout holds on a short-height window.
   - Inspector SOURCE column (snippet-suppressed, `inspector-refblock`, ~296px) — the narrowest and
     most-likely-to-wrap surface: confirm the collapsed row reads correctly when it wraps and that a
     focused URL link's focus ring is not clipped inside the flex row.

---

## Sources & Research

- `apps/web/src/components/RefBlock.tsx`, `apps/web/src/components/ref-block.css`,
  `apps/web/src/review/review.css` (base `.refblock`) — current structure and styling.
- `packages/core/src/source-ref.ts` — `formatSourceRef`, `summarizeReliability`,
  `SOURCE_TYPE_LABEL` (badge text is core-owned; not changed here).
- `apps/web/src/pages/queue/ProcessQueue.tsx:2065-2073` — the raw-extract surface in the screenshot.
- `apps/web/src/components/RefBlock.test.tsx`, `apps/web/src/components/ref-block-css.test.ts`,
  `tests/electron/reference-display.spec.ts`, `tests/electron/source-reliability.spec.ts` — existing coverage.
- Institutional learnings: `docs/solutions/ui-bugs/inbox-row-metadata-nowrap-compact-counts.md`,
  `docs/solutions/design-patterns/process-toolbar-progress-divider-and-lifted-source-title.md`,
  `docs/solutions/ui-bugs/extract-inspector-single-responsibility-lineage-scheduler.md`,
  `docs/solutions/ui-bugs/process-queue-source-reader-metadata-row-chrome.md`,
  `docs/solutions/design-patterns/compact-card-quality-check-disclosure.md`,
  `docs/solutions/conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md`.

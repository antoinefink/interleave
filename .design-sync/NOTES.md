# Interleave design-sync — repo notes

## This repo's shape (read before re-syncing)

Interleave is a **desktop app, not a packaged component library**. There is no
buildable DS package and no Storybook:

- The real components live in `apps/web/src` (a React 19 + Tailwind v4 SPA). ~75%
  of them call `window.appApi` (the Electron bridge) or `@tanstack/react-router`
  at runtime, so they can't render in isolation.
- `packages/ui` is an empty stub. `design/kit/` is an immutable Babel-in-browser
  prototype (do not ship).
- The brand lives in `design/tokens.css` (a Tailwind-v4 `@theme`-derived token set)
  + the IBM Plex superfamily (Sans/Serif/Mono via `@fontsource`).

So this sync is a **curated package-shape** build over a hand-picked re-export entry,
NOT a normal dist-based package sync.

## The build pipeline (reproduce in order from repo root)

1. Install deps once: `pnpm install --frozen-lockfile` (COREPACK_ENABLE_STRICT=0).
   Deps resolve under `apps/web/node_modules` (pnpm isolated layout) — that is the
   `--node-modules` target, NOT the repo root.
2. **Regenerate the brand stylesheet** whenever app CSS/tokens change:
   `pnpm -F @interleave/web build` then `node .design-sync/scripts/strip-fontface.mjs`.
   This takes the app's real Vite CSS (the faithful Interleave stylesheet: tokens +
   every semantic class + the Tailwind utilities actually used) and strips its
   `@font-face` blocks (their `/assets/*.woff2` urls can't be resolved by the
   bundler's font extractor) → `apps/web/.ds-brand.css` (gitignored, regenerated).
   IBM Plex ships separately via `cfg.extraFonts` (@fontsource → clean relative urls).
3. `config.json` is committed and **canonical — edit it directly**. (It was first emitted
   by a one-time template generator to avoid hand-escaping the multi-line `dtsPropsFor`
   bodies; that aid is not needed for re-syncs.)
4. Build: `node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules apps/web/node_modules --entry apps/web/ds-sync-entry.tsx --out ./ds-bundle`.
5. Validate: `node .ds-sync/package-validate.mjs ./ds-bundle`.

`apps/web/ds-sync-entry.tsx` is the curated re-export entry (committed, durable —
its location sets PKG_DIR=apps/web via package.json walk-up). `apps/web/tsconfig.json`
only compiles `src/**`, so this root file is invisible to the app's typecheck.

## Scope (22 components)

Curated to **presentational primitives with no runtime appApi/router usage**
(type-only imports are erased → fine). Inline-typed props → hand-written
`cfg.dtsPropsFor` bodies (the design agent's API contract). Components:
- inspector/badges: Prio, Status, Stage, TypeIcon, Tag, ConceptTag, SchedulerChip, FsrsStats, MetaRow, LineageTree
- controls: Btn, Segmented, Pipeline, Kbd, SuggestionChip, LibrarySearchField
- icons: Icon
- refs: RefBlock, ExternalUrlLink
- banners/states: ExpiryBanner, AutoPostponeReceiptLine, ExtractAgingReceiptLine

## Component gotchas (folded from authoring)

- **Btn & Segmented are scoped CSS**: `.btn`/`.segmented` only style inside
  `:where(.hc, .coach, .welcome, .tour-rail)`. Previews wrap in `.welcome` (NOT `.hc`
  — `.hc` forces `flex-direction:column; height:94vh` and breaks the row). The design
  agent must wrap these in one of those roots — captured in conventions.md.
- **Pipeline** `.pipeline`/`.pipe-step` are global (no wrapper needed).
- **SchedulerSignals** mock needs `scheduleReason: null` for attention-kind; FSRS-kind
  reads retrievability/stability/difficulty. SchedulerChip is the load-bearing
  FSRS-vs-attention split.
- **FsrsStats** needs a ~280px container to trigger its 3-column grid.
- **LineageTree** shows the inline Restore control only when `onRestore` is passed;
  tombstone nodes need `deleted:true`.
- **Receipt lines** use raw Tailwind utilities (present in `.ds-brand.css`). Note the
  asymmetric `onUndo` return shapes: AutoPostpone → `{undone}`; ExtractAging → `{undo:{undone}}`.
- Wide components (Pipeline, LibrarySearchField, both receipt lines) use
  `cfg.overrides.<Name> = {cardMode:"column"}` so the product card view doesn't crop them.

## Known render warns (recorded — not new on re-sync)

- `[TOKENS_MISSING]` for `--text-1`, `--success`, `--text-dim`, `--text-muted` (and
  `--focus`, which IS defined in tokens.css but outside `:root` so the scraper misses it):
  referenced by unrelated app CSS bundled into `.ds-brand.css`; **NONE are used by the
  22 curated components** (verified). Harmless.
- `[GRID_OVERFLOW]` resolved via the `cardMode:column` overrides above.

## Deferred (authorable on a later re-sync)

- **Review-card faces** (CardBody, CardFront, CardOcclusionFace, CardAudioFace): they
  import `@interleave/editor`, which bundles **KaTeX**, whose CSS references `.ttf` fonts
  the converter's bundler (`lib/bundle.mjs`) has no loader for → esbuild fails. `bundle.mjs`
  is app-contract surface (do-not-fork). To add them, the converter would need a `.ttf`
  loader (`dataurl`/`empty`). ExpiryBanner represents the review surface for now.
- **Menus/overlays** (ContextMenu, DoneIntentMenu) and **CollectionExplorerModeSwitch**:
  not yet authored — clean to add (no katex), just need overlay/open-state previews.

## Re-sync risks (what can silently go stale)

- **`.ds-brand.css` is gitignored and derived** — a fresh clone has none. Always re-run
  step 2 (vite build + strip-fontface) before building, or the bundle ships with stale/no
  Tailwind utilities + semantic classes. When app CSS changes, the brand sheet MUST be
  regenerated or cards drift from the real app.
- **`cfg.dtsPropsFor` is hand-written** — if a component's real props change in source,
  the contract here won't auto-update (no `.d.ts` to extract from). Re-check the bodies
  in `gen-config.mjs` against source on a major refactor.
- **Mock data in previews is inlined** — if a domain type (SchedulerSignals, LineageNode,
  ReviewCardExpiry, the receipts) changes shape, the preview mocks may need updating.
- **Playwright**: render check uses playwright@1.60.0 (installed in `.ds-sync`) + the
  cached Chromium 1223 at `~/Library/Caches/ms-playwright` (macOS path). A different
  machine needs a matching cached build or a download.
- **Curated entry is partial by design** — re-running discovery won't add new components;
  edit `apps/web/ds-sync-entry.tsx` + `gen-config.mjs` to grow the set.
- **conventions.md utility names must be tree-shaken-safe** — the bound `_ds_bundle.css`
  ships ONLY the Tailwind utilities the app actually renders. The first upload (Jun 21 2026)
  validation found 5 utilities named in the header that aren't compiled: `text-accent`,
  `bg-ok`, `bg-warn`, `text-md`, `text-lg` (their tokens `--accent/--ok/--warn/--t-md/--t-lg`
  DO exist, so the header now points to `var(--token)` inline for those). On any re-sync,
  re-run the conventions validation pass against the fresh `_ds_bundle.css`; if the app starts
  using one of these utilities it will reappear, and any newly-named utility must be grep-checked
  before shipping.

## Project (claude.ai/design)

- Synced to project **"Interleave"** `dcd9996b-9260-4055-8497-842c8a32d33d`
  (`https://claude.ai/design/p/dcd9996b-9260-4055-8497-842c8a32d33d`). `projectId` is pinned in
  config.json; re-syncs fetch its `_ds_sync.json` anchor automatically.

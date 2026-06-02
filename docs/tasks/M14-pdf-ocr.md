# M14 — PDF import, region extraction & OCR (T064–T066)

Detailed, buildable specs for the **first three tasks of M14** (the PDF subset of the
PDF / EPUB / document-import milestone). After these three tasks the desktop app can take a
**PDF source** in from the local filesystem entirely **on-device**:

- **T064** — the user picks a `.pdf`; the **Electron main process** streams the original bytes
  into the filesystem asset vault (`assets/sources/<source_id>/original.pdf`, via the T059
  `AssetVaultService.importAsset`), parses the PDF's per-page text with **`pdfjs-dist`**, builds
  a constrained ProseMirror document where each page is a labelled, stable-block-id'd run of
  paragraphs, and creates an **inbox** `source` through the existing transactional pipeline. The
  reader renders the PDF incrementally with selectable text, tracks a **page-granular
  read-point**, and stores **page-level source locations** so a PDF text extract links back to a
  page number.
- **T065** — drawing a rectangle over a figure/table in the PDF reader renders that region to an
  **image asset** in the vault and creates a scheduled **`media_fragment`** extract whose source
  location carries the **page + bounding box**, preserving lineage.
- **T066** — for a scanned/image PDF (no embedded text), an **`ocr` job** runs on the T058
  background runner (a DB-free `utilityProcess` worker, **`tesseract.js` WASM**), producing
  per-page searchable/extractable text **with confidence metadata**; results post back to main,
  which persists them as a reviewable OCR layer — **NOT** blindly merged into the body.

Everything obeys the established architecture (see [`../../CLAUDE.md`](../../CLAUDE.md) +
[`../architecture.md`](../architecture.md)): the React renderer (`apps/web`) calls the narrow
typed `window.appApi` bridge; the Electron main (`apps/desktop`) validates the IPC payload (Zod)
and routes to `packages/local-db` repositories + the pure `@interleave/importers` package; the
multi-table mutation runs in ONE SQLite transaction and appends `operation_log` entries; large
binaries (the original PDF, page-render images, region crops) go to the filesystem vault via the
T059 `AssetVaultService` — **never SQLite, never an app-facing S3**; heavy work (OCR) runs on the
T058 runner, **never a server**; the renderer never touches Node, the network, the filesystem, or
SQLite. Everything **survives an app restart**.

> **Local-first (roadmap M14 header, lines ~239–248).** "Imported documents and their assets live
> in the **filesystem asset vault** (T059 scaling), never app-level S3; OCR/parsing run on the
> **local background runner** (T058), never a server worker." These three specs are built directly
> ON the M12 infra that already shipped: the `UrlImportService` source-pipeline pattern, the
> `AssetVaultService` streamed importer, the `JobRunner` + `jobs` table + `job-worker.cjs` + the
> apply-handler registry. Reuse them — do **not** rebuild a parallel import/runner/vault stack.

Read first:
- [`../architecture.md`](../architecture.md) — **"PDF.js for PDF rendering/extraction"** (line
  ~90), the asset-vault layout (`assets/sources/<source_id>/ original.html, cleaned.html,
  original.pdf, snapshot.json`; `assets/media/<asset_id>/ original.bin, thumbnail.webp, ocr.json`,
  lines ~180–181), the **"No large blobs in SQLite"** rule (line ~169), the **on-device runner**
  note (line ~77), and the planned `packages/importers/` "Readability, PDF, EPUB … import logic"
  (line ~120).
- [`../domain-model.md`](../domain-model.md) — `media_fragment` ("a timestamped/region clip (PDF
  region, video/audio clip, image)", line ~16); `source_locations` columns
  (`block_ids[], start_offset, end_offset, page, timestamp_ms, region, label, selected_text`, line
  ~123 — note **`page` exists in the live schema; `region` does NOT yet** — T065 adds it); the
  `assets` columns (line ~135); the `operation_log` vocabulary (lines ~163–166).
- [`../../CLAUDE.md`](../../CLAUDE.md) — "Electron runtime & security", "Asset vault", "SQLite
  rules", "Data rules", "Document/editor rules" (stable block ids, source locations, lineage),
  "Scheduling rules" (a PDF source/extract is attention-scheduled, NOT FSRS).
- Spec contract: [`_TEMPLATE.md`](./_TEMPLATE.md) (REQUIRED shape). Format/depth exemplars:
  [`M2-capture-and-inbox.md`](./M2-capture-and-inbox.md), [`M3-document-editor.md`](./M3-document-editor.md),
  [`M4-extraction.md`](./M4-extraction.md), and the sibling
  [`M12-web-import.md`](./M12-web-import.md) (the `UrlImportService` it built is the EXACT pattern
  T064's PDF importer mirrors) + [`M12-runner-and-vault.md`](./M12-runner-and-vault.md) (the
  `JobRunner`/`AssetVaultService` T066/T064 build on).

What already exists (confirmed by inspecting the repo — **do not rebuild these**):
- **`AssetVaultService.importAsset`** in
  [`../../apps/desktop/src/main/asset-vault-service.ts`](../../apps/desktop/src/main/asset-vault-service.ts)
  (~line 159): STREAM-writes a binary to the vault while hashing (no whole-file-in-memory), dedups
  on content hash, and records `AssetRepository` metadata in ONE transaction. It accepts
  `source: string | NodeJS.ReadableStream`, a `kind: AssetKind`, and an optional
  `destRelativePath` (e.g. `sources/<source_id>/original.pdf`). **This is how the original PDF +
  page-render images + region crops reach the vault** — bytes never touch SQLite. It is built once
  in `DbService` behind a `get assetVaultService()` accessor (mirroring `urlImportService`).
- **`SourceRepository.createWithDocument` / `createWithDocumentWithin(tx, input)`** in
  [`../../packages/local-db/src/source-repository.ts`](../../packages/local-db/src/source-repository.ts)
  (~lines 200/216): creates the `source` element + `sources` provenance row + `documents` body +
  stable `document_blocks` in ONE transaction (logging `create_element` + `create_source` +
  `update_document`). It accepts a **pre-built `conversion: PlainTextConversion`** (the
  `{ doc, plainText, blocks }` shape — T060 added this) and a **pre-minted `id?: ElementId`** so
  the vault path is known before the row. **T064's PDF importer threads its page-doc `conversion`
  through this exact seam** — no editor/DOM work in `local-db`.
- **`SourceRepository.createExtractWithin(tx, input)`** (~line 322): the tx-composable extract
  seam. `CreateExtractInput` already carries `page?: number | null`, `timestampMs?`, `blockIds`,
  `selectedText`, and `label` — **T065's region extract reuses it**, adding the bbox. The
  `source_locations` row + `create_extract` op are written on the same tx.
- **`ElementLocation`** in
  [`../../packages/core/src/element.ts`](../../packages/core/src/element.ts) (~line 80) +
  the `source_locations` table in
  [`../../packages/db/src/schema/sources.ts`](../../packages/db/src/schema/sources.ts) (~line 50):
  both already have **`page: number | null`** (~line 92 / ~line 68) and `timestampMs`. **`region`
  is NOT present in either** — T065 adds the bbox column + field + mapper.
- **The constrained editor schema** in
  [`../../packages/editor/src/schema.ts`](../../packages/editor/src/schema.ts) (`buildSchema()`,
  `ALLOWED_NODE_NAMES`, `ALLOWED_MARK_NAMES`, `ALLOWED_HEADING_LEVELS`) and the stable-block-id
  rules in [`../../packages/editor/src/block-id.ts`](../../packages/editor/src/block-id.ts)
  (`shouldCarryBlockId`, `BLOCK_ID_NODE_TYPES`, `newBlockId`). **The PDF page-doc T064 produces
  MUST validate against `buildSchema()` and carry one stable `blockId` on the outermost block of
  each row.** PDF page text maps to `paragraph` rows (and `heading` for a detected page label);
  there is **no PDF/image node** in the constrained schema, so a region figure is an
  `image`-kind ASSET on a `media_fragment` element, NOT an inline editor node (see T065).
- **The widened `@interleave/core` ProseMirror types** in
  [`../../packages/core/src/prosemirror.ts`](../../packages/core/src/prosemirror.ts): the
  `PlainTextConversion = { doc, plainText, blocks }` result + the constrained `ProseMirror*` node
  union (T060 widened them beyond paragraph-only). The PDF→PM transform returns this SAME shape.
- **`@interleave/importers`** in [`../../packages/importers/`](../../packages/importers/): the pure,
  framework-agnostic, fixture-tested transform package (`extractArticle`/`sanitizeArticleHtml`/
  `htmlToProseMirrorDoc`). It has **`"sideEffects": false`** and depends on `@interleave/core` +
  `@interleave/editor` (React-free schema/block-id surface) but NOT Electron/`fs`/network. **T064's
  pure `pdfPagesToProseMirrorDoc` transform lives HERE; the orchestrating `PdfImportService`
  (file read, vault write, DB tx) stays main-side.**
- **`UrlImportService`** in
  [`../../apps/desktop/src/main/url-import-service.ts`](../../apps/desktop/src/main/url-import-service.ts):
  the construction-time-injected (`{ db, repositories, assetsDir }`) source-pipeline orchestrator —
  the EXACT pattern `PdfImportService` mirrors (mint id up front → write vault → one transaction →
  return `InboxItemSummary`; rollback removes the partial vault dir).
- **The job runner stack**: the `jobs` table
  ([`../../packages/db/src/schema/jobs.ts`](../../packages/db/src/schema/jobs.ts)), `JOB_TYPES`
  (with **`ocr` already RESERVED**, [`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts)
  ~line 179), `JobsRepository`, `JobRunner`
  ([`../../apps/desktop/src/main/job-runner.ts`](../../apps/desktop/src/main/job-runner.ts)), the
  worker entry + dispatch
  ([`../../apps/desktop/src/worker/job-worker.ts`](../../apps/desktop/src/worker/job-worker.ts)),
  the shared Zod `messages.ts`, the esbuild `dist/job-worker.cjs` target
  ([`../../apps/desktop/build.mjs`](../../apps/desktop/build.mjs)), and the apply-handler registry
  ([`../../apps/desktop/src/main/job-apply-handlers.ts`](../../apps/desktop/src/main/job-apply-handlers.ts)).
  **T066's `ocr` job is a new worker dispatch case + a new main-side apply handler on THIS runner —
  no new queue/table/IPC shape.** The `ocr` JobType is already declared.
- **The IPC seam**: channels
  [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts)
  (`sourcesImportUrl`, `sourcesImportManual`, `jobsList`/`jobsUpdated`, `vaultVerify`, …), contract
  [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts) (the
  `sources` group ~line 2709, `InboxItemSummary` ~line 794, `DocumentsGetResult` ~line 1116, the
  `jobs` group ~line 2928), the router
  [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts), the DB service
  [`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts) (its
  `urlImportService`/`assetVaultService` accessors + `open(dbPath, { migrationsDir, nativeBinding,
  assetsDir, allowLoopbackImport })`), the preload
  [`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts), and the
  renderer client [`../../apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts).
- **The reader** in [`../../apps/web/src/pages/source/SourceReader.tsx`](../../apps/web/src/pages/source/SourceReader.tsx):
  the `/source/$id` workspace (header + body via `SourceEditor`, read-point bar, selection toolbar →
  Extract/Cloze/Highlight, `?block=&offset=` jump-to-source). It reads through `documents.get` /
  `readPoints.get` / `readPoints.set` / `inspector.get`. **A PDF source reuses this shell** — same
  header, action bar, inspector, and a **PDF reading mode** swapped in for the editor body (a
  `pdfjs-dist` canvas + a selectable text layer).
- **The inbox import strip** in
  [`../../apps/web/src/pages/inbox/InboxScreen.tsx`](../../apps/web/src/pages/inbox/InboxScreen.tsx):
  `IMPORT_OPTS` already has Paste-URL / Paste-text / Browser-capture / Manual-note chips with a
  widened `action` union — plus a **no-action placeholder chip**
  `{ icon: "upload", label: "Upload PDF / EPUB", hint: "Books & papers — coming soon" }` (~line 70).
  **T064 wires up PDF import by REPLACING that "Upload PDF / EPUB — coming soon" placeholder** with a
  live **"Import PDF" chip** (`action: "pdf"`) that opens a native file picker — do NOT leave the dead
  "coming soon" entry beside a new live chip. (M14-formats' T067 later takes the EPUB/Markdown/HTML
  half of that same placeholder; coordinate so the strip ends with live chips only, no "coming soon"
  orphan.) It slots into the SAME inbox surface, not a new screen.

What is **missing** and this milestone adds:
- PDF dependencies: **`pdfjs-dist`** (render + per-page text/coords, main + renderer) and
  **`tesseract.js`** (OCR, runner worker) — see each task's "Dependencies to add".
- Pure PDF transforms in `@interleave/importers` (`pdf-text.ts`, `pdf-to-prosemirror.ts`).
- A main-side **`PdfImportService`** (mirrors `UrlImportService`) + a `sources.importPdf` /
  `sources.importPdfFromPath` IPC command.
- A **`region` bbox column** on `source_locations` (T065 migration) + the region-extract path.
- An **`ocr` job type wired end-to-end** (worker dispatch + apply handler) + an **`ocr_pages`
  table** (or a typed asset) persisting per-page OCR text + confidence, surfaced as a reviewable
  layer (T066).
- Renderer **PDF reading mode** (page canvas + text layer + rubber-band region selection +
  page read-point) and an OCR confidence affordance.

Build order is the task order: **T065 depends on T064** (it needs a rendered PDF + the
page-location substrate), **T066 depends on T064 + T058** (it OCRs the pages T064 imported, on the
runner that already exists). T064 wires ONE real PDF end-to-end (vault PDF + page doc + reader);
T065 and T066 extend it.

---

## T064 — PDF import

- **Status:** `[ ]` not started  · **Depends on:** T059 (the `AssetVaultService` streamed
  importer — the original PDF + page-render images go through it), T018 (the source reading-mode
  shell the PDF reader extends). In practice also T060 (the `createWithDocument` pre-built-`conversion`
  + pre-minted-`id` seam, the `@interleave/importers` package, and the construction-time-injected
  source-service pattern — all shipped, so concrete deps even though the roadmap line predates them).
- **Roadmap line:** Done when PDF.js renders PDFs, extracts selectable text, tracks page
  read-points, and stores page-level source locations; PDF text extracts link to page numbers.

### Goal

A user imports a local `.pdf` and the app brings it in as an **inbox `source`**, fully on-device.
The Electron **main process** streams the original bytes into the vault
(`assets/sources/<source_id>/original.pdf`, via `AssetVaultService.importAsset`), parses the PDF's
per-page text with `pdfjs-dist`, and builds a constrained ProseMirror document where **each page is
a labelled run** of `paragraph` blocks (preceded by a "Page N" `heading`) with stable block ids and
a per-block **page-number annotation**. The `source` is created through the existing transactional
pipeline (`createWithDocument`, one transaction, `create_element` + `create_source` +
`update_document` ops). The `/source/$id` reader renders the PDF **incrementally** — a `pdfjs-dist`
page canvas with a selectable text layer — tracks a **page-granular read-point** (reuse `read_points`
keyed by the page's first block id), and lets the user **extract selectable text** from a page; the
extract's `source_locations` row carries the **page number** so it links back to the page. The new
PDF source appears in the inbox immediately and survives an app restart. The renderer never reads
the file, never parses the PDF main-side, and never touches the vault.

### Context to load first

- Reference: [`../architecture.md`](../architecture.md) (PDF.js note + vault layout + no-blobs
  rule), [`../domain-model.md`](../domain-model.md) (`source_locations.page`, `source_pdf` asset
  kind, `raw_source`/`inbox`), [`../design-system.md`](../design-system.md) + the kit reader screen.
- Existing code to inspect: `AssetVaultService.importAsset` + its `DbService` accessor;
  `SourceRepository.createWithDocumentWithin` + `CreateSourceWithDocumentInput` (the `conversion` +
  `id` fields); the widened `PlainTextConversion`/`ProseMirror*` types
  ([`../../packages/core/src/prosemirror.ts`](../../packages/core/src/prosemirror.ts));
  `buildSchema`/`newBlockId`/`shouldCarryBlockId`/`BLOCK_ID_NODE_TYPES`; the `UrlImportService`
  pattern + its `runPipeline`/rollback discipline; the `documents.get`/`readPoints.*` contract +
  `SourceReader.tsx` + `useReadPoint`/`useDocument` hooks; the inbox import strip; `AppPaths.assetsDir`.
- Invariants in play: renderer never touches fs/SQL; the file read + PDF parse + vault write run
  **main-side**; the multi-table mutation is one transaction + logged; source lineage is preserved
  (a PDF source is a clean lineage root with a page-mapped body + the original PDF snapshot);
  asset bytes live in the vault (never SQLite); the produced page doc validates against the
  constrained schema with stable block ids; a PDF source is **attention-scheduled** (a topic-like
  source), NOT FSRS; new material defaults to a **non-dominating** priority (`C`).

### Dependencies to add (concrete, justified)

- **`pdfjs-dist`** (`^4.x`) — Mozilla's PDF.js, the SAME library `architecture.md` names. It is the
  one mature, pure-JS, MIT-licensed library that does BOTH jobs we need: (a) **structured text
  extraction with per-glyph coordinates** (`page.getTextContent()` returns text items with a
  transform matrix → x/y/width/height in PDF user space) used MAIN-side to build the page doc and
  later (T065) to map a rubber-band rect to text; and (b) **rendering** (`page.render({ canvasContext,
  viewport })`) used in the RENDERER to draw each page to a `<canvas>` with a positioned text layer
  for selection. Add it to:
  - `packages/importers` `dependencies` — main-side uses its **Node legacy build**
    (`pdfjs-dist/legacy/build/pdf.mjs`) for text extraction only (no canvas; pass the PDF bytes as a
    `Uint8Array`, `getDocument({ data, useWorkerFetch: false, isEvalSupported: false })`). The legacy
    build runs in plain Node (no DOM, no `OffscreenCanvas`) and is the documented headless path. It is
    pure JS and bundles into `main.cjs` via esbuild (which bundles everything but
    `electron`/`bindings`/`prebuild-install`). **Disable eval** (`isEvalSupported: false`) and **do
    not** wire a worker in the Node path (run `disableWorker`/main-thread parse) — a worker file in a
    bundled CJS context is fragile; the parse is bounded by the page count and a size cap, so
    main-thread parse in `PdfImportService` is acceptable (and the heavy OCR path is the one that goes
    to the runner, T066).
  - `apps/web` `dependencies` — the renderer imports the standard browser build
    (`pdfjs-dist/build/pdf.mjs`) + its worker (`pdfjs-dist/build/pdf.worker.mjs`) for canvas
    rendering, with `GlobalWorkerOptions.workerSrc` set to the Vite-resolved worker URL (Vite serves
    it; the renderer is a Chromium runtime so `<canvas>` + `OffscreenCanvas` are available). The
    renderer renders ONLY (it never re-parses for persistence — that already happened main-side); it
    re-uses the SAME `original.pdf` bytes, fetched through a typed `vault`/`documents` command (see
    the "Serve the PDF bytes to the renderer" deliverable — the renderer never resolves a raw path).
  - Pin a single `pdfjs-dist` version across both packages (same major) so the parsed coordinate
    space (main) and the rendered viewport (renderer) agree.

  **Justification over alternatives:** `pdf-lib` cannot extract text or render; `pdf-parse`/
  `pdf2json` extract text but give no reliable per-glyph coordinates and do not render — T065 needs
  coordinates and the reader needs rendering, so a single library that does all three (pdfjs-dist) is
  correct and is the project's already-chosen one. **Native-binding caveat:** pdfjs-dist is pure JS
  (no native addon), so no `asarUnpack`. Verify `pnpm --filter @interleave/desktop build` bundles the
  legacy build into `main.cjs` and the packaged app parses a fixture PDF (see Bundling note).

### The page-mapping model (specify concretely)

PDF text has no semantic blocks, so the importer imposes a deterministic, lineage-stable structure:

- **One `heading` (level 3) "Page N" label** opens each page's run, followed by **one `paragraph`
  per detected text line/段落** of that page (group `getTextContent` items into paragraphs by their
  y-coordinate gaps + reading order; a blank line / large y-gap starts a new paragraph). Each
  row-bearing node carries a stable `blockId` (via `newBlockId`, injectable for tests). This makes a
  page a contiguous, addressable block range, so a read-point/extract resolves to a page.
- **The page number is recorded per block**, NOT inferred from the doc. Two complementary stores,
  both written in T064:
  1. `document_blocks` already mirrors the doc rows (`blockType`, `order`, `stableBlockId`). T064
     extends the `blocks` array of the `PlainTextConversion` so each block ALSO carries its
     **1-based `page`** (see the "page-aware blocks" deliverable) — persisted to a new
     `document_blocks.page` column (nullable; `null` for non-paginated HTML/text sources). This is
     the canonical block→page map the read-point + extract path read.
  2. **`document_blocks.page` is the SOLE source of truth for page mapping** — the read-point and
     extract paths read it, and the reader can correlate a scrolled page with the body by reading it.
     A `data-page` attribute on the page `heading` node is **NOT** required and is **not** the cheap
     annotation it might seem: the editor schema's allowed attrs are tightly controlled (`buildSchema`
     with `blockId` as the single additive global attr), so adding a second global attr (`data-page`)
     is a real schema change that must round-trip through `buildSchema()`/`toDOM`/`parseDOM` **and**
     gain coverage in the `schema.roundtrip` test. **Prefer `document_blocks.page` as the only page
     carrier and skip `data-page` entirely.** Only add `data-page` if a concrete reader need appears
     that the column cannot serve — and if you do, you MUST extend the constrained schema definition +
     add the schema-roundtrip test case for it; do not slip it in as a free DOM annotation.
- `plainText` is the page texts joined with blank lines (page-prefixed, e.g. "Page 1\n\n…") for
  search/preview — the SAME `plainText` mirror `htmlToProseMirrorDoc` produces.
- **Empty/garbled/no-text PDF** (a scanned/image PDF) → a VALID doc with the "Page N" headings and
  EMPTY page paragraphs (zero text rows), `plainText` near-empty, and a `reasonAdded` note "No
  embedded text — run OCR" so the source is never lost and T066 has a target. (T066 fills the OCR
  layer; T064 must not crash on a text-free PDF.)

### Deliverables

- [ ] **`document_blocks.page` column + migration.** Add a nullable `page: integer("page")` to the
      `documentBlocks` table
      ([`../../packages/db/src/schema/documents.ts`](../../packages/db/src/schema/documents.ts) ~line
      33) — the canonical block→page map for paginated sources; `null` for HTML/text bodies (a pure
      widening, no backfill needed). Run `pnpm db:generate` to produce the next Drizzle migration;
      commit the generated SQL. Update `DocumentBlockRow`/`NewDocumentBlockRow` (auto-inferred) and
      the block mapper / any block reader that constructs `document_blocks` inserts.
      > **Migration numbering (T064/T065/T066 + the sibling M14-formats spec all add migrations on
      > top of the same `0007_parched_killmonger.sql`).** This spec writes `0008`/`0009`/`0010` for
      > `document_blocks.page` / `source_locations.region` / `ocr_pages` assuming nothing else lands
      > between them. **`pnpm db:generate` always emits the next sequential number in build order**, so
      > the numbers here are nominal — if a sibling M14 task (e.g. M14-formats' `source_epub`/`cards.source_uri`
      > migration) lands first, just take whatever number `db:generate` produces and keep each task's
      > schema change in its own reviewable migration. Do not hand-renumber; rebase to the generated
      > number.
- [ ] **Widen `PlainTextConversion` blocks with an optional `page`.** In
      [`../../packages/core/src/prosemirror.ts`](../../packages/core/src/prosemirror.ts), add an
      optional `readonly page?: number | null` to the `ProseMirrorBlock` (the `{ blockType, order,
      stableBlockId }` shape `conversion.blocks` carries). Backward-compatible: the existing
      paragraph/HTML converters omit it (`undefined`/`null`). `createWithDocumentWithin`
      ([`../../packages/local-db/src/source-repository.ts`](../../packages/local-db/src/source-repository.ts)
      ~line 263) then writes `page: block.page ?? null` into each `document_blocks` insert. Add a unit
      test that a `conversion` with per-block pages stores them and an HTML conversion stores `null`.
- [ ] **Pure PDF transforms in `@interleave/importers`:**
  - [ ] **`extractPdfPages(bytes: Uint8Array): Promise<PdfPage[]>`** in
        `packages/importers/src/pdf-text.ts`, where `PdfPage = { pageNumber: number; lines:
        PdfTextLine[]; width: number; height: number; hasText: boolean }` and `PdfTextLine = { text:
        string; x: number; y: number; width: number; height: number }` (PDF user-space coords, y
        measured from the page top via the viewport so it matches the rendered layer). Uses the
        `pdfjs-dist` legacy Node build: `getDocument({ data: bytes, isEvalSupported: false }).promise`
        → for each page `page.getTextContent()` → group items into lines/paragraphs by y-gap + reading
        order. `hasText` is false when a page yields no text items (the scanned-page signal T066 reads).
        No `fs`, no Electron — bytes in, structured text out. (The function is `async` because
        `pdfjs-dist` is promise-based; that is fine for a pure transform.)
  - [ ] **`pdfPagesToProseMirrorDoc(pages: PdfPage[], mint?: BlockIdMinter): PlainTextConversion`** in
        `packages/importers/src/pdf-to-prosemirror.ts`. Walks `pages` into the SAME `{ doc, plainText,
        blocks }` shape, per the page-mapping model above: a `heading` (level 3) "Page N"
        + one `paragraph` per line/paragraph, each row-bearing node minted a stable `blockId` (default
        `newBlockId`, injectable) and tagged with its **`page`** in the parallel `blocks` list (the page
        number lives ONLY in the `blocks[].page` mirror → `document_blocks.page`, NOT as a `data-page`
        schema attr — see the page-mapping model). The
        output MUST validate against `buildSchema()` (assert `Node.fromJSON(buildSchema(), doc)` does
        not throw; every node ∈ `ALLOWED_NODE_NAMES`, every mark ∈ `ALLOWED_MARK_NAMES`). A text-free
        page → a valid "Page N" heading with no paragraph. Empty `pages` → a valid empty doc.
  - [ ] Export both from `packages/importers/src/index.ts`. Add `pdfjs-dist` to
        `packages/importers/package.json` dependencies.
- [ ] **Main-side `PdfImportService`** in `apps/desktop/src/main/pdf-import-service.ts`, mirroring
      `UrlImportService` (construction-time injection: `new PdfImportService({ db, repositories,
      assetsDir, assetVault })` — the `AssetVaultService` is injected so the original PDF streams in;
      the open DB + repos for the source transaction). Public:
      `importFromFile(input: { filePath: string; title?: string | null; priority?: PriorityLabel;
      reasonAdded?: string | null }): Promise<PdfImportResult>`. `PdfImportResult = { id: string;
      item: InboxItemSummary }`. Steps (mirror `runPipeline`):
  1. **Read + validate** the file: confirm the extension/magic bytes are PDF (`%PDF-` header),
     enforce a **size cap** (e.g. 200 MB — a `fs.stat` check before reading; reject larger with a
     typed `PdfImportError { code: "too_large" }`) and a **page-count cap** (e.g. 2000 pages —
     reject `too_many_pages` after the parse opens the doc) so a hostile PDF cannot exhaust memory.
     Throw a typed `PdfImportError` (codes: `not_pdf` / `too_large` / `too_many_pages` / `unreadable`
     / `encrypted`) the IPC layer maps to a friendly line. (pdfjs throws on an encrypted/password PDF
     — catch it → `encrypted`.)
  2. **Mint the source id** up front (so the vault path `sources/<source_id>/original.pdf` is known
     before the row), as `UrlImportService.runPipeline` does.
  3. **Stream the original PDF into the vault** via `assetVault.importAsset({ owningElementId:
     sourceId, kind: "source_pdf", source: filePath, mime: "application/pdf", destRelativePath:
     "sources/<source_id>/original.pdf" })`. (Passing the absolute `filePath` makes `importAsset`
     `createReadStream` it — no whole-file read.) **This records the asset row + content hash and
     writes the bytes; bytes never touch SQLite.** NOTE: `importAsset` opens its own metadata
     transaction; because the asset row owns the source element by FK, **create the source element
     FIRST in the same outer transaction** OR import the asset AFTER the source row exists — pick the
     ordering that keeps the FK valid. **Recommended:** create the source (step 5) in one transaction,
     then `importAsset` (its own tx) keyed by the now-existing `sourceId`; on an `importAsset` failure,
     soft-roll-back is unnecessary (the source has its body; the PDF snapshot is best-effort and can
     be re-imported) — but prefer to set `snapshotKey` only AFTER the asset lands, and on failure
     throw so nothing half-commits. Document the chosen ordering in the service docblock. (Unlike the
     URL path's two tiny HTML snapshots, the PDF is large and streamed, so it is imported via the T059
     service, not written inline — keep the source-row transaction and the streamed asset import as
     two ordered steps, not one giant transaction holding a 200 MB write.)
  4. **Parse** `extractPdfPages(bytes)` → `pdfPagesToProseMirrorDoc(pages)` (both from
     `@interleave/importers`). (Read the bytes ONCE for the parse — or have the service read the file
     to a `Uint8Array` for the parse and pass the same `filePath` to `importAsset` for the streamed
     copy; do not buffer the whole file twice unnecessarily, but correctness over micro-optimization.)
  5. **Create the source** via `createWithDocument` (its own transaction) with `status: "inbox"`,
     `stage: "raw_source"`, the pre-minted `id`, the title (explicit → the PDF's `/Title` metadata →
     the filename stem), the pre-built `conversion`, `snapshotKey: "sources/<id>/original.pdf"`,
     `reasonAdded` (the "no embedded text" note when `pages.every(p => !p.hasText)`), priority `C`.
  6. Return `{ id, item: InboxItemSummary }` (the fresh inbox summary).
  On any failure after the vault dir was created, best-effort `rmSync` the partial
  `sources/<source_id>/` dir (mirror `UrlImportService`'s rollback) so no orphan files linger.
- [ ] **IPC contract** in
      [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts):
  - The renderer cannot send a filesystem path it chose itself (no fs access). **Use a native file
    picker in MAIN**: the command is `sources.importPdf(request)` where `request` carries only a
    priority/reason; the MAIN handler opens an Electron `dialog.showOpenDialog` (filtered to `.pdf`),
    gets the chosen absolute path, and calls `PdfImportService.importFromFile`. So:
    `SourcesImportPdfRequestSchema = z.object({ priority: PriorityLabelSchema.optional(), reasonAdded:
    z.string().trim().max(2048).optional() })` and `SourcesImportPdfResult = { status: "imported"; id:
    string; item: InboxItemSummary } | { status: "cancelled" }` (the user can cancel the picker — a
    non-error outcome, distinct from a thrown `PdfImportError`). Add
    `importPdf(request): Promise<SourcesImportPdfResult>` to the `AppApi` `sources` group (~line 2709).
  - **(Capture/extension path, optional/forward-looking):** if a future caller already has PDF bytes
    (the M13 extension), a sibling `importPdfFromBytes` could be added later; T064 ships only the
    picker-driven `importPdf` (no bytes-over-IPC — a large PDF should not cross the IPC bridge as a
    payload; the picker keeps the file path main-side).
- [ ] **Channel** `sourcesImportPdf: "sources:importPdf"` in
      [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts).
- [ ] **IPC handler** (async) in [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts):
      `ipcMain.handle(IPC_CHANNELS.sourcesImportPdf, async (_e, raw) => …)` — parse the request, open
      the file dialog (return `{ status: "cancelled" }` if dismissed), then `await
      dbService.importPdf({ filePath, ...request })`. Mirror the async `sourcesImportUrl` handler.
      Map a thrown `PdfImportError` to a rejected `invoke` (the modal catch handles it).
- [ ] **DB-service method + accessor** in
      [`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts): a
      lazily-built `get pdfImportService(): PdfImportService` (constructed once with the open DB +
      repos + `assetsDir` + the `assetVaultService`, like `urlImportService`) and an async
      `importPdf(input): Promise<SourcesImportPdfResult>` delegating to it. Throws a clear error if
      `assetsDir` was not provided (contract-only test).
- [ ] **Preload + renderer client** — add `sources.importPdf` to
      [`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts) and mirror
      `appApi.importPdfSource(request)` in
      [`../../apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts).
- [ ] **Serve the PDF bytes to the renderer (for rendering).** The reader's `pdfjs-dist` canvas needs
      the `original.pdf` bytes, but the renderer never resolves a vault path. Add a narrow typed
      command `documents.getPdf(request: { elementId })` (or extend the existing `documents.get`) that
      returns the PDF bytes for rendering — pick ONE and document it:
      - **(a, preferred)** a `sources.getPdfData({ elementId }): Promise<{ bytes: ArrayBuffer; pageCount:
        number }>` IPC command — MAIN reads `sources.snapshotKey` (the `sources/<id>/original.pdf`
        relative path), resolves it under `assetsDir`, reads the bytes, and returns them over IPC. For a
        very large PDF the bytes crossing IPC once at open is acceptable (Chromium handles an ArrayBuffer
        transfer); cap the served size to the import cap.
      - **(b)** register a privileged `pdf://` custom protocol in main (`protocol.handle`) that streams
        the vault file to the renderer by element id (avoids buffering the whole PDF over IPC). Prefer
        (b) if the import cap (200 MB) makes (a)'s single ArrayBuffer transfer heavy; otherwise (a) is
        simpler. Either way the renderer passes a path NEVER — only an element id; main owns the path.
- [ ] **Renderer PDF reading mode** in `apps/web/src/pages/source/` — a `PdfReader` body component the
      `SourceReader` swaps in when the source is a PDF (detected via a `sourceFormat: "pdf"` flag on
      the inspector/`documents.get` result — add a small flag derived from the presence of a
      `source_pdf` asset / a `.pdf` `snapshotKey`). It:
  - Loads the bytes via the command above, renders pages to `<canvas>` with `pdfjs-dist`
    (`GlobalWorkerOptions.workerSrc` wired to the Vite worker), **lazily/incrementally** (render the
    visible page(s) on scroll, not all at once — a 500-page PDF must stay responsive), and overlays a
    positioned **text layer** (`pdfjs-dist`'s `TextLayer`) so the user can SELECT text on a page.
  - Tracks a **page-granular read-point**: the read-point is set at the FIRST block id of the current
    page (reuse `read_points` keyed by `elementId` + that block id + offset 0). Scrolling to a page,
    or a "Set read-point" press, persists the page's first block id via `readPoints.set` — so
    reopening resumes at the page. The progress bar reads page N of M (derive from
    `document_blocks.page`).
  - **Extracts selectable page text** via the EXISTING selection toolbar → `extractions.create`, but
    the resolved location now carries the **page** (the selected text's page, read off the active
    page) so the `source_locations.page` is set (see the extraction deliverable). A PDF text extract
    is otherwise an ordinary `extract` element with body + lineage.
  - Renders gracefully when `!isDesktop()` (mirror the existing desktop-only fallback). Pure UI: it
    calls the typed commands only; no fs/parse/SQL in the renderer.
- [ ] **Page-level source locations on extraction.** The extraction path
      ([`../../packages/local-db/src/extraction-service.ts`](../../packages/local-db/src/extraction-service.ts)
      → `SourceRepository.createExtractWithin`) must receive + persist the **page** for a PDF extract.
      > **Most of this plumbing is already built — verify, do not re-add.** The `page` field already
      > threads end-to-end: `contract.ts` `ExtractionCreateRequestSchema` (~line 1325) carries `page: z.number().int().min(0)
      > .nullable().optional()` (the existing `// PDF, later` field), `appApi.ts` mirrors it,
      > `ElementLocation.page` exists, `ExtractionService.createExtraction` already accepts `page?` and
      > forwards it to `createExtractWithin`, and `CreateExtractInput.page` already exists. So the only
      > **genuinely new** work in this deliverable is **(a)** the reader deriving the page from
      > `document_blocks.page` for the selected block(s) and passing it on `extractions.create`, and
      > **(b)** the source-location label extension below. Confirm the existing `page` thread is intact
      > (a quick read of the three files above) and reuse it rather than re-plumbing.
      Derive the page in the reader from `document_blocks.page` for the selected
      block(s). For a non-PDF source `page` stays `null` (unchanged). Update the source-location label
      derivation ([`../../packages/local-db/src/source-location-label.ts`](../../packages/local-db/src/source-location-label.ts))
      so a paginated source's label reads "Page N · ¶M" (when `page` is set) rather than just "¶M";
      keep the existing "¶N" for non-paginated.
      > **Signature delta (genuinely new — the function takes no page today).**
      > `deriveSourceLocationLabel(blocks, firstBlockId): string`
      > ([`source-location-label.ts`](../../packages/local-db/src/source-location-label.ts) line ~35) has
      > **no page parameter**, and its caller `ExtractionService.deriveLabel`
      > ([`extraction-service.ts`](../../packages/local-db/src/extraction-service.ts) lines ~214–219)
      > also has none. So this deliverable must: **(1)** give `deriveSourceLocationLabel` a new trailing
      > `page?: number | null` param — `deriveSourceLocationLabel(blocks, firstBlockId, page?)` —
      > emitting `Page ${page} · ¶${M}` ONLY when `page` is set, else the existing `¶${M}` (or
      > `<Type> · ¶${M}`) unchanged; and **(2)** thread the page through the caller: `deriveLabel`
      > (and the `createExtraction` page thread that calls it) must accept + forward the extract's page
      > so the paginated label is produced. Make the signature change additive (optional param) so
      > every existing non-paginated caller is unaffected.
      Add a unit test for the page label (page set → "Page N · ¶M"; page null/absent → the existing
      "¶N").
- [ ] **Renderer "Import PDF" affordance** — **replace the existing no-action `{ icon: "upload",
      label: "Upload PDF / EPUB", hint: "Books & papers — coming soon" }` placeholder chip** (~line 70)
      in [`../../apps/web/src/pages/inbox/InboxScreen.tsx`](../../apps/web/src/pages/inbox/InboxScreen.tsx)
      with a LIVE `IMPORT_OPTS` entry `{ icon: "source",
      label: "Import PDF", hint: "Read a PDF incrementally", action: "pdf" }` (do not add a second chip
      beside the dead placeholder — repurpose it). Use an **existing `IconName`** — `"source"`
      (`FileText`) is the natural fit and is already in the icon map
      ([`../../apps/web/src/components/Icon.tsx`](../../apps/web/src/components/Icon.tsx) +
      [`../../design/icon-map.md`](../../design/icon-map.md)); there is **no `file`/`book` key**, so do
      NOT name one (it would fail typecheck on `IconName`). If a distinct PDF/book glyph is wanted,
      ADD it to `Icon.tsx` + `design/icon-map.md` first (a lucide import + a map entry) as an explicit
      step — do not assume it exists. T067 (M14-formats) reclaims the EPUB/Markdown/HTML
      side of that same placeholder, so leave the strip with live chips only.
      The chip calls `appApi.importPdfSource({ priority? })` (which triggers the MAIN file picker), shows a
      busy/spinner while main reads+parses, surfaces a friendly error on a thrown `PdfImportError`
      (mapping its `code`), and on success refreshes the inbox + selects the new source. No new screen.
- [ ] **Tests (unit, importers — fixture PDFs)** in `packages/importers/src/pdf-*.test.ts` against a
      tiny set of fixture PDFs under `packages/importers/src/__fixtures__/` (a 2-page text PDF; a
      PDF with a heading + body; a SCANNED/image-only PDF with no text layer — generate these as small
      committed fixtures, e.g. via a one-off script or a checked-in minimal PDF):
  - `extractPdfPages` returns the right page count, non-empty `lines` for the text PDF, and
    `hasText: false` for every page of the scanned PDF.
  - `pdfPagesToProseMirrorDoc`: a 2-page PDF maps to two "Page N" headings + the page paragraphs,
    each block tagged with its `page`; **every node ∈ `ALLOWED_NODE_NAMES`, every mark ∈
    `ALLOWED_MARK_NAMES`, `Node.fromJSON(buildSchema(), doc)` does not throw**; each row-bearing node
    has a unique `blockId`; the scanned PDF maps to "Page N" headings with empty bodies (no crash).
- [ ] **Tests (domain, local-db)** — `createWithDocumentWithin` with a page-tagged `conversion` stores
      `document_blocks.page`; the HTML/text path stores `page = null` (unchanged); the page-aware
      source-location label test.
- [ ] **Tests (integration, main-side service)** in
      `apps/desktop/src/main/pdf-import-service.test.ts` against a real temp-file SQLite DB + a temp
      `assetsDir` (the desktop-main pattern: `new DbService()` + `svc.open(dbPath, { migrationsDir,
      assetsDir })` under `mkdtempSync`, like
      [`../../apps/desktop/src/main/db-service.test.ts`](../../apps/desktop/src/main/db-service.test.ts)),
      pointing `importFromFile` at a fixture PDF on disk:
  - a successful import writes `sources/<id>/original.pdf` under the vault, records a `source_pdf`
    asset row whose `contentHash` matches the file, creates an `inbox` source whose `snapshotKey` is
    the PDF path and whose document body parses to the page headings/paragraphs with per-block pages,
    and appends `create_source` + `update_document` ops;
  - **restart-persistence**: re-open the DB (new repositories on the same file) and assert the source +
    provenance + body + page-tagged blocks + the PDF asset row are still present and `original.pdf`
    still exists on disk;
  - error paths: a non-PDF / oversize / encrypted fixture throws the typed `PdfImportError` with the
    right `code` and writes NO source row and NO partial vault dir (clean rollback).
- [ ] **Tests (contract)** — extend
      [`../../apps/desktop/src/shared/contract.test.ts`](../../apps/desktop/src/shared/contract.test.ts):
      `SourcesImportPdfRequestSchema` accepts/rejects; the `imported`/`cancelled` result round-trips.
- [ ] **Tests (E2E, Electron)** — `tests/electron/pdf-import.spec.ts`: drive the real Electron app,
      import a fixture PDF (stub `dialog.showOpenDialog` to return the fixture path via an env override
      — mirror the `INTERLEAVE_ALLOW_LOOPBACK_IMPORT` escape pattern, e.g.
      `INTERLEAVE_PDF_IMPORT_PATH`), see the source in the inbox, open it in the PDF reader (a page
      canvas renders, text is selectable), set a read-point on page 2, extract page text → the extract
      links to page 2, and — after an **app restart** against the same data dir — the source, its
      body, its `original.pdf`, the read-point, and the page-linked extract all survive.
- [ ] **Fixtures/seed** — the fixture PDFs are the only new test data; no schema/seed change beyond
      the migration. Optionally add ONE small seeded PDF source so the reader shows a real PDF
      out-of-the-box (nice-to-have).
- [ ] **Docs** — check the T064 box in [`../roadmap.md`](../roadmap.md) with the commit ref + a
      Progress-log line noting: the `pdfjs-dist` dep, the `document_blocks.page` migration, the
      `@interleave/importers` PDF transforms, the `PdfImportService` + `sources.importPdf` command,
      and the renderer PDF reading mode.

### Done when

- Importing a local `.pdf` (via the inbox "Import PDF" chip → a MAIN file picker) brings it in as an
  **inbox `source`** fully on-device: MAIN streams `original.pdf` into the vault (content-hashed
  `source_pdf` asset, bytes never in SQLite), parses per-page text with `pdfjs-dist`, builds a
  constrained ProseMirror page doc with **stable block ids + per-block page numbers**, and creates the
  source via `createWithDocument` in one transaction (appending `create_element` + `create_source` +
  `update_document`).
- The `/source/$id` reader renders the PDF **incrementally** (a `pdfjs-dist` page canvas + a
  selectable text layer), tracks a **page-granular read-point** (reopening resumes at the page), and
  shows page N of M progress.
- **Extracting selectable PDF text** creates an ordinary `extract` whose `source_locations.page` links
  it to the page it came from (the label reads "Page N · ¶M").
- The file read + PDF parse + vault write run **main-side**; the renderer reaches it only through the
  typed `window.appApi` (no fs/parse/SQL in React, no generic `db.query`).
- A text-free/scanned PDF imports without crashing (page headings, empty bodies, a "run OCR" note) —
  leaving a clean target for T066.
- An Electron E2E imports a fixture PDF, reads it, sets a page read-point, extracts page text, and —
  after an **app restart** — the source, body, `original.pdf`, read-point, and page-linked extract all
  survive.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass; the `0008_*`
  migration applies cleanly on an existing dev DB.

### Notes / risks

- **Bundling pdfjs-dist.** The legacy Node build (`pdfjs-dist/legacy/build/pdf.mjs`) is the headless,
  DOM-free path; bundle it into `main.cjs` via esbuild (it is pure JS, no native addon). Set
  `isEvalSupported: false` and run the parse on the main thread (no worker file) — a bundled CJS
  worker is fragile and the parse is bounded by the size/page caps. **Verify** `pnpm --filter
  @interleave/desktop build` succeeds and the packaged app parses a fixture PDF. The renderer's
  browser build + worker is Vite-resolved (`?url`/`GlobalWorkerOptions.workerSrc`), a normal renderer
  dependency. Pin ONE pdfjs version across importers + web.
- **Coordinate space (sets up T065).** `extractPdfPages` records line bboxes in a consistent space
  (PDF user space, y-from-top via the page viewport at scale 1) so T065 can map a rubber-band rect
  (rendered at a known scale) back to a PDF region by dividing out the scale. Keep the coordinate
  convention documented in `pdf-text.ts` so the renderer's region selection (T065) and the main-side
  parse agree.
- **Big PDFs.** Stream the bytes into the vault (T059 `importAsset`), render pages lazily in the
  reader (visible-page windowing), and cap size + page count at import. Do NOT render every page
  eagerly or hold the whole PDF in renderer memory beyond what `pdfjs` needs.
- **A PDF source is attention-scheduled, not FSRS.** It is a `source` element read incrementally —
  the existing topic/extract scheduler applies. Do not route a PDF source through review scheduling.
- **Downstream:** T065 (region extraction) needs the rendered PDF + the page-location substrate this
  task ships; T066 (OCR) needs the `hasText: false` per-page signal + the page doc to attach an OCR
  layer to. Both build on T064 without changing its source/vault/page shapes.

---

## T065 — PDF region extraction

- **Status:** `[ ]` not started  · **Depends on:** T064 (the rendered PDF reader + the per-page
  coordinate space + the page-location substrate).
- **Roadmap line:** Done when drawing a rectangle around a figure/table creates an image extract with
  page number + coordinates as its own scheduled topic.

### Goal

In the PDF reader, the user **draws a rectangle** over a figure/table on a page; the app crops that
region to an **image asset** in the vault and creates a scheduled **`media_fragment`** extract whose
`source_locations` row carries the **page number + bounding box** — its own attention-scheduled topic,
with lineage preserved back to the source + page + region. The crop is produced in the **renderer**
(from the page it already has on a `<canvas>`) and shipped as a small, size-capped PNG to MAIN, which
**writes the bytes to the vault** (the renderer never resolves a path or writes to disk); the image
bytes live in the vault (never SQLite).

### Context to load first

- Reference: [`../domain-model.md`](../domain-model.md) (`media_fragment` = "a timestamped/region
  clip (PDF region, …)", line ~16; `source_locations … page, … region`, line ~123),
  [`../architecture.md`](../architecture.md) (`assets/media/<asset_id>/` layout, no-blobs rule),
  [`../../CLAUDE.md`](../../CLAUDE.md) (extraction stores parent/source/blockIds/offsets/page/snapshot;
  lineage sacred; `media_fragment` is a core element type).
- Existing code to inspect: `SourceRepository.createExtractWithin` + `CreateExtractInput` (its `page`
  field + the `source_locations` insert); `ElementLocation`/`source_locations` (add `region`);
  `AssetVaultService.importAsset` (the crop image goes through it, `kind: "image"`,
  `assets/media/<asset_id>/original.png`); the `ExtractionService` (T021) transaction shape; the T064
  `PdfReader` (the page render + coordinate space) + `extractPdfPages` line bboxes; the inspector +
  `LineageTree` (a `media_fragment` extract must show in lineage like any extract).
- Invariants in play: the crop render + vault write run **main-side**; the extract is an independent
  scheduled element (a `media_fragment`, NOT a highlight, NOT an inline node) with full lineage
  (parent = source, `derived_from` the source, `source_locations` anchoring page + bbox); image bytes
  in the vault only; one transaction + `create_extract` op; lineage preserved.

### The region model (specify concretely)

- The renderer captures a **normalized rect** `{ page: number; x0: number; y0: number; x1: number; y1:
  number }` where x/y are fractions `0–1` of the page's rendered width/height (scale-independent, so it
  is stable regardless of the render zoom). The reader draws the rubber-band overlay on the page
  canvas; on mouse-up it normalizes the pixel rect to fractions.
- **The RENDERER produces the crop** from the page it already has on a `<canvas>`: crop that canvas to
  the rubber-band rect into an offscreen canvas, encode it to a PNG (`canvas.toBlob("image/png")`), and
  ship the small PNG `ArrayBuffer` + the normalized rect + page to MAIN. **MAIN** streams the PNG bytes
  into the vault via `AssetVaultService.importAsset` and records the metadata in a transaction. This is
  the chosen render path (see "Dependencies to add") — NO native canvas, NO main-side re-render from
  `original.pdf`. The PNG is one figure-sized region, size-capped at the IPC boundary.
- The `source_locations` row stores `page` (1-based) + a new **`region`** column = the normalized rect
  JSON `{ x0, y0, x1, y1 }` (fractions). `selectedText` is the OCR/text under the region when
  available (from `extractPdfPages` lines intersecting the rect) else a generated label ("Figure on
  page N"); `blockIds` is the page's heading block id (so the region anchors to the page row).
- The extract element is type **`media_fragment`**, `stage: "raw_extract"`, attention-scheduled
  (inherits the source priority), parent = the source, body = a minimal doc referencing the image
  (the image is the ASSET, displayed by the inspector/extract view; the body is a caption/placeholder
  paragraph — the constrained schema has no image node, so the image lives as the linked asset, not
  inline).

### Dependencies to add (concrete, justified)

- **Raster render for the crop — render in the RENDERER, ship the cropped PNG to main (CHOSEN).**
  Rendering a PDF page region to a PNG needs a 2D canvas, which the headless Node `pdfjs` text path
  lacks. The renderer already has the page on a `<canvas>` (T064's `PdfReader`), so the region crop is
  produced THERE and only the small PNG crosses IPC:
  - On region select, crop the page canvas to the rubber-band rect
    (`canvas.getContext('2d').getImageData(rect)` into an offscreen canvas sized to the rect) →
    encode a PNG (`canvas.toBlob("image/png")`) → send the PNG `ArrayBuffer` over IPC; MAIN streams
    those bytes into the vault via `AssetVaultService.importAsset` and records the metadata in a
    transaction. **This needs NO new dependency** (the renderer is Chromium — `<canvas>`/`toBlob` are
    native) and NO native canvas + `asarUnpack`. The PNG is **one figure-sized region, not a full
    page**, so the IPC payload is small; **cap it** (reject a crop PNG over a small bound, e.g. 8 MB,
    in the Zod request — a single figure crop is far under this; the cap stops a hostile/huge rect).
  - **Non-goal (do NOT do this): a main-side re-render with a native canvas.** Backing
    `pdfjs-dist`'s `page.render({ canvasContext })` in MAIN with `@napi-rs/canvas` (a prebuilt Skia
    canvas) would re-render the page headlessly and crop the sub-rect there. It is **explicitly out of
    scope** for T065 — it pulls a native `.node` addon that must be `asarUnpack`'d for no fidelity
    win over cropping the already-rendered renderer canvas. Do not add `@napi-rs/canvas` (or any
    native canvas) for the region crop. If a future task genuinely needs a server-/headless-side
    re-render (none does today), that is a separate, justified decision — not this task.

### Deliverables

- [ ] **`source_locations.region` column + migration.** Add a nullable `region: text("region")` (JSON
      `{ x0, y0, x1, y1 }` fractions) to the `sourceLocations` table
      ([`../../packages/db/src/schema/sources.ts`](../../packages/db/src/schema/sources.ts) ~line 50);
      add `region: RegionRect | null` to `ElementLocation`
      ([`../../packages/core/src/element.ts`](../../packages/core/src/element.ts) ~line 80) with a
      `RegionRect = { x0: number; y0: number; x1: number; y1: number }` type; update
      `rowToSourceLocation` ([`../../packages/local-db/src/mappers.ts`](../../packages/local-db/src/mappers.ts)
      ~line 71) to parse it, and `createExtractWithin` to insert it. Run `pnpm db:generate` → the
      `0009_*` migration; commit the SQL. Pure widening, no backfill (existing rows get `null`). This
      finally makes the schema match the `region` column `domain-model.md` already documents (line ~123).
- [ ] **Extend `CreateExtractInput`** with `region?: RegionRect | null` (default `null`), forwarded
      into the `source_locations` insert in `createExtractWithin`
      ([`../../packages/local-db/src/source-repository.ts`](../../packages/local-db/src/source-repository.ts)
      ~line 322). Add an `elementType?: "extract" | "media_fragment"` (default `"extract"`) so the same
      seam can mint a `media_fragment` element for a region (the type drives the element row's `type`);
      keep the default unchanged for text extraction. Add a unit test that a region extract creates a
      `media_fragment` element + a `source_locations` row with the page + region.
- [ ] **Region-extract path in the extraction service / a new `createRegionExtract`.** Add a main-side
      flow (in `ExtractionService` or a thin `PdfRegionService`) that, given `{ sourceElementId, page,
      region, imageBytes | renderInputs }`: (1) lands the cropped PNG in the vault via
      `assetVault.importAsset({ owningElementId: <newExtractId>, kind: "image", source: <stream/path>,
      mime: "image/png", destRelativePath: "media/<asset_id>/original.png" })`; (2) creates the
      `media_fragment` extract + its `source_locations` row (page + region + label) via
      `createExtractWithin` in ONE transaction (`create_element` + `create_extract` ops); (3) the image
      asset is owned by the new extract element. Order the element-create and asset-import so the asset
      FK is valid (create the extract element first, then `importAsset` keyed by its id — same ordering
      decision as T064's PDF asset). Best-effort vault cleanup on a failed transaction.
- [ ] **IPC contract + channel + handler.** `sources.extractRegion(request: { sourceElementId: string;
      page: number; region: RegionRect; imagePng: ArrayBuffer; caption?: string | null; priority?:
      PriorityLabel }): Promise<{ id: string; item: <extract summary> }>` — **the renderer ships the
      cropped PNG** (the chosen render path above; there is no rect-only / main-re-render arm). Channel
      `sourcesExtractRegion: "sources:extractRegion"`; an async handler mirroring `extractionsCreate`.
      Validate the rect (0–1, x0<x1, y0<y1) AND **size-cap the `imagePng` byteLength** (e.g. ≤ 8 MB —
      one figure crop is far under this) in Zod, so a hostile/huge crop cannot cross the bridge.
- [ ] **Preload + renderer client** — `sources.extractRegion` → `appApi.extractRegion(request)`.
- [ ] **Renderer region-select UI in `PdfReader`** — a toggleable "region/figure" mode (a toolbar
      button + a shortcut, e.g. `R`) that, when on, lets the user **drag a rubber-band rect** over the
      page canvas; on release it shows a small confirm popover ("Extract this region as a card topic"
      with an optional caption + priority), then calls `extractRegion` (cropping the PNG from the
      rendered canvas for option (b)). On success it toasts, marks the region on the page (a light
      outline overlay, like the extracted-span marker), and refreshes the inspector so the new
      `media_fragment` shows under the source's children. Pure UI; no fs/SQL.
- [ ] **Inspector / lineage display.** A `media_fragment` region extract must render in the universal
      inspector + `LineageTree` like any extract (it already will via the element graph), and its
      detail view should show the **cropped image** (fetched through a typed asset-bytes command — the
      renderer never resolves the path) + the "Page N · region" source location with a jump-to-page
      affordance (open the PDF reader scrolled to the page, flashing the region outline). Reuse the
      jump-to-source mechanism (a `?page=N&region=…` param on the reader route).
- [ ] **Tests (unit)** — the `region` mapper round-trips a rect; `createExtractWithin` with a region +
      `elementType: "media_fragment"` creates the right element + location (page + region); rect
      validation rejects an inverted/out-of-range rect.
- [ ] **Tests (integration, main-side)** — extend `pdf-import-service.test.ts` (or a new
      `pdf-region.test.ts`): given an imported PDF source + a region request with fixture PNG bytes,
      the service lands an `image` asset under `media/<asset_id>/`, creates a `media_fragment` extract
      with a `source_locations` row carrying the page + region, appends `create_extract`, and the whole
      thing survives a DB re-open (restart-persistence).
- [ ] **Tests (E2E, Electron)** — extend `pdf-import.spec.ts` (or a new spec): in the PDF reader, drag
      a region on a page, confirm the extract, see a `media_fragment` appear under the source with the
      cropped image and "Page N · region" location; after an **app restart**, the region extract +
      image + location survive.
- [ ] **Docs** — check the T065 box with the commit ref + a Progress-log line noting the
      `source_locations.region` migration, the `media_fragment` region-extract path, and the reader
      rubber-band UI.

### Done when

- Drawing a rectangle over a figure/table in the PDF reader creates an **image extract** — a
  scheduled **`media_fragment`** element — whose `source_locations` row carries the **page number +
  bounding box (region)** and whose cropped image lives in the vault (`media/<asset_id>/`, bytes never
  in SQLite). It is its own attention-scheduled topic with lineage back to the source + page + region.
- The crop is produced in the renderer and shipped as a small, size-capped PNG to MAIN, which writes
  it to the vault (the renderer never resolves a path or writes to disk); the renderer reaches it
  through the typed `window.appApi` only.
- The `media_fragment` shows in the inspector + lineage and its detail view shows the cropped image +
  a jump-to-page-region affordance.
- The `0009_*` `source_locations.region` migration is included and applies cleanly; everything
  survives an **app restart**.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass.

### Notes / risks

- **Coordinate fidelity.** Store the region as **normalized fractions** (0–1 of the page), never raw
  pixels, so a re-render at any zoom maps back correctly. Validate `x0<x1, y0<y1, 0≤·≤1`. Re-use T064's
  documented coordinate convention.
- **No new native dependency.** The crop is rendered in the Chromium renderer (it already has the
  page on a `<canvas>`) and only the small PNG crosses IPC for the vault write — so T065 adds NO
  native canvas and NO `asarUnpack`. Do NOT pull `@napi-rs/canvas` (or any native canvas) for a
  main-side re-render; that path is an explicit non-goal (see "Dependencies to add"). Size-cap the
  PNG that crosses IPC (one figure crop is small).
- **The image is an asset, not an inline node.** The constrained editor schema has no image node
  (deliberately). A region figure is a linked `image` asset on a `media_fragment` element, displayed
  by the inspector/extract view — do NOT widen the document schema to embed images here (that is
  M15/T071 image-occlusion territory; this task only links the cropped asset).
- **Downstream:** T071 (image occlusion, M15) builds masks on TOP of these `media_fragment` image
  extracts — keep the region image a clean base asset (the crop, no baked-in annotations) so
  occlusion masks can be stored separately later.

---

## T066 — OCR fallback

- **Status:** `[ ]` not started  · **Depends on:** T064 (the imported PDF + the `hasText: false`
  per-page signal + the page doc to attach text to), T058 (the background runner — OCR runs as a job
  on it, DB-free worker, results posted back to main).
- **Roadmap line:** Done when OCR jobs run on the local background runner (on-device, e.g.
  Tesseract/WASM) and produce searchable/extractable text for scanned pages/images with confidence
  metadata attached to page/region (not blindly inserted into the body).

### Goal

For a scanned/image PDF (or an image region) with no embedded text, the app runs **OCR on the T058
background runner** — a DB-free `utilityProcess` worker using **`tesseract.js` (WASM)** — producing
per-page recognized text **with confidence metadata** (word/line/page confidence). The worker posts
results back to MAIN, which persists them as a **reviewable OCR layer** keyed to the page (and, for a
region, to the region) — **NOT** blindly merged into the document body. The user sees the OCR text +
its confidence and can accept it into the page (making it searchable/extractable) or extract from it
explicitly; low-confidence OCR is flagged, never silently trusted. OCR is enqueued automatically for a
text-free PDF on import (or on demand from the reader) and survives an app restart (the queued job
resumes).

### Context to load first

- Reference: [`../architecture.md`](../architecture.md) (on-device runner; `assets/media/<asset_id>/
  … ocr.json` layout, line ~181 — OCR output is an asset/structured store, not a SQLite blob),
  [`../domain-model.md`](../domain-model.md) (the `assets`/`source_locations` shapes),
  [`../../CLAUDE.md`](../../CLAUDE.md) (Electron security, single-writer SQLite, the closed
  `operation_log` vocabulary — OCR is infra + an `update_document`-style mutation, NOT a new op type).
- Existing code to inspect: the FULL runner stack — `JobRunner`
  ([`../../apps/desktop/src/main/job-runner.ts`](../../apps/desktop/src/main/job-runner.ts)), the
  worker dispatch + `messages.ts`
  ([`../../apps/desktop/src/worker/job-worker.ts`](../../apps/desktop/src/worker/job-worker.ts)), the
  apply-handler registry
  ([`../../apps/desktop/src/main/job-apply-handlers.ts`](../../apps/desktop/src/main/job-apply-handlers.ts)),
  the `jobs` table + `JobsRepository`, the esbuild `dist/job-worker.cjs` target
  ([`../../apps/desktop/build.mjs`](../../apps/desktop/build.mjs)), and the **already-reserved `ocr`
  JobType** ([`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts) ~line 179); the
  `AssetVaultService` (the page-image + `ocr.json` go through it); the T064 `extractPdfPages.hasText`
  signal + `document_blocks.page`; the reader.
- Invariants in play: **the worker NEVER opens SQLite** — it does pure compute (OCR) and posts
  serializable results; MAIN persists in a transaction through the repositories; OCR is **at-least-once
  + idempotent** (a re-run re-OCRs and overwrites the same page's OCR layer — no duplicate rows, keyed
  by page); confidence is ATTACHED, the text is NOT blindly inserted; the `ocr` job adds NO
  `operation_log` op type (infra); everything survives an app restart (the queued job resumes via
  `recoverRunning`).

### Dependencies to add (concrete, justified)

- **`tesseract.js`** (`^6.x`) — the canonical pure-WASM OCR engine, runs **fully on-device** with no
  native binary and no server, in the runner's DB-free worker. It loads a WASM core + a language
  `traineddata` (eng) and returns recognized text WITH per-word/line/block **confidence** + bounding
  boxes (exactly the metadata this task must surface). Add it to `apps/desktop` dependencies (it is the
  worker's dep; the worker bundle is `dist/job-worker.cjs`). **Asset/bundling caveat (load-bearing —
  the packaged app ships NO `node_modules`):** `tesseract.js` needs its WASM core
  (`tesseract.js-core`) + the `eng.traineddata` language file at runtime — these are DATA files, NOT
  bundled by esbuild, and they live in `node_modules/`. But `apps/desktop/electron-builder.yml`'s
  `files:` list ships only `dist/**`, `native/**`, `package.json` and explicitly **EXCLUDES**
  `node_modules/**` (the app is fully self-contained in `dist/main.cjs` + `dist/job-worker.cjs`), so
  the WASM core + `eng.traineddata` sitting in `node_modules` would **never be packaged**. They must
  be STAGED into `dist/` at build time and then both packaged AND `asarUnpack`'d (a `.wasm`/data file
  cannot be `dlopen`'d/read from inside the asar archive). Ship them locally and point `tesseract.js`
  at LOCAL paths (NOT its default CDN — offline-first, NO network) — see the dedicated
  "Stage + package the tesseract WASM/langdata" deliverable below.

  **Justification over alternatives:** native Tesseract (`node-tesseract-ocr`) needs a system binary
  (not self-contained, breaks "no install"); cloud OCR (Google/AWS) violates the local-first invariant
  (no server, no network). `tesseract.js` is the only fully-bundled, offline, on-device option and is
  what the roadmap line names ("Tesseract/WASM").

### The OCR persistence model (specify concretely — "not blindly inserted")

- OCR output is a **separate, reviewable layer**, never auto-merged into the body. Store it as a typed
  per-page record. Pick the store + document it:
  - **(preferred) An `ocr_pages` table** (new, T066 migration): `{ id, sourceElementId, page,
    text, meanConfidence (0–100), wordConfidences (JSON), bbox/words (JSON, for word-level
    placement), status ("suggested" | "accepted" | "dismissed"), createdAt, updatedAt }`, indexed by
    `(sourceElementId, page)` UNIQUE so a re-OCR overwrites the page's record (idempotent). The text is
    "suggested" until the user accepts it.
  - The recognized text is ALSO written to the vault as `assets/sources/<source_id>/ocr/page-N.json`
    (the `ocr.json` analog the architecture layout names) via `AssetVaultService.importAsset` (kind
    `snapshot` or a dedicated `ocr` asset kind — add `"ocr"` to `ASSET_KINDS` if a distinct kind reads
    cleaner) for durability/export; the SQLite `ocr_pages` row holds the queryable text + confidence.
  Choose ONE primary store (the `ocr_pages` table is the source of truth; the vault json is the
  durable export copy) and keep them written in the same apply step.
- **Accepting OCR text** (an explicit user action) merges the page's OCR text into the document body's
  empty page paragraphs (replacing the empty "Page N" body the T064 importer left) through the EXISTING
  `documents.save` path (logging `update_document`) — so accepted OCR becomes ordinary, searchable,
  extractable body text with the page's stable block ids. Until accepted it is a suggestion overlay,
  shown with its confidence. **Low confidence** (e.g. meanConfidence < a threshold) is flagged in the
  UI and never auto-accepted.

### Deliverables

- [ ] **`ocr_pages` table + migration** (`packages/db/src/schema/` — a new module or fold into
      `documents.ts`): the per-page OCR record above, UNIQUE on `(sourceElementId, page)`, FK to
      `elements` (`onDelete: cascade`). Run `pnpm db:generate` → the `0010_*` migration; commit the SQL.
      (If `"ocr"` is added to `ASSET_KINDS`, that is the same migration's concern only for the CHECK
      constraint — note it.)
- [ ] **`OcrPagesRepository`** in `packages/local-db/src/ocr-pages-repository.ts` — typed,
      transactional access: `upsertPage(input)` (insert-or-replace by `(sourceElementId, page)` — the
      idempotent write the at-least-once job needs), `listForSource(sourceElementId)`,
      `findPage(sourceElementId, page)`, `setStatus(id, status)`. Register in
      `Repositories`/`createRepositories`. OCR rows add NO `operation_log` op (the recognized-text
      layer is a suggestion; ACCEPTING it logs `update_document` via the normal document save).
- [ ] **Pure OCR transform interface in `@interleave/importers`** (optional but clean): a thin
      `recognizePageImage(pngBytes): Promise<OcrResult>` wrapper type/contract (`OcrResult = { text;
      meanConfidence; words: { text; confidence; bbox }[] }`) so the worker + tests share one shape.
      The actual `tesseract.js` call lives in the worker (it is the heavy WASM dep); the importers
      package owns the TYPE + a fixture-testable post-processor (e.g. line-grouping) only.
- [ ] **Stage + package the tesseract WASM/langdata (load-bearing — `node_modules` is NOT shipped).**
      The packaged app ships only `dist/**` + `native/**` + `package.json` (electron-builder.yml `files:`
      **excludes** `node_modules/**`), so the `tesseract.js-core` WASM + `eng.traineddata(.gz)` living in
      `node_modules` must be staged into `dist/` and packaged + unpacked explicitly:
  - [ ] **(a) Stage into `dist/` during the build.** In
        [`../../apps/desktop/build.mjs`](../../apps/desktop/build.mjs) (alongside `stageMigrations()` /
        `stageRenderer()`), add a `stageTesseract()` step that `cpSync`s the `tesseract.js-core` WASM
        (resolved from the installed `tesseract.js-core` package) + the worker script tesseract needs +
        `eng.traineddata(.gz)` into `dist/resources/tesseract/`. (Source the `eng.traineddata` from a
        pinned `@tesseract.js-data/eng` package or a committed copy under `apps/desktop/resources/` that
        the step copies; do NOT fetch it at build time — offline.)
  - [ ] **(b) Package + unpack it.** `dist/resources/tesseract/**` is already PACKAGED by the existing
        `dist/**/*` `files:` glob, but the `.wasm`/data files cannot be read from inside the asar — so
        add `"dist/resources/tesseract/**/*"` to `apps/desktop/electron-builder.yml` **`asarUnpack:`**
        (beside `native/**/*`) so they land in `app.asar.unpacked/`.
  - [ ] **(c) Load from the staged path, not `node_modules`.** Configure
        `createWorker("eng", 1, { workerPath, corePath, langPath })` (in the OCR worker) with paths
        resolved relative to the worker bundle / app resources — i.e. the unpacked
        `resources/tesseract/` dir (NOT a `node_modules` path, which does not exist in the packaged
        app, and NOT the CDN). Verify the packaged app OCRs a fixture image with the network DISABLED
        (offline). Call this out in the build config + a Progress-log line.
- [ ] **Give the worker the vault root (new fork-env seam — genuinely new plumbing).** The runner
      forks the worker with NO env/args today
      ([`../../apps/desktop/src/main/job-runner.ts`](../../apps/desktop/src/main/job-runner.ts) ~line
      126: `utilityProcess.fork(workerPath)`), so the DB-free OCR worker cannot resolve the
      vault-relative page-PNG path. Add it:
  - [ ] Thread `assetsDir` into the `JobRunner` (it already flows to `db-service.open(…, { assetsDir })`
        / `AppPaths.assetsDir`) and into the fork factory, then change `defaultFork` to
        `utilityProcess.fork(workerPath, [], { env: { ...process.env, INTERLEAVE_ASSETS_DIR: <assetsDir> } })`.
        (Keep the no-`assetsDir` case harmless for the existing `url_import`/`vault_*` jobs, which do
        not read it.)
  - [ ] In [`../../apps/desktop/src/worker/job-worker.ts`](../../apps/desktop/src/worker/job-worker.ts),
        read `process.env.INTERLEAVE_ASSETS_DIR` ONCE at module load into a const and use it in the
        `ocr` case to resolve `path.join(assetsDir, imagePagePath)`. The persisted job `payload`
        carries ONLY the **vault-relative** `imagePagePath` (never an absolute path, never bytes), so
        the `jobs` row stays restart-safe + SQLite-persistable; the `WorkerRequestSchema` envelope is
        unchanged. (See the payload rule below for the full rationale.)
- [ ] **Worker dispatch for `ocr`** in
      [`../../apps/desktop/src/worker/job-worker.ts`](../../apps/desktop/src/worker/job-worker.ts):
      add a `case "ocr":` that receives `{ sourceElementId, page, imagePagePath }` — a
      **vault-relative path to a page PNG that MAIN already rendered and wrote to the vault**
      (NOT raw image bytes; see the payload rule below) — resolves it against the vault root the
      worker now reads from `process.env.INTERLEAVE_ASSETS_DIR` at startup (the new fork-env seam —
      see the payload rule), runs `tesseract.js` (a worker-local `createWorker` pointed at the
      LOCAL WASM/lang paths — see the dependency note), posts `progress` (per page) then a
      `result` `{ page, text, meanConfidence, words }`. **The worker stays DB-FREE** — it reads the
      page PNG from the path MAIN prepared and returns text only; MAIN persists. Extend
      `messages.ts` shapes (Zod) for the OCR result if its shape differs from
      the generic `result.data` (it can ride the generic `data` JSON — keep the message envelope
      unchanged, just a job-type-specific `data` shape validated at the apply boundary).
      > **Payload rule (load-bearing — no blob in the persisted queue).** The `jobs` table
      > **persists every job's `payload` JSON in SQLite** (`JobsRepository.enqueue` writes
      > `EnqueueJobInput.payload: JobJsonValue` to a row that survives restart). Therefore the
      > OCR payload MUST carry a **vault-relative page-image PATH** (`imagePagePath`), NEVER the
      > PNG bytes (`imagePng`): embedding a full rendered page PNG as base64 JSON in that row
      > both stores a binary blob in SQLite (violating the architecture "No large blobs in
      > SQLite" rule, [`../architecture.md`](../architecture.md) l169) and serializes a large
      > blob through the persisted queue. MAIN renders the text-free page to a PNG **in the vault**
      > (`assets/sources/<source_id>/ocr/page-N.png`) BEFORE enqueueing, then enqueues only that
      > **vault-relative** path — exactly the way `PdfImportService` keeps the large PDF out of
      > IPC/SQLite. The worker resolves that relative path against the **vault `assetsDir`** and
      > reads the bytes itself. **Do not** accept an `imagePng` bytes arm in the payload.
      > **New plumbing (the worker has no `assetsDir` today — this task adds it).** The runner
      > currently forks the worker with NO env/args/`workerData`: `defaultFork()` calls
      > `utilityProcess.fork(workerPath)`
      > ([`../../apps/desktop/src/main/job-runner.ts`](../../apps/desktop/src/main/job-runner.ts) ~line
      > 126), the worker reads no `process.env`/`argv`
      > ([`../../apps/desktop/src/worker/job-worker.ts`](../../apps/desktop/src/worker/job-worker.ts)),
      > and `WorkerRequestSchema` carries only `{ jobId, type, payload }`
      > ([`../../apps/desktop/src/worker/messages.ts`](../../apps/desktop/src/worker/messages.ts)) — so
      > the worker has no way to learn `assetsDir`. T066 ADDS it as a small, additive seam:
      > **(1)** change `defaultFork` to pass the vault dir via the child's env —
      > `utilityProcess.fork(workerPath, [], { env: { ...process.env, INTERLEAVE_ASSETS_DIR: <assetsDir> } })`
      > (the runner already knows `assetsDir`: thread it in from `db-service.open(…, { assetsDir })` /
      > `AppPaths.assetsDir` to the `JobRunner` constructor, then into the fork factory) — env is chosen
      > over `payload` deliberately so the absolute vault root **never** lands in a persisted `jobs` row;
      > **(2)** the worker reads `process.env.INTERLEAVE_ASSETS_DIR` ONCE at startup (a module-level
      > const) and, in the `ocr` case, resolves the payload's **vault-relative** `imagePagePath`
      > against it (`path.join(assetsDir, imagePagePath)`) to read the PNG; **(3)** the job `payload`
      > keeps ONLY the relative path (`imagePagePath`) so the persisted queue stays restart-safe and
      > SQLite-persistable — no absolute path is ever written to the `jobs` table. Keep the
      > `WorkerRequestSchema` envelope unchanged (the relative path rides the per-job `payload`); the
      > only message-shape work is the OCR-specific `payload`/`result` `data` validation at the apply
      > boundary. **Do not** accept an `imagePng` bytes arm in the payload.
- [ ] **`ocr` apply handler** in
      [`../../apps/desktop/src/main/job-apply-handlers.ts`](../../apps/desktop/src/main/job-apply-handlers.ts):
      `ocr: async (job, resultData) => …` — take the worker's `{ page, text, meanConfidence, words }`,
      `upsertPage(...)` into `ocr_pages` (status `suggested`), write the durable `ocr/page-N.json` to
      the vault via `AssetVaultService.importAsset`, and return a small serializable summary. It is
      **idempotent** (upsert by page). Bind it like the existing handlers (a `getOcrService()`/
      `getOcrPagesRepo()` accessor on the open DB). NOTE the per-page image: MAIN must render the page
      image (from `original.pdf`, the same render path T065 uses) and write it **to the vault**
      (`assets/sources/<source_id>/ocr/page-N.png`), then put that **vault-relative path** (NOT the
      bytes) into the job payload BEFORE enqueueing each page's `ocr` job — the worker only OCRs, it
      never reads the PDF/DB and never receives image bytes in the persisted payload (see the payload
      rule above). Document this main-renders-page-to-vault → enqueue-path → worker-OCRs →
      main-persists flow (the T058 pattern).
- [ ] **Enqueue OCR.** Two triggers, both enqueuing one `ocr` job PER text-free page through the
      runner (`runner.enqueue("ocr", { sourceElementId, page, imagePagePath })` — a vault-relative
      page-PNG path MAIN rendered first, NEVER bytes; see the payload rule above):
  - **Automatic on import (T064 hook):** when `PdfImportService` sees `pages.every(p => !p.hasText)`
    (or some pages text-free), render each text-free page to `assets/sources/<source_id>/ocr/page-N.png`
    in the vault, then enqueue an `ocr` job carrying that page's path after the source is created
    (so OCR backfills the scanned PDF without the user asking). Keep it bounded (a per-source cap /
    sequential) so a 500-page scan does not flood the queue at once.
  - **On demand from the reader:** an "Run OCR on this page" action in the PDF reader enqueues the job
    for the current page; the reader observes the job via the existing `jobs.subscribe` surface (T058)
    to show progress.
  Enqueue is MAIN-side (render the page image **to the vault**, then enqueue its path). The renderer
  triggers OCR ONLY through a typed command (e.g. `sources.runOcr({ elementId, page? })`) — no generic
  `jobs.enqueue` from the renderer (T058's decision stands).
- [ ] **IPC contract + channels + handlers** — `sources.runOcr(request: { elementId: string; page?:
      number }): Promise<{ enqueued: number }>` (channel `sourcesRunOcr`), and a read surface
      `sources.getOcr(request: { elementId: string }): Promise<{ pages: OcrPageSummary[] }>` (channel
      `sourcesGetOcr`) where `OcrPageSummary = { page; text; meanConfidence; status }` (the renderer
      shows the suggestion + confidence). An `sources.acceptOcr(request: { elementId; page })` command
      merges the page's OCR text into the body via the existing `documents.save` path (logging
      `update_document`) and sets the `ocr_pages` row `accepted`. Async handlers; Zod-validated.
- [ ] **Preload + renderer client** — mirror `sources.runOcr` / `sources.getOcr` / `sources.acceptOcr`
      into the preload + `appApi`.
- [ ] **Renderer OCR affordance in `PdfReader`** — for a text-free page show a "Scanned page — Run
      OCR" prompt; while the `ocr` job runs, show progress (via `jobs.subscribe`); when done, show the
      recognized text as a **suggestion overlay with a confidence badge** (green/amber/red by
      threshold) and an **Accept** / **Dismiss** choice. Accepting calls `acceptOcr` (the text becomes
      ordinary page body, searchable + extractable); dismissing sets `dismissed`. **The text is NEVER
      auto-merged** — the user accepts it. Low confidence is visibly flagged. Pure UI; one command per
      action.
- [ ] **Search integration (light).** Accepted OCR text flows into search through the normal
      `documents.save` → `plainText` → FTS path (no new search work — accepting OCR updates the body,
      which the existing search indexes). SUGGESTED (un-accepted) OCR is NOT in the body, so it is not
      searched until accepted — note this is intentional (un-reviewed OCR should not pollute search).
- [ ] **Tests (unit)** — `OcrPagesRepository` upsert is idempotent (a second upsert for the same
      `(source, page)` overwrites, not duplicates); `setStatus` transitions; the importers `OcrResult`
      post-processor (line grouping / confidence aggregation) over a fixture OCR payload.
- [ ] **Tests (integration, main-side — the runner + apply, the T058 fake-worker pattern)** in
      `apps/desktop/src/main/ocr-job.test.ts` against a real temp-file DB + temp `assetsDir`, using the
      **fake/in-process worker injected via the `fork` factory** (the same seam `job-runner.test.ts`
      uses — `utilityProcess` is unavailable under Vitest): enqueue an `ocr` job whose fake worker
      returns a known `{ page, text, meanConfidence, words }` → MAIN's apply handler upserts an
      `ocr_pages` row (status `suggested`) + writes `ocr/page-N.json` to the vault + the job is
      `succeeded`. **Idempotency/restart:** enqueue, simulate a crash leaving the job `running`, re-open
      the DB + start a new runner → `recoverRunning` re-queues it, it completes, and the `ocr_pages` row
      is present exactly once (no duplicate) and survives the re-open. Accepting OCR (`acceptOcr`) merges
      the text into the body (assert the document `plainText` now contains the OCR text + an
      `update_document` op).
- [ ] **Tests (contract)** — the `SourcesRunOcr`/`SourcesGetOcr`/`SourcesAcceptOcr` schemas round-trip;
      the worker `ocr` message `data` shape validates.
- [ ] **Tests (E2E, Electron — the real `tesseract.js` WASM worker)** — `tests/electron/pdf-ocr.spec.ts`:
      import a SCANNED fixture PDF (no text layer), see the "Run OCR" prompt, run OCR (the REAL
      `utilityProcess` worker runs `tesseract.js` against the LOCAL bundled WASM/lang, network
      disabled), see the recognized text + a confidence badge, Accept it → the page body now has the
      text and it is searchable; after an **app restart**, the accepted OCR text + `ocr_pages` row +
      `ocr/page-N.json` survive. (This is where the real WASM OCR + bundled-langdata + offline
      requirement is proven — Vitest uses the fake worker.)
- [ ] **Docs** — check the T066 box with the commit ref + a Progress-log line noting: the `tesseract.js`
      dep + the bundled-WASM/langdata + offline requirement, the `ocr` job wired end-to-end on the T058
      runner, the `ocr_pages` table + repository, the confidence-gated reviewable layer (not blind
      insertion), and the `0010_*` migration.

### Done when

- OCR runs **on the T058 background runner** — a DB-free `utilityProcess` worker using `tesseract.js`
  (WASM), fully on-device, with the WASM core + `eng.traineddata` bundled locally (NO network/CDN) — and
  produces per-page recognized text WITH **confidence metadata**; results post back to MAIN, which
  persists them through the repositories (the worker never opens SQLite).
- The recognized text is attached as a **reviewable, confidence-flagged layer** keyed to the page —
  **NOT blindly inserted** into the body. The user explicitly **accepts** OCR text into the page (then
  it becomes ordinary searchable/extractable body via `documents.save` → `update_document`); low
  confidence is visibly flagged and never auto-accepted.
- OCR is enqueued automatically for a text-free imported PDF and on demand from the reader; the
  renderer observes progress via the existing `jobs.subscribe` surface and triggers it only through a
  typed command (no generic `jobs.enqueue` from the renderer).
- The `ocr` job is **idempotent** (upsert by `(source, page)`) and **survives an app restart** (a
  queued/running-on-crash job resumes via `recoverRunning` and the OCR row appears exactly once).
- An Electron E2E OCRs a scanned fixture PDF with the **real WASM worker, offline**, surfaces
  confidence, accepts the text into the searchable body, and everything survives a restart.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass; the `0010_*`
  migration applies cleanly on an existing dev DB.

### Notes / risks

- **Bundling the WASM + language data (load-bearing).** `tesseract.js` defaults to fetching its core +
  `traineddata` from a CDN — forbidden (offline-first, no network). And the packaged app ships NO
  `node_modules` (electron-builder.yml `files:` excludes it), so the core/langdata must be STAGED into
  `dist/resources/tesseract/` by `build.mjs`, packaged via the existing `dist/**` glob, AND added to
  electron-builder.yml `asarUnpack:` (a `.wasm`/data file cannot be read from inside the asar). Point
  `createWorker("eng", …, { corePath, langPath, workerPath })` at those staged/unpacked LOCAL paths
  (resolved relative to the worker bundle / app resources), never `node_modules`, never the CDN. The
  E2E must prove OCR works with the network disabled. This is the single biggest concrete gotcha.
- **The worker is DB-free; MAIN prepares the page image.** Because the worker never opens SQLite or
  reads `original.pdf` from the vault by itself, MAIN renders each text-free page to a PNG (the T065
  render path) and passes the bytes/path in the job payload; the worker OCRs and returns text; MAIN
  persists. Keep the render in main (or a separate non-OCR step) so the worker only does the WASM OCR.
- **At-least-once + idempotency.** A crash-then-resume can re-run an `ocr` job — the `upsertPage` by
  `(source, page)` makes a re-run overwrite, not duplicate (the T058 apply-handler contract). Never
  append-only OCR rows.
- **Confidence is first-class, insertion is opt-in.** Per the roadmap line, confidence is ATTACHED to
  the page/region and the text is NOT auto-merged. Surface the confidence (per-page mean + per-word for
  low-confidence highlighting) and gate acceptance on the user. This protects the document body from
  silent OCR garbage — the whole point of "not blindly inserted."
- **Region OCR (ties to T065).** A region `media_fragment` whose crop is an image can ALSO be OCR'd
  (same `ocr` job, keyed to the region's location instead of a page) to give the region a text
  `selectedText` — a small extension of the same path; T066 ships page OCR, and the region case reuses
  the worker + apply handler with a region key. Keep the `ocr_pages` schema extensible (a nullable
  `sourceLocationId` for a region-scoped OCR) so the region case slots in without a reshape.
- **Performance.** OCR is slow (seconds/page). Bound the auto-enqueue (sequential / a per-source cap),
  show progress, and keep it OFF the main thread (the runner already guarantees this). Do not auto-OCR
  a 500-page scan all at once — enqueue lazily (e.g. on first read of a page) or in a bounded batch.

---

## Exit criteria for the M14 PDF subset (T064–T066)

- T064, T065, T066 are `[x]` in [`../roadmap.md`](../roadmap.md) with commit refs + Progress-log
  entries (noting: `pdfjs-dist` for render/text/coords, `tesseract.js` WASM for offline OCR on the T058
  runner, the `document_blocks.page` / `source_locations.region` / `ocr_pages` migrations, and that
  PDF assets stream into the T059 vault — no S3, no server).
- A user can import a local PDF, read it incrementally with selectable text + page read-points, extract
  page text (linked to its page) and figure/table regions (as scheduled `media_fragment` topics with
  page + bbox), and — for a scanned PDF — run on-device OCR that produces a confidence-flagged,
  reviewable text layer they explicitly accept into the searchable body.
- All of it goes through the typed `window.appApi` — no fs/parse/SQL/OCR in the renderer; PDF parsing +
  vault writes run main-side; OCR runs on the T058 runner (DB-free worker, results applied in main).
  Pure transforms live in `@interleave/importers` with fixture tests; orchestration is the injectable
  `PdfImportService` + the runner apply handlers.
- Everything **survives an app restart** (proven by the Electron E2Es), and source lineage (source →
  page → text/region extract → OCR layer) is preserved.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the Electron Playwright E2Es are green in CI.

When the PDF subset is complete, the remaining M14 tasks (T067 EPUB import, T068 Markdown/HTML
import-export, T069 highlight import, T070 Anki import/export) extend this same source-pipeline +
`@interleave/importers` substrate — generate their detailed specs from the roadmap before starting
them (EPUB = a zip+XHTML parser into chapter sources; Markdown = a `markdown-it`/PM serializer
round-trip; Anki = a zip + embedded-SQLite-collection + media reader).

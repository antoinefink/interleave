# M14 — EPUB / Markdown / HTML / highlight / Anki formats (T067–T070)

Detailed, buildable specs for the **format-interop** half of M14. The PDF half
(T064 PDF import, T065 region extraction, T066 OCR) lands in a sibling spec
(`tasks/M14-pdf-ocr.md`); **this file owns T067–T070** — getting knowledge **in** from
the formats people actually keep their reading in (EPUB books, Markdown/HTML notes,
Readwise/Kindle highlight exports, Anki decks) and **out** again (Markdown export,
Anki `.apkg`/CSV export) — without ever leaving the local-first envelope.

> **Local-first (authoritative for all of M14 — see [`../roadmap.md`](../roadmap.md)
> M14 header, lines ~237–256).** Imported documents and their original bytes live in
> the **filesystem asset vault** (T059 `AssetVaultService.importAsset`, streamed +
> deduped), **never** app-level S3. Heavy parsing (EPUB unzip + XHTML walk, Anki
> collection read, OCR) runs in the **Electron main process** or — for genuinely
> heavy/async work — on the **T058 on-device background runner** (an Electron
> `utilityProcess`), **never** a server worker. The renderer never touches
> SQLite/Node/fs — it calls `window.appApi`. Imports create **inbox sources** (and,
> for highlights, **inbox extracts**) through the **existing transactional source
> pipeline** (`SourceRepository.createWithDocument*`/`createExtractWithin`), append
> `operation_log`, soft-delete only, and **map document content to the constrained
> editor schema** (`packages/editor/src/schema.ts`) with **stable block ids**
> (`packages/editor/src/block-id.ts`). Everything survives an **app restart**. Verify
> with native **pnpm** (`pnpm typecheck`/`pnpm lint`/`pnpm test`/`pnpm e2e
> --project=electron`), NOT Docker. Any schema change ships a Drizzle migration.

Everything here obeys the established architecture (see [`../../CLAUDE.md`](../../CLAUDE.md)
+ [`../architecture.md`](../architecture.md)):

```txt
React UI (renderer)                          ← picks files, observes job state; never parses bytes
  → typed client API wrapper (appApi.ts)
  → Electron preload bridge (window.appApi)  ← narrow typed surface; validated IPC payloads (Zod)
  → Electron main / DB service (validated IPC) ← OWNS the single SQLite writer + the file dialogs + vault
  → import services (apps/desktop/src/main) composing @interleave/importers (pure transforms)
  → packages/local-db repositories/services → SQLite + filesystem asset vault
```

The single load-bearing rule, restated for M14: **the renderer never reads a file off
disk, never parses an EPUB/Markdown/`.apkg`, never touches the vault.** It hands the
main process a chosen file path (or pasted text), and the main process does the parse
(pure transforms in `@interleave/importers`) + the vault write + the one transactional
DB mutation. Pure transforms are framework-agnostic and **fixture-testable**; the
main-side services are construction-time-injected (`{ db, repositories, assetsDir }`)
exactly like the shipped `UrlImportService`/`AssetVaultService`.

## Read first

- Spec contract: [`_TEMPLATE.md`](./_TEMPLATE.md) (REQUIRED shape). Format/depth
  exemplars: [`M2-capture-and-inbox.md`](./M2-capture-and-inbox.md),
  [`M12-web-import.md`](./M12-web-import.md) (the importer + source-pipeline seam M14
  builds ON), and [`M12-runner-and-vault.md`](./M12-runner-and-vault.md) (the runner +
  vault you reuse). **Match their structure, depth, and "Done when" style.**
- Reference: [`../architecture.md`](../architecture.md) — the planned
  `packages/importers/` "Readability, PDF, **EPUB**, video, RSS, email import logic"
  (line ~120), the asset-vault layout (`assets/sources/<source_id>/`, lines ~173–188),
  the on-device-runner note (lines ~77–79). [`../domain-model.md`](../domain-model.md)
  — `source` ("an imported article/**book**/paper/note/media", line ~10), `topic` ("a
  readable unit derived from a source — e.g. a **chapter/section**", line ~11),
  `extract` ("independent scheduled elements, **not** highlights", line ~159), the
  `source_locations` anchor (with its `page` column), the closed `operation_log`
  vocabulary. [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — imported
  material defaults to a **non-dominating** priority so a fresh book/deck does not bury
  older high-value material. [`../design-system.md`](../design-system.md) + the kit inbox
  screen — imports slot into the SAME inbox import strip; do NOT invent a new screen.

## What already exists (confirmed by inspecting the repo — do NOT rebuild these)

- **The source pipeline + tx-composable seams** in
  [`../../packages/local-db/src/source-repository.ts`](../../packages/local-db/src/source-repository.ts):
  - `createWithDocument(input)` and `createWithDocumentWithin(tx, input)` (~lines
    200–292) create the `source` element + `sources` provenance row + `documents` body
    + stable `document_blocks` in ONE transaction, logging `create_element` +
    `create_source` + `update_document`. `CreateSourceWithDocumentInput` already
    accepts a **pre-built `conversion: PlainTextConversion`** (so an importer hands a
    ready doc through verbatim — no re-conversion), an optional pre-minted `id`, and the
    full provenance set (`title`, `author`, `publishedAt`, `accessedAt`, `url`,
    `canonicalUrl`, `originalUrl`, `snapshotKey`, `reasonAdded`, `priority`, `status`,
    `stage`). **This is the convergence point** for EPUB/MD/HTML imports.
  - `createExtractWithin(tx, input)` (~lines 322–377) creates an independent scheduled
    `extract` element + its `source_locations` anchor (block ids / offsets / page /
    label / `selectedText` snapshot), logging `create_extract`. **This is the
    convergence point** for highlight import (T069) — a highlight becomes an extract, not
    a card.
- **`ExtractionService`** in
  [`../../packages/local-db/src/extraction-service.ts`](../../packages/local-db/src/extraction-service.ts)
  — composes `createExtractWithin` with body-seed + tag/priority inheritance + the
  parent `extracted_span` mark. T069 reuses its extract-authoring pattern (or
  `createExtractWithin` directly when there is no parent body to mark).
- **`CardService`** in
  [`../../packages/local-db/src/card-service.ts`](../../packages/local-db/src/card-service.ts)
  — `createFromExtract(input)` authors a `card` element from an extract in one
  transaction (`create_element` + `create_card` + an un-due `review_states` row + tag
  inheritance + sibling-group edge + cloze `document_marks`). The `cards` table
  ([`../../packages/db/src/schema/cards.ts`](../../packages/db/src/schema/cards.ts)) has
  `kind` (`qa`/`cloze`), `prompt`, `answer`, `cloze`, `sourceLocationId`, `isLeech`;
  `review_states` holds the FSRS memory state (`dueAt`, `stability`, `difficulty`,
  `elapsedDays`, `scheduledDays`, `reps`, `lapses`, `fsrsState`, `learningSteps`,
  `lastReviewedAt`); `review_logs` is the append-only grading history. **This is the
  convergence point** for Anki import/export (T070).
- **`@interleave/importers`** (`packages/importers/`):
  [`readability.ts`](../../packages/importers/src/readability.ts) (`extractArticle`),
  [`sanitize.ts`](../../packages/importers/src/sanitize.ts) (`sanitizeArticleHtml` +
  `SANITIZE_ALLOWED_TAGS`), and
  [`html-to-prosemirror.ts`](../../packages/importers/src/html-to-prosemirror.ts)
  (`htmlToProseMirrorDoc(html, mint?) → PlainTextConversion`). The HTML→PM converter is
  the SHARED transform EPUB (XHTML) and HTML import REUSE; it already maps
  headings/paragraphs/lists/blockquotes/code/`hr` + inline `bold`/`italic`/`link`/`code`
  to the constrained schema with stable block ids and a parallel `blocks` list, and
  validates against `buildSchema()`. The package imports ONLY the React-free
  schema/block-id modules of `@interleave/editor` (`@interleave/editor/block-ids`,
  `…/schema`, `…/block-id`) so it bundles cleanly into `main.cjs` (see the
  "Editor barrel React leak" bundling note in
  [`M12-web-import.md`](./M12-web-import.md)).
- **The widened core ProseMirror types** in
  [`../../packages/core/src/prosemirror.ts`](../../packages/core/src/prosemirror.ts):
  `PlainTextConversion = { doc, plainText, blocks }`, the full `ProseMirrorBlockNode`
  union (paragraph/heading/blockquote/bulletList/orderedList/listItem/codeBlock/
  horizontalRule + inline text/hardBreak + marks bold/italic/link/code), and
  `plainTextToProseMirrorDoc`. Re-exported from
  [`../../packages/core/src/index.ts`](../../packages/core/src/index.ts).
- **The constrained editor schema + block-id rules** in
  [`../../packages/editor/src/schema.ts`](../../packages/editor/src/schema.ts)
  (`buildSchema`, `ALLOWED_NODE_NAMES`, `ALLOWED_MARK_NAMES`, `ALLOWED_HEADING_LEVELS`)
  and [`../../packages/editor/src/block-id.ts`](../../packages/editor/src/block-id.ts) /
  `block-ids.ts` (`shouldCarryBlockId`, `BLOCK_ID_NODE_TYPES`, `newBlockId`,
  `BlockIdMinter`). PDF/EPUB/MD content MUST validate against `buildSchema()` and carry
  a `blockId` attr on exactly the outermost block of each row.
- **The asset vault** — `AssetVaultService.importAsset({ owningElementId, kind, source,
  mime, destRelativePath?, … })`
  ([`../../apps/desktop/src/main/asset-vault-service.ts`](../../apps/desktop/src/main/asset-vault-service.ts))
  streams a binary into the vault with content-hash dedup + records metadata in one
  transaction; `AssetRepository`
  ([`../../packages/local-db/src/asset-repository.ts`](../../packages/local-db/src/asset-repository.ts))
  has `create`/`createWithin`/`findByContentHash`/`findLiveByContentHash`/
  `listForElementByKind`. `ASSET_KINDS`
  ([`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts) ~line 148)
  includes `source_html`, `source_pdf`, `snapshot`, `image`, `audio`, `video`,
  `export`, `backup` (M14 ADDS `source_epub` + `import_archive`; see migrations).
  `AppPaths.assetsDir` + the vault layout (`assets/sources/<source_id>/…`,
  `assets/media/<asset_id>/…`) live in
  [`../../apps/desktop/src/main/paths.ts`](../../apps/desktop/src/main/paths.ts);
  `exports/` + `backups/` are siblings (for T068 MD export + T070 `.apkg`/CSV export
  files).
- **The background runner (T058)** —
  [`../../apps/desktop/src/main/job-runner.ts`](../../apps/desktop/src/main/job-runner.ts)
  + `JobsRepository`
  ([`../../packages/local-db/src/jobs-repository.ts`](../../packages/local-db/src/jobs-repository.ts))
  + the `utilityProcess` worker
  ([`../../apps/desktop/src/worker/job-worker.ts`](../../apps/desktop/src/worker/job-worker.ts))
  + `JOB_TYPES`
  ([`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts) ~line 179,
  with `ocr` already RESERVED). The worker never opens SQLite; it posts results back and
  **main** commits through the repositories. M14's genuinely-heavy work (EPUB unzip of a
  large book, Anki collection read of a large deck) MAY run as a runner job; small/fast
  parses MAY run inline in main (document which per task).
- **The IPC seam to extend**: contract
  [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts)
  (the `AppApi` `sources` group ~line 2709; `InboxItemSummary`; `PriorityLabelSchema`;
  the discriminated `SourcesImportUrlResult` pattern), channels
  [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts),
  router [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts)
  (the async `sourcesImportUrl`/`backupsCreate` handlers; the `IpcHandlerContext` paths
  plumbing), DB service
  [`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts)
  (the `get urlImportService()` / `get assetVaultService()` accessor pattern, lazily
  built with `assetsDir` injected at `open()`), preload
  [`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts),
  renderer client [`../../apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts).
- **The inbox import strip** in
  [`../../apps/web/src/pages/inbox/InboxScreen.tsx`](../../apps/web/src/pages/inbox/InboxScreen.tsx):
  `IMPORT_OPTS` (~line 61) is a list of `{ icon, label, hint, action? }`; `action` is
  `"manual" | "url" | "capture"` (M14's PDF spec widens it with `"pdf"`) and the chip
  enable/click logic is at ~lines 477–490. It also holds a **no-action placeholder chip**
  `{ icon: "upload", label: "Upload PDF / EPUB", hint: "Books & papers — coming soon" }` (~line 70).
  `ImportUrlModal` ([`../../apps/web/src/pages/inbox/ImportUrlModal.tsx`](../../apps/web/src/pages/inbox/ImportUrlModal.tsx))
  + `NewSourceModal` are the dialog patterns to mirror. M14 ADDS import affordances here
  (an "Import file…" chip for EPUB/MD/HTML, "Import highlights…", "Import Anki deck…") —
  it does NOT invent a new screen. **Wire/replace the existing "Upload PDF / EPUB — coming
  soon" placeholder rather than adding a new chip beside it**: M14-pdf-ocr's T064 repurposes
  it for PDF, so T067 here adds its "Import file…" chip alongside the now-live strip and the
  milestone ends with **live chips only — no "coming soon" orphan** left in `IMPORT_OPTS`.
- **File-open dialogs in main** — there is no renderer file-system access; the main
  process opens a native picker with Electron's `dialog.showOpenDialog`. The renderer
  triggers the picker via a typed `window.appApi` command that returns the chosen
  **path(s)** (main reads the bytes); the renderer never receives a `File`/`Blob` it
  parses. (Check
  [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts) for the
  existing backup-save dialog precedent before adding new pickers; reuse that pattern.)

## What is missing and this milestone adds

- **EPUB parse transforms** in `@interleave/importers` (pure): unzip + OPF/spine/nav
  parse + per-chapter XHTML→ProseMirror (REUSING `sanitizeArticleHtml` +
  `htmlToProseMirrorDoc`).
- **Markdown ↔ ProseMirror transforms** in `@interleave/importers` (pure):
  `markdownToProseMirrorDoc` (import) + `proseMirrorDocToMarkdown` (export), the
  round-trip pair.
- **A generic highlight-import format + adapters** in `@interleave/importers` (pure):
  Readwise CSV/JSON + Kindle `My Clippings.txt` → a normalized `ImportedHighlight[]`.
- **Anki `.apkg` read/write transforms** in `@interleave/importers` (pure): `.apkg`
  (zip + embedded SQLite collection + media) → normalized note/card/review records, and
  Interleave cards → `.apkg`/CSV.
- **Main-side import/export services** in `apps/desktop/src/main/`:
  `EpubImportService`, `MarkdownImportService` (+ the HTML import path),
  `HighlightImportService`, `AnkiImportService`, `AnkiExportService`,
  `MarkdownExportService` — each construction-time-injected, composing the pure
  transforms + the vault + the repositories.
- The `window.appApi` surface, channels, schemas, preload, and renderer affordances for
  each.
- Two new `ASSET_KINDS` (`source_epub`, `import_archive`) + the migration; the `cards`
  table gains a `source_uri` provenance column for round-tripping a source ref into/out
  of Anki (T070); the migration index for M14 starts at **`0008_*`** (the last shipped
  is `0007_parched_killmonger.sql`).
  > **Migration numbering across the two parallel M14 specs.** Both this spec and the
  > sibling `tasks/M14-pdf-ocr.md` add migrations on top of `0007_parched_killmonger.sql`,
  > so the nominal `0008+` numbers in *both* files are nominal only. `pnpm db:generate`
  > always emits the **next sequential number in build order**; whichever M14 task lands
  > second takes whatever number `db:generate` produces. **Do not hand-renumber** — keep
  > each task's schema change in its own reviewable migration and rebase to the generated
  > number if a sibling landed first.

Build order: T067 and T068 are independent (both build on the source pipeline + importers);
T069 depends only on the extract pipeline; T070 depends on the card model. Do them in
roadmap order (T067 → T068 → T069 → T070). Each is a single coherent feature + tests.

---

## T067 — EPUB import

- **Status:** `[ ]` not started  · **Depends on:** T059 (the scaled vault —
  `AssetVaultService.importAsset` streams the `original.epub` into the vault with dedup),
  T018 (the source reading mode a chapter is read in). In practice it also builds on
  T060's `@interleave/importers` (`sanitizeArticleHtml` + `htmlToProseMirrorDoc`, which
  XHTML chapters reuse) and the `source_locations` substrate (T022, with its `page`
  column).
- **Roadmap line:** Done when EPUBs parse into book/chapter/section sources preserving
  chapters/headings/footnotes/locations; a chapter can be read incrementally.

### Goal

A user picks an `.epub` file and Interleave imports the **whole book** locally as a
small **lineage tree of sources**: one **book source** (the `source` element carrying the
book's title/author/published date + the `original.epub` in the vault as its
`snapshotKey`), and one **chapter `topic`** per reading unit in the book's spine — each a
schedulable, independently-readable element whose body is the chapter's XHTML mapped to
the constrained ProseMirror schema with **stable block ids**, with **headings preserved**,
**footnotes preserved** (lifted to an endnote block within the chapter so the reference
survives), and a **human-readable location** ("Chapter 3" / "Chapter 3 · §2"). A chapter
opens in the existing source reader and can be read **incrementally** (read-points,
extraction, highlights all work on it exactly as on a web-import source — because a
chapter IS a normal document-bearing element). The original `.epub` bytes live in the
vault (never SQLite); the renderer never unzips or parses anything. The book + its
chapters survive an **app restart** with lineage intact.

### Context to load first

- Reference: [`../architecture.md`](../architecture.md) (the planned EPUB importer line
  + the asset-vault layout), [`../domain-model.md`](../domain-model.md) (`source` =
  book, `topic` = chapter/section, the `source_locations` anchor + its `page` column,
  the closed `operation_log` vocabulary), [`../design-system.md`](../design-system.md)
  (the inbox import strip; the source reader + hierarchy view a book's chapters render
  in), [`M12-web-import.md`](./M12-web-import.md) (the importer + `createWithDocument`
  seam this reuses).
- Existing code to inspect: `@interleave/importers` `sanitize.ts` + `html-to-prosemirror.ts`
  (REUSED for each chapter's XHTML), `SourceRepository.createWithDocumentWithin` +
  `CreateSourceWithDocumentInput` (the source-creation seam), `ElementRepository`'s
  `parent_child` relation + `addRelationWithin` (chapter → book lineage),
  `AssetVaultService.importAsset` + `ASSET_KINDS` (the `original.epub` write),
  `AppPaths.assetsDir`/`ensureVaultSkeleton`, the `source_locations` schema (the `page`
  column for chapter ordinals + `label` for "Chapter 3"), the element hierarchy view
  (T023) the book's chapters render in, the universal inspector (T010).
- Invariants in play: renderer never reads/unzips the file; the unzip + XHTML walk + vault
  write all run **main-side**; each chapter's body validates against the constrained
  schema with stable block ids; lineage is sacred (**book source → chapter topics** via
  `parent_child`, and each chapter carries the book as its `sourceId` lineage root); the
  multi-table mutation is one transaction per chapter (or one big transaction for the
  whole book — see the atomicity deliverable) + logged; the `.epub` bytes live in the
  vault (never SQLite); imported material defaults to a **non-dominating** priority (`C`).

### Dependencies to add (concrete, justified)

Add to **`packages/importers`** (pure transform — bundled into `main.cjs` by esbuild;
deps must be pure-JS, no native bindings):
- **A pure-JS ZIP reader for the EPUB container.** An `.epub` is a ZIP. Use
  **`fflate`** — a tiny, dependency-free, pure-JS (un)zip library that works in Node and
  bundles cleanly (it has both sync `unzipSync` and streaming APIs). Chosen over
  **`jszip`** (heavier, promise-only, drags a larger tree) and over **`adm-zip`**
  (filesystem-oriented, less suited to in-memory buffers). The EPUB bytes are already in
  memory (main read the file / handed them in), so `unzipSync(buffer)` → a map of
  entry-path → `Uint8Array` is the simplest correct fit. (Justify `fflate` in the module
  docblock.)
- **An XML/OPF parser for the container + package + nav documents.** The EPUB metadata
  (`META-INF/container.xml` → the OPF path; the OPF `<package>` → `<metadata>` +
  `<manifest>` + `<spine>`; the EPUB3 nav doc or EPUB2 `toc.ncx`) is XML, not HTML. Use
  **`fast-xml-parser`** — pure-JS, no native deps, fast, and already an XML-only parser
  (we do NOT want a full DOM here, just the OPF/nav trees). Chosen over reusing
  `linkedom` for the OPF because `fast-xml-parser` gives a typed object tree that is far
  cleaner to walk for `<spine itemref>` ordering + `<manifest>` href resolution than DOM
  querying, and it is the lighter dep. (The chapter **XHTML bodies** still go through
  `linkedom` via the existing `htmlToProseMirrorDoc`, which already depends on it — do
  NOT add a second HTML DOM.)

Declare both in `packages/importers/package.json` `dependencies`. Do NOT add an
all-in-one "epub" npm package (e.g. `epub`/`epub2`/`epubjs`) — those are browser/DOM- or
filesystem-oriented, pull heavy or native-leaning trees, and bury the parse logic we want
to own + unit-test. We compose `fflate` + `fast-xml-parser` + the existing
sanitize/HTML→PM transforms, keeping the importer pure + fixture-testable. No streaming
unzip needed for v1 (a book is tens of MB at most; `unzipSync` over the in-memory buffer
is fine — note in the docblock that a future huge-book path could stream).

### Deliverables

- [ ] **EPUB parse transform** in `packages/importers/src/epub.ts` — the PURE, I/O-free
      parser. Public:
  - [ ] **`parseEpub(bytes: Uint8Array): ParsedEpub`** — `unzipSync` the bytes; read
        `META-INF/container.xml` → the OPF path; parse the OPF (`fast-xml-parser`) to get
        the **metadata** (`title`, `creator`/author, `language`, `date`/published, the
        `dc:identifier`), the **manifest** (id → href + media-type), and the **spine**
        (the ordered list of `itemref` → manifest item = the reading order); resolve the
        **nav** (EPUB3 `nav[epub:type=toc]` XHTML, or EPUB2 `toc.ncx`) to a chapter
        title map (href → title). Returns:
        ```ts
        interface ParsedEpub {
          readonly metadata: { title: string | null; author: string | null;
            language: string | null; publishedAt: string | null; identifier: string | null };
          readonly chapters: readonly ParsedEpubChapter[];   // spine order
        }
        interface ParsedEpubChapter {
          readonly order: number;                 // 0-based spine position (the "page" ordinal)
          readonly href: string;                  // OPF-relative href (for footnote resolution)
          readonly title: string | null;          // from the nav/ncx, else null
          readonly xhtml: string;                 // the raw chapter (X)HTML, pre-sanitize
        }
        ```
        No `fs`, no network, no Electron. Malformed/partial archives throw a typed
        `EpubParseError` with a `code` (`not_a_zip` / `no_opf` / `no_spine` /
        `empty_book`) the service maps to a friendly message.
  - [ ] **`chapterToProseMirror(chapter: ParsedEpubChapter, mint?: BlockIdMinter):
        ChapterConversion`** — sanitize the chapter XHTML with `sanitizeArticleHtml`
        (the same allowlist; EPUB XHTML is the same constrained tag set HTML import
        uses) **plus footnote handling** (below), then run `htmlToProseMirrorDoc` to get
        the `{ doc, plainText, blocks }` `PlainTextConversion` that validates against
        `buildSchema()`. `ChapterConversion = PlainTextConversion & { footnotes:
        readonly { marker: string; text: string }[] }`.
        - **Footnotes (REQUIRED — the roadmap names them).** EPUB footnotes are typically
          either `<a epub:type="noteref" href="#fn1">` references pointing at an
          `<aside epub:type="footnote" id="fn1">…</aside>` (EPUB3) or in-chapter `<a>`
          anchors to note bodies (EPUB2). Resolve them **within the chapter**: keep the
          in-text reference as a superscript-style marker (the constrained schema has no
          superscript mark, so render it as a bracketed inline marker like `[1]` in the
          paragraph text — preserving that a note exists at that point), and **append the
          note bodies as an endnotes section at the bottom of the chapter doc** (a
          `horizontalRule` + a `heading` "Notes" + one `paragraph` per note, each prefixed
          `[n] …`). This preserves the footnote CONTENT + its anchor without needing a
          schema feature the editor cannot represent. (Cross-chapter/endnote-file notes —
          a separate XHTML of all notes referenced from many chapters — are resolved
          best-effort by href; if a note's target is in another spine item, leave the
          `[n]` marker and surface the note in whichever chapter owns its body. Document
          this limit.) Footnote resolution is pure (operates on the parsed DOM), unit-
          testable on a fixture.
  - Export both from `packages/importers/src/index.ts` (+ the `ParsedEpub*` /
    `ChapterConversion` / `EpubParseError` types).
- [ ] **Main-side `EpubImportService`** in `apps/desktop/src/main/epub-import-service.ts`
      — constructed with `{ db, repositories, assetsDir }` (the
      `UrlImportService`/`AssetVaultService` injection pattern). Public:
      `importFromFile(input: { absPath: string; priority?: PriorityLabel; reasonAdded?:
      string | null }): Promise<EpubImportResult>` where `EpubImportResult = { status:
      "imported"; bookId: string; chapterCount: number; item: InboxItemSummary }`. Steps:
  1. Read the file bytes (`fs.readFile`) in main (the renderer passed only the path).
     Reject a non-`.epub`/non-ZIP / oversized file with a typed `EpubImportError` mapped
     from `EpubParseError`.
  2. **`parseEpub(bytes)`** → metadata + ordered chapters.
  3. **Mint the book source id up front** (so the vault path `assets/sources/<book_id>/`
     is known), then **stream `original.epub` into the vault** via
     `AssetVaultService.importAsset({ owningElementId: bookId, kind: "source_epub",
     source: absPath, mime: "application/epub+zip", destRelativePath:
     "sources/<book_id>/original.epub" })`. (Add `source_epub` to `ASSET_KINDS` —
     migration below.) The book source's `snapshotKey` = `sources/<book_id>/original.epub`.
  4. **Create the book source** via `createWithDocumentWithin` with `status: "inbox"`,
     `stage: "raw_source"`, the title/author/publishedAt from metadata, the `snapshotKey`,
     priority (default `C`), and a **book-overview body** (a short doc: the title as a
     heading + a table-of-contents list of chapter titles as a `bulletList`, each item the
     chapter title — so the book source itself is readable/inspectable, not empty). The
     book id is pre-minted so chapters can reference it.
  5. **Create one chapter `topic` per spine item**: for each `ParsedEpubChapter`, run
     `chapterToProseMirror`, then create a `topic` element (`status: "inbox"`, `stage:
     "rough_topic"`, the chapter title as title, the chapter conversion as the pre-built
     `conversion`, the book as `parentId` AND `sourceId` lineage root, priority inherited
     from the book) via the SAME document pipeline. Because `createWithDocument*` is
     hard-typed to `type: "source"`, a topic variant is needed. **Prefer extracting the
     shared element + `documents` + `document_blocks` insert body of
     `createWithDocumentWithin` (source-repository.ts ~216–292) into a single private helper
     parameterized by element `type` + a flag for whether to write the `sources` provenance
     row / `create_source` op, then have BOTH `createWithDocumentWithin` (source: writes the
     `sources` row + `create_source`) and the new `createTopicWithDocumentWithin` (topic:
     skips both) call it.** This avoids two divergent document-insert code paths that drift
     over time. A copy-paste sibling is the fallback only if the refactor proves risky. Either
     way the topic variant creates a `topic`-typed element + its `documents`/`document_blocks`
     body (logging `create_element` + `update_document`; a topic has no `sources` provenance
     row — only the book source does) and an `element_relations` `parent_child` edge book → chapter
     (`addRelationWithin`, logs `add_relation`). **Record a `source_locations` row per
     chapter anchoring it to the book** — `sourceElementId = bookId`, `page = order + 1`
     (the spine ordinal), `label = chapter.title ?? "Chapter <n>"`, `blockIds = []`,
     `selectedText = ""` — so the chapter knows its place in the book and jump-to-book
     works. (Reuse `deriveSourceLocationLabel` semantics for sub-section labels if a
     chapter is split.)
  6. Return `{ status: "imported", bookId, chapterCount, item }` (the inbox summary for
     the BOOK source — the chapters appear under it in the hierarchy view, not as N
     separate inbox rows; the inbox lists the book, and opening it shows its chapters).
  - **Atomicity (load-bearing).** Wrap the WHOLE book import — the book source, every
    chapter topic + its blocks + its `parent_child` edge + its `source_locations` row,
    and the `source_epub` asset row — in ONE `db.transaction` via the `*Within(tx, …)`
    seams (`createWithDocumentWithin`, the new `createTopicWithDocumentWithin`,
    `addRelationWithin`, `AssetRepository.createWithin`), so a parse/insert failure
    mid-book rolls back the entire book (no orphan book-with-half-its-chapters, no orphan
    `.epub` file — best-effort `rm` the partial `assets/sources/<book_id>/` dir on
    rollback, mirroring `UrlImportService`). The `.epub` file write happens BEFORE the
    transaction (so its bytes exist), and the transaction commits the rows referencing it;
    on rollback, unlink the file. **A very large book** (hundreds of chapters) in one
    transaction is acceptable for SQLite (better-sqlite3 is synchronous + fast); note the
    option to chunk into per-chapter transactions IF a real fixture shows a problem, but
    default to one-transaction-per-book for all-or-nothing integrity.
  - **Runner option.** Parsing + converting a large book is CPU work that could briefly
    block main. For v1, run it **inline in main** (simplest; a book parse is sub-second to
    a few seconds). If a fixture shows a multi-second freeze, move the parse + conversion
    onto the **T058 runner** as an `epub_import` job (the worker unzips + converts —
    pure, DB-free — and posts the `ParsedEpub` + per-chapter conversions back; main does
    the vault write + the one transaction). Declare `epub_import` as a reserved `JobType`
    now (alongside `ocr`) so this is a non-breaking later optimization. Document which
    path ships.
- [ ] **`SourceRepository.createTopicWithDocumentWithin`** (preferably built on a shared
      private document-insert helper generalized over element `type` + provenance-row flag,
      per step 5 — NOT a copy-paste of `createWithDocumentWithin`, to avoid two divergent
      document-insert paths) + `CreateTopicWithDocumentInput`. Add a unit test that it creates
      a `topic` element (not a `source`), writes its document body + stable blocks, logs
      `create_element` + `update_document` (NO `create_source` — a topic is not a
      provenance-bearing source), and that a supplied `parentId`/`sourceId` are adopted. If the
      shared-helper refactor lands, also assert `createWithDocumentWithin` STILL writes the
      `sources` row + `create_source` (no regression to the source path).
- [ ] **Migration — `ASSET_KINDS += "source_epub"`.** Add `source_epub` to
      `ASSET_KINDS` ([`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts)
      ~line 148). The `assets.kind` CHECK constraint is built from this tuple
      ([`../../packages/db/src/schema/system.ts`](../../packages/db/src/schema/system.ts)
      ~line 56 `assets_kind_check`), so widening the allowed-values list is a schema
      change → run `pnpm db:generate` to produce the `0008_*` migration (a recreated
      `assets` CHECK; SQLite emits a 12-step table rebuild — review the generated SQL
      preserves data). Commit the generated SQL.
      > **Builder caution — this is the M14 migration most likely to need manual review.**
      > A CHECK change cannot be done with `ALTER TABLE`; Drizzle emits the SQLite
      > recreate-table dance (create `__new_assets`, copy rows, drop, rename). `assets`
      > **references `elements`** (an FK), so the rebuild must run with
      > `PRAGMA foreign_keys=OFF` around it — drizzle-kit normally wraps this correctly,
      > but on an **existing dev DB with rows** verify the generated `0008` (i) disables FK
      > enforcement for the rebuild, (ii) copies **every** existing column/row into
      > `__new_assets`, and (iii) re-enables FKs. If the generated SQL drops/recreates
      > without the `PRAGMA foreign_keys=OFF` guard, fix it before committing. Add the
      > new kind to the migration only via the regenerated tuple — do not hand-edit the SQL
      > values.
- [ ] **IPC contract** in
      [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts):
  - A file-picker command result + an `EpubImportRequest`: because the renderer cannot
    read files, the flow is **(a)** `window.appApi.sources.pickImportFile({ kind:
    "epub" })` → main opens `dialog.showOpenDialog` (filter `*.epub`) → returns `{ paths:
    string[] } | { cancelled: true }`; **(b)** `window.appApi.sources.importEpub({ path,
    priority?, reasonAdded? })` → main reads + imports. Define
    `PickImportFileRequestSchema` (`{ kind: z.enum(["epub","markdown","html","highlights",
    "anki"]) }`), `PickImportFileResult`, `SourcesImportEpubRequestSchema = z.object({
    path: z.string().min(1), priority: PriorityLabelSchema.optional(), reasonAdded:
    z.string().trim().max(2048).optional() })`, and `SourcesImportEpubResult` (the
    `{ status: "imported"; bookId; chapterCount; item }` shape — discriminated, so future
    arms like a duplicate-book check can be added without a breaking change). Add
    `pickImportFile(request)` + `importEpub(request)` to the `AppApi` `sources` group.
    (The single shared `pickImportFile` command serves T067/T068/T069/T070 — define it
    ONCE here.)
- [ ] **Channels** in
      [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts):
      `sourcesPickImportFile: "sources:pickImportFile"`, `sourcesImportEpub:
      "sources:importEpub"`.
- [ ] **IPC handlers** in [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts):
      an async `sourcesPickImportFile` handler (opens the dialog) and an async
      `sourcesImportEpub` handler (parse + import is async I/O — mirror `backupsCreate`'s
      async shape, NOT the sync source handlers). Map `EpubImportError.code` to friendly
      messages.
- [ ] **DB-service method + accessor** in
      [`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts):
      a `get epubImportService()` accessor (lazily built with the open DB + `assetsDir`,
      like `urlImportService`) + an async `importEpub(request)` method the handler calls.
- [ ] **Preload + renderer client** — `sources.pickImportFile` + `sources.importEpub` in
      [`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts)
      + [`../../apps/web/src/lib/appApi.ts`](../../apps/web/src/lib/appApi.ts).
- [ ] **Renderer affordance** — add an **"Import file…"** chip to `IMPORT_OPTS` in
      [`../../apps/web/src/pages/inbox/InboxScreen.tsx`](../../apps/web/src/pages/inbox/InboxScreen.tsx)
      (icon `"library"` or `"upload"`, action `"file"`). Use an **existing `IconName`** — there is
      **no `book-open`/`file`/`book` key** in
      [`../../apps/web/src/components/Icon.tsx`](../../apps/web/src/components/Icon.tsx) /
      [`../../design/icon-map.md`](../../design/icon-map.md) (the closest existing keys are `library`,
      `upload`, `source`, `topic`), so naming `book-open`/`file` would fail typecheck on `IconName`. Pick
      one of the existing keys, or ADD a new lucide glyph to `Icon.tsx` + `design/icon-map.md` first as
      an explicit step. By the time T067 lands, M14-pdf-ocr's T064
      has already repurposed the old `{ label: "Upload PDF / EPUB", hint: "… coming soon" }`
      placeholder into a live "Import PDF" chip; this chip is therefore an ADDITION beside it
      (not a second placeholder). Leave the strip with **live chips only — no "coming soon"
      orphan**. It opens an **`ImportFileModal`** (new,
      mirroring `ImportUrlModal`): a "Choose EPUB…" button calls `pickImportFile({ kind:
      "epub" })`, shows the chosen filename + an optional priority chip group, `⌘↵` to
      import / `Esc` to cancel, a busy/spinner while main parses, an inline error on
      failure, and on success closes + `refresh(bookId)` (selects the new book in the
      inbox). (T068/T069/T070 extend this same modal/affordance with the other file
      kinds — design it to take a `kind` so it is reused, not duplicated.) Render
      gracefully when `!isDesktop()`. Pure UI: it calls ONE picker + ONE import command;
      all parse/persist is main-side.
- [ ] **Tests (unit, importers — fixture-driven)** in `packages/importers/src/epub.test.ts`
      against small `.epub` fixtures under `packages/importers/src/__fixtures__/epub/` (a
      minimal EPUB3 with nav + 3 chapters, one with footnotes; a minimal EPUB2 with
      `toc.ncx`; a malformed/empty archive):
  - `parseEpub` returns the right metadata (title/author/language/published), the
    chapters in **spine order**, and resolves chapter titles from the nav/ncx;
  - `chapterToProseMirror` maps a chapter's headings/paragraphs/lists to the right node
    types, **`Node.fromJSON(buildSchema(), doc)` does not throw**, every node is in
    `ALLOWED_NODE_NAMES` / every mark in `ALLOWED_MARK_NAMES`, each row-bearing node has a
    unique `blockId`, and footnotes are lifted to an endnotes section with `[n]` markers
    preserved in the body;
  - a malformed archive throws `EpubParseError` with the right `code`. Build the EPUB
    fixtures with `fflate.zipSync` IN-TEST (a tiny helper) so no binary blobs are
    committed (or commit small `.epub` fixtures — pick one and keep them small).
- [ ] **Tests (domain, local-db)** — `createTopicWithDocumentWithin` creates a `topic`
      with a body + blocks + the right ops and adopts `parentId`/`sourceId`.
- [ ] **Tests (main-side service)** in `apps/desktop/src/main/epub-import-service.test.ts`
      against a real temp-file SQLite DB (`new DbService()` + `svc.open(dbPath, {
      migrationsDir, assetsDir })` under `mkdtempSync` — the desktop-main pattern) + a
      temp `assetsDir` + a fixture `.epub` on disk:
  - a successful import writes `original.epub` under `assets/sources/<bookId>/` (its
    `contentHash` matches a streamed re-hash), creates an `inbox` book `source` whose
    `snapshotKey` is the epub path, creates N chapter `topic`s linked `parent_child` to
    the book with the book as their `sourceId`, each with a readable body + a
    `source_locations` row (`page` = spine ordinal, `label` = chapter title), and appends
    `create_element`/`create_source`/`update_document`/`add_relation` ops;
  - **restart-persistence**: re-open the DB (new repositories on the same file) and assert
    the book + chapters + bodies + relations + the `.epub` file all survive;
  - a malformed `.epub` throws the typed error and writes NO source/asset/file (clean
    rollback — no orphan book or partial chapters).
- [ ] **Tests (contract)** — `PickImportFileRequestSchema`/`SourcesImportEpubRequestSchema`
      accept valid payloads + reject bad ones; `SourcesImportEpubResult` round-trips.
- [ ] **Tests (E2E, Electron)** — `tests/electron/epub-import.spec.ts`: open the import
      modal, pick a fixture `.epub` (drive the picker via the `INTERLEAVE_*` test escape
      or a test-only `importEpub({ path })` direct call against a fixture path — match how
      `url-import.spec.ts` avoids a live picker), see the book in the inbox, open it, open
      a chapter, set a read-point + extract from it (proving a chapter reads incrementally
      like any source), and — after an **app restart** — the book, its chapters, the
      read-point/extract, and the `.epub` snapshot all survive.
- [ ] **Fixtures/seed** — the `.epub` fixtures are the only new test data. Optionally add
      ONE small imported book to the dev seed so the hierarchy view shows a book→chapters
      tree out of the box (nice-to-have, not required).
- [ ] **Docs** — check the T067 box in [`../roadmap.md`](../roadmap.md) with the commit ref
      + a Progress-log line; note the new `source_epub` asset kind + `0008_*` migration +
      the `fflate`/`fast-xml-parser` deps + the book→chapter-topic lineage model.

### Done when

- Picking an `.epub` imports the whole book **locally**: the main process unzips +
  parses it, stores `original.epub` in the vault under `assets/sources/<book_id>/`
  (content-hashed, bytes never in SQLite), creates an **inbox book `source`** + one
  **chapter `topic`** per spine item, each with its XHTML mapped to the **constrained
  schema with stable block ids**, **headings + footnotes preserved**, and a **human-
  readable location** ("Chapter 3"), all linked `book → chapters` via `parent_child` with
  the book as each chapter's lineage root — through the existing source/document pipeline
  in one transaction, appending the right `operation_log` entries.
- A chapter opens in the existing source reader and can be **read incrementally**:
  read-points, highlights, and extraction all work on it (it is a normal document-bearing
  element). The book + its chapters appear in the hierarchy view + inspector.
- The unzip/parse/persist all run **main-side**; the renderer reaches it only through
  `window.appApi.sources.pickImportFile` + `importEpub` — no fs/Node/SQL in the renderer.
- A malformed/oversized `.epub` fails gracefully (friendly message, clean rollback — no
  orphan book/chapter/file); the app never crashes or hangs.
- An Electron E2E imports a fixture `.epub`, reads a chapter incrementally, and everything
  survives an **app restart**. `pnpm typecheck`, `pnpm lint`, `pnpm test`, and
  `pnpm e2e --project=electron` pass; the `0008_*` migration applies cleanly.

### Notes / risks

- **Footnotes are the trickiest fidelity point.** The constrained schema has no
  superscript/sup mark and no inter-document links, so we preserve footnote CONTENT (as an
  endnotes section per chapter) + the anchor position (a `[n]` marker), not the exact
  visual superscript-link. This is the right trade for a constrained-schema, lineage-first
  system; surfacing notes as readable text is more useful for extraction than a dead
  link. Document the cross-chapter endnote limit.
- **Chapter granularity = spine items.** EPUB spine items are the natural reading unit
  and the simplest correct chapter model; a single huge spine item (a whole book in one
  file) imports as one large chapter (acceptable; a later T-task could split on `h1`
  boundaries — out of scope here). Do NOT try to merge/split spine items heuristically in
  v1.
- **Images deferred.** EPUB images (cover, figures) are NOT imported as image extracts in
  T067 (image extraction is T065/M15); `sanitizeArticleHtml` already drops `<img>`
  (keeping alt text). The `original.epub` retains the images for a future pass; note this.
- **No DRM.** DRM-protected EPUBs (Adobe ADEPT etc.) cannot be parsed and are out of
  scope — `parseEpub` will fail the OPF/encryption check; surface a clear "this EPUB is
  DRM-protected" message and import nothing. Do not attempt to circumvent DRM.
- **Downstream.** The same `createTopicWithDocumentWithin` seam + the book→chapter
  lineage model is reused by any future paginated import (a multi-section PDF, a long
  article split into topics). Keep it generic.

---

## T068 — Markdown & HTML import/export

- **Status:** `[ ]` not started  · **Depends on:** T015 (the constrained editor schema +
  the document body the converters target). In practice it also builds on T060's
  `@interleave/importers` (HTML import REUSES `sanitizeArticleHtml` +
  `htmlToProseMirrorDoc`; only Markdown needs a new transform pair).
- **Roadmap line:** Done when Markdown and HTML are first-class imports preserving
  code/headings/links/images; exported Markdown round-trips back with acceptable fidelity.

### Goal

Markdown and HTML become **first-class import formats** alongside URL/EPUB: a user picks
(or pastes) a `.md`/`.markdown` or `.html`/`.htm` file and it imports as an **inbox
source** whose body is mapped to the constrained ProseMirror schema with **stable block
ids**, preserving **headings, code blocks, links, lists, blockquotes, and images** (images
to the degree the constrained schema allows — see the image note). And the reverse:
Interleave can **export a document (source/extract/topic) to Markdown**, and that exported
Markdown **round-trips** — re-importing it yields an equivalent document (same headings/
paragraphs/lists/code/links, modulo normalization). HTML import reuses the shipped
sanitize + HTML→PM transforms; Markdown needs a NEW `markdown ↔ ProseMirror` transform
pair. All parse/serialize runs main-side; the renderer never parses Markdown or writes a
file.

### Context to load first

- Reference: [`../architecture.md`](../architecture.md) (the importers package),
  [`../domain-model.md`](../domain-model.md) (the document body + stable block ids),
  [`../design-system.md`](../design-system.md) (the inbox import strip + the export
  affordance — exports go to the `exports/` vault sibling), [`M12-web-import.md`](./M12-web-import.md)
  (the HTML→PM transform this reuses; the source pipeline).
- Existing code to inspect: `@interleave/importers` `sanitize.ts` + `html-to-prosemirror.ts`
  (HTML import path), the widened `@interleave/core` ProseMirror types
  ([`../../packages/core/src/prosemirror.ts`](../../packages/core/src/prosemirror.ts) —
  the `ProseMirrorBlockNode` union the Markdown serializer walks), `buildSchema`/
  `ALLOWED_NODE_NAMES`/`ALLOWED_MARK_NAMES` (the validation target),
  `SourceRepository.createWithDocument`/`createWithDocumentWithin` +
  `CreateSourceWithDocumentInput.conversion` (the convergence point), `AppPaths.exportsDir`
  (where exported `.md` lands), the `DocumentRepository` (reading a stored doc to export),
  the IPC seam + the `pickImportFile` command added in T067.
- Invariants in play: renderer never reads/writes files or parses Markdown; parse/serialize
  run **main-side** via the pure importers package; the imported doc validates against the
  constrained schema with stable block ids; one transactional + logged source creation;
  exported files go to the `exports/` vault (never arbitrary renderer-chosen paths);
  imported material defaults to a **non-dominating** priority (`C`); round-trip fidelity is
  DEFINED + tested (see the round-trip deliverable).

### Dependencies to add (concrete, justified)

Add to **`packages/importers`** (pure transform):
- **`markdown-it`** — the de-facto, pure-JS, CommonMark-compliant Markdown parser. It
  produces a flat **token stream** (not a DOM), which we walk directly into the
  constrained `PlainTextConversion` shape (the same shape `htmlToProseMirrorDoc`
  produces). Chosen over **`marked`** (HTML-string output — we'd then re-parse the HTML
  with linkedom, an unnecessary round-trip and a fidelity loss on code/links) and over
  **`remark`/`unified`** (a much larger plugin ecosystem + mdast tree we don't need; more
  deps to bundle). `markdown-it`'s token stream maps cleanly 1:1 onto our constrained node
  set (heading/paragraph/blockquote/bullet_list/ordered_list/list_item/fence(code)/hr +
  inline strong/em/link/code). Pure JS, no native deps, bundles cleanly.
  - **Markdown EXPORT does NOT need a new dep.** Serialize the constrained
    `ProseMirrorDoc` to Markdown with a small **hand-written serializer** that walks the
    `ProseMirrorBlockNode` union — the constrained schema is tiny (≤8 block types, 4
    marks), so a ~120-line pure serializer is simpler, dependency-free, and gives us exact
    control over the round-trip normalization than pulling
    `prosemirror-markdown` (which assumes the full prosemirror-schema-basic schema +
    prosemirror `Node` instances we don't construct on the core side). Justify the
    hand-written serializer in the module docblock; it is the cleaner fit for our
    constrained, framework-free core types.

Declare `markdown-it` in `packages/importers/package.json` `dependencies` (+ its types
`@types/markdown-it` as a devDependency). Do NOT add `marked`/`remark`/`turndown` (HTML→MD
is not needed — we serialize from the ProseMirror doc, not from HTML).

### Deliverables

- [ ] **`markdownToProseMirrorDoc(markdown: string, mint?: BlockIdMinter):
      PlainTextConversion`** in `packages/importers/src/markdown.ts` — parse the Markdown
      with `markdown-it` (CommonMark preset, no unsafe HTML passthrough — set
      `html: false` so raw HTML in the Markdown is escaped/dropped, not injected) and walk
      its token stream into the constrained `{ doc, plainText, blocks }`:
  - `heading_open[h1..h6]` → `heading` (clamp 4–6 to level 3 per `ALLOWED_HEADING_LEVELS`);
    `paragraph_open` → `paragraph`; `blockquote_open` → `blockquote`; `bullet_list_open`
    → `bulletList`, `ordered_list_open` → `orderedList`, `list_item_open` → `listItem`;
    `fence`/`code_block` → `codeBlock` (preserving the raw code text + the info-string
    language if present, stored as the codeBlock's text — the constrained schema has no
    language attr, so language is a future enhancement; note it); `hr` → `horizontalRule`;
    inline `strong` → bold, `em` → italic, `link_open` → link (`href` from the token
    attrs), `code_inline` → code.
  - Stable `blockId` on exactly the outermost row block (id on `listItem`/`blockquote`,
    NOT the inner paragraph; never on the list container) — REUSE the SAME id-assignment +
    `blocks`-list logic `htmlToProseMirrorDoc` uses (factor the shared row-recording into a
    helper if it cleanly de-duplicates, else mirror it). The output MUST validate against
    `buildSchema()`.
  - `plainText` = the flattened text mirror; empty/whitespace Markdown → a valid empty doc.
  - **Images:** a Markdown `![alt](src)` → keep the alt text as a paragraph/inline run
    (the constrained schema has no image node; images are deferred to M15). Note this so
    the round-trip test does not expect image round-tripping.
- [ ] **`proseMirrorDocToMarkdown(doc: ProseMirrorDoc): string`** in
      `packages/importers/src/markdown.ts` — the hand-written serializer walking the
      `ProseMirrorBlockNode` union: `# `/`## `/`### ` for headings, blank-line-separated
      paragraphs, `> ` for blockquotes, `- ` / `1. ` for list items (nested by depth),
      ` ```\n…\n``` ` fences for code blocks, `---` for `hr`, and inline `**bold**`/
      `*italic*`/`[text](href)`/`` `code` ``. Escape Markdown-significant characters in
      text runs so a paragraph containing `*` or `#` round-trips. Deterministic output (a
      fixed normalization) so the round-trip test is stable.
- [ ] **HTML import path (REUSE, no new transform).** HTML import is
      `sanitizeArticleHtml(html)` → `htmlToProseMirrorDoc(...)` — the EXACT transforms
      T060 shipped. Add a thin `htmlFileToProseMirrorDoc(html, mint?)` convenience export
      that composes the two (so the service has one call), or have the service call them
      directly. No new parsing code; the only new bit is the file/IPC plumbing.
- [ ] **Export both transforms** + the `markdownToProseMirrorDoc`/
      `proseMirrorDocToMarkdown` symbols from `packages/importers/src/index.ts`.
- [ ] **Main-side `MarkdownImportService`** (handling MD + HTML + the export) in
      `apps/desktop/src/main/document-import-service.ts` — constructed `{ db, repositories,
      assetsDir, exportsDir }`. Public:
  - `importFromFile(input: { absPath: string; format: "markdown" | "html"; priority?:
    PriorityLabel; reasonAdded?: string | null }): Promise<DocumentImportResult>` — read
    the file in main, dispatch to `markdownToProseMirrorDoc` or the HTML path, derive a
    title (the first `# ` heading / the HTML `<title>` / the filename stem), and create an
    **inbox `source`** via `createWithDocumentWithin` with the pre-built conversion (one
    transaction, logged). `DocumentImportResult = { status: "imported"; id; item:
    InboxItemSummary }`. (For HTML files we MAY also store the raw `original.html` in the
    vault as a `source_html` asset, mirroring URL import, so the original survives — do
    this for parity with `UrlImportService`; Markdown stores no separate snapshot since the
    text body IS the source. Document the choice.)
  - `importFromText(input: { text: string; format: "markdown"; title?: string;
    priority?: … }): Promise<DocumentImportResult>` — the PASTE path (the inbox "Paste
    text" / a "Paste Markdown" option), no file read; same pipeline. (Reuses the existing
    paste affordance — a Markdown toggle on the New-source modal, or a dedicated chip.)
  - `exportToMarkdown(input: { elementId: ElementId }): Promise<{ relativePath: string;
    absPath: string }>` — load the element's stored ProseMirror doc via
    `DocumentRepository`, run `proseMirrorDocToMarkdown`, and **write the `.md` to the
    `exports/` vault** (`exports/<element_id>-<slug>.md`), returning the path. (The
    renderer never picks the path; main writes to the managed `exports/` dir, then MAY
    reveal it in Finder via `shell.showItemInFolder` — a typed command. Match the backup-
    export reveal pattern if one exists.) Exporting is read-only on the DB (no mutation,
    no op-log entry — it produces a file artifact, not a domain change).
- [ ] **IPC contract + channels + handlers + preload + client** for:
  `sources.importDocument({ path, format })` (MD/HTML file import, reusing the shared
  `pickImportFile({ kind: "markdown" | "html" })` from T067),
  `sources.importMarkdownText({ text, title? })` (the paste path), and
  `documents.exportMarkdown({ elementId }) → { path }`. Define the Zod schemas
  (`SourcesImportDocumentRequestSchema`, `SourcesImportMarkdownTextRequestSchema`,
  `DocumentsExportMarkdownRequestSchema`), the results, the channels
  (`sources:importDocument`, `sources:importMarkdownText`, `documents:exportMarkdown`),
  the async handlers (I/O — async), the `get documentImportService()` accessor, preload,
  and the renderer client. (Use a `documents` AppApi group for the export, beside the
  existing document commands.)
- [ ] **Renderer affordances** — extend the T067 `ImportFileModal` to accept `kind:
      "markdown" | "html"` (the "Import file…" chip offers EPUB / Markdown / HTML), add a
      "Paste Markdown" option to the inbox import strip (or a Markdown toggle on
      `NewSourceModal` routing to `importMarkdownText`), and add an **"Export to
      Markdown"** action to a source/extract's context menu / inspector
      (`documents.exportMarkdown` → toast "Exported to …" + a "Reveal in Finder" action).
      Pure UI; all parse/serialize/write is main-side. Render gracefully when
      `!isDesktop()`.
- [ ] **Tests (unit, importers — fixture-driven)** in `packages/importers/src/markdown.test.ts`:
  - `markdownToProseMirrorDoc` over a fixture covering headings/paragraphs/lists (nested)/
    blockquotes/fenced-code/links/inline-marks maps to the right node types, **validates
    against `buildSchema()`**, assigns unique stable `blockId`s on the right rows, and
    mirrors the `blocks` list; empty Markdown → valid empty doc.
  - `proseMirrorDocToMarkdown` over a known doc produces the expected Markdown string
    (deterministic).
  - **The round-trip test (the roadmap's "acceptable fidelity" criterion, MADE CONCRETE):**
    define round-trip as **`md → doc1 → md' → doc2` where `doc2` is structurally equal to
    `doc1` modulo block ids** (block ids are freshly minted each import, so compare the
    docs with ids stripped). Assert that for the fixture corpus,
    `markdownToProseMirrorDoc(proseMirrorDocToMarkdown(markdownToProseMirrorDoc(md).doc))`
    yields a doc structurally identical (node types, nesting, text, marks, heading levels,
    code text) to the first import's doc — i.e. **a second round-trip is a fixed point**.
    This is the testable definition of "round-trips with acceptable fidelity"; spell out
    in the test that images + code-language + exotic Markdown (tables, HTML passthrough,
    footnotes) are explicitly OUT of the fidelity guarantee (the constrained schema cannot
    represent them) and are normalized away on the first import.
- [ ] **Tests (main-side service)** in `apps/desktop/src/main/document-import-service.test.ts`
      (real temp-file DB + temp `assetsDir`/`exportsDir`): a `.md` file import creates an
      `inbox` source whose body parses to the expected nodes + the right ops; a `.html`
      file import reuses the sanitize/HTML→PM path + (if chosen) writes `original.html` to
      the vault; `exportToMarkdown` writes a `.md` to `exports/` whose content re-imports
      to an equivalent doc (the round-trip, end-to-end through the DB); **restart-
      persistence** — re-open the DB and the imported source survives.
- [ ] **Tests (contract)** — the new request schemas accept valid + reject invalid
      payloads; the results round-trip.
- [ ] **Tests (E2E, Electron)** — `tests/electron/markdown-import.spec.ts`: import a
      fixture `.md`, open it in the reader (headings/code/links render), extract from it,
      export it to Markdown, and assert the export file exists; everything survives an
      **app restart**.
- [ ] **Fixtures/seed** — Markdown + HTML fixture files under
      `packages/importers/src/__fixtures__/markdown/` + `…/html/`. No seed change required.
- [ ] **Docs** — check the T068 box in [`../roadmap.md`](../roadmap.md) with the commit ref
      + a Progress-log line; note the `markdown-it` dep + the hand-written MD serializer +
      the defined round-trip fidelity contract.

### Done when

- Markdown (`.md`/`.markdown`) and HTML (`.html`/`.htm`) import as **inbox sources** —
  the main process parses them (Markdown via `markdown-it`, HTML via the shipped
  sanitize/HTML→PM transforms), maps the body to the **constrained schema with stable
  block ids** preserving **headings, code, links, lists, blockquotes** (images → alt
  text, per the schema), and creates the source through the existing transactional
  pipeline (one transaction, logged). A pasted-Markdown path works without a file.
- **Exported Markdown round-trips**: exporting a document to Markdown then re-importing
  yields a structurally equivalent document (the `doc → md → doc` fixed-point test passes),
  with the out-of-scope-by-schema features (images, code language, tables) explicitly
  documented as normalized away.
- All parse/serialize/file-IO runs **main-side**; the renderer reaches it only through the
  typed `window.appApi` (pickImportFile + importDocument + importMarkdownText +
  exportMarkdown) — no fs/Node/SQL in the renderer; exported files go to the managed
  `exports/` vault, never a renderer-chosen path.
- An Electron E2E imports a fixture `.md`, reads + extracts from it, exports it, and
  everything survives an **app restart**. `pnpm typecheck`, `pnpm lint`, `pnpm test`, and
  `pnpm e2e --project=electron` pass.

### Notes / risks

- **Round-trip fidelity is a CONTRACT, not "best effort".** Define it precisely (the
  fixed-point test above) so a builder can prove it and a reviewer can check it. The
  constrained schema is the fidelity ceiling: anything it cannot represent (images,
  tables, HTML passthrough, code-language, footnotes, task lists, strikethrough) is
  normalized away on import and is NOT expected to round-trip. Documenting the ceiling is
  part of the deliverable — silent fidelity loss is the failure mode to avoid.
- **HTML import security.** As with URL import, the sanitizer is load-bearing: an imported
  `.html` file is untrusted (it renders in the reader), so it goes through
  `sanitizeArticleHtml` BEFORE HTML→PM, and the constrained-schema validation is the final
  backstop. No scripts/styles/iframes/event-handlers/`javascript:` survive.
- **Markdown raw-HTML passthrough is OFF.** `markdown-it` with `html: false` means inline
  HTML in a Markdown file is escaped, not injected — keeping the import safe and the schema
  constrained. (A user wanting rich HTML should import the file AS HTML, which goes through
  the sanitizer.)
- **Export is a file artifact, not a mutation.** `exportToMarkdown` writes to `exports/`
  and appends NO `operation_log` entry (it changes no domain data). Keep it read-only on
  the DB.

---

## T069 — Highlight import (Readwise / Kindle-style)

- **Status:** `[ ]` not started  · **Depends on:** T012 (the inbox + source pipeline). In
  practice it builds on the extract pipeline (`SourceRepository.createExtractWithin` /
  `ExtractionService`) + the `source_locations` substrate.
- **Roadmap line:** Done when a generic highlight import format + adapters turn external
  highlights into inbox extracts (not active cards).

### Goal

A user imports their existing **highlights** from another tool — a **Readwise** export
(CSV or JSON) or a Kindle **`My Clippings.txt`** — and Interleave turns them into **inbox
`extract` elements** (NOT cards, NOT highlights-on-a-body), grouped under a **source per
book/article** they came from, **preserving source attribution** (book/article title,
author, and the highlight's location — Kindle "location 1234" / page, Readwise's location)
on each extract's `source_locations` anchor. An imported highlight is a first-class
schedulable extract the user can later distill into a card — exactly like a highlight they
extracted themselves. The parse runs main-side; the renderer never reads the file or
parses CSV/JSON/clippings.

### Context to load first

- Reference: [`../domain-model.md`](../domain-model.md) ("**Extracts are independent
  scheduled elements, not highlights**", line ~159; the `source_locations` anchor + its
  `page` column + `label`), [`../scheduling-and-priority.md`](../scheduling-and-priority.md)
  (an imported extract enters the attention scheduler as a normal extract — non-dominating
  priority), [`M4-extraction.md`](./M4-extraction.md) (the extraction/lineage substrate;
  read it if present, else the extract code below).
- Existing code to inspect: `SourceRepository.createExtractWithin` + `CreateExtractInput`
  (the extract + `source_locations` seam — `selectedText`, `blockIds`, `page`, `label`),
  `ExtractionService`
  ([`../../packages/local-db/src/extraction-service.ts`](../../packages/local-db/src/extraction-service.ts))
  (the extract-authoring + tag/priority inheritance pattern), `SourceRepository.create`
  /`createWithDocument` (the per-book/article source the extracts hang under),
  `deriveSourceLocationLabel`
  ([`../../packages/local-db/src/source-location-label.ts`](../../packages/local-db/src/source-location-label.ts))
  (the label style to match), the inbox + the `pickImportFile` command (T067).
- Invariants in play: imported highlights become **extracts**, never cards (cards require
  explicit authoring + quality checks — T033/T035); each extract carries source
  attribution via a `source_locations` anchor (title/author live on the owning source; the
  highlight's location is the `page`/`label`/`selectedText`); the parse runs **main-side**;
  one transaction per import batch (or per source) + logged; imported material defaults to a
  **non-dominating** priority (`C`); lineage is preserved (highlight → its
  source-location → its book/article source).

### The generic highlight format (specify concretely)

The normalized intermediate every adapter produces (pure, in `@interleave/importers`):
```ts
interface ImportedHighlight {
  readonly text: string;                 // the highlighted passage (required, non-empty)
  readonly note: string | null;          // the user's note on the highlight, if any
  readonly title: string;                // the book/article it came from (required)
  readonly author: string | null;
  readonly sourceUrl: string | null;     // article URL (Readwise), else null
  readonly location: string | null;      // raw location label ("Location 1234", "Page 56", "12:34")
  readonly page: number | null;          // parsed page number when derivable, else null
  readonly highlightedAt: string | null; // ISO timestamp when highlighted, if known
  readonly tags: readonly string[];      // Readwise tags, else []
}
```
The import groups `ImportedHighlight[]` **by `(title, author)`** into one **source per
book/article**; each highlight becomes one **extract** under that source.

### Deliverables

- [ ] **Adapters** in `packages/importers/src/highlights.ts` (PURE — no `fs`, no
      network):
  - [ ] **`parseReadwiseCsv(csv: string): ImportedHighlight[]`** — Readwise's CSV export
        columns (`Highlight`, `Title`, `Author`, `Note`, `Location`, `Location Type`,
        `Highlighted at`, `URL`, `Tags`, …). Use a tiny pure-JS CSV parse — add
        **`papaparse`** (pure JS, robust quoting/escaping, no native deps) to the importers
        package, OR a minimal hand-rolled RFC-4180 splitter if the dependency is unwanted
        (Readwise CSV is well-formed; prefer `papaparse` for correctness on quoted
        commas/newlines — justify the choice). Map columns → `ImportedHighlight`; parse the
        `Location` ("Location 1234" / "Page 56") into `page` when it's a page.
  - [ ] **`parseReadwiseJson(json: string): ImportedHighlight[]`** — Readwise's JSON
        export shape (an array of books, each with `highlights[]`); map to the normalized
        form. (Readwise also offers a per-highlight JSON; support the documented export
        shape, with a tolerant parse + a clear error on an unrecognized shape.)
  - [ ] **`parseKindleClippings(text: string): ImportedHighlight[]`** — the Kindle
        `My Clippings.txt` format: records separated by `==========`, each with a title
        line ("Title (Author)"), a metadata line ("- Your Highlight on page 56 | location
        1234-1240 | Added on …"), a blank line, and the highlight text. Parse the
        title/author out of the first line, the page/location out of the metadata line, the
        text body, and drop "Your Bookmark" / empty entries. (Kindle clippings are
        notoriously messy — be tolerant: skip malformed records rather than failing the
        whole import; count + report skips.)
  - [ ] **`detectHighlightFormat(filename: string, content: string): "readwise_csv" |
        "readwise_json" | "kindle_clippings" | null`** — sniff by extension + content
        (a `.txt` containing `==========` → kindle; `.json` parsing to the Readwise shape →
        readwise_json; `.csv` with the Readwise header → readwise_csv) so the service can
        auto-route a picked file. Returns `null` (→ a friendly "unrecognized highlight
        export" error) when nothing matches.
  - Export all four + `ImportedHighlight` from `packages/importers/src/index.ts`.
- [ ] **Main-side `HighlightImportService`** in
      `apps/desktop/src/main/highlight-import-service.ts` — constructed `{ db, repositories
      }` (no vault needed; highlights are text). Public:
      `importFromFile(input: { absPath: string; format?: HighlightFormat; priority?:
      PriorityLabel }): Promise<HighlightImportResult>` where `HighlightImportResult =
      { status: "imported"; sourceCount: number; extractCount: number; skipped: number;
      items: readonly InboxItemSummary[] }`. Steps:
  1. Read the file in main; `detectHighlightFormat` (or use the supplied `format`);
     run the matching adapter → `ImportedHighlight[]`. A `null` format / zero highlights →
     a typed `HighlightImportError` ("Couldn't recognize this highlight export").
  2. **Group by `(title, author)`**. For each group, in ONE transaction:
     - find-or-create the **book/article source** (`createWithDocument` with an empty/near-
       empty body — a heading with the title — `status: "inbox"`, `stage: "raw_source"`,
       the `author`, the `sourceUrl` as `url`/`originalUrl`, `reasonAdded: "Imported
       highlights"`, priority `C`). **Dedup:** if a live source with the same canonical
       URL (Readwise URL) OR the same title+author already exists, REUSE it (so re-running
       an export does not create duplicate books — for the URL case write a new
       `SourceRepository.findByCanonicalUrl(canonicalUrl)` query that uses the existing
       `sources_canonical_url_idx` index
       ([`../../packages/db/src/schema/sources.ts`](../../packages/db/src/schema/sources.ts) line ~46);
       T061 added that index + the `canonicalUrl` field but **no named query** — its `importUrl` dedup
       inlines the lookup, so this parallels that rather than reusing a method that does not exist —
       and a title+author lookup for the no-URL case). Document the dedup; a re-import adds only NEW
       highlights (dedup extracts by `(sourceId, text)` so the same highlight isn't added twice).
     - for each highlight in the group, create an **`extract`** via `createExtractWithin`
       with `sourceElementId = the book source`, `selectedText = highlight.text`,
       `blockIds = []` (no in-body anchor — the highlight came from outside our document),
       `page = highlight.page`, `label = highlight.location ?? deriveLabelFromPage(page)`,
       `title` = a short slug of the text, `priority: C`, `stage: "raw_extract"`. If the
       highlight has a `note`, seed it into the extract body or store it (the extract body
       is the highlight text; the note can be appended as a second paragraph). Inherit the
       highlight's `tags` onto the extract (`addTagWithin`). Each extract logs
       `create_element` + `create_extract` (+ `add_tag`).
  3. Return the counts + the inbox summaries for the created/updated sources. The extracts
     appear in the queue/library as normal pending extracts (NOT cards).
  - **Why extracts, not cards (the roadmap's load-bearing constraint).** A highlight is
    raw, unprocessed material — exactly an extract's role ("a raw extract"). Turning it
    straight into an active card would bypass the minimum-information / quality checks
    (T035) and flood review with un-distilled clippings. So the import stops at `extract`;
    the user later runs the normal extract → card distillation. Enforce this: the service
    creates ONLY `extract` elements, never touches `cards`/`review_states`.
- [ ] **IPC contract + channels + handlers + preload + client** for
      `sources.importHighlights({ path, format? })` (reusing `pickImportFile({ kind:
      "highlights" })`), returning `HighlightImportResult`. Async handler (file I/O). DB-
      service `get highlightImportService()` accessor + `importHighlights` method.
- [ ] **Renderer affordance** — extend the T067 `ImportFileModal` with a `kind:
      "highlights"` mode ("Import highlights…" — accepts `.csv`/`.json`/`.txt`), show the
      detected format + the counts on success ("Imported 142 highlights into 6 sources, 3
      skipped"), and `refresh()` the inbox. Pure UI.
- [ ] **Tests (unit, importers — fixture-driven)** in `packages/importers/src/highlights.test.ts`
      against fixtures under `packages/importers/src/__fixtures__/highlights/` (a Readwise
      CSV, a Readwise JSON, a Kindle `My Clippings.txt` with a few books + a malformed
      record): each adapter parses the right `ImportedHighlight[]` (text/title/author/
      location/page/tags); `parseKindleClippings` skips a malformed record + a bookmark
      entry and counts the skips; `detectHighlightFormat` routes each fixture correctly +
      returns `null` for garbage.
- [ ] **Tests (main-side service)** in `apps/desktop/src/main/highlight-import-service.test.ts`
      (real temp-file DB): importing the Readwise CSV creates one source per book with N
      `extract` children each carrying a `source_locations` row (page/label/selectedText)
      and the right ops, and **creates NO `cards`/`review_states` rows** (assert the card
      count is zero); re-importing the SAME file does not duplicate sources or extracts
      (dedup); a Kindle clippings import groups by book + preserves locations; **restart-
      persistence** — re-open the DB and the sources + extracts survive.
- [ ] **Tests (contract)** — `SourcesImportHighlightsRequestSchema` accepts valid +
      rejects invalid; the result round-trips.
- [ ] **Tests (E2E, Electron)** — `tests/electron/highlight-import.spec.ts`: import a
      fixture export, see the new sources in the inbox + their extracts in the library/
      queue, confirm they are extracts (not in the review deck), and everything survives an
      **app restart**.
- [ ] **Fixtures/seed** — the highlight-export fixtures are the only new test data.
- [ ] **Docs** — check the T069 box in [`../roadmap.md`](../roadmap.md) with the commit ref
      + a Progress-log line; note the generic `ImportedHighlight` format + the three
      adapters + that highlights become extracts (not cards) + the `papaparse` dep (if
      added).

### Done when

- Importing a Readwise CSV/JSON export or a Kindle `My Clippings.txt` turns external
  highlights into **inbox `extract` elements** (NOT cards, NOT body highlights), grouped
  under one **source per book/article**, each extract **preserving source attribution**
  (title/author on the owning source; the highlight's location as `page`/`label`/
  `selectedText` on its `source_locations` anchor) — through the existing extract pipeline,
  one transaction per source, appending the right `operation_log` entries.
- An imported highlight is a normal schedulable extract (it enters the attention queue, can
  be distilled into a card via the standard flow); the import creates **zero** card/review
  rows. Re-importing the same export does not duplicate sources or extracts.
- The parse runs **main-side**; the renderer reaches it only through
  `window.appApi.sources.importHighlights` (+ `pickImportFile`) — no fs/Node/SQL in the
  renderer.
- An Electron E2E imports a fixture export and the sources/extracts survive an **app
  restart**. `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron`
  pass.

### Notes / risks

- **Extracts, not cards — non-negotiable.** This is the roadmap's explicit constraint and
  the right product call: dumping hundreds of raw clippings into active review would
  violate the minimum-information principle and bury the deck. The import floor is
  `extract`; distillation to a card stays a deliberate user action. Enforce + test it.
- **Kindle clippings are messy.** Locale-specific date/location strings, duplicate
  highlights (Kindle re-emits on edit), bookmarks, and notes-attached-to-highlights make
  the format error-prone. Be tolerant: skip + count malformed records, dedup obvious
  duplicates, never fail the whole import on one bad record. Surface the skip count so the
  user knows.
- **Attribution over in-body anchoring.** These highlights did not come from a document we
  hold, so their `source_locations` has empty `blockIds` (no jump-to-paragraph) — the
  anchor carries attribution (title/author/page/`selectedText`) instead. If the user later
  imports the actual book (T067 EPUB) they could re-anchor (out of scope here — note it as
  a future link-up).
- **No semantic dedup.** Dedup is exact `(sourceId, text)` match only; near-duplicate
  highlights are not merged (semantic dedup is T088/M18). Keep it simple.

---

## T070 — Anki import/export

- **Status:** `[ ]` not started  · **Depends on:** T032 (the card model — `cards`,
  `review_states`, `review_logs`, `CardService`). In practice it also builds on the
  source/extract pipeline (an imported Anki note lands as a card under a lineage root) and
  the asset vault (the `.apkg`'s embedded media + the export archive).
- **Roadmap line:** Done when cards export to Anki-compatible packages/CSV with source
  refs, and Anki cards import as card elements preserving review history when available.

### Goal

Interleave interoperates with **Anki** both ways, locally:
- **Export** — the user exports a selection of cards (a concept, a deck-like filter, or
  all) to an **Anki-compatible `.apkg`** (and/or a **CSV**) that imports into Anki, **with
  source references** carried into Anki (the originating source title/URL/location as an
  extra field / tag) so the lineage is not lost on the way out.
- **Import** — the user imports an **Anki `.apkg`** and its notes become Interleave **card
  elements** (Q&A from Basic notes, cloze from Cloze notes), **preserving review history
  when available** (the `.apkg`'s revlog / card scheduling → `review_states` +
  `review_logs`, with the **FSRS-vs-Anki-SM2 mapping limits** documented and handled
  honestly), each anchored under a lineage root so an imported card is not orphaned.

All `.apkg` (de)serialization (zip + the embedded SQLite `collection.anki2` + the media
map) runs main-side; the renderer never reads the archive or touches SQLite.

### Context to load first

- Reference: [`../domain-model.md`](../domain-model.md) (the `card` element + `cards`/
  `review_states`/`review_logs` model; lineage is sacred), [`../scheduling-and-priority.md`](../scheduling-and-priority.md)
  + the FSRS notes (the difference between Anki's SM-2 scheduling and our FSRS state — the
  mapping limit), [`M6-cards.md`](./M6-cards.md) / [`M7-fsrs-review.md`](./M7-fsrs-review.md)
  (the card + review-state model, if present).
- Existing code to inspect: `CardService.createFromExtract`
  ([`../../packages/local-db/src/card-service.ts`](../../packages/local-db/src/card-service.ts))
  (the card-authoring transaction — `create_element`/`create_card`/un-due `review_states`/
  sibling group/cloze marks); the `cards` schema
  ([`../../packages/db/src/schema/cards.ts`](../../packages/db/src/schema/cards.ts) —
  `kind`, `prompt`, `answer`, `cloze`, `sourceLocationId`, `isLeech`); the `review_states`
  + `review_logs` schema (the FSRS memory state + grading history we map INTO);
  `ReviewRepository` (`createCardWithin` + the review-state writes);
  `canonicalizeCloze`/`parseCloze` ([`../../packages/core`](../../packages/core/src/))
  (Anki's `{{c1::…}}` cloze syntax IS our canonical cloze text — they align); the
  `@interleave/scheduler` FSRS wrapper (T036) for seeding a sane FSRS state from Anki
  scheduling; `AssetVaultService.importAsset` + `exportsDir` (the `.apkg`'s media + the
  export file); `ASSET_KINDS` (add `import_archive` for a retained `.apkg`).
- Invariants in play: an imported note becomes a **`card` element** with a real lineage
  root (a per-deck `source` so the card is not orphaned); review history maps INTO
  `review_states`/`review_logs` HONESTLY (no fabricated FSRS stability — see the mapping
  limit); cloze text uses our canonical `{{c1::…}}` form (`canonicalizeCloze`); the
  `.apkg` read/write runs **main-side**; one transaction per imported note (or per deck) +
  logged; export is a read-only file artifact (no op-log); the export carries source refs.

### Dependencies to add (concrete, justified)

Add to **`packages/importers`** (pure transform — for the `.apkg` parse/build), with the
SQLite read/write of the embedded `collection.anki2` done **main-side** (it needs
`better-sqlite3`, which is already a main dependency and must NOT be pulled into the pure
package):
- **Zip:** reuse **`fflate`** (added in T067) for reading/writing the `.apkg` ZIP
  container (an `.apkg` is a ZIP of `collection.anki2` (or `.anki21`/`.anki21b`) + a
  `media` JSON map + numbered media files). No new zip dep.
- **The embedded Anki collection is an SQLite DB.** Reading/writing
  `collection.anki2` requires opening a SQLite database. **Do this main-side with the
  already-present `better-sqlite3`** (open the extracted `collection.anki2` bytes as a
  temp file or via an in-memory DB) — NOT in the pure importers package (which must stay
  DB-free + bundleable). So the split is: `@interleave/importers` owns the **pure**
  `.apkg` ↔ {note records, media map} transforms that operate on already-extracted
  collection ROWS (parse the Anki `notes`/`cards`/`revlog`/`col` row shapes into
  normalized records, and build the row shapes for export); the main-side
  `AnkiImportService`/`AnkiExportService` own the **`better-sqlite3` open/read/write** of
  `collection.anki2` + the zip + the vault. Justify this split in the docblocks. (Building
  a valid Anki `collection.anki2` from scratch is fiddly — the `col` table's `models`/
  `decks` JSON, the checksums. Ship a **minimal but Anki-importable** schema: a single
  Basic note type + a single Cloze note type + one deck, which Anki accepts. Document that
  we target Anki's import, not byte-identical Anki internals.)
- **CSV export** reuses the same CSV approach as T069 (`papaparse` or a minimal writer) —
  Anki's "import CSV" wants one row per note with the fields + a tags column. No extra dep.

Do NOT add a heavyweight "anki" npm package — the few that exist are unmaintained,
browser-oriented, or assume a Python/`genanki` runtime. We own the `.apkg` shape with
`fflate` + `better-sqlite3` + small pure transforms, so it is testable + maintainable.

### Deliverables

- [ ] **Pure Anki transforms** in `packages/importers/src/anki.ts` (NO `better-sqlite3`,
      NO `fs`):
  - [ ] **`AnkiNoteRecord`** — the normalized intermediate:
        `{ guid; noteTypeName; fields: string[]; tags: string[]; kind: "qa" | "cloze";
        prompt: string | null; answer: string | null; cloze: string | null; scheduling:
        AnkiScheduling | null; media: string[] }` and `AnkiScheduling = { due; interval;
        ease; reps; lapses; reviews: AnkiReviewLogEntry[] }` (the SM-2-ish fields from the
        Anki `cards`/`revlog` rows).
  - [ ] **`ankiRowsToNotes(rows: { notes; cards; revlog; col }): AnkiNoteRecord[]`** —
        the PURE mapper from already-read Anki collection rows (the main-side service reads
        them via `better-sqlite3` and hands them in) to `AnkiNoteRecord[]`: split each
        note's `flds` (Anki separates fields with the `\x1f` char) by the note type's
        field list (parsed from `col.models` JSON), classify Basic vs Cloze by the model
        name/template, derive `prompt`/`answer` (Basic: front/back) or `cloze` (Cloze: the
        text field is already `{{c1::…}}`), and attach the scheduling + revlog. Strip
        Anki HTML in fields to plain/constrained text (REUSE `sanitizeArticleHtml` — Anki
        fields are HTML).
  - [ ] **`notesToAnkiRows(notes: ExportNote[], col): { notes; cards; revlog }`** — the
        PURE builder for export: given Interleave cards mapped to `ExportNote`
        (`{ kind; prompt?; answer?; cloze?; tags; sourceRef }`), build the Anki `notes`/
        `cards` rows (+ optional `revlog`) for the minimal Basic/Cloze note types, putting
        the **source reference** into a dedicated extra field (`Source`) AND a tag
        (`interleave::source::<slug>`) so it survives into Anki. (The `col` table's
        `models`/`decks` JSON is built by the main-side service from a fixed template;
        this function builds the per-note rows.)
  - [ ] **`parseApkgZip(bytes) → { collectionBytes: Uint8Array; media: Record<string,
        string> ; mediaFiles: Record<string, Uint8Array> }`** and **`buildApkgZip({
        collectionBytes, media, mediaFiles }) → Uint8Array`** — the PURE zip
        wrap/unwrap (via `fflate`), separating the `collection.anki2` bytes (which the
        main-side service opens with `better-sqlite3`) from the media. Handle the
        `.anki21`/`.anki21b` (zstd-compressed) variants by detecting + (for `.anki21b`)
        reporting an unsupported-compression error if zstd is not bundled — prefer
        targeting the widely-supported `collection.anki2`/`.anki21` (uncompressed) form for
        export, and on import accept `.anki2`/`.anki21`, erroring clearly on `.anki21b`
        unless a pure-JS zstd is added. Document the format-version support matrix.
  - Export the types + functions from `packages/importers/src/index.ts`.
- [ ] **Migration — `cards.source_uri` + `ASSET_KINDS += "import_archive"`.** Add a
      nullable `sourceUri` text column to the `cards` table
      ([`../../packages/db/src/schema/cards.ts`](../../packages/db/src/schema/cards.ts)) —
      the round-trippable, human-readable source reference (the originating source
      title + URL/location) carried OUT to Anki's `Source` field and read back IN on
      import, so an Anki round-trip does not lose the source pointer even when there is no
      `source_locations` anchor (an imported Anki card has no in-app source location). Also
      add `import_archive` to `ASSET_KINDS` (for retaining the imported `.apkg` in the
      vault, so a re-import/audit is possible). Run `pnpm db:generate` → the `0008_*` (or
      next) migration (this can be the SAME migration as T067's `source_epub` if T067/T070
      land together, or a separate `0009_*` — keep each task's schema change in its own
      reviewable migration if they land separately). Commit the generated SQL. **The
      `cards.source_uri` column is consumed by the widened `createCardWithin` seam** (step 5
      above) — the migration adds the column; the seam widening writes it. Update the
      auto-inferred `CardRow`/`NewCardRow` types + the card mapper to carry `sourceUri`.
- [ ] **Widen the `createCardWithin` creation seam** (per step 5) — extend `CreateCardInput`
      with `sourceUri?: string | null` (→ the `cards.source_uri` insert) and an optional
      `reviewSeed` (→ the `review_states` row written from the seed instead of the bare
      `new`/`firstScheduledAt` default), and update `createCardWithin`
      ([`../../packages/local-db/src/review-repository.ts`](../../packages/local-db/src/review-repository.ts)
      ~line 138) accordingly. This is the seam Anki history flows through. Add the unit test
      described in step 5 (seed persists; no-seed path unchanged).
- [ ] **Main-side `AnkiImportService`** in `apps/desktop/src/main/anki-import-service.ts`
      — constructed `{ db, repositories, assetsDir }`. Public:
      `importFromFile(input: { absPath: string; priority?: PriorityLabel }):
      Promise<AnkiImportResult>` where `AnkiImportResult = { status: "imported"; deckCount:
      number; cardCount: number; withHistory: number; item: InboxItemSummary }`. Steps:
  1. Read the `.apkg` in main; `parseApkgZip` → `collection.anki2` bytes + media.
  2. Open the collection bytes with **`better-sqlite3`** (write to a temp file, open
     read-only), read the `notes`/`cards`/`revlog`/`col` rows, and `ankiRowsToNotes` →
     `AnkiNoteRecord[]`. Close + delete the temp.
  3. Stream the imported `.apkg` into the vault (`import_archive` kind) for provenance/
     re-import (optional but recommended — document).
  4. **Create a per-deck lineage root `source`** ("Imported Anki deck: <deck name>",
     `status: "inbox"`, `stage: "raw_source"`, priority `C`) so imported cards are NOT
     orphaned (every card must point back to a source — the invariant). Import the deck's
     media files into the vault as `image`/`audio` assets owned by their cards (best-effort;
     media-on-cards is M15 territory — for T070, import the bytes + alt/filename so they
     are not lost, even if rich rendering waits).
  5. For each note, in ONE transaction, create a **`card` element** via the
     `ReviewRepository.createCardWithin` seam (the same one `CardService` uses) with
     `kind` (qa/cloze), `prompt`/`answer` or canonicalized `cloze` (`canonicalizeCloze`),
     `parentId`/`sourceId` = the deck source, `sourceUri` = the Anki `Source` field /
     deck name (so attribution survives), the imported `tags`, and stage `active_card`.
     **Map review history (the roadmap's "preserving review history when available")** —
     see the dedicated deliverable below. Each note logs `create_element` + `create_card`
     (+ `add_tag` + the review-history ops).
     > **Widen the `createCardWithin` seam first — this is genuinely new code, not just a
     > call.** The shipped `CreateCardInput`
     > ([`../../packages/local-db/src/review-repository.ts`](../../packages/local-db/src/review-repository.ts)
     > ~lines 47–72) has **no `sourceUri`** and **no FSRS-seed inputs**: its only scheduling
     > input is `firstScheduledAt` (which merely sets `dueAt`), and `createCardWithin`
     > (~line 138) ALWAYS writes a fresh `review_states` row at the schema defaults
     > (`stability=0, difficulty=0, reps=0, lapses=0, fsrsState="new"`). The only code that
     > writes those counters today is the grading path (`recordReview`,
     > [`review-repository.ts`](../../packages/local-db/src/review-repository.ts):260–305), NOT a
     > creation seam. So T070 must **extend `CreateCardInput` + `createCardWithin`** (a
     > localized, additive change) BEFORE it can persist Anki history through this seam:
     > - add `sourceUri?: string | null` to `CreateCardInput` → the `cards` insert writes
     >   it into the new `cards.source_uri` column (migration below);
     > - add an optional `reviewSeed?: { reps; lapses; stability; difficulty; elapsedDays?;
     >   scheduledDays?; fsrsState?: FsrsState; dueAt: IsoTimestamp | null } | null` to
     >   `CreateCardInput` → when supplied, `createCardWithin` writes the `review_states` row
     >   with THOSE values (and the matching element `dueAt`) instead of the bare
     >   `{ fsrsState: "new", dueAt: firstScheduledAt }` default. When omitted, the existing
     >   default behaviour is unchanged (every existing caller — `CardService`,
     >   authored-card flows — keeps working untouched). `firstScheduledAt` and `reviewSeed`
     >   are mutually exclusive (a seed implies its own `dueAt`); document the precedence.
     > Add a **unit test** that `createCardWithin` with a `reviewSeed` persists the seeded
     > `reps`/`lapses`/`stability`/`difficulty`/`fsrsState`/`dueAt` into `review_states` (and
     > `sourceUri` into `cards`), and that the no-seed path is byte-identical to today (no
     > regression to the authored-card shape). This widening IS the mechanism the
     > "preserving review history when available" criterion below relies on — without it the
     > builder hits a wall at step 5.
  6. Return the counts. Imported cards appear in the review deck scheduled per their mapped
     state.
- [ ] **Review-history mapping (FSRS-vs-SM-2 — handle honestly).** Anki schedules with
      SM-2 (interval + ease factor) or, in recent Anki, its own FSRS; OUR scheduler is
      ts-fsrs with a specific state (`stability`, `difficulty`, `elapsedDays`, `reps`,
      `lapses`, `fsrsState`, `learningSteps`). There is **no exact, lossless map** from
      SM-2 ease/interval to FSRS stability/difficulty. Implement an **honest, documented
      approximation**, with a clear limit statement:
  - **`reps`/`lapses`** map directly (Anki `cards.reps`/`lapses` → our counters) — these
    ARE comparable; carry them.
  - **`dueAt`** maps directly (preserve the next-due date so the card lands on roughly the
    same review schedule — this is the most user-visible continuity).
  - **`stability`** is **seeded** from the Anki interval (a mature Anki card with interval
    N days seeds an FSRS stability ≈ N, since FSRS stability is "days until ~90%
    retrievability" and a stable Anki interval is a reasonable proxy); **`difficulty`** is
    seeded from a transform of the Anki ease factor (lower ease → higher difficulty), or a
    neutral default when ease is unavailable. State EXPLICITLY in the docblock + the
    migration/notes that this is an **approximation, not a faithful FSRS history** — the
    real FSRS parameters re-converge over the next few reviews; we do NOT fabricate a
    per-review FSRS log for historical Anki reviews. **All of this lands in `review_states`
    through the widened `createCardWithin` `reviewSeed` input** (step 5 above): the mapper
    computes the `{ reps, lapses, stability, difficulty, dueAt, fsrsState }` seed from the
    `AnkiScheduling` record and passes it in — `createCardWithin` writes it; this task does
    NOT write `review_states` directly from the service.
  - **`review_logs`** — for the imported revlog, write **summary** `review_logs` rows
    where the data allows (rating + reviewedAt are in the Anki revlog; the before/after
    FSRS state columns are filled with the SEEDED state, clearly marked as imported) OR —
    cleaner — do NOT fabricate FSRS-shaped logs and instead record the import as a single
    note in the card (the honest option). **Pick ONE and document it**; the preferred
    approach is: carry `reps`/`lapses`/`dueAt`/seeded `stability`/`difficulty` into
    `review_states` (so scheduling continuity is preserved) and do NOT manufacture
    historical `review_logs` (so the grading history stays truthful — only real
    in-Interleave reviews appear there). This keeps analytics honest. When the `.apkg` has
    NO scheduling (a fresh/never-studied note), the card imports as a brand-new un-due card
    (`fsrsState: "new"`, due now) like any authored card.
  - Add a `withHistory` count to the result so the UI can say "imported 200 cards (150 with
    scheduling carried over)".
- [ ] **Main-side `AnkiExportService`** in `apps/desktop/src/main/anki-export-service.ts`
      — constructed `{ db, repositories, exportsDir, assetsDir }`. Public:
      `exportApkg(input: { cardIds?: ElementId[]; conceptId?: ElementId; all?: boolean }):
      Promise<{ relativePath: string; absPath: string; cardCount: number }>` and
      `exportCsv(input: …): Promise<{ relativePath; absPath; cardCount }>`. Steps:
  1. Resolve the card selection (explicit ids / a concept's cards / all live cards) via
     the repositories.
  2. For each card, build an `ExportNote` with the prompt/answer or cloze, the tags, and
     the **source reference** — derived from the card's `sourceUri` and/or its
     `source_locations` anchor + the owning source's title/URL (so the lineage goes OUT to
     Anki's `Source` field + the `interleave::source::…` tag). This is the roadmap's "with
     source refs" requirement.
  3. **Export `.apkg`:** build the minimal `col` (Basic + Cloze note types + one deck) +
     the per-note rows (`notesToAnkiRows`), write a `collection.anki2` with `better-sqlite3`
     (a fresh temp DB → the Anki schema → insert the rows), `buildApkgZip` it with any
     media, and write the `.apkg` to `exports/`. **Export CSV:** one row per note
     (fields + a `Tags` column + a `Source` column), to `exports/`.
  4. Read-only on the Interleave DB (no mutation, no op-log) — export produces a file.
- [ ] **IPC contract + channels + handlers + preload + client** for
      `cards.importAnki({ path, priority? }) → AnkiImportResult` (reusing `pickImportFile({
      kind: "anki" })`) and `cards.exportAnki({ selection, format: "apkg" | "csv" }) →
      { path; cardCount }`. Async handlers (file I/O + the `better-sqlite3` collection
      read/write). DB-service `get ankiImportService()` / `get ankiExportService()`
      accessors + the methods. (Use a `cards` AppApi group, beside the existing card
      commands.)
- [ ] **Renderer affordances** — extend the T067 `ImportFileModal` with a `kind: "anki"`
      mode ("Import Anki deck…", accepts `.apkg`), showing the counts + the with-history
      note on success; and add **"Export to Anki"** (apkg / CSV) actions to the
      review/library/concept context menus (a small dialog: scope = selection/concept/all,
      format = apkg/CSV) → `cards.exportAnki` → toast "Exported N cards to …" + a "Reveal
      in Finder" action. Pure UI. Render gracefully when `!isDesktop()`.
- [ ] **Tests (unit, importers — fixture-driven)** in `packages/importers/src/anki.test.ts`:
  - `ankiRowsToNotes` over fixture Anki rows (a Basic note + a Cloze note + a note with a
    revlog) splits fields correctly, classifies qa/cloze, derives prompt/answer + cloze
    (`{{c1::…}}`), strips field HTML, and attaches scheduling/revlog;
  - `notesToAnkiRows` round-trips an `ExportNote` to rows whose fields/tags carry the
    source ref;
  - `parseApkgZip(buildApkgZip(x))` is identity on the media map + collection bytes (zip
    round-trip);
  - a `.anki21b` (zstd) archive reports the documented unsupported error.
- [ ] **Tests (main-side service, import)** in `apps/desktop/src/main/anki-import-service.test.ts`
      (real temp-file DB + a fixture `.apkg` built in-test via `buildApkgZip` + a
      `better-sqlite3`-authored `collection.anki2` so no binary blob is committed):
      importing creates a per-deck `source` + N `card` elements (Basic → qa, Cloze →
      cloze) with the right ops; a note WITH scheduling carries `reps`/`lapses`/`dueAt` +
      a seeded `stability`/`difficulty` into `review_states` (assert the seeded state is
      plausible + `dueAt` preserved) and `withHistory` counts it; a note WITHOUT scheduling
      imports as a new un-due card; **no fabricated `review_logs`** (assert the log count is
      zero for imported cards, per the chosen honest mapping); **restart-persistence** —
      re-open the DB and the cards + states survive.
- [ ] **Tests (main-side service, export + round-trip)** in
      `apps/desktop/src/main/anki-export-service.test.ts`: exporting selected cards writes
      an `.apkg` to `exports/`; **the round-trip** — export Interleave cards to `.apkg`,
      then `importFromFile` that same `.apkg` back, and assert the prompts/answers/cloze
      text + the **source ref** survive (the source ref is in the re-imported card's
      `sourceUri`); CSV export writes the expected rows (fields + tags + source column).
- [ ] **Tests (contract)** — the import/export request schemas accept valid + reject
      invalid; the results round-trip.
- [ ] **Tests (E2E, Electron)** — `tests/electron/anki.spec.ts`: import a fixture `.apkg`,
      see the cards in the review deck (review one), export a selection back to `.apkg`,
      assert the export file exists; everything survives an **app restart**.
- [ ] **Fixtures/seed** — Anki fixtures are built in-test (`buildApkgZip` +
      `better-sqlite3`-authored collection) so no `.apkg` binary is committed. No seed
      change required.
- [ ] **Docs** — check the T070 box in [`../roadmap.md`](../roadmap.md) with the commit ref
      + a Progress-log line; note the `cards.source_uri` column + `import_archive` asset
      kind + the migration, the pure-`@interleave/importers` / main-side-`better-sqlite3`
      split, the supported `.apkg` format-version matrix, and the **explicit FSRS-vs-SM-2
      mapping limit** (scheduling continuity is approximated, historical FSRS logs are NOT
      fabricated).

### Done when

- Selected cards **export** to an Anki-compatible **`.apkg`** (and CSV) in the `exports/`
  vault, **carrying source references** (the originating source title/URL/location → an
  Anki `Source` field + an `interleave::source::…` tag), and the `.apkg` imports cleanly
  into Anki (and back into Interleave — the round-trip test passes, source ref intact).
- An Anki **`.apkg` imports** as Interleave **`card` elements** (Basic → Q&A, Cloze →
  cloze with `{{c1::…}}` text), each under a per-deck lineage-root `source` (never
  orphaned), **preserving review history when available** — `reps`/`lapses`/`dueAt` carried
  + a seeded FSRS `stability`/`difficulty`, with the **FSRS-vs-SM-2 mapping limit
  documented** (scheduling continuity approximated; no fabricated historical FSRS logs) —
  through the existing card pipeline, one transaction per note, logged.
- All `.apkg` zip + embedded-SQLite read/write runs **main-side** (`better-sqlite3` in
  main, pure transforms in `@interleave/importers`); the renderer reaches it only through
  `window.appApi.cards.importAnki`/`exportAnki` (+ `pickImportFile`) — no fs/Node/SQL in
  the renderer.
- An Electron E2E imports a fixture `.apkg`, reviews a card, exports a selection, and
  everything survives an **app restart**. `pnpm typecheck`, `pnpm lint`, `pnpm test`, and
  `pnpm e2e --project=electron` pass; the new migration applies cleanly.

### Notes / risks

- **FSRS-vs-SM-2 is the load-bearing honesty point.** There is no faithful map from Anki's
  SM-2 ease/interval to FSRS stability/difficulty. Preserve what IS comparable
  (reps/lapses/dueAt) and SEED the FSRS state plausibly so scheduling continuity holds and
  re-converges, but do NOT manufacture a fake per-review FSRS history — that would corrupt
  analytics + future FSRS optimization (T080). Document the limit in the code + the import
  UI ("scheduling carried over approximately; review history re-learns over the next few
  reviews"). When the importing user runs Anki's own FSRS, the interval is already FSRS-ish
  and the seed is better — note it but don't special-case heavily.
- **`.apkg` format versions.** Modern Anki writes `.anki21`/`.anki21b` (the latter
  zstd-compressed); older exports are `.anki2`. Target `.anki2`/`.anki21` (uncompressed)
  for our EXPORT (maximally importable) and accept those on IMPORT; error clearly on
  `.anki21b` unless a pure-JS zstd dep is added. State the matrix in the docblock + the UI.
- **We target Anki's importer, not byte-identical internals.** Building a fully
  Anki-internal-faithful `collection.anki2` (every `col.conf`/`models`/`dconf` field,
  checksums, `usn`) is large + brittle; ship the MINIMAL valid shape Anki's import accepts
  (Basic + Cloze note types, one deck, correct field separators + GUIDs + checksums for the
  note dedup). Test against the round-trip (our import of our export) as the contract; a
  manual "imports into real Anki" check is documented but not CI-gated.
- **Media is carried, not richly rendered (yet).** `.apkg` media (images/audio in fields)
  is imported into the vault + referenced, but rich in-card media rendering is M15 (image
  occlusion / audio cards). For T070, do not lose the bytes; full rendering is downstream.
- **Cards, source refs, lineage.** Every imported Anki card gets a real `source` root +
  a `sourceUri`, honoring "a card must point back to its source". Export carries the ref out.
  This is what keeps Anki interop from being a lineage black hole.

---

## Exit criteria for M14-formats (T067–T070)

- T067–T070 are `[x]` in [`../roadmap.md`](../roadmap.md) with commit refs + Progress-log
  entries (noting the local-first envelope: vault not S3, main/runner not server worker).
- A user can, **fully locally**: import an `.epub` as a book→chapter-topic tree read
  incrementally; import + export Markdown (round-tripping) and import HTML; import
  Readwise/Kindle highlights as inbox **extracts** (not cards) with attribution; and
  import an Anki `.apkg` as cards (review history approximated, FSRS-vs-SM-2 limit
  documented) + export cards to Anki `.apkg`/CSV with source refs.
- Every importer maps document content to the **constrained editor schema with stable
  block ids**, creates elements through the **existing transactional pipeline** (appending
  the right `operation_log` ops, soft-delete only, lineage sacred), stores original bytes
  in the **filesystem asset vault** (never SQLite), and runs all parse/serialize/file-IO
  **main-side** — the renderer touches no fs/Node/SQL, only `window.appApi`.
- Pure transforms live in `@interleave/importers` with **fixture-driven unit tests**; the
  orchestration is in construction-time-injected main-side services with integration tests
  on a real temp-file DB; each format has an **Electron E2E** proving the flow + an **app
  restart** survival check.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` are green
  in CI; the M14 migrations (`0008_*` and any siblings — `source_epub`/`import_archive`
  asset kinds, `cards.source_uri`) apply cleanly on an existing dev DB.

When M14-formats is complete (and the PDF half T064–T066), M15 (rich-media cards —
T071–T075) is unblocked: image/video/audio bytes land in the scaled vault via
`AssetVaultService.importAsset` and transcode/clip/OCR work runs on the T058 runner.

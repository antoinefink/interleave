# M4 — Highlights, extraction & lineage (T019–T026)

Detailed, buildable specs for the fourth milestone. M4 turns the read-only reader from
M3 into the **distillation engine**: the user selects text and acts on it. The keystone is
**extraction** (T021) — lifting a fragment into an *independent, scheduled* child `extract`
element that knows exactly where it came from. Around it sit the affordances that make
extraction usable and lineage actionable: an inline selection toolbar (T019), removable
highlights that are *not* extracts (T020), persisted source locations with jump-back (T022),
a bidirectional hierarchy view (T023), an extract review mode that walks a fragment from
`raw_extract → clean_extract → atomic_statement` (T024), sub-extracts that preserve the chain
(T025), and a mark-processed affordance that dims source text without deleting it (T026).

After M4 the core distillation loop exists end to end: **read → highlight → extract →
distill → (sub-)extract → mark processed**, with `source → extract → sub-extract` lineage
that survives an app restart and is navigable in both directions. Cards (M6) and the
queue/scheduler (M5) build on the scheduled extracts this milestone produces.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md) and
the roadmap header): the React **renderer** (`apps/web`) never touches SQLite, Node, or the
filesystem. Every mutation flows React UI → typed client wrapper (`apps/web/src/lib/appApi.ts`)
→ preload bridge (`apps/desktop/src/preload/index.ts`) → validated IPC (Zod) on the main side
(`apps/desktop/src/main/ipc.ts`) → the `DbService` (`apps/desktop/src/main/db-service.ts`) →
`packages/local-db` repositories/services → SQLite + asset vault. Every meaningful mutation
runs in **one transaction** and appends an **`operation_log`** row; deletes are soft
(`deleted_at`); `extracts are independent scheduled elements, not highlights`.

Read first:
- [`../domain-model.md`](../domain-model.md) — "Relationships & lineage", "Document/editor
  rules", "Operation-log-shaped mutations".
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — the **attention** vs
  **FSRS** split; an extract is an *attention* item (`source`/`topic`/`extract`), never FSRS.
- [`../design-system.md`](../design-system.md) — `sel-toolbar`, reading marks
  (`.hl`/`.extracted`/`.dimmed`), `LineageTree`, `Pipeline`, `SchedulerChip`, `Stage`.
- [`../../CLAUDE.md`](../../CLAUDE.md) — "Document/editor rules" + the extraction storage
  checklist + "Architectural rules" + "Electron runtime & security".
- Design kit (immutable reference): `design/kit/app/screen-reader.jsx` (the `SelToolbar` +
  `READING` marks + reader inspector), `design/kit/app/screen-builder.jsx` (extract distill
  + `LineageTree` + `Pipeline` + stage stepper), `design/kit/app/components.jsx`
  (`LineageTree`, `Pipeline`, `SchedulerChip`, `Stage`, `TypeIcon`), and the screenshots
  `design/kit/screenshots/reader.png`, `builder.png`.

### What already exists (inspect before building)

The earlier milestones built more of M4's substrate than the roadmap implies — confirm and
reuse, do not duplicate:

- **Schema (T006) — already present, no new tables needed for M4's core:**
  - `document_marks` (`packages/db/src/schema/documents.ts`): `id`, `documentId`, `blockId`,
    `markType`, `range` (JSON `[start,end]`), `attrs` (JSON). Provisioned for
    `highlight`/`extracted_span`/`processed_span`/`cloze` — used by T019/T020/T021/T026.
  - `source_locations` (`packages/db/src/schema/sources.ts`): `elementId`, `sourceElementId`,
    `blockIds` (JSON array), `startOffset`, `endOffset`, `page`, `timestampMs`, `label`,
    `selectedText` — used by T021/T022/T025.
  - `element_relations` (`packages/db/src/schema/relations.ts`): typed edges incl.
    `derived_from` (`RELATION_TYPES` in `packages/core/src/enums.ts`) — used by T021/T025/T023.
- **Repositories (T008) — already present:**
  - `SourceRepository.createExtract(CreateExtractInput): ExtractWithLocation` already creates
    an `extract` element + a `source_locations` row in one transaction and logs
    `create_extract` (`packages/local-db/src/source-repository.ts`). It accepts an explicit
    `parentId` (the sub-extract path for T025) and defaults it to `sourceElementId`.
  - `SourceRepository.findLocationForElement` / `listLocationsForSource` / `findLocationById`
    (T022's read side).
  - `ElementRepository.addRelation` / `removeRelation` / `listRelationsFrom` (`derived_from`,
    T021/T023), `update` / `reschedule` (T024 stage/reschedule), `listChildren` / `listBySource`
    (T023), soft-delete (T024 delete).
- **Inspector (T010) — already present:** `apps/web/src/components/inspector/Inspector.tsx`
  renders `parent` / `children` / `source` / `location` via a `LineageRow` + `.tree`, fed by
  `InspectorQuery` (`packages/local-db/src/inspector-query.ts`) through `inspector.get`. T023
  upgrades this from flat rows to the full `LineageTree`.

### What M4 must add (the gaps)

- **`packages/editor` is still a placeholder** (`packages/editor/src/index.ts` exports only
  `editorPlaceholder`). M3 (T015) adds Tiptap; M4 adds the **selection toolbar**, **highlight
  mark**, **extracted-span mark**, and **processed-span mark** extensions/commands here.
- **No `window.appApi` surface for marks or extraction yet** — the contract
  (`apps/desktop/src/shared/contract.ts`), channels (`apps/desktop/src/shared/channels.ts`),
  preload, IPC router, `DbService`, and the renderer client (`apps/web/src/lib/appApi.ts`)
  expose only `app`/`db`/`settings`/`inspector`. M4 adds `extractions.*`, `documents.marks.*`,
  and `extracts.*` (review actions) commands.
- **No `ExtractionService`** — the index doc comment names one; T021 creates it in
  `packages/local-db/src/extraction-service.ts` to compose `SourceRepository` +
  `ElementRepository` + `DocumentRepository` for the full extraction transaction.
- **No `MarkType` enum in `packages/core`** — T019/T020 add the canonical
  `["highlight","extracted_span","processed_span","cloze"]` tuple matching the schema docs.

> **Operation-log discipline (read before adding any op).** `OPERATION_TYPES`
> (`packages/core/src/operation-log.ts`) is a **closed, fixed set of 15** — "a rename is a
> migration." M4 mutations map onto the existing ops, no new op types: extraction →
> `create_extract` (+ `create_element`, optionally `add_relation`); highlight/processed-span
> mark add/remove → **`update_document`** (marks are part of the document body); stage
> transitions / reschedule → `update_element` + `reschedule_element`; extract delete →
> `soft_delete_element`. Do **not** invent `add_mark`/`mark_processed` op types in M4.

Build order is the task order. T019 → T026 each depend on the prior reader/extraction
plumbing as noted; T019 and T020 can land together (both editor-mark work). **T026 is
specced here for the next run** (the current run builds T019–T025).

---

## T019 — Text-selection toolbar

- **Status:** `[ ]`  · **Depends on:** T018
- **Roadmap line:** Done when: selecting text in the reader shows an inline toolbar
  (Extract, Cloze, Highlight, Copy, Cancel) without breaking editor selection.

### Goal

In the source reader, selecting any run of text pops a floating inline toolbar anchored above
the selection offering **Extract**, **Cloze**, **Highlight**, **Copy**, and **Cancel** — the
single entry point to every M4 action. Opening, using, or dismissing the toolbar must never
collapse or corrupt the live ProseMirror selection.

### Context to load first

- Reference: `design-system.md` (`sel-toolbar`, reading marks); `CLAUDE.md` "UX rules"
  (keyboard-first), "Document/editor rules".
- Existing code to inspect: `design/kit/app/screen-reader.jsx` (`SelToolbar`, `onMouseUp`,
  `clearSel`, the `E`/`C`/`H` keydown handler) — the canonical pattern to rebuild in our
  Tiptap reader; the M3 reader route/component for `/source/$id`; `packages/editor`;
  `apps/web/src/shell/Kbd.tsx`; `design/kit/styles/app.css` for `.sel-toolbar`/`.sel-tool`.
- Invariants in play: the renderer holds only UI/selection state — no SQL, no lineage logic;
  the toolbar is presentational and delegates each action to the T020/T021 commands.

### Deliverables

- [ ] A `SelectionToolbar` React component in `apps/web` (e.g.
      `apps/web/src/reader/SelectionToolbar.tsx`) matching `design/kit/app/screen-reader.jsx`
      `SelToolbar` pixel-for-pixel: `Extract` (accent, `Kbd E`), `Cloze` (`Kbd C`),
      `Highlight` (`Kbd H`), `Copy`, `Cancel`; `lucide-react` icons per
      `design/icon-map.md`. Position `fixed` above the selection bounding rect with
      `transform: translate(-50%,-100%)`, using the design `--sel-*`/`.sel-toolbar` tokens.
- [ ] A `useTextSelection` hook (e.g. `apps/web/src/reader/useTextSelection.ts`) that, from a
      ProseMirror selection inside the reader, computes: the selected text, the anchor rect,
      and the **resolved location** (ordered list of stable block IDs spanned + start/end
      character offsets within first/last block). Reuse the stable-block-ID mapping from M3
      (T016) so the offsets line up with `document_blocks.stableBlockId`.
- [ ] `onMouseDown={(e) => e.preventDefault()}` on the toolbar (as in the prototype) so
      clicking a button **does not** clear the selection; `Cancel`/`Escape` and clicking
      elsewhere dismiss it without mutating the document.
- [ ] Keyboard handling while the toolbar is open: `E` → extract, `C` → cloze, `H` →
      highlight, `Escape` → cancel (mirror the prototype's `onKey`); ignore when no selection.
- [ ] Wire the buttons to **stub callbacks** for now (`onExtract`/`onCloze`/`onHighlight`/
      `onCopy`); T020 wires Highlight, T021 wires Extract, M6 (T033/T034) wires the card
      builder for Cloze. `Copy` writes the selection to the clipboard (renderer-side, no IPC).
- [ ] Unit/component test (Vitest + Testing Library) that a selection of ≥3 chars shows the
      toolbar with all five actions, `Escape` hides it, and the resolved location (block IDs +
      offsets) is computed correctly for a single-block and a cross-block selection.

### Done when

- Selecting text in the reader shows the inline toolbar with Extract / Cloze / Highlight /
  Copy / Cancel, matching the design kit; using or dismissing it leaves the ProseMirror
  selection and document intact (no surround/mutation happens on mere selection).
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks

- The prototype uses `range.surroundContents` on raw DOM — **do not** do that in our app;
  marks are applied through Tiptap commands (T020/T021), not DOM surgery, so undo/serialize
  stay correct.
- Cross-node selections must still resolve a multi-block location (the prototype skips DOM
  styling on cross-node selects, but our `useTextSelection` must still return all spanned
  block IDs for extraction).
- This task ships no persistence; it is the UI seam. Keep all domain logic out of the
  component (see "Architectural rules").

---

## T020 — Highlights

- **Status:** `[ ]`  · **Depends on:** T019
- **Roadmap line:** Done when: highlight marks persist as document annotations and can be
  removed (highlights are NOT extracts).

### Goal

The Highlight toolbar action applies a persistent **highlight** annotation over the selected
text, stored as a `document_marks` row on the source document, surviving save + app restart,
and removable (toggle off / clear). A highlight is a lightweight reading annotation — it
creates **no** element, **no** schedule, and **no** lineage.

### Context to load first

- Reference: `domain-model.md` "Document/editor rules" (marks: highlight / extracted-span /
  processed-span / cloze); `design-system.md` reading marks (`.hl`).
- Existing code to inspect: `packages/db/src/schema/documents.ts` (`document_marks`);
  `packages/local-db/src/document-repository.ts` (has no mark methods yet — add them);
  `packages/core/src/operation-log.ts` (`update_document` is the op for body+mark changes);
  `design/kit/app/screen-reader.jsx` (the `.hl` mark render).
- Invariants in play: highlights are annotations, not elements; mark mutations are logged
  under `update_document` (no new op type — see the milestone op-log note).

### Deliverables

- [ ] `MarkType` enum in `packages/core` (e.g. add to `packages/core/src/enums.ts`):
      `["highlight","extracted_span","processed_span","cloze"]` matching the schema doc, with
      a derived `MarkType` union, plus a doc comment citing the document/editor invariant.
- [ ] A Tiptap **highlight mark** extension in `packages/editor` (e.g.
      `packages/editor/src/marks/highlight.ts`) rendering `<mark class="hl">`, with
      add/toggle/remove commands; export from `packages/editor/src/index.ts`.
- [ ] `DocumentRepository` mark methods in `packages/local-db/src/document-repository.ts`:
      `addMark({ elementId, blockId, markType, range, attrs? })`,
      `removeMark(markId)` / `removeMarksForRange(...)`, and `listMarks(elementId)` /
      `listMarksByType(elementId, markType)` — each mutation in one transaction that appends
      an **`update_document`** op (payload records the mark add/remove). IDs minted via
      `newRowId()`.
- [ ] New `window.appApi` surface `documents.marks.add` / `documents.marks.remove` /
      `documents.marks.list`: add channels (`apps/desktop/src/shared/channels.ts`), Zod
      request schemas + response types (`apps/desktop/src/shared/contract.ts`), preload
      methods (`apps/desktop/src/preload/index.ts`), validated IPC handlers
      (`apps/desktop/src/main/ipc.ts`), `DbService` methods
      (`apps/desktop/src/main/db-service.ts`), and the renderer client + mirrored types
      (`apps/web/src/lib/appApi.ts`). Validate `markType` against the `MarkType` enum on the
      main side.
- [ ] Reader wiring: the Highlight action calls `documents.marks.add` with the resolved
      block ID(s) + range; existing highlights load from `documents.marks.list` and render as
      `.hl`; clicking a highlight (or re-selecting + Highlight) removes it.
- [ ] Tests: a repository test (Vitest against in-memory `better-sqlite3` via
      `packages/local-db/src/test-db.ts`) that add/list/remove round-trips a highlight and
      appends an `update_document` op and **creates no `elements` row**; an editor unit test
      for the mark extension's toggle.

### Done when

- A highlight applied in the reader persists as a `document_marks` row, reloads on reopen and
  after **app restart**, and can be removed; no `extract`/`element` is created by highlighting.
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass; the highlight round-trip survives restart.

### Notes / risks

- Ranges are per **stable block ID** (`[start,end]` JSON in `document_marks.range`) so marks
  re-anchor after re-import — never store absolute ProseMirror document positions.
- Keep highlight strictly separate from `extracted_span` (T021) and `processed_span` (T026):
  same table, different `markType`, different semantics.
- Do not add an `add_mark` op type — log under `update_document` (closed op set).

---

## T021 — Extraction (the keystone)

- **Status:** `[ ]`  · **Depends on:** T019, T008
- **Roadmap line:** Done when: Extract creates a child `extract` element with its own document
  body, source reference, parent link, source location, inherited priority, and scheduled
  review state; the parent text is visually marked extracted.

### Goal

The Extract toolbar action lifts the selected text into a new, **independent, scheduled**
`extract` element — a first-class child of the source, not a highlight. In one transaction it
creates the extract `elements` row (its own `documents` body seeded from the selected text),
records the precise `source_locations` anchor (block IDs + offsets + verbatim snapshot +
human label), links it to its source/parent (`source_id`, `parent_id`, and a `derived_from`
`element_relations` edge), inherits the source's **priority/concepts/tags**, gives it a
**due date on the attention scheduler** (never FSRS), and marks the parent text
`extracted_span`. The whole thing appends the right `operation_log` entries.

### Context to load first

- Reference: `CLAUDE.md` "Document/editor rules" — the extraction storage checklist (parent
  element ID, source element ID, source block IDs, offsets, selected-text snapshot, inherited
  metadata); `scheduling-and-priority.md` — extracts are **attention** items, default
  `raw_extract` returns in `+1..+7 days`; `domain-model.md` "Relationships & lineage".
- Existing code to inspect: `packages/local-db/src/source-repository.ts`
  (`createExtract` / `CreateExtractInput` / `ExtractWithLocation` — already built; reuse it),
  `packages/local-db/src/element-repository.ts` (`addRelation`, `reschedule`, tag/relation
  helpers), `packages/local-db/src/document-repository.ts` (`upsert` to seed the extract body),
  `packages/core/src/operation-log.ts` (`create_extract`, `create_element`, `add_relation`,
  `reschedule_element`), `design/kit/app/screen-reader.jsx` (`.extracted` mark + the reader
  inspector's "Extracts from this source").
- Invariants in play: **extracts are independent scheduled elements, not highlights**;
  lineage is sacred; the whole mutation is one transaction; the renderer never touches SQL.

### Deliverables

- [ ] **`ExtractionService`** in `packages/local-db/src/extraction-service.ts` composing
      `SourceRepository`, `ElementRepository`, and `DocumentRepository` to perform the full
      extraction in **one transaction**:
      1. create the `extract` element (status `pending`, stage `raw_extract`) +
         `source_locations` row via `SourceRepository.createExtract` (logs `create_element` +
         `create_extract`);
      2. seed the extract's `documents` body + blocks from the selected text via
         `DocumentRepository.upsert` (logs `update_document`);
      3. add a `derived_from` `element_relations` edge extract → source/parent via
         `ElementRepository.addRelation` (logs `add_relation`);
      4. **inherit** the source's priority (already passed in), and copy its concept/tag
         memberships onto the extract;
      5. set the initial **attention** `due_at` (e.g. `+1..+7 days` per the `raw_extract`
         heuristic) via `ElementRepository.reschedule` (logs `reschedule_element`) — set
         `status` to `scheduled` accordingly;
      6. add an `extracted_span` `document_marks` row on the **parent/source** document over
         the selected range (logged under `update_document`).
      **Atomicity (required — do not leave implicit):** all six steps plus their
      `operation_log` appends must commit in a **single** transaction; a throw anywhere rolls
      back the *entire* extraction (no orphan element / location / relation / mark / log rows).
      Because each existing repo method (`SourceRepository.createExtract`,
      `DocumentRepository.upsert`, `ElementRepository.addRelation`/`reschedule`, `addMark`)
      opens its **own** top-level `db.transaction`, `ExtractionService` must compose them in one
      of two ways: **(preferred)** add tx-composable `*Within(tx, …)` variants mirroring the
      existing `ElementRepository.createWithin(tx, …)` + `OperationLogRepository.append(tx, …)`
      seams (the same pattern T013 prescribes via `SourceRepository.createWithDocument`), and
      call them inside one `ExtractionService` `db.transaction`; **or** wrap the existing
      methods in an outer `db.transaction` relying on better-sqlite3 SAVEPOINT nesting (inner
      `transaction()` calls become savepoints that roll back with the outer). Never append an
      `operation_log` row in a transaction separate from the mutation it records.
      Export the service from `packages/local-db/src/index.ts`.
- [ ] New `window.appApi` surface `extractions.create`: channel + Zod
      `ExtractionCreateRequestSchema` (`sourceElementId`, optional `parentId`, `selectedText`,
      `blockIds[]`, `startOffset`/`endOffset`, optional `label`/`page`/`title`/`priority`) +
      `ExtractionCreateResult` (the new extract summary + its location) across
      `channels.ts`, `contract.ts`, `preload/index.ts`, `ipc.ts`, `db-service.ts`, and the
      renderer client `apps/web/src/lib/appApi.ts`. The main side validates the payload and
      calls `ExtractionService`.
- [ ] Reader wiring: the Extract action calls `extractions.create` with the resolved
      location from `useTextSelection`; on success the source text shows the `.extracted` mark
      and the inspector's "Extracts from this source" list (re-using T010 inspector data)
      gains the new extract without a reload.
- [ ] Tests:
      - Vitest service test (in-memory DB): one `extractions.create` produces exactly one new
        `extract` element with correct `parent_id`/`source_id`, a `source_locations` row whose
        `blockIds`/offsets/`selectedText` match the selection, a `derived_from` relation, an
        inherited priority, a future `due_at` with `scheduler = attention`, an
        `extracted_span` mark on the parent, and `operation_log` rows
        `create_element` + `create_extract` + `update_document` + `add_relation` +
        `reschedule_element` — all committed atomically (assert a failure rolls everything back).
      - Assert the extract is **not** on FSRS (no `review_states` row created).
- [ ] **Playwright E2E (the milestone flow)** in `tests/electron/` (e.g.
      `tests/electron/extraction.spec.ts`): open a seeded source → select text → Extract →
      the parent shows `.extracted`, the extract appears in the inspector with its source
      location → **restart the Electron app** → the extract, its lineage, and the
      `extracted_span` mark are still there.

### Done when

- Extracting selected text creates an independent `extract` element with its own document
  body, `source_id` + `parent_id` + a `derived_from` relation, a `source_locations` anchor
  (block IDs + offsets + snapshot + label), inherited priority/concepts/tags, and a scheduled
  **attention** `due_at`; the parent text is visibly `extracted`-marked; all of it appends the
  expected `operation_log` rows in one transaction and **survives app restart**.
- The extract is NOT scheduled with FSRS (no `review_states` row).
- `pnpm typecheck`, `pnpm test`, and the extraction Playwright spec pass.

### Notes / risks

- `SourceRepository.createExtract` already exists — `ExtractionService` orchestrates it plus
  the body seed, relation, tag/concept inheritance, attention schedule, and parent mark.
  Don't reimplement the element+location insert.
- Concept/tag inheritance: copy the source's tags via `ElementRepository.addTag`; concept
  membership edges land properly with T041 — for M4 inherit tags + priority at minimum and
  leave a TODO for concept edges if concept assignment is not yet wired.
- The exact attention interval lives behind the scheduler (T028); for M4 use the
  `raw_extract` starter heuristic from `scheduling-and-priority.md` (a simple `+Nd` based on
  inherited priority is acceptable) and let T028 replace the formula.
- The card builder ("Cloze"/"Q&A") is **deferred to M6** (T033/T034); the Cloze toolbar
  action remains a stub or routes to a placeholder builder until then.

---

## T022 — Source locations

- **Status:** `[ ]`  · **Depends on:** T021
- **Roadmap line:** Done when: each extract stores source element ID, block IDs, start/end
  offsets, and a human-readable label; the user can jump from an extract back to the exact
  paragraph.

### Goal

Make extraction lineage **actionable**: every extract carries a stored, human-readable source
location, and from an extract (in the inspector or extract view) the user can "jump to source"
— opening the source reader scrolled to and flashing the exact originating paragraph (the
`design/kit/screenshots/v2-jump.png` behaviour).

### Context to load first

- Reference: `design-system.md` "actionable lineage (jump-to-source-location)";
  `domain-model.md` "Relationships & lineage".
- Existing code to inspect: `packages/local-db/src/source-repository.ts`
  (`findLocationForElement`, `listLocationsForSource`, `findLocationById` — read side already
  exists), `packages/local-db/src/inspector-query.ts` (already surfaces a `LocationSummary`
  via `inspector.get`), `apps/web/src/components/inspector/Inspector.tsx` (renders the
  `location` section with `selectedText` + `label`), `design/kit/app/screen-reader.jsx` (the
  `jumped` flash + `boxShadow`/`scrollIntoView` treatment on the `.extracted` block).
- Invariants in play: the location snapshot (`selectedText`, `blockIds`) must survive a source
  re-import; the renderer resolves a location to a scroll target only via stable block IDs.

### Deliverables

- [ ] A human-readable **label** is generated at extraction time (T021) and stored in
      `source_locations.label` (e.g. "¶4" / heading + paragraph index). Add a small label
      helper in `packages/local-db` (or `packages/core`) deriving the label from block
      order/heading context; backfill is unnecessary (M4 is the first writer).
- [ ] A `navigateToLocation` flow in the reader: given a `source_locations` row (block IDs +
      offsets), open `/source/$id` (TanStack Router) for the `sourceElementId`, scroll the
      first spanned stable block into view, and flash it (reuse the kit's `jumped` box-shadow +
      "Jumped to source · …" toast). If the renderer already has the location from
      `inspector.get`, no new IPC is required; otherwise add a thin `extractions.location`
      read command following the established `appApi` pattern.
- [ ] A "Jump to source" / "Open source location" affordance on the inspector's location
      section (`Inspector.tsx`) and on the extract view (T024), wired to `navigateToLocation`.
- [ ] Tests: a Vitest test that `findLocationForElement` returns the stored block IDs/offsets/
      label/snapshot for an extract; extend the **T021 Playwright spec** with a
      jump-back step (Extract → open the extract → Jump to source → the originating paragraph
      is scrolled into view and flashed) and assert it still works **after app restart**.

### Done when

- Each extract stores `source_element_id`, `block_ids`, `start/end` offsets, and a
  human-readable `label`; from an extract the user can jump back to the exact paragraph in the
  reader, and the jump target is correct after **app restart**.
- `pnpm typecheck`, `pnpm test`, and the (extended) jump-back Playwright spec pass.

### Notes / risks

- Resolve the scroll target by **stable block ID**, never by absolute position — that is what
  keeps jump-back correct after edits/re-imports.
- Page/timestamp locations (`page`, `timestampMs`) are stored already but only matter for PDF
  (M14) / media (M15) — leave them null for text sources; don't build paginated jump now.
- If the spanned block was edited/removed, fall back to the nearest surviving block and still
  show the stored `selectedText` snapshot so lineage is never a dead end.

---

## T023 — Element hierarchy view

- **Status:** `[ ]`  · **Depends on:** T021, T010
- **Roadmap line:** Done when: source pages show a tree of children (extracts/sub-extracts/
  cards) and extract pages show parent + children; navigation works both directions.

### Goal

Surface the full lineage as a navigable tree: a source shows its descendants
(`source → extract → sub-extract → card`), an extract shows its ancestors **and** descendants,
and clicking any node navigates to that element. This upgrades the inspector's flat
parent/children rows (T010) to the design kit's `LineageTree`.

### Context to load first

- Reference: `design-system.md` (`LineageTree` "navigable both ways", `Pipeline`);
  `domain-model.md` "Relationships & lineage".
- Existing code to inspect: `apps/web/src/components/inspector/Inspector.tsx` +
  `apps/web/src/components/inspector/primitives.tsx` (the current `LineageRow`/`.tree` and the
  selection mechanism), `packages/local-db/src/inspector-query.ts` (currently returns
  `parent` + direct `children` + `source`), `packages/local-db/src/element-repository.ts`
  (`listChildren`, `listBySource`, `listRelationsFrom`), `design/kit/app/components.jsx`
  (`LineageTree`, depth-indented `tree-row`/`tree-node`), `design/kit/app/screen-reader.jsx`
  + `screen-builder.jsx` (how `LineageTree` is fed with `{id,type,title,depth,meta}` nodes).
- Invariants in play: lineage is queryable in **both** directions; navigation routes through
  the existing selection state + `/source/$id`; the renderer reads the tree via `appApi`.

### Deliverables

- [ ] A `lineage` read query in `packages/local-db` (extend `inspector-query.ts` or add
      `lineage-query.ts`) that, for any element, returns the flattened, depth-tagged tree from
      the **lineage root** (`source`/`topic`) down through `extract → sub-extract → card`,
      using `sourceId`/`parentId` + `derived_from` relations. Shape per node:
      `{ id, type, title, stage|meta, depth }`, marking the active element.
- [ ] New `window.appApi` surface `lineage.get` (channel + Zod schema + preload + IPC handler
      + `DbService` method + renderer client), or extend `InspectorData` with a `lineage`
      field if cleaner — follow the existing `inspector.get` pattern exactly.
- [ ] A `LineageTree` React component in `apps/web` rebuilt from `design/kit/app/components.jsx`
      (depth-indented `tree-row`/`tree-node`, `TypeIcon`, active highlight, `meta` text),
      used in the inspector (replacing/augmenting the flat parent/children rows) on **source**,
      **extract**, and **sub-extract** pages. Clicking a node sets the selected element and
      navigates (to `/source/$id` for sources, to the extract view for extracts).
- [ ] Tests: a Vitest test that the lineage query returns the correct depth-ordered tree for a
      `source → extract → sub-extract → card` chain (from the T009 seed, which already contains
      this shape); a component test that clicking a node fires navigation/selection.

### Done when

- Source pages show the descendant tree (extracts / sub-extracts / cards); extract pages show
  parent + children; clicking any node navigates there, both up and down the chain — matching
  the `LineageTree` design.
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks

- The T009 seed already contains a `source → extract → sub-extract → Q&A/cloze card` chain —
  use it as the deterministic fixture for the tree test (no new seed needed).
- Card nodes appear in the tree but the card builder/review is M6/M7 — clicking a card node
  may select it in the inspector without a dedicated card screen yet.
- Don't duplicate lineage logic in the component — the tree is computed in `packages/local-db`
  and crosses IPC as flat nodes (the renderer only renders + navigates).

---

## T024 — Extract review mode

- **Status:** `[ ]`  · **Depends on:** T021
- **Roadmap line:** Done when: extracts appear as readable mini-topics with trim/rewrite/split/
  convert/postpone/done/delete; an extract can move raw → clean → atomic.

### Goal

An extract is a readable **mini-topic** the user processes over time. This task gives an
extract its own working view with the distillation actions — **trim**, **rewrite** (edit the
body), **split** (T025), **convert** (to a card, deferred to M6), **postpone**, **done**,
**delete** — and the **stage progression** `raw_extract → clean_extract → atomic_statement`,
each transition rescheduling the extract on the attention scheduler and logging the mutation.

### Context to load first

- Reference: `scheduling-and-priority.md` (the by-stage extract intervals: `raw_extract`
  `+1..7d`, `clean_extract` `+3..14d`, `atomic_statement` → convert now / `+1d`; rescheduling
  by action); `domain-model.md` distillation stages; `design-system.md` (`Pipeline`, `Stage`,
  stage stepper).
- Existing code to inspect: `design/kit/app/screen-builder.jsx` (the extract editor column:
  `textarea` body, stage stepper, `Pipeline`, Trim/Split/Sub-extract/Postpone/Delete buttons —
  the **left+center** columns are the extract review surface; the **right** card-builder column
  is M6), `packages/local-db/src/element-repository.ts` (`update` for stage, `reschedule`,
  `softDelete`), `packages/local-db/src/document-repository.ts` (`upsert` for rewrite),
  `packages/core/src/enums.ts` (`DISTILLATION_STAGES`).
- Invariants in play: stage (`raw_extract`/`clean_extract`/`atomic_statement`) is distinct
  from status; each action reschedules on the **attention** scheduler and logs an op; delete
  is **soft**.

### Deliverables

- [ ] An **Extract view** in `apps/web` (route or panel — reuse `/source/$id`-style routing or
      an extract route, e.g. `apps/web/src/reader/ExtractView.tsx`) rendering the extract body
      (editable), its `Stage`/`Pipeline`/`SchedulerChip` (attention), and the source-context +
      `LineageTree` from T023, matching the builder screen's left+center columns.
- [ ] Stage transitions: an "Advance stage" action (and stage stepper) moving
      `raw_extract → clean_extract → atomic_statement`, persisted via `ElementRepository.update`
      (`update_element`) and reschedule via `ElementRepository.reschedule`
      (`reschedule_element`) using the by-stage interval heuristic. Surface these through a new
      `extracts.*` `window.appApi` group (`extracts.updateStage`, `extracts.rewrite`,
      `extracts.postpone`, `extracts.markDone`, `extracts.delete`) added across the
      contract/channels/preload/ipc/db-service/renderer-client, each validated and transactional.
- [ ] Actions wired: **Trim** (whitespace/filler cleanup of the body → `documents.upsert`),
      **Rewrite** (edit + save body), **Postpone** (reschedule + increment a postpone counter),
      **Mark done** (status `done`), **Delete** (soft-delete). **Convert** opens the card
      builder — **stub/route to M6 placeholder** (T033/T034).
- [ ] Tests: Vitest tests for the stage-transition + reschedule (assert `raw → clean → atomic`
      updates `stage`, sets a new attention `due_at`, and logs `update_element` +
      `reschedule_element`), and for soft-delete (status `deleted`, `deleted_at` set, op
      logged, lineage rows intact). A component test that the stage stepper advances and
      "Convert" routes to the (placeholder) builder.

### Done when

- An extract opens as a readable mini-topic with trim / rewrite / split / convert / postpone /
  done / delete actions, and can be advanced `raw_extract → clean_extract → atomic_statement`,
  each transition rescheduling it on the attention scheduler and appending the right
  `operation_log` rows; state survives **app restart**.
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks

- **Split** is T025; **Convert to card** is M6 — wire the buttons but route convert to a
  placeholder until M6.
- Track the postpone count so the attention scheduler (T028) and stagnation analytics (T084)
  can use it; storing it now (e.g. via the reschedule op payload / a counter) avoids a later
  migration — store it where the scheduler can read it without schema churn.
- Stage transition does **not** create a card or touch FSRS; `atomic_statement` is "ready to
  become a card," not a card.

---

## T025 — Extract splitting (sub-extracts)

- **Status:** `[ ]`  · **Depends on:** T024, T022
- **Roadmap line:** Done when: selecting part of an extract creates a sub-extract with
  preserved lineage (source → extract → sub-extract).

### Goal

Within an extract's body, selecting a fragment and choosing **Sub-extract** / **Split**
creates a child `extract` whose parent is the current extract and whose lineage root is still
the original source — `source → extract → sub-extract` — reusing the exact T021 extraction
path so the sub-extract is also an independent, scheduled, source-anchored element.

### Context to load first

- Reference: `domain-model.md` "Relationships & lineage" (sub-extracts preserve the chain);
  `scheduling-and-priority.md` (sub-extracts are attention items like extracts).
- Existing code to inspect: `packages/local-db/src/extraction-service.ts` (T021 — pass an
  explicit `parentId`), `packages/local-db/src/source-repository.ts` (`createExtract` already
  accepts `parentId` distinct from `sourceElementId`), the T019 `SelectionToolbar` +
  `useTextSelection` (reused inside the extract body), `design/kit/app/screen-builder.jsx`
  (the "Split extract" / "Sub-extract" buttons + the `sub-extract` `LineageTree` node).
- Invariants in play: `source_id` of a sub-extract is the **original source**, `parent_id` is
  the **parent extract**; the `source_locations` row points into the parent extract's body;
  the chain stays navigable (T023).

### Deliverables

- [ ] Reuse the `SelectionToolbar`/`useTextSelection` inside the extract body so selecting text
      in an extract offers **Sub-extract** (and **Split** = sub-extract + optionally trim the
      remainder), calling `extractions.create` with `sourceElementId` = the original source and
      `parentId` = the current extract. No new service is needed — `ExtractionService` already
      threads `parentId` through `SourceRepository.createExtract`.
- [ ] The new sub-extract gets its own body, a `source_locations` row anchored in the **parent
      extract** (block IDs/offsets/snapshot), a `derived_from` relation sub-extract → parent
      extract, inherited priority/tags, and an attention schedule — same transaction + ops as
      T021.
- [ ] The parent extract's body shows the split fragment `extracted_span`-marked; the
      `LineageTree` (T023) shows the sub-extract at the correct depth under its parent.
- [ ] Tests: a Vitest test that splitting yields a sub-extract with `parent_id` = parent
      extract, `source_id` = original source, a `derived_from` edge to the parent, and a
      location into the parent; the T023 lineage query then returns
      `source → extract → sub-extract` at correct depths. Extend the Playwright extraction spec
      with a sub-extract step that **survives app restart**.

### Done when

- Selecting part of an extract creates a sub-extract whose lineage is
  `source → extract → sub-extract` (correct `source_id`/`parent_id` + `derived_from`), with its
  own body, source location, inherited priority/tags, and attention schedule; the chain is
  navigable (T023) and survives **app restart**.
- `pnpm typecheck`, `pnpm test`, and the (extended) Playwright spec pass.

### Notes / risks

- Reuse the T021 path verbatim (only `parentId` differs) — do **not** create a separate
  sub-extract code path; that is what guarantees identical lineage/scheduling/logging.
- The `source_locations.sourceElementId` for a sub-extract points into the **parent extract**
  (where the text was selected), while `elements.source_id` still points at the original
  source root — keep these two anchors distinct and correct.

---

## T026 — Mark processed on source text  _(historical; superseded by source block processing)_

- **Status:** `[x]`  · **Depends on:** T020
- **Roadmap line:** Done when: processed spans can be collapsed/dimmed so the user can hide
  processed text without deleting the archived source.

### Goal

After extracting/reading a passage, the user can mark it **processed** so it visually
collapses/dims (`.dimmed`) in the reader — decluttering long sources without deleting any
content. This was originally implemented as a removable `document_marks` annotation
(`processed_span`), then superseded by the 2026-06-07 source block processing system:
per-stable-block outcomes are now the durable source of truth, and `processed_span` is only a
visual projection or legacy annotation.

### Context to load first

- Reference: `domain-model.md` "Document/editor rules" (processed-span mark); `design-system.md`
  reading marks (`.dimmed`); `CLAUDE.md` "Data rules" (never silently destroy user data).
- Existing code to inspect: `design/kit/app/screen-reader.jsx` (`readpara` + `readpara__mark`
  toggle, the `.dimmed` class, `restore`/`check` icons), `packages/local-db/src/block-processing-service.ts`,
  `packages/local-db/src/block-processing-repository.ts`, `packages/editor/src/reader-decorations.ts`,
  and the typed `blockProcessing.*` app API surface.
- Invariants in play: processed/ignored/needs-later/extracted outcomes are durable block state,
  not deletion; extracted state follows live output lineage; stale-after-edit rows force
  re-evaluation after source text changes; all renderer behavior goes through typed APIs.

### Deliverables

- [x] Durable SQLite model for per-source-block processing outcomes plus optional output links.
- [x] Reader affordances for processed, ignored, needs-later, unread restore, and extracted-state
      protection, projected into the legacy visual controls where appropriate.
- [x] Reader filters for show all, hide processed, unresolved only, extracted only, and ignored hidden.
- [x] Source progress summaries for processed/terminal blocks, unresolved blocks, extracted yield,
      ignored ratio, and stale-after-edit rows.
- [x] Scheduler/source-yield/mark-done behavior uses durable block summaries rather than
      `processed_span` marks.
- [x] Tests cover repository/service behavior, renderer controls, typed APIs, IPC, scheduling,
      source-yield analytics, queue mark-done confirmation, and Electron restart persistence.

### Done when

- Source block outcomes survive app restart, drive reader filters/progress/scheduling/action
  gating, and can be restored or reconciled without changing the underlying source body.
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks

- `processed_span` is no longer the domain source of truth. Keep it only as a visual projection
  or compatibility mark where needed.
- "Collapse" can remain a reader filter/dimming mode; source progress and completion come from
  block-processing summaries, not from CSS or editor marks.

---

## Exit criteria for M4

- All of T019–T026 are `[x]` in [`../roadmap.md`](../roadmap.md) (T019–T025 this run; T026
  next run).
- The full distillation loop works end to end in the **Electron desktop app**: select text →
  Highlight (annotation) / Extract (independent scheduled child element) → distill an extract
  through `raw_extract → clean_extract → atomic_statement` → Sub-extract → (T026) mark
  processed — and the lineage `source → extract → sub-extract` plus all marks and locations
  **survive an app restart**.
- Extracts are **independent, attention-scheduled** elements (never FSRS), each with its own
  document body, a `source_locations` anchor (block IDs + offsets + snapshot + human label), a
  `derived_from` relation, and inherited priority/tags; jump-to-source lands on the exact
  paragraph.
- Every M4 mutation runs in **one transaction** and appends the correct existing
  `operation_log` op (`create_extract`/`create_element`/`add_relation`/`reschedule_element` for
  extraction; `update_document` for mark add/remove; `update_element`/`reschedule_element` for
  stage/postpone; `soft_delete_element` for delete) — **no new op types** were introduced.
- All new capabilities reach the renderer **only** through new typed `window.appApi` commands
  (`documents.marks.*`, `extractions.create`, `lineage.get`, `extracts.*`) with Zod-validated
  IPC; **no raw DB/filesystem access is exposed to the renderer**, and no generic `db.query`.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the M4 Playwright specs (extract → lineage →
  jump-back → restart) are green.

When M4 is complete, generate `tasks/M5-priority-scheduling-queue.md` from the roadmap before
starting T027.

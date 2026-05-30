# M6 — Cards (T032–T035)

Detailed, buildable specs for the sixth milestone. M6 closes the distillation loop's last
gap before review: it turns an `atomic_statement` extract (M4) into an **active-recall card**.
The keystone is the **card model + `CardService`** (T032) — a `card` element with its `cards`
side-table row (`kind`, `prompt`, `answer`, `cloze`), its `sourceLocationId` anchor, and a
sibling-group edge, created at stage `card_draft` in one transaction. Around it sit the two
authoring surfaces — **Q&A card creation** (T033) and **cloze card creation** (T034), the
RIGHT column of `design/kit/app/screen-builder.jsx` — and the **card-quality warnings** (T035)
that gate a `card_draft` before it can be activated.

After M6 the user can stand inside an extract, press **Convert to card**, author a Q&A or
cloze card with a live preview and a quality checklist, and have a real `card` element appear
in their collection — with full `card → extract → source location → source` lineage that
survives an app restart. **FSRS scheduling and the review session are M7** (T036–T040): M6
creates cards at `card_draft` and parks their `review_states` row at `dueAt = null`,
`fsrsState = "new"` (created but **not** due) so the card is authored, not yet in rotation.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md) and
the roadmap header): the React **renderer** (`apps/web`) never touches SQLite, Node, or the
filesystem. Every mutation flows React UI → typed client wrapper (`apps/web/src/lib/appApi.ts`)
→ preload bridge (`apps/desktop/src/preload/index.ts`) → validated IPC (Zod) on the main side
(`apps/desktop/src/main/ipc.ts`) → the `DbService` (`apps/desktop/src/main/db-service.ts`) →
`packages/local-db` repositories/services → SQLite + asset vault. Every meaningful mutation
runs in **one transaction** and appends an **`operation_log`** row; deletes are soft.

> **The two-scheduler split is the load-bearing invariant of this milestone** (see
> [`../scheduling-and-priority.md`](../scheduling-and-priority.md)). A **card** is the ONLY
> element type scheduled by **FSRS** (`ts-fsrs`, M7) — it answers *"can the user recall this?"*.
> An **extract** is an **attention** item (M5) — it answers *"should the user process this
> again?"* — and must **never** get a `review_states`/FSRS row. M6 creates the `review_states`
> row that M7's FSRS engine will own; it does **not** schedule the card (no FSRS math here) and
> it does **not** convert the originating extract into a card (the extract lives on as its own
> attention-scheduled element, and the new card is its child).

Read first:
- [`../domain-model.md`](../domain-model.md) — element types (`card`), the distillation stages
  `atomic_statement → card_draft → active_card → mature_card`, "Relationships & lineage"
  (`card → extract → source location → source`), and the core-tables list (`cards`,
  `review_states`, `element_relations`).
- [`../scheduling-and-priority.md`](../scheduling-and-priority.md) — the FSRS-vs-attention table;
  cards are FSRS-only; siblings (same extract/cloze group) must not appear back-to-back (M7).
- [`../../CLAUDE.md`](../../CLAUDE.md) — "Card-quality rules" (the full warn/prevent list),
  "Document/editor rules" (cloze marks), "Review rules" (sibling burying), "Architectural rules"
  (domain logic out of components — card-quality heuristics live in `packages/core`, NOT React).
- [`../design-system.md`](../design-system.md) — `screen-builder` → M6 (T032–T035); the
  `SchedulerChip` FSRS side, `qc` (card-quality checks), `cardprev`, `Pipeline`, `Stage`.
- Design kit (immutable reference): `design/kit/app/screen-builder.jsx` (the RIGHT card-builder
  column — `Cloze`/`Q&A` tabs, the `{{ }}` cloze text field, `cardprev` preview + reveal, the
  `QualityCheck`/`qc` checklist, the A/B/C/D priority chips, the FSRS `SchedulerChip`, and the
  "Create card" button) and the screenshot `design/kit/screenshots/builder.png`.

### What already exists (inspect before building — this milestone reuses a LOT)

Earlier milestones built most of M6's substrate. Confirm and reuse; do **not** duplicate:

- **Schema (T006) — already present, NO new card tables/columns needed:**
  - `cards` (`packages/db/src/schema/cards.ts`): `elementId` (PK, 1:1 with the `card`
    element), `kind` (`qa`/`cloze`, CHECK against `CARD_KINDS`), `prompt`, `answer`, `cloze`,
    and `sourceLocationId` (FK → `source_locations.id`). **This is the canonical card model —
    see the naming note below.**
  - `review_states` (same file): the FSRS state row, `fsrsState` defaulting to `"new"`,
    `dueAt` nullable. M6 creates this row but leaves it un-due.
  - `element_relations` (`packages/db/src/schema/relations.ts`): the `sibling_group` relation
    type + the `siblingGroupId` column — how Q&A/cloze siblings are grouped (NOT a column on
    `cards`).
  - `elements` (`packages/db/src/schema/elements.ts`): `parentId` (the originating extract),
    `sourceId` (lineage root), `stage`, `status`, `priority`, `dueAt`.
- **Enums (T005) — already present:** `CARD_KINDS = ["qa","cloze"]`, `MARK_TYPES` includes
  `"cloze"`, `DISTILLATION_STAGES` includes `card_draft`/`active_card`/`mature_card`,
  `RELATION_TYPES` includes `sibling_group`, `PRIORITY_LABEL_VALUE` (A/B/C/D → numeric) and
  `priorityFromLabel`/`priorityToLabel` (`packages/core/src/priority.ts`).
- **`ReviewRepository.createCard` (T008) — already built and used by the seed.**
  `packages/local-db/src/review-repository.ts` `createCard(CreateCardInput)` already creates the
  `card` `elements` row (type `card`, status `pending`, stage `card_draft`), the `cards` row
  (`kind`/`prompt`/`answer`/`cloze`/`sourceLocationId`), AND a `review_states` row
  (`fsrsState: "new"`), all in ONE transaction, logging `create_card`. The shared factories
  (`packages/testing/src/factories.ts`) already build a Q&A card + a cloze card from one extract
  and group them as siblings via `ElementRepository.addRelation({ relationType: "sibling_group",
  siblingGroupId })`. **T032's `CardService` composes this; it does not replace it.**
- **`ElementRepository` (T008):** `addRelation`/`addRelationWithin` (sibling group),
  `addTag`/`addTagWithin` (tag inheritance), `findById`, `update`/`updateWithin` (stage),
  `softDelete`, `listRelationsFrom`. `createWithin`/`*Within` are the tx-composable seams a
  `CardService` uses to do everything in one `db.transaction` (the same pattern
  `ExtractionService` / `ExtractService` use).
- **`SourceRepository` (T008):** `findLocationForElement(extractId)` returns the extract's
  `source_locations` row — the anchor a card inherits as `sourceLocationId` (so the card points
  at the exact source position, not just at the extract).
- **`InspectorQuery` (T010, `packages/local-db/src/inspector-query.ts`):** already renders the
  FSRS `SchedulerChip`, the `ReviewSummary`, and the `LocationSummary` for cards; `schedulerKindForType`
  returns `"fsrs"` for `card`. A new card shows correctly in the inspector with no inspector
  changes (its `review` summary reads the un-due `review_states` row).
- **`LineageQuery` (T023):** already flattens `source → extract → sub-extract → card`; a new card
  appears as a leaf node under its extract automatically.
- **`ExtractView` (T024, `apps/web/src/reader/ExtractView.tsx`):** the extract distillation
  workspace. Its **"Convert to card"** button currently toasts "Card builder lands in M6" and
  routes to `/review` (a placeholder, line ~256). M6 replaces that placeholder with the real
  card-builder surface and wires the **Cloze** selection-toolbar action (currently
  `toast("Cloze lands in M6")`, line ~329).
- **`packages/editor` marks:** `marks/highlight.ts` is the template for a Tiptap mark; the
  generic `reader-decorations` / mark plumbing exists. **No cloze mark exists yet** — T034 adds
  `marks/cloze.ts` (the editor index comment names "cloze marks" as still-to-land).
- **The `appApi` contract pattern:** channels (`apps/desktop/src/shared/channels.ts`), Zod
  request schemas + response types (`apps/desktop/src/shared/contract.ts`), preload methods
  (`apps/desktop/src/preload/index.ts`), validated IPC handlers (`apps/desktop/src/main/ipc.ts`),
  `DbService` methods (`apps/desktop/src/main/db-service.ts`), and the renderer client
  (`apps/web/src/lib/appApi.ts`). M6 adds a `cards.*` group following the `extractions.*`/
  `extracts.*` precedent EXACTLY.

> **Roadmap-vs-schema naming (ambiguity resolved here).** The roadmap names the card columns
> `card_type` / `cloze_text` / `source_extract_id` / `sibling_group_id`. The **schema is the
> authority** and already ships the equivalent fields under their real names — **do not add new
> columns and do not write a migration for the card model:**
>
> | Roadmap name        | Real storage (T006, already present)                                              |
> |---------------------|-----------------------------------------------------------------------------------|
> | `card_type`         | `cards.kind` (`qa` \| `cloze`, CHECK against `CARD_KINDS`)                         |
> | `prompt` / `answer` | `cards.prompt` / `cards.answer`                                                   |
> | `cloze_text`        | `cards.cloze` (the `{{c1::answer}}` text)                                          |
> | `source_extract_id` | `elements.parentId` (the originating extract) **+** `cards.sourceLocationId` (the inherited source anchor) — the two together preserve `card → extract → source location → source` lineage |
> | `sibling_group_id`  | `element_relations.siblingGroupId` on a `sibling_group` edge (NOT a `cards` column) |
>
> The **structured cloze metadata** T034 stores (cloze count, ordered `c1..cN` index → answer
> spans) lives in `document_marks` (`markType: "cloze"`, T034) — keyed by stable block id —
> **not** in a new `cards` column. If, while building, a field genuinely cannot be expressed in
> the existing schema, ship a Drizzle migration (`pnpm db:generate`) per the Definition of Done —
> but the milestone is designed so none is required.

> **Operation-log discipline (read before adding any op).** `OPERATION_TYPES`
> (`packages/core/src/operation-log.ts`) is a **closed, fixed set of 15**. M6 mutations map onto
> existing ops, **no new op types**: card creation → **`create_card`** (already logged by
> `ReviewRepository.createCard`; the sibling edge adds `add_relation`, tag inheritance adds
> `add_tag`); editing a draft card's prompt/answer/cloze body → `update_element` (+ a small
> `cards`-row update inside the same tx; see T033/T034 note); activating a draft (`card_draft →
> active_card`, M7 boundary) → `update_element`. Do **not** invent `create_qa`/`create_cloze`/
> `activate_card` op types.

Build order is the task order. T032 is the keystone (model + service + `cards.create`); T033 and
T034 are the two authoring surfaces and can land together (both build on T032 and share the
builder UI + `cards.create`); T035 gates them. T032/T033/T034 depend on M4's T024 (the extract
review surface the builder opens from) and T008.

---

## T032 — Card model & templates

- **Status:** `[ ]`  · **Depends on:** T008, T005
- **Roadmap line:** Done when: `card` elements have `card_type`, `prompt`, `answer`, `cloze_text`,
  `source_extract_id`, `sibling_group_id`; Q&A and cloze types exist as first-class elements with
  parents, priority, and review state.

### Goal

A `card` is a first-class element with everything needed to author and (later) review it: a
`cards` side-table row carrying its `kind` (`qa`/`cloze`), `prompt`/`answer`/`cloze` text, and
its `sourceLocationId` anchor; a `parentId` to the originating extract and a `sourceId` to the
lineage root; an inherited numeric priority; a `review_states` row (created but un-due); and,
when it has siblings, a `sibling_group` relation linking them. This task introduces a
**`CardService`** in `packages/local-db` that creates a card from an extract in **one
transaction** — composing the existing `ReviewRepository.createCard`, sibling grouping, the
source-anchor inheritance, and tag/priority inheritance — and exposes it on the bridge as
`cards.create`. No FSRS math, no review UI yet.

### Context to load first

- Reference: `domain-model.md` (`card` element + `card_draft` stage + lineage); `CLAUDE.md`
  "Core domain invariants" + "Architectural rules" (services compose repositories);
  `scheduling-and-priority.md` (cards are FSRS-only — but FSRS is M7).
- Existing code to inspect: `packages/local-db/src/review-repository.ts` (`createCard` /
  `CreateCardInput` / `CardWithElement` — the transaction already exists, reuse it);
  `packages/local-db/src/element-repository.ts` (`addRelationWithin`, `addTagWithin`,
  `createWithin` — the tx-composable seams); `packages/local-db/src/source-repository.ts`
  (`findLocationForElement`); `packages/local-db/src/extraction-service.ts` +
  `extract-service.ts` (the service/`*Within` composition pattern to mirror);
  `packages/core/src/priority.ts` (`priorityFromLabel`); `packages/core/src/ids.ts`
  (`SiblingGroupId`) + `packages/local-db/src/ids.ts` (`newSiblingGroupId`);
  `packages/testing/src/factories.ts` (how the seed already creates + sibling-links two cards).
- Invariants in play: lineage is sacred (`card → extract → source location → source`); the whole
  creation is ONE transaction; the card starts `card_draft` and its `review_states` row is **not
  due** (no FSRS scheduling here); the renderer never touches SQL.

### Deliverables

- [ ] **`CardService`** in `packages/local-db/src/card-service.ts` composing `ReviewRepository`,
      `ElementRepository`, and `SourceRepository` to create a card from an extract in **one
      transaction**:
      1. resolve the originating extract via `ElementRepository.findById(extractId)`; derive the
         card's **lineage** from it — `parentId = extractId`, `sourceId = extract.sourceId ??
         extractId`, and `sourceLocationId = SourceRepository.findLocationForElement(extractId)?.id
         ?? null` (the card inherits the extract's exact source anchor → jump-to-source works in
         review, M7);
      2. inherit **priority** — default to the extract's numeric priority, overridable by an
         explicit A/B/C/D label (`priorityFromLabel`);
      3. create the card via `ReviewRepository.createCard({ kind, title, priority, prompt, answer,
         cloze, parentId, sourceId, sourceLocationId, stage: "card_draft" })` (logs
         `create_element` + `create_card`, and inserts the un-due `review_states` row);
      4. inherit the extract's **tags** onto the card (`ElementRepository.addTagWithin`, logs
         `add_tag` — mirrors `ExtractionService`'s tag inheritance);
      5. **sibling grouping:** if a `siblingGroupId` is supplied (subsequent cards from the same
         extract/cloze-set reuse it; the FIRST card from an extract mints a fresh one via
         `newSiblingGroupId`), add a `sibling_group` `element_relations` edge from the new card to
         the group via `ElementRepository.addRelationWithin` (logs `add_relation`). Return the
         `siblingGroupId` so the caller can group the next sibling.
      **Atomicity (required):** all four/five steps + their `operation_log` appends commit in ONE
      `db.transaction`; a throw rolls the whole card back (no orphan element/card/review-state/
      relation/tag rows). Because `ReviewRepository.createCard` currently opens its OWN top-level
      `db.transaction`, add a tx-composable `createCardWithin(tx, …)` seam on `ReviewRepository`
      (mirroring `SourceRepository.createExtractWithin` / `ElementRepository.createWithin`) and
      compose all steps inside one `CardService` transaction; never append an `operation_log` row
      in a transaction separate from the mutation it records. Export `CardService` (and any new
      input/result types) from `packages/local-db/src/index.ts`.
- [ ] **Confirm the `review_states` row is created but NOT due:** `card_draft` cards must not
      appear in any due query before activation. Verify `ReviewRepository.createCard` leaves
      `review_states.dueAt = null` + `fsrsState = "new"` (it does today). Add a doc comment on
      `CardService` stating the two-scheduler invariant: M6 authors the card and parks its FSRS
      state un-due; **M7 (T036)** owns the first FSRS schedule + the `card_draft → active_card`
      transition. Do NOT make a card "due" in M6.
- [ ] **New `window.appApi` surface `cards.create`** added across the six layers following the
      `extractions.create` precedent exactly:
      - channel `cardsCreate: "cards:create"` (`apps/desktop/src/shared/channels.ts`);
      - `CardsCreateRequestSchema` + `CardsCreateResult` (`apps/desktop/src/shared/contract.ts`) —
        request: `extractId` (ElementId), `kind` (`z.enum(CARD_KINDS)`), `prompt?`/`answer?`
        (Q&A), `cloze?` (cloze text), optional `title`, optional A/B/C/D `priority` override,
        optional `siblingGroupId` (to group with a prior sibling); result: a flat `CardSummary`
        (`id`, `type`, `status`, `stage`, numeric `priority`, `title`, `kind`, `sourceId`,
        `parentId`, `siblingGroupId`) + the inherited `sourceLocationId`. Validate that Q&A carries
        non-empty `prompt`+`answer` and cloze carries non-empty `cloze` (a coarse boundary check —
        the rich quality gate is T035);
      - preload method `cards.create` (`apps/desktop/src/preload/index.ts`);
      - validated IPC handler on `IPC_CHANNELS.cardsCreate` calling `DbService.createCard`
        (`apps/desktop/src/main/ipc.ts`);
      - `DbService.createCard(request)` mapping the A/B/C/D label → numeric priority and calling
        `CardService` (`apps/desktop/src/main/db-service.ts`);
      - the renderer client `cards.create` + mirrored request/result types + a thin
        `createCard(...)` helper (`apps/web/src/lib/appApi.ts`), and the `cards` group added to the
        `AppApi` interface in `contract.ts`.
- [ ] Tests:
      - Vitest `CardService` test (`packages/local-db/src/card-service.test.ts`, in-memory DB via
        `test-db.ts`): from a seeded extract, `cards.create` (Q&A) produces exactly one `card`
        element with `stage = "card_draft"`, `status = "pending"`, `parentId = extractId`,
        `sourceId = extract.sourceId`, a `cards` row with `kind = "qa"` + the prompt/answer + the
        inherited `sourceLocationId`, an un-due `review_states` row (`dueAt = null`,
        `fsrsState = "new"`), inherited tags, and `operation_log` rows `create_element` +
        `create_card` (+ `add_tag`). Assert a throw rolls everything back.
      - A second test: two cards created from one extract with the same `siblingGroupId` produce
        two `sibling_group` edges sharing that id; assert the cards are **not** FSRS-due (no card
        appears in a `dueAt <= now` query). Assert the extract is unchanged (still an attention
        item, still its own element — converting did NOT mutate the extract into a card).
      - A `contract.test.ts` case (`apps/desktop/src/shared/contract.test.ts`) that
        `CardsCreateRequestSchema` rejects a Q&A request with an empty `prompt`/`answer` and a
        cloze request with empty `cloze`.

### Done when

- A `card` element can be created from an extract with `kind` (`qa`/`cloze`), `prompt`/`answer`/
  `cloze`, an inherited `sourceLocationId`, `parentId` (extract) + `sourceId` (lineage root),
  inherited priority + tags, a `card_draft` stage, and an un-due `review_states` row — all in one
  transaction logging `create_card` (+ `add_relation` for siblings, `add_tag`) — through the typed
  `cards.create` command; the card survives **app restart** and appears in the inspector + lineage
  tree. The originating extract is unchanged (still attention-scheduled).
- The card is NOT FSRS-scheduled in M6 (its `review_states` row exists but is not due); FSRS lands
  in M7.
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks

- **No migration:** the card model is fully expressible in the T006 schema (see the naming table
  above). Adding a column or op type for this is a mistake.
- **Do not schedule the card.** Resist the temptation to compute a first FSRS interval — that is
  T036's job and forcing it here would entangle the two schedulers. M6 stops at "card authored,
  FSRS state initialized to `new`, not due."
- The first card from an extract mints a `siblingGroupId`; T033/T034 thread it so a Q&A + cloze
  pair (or multi-cloze set, T034) from the same extract are grouped. Sibling **burying** in review
  is M7 (T039) — M6 only records the grouping.
- A `synthesis_note`/`task`/`media_fragment` is NOT a card; `cards.create` only ever creates a
  `card` element with `kind ∈ CARD_KINDS`.

---

## T033 — Q&A card creation

- **Status:** `[ ]`  · **Depends on:** T032, T024
- **Roadmap line:** Done when: from an extract, "Create Q&A card" shows prompt/answer/source-context/
  preview; the card appears in review.

### Goal

From the extract distillation workspace (T024), the user opens the **card builder** and authors a
**Q&A** card: a `Front · question` field and a `Back · answer` field, with the source context
visible, a live `cardprev` preview (front ⇄ back reveal), the A/B/C/D priority chips, and the FSRS
`SchedulerChip`. Pressing **Create Q&A card** calls `cards.create` (T032) and the new card appears
in the collection (inspector + lineage tree) — and will appear in the review queue once FSRS lands
(M7). This is the RIGHT column of `design/kit/app/screen-builder.jsx`, Q&A tab.

### Context to load first

- Reference: `design-system.md` (`screen-builder` → M6; `cardprev`, `qc`, the FSRS `SchedulerChip`);
  `CLAUDE.md` "Card-quality rules" (minimum information — surfaced by T035); "Key screens" (the
  builder must fit "Extract Distillation & Card Builder").
- Existing code to inspect: `design/kit/app/screen-builder.jsx` (the RIGHT column: the `Cloze`/`Q&A`
  tabs, the Q&A `Front`/`Back` textareas, the `cardprev` preview + reveal `Btn`, the `qc` checklist,
  the A/B/C/D `chip`s, the `MetaRow` schedule block with the FSRS `sched--fsrs` chip, the
  `Create … card` `btn--block`); `apps/web/src/reader/ExtractView.tsx` (the "Convert to card"
  button at line ~256 and the Cloze toolbar action at ~329 — the entry points to replace);
  `apps/web/src/reader/extract-view.css` (the builder column styles to extend);
  `apps/web/src/components/inspector/primitives.tsx` (`Prio`, `SchedulerChip`, `Stage`);
  `apps/web/src/lib/appApi.ts` (the `cards.create` client from T032).
- Invariants in play: domain logic stays out of the component — the builder orchestrates UI state
  + IPC; lineage/priority inheritance happens main-side in `CardService`; the renderer only ships
  the authored fields + the `extractId`.

### Deliverables

- [ ] A **card-builder surface** in `apps/web` rebuilt from the `screen-builder.jsx` RIGHT column.
      Prefer a panel/component (e.g. `apps/web/src/reader/CardBuilder.tsx`) mounted as the THIRD
      column of `ExtractView` (so the builder's source-context + extract-distill columns are the
      same screen — matching the kit's `split3`), with the `Cloze`/`Q&A` tabs. The Q&A tab renders:
      a `Front · question` textarea, a `Back · answer` textarea, a `cardprev` preview that shows the
      front and toggles to the back on reveal, the A/B/C/D priority chips (default = the extract's
      label), the `qc` quality checklist (wired in T035; render the container now), the FSRS
      `SchedulerChip` (FSRS side — `brain`, `--sched-fsrs`; the schedule values are previews/`—`
      until M7), and a **Create Q&A card** `btn--block`.
- [ ] Wire the entry points in `ExtractView.tsx`: the **"Convert to card"** button opens the
      builder (replacing the `toast("Card builder lands in M6")` + `/review` placeholder), defaulting
      to the Q&A tab; the body of the builder is pre-seeded from the extract's text where sensible
      (e.g. the answer defaults to the extract body / atomic statement; the user edits both fields).
- [ ] On **Create Q&A card**: call `appApi.createCard({ extractId: id, kind: "qa", prompt, answer,
      priority, title? })`; on success toast "Q&A card created", refresh the inspector + lineage
      (`requestInspectorRefresh()` + `appApi.getLineage`) so the card appears under the extract, and
      leave the builder ready for another card (so a Q&A + cloze pair can be authored back-to-back —
      thread the returned `siblingGroupId` into the next create).
- [ ] Keyboard + a11y: the builder's preview reveal toggles on a key (mirror the kit's `Kbd ␣`);
      the Create button is the primary action. Keep the existing `ExtractView` selection-toolbar /
      sub-extract behavior intact.
- [ ] Tests:
      - A component test (Vitest + Testing Library, `apps/web/src/reader/CardBuilder.test.tsx`):
        the Q&A tab shows Front/Back fields + a preview; editing the front updates the preview;
        reveal toggles to the back; pressing Create calls the `cards.create` client with
        `{ kind: "qa", prompt, answer }`.
      - Extend the **Vitest service coverage** (or `db-service.test.ts`) so a Q&A `cards.create`
        round-trips end-to-end through `DbService` (label → numeric priority mapping correct).

### Done when

- From an extract, "Create Q&A card" shows the question, answer, source context, and a live
  preview; pressing Create persists a `qa` card via `cards.create` and the card appears in the
  inspector + lineage tree (and is review-ready for M7) and survives **app restart**, with lineage
  `card → extract → source location → source` intact.
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks

- "The card appears in review" is satisfied in M6 by the card existing as a `card_draft` element
  with an initialized (un-due) `review_states` row + correct lineage; the actual `/review` session
  + FSRS due-scheduling is **M7 (T037)**. Do not build the review session here.
- Keep the builder presentational: no SQL, no priority-numeric math, no lineage resolution in the
  component (all main-side in `CardService`). The renderer ships the authored strings + `extractId`.
- The "Image occlusion" tab in the kit is disabled/"Coming later" — keep it disabled (M15).

---

## T034 — Cloze card creation

- **Status:** `[ ]`  · **Depends on:** T032, T024
- **Roadmap line:** Done when: selecting text in an extract creates a cloze card linked to the
  extract; clozes store `{{c1::answer}}` text plus structured cloze metadata.

### Goal

The **Cloze** tab of the card builder turns extract text into a cloze-deletion card: the user wraps
phrases in cloze markers (or selects text in the extract body and presses **Cloze** to wrap the
selection), the `cardprev` shows each deletion as `[ … ]` with a reveal, and **Create cloze card**
persists a `cloze` card whose `cards.cloze` stores the canonical **`{{c1::answer}}`** text — plus
**structured cloze metadata** (the ordered `c1..cN` index → answer-span map) so a multi-cloze card
is unambiguous and re-renderable without re-parsing free text. Multiple clozes in one text are
supported (`{{c1::…}} {{c2::…}}`). The cloze deletion is also recorded on the card body as a `cloze`
`document_marks` annotation (the M4 mark infrastructure).

### Context to load first

- Reference: `CLAUDE.md` "Document/editor rules" (cloze is one of the four mark kinds; marks
  re-anchor by stable block id + range); `domain-model.md` (`cloze` in `MARK_TYPES`);
  `design-system.md` (`cardprev`, the `.cloze`/`.cloze--revealed` render).
- Existing code to inspect: `design/kit/app/screen-builder.jsx` — the Cloze tab: the
  `Cloze text · wrap answers in {{ }}` textarea, `renderCloze(txt, reveal)` (splits on
  `{{(.+?)}}`, renders `[ … ]` vs the answer), the `cardprev` + reveal `Btn`. Note the kit uses the
  simple `{{answer}}` form — **our canonical storage is the Anki-style `{{c1::answer}}`** (numbered)
  so multiple deletions and grouping are unambiguous; the renderer accepts both on input and
  normalizes to numbered form. `packages/core/src/enums.ts` (`MARK_TYPES` has `"cloze"`);
  `packages/editor/src/marks/highlight.ts` (the Tiptap mark template); `packages/editor/src/index.ts`
  (where to export the cloze mark); `apps/desktop/src/shared/contract.ts` `documents.marks.*`
  (T020 — the existing mark surface to reuse for the `cloze` mark; NO new mark IPC needed);
  `apps/web/src/reader/useTextSelection.ts` + `SelectionToolbar.tsx` (the Cloze action seam, reused
  inside the extract body in `ExtractView`).
- Invariants in play: cloze text is stored canonically; structured metadata makes multi-cloze
  unambiguous; the cloze `document_marks` row re-anchors by stable block id; lineage is preserved;
  the renderer never touches SQL.

### Deliverables

- [ ] **Cloze parsing/serialization helpers in `packages/core`** (framework-agnostic, e.g.
      `packages/core/src/cloze.ts`): parse `{{c1::answer}}`-style text into a structured model
      (`{ raw: string; deletions: { index: number; answer: string; start: number; end: number }[];
      clozeCount: number }`), serialize the model back to canonical numbered text, and a
      `renderClozePrompt(text, { revealIndex? })` helper that yields the prompt/answer spans the
      preview renders. Accept the kit's bare `{{answer}}` on input and normalize to `{{c1::…}}`
      (auto-number). **Unit-tested** (single cloze, multiple clozes, grouped `c1` repeats, malformed
      markers). This is the structured-metadata source of truth — NOT a new DB column.
- [ ] A **Tiptap cloze mark** in `packages/editor/src/marks/cloze.ts` (mirroring
      `marks/highlight.ts`) rendering `<span class="cloze">` with add/toggle/remove commands, plus
      `CLOZE_MARK_NAME`/`CLOZE_MARK_CLASS` constants; export it from `packages/editor/src/index.ts`.
      Selecting text in the extract body + pressing **Cloze** wraps the selection (applies the mark
      + inserts the numbered cloze marker into the builder's cloze text).
- [ ] **Cloze tab** of the `CardBuilder` (T033): the `Cloze text` textarea (seeded from the selected
      extract text with the selection wrapped as `{{c1::…}}`), the `cardprev` preview rendering each
      deletion as `[ … ]` and toggling to answers on reveal (via the core `renderClozePrompt`
      helper — not ad-hoc regex in the component), and the A/B/C/D priority chips + FSRS chip +
      `qc` checklist + **Create cloze card**.
- [ ] On **Create cloze card**: call `appApi.createCard({ extractId: id, kind: "cloze", cloze:
      canonicalClozeText, priority, title? })`; the main side stores `cards.cloze` = the canonical
      text. The **structured metadata** is derived deterministically from `cards.cloze` (the core
      `parseCloze` helper) on read, AND the cloze deletion spans are persisted as `cloze`
      `document_marks` on the card's body via the **existing** `documents.marks.add` command
      (`markType: "cloze"`, one mark per deletion, `attrs: { clozeIndex }`) — keyed by stable block
      id so they survive a re-render. No new card column, no new mark op (logged `update_document`).
- [ ] Wire the **Cloze** selection-toolbar action in `ExtractView.tsx` (currently
      `toast("Cloze lands in M6")`, line ~329) to open the builder on the Cloze tab with the
      selection pre-wrapped.
- [ ] Tests:
      - Vitest core test (`packages/core/src/cloze.test.ts`): parse/serialize round-trips for
        single, multiple, and grouped clozes; `clozeCount` correct; malformed markers handled.
      - Editor unit test for the cloze mark's toggle (`packages/editor/src/marks/cloze.test.ts`).
      - Vitest `CardService`/`db-service` test: a `cloze` `cards.create` stores `cards.cloze` =
        canonical text, creates the `cloze` card under the extract with inherited lineage, and (when
        the builder adds them) the `cloze` `document_marks` rows round-trip. Assert multi-cloze
        (`c1` + `c2`) yields `clozeCount = 2`.
      - Component test: the Cloze preview renders `[ … ]` for each deletion and reveals answers.

### Done when

- Selecting text in an extract (or wrapping `{{ }}` in the cloze field) creates a `cloze` card
  linked to the extract (`parentId`/`sourceId`/`sourceLocationId` inherited); `cards.cloze` stores
  the canonical `{{c1::answer}}` text and the structured cloze model (count + ordered index→answer
  spans) is derivable and stored as `cloze` `document_marks`; multiple clozes are supported; the
  card survives **app restart** with lineage intact.
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks

- **Structured metadata = `packages/core` parse of canonical text + `cloze` document_marks**, not a
  new `cards` column. `cards.cloze` (canonical numbered text) is the single source of truth; the
  parsed model + marks are deterministically derived from it. This avoids a migration and keeps the
  text editable.
- Grouped clozes (`{{c1::…}} … {{c1::…}}` — same index revealed together) are one logical deletion;
  the `clozeCount` is the number of distinct indices, which feeds T035's "multiple clozes" warning.
- Reuse the **existing** `documents.marks.*` surface (T020) for the `cloze` mark — do NOT add a new
  mark command or op; `cloze` is just another `markType` (closed op set → `update_document`).
- The card builder's cloze text is authored on the card; do not retro-write cloze markers into the
  source/extract body (that would corrupt the extract). The optional `cloze` `document_marks` are on
  the **card's** document body.

---

## T035 — Card-quality warnings

- **Status:** `[ ]`  · **Depends on:** T033, T034
- **Roadmap line:** Done when: warnings flag prompt-too-long, answer-too-long, missing source,
  multiple clozes, ambiguous pronouns, and empty answer before activation.

### Goal

Before a `card_draft` becomes an active card, the builder runs **card-quality heuristics** and
surfaces them as the `qc` checklist (`design/kit/app/screen-builder.jsx` `QualityCheck`): each
check is an `ok`/`warn` row with human text. The heuristics live as **pure domain functions in
`packages/core`** (NOT React, NOT the component) so they are unit-testable and reusable by later
analytics (M17 T086 extends this exact set). M6 covers: **prompt-too-long**, **answer-too-long**,
**missing source**, **multiple clozes** (more than one distinct deletion), **ambiguous pronouns**,
and **empty answer/prompt/cloze**. Warnings are advisory (they explain *why* a card is weak); a
hard-fail set (empty answer, no cloze deletion) blocks activation.

### Context to load first

- Reference: `CLAUDE.md` "Card-quality rules" (the full warn/prevent list — M6 ships the listed
  subset; the rest is M17 T086) and "Minimum information principle"; `design-system.md` (`qc`,
  `QualityCheck`).
- Existing code to inspect: `design/kit/app/screen-builder.jsx` lines ~26–36 (`checks` — the exact
  heuristics + thresholds the kit shows: cloze ≤ 2 deletions, Q&A front < 110 chars, back < 90
  chars, "Source attached"); `packages/core/src/index.ts` (where to export the new module);
  `packages/core/src/priority.ts` (the pure-helper + test pattern to mirror);
  `apps/web/src/reader/CardBuilder.tsx` (T033/T034 — where the `qc` checklist renders).
- Invariants in play: heuristics are domain functions, NOT component code (Architectural rules);
  warnings are surfaced before the `card_draft → active_card` activation; nothing destructive — a
  warning never deletes or blocks creation, only flags (the hard-fail subset blocks *activation*).

### Deliverables

- [ ] **Card-quality heuristics in `packages/core`** (e.g. `packages/core/src/card-quality.ts`):
      a pure `evaluateCardQuality(input): CardQualityReport` where `input` is a discriminated shape
      over `kind` (`qa`: `prompt`/`answer`; `cloze`: `cloze` text + parsed model from T034's
      `parseCloze`) plus `hasSource: boolean`. `CardQualityReport` is an ordered list of
      `{ id, severity: "ok" | "warn" | "block", message }` checks. The M6 check set:
      - **empty prompt / empty answer (Q&A)** and **no cloze deletion (cloze)** → `block` (the card
        cannot be activated until fixed);
      - **prompt-too-long** (Q&A front over the kit's ~110-char threshold) → `warn`;
      - **answer-too-long** (Q&A back over ~90 chars; or a giant cloze paragraph over a word
        threshold) → `warn`;
      - **multiple clozes** (more than one distinct deletion index) → `warn` ("split the card");
      - **ambiguous pronouns** (the prompt/answer leads with or hinges on a bare "it/this/that/they/
        these/those" with no antecedent — a simple, documented heuristic) → `warn`;
      - **missing source** (`hasSource === false`) → `warn`.
      Thresholds are exported named constants (so tests + the UI + M17 share them) with doc comments
      citing the minimum-information principle. Export from `packages/core/src/index.ts`.
- [ ] **`qc` checklist wiring** in `CardBuilder.tsx`: render `evaluateCardQuality(...)` live as the
      user edits (the `QualityCheck`/`qc` rows — `checkCircle` for ok, `warning` for warn/block,
      per the kit). The component **calls the core function**; it contains no heuristic logic.
- [ ] **Activation gate (the "before activation" clause):** the **Create card** action is allowed
      with warnings (warnings are advisory), but the report's `block`-severity checks (empty
      answer/prompt, no cloze deletion) disable the Create button (or surface a confirm). Since the
      `card_draft → active_card` *activation* transition itself lands with FSRS (M7 T036), document
      that the quality gate is the precondition M7's activation will also call — i.e. M6 ships the
      heuristics + the create-time gate; M7 reuses `evaluateCardQuality` at activation. Do NOT build
      the activation transition here beyond the create-button gate.
- [ ] Tests:
      - Vitest core test (`packages/core/src/card-quality.test.ts`): each check fires on the right
        input and stays silent otherwise — a clean short Q&A with a source returns all `ok`; an
        over-long prompt warns; an over-long/multi-fact answer warns; a 2-cloze text warns
        "multiple clozes"; an empty answer and a no-deletion cloze return a `block`; a missing source
        warns; the ambiguous-pronoun heuristic fires on "It increases this." and not on a clear
        sentence. Assert thresholds match the exported constants.
      - Component test: the `qc` checklist updates as fields change and the Create button is disabled
        while a `block` check is present.

### Done when

- The builder surfaces card-quality warnings (prompt-too-long, answer-too-long, missing source,
  multiple clozes, ambiguous pronouns, empty answer) as the `qc` checklist before a draft is
  activated, driven by pure `packages/core` heuristics with unit tests; `block`-severity checks
  prevent creating a hollow card.
- `pnpm typecheck`, `pnpm test`, `pnpm lint` pass.

### Notes / risks

- **Heuristics live in `packages/core`, never in the component** (the Architectural rule). The
  component renders the report; M17 (T086) extends the same `evaluateCardQuality` with more checks
  (multiple facts, long lists, similar-answer interference, outdated source) — design the report
  shape to grow.
- Keep heuristics cheap + deterministic (no NLP models) — "ambiguous pronoun" is a small documented
  rule, not a parser; false positives are acceptable as advisory `warn`s, but the `block` set must
  be precise (only truly empty/hollow cards).
- Warnings are advisory; the only hard block is the empty/hollow `block` set — never silently
  prevent or destroy user authoring.

---

## Milestone E2E (lands with T033/T034 + T035)

- [ ] **Playwright E2E** in `tests/electron/` (e.g. `tests/electron/cards.spec.ts`): open a seeded
      source → extract a fragment → open the extract → **Convert to card** → author a **Q&A** card
      and Create → author a **cloze** card (`{{c1::…}}`, multi-cloze) and Create → both cards appear
      in the inspector + lineage tree under the extract with correct `card → extract → source
      location → source` lineage and the FSRS `SchedulerChip` → trigger a quality warning
      (over-long prompt) and see the `qc` row → **restart the Electron app** → both cards, their
      lineage, their `kind`/prompt/answer/cloze text, and the sibling grouping are still there.

---

## Exit criteria for M6

- All of T032–T035 are `[x]` in [`../roadmap.md`](../roadmap.md).
- A user can stand inside an extract, **Convert to card**, and author a **Q&A** or **cloze** card
  in the **Electron desktop app** — with a live `cardprev`, A/B/C/D priority, the FSRS
  `SchedulerChip`, and a `qc` quality checklist — and the new `card` element persists with full
  `card → extract → source location → source` lineage that **survives an app restart**.
- The card model uses the **existing T006 schema** (`cards.kind`/`prompt`/`answer`/`cloze`/
  `sourceLocationId`, `elements.parentId`/`sourceId`, `element_relations.siblingGroupId`) — **no
  new card columns and no migration** were introduced; cloze structured metadata is the
  `packages/core` parse of canonical `{{c1::answer}}` text + `cloze` `document_marks`.
- The **two-scheduler split holds**: cards are created at `card_draft` with a `review_states` row
  that is initialized (`fsrsState = "new"`) but **not due** — M6 does **no** FSRS math and the
  originating extract is **never** converted into a card or given an FSRS row; FSRS scheduling +
  the `card_draft → active_card` activation are **M7 (T036–T040)**.
- Card-quality heuristics live as pure functions in `packages/core` (NOT React), unit-tested, and
  surface as the builder's `qc` checklist; `block`-severity checks prevent hollow cards.
- Every M6 mutation runs in **one transaction** and appends the correct **existing**
  `operation_log` op (`create_card` + `create_element` for card creation; `add_relation` for
  siblings; `add_tag` for tag inheritance; `update_document` for cloze marks) — **no new op types**.
- All new capabilities reach the renderer **only** through the new typed `window.appApi` `cards.*`
  command (+ the reused `documents.marks.*` for cloze marks) with Zod-validated IPC; **no raw
  DB/filesystem access is exposed to the renderer**, and no generic `db.query`.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and the M6 Playwright spec (extract → Q&A + cloze →
  lineage + quality warning → restart) are green.

When M6 is complete, generate `tasks/M7-fsrs-review.md` from the roadmap before starting T036.

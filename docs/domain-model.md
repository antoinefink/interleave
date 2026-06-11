# Domain model

The universal primitive is **`Element`**. Every source, topic, extract, card, task,
concept, media fragment, and synthesis note **is** an element or **belongs to** one. This
is the most important invariant in the codebase — do not introduce parallel object models.

## Element types

```txt
source           an imported article/book/paper/note/media
topic            a readable unit derived from a source (e.g. a chapter/section)
extract          a fragment lifted from a source/extract, independently scheduled
card             an active-recall item (Q&A or cloze)
task             a maintenance/verification action ("verify this claim")
concept          a hierarchical knowledge node used for organization
media_fragment   a timestamped/region clip (PDF region, video/audio clip, image)
synthesis_note   a writing/thinking note that collects linked extracts/cards
```

## Lifecycle statuses

```txt
inbox        captured but not yet accepted into learning
pending      accepted, awaiting first processing
active       currently in rotation
scheduled    has a future due date
done         exhausted/archived (value extracted)
parked       deliberately saved for later, visible in inventory but not scheduled
dismissed    intentionally set aside (not deleted)
suspended    temporarily out of scheduling (e.g. a leech card)
deleted      soft-deleted (recoverable via trash)
```

## Distillation stages

The stage tracks *where in the refinery* an element is. It is distinct from status.

```txt
raw_source        just imported
rough_topic       a source broken into a readable unit
raw_extract       freshly extracted, unedited
clean_extract     trimmed/contextualized
atomic_statement  a single self-contained idea, ready to become a card
card_draft        a card not yet activated/approved
active_card        a card in FSRS rotation
mature_card        a card with long stable intervals
synthesis         a higher-order note combining multiple elements
```

## Priority

Priority is first-class on every source, extract, card, and task. Stored **numerically**
(e.g. `0.000`–`1.000`, or 0–100), surfaced in the MVP UI as labels:

```txt
A = high value (want to remember)
B = useful
C = maybe / nice to have
D = low / background (skim or delete first under overload)
```

High-priority fragile memory is protected; low-priority topics are sacrificed first during
overload. Newly imported material must **not** automatically dominate older high-value
material. See [`scheduling-and-priority.md`](./scheduling-and-priority.md).

## Relationships & lineage

Lineage is sacred. A card must trace: `card → extract → source location → source metadata
→ original document context`. Relationships are explicit rows, not implicit nesting:

- `parent element ID` and `source element ID` on extracts/cards
- `element_relations` for typed edges (parent-child, derived-from, sibling-group, concept
  membership, references)
- `source_locations` for source positions (block IDs, offsets, page numbers, timestamps)

## Desktop & persistence types

Alongside the element-centric types (`Element`, `ElementType`, `ElementStatus`,
`DistillationStage`, `Priority`, `ReviewState`, `ReviewLog`, `Source`, `Document`,
`ElementRelation`, `ElementLocation`), `packages/core` defines the types that describe how
knowledge is stored durably on the desktop. SQLite is the canonical local database, the
filesystem is the canonical local asset vault, and these types are the bridge between them:

```txt
Asset             metadata for a large binary owned by an element (PDF, HTML snapshot,
                  image, audio, video, export): id, owning element ID, kind, MIME type,
                  size, content hash, timestamps. The bytes live in the vault, never in
                  SQLite.
AssetLocation     where an asset's bytes live in the vault: stable asset ID + relative
                  path (e.g. assets/sources/<source_id>/original.pdf), resolved to an
                  absolute path only by the Electron main/DB service.
LocalVaultPath    a relative, vault-rooted path resolved by Electron against the app data
                  directory (assets/, exports/, backups/). The renderer never sees or
                  resolves raw filesystem paths.
OperationLogEntry one command-shaped, logged mutation (create_element, update_element,
                  soft_delete_element, restore_element, create_source, update_document,
                  set_read_point, create_extract, create_card, add_review_log,
                  reschedule_element, add_relation, remove_relation, add_tag, remove_tag):
                  id, op type, payload, element ID, timestamp. Persisted in `operation_log`
                  from day one to support undo, audit, and incremental backup (not server-side
                  sync — the server, when it arrives, is an encrypted-backup target only).
```

## Core tables (Drizzle)

The canonical local store is **native SQLite** (`better-sqlite3` + Drizzle, SQLite dialect),
opened by the Electron main/DB service and reached only through the typed `window.appApi`
bridge — never by the renderer directly. Large assets (PDFs, HTML snapshots, images, media)
live on the **filesystem asset vault**, not in the database; SQLite stores their metadata,
hashes, relative paths, and owning element IDs. The later backup server (M11) stores only opaque
**end-to-end-encrypted archives** + minimal metadata (`users`, `devices`, `backup_manifests`);
it does **not** mirror these tables, and there is no live multi-device sync.

The initial M1 schema (defined in `packages/db`, generated/migrated with `drizzle-kit`):

```txt
elements          id, type, status, stage, priority, due_at, title, created_at,
                  updated_at, deleted_at, parent_id, source_id, ...
documents         element_id, prosemirror_json, plain_text, schema_version, ...
document_blocks   id, document_id, block_type, order, stable_block_id, ...
document_marks    id, document_id, block_id, mark_type, range, attrs, ...
sources           element_id, url, canonical_url, original_url, author, published_at,
                  accessed_at, snapshot_key, reason_added, read_point, status, ...
source_locations  id, element_id, source_element_id, block_ids[], start_offset,
                  end_offset, page, timestamp_ms, region, label, selected_text, ...
element_relations id, from_element_id, to_element_id, relation_type, sibling_group_id, ...
read_points       id, element_id, document_id, block_id, offset, updated_at, ...
cards             element_id, kind, prompt, answer, cloze, source_location_id, ...
review_states     element_id (card), due_at, stability, difficulty, elapsed_days,
                  scheduled_days, reps, lapses, fsrs_state, ...
review_logs       id, element_id, rating, reviewed_at, response_ms, prev/next state, ...
concepts          id, parent_concept_id, name, ...
tags              id, name
element_tags      element_id, tag_id
tasks             element_id, task_type, due_at, status, ...
assets            id, owning_element_id, kind, vault_root, relative_path, content_hash,
                  mime, size, width, height, duration_ms, created_at, ...
operation_log     id, op_type, payload, element_id, created_at, ...
settings          key, value
```

> Not every column exists from day one, but the MVP introduces these tables per the
> roadmap, and **`operation_log` exists from day one** — every meaningful mutation appends
> an entry so undo, audit, and incremental backup stay tractable (the server is backup-only —
> the op-log is never replayed into a server domain DB). FTS5
> tables (`source_fts`, `extract_fts`, `card_fts`) arrive with full-text search later.
> Stable UUID/ULID-style IDs are generated in domain services. **Any schema change ships
> with a Drizzle migration** (see Definition of Done in `CLAUDE.md`).

## Document/editor rules

ProseMirror documents are the substrate for lineage. When editing source documents,
preserve: **stable block IDs**, marks (highlight / extracted-span / processed-span /
cloze), source locations, parent-child relationships, read-points, and references.

When creating an extract, always store: parent element ID, source element ID, source block
IDs, start/end offsets when available, the selected-text snapshot, inherited source
metadata, and inherited concept/tags/priority where appropriate.

**Extracts are independent scheduled elements, not highlights.**

## Operation-log-shaped mutations

Every meaningful mutation is command-shaped and appended to the `operation_log` table
**from day one**: `create_element`, `update_element`, `soft_delete_element`,
`restore_element`, `create_source`, `update_document`, `set_read_point`, `create_extract`,
`create_card`, `add_review_log`, `reschedule_element`, `add_relation`, `remove_relation`,
`add_tag`, `remove_tag`. Mutations run as transactions in the Electron main/`packages/local-db`
layer and are exposed to the renderer only through typed `window.appApi` commands — the
renderer never issues SQL. We do not overbuild backup now; logging command-shaped mutations
keeps undo, audit, and **incremental backup** tractable (the server, when it arrives, is an
encrypted-backup target only — the op-log is never replayed into a server domain DB).
</content>

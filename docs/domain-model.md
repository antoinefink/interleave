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
- `element_locations` for source positions (block IDs, offsets, page numbers, timestamps)

## Core tables (Drizzle)

Local (PGlite) and server (PostgreSQL) share these. Server adds user/device/sync fields.

```txt
elements          id, type, status, stage, priority, due_at, title, created_at,
                  updated_at, deleted_at, parent_id, source_id, ...
documents         element_id, prosemirror_json, plain_text, schema_version, ...
sources           element_id, url, canonical_url, original_url, author, published_at,
                  accessed_at, snapshot_key, reason_added, read_point, status, ...
element_relations id, from_element_id, to_element_id, relation_type, sibling_group_id, ...
element_locations id, element_id, source_element_id, block_ids[], start_offset,
                  end_offset, page, timestamp_ms, region, label, selected_text, ...
review_states     element_id (card), due_at, stability, difficulty, elapsed_days,
                  scheduled_days, reps, lapses, fsrs_state, ...
review_logs       id, element_id, rating, reviewed_at, response_ms, prev/next state, ...
concepts          id, parent_concept_id, name, ...
tags              id, name
element_tags      element_id, tag_id
media_assets      id, element_id, kind, storage_key, mime, width, height, duration_ms, ...
tasks             element_id, task_type, due_at, status, ...
operation_log     id, op_type, payload, element_id, device_id, created_at, ...   (sync)
sync_cursors      device_id, last_op_id, ...                                     (sync)
settings          key, value
```

> Not every column exists from day one. The MVP introduces tables incrementally per the
> roadmap; gold-standard milestones add `operation_log`, `sync_cursors`, `media_assets`,
> and server-only fields. **Any schema change ships with a Drizzle migration** (see
> Definition of Done in `CLAUDE.md`).

## Document/editor rules

ProseMirror documents are the substrate for lineage. When editing source documents,
preserve: **stable block IDs**, marks (highlight / extracted-span / processed-span /
cloze), source locations, parent-child relationships, read-points, and references.

When creating an extract, always store: parent element ID, source element ID, source block
IDs, start/end offsets when available, the selected-text snapshot, inherited source
metadata, and inherited concept/tags/priority where appropriate.

**Extracts are independent scheduled elements, not highlights.**

## Operation-log-shaped mutations

Every important mutation is designed to become an operation-log entry: `create_element`,
`update_element`, `delete_element`, `create_extract`, `create_card`, `update_document`,
`set_read_point`, `add_review_log`, `reschedule_element`. This is true even in the MVP
(where the log may not be persisted yet) so the eventual sync layer is tractable.
</content>

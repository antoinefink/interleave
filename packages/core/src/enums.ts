/**
 * Core domain enums (T005).
 *
 * The string values here are the canonical vocabulary of the whole product and
 * MUST match `docs/domain-model.md` and `CLAUDE.md` exactly — no renames, no
 * casual additions. They are persisted verbatim in SQLite (`elements.type`,
 * `elements.status`, `elements.stage`) and travel through the operation log and
 * the eventual cloud sync, so a rename is a data migration, not a refactor.
 *
 * Each enum is expressed as a `const` tuple (the source of truth for runtime
 * validation/iteration) plus a derived union type (the compile-time vocabulary).
 */

/**
 * The eight core element types. `Element` is the universal primitive — every
 * source, topic, extract, card, task, concept, media fragment, and synthesis
 * note **is** an element of one of these types. Introducing a parallel object
 * model is forbidden (see the most important invariant in `domain-model.md`).
 */
export const ELEMENT_TYPES = [
  "source",
  "topic",
  "extract",
  "card",
  "task",
  "concept",
  "media_fragment",
  "synthesis_note",
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

/**
 * Lifecycle statuses. Status answers *"where in the workflow is this element?"*
 * and is deliberately distinct from {@link DistillationStage} (which answers
 * *"how refined is it?"*). `deleted` is a **soft** delete (recoverable via
 * trash) — user data is never silently destroyed.
 */
export const ELEMENT_STATUSES = [
  "inbox",
  "pending",
  "active",
  "scheduled",
  "done",
  "parked",
  "dismissed",
  "suspended",
  "deleted",
] as const;
export type ElementStatus = (typeof ELEMENT_STATUSES)[number];

/**
 * Distillation stages — *where in the refinery* an element sits, from a raw
 * import to a mature card or higher-order synthesis. This is INDEPENDENT of
 * {@link ElementStatus}: e.g. an element can be `active` (status) while still a
 * `raw_extract` (stage). Keeping the two axes separate is a load-bearing
 * invariant (see "stage vs status" in `domain-model.md`).
 */
export const DISTILLATION_STAGES = [
  "raw_source",
  "rough_topic",
  "raw_extract",
  "clean_extract",
  "atomic_statement",
  "card_draft",
  "active_card",
  "mature_card",
  "synthesis",
] as const;
export type DistillationStage = (typeof DISTILLATION_STAGES)[number];

/**
 * Typed edges between elements (`element_relations.relation_type`). Lineage is
 * sacred and modeled as explicit rows, not implicit nesting: `derived_from`
 * carries the extract→source chain, `sibling_group` keeps cloze/Q&A siblings
 * from interfering in review, `concept_membership` organizes, and `references`
 * records cross-links.
 */
export const RELATION_TYPES = [
  "parent_child",
  "derived_from",
  "sibling_group",
  "concept_membership",
  "references",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * Document-mark kinds (`document_marks.mark_type`). A mark is an annotation over a
 * stable block's character range — NOT an element and NOT lineage. The four kinds
 * are deliberately distinct in semantics even though they share one table:
 *
 *  - `highlight`       — a lightweight reading annotation (T020). Creates no
 *                        element, no schedule, no lineage; freely added/removed.
 *  - `extracted_span`  — the visual marker on a SOURCE/parent body showing where a
 *                        child `extract` element was lifted from (T021). The extract
 *                        is the first-class lineage; this is only the parent-side
 *                        breadcrumb.
 *  - `processed_span`  — a reversible "processed/dimmed" annotation (T026) that
 *                        declutters a long source without destroying its body.
 *  - `cloze`           — the structured cloze deletion span on a card body (M6).
 *
 * Per the "Document/editor rules" invariant, marks (highlights / extracted-spans /
 * processed-spans / cloze) live on the document body and re-anchor by STABLE block
 * id + character range, never by absolute ProseMirror position — so they survive a
 * re-import. Mark add/remove is logged under `update_document` (no `add_mark` op).
 */
export const MARK_TYPES = ["highlight", "extracted_span", "processed_span", "cloze"] as const;
export type MarkType = (typeof MARK_TYPES)[number];

/** Type guard: is `value` one of the canonical document-mark-type strings? */
export function isMarkType(value: unknown): value is MarkType {
  return typeof value === "string" && (MARK_TYPES as readonly string[]).includes(value);
}

/**
 * Active-recall card flavours (`cards.kind`). `qa` and `cloze` ship in the MVP;
 * `image_occlusion` (T071, M15) is the THIRD kind — a card whose front hides ONE
 * masked region of a `media_fragment` image extract, revealed at review. It is a
 * card VARIANT, not a parallel system: it rides the same `cards`/`review_states`/
 * `element_relations` substrate + `CardService`/`ReviewRepository` seam + the FSRS
 * review loop. Its only extra storage is the `occlusion_masks` table (the vector
 * masks a `cards` row can't hold). Adding it widens the `cards.kind` CHECK (built
 * from this tuple), so it ships with a Drizzle migration.
 */
export const CARD_KINDS = ["qa", "cloze", "image_occlusion"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

/**
 * FSRS card-memory states (`review_states.fsrs_state`). FSRS scheduling applies
 * to cards ONLY — sources/topics/extracts use the separate attention scheduler.
 * Forcing topic/extract scheduling into this model is forbidden.
 */
export const FSRS_STATES = ["new", "learning", "review", "relearning"] as const;
export type FsrsState = (typeof FSRS_STATES)[number];

/**
 * Review grades. `again | hard | good | easy` map to the FSRS rating values
 * `1 | 2 | 3 | 4` — see {@link REVIEW_RATING_VALUE}.
 */
export const REVIEW_RATINGS = ["again", "hard", "good", "easy"] as const;
export type ReviewRating = (typeof REVIEW_RATINGS)[number];

/** Numeric FSRS rating values, indexed by {@link ReviewRating}. */
export const REVIEW_RATING_VALUE: Readonly<Record<ReviewRating, 1 | 2 | 3 | 4>> = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4,
};

/**
 * Kinds of large binary an {@link Asset} can describe. The bytes live in the
 * filesystem asset vault, never in SQLite (see asset-vault separation).
 */
export const ASSET_KINDS = [
  "source_html",
  "source_pdf",
  // The original `.epub` bytes of an imported book (T067). Streamed into the vault
  // at `assets/sources/<book_id>/original.epub`; the bytes never touch SQLite, and
  // the book source's `snapshotKey` points at this path (mirrors `source_pdf`).
  "source_epub",
  // The original `.apkg` bytes of an imported Anki deck (T070). Streamed into the
  // vault for provenance/re-import; the bytes never touch SQLite. Imported Anki
  // cards point back to the deck source whose vault holds this archive.
  "import_archive",
  "snapshot",
  "image",
  "audio",
  "video",
  "export",
  "backup",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * Logical roots inside the asset vault that a {@link LocalVaultPath} can be
 * relative to. Resolved to an absolute path only by the Electron main/DB
 * service — the renderer never sees a raw filesystem path.
 */
export const VAULT_ROOTS = ["assets", "exports", "backups"] as const;
export type VaultRoot = (typeof VAULT_ROOTS)[number];

/**
 * Background-runner job types (`jobs.type`, T058). The local on-device runner (an
 * Electron `utilityProcess` worker — NOT pg-boss, NOT a server worker) dispatches
 * on this closed union. Only `url_import` is wired end-to-end in T058 (the proof
 * job that moves the URL-import fetch off-main); the rest are **reserved** —
 * declared so M14 (`ocr`), M18 (`embed`/`ai`), and T059 (`vault_verify`/
 * `vault_gc`) slot in with only a worker dispatch case + a main-side apply
 * handler, never a queue/table/IPC shape change. `cleanup` is a generic
 * housekeeping slot. A job is infra, so adding a type is a migration (the
 * `jobs.type` CHECK is built from this tuple) but adds NO `operation_log` op.
 */
export const JOB_TYPES = [
  "url_import",
  "ocr",
  // RESERVED (T067): a future heavy-book EPUB parse + chapter conversion could run
  // on the runner (DB-free worker unzips + converts; main does the vault write + the
  // one transaction). v1 runs the parse inline in main (a book parse is sub-second);
  // declared now so the later move is a non-breaking worker-dispatch addition.
  "epub_import",
  "embed",
  "ai",
  "cleanup",
  "vault_verify",
  "vault_gc",
  // The heavy on-device FSRS parameter fit (T080). A large review history is
  // replayed + scored OFF the main thread (the DB-free worker runs the pure
  // `suggestParameters`; main builds the `OptimizerHistory` payload and applies the
  // result through `optimization.apply`). A small history fits INLINE in main (no
  // job) — this is for large histories so the UI never blocks. Adding a type widens
  // the `jobs.type` CHECK → ships with a Drizzle table-rebuild migration.
  "fsrs_optimize",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * Background-runner job lifecycle statuses (`jobs.status`, T058). A job moves
 * `queued` → `running` → terminal (`succeeded` | `failed` | `cancelled`). The
 * queue is persisted in SQLite, so these survive an app restart: on launch the
 * runner re-queues any row left `running` by a crash (at-least-once) and resumes
 * draining `queued` rows. `cancelled`/`failed` are recorded, never silently
 * dropped (soft-state only).
 */
export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * OCR-page review statuses (`ocr_pages.status`, T066). The on-device OCR runner
 * produces a `suggested` recognized-text layer for a scanned page; it is a
 * REVIEWABLE suggestion (with confidence), NOT blindly merged into the body. The
 * user explicitly `accepted`s it (merging it into the page body via the normal
 * `documents.save` → `update_document` path) or `dismissed`s it. Low confidence is
 * flagged in the UI and never auto-accepted — confidence is attached, the text is
 * opt-in (the whole point of "not blindly inserted").
 */
export const OCR_PAGE_STATUSES = ["suggested", "accepted", "dismissed"] as const;
export type OcrPageStatus = (typeof OCR_PAGE_STATUSES)[number];

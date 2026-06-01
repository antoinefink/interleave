/**
 * Stable identifier types (T005).
 *
 * Every element, relation, location, asset, and operation-log entry carries a
 * stable string ID. IDs are generated in the domain/service layer
 * (UUID/ULID-style), NEVER by SQLite autoincrement — this protects two
 * invariants:
 *
 *  - **Lineage**: a card points at an extract, an extract at a source location,
 *    a location at a source. Those references must stay valid across exports,
 *    restores, and the eventual cloud sync, so IDs must be portable and not tied
 *    to a per-database row counter.
 *  - **Operation-log shape**: every mutation is a command appended to the
 *    `operation_log`; the command references the element by its stable ID so the
 *    log replays deterministically.
 *
 * These are branded string aliases. They are erased at runtime (plain strings)
 * but stop accidental cross-assignment at the type level (e.g. passing a
 * `SourceLocationId` where a `CardId` is expected).
 */

/** A nominal-typing brand so distinct ID kinds are not interchangeable. */
declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

/** ID of any {@link Element} row (`elements.id`). */
export type ElementId = Brand<string, "ElementId">;

/** ID of a {@link Document} (mirrors its owning element). */
export type DocumentId = Brand<string, "DocumentId">;

/** ID of a stable document block (`document_blocks.stable_block_id`). */
export type BlockId = Brand<string, "BlockId">;

/** ID of an {@link ElementRelation} edge row. */
export type RelationId = Brand<string, "RelationId">;

/** ID of an {@link ElementLocation} (`source_locations.id`). */
export type SourceLocationId = Brand<string, "SourceLocationId">;

/** ID of an {@link Asset} metadata row. */
export type AssetId = Brand<string, "AssetId">;

/** ID of an {@link OperationLogEntry} (`operation_log.id`). */
export type OperationId = Brand<string, "OperationId">;

/** ID of a `review_logs` row. */
export type ReviewLogId = Brand<string, "ReviewLogId">;

/** ID grouping sibling cards/extracts (`element_relations.sibling_group_id`). */
export type SiblingGroupId = Brand<string, "SiblingGroupId">;

/**
 * ID of a background-runner {@link Job} row (`jobs.id`, T058). A job is local
 * infrastructure (an off-main work unit), NOT an element — it carries no lineage
 * and never appears in `operation_log`; it MAY reference an element inside its
 * typed payload/result, but it is not part of the element graph.
 */
export type JobId = Brand<string, "JobId">;

/**
 * An ISO-8601 timestamp string (UTC). Stored as text in SQLite. Kept as a named
 * alias so timestamp columns read clearly and can be tightened later without a
 * sweep across the codebase.
 */
export type IsoTimestamp = string;

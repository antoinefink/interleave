/**
 * The Interleave SQLite schema (T006) — full table set, re-exported.
 *
 * This barrel is what `drizzle-kit` reads (via `drizzle.config.ts`), what the
 * migrator/client (`packages/db`) import, and what `packages/local-db` (T008)
 * builds repositories on. All 18 M1 tables live here; FTS5 tables
 * (`source_fts`, `extract_fts`, `card_fts`) arrive with search later.
 *
 * Tables (per `docs/domain-model.md` "Core tables"):
 *   elements, documents, document_blocks, document_marks, sources,
 *   source_locations, element_relations, read_points, cards, review_states,
 *   review_logs, concepts, tags, element_tags, tasks, assets, operation_log,
 *   settings.
 */

export * from "./cards";
export * from "./documents";
export * from "./elements";
export * from "./organize";
export * from "./relations";
export * from "./sources";
export * from "./system";

/**
 * SearchRepository (T008 surface → T042 FTS5 implementation).
 *
 * Local full-text search over the SQLite FTS5 virtual tables `source_fts`,
 * `extract_fts`, and `card_fts` (created + kept in sync by triggers in the
 * hand-authored migration `packages/db/drizzle/0002_search_fts5.sql`). The index
 * is DERIVED — the base tables (`elements` / `documents` / `cards` /
 * `element_tags`) are the source of truth, and the triggers keep FTS current
 * inside the same write transaction as every mutation, so the index cannot drift
 * from a missed code path.
 *
 * What it searches:
 *  - sources: `elements.title` + the `documents.plain_text` body mirror + tags;
 *  - extracts: title + body + tags;
 *  - cards: `cards.prompt`/`cloze` (folded together) + `answer` + tags.
 *
 * Ranking is "simple" per the MVP: FTS5 `bm25()` with title/prompt weighted over
 * body, and a light boost on tag hits, so the best matches sort first. Recency /
 * priority-weighted ranking, fuzzy/typo tolerance, and semantic search are
 * explicitly later (semantic is M18/T087).
 *
 * It is READ-ONLY (search appends nothing to the operation log) and excludes
 * soft-deleted elements (the triggers never index a `deleted_at IS NOT NULL`
 * element, and the joins re-check `deleted_at IS NULL` defensively). The renderer
 * never instantiates this — the Electron main/DB service composes it behind the
 * validated `search.*` IPC surface; the renderer never issues SQL.
 */

import type { Element, ElementId, ElementType } from "@interleave/core";
import { elements, type InterleaveDatabase } from "@interleave/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { rowToElement } from "./mappers";

/** Options narrowing a search. */
export interface SearchOptions {
  /** Restrict to a single element type. */
  readonly type?: ElementType;
  readonly limit?: number;
}

/** Element types that have an FTS index (the only types `query`/`search` return). */
export type SearchableType = "source" | "extract" | "card";
const SEARCHABLE_TYPES = new Set<ElementType>(["source", "extract", "card"]);

/** Default cap so a broad query can't return an unbounded list. */
const DEFAULT_LIMIT = 50;

/**
 * A ranked search hit: enough for the library `result` row + selection detail.
 * `score` is the (lower-is-better) `bm25` rank, exposed so callers can sort/merge;
 * `snippet` is a short matched excerpt for the row preview.
 */
export interface SearchHit {
  readonly id: ElementId;
  readonly type: SearchableType;
  readonly title: string;
  /** A short excerpt of the best-matching field for the row preview. */
  readonly snippet: string;
  /** FTS5 `bm25` rank — lower is a better match. */
  readonly score: number;
}

/** Options for the richer ranked {@link SearchRepository.search}. */
export interface SearchQueryOptions {
  readonly type?: ElementType;
  readonly limit?: number;
  /** Restrict to elements that are members of this concept (`concept_membership`). */
  readonly conceptId?: ElementId;
  /** Restrict to elements carrying this tag (exact name). */
  readonly tag?: string;
}

/**
 * Sanitize raw user input into a SAFE FTS5 `MATCH` expression. FTS5 has its own
 * query syntax (operators like `AND`/`OR`/`NEAR`/`*`/`"`/`(`/`-`/`:`) that throws
 * on stray operators, so we NEVER interpolate raw text. We split on non-word
 * runs, quote each term (escaping embedded double-quotes per FTS5 rules — a `"`
 * becomes `""`), append a `*` for prefix matching, and AND the terms together.
 * Returns `null` when there is nothing to match (so the caller returns `[]`
 * instead of issuing an error-prone query).
 */
export function toMatchExpression(raw: string): string | null {
  const terms = raw
    .trim()
    .toLowerCase()
    // Split on anything that is not a letter/number (Unicode-aware).
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" AND ");
}

export class SearchRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /**
   * Back-compat surface (T008): find live elements matching `query` and return
   * them as {@link Element} rows, ranked best-first. Reimplemented over FTS5
   * (was a `LIKE` scan). Sources/extracts/cards only (the FTS-indexed types);
   * `byTitle` still covers every type for the palette. Excludes soft-deleted.
   */
  query(query: string, options: SearchOptions = {}): Element[] {
    const hits = this.search(query, {
      ...(options.type ? { type: options.type } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
    const out: Element[] = [];
    for (const hit of hits) {
      const row = this.db.select().from(elements).where(eq(elements.id, hit.id)).get();
      if (row && !row.deletedAt) out.push(rowToElement(row));
    }
    return out;
  }

  /**
   * Ranked full-text search returning {@link SearchHit}s (the library surface).
   * Runs the three FTS tables, joins back to live `elements`, ranks by `bm25`
   * (title/prompt weighted over body, tags a light boost), dedupes per element,
   * applies the optional type/concept/tag narrowing in SQL, and caps the result.
   * A malformed/empty query degrades to `[]` (never an error).
   */
  search(query: string, options: SearchQueryOptions = {}): SearchHit[] {
    const match = toMatchExpression(query);
    if (match === null) return [];

    const limit = options.limit ?? DEFAULT_LIMIT;
    const typeFilter = options.type;
    if (typeFilter && !SEARCHABLE_TYPES.has(typeFilter)) return [];

    const wantSource = !typeFilter || typeFilter === "source";
    const wantExtract = !typeFilter || typeFilter === "extract";
    const wantCard = !typeFilter || typeFilter === "card";

    // A column-scoped MATCH used to detect whether the term hit the HEADLINE
    // field (title for source/extract, prompt for card). `bm25` column weights
    // alone are unstable on tiny corpora, so we sort by a coarse, deterministic
    // `tier` first (0 = headline hit, 1 = body/answer/tags only) and use `bm25`
    // only as the WITHIN-tier tiebreaker — this guarantees "simple ranking":
    // a title/prompt match always outranks a body-only match. The column order:
    //   source/extract_fts(element_id UNINDEXED, title, body, tags)
    //   card_fts(element_id UNINDEXED, prompt, answer, tags)
    const titleMatch = `{title} : ${match}`;
    const promptMatch = `{prompt} : ${match}`;

    const unions: ReturnType<typeof sql>[] = [];
    if (wantSource) {
      unions.push(sql`
        SELECT element_id AS id, 'source' AS type,
          CASE WHEN element_id IN (
            SELECT element_id FROM source_fts WHERE source_fts MATCH ${titleMatch}
          ) THEN 0 ELSE 1 END AS tier,
          bm25(source_fts, 10.0, 1.0, 4.0) AS score,
          snippet(source_fts, 2, '', '', '…', 12) AS snippet
        FROM source_fts WHERE source_fts MATCH ${match}
      `);
    }
    if (wantExtract) {
      unions.push(sql`
        SELECT element_id AS id, 'extract' AS type,
          CASE WHEN element_id IN (
            SELECT element_id FROM extract_fts WHERE extract_fts MATCH ${titleMatch}
          ) THEN 0 ELSE 1 END AS tier,
          bm25(extract_fts, 8.0, 1.0, 4.0) AS score,
          snippet(extract_fts, 2, '', '', '…', 12) AS snippet
        FROM extract_fts WHERE extract_fts MATCH ${match}
      `);
    }
    if (wantCard) {
      unions.push(sql`
        SELECT element_id AS id, 'card' AS type,
          CASE WHEN element_id IN (
            SELECT element_id FROM card_fts WHERE card_fts MATCH ${promptMatch}
          ) THEN 0 ELSE 1 END AS tier,
          bm25(card_fts, 10.0, 6.0, 4.0) AS score,
          snippet(card_fts, 0, '', '', '…', 12) AS snippet
        FROM card_fts WHERE card_fts MATCH ${match}
      `);
    }
    if (unions.length === 0) return [];

    const unionSql = sql.join(unions, sql` UNION ALL `);

    // Narrow to live elements (defensive `deleted_at IS NULL`), and apply the
    // optional concept-membership / tag filters from T041 in the query layer.
    const conceptJoin = options.conceptId
      ? sql`JOIN element_relations cm
            ON cm.from_element_id = e.id
            AND cm.relation_type = 'concept_membership'
            AND cm.to_element_id = ${options.conceptId}`
      : sql``;
    const tagJoin = options.tag
      ? sql`JOIN element_tags etf ON etf.element_id = e.id
            JOIN tags tf ON tf.id = etf.tag_id AND tf.name = ${options.tag}`
      : sql``;

    const rows = this.db.all<{
      id: string;
      type: SearchableType;
      title: string;
      snippet: string;
      tier: number;
      score: number;
    }>(sql`
      SELECT m.id AS id, m.type AS type, e.title AS title, m.snippet AS snippet,
        m.tier AS tier, m.score AS score
      FROM (${unionSql}) m
      JOIN elements e ON e.id = m.id AND e.deleted_at IS NULL
      ${conceptJoin}
      ${tagJoin}
      ORDER BY m.tier ASC, m.score ASC
    `);

    // Dedupe per element (keep the best-ranked hit), preserving rank order, then cap.
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      hits.push({
        id: row.id as ElementId,
        type: row.type,
        title: row.title,
        snippet: row.snippet ?? "",
        score: row.score,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /**
   * Title-only substring lookup used by the command palette (fast path). Covers
   * EVERY element type (including topics, which have no FTS index), so the
   * palette can jump to anything by name. Excludes soft-deleted.
   *
   * LIKE wildcards (`%`, `_`) and the escape char (`\`) in user input are escaped
   * (with `ESCAPE '\'`) so they match LITERALLY — a query like `50%` or `a_b`
   * searches for those characters rather than silently broadening the match.
   */
  byTitle(query: string, limit = 20): Element[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const pattern = `%${escapeLikePattern(trimmed)}%`;
    return this.db
      .select()
      .from(elements)
      .where(and(sql`${elements.title} LIKE ${pattern} ESCAPE '\\'`, isNull(elements.deletedAt)))
      .limit(limit)
      .all()
      .map(rowToElement);
  }
}

/**
 * Escape the SQL LIKE wildcards (`%`, `_`) and the escape char itself (`\`) in a
 * user-supplied substring so they are matched literally under `ESCAPE '\'`. The
 * backslash MUST be escaped first so it does not double-escape the wildcards.
 */
function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

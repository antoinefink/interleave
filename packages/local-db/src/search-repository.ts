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
 * Ranking is "simple" per the MVP: a coarse, deterministic `tier` (headline hit
 * vs body-only) sorts first, with FTS5 `bm25()` as the within-tier tiebreaker —
 * title/prompt weighted over body, tags a light boost — so the best matches sort
 * first. The `bm25()` weights are positional over ALL columns INCLUDING the
 * leading UNINDEXED `element_id`, so the first weight is always `0.0` for it.
 * Recency / priority-weighted ranking, fuzzy/typo tolerance, and semantic search
 * are explicitly later (semantic is M18/T087).
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

/** The four coarse priority labels the `/search` priority facet exposes. */
export type SearchPriorityLabel = "A" | "B" | "C" | "D";

/**
 * Half-open numeric `[lower, upper)` bands for each A/B/C/D label, derived from the
 * canonical `priorityToLabel` thresholds (`A>=0.75`, `B>=0.5`, `C>=0.25`, `D>=0`).
 * `A` has no upper bound and `D` no lower bound so the filter agrees with
 * `priorityToLabel` for ANY value — including, defensively, an out-of-range one
 * (`>=0.75` is `A`, `<0.25` is `D`), matching `priorityToLabel`'s `clamp01`. In
 * practice `elements.priority` is `[0,1]` (DB CHECK), so the open ends just keep the
 * SQL band filter in lock-step with the label mapping, with no per-row clamp in SQL.
 */
const PRIORITY_BANDS: Readonly<
  Record<SearchPriorityLabel, readonly [number | null, number | null]>
> = {
  A: [0.75, null],
  B: [0.5, 0.75],
  C: [0.25, 0.5],
  D: [null, 0.25],
};

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
 * Safety cap for the un-narrowed concept-count scan ({@link
 * SearchRepository.matchedIdsForConceptCounts}). The drill-down chip counts want
 * the FULL keyword+type+tag match set (pre-display-cap), but a pathological query
 * must still not pull an unbounded list into memory; this bound is far above any
 * realistic single-keyword result set, so counts stay exact in practice while the
 * scan can never run away.
 */
const MAX_COUNT_SCAN = 10_000;

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
  /**
   * Restrict to elements whose numeric priority maps to this A/B/C/D band (the
   * `/search` priority facet). Band boundaries mirror the canonical
   * `priorityToLabel` thresholds, so a priority-narrowed search matches the
   * SAME rows the renderer would render — and the drill-down concept-chip counts
   * stay in lock-step with the priority-narrowed list.
   */
  readonly priorityLabel?: SearchPriorityLabel;
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
    //
    // CRITICAL: `bm25()`'s weight arguments are positional over ALL columns —
    // including the leading `element_id UNINDEXED`. So the first weight must be
    // for `element_id` (0.0 — it is never matched), then title/body/tags. The
    // weights here keep title > tags > body so the within-tier tiebreaker agrees
    // with the documented "weight title > body". And `snippet(table, -1, …)`
    // uses the FTS5 "best matching column" sentinel so the excerpt comes from the
    // column the term actually hit — never the UNINDEXED `element_id` (column 0).
    const titleMatch = `{title} : ${match}`;
    const promptMatch = `{prompt} : ${match}`;

    const unions: ReturnType<typeof sql>[] = [];
    if (wantSource) {
      unions.push(sql`
        SELECT element_id AS id, 'source' AS type,
          CASE WHEN element_id IN (
            SELECT element_id FROM source_fts WHERE source_fts MATCH ${titleMatch}
          ) THEN 0 ELSE 1 END AS tier,
          bm25(source_fts, 0.0, 10.0, 1.0, 4.0) AS score,
          snippet(source_fts, -1, '', '', '…', 12) AS snippet
        FROM source_fts WHERE source_fts MATCH ${match}
      `);
    }
    if (wantExtract) {
      unions.push(sql`
        SELECT element_id AS id, 'extract' AS type,
          CASE WHEN element_id IN (
            SELECT element_id FROM extract_fts WHERE extract_fts MATCH ${titleMatch}
          ) THEN 0 ELSE 1 END AS tier,
          bm25(extract_fts, 0.0, 8.0, 1.0, 4.0) AS score,
          snippet(extract_fts, -1, '', '', '…', 12) AS snippet
        FROM extract_fts WHERE extract_fts MATCH ${match}
      `);
    }
    if (wantCard) {
      unions.push(sql`
        SELECT element_id AS id, 'card' AS type,
          CASE WHEN element_id IN (
            SELECT element_id FROM card_fts WHERE card_fts MATCH ${promptMatch}
          ) THEN 0 ELSE 1 END AS tier,
          bm25(card_fts, 0.0, 10.0, 6.0, 4.0) AS score,
          snippet(card_fts, -1, '', '', '…', 12) AS snippet
        FROM card_fts WHERE card_fts MATCH ${match}
      `);
    }
    if (unions.length === 0) return [];

    const unionSql = sql.join(unions, sql` UNION ALL `);

    // Narrow to live elements (defensive `deleted_at IS NULL`), and apply the
    // optional concept-membership / tag filters from T041 in the query layer.
    //
    // The concept filter enforces concept-ENDPOINT liveness/type the SAME way as the
    // canonical substrate (ConceptRepository.liveMembershipMap / elementsForConcept):
    // the membership edge only counts when its `to` endpoint is a LIVE `concept`-type
    // element. Without the `ce` join, search would surface members of a soft-deleted
    // concept (or of a corrupt edge pointing at a non-concept), diverging from
    // queue/Library, which both drop such edges. The `from`/member liveness is still
    // enforced by the outer `JOIN elements e ... e.deleted_at IS NULL`.
    const conceptJoin = options.conceptId
      ? sql`JOIN element_relations cm
            ON cm.from_element_id = e.id
            AND cm.relation_type = 'concept_membership'
            AND cm.to_element_id = ${options.conceptId}
          JOIN elements ce
            ON ce.id = cm.to_element_id
            AND ce.deleted_at IS NULL
            AND ce.type = 'concept'`
      : sql``;
    const tagJoin = options.tag
      ? sql`JOIN element_tags etf ON etf.element_id = e.id
            JOIN tags tf ON tf.id = etf.tag_id AND tf.name = ${options.tag}`
      : sql``;

    // The PRIORITY facet (drill-down): narrow on `elements.priority` by the chosen
    // A/B/C/D band, using the SAME `[lower, upper)` boundaries `priorityToLabel`
    // derives so the SQL filter and the label mapping never diverge. Applied here
    // (in `search`) means BOTH the result list AND the concept-count scan
    // (`matchedIdsForConceptCounts`, which reuses `search`) respect priority — so a
    // concept-chip count always matches the priority-narrowed list.
    const priorityClause = priorityBandClause(options.priorityLabel);

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
      WHERE 1 = 1 ${priorityClause}
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
   * The DISTINCT live element ids matching a query under the keyword + type + tag
   * filters but with NO concept narrowing and NO result cap — the universe the
   * library `/search` concept chips count over (DRILL-DOWN semantics: the concept
   * dimension's own predicate is dropped so a chip count equals the rows you'd get
   * if that concept were selected alongside the SAME keyword/type/tag). It reuses
   * the SAME ranked {@link search} (so the matched set is identical to what the
   * results list draws from) with the concept filter omitted and the cap lifted to
   * the safety {@link MAX_COUNT_SCAN}, then returns just the ids. Excludes
   * soft-deleted (the FTS join already does). The CALLER folds these through the
   * canonical `concept_membership` map to produce per-concept counts — keeping the
   * single-pass, no-N+1 rule (no `elementsForConcept` per concept).
   */
  matchedIdsForConceptCounts(
    query: string,
    options: {
      readonly type?: ElementType;
      readonly tag?: string;
      readonly priorityLabel?: SearchPriorityLabel;
    } = {},
  ): ElementId[] {
    const hits = this.search(query, {
      ...(options.type ? { type: options.type } : {}),
      ...(options.tag ? { tag: options.tag } : {}),
      ...(options.priorityLabel ? { priorityLabel: options.priorityLabel } : {}),
      limit: MAX_COUNT_SCAN,
    });
    return hits.map((h) => h.id);
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

/**
 * The `AND`-prefixed `e.priority` band predicate for the chosen A/B/C/D facet, or
 * an empty fragment when no priority facet is active. Uses the canonical half-open
 * {@link PRIORITY_BANDS} boundaries (mirroring `priorityToLabel`) so the
 * filter and the label mapping agree on every band edge. Designed to be appended
 * after a `WHERE 1 = 1` so an absent facet contributes nothing.
 */
function priorityBandClause(label: SearchPriorityLabel | undefined): ReturnType<typeof sql> {
  if (!label) return sql``;
  const [lower, upper] = PRIORITY_BANDS[label];
  const lowerClause = lower !== null ? sql` AND e.priority >= ${lower}` : sql``;
  const upperClause = upper !== null ? sql` AND e.priority < ${upper}` : sql``;
  return sql`${lowerClause}${upperClause}`;
}

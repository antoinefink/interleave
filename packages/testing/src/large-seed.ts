/**
 * Large-collection seed harness (T100).
 *
 * Builds a configurable, realistic collection — up to the scale matrix (~thousands
 * of sources, ~100k extracts, ~100k cards, long review histories → ~1M+
 * `review_logs`) — into an ALREADY-OPEN, fully-migrated database, so the
 * `packages/local-db/bench/scale.bench.ts` benchmark measures the hot read paths
 * against REAL query plans at scale.
 *
 * Why this is NOT `seedDemoCollection` at scale: the per-element factory path runs
 * a transaction + appends an `operation_log` row PER mutation. That is the right,
 * honest path for correctness (the demo seed + every domain test exercise it), but
 * it is far too slow for 1M+ rows. This harness therefore offers a documented
 * **bulk-insert fast path** — batched `INSERT`s inside ONE transaction, with the
 * throwaway bench DB's pragmas relaxed (`synchronous = OFF`, `journal_mode =
 * MEMORY`) — that writes the SAME row shapes the repositories produce, so the bench
 * query plans are identical to production. The bench DB is a THROWAWAY temp file (or
 * `:memory:`), NEVER the user/dev DB, and the fast path INTENTIONALLY skips the
 * per-row `operation_log` (op-log throughput is exercised by the per-task
 * transaction tests, not here — documented below).
 *
 * The fast path is kept honest two ways: (1) it writes exactly the columns the
 * schema declares (the row builders below mirror `SourceRepository.create` /
 * `createExtract`, `ReviewRepository.createCard` / `recordReview`), and (2) the bench
 * harness can run a small SMOKE control collection through the REAL repository path
 * (`seedSmokeControl`) and assert the two produce schema-identical rows (same
 * tables, same NOT-NULL/CHECK/FK satisfaction) — proving the bulk rows are not a
 * fiction.
 *
 * Determinism: every random choice flows through a tiny seeded PRNG (`mulberry32`
 * over an `xmur3` 32-bit string hash) — the SAME dependency-free algorithm the only
 * other seeded RNG in the repo uses (`review-mode-service.ts`, T096). Those helpers
 * are private module functions there (not importable), so they are re-implemented
 * here (per the T100 spec's preferred option (b)) to avoid `packages/testing`
 * reaching into `packages/local-db` internals.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  type BlockId,
  DEFAULT_EMBEDDING_MODEL_ID,
  EMBEDDING_DIM,
  type EmbeddableType,
  embedTextLocal,
  type IsoTimestamp,
  PRIORITY_LABEL_VALUE,
} from "@interleave/core";
import {
  cards,
  documentBlocks,
  documents,
  elementRelations,
  elements,
  elementTags,
  embeddings as embeddingsTable,
  type InterleaveDatabase,
  reviewLogs,
  reviewStates,
  type SqliteDatabase,
  sourceLocations,
  sources,
  tags,
  vectorToBlob,
} from "@interleave/db";
import type { Repositories } from "@interleave/local-db";

// ---------------------------------------------------------------------------
// Seeded PRNG — the SAME mulberry32 / xmur3 algorithm as review-mode-service.ts
// (T096), re-implemented locally so packages/testing does not reach into
// packages/local-db internals (the helpers are private there). Pure + dependency-
// free; a given seed reproduces the SAME collection.
// ---------------------------------------------------------------------------

/** A 32-bit string hash (xmur3) — seeds the PRNG from a string `seed`. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32 — a tiny seeded PRNG returning a float in `[0, 1)`. */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small deterministic RNG facade with the helpers the seed needs. */
interface Rng {
  /** Float in `[0, 1)`. */
  next(): number;
  /** Integer in `[lo, hi]` (inclusive). */
  int(lo: number, hi: number): number;
  /** Pick one element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
}

function makeRng(seed: string): Rng {
  const seedFn = xmur3(seed);
  const rand = mulberry32(seedFn());
  return {
    next: rand,
    int: (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)),
    pick: (items) => items[Math.floor(rand() * items.length)] as (typeof items)[number],
  };
}

// ---------------------------------------------------------------------------
// Options + stats.
// ---------------------------------------------------------------------------

/** Options for {@link seedLargeCollection}. All counts have a documented default. */
export interface LargeSeedOptions {
  /** Number of `source` elements. Default {@link DEFAULT_LARGE_PROFILE}. */
  readonly sources?: number;
  /** Extracts created per source. */
  readonly extractsPerSource?: number;
  /** Cards created per extract. */
  readonly cardsPerExtract?: number;
  /** `review_logs` appended per card (the long-history knob). */
  readonly reviewsPerCard?: number;
  /** Number of concept elements (membership edges spread across cards/extracts). */
  readonly conceptCount?: number;
  /**
   * Whether to seed `embeddings` + `element_vectors` (`vec0`) rows. Requires the DB
   * to have been opened with `sqlite-vec` loaded; pass `false` (default) when vec0
   * is unavailable — the bench then measures the FTS-only degrade path.
   */
  readonly embeddings?: boolean;
  /** Deterministic seed (string). Default `"interleave-scale"`. */
  readonly seed?: string;
  /**
   * The instant the collection is "as of" (ISO). `created_at`/`due_at` are spread
   * in a window ending at this instant so analytics + the queue see realistic data.
   * Default: a fixed 2026 instant (deterministic).
   */
  readonly asOf?: string;
}

/** What {@link seedLargeCollection} actually built — the bench's provenance header. */
export interface LargeSeedStats {
  readonly sources: number;
  readonly extracts: number;
  readonly cards: number;
  readonly reviewLogs: number;
  readonly reviewStates: number;
  readonly concepts: number;
  readonly tags: number;
  readonly embeddings: number;
  readonly elements: number;
  /** Wall-clock build time in milliseconds. */
  readonly buildMs: number;
  /**
   * On-disk DB size in bytes (sum of the main file + `-wal`), or `null` for an
   * in-memory DB. The bench prints this so the backup soft-ceiling is in context.
   */
  readonly dbSizeBytes: number | null;
}

/**
 * The DEFAULT large profile — the spec's scale matrix: **~1k sources, ~100k
 * extracts, ~100k cards, ~10 reviews/card → ~1M review_logs**. This is the OPT-IN /
 * LOCAL run (`INTERLEAVE_BENCH_N=full pnpm bench`); CI passes the much smaller
 * {@link SMOKE_LARGE_PROFILE}. On the T100 reference machine (Apple-silicon laptop)
 * the bulk fast path builds this in a few minutes + a few hundred MB of temp disk —
 * documented in the bench header + the M20 spec. (The knobs are deliberately ~1M
 * logs, not 3M: the spec's matrix is "~100k cards / ~1M+ logs"; the bulk-insert path
 * is JS-array-bound, so 1M keeps the local run in "minutes", not tens of minutes.)
 */
export const DEFAULT_LARGE_PROFILE: Required<
  Omit<LargeSeedOptions, "seed" | "asOf" | "embeddings">
> = {
  sources: 1000,
  extractsPerSource: 100,
  cardsPerExtract: 1,
  reviewsPerCard: 10,
  conceptCount: 200,
};

/**
 * A small profile suitable for CI / a fast smoke (a few thousand elements). Used by
 * the bench's bounded-N CI mode + the scale-smoke harness.
 */
export const SMOKE_LARGE_PROFILE: Required<Omit<LargeSeedOptions, "seed" | "asOf" | "embeddings">> =
  {
    sources: 40,
    extractsPerSource: 12,
    cardsPerExtract: 1,
    reviewsPerCard: 6,
    conceptCount: 12,
  };

/**
 * The CI-bounded scale profile for the `scale-smoke` Playwright run — a few THOUSAND
 * elements (NOT 100k in CI, per the T100 spec). Big enough that backup/restore,
 * `integrity_check`, the two-scheduler split, and the MVP-flow-after-restart all
 * exercise a realistic-but-fast collection; small enough that every PR stays quick.
 * ~120 sources × ~20 extracts ≈ 2.4k extracts + 2.4k cards + ~5 logs/card ≈ 12k logs.
 */
export const CI_SCALE_PROFILE: Required<Omit<LargeSeedOptions, "seed" | "asOf" | "embeddings">> = {
  sources: 120,
  extractsPerSource: 20,
  cardsPerExtract: 1,
  reviewsPerCard: 5,
  conceptCount: 20,
};

const DEFAULT_SEED = "interleave-scale";
const DEFAULT_AS_OF = "2026-06-01T12:00:00.000Z";
const MODEL_ID = DEFAULT_EMBEDDING_MODEL_ID;
/** Spread `created_at` over this many days back from `asOf`. */
const CREATED_WINDOW_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

const PRIORITY_BANDS = [
  PRIORITY_LABEL_VALUE.A,
  PRIORITY_LABEL_VALUE.B,
  PRIORITY_LABEL_VALUE.C,
  PRIORITY_LABEL_VALUE.D,
] as const;
const FSRS_STATES_NEW = "review" as const;
const RATINGS = ["again", "hard", "good", "easy"] as const;

const id = (): string => randomUUID();

/**
 * A raw `better-sqlite3` prepared single-row INSERT for `table`, derived from the
 * Drizzle table's column map (so it writes EXACTLY the columns Drizzle declares —
 * the schema-identical guarantee), CACHED per (sqlite handle, table) so it is
 * compiled once and reused across the millions of rows. This is the bulk fast path's
 * real lever: Drizzle's `.values(chunk).run()` recompiles + re-maps per chunk, which
 * is ~50× slower than reusing one prepared statement at 1M-row scale.
 */
/** A minimal raw `better-sqlite3` handle surface (avoids importing the type). */
interface RawStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface RawDb {
  prepare(sql: string): RawStatement;
}
interface PreparedInsert {
  readonly columns: { drizzleKey: string; sqlName: string }[];
  readonly stmt: RawStatement;
}
const preparedInsertCache = new WeakMap<object, Map<unknown, PreparedInsert>>();

type DrizzleTable = Parameters<InterleaveDatabase["insert"]>[0];

function preparedInsertFor(raw: RawDb, table: DrizzleTable): PreparedInsert {
  let byTable = preparedInsertCache.get(raw as unknown as object);
  if (!byTable) {
    byTable = new Map();
    preparedInsertCache.set(raw as unknown as object, byTable);
  }
  const hit = byTable.get(table);
  if (hit) return hit;

  // Drizzle stores the column map + table name on well-known symbols; read them to
  // derive the SQLite column names (and their JS keys) in declaration order — so the
  // raw INSERT writes EXACTLY the columns Drizzle declares (schema-identical rows).
  const colMap =
    (table as unknown as Record<symbol, Record<string, { name: string }> | undefined>)[
      Symbol.for("drizzle:Columns")
    ] ?? {};
  const tableName = (table as unknown as Record<symbol, string>)[Symbol.for("drizzle:Name")];
  const columns = Object.entries(colMap).map(([drizzleKey, col]) => ({
    drizzleKey,
    sqlName: col.name,
  }));
  const cols = columns.map((c) => `"${c.sqlName}"`).join(", ");
  const placeholders = columns.map((c) => `@${c.drizzleKey}`).join(", ");
  const stmt = raw.prepare(`INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders})`);
  const prepared: PreparedInsert = { columns, stmt };
  byTable.set(table, prepared);
  return prepared;
}

/**
 * Insert `rows` into `table` via the CACHED raw prepared statement (one tx assumed).
 * Each row is normalized to the exact named params the statement expects: every
 * declared column is bound (a missing key → `null`, a boolean → 0/1, matching
 * better-sqlite3's bindable types), so the written rows are schema-identical to the
 * Drizzle-produced shapes (validated against the real-repository control run). This
 * is the bulk fast path's real lever — reusing one prepared statement is ~50× faster
 * than Drizzle's per-chunk `.values().run()` at 1M-row scale.
 */
function batchInsert<T>(raw: RawDb, table: DrizzleTable, rows: readonly T[]): void {
  if (rows.length === 0) return;
  const { columns, stmt } = preparedInsertFor(raw, table);
  const params: Record<string, unknown> = {};
  for (const row of rows as readonly Record<string, unknown>[]) {
    for (const col of columns) {
      const v = row[col.drizzleKey];
      params[col.drizzleKey] = v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v;
    }
    stmt.run(params);
  }
}

/**
 * Relax the throwaway bench DB's durability pragmas for the bulk load, returning a
 * restore function. ONLY safe on a throwaway temp/in-memory DB — never the user DB.
 * The caller guards this; we additionally no-op on `:memory:` (WAL is already a
 * no-op there).
 */
function relaxBenchPragmas(db: InterleaveDatabase): () => void {
  const raw = rawSqlite(db);
  const prevSync = raw.pragma("synchronous", { simple: true });
  const prevJournal = raw.pragma("journal_mode", { simple: true });
  const prevFk = raw.pragma("foreign_keys", { simple: true });
  const prevCache = raw.pragma("cache_size", { simple: true });
  raw.pragma("synchronous = OFF");
  // Only switch journal away from WAL when not in-memory (memory is already fastest).
  if (prevJournal !== "memory") raw.pragma("journal_mode = MEMORY");
  // A LARGE page cache (~1 GiB; negative = KiB) keeps the growing index B-trees
  // resident during the bulk load. Random-UUID primary keys insert all over each
  // B-tree, so without a big cache every insert evicts/refetches index pages and the
  // load scales super-linearly (the rate halves as the table grows). With the cache
  // the index pages stay hot and the rate stays flat. Throwaway bench DB only.
  raw.pragma("cache_size = -1048576");
  // Defer FK enforcement during the bulk load — at 100k+ elements a per-row FK index
  // probe on every review_log/card/location insert dominates the wall-clock and makes
  // the load scale super-linearly. The seed builds VALID lineage, and the caller
  // re-enables FK + runs `foreign_key_check` after the load to PROVE no row violates a
  // constraint (see seedLargeCollection's finally). `foreign_keys` is a no-op inside a
  // transaction, so this MUST run before `raw.transaction(...)` — which it does.
  raw.pragma("foreign_keys = OFF");
  return () => {
    raw.pragma(`synchronous = ${prevSync}`);
    if (prevJournal !== "memory") raw.pragma(`journal_mode = ${prevJournal}`);
    raw.pragma(`foreign_keys = ${prevFk ? "ON" : "OFF"}`);
    raw.pragma(`cache_size = ${prevCache}`);
  };
}

/** A raw better-sqlite3 surface for the FTS trigger dance (no type import needed). */
interface RawExecDb extends RawDb {
  exec(sql: string): void;
}

/**
 * Drop the FTS5 sync triggers (`*_fts_ai`/`*_fts_au`/`*_fts_ad`) for the bulk load and
 * return a function that re-creates them AND rebuilds the FTS index from scratch.
 *
 * These triggers run a `DELETE FROM <fts> WHERE element_id = …` + re-INSERT on EVERY
 * `documents`/`source_locations`/`cards`/`elements`/`element_tags` mutation. FTS5 has
 * no fast key on `element_id`, so each trigger DELETE scans the growing FTS table —
 * the dominant super-linear cost at 100k+ rows (the load rate halves as the table
 * grows). For a fresh bulk load there is nothing to delete, so the triggers are pure
 * overhead. We read their live definitions from `sqlite_master` (so this NEVER drifts
 * from the real schema), drop them, and after the load re-create them verbatim + do a
 * single bulk `INSERT INTO <fts> SELECT …` populate — leaving the same searchable
 * index the per-row triggers would have, in a fraction of the time.
 */
function deferFtsTriggers(rawDb: RawDb): () => void {
  const raw = rawDb as RawExecDb;
  // Read the live trigger DDL (name + SQL) for every FTS sync trigger.
  const triggers = (
    raw
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND (name LIKE '%\\_fts\\_ai' ESCAPE '\\' OR name LIKE '%\\_fts\\_au' ESCAPE '\\' OR name LIKE '%\\_fts\\_ad' ESCAPE '\\')",
      )
      .all() as { name: string; sql: string }[]
  ).filter((t) => t.sql);
  for (const t of triggers) raw.exec(`DROP TRIGGER IF EXISTS "${t.name}"`);

  return () => {
    // Re-create the triggers verbatim (so ongoing app writes stay FTS-synced)…
    for (const t of triggers) raw.exec(t.sql);
    // …then bulk-populate the three FTS tables in one pass each (the index the
    // dropped per-row triggers would have built). Mirrors the trigger bodies' SELECTs.
    const tagsExpr = `(SELECT COALESCE(group_concat(t.name, ' '), '') FROM element_tags et JOIN tags t ON t.id = et.tag_id WHERE et.element_id = e.id)`;
    raw.exec(
      `INSERT INTO source_fts(element_id, title, body, tags)
         SELECT e.id, e.title, d.plain_text, ${tagsExpr}
         FROM elements e JOIN documents d ON d.element_id = e.id
         WHERE e.type = 'source' AND e.deleted_at IS NULL`,
    );
    raw.exec(
      `INSERT INTO extract_fts(element_id, title, body, tags)
         SELECT e.id, e.title, sl.selected_text, ${tagsExpr}
         FROM elements e JOIN source_locations sl ON sl.element_id = e.id
         WHERE e.type = 'extract' AND e.deleted_at IS NULL`,
    );
    raw.exec(
      `INSERT INTO card_fts(element_id, prompt, answer, tags)
         SELECT e.id, COALESCE(c.prompt, c.cloze, ''), COALESCE(c.answer, ''), ${tagsExpr}
         FROM elements e JOIN cards c ON c.element_id = e.id
         WHERE e.type = 'card' AND e.deleted_at IS NULL`,
    );
  };
}

/**
 * Seed a large, realistic collection into an open, migrated DB via the documented
 * BULK FAST PATH (batched inserts, one transaction, relaxed pragmas on the throwaway
 * bench DB). Writes the SAME row shapes the repositories produce — full
 * `source → source_location → extract → card` lineage, spread `created_at`/`due_at`,
 * A/B/C/D priorities, concept membership + tags, and (optionally) `vec0` embeddings —
 * but SKIPS the per-row `operation_log` ON PURPOSE (too slow for 1M+ rows; op-log
 * throughput is covered by the per-task transaction tests).
 *
 * `repos` is accepted so the bench can reuse the same handle; the bulk path uses
 * `db` directly. NEVER run this against the user/dev DB — it is for the throwaway
 * bench DB only.
 */
export function seedLargeCollection(
  repos: Repositories,
  db: InterleaveDatabase,
  options: LargeSeedOptions = {},
): LargeSeedStats {
  void repos; // accepted for symmetry with the demo factory; bulk path uses `db`.
  const opts = { ...DEFAULT_LARGE_PROFILE, ...options };
  const seed = options.seed ?? DEFAULT_SEED;
  const asOf = options.asOf ?? DEFAULT_AS_OF;
  const wantEmbeddings = options.embeddings ?? false;
  const rng = makeRng(seed);
  const asOfMs = Date.parse(asOf);
  const start = Date.now();

  const restorePragmas = relaxBenchPragmas(db);
  // Resolve the raw better-sqlite3 handle ONCE; the whole bulk load runs on it via a
  // single transaction with cached prepared statements (the fast path). Typed as the
  // minimal RawDb surface so packages/testing needs no better-sqlite3 dependency.
  const raw = rawSqlite(db) as unknown as RawDb & {
    transaction(fn: () => void): () => void;
  };
  // Drop the FTS5 sync triggers for the load (their per-row DELETE-then-INSERT is the
  // dominant super-linear cost at scale); restore them + bulk-rebuild the index after.
  const restoreFts = deferFtsTriggers(raw);

  // Counters for the stats header.
  let nSources = 0;
  let nExtracts = 0;
  let nCards = 0;
  let nReviewLogs = 0;
  let nEmbeddings = 0;
  let vecRowid = 0;

  // A spread `created_at` ISO some random days back from `asOf`.
  const createdAtFor = (): string =>
    new Date(asOfMs - rng.int(0, CREATED_WINDOW_DAYS) * DAY_MS).toISOString();
  // A `due_at` ISO: ~40% in the past (due now), the rest in the next 30 days.
  const dueAtFor = (): string => {
    const past = rng.next() < 0.4;
    const delta = (past ? -1 : 1) * rng.int(0, past ? 60 : 30) * DAY_MS;
    return new Date(asOfMs + delta).toISOString();
  };

  try {
    raw.transaction(() => {
      // --- concepts (element + concept side-table) + tags ---
      const conceptElementRows: (typeof elements.$inferInsert)[] = [];
      const conceptRows: { id: string; parentConceptId: string | null; name: string }[] = [];
      const conceptIds: string[] = [];
      for (let c = 0; c < opts.conceptCount; c++) {
        const cid = id();
        const created = createdAtFor();
        conceptElementRows.push({
          id: cid,
          type: "concept",
          status: "active",
          stage: "synthesis",
          priority: rng.pick(PRIORITY_BANDS),
          attentionIntervalMultiplier: 1.0,
          title: `Concept ${c}`,
          createdAt: created,
          updatedAt: created,
        });
        conceptRows.push({
          id: cid,
          parentConceptId:
            c > 0 && rng.next() < 0.5 ? (conceptIds[rng.int(0, c - 1)] ?? null) : null,
          name: `Concept ${c}`,
        });
        conceptIds.push(cid);
      }
      batchInsert(raw, elements, conceptElementRows);
      if (conceptRows.length > 0) {
        // `concepts` is not in the testing barrel's destructure; insert via a cached
        // raw prepared statement (the same fast path as `batchInsert`).
        const conceptStmt = raw.prepare(
          "INSERT INTO concepts (id, parent_concept_id, name) VALUES (@id, @parentConceptId, @name)",
        );
        for (const cr of conceptRows) {
          conceptStmt.run({ id: cr.id, parentConceptId: cr.parentConceptId, name: cr.name });
        }
      }

      const tagIds: string[] = [];
      const tagRows: (typeof tags.$inferInsert)[] = [];
      const TAG_COUNT = Math.max(8, Math.floor(opts.conceptCount / 4));
      for (let t = 0; t < TAG_COUNT; t++) {
        const tid = id();
        tagIds.push(tid);
        tagRows.push({ id: tid, name: `tag-${seed}-${t}` });
      }
      batchInsert(raw, tags, tagRows);

      // Row buffers (flushed in batches as they fill, so memory stays bounded).
      let elementBuf: (typeof elements.$inferInsert)[] = [];
      let sourceBuf: (typeof sources.$inferInsert)[] = [];
      let documentBuf: (typeof documents.$inferInsert)[] = [];
      let blockBuf: (typeof documentBlocks.$inferInsert)[] = [];
      let locationBuf: (typeof sourceLocations.$inferInsert)[] = [];
      let cardBuf: (typeof cards.$inferInsert)[] = [];
      let stateBuf: (typeof reviewStates.$inferInsert)[] = [];
      let logBuf: (typeof reviewLogs.$inferInsert)[] = [];
      let relationBuf: (typeof elementRelations.$inferInsert)[] = [];
      let elementTagBuf: (typeof elementTags.$inferInsert)[] = [];
      let embeddingBuf: (typeof embeddingsTable.$inferInsert)[] = [];

      const flush = (): void => {
        if (elementBuf.length) {
          batchInsert(raw, elements, elementBuf);
          elementBuf = [];
        }
        if (sourceBuf.length) {
          batchInsert(raw, sources, sourceBuf);
          sourceBuf = [];
        }
        if (documentBuf.length) {
          batchInsert(raw, documents, documentBuf);
          documentBuf = [];
        }
        if (blockBuf.length) {
          batchInsert(raw, documentBlocks, blockBuf);
          blockBuf = [];
        }
        if (locationBuf.length) {
          batchInsert(raw, sourceLocations, locationBuf);
          locationBuf = [];
        }
        if (cardBuf.length) {
          batchInsert(raw, cards, cardBuf);
          cardBuf = [];
        }
        if (stateBuf.length) {
          batchInsert(raw, reviewStates, stateBuf);
          stateBuf = [];
        }
        if (logBuf.length) {
          batchInsert(raw, reviewLogs, logBuf);
          logBuf = [];
        }
        if (relationBuf.length) {
          batchInsert(raw, elementRelations, relationBuf);
          relationBuf = [];
        }
        if (elementTagBuf.length) {
          batchInsert(raw, elementTags, elementTagBuf);
          elementTagBuf = [];
        }
        if (embeddingBuf.length) {
          batchInsert(raw, embeddingsTable, embeddingBuf);
          embeddingBuf = [];
        }
      };

      // Cached raw prepared statement for the `vec0` virtual table (the `element_vectors`
      // KNN store) — reused across every embedded element when embeddings are seeded.
      // POSITIONAL binding: vec0 requires the rowid to arrive as a plain integer (a
      // named-param `@rowid` is rejected with "Only integers are allowed for primary key").
      const vecStmt = wantEmbeddings
        ? raw.prepare("INSERT INTO element_vectors(rowid, embedding) VALUES (?, ?)")
        : null;
      const upsertVector = (elementId: string, type: EmbeddableType, text: string): void => {
        if (!wantEmbeddings || !vecStmt) return;
        const vec = embedTextLocal(text, EMBEDDING_DIM);
        const blob = vectorToBlob(vec);
        vecRowid += 1;
        // vec0 demands a strict INTEGER rowid; a plain JS number can reach the driver
        // as a REAL, so bind a BigInt (better-sqlite3's unambiguous INTEGER type).
        vecStmt.run(BigInt(vecRowid), blob);
        const created = asOf;
        embeddingBuf.push({
          elementId,
          vecRowid,
          elementType: type,
          modelId: MODEL_ID,
          dim: EMBEDDING_DIM,
          contentHash: `${elementId}-hash`,
          createdAt: created,
          updatedAt: created,
        });
        nEmbeddings += 1;
      };

      for (let s = 0; s < opts.sources; s++) {
        const sourceId = id();
        const created = createdAtFor();
        const sourcePriority = rng.pick(PRIORITY_BANDS);
        const sourceTitle = `Source ${s}: notes on topic ${s % 97}`;
        elementBuf.push({
          id: sourceId,
          type: "source",
          status: rng.next() < 0.1 ? "inbox" : "active",
          stage: "raw_source",
          priority: sourcePriority,
          attentionIntervalMultiplier: 1.0,
          title: sourceTitle,
          dueAt: rng.next() < 0.5 ? dueAtFor() : null,
          createdAt: created,
          updatedAt: created,
        });
        // Realistic dedup fodder: ~5% of sources share a canonical URL with a sibling.
        const canonical =
          rng.next() < 0.05
            ? `https://example.com/shared/${s % 50}`
            : `https://example.com/source/${s}`;
        sourceBuf.push({
          elementId: sourceId,
          url: canonical,
          canonicalUrl: canonical,
          author: `Author ${s % 211}`,
          accessedAt: created,
          sourceType: "article",
        });
        const plain = `${sourceTitle}. ${DEMO_SENTENCES[s % DEMO_SENTENCES.length]} ${DEMO_SENTENCES[(s + 3) % DEMO_SENTENCES.length]}`;
        documentBuf.push({
          elementId: sourceId,
          prosemirrorJson: "{}",
          plainText: plain,
          schemaVersion: 1,
          updatedAt: created,
        });
        const blockId = id();
        blockBuf.push({
          id: blockId,
          documentId: sourceId,
          blockType: "paragraph",
          order: 0,
          stableBlockId: `blk_${s}_0`,
        });
        nSources += 1;
        upsertVector(sourceId, "source", `${sourceTitle} ${plain}`);

        for (let e = 0; e < opts.extractsPerSource; e++) {
          const extractId = id();
          const eCreated = createdAtFor();
          const ePriority = rng.pick(PRIORITY_BANDS);
          const selected = DEMO_SENTENCES[(s + e) % DEMO_SENTENCES.length] as string;
          elementBuf.push({
            id: extractId,
            type: "extract",
            status: "active",
            stage: rng.pick(["raw_extract", "clean_extract", "atomic_statement"] as const),
            priority: ePriority,
            attentionIntervalMultiplier: 1.0,
            title: `Extract ${s}.${e}: ${selected.slice(0, 32)}`,
            parentId: sourceId,
            sourceId,
            dueAt: rng.next() < 0.5 ? dueAtFor() : null,
            createdAt: eCreated,
            updatedAt: eCreated,
          });
          const locationId = id();
          locationBuf.push({
            id: locationId,
            elementId: extractId,
            sourceElementId: sourceId,
            blockIds: JSON.stringify([`blk_${s}_0`]),
            startOffset: 0,
            endOffset: selected.length,
            label: `¶${e}`,
            selectedText: selected,
          });
          nExtracts += 1;
          upsertVector(extractId, "extract", `Extract ${s}.${e} ${selected}`);

          // Concept membership for ~half of extracts (spreads the filter load).
          if (conceptIds.length > 0 && rng.next() < 0.5) {
            relationBuf.push({
              id: id(),
              fromElementId: extractId,
              toElementId: rng.pick(conceptIds),
              relationType: "concept_membership",
              createdAt: eCreated,
            });
          }
          if (tagIds.length > 0 && rng.next() < 0.4) {
            elementTagBuf.push({ elementId: extractId, tagId: rng.pick(tagIds) });
          }

          for (let k = 0; k < opts.cardsPerExtract; k++) {
            const cardId = id();
            const cCreated = createdAtFor();
            const cPriority = rng.pick(PRIORITY_BANDS);
            const isQa = rng.next() < 0.7;
            const prompt = `Q ${s}.${e}.${k}: what is ${selected.slice(0, 24)}?`;
            const answer = selected;
            elementBuf.push({
              id: cardId,
              type: "card",
              status: "active",
              stage: rng.pick(["card_draft", "active_card", "mature_card"] as const),
              priority: cPriority,
              attentionIntervalMultiplier: 1.0,
              title: `Card ${s}.${e}.${k}`,
              parentId: extractId,
              sourceId,
              createdAt: cCreated,
              updatedAt: cCreated,
            });
            cardBuf.push({
              elementId: cardId,
              kind: isQa ? "qa" : "cloze",
              prompt: isQa ? prompt : null,
              answer: isQa ? answer : null,
              cloze: isQa ? null : `The {{c1::${selected.slice(0, 16)}}} matters.`,
              sourceLocationId: locationId,
              isLeech: rng.next() < 0.02,
              isRetired: rng.next() < 0.03,
            });
            // FSRS state — spread due so a realistic fraction is due now.
            const stability = 1 + rng.next() * 90;
            stateBuf.push({
              elementId: cardId,
              dueAt: dueAtFor(),
              stability,
              difficulty: 2 + rng.next() * 6,
              elapsedDays: rng.next() * 30,
              scheduledDays: stability,
              reps: rng.int(1, opts.reviewsPerCard),
              lapses: rng.int(0, 4),
              fsrsState: FSRS_STATES_NEW,
              learningSteps: 0,
              lastReviewedAt: createdAtFor(),
            });
            nCards += 1;
            upsertVector(cardId, "card", `${prompt} ${answer}`);

            if (conceptIds.length > 0 && rng.next() < 0.5) {
              relationBuf.push({
                id: id(),
                fromElementId: cardId,
                toElementId: rng.pick(conceptIds),
                relationType: "concept_membership",
                createdAt: cCreated,
              });
            }

            // Long review history — the ~1M-row knob.
            for (let r = 0; r < opts.reviewsPerCard; r++) {
              const reviewedAt = new Date(
                asOfMs - rng.int(0, CREATED_WINDOW_DAYS) * DAY_MS,
              ).toISOString();
              logBuf.push({
                id: id(),
                elementId: cardId,
                rating: rng.pick(RATINGS),
                reviewedAt,
                responseMs: rng.int(800, 12000),
                prevState: FSRS_STATES_NEW,
                nextState: FSRS_STATES_NEW,
                nextStability: stability,
                nextDifficulty: 5,
                nextDueAt: reviewedAt,
              });
              nReviewLogs += 1;
            }
          }

          // Flush periodically so the row buffers stay bounded in memory.
          if (logBuf.length >= 5000 || elementBuf.length >= 5000) flush();
        }
      }
      flush();
    })();
    // Re-create the FTS triggers + bulk-rebuild the search index (the load dropped
    // them for speed). Runs after the main load commits, still under the relaxed
    // pragmas so the single-pass FTS populate is fast.
    restoreFts();
  } finally {
    restorePragmas();
  }

  // Correctness gate: FK enforcement was deferred during the bulk load for speed, so
  // PROVE the seeded lineage has no dangling reference now that FK is back on. A
  // violation here means the row builders drifted from the schema — fail loudly rather
  // than leave a subtly-broken bench DB. (`foreign_key_check` returns one row per
  // violation; an empty result == clean.)
  const fkViolations = rawSqlite(db).pragma("foreign_key_check") as unknown[];
  if (fkViolations.length > 0) {
    throw new Error(
      `seedLargeCollection produced ${fkViolations.length} foreign-key violation(s) — the bulk row builders drifted from the schema`,
    );
  }

  const buildMs = Date.now() - start;
  const dbSizeBytes = dbFileSize(db);

  return {
    sources: nSources,
    extracts: nExtracts,
    cards: nCards,
    reviewLogs: nReviewLogs,
    reviewStates: nCards,
    concepts: opts.conceptCount,
    tags: Math.max(8, Math.floor(opts.conceptCount / 4)),
    embeddings: nEmbeddings,
    elements: nSources + nExtracts + nCards + opts.conceptCount,
    buildMs,
    dbSizeBytes,
  };
}

/** The raw better-sqlite3 handle behind a Drizzle client. */
function rawSqlite(db: InterleaveDatabase): SqliteDatabase {
  return (db as unknown as { session: { client: SqliteDatabase } }).session.client;
}

/** On-disk size of the DB file + `-wal`, or `null` for in-memory. */
function dbFileSize(db: InterleaveDatabase): number | null {
  const raw = rawSqlite(db);
  const file = raw.name;
  if (!file || file === ":memory:" || file === "") return null;
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += fs.statSync(`${file}${suffix}`).size;
    } catch {
      // file may not exist (e.g. -wal after a checkpoint) — ignore.
    }
  }
  return total;
}

/**
 * Build a SMALL control collection through the REAL repository path (one
 * `source → extract → card` chain with a couple of reviews), proving the bulk fast
 * path writes schema-identical rows. The bench's control test seeds this into a
 * second DB and asserts the same tables/columns are populated and pass every
 * CHECK/FK/NOT-NULL — so the bulk rows are not a fiction.
 *
 * Returns the created element ids so the test can assert lineage.
 */
export function seedSmokeControl(repos: Repositories): {
  sourceId: string;
  extractId: string;
  cardId: string;
} {
  const source = repos.sources.create({
    title: "Control source",
    priority: PRIORITY_LABEL_VALUE.A,
    status: "active",
    url: "https://example.com/control",
    canonicalUrl: "https://example.com/control",
  });
  const sourceId = source.element.id;
  repos.documents.upsert({
    elementId: sourceId,
    prosemirrorJson: "{}",
    plainText: "Control source plain text body for the smoke comparison.",
    blocks: [{ blockType: "paragraph", order: 0, stableBlockId: "blk_ctrl_0" as BlockId }],
  });
  const extract = repos.sources.createExtract({
    sourceElementId: sourceId,
    title: "Control extract",
    priority: PRIORITY_LABEL_VALUE.B,
    selectedText: "Control extract selected text.",
    blockIds: ["blk_ctrl_0" as BlockId],
    startOffset: 0,
    endOffset: 29,
    label: "¶0",
  });
  const extractId = extract.element.id;
  const card = repos.review.createCard({
    kind: "qa",
    title: "Control card",
    priority: PRIORITY_LABEL_VALUE.A,
    prompt: "What is the control?",
    answer: "Control extract selected text.",
    parentId: extractId,
    sourceId,
    sourceLocationId: extract.location.id,
    stage: "active_card",
  });
  repos.review.recordReview(card.element.id, {
    rating: "good",
    reviewedAt: "2026-05-01T00:00:00.000Z" as IsoTimestamp,
    responseMs: 2000,
    prevState: "new",
    nextState: "review",
    nextStability: 10,
    nextDifficulty: 5,
    nextDueAt: "2026-05-15T00:00:00.000Z" as IsoTimestamp,
    elapsedDays: 14,
    scheduledDays: 14,
    reps: 1,
    lapses: 0,
    nextLearningSteps: 0,
  });
  return { sourceId, extractId, cardId: card.element.id };
}

/** A few realistic sentences the seed cycles for source/extract/card body text. */
const DEMO_SENTENCES = [
  "Intelligence is a measure of skill-acquisition efficiency over a scope of tasks.",
  "Spaced repetition schedules reviews at expanding intervals to fight forgetting.",
  "The minimum information principle keeps each card focused on a single fact.",
  "Incremental reading extracts the most valuable fragments from a long source.",
  "Active recall strengthens memory more than passive re-reading of material.",
  "Priority protects fragile high-value knowledge from being crowded out.",
  "Lineage lets every card trace back to its exact source location and context.",
  "Attention scheduling decides when a topic should return for further processing.",
  "FSRS models memory stability and difficulty to schedule the next review.",
  "Distillation turns a rough extract into a clean, atomic, reviewable statement.",
] as const;

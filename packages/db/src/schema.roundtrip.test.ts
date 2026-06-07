/**
 * Schema round-trip tests (T006).
 *
 * These run the generated Drizzle migrations against a TEMPORARY in-memory
 * `better-sqlite3` database (no PGlite), then insert and read back rows for
 * several tables. The centerpiece is the lineage chain — a `source` →
 * `document_blocks` → `extract` + `source_location` → `card` — plus an
 * `operation_log` row, proving the schema preserves source lineage end to end
 * (the load-bearing invariant) and that mutations can be logged from day one.
 *
 * We also assert that foreign keys and the core-derived CHECK constraints are
 * actually enforced, so the DB and the `@interleave/core` vocabulary cannot drift.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cards,
  type DbHandle,
  documentBlocks,
  documents,
  elementRelations,
  elements,
  migrateDatabase,
  openDatabase,
  operationLog,
  reviewLogs,
  reviewStates,
  settings,
  sourceLocations,
  sources,
} from "./index";

const id = (): string => randomUUID();
const now = (): string => new Date("2026-05-29T12:00:00.000Z").toISOString();

let handle: DbHandle;

beforeEach(() => {
  handle = openDatabase(":memory:");
  migrateDatabase(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

describe("schema migration", () => {
  it("creates all M1 base tables (+ the T058 jobs table) from empty", () => {
    // Exclude the T042 FTS5 search index — its virtual tables (source_fts /
    // extract_fts / card_fts) and their auto-created shadow tables (…_data,
    // …_idx, …_content, …_docsize, …_config) all appear as `type='table'` but
    // are M8 search additions, not M1 base tables. The `jobs` table (T058) is the
    // background-runner queue — infra, not part of the M1 element graph.
    const rows = handle.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' AND name NOT LIKE '%fts%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toEqual([
      "ai_suggestions",
      "assets",
      "cards",
      "concepts",
      "document_blocks",
      "document_marks",
      "documents",
      "element_relations",
      "element_tags",
      "elements",
      // T087 embedding bookkeeping (the `element_vectors` vec0 table is created
      // only when sqlite-vec is functional, via the guarded migrator — not here).
      "embeddings",
      "jobs",
      "occlusion_masks",
      "ocr_pages",
      "operation_log",
      "read_points",
      "review_logs",
      "review_states",
      "settings",
      "source_block_processing",
      "source_block_processing_outputs",
      "source_locations",
      "sources",
      "tags",
      "tasks",
    ]);
  });

  it("turns foreign keys on", () => {
    const rows = handle.sqlite.pragma("foreign_keys") as { foreign_keys: number }[];
    expect(rows[0]?.foreign_keys).toBe(1);
  });
});

describe("lineage round-trip: source → blocks → extract + source_location → card", () => {
  it("inserts and reads back a full lineage chain plus an operation_log entry", () => {
    const { db } = handle;

    // 1. The source element + its provenance + body.
    const sourceId = id();
    db.insert(elements)
      .values({
        id: sourceId,
        type: "source",
        status: "active",
        stage: "raw_source",
        priority: 0.625,
        title: "On the Measure of Intelligence",
        parentId: null,
        sourceId: null,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    db.insert(sources)
      .values({
        elementId: sourceId,
        url: "https://arxiv.org/abs/1911.01547",
        canonicalUrl: "https://arxiv.org/abs/1911.01547",
        author: "François Chollet",
        accessedAt: now(),
        reasonAdded: "Foundational ARC paper",
      })
      .run();
    db.insert(documents)
      .values({
        elementId: sourceId,
        prosemirrorJson: JSON.stringify({ type: "doc", content: [] }),
        plainText: "Intelligence is skill-acquisition efficiency.",
        updatedAt: now(),
      })
      .run();

    // 2. A stable document block (the lineage anchor).
    const blockRowId = id();
    const stableBlockId = "blk_intro_1";
    db.insert(documentBlocks)
      .values({
        id: blockRowId,
        documentId: sourceId,
        blockType: "paragraph",
        order: 0,
        stableBlockId,
      })
      .run();

    // 3. An extract element derived from the source.
    const extractId = id();
    db.insert(elements)
      .values({
        id: extractId,
        type: "extract",
        status: "active",
        stage: "raw_extract",
        priority: 0.625,
        title: "Skill-acquisition efficiency",
        parentId: sourceId,
        sourceId,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();

    // 4. The source location anchoring the extract to the exact block.
    const locationId = id();
    db.insert(sourceLocations)
      .values({
        id: locationId,
        elementId: extractId,
        sourceElementId: sourceId,
        blockIds: JSON.stringify([stableBlockId]),
        startOffset: 0,
        endOffset: 44,
        label: "Intro · ¶1",
        selectedText: "Intelligence is skill-acquisition efficiency.",
      })
      .run();

    // 5. A card derived from the extract, pointing back at the source location.
    const cardId = id();
    db.insert(elements)
      .values({
        id: cardId,
        type: "card",
        status: "active",
        stage: "active_card",
        priority: 0.875,
        title: "Definition of intelligence (Chollet)",
        parentId: extractId,
        sourceId,
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    db.insert(cards)
      .values({
        elementId: cardId,
        kind: "qa",
        prompt: "How does Chollet define intelligence?",
        answer: "Skill-acquisition efficiency.",
        sourceLocationId: locationId,
      })
      .run();
    db.insert(reviewStates).values({ elementId: cardId, fsrsState: "new" }).run();

    // 6. A typed lineage edge and an operation-log entry for the mutation.
    db.insert(elementRelations)
      .values({
        id: id(),
        fromElementId: cardId,
        toElementId: extractId,
        relationType: "derived_from",
        siblingGroupId: null,
        createdAt: now(),
      })
      .run();
    db.insert(operationLog)
      .values({
        id: id(),
        opType: "create_card",
        payload: JSON.stringify({ cardId, extractId, sourceLocationId: locationId }),
        elementId: cardId,
        createdAt: now(),
      })
      .run();

    // --- Read the chain back and assert lineage is intact end to end. ---
    const card = db.select().from(cards).where(eq(cards.elementId, cardId)).get();
    expect(card?.sourceLocationId).toBe(locationId);

    const location = db
      .select()
      .from(sourceLocations)
      .where(eq(sourceLocations.id, card?.sourceLocationId ?? ""))
      .get();
    expect(location?.sourceElementId).toBe(sourceId);
    expect(JSON.parse(location?.blockIds ?? "[]")).toEqual([stableBlockId]);

    const block = db
      .select()
      .from(documentBlocks)
      .where(eq(documentBlocks.documentId, location?.sourceElementId ?? ""))
      .get();
    expect(block?.stableBlockId).toBe(stableBlockId);

    const source = db.select().from(sources).where(eq(sources.elementId, sourceId)).get();
    expect(source?.author).toBe("François Chollet");

    const op = db.select().from(operationLog).where(eq(operationLog.elementId, cardId)).get();
    expect(op?.opType).toBe("create_card");
    expect(JSON.parse(op?.payload ?? "{}")).toMatchObject({ cardId, sourceLocationId: locationId });
  });
});

describe("review_logs round-trip", () => {
  it("stores a durable review log row", () => {
    const { db } = handle;
    const cardId = id();
    db.insert(elements)
      .values({
        id: cardId,
        type: "card",
        status: "active",
        stage: "active_card",
        priority: 0.875,
        title: "card",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    const logId = id();
    db.insert(reviewLogs)
      .values({
        id: logId,
        elementId: cardId,
        rating: "good",
        reviewedAt: now(),
        responseMs: 1820,
        promptMs: 640,
        prevState: "new",
        prevDueAt: "2026-05-29T12:00:00.000Z",
        prevStability: 1.2,
        prevDifficulty: 6.3,
        prevElapsedDays: 0,
        prevScheduledDays: 0,
        prevReps: 2,
        prevLapses: 1,
        prevLearningSteps: 1,
        prevLastReviewedAt: "2026-05-28T12:00:00.000Z",
        nextState: "learning",
        nextStability: 3.2,
        nextDifficulty: 5.1,
        nextDueAt: now(),
        nextElapsedDays: 1,
        nextScheduledDays: 2,
        nextReps: 3,
        nextLapses: 1,
        nextLearningSteps: 2,
      })
      .run();
    const log = db.select().from(reviewLogs).where(eq(reviewLogs.id, logId)).get();
    expect(log?.rating).toBe("good");
    expect(log?.promptMs).toBe(640);
    expect(log?.responseMs).toBe(1820);
    expect(log?.prevDueAt).toBe("2026-05-29T12:00:00.000Z");
    expect(log?.prevStability).toBeCloseTo(1.2);
    expect(log?.prevDifficulty).toBeCloseTo(6.3);
    expect(log?.prevReps).toBe(2);
    expect(log?.prevLapses).toBe(1);
    expect(log?.prevLearningSteps).toBe(1);
    expect(log?.prevLastReviewedAt).toBe("2026-05-28T12:00:00.000Z");
    expect(log?.nextStability).toBeCloseTo(3.2);
    expect(log?.nextElapsedDays).toBe(1);
    expect(log?.nextScheduledDays).toBe(2);
    expect(log?.nextReps).toBe(3);
    expect(log?.nextLapses).toBe(1);
    expect(log?.nextLearningSteps).toBe(2);
  });

  it("allows legacy-style review log inserts to omit newly added timing and transition fields", () => {
    const { db } = handle;
    const cardId = id();
    db.insert(elements)
      .values({
        id: cardId,
        type: "card",
        status: "active",
        stage: "active_card",
        priority: 0.875,
        title: "card",
        createdAt: now(),
        updatedAt: now(),
      })
      .run();
    const logId = id();
    db.insert(reviewLogs)
      .values({
        id: logId,
        elementId: cardId,
        rating: "easy",
        reviewedAt: now(),
        responseMs: 900,
        prevState: "new",
        nextState: "review",
        nextStability: 4.5,
        nextDifficulty: 4.2,
        nextDueAt: now(),
      })
      .run();
    const log = db.select().from(reviewLogs).where(eq(reviewLogs.id, logId)).get();
    expect(log?.promptMs).toBeNull();
    expect(log?.prevDueAt).toBeNull();
    expect(log?.prevStability).toBeNull();
    expect(log?.prevDifficulty).toBeNull();
    expect(log?.prevElapsedDays).toBeNull();
    expect(log?.prevScheduledDays).toBeNull();
    expect(log?.prevReps).toBeNull();
    expect(log?.prevLapses).toBeNull();
    expect(log?.prevLearningSteps).toBeNull();
    expect(log?.prevLastReviewedAt).toBeNull();
    expect(log?.nextElapsedDays).toBeNull();
    expect(log?.nextScheduledDays).toBeNull();
    expect(log?.nextReps).toBeNull();
    expect(log?.nextLapses).toBeNull();
    expect(log?.nextLearningSteps).toBeNull();
  });
});

describe("settings key/value round-trip", () => {
  it("stores and reads a JSON-encoded setting", () => {
    const { db } = handle;
    db.insert(settings)
      .values({ key: "daily_review_budget", value: JSON.stringify(50) })
      .run();
    const row = db.select().from(settings).where(eq(settings.key, "daily_review_budget")).get();
    expect(JSON.parse(row?.value ?? "0")).toBe(50);
  });
});

describe("integrity is enforced", () => {
  it("rejects an element with a type outside the core vocabulary (CHECK)", () => {
    expect(() =>
      handle.db
        .insert(elements)
        .values({
          id: id(),
          // Intentionally invalid type (column is `string`) to exercise the CHECK.
          type: "frobnicate",
          status: "active",
          stage: "raw_source",
          priority: 0.5,
          title: "bad",
          createdAt: now(),
          updatedAt: now(),
        })
        .run(),
    ).toThrow();
  });

  it("rejects a priority outside [0,1] (CHECK)", () => {
    expect(() =>
      handle.db
        .insert(elements)
        .values({
          id: id(),
          type: "source",
          status: "active",
          stage: "raw_source",
          priority: 2,
          title: "bad",
          createdAt: now(),
          updatedAt: now(),
        })
        .run(),
    ).toThrow();
  });

  it("rejects a card whose owning element does not exist (foreign key)", () => {
    expect(() =>
      handle.db
        .insert(cards)
        .values({ elementId: id(), kind: "qa", prompt: "orphan", answer: "x" })
        .run(),
    ).toThrow();
  });

  it("rejects an operation_log row with an unknown op_type (CHECK)", () => {
    expect(() =>
      handle.db
        .insert(operationLog)
        .values({
          id: id(),
          // Intentionally invalid op type (column is `string`) to exercise the CHECK.
          opType: "not_a_real_op",
          payload: "{}",
          elementId: null,
          createdAt: now(),
        })
        .run(),
    ).toThrow();
  });
});

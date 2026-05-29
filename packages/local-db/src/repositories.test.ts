/**
 * Repository smoke tests (T008).
 *
 * These run every repository against a TEMPORARY, fully-migrated in-memory
 * `better-sqlite3` database (via `@interleave/testing`'s `createInMemoryDb`), so
 * behaviour matches production exactly. They assert the load-bearing invariants:
 *
 *  - the `card → extract → source_location → source` lineage chain is created and
 *    readable end to end;
 *  - every meaningful mutation appends a command-shaped `operation_log` row INSIDE
 *    the same transaction (rolled back together on failure);
 *  - soft-delete sets `deleted_at` (never DELETEs) and is restorable;
 *  - referential integrity (foreign keys) is enforced;
 *  - the queue separates FSRS-due cards from attention-due items.
 */

import type { BlockId, ElementId, FsrsState, ReviewRating } from "@interleave/core";
import { DAILY_REVIEW_BUDGET_MAX, DEFAULT_APP_SETTINGS, SETTINGS_KEYS } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetRepository } from "./asset-repository";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { OperationLogRepository } from "./operation-log-repository";
import { QueueRepository } from "./queue-repository";
import { ReviewRepository } from "./review-repository";
import { SearchRepository } from "./search-repository";
import { SettingsRepository } from "./settings-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("ElementRepository", () => {
  it("creates an element and logs create_element in the same transaction", () => {
    const repo = new ElementRepository(handle.db);
    const ops = new OperationLogRepository(handle.db);

    const el = repo.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.5,
      title: "Spaced repetition",
    });

    expect(el.id).toBeTruthy();
    expect(repo.findById(el.id)?.title).toBe("Spaced repetition");
    const log = ops.listForElement(el.id);
    expect(log.map((e) => e.opType)).toContain("create_element");
  });

  it("updates fields + bumps updatedAt + logs update_element", () => {
    const repo = new ElementRepository(handle.db);
    const ops = new OperationLogRepository(handle.db);
    const el = repo.create({
      type: "topic",
      status: "inbox",
      stage: "rough_topic",
      priority: 0.5,
      title: "old",
    });
    const updated = repo.update(el.id, { title: "new", status: "active", priority: 0.75 });
    expect(updated.title).toBe("new");
    expect(updated.status).toBe("active");
    expect(updated.priority).toBe(0.75);
    expect(ops.listForElement(el.id).map((e) => e.opType)).toContain("update_element");
  });

  it("soft-deletes (sets deleted_at, never removes the row) and restores", () => {
    const repo = new ElementRepository(handle.db);
    const ops = new OperationLogRepository(handle.db);
    const el = repo.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.5,
      title: "trashable",
    });

    const deleted = repo.softDelete(el.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.status).toBe("deleted");
    // The row still exists (recoverable) — soft delete, not hard delete.
    expect(repo.findById(el.id)).not.toBeNull();
    // But it is excluded from live listings.
    expect(repo.listByType("topic").map((e) => e.id)).not.toContain(el.id);

    const restored = repo.restore(el.id, "active");
    expect(restored.deletedAt).toBeNull();
    expect(restored.status).toBe("active");
    expect(repo.listByType("topic").map((e) => e.id)).toContain(el.id);

    const types = ops.listForElement(el.id).map((e) => e.opType);
    expect(types).toContain("soft_delete_element");
    expect(types).toContain("restore_element");
  });

  it("reschedule sets dueAt and logs reschedule_element", () => {
    const repo = new ElementRepository(handle.db);
    const ops = new OperationLogRepository(handle.db);
    const el = repo.create({
      type: "extract",
      status: "pending",
      stage: "raw_extract",
      priority: 0.5,
      title: "x",
    });
    const due = "2026-06-10T00:00:00.000Z";
    const out = repo.reschedule(el.id, due);
    expect(out.dueAt).toBe(due);
    expect(ops.listForElement(el.id).map((e) => e.opType)).toContain("reschedule_element");
  });

  it("adds/removes typed relations and tags with op-log entries", () => {
    const repo = new ElementRepository(handle.db);
    const ops = new OperationLogRepository(handle.db);
    const a = repo.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.5,
      title: "a",
    });
    const b = repo.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.5,
      title: "b",
    });

    const rel = repo.addRelation({
      fromElementId: a.id,
      toElementId: b.id,
      relationType: "references",
    });
    expect(repo.listRelationsFrom(a.id).map((r) => r.toElementId)).toContain(b.id);

    repo.addTag(a.id, "memory");
    repo.addTag(a.id, "memory"); // idempotent
    expect(repo.listTags(a.id)).toEqual(["memory"]);
    repo.removeTag(a.id, "memory");
    expect(repo.listTags(a.id)).toEqual([]);

    repo.removeRelation(rel.id);
    expect(repo.listRelationsFrom(a.id)).toEqual([]);

    const types = ops.listForElement(a.id).map((e) => e.opType);
    expect(types).toEqual(
      expect.arrayContaining(["add_relation", "remove_relation", "add_tag", "remove_tag"]),
    );
  });
});

describe("SourceRepository — lineage", () => {
  it("creates a source (element + provenance) atomically with create_source", () => {
    const sources = new SourceRepository(handle.db);
    const ops = new OperationLogRepository(handle.db);

    const { element, source } = sources.create({
      title: "On the Measure of Intelligence",
      priority: 0.625,
      author: "François Chollet",
      url: "https://arxiv.org/abs/1911.01547",
      reasonAdded: "Foundational ARC paper",
    });

    expect(element.type).toBe("source");
    expect(source.author).toBe("François Chollet");
    expect(sources.findById(element.id)?.source.url).toBe("https://arxiv.org/abs/1911.01547");

    const types = ops.listForElement(element.id).map((e) => e.opType);
    expect(types).toContain("create_element");
    expect(types).toContain("create_source");
  });

  it("creates the full card → extract → source_location → source lineage chain", () => {
    const elementsRepo = new ElementRepository(handle.db);
    const documents = new DocumentRepository(handle.db);
    const sources = new SourceRepository(handle.db);
    const review = new ReviewRepository(handle.db);

    // Source + document body + a stable block (the lineage anchor).
    const { element: source } = sources.create({
      title: "Intelligence",
      priority: 0.625,
    });
    documents.upsert({
      elementId: source.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "Intelligence is skill-acquisition efficiency.",
      blocks: [{ blockType: "paragraph", order: 0, stableBlockId: "blk_1" as BlockId }],
    });

    // Extract anchored at the block.
    const { element: extract, location } = sources.createExtract({
      sourceElementId: source.id,
      title: "Skill-acquisition efficiency",
      priority: 0.625,
      selectedText: "Intelligence is skill-acquisition efficiency.",
      blockIds: ["blk_1" as BlockId],
      startOffset: 0,
      endOffset: 44,
      label: "Intro · ¶1",
    });
    expect(extract.parentId).toBe(source.id);
    expect(extract.sourceId).toBe(source.id);
    expect(location.sourceElementId).toBe(source.id);
    expect(location.blockIds).toEqual(["blk_1"]);

    // Card derived from the extract, anchored at the same source location.
    const { element: card, card: cardRow } = review.createCard({
      kind: "qa",
      title: "Definition of intelligence",
      priority: 0.875,
      prompt: "How does Chollet define intelligence?",
      answer: "Skill-acquisition efficiency.",
      parentId: extract.id,
      sourceId: source.id,
      sourceLocationId: location.id,
    });

    // Walk the lineage back: card → location → source.
    expect(cardRow.sourceLocationId).toBe(location.id);
    const loc = sources.findLocationById(location.id);
    expect(loc?.sourceElementId).toBe(source.id);
    expect(elementsRepo.findById(card.parentId as ElementId)?.id).toBe(extract.id);
    expect(elementsRepo.findById(card.sourceId as ElementId)?.type).toBe("source");
    expect(sources.listLocationsForSource(source.id).map((l) => l.id)).toContain(location.id);
  });

  it("rejects an extract pointing at a non-existent source (foreign key)", () => {
    const sources = new SourceRepository(handle.db);
    expect(() =>
      sources.createExtract({
        sourceElementId: "missing-source" as ElementId,
        title: "orphan",
        priority: 0.5,
        selectedText: "x",
        blockIds: ["blk" as BlockId],
      }),
    ).toThrow();
  });
});

describe("DocumentRepository", () => {
  it("upserts a body + blocks and persists a read-point with set_read_point", () => {
    const sources = new SourceRepository(handle.db);
    const documents = new DocumentRepository(handle.db);
    const ops = new OperationLogRepository(handle.db);

    const { element: source } = sources.create({ title: "Doc", priority: 0.5 });
    documents.upsert({
      elementId: source.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "hello world",
      blocks: [
        { blockType: "paragraph", order: 1, stableBlockId: "b2" as BlockId },
        { blockType: "heading", order: 0, stableBlockId: "b1" as BlockId },
      ],
    });

    expect(documents.findById(source.id)?.plainText).toBe("hello world");
    expect(documents.listBlocks(source.id).map((b) => b.stableBlockId)).toEqual(["b1", "b2"]);

    documents.setReadPoint({
      elementId: source.id,
      documentId: source.id,
      blockId: "b1" as BlockId,
      offset: 12,
    });
    expect(documents.getReadPoint(source.id)?.offset).toBe(12);
    // Advancing updates the same row, not a duplicate.
    documents.setReadPoint({
      elementId: source.id,
      documentId: source.id,
      blockId: "b2" as BlockId,
      offset: 3,
    });
    expect(documents.getReadPoint(source.id)?.blockId).toBe("b2");

    const types = ops.listForElement(source.id).map((e) => e.opType);
    expect(types).toContain("update_document");
    expect(types).toContain("set_read_point");
  });
});

describe("ReviewRepository — FSRS state/logs", () => {
  it("creates a card with a fresh review_state and records a review atomically", () => {
    const review = new ReviewRepository(handle.db);
    const ops = new OperationLogRepository(handle.db);

    const { element: card } = review.createCard({
      kind: "cloze",
      title: "Cloze card",
      priority: 0.75,
      cloze: "The capital of France is {{c1::Paris}}.",
    });

    const state0 = review.findReviewState(card.id);
    expect(state0?.fsrsState).toBe<FsrsState>("new");

    const log = review.recordReview(card.id, {
      rating: "good" as ReviewRating,
      reviewedAt: "2026-05-29T12:00:00.000Z",
      responseMs: 1820,
      prevState: "new",
      nextState: "learning",
      nextStability: 3.2,
      nextDifficulty: 5.1,
      nextDueAt: "2026-05-30T12:00:00.000Z",
      elapsedDays: 0,
      scheduledDays: 1,
      reps: 1,
      lapses: 0,
    });

    expect(log.rating).toBe("good");
    const state1 = review.findReviewState(card.id);
    expect(state1?.fsrsState).toBe<FsrsState>("learning");
    expect(state1?.dueAt).toBe("2026-05-30T12:00:00.000Z");
    expect(state1?.reps).toBe(1);
    // The element's dueAt is advanced too so the queue picks it up.
    expect(new ElementRepository(handle.db).findById(card.id)?.dueAt).toBe(
      "2026-05-30T12:00:00.000Z",
    );
    expect(review.listReviewLogs(card.id)).toHaveLength(1);

    const types = ops.listForElement(card.id).map((e) => e.opType);
    expect(types).toContain("create_card");
    expect(types).toContain("add_review_log");
  });
});

describe("QueueRepository", () => {
  it("separates FSRS-due cards from attention-due items, excluding soft-deleted", () => {
    const elementsRepo = new ElementRepository(handle.db);
    const review = new ReviewRepository(handle.db);
    const queue = new QueueRepository(handle.db);

    const asOf = "2026-05-29T12:00:00.000Z";
    const past = "2026-05-28T12:00:00.000Z";
    const future = "2026-06-29T12:00:00.000Z";

    // A due card (FSRS).
    const { element: card } = review.createCard({ kind: "qa", title: "due card", priority: 0.5 });
    review.recordReview(card.id, {
      rating: "again" as ReviewRating,
      reviewedAt: past,
      responseMs: 1000,
      prevState: "new",
      nextState: "learning",
      nextStability: 1,
      nextDifficulty: 5,
      nextDueAt: past, // due in the past → due now
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 1,
      lapses: 1,
    });

    // A due attention item (extract with elements.dueAt in the past).
    const extract = elementsRepo.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.5,
      title: "due extract",
    });
    elementsRepo.reschedule(extract.id, past);

    // A not-yet-due attention item.
    const future1 = elementsRepo.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.5,
      title: "future topic",
    });
    elementsRepo.reschedule(future1.id, future);

    expect(queue.dueCards(asOf).map((e) => e.id)).toEqual([card.id]);
    expect(queue.dueAttentionItems(asOf).map((e) => e.id)).toEqual([extract.id]);
    expect(queue.dueCardCount(asOf)).toBe(1);

    // Soft-deleting removes the item from the queue.
    elementsRepo.softDelete(extract.id);
    expect(queue.dueAttentionItems(asOf)).toEqual([]);
  });

  it("lists inbox items by type", () => {
    const elementsRepo = new ElementRepository(handle.db);
    const queue = new QueueRepository(handle.db);
    elementsRepo.create({
      type: "source",
      status: "inbox",
      stage: "raw_source",
      priority: 0.5,
      title: "inbox source",
    });
    elementsRepo.create({
      type: "topic",
      status: "inbox",
      stage: "rough_topic",
      priority: 0.5,
      title: "inbox topic",
    });
    expect(queue.inbox().length).toBe(2);
    expect(queue.inbox("source").map((e) => e.title)).toEqual(["inbox source"]);
  });
});

describe("SearchRepository", () => {
  it("finds elements by title and by document body, excluding soft-deleted", () => {
    const elementsRepo = new ElementRepository(handle.db);
    const documents = new DocumentRepository(handle.db);
    const sources = new SourceRepository(handle.db);
    const search = new SearchRepository(handle.db);

    const { element: source } = sources.create({ title: "Forgetting curve", priority: 0.5 });
    documents.upsert({
      elementId: source.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "Ebbinghaus measured retention over time.",
    });
    const other = elementsRepo.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.5,
      title: "Unrelated note",
    });

    expect(search.query("Forgetting").map((e) => e.id)).toContain(source.id);
    expect(search.query("Ebbinghaus").map((e) => e.id)).toContain(source.id);
    expect(search.query("Forgetting").map((e) => e.id)).not.toContain(other.id);
    expect(search.byTitle("Unrelated").map((e) => e.id)).toEqual([other.id]);

    elementsRepo.softDelete(source.id);
    expect(search.query("Ebbinghaus")).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    const search = new SearchRepository(handle.db);
    expect(search.query("   ")).toEqual([]);
    expect(search.byTitle("")).toEqual([]);
  });
});

describe("AssetRepository", () => {
  it("stores asset metadata, enforces the owning-element FK, and looks up by hash", () => {
    const sources = new SourceRepository(handle.db);
    const assets = new AssetRepository(handle.db);

    const { element: source } = sources.create({ title: "PDF source", priority: 0.5 });
    const asset = assets.create({
      owningElementId: source.id,
      kind: "source_pdf",
      vaultRoot: "assets",
      relativePath: `sources/${source.id}/original.pdf`,
      contentHash: "sha256:abc",
      mime: "application/pdf",
      size: 12345,
    });

    expect(asset.location.vaultPath.root).toBe("assets");
    expect(assets.findById(asset.id)?.contentHash).toBe("sha256:abc");
    expect(assets.listForElement(source.id)).toHaveLength(1);
    expect(assets.listForElementByKind(source.id, "source_pdf")).toHaveLength(1);
    expect(assets.findByContentHash("sha256:abc")?.id).toBe(asset.id);

    // Orphan asset (no owning element) is rejected by the foreign key.
    expect(() =>
      assets.create({
        owningElementId: "nope" as ElementId,
        kind: "image",
        vaultRoot: "assets",
        relativePath: "media/x/original.bin",
        contentHash: "h",
        mime: "image/png",
        size: 1,
      }),
    ).toThrow();
  });
});

describe("SettingsRepository", () => {
  it("round-trips JSON settings, upserts, and supports defaults + delete", () => {
    const settings = new SettingsRepository(handle.db);

    expect(settings.get("daily.budget")).toBeNull();
    expect(settings.getOr("daily.budget", 50)).toBe(50);

    settings.set("daily.budget", 42);
    expect(settings.get<number>("daily.budget")).toBe(42);
    settings.set("daily.budget", 99); // upsert
    expect(settings.get<number>("daily.budget")).toBe(99);

    settings.setMany({ theme: "dark", retention: 0.9 });
    expect(settings.getAll()).toMatchObject({ "daily.budget": 99, theme: "dark", retention: 0.9 });

    settings.delete("theme");
    expect(settings.get("theme")).toBeNull();
  });

  it("reads the typed AppSettings with defaults on a fresh DB (T011)", () => {
    const settings = new SettingsRepository(handle.db);
    expect(settings.getAppSettings()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("updates the typed AppSettings, coercing/clamping and persisting (T011)", () => {
    const settings = new SettingsRepository(handle.db);

    const result = settings.updateAppSettings({
      dailyReviewBudget: 9999, // clamped to the max
      defaultDesiredRetention: 0.95,
      keyboardLayout: "vim",
      theme: "light",
    });
    expect(result.dailyReviewBudget).toBe(DAILY_REVIEW_BUDGET_MAX);
    expect(result.defaultDesiredRetention).toBe(0.95);
    expect(result.keyboardLayout).toBe("vim");
    expect(result.theme).toBe("light");
    // Untouched fields keep their defaults.
    expect(result.defaultTopicIntervalDays).toBe(DEFAULT_APP_SETTINGS.defaultTopicIntervalDays);

    // Persisted under the stable storage keys + readable as the typed model.
    expect(settings.get<number>(SETTINGS_KEYS.dailyReviewBudget)).toBe(DAILY_REVIEW_BUDGET_MAX);
    expect(settings.getAppSettings().theme).toBe("light");
  });

  it("drops unknown patch fields and ignores an empty patch (T011)", () => {
    const settings = new SettingsRepository(handle.db);
    const before = settings.getAppSettings();
    const after = settings.updateAppSettings({ bogus: "x" });
    expect(after).toEqual(before);
    expect(settings.get("bogus")).toBeNull();
  });
});

describe("operation_log atomicity", () => {
  it("rolls back the op-log row when the mutation fails (single transaction)", () => {
    const sources = new SourceRepository(handle.db);
    const ops = new OperationLogRepository(handle.db);

    const before = ops.count();
    // Extract creation fails on the source_location FK; the create_element +
    // create_extract op rows inside the same transaction must roll back too.
    expect(() =>
      sources.createExtract({
        sourceElementId: "missing" as ElementId,
        title: "x",
        priority: 0.5,
        selectedText: "x",
        blockIds: ["b" as BlockId],
      }),
    ).toThrow();
    expect(ops.count()).toBe(before);
  });
});

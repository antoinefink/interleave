/**
 * Demo-collection factory tests (T009).
 *
 * These prove the SHARED factory the `pnpm seed` dev DB and Playwright reuse is
 * correct and deterministic: it builds the full lineage through the repositories,
 * appends the right `operation_log` ops, and produces the exact fixed content
 * every run. A passing test here means the seeded dev database is trustworthy.
 */

import type { DbHandle } from "@interleave/db";
import { createRepositories, OperationLogRepository } from "@interleave/local-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDb } from "./db";
import { DEMO_FIXTURES, type DemoCollection, seedDemoCollection } from "./factories";

let handle: DbHandle;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

function seed(): { collection: DemoCollection; repos: ReturnType<typeof createRepositories> } {
  const repos = createRepositories(handle.db);
  const collection = seedDemoCollection(repos, handle.db);
  return { collection, repos };
}

describe("seedDemoCollection", () => {
  it("creates a source with a 4-block document body and a read-point", () => {
    const { collection, repos } = seed();
    const sourceId = collection.source.element.id;

    expect(collection.source.element.type).toBe("source");
    expect(collection.source.source.author).toBe(DEMO_FIXTURES.source.author);

    const doc = repos.documents.findById(sourceId);
    expect(doc?.plainText).toContain("skill-acquisition efficiency");
    expect(repos.documents.listBlocks(sourceId).map((b) => b.stableBlockId)).toEqual(
      DEMO_FIXTURES.blocks.map((b) => b.stableBlockId),
    );

    const readPoint = repos.documents.getReadPoint(sourceId);
    expect(readPoint?.blockId).toBe(DEMO_FIXTURES.readPoint.blockId);
  });

  it("advances the extract through raw → clean → atomic and creates a sub-extract", () => {
    const { collection, repos } = seed();
    const extract = repos.elements.findById(collection.extract.element.id);
    // The extract is created as raw_extract, then advanced to atomic_statement.
    expect(extract?.stage).toBe("atomic_statement");

    const sub = repos.elements.findById(collection.subExtract.element.id);
    // Lineage: source → extract → sub-extract.
    expect(sub?.parentId).toBe(collection.extract.element.id);
    expect(sub?.sourceId).toBe(collection.source.element.id);
  });

  it("creates the full card → extract → source_location → source lineage", () => {
    const { collection, repos } = seed();
    const sourceId = collection.source.element.id;
    const extractId = collection.extract.element.id;
    const locationId = collection.extract.location.id;

    // Both cards anchor at the extract's source location.
    expect(collection.qaCard.card.sourceLocationId).toBe(locationId);
    expect(collection.clozeCard.card.sourceLocationId).toBe(locationId);
    expect(collection.qaCard.card.kind).toBe("qa");
    expect(collection.clozeCard.card.kind).toBe("cloze");

    // Walk the lineage back: card → location → source.
    const location = repos.sources.findLocationById(locationId);
    expect(location?.sourceElementId).toBe(sourceId);
    expect(location?.elementId).toBe(extractId);

    const qa = repos.elements.findById(collection.qaCard.element.id);
    expect(qa?.parentId).toBe(extractId);
    expect(repos.elements.findById(qa?.sourceId ?? ("x" as never))?.type).toBe("source");
  });

  it("groups the two cards as siblings and records two reviews on the Q&A card", () => {
    const { collection, repos } = seed();

    const relations = repos.elements.listRelationsFrom(collection.qaCard.element.id);
    const sibling = relations.find((r) => r.relationType === "sibling_group");
    expect(sibling?.toElementId).toBe(collection.clozeCard.element.id);
    expect(sibling?.siblingGroupId).toBe(collection.siblingGroupId);

    const logs = repos.review.listReviewLogs(collection.qaCard.element.id);
    expect(logs).toHaveLength(2);
    const state = repos.review.findReviewState(collection.qaCard.element.id);
    expect(state?.fsrsState).toBe("review");
    expect(state?.reps).toBe(2);

    // The cloze card stays brand-new (no reviews recorded against it).
    expect(repos.review.findReviewState(collection.clozeCard.element.id)?.fsrsState).toBe("new");
  });

  it("creates hierarchical concepts with membership edges and tags on the extract", () => {
    const { collection, repos } = seed();

    const parent = repos.elements.findById(collection.concepts.parentConceptId);
    const child = repos.elements.findById(collection.concepts.childConceptId);
    expect(parent?.type).toBe("concept");
    expect(child?.type).toBe("concept");

    const membership = repos.elements
      .listRelationsFrom(collection.extract.element.id)
      .find((r) => r.relationType === "concept_membership");
    expect(membership?.toElementId).toBe(collection.concepts.childConceptId);

    expect(repos.elements.listTags(collection.extract.element.id).sort()).toEqual(
      [...DEMO_FIXTURES.tags].sort(),
    );
  });

  it("stores asset metadata pointing at vault paths/hashes (no blobs)", () => {
    const { collection, repos } = seed();
    const assets = repos.assets.listForElement(collection.source.element.id);
    expect(assets).toHaveLength(2);
    expect(assets.map((a) => a.kind).sort()).toEqual(["snapshot", "source_pdf"]);
    for (const asset of assets) {
      expect(asset.location.vaultPath.root).toBe("assets");
      expect(asset.location.vaultPath.relativePath).toContain(collection.source.element.id);
      expect(asset.contentHash.startsWith("sha256:")).toBe(true);
    }
  });

  it("writes dev settings and a second inbox source for triage variety", () => {
    const { collection, repos } = seed();
    expect(repos.settings.get<number>("review.dailyBudget")).toBe(
      DEMO_FIXTURES.settings["review.dailyBudget"],
    );
    expect(repos.settings.get<string>("ui.theme")).toBe(DEMO_FIXTURES.settings["ui.theme"]);

    expect(collection.inboxSource.element.status).toBe("inbox");
    expect(repos.queue.inbox("source").map((e) => e.id)).toContain(
      collection.inboxSource.element.id,
    );
  });

  it("appends operation_log entries for every meaningful mutation", () => {
    const { collection } = seed();
    const ops = new OperationLogRepository(handle.db);

    // Source lineage.
    const sourceOps = ops.listForElement(collection.source.element.id).map((o) => o.opType);
    expect(sourceOps).toEqual(
      expect.arrayContaining([
        "create_element",
        "create_source",
        "update_document",
        "set_read_point",
      ]),
    );

    // Extract lineage.
    const extractOps = ops.listForElement(collection.extract.element.id).map((o) => o.opType);
    expect(extractOps).toEqual(
      expect.arrayContaining([
        "create_element",
        "create_extract",
        "update_element",
        "add_tag",
        "add_relation",
      ]),
    );

    // Card lineage + reviews.
    const qaOps = ops.listForElement(collection.qaCard.element.id).map((o) => o.opType);
    expect(qaOps).toEqual(expect.arrayContaining(["create_card", "add_review_log"]));

    // The whole seed produces a healthy op-log (lower bound, not exact).
    expect(ops.count()).toBeGreaterThan(15);
  });

  it("is deterministic in content across two independent seeds", () => {
    const repos1 = createRepositories(handle.db);
    const c1 = seedDemoCollection(repos1, handle.db);

    const handle2 = createInMemoryDb();
    try {
      const repos2 = createRepositories(handle2.db);
      const c2 = seedDemoCollection(repos2, handle2.db);

      // Ids differ (domain-generated UUIDs) but content is identical.
      expect(c1.source.element.title).toBe(c2.source.element.title);
      expect(c1.qaCard.card.prompt).toBe(c2.qaCard.card.prompt);
      expect(c1.extract.location.selectedText).toBe(c2.extract.location.selectedText);
      expect(c1.extract.location.blockIds).toEqual(c2.extract.location.blockIds);
    } finally {
      handle2.sqlite.close();
    }
  });
});

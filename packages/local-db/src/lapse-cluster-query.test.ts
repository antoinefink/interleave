import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, reviewLogs, sourceLocations } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { newReviewLogId, newSourceLocationId } from "./ids";
import { LapseClusterQuery } from "./lapse-cluster-query";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

const AS_OF = "2026-06-12T12:00:00.000Z" as IsoTimestamp;
const PRIORITY = 0.5;
// Deterministic thresholds for tests (the production defaults are 5/30/2).
const OPTS = { asOf: AS_OF, minLapses: 5, windowDays: 30, minCards: 2 } as const;

function daysAgo(days: number): IsoTimestamp {
  return new Date(Date.parse(AS_OF) - days * 86_400_000).toISOString() as IsoTimestamp;
}

function seedSource(title: string): ElementId {
  return new ElementRepository(handle.db).create({
    type: "source",
    status: "active",
    stage: "raw_source",
    priority: PRIORITY,
    title,
  }).id;
}

/** Seed an extract; optionally anchor it into `anchorInto` via a source_locations row. */
function seedExtract(options: {
  parentId: ElementId;
  sourceId: ElementId;
  anchorInto?: ElementId;
  blockIds?: string[];
  label?: string | null;
  deletedAt?: IsoTimestamp | null;
}): ElementId {
  const repo = new ElementRepository(handle.db);
  const extract = repo.create({
    type: "extract",
    status: "active",
    stage: "raw_extract",
    priority: PRIORITY,
    title: "Extract",
    parentId: options.parentId,
    sourceId: options.sourceId,
  });
  if (options.anchorInto) {
    handle.db
      .insert(sourceLocations)
      .values({
        id: newSourceLocationId(),
        elementId: extract.id,
        sourceElementId: options.anchorInto,
        blockIds: JSON.stringify(options.blockIds ?? ["blk-1"]),
        label: options.label === undefined ? "Chapter 2 · ¶4" : options.label,
        selectedText: "selected text",
      })
      .run();
  }
  if (options.deletedAt) {
    handle.db
      .update(elements)
      .set({ deletedAt: options.deletedAt, status: "deleted" })
      .where(eq(elements.id, extract.id))
      .run();
  }
  return extract.id;
}

function seedCard(options: {
  parentId: ElementId;
  sourceId: ElementId | null;
  status?: "active" | "scheduled" | "suspended";
  retired?: boolean;
  prompt?: string;
}): ElementId {
  const repo = new ElementRepository(handle.db);
  const card = repo.create({
    type: "card",
    status: options.status ?? "active",
    stage: "active_card",
    priority: PRIORITY,
    title: "Card",
    parentId: options.parentId,
    ...(options.sourceId ? { sourceId: options.sourceId } : {}),
  });
  handle.db
    .insert(cards)
    .values({
      elementId: card.id,
      kind: "qa",
      prompt: options.prompt ?? "Prompt",
      isRetired: options.retired ?? false,
    })
    .run();
  return card.id;
}

function seedLapse(
  cardId: ElementId,
  reviewedAt: IsoTimestamp,
  prevLapses: number,
  nextLapses: number,
  marker = false,
): void {
  handle.db
    .insert(reviewLogs)
    .values({
      id: newReviewLogId(),
      elementId: cardId,
      rating: marker ? "good" : "again",
      reviewedAt,
      responseMs: 1000,
      prevState: "review",
      nextState: marker ? "review" : "relearning",
      nextStability: 1,
      nextDifficulty: 5,
      nextDueAt: reviewedAt,
      prevLapses,
      nextLapses,
      ...(marker
        ? { editMarkerAt: reviewedAt, editClass: "substantive", editChoice: "re_stabilize" }
        : {}),
    })
    .run();
}

/** Two in-window lapse increments for a card (total 2). */
function seedTwoLapses(cardId: ElementId): void {
  seedLapse(cardId, daysAgo(2), 0, 1);
  seedLapse(cardId, daysAgo(1), 1, 2);
}

function tableRowCounts(): Record<string, number> {
  const names = handle.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  const counts: Record<string, number> = {};
  for (const { name } of names) {
    const row = handle.sqlite.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number };
    counts[name] = row.n;
  }
  return counts;
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("LapseClusterQuery.list", () => {
  it("finds one cluster naming the right region and members for sibling failures", () => {
    const source = seedSource("The Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a = seedCard({ parentId: extract, sourceId: source, prompt: "A" });
    const b = seedCard({ parentId: extract, sourceId: source, prompt: "B" });
    const c = seedCard({ parentId: extract, sourceId: source, prompt: "C" });
    seedTwoLapses(a);
    seedTwoLapses(b);
    seedTwoLapses(c); // total 6 >= K=5, 3 cards >= 2

    const clusters = new LapseClusterQuery(handle.db).list(OPTS);
    expect(clusters).toHaveLength(1);
    const [cluster] = clusters;
    if (!cluster) throw new Error("expected one cluster");
    expect(cluster.ancestorId).toBe(extract);
    expect(cluster.sourceId).toBe(source);
    expect(cluster.sourceTitle).toBe("The Source");
    expect(cluster.region.label).toBe("Chapter 2 · ¶4");
    expect(cluster.region.blockIds).toEqual(["blk-1"]);
    expect(cluster.affectedCardCount).toBe(3);
    expect(cluster.totalWindowLapses).toBe(6);
    expect(cluster.members.map((m) => m.cardId).sort()).toEqual([a, b, c].sort());
    expect(cluster.members.every((m) => m.windowLapseCount === 2)).toBe(true);
    expect(cluster.strength).toBeGreaterThan(0);
  });

  it("clusters cards from an atomic-statement intermediary together with direct siblings", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    // Atomic statement: an extract child of `extract`, NO source anchor of its own.
    const atomic = seedExtract({ parentId: extract, sourceId: source });
    const d1 = seedCard({ parentId: extract, sourceId: source });
    const d2 = seedCard({ parentId: extract, sourceId: source });
    const d3 = seedCard({ parentId: extract, sourceId: source });
    const s1 = seedCard({ parentId: atomic, sourceId: source });
    const s2 = seedCard({ parentId: atomic, sourceId: source });
    for (const card of [d1, d2, d3, s1, s2]) seedLapse(card, daysAgo(1), 0, 1); // 5 cards x 1

    const clusters = new LapseClusterQuery(handle.db).list(OPTS);
    expect(clusters).toHaveLength(1);
    const [cluster] = clusters;
    if (!cluster) throw new Error("expected one cluster");
    expect(cluster.ancestorId).toBe(extract);
    expect(cluster.affectedCardCount).toBe(5);
    expect(cluster.totalWindowLapses).toBe(5);
  });

  it("does not surface below the lapse-count floor", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a = seedCard({ parentId: extract, sourceId: source });
    const b = seedCard({ parentId: extract, sourceId: source });
    seedLapse(a, daysAgo(1), 0, 2); // 2
    seedLapse(b, daysAgo(1), 0, 2); // 2 -> total 4 < K=5
    expect(new LapseClusterQuery(handle.db).list(OPTS)).toEqual([]);
  });

  it("does not surface a single-card pile of lapses", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a = seedCard({ parentId: extract, sourceId: source });
    seedLapse(a, daysAgo(1), 0, 6); // 6 lapses, ONE card
    expect(new LapseClusterQuery(handle.db).list(OPTS)).toEqual([]);
  });

  it("ignores lapses outside the window", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a = seedCard({ parentId: extract, sourceId: source });
    const b = seedCard({ parentId: extract, sourceId: source });
    seedLapse(a, daysAgo(40), 0, 3);
    seedLapse(b, daysAgo(35), 0, 3);
    expect(new LapseClusterQuery(handle.db).list(OPTS)).toEqual([]);
  });

  it("excludes T125 marker rows even when they reach the floor", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a = seedCard({ parentId: extract, sourceId: source });
    const b = seedCard({ parentId: extract, sourceId: source });
    seedLapse(a, daysAgo(1), 0, 5, true); // marker, fabricated +5
    seedLapse(b, daysAgo(1), 0, 5, true); // marker, fabricated +5
    expect(new LapseClusterQuery(handle.db).list(OPTS)).toEqual([]);
  });

  it("excludes retired members (current-status filter)", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const live = seedCard({ parentId: extract, sourceId: source });
    const retired = seedCard({ parentId: extract, sourceId: source, retired: true });
    seedLapse(live, daysAgo(1), 0, 3);
    seedLapse(retired, daysAgo(1), 0, 3); // would push to 2 cards / 6 lapses but is retired
    // Only the live card remains: 1 card, below minCards.
    expect(new LapseClusterQuery(handle.db).list(OPTS)).toEqual([]);
  });

  it("suppresses a cluster whose source-region ancestor is tombstoned", () => {
    const source = seedSource("Source");
    const extract = seedExtract({
      parentId: source,
      sourceId: source,
      anchorInto: source,
      deletedAt: daysAgo(1),
    });
    const a = seedCard({ parentId: extract, sourceId: source });
    const b = seedCard({ parentId: extract, sourceId: source });
    seedTwoLapses(a);
    seedTwoLapses(b);
    seedLapse(a, daysAgo(3), 2, 3); // push above floor
    expect(new LapseClusterQuery(handle.db).list(OPTS)).toEqual([]);
  });

  it("does not over-cluster: cards under distinct extracts of one source stay separate", () => {
    const source = seedSource("Source");
    // 6 cards, each under its OWN extract (1 card per extract -> below minCards).
    for (let i = 0; i < 6; i += 1) {
      const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
      const card = seedCard({ parentId: extract, sourceId: source });
      seedLapse(card, daysAgo(1), 0, 3);
    }
    expect(new LapseClusterQuery(handle.db).list(OPTS)).toEqual([]);
  });

  it("excludes sourceless / lineage-wiped cards without crashing", () => {
    const source = seedSource("Source");
    // Cards with a null parent (Anki / migration-0030 wiped) — no shared ancestor.
    const orphanA = new ElementRepository(handle.db).create({
      type: "card",
      status: "active",
      stage: "active_card",
      priority: PRIORITY,
      title: "Orphan",
    }).id;
    handle.db.insert(cards).values({ elementId: orphanA, kind: "qa", isRetired: false }).run();
    seedLapse(orphanA, daysAgo(1), 0, 6);
    expect(() => new LapseClusterQuery(handle.db).list(OPTS)).not.toThrow();
    expect(new LapseClusterQuery(handle.db).list({ ...OPTS, sourceId: source })).toEqual([]);
  });

  it("never double-counts: summed cluster lapses <= total in-window lapses", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const atomic = seedExtract({ parentId: extract, sourceId: source });
    const a = seedCard({ parentId: extract, sourceId: source });
    const b = seedCard({ parentId: atomic, sourceId: source });
    const c = seedCard({ parentId: atomic, sourceId: source });
    seedTwoLapses(a);
    seedTwoLapses(b);
    seedTwoLapses(c); // total 6 across 3 cards, all resolve to `extract`
    const clusters = new LapseClusterQuery(handle.db).list(OPTS);
    const summed = clusters.reduce((sum, cl) => sum + cl.totalWindowLapses, 0);
    expect(summed).toBeLessThanOrEqual(6);
    expect(clusters).toHaveLength(1);
  });

  it("orders strongest-first and respects the limit", () => {
    const source = seedSource("Source");
    // Cluster 1: 2 cards / 4 lapses... need >= K. Use minLapses=4 here for a 2-cluster setup.
    const e1 = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const e2 = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a1 = seedCard({ parentId: e1, sourceId: source });
    const a2 = seedCard({ parentId: e1, sourceId: source });
    const a3 = seedCard({ parentId: e1, sourceId: source });
    const b1 = seedCard({ parentId: e2, sourceId: source });
    const b2 = seedCard({ parentId: e2, sourceId: source });
    for (const card of [a1, a2, a3]) seedTwoLapses(card); // e1: 3 cards / 6 lapses (strongest)
    for (const card of [b1, b2]) seedTwoLapses(card); // e2: 2 cards / 4 lapses

    const opts = { ...OPTS, minLapses: 4 };
    const clusters = new LapseClusterQuery(handle.db).list(opts);
    expect(clusters.map((c) => c.ancestorId)).toEqual([e1, e2]); // strongest first
    expect(new LapseClusterQuery(handle.db).list({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it("scopes to a single source when sourceId is provided", () => {
    const sourceA = seedSource("A");
    const sourceB = seedSource("B");
    const eA = seedExtract({ parentId: sourceA, sourceId: sourceA, anchorInto: sourceA });
    const eB = seedExtract({ parentId: sourceB, sourceId: sourceB, anchorInto: sourceB });
    for (const parent of [eA, eB]) {
      const x = seedCard({ parentId: parent, sourceId: parent === eA ? sourceA : sourceB });
      const y = seedCard({ parentId: parent, sourceId: parent === eA ? sourceA : sourceB });
      seedTwoLapses(x);
      seedTwoLapses(y);
      seedLapse(x, daysAgo(3), 2, 3);
    }
    const query = new LapseClusterQuery(handle.db);
    expect(query.list(OPTS)).toHaveLength(2);
    const scoped = query.list({ ...OPTS, sourceId: sourceA });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.sourceId).toBe(sourceA);
  });

  it("returns [] when detection is disabled", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a = seedCard({ parentId: extract, sourceId: source });
    const b = seedCard({ parentId: extract, sourceId: source });
    seedTwoLapses(a);
    seedTwoLapses(b);
    seedLapse(a, daysAgo(3), 2, 3);
    expect(new LapseClusterQuery(handle.db).list({ ...OPTS, enabled: false })).toEqual([]);
  });

  it("degrades the region label to 'Selected text' when no label is stored", () => {
    const source = seedSource("Source");
    const extract = seedExtract({
      parentId: source,
      sourceId: source,
      anchorInto: source,
      label: null,
    });
    const a = seedCard({ parentId: extract, sourceId: source });
    const b = seedCard({ parentId: extract, sourceId: source });
    seedTwoLapses(a);
    seedTwoLapses(b);
    seedLapse(a, daysAgo(3), 2, 3);
    expect(new LapseClusterQuery(handle.db).list(OPTS)[0]?.region.label).toBe("Selected text");
  });

  it("resolves the source-region anchor deterministically when an extract has multiple anchors", () => {
    const source = seedSource("The Source");
    const otherExtract = seedExtract({ parentId: source, sourceId: source });
    const extract = seedExtract({ parentId: source, sourceId: source });
    // A non-source anchor (into a parent extract) inserted FIRST (lower id), plus the real
    // source anchor. A naive unordered .get() could pick the non-source row and over-climb.
    handle.db
      .insert(sourceLocations)
      .values({
        id: newSourceLocationId(),
        elementId: extract,
        sourceElementId: otherExtract,
        blockIds: JSON.stringify(["x"]),
        label: "Into an extract",
        selectedText: "x",
      })
      .run();
    handle.db
      .insert(sourceLocations)
      .values({
        id: newSourceLocationId(),
        elementId: extract,
        sourceElementId: source,
        blockIds: JSON.stringify(["blk-9"]),
        label: "Chapter 9 · ¶1",
        selectedText: "real",
      })
      .run();
    const a = seedCard({ parentId: extract, sourceId: source });
    const b = seedCard({ parentId: extract, sourceId: source });
    seedTwoLapses(a);
    seedTwoLapses(b);
    seedLapse(a, daysAgo(3), 2, 3);

    const query = new LapseClusterQuery(handle.db);
    const first = query.list(OPTS);
    const second = query.list(OPTS);
    expect(first).toHaveLength(1);
    expect(first[0]?.ancestorId).toBe(extract);
    expect(first[0]?.sourceId).toBe(source);
    expect(first[0]?.region.label).toBe("Chapter 9 · ¶1"); // the source anchor, not "Into an extract"
    expect(second).toEqual(first); // deterministic across reads
  });

  it("suppresses a cluster whose source was soft-deleted with descendants kept", () => {
    const source = seedSource("Trashed source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a = seedCard({ parentId: extract, sourceId: source });
    const b = seedCard({ parentId: extract, sourceId: source });
    seedTwoLapses(a);
    seedTwoLapses(b);
    seedLapse(a, daysAgo(3), 2, 3);
    // Soft-delete ONLY the source (keep extract + cards live) — the region points into trash.
    handle.db
      .update(elements)
      .set({ deletedAt: daysAgo(1), status: "deleted" })
      .where(eq(elements.id, source))
      .run();
    expect(new LapseClusterQuery(handle.db).list(OPTS)).toEqual([]);
  });

  it("does not cluster an extract anchored into a topic (not a source)", () => {
    const topic = new ElementRepository(handle.db).create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: PRIORITY,
      title: "Topic",
    }).id;
    const extract = seedExtract({ parentId: topic, sourceId: topic, anchorInto: topic });
    const a = seedCard({ parentId: extract, sourceId: topic });
    const b = seedCard({ parentId: extract, sourceId: topic });
    seedTwoLapses(a);
    seedTwoLapses(b);
    seedLapse(a, daysAgo(3), 2, 3);
    expect(new LapseClusterQuery(handle.db).list(OPTS)).toEqual([]);
  });

  it("counts only in-window lapses for a card with lapses on both sides of the window", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a = seedCard({ parentId: extract, sourceId: source });
    const b = seedCard({ parentId: extract, sourceId: source });
    seedLapse(a, daysAgo(40), 0, 1); // out-of-window — ignored
    seedLapse(a, daysAgo(2), 1, 4); // in-window +3
    seedLapse(b, daysAgo(2), 0, 2); // in-window +2
    const clusters = new LapseClusterQuery(handle.db).list(OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.totalWindowLapses).toBe(5); // 3 + 2, NOT 6
  });

  it("counts a lapse stamped exactly at the window start (inclusive boundary)", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a = seedCard({ parentId: extract, sourceId: source });
    const b = seedCard({ parentId: extract, sourceId: source });
    seedLapse(a, daysAgo(30), 0, 3); // exactly at since
    seedLapse(b, daysAgo(30), 0, 2); // exactly at since
    const clusters = new LapseClusterQuery(handle.db).list(OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.totalWindowLapses).toBe(5);
  });

  it("is read-only: no writes to any table", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a = seedCard({ parentId: extract, sourceId: source });
    const b = seedCard({ parentId: extract, sourceId: source });
    seedTwoLapses(a);
    seedTwoLapses(b);
    seedLapse(a, daysAgo(3), 2, 3);

    const before = tableRowCounts();
    const query = new LapseClusterQuery(handle.db);
    query.list(OPTS);
    query.list({ ...OPTS, sourceId: source });
    const after = tableRowCounts();
    expect(after).toEqual(before);
  });
});

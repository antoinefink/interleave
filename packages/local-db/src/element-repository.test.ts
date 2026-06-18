import type { BlockId, Element, ElementId, IsoTimestamp, SiblingGroupId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { operationLog, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { createRepositories, type Repositories } from "./index";
import { OperationLogRepository } from "./operation-log-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let elements: ElementRepository;
let ops: OperationLogRepository;
let repos: Repositories;

beforeEach(() => {
  handle = createInMemoryDb();
  elements = new ElementRepository(handle.db);
  ops = new OperationLogRepository(handle.db);
  repos = createRepositories(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

/** A `source → extract → sub-extract → card` chain; the card is DUE in both stores. */
function seedLineage(): {
  sourceId: ElementId;
  extractId: ElementId;
  subExtractId: ElementId;
  cardId: ElementId;
} {
  const sourceId = repos.sources.create({
    title: "On Memory",
    priority: 0.875,
    status: "active",
  }).element.id;
  const extractId = repos.sources.createExtract({
    sourceElementId: sourceId,
    title: "Extract",
    priority: 0.625,
    selectedText: "…",
    blockIds: ["blk" as BlockId],
    startOffset: 0,
    endOffset: 10,
    label: "¶1",
  }).element.id;
  const subExtractId = repos.sources.createExtract({
    sourceElementId: sourceId,
    parentId: extractId,
    title: "Sub-extract",
    priority: 0.625,
    selectedText: "…",
    blockIds: ["blk" as BlockId],
    startOffset: 0,
    endOffset: 10,
    label: "¶1",
  }).element.id;
  const cardId = repos.review.createCard({
    kind: "qa",
    title: "Card",
    priority: 0.625,
    prompt: "Q?",
    answer: "A.",
    parentId: subExtractId,
    sourceId,
    stage: "active_card",
    firstScheduledAt: "2026-06-15T00:00:00.000Z" as IsoTimestamp,
  }).element.id;
  return { sourceId, extractId, subExtractId, cardId };
}

function softDeletePayload(id: ElementId): Record<string, unknown> | null {
  const row = handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, id))
    .all()
    .filter((op) => op.opType === "soft_delete_element")
    .at(-1);
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : null;
}

function reviewDueOf(cardId: ElementId): string | null {
  return (
    handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, cardId)).get()?.dueAt ??
    null
  );
}

function createTopic(title: string, parentId?: ElementId | null, sourceId?: ElementId | null) {
  return elements.create({
    type: "topic",
    status: "active",
    stage: "rough_topic",
    priority: 0.5,
    title,
    parentId: parentId ?? null,
    sourceId: sourceId ?? null,
  });
}

function attentionMultiplierOf(element: Element | null): number | null {
  return element?.attentionIntervalMultiplier ?? null;
}

describe("ElementRepository direct reads", () => {
  it("lists children/source members and findManyLive excludes soft-deleted rows", () => {
    const source = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.5,
      title: "Source",
    });
    const parent = createTopic("Parent", null, source.id);
    const child = createTopic("Child", parent.id, source.id);
    const other = createTopic("Other");

    expect(elements.listChildren(parent.id).map((e) => e.id)).toEqual([child.id]);
    expect(elements.listBySource(source.id).map((e) => e.id)).toEqual([parent.id, child.id]);

    elements.softDelete(child.id);
    expect(
      elements
        .findManyLive([parent.id, child.id, other.id])
        .map((e) => e.id)
        .sort(),
    ).toEqual([other.id, parent.id].sort());
  });

  it("records exact pre-images and batch ids in update/reschedule/delete op payloads", () => {
    const el = createTopic("Original");

    elements.update(
      el.id,
      {
        title: "Updated",
        status: "parked",
        parkedAt: "2026-06-09T00:00:00.000Z",
        dueAt: null,
      },
      { batchId: "batch-1" },
    );
    elements.rescheduleWithin(handle.db, el.id, "2026-06-10T00:00:00.000Z", "scheduled", {
      postpone: true,
      batchId: "batch-2",
    });
    elements.softDelete(el.id, { batchId: "batch-3" });

    const logs = ops.listForElement(el.id);
    const update = logs.find((op) => op.opType === "update_element");
    const reschedule = logs.find((op) => op.opType === "reschedule_element");
    const softDelete = logs.find((op) => op.opType === "soft_delete_element");

    expect(update?.payload).toMatchObject({
      prev: { title: "Original", status: "active" },
      patch: {
        title: "Updated",
        status: "parked",
        dueAt: null,
        parkedAt: "2026-06-09T00:00:00.000Z",
      },
      batchId: "batch-1",
    });
    expect(reschedule?.payload).toMatchObject({
      dueAt: "2026-06-10T00:00:00.000Z",
      prevDueAt: null,
      prevStatus: "parked",
      postpone: true,
      batchId: "batch-2",
    });
    expect(softDelete?.payload).toMatchObject({
      prev: { status: "scheduled" },
      batchId: "batch-3",
    });
  });

  it("persists attention interval multipliers on create and update", () => {
    const defaulted = createTopic("Default multiplier");
    const custom = elements.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.5,
      attentionIntervalMultiplier: 2.5,
      title: "Custom multiplier",
    });

    expect(attentionMultiplierOf(defaulted)).toBe(1);
    expect(attentionMultiplierOf(elements.findById(defaulted.id))).toBe(1);
    expect(attentionMultiplierOf(custom)).toBe(2.5);
    expect(attentionMultiplierOf(elements.findById(custom.id))).toBe(2.5);

    const updated = elements.update(custom.id, { attentionIntervalMultiplier: 0.75 });
    expect(attentionMultiplierOf(updated)).toBe(0.75);
    expect(attentionMultiplierOf(elements.findById(custom.id))).toBe(0.75);

    const updateLogs = ops.listForElement(custom.id).filter((op) => op.opType === "update_element");
    const update = updateLogs[updateLogs.length - 1];
    expect(update?.payload).toMatchObject({
      patch: { attentionIntervalMultiplier: 0.75 },
      prev: { attentionIntervalMultiplier: 2.5 },
    });
  });

  it("rescheduleWithin can persist an injected mutation timestamp", () => {
    const el = createTopic("Clocked");
    const dueAt = "2026-06-20T00:00:00.000Z";
    const updatedAt = "2026-06-12T09:30:00.000Z";

    const rescheduled = elements.rescheduleWithin(
      handle.db,
      el.id,
      dueAt,
      "scheduled",
      { action: "rewrite" },
      { updatedAt },
    );

    expect(rescheduled.dueAt).toBe(dueAt);
    expect(rescheduled.updatedAt).toBe(updatedAt);
    expect(elements.findById(el.id)?.updatedAt).toBe(updatedAt);
  });

  it("builds a live sibling-group map and keeps the first group per card", () => {
    const card = elements.create({
      type: "card",
      status: "active",
      stage: "active_card",
      priority: 0.5,
      title: "Card",
    });
    const sibling = elements.create({
      type: "card",
      status: "active",
      stage: "active_card",
      priority: 0.5,
      title: "Sibling",
    });

    elements.addRelation({
      fromElementId: card.id,
      toElementId: sibling.id,
      relationType: "sibling_group",
      siblingGroupId: "grp-a" as SiblingGroupId,
    });
    elements.addRelation({
      fromElementId: card.id,
      toElementId: sibling.id,
      relationType: "sibling_group",
      siblingGroupId: "grp-b" as SiblingGroupId,
    });

    expect(elements.liveSiblingGroupMap().get(card.id)).toBe("grp-a");
  });
});

describe("ElementRepository.softDeleteSubtreeWithin (T135/U4)", () => {
  it("R7: subtree delete soft-deletes node + all live descendants under one batchId", () => {
    const { extractId, subExtractId, cardId } = seedLineage();
    const batchId = "branch-batch-1";

    const result = handle.db.transaction((tx) =>
      elements.softDeleteSubtreeWithin(tx, extractId, { batchId, includeSubtree: true }),
    );

    // All three nodes were soft-deleted (root-first order), under the shared batch.
    expect(result.affected).toEqual([extractId, subExtractId, cardId]);
    for (const id of [extractId, subExtractId, cardId]) {
      const row = elements.findById(id);
      expect(row?.deletedAt).toBeTruthy();
      expect(row?.status).toBe("deleted");
      const payload = softDeletePayload(id);
      expect(payload?.batchId).toBe(batchId);
    }
    // Exactly three soft_delete_element ops carry this batchId.
    const batchOps = handle.db
      .select()
      .from(operationLog)
      .all()
      .filter(
        (op) =>
          op.opType === "soft_delete_element" &&
          (JSON.parse(op.payload) as { batchId?: string }).batchId === batchId,
      );
    expect(batchOps).toHaveLength(3);
  });

  it("R8: a descendant card's elements.due_at AND review_states.due_at are cleared with preimages", () => {
    const { extractId, cardId } = seedLineage();
    // Sanity: the card is due in BOTH stores before the delete.
    expect(elements.findById(cardId)?.dueAt).toBe("2026-06-15T00:00:00.000Z");
    expect(reviewDueOf(cardId)).toBe("2026-06-15T00:00:00.000Z");

    handle.db.transaction((tx) =>
      elements.softDeleteSubtreeWithin(tx, extractId, {
        batchId: "b",
        includeSubtree: true,
      }),
    );

    // Both due stores are cleared so the deleted card never reads as "Due today".
    expect(elements.findById(cardId)?.dueAt).toBeNull();
    expect(reviewDueOf(cardId)).toBeNull();
    // Both cleared values are recorded as preimages in the card's soft-delete op.
    const payload = softDeletePayload(cardId);
    expect(payload?.prevDueAt).toBe("2026-06-15T00:00:00.000Z");
    expect(payload?.prevReviewDueAt).toBe("2026-06-15T00:00:00.000Z");
  });

  it("single-node mode (subtree off) clears + records the node's own due preimage and spares descendants", () => {
    const { extractId, subExtractId, cardId } = seedLineage();
    // Give the extract an attention due date to clear.
    elements.reschedule(extractId, "2026-07-01T00:00:00.000Z" as IsoTimestamp);

    const result = handle.db.transaction((tx) =>
      elements.softDeleteSubtreeWithin(tx, extractId, {
        batchId: "single",
        includeSubtree: false,
      }),
    );

    // Only the node itself is deleted; its due is cleared and recorded.
    expect(result.affected).toEqual([extractId]);
    expect(elements.findById(extractId)?.dueAt).toBeNull();
    expect(softDeletePayload(extractId)?.prevDueAt).toBe("2026-07-01T00:00:00.000Z");
    // Descendants stay live and connected (the "keep descendants" tombstone case).
    expect(elements.findById(subExtractId)?.deletedAt).toBeNull();
    expect(elements.findById(cardId)?.deletedAt).toBeNull();
    expect(elements.findById(cardId)?.parentId).toBe(subExtractId);
  });

  it("R14: a mid-batch failure rolls back ALL prior soft-deletes (atomic)", () => {
    const { extractId, subExtractId, cardId } = seedLineage();

    expect(() =>
      handle.db.transaction((tx) => {
        elements.softDeleteSubtreeWithin(tx, extractId, {
          batchId: "doomed",
          includeSubtree: true,
        });
        // Force a failure AFTER the subtree was soft-deleted, inside the same tx.
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // Nothing was committed — every node is still live with its schedule intact.
    for (const id of [extractId, subExtractId, cardId]) {
      expect(elements.findById(id)?.deletedAt).toBeNull();
    }
    expect(reviewDueOf(cardId)).toBe("2026-06-15T00:00:00.000Z");
    expect(softDeletePayload(extractId)).toBeNull();
  });

  it("skips an already-deleted descendant rather than re-stamping it (idempotent)", () => {
    const { extractId, subExtractId, cardId } = seedLineage();
    // The sub-extract was already soft-deleted earlier (a partial state).
    elements.softDelete(subExtractId);
    // The card now has no LIVE parent chain to the extract, so it is not a live
    // descendant of the extract anymore — only the extract itself is live.
    const result = handle.db.transaction((tx) =>
      elements.softDeleteSubtreeWithin(tx, extractId, {
        batchId: "partial",
        includeSubtree: true,
      }),
    );

    // The extract is deleted; the already-deleted sub-extract is NOT re-stamped.
    expect(result.affected).toContain(extractId);
    expect(result.affected).not.toContain(subExtractId);
    // The card, orphaned from the live walk by the deleted sub-extract, is untouched.
    expect(result.affected).not.toContain(cardId);
    expect(elements.findById(cardId)?.deletedAt).toBeNull();
  });
});

describe("ElementRepository.listTagsForMany — batched tag map (U2 parity)", () => {
  it("parity: listTagsForMany(ids).get(id) deepEquals listTags(id) for each element", () => {
    const a = elements.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.5,
      title: "a",
    }).id;
    const b = elements.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.5,
      title: "b",
    }).id;
    const c = elements.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.5,
      title: "c",
    }).id;

    elements.addTag(a, "alpha");
    elements.addTag(a, "beta");
    elements.addTag(b, "beta");
    // c has no tags

    const ids = [a, b, c];
    const map = elements.listTagsForMany(ids);

    for (const id of ids) {
      const single = elements.listTags(id);
      const batched = map.get(id) ?? [];
      expect(batched).toEqual(single);
    }
  });

  it("element with no tags is absent from the map (matching listTags returning [])", () => {
    const el = elements.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.5,
      title: "untagged",
    }).id;
    const map = elements.listTagsForMany([el]);
    // listTags returns [] for untagged; map has no entry (consumer falls back to [])
    expect(map.has(el)).toBe(false);
    expect(elements.listTags(el)).toEqual([]);
  });

  it("empty ids → empty map", () => {
    expect(elements.listTagsForMany([])).toEqual(new Map());
  });
});

describe("ElementRepository batched reads — chunk-boundary parity (SQLITE_SAFE_IN_ARRAY_SIZE)", () => {
  // SQLITE_SAFE_IN_ARRAY_SIZE is 900; use > one chunk's worth so the batched read
  // must split into multiple IN (...) chunks and merge them. These prove the chunk
  // boundary is output-identical to the single-call / per-row expectation (and that
  // a large id set no longer throws SQLite "too many SQL variables").
  const OVER_ONE_CHUNK = 910;

  function seedManyExtracts(count: number): ElementId[] {
    const ids: ElementId[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        elements.create({
          type: "extract",
          status: "active",
          stage: "raw_extract",
          priority: 0.5,
          title: `e${i}`,
        }).id,
      );
    }
    return ids;
  }

  it("findManyLive over > one chunk returns every live id (chunked == single big read)", () => {
    const ids = seedManyExtracts(OVER_ONE_CHUNK);
    const first = ids[0] as ElementId;
    const last = ids[OVER_ONE_CHUNK - 1] as ElementId;
    // Soft-delete a couple so the liveness filter is exercised across chunks.
    elements.softDelete(first);
    elements.softDelete(last);

    const live = elements.findManyLive(ids);
    const liveIds = new Set(live.map((e) => e.id));

    expect(live.length).toBe(OVER_ONE_CHUNK - 2);
    expect(liveIds.has(first)).toBe(false);
    expect(liveIds.has(last)).toBe(false);
    // Every other id is present exactly once.
    for (let i = 1; i < OVER_ONE_CHUNK - 1; i++) {
      expect(liveIds.has(ids[i] as ElementId)).toBe(true);
    }
  });

  it("findManyById over > one chunk includes soft-deleted rows across the boundary", () => {
    const ids = seedManyExtracts(OVER_ONE_CHUNK);
    const deleted = ids[5] as ElementId;
    elements.softDelete(deleted);

    const found = elements.findManyById(ids);
    const foundIds = new Set(found.map((e) => e.id));

    expect(found.length).toBe(OVER_ONE_CHUNK);
    // findManyById is liveness-agnostic: the soft-deleted row is still returned.
    expect(foundIds.has(deleted)).toBe(true);
    for (const id of ids) expect(foundIds.has(id)).toBe(true);
  });

  it("listTagsForMany over > one chunk equals per-element listTags at the boundary", () => {
    const ids = seedManyExtracts(OVER_ONE_CHUNK);
    const head = ids[0] as ElementId;
    const tail = ids[901] as ElementId;
    // Tag a handful, including ids in the second chunk (index >= 900).
    elements.addTag(head, "alpha");
    elements.addTag(head, "beta");
    elements.addTag(ids[450] as ElementId, "mid");
    elements.addTag(tail, "tail-a");
    elements.addTag(tail, "tail-b");

    const map = elements.listTagsForMany(ids);
    // Batched (chunked) result is byte-identical to per-element listTags, including
    // for tagged elements that straddle the chunk boundary (index >= 900).
    for (const id of ids) {
      expect(map.get(id) ?? []).toEqual(elements.listTags(id));
    }
    expect(map.get(tail)).toEqual(elements.listTags(tail));
    expect(map.get(tail)?.length).toBe(2);
  });
});

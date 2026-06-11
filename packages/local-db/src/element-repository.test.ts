import type { ElementId, SiblingGroupId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { OperationLogRepository } from "./operation-log-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let elements: ElementRepository;
let ops: OperationLogRepository;

beforeEach(() => {
  handle = createInMemoryDb();
  elements = new ElementRepository(handle.db);
  ops = new OperationLogRepository(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

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

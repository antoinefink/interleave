import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRetirementService } from "./card-retirement-service";
import { ElementRepository } from "./element-repository";
import { QueueRepository } from "./queue-repository";
import { ReviewRepository } from "./review-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let elements: ElementRepository;
let queue: QueueRepository;
let review: ReviewRepository;

const NOW = "2026-06-03T12:00:00.000Z" as IsoTimestamp;
const PAST = "2026-06-01T12:00:00.000Z" as IsoTimestamp;
const FUTURE = "2026-06-10T12:00:00.000Z" as IsoTimestamp;

beforeEach(() => {
  handle = createInMemoryDb();
  elements = new ElementRepository(handle.db);
  queue = new QueueRepository(handle.db);
  review = new ReviewRepository(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

function createDueCard(title: string, dueAt: IsoTimestamp): ElementId {
  const { element } = review.createCard({
    kind: "qa",
    title,
    prompt: "Q",
    answer: "A",
    priority: 0.5,
  });
  handle.db.update(reviewStates).set({ dueAt }).where(eq(reviewStates.elementId, element.id)).run();
  return element.id;
}

function createAttention(title: string, dueAt: IsoTimestamp) {
  return elements.create({
    type: "extract",
    status: "scheduled",
    stage: "raw_extract",
    priority: 0.5,
    title,
    dueAt,
  });
}

describe("QueueRepository", () => {
  it("returns due cards with state and matching cheap due-card counts", () => {
    const due = createDueCard("Due", PAST);
    const future = createDueCard("Future", FUTURE);

    expect(queue.dueCards(NOW).map((card) => card.id)).toEqual([due]);
    expect(queue.dueCardsWithState(NOW).map((row) => row.element.id)).toEqual([due]);
    expect(queue.dueCardsWithState(NOW)[0]?.state.dueAt).toBe(PAST);
    expect(queue.dueCardCount(NOW)).toBe(1);
    expect(queue.nextCard(NOW)?.id).toBe(due);
    expect(queue.nextCard(NOW, [due])).toBeNull();
    expect(queue.dueCards(FUTURE).map((card) => card.id)).toEqual([due, future]);
  });

  it("keeps retired and excluded-status cards out of due reads and windows", () => {
    const retired = createDueCard("Retired", PAST);
    const done = createDueCard("Done", PAST);
    new CardRetirementService(handle.db).retire(retired);
    elements.update(done, { status: "done" });

    expect(queue.dueCards(NOW)).toEqual([]);
    expect(queue.dueCardCount(NOW)).toBe(0);
    expect(queue.dueCardsBetween(PAST, NOW)).toBe(0);
  });

  it("counts and lists due attention items separately from cards", () => {
    const dueAttention = createAttention("Due attention", PAST);
    createAttention("Future attention", FUTURE);
    createDueCard("Due card", PAST);

    expect(queue.dueAttentionItems(NOW).map((item) => item.id)).toEqual([dueAttention.id]);
    expect(queue.dueAttentionCount(NOW)).toBe(1);
    expect(queue.dueCards(NOW)).toHaveLength(1);
  });

  it("lists live inbox items by type and excludes soft-deleted inbox rows", () => {
    const source = elements.create({
      type: "source",
      status: "inbox",
      stage: "raw_source",
      priority: 0.5,
      title: "Inbox source",
    });
    const extract = elements.create({
      type: "extract",
      status: "inbox",
      stage: "raw_extract",
      priority: 0.5,
      title: "Inbox extract",
    });
    elements.softDelete(extract.id);

    expect(queue.inbox().map((item) => item.id)).toEqual([source.id]);
    expect(queue.inbox("source").map((item) => item.id)).toEqual([source.id]);
    expect(queue.inbox("extract")).toEqual([]);
  });
});

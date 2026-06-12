import type { DistillationStage, ElementId, ElementType, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, operationLog, reviewLogs } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { newReviewLogId } from "./ids";
import { createInMemoryDb } from "./test-db";
import {
  createEmptyQueueTimeCostSummary,
  queueTimeCostSummaryWithItem,
  type TimeCostPricingItem,
  TimeCostQuery,
} from "./time-cost-query";

let handle: DbHandle;

const AS_OF = "2026-06-12T12:00:00.000Z" as IsoTimestamp;

function daysAgo(days: number): IsoTimestamp {
  return new Date(Date.parse(AS_OF) - days * 86_400_000).toISOString() as IsoTimestamp;
}

function seedCard(options: {
  idTitle: string;
  kind: "qa" | "cloze" | "image_occlusion";
  mediaRef?: string | null;
}): ElementId {
  const element = new ElementRepository(handle.db).create({
    type: "card",
    status: "scheduled",
    stage: "active_card",
    priority: 0.5,
    title: options.idTitle,
  });
  handle.db
    .insert(cards)
    .values({
      elementId: element.id,
      kind: options.kind,
      mediaRef: options.mediaRef ?? null,
    })
    .run();
  return element.id;
}

function seedAttention(
  type: ElementType,
  stage: DistillationStage,
  title: string,
): TimeCostPricingItem {
  const element = new ElementRepository(handle.db).create({
    type,
    status: "scheduled",
    stage,
    priority: 0.5,
    title,
  });
  return { id: element.id, type, stage };
}

function dueCard(id: ElementId): TimeCostPricingItem {
  return { id, type: "card", stage: "active_card" };
}

function estimateQueue(
  items: readonly TimeCostPricingItem[],
  visibleItems: readonly TimeCostPricingItem[] = items,
  asOf: IsoTimestamp = AS_OF,
) {
  let summary = createEmptyQueueTimeCostSummary();
  for (const item of items) {
    const card =
      item.type === "card"
        ? handle.db
            .select({ kind: cards.kind, mediaRef: cards.mediaRef })
            .from(cards)
            .where(eq(cards.elementId, item.id))
            .get()
        : undefined;
    summary = queueTimeCostSummaryWithItem(summary, item, card);
  }
  return new TimeCostQuery(handle.db).estimateQueue(summary, { asOf, visibleItems });
}

function seedReview(
  cardId: ElementId,
  responseMs: number,
  reviewedAt: IsoTimestamp,
  promptMs: number | null = null,
): void {
  handle.db
    .insert(reviewLogs)
    .values({
      id: newReviewLogId(),
      elementId: cardId,
      rating: "good",
      reviewedAt,
      responseMs,
      promptMs,
      prevState: "review",
      nextState: "review",
      nextStability: 10,
      nextDifficulty: 5,
      nextDueAt: reviewedAt,
    })
    .run();
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("TimeCostQuery.estimateQueue", () => {
  it("prices card buckets from recent median timings and ignores outliers", () => {
    const qa = seedCard({ idTitle: "QA", kind: "qa" });
    const cloze = seedCard({ idTitle: "Cloze", kind: "cloze" });
    const occlusion = seedCard({ idTitle: "Occlusion", kind: "image_occlusion" });
    seedReview(qa, 60_000, daysAgo(1));
    seedReview(qa, 120_000, daysAgo(2));
    seedReview(qa, 600_000, daysAgo(3));
    seedReview(qa, 10_000_000, daysAgo(4));
    seedReview(cloze, 30_000, daysAgo(1));
    seedReview(cloze, 60_000, daysAgo(2));
    seedReview(cloze, 90_000, daysAgo(3));
    seedReview(occlusion, 1000, daysAgo(1), 59_000);
    seedReview(occlusion, 2000, daysAgo(2), 118_000);
    seedReview(occlusion, 3000, daysAgo(3), 177_000);

    const estimate = estimateQueue([dueCard(qa), dueCard(cloze), dueCard(occlusion)]);

    expect(estimate).toMatchObject({
      totalMinutes: 5,
      pricedItemCount: 3,
      confidence: "learned",
    });
    expect(estimate.items.map((item) => [item.id, item.estimatedMinutes, item.confidence])).toEqual(
      [
        [qa, 2, "learned"],
        [cloze, 1, "learned"],
        [occlusion, 2, "learned"],
      ],
    );
  });

  it("keeps null prompt timing as response-only and excludes invalid timing rows", () => {
    const qa = seedCard({ idTitle: "QA", kind: "qa" });
    seedReview(qa, 60_000, daysAgo(1), null);
    seedReview(qa, 120_000, daysAgo(2), null);
    seedReview(qa, 180_000, daysAgo(3), null);
    seedReview(qa, 100, daysAgo(4), null);

    const estimate = estimateQueue([dueCard(qa)]);

    expect(estimate.items[0]).toMatchObject({
      estimatedMinutes: 2,
      confidence: "learned",
      basis: "card:qa:median",
    });
  });

  it("uses the average of two middle timings for even-count medians", () => {
    const qa = seedCard({ idTitle: "Even QA", kind: "qa" });
    seedReview(qa, 60_000, daysAgo(1));
    seedReview(qa, 120_000, daysAgo(2));
    seedReview(qa, 180_000, daysAgo(3));
    seedReview(qa, 240_000, daysAgo(4));

    const estimate = estimateQueue([dueCard(qa)]);

    expect(estimate.items[0]).toMatchObject({
      estimatedMinutes: 2.5,
      confidence: "learned",
      basis: "card:qa:median",
    });
  });

  it("does not use reviews that happened after the queue clock", () => {
    const qa = seedCard({ idTitle: "Historical QA", kind: "qa" });
    seedReview(qa, 60_000, daysAgo(3));
    seedReview(qa, 120_000, daysAgo(2));
    seedReview(qa, 180_000, daysAgo(1));
    seedReview(qa, 600_000, new Date(Date.parse(AS_OF) + 86_400_000).toISOString() as IsoTimestamp);

    const estimate = estimateQueue([dueCard(qa)], [dueCard(qa)], AS_OF);

    expect(estimate.items[0]).toMatchObject({
      estimatedMinutes: 2,
      confidence: "learned",
    });
  });

  it("falls back from sparse audio timing to the learned base card bucket", () => {
    const qa = seedCard({ idTitle: "QA", kind: "qa" });
    const audio = seedCard({
      idTitle: "Audio QA",
      kind: "qa",
      mediaRef: JSON.stringify({
        sourceElementId: "source-1",
        startMs: 0,
        endMs: 30_000,
        on: "prompt",
      }),
    });
    seedReview(qa, 60_000, daysAgo(1));
    seedReview(qa, 120_000, daysAgo(2));
    seedReview(qa, 180_000, daysAgo(3));
    seedReview(audio, 240_000, daysAgo(1));

    const estimate = estimateQueue([dueCard(audio)]);

    expect(estimate.items[0]).toMatchObject({
      estimatedMinutes: 2,
      confidence: "learned",
      basis: "card:audio->qa:median",
    });
  });

  it("treats malformed media refs as non-audio cards", () => {
    const qa = seedCard({ idTitle: "QA", kind: "qa" });
    const malformed = seedCard({
      idTitle: "Malformed media",
      kind: "qa",
      mediaRef: JSON.stringify({ sourceElementId: "source-1", startMs: 0, endMs: 30_000 }),
    });
    seedReview(qa, 60_000, daysAgo(1));
    seedReview(qa, 120_000, daysAgo(2));
    seedReview(qa, 180_000, daysAgo(3));

    const estimate = estimateQueue([dueCard(malformed)]);

    expect(estimate.items[0]).toMatchObject({
      estimatedMinutes: 2,
      confidence: "learned",
      basis: "card:qa:median",
    });
  });

  it("uses documented defaults for thin card history and attention rows", () => {
    const cloze = seedCard({ idTitle: "Thin cloze", kind: "cloze" });
    seedReview(cloze, 30_000, daysAgo(1));
    const source = seedAttention("source", "raw_source", "Source");
    const extract = seedAttention("extract", "raw_extract", "Extract");

    const estimate = estimateQueue([dueCard(cloze), source, extract], [dueCard(cloze)]);

    expect(estimate).toMatchObject({
      totalMinutes: 17,
      pricedItemCount: 3,
      confidence: "default",
    });
    expect(estimate.items).toEqual([
      {
        id: cloze,
        estimatedMinutes: 1,
        confidence: "default",
        basis: "card:cloze:default",
      },
    ]);
  });

  it("is read-only and appends no operation_log rows", () => {
    const qa = seedCard({ idTitle: "QA", kind: "qa" });
    const before = handle.db.select().from(operationLog).all().length;

    estimateQueue([dueCard(qa)]);

    expect(handle.db.select().from(operationLog).all()).toHaveLength(before);
  });
});

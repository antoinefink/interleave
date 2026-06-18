/**
 * TopicKnowledgeStateQuery tests (T108).
 *
 * The read model is a current receipt only: it folds live concept membership/topic
 * subtrees, card FSRS state, review logs, retention targets, and verification tasks
 * without mutating state or inventing historical graduation crossings.
 */

import {
  type BlockId,
  type DistillationStage,
  type ElementId,
  type IsoTimestamp,
  PRIORITY_LABEL_VALUE,
} from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, operationLog, reviewLogs, reviewStates, tasks } from "@interleave/db";
import { CARD_MATURE_STABILITY_DAYS } from "@interleave/scheduler";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConceptRepository } from "./concept-repository";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { newReviewLogId } from "./ids";
import { RetentionService } from "./retention-service";
import { SettingsRepository } from "./settings-repository";
import { createInMemoryDb } from "./test-db";
import { TopicKnowledgeStateQuery } from "./topic-knowledge-state-query";

let handle: DbHandle;
let elementsRepo: ElementRepository;
let conceptsRepo: ConceptRepository;
let documents: DocumentRepository;

const ASOF = "2026-06-12T12:00:00.000Z" as IsoTimestamp;

beforeEach(() => {
  handle = createInMemoryDb();
  elementsRepo = new ElementRepository(handle.db);
  conceptsRepo = new ConceptRepository(handle.db);
  documents = new DocumentRepository(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

function seedElement(
  title: string,
  opts: {
    readonly type: "source" | "topic" | "extract" | "card" | "task";
    readonly parentId?: ElementId | null;
    readonly sourceId?: ElementId | null;
    readonly stage?: DistillationStage;
    readonly status?: "active" | "scheduled" | "done";
    readonly priority?: number;
    readonly extractFate?: "reference" | "synthesized" | "done_without_card" | null;
  },
): ElementId {
  const el = elementsRepo.create({
    type: opts.type,
    status: opts.status ?? "active",
    stage:
      opts.stage ??
      (opts.type === "source"
        ? "raw_source"
        : opts.type === "topic"
          ? "rough_topic"
          : opts.type === "card"
            ? "active_card"
            : "raw_extract"),
    priority: opts.priority ?? 0.5,
    title,
    parentId: opts.parentId ?? null,
    sourceId: opts.sourceId ?? null,
  });
  if (opts.extractFate) {
    elementsRepo.update(el.id, { extractFate: opts.extractFate, status: "done" });
  }
  return el.id;
}

function seedSourceWithReadPoint(title: string): ElementId {
  const sourceId = seedElement(title, { type: "source" });
  const blockId = `${sourceId}-b0` as BlockId;
  documents.upsert({
    elementId: sourceId,
    prosemirrorJson: { type: "doc", content: [] },
    plainText: "Source body",
    blocks: [{ blockType: "paragraph", order: 0, stableBlockId: blockId }],
  });
  documents.setReadPoint({ elementId: sourceId, documentId: sourceId, blockId, offset: 0 });
  return sourceId;
}

function seedCard(
  sourceId: ElementId,
  parentId: ElementId,
  opts: {
    readonly retired?: boolean;
    readonly stability?: number;
    readonly fsrsState?: "new" | "learning" | "review" | "relearning";
    readonly withReviewState?: boolean;
  } = {},
): ElementId {
  const cardId = seedElement("Card", {
    type: "card",
    parentId,
    sourceId,
    stage: "active_card",
  });
  handle.db
    .insert(cards)
    .values({ elementId: cardId, kind: "qa", isRetired: opts.retired ?? false })
    .run();
  if (opts.withReviewState !== false) {
    handle.db
      .insert(reviewStates)
      .values({
        elementId: cardId,
        fsrsState: opts.fsrsState ?? "review",
        stability: opts.stability ?? CARD_MATURE_STABILITY_DAYS + 1,
        reps: 3,
      })
      .run();
  }
  return cardId;
}

function seedReview(
  cardId: ElementId,
  rating: "again" | "hard" | "good" | "easy" = "good",
  reviewedAt = "2026-06-10T12:00:00.000Z",
) {
  handle.db
    .insert(reviewLogs)
    .values({
      id: newReviewLogId(),
      elementId: cardId,
      rating,
      reviewedAt,
      responseMs: 800,
      prevState: "review",
      nextState: "review",
      nextStability: CARD_MATURE_STABILITY_DAYS + 1,
      nextDifficulty: 5,
      nextDueAt: "2026-07-10T12:00:00.000Z",
    })
    .run();
}

function seedOpenVerificationTask(linkedElementId: ElementId): ElementId {
  const taskId = seedElement("Verify claim", {
    type: "task",
    parentId: linkedElementId,
    sourceId: null,
    stage: "raw_extract",
    status: "scheduled",
  });
  handle.db
    .insert(tasks)
    .values({
      elementId: taskId,
      taskType: "verify_claim",
      status: "scheduled",
      linkedElementId,
    })
    .run();
  return taskId;
}

describe("TopicKnowledgeStateQuery.getTopicKnowledgeState", () => {
  it("returns an empty read-only receipt without appending operation-log rows", () => {
    const before = handle.db.select().from(operationLog).all().length;

    const summary = new TopicKnowledgeStateQuery(handle.db).getTopicKnowledgeState(ASOF);

    expect(summary).toEqual({
      asOf: ASOF,
      windowDays: 90,
      subjects: [],
      graduationEvents: [],
    });
    expect(handle.db.select().from(operationLog).all()).toHaveLength(before);
  });

  it("rolls a concept member through descendants into a current graduation candidate", () => {
    const concept = conceptsRepo.createConcept({ name: "Mechanistic interpretability" });
    conceptsRepo.setConceptRetention(concept.id, 0.93);
    const sourceId = seedSourceWithReadPoint("Transformer Circuits");
    const extractId = seedElement("Induction heads are discoverable", {
      type: "extract",
      parentId: sourceId,
      sourceId,
      stage: "clean_extract",
      extractFate: "synthesized",
    });
    const cardIds = Array.from({ length: 3 }, () => seedCard(sourceId, extractId));
    for (const cardId of cardIds) seedReview(cardId);
    conceptsRepo.assignConcept(sourceId, concept.id);
    const before = handle.db.select().from(operationLog).all().length;

    const summary = new TopicKnowledgeStateQuery(handle.db).getTopicKnowledgeState(ASOF, {
      subjectType: "concept",
      subjectId: concept.id,
    });

    expect(summary.subjects).toHaveLength(1);
    expect(summary.subjects[0]).toMatchObject({
      subjectType: "concept",
      subjectId: concept.id,
      directMemberCount: 1,
      includedElementCount: 5,
      funnel: {
        read: 1,
        extracted: 1,
        distilled: 1,
        carded: 3,
        mature: 3,
        extractedOfRead: 1,
        distilledOfExtracted: 1,
        cardedOfDistilled: 3,
        matureOfCarded: 1,
      },
      stability: { young: 0, maturing: 0, mature: 3, retired: 0 },
      retention: {
        reviewCount: 3,
        measuredRetention: 1,
        directConceptTarget: 0.93,
      },
      staleness: { staleItems: 0, needsReverify: 0 },
      graduationState: { status: "graduated", thresholdVersion: "v1" },
    });
    expect(summary.graduationEvents).toEqual([
      {
        eventId: `concept:${concept.id}:graduated:v1`,
        eventType: "current_graduated",
        subjectType: "concept",
        subjectId: concept.id,
        title: "Mechanistic interpretability",
        asOf: ASOF,
        thresholdVersion: "v1",
      },
    ]);
    expect(handle.db.select().from(operationLog).all()).toHaveLength(before);
  });

  it("uses topic parent-subtrees and does not overcount sourceId siblings", () => {
    const sourceId = seedElement("Shared source", { type: "source" });
    const firstTopic = seedElement("Chapter 1", { type: "topic", parentId: sourceId, sourceId });
    const secondTopic = seedElement("Chapter 2", { type: "topic", parentId: sourceId, sourceId });
    seedElement("Chapter 2 extract", {
      type: "extract",
      parentId: secondTopic,
      sourceId,
      stage: "clean_extract",
      extractFate: "reference",
    });

    const summary = new TopicKnowledgeStateQuery(handle.db).getTopicKnowledgeState(ASOF, {
      subjectType: "topic",
      subjectId: firstTopic,
    });

    expect(summary.subjects).toHaveLength(1);
    expect(summary.subjects[0]).toMatchObject({
      subjectType: "topic",
      subjectId: firstTopic,
      title: "Chapter 1",
      includedElementCount: 1,
      funnel: {
        read: 0,
        extracted: 0,
        distilled: 0,
        carded: 0,
        mature: 0,
      },
    });
  });

  it("does not expand concept membership through sourceId provenance", () => {
    const concept = conceptsRepo.createConcept({ name: "Precise source concept" });
    const sourceId = seedSourceWithReadPoint("Shared source");
    seedElement("Detached source-provenance extract", {
      type: "extract",
      sourceId,
      stage: "clean_extract",
      extractFate: "reference",
    });
    conceptsRepo.assignConcept(sourceId, concept.id);

    const summary = new TopicKnowledgeStateQuery(handle.db).getTopicKnowledgeState(ASOF, {
      subjectType: "concept",
      subjectId: concept.id,
    });

    expect(summary.subjects[0]).toMatchObject({
      includedElementCount: 1,
      funnel: { read: 1, extracted: 0, distilled: 0, carded: 0, mature: 0 },
    });
  });

  it("keeps retired cards visible but out of active graduation math", () => {
    const concept = conceptsRepo.createConcept({ name: "Retired card accounting" });
    const sourceId = seedSourceWithReadPoint("Retirement source");
    const extractId = seedElement("Retirement extract", {
      type: "extract",
      parentId: sourceId,
      sourceId,
      stage: "clean_extract",
    });
    const activeOne = seedCard(sourceId, extractId);
    const activeTwo = seedCard(sourceId, extractId);
    const retired = seedCard(sourceId, extractId, { retired: true });
    for (const cardId of [activeOne, activeTwo, retired]) seedReview(cardId);
    conceptsRepo.assignConcept(sourceId, concept.id);

    const summary = new TopicKnowledgeStateQuery(handle.db).getTopicKnowledgeState(ASOF, {
      subjectType: "concept",
      subjectId: concept.id,
    });

    expect(summary.subjects[0]).toMatchObject({
      funnel: {
        carded: 2,
        mature: 2,
        matureOfCarded: 1,
      },
      stability: { young: 0, maturing: 0, mature: 2, retired: 1 },
      retention: { reviewCount: 2 },
      graduationState: { status: "insufficient_evidence" },
    });
    expect(summary.graduationEvents).toEqual([]);
  });

  it("buckets active stability states and uses half-open retention snapshots", () => {
    const concept = conceptsRepo.createConcept({ name: "Retention edges" });
    const sourceId = seedSourceWithReadPoint("Retention source");
    const extractId = seedElement("Retention extract", {
      type: "extract",
      parentId: sourceId,
      sourceId,
      stage: "clean_extract",
    });
    const noState = seedCard(sourceId, extractId, { withReviewState: false });
    const learning = seedCard(sourceId, extractId, { fsrsState: "learning", stability: 20 });
    const maturing = seedCard(sourceId, extractId, { stability: 10 });
    const mature = seedCard(sourceId, extractId);
    conceptsRepo.assignConcept(sourceId, concept.id);

    seedReview(noState, "good", "2026-03-20T12:00:00.000Z");
    seedReview(learning, "again", "2026-04-13T12:00:00.000Z");
    seedReview(maturing, "good", "2026-05-13T12:00:00.000Z");
    seedReview(mature, "good", "2026-06-10T12:00:00.000Z");
    seedReview(mature, "good", "2026-02-01T12:00:00.000Z");

    const summary = new TopicKnowledgeStateQuery(handle.db).getTopicKnowledgeState(ASOF, {
      subjectType: "concept",
      subjectId: concept.id,
      windowDays: 90,
    });

    expect(summary.subjects[0]).toMatchObject({
      stability: { young: 2, maturing: 1, mature: 1, retired: 0 },
      retention: {
        reviewCount: 4,
        measuredRetention: 0.75,
        snapshots: [
          { reviewCount: 1, measuredRetention: 1 },
          { reviewCount: 1, measuredRetention: 0 },
          { reviewCount: 2, measuredRetention: 1 },
        ],
      },
      graduationState: { status: "needs_attention" },
    });
    expect(summary.graduationEvents).toEqual([]);
  });

  it("treats nested descendant output as read evidence for a topic root", () => {
    const root = seedElement("Root topic", { type: "topic" });
    const chapter = seedElement("Nested chapter", { type: "topic", parentId: root });
    seedElement("Nested extract", {
      type: "extract",
      parentId: chapter,
      stage: "clean_extract",
    });

    const summary = new TopicKnowledgeStateQuery(handle.db).getTopicKnowledgeState(ASOF, {
      subjectType: "topic",
      subjectId: root,
    });

    const [subject] = summary.subjects;
    expect(subject?.funnel.read).toBe(2);
  });

  it("orders attention-needed subjects by higher priority when urgency ties", () => {
    const low = seedElement("A low priority topic", { type: "topic", priority: 0.1 });
    const high = seedElement("Z high priority topic", { type: "topic", priority: 0.9 });

    const summary = new TopicKnowledgeStateQuery(handle.db).getTopicKnowledgeState(ASOF, {
      subjectType: "topic",
      order: "needs_attention",
      limit: 2,
    });

    expect(summary.subjects.map((subject) => subject.subjectId)).toEqual([high, low]);
  });

  it("ignores soft-deleted verification tasks when computing reverify staleness", () => {
    const concept = conceptsRepo.createConcept({ name: "Verification liveness" });
    const sourceId = seedSourceWithReadPoint("Verification source");
    const extractId = seedElement("Verification extract", {
      type: "extract",
      parentId: sourceId,
      sourceId,
      stage: "clean_extract",
    });
    const taskId = seedOpenVerificationTask(extractId);
    elementsRepo.softDelete(taskId);
    conceptsRepo.assignConcept(sourceId, concept.id);

    const summary = new TopicKnowledgeStateQuery(handle.db).getTopicKnowledgeState(ASOF, {
      subjectType: "concept",
      subjectId: concept.id,
    });

    expect(handle.db.select().from(tasks).where(eq(tasks.elementId, taskId)).get()?.status).toBe(
      "scheduled",
    );
    const [subject] = summary.subjects;
    expect(subject?.staleness).toEqual({ staleItems: 0, needsReverify: 0 });
  });
});

describe("U12 drift: strictestResolvedTarget batched vs per-card resolveForCard", () => {
  /**
   * Seeds a concept with multiple cards whose retention is sourced from different
   * rules (per-concept override, per-band/priority, global default, per-card override).
   * Asserts that the batched `strictestResolvedTarget` path produces the same retention
   * target as the old per-card `retention.resolveForCard` path would.
   */
  it("batched retention target matches per-card resolveForCard across all rule sources", () => {
    const settings = new SettingsRepository(handle.db);
    const retention = new RetentionService(handle.db);

    // Enable band targeting + set global + band-A target.
    settings.updateAppSettings({
      defaultDesiredRetention: 0.88,
      retentionByBandEnabled: true,
      retentionByBand: { A: 0.93, B: 0.91 },
    });

    // Concept with its own per-concept target (0.95).
    const concept = conceptsRepo.createConcept({ name: "Drift test concept" });
    conceptsRepo.setConceptRetention(concept.id, 0.95);

    const sourceId = seedSourceWithReadPoint("Drift source");
    const extractId = seedElement("Drift extract", {
      type: "extract",
      parentId: sourceId,
      sourceId,
      stage: "clean_extract",
    });

    // Card 1: concept membership → resolves via concept rule (0.95).
    const conceptCard = seedCard(sourceId, extractId, { stability: 20 });
    conceptsRepo.assignConcept(conceptCard, concept.id);

    // Card 2: A-band priority, no concept → resolves via band (0.93).
    const bandCard = seedCard(sourceId, extractId, { stability: 15 });
    elementsRepo.update(bandCard, { priority: PRIORITY_LABEL_VALUE.A });

    // Card 3: B-band, no concept → resolves via band (0.91).
    const bandCardB = seedCard(sourceId, extractId, { stability: 10 });
    elementsRepo.update(bandCardB, { priority: PRIORITY_LABEL_VALUE.B });

    // Card 4: per-card override (0.97) — wins over everything.
    const overrideCard = seedCard(sourceId, extractId, { stability: 8 });
    retention.setCardRetention(overrideCard, 0.97);

    // Card 5: default-band card (no concept, C-band) → resolves via global (0.88).
    const globalCard = seedCard(sourceId, extractId, { stability: 5 });
    elementsRepo.update(globalCard, { priority: PRIORITY_LABEL_VALUE.C });

    conceptsRepo.assignConcept(sourceId, concept.id);

    // Compute the per-card targets using the OLD per-card resolveForCard path.
    const targets = retention.targets();
    const allCardIds = [conceptCard, bandCard, bandCardB, overrideCard, globalCard];
    const perCardStrictest = allCardIds.reduce<number | null>((acc, cardId) => {
      const resolved = retention.resolveForCard(cardId, targets).target;
      return acc === null ? resolved : Math.max(acc, resolved);
    }, null);

    // Run the batched query.
    const summary = new TopicKnowledgeStateQuery(handle.db).getTopicKnowledgeState(ASOF, {
      subjectType: "concept",
      subjectId: concept.id,
    });

    const subject = summary.subjects[0];
    expect(subject).toBeDefined();
    // Strictest across all 5 cards: overrideCard has 0.97 → should win.
    expect(subject?.retention.retentionTarget).toBeCloseTo(0.97, 6);
    // Drift guard: batched result equals the per-card path.
    expect(subject?.retention.retentionTarget).toBeCloseTo(perCardStrictest ?? 0, 6);
  });

  it("returns null retention target for a subject with zero active cards (same as before)", () => {
    const concept = conceptsRepo.createConcept({ name: "Empty concept" });
    const sourceId = seedElement("Empty source", { type: "source" });
    conceptsRepo.assignConcept(sourceId, concept.id);

    const summary = new TopicKnowledgeStateQuery(handle.db).getTopicKnowledgeState(ASOF, {
      subjectType: "concept",
      subjectId: concept.id,
    });

    const subject = summary.subjects[0];
    expect(subject).toBeDefined();
    expect(subject?.retention.retentionTarget).toBeNull();
  });

  it("per-concept override wins over band for a card assigned to concept (non-vacuous correctness)", () => {
    const settings = new SettingsRepository(handle.db);
    settings.updateAppSettings({
      defaultDesiredRetention: 0.88,
      retentionByBandEnabled: true,
      retentionByBand: { A: 0.93 },
    });

    const concept = conceptsRepo.createConcept({ name: "High-value concept" });
    conceptsRepo.setConceptRetention(concept.id, 0.95);

    const sourceId = seedSourceWithReadPoint("Concept priority source");
    const extractId = seedElement("Concept priority extract", {
      type: "extract",
      parentId: sourceId,
      sourceId,
      stage: "clean_extract",
    });

    // A-band card assigned to concept: concept (0.95) > band (0.93) → concept wins.
    const cardId = seedCard(sourceId, extractId, { stability: 20 });
    elementsRepo.update(cardId, { priority: PRIORITY_LABEL_VALUE.A });
    conceptsRepo.assignConcept(cardId, concept.id);
    conceptsRepo.assignConcept(sourceId, concept.id);

    const summary = new TopicKnowledgeStateQuery(handle.db).getTopicKnowledgeState(ASOF, {
      subjectType: "concept",
      subjectId: concept.id,
    });

    const subject = summary.subjects[0];
    expect(subject?.retention.retentionTarget).toBeCloseTo(0.95, 6);

    // Non-vacuous: if we inject 0.93 (the band value) instead, the assertion would fail.
    expect(subject?.retention.retentionTarget).not.toBeCloseTo(0.93, 6);
  });
});

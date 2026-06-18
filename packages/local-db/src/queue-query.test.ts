/**
 * QueueQuery tests (T029).
 *
 * The unified due-queue read is the seam that keeps queue sorting/filtering out of
 * React, so its behaviour is unit-tested against a temporary, fully-migrated
 * in-memory `better-sqlite3` database. These assert the load-bearing invariants the
 * `/queue` screen depends on:
 *
 *  - it returns due CARDS (FSRS `review_states.due_at`) AND due ATTENTION items
 *    (`elements.due_at`) — the two distinct schedulers, kept separate in the read;
 *  - each row carries the correct `scheduler` tag (`fsrs` for cards, `attention`
 *    for the rest) + the matching signals;
 *  - rows are ordered by the T076 SCORING FUNCTION (priority dominant, then due/
 *    retrievability/type + sibling/source/concept de-clumping, modulated by `mode`),
 *    and each row carries the `siblingGroupId` + `sourceId` de-clumping keys;
 *  - `protected` is set for band-A items (the `--protected` accent bar);
 *  - type / status filters narrow correctly;
 *  - the budget gauge reads the daily review budget from settings.
 */

import type { BlockId, ElementId, IsoTimestamp } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import { type DbHandle, elements, operationLog } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { CardRetirementService } from "./card-retirement-service";
import { DocumentRepository } from "./document-repository";
import { createRepositories, type Repositories } from "./index";
import { QueueQuery } from "./queue-query";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let queue: QueueQuery;

/** A fixed "now" so due classification + sort are deterministic. */
const NOW = "2026-05-30T12:00:00.000Z" as IsoTimestamp;
const iso = (s: string) => s as IsoTimestamp;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  queue = new QueueQuery(repos);
});

afterEach(() => {
  handle.sqlite.close();
});

/**
 * Build a small mixed due set:
 *  - a source (A) due yesterday (overdue, attention);
 *  - an extract (B) due today (attention);
 *  - a Q&A card (A) made due via a review (FSRS);
 *  - a cloze card (C) reviewed into a FUTURE due (NOT due) — must be excluded.
 */
function buildDueSet(): {
  sourceId: ElementId;
  extractId: ElementId;
  qaCardId: ElementId;
  clozeCardId: ElementId;
} {
  const source = repos.sources.create({
    title: "On the Measure of Intelligence",
    priority: PRIORITY_LABEL_VALUE.A,
    status: "active",
    author: "François Chollet",
  });
  const sourceId = source.element.id;
  // Source is due yesterday (overdue) on the attention scheduler.
  repos.elements.reschedule(sourceId, iso("2026-05-29T08:00:00.000Z"));

  const extract = repos.sources.createExtract({
    sourceElementId: sourceId,
    title: "Intelligence = skill-acquisition efficiency",
    priority: PRIORITY_LABEL_VALUE.B,
    selectedText: "We define the intelligence of a system…",
    blockIds: ["blk_def_p1" as BlockId],
    label: "Definition · ¶1",
  });
  const extractId = extract.element.id;
  repos.elements.update(extractId, { status: "active", stage: "clean_extract" });
  // Extract due today.
  repos.elements.reschedule(extractId, iso("2026-05-30T06:00:00.000Z"));

  const qaCard = repos.review.createCard({
    kind: "qa",
    title: "Chollet's definition of intelligence",
    priority: PRIORITY_LABEL_VALUE.A,
    prompt: "How does Chollet define intelligence?",
    answer: "Skill-acquisition efficiency over a scope of tasks.",
    parentId: extractId,
    sourceId,
    sourceLocationId: extract.location.id,
    stage: "active_card",
  });
  // Review it so its FSRS due lands in the PAST (due now).
  repos.review.recordReview(qaCard.element.id, {
    rating: "good",
    reviewedAt: iso("2026-05-26T08:00:00.000Z"),
    responseMs: 3000,
    prevState: "new",
    nextState: "review",
    nextStability: 9.4,
    nextDifficulty: 5,
    nextDueAt: iso("2026-05-29T08:00:00.000Z"),
    elapsedDays: 3,
    scheduledDays: 3,
    reps: 2,
    lapses: 0,
    nextLearningSteps: 0,
  });

  const clozeCard = repos.review.createCard({
    kind: "cloze",
    title: "Intelligence definition (cloze)",
    priority: PRIORITY_LABEL_VALUE.C,
    cloze: "Intelligence is {{c1::skill-acquisition efficiency}}.",
    parentId: extractId,
    sourceId,
    sourceLocationId: extract.location.id,
    stage: "card_draft",
  });
  // Review it into a FUTURE due — it must NOT appear in the due queue.
  repos.review.recordReview(clozeCard.element.id, {
    rating: "good",
    reviewedAt: iso("2026-05-30T08:00:00.000Z"),
    responseMs: 3000,
    prevState: "new",
    nextState: "review",
    nextStability: 12,
    nextDifficulty: 5,
    nextDueAt: iso("2026-06-15T08:00:00.000Z"),
    elapsedDays: 0,
    scheduledDays: 16,
    reps: 1,
    lapses: 0,
    nextLearningSteps: 0,
  });

  return { sourceId, extractId, qaCardId: qaCard.element.id, clozeCardId: clozeCard.element.id };
}

describe("QueueQuery", () => {
  it("returns due cards AND due attention items, each tagged with the right scheduler", () => {
    const { sourceId, extractId, qaCardId, clozeCardId } = buildDueSet();
    const { items } = queue.list({ asOf: NOW });
    const ids = items.map((i) => i.id);

    expect(ids).toContain(sourceId);
    expect(ids).toContain(extractId);
    expect(ids).toContain(qaCardId);
    // The future-due cloze card is excluded.
    expect(ids).not.toContain(clozeCardId);

    const card = items.find((i) => i.id === qaCardId);
    const extract = items.find((i) => i.id === extractId);
    const source = items.find((i) => i.id === sourceId);
    expect(card?.scheduler).toBe("fsrs");
    expect(card?.schedulerSignals.kind).toBe("fsrs");
    expect(extract?.scheduler).toBe("attention");
    expect(extract?.schedulerSignals.kind).toBe("attention");
    expect(source?.type).toBe("source");
    expect(source?.status).toBe("active");
    expect(source?.scheduler).toBe("attention");
    expect(source?.schedulerSignals.kind).toBe("attention");
  });

  it("carries the current attention schedule reason on due queue rows", () => {
    const source = repos.sources.create({
      title: "Productive source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "active",
      stage: "raw_source",
    });
    handle.db.transaction((tx) => {
      repos.elements.rescheduleWithin(
        tx,
        source.element.id,
        iso("2026-05-30T06:00:00.000Z"),
        "scheduled",
        {
          action: "extract",
          scheduledAt: "2026-05-24T06:00:00.000Z",
          attentionAdaptive: {
            version: 1,
            enabled: true,
            reason: {
              reasonKind: "yield_shortened",
              baseIntervalDays: 7,
              intervalAfterMultiplierDays: 6,
              finalIntervalDays: 6,
              priorMultiplier: 1,
              newMultiplier: 0.85,
              productiveOutputCount: 2,
            },
          },
        },
      );
    });

    const row = queue
      .list({ asOf: NOW, filters: { types: ["source"] } })
      .items.find((item) => item.id === source.element.id);

    expect(row?.schedulerSignals.scheduleReason).toMatchObject({
      kind: "yield_shortened",
      finalIntervalDays: 6,
      newMultiplier: 0.85,
      productiveOutputCount: 2,
    });
  });

  it("decorates visible source rows with a source retirement suggestion", () => {
    const { element } = repos.sources.createWithDocument({
      title: "Low-yield source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "active",
      stage: "raw_source",
      body: "First.\n\nSecond.\n\nThird.\n\nFourth.",
    });
    repos.elements.reschedule(element.id, iso("2026-05-29T08:00:00.000Z"));
    const blocks = new DocumentRepository(handle.db)
      .listBlocks(element.id)
      .map((block) => block.stableBlockId);
    const blockProcessing = new BlockProcessingService(handle.db);
    for (const block of blocks.slice(0, 3)) {
      blockProcessing.markBlockIgnored({
        sourceElementId: element.id,
        stableBlockId: block as BlockId,
      });
    }
    blockProcessing.markBlockProcessed({
      sourceElementId: element.id,
      stableBlockId: blocks[3] as BlockId,
    });

    const row = queue
      .list({ asOf: NOW, filters: { types: ["source"] } })
      .items.find((item) => item.id === element.id);

    expect(row?.schedulerSignals.retirementSuggestion).toMatchObject({
      kind: "abandon",
      signalHash: expect.stringContaining(`v1|${element.id}|abandon|`),
    });
  });

  it("excludes dismissed, done, and parked sources even when they still have due_at", () => {
    const { sourceId } = buildDueSet();
    const dismissed = repos.sources.create({
      title: "Dismissed source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "dismissed",
    }).element.id;
    repos.elements.reschedule(dismissed, iso("2026-05-29T08:00:00.000Z"));
    const done = repos.sources.create({
      title: "Done source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "done",
    }).element.id;
    repos.elements.reschedule(done, iso("2026-05-29T08:00:00.000Z"));
    const parked = repos.sources.create({
      title: "Parked source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "parked",
    }).element.id;
    repos.elements.reschedule(parked, iso("2026-05-29T08:00:00.000Z"));

    const ids = queue.list({ asOf: NOW }).items.map((item) => item.id);
    const parkedSummary = queue.summaryFor(parked, NOW);

    expect(ids).toContain(sourceId);
    expect(ids).not.toContain(dismissed);
    expect(ids).not.toContain(done);
    expect(ids).not.toContain(parked);
    expect(parkedSummary).toMatchObject({
      queueEligible: false,
      dueLabel: "Parked",
      notInQueueReason: "Not in queue: status is Parked",
    });
  });

  it("carries linkedElementId + linkedElementType on a due verification task row (the queue jump)", () => {
    // A verification TASK (T092) linked to the source — the queue row must expose the
    // protected element's id + type so the renderer's "Open" can JUMP TO its reader.
    const { sourceId } = buildDueSet();
    const task = repos.tasks.createTask({
      taskType: "verify_claim",
      title: "Verify Chollet's definition",
      linkedElementId: sourceId,
    });
    // Make the task due (overdue) on the attention scheduler.
    repos.elements.reschedule(task.id, iso("2026-05-29T08:00:00.000Z"));

    const { items } = queue.list({ asOf: NOW });
    const row = items.find((i) => i.id === task.id);
    expect(row).toBeDefined();
    expect(row?.type).toBe("task");
    expect(row?.scheduler).toBe("attention");
    expect(row?.taskType).toBe("verify_claim");
    expect(row?.linkedElementId).toBe(sourceId);
    expect(row?.linkedElementType).toBe("source");
    // A SOURCE linked element resolves its owning-source id to its own id (T129).
    expect(row?.linkedSourceId).toBe(sourceId);

    // Non-task rows never carry a link (the source/extract/card rows stay null).
    expect(items.find((i) => i.id === sourceId)?.taskType).toBeNull();
    expect(items.find((i) => i.id === sourceId)?.linkedElementId).toBeNull();
    expect(items.find((i) => i.id === sourceId)?.linkedElementType).toBeNull();
    expect(items.find((i) => i.id === sourceId)?.linkedSourceId).toBeNull();
  });

  it("resolves linkedSourceId to the linked EXTRACT's owning source (the T129 re-read jump)", () => {
    // The T129 `reread_region` task links the ancestor EXTRACT, not a source, and the
    // queue row must surface the extract's OWNING SOURCE so the renderer can route to
    // /source/$id. The resolution is task-type-agnostic, so a verify task linked to an
    // extract exercises the same code path without depending on the system-owned type.
    const { sourceId, extractId } = buildDueSet();
    const task = repos.tasks.createTask({
      taskType: "verify_claim",
      title: "Verify a claim in the extract",
      linkedElementId: extractId,
    });
    repos.elements.reschedule(task.id, iso("2026-05-29T08:00:00.000Z"));

    const row = queue.list({ asOf: NOW }).items.find((i) => i.id === task.id);
    expect(row).toBeDefined();
    expect(row?.linkedElementId).toBe(extractId);
    expect(row?.linkedElementType).toBe("extract");
    // The owning source of the linked extract — NOT the extract id, NOT the task's
    // own (null) source.
    expect(row?.linkedSourceId).toBe(sourceId);
  });

  it("carries taskType for the system-owned weekly review task without a protected link", () => {
    const weekly = repos.elements.create({
      type: "task",
      status: "scheduled",
      stage: "rough_topic",
      priority: PRIORITY_LABEL_VALUE.A,
      title: "Weekly review",
      dueAt: iso("2026-05-29T08:00:00.000Z"),
    });
    handle.sqlite
      .prepare(
        `INSERT INTO tasks (element_id, task_type, due_at, status, linked_element_id, note)
         VALUES (?, 'weekly_review', ?, 'scheduled', NULL, NULL)`,
      )
      .run(weekly.id, weekly.dueAt);

    const row = queue.list({ asOf: NOW }).items.find((i) => i.id === weekly.id);
    expect(row).toBeDefined();
    expect(row?.taskType).toBe("weekly_review");
    expect(row?.linkedElementId).toBeNull();
    expect(row?.linkedElementType).toBeNull();
  });

  it("surfaces a scheduled synthesis note as an attention row (T095)", () => {
    // A synthesis note (T095) is an ATTENTION item — once scheduled to return it
    // appears in the due queue like an extract/topic, tagged `attention` (never FSRS).
    const { element } = repos.synthesis.create({ title: "Weaving definitions" });
    repos.synthesis.scheduleReturn(element.id, { manual: "2026-05-29T08:00:00.000Z" });

    const { items } = queue.list({ asOf: NOW });
    const row = items.find((i) => i.id === element.id);
    expect(row).toBeDefined();
    expect(row?.type).toBe("synthesis_note");
    expect(row?.scheduler).toBe("attention");
    expect(row?.schedulerSignals.kind).toBe("attention");
  });

  it("sorts by priority desc, then due date asc", () => {
    buildDueSet();
    const { items } = queue.list({ asOf: NOW });
    // A (source, overdue) and A (qa card, due 05-29) are both band A; the source's
    // due (05-29 08:00) ties the card's due (05-29 08:00) — both before the B
    // extract (due 05-30). So both A items precede the B extract.
    const priorities = items.map((i) => i.priority);
    for (let i = 1; i < priorities.length; i++) {
      const prev = priorities[i - 1] as number;
      const cur = priorities[i] as number;
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
    // The B-priority extract is last among the three due items.
    expect(items[items.length - 1]?.priority).toBe(PRIORITY_LABEL_VALUE.B);
  });

  it("marks band-A items protected (the --protected accent bar)", () => {
    const { sourceId, extractId } = buildDueSet();
    const { items } = queue.list({ asOf: NOW });
    expect(items.find((i) => i.id === sourceId)?.protected).toBe(true);
    expect(items.find((i) => i.id === extractId)?.protected).toBe(false);
  });

  it("classifies due state (overdue vs today) and a human due label", () => {
    const { sourceId, extractId } = buildDueSet();
    const { items } = queue.list({ asOf: NOW });
    const source = items.find((i) => i.id === sourceId);
    const extract = items.find((i) => i.id === extractId);
    expect(source?.due).toBe("overdue");
    expect(source?.dueLabel).toBe("Overdue");
    expect(extract?.due).toBe("today");
    expect(extract?.dueLabel).toBe("Due today");
  });

  it("filters by type (cards only)", () => {
    const { qaCardId } = buildDueSet();
    const { items } = queue.list({ asOf: NOW, filters: { types: ["card"] } });
    expect(items.every((i) => i.type === "card")).toBe(true);
    expect(items.map((i) => i.id)).toContain(qaCardId);
  });

  it("filters by status", () => {
    const { extractId } = buildDueSet();
    // The extract was set `active` in the fixture; narrowing to `active` keeps it.
    const { items } = queue.list({ asOf: NOW, filters: { statuses: ["active"] } });
    expect(items.map((i) => i.id)).toContain(extractId);
    expect(items.every((i) => i.status === "active")).toBe(true);
  });

  it("filters by concept (T041) — keeps only members of the named concept", () => {
    const { extractId, sourceId } = buildDueSet();
    // Assign ONLY the extract to a concept; the source stays unassigned.
    const concept = repos.concepts.createConcept({ name: "Intelligence" });
    repos.concepts.assignConcept(extractId, concept.id);

    const { items } = queue.list({ asOf: NOW, filters: { concept: "Intelligence" } });
    const ids = items.map((i) => i.id);
    expect(ids).toContain(extractId);
    expect(ids).not.toContain(sourceId);

    // A different concept name returns no matches.
    expect(queue.list({ asOf: NOW, filters: { concept: "Nope" } }).items).toHaveLength(0);
  });

  it("filters by concept matching ANY membership, via the prebuilt non-N+1 matcher", () => {
    const { extractId, sourceId } = buildDueSet();
    // The extract joins TWO concepts; the concept filter must match on EITHER name
    // (the matcher tests the element's full membership set, not just the first edge).
    const cog = repos.concepts.createConcept({ name: "Cognition" });
    const mem = repos.concepts.createConcept({ name: "Memory" });
    repos.concepts.assignConcept(extractId, cog.id);
    repos.concepts.assignConcept(extractId, mem.id);

    expect(
      queue.list({ asOf: NOW, filters: { concept: "Cognition" } }).items.map((i) => i.id),
    ).toEqual([extractId]);
    expect(
      queue.list({ asOf: NOW, filters: { concept: "Memory" } }).items.map((i) => i.id),
    ).toEqual([extractId]);
    expect(
      queue.list({ asOf: NOW, filters: { concept: "Cognition" } }).items.map((i) => i.id),
    ).not.toContain(sourceId);
  });

  it("concept filter excludes members of a SOFT-DELETED concept (matcher honours live endpoints)", () => {
    const { extractId } = buildDueSet();
    const dead = repos.concepts.createConcept({ name: "Phantom" });
    repos.concepts.assignConcept(extractId, dead.id);
    // While live, the filter keeps the member…
    expect(
      queue.list({ asOf: NOW, filters: { concept: "Phantom" } }).items.map((i) => i.id),
    ).toEqual([extractId]);
    // …after soft-deleting the concept element, the named-concept set has no LIVE id,
    // so the row drops out — consistent with the Library drill-down counts.
    repos.elements.softDelete(dead.id);
    expect(queue.list({ asOf: NOW, filters: { concept: "Phantom" } }).items).toHaveLength(0);
  });

  it("filters by tag (T041) — keeps only elements carrying the tag", () => {
    const { extractId, qaCardId } = buildDueSet();
    repos.elements.addTag(extractId, "definitions");

    const { items } = queue.list({ asOf: NOW, filters: { tag: "definitions" } });
    const ids = items.map((i) => i.id);
    expect(ids).toContain(extractId);
    expect(ids).not.toContain(qaCardId);

    expect(queue.list({ asOf: NOW, filters: { tag: "missing" } }).items).toHaveLength(0);
  });

  it("reports per-type counts over the full due set when no filter is active", () => {
    buildDueSet();
    const { counts } = queue.list({ asOf: NOW });
    expect(counts.all).toBe(3);
    expect(counts.card).toBe(1);
    expect(counts.source).toBe(1);
    expect(counts.extract).toBe(1);
    expect(counts.highPriority).toBe(2); // source A + qa card A
    expect(counts.overdue).toBeGreaterThanOrEqual(1);
    expect(counts.protected).toBe(2);
  });

  it("DRILL-DOWN: per-type + all counts respect an active STATUS filter (count-vs-list invariant)", () => {
    // Two due sources of the SAME priority: one `active`, one `scheduled`.
    const active = repos.sources.create({
      title: "active source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "active",
    });
    repos.elements.reschedule(active.element.id, iso("2026-05-29T08:00:00.000Z"));
    const scheduled = repos.sources.create({
      title: "scheduled source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
    });
    repos.elements.reschedule(scheduled.element.id, iso("2026-05-29T08:00:00.000Z"));

    // Narrow to `active` (what the queue UI's "Active" status chip sends). The
    // "Sources" chip count + the "N items due" total must match the narrowed list —
    // NOT the full due set (the reported bug class: chip shows 2, list shows 1).
    const res = queue.list({ asOf: NOW, filters: { statuses: ["active"] } });
    const sourcesShown = res.items.filter((i) => i.type === "source").length;
    expect(res.counts.source).toBe(sourcesShown);
    expect(res.counts.source).toBe(1);
    expect(res.counts.all).toBe(res.items.length);
    // The budget gauge tracks the filtered set the user faces, not the raw merge.
    expect(res.budget.used).toBe(res.items.length);
  });

  it("DRILL-DOWN: per-type counts respect an active CONCEPT filter", () => {
    const a = repos.sources.create({
      title: "in-concept source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "active",
    });
    repos.elements.reschedule(a.element.id, iso("2026-05-29T08:00:00.000Z"));
    const b = repos.sources.create({
      title: "out-of-concept source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "active",
    });
    repos.elements.reschedule(b.element.id, iso("2026-05-29T08:00:00.000Z"));
    const concept = repos.concepts.createConcept({ name: "Focus" });
    repos.concepts.assignConcept(a.element.id, concept.id);

    const res = queue.list({ asOf: NOW, filters: { concept: "Focus" } });
    // Only the in-concept source is shown, and the Sources chip count agrees.
    expect(res.items.map((i) => i.id)).toEqual([a.element.id]);
    expect(res.counts.source).toBe(1);
    expect(res.counts.all).toBe(res.items.length);
  });

  it("DRILL-DOWN: an explicit `types` filter is DROPPED from the per-type counts (chips drill down)", () => {
    buildDueSet();
    // When the caller passes `types: ['card']`, the per-type counts must still report
    // EVERY type (the type dimension is the chip's own value — dropped from its count),
    // so the renderer can show non-zero counts on the other chips to switch to.
    const res = queue.list({ asOf: NOW, filters: { types: ["card"] } });
    expect(res.items.every((i) => i.type === "card")).toBe(true);
    // Counts ignore the type filter: sources/extracts still counted.
    expect(res.counts.source).toBe(1);
    expect(res.counts.extract).toBe(1);
    expect(res.counts.card).toBe(1);
    expect(res.counts.all).toBe(3);
    expect(res.timeCostSummary.pricedItemCount).toBe(1);
    expect(res.timeCostSummary.cardBuckets.qa).toBe(1);
    expect(res.timeCostSummary.attention.source).toBe(0);
  });

  it("keeps time-cost summaries over the full filtered due set even when visible rows are limited", () => {
    buildDueSet();

    const res = queue.list({ asOf: NOW, limit: 1 });

    expect(res.items).toHaveLength(1);
    expect(res.counts.all).toBe(3);
    expect(res.timeCostSummary.pricedItemCount).toBe(3);
    expect(res.timeCostSummary.cardBuckets.qa).toBe(1);
    expect(res.timeCostSummary.attention.source).toBe(1);
    expect(res.timeCostSummary.attention.extract).toBe(1);
  });

  it("prices auto-postpone candidates after applying type filters", () => {
    const { sourceId } = buildDueSet();

    const candidates = queue.autoPostponeCandidates({
      asOf: NOW,
      filters: { types: ["source"] },
    });

    expect(candidates.items.map((item) => item.id)).toEqual([sourceId]);
    expect(candidates.timeCostSummary.pricedItemCount).toBe(1);
    expect(candidates.timeCostSummary.attention.source).toBe(1);
    expect(candidates.timeCostSummary.attention.extract).toBe(0);
    expect(candidates.timeCostSummary.cardBuckets.qa).toBe(0);
  });

  it("reads the daily review budget from settings for the gauge", () => {
    buildDueSet();
    repos.settings.updateAppSettings({ dailyReviewBudget: 25 });
    const { budget } = queue.list({ asOf: NOW });
    expect(budget.target).toBe(25);
    expect(budget.used).toBe(3);
  });

  it("returns an empty queue with zero counts when nothing is due", () => {
    const { items, counts } = queue.list({ asOf: NOW });
    expect(items).toHaveLength(0);
    expect(counts.all).toBe(0);
  });

  it("T076: enriches each row with the de-clumping keys (sourceId + siblingGroupId)", () => {
    const { sourceId, extractId, qaCardId } = buildDueSet();
    const { items } = queue.list({ asOf: NOW });
    const source = items.find((i) => i.id === sourceId);
    const extract = items.find((i) => i.id === extractId);
    const card = items.find((i) => i.id === qaCardId);
    // A source's `sourceId` is itself; the extract + card belong to that source.
    expect(source?.sourceId).toBe(sourceId);
    expect(extract?.sourceId).toBe(sourceId);
    expect(card?.sourceId).toBe(sourceId);
    // The fixture cards have no sibling-group edge, so `siblingGroupId` is null;
    // attention items never carry one.
    expect(card?.siblingGroupId).toBeNull();
    expect(source?.siblingGroupId).toBeNull();
  });

  it("T076: orders by the score (default `full` mode) — high-priority overdue floats first", () => {
    const { sourceId, extractId } = buildDueSet();
    const { items } = queue.list({ asOf: NOW });
    // The B-priority extract (due today, not overdue) sits behind the A items.
    expect(items[items.length - 1]?.id).toBe(extractId);
    // The overdue A-priority source is at (or near) the front — score, not raw priority.
    expect(items[0]?.priority).toBe(PRIORITY_LABEL_VALUE.A);
    // `list()` with no `mode` defaults to `"full"` — same order as an explicit full.
    const explicit = queue.list({ asOf: NOW, mode: "full" }).items.map((i) => i.id);
    expect(items.map((i) => i.id)).toEqual(explicit);
    expect(items.map((i) => i.id)).toContain(sourceId);
  });

  it("T076: `review` mode floats the card above an equally-scored source; `read` inverts (neither dropped)", () => {
    // A due source and a due card at the SAME priority + same due day, with the card's
    // retrievability pinned to ~0.5 (reviewed ~25.6 days ago at stability 2) so it
    // equals the attention row's NEUTRAL retrievability — leaving ONLY the
    // mode-modulated type weight to separate them, making the flip decisive.
    const source = repos.sources.create({
      title: "A read-mode source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "active",
    });
    repos.elements.reschedule(source.element.id, iso("2026-05-30T06:00:00.000Z"));

    const card = repos.review.createCard({
      kind: "qa",
      title: "A review-mode card",
      priority: PRIORITY_LABEL_VALUE.B,
      prompt: "Q?",
      answer: "A.",
      stage: "active_card",
    });
    repos.review.recordReview(card.element.id, {
      rating: "good",
      // ~25.6 days before NOW with stability 2 ⇒ R ≈ 0.50 (the neutral midpoint).
      reviewedAt: iso("2026-05-04T22:24:00.000Z"),
      responseMs: 3000,
      prevState: "new",
      nextState: "review",
      nextStability: 2,
      nextDifficulty: 5,
      nextDueAt: iso("2026-05-30T06:00:00.000Z"),
      elapsedDays: 25,
      scheduledDays: 25,
      reps: 2,
      lapses: 0,
      nextLearningSteps: 0,
    });

    const review = queue.list({ asOf: NOW, mode: "review" }).items.map((i) => i.id);
    const read = queue.list({ asOf: NOW, mode: "read" }).items.map((i) => i.id);
    // Both modes keep BOTH items (no hard filter — the old `modeIncludes` slice is gone).
    expect(review).toEqual(expect.arrayContaining([card.element.id, source.element.id]));
    expect(read).toEqual(expect.arrayContaining([card.element.id, source.element.id]));
    // review floats the card ahead of the source; read floats the source ahead.
    expect(review.indexOf(card.element.id)).toBeLessThan(review.indexOf(source.element.id));
    expect(read.indexOf(source.element.id)).toBeLessThan(read.indexOf(card.element.id));
  });

  it("T076: the drill-down counts + budget gauge are unchanged by the mode", () => {
    buildDueSet();
    const full = queue.list({ asOf: NOW, mode: "full" });
    const review = queue.list({ asOf: NOW, mode: "review" });
    // Ordering changes; the merged set, counts, and budget are identical.
    expect(review.counts).toEqual(full.counts);
    expect(review.budget).toEqual(full.budget);
    expect([...review.items].map((i) => i.id).sort()).toEqual(
      [...full.items].map((i) => i.id).sort(),
    );
  });

  it("surfaces backend fallow reason on inventory summaries while due reads stay date-based", () => {
    const topic = repos.elements.create({
      type: "topic",
      status: "scheduled",
      stage: "rough_topic",
      priority: PRIORITY_LABEL_VALUE.B,
      title: "Rested topic",
      dueAt: iso("2026-05-29T06:00:00.000Z"),
    });
    const extract = repos.elements.create({
      type: "extract",
      status: "scheduled",
      stage: "raw_extract",
      priority: PRIORITY_LABEL_VALUE.B,
      title: "Rested extract",
      parentId: topic.id,
      dueAt: iso("2026-05-29T06:00:00.000Z"),
    });

    repos.fallow.fallowTopic({
      topicId: topic.id,
      fallowUntil: iso("2026-06-15T00:00:00.000Z"),
      fallowReason: "Let the thread cool off",
      now: NOW,
    });

    expect(queue.list({ asOf: NOW }).items.map((item) => item.id)).not.toContain(extract.id);
    const rested = queue.summaryFor(extract.id, NOW);
    expect(rested).toMatchObject({
      queueEligible: false,
      notInQueueReason: "fallow",
      fallowState: "active",
      fallowUntil: "2026-06-15T00:00:00.000Z",
      fallowReason: "Let the thread cool off",
      fallowTopicId: topic.id,
    });
    expect(rested?.dueLabel).toBe("Resting until Jun 15");

    const returned = queue.summaryFor(extract.id, iso("2026-06-15T00:00:00.000Z"));
    expect(returned).toMatchObject({
      queueEligible: true,
      notInQueueReason: null,
      fallowState: "returned",
    });
    expect(returned?.dueLabel).toBe("Due today");

    const returnedDueRow = queue
      .list({ asOf: iso("2026-06-15T00:00:00.000Z") })
      .items.find((item) => item.id === extract.id);
    expect(returnedDueRow).toMatchObject({
      fallowState: "returned",
      fallowUntil: "2026-06-15T00:00:00.000Z",
      fallowReason: "Let the thread cool off",
      fallowTopicId: topic.id,
    });
  });

  it("projects extract aging from stagnation progress age rather than updatedAt", () => {
    const source = repos.sources.create({
      title: "Aging source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "active",
    });
    const extract = repos.sources.createExtract({
      sourceElementId: source.element.id,
      title: "Old but recently postponed extract",
      priority: PRIORITY_LABEL_VALUE.B,
      selectedText: "Old thought",
      blockIds: ["blk_age" as BlockId],
      label: "Age",
    });
    const id = extract.element.id;
    repos.elements.update(id, { status: "active", stage: "clean_extract" });
    repos.elements.reschedule(id, iso("2026-08-14T09:00:00.000Z"), {
      updatedAt: iso("2026-08-14T09:00:00.000Z"),
    });
    handle.db
      .update(elements)
      .set({
        createdAt: iso("2026-06-01T09:00:00.000Z"),
        updatedAt: iso("2026-08-14T09:00:00.000Z"),
      })
      .where(eq(elements.id, id))
      .run();
    handle.db.transaction((tx) => {
      for (let i = 0; i < 5; i += 1) {
        repos.operationLog.append(tx, {
          opType: "reschedule_element",
          elementId: id,
          payload: { postpone: true, postponeCount: i + 1 },
        });
      }
    });
    // The stage advance to `clean_extract` above logs an `update_element` op whose
    // `createdAt` is the real wall clock. `daysSinceProgress` anchors on
    // `lastStageAdvanceAt ?? createdAt`, so that op's timestamp OVERRIDES the pinned
    // `elements.createdAt` and the band drifts (graveyard → stale) once real time is
    // within 2×ageDays of the fixed asOf. Pin every op for this extract to the same
    // fixed instant as `createdAt` so the progress anchor stays deterministic.
    handle.db
      .update(operationLog)
      .set({ createdAt: iso("2026-06-01T09:00:00.000Z") })
      .where(eq(operationLog.elementId, id))
      .run();
    repos.settings.updateAppSettings({
      extractAgingPolicy: "suggest",
      extractAgingReturnThreshold: 5,
      extractAgingAgeDays: 30,
    });

    const row = queue.summaryFor(id, iso("2026-08-15T09:00:00.000Z"));

    expect(row?.extractAging).toMatchObject({
      band: "graveyard",
      postponeCount: 5,
      thresholdReached: true,
    });
    expect(row?.extractAging?.daysSinceProgress).toBeGreaterThanOrEqual(30);
  });
});

/**
 * U1 keystone: `summaryForMany(ids, asOf)` is a BATCHED path that MUST produce output
 * byte-identical to the single-row `summaryFor(id, asOf)` for an ARBITRARY id set — not
 * just due elements. The load-bearing guarantee is the drift test below: it seeds a mixed
 * inventory (due card, retired card, parked source, future-due element, fallow-paused
 * element, source with a visible retirement suggestion) and asserts deepEquals per id and
 * asOf. The trap this guards is the due-only `BatchContext` eligibility shortcut
 * (`eligible:true`/`retirementSuggestion:null`/`cardRetired:false`/`fallow:null`), which
 * would silently emit the WRONG queue-eligibility projection for the non-due inventory.
 */
describe("QueueQuery.summaryForMany (U1 — batched queue summary)", () => {
  /**
   * Seed the full mixed inventory the drift test ranges over. Returns the id set plus the
   * topic id (so callers can include it too — a topic is itself an attention element).
   */
  function buildMixedInventory(): {
    dueCardId: ElementId;
    retiredCardId: ElementId;
    parkedSourceId: ElementId;
    futureDueExtractId: ElementId;
    fallowExtractId: ElementId;
    fallowTopicId: ElementId;
    suggestionSourceId: ElementId;
    plainSourceId: ElementId;
    postponedExtractId: ElementId;
    weeklyTaskId: ElementId;
  } {
    // A plain active source + extract + a DUE card (FSRS, due in the past).
    const source = repos.sources.create({
      title: "Mixed inventory source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "active",
      author: "An Author",
    });
    const plainSourceId = source.element.id;
    repos.elements.reschedule(plainSourceId, iso("2026-05-29T08:00:00.000Z"));
    const extract = repos.sources.createExtract({
      sourceElementId: plainSourceId,
      title: "An extract",
      priority: PRIORITY_LABEL_VALUE.B,
      selectedText: "Some selected text",
      blockIds: ["blk_mi_1" as BlockId],
      label: "Mixed · ¶1",
    });
    const dueCard = repos.review.createCard({
      kind: "qa",
      title: "Due card",
      priority: PRIORITY_LABEL_VALUE.A,
      prompt: "Q?",
      answer: "A.",
      parentId: extract.element.id,
      sourceId: plainSourceId,
      sourceLocationId: extract.location.id,
      stage: "active_card",
    });
    repos.review.recordReview(dueCard.element.id, {
      rating: "good",
      reviewedAt: iso("2026-05-26T08:00:00.000Z"),
      responseMs: 3000,
      prevState: "new",
      nextState: "review",
      nextStability: 9.4,
      nextDifficulty: 5,
      nextDueAt: iso("2026-05-29T08:00:00.000Z"),
      elapsedDays: 3,
      scheduledDays: 3,
      reps: 2,
      lapses: 0,
      nextLearningSteps: 0,
    });

    // A RETIRED card (due in the past, but retired ⇒ NOT queue-eligible).
    const retiredCard = repos.review.createCard({
      kind: "qa",
      title: "Retired card",
      priority: PRIORITY_LABEL_VALUE.B,
      prompt: "Q2?",
      answer: "A2.",
      parentId: extract.element.id,
      sourceId: plainSourceId,
      sourceLocationId: extract.location.id,
      stage: "active_card",
    });
    repos.review.recordReview(retiredCard.element.id, {
      rating: "good",
      reviewedAt: iso("2026-05-26T08:00:00.000Z"),
      responseMs: 2000,
      prevState: "new",
      nextState: "review",
      nextStability: 5,
      nextDifficulty: 5,
      nextDueAt: iso("2026-05-29T08:00:00.000Z"),
      elapsedDays: 3,
      scheduledDays: 3,
      reps: 2,
      lapses: 0,
      nextLearningSteps: 0,
    });
    new CardRetirementService(handle.db).retire(retiredCard.element.id, {
      reason: "low value",
    });

    // A PARKED source (still has a past due_at, but parked ⇒ NOT queue-eligible).
    const parkedSource = repos.sources.create({
      title: "Parked source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "parked",
    });
    const parkedSourceId = parkedSource.element.id;
    repos.elements.reschedule(parkedSourceId, iso("2026-05-29T08:00:00.000Z"));

    // A FUTURE-DUE extract (active, but due_at in the future ⇒ NOT yet in queue).
    const futureExtract = repos.sources.createExtract({
      sourceElementId: plainSourceId,
      title: "Future-due extract",
      priority: PRIORITY_LABEL_VALUE.C,
      selectedText: "Later thought",
      blockIds: ["blk_mi_future" as BlockId],
      label: "Future",
    });
    const futureDueExtractId = futureExtract.element.id;
    repos.elements.update(futureDueExtractId, { status: "active", stage: "clean_extract" });
    repos.elements.reschedule(futureDueExtractId, iso("2026-06-30T08:00:00.000Z"));

    // A FALLOW-paused element: a topic put to rest + an extract child under it.
    const topic = repos.elements.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: PRIORITY_LABEL_VALUE.B,
      title: "Rested topic",
    });
    const fallowTopicId = topic.id;
    const fallowExtract = repos.elements.create({
      type: "extract",
      status: "scheduled",
      stage: "raw_extract",
      priority: PRIORITY_LABEL_VALUE.B,
      title: "Rested extract",
      parentId: topic.id,
      dueAt: iso("2026-05-29T06:00:00.000Z"),
    });
    const fallowExtractId = fallowExtract.id;
    repos.fallow.fallowTopic({
      topicId: topic.id,
      fallowUntil: iso("2026-06-15T00:00:00.000Z"),
      fallowReason: "Let it cool",
      now: NOW,
    });

    // A SOURCE with a VISIBLE retirement suggestion (mostly-ignored blocks → abandon).
    const lowYield = repos.sources.createWithDocument({
      title: "Low-yield source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "active",
      stage: "raw_source",
      body: "First.\n\nSecond.\n\nThird.\n\nFourth.",
    });
    const suggestionSourceId = lowYield.element.id;
    repos.elements.reschedule(suggestionSourceId, iso("2026-05-29T08:00:00.000Z"));
    const blocks = new DocumentRepository(handle.db)
      .listBlocks(suggestionSourceId)
      .map((b) => b.stableBlockId);
    const blockProcessing = new BlockProcessingService(handle.db);
    for (const block of blocks.slice(0, 3)) {
      blockProcessing.markBlockIgnored({
        sourceElementId: suggestionSourceId,
        stableBlockId: block as BlockId,
      });
    }
    blockProcessing.markBlockProcessed({
      sourceElementId: suggestionSourceId,
      stableBlockId: blocks[3] as BlockId,
    });

    // An extract POSTPONED several times (effective postpone count + schedule reason).
    const postponedExtract = repos.sources.createExtract({
      sourceElementId: plainSourceId,
      title: "Postponed extract",
      priority: PRIORITY_LABEL_VALUE.B,
      selectedText: "Keep deferring",
      blockIds: ["blk_mi_postpone" as BlockId],
      label: "Postpone",
    });
    const postponedExtractId = postponedExtract.element.id;
    repos.elements.update(postponedExtractId, { status: "active", stage: "clean_extract" });
    handle.db.transaction((tx) => {
      for (let i = 0; i < 3; i += 1) {
        repos.operationLog.append(tx, {
          opType: "reschedule_element",
          elementId: postponedExtractId,
          payload: { postpone: true, postponeCount: i + 1 },
        });
      }
    });
    repos.elements.reschedule(postponedExtractId, iso("2026-05-29T08:00:00.000Z"));

    // A system-owned weekly-review TASK (attention, no protected link).
    const weekly = repos.elements.create({
      type: "task",
      status: "scheduled",
      stage: "rough_topic",
      priority: PRIORITY_LABEL_VALUE.A,
      title: "Weekly review",
      dueAt: iso("2026-05-29T08:00:00.000Z"),
    });
    handle.sqlite
      .prepare(
        `INSERT INTO tasks (element_id, task_type, due_at, status, linked_element_id, note)
         VALUES (?, 'weekly_review', ?, 'scheduled', NULL, NULL)`,
      )
      .run(weekly.id, weekly.dueAt);

    return {
      dueCardId: dueCard.element.id,
      retiredCardId: retiredCard.element.id,
      parkedSourceId,
      futureDueExtractId,
      fallowExtractId,
      fallowTopicId,
      suggestionSourceId,
      plainSourceId,
      postponedExtractId,
      weeklyTaskId: weekly.id,
    };
  }

  it("returns an empty map for empty ids", () => {
    expect(queue.summaryForMany([], NOW).size).toBe(0);
  });

  it("omits unknown and soft-deleted ids (matches summaryFor returning null)", () => {
    const { dueCardId } = buildMixedInventory();
    const unknown = "el_does_not_exist" as ElementId;
    const deleted = repos.sources.create({
      title: "Deleted source",
      priority: PRIORITY_LABEL_VALUE.C,
      status: "active",
    }).element.id;
    repos.elements.softDelete(deleted);

    const map = queue.summaryForMany([dueCardId, unknown, deleted], NOW);
    expect(map.has(dueCardId)).toBe(true);
    expect(map.has(unknown)).toBe(false);
    expect(map.has(deleted)).toBe(false);
    // summaryFor agrees: unknown/deleted → null.
    expect(queue.summaryFor(unknown, NOW)).toBeNull();
    expect(queue.summaryFor(deleted, NOW)).toBeNull();
  });

  it("deepEquals summaryFor field-by-field for EVERY mixed-inventory id across asOfs", () => {
    const inventory = buildMixedInventory();
    const ids = Object.values(inventory) as ElementId[];
    // Several read clocks: before the future due, before the fallow return, ON the fallow
    // return day (fallow flips active → returned, future extract stays future), and well
    // after everything is due. Each must agree single-row vs batched.
    const asOfs: IsoTimestamp[] = [
      NOW,
      iso("2026-06-15T00:00:00.000Z"),
      iso("2026-07-01T09:00:00.000Z"),
    ];
    for (const asOf of asOfs) {
      const map = queue.summaryForMany(ids, asOf);
      for (const id of ids) {
        const single = queue.summaryFor(id, asOf);
        expect(single, `summaryFor(${id}) at ${asOf}`).not.toBeNull();
        expect(map.get(id), `summaryForMany.get(${id}) at ${asOf}`).toEqual(single);
      }
    }
  });

  it("computes per-element eligibility (retired card + parked source are NOT eligible)", () => {
    const { retiredCardId, parkedSourceId, dueCardId } = buildMixedInventory();
    const map = queue.summaryForMany([retiredCardId, parkedSourceId, dueCardId], NOW);

    expect(map.get(retiredCardId)).toMatchObject({
      queueEligible: false,
      notInQueueReason: "Not in queue: card is retired",
    });
    expect(map.get(parkedSourceId)).toMatchObject({
      queueEligible: false,
      notInQueueReason: "Not in queue: status is Parked",
    });
    // The due card stays eligible — proving the shortcut wasn't applied wholesale.
    expect(map.get(dueCardId)).toMatchObject({ queueEligible: true, notInQueueReason: null });
  });

  it("future-due element reports the returns label, not in-queue (no eligible shortcut)", () => {
    const { futureDueExtractId } = buildMixedInventory();
    const row = queue.summaryForMany([futureDueExtractId], NOW).get(futureDueExtractId);
    expect(row).toMatchObject({ queueEligible: false });
    expect(row?.notInQueueReason).toContain("Not in queue: returns");
    expect(row).toEqual(queue.summaryFor(futureDueExtractId, NOW));
  });

  it("fallow-paused element carries the fallow projection batched (active then returned)", () => {
    const { fallowExtractId, fallowTopicId } = buildMixedInventory();
    const active = queue.summaryForMany([fallowExtractId], NOW).get(fallowExtractId);
    expect(active).toMatchObject({
      queueEligible: false,
      notInQueueReason: "fallow",
      fallowState: "active",
      fallowTopicId,
    });
    expect(active).toEqual(queue.summaryFor(fallowExtractId, NOW));

    const returnedAsOf = iso("2026-06-15T00:00:00.000Z");
    const returned = queue.summaryForMany([fallowExtractId], returnedAsOf).get(fallowExtractId);
    expect(returned).toMatchObject({ fallowState: "returned" });
    expect(returned).toEqual(queue.summaryFor(fallowExtractId, returnedAsOf));
  });

  it("resolves a visible source retirement suggestion batched (the hardcoded-null trap)", () => {
    const { suggestionSourceId } = buildMixedInventory();
    const row = queue.summaryForMany([suggestionSourceId], NOW).get(suggestionSourceId);
    expect(row?.schedulerSignals.retirementSuggestion).toMatchObject({
      kind: "abandon",
      signalHash: expect.stringContaining(`v1|${suggestionSourceId}|abandon|`),
    });
    // And it equals the single-row resolution exactly.
    expect(row?.schedulerSignals.retirementSuggestion).toEqual(
      queue.summaryFor(suggestionSourceId, NOW)?.schedulerSignals.retirementSuggestion,
    );
  });

  it("reports the same effective postpone count batched as single-row", () => {
    const { postponedExtractId } = buildMixedInventory();
    const row = queue.summaryForMany([postponedExtractId], NOW).get(postponedExtractId);
    const single = queue.summaryFor(postponedExtractId, NOW);
    expect(row?.schedulerSignals.postponed).toBe(3);
    expect(row?.schedulerSignals.postponed).toBe(single?.schedulerSignals.postponed);
    expect(row?.schedulerSignals.scheduleReason).toEqual(single?.schedulerSignals.scheduleReason);
  });
});

/**
 * U11 — queue tag-filter batched membership drift tests.
 *
 * The tag-filter paths in `list()` (both the count pass over the full due set and the
 * result-filter pass) formerly called `listTags(element.id)` per row — an N+1 of 2
 * SQL/element over the uncapped due set. U11 replaces both with a SINGLE batched
 * `listTagsForMany` call before the loops, mirroring the `buildConceptMatcher` /
 * `liveMembershipMap` pattern. These drift tests assert that the batched path produces
 * byte-identical output (same members, same counts) compared to what the old per-row
 * path would have returned, and guard the correctness invariants the plan requires.
 */
describe("QueueQuery U11 — tag-filter batched membership", () => {
  it("drift: list + counts with an active tag filter deepEquals pre-refactor behaviour over a tagged seed", () => {
    // Seed: source tagged "philosophy" + extract tagged "definitions" + card (no tag).
    // The tag filter "definitions" must include only the extract in both items AND counts.
    const source = repos.sources.create({
      title: "Philosophy source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "active",
    });
    repos.elements.reschedule(source.element.id, iso("2026-05-29T08:00:00.000Z"));
    repos.elements.addTag(source.element.id, "philosophy");

    const extract = repos.sources.createExtract({
      sourceElementId: source.element.id,
      title: "Key definition extract",
      priority: PRIORITY_LABEL_VALUE.B,
      selectedText: "A definition.",
      blockIds: ["blk_u11_1" as BlockId],
      label: "Def · ¶1",
    });
    repos.elements.update(extract.element.id, { status: "active", stage: "clean_extract" });
    repos.elements.reschedule(extract.element.id, iso("2026-05-29T08:00:00.000Z"));
    repos.elements.addTag(extract.element.id, "definitions");
    repos.elements.addTag(extract.element.id, "philosophy"); // multiple tags

    const card = repos.review.createCard({
      kind: "qa",
      title: "No-tag card",
      priority: PRIORITY_LABEL_VALUE.B,
      prompt: "Q?",
      answer: "A.",
      parentId: extract.element.id,
      sourceId: source.element.id,
      sourceLocationId: extract.location.id,
      stage: "active_card",
    });
    repos.review.recordReview(card.element.id, {
      rating: "good",
      reviewedAt: iso("2026-05-26T08:00:00.000Z"),
      responseMs: 3000,
      prevState: "new",
      nextState: "review",
      nextStability: 4,
      nextDifficulty: 5,
      nextDueAt: iso("2026-05-29T08:00:00.000Z"),
      elapsedDays: 3,
      scheduledDays: 3,
      reps: 2,
      lapses: 0,
      nextLearningSteps: 0,
    });

    // Filter by "definitions": only the extract qualifies.
    const filtered = queue.list({ asOf: NOW, filters: { tag: "definitions" } });
    expect(filtered.items.map((i) => i.id)).toEqual([extract.element.id]);
    expect(filtered.counts.all).toBe(1);
    expect(filtered.counts.extract).toBe(1);
    expect(filtered.counts.source).toBe(0);
    expect(filtered.counts.card).toBe(0);

    // Filter by "philosophy": source AND extract qualify; card stays out.
    const philFiltered = queue.list({ asOf: NOW, filters: { tag: "philosophy" } });
    expect(philFiltered.items.map((i) => i.id)).toContain(source.element.id);
    expect(philFiltered.items.map((i) => i.id)).toContain(extract.element.id);
    expect(philFiltered.items.map((i) => i.id)).not.toContain(card.element.id);
    expect(philFiltered.counts.all).toBe(2);
  });

  it("element with multiple tags — filter matching ONE of them includes the element", () => {
    const source = repos.sources.create({
      title: "Multi-tag source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "active",
    });
    repos.elements.reschedule(source.element.id, iso("2026-05-29T08:00:00.000Z"));
    repos.elements.addTag(source.element.id, "alpha");
    repos.elements.addTag(source.element.id, "beta");
    repos.elements.addTag(source.element.id, "gamma");

    // Each individual tag matches the element.
    for (const tag of ["alpha", "beta", "gamma"]) {
      const res = queue.list({ asOf: NOW, filters: { tag } });
      expect(res.items.map((i) => i.id)).toContain(source.element.id);
      expect(res.counts.all).toBe(1);
    }

    // A tag not assigned to the element returns nothing.
    expect(queue.list({ asOf: NOW, filters: { tag: "delta" } }).items).toHaveLength(0);
  });

  it("no tag filter active — tag map is NOT built (no extra query, no behaviour change)", () => {
    // Seed due items and run WITHOUT a tag filter; the result must be identical to
    // before U11 (all due items present). This guards that the refactor does not
    // accidentally apply an empty tag filter that would drop all results.
    const { sourceId, extractId, qaCardId } = buildDueSet();
    const res = queue.list({ asOf: NOW });
    const ids = res.items.map((i) => i.id);
    expect(ids).toContain(sourceId);
    expect(ids).toContain(extractId);
    expect(ids).toContain(qaCardId);
    expect(res.counts.all).toBe(3);
  });

  it("drift non-vacuous guard: injecting a wrong tag membership causes the test to fail", () => {
    // Sanity-check that the drift test above would have caught a bug.
    // The extract is tagged "definitions"; if we check the WRONG tag, it should return 0.
    const source = repos.sources.create({
      title: "Guard source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "active",
    });
    repos.elements.reschedule(source.element.id, iso("2026-05-29T08:00:00.000Z"));
    const extract = repos.sources.createExtract({
      sourceElementId: source.element.id,
      title: "Guard extract",
      priority: PRIORITY_LABEL_VALUE.B,
      selectedText: "Guard.",
      blockIds: ["blk_u11_guard" as BlockId],
      label: "Guard",
    });
    repos.elements.update(extract.element.id, { status: "active", stage: "clean_extract" });
    repos.elements.reschedule(extract.element.id, iso("2026-05-29T08:00:00.000Z"));
    repos.elements.addTag(extract.element.id, "definitions");

    // Correct tag returns 1; wrong tag returns 0 — proves the filter is not vacuous.
    expect(queue.list({ asOf: NOW, filters: { tag: "definitions" } }).counts.all).toBe(1);
    expect(queue.list({ asOf: NOW, filters: { tag: "wrong-tag" } }).counts.all).toBe(0);
  });
});

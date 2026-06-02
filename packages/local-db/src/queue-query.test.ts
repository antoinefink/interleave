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
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    prevState: "review",
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
    expect(card?.scheduler).toBe("fsrs");
    expect(card?.schedulerSignals.kind).toBe("fsrs");
    expect(extract?.scheduler).toBe("attention");
    expect(extract?.schedulerSignals.kind).toBe("attention");
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
      prevState: "review",
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
});

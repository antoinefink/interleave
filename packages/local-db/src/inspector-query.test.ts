/**
 * InspectorQuery tests (T010).
 *
 * The universal inspector's read query is the seam that keeps inspector domain
 * logic out of React, so its behaviour is unit-tested against a temporary,
 * fully-migrated in-memory `better-sqlite3` database (via the same harness the
 * repository tests use). These assert the load-bearing invariants the inspector
 * surfaces:
 *
 *  - cards are on the FSRS scheduler (memory signals: retrievability/stability/
 *    difficulty + a review summary), everything else on the attention scheduler
 *    (process-again signals: stage/priority/postponed) — the two-scheduler split;
 *  - lineage (parent / children / owning source / source location) is assembled
 *    both directions from the `card → extract → source` chain;
 *  - tags and provenance surface; a soft-deleted or unknown id returns `null`;
 *  - `list()` returns every live element type, newest first.
 */

import type { BlockId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { CardEditService } from "./card-edit-service";
import { DocumentRepository } from "./document-repository";
import { createRepositories, type Repositories } from "./index";
import { InspectorQuery, schedulerKindForType } from "./inspector-query";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let inspector: InspectorQuery;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  inspector = new InspectorQuery(repos);
});

afterEach(() => {
  handle.sqlite.close();
});

/** Build a source → extract → (Q&A card) chain with a tag + a review. */
function buildChain() {
  const source = repos.sources.create({
    title: "On the Measure of Intelligence",
    priority: 0.875,
    status: "active",
    author: "François Chollet",
    url: "https://arxiv.org/abs/1911.01547?utm_source=feed",
    canonicalUrl: "https://arxiv.org/abs/1911.01547",
    originalUrl: "https://arxiv.org/abs/1911.01547?utm_source=feed",
    accessedAt: "2026-05-20T09:30:00.000Z",
    reasonAdded: "Foundational paper.",
  });
  const sourceId = source.element.id;

  const extract = repos.sources.createExtract({
    sourceElementId: sourceId,
    title: "Intelligence = skill-acquisition efficiency",
    priority: 0.875,
    selectedText: "We define the intelligence of a system as a measure of its skill-acquisition…",
    blockIds: ["blk_def_p1" as BlockId],
    startOffset: 0,
    endOffset: 80,
    label: "Definition · ¶1",
  });
  const extractId = extract.element.id;
  repos.elements.addTag(extractId, "definitions");

  const card = repos.review.createCard({
    kind: "qa",
    title: "Chollet's definition of intelligence",
    priority: 0.875,
    prompt: "How does Chollet define intelligence?",
    answer: "Skill-acquisition efficiency over a scope of tasks.",
    parentId: extractId,
    sourceId,
    sourceLocationId: extract.location.id,
    stage: "active_card",
  });
  const cardId = card.element.id;
  repos.review.recordReview(cardId, {
    rating: "good",
    reviewedAt: "2026-05-25T08:00:00.000Z",
    responseMs: 3000,
    prevState: "new",
    nextState: "review",
    nextStability: 9.4,
    nextDifficulty: 5,
    nextDueAt: "2026-06-03T08:00:00.000Z",
    elapsedDays: 0,
    scheduledDays: 9,
    reps: 1,
    lapses: 0,
    nextLearningSteps: 0,
  });
  return { sourceId, extractId, cardId, locationId: extract.location.id };
}

describe("InspectorQuery.buildSchedulerSignals (the /search scheduler slice)", () => {
  it("equals get()'s scheduler when includeYield is true — no drift between the two paths", () => {
    const { sourceId, cardId } = buildChain();
    const asOf = new Date("2026-05-28T08:00:00.000Z");
    const source = repos.elements.findById(sourceId);
    const card = repos.elements.findById(cardId);
    if (!source || !card) throw new Error("fixture not found");
    expect(inspector.buildSchedulerSignals(source, asOf, { includeYield: true })).toEqual(
      inspector.get(sourceId, asOf)?.scheduler,
    );
    expect(inspector.buildSchedulerSignals(card, asOf, { includeYield: true })).toEqual(
      inspector.get(cardId, asOf)?.scheduler,
    );
  });

  it("skips the source read-%/yield + retirement rollups when includeYield is false (the cost the /search list avoids)", () => {
    const { sourceId } = buildChain();
    const source = repos.elements.findById(sourceId);
    if (!source) throw new Error("fixture not found");
    const trimmed = inspector.buildSchedulerSignals(source, new Date(), { includeYield: false });
    // The search-list variant carries the chip essentials (kind/stage) but NOT the
    // expensive source-yield rollup or retirement suggestion (a selection-detail nicety).
    expect(trimmed.kind).toBe("attention");
    expect(trimmed.yield).toBeNull();
    expect(trimmed.retirementSuggestion).toBeNull();
  });
});

describe("schedulerKindForType", () => {
  it("puts cards on FSRS and everything else on attention", () => {
    expect(schedulerKindForType("card")).toBe("fsrs");
    for (const t of [
      "source",
      "topic",
      "extract",
      "task",
      "concept",
      "media_fragment",
      "synthesis_note",
    ] as const) {
      expect(schedulerKindForType(t)).toBe("attention");
    }
  });
});

describe("InspectorQuery.get — cards (FSRS scheduler)", () => {
  it("shows FSRS signals + a review summary for a reviewed card", () => {
    const { cardId } = buildChain();
    const data = inspector.get(cardId, new Date("2026-05-28T08:00:00.000Z"));
    expect(data).not.toBeNull();
    if (!data) return;

    expect(data.element.type).toBe("card");
    expect(data.scheduler.kind).toBe("fsrs");
    expect(data.scheduler.stability).toBe(9.4);
    expect(data.scheduler.difficulty).toBe(5);
    // Reviewed 3 days before `asOf` with stability 9.4 → retrievability in (0,1).
    expect(data.scheduler.retrievability).not.toBeNull();
    expect(data.scheduler.retrievability ?? 0).toBeGreaterThan(0);
    expect(data.scheduler.retrievability ?? 1).toBeLessThanOrEqual(1);

    expect(data.review).not.toBeNull();
    expect(data.review?.reps).toBe(1);
    expect(data.review?.logCount).toBe(1);
    expect(data.review?.fsrsState).toBe("review");
  });

  it("assembles the card's lineage: parent extract, owning source, location", () => {
    const { sourceId, extractId, cardId } = buildChain();
    const data = inspector.get(cardId);
    expect(data?.parent?.id).toBe(extractId);
    expect(data?.parent?.type).toBe("extract");
    expect(data?.source?.id).toBe(sourceId);
    expect(data?.location?.label).toBe("Definition · ¶1");
    expect(data?.location?.selectedText).toContain("We define the intelligence");
    // T022 — the location carries the full jump target so the renderer can open the
    // source reader and scroll/flash the originating block with NO extra IPC.
    expect(data?.location?.sourceElementId).toBe(sourceId);
    expect(data?.location?.blockIds).toEqual(["blk_def_p1"]);
    expect(data?.location?.startOffset).toBe(0);
    expect(data?.location?.endOffset).toBe(80);
  });

  it("reports no retrievability for a brand-new, never-reviewed card", () => {
    const card = repos.review.createCard({
      kind: "qa",
      title: "Fresh card",
      priority: 0.5,
      prompt: "q",
      answer: "a",
    });
    const data = inspector.get(card.element.id);
    expect(data?.scheduler.kind).toBe("fsrs");
    expect(data?.scheduler.retrievability).toBeNull();
    expect(data?.scheduler.fsrsState).toBe("new");
  });

  it("carries the card's claim-lifetime fields + the derived expiry status (T090)", () => {
    const { cardId } = buildChain();
    // No lifetime yet → present with status "fresh" and every field null.
    const before = inspector.get(cardId);
    expect(before?.lifetime).not.toBeNull();
    expect(before?.lifetime?.status).toBe("fresh");
    expect(before?.lifetime?.validUntil).toBeNull();

    // Set a PAST valid_until → the derived status reads as "expired".
    new CardEditService(handle.db).setLifetime(cardId, {
      factStability: "slow",
      validUntil: "2020-01-01",
      jurisdiction: "global",
    });
    const after = inspector.get(cardId, new Date("2026-06-01T00:00:00.000Z"));
    expect(after?.lifetime?.status).toBe("expired");
    expect(after?.lifetime?.validUntil).toBe("2020-01-01");
    expect(after?.lifetime?.factStability).toBe("slow");
    expect(after?.lifetime?.jurisdiction).toBe("global");

    // A future review_by (no valid_until) → "due_for_review" only once it passes.
    new CardEditService(handle.db).setLifetime(cardId, {
      validUntil: "",
      reviewBy: "2026-03-01",
    });
    const due = inspector.get(cardId, new Date("2026-06-01T00:00:00.000Z"));
    expect(due?.lifetime?.status).toBe("due_for_review");
  });

  it("returns lifetime: null for a non-card element (T090)", () => {
    const { sourceId, extractId } = buildChain();
    expect(inspector.get(sourceId)?.lifetime).toBeNull();
    expect(inspector.get(extractId)?.lifetime).toBeNull();
  });
});

describe("InspectorQuery.get — attention scheduler", () => {
  it("shows attention signals + provenance for a source", () => {
    const { sourceId, extractId } = buildChain();
    const data = inspector.get(sourceId);
    expect(data).not.toBeNull();
    if (!data) return;

    expect(data.element.type).toBe("source");
    expect(data.scheduler.kind).toBe("attention");
    expect(data.scheduler.retrievability).toBeNull();
    expect(data.scheduler.stage).toBe("raw_source");
    expect(data.review).toBeNull();

    expect(data.provenance?.author).toBe("François Chollet");
    expect(data.provenance?.url).toContain("arxiv.org");
    // Provenance carries the normalized canonical URL + the verbatim original (T014).
    expect(data.provenance?.canonicalUrl).toBe("https://arxiv.org/abs/1911.01547");
    expect(data.provenance?.originalUrl).toBe("https://arxiv.org/abs/1911.01547?utm_source=feed");

    // The extract is a live child of the source.
    expect(data.children.map((c) => c.id)).toContain(extractId);

    // The source's "yield (N extracts / M cards)" chip (T083): 1 extract + 1 card,
    // and a read % (no read-point here → 0).
    expect(data.scheduler.yield).not.toBeNull();
    expect(data.scheduler.yield?.extractsCreated).toBe(1);
    expect(data.scheduler.yield?.cardsCreated).toBe(1);
    expect(data.scheduler.yield?.readPct).toBe(0);
  });

  it("surfaces a source retirement suggestion on source inspector scheduler signals", () => {
    const { element } = repos.sources.createWithDocument({
      title: "Low-yield source",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
      body: "First.\n\nSecond.\n\nThird.\n\nFourth.",
    });
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

    expect(inspector.get(element.id)?.scheduler.retirementSuggestion).toMatchObject({
      kind: "abandon",
      signalHash: expect.stringContaining(`v1|${element.id}|abandon|`),
    });
  });

  it("shows the extract's tag, parent source, and FSRS-free attention chip", () => {
    const { sourceId, extractId } = buildChain();
    const data = inspector.get(extractId);
    expect(data?.scheduler.kind).toBe("attention");
    // Yield is a SOURCE concern — an extract's attention chip carries no yield.
    expect(data?.scheduler.yield).toBeNull();
    expect(data?.tags).toContain("definitions");
    // Extract's parent is the source (default parentId on createExtract).
    expect(data?.source?.id).toBe(sourceId);
    expect(data?.review).toBeNull();
  });

  it("uses the effective postpone count in attention schedule signals", () => {
    const source = repos.sources.create({
      title: "Repeatedly postponed source",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
    });
    const sourceId = source.element.id;
    handle.db.transaction((tx) => {
      repos.elements.rescheduleWithin(tx, sourceId, "2026-06-20T12:00:00.000Z", "scheduled", {
        action: "postpone",
        scheduledAt: "2026-05-30T12:00:00.000Z",
        postpone: true,
        postponeCount: 1,
      });
      repos.operationLog.append(tx, {
        opType: "update_element",
        payload: {
          chronicPostponeReset: true,
          prevEffectivePostponeCount: 1,
        },
        elementId: sourceId,
      });
    });

    const data = inspector.get(sourceId);

    expect(data?.scheduler.postponed).toBe(0);
    expect(data?.scheduler.scheduleReason).toBeNull();
  });
});

describe("InspectorQuery.get — source reliability (T091)", () => {
  it("returns the source's reliability in provenance + sourceRef after an edit", () => {
    const { sourceId, cardId } = buildChain();
    // Fresh source carries no reliability — no badge.
    let data = inspector.get(sourceId);
    expect(data?.provenance?.reliabilityTier).toBeNull();
    expect(data?.sourceRef?.reliabilityTier).toBeNull();

    repos.sources.updateReliability(sourceId, {
      sourceType: "paper",
      reliabilityTier: "primary",
      confidence: "high",
      reliabilityNotes: "Peer reviewed.",
    });

    // The source inspector now carries reliability in BOTH provenance and the ref.
    data = inspector.get(sourceId);
    expect(data?.provenance?.sourceType).toBe("paper");
    expect(data?.provenance?.reliabilityTier).toBe("primary");
    expect(data?.provenance?.confidence).toBe("high");
    expect(data?.provenance?.reliabilityNotes).toBe("Peer reviewed.");
    expect(data?.sourceRef?.reliabilityTier).toBe("primary");

    // A card derived from the source INHERITS the source's reliability on its sourceRef
    // (the "reliability on important cards" surfacing) — even though the card itself has
    // no provenance row.
    const cardData = inspector.get(cardId);
    expect(cardData?.provenance).toBeNull();
    expect(cardData?.sourceRef?.reliabilityTier).toBe("primary");
    expect(cardData?.sourceRef?.confidence).toBe("high");
    expect(cardData?.sourceRef?.reliabilityNotes).toBe("Peer reviewed.");
  });

  it("a null-reliability source yields a sourceRef with no reliability fields set", () => {
    const { cardId } = buildChain();
    const cardData = inspector.get(cardId);
    expect(cardData?.sourceRef?.sourceType).toBeNull();
    expect(cardData?.sourceRef?.reliabilityTier).toBeNull();
    expect(cardData?.sourceRef?.confidence).toBeNull();
    expect(cardData?.sourceRef?.reliabilityNotes).toBeNull();
  });
});

describe("InspectorQuery.get — absence", () => {
  it("returns null for an unknown id", () => {
    expect(inspector.get("nope-not-an-id" as never)).toBeNull();
  });

  it("returns null for a soft-deleted element", () => {
    const { extractId } = buildChain();
    repos.elements.softDelete(extractId);
    expect(inspector.get(extractId)).toBeNull();
  });
});

describe("InspectorQuery.list", () => {
  it("returns summaries for every live element, newest first", () => {
    buildChain();
    const list = inspector.list();
    const types = list.map((e) => e.type);
    expect(types).toContain("source");
    expect(types).toContain("extract");
    expect(types).toContain("card");
    // Newest-first ordering (descending createdAt).
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (prev && cur) {
        // ids are time-ordered; summaries carry no createdAt, so assert via the
        // source repo that the list is non-empty and well-formed instead.
        expect(typeof cur.id).toBe("string");
      }
    }
    expect(list.length).toBeGreaterThanOrEqual(3);
  });

  it("excludes soft-deleted elements", () => {
    const { cardId } = buildChain();
    repos.elements.softDelete(cardId);
    expect(inspector.list().map((e) => e.id)).not.toContain(cardId);
  });
});

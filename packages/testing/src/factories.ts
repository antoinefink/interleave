/**
 * Shared factories + the demo collection (T009).
 *
 * One source of truth for "what realistic content looks like", reused by BOTH
 * Vitest (deterministic fixtures for repository/domain tests) and Playwright
 * (the `pnpm seed` dev database the E2E flow drives). Everything here builds the
 * collection THROUGH the `packages/local-db` repositories — never raw inserts —
 * so the seed exercises the real invariants: multi-table mutations run in
 * transactions, every meaningful mutation appends an `operation_log` row, and the
 * load-bearing `card → extract → source_location → source` lineage is created
 * exactly the way the app creates it.
 *
 * The content itself (titles, prompts, block ids, offsets, priorities) is fixed,
 * so a test that asserts on it is deterministic; row ids are domain-generated
 * UUIDs (per the SQLite rules), so {@link seedDemoCollection} RETURNS a typed
 * handle of every created element/location/card. Tests navigate lineage by that
 * handle (by reference), not by guessing ids — the same way the seeded UI does.
 *
 * Concepts have no dedicated repository or `operation_log` op (like assets and
 * settings), so the concept rows are inserted via the bound Drizzle client and
 * concept *membership* is recorded as a `concept_membership` edge through
 * {@link ElementRepository.addRelation} (which does log `add_relation`).
 */

import type { BlockId, ElementId, IsoTimestamp, SiblingGroupId } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import { concepts, type InterleaveDatabase } from "@interleave/db";
import {
  type CardWithElement,
  type ExtractWithLocation,
  newSiblingGroupId,
  type Repositories,
  type SourceWithElement,
} from "@interleave/local-db";

/**
 * The fixed, deterministic content of the demo collection. Exported so tests can
 * assert against the exact strings/offsets the seed used without hard-coding
 * UUIDs (which are minted per run).
 */
export const DEMO_FIXTURES = {
  source: {
    title: "On the Measure of Intelligence",
    author: "François Chollet",
    url: "https://arxiv.org/abs/1911.01547",
    canonicalUrl: "https://arxiv.org/abs/1911.01547",
    publishedAt: "2019-11-05T00:00:00.000Z" as IsoTimestamp,
    accessedAt: "2026-05-20T09:30:00.000Z" as IsoTimestamp,
    reasonAdded: "Foundational paper for the ARC benchmark and a clean definition of intelligence.",
    priority: PRIORITY_LABEL_VALUE.A,
  },
  /** Stable document block ids — the anchors extracts + read-points depend on. */
  blocks: [
    { stableBlockId: "blk_intro_p1" as BlockId, blockType: "paragraph", order: 0 },
    { stableBlockId: "blk_intro_p2" as BlockId, blockType: "paragraph", order: 1 },
    { stableBlockId: "blk_def_p1" as BlockId, blockType: "paragraph", order: 2 },
    { stableBlockId: "blk_def_p2" as BlockId, blockType: "paragraph", order: 3 },
  ],
  /** The flattened body mirror (search/preview), paragraph per block. */
  paragraphs: [
    "To make deliberate progress towards more intelligent and more human-like artificial systems, we need to be following an appropriate feedback signal.",
    "We need to be able to define and evaluate intelligence in a way that enables comparisons between two systems, as well as comparisons with humans.",
    "We define the intelligence of a system as a measure of its skill-acquisition efficiency over a scope of tasks, with respect to priors, experience, and generalization difficulty.",
    "A measure of intelligence must control for prior knowledge and experience, and must reward generalization power rather than skill at any single task.",
  ],
  /** First read-point: the user has read through the first definition paragraph. */
  readPoint: { blockId: "blk_def_p1" as BlockId, offset: 0 },
  /** Raw → clean → atomic extract distilled from the definition paragraph. */
  extract: {
    title: "Intelligence = skill-acquisition efficiency",
    selectedText:
      "We define the intelligence of a system as a measure of its skill-acquisition efficiency over a scope of tasks, with respect to priors, experience, and generalization difficulty.",
    blockIds: ["blk_def_p1" as BlockId],
    startOffset: 0,
    endOffset: 181,
    label: "Definition · ¶1",
    priority: PRIORITY_LABEL_VALUE.A,
    cleanText: "Intelligence is a measure of skill-acquisition efficiency over a scope of tasks.",
    atomicText:
      "Intelligence = skill-acquisition efficiency (controlling for priors and experience).",
  },
  /** A sub-extract that narrows the parent to the single "controlling for" idea. */
  subExtract: {
    title: "Must control for priors and experience",
    selectedText: "with respect to priors, experience, and generalization difficulty.",
    blockIds: ["blk_def_p1" as BlockId],
    startOffset: 115,
    endOffset: 181,
    label: "Definition · ¶1 (clause)",
    priority: PRIORITY_LABEL_VALUE.B,
  },
  /** Q&A card distilled from the extract, anchored at the extract's source location. */
  qaCard: {
    title: "Chollet's definition of intelligence",
    prompt: "How does Chollet define the intelligence of a system?",
    answer: "As a measure of its skill-acquisition efficiency over a scope of tasks.",
    priority: PRIORITY_LABEL_VALUE.A,
  },
  /** Cloze card from the same extract; siblings of the Q&A card. */
  clozeCard: {
    title: "Intelligence definition (cloze)",
    cloze:
      "Intelligence is a measure of {{c1::skill-acquisition efficiency}} over a scope of {{c2::tasks}}.",
    priority: PRIORITY_LABEL_VALUE.B,
  },
  /**
   * A leech card (T040): a Q&A card the user keeps failing. Seeded with four
   * `again` lapses so `review_states.lapses >= LEECH_LAPSE_THRESHOLD` (4) and the
   * durable `cards.is_leech` flag is set — so the cleanup view + the in-review leech
   * banner have realistic data in dev/E2E without grading it live.
   */
  leechCard: {
    title: "Generalization difficulty (leech)",
    prompt: "What does a measure of intelligence reward, rather than single-task skill?",
    answer: "Generalization power — skill-acquisition efficiency across a scope of tasks.",
    priority: PRIORITY_LABEL_VALUE.B,
  },
  /** Four failing (`again`) reviews on the leech card → lapses cross the threshold. */
  leechReviews: [
    {
      rating: "again" as const,
      reviewedAt: "2026-05-21T08:00:00.000Z" as IsoTimestamp,
      responseMs: 9000,
      prevState: "new" as const,
      nextState: "learning" as const,
      nextStability: 0.4,
      nextDifficulty: 8.1,
      nextDueAt: "2026-05-21T08:10:00.000Z" as IsoTimestamp,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 1,
      lapses: 1,
    },
    {
      rating: "again" as const,
      reviewedAt: "2026-05-22T08:00:00.000Z" as IsoTimestamp,
      responseMs: 9500,
      prevState: "learning" as const,
      nextState: "relearning" as const,
      nextStability: 0.4,
      nextDifficulty: 8.5,
      nextDueAt: "2026-05-22T08:10:00.000Z" as IsoTimestamp,
      elapsedDays: 1,
      scheduledDays: 0,
      reps: 2,
      lapses: 2,
    },
    {
      rating: "again" as const,
      reviewedAt: "2026-05-23T08:00:00.000Z" as IsoTimestamp,
      responseMs: 10000,
      prevState: "relearning" as const,
      nextState: "relearning" as const,
      nextStability: 0.4,
      nextDifficulty: 8.9,
      nextDueAt: "2026-05-23T08:10:00.000Z" as IsoTimestamp,
      elapsedDays: 1,
      scheduledDays: 0,
      reps: 3,
      lapses: 3,
    },
    {
      rating: "again" as const,
      reviewedAt: "2026-05-24T08:00:00.000Z" as IsoTimestamp,
      responseMs: 11000,
      prevState: "relearning" as const,
      nextState: "relearning" as const,
      nextStability: 0.4,
      nextDifficulty: 9.2,
      // Parked far in the future so the seeded leech NEVER competes in the FSRS due
      // deck (it would otherwise displace the seeded Q&A card as the soonest-due
      // head and break the plain review fixtures). The leech is the CLEANUP VIEW's
      // fixture — `review.leeches()` reads by the durable `is_leech` flag, not by
      // due date, so a non-due card still surfaces there. Live leech DETECTION is
      // proven by grading a fresh card in the E2E, not by this seeded one being due.
      nextDueAt: "2099-01-01T08:10:00.000Z" as IsoTimestamp,
      elapsedDays: 1,
      scheduledDays: 0,
      reps: 4,
      lapses: 4,
    },
  ],
  /** Two reviews recorded against the Q&A card (so review_logs is non-empty). */
  reviews: [
    {
      rating: "good" as const,
      reviewedAt: "2026-05-22T08:00:00.000Z" as IsoTimestamp,
      responseMs: 4200,
      prevState: "new" as const,
      nextState: "learning" as const,
      nextStability: 3.1,
      nextDifficulty: 5.2,
      nextDueAt: "2026-05-25T08:00:00.000Z" as IsoTimestamp,
      elapsedDays: 0,
      scheduledDays: 3,
      reps: 1,
      lapses: 0,
    },
    {
      rating: "good" as const,
      reviewedAt: "2026-05-25T08:05:00.000Z" as IsoTimestamp,
      responseMs: 2600,
      prevState: "learning" as const,
      nextState: "review" as const,
      nextStability: 9.4,
      nextDifficulty: 5.0,
      nextDueAt: "2026-06-03T08:05:00.000Z" as IsoTimestamp,
      elapsedDays: 3,
      scheduledDays: 9,
      reps: 2,
      lapses: 0,
    },
  ],
  /** Tag names attached to the extract (created on demand by the repository). */
  tags: ["machine-learning", "definitions"],
  /** Hierarchical concepts: a parent "Cognition" with child "Intelligence". */
  concepts: {
    parent: { name: "Cognition" },
    child: { name: "Intelligence" },
  },
  /** A second, lower-priority inbox source so triage screens have variety. */
  inboxSource: {
    title: "The Bitter Lesson",
    author: "Rich Sutton",
    url: "http://www.incompleteideas.net/IncIdeas/BitterLesson.html",
    reasonAdded: "Counterpoint on scaling vs. hand-crafted priors — triage later.",
    priority: PRIORITY_LABEL_VALUE.C,
  },
  /** Asset metadata pointing at vault paths/hashes (bytes live on disk, not here). */
  assets: {
    snapshot: {
      kind: "snapshot" as const,
      vaultRoot: "assets" as const,
      relativePathSuffix: "snapshot.json",
      contentHash: "sha256:9f1c0b5b3e2a47d18c6f0a2b4d8e1f30c5a7b9d2e4f60718293a4b5c6d7e8f90",
      mime: "application/json",
      size: 18432,
    },
    pdf: {
      kind: "source_pdf" as const,
      vaultRoot: "assets" as const,
      relativePathSuffix: "original.pdf",
      contentHash: "sha256:1a2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
      mime: "application/pdf",
      size: 1048576,
    },
  },
  /** Settings the seed writes so the scheduler/UI have sane dev defaults. */
  settings: {
    "review.dailyBudget": 60,
    "review.defaultDesiredRetention": 0.9,
    "scheduler.defaultTopicIntervalDays": 7,
    "source.defaultPriority": PRIORITY_LABEL_VALUE.C,
    "ui.keyboardLayout": "qwerty",
    "ui.theme": "dark",
  },
} as const;

/** A fully-built ProseMirror doc body for the demo source (one paragraph per block). */
function buildProseMirrorDoc(): unknown {
  return {
    type: "doc",
    content: DEMO_FIXTURES.blocks.map((block, i) => ({
      type: "paragraph",
      attrs: { blockId: block.stableBlockId },
      content: [{ type: "text", text: DEMO_FIXTURES.paragraphs[i] }],
    })),
  };
}

/** Concept element ids minted for the seeded concept hierarchy. */
export interface SeededConcepts {
  readonly parentConceptId: ElementId;
  readonly childConceptId: ElementId;
}

/**
 * Every element/location/card the demo collection creates, returned so callers
 * (tests + the seed CLI summary) can navigate the lineage by reference instead
 * of re-querying or guessing ids.
 */
export interface DemoCollection {
  readonly source: SourceWithElement;
  readonly inboxSource: SourceWithElement;
  readonly extract: ExtractWithLocation;
  readonly subExtract: ExtractWithLocation;
  readonly qaCard: CardWithElement;
  readonly clozeCard: CardWithElement;
  /** A Q&A card flagged a leech (≥4 lapses) — the cleanup view's seeded data (T040). */
  readonly leechCard: CardWithElement;
  readonly concepts: SeededConcepts;
  readonly siblingGroupId: SiblingGroupId;
}

/**
 * Create a concept as a `concept`-type element (via {@link ElementRepository}, so
 * `create_element` is logged) PLUS its `concepts` hierarchy side-table row. A
 * concept IS an element — concept-membership edges in `element_relations`
 * reference `elements.id`, so the concept must exist as an element for the FK to
 * hold. The hierarchy row carries the optional parent link. Returns the concept
 * element id.
 */
function createConcept(
  repos: Repositories,
  db: InterleaveDatabase,
  name: string,
  parentConceptId: ElementId | null,
): ElementId {
  const element = repos.elements.create({
    type: "concept",
    status: "active",
    stage: "synthesis",
    priority: PRIORITY_LABEL_VALUE.B,
    title: name,
  });
  db.insert(concepts).values({ id: element.id, name, parentConceptId }).run();
  return element.id;
}

/**
 * Build the realistic demo collection through the repositories. Designed to run
 * against a freshly-reset database — the dev `pnpm seed` script
 * (`packages/db/scripts/seed-dev.ts`) deletes + re-migrates the dev SQLite file
 * first; tests pass a fresh in-memory `createInMemoryDb()` handle.
 *
 * What it creates, exercising the full lineage + op-log:
 *  - a high-priority `source` (element + provenance) with a 4-block document body
 *    and a read-point;
 *  - the `raw → clean → atomic` extract chain (one extract advanced through the
 *    three stages) anchored at a `source_location`;
 *  - a `sub-extract` (lineage: source → extract → sub-extract);
 *  - a Q&A card and a cloze card distilled from the extract, both anchored at the
 *    extract's source location and grouped as siblings;
 *  - a fresh review state plus two `review_logs` on the Q&A card;
 *  - two hierarchical concepts (Cognition → Intelligence) with membership edges,
 *    and two tags on the extract;
 *  - asset metadata (a snapshot + a PDF) pointing at vault paths/hashes;
 *  - a second, lower-priority `inbox` source for triage variety.
 */
export function seedDemoCollection(repos: Repositories, db: InterleaveDatabase): DemoCollection {
  const f = DEMO_FIXTURES;

  // 1) Source element + provenance, accepted into active learning.
  const source = repos.sources.create({
    title: f.source.title,
    priority: f.source.priority,
    status: "active",
    author: f.source.author,
    url: f.source.url,
    canonicalUrl: f.source.canonicalUrl,
    publishedAt: f.source.publishedAt,
    accessedAt: f.source.accessedAt,
    reasonAdded: f.source.reasonAdded,
  });
  const sourceId = source.element.id;

  // 2) Document body + stable blocks (the lineage anchors).
  repos.documents.upsert({
    elementId: sourceId,
    prosemirrorJson: buildProseMirrorDoc(),
    plainText: f.paragraphs.join("\n\n"),
    blocks: f.blocks.map((b) => ({
      blockType: b.blockType,
      order: b.order,
      stableBlockId: b.stableBlockId,
    })),
  });

  // 3) Read-point: the user has reached the definition paragraph.
  repos.documents.setReadPoint({
    elementId: sourceId,
    documentId: sourceId,
    blockId: f.readPoint.blockId,
    offset: f.readPoint.offset,
  });

  // 4) Extract anchored at the definition block, advanced raw → clean → atomic.
  const extract = repos.sources.createExtract({
    sourceElementId: sourceId,
    title: f.extract.title,
    priority: f.extract.priority,
    selectedText: f.extract.selectedText,
    blockIds: f.extract.blockIds,
    startOffset: f.extract.startOffset,
    endOffset: f.extract.endOffset,
    label: f.extract.label,
  });
  const extractId = extract.element.id;
  // Advance the distillation stage (raw_extract → clean_extract → atomic_statement).
  repos.elements.update(extractId, { stage: "clean_extract", status: "active" });
  repos.elements.update(extractId, { stage: "atomic_statement" });

  // 5) Sub-extract: a narrower clause, lineage source → extract → sub-extract.
  const subExtract = repos.sources.createExtract({
    sourceElementId: sourceId,
    parentId: extractId,
    title: f.subExtract.title,
    priority: f.subExtract.priority,
    selectedText: f.subExtract.selectedText,
    blockIds: f.subExtract.blockIds,
    startOffset: f.subExtract.startOffset,
    endOffset: f.subExtract.endOffset,
    label: f.subExtract.label,
  });
  // Record the explicit derived-from edge (sub-extract → extract).
  repos.elements.addRelation({
    fromElementId: subExtract.element.id,
    toElementId: extractId,
    relationType: "derived_from",
  });

  // 6) Two cards distilled from the extract, anchored at the extract's location,
  //    grouped as siblings so review never shows them back-to-back.
  const siblingGroupId = newSiblingGroupId();
  const qaCard = repos.review.createCard({
    kind: "qa",
    title: f.qaCard.title,
    priority: f.qaCard.priority,
    prompt: f.qaCard.prompt,
    answer: f.qaCard.answer,
    parentId: extractId,
    sourceId,
    sourceLocationId: extract.location.id,
    stage: "active_card",
  });
  const clozeCard = repos.review.createCard({
    kind: "cloze",
    title: f.clozeCard.title,
    priority: f.clozeCard.priority,
    cloze: f.clozeCard.cloze,
    parentId: extractId,
    sourceId,
    sourceLocationId: extract.location.id,
    stage: "card_draft",
  });
  repos.elements.addRelation({
    fromElementId: qaCard.element.id,
    toElementId: clozeCard.element.id,
    relationType: "sibling_group",
    siblingGroupId,
  });

  // 7) Two reviews on the Q&A card (durable review_logs + advanced FSRS state).
  for (const review of f.reviews) {
    repos.review.recordReview(qaCard.element.id, review);
  }

  // 7b) A leech card (T040): a Q&A card distilled from the same extract, failed
  //     four times so `lapses >= 4` → `recordReview` auto-sets the durable
  //     `cards.is_leech` flag. It surfaces in the cleanup view + the review banner.
  const leechCard = repos.review.createCard({
    kind: "qa",
    title: f.leechCard.title,
    priority: f.leechCard.priority,
    prompt: f.leechCard.prompt,
    answer: f.leechCard.answer,
    parentId: extractId,
    sourceId,
    sourceLocationId: extract.location.id,
    stage: "active_card",
  });
  for (const review of f.leechReviews) {
    repos.review.recordReview(leechCard.element.id, review);
  }

  // 8) Concepts (hierarchical) + membership edges, and tags on the extract.
  const parentConceptId = createConcept(repos, db, f.concepts.parent.name, null);
  const childConceptId = createConcept(repos, db, f.concepts.child.name, parentConceptId);
  repos.elements.addRelation({
    fromElementId: sourceId,
    toElementId: childConceptId,
    relationType: "concept_membership",
  });
  repos.elements.addRelation({
    fromElementId: extractId,
    toElementId: childConceptId,
    relationType: "concept_membership",
  });
  for (const tag of f.tags) {
    repos.elements.addTag(extractId, tag);
  }

  // 9) Asset metadata pointing at vault paths/hashes (bytes live on disk).
  repos.assets.create({
    owningElementId: sourceId,
    kind: f.assets.snapshot.kind,
    vaultRoot: f.assets.snapshot.vaultRoot,
    relativePath: `sources/${sourceId}/${f.assets.snapshot.relativePathSuffix}`,
    contentHash: f.assets.snapshot.contentHash,
    mime: f.assets.snapshot.mime,
    size: f.assets.snapshot.size,
  });
  repos.assets.create({
    owningElementId: sourceId,
    kind: f.assets.pdf.kind,
    vaultRoot: f.assets.pdf.vaultRoot,
    relativePath: `sources/${sourceId}/${f.assets.pdf.relativePathSuffix}`,
    contentHash: f.assets.pdf.contentHash,
    mime: f.assets.pdf.mime,
    size: f.assets.pdf.size,
  });

  // 10) A second, lower-priority inbox source for triage variety.
  const inboxSource = repos.sources.create({
    title: f.inboxSource.title,
    priority: f.inboxSource.priority,
    status: "inbox",
    author: f.inboxSource.author,
    url: f.inboxSource.url,
    reasonAdded: f.inboxSource.reasonAdded,
  });

  // 11) Dev settings the scheduler/UI read.
  repos.settings.setMany(f.settings);

  return {
    source,
    inboxSource,
    extract,
    subExtract,
    qaCard,
    clozeCard,
    leechCard,
    concepts: { parentConceptId, childConceptId },
    siblingGroupId,
  };
}

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
 * Concepts (T041) are created through {@link ConceptRepository.createConcept},
 * which writes the `concept`-type element (logging `create_element`) AND the
 * `concepts` hierarchy row in ONE transaction; concept *membership* is recorded as
 * a `concept_membership` edge through {@link ElementRepository.addRelation} (which
 * logs `add_relation`). The seed therefore round-trips the exact shape the
 * `concepts.*` `window.appApi` surface reads.
 */

import type { BlockId, ElementId, IsoTimestamp, SiblingGroupId } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  type CardWithElement,
  type ExtractWithLocation,
  newSiblingGroupId,
  OcclusionService,
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
      nextLearningSteps: 0,
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
      nextLearningSteps: 0,
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
      nextLearningSteps: 0,
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
      nextLearningSteps: 0,
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
      nextLearningSteps: 1,
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
      nextLearningSteps: 0,
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
  /**
   * An image-occlusion example (T071): a `media_fragment` image extract (a cropped
   * figure on page 3) + two masks the user occludes, yielding two sibling
   * `image_occlusion` cards. So the editor + the review face show a real example
   * out-of-the-box and the E2E has a seeded target. The masks are normalized
   * fractions 0–1 (`RegionRect`); the base image asset is a clean crop (never baked).
   */
  occlusion: {
    figure: {
      title: "Figure 1 · ARC task grid",
      page: 3,
      pageBlockId: "blk_def_p1" as BlockId,
      region: { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.7 },
      label: "Page 3 · region",
      priority: PRIORITY_LABEL_VALUE.B,
      // The cropped figure's vault asset (clean base — masks stored separately).
      asset: {
        kind: "image" as const,
        vaultRoot: "assets" as const,
        relativePathSuffix: "original.bin",
        contentHash: "sha256:0c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f70819203a4b5c6d7e8f90",
        mime: "image/png",
        size: 24576,
      },
    },
    /** Two masks over the figure → two sibling image_occlusion cards. */
    masks: [
      { region: { x0: 0.15, y0: 0.25, x1: 0.45, y1: 0.5 }, label: "Input grid" },
      { region: { x0: 0.55, y0: 0.25, x1: 0.85, y1: 0.5 }, label: "Output grid" },
    ],
  },
  /**
   * A formula & code source (T072): a source whose body has a BLOCK formula
   * (`$$…$$` math node), an INLINE formula inside running text, and a
   * `language`-tagged code block — so source/extract/review show real math +
   * highlighted code out-of-the-box and the E2E has seeded targets. Plus a code
   * fill-in CLOZE card and a math Q&A card distilled from it.
   */
  mathCode: {
    source: {
      title: "Backpropagation in one page",
      author: "Notes",
      priority: PRIORITY_LABEL_VALUE.B,
      reasonAdded: "A compact derivation with a formula and the gradient-step code.",
    },
    // Block ids for the body's rows (paragraph / math / paragraph / codeBlock).
    blocks: [
      { stableBlockId: "blk_mc_intro" as BlockId, blockType: "paragraph" as const, order: 0 },
      { stableBlockId: "blk_mc_formula" as BlockId, blockType: "paragraph" as const, order: 1 },
      { stableBlockId: "blk_mc_inline" as BlockId, blockType: "paragraph" as const, order: 2 },
      { stableBlockId: "blk_mc_code" as BlockId, blockType: "codeBlock" as const, order: 3 },
    ],
    /** The block formula's LaTeX (rendered with KaTeX as a display formula). */
    formulaLatex: "\\frac{\\partial L}{\\partial w} = \\delta \\cdot x",
    /** The inline formula's LaTeX (inside a sentence). */
    inlineLatex: "L = \\tfrac{1}{2}(y-\\hat{y})^2",
    /** The code block's language + body (highlighted with Shiki). */
    codeLanguage: "python",
    codeBody: "def step(w, grad, lr):\n    return w - lr * grad",
    paragraphs: [
      "Backpropagation computes the gradient of the loss with respect to each weight.",
      "The squared-error loss is L = (1/2)(y - y_hat)^2.",
    ],
    /** A code fill-in CLOZE card — a cloze over a code token (kind: cloze). */
    clozeCard: {
      title: "Gradient step (code cloze)",
      cloze: "The SGD update is ```python\nw = w - {{c1::lr}} * grad\n```",
      priority: PRIORITY_LABEL_VALUE.B,
    },
    /** A math Q&A card — the answer is a block formula (kind: qa). */
    qaCard: {
      title: "Gradient of the loss (math Q&A)",
      prompt: "What is the gradient of the loss L w.r.t. a weight w?",
      answer: "$$\\frac{\\partial L}{\\partial w} = \\delta \\cdot x$$",
      priority: PRIORITY_LABEL_VALUE.B,
    },
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
  /**
   * The image-occlusion example (T071): a `media_fragment` image extract + the two
   * sibling `image_occlusion` cards generated from its two masks. The editor + the
   * review face show a real example out-of-the-box; the E2E has a seeded target.
   */
  readonly occlusion: {
    readonly imageExtract: ExtractWithLocation;
    readonly cards: readonly { readonly id: ElementId; readonly maskId: string }[];
    readonly siblingGroupId: SiblingGroupId;
  };
  /**
   * The formula & code example (T072): a source with a block + inline formula and a
   * `language`-tagged code block, plus a code fill-in cloze card and a math Q&A card
   * distilled from a code extract — so source/extract/review show real math +
   * highlighted code out-of-the-box and the E2E has seeded targets.
   */
  readonly mathCode: {
    readonly source: SourceWithElement;
    readonly extract: ExtractWithLocation;
    readonly clozeCard: CardWithElement;
    readonly qaCard: CardWithElement;
  };
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
 *  - a second, lower-priority `inbox` source for triage variety;
 *  - an image-occlusion example (T071): a `media_fragment` image extract + two
 *    sibling `image_occlusion` cards generated from its two masks.
 *
 * The `db` handle is threaded so the occlusion generation can run through the real
 * {@link OcclusionService} (the same path the `cards.generateOcclusion` command
 * uses) — masks stored SEPARATELY from the base image, one card per mask, in one tx.
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

  // 8) Concepts (hierarchical) + membership edges, and tags on the extract. Built
  //    through the ConceptRepository (T041) — `createConcept` writes the
  //    `concept`-type element (logging `create_element`) AND the `concepts`
  //    hierarchy row in one transaction; membership is a `concept_membership` edge.
  const parentConcept = repos.concepts.createConcept({ name: f.concepts.parent.name });
  const childConcept = repos.concepts.createConcept({
    name: f.concepts.child.name,
    parentConceptId: parentConcept.id,
  });
  const parentConceptId = parentConcept.id;
  const childConceptId = childConcept.id;
  repos.concepts.assignConcept(sourceId, childConceptId);
  repos.concepts.assignConcept(extractId, childConceptId);
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

  // 11) Image-occlusion example (T071): a `media_fragment` image extract (a cropped
  //     figure on page 3) anchored at a page+region source-location, its clean base
  //     `image` asset, and TWO sibling `image_occlusion` cards generated from two
  //     masks via the real OcclusionService (masks stored SEPARATELY from the image).
  const og = f.occlusion;
  const imageExtract = repos.sources.createExtract({
    sourceElementId: sourceId,
    elementType: "media_fragment",
    title: og.figure.title,
    priority: og.figure.priority,
    selectedText: "",
    blockIds: [og.figure.pageBlockId],
    startOffset: 0,
    endOffset: 0,
    page: og.figure.page,
    region: og.figure.region,
    label: og.figure.label,
  });
  const imageElementId = imageExtract.element.id;
  // The clean base image asset (the crop) — masks are NEVER baked into it.
  repos.assets.create({
    owningElementId: imageElementId,
    kind: og.figure.asset.kind,
    vaultRoot: og.figure.asset.vaultRoot,
    relativePath: `media/${imageElementId}/${og.figure.asset.relativePathSuffix}`,
    contentHash: og.figure.asset.contentHash,
    mime: og.figure.asset.mime,
    size: og.figure.asset.size,
  });
  // Generate the two sibling image_occlusion cards (one per mask) in one tx.
  const occlusionResult = new OcclusionService(db).generate({
    imageElementId,
    masks: og.masks.map((m) => ({ region: m.region, label: m.label })),
  });

  // 12) Formula & code example (T072): a source whose body carries a block formula
  //     (a `display:true` math node), an inline formula, and a `language`-tagged code
  //     block; plus a code fill-in cloze card and a math Q&A card distilled from it.
  const mc = f.mathCode;
  const mathCodeSource = repos.sources.create({
    title: mc.source.title,
    priority: mc.source.priority,
    status: "active",
    author: mc.source.author,
    reasonAdded: mc.source.reasonAdded,
  });
  const mathCodeSourceId = mathCodeSource.element.id;
  repos.documents.upsert({
    elementId: mathCodeSourceId,
    prosemirrorJson: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId: mc.blocks[0]?.stableBlockId },
          content: [{ type: "text", text: mc.paragraphs[0] }],
        },
        // A BLOCK formula: a display:true math node alone in its paragraph.
        {
          type: "paragraph",
          attrs: { blockId: mc.blocks[1]?.stableBlockId },
          content: [{ type: "math", attrs: { latex: mc.formulaLatex, display: true } }],
        },
        // An INLINE formula inside running text.
        {
          type: "paragraph",
          attrs: { blockId: mc.blocks[2]?.stableBlockId },
          content: [
            { type: "text", text: "The squared-error loss is " },
            { type: "math", attrs: { latex: mc.inlineLatex, display: false } },
            { type: "text", text: "." },
          ],
        },
        // A language-tagged code block (highlighted with Shiki at display time).
        {
          type: "codeBlock",
          attrs: { blockId: mc.blocks[3]?.stableBlockId, language: mc.codeLanguage },
          content: [{ type: "text", text: mc.codeBody }],
        },
      ],
    },
    plainText: [
      mc.paragraphs[0],
      `$$${mc.formulaLatex}$$`,
      `The squared-error loss is $${mc.inlineLatex}$.`,
      mc.codeBody,
    ].join("\n"),
    blocks: mc.blocks.map((b) => ({
      blockType: b.blockType,
      order: b.order,
      stableBlockId: b.stableBlockId,
    })),
  });
  // An extract of the code snippet → the two code/math cards are distilled from it.
  const mathCodeExtract = repos.sources.createExtract({
    sourceElementId: mathCodeSourceId,
    title: "Gradient step",
    priority: mc.source.priority,
    selectedText: mc.codeBody,
    blockIds: [mc.blocks[3]?.stableBlockId as BlockId],
    startOffset: 0,
    endOffset: mc.codeBody.length,
    label: "Code · gradient step",
  });
  // Left `card_draft` (an UN-DUE review state) so they DON'T crowd the seeded due
  // queue/process loop (M7 owns the first schedule) — review still resolves them by id.
  const mathCodeClozeCard = repos.review.createCard({
    kind: "cloze",
    title: mc.clozeCard.title,
    priority: mc.clozeCard.priority,
    cloze: mc.clozeCard.cloze,
    parentId: mathCodeExtract.element.id,
    sourceId: mathCodeSourceId,
    sourceLocationId: mathCodeExtract.location.id,
    stage: "card_draft",
  });
  const mathCodeQaCard = repos.review.createCard({
    kind: "qa",
    title: mc.qaCard.title,
    priority: mc.qaCard.priority,
    prompt: mc.qaCard.prompt,
    answer: mc.qaCard.answer,
    parentId: mathCodeExtract.element.id,
    sourceId: mathCodeSourceId,
    sourceLocationId: mathCodeExtract.location.id,
    stage: "card_draft",
  });

  // 13) Dev settings the scheduler/UI read.
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
    occlusion: {
      imageExtract,
      cards: occlusionResult.cards.map((c) => ({ id: c.id, maskId: c.maskId })),
      siblingGroupId: occlusionResult.siblingGroupId,
    },
    mathCode: {
      source: mathCodeSource,
      extract: mathCodeExtract,
      clozeCard: mathCodeClozeCard,
      qaCard: mathCodeQaCard,
    },
  };
}

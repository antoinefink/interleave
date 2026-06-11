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
import { elements, type InterleaveDatabase } from "@interleave/db";
import {
  CardEditService,
  CardRetirementService,
  type CardWithElement,
  type ExtractWithLocation,
  newSiblingGroupId,
  OcclusionService,
  type Repositories,
  type SourceWithElement,
  TaskService,
  type TaskSummary,
} from "@interleave/local-db";
import { eq } from "drizzle-orm";

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
    // Source-reliability metadata (T091) — so the refblock/inspector specs render a
    // real badge (a card derived from this source inherits it). The second/inbox
    // sources leave reliability null to prove the no-badge case.
    sourceType: "article" as const,
    reliabilityTier: "secondary" as const,
    confidence: "medium" as const,
    reliabilityNotes: "Pre-print; influential but not peer reviewed.",
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
  /**
   * Q&A card distilled from the extract, anchored at the extract's source location.
   * Carries a claim-lifetime (T090) whose `valid_until`/`review_by` are in the PAST
   * (2020) so the card reads as EXPIRED — giving the inspector/review specs + the T092
   * generation scan a real stale fact. `valid_from` dates the original claim; the
   * stability + jurisdiction/version fields exercise the display rows. Other seeded
   * cards keep `null` lifetimes (they never expire).
   */
  qaCard: {
    title: "Chollet's definition of intelligence",
    prompt: "How does Chollet define the intelligence of a system?",
    answer: "As a measure of its skill-acquisition efficiency over a scope of tasks.",
    priority: PRIORITY_LABEL_VALUE.A,
    lifetime: {
      factStability: "slow" as const,
      validFrom: "2019-11-05",
      validUntil: "2020-01-01",
      jurisdiction: "global",
      softwareVersion: null,
      reviewBy: "2020-01-01",
    },
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
  /**
   * A retired card (T082): a low-value MATURE Q&A card (high stability, low B
   * priority, well-learned) the user retired so it stops costing review time but is
   * kept for reference. Seeded with two strong `good`/`easy` reviews → high stability,
   * then the durable `cards.is_retired` flag is set, so the Retired-cards inventory +
   * the analytics "Retired" metric have realistic data in dev/E2E without retiring one
   * live. A retired card is SKIPPED by the due read, so it never competes in the deck.
   */
  retiredCard: {
    title: "Skill-acquisition efficiency (retired)",
    prompt: "What single phrase captures the essence of Chollet's intelligence measure?",
    answer: "Skill-acquisition efficiency.",
    priority: PRIORITY_LABEL_VALUE.D,
  },
  /** Two strong reviews → a high-stability mature card, then retired. */
  retiredReviews: [
    {
      rating: "good" as const,
      reviewedAt: "2026-04-01T08:00:00.000Z" as IsoTimestamp,
      responseMs: 3000,
      prevState: "new" as const,
      nextState: "review" as const,
      nextStability: 18.0,
      nextDifficulty: 4.4,
      nextDueAt: "2026-04-19T08:00:00.000Z" as IsoTimestamp,
      elapsedDays: 0,
      scheduledDays: 18,
      reps: 1,
      lapses: 0,
      nextLearningSteps: 0,
    },
    {
      rating: "easy" as const,
      reviewedAt: "2026-04-19T08:00:00.000Z" as IsoTimestamp,
      responseMs: 1800,
      prevState: "review" as const,
      nextState: "review" as const,
      nextStability: 64.0,
      nextDifficulty: 4.1,
      // Far-future due so the mature retired card never heads the deck even if the
      // flag were ignored; the flag is the real exclusion.
      nextDueAt: "2026-06-22T08:00:00.000Z" as IsoTimestamp,
      elapsedDays: 18,
      scheduledDays: 64,
      reps: 2,
      lapses: 0,
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
  /**
   * A verification task (T092) linked to the EXPIRED Q&A card — a "verify this claim"
   * maintenance action, due today, so the queue/inspector specs have a live `task`
   * element (the first seeded `task`). Created through the SAME production path
   * (`TaskService.createTask`: `task` element + `tasks` row + the `references` edge in
   * one transaction; attention-scheduled, never FSRS).
   */
  verifyTask: {
    taskType: "verify_claim" as const,
    title: "Verify Chollet's definition of intelligence",
    note: "Confirm the skill-acquisition-efficiency framing still holds.",
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
    // Per-priority/per-concept retention (T079) enabled with one A-band target so the
    // demo shows high-value cards held to a higher target (shorter intervals).
    "review.retentionByBand.enabled": true,
    "review.retentionByBand": { A: 0.93 },
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
  /** A retired mature Q&A card (`cards.is_retired`) — the retired-inventory seed (T082). */
  readonly retiredCard: CardWithElement;
  /**
   * An open `verify_claim` verification task (T092) linked to the EXPIRED Q&A card —
   * the first seeded `task` element, due today, so the queue/inspector specs have a
   * live maintenance task to exercise.
   */
  readonly verifyTask: TaskSummary;
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
    // Source-reliability metadata (T091).
    sourceType: f.source.sourceType,
    reliabilityTier: f.source.reliabilityTier,
    confidence: f.source.confidence,
    reliabilityNotes: f.source.reliabilityNotes,
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

  // 6b) Claim-lifetime on the Q&A card (T090) — a PAST `valid_until`/`review_by` so the
  //     card reads as EXPIRED (the inspector Expiry section + the review banner + the
  //     T092 generation scan have a real stale fact). Applied through the SAME
  //     production path (`CardEditService.setLifetime`: one transaction + `update_element`),
  //     never a raw insert.
  new CardEditService(db).setLifetime(qaCard.element.id, f.qaCard.lifetime);

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

  // 7c) A retired card (T082): a low-value MATURE Q&A card from the same extract,
  //     given two strong reviews → high stability, then RETIRED (the durable
  //     `cards.is_retired` flag). It surfaces in the Retired-cards inventory + the
  //     analytics "Retired" metric, and is SKIPPED by the due/review reads. Retire is
  //     a distinct, reversible exit (not suspend, not delete) — un-retire restores it.
  const retiredCard = repos.review.createCard({
    kind: "qa",
    title: f.retiredCard.title,
    priority: f.retiredCard.priority,
    prompt: f.retiredCard.prompt,
    answer: f.retiredCard.answer,
    parentId: extractId,
    sourceId,
    sourceLocationId: extract.location.id,
    stage: "mature_card",
  });
  for (const review of f.retiredReviews) {
    repos.review.recordReview(retiredCard.element.id, review);
  }
  // Retire it (the durable flag) and capture the post-retire card so the returned
  // collection reflects `isRetired: true` for tests/seed echo.
  const retiredCardAfter = new CardRetirementService(db).retire(retiredCard.element.id, {
    reason: "Low-value, well-learned",
  });

  // 7d) A verification task (T092) linked to the EXPIRED Q&A card — a "verify this
  //     claim" maintenance action due today, the FIRST seeded `task` element. Created
  //     through the real TaskService (the `task` element + the `tasks` row + the
  //     `references` edge in ONE transaction; attention-scheduled, never FSRS) so the
  //     queue/inspector specs have a live task to exercise.
  const verifyTask = new TaskService(db).createTask({
    taskType: f.verifyTask.taskType,
    title: f.verifyTask.title,
    note: f.verifyTask.note,
    linkedElementId: qaCard.element.id,
    dueChoice: "tomorrow",
  });

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
  // A per-concept retention target (T079) so the demo shows a fragile concept held to a
  // higher target than the global default (the strictest concept among a card's wins).
  repos.concepts.setConceptRetention(childConceptId, 0.94);
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
    retiredCard: retiredCardAfter,
    verifyTask,
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

/** The element ids the maintenance fixture plants, returned for the e2e to assert on. */
export interface MaintenanceCollection {
  /** The two live sources sharing a canonical URL — a duplicate cluster. */
  readonly duplicateSourceKeeper: ElementId;
  readonly duplicateSourceRedundant: ElementId;
  /** A hand-authored card with no source_location_id, source_id, or derived_from ancestor. */
  readonly sourcelessCard: ElementId;
  /** A live source whose snapshot asset row points at `brokenSnapshotRelPath` (file removed by the test). */
  readonly brokenSource: ElementId;
  /** The canonical relative path of the broken source's snapshot asset (delete this on disk). */
  readonly brokenSnapshotRelPath: string;
  /** A low-priority (D), stale source — a bulk-archive / postpone candidate. */
  readonly lowValueSource: ElementId;
  /** Due parked sources old enough for the T102 resurfacing sweep's three verbs. */
  readonly parkedResurfacingKeepSource: ElementId;
  readonly parkedResurfacingQueueSource: ElementId;
  readonly parkedResurfacingLetGoSource: ElementId;
  /** Chronic-postpone rows for the T106 reckoning panel's four decision verbs. */
  readonly chronicPostponeKeepSource: ElementId;
  readonly chronicPostponeDemoteSource: ElementId;
  readonly chronicPostponeDoneSource: ElementId;
  readonly chronicPostponeDeleteSource: ElementId;
}

/** Options for {@link seedMaintenanceCollection}. */
export interface SeedMaintenanceOptions {
  /** The `asOf` the low-value staleness is dated against (defaults to a fixed past date). */
  readonly staleBefore?: IsoTimestamp;
}

/**
 * Plant the deterministic maintenance fixtures (T099) the unit + e2e tests need: a
 * duplicate source pair (same canonical URL), a hand-authored sourceless card, a
 * broken source (a snapshot asset row whose file the test deletes on disk), a
 * low-priority stale source, and an old parked source for the T102 resurfacing
 * sweep. Built THROUGH the repositories where possible so the op-log + lineage
 * invariants hold. Correctness-sized — a 100k performance seed is T100's concern.
 * Returns the ids so the e2e asserts by reference.
 */
export function seedMaintenanceCollection(
  repos: Repositories,
  db: InterleaveDatabase,
  options: SeedMaintenanceOptions = {},
): MaintenanceCollection {
  // 1) A duplicate source pair under one canonical URL (keeper = newest accessed_at).
  const dupUrl = "https://example.com/maintenance-duplicate";
  const redundant = repos.sources.create({
    title: "Duplicate article (older copy)",
    priority: PRIORITY_LABEL_VALUE.C,
    status: "active",
    url: dupUrl,
    canonicalUrl: dupUrl,
    accessedAt: "2026-01-01T00:00:00.000Z" as IsoTimestamp,
  });
  const keeper = repos.sources.create({
    title: "Duplicate article (newer copy)",
    priority: PRIORITY_LABEL_VALUE.C,
    status: "active",
    url: dupUrl,
    canonicalUrl: dupUrl,
    accessedAt: "2026-05-01T00:00:00.000Z" as IsoTimestamp,
  });

  // 2) A hand-authored card with NO source_location_id, NO source_id, NO ancestor.
  const sourceless = repos.review.createCard({
    kind: "qa",
    title: "Hand-authored sourceless card",
    prompt: "A fact with no source.",
    answer: "Right.",
    priority: PRIORITY_LABEL_VALUE.B,
    stage: "active_card",
  });

  // 3) A broken source: a live source + a snapshot asset row whose file the test
  //    removes on disk (the row stays → verifyIntegrity reports it as `missing`).
  const broken = repos.sources.create({
    title: "Broken source (snapshot file removed)",
    priority: PRIORITY_LABEL_VALUE.B,
    status: "active",
    url: "https://example.com/broken",
    canonicalUrl: "https://example.com/broken",
    accessedAt: "2026-03-01T00:00:00.000Z" as IsoTimestamp,
  });
  const brokenSnapshotRelPath = `sources/${broken.element.id}/cleaned.html`;
  repos.assets.create({
    owningElementId: broken.element.id,
    kind: "source_html",
    vaultRoot: "assets",
    relativePath: brokenSnapshotRelPath,
    contentHash: "sha256:maintenance-broken-snapshot",
    mime: "text/html",
    size: 64,
  });

  // 4) A low-priority (D), stale source — a bulk-archive / postpone candidate. Its
  //    `updated_at` is backdated (a test-only direct write) so the staleness scan
  //    picks it up regardless of the wall clock at run time.
  const lowValue = repos.sources.create({
    title: "Low-value stale source",
    priority: PRIORITY_LABEL_VALUE.D,
    status: "active",
    reasonAdded: "Imported and forgotten.",
  });
  const stale = options.staleBefore ?? ("2026-01-01T00:00:00.000Z" as IsoTimestamp);
  db.update(elements).set({ updatedAt: stale }).where(eq(elements.id, lowValue.element.id)).run();

  // 5) Old saved-for-later sources — parked long before the default 90-day
  //    threshold, so Maintenance can exercise keep, queue, and let-go in one batch.
  const parkedKeep = repos.sources.create({
    title: "Parked resurfacing keep source",
    priority: PRIORITY_LABEL_VALUE.B,
    status: "active",
    reasonAdded: "Saved for later, then forgotten.",
  });
  const parkedQueue = repos.sources.create({
    title: "Parked resurfacing queue source",
    priority: PRIORITY_LABEL_VALUE.B,
    status: "active",
    reasonAdded: "Saved for later, then forgotten.",
  });
  const parkedLetGo = repos.sources.create({
    title: "Parked resurfacing let-go source",
    priority: PRIORITY_LABEL_VALUE.C,
    status: "active",
    reasonAdded: "Saved for later, then forgotten.",
  });
  for (const id of [parkedKeep.element.id, parkedQueue.element.id, parkedLetGo.element.id]) {
    repos.elements.update(id, {
      status: "parked",
      dueAt: null,
      parkedAt: "2026-01-01T00:00:00.000Z" as IsoTimestamp,
    });
  }

  // 6) Chronic-postpone rows — scheduled, queue-actionable, and carrying enough
  //    postpone markers to cross the default threshold. One row is future-due to
  //    prove reckoning is about behavior, not queue due eligibility.
  const chronicKeep = repos.sources.create({
    title: "Chronic postpone keep source",
    priority: PRIORITY_LABEL_VALUE.B,
    status: "scheduled",
    reasonAdded: "Repeatedly postponed but intentionally kept.",
  });
  const chronicDemote = repos.sources.create({
    title: "Chronic postpone demote source",
    priority: PRIORITY_LABEL_VALUE.B,
    status: "scheduled",
    reasonAdded: "Repeatedly postponed and ready to demote.",
  });
  const chronicDone = repos.sources.create({
    title: "Chronic postpone done source",
    priority: PRIORITY_LABEL_VALUE.C,
    status: "scheduled",
    reasonAdded: "Repeatedly postponed and now finished.",
  });
  const chronicDelete = repos.sources.create({
    title: "Chronic postpone delete source",
    priority: PRIORITY_LABEL_VALUE.C,
    status: "scheduled",
    reasonAdded: "Repeatedly postponed and ready to delete.",
  });
  const futureDue = "2026-12-01T00:00:00.000Z" as IsoTimestamp;
  db.update(elements)
    .set({ dueAt: futureDue })
    .where(eq(elements.id, chronicKeep.element.id))
    .run();
  for (const id of [
    chronicKeep.element.id,
    chronicDemote.element.id,
    chronicDone.element.id,
    chronicDelete.element.id,
  ]) {
    for (let i = 0; i < 6; i += 1) {
      db.transaction((tx) => {
        repos.operationLog.append(tx, {
          opType: "reschedule_element",
          elementId: id,
          payload: {
            id,
            dueAt: futureDue,
            prevDueAt: null,
            postpone: true,
            postponeCount: i + 1,
            action: "maintenanceSeed:chronicPostpone",
          },
        });
      });
    }
  }

  return {
    duplicateSourceKeeper: keeper.element.id,
    duplicateSourceRedundant: redundant.element.id,
    sourcelessCard: sourceless.element.id,
    brokenSource: broken.element.id,
    brokenSnapshotRelPath,
    lowValueSource: lowValue.element.id,
    parkedResurfacingKeepSource: parkedKeep.element.id,
    parkedResurfacingQueueSource: parkedQueue.element.id,
    parkedResurfacingLetGoSource: parkedLetGo.element.id,
    chronicPostponeKeepSource: chronicKeep.element.id,
    chronicPostponeDemoteSource: chronicDemote.element.id,
    chronicPostponeDoneSource: chronicDone.element.id,
    chronicPostponeDeleteSource: chronicDelete.element.id,
  };
}

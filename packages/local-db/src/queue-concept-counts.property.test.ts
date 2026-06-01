/**
 * Property-based / fuzzy tests for the `/queue` DRILL-DOWN counts
 * ({@link QueueQuery.list} `counts`).
 *
 * Sibling of the reported Library bug: the queue's per-type + at-risk counts used to
 * be computed over the WHOLE due set, while the visible list is narrowed by the
 * active status/concept/tag filters — so e.g. the "Active" status chip narrowed the
 * list to 1 source while the "Sources" type chip still read 2. The fix makes the
 * counts DRILL DOWN: each respects the active status/concept/tag filters but DROPS
 * the type dimension (the chips drive it), so a chip's number equals the rows shown
 * when that chip is selected alongside the other active filters.
 *
 * The HARD INVARIANT — `counts[type]` equals the rows of that type the list shows
 * under the active status/concept filters, and `counts.all === items.length` — is
 * exactly the cross-cutting property example tests miss. We fuzz random due worlds
 * (varied type/status/priority, concept membership incl. duplicate + dead-endpoint
 * edges) and random status/concept filter combos, then re-derive each count by
 * filtering the rendered list — and assert they agree. fast-check pins a fixed seed
 * for CI reproducibility.
 */

import type { ElementId, IsoTimestamp } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import { QueueQuery } from "./queue-query";
import { createInMemoryDb } from "./test-db";

const FC = { seed: 0x9_b17c, numRuns: 150, verbose: false } as const;
const NOW = "2026-05-30T12:00:00.000Z" as IsoTimestamp;
const PAST = "2026-05-28T08:00:00.000Z" as IsoTimestamp; // always due relative to NOW

// The due, attention-schedulable types the queue surfaces (cards are scheduled via
// FSRS below; sources/extracts/topics/tasks/synthesis notes via the attention due_at).
const ATTENTION_TYPES = ["source", "extract", "topic", "task", "synthesis_note"] as const;
type AttentionType = (typeof ATTENTION_TYPES)[number];
// The two live statuses a due attention item realistically carries (the due read
// excludes done/dismissed/suspended/deleted; the meaningful split is active vs scheduled).
const GEN_STATUSES = ["active", "scheduled", "pending", "inbox"] as const;
type GenStatus = (typeof GEN_STATUSES)[number];
const PRIORITY_BANDS = [
  PRIORITY_LABEL_VALUE.A,
  PRIORITY_LABEL_VALUE.B,
  PRIORITY_LABEL_VALUE.C,
  PRIORITY_LABEL_VALUE.D,
] as const;

let handle: DbHandle | null = null;
let repos!: Repositories;
let queue!: QueueQuery;

function freshDb(): void {
  if (handle) handle.sqlite.close();
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  queue = new QueueQuery(repos);
}

beforeEach(freshDb);
afterEach(() => {
  if (handle) handle.sqlite.close();
  handle = null;
});

interface AttSpec {
  readonly type: AttentionType;
  readonly status: GenStatus;
  readonly prioIdx: number;
}
interface CardSpec {
  readonly prioIdx: number;
}
interface EdgeSpec {
  readonly memberIdx: number; // index into the COMBINED [attention..., card...] id list
  readonly conceptIdx: number;
  readonly dup: number;
}
interface FilterSpec {
  readonly useStatus: boolean;
  readonly statusIdx: number;
  readonly useConcept: boolean;
  readonly conceptIdx: number;
}
interface WorldSpec {
  readonly attention: readonly AttSpec[];
  readonly cards: readonly CardSpec[];
  readonly concepts: readonly { deleted: boolean }[];
  readonly edges: readonly EdgeSpec[];
  readonly filter: FilterSpec;
}

const attArb: fc.Arbitrary<AttSpec> = fc.record({
  type: fc.constantFrom(...ATTENTION_TYPES),
  status: fc.constantFrom(...GEN_STATUSES),
  prioIdx: fc.integer({ min: 0, max: 3 }),
});

const worldArb: fc.Arbitrary<WorldSpec> = fc
  .record({
    attention: fc.array(attArb, { minLength: 0, maxLength: 10 }),
    cards: fc.array(fc.record({ prioIdx: fc.integer({ min: 0, max: 3 }) }), {
      minLength: 0,
      maxLength: 6,
    }),
    concepts: fc.array(fc.record({ deleted: fc.boolean() }), { minLength: 1, maxLength: 4 }),
    filter: fc.record({
      useStatus: fc.boolean(),
      statusIdx: fc.integer({ min: 0, max: GEN_STATUSES.length - 1 }),
      useConcept: fc.boolean(),
      conceptIdx: fc.nat(),
    }),
  })
  // Require at least one due element so worlds aren't trivially empty.
  .filter((w) => w.attention.length + w.cards.length > 0)
  .chain((w) => {
    const total = w.attention.length + w.cards.length;
    const edgeArb: fc.Arbitrary<EdgeSpec> = fc.record({
      memberIdx: fc.integer({ min: 0, max: total - 1 }),
      conceptIdx: fc.integer({ min: 0, max: w.concepts.length - 1 }),
      dup: fc.integer({ min: 0, max: 2 }),
    });
    return fc.record({
      attention: fc.constant(w.attention),
      cards: fc.constant(w.cards),
      concepts: fc.constant(w.concepts),
      edges: fc.array(edgeArb, { minLength: 0, maxLength: 24 }),
      filter: fc.constant(w.filter),
    });
  });

interface BuiltWorld {
  readonly liveConceptNames: readonly string[];
  readonly filters: { statuses?: readonly GenStatus[]; concept?: string };
}

function buildWorld(world: WorldSpec): BuiltWorld {
  freshDb();

  const ids: ElementId[] = [];
  // A shared host source for cards (kept out of the due set by scheduling it far out).
  const host = repos.sources.create({ title: "host", priority: PRIORITY_LABEL_VALUE.C });
  repos.elements.reschedule(host.element.id, "2099-01-01T00:00:00.000Z" as IsoTimestamp);

  for (const spec of world.attention) {
    const el = repos.elements.create({
      type: spec.type,
      status: spec.status,
      stage: "raw_extract",
      priority: PRIORITY_BANDS[spec.prioIdx] ?? PRIORITY_LABEL_VALUE.B,
      title: `att-${ids.length}`,
    });
    // Make it due in the PAST so it always appears in the queue relative to NOW.
    repos.elements.reschedule(el.id, PAST);
    ids.push(el.id);
  }
  for (const spec of world.cards) {
    const card = repos.review.createCard({
      kind: "qa",
      title: `card-${ids.length}`,
      priority: PRIORITY_BANDS[spec.prioIdx] ?? PRIORITY_LABEL_VALUE.B,
      prompt: "p",
      answer: "a",
      sourceId: host.element.id,
      stage: "active_card",
    });
    // Review into a PAST due so the FSRS due read includes it.
    repos.review.recordReview(card.element.id, {
      rating: "good",
      reviewedAt: "2026-05-20T08:00:00.000Z" as IsoTimestamp,
      responseMs: 1000,
      prevState: "review",
      nextState: "review",
      nextStability: 5,
      nextDifficulty: 5,
      nextDueAt: PAST,
      elapsedDays: 1,
      scheduledDays: 1,
      reps: 1,
      lapses: 0,
      nextLearningSteps: 0,
    });
    ids.push(card.element.id);
  }

  const conceptIds = world.concepts.map(
    (_, idx) => repos.concepts.createConcept({ name: `concept-${idx}` }).id,
  );

  // Membership edges with raw duplicates (addRelation, not assignConcept).
  for (const edge of world.edges) {
    const memberId = ids[edge.memberIdx];
    const conceptId = conceptIds[edge.conceptIdx];
    if (!memberId || !conceptId) continue;
    for (let i = 0; i < 1 + edge.dup; i++) {
      repos.elements.addRelation({
        fromElementId: memberId,
        toElementId: conceptId,
        relationType: "concept_membership",
      });
    }
  }

  // Soft-delete flagged concepts AFTER wiring (edges to dead concept endpoints).
  world.concepts.forEach((spec, idx) => {
    const id = conceptIds[idx];
    if (spec.deleted && id) repos.elements.softDelete(id);
  });

  const liveConceptNames = world.concepts
    .map((spec, idx) => ({ name: `concept-${idx}`, deleted: spec.deleted }))
    .filter((c) => !c.deleted)
    .map((c) => c.name);

  const f = world.filter;
  const filters: BuiltWorld["filters"] = {};
  if (f.useStatus) {
    const s = GEN_STATUSES[f.statusIdx];
    if (s) filters.statuses = [s];
  }
  if (f.useConcept && liveConceptNames.length > 0) {
    const picked = liveConceptNames[f.conceptIdx % liveConceptNames.length];
    if (picked) filters.concept = picked;
  }
  return { liveConceptNames, filters };
}

const COUNT_TYPES = ["card", "source", "extract", "topic", "task"] as const;

describe("QueueQuery drill-down counts — property invariants", () => {
  it("INVARIANT: counts.all === items.length, and per-type counts === rows of that type shown", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { filters } = buildWorld(world);
        const { items, counts } = queue.list({ asOf: NOW, filters });

        // all tracks the rendered (filtered) list exactly.
        expect(counts.all).toBe(items.length);

        // Each per-type count equals the rows of that type in the rendered list (the
        // type chip drills down on top of the status/concept filter, client-side).
        for (const t of COUNT_TYPES) {
          const shown = items.filter((i) => i.type === t).length;
          expect(counts[t]).toBe(shown);
        }
        // at-risk metrics agree with the rendered list too.
        expect(counts.protected).toBe(items.filter((i) => i.protected).length);
        expect(counts.highPriority).toBe(items.filter((i) => i.protected).length);
        expect(counts.overdue).toBe(items.filter((i) => i.due === "overdue").length);
      }),
      FC,
    );
  });

  it("INVARIANT: selecting any type chip yields exactly counts[type] rows (count-vs-list)", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { filters } = buildWorld(world);
        const { items, counts } = queue.list({ asOf: NOW, filters });
        // The /queue UI applies the type chip CLIENT-side over the filtered list, so a
        // chip's count must equal the post-type-filter row count.
        for (const t of COUNT_TYPES) {
          const afterChip = items.filter((i) => i.type === t);
          expect(afterChip.length).toBe(counts[t]);
        }
      }),
      FC,
    );
  });

  it("INVARIANT: a passed `types` filter narrows items but is dropped from the per-type counts", () => {
    fc.assert(
      fc.property(worldArb, fc.constantFrom(...COUNT_TYPES), (world, pinned) => {
        const { filters } = buildWorld(world);
        const unfiltered = queue.list({ asOf: NOW, filters });
        const withType = queue.list({ asOf: NOW, filters: { ...filters, types: [pinned] } });

        // The rendered list honours the type filter…
        expect(withType.items.every((i) => i.type === pinned)).toBe(true);
        // …but the per-type counts ignore the type dimension (chips drill down): they
        // equal the counts WITHOUT the type filter (same status/concept narrowing).
        for (const t of COUNT_TYPES) expect(withType.counts[t]).toBe(unfiltered.counts[t]);
        expect(withType.counts.all).toBe(unfiltered.counts.all);
      }),
      FC,
    );
  });
});

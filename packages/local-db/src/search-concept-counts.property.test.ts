/**
 * Property-based / fuzzy tests for the `/search` DRILL-DOWN per-concept counts.
 *
 * Sibling of the reported Library bug: the `/search` concept chips used to render
 * the GLOBAL {@link ConceptRepository.listConcepts} `memberCount` (members across ALL
 * element types), while the visible list is the keyword + type + concept
 * INTERSECTION — so a chip count never matched the narrowed list. The fix computes a
 * drill-down `byConcept` MAIN-side: the count over the keyword+type match set WITHOUT
 * the concept's own predicate, folded through the canonical
 * {@link ConceptRepository.liveMembershipMap} (dedup + soft-delete rules), exactly
 * like {@link LibraryQuery}.
 *
 * This pins the SAME hard invariant the Library property test does, at the search
 * layer: for every live concept `c`, the count taken over
 * {@link SearchRepository.matchedIdsForConceptCounts} equals the number of result
 * rows {@link SearchRepository.search} returns when `c` is selected alongside the
 * SAME keyword/type. We fuzz random worlds (varied searchable elements with random
 * indexed words, soft-deleted elements + concepts, duplicate + dead-endpoint edges)
 * and random keyword/type filters. fast-check pins a fixed seed for CI reproducibility.
 */

import { type ElementId, priorityToLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConceptRepository } from "./concept-repository";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ReviewRepository } from "./review-repository";
import { SearchRepository } from "./search-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

const FC = { seed: 0x5ea_3c01, numRuns: 150, verbose: false } as const;

// The deterministic vocabulary the indexed bodies/titles draw from — a small fixed
// pool so generated worlds actually share keyword hits across elements (otherwise
// every search would match at most one row and the intersection logic is untested).
const WORDS = ["alpha", "beta", "gamma", "delta", "omega"] as const;
type Word = (typeof WORDS)[number];
const SEARCHABLE = ["source", "extract", "card"] as const;
type SearchableSpecType = (typeof SEARCHABLE)[number];
const PRIORITY_LABELS = ["A", "B", "C", "D"] as const;
type PriorityLabel = (typeof PRIORITY_LABELS)[number];
/** Representative numeric value per band (the `priorityFromLabel` midpoints). */
const PRIORITY_VALUE: Readonly<Record<PriorityLabel, number>> = {
  A: 0.875,
  B: 0.625,
  C: 0.375,
  D: 0.125,
};

let handle: DbHandle | null = null;
let search!: SearchRepository;
let sources!: SourceRepository;
let documents!: DocumentRepository;
let elementsRepo!: ElementRepository;
let review!: ReviewRepository;
let conceptsRepo!: ConceptRepository;

function freshDb(): void {
  if (handle) handle.sqlite.close();
  handle = createInMemoryDb();
  search = new SearchRepository(handle.db);
  sources = new SourceRepository(handle.db);
  documents = new DocumentRepository(handle.db);
  elementsRepo = new ElementRepository(handle.db);
  review = new ReviewRepository(handle.db);
  conceptsRepo = new ConceptRepository(handle.db);
}

beforeEach(freshDb);
afterEach(() => {
  if (handle) handle.sqlite.close();
  handle = null;
});

interface ElementSpec {
  readonly type: SearchableSpecType;
  readonly words: readonly Word[]; // words indexed in title/body
  readonly priority: PriorityLabel;
  readonly deleted: boolean;
}
interface EdgeSpec {
  readonly memberIdx: number;
  readonly conceptIdx: number;
  readonly dup: number;
}
interface WorldSpec {
  readonly elements: readonly ElementSpec[];
  readonly concepts: readonly { deleted: boolean }[];
  readonly edges: readonly EdgeSpec[];
  readonly keyword: Word;
  readonly useType: boolean;
  readonly typeIdx: number;
  readonly usePriority: boolean;
  readonly priorityIdx: number;
}

const elementSpecArb: fc.Arbitrary<ElementSpec> = fc.record({
  type: fc.constantFrom(...SEARCHABLE),
  words: fc.uniqueArray(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 3 }),
  priority: fc.constantFrom(...PRIORITY_LABELS),
  deleted: fc.boolean(),
});

const worldArb: fc.Arbitrary<WorldSpec> = fc
  .record({
    elements: fc.array(elementSpecArb, { minLength: 1, maxLength: 12 }),
    concepts: fc.array(fc.record({ deleted: fc.boolean() }), { minLength: 1, maxLength: 4 }),
    keyword: fc.constantFrom(...WORDS),
    useType: fc.boolean(),
    typeIdx: fc.integer({ min: 0, max: SEARCHABLE.length - 1 }),
    usePriority: fc.boolean(),
    priorityIdx: fc.integer({ min: 0, max: PRIORITY_LABELS.length - 1 }),
  })
  .chain(({ elements, concepts, keyword, useType, typeIdx, usePriority, priorityIdx }) => {
    const edgeArb: fc.Arbitrary<EdgeSpec> = fc.record({
      memberIdx: fc.integer({ min: 0, max: elements.length - 1 }),
      conceptIdx: fc.integer({ min: 0, max: concepts.length - 1 }),
      dup: fc.integer({ min: 0, max: 2 }),
    });
    return fc.record({
      elements: fc.constant(elements),
      concepts: fc.constant(concepts),
      edges: fc.array(edgeArb, { minLength: 0, maxLength: 24 }),
      keyword: fc.constant(keyword),
      useType: fc.constant(useType),
      typeIdx: fc.constant(typeIdx),
      usePriority: fc.constant(usePriority),
      priorityIdx: fc.constant(priorityIdx),
    });
  });

interface BuiltWorld {
  readonly liveConceptIds: readonly ElementId[];
  /** The ids of LIVE member elements (non-deleted), for positive count assertions. */
  readonly liveMemberIds: readonly ElementId[];
  /** The ids of SOFT-DELETED member elements, to prove they never inflate a count. */
  readonly deadMemberIds: readonly ElementId[];
  readonly keyword: string;
  readonly type?: SearchableSpecType;
  readonly priorityLabel?: PriorityLabel;
}

/** Materialize a generated world into a FRESH DB and resolve the active filters. */
function buildWorld(world: WorldSpec): BuiltWorld {
  freshDb();

  const elementIds: ElementId[] = world.elements.map((spec, idx) => {
    const body = spec.words.join(" ");
    // The element's own numeric priority (the band the priority facet narrows on).
    // The host source for a card keeps a neutral 0.5 — only the card element's band
    // matters for the card's count/list.
    const prio = PRIORITY_VALUE[spec.priority];
    if (spec.type === "card") {
      // A card hosted by a throwaway source; the keyword lives in the prompt.
      const { element: host } = sources.create({ title: `host-${idx}`, priority: 0.5 });
      const card = review.createCard({
        sourceId: host.id,
        title: `card-${idx}`,
        kind: "qa",
        prompt: `${body} question`,
        answer: "answer",
        priority: prio,
      });
      return card.element.id;
    }
    if (spec.type === "extract") {
      // Create the extract element directly (type=extract) so the extract_fts
      // trigger indexes its body on the document upsert below.
      const extract = elementsRepo.create({
        type: "extract",
        status: "active",
        stage: "raw_extract",
        priority: prio,
        title: `t-${idx} ${body}`,
      });
      documents.upsert({
        elementId: extract.id,
        prosemirrorJson: { type: "doc", content: [] },
        plainText: body,
      });
      return extract.id;
    }
    const { element } = sources.create({ title: `t-${idx} ${body}`, priority: prio });
    documents.upsert({
      elementId: element.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: body,
    });
    return element.id;
  });

  const conceptIds: ElementId[] = world.concepts.map(
    (_, idx) => conceptsRepo.createConcept({ name: `concept-${idx}` }).id,
  );

  // Membership edges with raw duplicates (addRelation, not assignConcept) so the
  // substrate's own dedup is exercised.
  for (const edge of world.edges) {
    const memberId = elementIds[edge.memberIdx];
    const conceptId = conceptIds[edge.conceptIdx];
    if (!memberId || !conceptId) continue;
    for (let i = 0; i < 1 + edge.dup; i++) {
      elementsRepo.addRelation({
        fromElementId: memberId,
        toElementId: conceptId,
        relationType: "concept_membership",
      });
    }
  }

  // Soft-delete flagged endpoints AFTER wiring (edges to dead endpoints).
  world.elements.forEach((spec, idx) => {
    const id = elementIds[idx];
    if (spec.deleted && id) elementsRepo.softDelete(id);
  });
  world.concepts.forEach((spec, idx) => {
    const id = conceptIds[idx];
    if (spec.deleted && id) elementsRepo.softDelete(id);
  });

  const liveConceptIds = conceptIds.filter((_, idx) => !world.concepts[idx]?.deleted);

  // Member element indices that have at least one edge (the elements whose liveness
  // actually affects a concept count). Partition them by their soft-delete flag.
  const memberIdxs = new Set<number>();
  for (const edge of world.edges) {
    if (elementIds[edge.memberIdx] && conceptIds[edge.conceptIdx]) memberIdxs.add(edge.memberIdx);
  }
  const liveMemberIds: ElementId[] = [];
  const deadMemberIds: ElementId[] = [];
  for (const idx of memberIdxs) {
    const id = elementIds[idx];
    if (!id) continue;
    if (world.elements[idx]?.deleted) deadMemberIds.push(id);
    else liveMemberIds.push(id);
  }

  const type = world.useType ? SEARCHABLE[world.typeIdx] : undefined;
  const priorityLabel = world.usePriority ? PRIORITY_LABELS[world.priorityIdx] : undefined;
  return {
    liveConceptIds,
    liveMemberIds,
    deadMemberIds,
    keyword: world.keyword,
    ...(type ? { type } : {}),
    ...(priorityLabel ? { priorityLabel } : {}),
  };
}

/** The db-service fold: matchedIds × liveMembershipMap → per-concept count. */
function foldByConcept(
  keyword: string,
  type?: SearchableSpecType,
  priorityLabel?: PriorityLabel,
): Record<string, number> {
  const membership = conceptsRepo.liveMembershipMap();
  const byConcept: Record<string, number> = {};
  for (const id of search.matchedIdsForConceptCounts(keyword, {
    ...(type ? { type } : {}),
    ...(priorityLabel ? { priorityLabel } : {}),
  })) {
    for (const c of membership.get(id) ?? []) byConcept[c] = (byConcept[c] ?? 0) + 1;
  }
  return byConcept;
}

describe("search drill-down byConcept — property invariants", () => {
  it("INVARIANT: byConcept[c] equals the rows when c is selected alongside the SAME keyword/type/priority", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { liveConceptIds, keyword, type, priorityLabel } = buildWorld(world);
        const byConcept = foldByConcept(keyword, type, priorityLabel);

        for (const conceptId of liveConceptIds) {
          const rerun = search
            .search(keyword, {
              conceptId,
              ...(type ? { type } : {}),
              ...(priorityLabel ? { priorityLabel } : {}),
            })
            .map((h) => h.id);
          expect(byConcept[conceptId] ?? 0).toBe(rerun.length);
        }
      }),
      FC,
    );
  });

  it("INVARIANT: soft-deleted members/concepts NEVER inflate a count; live siblings still count", () => {
    // Strengthened (was vacuously true): liveMembershipMap already drops dead-concept
    // KEYS, so the old 'a dead concept gets no byConcept entry' assertion could never
    // fail. This version positively asserts (a) a soft-deleted MEMBER element is absent
    // from the count scan (so it cannot contribute to ANY byConcept), and (b) any
    // byConcept key is a LIVE concept and its count equals the live members matching the
    // active filters — i.e. dead members/concepts contribute 0 while live ones still count.
    fc.assert(
      fc.property(worldArb, (world) => {
        const built = buildWorld(world);
        const { keyword, type, priorityLabel } = built;
        const byConcept = foldByConcept(keyword, type, priorityLabel);

        // (a) No soft-deleted MEMBER element appears in the count scan.
        const scan = new Set(
          search.matchedIdsForConceptCounts(keyword, {
            ...(type ? { type } : {}),
            ...(priorityLabel ? { priorityLabel } : {}),
          }),
        );
        for (const deadId of built.deadMemberIds) {
          expect(scan.has(deadId)).toBe(false);
        }

        // (b) Every byConcept KEY is a live concept, and equals the live concept-narrowed
        // rows under the SAME filters (dead members already excluded by the scan; dead
        // concepts never get a key). A concept whose only members were soft-deleted (or
        // which was itself soft-deleted) is therefore 0.
        const liveSet = new Set(built.liveConceptIds);
        for (const [key, count] of Object.entries(byConcept)) {
          expect(liveSet.has(key as ElementId)).toBe(true);
          const rows = search.search(keyword, {
            conceptId: key as ElementId,
            ...(type ? { type } : {}),
            ...(priorityLabel ? { priorityLabel } : {}),
          });
          expect(count).toBe(rows.length);
        }
      }),
      FC,
    );
  });

  it("INVARIANT: the concept-narrowed result set is always a subset of the count scan (under all facets)", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { liveConceptIds, keyword, type, priorityLabel } = buildWorld(world);
        const scan = new Set(
          search.matchedIdsForConceptCounts(keyword, {
            ...(type ? { type } : {}),
            ...(priorityLabel ? { priorityLabel } : {}),
          }),
        );
        for (const conceptId of liveConceptIds) {
          for (const hit of search.search(keyword, {
            conceptId,
            ...(type ? { type } : {}),
            ...(priorityLabel ? { priorityLabel } : {}),
          })) {
            expect(scan.has(hit.id)).toBe(true);
          }
        }
      }),
      FC,
    );
  });

  it("INVARIANT: every count-scan id is in the chosen priority band (the facet is respected)", () => {
    // The /search priority×count gap finding #1 fixed, as a property: when a priority
    // facet is active, EVERY id the concept-count scan returns must be a live element
    // whose priority maps to that band — so byConcept can never out-count the
    // priority-narrowed list. fast-check explores both with- and without-priority worlds.
    fc.assert(
      fc.property(worldArb, (world) => {
        const { keyword, type, priorityLabel } = buildWorld(world);
        if (!priorityLabel) return; // only meaningful with a priority facet active
        const banded = search.matchedIdsForConceptCounts(keyword, {
          ...(type ? { type } : {}),
          priorityLabel,
        });
        for (const id of banded) {
          const el = elementsRepo.findById(id);
          expect(el).not.toBeNull();
          expect(priorityToLabel(el?.priority ?? 0)).toBe(priorityLabel);
        }
      }),
      FC,
    );
  });
});

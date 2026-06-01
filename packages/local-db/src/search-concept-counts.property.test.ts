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

import type { ElementId } from "@interleave/core";
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
}

const elementSpecArb: fc.Arbitrary<ElementSpec> = fc.record({
  type: fc.constantFrom(...SEARCHABLE),
  words: fc.uniqueArray(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 3 }),
  deleted: fc.boolean(),
});

const worldArb: fc.Arbitrary<WorldSpec> = fc
  .record({
    elements: fc.array(elementSpecArb, { minLength: 1, maxLength: 12 }),
    concepts: fc.array(fc.record({ deleted: fc.boolean() }), { minLength: 1, maxLength: 4 }),
    keyword: fc.constantFrom(...WORDS),
    useType: fc.boolean(),
    typeIdx: fc.integer({ min: 0, max: SEARCHABLE.length - 1 }),
  })
  .chain(({ elements, concepts, keyword, useType, typeIdx }) => {
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
    });
  });

interface BuiltWorld {
  readonly liveConceptIds: readonly ElementId[];
  readonly keyword: string;
  readonly type?: SearchableSpecType;
}

/** Materialize a generated world into a FRESH DB and resolve the active filters. */
function buildWorld(world: WorldSpec): BuiltWorld {
  freshDb();

  const elementIds: ElementId[] = world.elements.map((spec, idx) => {
    const body = spec.words.join(" ");
    if (spec.type === "card") {
      // A card hosted by a throwaway source; the keyword lives in the prompt.
      const { element: host } = sources.create({ title: `host-${idx}`, priority: 0.5 });
      const card = review.createCard({
        sourceId: host.id,
        title: `card-${idx}`,
        kind: "qa",
        prompt: `${body} question`,
        answer: "answer",
        priority: 0.5,
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
        priority: 0.5,
        title: `t-${idx} ${body}`,
      });
      documents.upsert({
        elementId: extract.id,
        prosemirrorJson: { type: "doc", content: [] },
        plainText: body,
      });
      return extract.id;
    }
    const { element } = sources.create({ title: `t-${idx} ${body}`, priority: 0.5 });
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
  const type = world.useType ? SEARCHABLE[world.typeIdx] : undefined;
  return { liveConceptIds, keyword: world.keyword, ...(type ? { type } : {}) };
}

/** The db-service fold: matchedIds × liveMembershipMap → per-concept count. */
function foldByConcept(keyword: string, type?: SearchableSpecType): Record<string, number> {
  const membership = conceptsRepo.liveMembershipMap();
  const byConcept: Record<string, number> = {};
  for (const id of search.matchedIdsForConceptCounts(keyword, type ? { type } : {})) {
    for (const c of membership.get(id) ?? []) byConcept[c] = (byConcept[c] ?? 0) + 1;
  }
  return byConcept;
}

describe("search drill-down byConcept — property invariants", () => {
  it("INVARIANT: byConcept[c] equals the rows when c is selected alongside the SAME keyword/type", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { liveConceptIds, keyword, type } = buildWorld(world);
        const byConcept = foldByConcept(keyword, type);

        for (const conceptId of liveConceptIds) {
          const rerun = search
            .search(keyword, { conceptId, ...(type ? { type } : {}) })
            .map((h) => h.id);
          expect(byConcept[conceptId] ?? 0).toBe(rerun.length);
        }
      }),
      FC,
    );
  });

  it("INVARIANT: a soft-deleted concept never gets a byConcept entry", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const built = buildWorld(world);
        const byConcept = foldByConcept(built.keyword, built.type);
        // Any concept id NOT in the live set must contribute nothing.
        const liveSet = new Set(built.liveConceptIds);
        for (const key of Object.keys(byConcept)) {
          if (!liveSet.has(key as ElementId)) {
            expect(byConcept[key] ?? 0).toBe(0);
          }
        }
      }),
      FC,
    );
  });

  it("INVARIANT: the concept-narrowed result set is always a subset of the count scan", () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const { liveConceptIds, keyword, type } = buildWorld(world);
        const scan = new Set(search.matchedIdsForConceptCounts(keyword, type ? { type } : {}));
        for (const conceptId of liveConceptIds) {
          for (const hit of search.search(keyword, { conceptId, ...(type ? { type } : {}) })) {
            expect(scan.has(hit.id)).toBe(true);
          }
        }
      }),
      FC,
    );
  });
});

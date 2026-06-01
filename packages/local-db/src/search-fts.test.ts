/**
 * SearchRepository FTS5 tests (T042).
 *
 * Run against a fresh in-memory `better-sqlite3` with ALL migrations applied
 * (`createInMemoryDb` → the `0002_search_fts5` migration creates the FTS tables +
 * triggers). These prove: ranking (title > body), card prompt matches, tag-only
 * matches, soft-delete exclusion, the empty/malformed query → `[]` contract, and
 * that the triggers keep the index in sync across insert/update/delete.
 */

import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConceptRepository } from "./concept-repository";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ReviewRepository } from "./review-repository";
import { SearchRepository, toMatchExpression } from "./search-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

describe("SearchRepository (FTS5, T042)", () => {
  let handle: DbHandle;
  let search: SearchRepository;
  let sources: SourceRepository;
  let documents: DocumentRepository;
  let elementsRepo: ElementRepository;
  let review: ReviewRepository;
  let conceptsRepo: ConceptRepository;

  beforeEach(() => {
    handle = createInMemoryDb();
    search = new SearchRepository(handle.db);
    sources = new SourceRepository(handle.db);
    documents = new DocumentRepository(handle.db);
    elementsRepo = new ElementRepository(handle.db);
    review = new ReviewRepository(handle.db);
    conceptsRepo = new ConceptRepository(handle.db);
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  /** Seed a source whose TITLE has the term and an extract whose BODY merely mentions it. */
  function seedTitleVsBody() {
    const { element: titled } = sources.create({ title: "Memory consolidation", priority: 0.5 });
    documents.upsert({
      elementId: titled.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "Sleep helps the brain file away the day's events.",
    });
    const { element: src2 } = sources.create({ title: "Sleep and the brain", priority: 0.5 });
    documents.upsert({
      elementId: src2.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "The hippocampus replays patterns and shifts memory into the cortex overnight.",
    });
    return { titled, src2 };
  }

  it("ranks a title match above a body-only match", () => {
    const { titled, src2 } = seedTitleVsBody();
    const hits = search.search("memory");
    const ids = hits.map((h) => h.id);
    expect(ids).toContain(titled.id);
    expect(ids).toContain(src2.id);
    // The title hit must outrank the body-only hit.
    expect(ids.indexOf(titled.id)).toBeLessThan(ids.indexOf(src2.id));
  });

  it("ranks title-weighted within the same tier (bm25 weights, not just the tier)", () => {
    // Both sources mention the term in BOTH title and body, so both land in the
    // headline tier (tier 0); ordering is then the bm25 tiebreaker. With the
    // weights positional over ALL columns (element_id, title, body, tags), a
    // STRONGER title match must still outrank a weaker-title/stronger-body match.
    // Off-by-one weights (title landing on the UNINDEXED element_id) would invert
    // this, so the test pins the within-tier order, not just the coarse tier.
    const { element: strongTitle } = sources.create({
      title: "Memory memory memory",
      priority: 0.5,
    });
    documents.upsert({
      elementId: strongTitle.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "memory mentioned once in the body here",
    });
    const { element: strongBody } = sources.create({ title: "Memory once", priority: 0.5 });
    documents.upsert({
      elementId: strongBody.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "memory memory memory memory saturates this body text",
    });
    const ids = search.search("memory").map((h) => h.id);
    expect(ids).toContain(strongTitle.id);
    expect(ids).toContain(strongBody.id);
    // The title-heavy source must rank ahead of the body-heavy one.
    expect(ids.indexOf(strongTitle.id)).toBeLessThan(ids.indexOf(strongBody.id));
  });

  it("returns a card whose prompt matches a card query", () => {
    const { element: src } = sources.create({ title: "Host source", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "host body",
    });
    const card = review.createCard({
      sourceId: src.id,
      title: "card el",
      kind: "qa",
      prompt: "What is photosynthesis?",
      answer: "How plants convert light to energy.",
      priority: 0.5,
    });
    const hits = search.search("photosynthesis");
    expect(hits.map((h) => h.id)).toContain(card.element.id);
    expect(hits.find((h) => h.id === card.element.id)?.type).toBe("card");
  });

  it("a card hit's snippet is the prompt/answer text, NOT the element id", () => {
    // Regression: `snippet(card_fts, 0, …)` returns column 0 (element_id
    // UNINDEXED) — i.e. the ULID — instead of an excerpt of the matched field.
    // `snippet(card_fts, -1, …)` uses the best-matching column, so a prompt hit
    // excerpts the prompt and an answer-only hit excerpts the answer.
    const { element: src } = sources.create({ title: "Snippet host", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "host body",
    });
    const card = review.createCard({
      sourceId: src.id,
      title: "snippet card",
      kind: "qa",
      prompt: "What is photosynthesis in plants?",
      answer: "Chloroplasts convert sunlight into chemical energy.",
      priority: 0.5,
    });

    // A prompt hit excerpts the prompt — and must NEVER be the element id.
    const promptHit = search.search("photosynthesis").find((h) => h.id === card.element.id);
    expect(promptHit).toBeDefined();
    expect(promptHit?.snippet).not.toBe(card.element.id);
    expect(promptHit?.snippet.toLowerCase()).toContain("photosynthesis");

    // An answer-only hit excerpts the answer (still not the id).
    const answerHit = search.search("chloroplasts").find((h) => h.id === card.element.id);
    expect(answerHit).toBeDefined();
    expect(answerHit?.snippet).not.toBe(card.element.id);
    expect(answerHit?.snippet.toLowerCase()).toContain("chloroplast");
  });

  it("finds a tag-only match (the term appears only as a tag)", () => {
    const { element: src } = sources.create({ title: "Untagged title", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "no special words here",
    });
    elementsRepo.addTag(src.id, "neuroscience");
    const hits = search.search("neuroscience");
    expect(hits.map((h) => h.id)).toContain(src.id);
  });

  it("excludes soft-deleted elements", () => {
    const { element: src } = sources.create({ title: "Ephemeral memory", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "transient body",
    });
    expect(search.search("ephemeral").map((h) => h.id)).toContain(src.id);
    elementsRepo.softDelete(src.id);
    expect(search.search("ephemeral").map((h) => h.id)).not.toContain(src.id);
  });

  it("drops a soft-deleted CARD from search and clears its card_fts row", () => {
    // Regression: the `elements_fts_au` trigger rebuilt source_fts/extract_fts on
    // soft-delete but left card_fts untouched, so a soft-deleted card kept a stale
    // index row (masked only by the query join). Migration 0005 fixes the trigger.
    const { element: src } = sources.create({ title: "Card host", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "host body",
    });
    const card = review.createCard({
      sourceId: src.id,
      title: "ephemeral card",
      kind: "qa",
      prompt: "What is mitochondria?",
      answer: "The powerhouse of the cell.",
      priority: 0.5,
    });
    expect(search.search("mitochondria").map((h) => h.id)).toContain(card.element.id);

    elementsRepo.softDelete(card.element.id);

    // It leaves the search results entirely.
    expect(search.search("mitochondria").map((h) => h.id)).not.toContain(card.element.id);
    // And the trigger physically removed the card_fts row (no index drift).
    const remaining = handle.sqlite
      .prepare("SELECT element_id FROM card_fts WHERE element_id = ?")
      .all(card.element.id);
    expect(remaining).toHaveLength(0);
  });

  it("returns [] for an empty or whitespace-only query", () => {
    expect(search.search("")).toEqual([]);
    expect(search.search("   ")).toEqual([]);
    expect(search.query("   ")).toEqual([]);
  });

  it("degrades a malformed FTS query to [] instead of throwing", () => {
    seedTitleVsBody();
    // Pure FTS operators / punctuation — must not throw.
    expect(() => search.search('"')).not.toThrow();
    expect(() => search.search("AND OR NEAR( )")).not.toThrow();
    expect(search.search('"')).toEqual([]);
  });

  it("keeps the index in sync across insert / update / delete (the triggers work)", () => {
    // Insert: a source body containing "alpha".
    const { element: src } = sources.create({ title: "Greek letters", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "the first one is alpha",
    });
    expect(search.search("alpha").map((h) => h.id)).toContain(src.id);

    // Update: rewrite the body to "omega" — "alpha" must drop, "omega" appear.
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "the last one is omega",
    });
    expect(search.search("alpha").map((h) => h.id)).not.toContain(src.id);
    expect(search.search("omega").map((h) => h.id)).toContain(src.id);

    // Delete (hard): remove the document → the source drops from body matches, but
    // the title ("Greek letters") still resolves via the elements_fts trigger.
    handle.sqlite.prepare("DELETE FROM documents WHERE element_id = ?").run(src.id);
    expect(search.search("omega").map((h) => h.id)).not.toContain(src.id);
  });

  it("narrows by element type", () => {
    const { element: src } = sources.create({ title: "Quantum source", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "quantum body",
    });
    const card = review.createCard({
      sourceId: src.id,
      title: "card",
      kind: "qa",
      prompt: "quantum question?",
      answer: "answer",
      priority: 0.5,
    });
    expect(search.search("quantum", { type: "source" }).map((h) => h.id)).toEqual([src.id]);
    expect(search.search("quantum", { type: "card" }).map((h) => h.id)).toEqual([card.element.id]);
  });

  describe("concept filter (canonical-substrate liveness/type, T041/T042)", () => {
    /** Seed a source that matches "neuron" and is a member of a fresh concept. */
    function seedSourceInConcept(conceptName: string) {
      const concept = conceptsRepo.createConcept({ name: conceptName });
      const { element: src } = sources.create({ title: "Neuron firing", priority: 0.5 });
      documents.upsert({
        elementId: src.id,
        prosemirrorJson: { type: "doc", content: [] },
        plainText: "the neuron body",
      });
      conceptsRepo.assignConcept(src.id, concept.id);
      return { concept, src };
    }

    it("matchedIdsForConceptCounts returns the keyword+type match set WITHOUT concept narrowing", () => {
      // Two matching sources; only one is a member of the concept. The count-scan
      // method must return BOTH (it drops the concept predicate — drill-down), so a
      // chip count taken over its result can show the concept's keyword-matched share.
      const { concept, src } = seedSourceInConcept("Attention");
      const { element: other } = sources.create({ title: "Neuron map", priority: 0.5 });
      documents.upsert({
        elementId: other.id,
        prosemirrorJson: { type: "doc", content: [] },
        plainText: "another neuron",
      });

      const ids = search.matchedIdsForConceptCounts("neuron");
      expect(ids).toEqual(expect.arrayContaining([src.id, other.id]));
      // And the concept-narrowed search is a SUBSET of the count scan.
      const filtered = search.search("neuron", { conceptId: concept.id }).map((h) => h.id);
      expect(ids).toEqual(expect.arrayContaining(filtered));
    });

    it("matchedIdsForConceptCounts honours the type filter (drops only the concept predicate)", () => {
      const { src } = seedSourceInConcept("Attention");
      const card = review.createCard({
        sourceId: src.id,
        title: "card",
        kind: "qa",
        prompt: "neuron question?",
        answer: "answer",
        priority: 0.5,
      });
      // type=source excludes the matching card from the count scan.
      const sourceIds = search.matchedIdsForConceptCounts("neuron", { type: "source" });
      expect(sourceIds).toContain(src.id);
      expect(sourceIds).not.toContain(card.element.id);
    });

    it("matchedIdsForConceptCounts excludes soft-deleted elements", () => {
      const { src } = seedSourceInConcept("Attention");
      expect(search.matchedIdsForConceptCounts("neuron")).toContain(src.id);
      elementsRepo.softDelete(src.id);
      expect(search.matchedIdsForConceptCounts("neuron")).not.toContain(src.id);
    });

    it("a count fold over matchedIds dedups duplicate edges and drops dead concept endpoints", () => {
      // Mirror the db-service fold: matchedIds × liveMembershipMap → per-concept count.
      const concept = conceptsRepo.createConcept({ name: "Attention" });
      const { element: src } = sources.create({ title: "Neuron firing", priority: 0.5 });
      documents.upsert({
        elementId: src.id,
        prosemirrorJson: { type: "doc", content: [] },
        plainText: "the neuron body",
      });
      // DUPLICATE raw edges (not assignConcept) — the Set in liveMembershipMap dedups.
      for (let i = 0; i < 3; i++) {
        elementsRepo.addRelation({
          fromElementId: src.id,
          toElementId: concept.id,
          relationType: "concept_membership",
        });
      }
      const fold = () => {
        const membership = conceptsRepo.liveMembershipMap();
        const byConcept: Record<string, number> = {};
        for (const id of search.matchedIdsForConceptCounts("neuron")) {
          for (const c of membership.get(id) ?? []) byConcept[c] = (byConcept[c] ?? 0) + 1;
        }
        return byConcept;
      };
      // Despite 3 edges, the member counts once.
      expect(fold()[concept.id]).toBe(1);
      // After soft-deleting the concept, it contributes no count (dead endpoint).
      elementsRepo.softDelete(concept.id);
      expect(fold()[concept.id] ?? 0).toBe(0);
    });

    it("restricts a search to members of a live concept", () => {
      const { concept, src } = seedSourceInConcept("Attention");
      // A second matching source NOT in the concept must be excluded by the filter.
      const { element: other } = sources.create({ title: "Neuron map", priority: 0.5 });
      documents.upsert({
        elementId: other.id,
        prosemirrorJson: { type: "doc", content: [] },
        plainText: "another neuron",
      });

      const unfiltered = search.search("neuron").map((h) => h.id);
      expect(unfiltered).toEqual(expect.arrayContaining([src.id, other.id]));

      const filtered = search.search("neuron", { conceptId: concept.id }).map((h) => h.id);
      expect(filtered).toContain(src.id);
      expect(filtered).not.toContain(other.id);
    });

    it("concept filter EXCLUDES members of a SOFT-DELETED concept (matches the canonical substrate)", () => {
      // Regression: the conceptJoin used to enforce only MEMBER liveness, not the
      // concept ENDPOINT, so a soft-deleted concept's members still surfaced — a
      // cross-surface divergence from queue/Library (elementsForConcept of a dead
      // concept is []). Assign while live, THEN soft-delete the concept element.
      const { concept, src } = seedSourceInConcept("Attention");
      expect(search.search("neuron", { conceptId: concept.id }).map((h) => h.id)).toContain(src.id);

      elementsRepo.softDelete(concept.id);

      // The member is still live and still matches an UNscoped query…
      expect(search.search("neuron").map((h) => h.id)).toContain(src.id);
      // …but filtering by the now-dead concept yields nothing (concept-endpoint
      // liveness), exactly as ConceptRepository.elementsForConcept returns [].
      expect(conceptsRepo.elementsForConcept(concept.id)).toEqual([]);
      expect(search.search("neuron", { conceptId: concept.id })).toEqual([]);
    });

    it("concept filter ignores a corrupt edge whose `to` endpoint is a NON-concept element", () => {
      // A raw addRelation (or legacy/imported data) can create a `concept_membership`
      // edge pointing at a non-concept; the canonical substrate drops it. Search must
      // too — the `ce.type = 'concept'` guard ensures a non-concept `to`-endpoint id
      // never resolves any members.
      const { element: src } = sources.create({ title: "Neuron stub", priority: 0.5 });
      documents.upsert({
        elementId: src.id,
        prosemirrorJson: { type: "doc", content: [] },
        plainText: "neuron body",
      });
      const { element: notAConcept } = sources.create({ title: "Not a concept", priority: 0.5 });
      elementsRepo.addRelation({
        fromElementId: src.id,
        toElementId: notAConcept.id,
        relationType: "concept_membership",
      });

      // Filtering by the non-concept id resolves no members (it is not a concept),
      // mirroring elementsForConcept(non-concept) === [].
      expect(conceptsRepo.elementsForConcept(notAConcept.id)).toEqual([]);
      expect(search.search("neuron", { conceptId: notAConcept.id })).toEqual([]);
    });
  });

  describe("priority facet (drill-down band filter + count-vs-list invariant)", () => {
    /** A source matching "neuron" at a given numeric priority. */
    function seedSourceAtPriority(priority: number, name: string) {
      const { element: src } = sources.create({ title: `Neuron ${name}`, priority });
      documents.upsert({
        elementId: src.id,
        prosemirrorJson: { type: "doc", content: [] },
        plainText: "the neuron body",
      });
      return src;
    }

    it("restricts a search to elements in the chosen A/B/C/D band (canonical boundaries)", () => {
      // One per band, at the representative band midpoint.
      const a = seedSourceAtPriority(0.875, "alpha"); // A
      const b = seedSourceAtPriority(0.625, "beta"); // B
      const c = seedSourceAtPriority(0.375, "gamma"); // C
      const d = seedSourceAtPriority(0.125, "delta"); // D

      expect(search.search("neuron", { priorityLabel: "A" }).map((h) => h.id)).toEqual([a.id]);
      expect(search.search("neuron", { priorityLabel: "B" }).map((h) => h.id)).toEqual([b.id]);
      expect(search.search("neuron", { priorityLabel: "C" }).map((h) => h.id)).toEqual([c.id]);
      expect(search.search("neuron", { priorityLabel: "D" }).map((h) => h.id)).toEqual([d.id]);
    });

    it("buckets on the SAME half-open band edges as priorityToLabel (0.75/0.5/0.25)", () => {
      // Exactly on a boundary is the HIGHER band (>= lower bound), matching priorityToLabel.
      const onA = seedSourceAtPriority(0.75, "edgeA"); // >= 0.75 → A
      const onB = seedSourceAtPriority(0.5, "edgeB"); // >= 0.5 → B
      const onC = seedSourceAtPriority(0.25, "edgeC"); // >= 0.25 → C

      expect(search.search("neuron", { priorityLabel: "A" }).map((h) => h.id)).toEqual([onA.id]);
      expect(search.search("neuron", { priorityLabel: "B" }).map((h) => h.id)).toEqual([onB.id]);
      expect(search.search("neuron", { priorityLabel: "C" }).map((h) => h.id)).toEqual([onC.id]);
    });

    it("buckets the [0,1] extremes like priorityToLabel (1.0 → A, 0.0 → D)", () => {
      // The DB CHECK constrains priority to [0,1]; these are the extreme in-range
      // values. The half-open bands map 1.0 → A (>= 0.75) and 0.0 → D (< 0.25).
      const top = seedSourceAtPriority(1, "top"); // A
      const bottom = seedSourceAtPriority(0, "bottom"); // D
      expect(search.search("neuron", { priorityLabel: "A" }).map((h) => h.id)).toContain(top.id);
      expect(search.search("neuron", { priorityLabel: "D" }).map((h) => h.id)).toContain(bottom.id);
      expect(search.search("neuron", { priorityLabel: "A" }).map((h) => h.id)).not.toContain(
        bottom.id,
      );
      expect(search.search("neuron", { priorityLabel: "D" }).map((h) => h.id)).not.toContain(
        top.id,
      );
    });

    it("matchedIdsForConceptCounts honours the priority facet (drops only the concept predicate)", () => {
      // Two members of one concept at DIFFERENT priorities; the priority-scoped scan
      // returns only the one in-band, so a concept-chip count under that priority is 1.
      const concept = conceptsRepo.createConcept({ name: "Attention" });
      const aMember = seedSourceAtPriority(0.875, "a-member"); // A
      const cMember = seedSourceAtPriority(0.375, "c-member"); // C
      conceptsRepo.assignConcept(aMember.id, concept.id);
      conceptsRepo.assignConcept(cMember.id, concept.id);

      const aScan = search.matchedIdsForConceptCounts("neuron", { priorityLabel: "A" });
      expect(aScan).toContain(aMember.id);
      expect(aScan).not.toContain(cMember.id);
    });

    it("INVARIANT: byConcept[c] under (keyword+type+priority) equals the list when c is added", () => {
      // The exact /search count-vs-list gap finding #1 fixed: with a priority facet
      // active, the concept-chip count must equal the rows you'd get if that concept
      // were selected alongside the SAME keyword/type/priority.
      const concept = conceptsRepo.createConcept({ name: "Attention" });
      const aMember = seedSourceAtPriority(0.875, "a-member"); // A, in concept
      const cMember = seedSourceAtPriority(0.375, "c-member"); // C, in concept
      const aLoner = seedSourceAtPriority(0.875, "a-loner"); // A, NOT in concept
      conceptsRepo.assignConcept(aMember.id, concept.id);
      conceptsRepo.assignConcept(cMember.id, concept.id);

      const foldByConcept = (priorityLabel: "A" | "B" | "C" | "D") => {
        const membership = conceptsRepo.liveMembershipMap();
        const byConcept: Record<string, number> = {};
        for (const id of search.matchedIdsForConceptCounts("neuron", { priorityLabel })) {
          for (const cc of membership.get(id) ?? []) byConcept[cc] = (byConcept[cc] ?? 0) + 1;
        }
        return byConcept;
      };

      // Under priority A: only aMember is both A AND in the concept → count 1, and the
      // narrowed list (concept + A) is exactly [aMember].
      expect(foldByConcept("A")[concept.id]).toBe(1);
      expect(
        search.search("neuron", { conceptId: concept.id, priorityLabel: "A" }).map((h) => h.id),
      ).toEqual([aMember.id]);
      // aLoner is A but not a member — never inflates the chip.
      expect(foldByConcept("A")[concept.id]).not.toBe(2);
      void aLoner;

      // Under priority C: only cMember → count 1, list [cMember].
      expect(foldByConcept("C")[concept.id]).toBe(1);
      expect(
        search.search("neuron", { conceptId: concept.id, priorityLabel: "C" }).map((h) => h.id),
      ).toEqual([cMember.id]);
    });

    it("excludes soft-deleted elements even when the priority band matches", () => {
      const src = seedSourceAtPriority(0.875, "doomed"); // A
      expect(search.search("neuron", { priorityLabel: "A" }).map((h) => h.id)).toContain(src.id);
      elementsRepo.softDelete(src.id);
      expect(search.search("neuron", { priorityLabel: "A" }).map((h) => h.id)).not.toContain(
        src.id,
      );
    });
  });

  it("matches by prefix (typing the start of a word)", () => {
    const { element: src } = sources.create({ title: "Intelligence measure", priority: 0.5 });
    documents.upsert({
      elementId: src.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "body",
    });
    expect(search.search("intel").map((h) => h.id)).toContain(src.id);
  });

  describe("toMatchExpression", () => {
    it("builds a prefix-AND expression from words", () => {
      expect(toMatchExpression("hello world")).toBe('"hello"* AND "world"*');
    });
    it("strips FTS operators / punctuation", () => {
      expect(toMatchExpression("a-b: c(d)")).toBe('"a"* AND "b"* AND "c"* AND "d"*');
    });
    it("returns null for empty / operator-only input", () => {
      expect(toMatchExpression("   ")).toBeNull();
      expect(toMatchExpression('"()')).toBeNull();
    });
    it("escapes embedded quotes", () => {
      expect(toMatchExpression('say "hi"')).toBe('"say"* AND "hi"*');
    });
  });
});

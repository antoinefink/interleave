/**
 * RelatedService tests (T088).
 *
 * Prove the four DERIVED related-item buckets over the T087 `vec0` store + the
 * concept lineage:
 *  - `similar`: a near-extract neighbor of an extract is surfaced;
 *  - `duplicates`: a deliberately near-identical second extract (≈0 distance) is
 *    flagged distinctly and NOT also listed under `similar`;
 *  - `prerequisiteConcepts`: the element's member concept PLUS its parent chain
 *    (the seeded "Intelligence" → "Cognition" hierarchy) with the right `level`;
 *  - `siblingSources`: a source sharing the element's concept is returned and one
 *    that doesn't is excluded.
 * Plus: the element itself + a soft-deleted neighbor are excluded; and with
 * semantics OFF the vector buckets are empty while the concept/sibling buckets
 * still resolve from lineage.
 *
 * The DETERMINISTIC local embedder (`embedTextLocal`, the same function the worker
 * uses) is the fake embedder, so KNN neighbors are asserted exactly with no model
 * or worker. The vec-dependent cases are gated on the FUNCTIONAL `vec0` smoke test
 * (`isVecAvailable`) so an ABI-mismatched host skips cleanly; the semantics-off
 * cases run everywhere.
 */

import {
  type ElementId,
  EMBEDDING_DIM,
  embedTextLocal,
  PRIORITY_LABEL_VALUE,
} from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import { createInMemoryDb, isVecAvailable } from "./test-db";

const MODEL = "local:minilm-hash-384";

const VEC_OK = (() => {
  const probe = createInMemoryDb();
  const ok = isVecAvailable(probe);
  probe.sqlite.close();
  if (!ok) {
    console.warn(
      "[related-service.test] skipping vec cases: sqlite-vec vec0 not functional on this host " +
        "(ABI mismatch) — the semantics-off cases still run",
    );
  }
  return ok;
})();

function embed(text: string): number[] {
  return embedTextLocal(text, EMBEDDING_DIM);
}

describe("RelatedService (T088)", () => {
  let handle: DbHandle;
  let repos: Repositories;

  beforeEach(() => {
    handle = createInMemoryDb();
    repos = createRepositories(handle.db, { vecAvailable: isVecAvailable(handle) });
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  /** Create an extract element, optionally embedding its own text. */
  function makeExtract(title: string, body: string, opts: { embed?: boolean } = {}): ElementId {
    const el = repos.elements.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: PRIORITY_LABEL_VALUE.B,
      title,
    });
    if (opts.embed !== false && VEC_OK) {
      repos.embeddings.upsert({
        elementId: el.id,
        elementType: "extract",
        modelId: MODEL,
        dim: EMBEDDING_DIM,
        contentHash: `h-${el.id}`,
        vector: embed(`${title} ${body}`),
      });
    }
    return el.id;
  }

  /** Create a source element, optionally embedding its own text. */
  function makeSource(title: string, body: string, opts: { embed?: boolean } = {}): ElementId {
    const { element } = repos.sources.create({ title, priority: PRIORITY_LABEL_VALUE.B });
    if (opts.embed !== false && VEC_OK) {
      repos.embeddings.upsert({
        elementId: element.id,
        elementType: "source",
        modelId: MODEL,
        dim: EMBEDDING_DIM,
        contentHash: `h-${element.id}`,
        vector: embed(`${title} ${body}`),
      });
    }
    return element.id;
  }

  describe.skipIf(!VEC_OK)("vector buckets", () => {
    it("returns a near extract as `similar` (not the element itself)", () => {
      const subject = makeExtract("Spacing effect", "distributed practice improves retention");
      const near = makeExtract(
        "Distributed practice",
        "spacing repetitions over time improves retention",
      );
      makeExtract("Unrelated", "the mitochondria is the powerhouse of the cell");

      const result = repos.related.related(subject, { semanticEnabled: true });
      expect(result.semanticAvailable).toBe(true);
      const ids = result.similar.map((i) => i.id);
      expect(ids).toContain(near);
      expect(ids).not.toContain(subject); // the element itself is excluded
      const hit = result.similar.find((i) => i.id === near);
      expect(hit?.kind).toBe("similar");
      expect(hit?.similarity).toBeGreaterThan(0);
    });

    it("flags a near-IDENTICAL second extract as a `duplicate`, not `similar`", () => {
      // A re-import: the SAME title + body embed to the SAME vector (L2 distance ~0),
      // well below DUPLICATE_DISTANCE_THRESHOLD — the canonical "possible duplicate".
      const title = "Spacing effect";
      const body = "spacing repetitions over time improves long-term retention substantially";
      const subject = makeExtract(title, body);
      const dup = makeExtract(title, body); // identical embedded text → ~0 distance

      const result = repos.related.related(subject, { semanticEnabled: true });
      const dupIds = result.duplicates.map((i) => i.id);
      expect(dupIds).toContain(dup);
      expect(result.duplicates.find((i) => i.id === dup)?.kind).toBe("duplicate");
      // A duplicate is NOT also listed under `similar`.
      expect(result.similar.map((i) => i.id)).not.toContain(dup);
    });

    it("excludes a soft-deleted neighbor from the vector buckets", () => {
      const subject = makeExtract("Spacing effect", "distributed practice improves retention");
      const near = makeExtract(
        "Distributed practice",
        "spacing repetitions over time improves retention",
      );
      repos.elements.softDelete(near);

      const result = repos.related.related(subject, { semanticEnabled: true });
      expect(result.similar.map((i) => i.id)).not.toContain(near);
      expect(result.duplicates.map((i) => i.id)).not.toContain(near);
    });

    it("returns empty vector buckets (semanticAvailable false) when the element is NOT embedded", () => {
      // An extract with no stored vector — the vector buckets cannot resolve.
      const subject = makeExtract("Not indexed", "no vector stored", { embed: false });
      makeExtract("Distributed practice", "spacing repetitions improves retention");

      const result = repos.related.related(subject, { semanticEnabled: true });
      expect(result.semanticAvailable).toBe(false);
      expect(result.similar).toEqual([]);
      expect(result.duplicates).toEqual([]);
    });
  });

  describe("prerequisite concepts (works with semantics off)", () => {
    it("returns the member concept (level 0) + its parent ancestor (level 1), ancestors first", () => {
      const cognition = repos.concepts.createConcept({ name: "Cognition" });
      const intelligence = repos.concepts.createConcept({
        name: "Intelligence",
        parentConceptId: cognition.id,
      });
      const subject = makeExtract("IQ research", "individual differences in reasoning", {
        embed: false,
      });
      repos.concepts.assignConcept(subject, intelligence.id);

      const result = repos.related.related(subject, { semanticEnabled: false });
      const byId = new Map(result.prerequisiteConcepts.map((c) => [c.id, c]));
      expect(byId.get(intelligence.id)?.level).toBe(0);
      expect(byId.get(cognition.id)?.level).toBe(1);
      // Ancestors (more general) come first — "learn first".
      expect(result.prerequisiteConcepts[0]?.id).toBe(cognition.id);
    });

    it("returns [] when the element has no member concepts", () => {
      const subject = makeExtract("Orphan", "no concepts", { embed: false });
      const result = repos.related.related(subject, { semanticEnabled: false });
      expect(result.prerequisiteConcepts).toEqual([]);
    });
  });

  describe("sibling sources (works with semantics off)", () => {
    it("returns a source sharing the element's concept and excludes one that does not", () => {
      const memory = repos.concepts.createConcept({ name: "Memory" });
      const other = repos.concepts.createConcept({ name: "Optics" });

      const subject = makeExtract("Forgetting curve", "retention decays over time", {
        embed: false,
      });
      repos.concepts.assignConcept(subject, memory.id);

      const sibling = makeSource("Memory consolidation", "sleep strengthens memory traces", {
        embed: false,
      });
      repos.concepts.assignConcept(sibling, memory.id);

      const unrelated = makeSource("Lens design", "refraction and focal length", {
        embed: false,
      });
      repos.concepts.assignConcept(unrelated, other.id);

      const result = repos.related.related(subject, { semanticEnabled: false });
      const ids = result.siblingSources.map((i) => i.id);
      expect(ids).toContain(sibling);
      expect(ids).not.toContain(unrelated);
      expect(ids).not.toContain(subject);
    });

    it("excludes a soft-deleted sibling source", () => {
      const memory = repos.concepts.createConcept({ name: "Memory" });
      const subject = makeExtract("Forgetting curve", "retention decays", { embed: false });
      repos.concepts.assignConcept(subject, memory.id);
      const sibling = makeSource("Memory consolidation", "sleep strengthens memory", {
        embed: false,
      });
      repos.concepts.assignConcept(sibling, memory.id);
      repos.elements.softDelete(sibling);

      const result = repos.related.related(subject, { semanticEnabled: false });
      expect(result.siblingSources.map((i) => i.id)).not.toContain(sibling);
    });
  });

  describe("graceful degrade", () => {
    it("with semantics OFF, vector buckets are empty but concept/sibling buckets resolve", () => {
      const cognition = repos.concepts.createConcept({ name: "Cognition" });
      const memory = repos.concepts.createConcept({
        name: "Memory",
        parentConceptId: cognition.id,
      });
      const subject = makeExtract("Recall", "active retrieval strengthens memory", {
        embed: false,
      });
      repos.concepts.assignConcept(subject, memory.id);
      const sibling = makeSource("Memory book", "a treatise on remembering", { embed: false });
      repos.concepts.assignConcept(sibling, memory.id);

      const result = repos.related.related(subject, { semanticEnabled: false });
      expect(result.semanticAvailable).toBe(false);
      expect(result.similar).toEqual([]);
      expect(result.duplicates).toEqual([]);
      // Lineage buckets still resolve.
      expect(result.prerequisiteConcepts.map((c) => c.id)).toEqual(
        expect.arrayContaining([memory.id, cognition.id]),
      );
      expect(result.siblingSources.map((i) => i.id)).toContain(sibling);
    });

    it("returns empty buckets for an unknown/soft-deleted element (never throws)", () => {
      const subject = makeExtract("Gone", "soon deleted", { embed: false });
      repos.elements.softDelete(subject);
      const result = repos.related.related(subject, { semanticEnabled: false });
      expect(result).toEqual({
        similar: [],
        duplicates: [],
        prerequisiteConcepts: [],
        siblingSources: [],
        semanticAvailable: false,
      });
    });
  });
});

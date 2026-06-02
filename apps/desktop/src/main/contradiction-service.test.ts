/**
 * ContradictionService tests (T089).
 *
 * Prove the main-side resolver that feeds the pure-core {@link detectContradictions}
 * heuristic: it resolves the element's vector + high-similarity neighbors, the
 * embedded text (for the negation/numeric signals), and the source dates via lineage
 * (for the recency signal), and returns enriched flags. The cases:
 *  - a near-duplicate-but-OPPOSING neighbor is flagged with the neighbor's title +
 *    ref + reasons;
 *  - a NEWER-source neighbor is flagged with `newerSide` set (resolved from lineage);
 *  - `findForElement` returns `[]` when `semanticSearchEnabled=false` (the surface
 *    hides) and when `vecAvailable=false`;
 *  - a soft-deleted neighbor is excluded.
 *
 * Built on a REAL in-memory DB (so lineage + the `vec0` KNN are genuine) with the
 * DETERMINISTIC local embedder (`embedTextLocal`, the same one the worker uses) as
 * the fake embedder — NO real model, NO worker, NO live network. The vec-dependent
 * suite is gated on the FUNCTIONAL `vec0` smoke test so an ABI-mismatched host skips
 * cleanly; the semantics-off cases run everywhere.
 */

import {
  type ElementId,
  EMBEDDING_DIM,
  embedTextLocal,
  PRIORITY_LABEL_VALUE,
} from "@interleave/core";
import {
  type DbHandle,
  loadVectorExtension,
  migrateDatabase,
  openDatabase,
  vecFunctional,
} from "@interleave/db";
import { createRepositories, type Repositories, resolveSourceRef } from "@interleave/local-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContradictionService } from "./contradiction-service";

const MODEL = "local:minilm-hash-384";

/** Open a fresh in-memory DB with vec loaded + the functional check (mirrors test-db). */
function makeDb(): { handle: DbHandle; vecAvailable: boolean } {
  const handle = openDatabase(":memory:");
  loadVectorExtension(handle.sqlite);
  const vecAvailable = vecFunctional(handle.sqlite);
  migrateDatabase(handle.db, { vecAvailable });
  return { handle, vecAvailable };
}

const VEC_OK = (() => {
  const { handle, vecAvailable } = makeDb();
  handle.sqlite.close();
  if (!vecAvailable) {
    console.warn(
      "[contradiction-service.test] skipping vec cases: sqlite-vec vec0 not functional " +
        "on this host (ABI mismatch) — the semantics-off cases still run",
    );
  }
  return vecAvailable;
})();

function embed(text: string): number[] {
  return embedTextLocal(text, EMBEDDING_DIM);
}

describe("ContradictionService.findForElement (T089)", () => {
  let handle: DbHandle;
  let repos: Repositories;
  let vecAvailable: boolean;

  beforeEach(() => {
    const db = makeDb();
    handle = db.handle;
    vecAvailable = db.vecAvailable;
    repos = createRepositories(handle.db, { vecAvailable });
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  /** Create a source with optional provenance dates. */
  function makeSource(
    title: string,
    dates: { publishedAt?: string; accessedAt?: string } = {},
  ): ElementId {
    const { element } = repos.sources.create({
      title,
      priority: PRIORITY_LABEL_VALUE.B,
      ...(dates.publishedAt ? { publishedAt: dates.publishedAt } : {}),
      ...(dates.accessedAt ? { accessedAt: dates.accessedAt } : {}),
    });
    return element.id;
  }

  /**
   * Create an extract anchored to `sourceId` with `claim` as its selected text, and
   * embed it (so the vec0 KNN + buildText both work). Returns the extract id.
   */
  function makeExtract(sourceId: ElementId, title: string, claim: string): ElementId {
    const { element } = repos.sources.createExtract({
      sourceElementId: sourceId,
      title,
      priority: PRIORITY_LABEL_VALUE.B,
      blockIds: [],
      selectedText: claim,
    });
    if (vecAvailable) {
      repos.embeddings.upsert({
        elementId: element.id,
        elementType: "extract",
        modelId: MODEL,
        dim: EMBEDDING_DIM,
        contentHash: `h-${element.id}`,
        // The embed text mirrors buildText's extract text: `${title}\n${selectedText}`.
        vector: embed(`${title}\n${claim}`),
      });
    }
    return element.id;
  }

  /** A service wired over the real repos: buildText returns the extract's title+claim. */
  function makeService(opts: { semanticEnabled?: boolean; vec?: boolean } = {}) {
    return new ContradictionService({
      repositories: repos,
      buildText: (id) => {
        const el = repos.elements.findById(id);
        if (!el || el.deletedAt) return null;
        const loc = repos.sources.findLocationForElement(id);
        return { type: "extract", text: `${el.title}\n${loc?.selectedText ?? ""}` };
      },
      resolveRef: (id) => resolveSourceRef(repos, id),
      vecAvailable: opts.vec ?? vecAvailable,
      semanticEnabled: () => opts.semanticEnabled ?? true,
    });
  }

  // A long, high-overlap claim where only the polarity word differs. The DETERMINISTIC
  // feature-hash embedder is lexical, so a single negation word barely moves the vector
  // (sim stays well above CONTRADICTION_SIMILARITY_MIN) — faithfully mirroring the real
  // MiniLM model, for which "X improves Y" and "X does not improve Y" are near-identical.
  const AFFIRM =
    "Caffeine taken shortly before bed improves long-term memory consolidation during " +
    "deep sleep and boosts overall recall the following morning according to the study.";
  const NEGATE =
    "Caffeine taken shortly before bed does not improve long-term memory consolidation " +
    "during deep sleep and boosts overall recall the following morning according to the study.";

  describe.skipIf(!VEC_OK)("with the vec0 store", () => {
    it("flags a near-identical NEGATED neighbor with its title + ref + reasons", () => {
      const src = makeSource("Sleep & Memory", { publishedAt: "2020-01-01" });
      const subject = makeExtract(src, "Caffeine claim", AFFIRM);
      makeExtract(src, "Caffeine rebuttal", NEGATE);

      const flags = makeService().findForElement(subject);
      expect(flags.length).toBeGreaterThanOrEqual(1);
      const flag = flags.find((f) => f.otherTitle === "Caffeine rebuttal");
      expect(flag?.reasons).toContain("negation");
      // The neighbor's ref resolves to the same source (lineage), with a citation.
      expect(flag?.otherRef?.sourceTitle).toBe("Sleep & Memory");
      // No flag is ever high-severity.
      expect(flag?.severity === "low" || flag?.severity === "medium").toBe(true);
    });

    it("flags a NEWER-source neighbor with newerSide resolved from lineage", () => {
      // Two sources, same claim, different publication years (2026 vs 2019).
      const oldSrc = makeSource("Old paper", { publishedAt: "2019-03-01" });
      const newSrc = makeSource("New paper", { publishedAt: "2026-03-01" });
      const claim = "The recommended spaced-repetition interval is seven days.";
      const subject = makeExtract(oldSrc, "Old interval claim", claim);
      makeExtract(newSrc, "New interval claim", claim);

      const flags = makeService().findForElement(subject);
      const recency = flags.find((f) => f.reasons.includes("recency"));
      expect(recency).toBeDefined();
      // The NEIGHBOR (other) is the newer one; subject is the older.
      expect(recency?.newerSide).toBe("other");
    });

    it("excludes a soft-deleted neighbor", () => {
      const src = makeSource("Doc", { publishedAt: "2020" });
      const subject = makeExtract(src, "A", AFFIRM);
      const deleted = makeExtract(src, "B", NEGATE);
      repos.elements.softDelete(deleted);

      const flags = makeService().findForElement(subject);
      expect(flags.map((f) => f.otherId)).not.toContain(deleted);
    });

    it("does NOT flag an agreeing near-duplicate (same polarity, same era)", () => {
      const src = makeSource("Doc", { publishedAt: "2020" });
      const claim = "Distributed practice improves long-term retention substantially.";
      const subject = makeExtract(src, "A", claim);
      makeExtract(src, "B", claim);

      const flags = makeService().findForElement(subject);
      expect(flags).toEqual([]);
    });

    it("returns [] when semanticSearchEnabled is false (the surface hides)", () => {
      const src = makeSource("Doc", { publishedAt: "2020" });
      const subject = makeExtract(src, "A", "X is true.");
      makeExtract(src, "B", "X is false.");

      const flags = makeService({ semanticEnabled: false }).findForElement(subject);
      expect(flags).toEqual([]);
    });
  });

  it("returns [] when vec is unavailable, regardless of semantics", () => {
    const src = makeSource("Doc", { publishedAt: "2020" });
    const subject = repos.sources.createExtract({
      sourceElementId: src,
      title: "A",
      priority: PRIORITY_LABEL_VALUE.B,
      blockIds: [],
      selectedText: "X is true.",
    }).element.id;

    const flags = makeService({ vec: false, semanticEnabled: true }).findForElement(subject);
    expect(flags).toEqual([]);
  });

  it("returns [] for an unknown element (never throws)", () => {
    expect(() => makeService().findForElement("does-not-exist" as ElementId)).not.toThrow();
    expect(makeService().findForElement("does-not-exist" as ElementId)).toEqual([]);
  });
});

/**
 * TriageSuggestionQuery tests (T127 — the read-model that gathers the three signals).
 *
 * Pins the gathering contract on top of the pure scorer (covered in
 * `@interleave/core`'s `triage-suggestion.test.ts`):
 *  - the semantic signal comes from KNN over the seed's own SOURCE vector (same-model
 *    only) and the placement concept from the NEIGHBORS' shared memberships — NOT
 *    `RelatedService` (which is empty for a fresh inbox source);
 *  - a non-embedded / fallback-model / default-priority-neighbor seed yields no semantic
 *    signal; the yield path drives `suggestForMetadata`;
 *  - `matches_current` and `not_inbox_source` suppress; the surface is read-only.
 *
 * The vec-dependent cases are gated on the functional `vec0` smoke test (`isVecAvailable`)
 * so an ABI-mismatched host skips cleanly; the non-vec cases run everywhere.
 */

import {
  DEFAULT_PRIORITY,
  type ElementId,
  EMBEDDING_DIM,
  embedTextLocal,
  type IsoTimestamp,
  PRIORITY_LABEL_VALUE,
} from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, reviewLogs, reviewStates } from "@interleave/db";
import { CARD_MATURE_STABILITY_DAYS } from "@interleave/scheduler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newReviewLogId } from "./ids";
import { createRepositories, type Repositories } from "./index";
import { createInMemoryDb, isVecAvailable } from "./test-db";
import { TriageSuggestionQuery } from "./triage-suggestion-query";

const MODEL = "onnx-community/embeddinggemma-300m-ONNX";
const FALLBACK_MODEL = "local:embeddinggemma-hash-768";
const ASOF = "2026-06-01T12:00:00.000Z" as IsoTimestamp;

const VEC_OK = (() => {
  const probe = createInMemoryDb();
  const ok = isVecAvailable(probe);
  probe.sqlite.close();
  if (!ok) {
    console.warn(
      "[triage-suggestion-query.test] skipping vec cases: sqlite-vec vec0 not functional " +
        "on this host (ABI mismatch) — the non-vec cases still run",
    );
  }
  return ok;
})();

function embed(text: string): number[] {
  return embedTextLocal(text, EMBEDDING_DIM);
}

describe("TriageSuggestionQuery (T127)", () => {
  let handle: DbHandle;
  let repos: Repositories;

  beforeEach(() => {
    handle = createInMemoryDb();
    repos = createRepositories(handle.db, { vecAvailable: isVecAvailable(handle) });
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  const query = (): TriageSuggestionQuery => new TriageSuggestionQuery(repos);

  /** A live inbox source, optionally embedded under a chosen model. */
  function makeInboxSource(
    title: string,
    body: string,
    opts: {
      embed?: boolean;
      modelId?: string;
      priority?: number;
      author?: string | null;
      url?: string | null;
      canonicalUrl?: string | null;
      confidence?: "high" | "medium" | "low" | null;
    } = {},
  ): ElementId {
    const { element } = repos.sources.create({
      title,
      priority: opts.priority ?? DEFAULT_PRIORITY,
      status: "inbox",
      author: opts.author ?? null,
      url: opts.url ?? null,
      canonicalUrl: opts.canonicalUrl ?? null,
      confidence: opts.confidence ?? null,
    });
    if (opts.embed !== false && VEC_OK) {
      repos.embeddings.upsert({
        elementId: element.id,
        elementType: "source",
        modelId: opts.modelId ?? MODEL,
        dim: EMBEDDING_DIM,
        contentHash: `h-${element.id}`,
        vector: embed(`${title} ${body}`),
      });
    }
    return element.id;
  }

  /** A live (active) source neighbor with a chosen priority + optional concept membership. */
  function makeNeighborSource(
    title: string,
    body: string,
    opts: { priority?: number; modelId?: string; conceptId?: ElementId } = {},
  ): ElementId {
    const { element } = repos.sources.create({
      title,
      priority: opts.priority ?? PRIORITY_LABEL_VALUE.A,
      status: "active",
    });
    if (VEC_OK) {
      repos.embeddings.upsert({
        elementId: element.id,
        elementType: "source",
        modelId: opts.modelId ?? MODEL,
        dim: EMBEDDING_DIM,
        contentHash: `h-${element.id}`,
        vector: embed(`${title} ${body}`),
      });
    }
    if (opts.conceptId) repos.concepts.assignConcept(element.id, opts.conceptId);
    return element.id;
  }

  /** Seed a worked (2 mature cards + reviews) high-yield source by an author — drives the yield signal. */
  function seedWorkedSource(author: string): void {
    const { element } = repos.sources.create({
      title: `${author} source`,
      priority: PRIORITY_LABEL_VALUE.B,
      status: "active",
      author,
    });
    for (let i = 0; i < 2; i++) {
      const card = repos.elements.create({
        type: "card",
        status: "active",
        stage: "active_card",
        priority: PRIORITY_LABEL_VALUE.B,
        title: "Card",
        sourceId: element.id,
      });
      handle.db.insert(cards).values({ elementId: card.id, kind: "qa", isLeech: false }).run();
      handle.db
        .insert(reviewStates)
        .values({
          elementId: card.id,
          fsrsState: "review",
          stability: CARD_MATURE_STABILITY_DAYS + 5,
        })
        .run();
      handle.db
        .insert(reviewLogs)
        .values({
          id: newReviewLogId(),
          elementId: card.id,
          rating: "good",
          reviewedAt: "2026-05-30T08:00:00.000Z",
          responseMs: 1500,
          prevState: "review",
          nextState: "review",
          nextStability: 30,
          nextDifficulty: 5,
          nextDueAt: "2026-05-30T08:00:00.000Z",
        })
        .run();
    }
  }

  const opLogCount = (): number =>
    (handle.sqlite.prepare("SELECT COUNT(*) AS c FROM operation_log").get() as { c: number }).c;

  describe.skipIf(!VEC_OK)("semantic + placement signal", () => {
    it("suggests a band from high-priority source neighbors and places their shared concept", () => {
      const concept = repos.concepts.createConcept({ name: "Distributed systems" });
      makeNeighborSource("Raft consensus", "distributed consensus log replication leader", {
        priority: PRIORITY_LABEL_VALUE.A,
        conceptId: concept.id,
      });
      makeNeighborSource("Paxos made simple", "distributed consensus quorum proposer", {
        priority: PRIORITY_LABEL_VALUE.A,
        conceptId: concept.id,
      });
      const seed = makeInboxSource("Consensus algorithms", "distributed consensus replication");

      const result = query().suggestForInboxItem(seed, ASOF);
      expect(result.kind).toBe("suggestion");
      if (result.kind !== "suggestion") return;
      expect(result.band).toBe("A");
      expect(result.justification.signals.some((s) => s.kind === "semantic")).toBe(true);
      expect(result.placement?.conceptName).toBe("Distributed systems");
      expect(result.signalHash).toContain("semantic:");
    });

    it("a fallback-model seed yields no semantic signal", () => {
      makeNeighborSource("Raft", "distributed consensus", { priority: PRIORITY_LABEL_VALUE.A });
      makeNeighborSource("Paxos", "distributed consensus", { priority: PRIORITY_LABEL_VALUE.A });
      const seed = makeInboxSource("Consensus", "distributed consensus", {
        modelId: FALLBACK_MODEL,
      });
      expect(query().suggestForInboxItem(seed, ASOF)).toEqual({
        kind: "insufficient_signal",
        reason: "no_signal_fired",
      });
    });

    it("neighbors still at the default priority carry no signal (semantic does not fire)", () => {
      makeNeighborSource("Raft", "distributed consensus", { priority: DEFAULT_PRIORITY });
      makeNeighborSource("Paxos", "distributed consensus", { priority: DEFAULT_PRIORITY });
      const seed = makeInboxSource("Consensus", "distributed consensus");
      expect(query().suggestForInboxItem(seed, ASOF)).toEqual({
        kind: "insufficient_signal",
        reason: "no_signal_fired",
      });
    });

    it("no shared neighbor concept → band-only suggestion (no placement)", () => {
      const a = repos.concepts.createConcept({ name: "Consensus" });
      const b = repos.concepts.createConcept({ name: "Storage" });
      makeNeighborSource("Raft", "distributed consensus", {
        priority: PRIORITY_LABEL_VALUE.A,
        conceptId: a.id,
      });
      makeNeighborSource("LSM trees", "distributed consensus storage", {
        priority: PRIORITY_LABEL_VALUE.A,
        conceptId: b.id,
      });
      const seed = makeInboxSource("Consensus", "distributed consensus storage");
      const result = query().suggestForInboxItem(seed, ASOF);
      expect(result.kind).toBe("suggestion");
      if (result.kind !== "suggestion") return;
      expect(result.band).toBe("A");
      expect(result.placement).toBeUndefined();
    });

    it("suppresses a suggestion equal to the item's current band (matches_current)", () => {
      makeNeighborSource("Raft", "distributed consensus", { priority: PRIORITY_LABEL_VALUE.A });
      makeNeighborSource("Paxos", "distributed consensus", { priority: PRIORITY_LABEL_VALUE.A });
      // Seed already at A; neighbors lean A → suggestion equals current → suppressed.
      const seed = makeInboxSource("Consensus", "distributed consensus", {
        priority: PRIORITY_LABEL_VALUE.A,
      });
      expect(query().suggestForInboxItem(seed, ASOF)).toEqual({
        kind: "insufficient_signal",
        reason: "matches_current",
      });
    });

    it("suppresses a DISPERSED neighbor set (A,A,D,D) rather than averaging to a phantom band", () => {
      // Two strong + two weak neighbors would average to a confident MIDDLE band no
      // neighbor holds — the automation-bias failure the spec engineers against.
      makeNeighborSource("Raft", "distributed consensus replication", {
        priority: PRIORITY_LABEL_VALUE.A,
      });
      makeNeighborSource("Paxos", "distributed consensus quorum", {
        priority: PRIORITY_LABEL_VALUE.A,
      });
      makeNeighborSource("Gossip", "distributed consensus epidemic", {
        priority: PRIORITY_LABEL_VALUE.D,
      });
      makeNeighborSource("Vector clocks", "distributed consensus causality", {
        priority: PRIORITY_LABEL_VALUE.D,
      });
      const seed = makeInboxSource("Consensus survey", "distributed consensus replication quorum");
      // Neighbors span A..D (>1 band) → semantic suppressed; no other signal → nothing.
      expect(query().suggestForInboxItem(seed, ASOF)).toEqual({
        kind: "insufficient_signal",
        reason: "no_signal_fired",
      });
    });

    it("suppresses placement on an exact tie between two equally-shared concepts (band-only)", () => {
      const x = repos.concepts.createConcept({ name: "Consensus" });
      const y = repos.concepts.createConcept({ name: "Replication" });
      const n1 = makeNeighborSource("Raft", "distributed consensus replication", {
        priority: PRIORITY_LABEL_VALUE.A,
        conceptId: x.id,
      });
      const n2 = makeNeighborSource("Paxos", "distributed consensus replication", {
        priority: PRIORITY_LABEL_VALUE.A,
        conceptId: x.id,
      });
      // Both neighbors ALSO share concept Y → X(2) and Y(2) tie for the top → no placement.
      repos.concepts.assignConcept(n1, y.id);
      repos.concepts.assignConcept(n2, y.id);
      const seed = makeInboxSource("Consensus algorithms", "distributed consensus replication");
      const result = query().suggestForInboxItem(seed, ASOF);
      expect(result.kind).toBe("suggestion");
      if (result.kind !== "suggestion") return;
      expect(result.band).toBe("A");
      expect(result.placement).toBeUndefined();
    });
  });

  it("returns not_inbox_source for a non-inbox / missing element", () => {
    const { element } = repos.sources.create({
      title: "Active source",
      priority: DEFAULT_PRIORITY,
      status: "active",
    });
    expect(query().suggestForInboxItem(element.id, ASOF)).toEqual({
      kind: "insufficient_signal",
      reason: "not_inbox_source",
    });
    expect(query().suggestForInboxItem("missing-id" as ElementId, ASOF)).toEqual({
      kind: "insufficient_signal",
      reason: "not_inbox_source",
    });
  });

  it("suggestForMetadata drives a yield-only suggestion (no semantic at intake)", () => {
    seedWorkedSource("Ada Lovelace");
    seedWorkedSource("Ada Lovelace");
    const result = query().suggestForMetadata({ author: "Ada Lovelace" }, ASOF);
    expect(result.kind).toBe("suggestion");
    if (result.kind !== "suggestion") return;
    expect(result.justification.signals.some((s) => s.kind === "authorYield")).toBe(true);
    expect(result.justification.signals.some((s) => s.kind === "semantic")).toBe(false);
  });

  it("suggestForMetadata shows nothing for an unknown author (thin signal)", () => {
    expect(query().suggestForMetadata({ author: "Nobody" }, ASOF)).toEqual({
      kind: "insufficient_signal",
      reason: "no_signal_fired",
    });
  });

  it("is read-only: operation_log row count is unchanged after a suggestion", () => {
    seedWorkedSource("Ada");
    seedWorkedSource("Ada");
    const seed = makeInboxSource("Notes on Ada", "history of computing", {
      embed: false,
      author: "Ada",
    });
    const before = opLogCount();
    query().suggestForInboxItem(seed, ASOF);
    query().suggestForInboxItems([seed], ASOF);
    query().suggestForMetadata({ author: "Ada" }, ASOF);
    expect(opLogCount()).toBe(before);
  });

  it("batch returns one entry per id", () => {
    const a = makeInboxSource("A", "alpha", { embed: false });
    const b = makeInboxSource("B", "beta", { embed: false });
    const out = query().suggestForInboxItems([a, b], ASOF);
    expect(out.size).toBe(2);
    expect(out.has(a)).toBe(true);
    expect(out.has(b)).toBe(true);
  });

  it("is deterministic across back-to-back calls", () => {
    seedWorkedSource("Det");
    seedWorkedSource("Det");
    const seed = makeInboxSource("Det notes", "subject", { embed: false, author: "Det" });
    const q = query();
    expect(q.suggestForInboxItem(seed, ASOF)).toEqual(q.suggestForInboxItem(seed, ASOF));
  });
});

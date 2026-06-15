/**
 * Suggested-priority scorer tests (T127 — the pure band/placement/justification rule).
 *
 * Pin the contract the `TriageSuggestionQuery` read-model + the import-modal preview
 * depend on: each signal contributes a lean ONLY when its floor clears; the fired
 * leans combine to the most-conservative band; a >1-band gap suppresses; confidence
 * caps the band DOWN (and tier never moves it); the justification cites only fired
 * signals; a no-op (band == current) suppresses; placement rides a banded suggestion
 * but never an insufficient one; and the verdict + signal hash are deterministic.
 */

import { describe, expect, it } from "vitest";
import {
  authorDomainYieldBand,
  computeTriageSignalHash,
  scoreTriageSuggestion,
  type TriageSignalInputs,
} from "./triage-suggestion";

describe("scoreTriageSuggestion", () => {
  it("semantic-only: 2 real-model neighbors leaning B → band B with one semantic clause", () => {
    const v = scoreTriageSuggestion({
      semantic: { lean: "B", sourceNeighborCount: 2, realModel: true },
    });
    expect(v.kind).toBe("suggestion");
    if (v.kind !== "suggestion") return;
    expect(v.band).toBe("B");
    expect(v.justification.signals).toHaveLength(1);
    expect(v.justification.signals[0]).toEqual({ kind: "semantic", neighborCount: 2, lean: "B" });
    expect(v.placement).toBeUndefined();
  });

  it("author-yield-only: 3 worked high-yield sources → leaning A; justification states the real count", () => {
    const v = scoreTriageSuggestion({
      authorYield: { band: "high", workedSourceCount: 3, totalCards: 11, totalMatureCards: 7 },
    });
    expect(v.kind).toBe("suggestion");
    if (v.kind !== "suggestion") return;
    expect(v.band).toBe("A");
    expect(v.justification.signals).toEqual([
      {
        kind: "authorYield",
        workedSourceCount: 3,
        totalCards: 11,
        totalMatureCards: 7,
        band: "high",
      },
    ]);
  });

  it("reliability caps a high (A) lean one step down on confidence 'low'", () => {
    const v = scoreTriageSuggestion({
      authorYield: { band: "high", workedSourceCount: 3, totalCards: 9, totalMatureCards: 4 },
      confidence: "low",
    });
    expect(v.kind).toBe("suggestion");
    if (v.kind !== "suggestion") return;
    // Uncapped lean is A; `low` caps one step down → B.
    expect(v.band).toBe("B");
  });

  it("reliabilityTier 'tertiary' (no confidence) never moves the band — tier is not a trust ordinal", () => {
    // `reliabilityTier` is intentionally NOT a field the scorer reads; passing only
    // a tier-shaped world (no `confidence`) leaves the lean uncapped.
    const v = scoreTriageSuggestion({
      authorYield: { band: "high", workedSourceCount: 3, totalCards: 9, totalMatureCards: 4 },
      confidence: null,
    });
    expect(v.kind).toBe("suggestion");
    if (v.kind !== "suggestion") return;
    expect(v.band).toBe("A");
  });

  it("conflict: leans more than one band apart → insufficient_signal(conflict_unresolved)", () => {
    // Semantic leans A (strong); author leans C (low yield) — a 2-band gap.
    const v = scoreTriageSuggestion({
      semantic: { lean: "A", sourceNeighborCount: 3, realModel: true },
      authorYield: { band: "low", workedSourceCount: 2, totalCards: 1, totalMatureCards: 0 },
    });
    expect(v).toEqual({ kind: "insufficient_signal", reason: "conflict_unresolved" });
  });

  it("exactly-one-band-apart (semantic B + author A) resolves to the lower band B", () => {
    const v = scoreTriageSuggestion({
      semantic: { lean: "B", sourceNeighborCount: 2, realModel: true },
      authorYield: { band: "high", workedSourceCount: 2, totalCards: 8, totalMatureCards: 5 },
    });
    expect(v.kind).toBe("suggestion");
    if (v.kind !== "suggestion") return;
    expect(v.band).toBe("B");
    expect(v.justification.signals).toHaveLength(2);
  });

  it("same-band tie keeps the band", () => {
    const v = scoreTriageSuggestion({
      semantic: { lean: "A", sourceNeighborCount: 2, realModel: true },
      authorYield: { band: "high", workedSourceCount: 2, totalCards: 8, totalMatureCards: 5 },
    });
    expect(v.kind).toBe("suggestion");
    if (v.kind !== "suggestion") return;
    expect(v.band).toBe("A");
  });

  it("all floors fail (no inputs) → insufficient_signal(no_signal_fired)", () => {
    const v = scoreTriageSuggestion({});
    expect(v).toEqual({ kind: "insufficient_signal", reason: "no_signal_fired" });
  });

  it("thin signals below their floors do not fire → no_signal_fired", () => {
    const v = scoreTriageSuggestion({
      // 1 neighbor (< floor), fallback model, n=1 author (< floor).
      semantic: { lean: "A", sourceNeighborCount: 1, realModel: true },
      authorYield: { band: "high", workedSourceCount: 1, totalCards: 9, totalMatureCards: 4 },
    });
    expect(v).toEqual({ kind: "insufficient_signal", reason: "no_signal_fired" });
  });

  it("a fallback-model semantic signal never fires even with enough neighbors", () => {
    const v = scoreTriageSuggestion({
      semantic: { lean: "A", sourceNeighborCount: 5, realModel: false },
    });
    expect(v).toEqual({ kind: "insufficient_signal", reason: "no_signal_fired" });
  });

  it("n=1 author below the floor emits no author clause / does not fire", () => {
    const v = scoreTriageSuggestion({
      authorYield: { band: "high", workedSourceCount: 1, totalCards: 9, totalMatureCards: 4 },
    });
    expect(v).toEqual({ kind: "insufficient_signal", reason: "no_signal_fired" });
  });

  it("a neutral-band yield signal never fires (un-started history)", () => {
    const v = scoreTriageSuggestion({
      authorYield: { band: "neutral", workedSourceCount: 3, totalCards: 0, totalMatureCards: 0 },
    });
    expect(v).toEqual({ kind: "insufficient_signal", reason: "no_signal_fired" });
  });

  it("matches_current: computed band equals currentBand → insufficient_signal(matches_current)", () => {
    const v = scoreTriageSuggestion({
      authorYield: { band: "medium", workedSourceCount: 3, totalCards: 5, totalMatureCards: 2 },
      currentBand: "B", // medium → lean B, no cap → B equals current.
    });
    expect(v).toEqual({ kind: "insufficient_signal", reason: "matches_current" });
  });

  it("a band that differs from currentBand is still suggested", () => {
    const v = scoreTriageSuggestion({
      authorYield: { band: "high", workedSourceCount: 3, totalCards: 9, totalMatureCards: 6 },
      currentBand: "C", // lean A ≠ C → suggestion stands.
    });
    expect(v.kind).toBe("suggestion");
    if (v.kind !== "suggestion") return;
    expect(v.band).toBe("A");
  });

  it("prefers author over domain when both fire (domain dropped from lean + justification)", () => {
    const v = scoreTriageSuggestion({
      authorYield: { band: "high", workedSourceCount: 2, totalCards: 8, totalMatureCards: 5 },
      domainYield: { band: "low", workedSourceCount: 4, totalCards: 2, totalMatureCards: 0 },
    });
    expect(v.kind).toBe("suggestion");
    if (v.kind !== "suggestion") return;
    // Author (high → A) wins; domain's low lean is ignored entirely (no conflict, no clause).
    expect(v.band).toBe("A");
    expect(v.justification.signals).toHaveLength(1);
    expect(v.justification.signals[0]?.kind).toBe("authorYield");
  });

  it("domain fires when author is absent", () => {
    const v = scoreTriageSuggestion({
      domainYield: { band: "medium", workedSourceCount: 3, totalCards: 6, totalMatureCards: 3 },
    });
    expect(v.kind).toBe("suggestion");
    if (v.kind !== "suggestion") return;
    expect(v.band).toBe("B");
    expect(v.justification.signals[0]?.kind).toBe("domainYield");
  });

  it("placement is kept for a banded suggestion and dropped for an insufficient verdict", () => {
    const candidate = {
      conceptId: "concept-1",
      conceptName: "Information theory",
      sharedByNeighborCount: 2,
    };
    const banded = scoreTriageSuggestion({
      semantic: { lean: "B", sourceNeighborCount: 2, realModel: true },
      placementCandidate: candidate,
    });
    expect(banded.kind).toBe("suggestion");
    if (banded.kind === "suggestion") {
      expect(banded.placement).toEqual({
        conceptId: "concept-1",
        conceptName: "Information theory",
      });
      // sharedByNeighborCount is not leaked into the emitted placement.
      expect(banded.placement).not.toHaveProperty("sharedByNeighborCount");
    }

    const suppressed = scoreTriageSuggestion({ placementCandidate: candidate });
    expect(suppressed).toEqual({ kind: "insufficient_signal", reason: "no_signal_fired" });
    expect(suppressed).not.toHaveProperty("placement");
  });

  it("medium confidence only caps the strongest band (A→B), leaving B/C/D untouched", () => {
    const capsA = scoreTriageSuggestion({
      authorYield: { band: "high", workedSourceCount: 3, totalCards: 9, totalMatureCards: 6 },
      confidence: "medium",
    });
    expect(capsA.kind === "suggestion" && capsA.band).toBe("B");

    const keepsB = scoreTriageSuggestion({
      authorYield: { band: "medium", workedSourceCount: 3, totalCards: 5, totalMatureCards: 2 },
      confidence: "medium",
    });
    expect(keepsB.kind === "suggestion" && keepsB.band).toBe("B");
  });

  it("low confidence caps a C lean down to D (and clamps at D)", () => {
    const v = scoreTriageSuggestion({
      domainYield: { band: "low", workedSourceCount: 3, totalCards: 1, totalMatureCards: 0 },
      confidence: "low",
    });
    // low yield → lean C; low confidence caps one step → D.
    expect(v.kind === "suggestion" && v.band).toBe("D");
  });
});

describe("computeTriageSignalHash", () => {
  it("is deterministic: same inputs + band → identical hash", () => {
    const inputs: TriageSignalInputs = {
      semantic: { lean: "B", sourceNeighborCount: 2, realModel: true },
      authorYield: { band: "high", workedSourceCount: 3, totalCards: 11, totalMatureCards: 7 },
    };
    expect(computeTriageSignalHash(inputs, "B")).toBe(computeTriageSignalHash(inputs, "B"));
  });

  it("includes the evaluator version, band, and fired signal counters; excludes thin signals", () => {
    const hash = computeTriageSignalHash(
      {
        semantic: { lean: "B", sourceNeighborCount: 2, realModel: true },
        // n=1 author is below the floor → must not appear in the hash.
        authorYield: { band: "high", workedSourceCount: 1, totalCards: 9, totalMatureCards: 4 },
      },
      "B",
    );
    expect(hash).toBe("t127-v1|band:B|semantic:2");
  });

  it("changes when the band changes", () => {
    const inputs: TriageSignalInputs = {
      authorYield: { band: "high", workedSourceCount: 3, totalCards: 9, totalMatureCards: 6 },
    };
    expect(computeTriageSignalHash(inputs, "A")).not.toBe(computeTriageSignalHash(inputs, "B"));
  });

  it("is stable regardless of which signal was specified first (sorted parts)", () => {
    const a = computeTriageSignalHash(
      {
        semantic: { lean: "B", sourceNeighborCount: 2, realModel: true },
        domainYield: { band: "medium", workedSourceCount: 3, totalCards: 6, totalMatureCards: 3 },
      },
      "B",
    );
    expect(a).toBe("t127-v1|band:B|domainYield:3|semantic:2");
  });
});

describe("determinism of the full verdict", () => {
  it("produces a byte-identical verdict + hash across back-to-back calls", () => {
    const inputs: TriageSignalInputs = {
      semantic: { lean: "B", sourceNeighborCount: 2, realModel: true },
      authorYield: { band: "high", workedSourceCount: 3, totalCards: 11, totalMatureCards: 7 },
      placementCandidate: { conceptId: "c1", conceptName: "Compression", sharedByNeighborCount: 2 },
      currentBand: "D",
    };
    const first = scoreTriageSuggestion(inputs);
    const second = scoreTriageSuggestion(inputs);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const band = first.kind === "suggestion" ? first.band : "C";
    expect(computeTriageSignalHash(inputs, band)).toBe(computeTriageSignalHash(inputs, band));
  });
});

describe("authorDomainYieldBand", () => {
  it("collapses summed tallies through scoreSourceYield (high)", () => {
    // 3 mature cards on summed tallies → well past the high threshold.
    const band = authorDomainYieldBand({
      readPct: 1,
      extractsCreated: 3,
      honorableExtracts: 0,
      synthesisNotesCreated: 0,
      cardsCreated: 4,
      matureCards: 3,
      leeches: 0,
      timeSpentMs: 0,
    });
    expect(band).toBe("high");
  });

  it("returns neutral for summed-zero (un-started) tallies", () => {
    const band = authorDomainYieldBand({
      readPct: 0,
      extractsCreated: 0,
      honorableExtracts: 0,
      synthesisNotesCreated: 0,
      cardsCreated: 0,
      matureCards: 0,
      leeches: 0,
      timeSpentMs: 0,
    });
    expect(band).toBe("neutral");
  });
});

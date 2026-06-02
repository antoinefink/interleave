/**
 * RetentionService tests (T079) — the composition seam between the persisted stores
 * (settings bands + per-concept + per-card columns) and the pure resolver.
 *
 * Pins: `targets()` assembles bands + concept-name targets + the enabled flag;
 * `resolveForCard` resolves by band, by concept membership, and by per-card override;
 * `setCardRetention` writes the column, logs `update_element`, and floor-clamps a
 * below-floor override UP to DESIRED_RETENTION_MIN (it can never self-retire a card).
 */

import { type ElementId, PRIORITY_LABEL_VALUE } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import { RetentionService } from "./retention-service";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let retention: RetentionService;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  retention = new RetentionService(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

function makeCard(priority: number, title = "A card"): ElementId {
  return repos.review.createCard({ kind: "qa", title, priority, prompt: "Q", answer: "A" }).element
    .id;
}

describe("RetentionService.targets", () => {
  it("assembles global + bands + concept names; enabled when the band flag is on", () => {
    repos.settings.updateAppSettings({
      defaultDesiredRetention: 0.9,
      retentionByBandEnabled: true,
      retentionByBand: { A: 0.93, D: 0.85 },
    });
    const concept = repos.concepts.createConcept({ name: "Fragile" });
    repos.concepts.setConceptRetention(concept.id, 0.95);

    const targets = retention.targets();
    expect(targets.global).toBeCloseTo(0.9, 6);
    expect(targets.byBand).toEqual({ A: 0.93, D: 0.85 });
    expect(targets.byConcept).toEqual({ Fragile: 0.95 });
    expect(targets.enabled).toBe(true);
  });

  it("is enabled by a per-concept target even when the band flag is off", () => {
    repos.settings.updateAppSettings({ retentionByBandEnabled: false });
    const concept = repos.concepts.createConcept({ name: "Fragile" });
    repos.concepts.setConceptRetention(concept.id, 0.95);
    expect(retention.targets().enabled).toBe(true);
  });

  it("is disabled with no bands + no concept targets", () => {
    repos.settings.updateAppSettings({ retentionByBandEnabled: false });
    repos.concepts.createConcept({ name: "Plain" }); // no target
    expect(retention.targets().enabled).toBe(false);
  });
});

describe("RetentionService.resolveForCard", () => {
  it("resolves by priority band when enabled", () => {
    repos.settings.updateAppSettings({
      defaultDesiredRetention: 0.9,
      retentionByBandEnabled: true,
      retentionByBand: { A: 0.93 },
    });
    const card = makeCard(PRIORITY_LABEL_VALUE.A);
    const r = retention.resolveForCard(card);
    expect(r.source).toBe("band");
    expect(r.target).toBeCloseTo(0.93, 6);
  });

  it("resolves by concept membership (strictest among the card's concepts)", () => {
    repos.settings.updateAppSettings({
      defaultDesiredRetention: 0.9,
      retentionByBandEnabled: true,
      retentionByBand: { C: 0.88 },
    });
    const card = makeCard(PRIORITY_LABEL_VALUE.C);
    const low = repos.concepts.createConcept({ name: "Background" });
    const high = repos.concepts.createConcept({ name: "Fragile" });
    repos.concepts.setConceptRetention(low.id, 0.85);
    repos.concepts.setConceptRetention(high.id, 0.94);
    repos.concepts.assignConcept(card, low.id);
    repos.concepts.assignConcept(card, high.id);

    const r = retention.resolveForCard(card);
    expect(r.source).toBe("concept");
    expect(r.target).toBeCloseTo(0.94, 6); // the strictest wins
  });

  it("resolves by per-card override over concept + band", () => {
    repos.settings.updateAppSettings({
      defaultDesiredRetention: 0.9,
      retentionByBandEnabled: true,
      retentionByBand: { A: 0.93 },
    });
    const card = makeCard(PRIORITY_LABEL_VALUE.A);
    const concept = repos.concepts.createConcept({ name: "Fragile" });
    repos.concepts.setConceptRetention(concept.id, 0.95);
    repos.concepts.assignConcept(card, concept.id);
    retention.setCardRetention(card, 0.82);

    const r = retention.resolveForCard(card);
    expect(r.source).toBe("card");
    expect(r.target).toBeCloseTo(0.82, 6);
  });

  it("falls back to global for an unknown / non-card id", () => {
    repos.settings.updateAppSettings({ defaultDesiredRetention: 0.91 });
    const r = retention.resolveForCard("not-a-card" as ElementId);
    expect(r.source).toBe("global");
    expect(r.target).toBeCloseTo(0.91, 6);
  });
});

describe("RetentionService.setCardRetention", () => {
  it("writes the column + logs update_element, and clearing inherits again", () => {
    const card = makeCard(PRIORITY_LABEL_VALUE.B);
    const { card: row } = retention.setCardRetention(card, 0.93);
    expect(row.desiredRetention).toBeCloseTo(0.93, 6);

    const ops = repos.operationLog.listForElement(card);
    expect(ops.some((o) => o.opType === "update_element")).toBe(true);

    const cleared = retention.setCardRetention(card, null);
    expect(cleared.card.desiredRetention).toBeNull();
  });

  it("floor-clamps a below-floor override UP to DESIRED_RETENTION_MIN (cannot self-retire)", () => {
    const card = makeCard(PRIORITY_LABEL_VALUE.D);
    const { card: row } = retention.setCardRetention(card, 0.01);
    expect(row.desiredRetention).toBe(0.8); // clamped UP, never near-zero
    expect(retention.resolveForCard(card).target).toBe(0.8);
  });
});

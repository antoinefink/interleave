/**
 * ReviewSessionService tests (T039 — sibling burying).
 *
 * Run against a temporary, fully-migrated in-memory `better-sqlite3` DB so
 * behaviour matches production. They pin the burying contract:
 *
 *  - `siblingGroupOf` resolves a card's group from the M6 shape (the
 *    `sibling_group` `element_relations` edge FROM the card), and `null` when a
 *    card has no group;
 *  - with burying ON, two cards from one group are never returned back-to-back
 *    (the session walks past the sibling to an unrelated due card);
 *  - with burying OFF, the natural due order is returned unchanged;
 *  - a degenerate all-siblings deck still drains (burying never starves);
 *  - selection mutates nothing (no `review_states`/`due_at`/log change).
 */

import type { ElementId, IsoTimestamp, SiblingGroupId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { elements, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { newSiblingGroupId } from "./ids";
import { ReviewRepository } from "./review-repository";
import { ReviewSessionService } from "./review-session-service";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

const ASOF = "2027-06-01T12:00:00.000Z" as IsoTimestamp;

/**
 * Create a due Q&A card with the given title and a `due_at` `dueAt`, returning its
 * element id. Cards are due (their `review_states.due_at` is in the past relative
 * to `ASOF`), so `QueueRepository.dueCards(ASOF)` returns them soonest-first.
 */
function seedDueCard(h: DbHandle, title: string, dueAt: string): ElementId {
  const review = new ReviewRepository(h.db);
  const { element } = review.createCard({
    kind: "qa",
    title,
    priority: 0.625,
    prompt: `${title}?`,
    answer: `${title}.`,
    stage: "active_card",
  });
  // A fresh card is created UN-DUE (dueAt null); make it due at `dueAt` so it
  // enters the FSRS deck. (We set the column directly — this is test setup, not a
  // review; the service under test never writes review_states.)
  h.db.update(reviewStates).set({ dueAt }).where(eq(reviewStates.elementId, element.id)).run();
  return element.id as ElementId;
}

/** Group two cards as siblings via the M6 shape: a `sibling_group` edge FROM each. */
function groupAsSiblings(h: DbHandle, cardIds: readonly ElementId[]): SiblingGroupId {
  const elementsRepo = new ElementRepository(h.db);
  const groupId = newSiblingGroupId();
  for (const id of cardIds) {
    elementsRepo.addRelation({
      fromElementId: id,
      // The grouping is carried by `siblingGroupId`; `toElementId` points at the
      // first sibling (mirrors CardService's edge target — irrelevant to grouping).
      toElementId: cardIds[0] as ElementId,
      relationType: "sibling_group",
      siblingGroupId: groupId,
    });
  }
  return groupId;
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("ReviewSessionService.siblingGroupOf", () => {
  it("resolves a card's group from the sibling_group edge, null when ungrouped", () => {
    const svc = new ReviewSessionService(handle.db);
    const a = seedDueCard(handle, "Card A", "2027-05-01T00:00:00.000Z");
    const b = seedDueCard(handle, "Card B", "2027-05-01T00:00:00.000Z");
    const lone = seedDueCard(handle, "Lone", "2027-05-01T00:00:00.000Z");

    const group = groupAsSiblings(handle, [a, b]);
    expect(svc.siblingGroupOf(a)).toBe(group);
    expect(svc.siblingGroupOf(b)).toBe(group);
    // An ungrouped card has no group → never buried.
    expect(svc.siblingGroupOf(lone)).toBeNull();
  });
});

describe("ReviewSessionService.nextReviewCard — burying ON (default)", () => {
  it("never returns two siblings back-to-back, walking past to an unrelated card", () => {
    const svc = new ReviewSessionService(handle.db);
    // Two siblings are the SOONEST due (so they'd be adjacent in natural order),
    // with one unrelated card due slightly later.
    const sib1 = seedDueCard(handle, "Sibling 1", "2027-05-01T00:00:00.000Z");
    const sib2 = seedDueCard(handle, "Sibling 2", "2027-05-01T00:00:01.000Z");
    const other = seedDueCard(handle, "Unrelated", "2027-05-01T00:00:02.000Z");
    const group = groupAsSiblings(handle, [sib1, sib2]);

    // First card: the soonest-due sibling (nothing shown yet → no recent group).
    const first = svc.nextReviewCard({ asOf: ASOF });
    expect(first.cardId).toBe(sib1);
    expect(first.siblingGroupId).toBe(group);
    expect(first.deckSize).toBe(3);

    // Next card: sib1 seen, its group is "recent" → sib2 must be BURIED; the
    // unrelated card surfaces instead even though sib2 is due sooner.
    const second = svc.nextReviewCard({
      asOf: ASOF,
      exclude: [sib1],
      recentSiblingGroups: [group],
    });
    expect(second.cardId).toBe(other);
    expect(second.siblingGroupId).toBeNull();

    // Then sib2 (no longer adjacent to sib1 — `other` separated them).
    const third = svc.nextReviewCard({
      asOf: ASOF,
      exclude: [sib1, other],
      recentSiblingGroups: [other ? svc.siblingGroupOf(other) : null].filter(
        (g): g is SiblingGroupId => g != null,
      ),
    });
    expect(third.cardId).toBe(sib2);
  });

  it("does not bury an UNRELATED card just because something was shown", () => {
    const svc = new ReviewSessionService(handle.db);
    const sib1 = seedDueCard(handle, "Sibling 1", "2027-05-01T00:00:00.000Z");
    const sib2 = seedDueCard(handle, "Sibling 2", "2027-05-01T00:00:05.000Z");
    const other = seedDueCard(handle, "Unrelated", "2027-05-01T00:00:01.000Z");
    groupAsSiblings(handle, [sib1, sib2]);

    // After sib1, the soonest-due card is `other` (unrelated) — it is NOT buried.
    const next = svc.nextReviewCard({
      asOf: ASOF,
      exclude: [sib1],
      recentSiblingGroups: [svc.siblingGroupOf(sib1) as SiblingGroupId],
    });
    expect(next.cardId).toBe(other);
  });
});

describe("ReviewSessionService.nextReviewCard — burying OFF", () => {
  it("returns the natural soonest-due order, siblings adjacent", () => {
    const svc = new ReviewSessionService(handle.db);
    const sib1 = seedDueCard(handle, "Sibling 1", "2027-05-01T00:00:00.000Z");
    const sib2 = seedDueCard(handle, "Sibling 2", "2027-05-01T00:00:01.000Z");
    const other = seedDueCard(handle, "Unrelated", "2027-05-01T00:00:02.000Z");
    const group = groupAsSiblings(handle, [sib1, sib2]);

    const first = svc.nextReviewCard({ asOf: ASOF, burySiblings: false });
    expect(first.cardId).toBe(sib1);

    // Burying OFF → sib2 (the next soonest) surfaces right after sib1 even though
    // its group is "recent" — the natural due order is preserved.
    const second = svc.nextReviewCard({
      asOf: ASOF,
      burySiblings: false,
      exclude: [sib1],
      recentSiblingGroups: [group],
    });
    expect(second.cardId).toBe(sib2);

    const third = svc.nextReviewCard({
      asOf: ASOF,
      burySiblings: false,
      exclude: [sib1, sib2],
      recentSiblingGroups: [group],
    });
    expect(third.cardId).toBe(other);
  });
});

describe("ReviewSessionService.nextReviewCard — never starves", () => {
  it("drains a degenerate all-siblings deck (no infinite skip)", () => {
    const svc = new ReviewSessionService(handle.db);
    const sib1 = seedDueCard(handle, "Sibling 1", "2027-05-01T00:00:00.000Z");
    const sib2 = seedDueCard(handle, "Sibling 2", "2027-05-01T00:00:01.000Z");
    const group = groupAsSiblings(handle, [sib1, sib2]);

    const first = svc.nextReviewCard({ asOf: ASOF });
    expect(first.cardId).toBe(sib1);

    // Only sib2 remains and it IS a recent sibling — but the deck must still drain,
    // so sib2 is returned rather than the session stalling on an empty result.
    const second = svc.nextReviewCard({
      asOf: ASOF,
      exclude: [sib1],
      recentSiblingGroups: [group],
    });
    expect(second.cardId).toBe(sib2);
    expect(second.deckSize).toBe(1);

    // Walking the whole deck via exclude terminates.
    const exhausted = svc.nextReviewCard({
      asOf: ASOF,
      exclude: [sib1, sib2],
      recentSiblingGroups: [group],
    });
    expect(exhausted.cardId).toBeNull();
    expect(exhausted.deckSize).toBe(0);
  });

  it("respects the limit cap (the daily budget) on the surfaceable deck", () => {
    const svc = new ReviewSessionService(handle.db);
    seedDueCard(handle, "A", "2027-05-01T00:00:00.000Z");
    seedDueCard(handle, "B", "2027-05-01T00:00:01.000Z");
    seedDueCard(handle, "C", "2027-05-01T00:00:02.000Z");

    expect(svc.nextReviewCard({ asOf: ASOF }).deckSize).toBe(3);
    expect(svc.nextReviewCard({ asOf: ASOF, limit: 2 }).deckSize).toBe(2);
    expect(svc.nextReviewCard({ asOf: ASOF, limit: 0 }).cardId).toBeNull();
  });
});

describe("ReviewSessionService — selection mutates nothing", () => {
  it("leaves review_states + elements.due_at untouched", () => {
    const svc = new ReviewSessionService(handle.db);
    const sib1 = seedDueCard(handle, "Sibling 1", "2027-05-01T00:00:00.000Z");
    const sib2 = seedDueCard(handle, "Sibling 2", "2027-05-01T00:00:01.000Z");
    const group = groupAsSiblings(handle, [sib1, sib2]);

    const stateBefore = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, sib2))
      .get();
    const elBefore = handle.db.select().from(elements).where(eq(elements.id, sib2)).get();

    svc.nextReviewCard({ asOf: ASOF });
    svc.nextReviewCard({ asOf: ASOF, exclude: [sib1], recentSiblingGroups: [group] });

    const stateAfter = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, sib2))
      .get();
    const elAfter = handle.db.select().from(elements).where(eq(elements.id, sib2)).get();
    expect(stateAfter?.dueAt).toBe(stateBefore?.dueAt);
    expect(stateAfter?.reps).toBe(stateBefore?.reps);
    expect(elAfter?.dueAt).toBe(elBefore?.dueAt);
    expect(elAfter?.updatedAt).toBe(elBefore?.updatedAt);
  });
});

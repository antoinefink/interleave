/**
 * LibraryQuery tests (Library route — facet-driven browse).
 *
 * The browse-everything read is the seam that keeps Library's list/ordering/
 * filtering out of React, so it is unit-tested against a temporary, fully-
 * migrated in-memory `better-sqlite3` database. These assert the invariants the
 * `/library` screen depends on:
 *
 *  - with NO filters it returns ALL live elements (the browse-first default);
 *  - it EXCLUDES soft-deleted elements (and concept/media_fragment rows, which
 *    are not browsable);
 *  - it covers `topic`/`synthesis_note`/`task` — the types FTS search cannot
 *    return — proving Library is more than a re-skin of search;
 *  - it narrows by type, by status, by priority label, and by concept membership;
 *  - it respects `limit` and orders priority desc then `updated_at` desc;
 *  - the per-facet counts are DRILL-DOWN — each dimension respects every OTHER
 *    active filter but not its own value, so a facet count always equals the rows
 *    you'd get if that value were selected alongside the active filters (the fix for
 *    the reported chip/list mismatch). With NO filters they equal the live universe.
 */

import type { ElementId } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import { LIBRARY_STATUSES, LIBRARY_TYPES, LibraryQuery } from "./library-query";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let library: LibraryQuery;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  library = new LibraryQuery(handle.db, repos);
});

afterEach(() => {
  handle.sqlite.close();
});

/**
 * Build a mixed live universe spanning every browsable type + a concept (a
 * non-browsable type) + a soft-deleted element, so the facet/exclusion behaviour
 * can be asserted.
 */
function buildUniverse(): {
  source: ElementId;
  extract: ElementId;
  card: ElementId;
  topic: ElementId;
  synth: ElementId;
  task: ElementId;
  deleted: ElementId;
} {
  const source = repos.elements.create({
    type: "source",
    status: "active",
    stage: "raw_source",
    priority: PRIORITY_LABEL_VALUE.A,
    title: "On the Measure of Intelligence",
  });
  const extract = repos.elements.create({
    type: "extract",
    status: "active",
    stage: "clean_extract",
    priority: PRIORITY_LABEL_VALUE.B,
    title: "Intelligence rewards generalization",
    sourceId: source.id,
    parentId: source.id,
  });
  const card = repos.elements.create({
    type: "card",
    status: "scheduled",
    stage: "active_card",
    priority: PRIORITY_LABEL_VALUE.C,
    title: "What does intelligence reward?",
    sourceId: source.id,
    parentId: extract.id,
  });
  // The three types FTS search can NEVER return — the whole point of browse.
  const topic = repos.elements.create({
    type: "topic",
    status: "active",
    stage: "rough_topic",
    priority: PRIORITY_LABEL_VALUE.A,
    title: "Machine learning fundamentals",
  });
  const synth = repos.elements.create({
    type: "synthesis_note",
    status: "active",
    stage: "synthesis",
    priority: PRIORITY_LABEL_VALUE.D,
    title: "Synthesis: generalization vs memorization",
  });
  const task = repos.elements.create({
    type: "task",
    status: "pending",
    stage: "raw_source",
    priority: PRIORITY_LABEL_VALUE.B,
    title: "Re-read the ARC section",
  });
  // A soft-deleted element must never surface in browse.
  const trashed = repos.elements.create({
    type: "extract",
    status: "active",
    stage: "raw_extract",
    priority: PRIORITY_LABEL_VALUE.A,
    title: "Trashed extract",
    sourceId: source.id,
  });
  repos.elements.softDelete(trashed.id);

  return {
    source: source.id,
    extract: extract.id,
    card: card.id,
    topic: topic.id,
    synth: synth.id,
    task: task.id,
    deleted: trashed.id,
  };
}

describe("LibraryQuery.browse", () => {
  it("returns ALL live elements with no filters (browse-first default)", () => {
    const u = buildUniverse();
    const { items, counts } = library.browse();
    const ids = items.map((e) => e.id);

    // All six browsable types are present; the soft-deleted one is not.
    expect(ids).toContain(u.source);
    expect(ids).toContain(u.extract);
    expect(ids).toContain(u.card);
    expect(ids).toContain(u.topic);
    expect(ids).toContain(u.synth);
    expect(ids).toContain(u.task);
    expect(ids).not.toContain(u.deleted);
    expect(items.length).toBe(6);
    expect(counts.all).toBe(6);
  });

  it("excludes non-browsable types (concept) from the universe", () => {
    buildUniverse();
    // A concept element exists after this, but is a FACET, never a browsed row.
    repos.concepts.createConcept({ name: "Intelligence" });
    const { items, counts } = library.browse();
    expect(items.some((e) => e.type === "concept")).toBe(false);
    expect(counts.all).toBe(6);
  });

  it("covers topic / synthesis_note / task (the non-FTS types)", () => {
    buildUniverse();
    const types = new Set(library.browse().items.map((e) => e.type));
    expect(types.has("topic")).toBe(true);
    expect(types.has("synthesis_note")).toBe(true);
    expect(types.has("task")).toBe(true);
  });

  it("excludes system-owned tasks (weekly review) from rows AND facet counts", () => {
    const u = buildUniverse();
    // Open a weekly-review session then complete it: this leaves one DONE
    // weekly_review (spent history) plus a freshly SCHEDULED one (next session).
    // Both are system machinery — they must never surface in the knowledge browser,
    // unlike the plain user `task` from buildUniverse, which still appears.
    const session = repos.weeklyReviewService.ensureSession();
    expect(session).not.toBeNull();
    if (!session) throw new Error("expected a weekly-review session");
    repos.weeklyReviewService.completeSession(session.id);

    const { items, counts } = library.browse();
    const ids = items.map((e) => e.id);

    // The plain user task still shows; neither weekly-review element does.
    expect(ids).toContain(u.task);
    expect(items.some((e) => e.title === "Weekly review")).toBe(false);
    // Exactly the six knowledge/user rows — no recurring-session exhaust leaked in.
    expect(items.length).toBe(6);
    expect(counts.all).toBe(6);
    // The Tasks facet counts only the one user task, not the two system sessions.
    expect(counts.byType.task).toBe(1);
    // And the spent "done" session does not inflate the status facet.
    expect(counts.byStatus.done ?? 0).toBe(0);
  });

  it("narrows by type", () => {
    const u = buildUniverse();
    const { items } = library.browse({ types: ["topic"] });
    expect(items.map((e) => e.id)).toEqual([u.topic]);
  });

  it("narrows by status", () => {
    const u = buildUniverse();
    const { items } = library.browse({ statuses: ["scheduled"] });
    expect(items.map((e) => e.id)).toEqual([u.card]);
  });

  it("narrows by priority label", () => {
    const u = buildUniverse();
    const aRows = library.browse({ priorityLabel: "A" });
    // Two live A-priority elements: the source + the topic (the trashed A is excluded).
    expect(new Set(aRows.items.map((e) => e.id))).toEqual(new Set([u.source, u.topic]));
  });

  it("narrows by concept membership", () => {
    const u = buildUniverse();
    const concept = repos.concepts.createConcept({ name: "Intelligence" });
    repos.concepts.assignConcept(u.extract, concept.id);
    repos.concepts.assignConcept(u.card, concept.id);

    const { items } = library.browse({ conceptId: concept.id });
    expect(new Set(items.map((e) => e.id))).toEqual(new Set([u.extract, u.card]));
  });

  it("orders by priority desc, then updated_at desc", () => {
    const u = buildUniverse();
    // The two A-priority rows sort before B/C/D; the most-recently-updated A wins.
    repos.elements.update(u.topic, { title: "Machine learning fundamentals (rev)" });
    const ordered = library.browse().items;
    // First two are the A-priority pair (topic now most-recently-updated → first).
    expect(ordered[0]?.id).toBe(u.topic);
    expect(ordered[1]?.id).toBe(u.source);
    // The D-priority synthesis note sorts last.
    expect(ordered[ordered.length - 1]?.id).toBe(u.synth);
  });

  it("respects the limit cap", () => {
    buildUniverse();
    const { items } = library.browse({ limit: 2 });
    expect(items.length).toBe(2);
  });

  it("counts.all tracks the RENDERED rows (post-limit), never the larger match set", () => {
    // Six live elements, but a cap of 2 — the top "N elements" label must read 2
    // (the rows actually rendered), NOT 6, so the label can never exceed the list.
    buildUniverse();
    const capped = library.browse({ limit: 2 });
    expect(capped.items.length).toBe(2);
    expect(capped.counts.all).toBe(2);
    // The per-facet (drill-down) counts stay PRE-limit — they describe what selecting
    // that value would yield — so they are unaffected by the top-line cap.
    expect(capped.counts.byType.source).toBe(1);
    expect(capped.counts.byType.extract).toBe(1);
    const sumByType = LIBRARY_TYPES.reduce((acc, t) => acc + (capped.counts.byType[t] ?? 0), 0);
    expect(sumByType).toBe(6);
    // With no cap the label equals the full match set again.
    expect(library.browse().counts.all).toBe(6);
  });

  it("computes per-type / per-priority / per-status counts with NO filters (universe totals)", () => {
    buildUniverse();
    // With no active filter, every dimension counts the whole live universe.
    const { counts } = library.browse();
    expect(counts.all).toBe(6);
    expect(counts.byType.source).toBe(1);
    expect(counts.byType.extract).toBe(1);
    expect(counts.byType.card).toBe(1);
    expect(counts.byType.topic).toBe(1);
    expect(counts.byType.synthesis_note).toBe(1);
    expect(counts.byType.task).toBe(1);
    // Priority bands: A = source + topic; B = extract + task; C = card; D = synth.
    expect(counts.byPriority.A).toBe(2);
    expect(counts.byPriority.B).toBe(2);
    expect(counts.byPriority.C).toBe(1);
    expect(counts.byPriority.D).toBe(1);
    // Statuses present in the universe.
    expect(counts.byStatus.active).toBe(4);
    expect(counts.byStatus.scheduled).toBe(1);
    expect(counts.byStatus.pending).toBe(1);
  });

  it("DRILL-DOWN: byType ignores its own type filter; other dimensions honour it", () => {
    buildUniverse();
    // TYPE=card active: byType must still show universe totals (it omits its own
    // filter), but byPriority/byStatus must reflect ONLY the card (the bug fix).
    const { counts } = library.browse({ types: ["card"] });
    // byType ignores the type filter -> full universe per type.
    expect(counts.byType.source).toBe(1);
    expect(counts.byType.extract).toBe(1);
    expect(counts.byType.card).toBe(1);
    expect(counts.byType.topic).toBe(1);
    // The card is priority C, status scheduled — so the OTHER dimensions collapse to it.
    expect(counts.byPriority).toEqual({ A: 0, B: 0, C: 1, D: 0 });
    expect(counts.byStatus.scheduled).toBe(1);
    expect(counts.byStatus.active).toBe(0);
    expect(counts.byStatus.pending).toBe(0);
    // `all` equals the matched (card-only) list, not the universe.
    expect(counts.all).toBe(1);
  });

  it("DRILL-DOWN: byConcept is filter-scoped and matches the visible list (the reported bug)", () => {
    const u = buildUniverse();
    const concept = repos.concepts.createConcept({ name: "Attention" });
    // The concept has 4 members: 3 "extracts" (the extract + two more) + 1 card.
    const extract2 = repos.elements.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: PRIORITY_LABEL_VALUE.B,
      title: "Attention extract 2",
    });
    const extract3 = repos.elements.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: PRIORITY_LABEL_VALUE.B,
      title: "Attention extract 3",
    });
    repos.concepts.assignConcept(u.extract, concept.id);
    repos.concepts.assignConcept(extract2.id, concept.id);
    repos.concepts.assignConcept(extract3.id, concept.id);
    repos.concepts.assignConcept(u.card, concept.id);

    // With NO type filter, byConcept reflects all 4 live members (the Map volume).
    expect(library.browse().counts.byConcept[concept.id]).toBe(4);

    // With TYPE=Extracts active, byConcept[Attention] must be 3 (the extract members),
    // and that EXACTLY matches the returned extract rows — the count/list invariant.
    const withType = library.browse({ types: ["extract"] });
    expect(withType.counts.byConcept[concept.id]).toBe(3);
    const extractRows = withType.items.filter((e) => e.type === "extract");
    expect(extractRows.length).toBe(3);
    // The HARD invariant: selecting the concept alongside TYPE=Extracts yields exactly
    // that many rows.
    const intersection = library.browse({ types: ["extract"], conceptId: concept.id });
    expect(intersection.items.length).toBe(3);
    expect(withType.counts.byConcept[concept.id]).toBe(intersection.items.length);
  });

  it("DRILL-DOWN: a concept with 0 matching members under the active type shows 0 (no surprise-empty)", () => {
    const u = buildUniverse();
    // A concept whose ONLY member is a card.
    const concept = repos.concepts.createConcept({ name: "OnlyCards" });
    repos.concepts.assignConcept(u.card, concept.id);

    // Under TYPE=Extracts the concept has zero extract members -> byConcept===0, so
    // selecting it would yield an empty list AND the chip already shows 0 (not a
    // non-zero number that mismatches the list).
    const withType = library.browse({ types: ["extract"] });
    expect(withType.counts.byConcept[concept.id] ?? 0).toBe(0);
    const intersection = library.browse({ types: ["extract"], conceptId: concept.id });
    expect(intersection.items.length).toBe(0);
  });

  it("DRILL-DOWN: byConcept ignores its own concept filter (so it can be re-picked)", () => {
    const u = buildUniverse();
    const a = repos.concepts.createConcept({ name: "A" });
    const b = repos.concepts.createConcept({ name: "B" });
    repos.concepts.assignConcept(u.extract, a.id);
    repos.concepts.assignConcept(u.card, b.id);

    // With CONCEPT=A active, byConcept still reports B's count (its own value omitted),
    // so the user can switch to B and see a non-empty list.
    const counts = library.browse({ conceptId: a.id }).counts;
    expect(counts.byConcept[a.id]).toBe(1); // A's own member (own filter omitted)
    expect(counts.byConcept[b.id]).toBe(1); // B still visible to switch to
  });

  it("INVARIANT: for every facet value, its count equals the rows when that value is added", () => {
    const u = buildUniverse();
    const concept = repos.concepts.createConcept({ name: "K" });
    repos.concepts.assignConcept(u.extract, concept.id);
    repos.concepts.assignConcept(u.card, concept.id);

    // Start from an active priority filter and verify the type-dimension invariant.
    const base = { priorityLabel: "A" as const };
    const counts = library.browse(base).counts;
    for (const t of LIBRARY_TYPES) {
      const withValue = library.browse({ ...base, types: [t] });
      expect(counts.byType[t]).toBe(withValue.items.length);
    }
    // And the status-dimension invariant under the same base filter.
    for (const s of LIBRARY_STATUSES) {
      const withValue = library.browse({ ...base, statuses: [s] });
      expect(counts.byStatus[s]).toBe(withValue.items.length);
    }
  });

  it("INVARIANT: sum of byType (no other filters) equals all", () => {
    buildUniverse();
    const { counts } = library.browse();
    const sum = LIBRARY_TYPES.reduce((acc, t) => acc + (counts.byType[t] ?? 0), 0);
    expect(sum).toBe(counts.all);
  });

  it("never returns an unbounded list without a soft-deleted leak", () => {
    const u = buildUniverse();
    const ids = library.browse({ limit: 500 }).items.map((e) => e.id);
    expect(ids).not.toContain(u.deleted);
  });
});

/**
 * ConceptRepository tests (T041).
 *
 * Concepts are dual-modeled — a `concept`-type element (logging `create_element`)
 * PLUS a `concepts` hierarchy row, written in ONE transaction — and membership is a
 * `concept_membership` edge in `element_relations` (logging `add_relation` /
 * `remove_relation`). NO new op types. These assert the load-bearing invariants:
 *
 *  - `createConcept` writes BOTH the element + the `concepts` row atomically, logs
 *    `create_element`, and rejects a bad/missing parent;
 *  - `assignConcept`/`unassignConcept` add/remove the membership edge, log
 *    `add_relation`/`remove_relation`, and are idempotent;
 *  - `conceptsForElement`/`elementsForConcept` resolve membership both directions;
 *  - `listConcepts` returns the hierarchy with correct parent links + member counts.
 */

import type { ElementId } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import { concepts as conceptsTable, type DbHandle } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConceptRepository } from "./concept-repository";
import type { ElementRepository } from "./element-repository";
import { createRepositories, type Repositories } from "./index";
import type { OperationLogRepository } from "./operation-log-repository";
import { createInMemoryDb } from "./test-db";
import { TrashRepository } from "./trash-query";

let handle: DbHandle;
let repos: Repositories;
let concepts: ConceptRepository;
let elements: ElementRepository;
let opLog: OperationLogRepository;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  concepts = repos.concepts;
  elements = repos.elements;
  opLog = repos.operationLog;
});

afterEach(() => {
  handle.sqlite.close();
});

/** Create a plain (non-concept) element to assign concepts to. */
function makeExtract(title = "An extract"): ElementId {
  return elements.create({
    type: "extract",
    status: "active",
    stage: "raw_extract",
    priority: PRIORITY_LABEL_VALUE.B,
    title,
  }).id;
}

describe("ConceptRepository.createConcept", () => {
  it("writes the concept element AND the concepts row in one transaction, logging create_element", () => {
    const concept = concepts.createConcept({ name: "Cognition" });

    // The concept exists as a `concept`-type element.
    const el = elements.findById(concept.id);
    expect(el).not.toBeNull();
    expect(el?.type).toBe("concept");
    expect(el?.title).toBe("Cognition");

    // The concepts side-table row exists with the same id.
    const summary = concepts.findById(concept.id);
    expect(summary).toEqual({
      id: concept.id,
      name: "Cognition",
      parentConceptId: null,
      desiredRetention: null,
    });

    // It logged `create_element` (the closed op set — no `create_concept`).
    const ops = opLog.listForElement(concept.id);
    expect(ops.some((o) => o.opType === "create_element")).toBe(true);
    expect(ops.some((o) => String(o.opType) === "create_concept")).toBe(false);
  });

  it("builds a hierarchy: a child concept links to its parent", () => {
    const parent = concepts.createConcept({ name: "Cognition" });
    const child = concepts.createConcept({ name: "Intelligence", parentConceptId: parent.id });
    expect(child.parentConceptId).toBe(parent.id);
    const summary = concepts.findById(child.id);
    expect(summary?.parentConceptId).toBe(parent.id);
  });

  it("rejects a parent that does not exist", () => {
    expect(() =>
      concepts.createConcept({ name: "Orphan", parentConceptId: "does-not-exist" as ElementId }),
    ).toThrow(/parent concept/);
  });

  it("rejects a parent that is not a concept", () => {
    const extractId = makeExtract();
    expect(() =>
      concepts.createConcept({ name: "Bad parent", parentConceptId: extractId }),
    ).toThrow(/parent concept/);
  });

  it("rejects an empty name", () => {
    expect(() => concepts.createConcept({ name: "   " })).toThrow(/non-empty/);
  });
});

describe("ConceptRepository.assignConcept / unassignConcept", () => {
  it("adds the concept_membership edge and logs add_relation", () => {
    const extractId = makeExtract();
    const concept = concepts.createConcept({ name: "Memory" });

    concepts.assignConcept(extractId, concept.id);

    const edges = elements
      .listRelationsFrom(extractId)
      .filter((r) => r.relationType === "concept_membership");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.toElementId).toBe(concept.id);

    const ops = opLog.listForElement(extractId);
    expect(ops.some((o) => o.opType === "add_relation")).toBe(true);
  });

  it("is idempotent — re-assigning the same pair does not duplicate the edge or re-log", () => {
    const extractId = makeExtract();
    const concept = concepts.createConcept({ name: "Memory" });

    concepts.assignConcept(extractId, concept.id);
    concepts.assignConcept(extractId, concept.id);

    const edges = elements
      .listRelationsFrom(extractId)
      .filter((r) => r.relationType === "concept_membership");
    expect(edges).toHaveLength(1);
    const addRelations = opLog.listForElement(extractId).filter((o) => o.opType === "add_relation");
    expect(addRelations).toHaveLength(1);
  });

  it("removes the edge and logs remove_relation", () => {
    const extractId = makeExtract();
    const concept = concepts.createConcept({ name: "Memory" });
    concepts.assignConcept(extractId, concept.id);

    concepts.unassignConcept(extractId, concept.id);

    const edges = elements
      .listRelationsFrom(extractId)
      .filter((r) => r.relationType === "concept_membership");
    expect(edges).toHaveLength(0);
    const ops = opLog.listForElement(extractId);
    expect(ops.some((o) => o.opType === "remove_relation")).toBe(true);
  });

  it("unassigning a non-member is a no-op (no throw, no op)", () => {
    const extractId = makeExtract();
    const concept = concepts.createConcept({ name: "Memory" });
    expect(() => concepts.unassignConcept(extractId, concept.id)).not.toThrow();
    expect(opLog.listForElement(extractId).some((o) => o.opType === "remove_relation")).toBe(false);
  });

  it("rejects assigning to a concept that does not exist", () => {
    const extractId = makeExtract();
    expect(() => concepts.assignConcept(extractId, "nope" as ElementId)).toThrow(/concept/);
  });

  it("rejects assigning to a SOFT-DELETED concept (write side honours element liveness, not the side-table row)", () => {
    const extractId = makeExtract();
    const concept = concepts.createConcept({ name: "Memory" });
    // Soft-deleting the concept ELEMENT leaves the `concepts` side-table row alive,
    // so a side-table `findById` still resolves it — but assignConcept must refuse,
    // matching the read side (liveMembershipMap/elementsForConcept drop dead concepts).
    elements.softDelete(concept.id);
    expect(concepts.findById(concept.id)).not.toBeNull(); // side-table row survives
    expect(() => concepts.assignConcept(extractId, concept.id)).toThrow(/concept/);
    // No phantom edge was created (the write was rejected before addRelation).
    expect(
      elements.listRelationsFrom(extractId).filter((r) => r.relationType === "concept_membership"),
    ).toHaveLength(0);
  });

  it("rejects assigning to a non-concept element id", () => {
    const extractId = makeExtract();
    const otherExtract = makeExtract("Other");
    // An element id that is not a concept must be rejected (type guard on the write).
    expect(() => concepts.assignConcept(extractId, otherExtract)).toThrow(/concept/);
  });
});

describe("ConceptRepository membership reads", () => {
  it("conceptsForElement and elementsForConcept resolve membership both directions", () => {
    const a = makeExtract("A");
    const b = makeExtract("B");
    const cog = concepts.createConcept({ name: "Cognition" });
    const mem = concepts.createConcept({ name: "Memory" });

    concepts.assignConcept(a, cog.id);
    concepts.assignConcept(a, mem.id);
    concepts.assignConcept(b, cog.id);

    const aConcepts = concepts
      .conceptsForElement(a)
      .map((c) => c.name)
      .sort();
    expect(aConcepts).toEqual(["Cognition", "Memory"]);

    expect(new Set(concepts.elementsForConcept(cog.id))).toEqual(new Set([a, b]));
    expect(concepts.elementsForConcept(mem.id)).toEqual([a]);
  });

  it("elementsForConcept excludes soft-deleted members", () => {
    const a = makeExtract("A");
    const concept = concepts.createConcept({ name: "Cognition" });
    concepts.assignConcept(a, concept.id);
    expect(concepts.elementsForConcept(concept.id)).toEqual([a]);

    elements.softDelete(a);
    expect(concepts.elementsForConcept(concept.id)).toEqual([]);
  });

  it("conceptsForElement excludes soft-deleted concepts (matches liveMembershipMap / firstConceptName)", () => {
    const a = makeExtract("A");
    const dead = concepts.createConcept({ name: "Dead" });
    const live = concepts.createConcept({ name: "Live" });
    concepts.assignConcept(a, dead.id);
    concepts.assignConcept(a, live.id);

    // Before deletion: both surface.
    expect(
      concepts
        .conceptsForElement(a)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["Dead", "Live"]);

    // Soft-deleting the concept ELEMENT keeps the `concepts` side-table row alive, so
    // a raw `findById` would still resolve it — but conceptsForElement must drop it,
    // consistent with every other live-membership read.
    elements.softDelete(dead.id);
    const names = concepts.conceptsForElement(a).map((c) => c.name);
    expect(names).toEqual(["Live"]);

    // All membership reads agree: the dead concept appears in NONE of them.
    expect(concepts.firstConceptName(a)).toBe("Live");
    expect(concepts.liveMembershipMap().get(a)).toEqual(new Set([live.id]));
  });

  it("drops a concept_membership edge whose `to` endpoint is a NON-concept element (load-bearing liveness/type guard)", () => {
    // assignConcept rejects a non-concept target at write time, but a RAW addRelation
    // (used for duplicates) or legacy/imported data can still create a
    // `concept_membership` edge pointing at a non-concept. The substrate's guard
    // (liveMembershipMap keeps only edges whose `to` is in liveConceptIds, built with
    // `type = 'concept' AND deleted_at IS NULL`) must drop such an edge from EVERY
    // read so a corrupt row can never inflate a count or surface a phantom concept.
    const memberId = makeExtract("Member");
    const notAConceptId = makeExtract("Not a concept");

    elements.addRelation({
      fromElementId: memberId,
      toElementId: notAConceptId,
      relationType: "concept_membership",
    });

    // liveMembershipMap: the edge is excluded (its `to` endpoint is not a live concept).
    expect(concepts.liveMembershipMap().get(memberId)).toBeUndefined();
    // conceptsForElement: the non-concept `to` endpoint is not surfaced as a concept.
    expect(concepts.conceptsForElement(memberId)).toEqual([]);
    // elementsForConcept(non-concept) is [] (the id is not a live concept).
    expect(concepts.elementsForConcept(notAConceptId)).toEqual([]);
    // The byConcept-style member count (inversion of the map) counts it as 0 — there
    // is no concept node for a non-concept id, so listConcepts never reports it.
    expect(concepts.listConcepts().some((c) => c.id === notAConceptId)).toBe(false);
    let memberCountForNonConcept = 0;
    for (const set of concepts.liveMembershipMap().values()) {
      if (set.has(notAConceptId)) memberCountForNonConcept += 1;
    }
    expect(memberCountForNonConcept).toBe(0);
  });

  it("conceptsForElement dedups duplicate membership edges (one summary per concept)", () => {
    const a = makeExtract("A");
    const concept = concepts.createConcept({ name: "Memory" });
    // Raw duplicate edges (bypass assignConcept's idempotency) to exercise dedup.
    elements.addRelation({
      fromElementId: a,
      toElementId: concept.id,
      relationType: "concept_membership",
    });
    elements.addRelation({
      fromElementId: a,
      toElementId: concept.id,
      relationType: "concept_membership",
    });
    const found = concepts.conceptsForElement(a);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(concept.id);
  });
});

describe("ConceptRepository.listConcepts", () => {
  it("returns the hierarchy with correct parent links, child counts, and member counts", () => {
    const parent = concepts.createConcept({ name: "Cognition" });
    const child = concepts.createConcept({ name: "Intelligence", parentConceptId: parent.id });
    const a = makeExtract("A");
    const b = makeExtract("B");
    concepts.assignConcept(a, child.id);
    concepts.assignConcept(b, child.id);

    const list = concepts.listConcepts();
    const byId = new Map(list.map((c) => [c.id, c]));

    expect(byId.get(parent.id)).toMatchObject({
      name: "Cognition",
      parentConceptId: null,
      childCount: 1,
      memberCount: 0,
    });
    expect(byId.get(child.id)).toMatchObject({
      name: "Intelligence",
      parentConceptId: parent.id,
      childCount: 0,
      memberCount: 2,
    });
  });

  it("member count counts each member once even with duplicate edges, and ignores trashed members", () => {
    const concept = concepts.createConcept({ name: "Cognition" });
    const a = makeExtract("A");
    concepts.assignConcept(a, concept.id);
    concepts.assignConcept(a, concept.id); // idempotent
    expect(concepts.listConcepts().find((c) => c.id === concept.id)?.memberCount).toBe(1);

    elements.softDelete(a);
    expect(concepts.listConcepts().find((c) => c.id === concept.id)?.memberCount).toBe(0);
  });
});

describe("ConceptRepository concept-node lifecycle (soft-delete + purge)", () => {
  it("soft-deleting a concept node drops it from listConcepts but keeps the side-table row", () => {
    const cog = concepts.createConcept({ name: "Cognition" });
    expect(concepts.listConcepts().some((c) => c.id === cog.id)).toBe(true);

    elements.softDelete(cog.id);

    // listConcepts filters by live element ids, so the soft-deleted node drops out…
    expect(concepts.listConcepts().some((c) => c.id === cog.id)).toBe(false);
    // …but soft-delete is recoverable, so the side-table row still exists.
    expect(concepts.findById(cog.id)).not.toBeNull();
    const sideRows = handle.db
      .select()
      .from(conceptsTable)
      .where(eq(conceptsTable.id, cog.id))
      .all();
    expect(sideRows).toHaveLength(1);
  });

  it("purging a concept node cascade-deletes its concepts side-table row (no orphan)", () => {
    const trash = new TrashRepository(handle.db);
    const cog = concepts.createConcept({ name: "Cognition" });

    // Sanity: the side-table row exists before purge.
    expect(
      handle.db.select().from(conceptsTable).where(eq(conceptsTable.id, cog.id)).all(),
    ).toHaveLength(1);

    elements.softDelete(cog.id);
    const purged = trash.purge(cog.id);
    expect(purged).toBe(true);

    // The element row is gone (hard delete)…
    expect(elements.findById(cog.id)).toBeNull();
    // …and the concepts side-table row cascade-deleted with it (no dangling row,
    // no phantom summary). This is the cascade-FK fix on `concepts.id`.
    expect(
      handle.db.select().from(conceptsTable).where(eq(conceptsTable.id, cog.id)).all(),
    ).toHaveLength(0);
    expect(concepts.findById(cog.id)).toBeNull();
  });

  it("emptyTrash leaves no orphan concepts rows", () => {
    const trash = new TrashRepository(handle.db);
    const parent = concepts.createConcept({ name: "Cognition" });
    const child = concepts.createConcept({ name: "Intelligence", parentConceptId: parent.id });

    elements.softDelete(child.id);
    elements.softDelete(parent.id);
    trash.emptyTrash();

    expect(handle.db.select().from(conceptsTable).all()).toHaveLength(0);
  });
});

describe("ConceptRepository per-concept retention (T079)", () => {
  it("setConceptRetention writes the column, logs update_element, and surfaces on findById", () => {
    const concept = concepts.createConcept({ name: "Fragile" });
    expect(concepts.findById(concept.id)?.desiredRetention).toBeNull();

    const updated = concepts.setConceptRetention(concept.id, 0.93);
    expect(updated.desiredRetention).toBeCloseTo(0.93, 6);
    expect(concepts.findById(concept.id)?.desiredRetention).toBeCloseTo(0.93, 6);

    // Logged as `update_element` on the concept element (the closed op set).
    const ops = opLog.listForElement(concept.id);
    expect(ops.some((o) => o.opType === "update_element")).toBe(true);

    // Clearing it back to inherit.
    const cleared = concepts.setConceptRetention(concept.id, null);
    expect(cleared.desiredRetention).toBeNull();
  });

  it("clamps a stored per-concept target to the supported band (choke point)", () => {
    const concept = concepts.createConcept({ name: "Clamped" });
    expect(concepts.setConceptRetention(concept.id, 0.01).desiredRetention).toBe(0.8);
    expect(concepts.setConceptRetention(concept.id, 1.5).desiredRetention).toBe(0.97);
  });

  it("retentionTargets() keys by NAME and collapses duplicate names to the HIGHEST target", () => {
    const lowDup = concepts.createConcept({ name: "Shared" });
    const highDup = concepts.createConcept({ name: "Shared" });
    const other = concepts.createConcept({ name: "Other" });
    const noTarget = concepts.createConcept({ name: "NoTarget" });
    concepts.setConceptRetention(lowDup.id, 0.85);
    concepts.setConceptRetention(highDup.id, 0.94);
    concepts.setConceptRetention(other.id, 0.9);
    void noTarget; // left at null = inherit → absent from the map

    const targets = concepts.retentionTargets();
    // Deterministic: the two "Shared" concepts collapse to the HIGHEST (0.94), never
    // order-dependent last-write-wins (which could under-protect a fragile concept).
    expect(targets.Shared).toBeCloseTo(0.94, 6);
    expect(targets.Other).toBeCloseTo(0.9, 6);
    expect(targets).not.toHaveProperty("NoTarget");
  });

  it("retentionTargets() drops a soft-deleted concept", () => {
    const concept = concepts.createConcept({ name: "Gone" });
    concepts.setConceptRetention(concept.id, 0.92);
    expect(concepts.retentionTargets().Gone).toBeCloseTo(0.92, 6);
    elements.softDelete(concept.id);
    expect(concepts.retentionTargets()).not.toHaveProperty("Gone");
  });
});

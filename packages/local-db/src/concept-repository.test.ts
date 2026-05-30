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
    expect(summary).toEqual({ id: concept.id, name: "Cognition", parentConceptId: null });

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

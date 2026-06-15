/**
 * InboxBulkTriageService domain tests (T126).
 *
 * Run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` database (via
 * `createInMemoryDb`), so behaviour matches production exactly. They are the safety net
 * for the bulk batch boundary: ONE wrapping transaction sharing ONE `batchId`, reusing
 * the EXACT per-item verb writes (no new op type, no new status, no new mutation shape),
 * skip-and-classify of stale ids (never thrown), atomic abort on a real write error, and
 * op-type-agnostic undo that restores every pre-image AND refuses cleanly on a moved
 * victim.
 *
 * The single-row triage writes these test against are the SAME helpers the per-item
 * `DbService.triageInboxItem` composes (`SchedulerService.activateSourceWithReturnWithin`
 * / `queueSourceSoonWithin`, `ElementRepository.updateWithin` / `softDeleteWithin`).
 */

import type { ElementId, IsoTimestamp, Priority } from "@interleave/core";
import { priorityFromLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { elements, operationLog, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { type InboxBulkTriageAction, InboxBulkTriageService } from "./inbox-bulk-triage-service";
import { createRepositories } from "./index";
import { SchedulerService } from "./scheduler-service";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

let handle: DbHandle;

const NOW = "2027-06-01T12:00:00.000Z" as IsoTimestamp;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

/** Build the service over the open DB with the SAME deps the DbService injects. */
function service(): InboxBulkTriageService {
  const repos = createRepositories(handle.db);
  return new InboxBulkTriageService(handle.db, {
    elements: repos.elements,
    scheduler: new SchedulerService(handle.db),
    undo: new UndoService(handle.db),
  });
}

/** Create a live inbox source (the way the DB service does; default band C). */
function seedInboxSource(title: string, priority: Priority = priorityFromLabel("C")): ElementId {
  return new SourceRepository(handle.db).create({
    title,
    priority,
    status: "inbox",
    stage: "raw_source",
  }).element.id;
}

/** All op rows for an element, in insertion order. */
function opsFor(id: ElementId): { opType: string; payload: Record<string, unknown> }[] {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, id))
    .all()
    .map((row) => ({
      opType: row.opType,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
}

/** The op types written for an element, in order. */
function opTypesFor(id: ElementId): string[] {
  return opsFor(id).map((op) => op.opType);
}

/** The triage MUTATION op types only (drops the seed's `create_*` ops). */
function triageOpTypesFor(id: ElementId): string[] {
  return opTypesFor(id).filter((t) => !t.startsWith("create_"));
}

/** The current row for an element (or undefined). */
function rowFor(id: ElementId) {
  return handle.db.select().from(elements).where(eq(elements.id, id)).get();
}

/** Whether a `review_states` row exists for an element. */
function hasReviewState(id: ElementId): boolean {
  return Boolean(handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, id)).get());
}

/** Every distinct `batchId` recorded across an element's ops. */
function batchIdsFor(id: ElementId): Set<string> {
  const ids = new Set<string>();
  for (const op of opsFor(id)) {
    if (typeof op.payload.batchId === "string") ids.add(op.payload.batchId);
  }
  return ids;
}

describe("InboxBulkTriageService.apply — atomicity & shared batch", () => {
  it("a 3-id bulk emits ops all sharing ONE batchId", () => {
    const a = seedInboxSource("A");
    const b = seedInboxSource("B");
    const c = seedInboxSource("C");

    const result = service().apply([a, b, c], "queueSoon", null, NOW);

    expect(result.applied).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(result.errored).toEqual([]);
    // Every applied row carries the result's batchId — and exactly that one.
    for (const id of [a, b, c]) {
      expect(batchIdsFor(id)).toEqual(new Set([result.batchId]));
    }
  });

  it("empty ids → applied 0 (still mints a batchId, no ops)", () => {
    const result = service().apply([], "delete", null, NOW);
    expect(result.applied).toBe(0);
    expect(result.batchId).toBeTruthy();
    expect(handle.db.select().from(operationLog).all().length).toBe(0);
  });

  it("duplicate ids are deduped (applied once)", () => {
    const a = seedInboxSource("Dup");
    const result = service().apply([a, a, a], "queueSoon", null, NOW);
    expect(result.applied).toBe(1);
    // One reschedule op, not three.
    expect(opTypesFor(a).filter((t) => t === "reschedule_element").length).toBe(1);
  });
});

describe("InboxBulkTriageService.apply — reuse, not reinvent", () => {
  it("bulk queueSoon emits reschedule_element and creates NO review_states row", () => {
    const a = seedInboxSource("Queue me");
    const result = service().apply([a], "queueSoon", null, NOW);

    expect(result.applied).toBe(1);
    expect(opTypesFor(a)).toContain("reschedule_element");
    // Sources are attention-scheduled — NOT FSRS.
    expect(hasReviewState(a)).toBe(false);
    const row = rowFor(a);
    expect(row?.status).toBe("scheduled");
    expect(row?.dueAt).toBe(NOW);
  });

  it("bulk park emits update_element status:parked and PRESERVES prior priority", () => {
    const a = seedInboxSource("Park me", priorityFromLabel("A"));
    const result = service().apply([a], "keepForLater", null, NOW);

    expect(result.applied).toBe(1);
    const parkOps = opsFor(a).filter((op) => op.opType === "update_element");
    expect(parkOps.length).toBe(1);
    const patch = parkOps[0]?.payload.patch as Record<string, unknown>;
    expect(patch.status).toBe("parked");
    expect(patch.dueAt).toBeNull();
    const row = rowFor(a);
    expect(row?.status).toBe("parked");
    expect(row?.dueAt).toBeNull();
    expect(row?.parkedAt).toBe(NOW);
    // Priority untouched by a verb-only park.
    expect(row?.priority).toBe(priorityFromLabel("A"));
  });

  it("bulk delete emits soft_delete_element", () => {
    const a = seedInboxSource("Delete me");
    const result = service().apply([a], "delete", null, NOW);

    expect(result.applied).toBe(1);
    expect(opTypesFor(a)).toContain("soft_delete_element");
    const row = rowFor(a);
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.status).toBe("deleted");
  });

  it("bulk accept activates with a return dueAt (no FSRS state)", () => {
    const a = seedInboxSource("Read now");
    const result = service().apply([a], "accept", null, NOW);

    expect(result.applied).toBe(1);
    expect(opTypesFor(a)).toContain("reschedule_element");
    expect(hasReviewState(a)).toBe(false);
    const row = rowFor(a);
    expect(row?.status).toBe("active");
    expect(row?.dueAt).not.toBeNull();
  });

  it("ONLY the four existing op types are written (no new op type)", () => {
    const allowed = new Set([
      "reschedule_element",
      "update_element",
      "soft_delete_element",
      "create_source",
      "create_element",
      "update_document",
    ]);
    const svc = service();
    const accept = seedInboxSource("accept");
    const queue = seedInboxSource("queue");
    const park = seedInboxSource("park");
    const del = seedInboxSource("del");
    svc.apply([accept], "accept", null, NOW);
    svc.apply([queue], "queueSoon", null, NOW);
    svc.apply([park], "keepForLater", null, NOW);
    svc.apply([del], "delete", null, NOW);
    const writtenTypes = new Set(
      handle.db
        .select()
        .from(operationLog)
        .all()
        .map((r) => r.opType),
    );
    for (const type of writtenTypes) {
      expect(allowed.has(type)).toBe(true);
    }
    // The triage verbs themselves wrote only the three mutation ops.
    expect(writtenTypes.has("reschedule_element")).toBe(true);
    expect(writtenTypes.has("update_element")).toBe(true);
    expect(writtenTypes.has("soft_delete_element")).toBe(true);
  });
});

describe("InboxBulkTriageService.apply — combined verb + priority", () => {
  it("queueSoon + B emits per item a priority update_element AND a reschedule_element, one batchId", () => {
    const a = seedInboxSource("Q+B", priorityFromLabel("C"));
    const result = service().apply([a], "queueSoon", "B", NOW);

    expect(result.applied).toBe(1);
    const types = opTypesFor(a);
    expect(types).toContain("update_element"); // the priority write
    expect(types).toContain("reschedule_element"); // the queueSoon write
    expect(batchIdsFor(a)).toEqual(new Set([result.batchId]));
    const row = rowFor(a);
    expect(row?.priority).toBe(priorityFromLabel("B"));
    expect(row?.status).toBe("scheduled");
    expect(row?.dueAt).toBe(NOW);
  });

  it("setPriority-only sweep keeps the item in inbox and writes only the priority", () => {
    const a = seedInboxSource("Priority only", priorityFromLabel("D"));
    const result = service().apply([a], "setPriority", "A", NOW);

    expect(result.applied).toBe(1);
    // Exactly one triage write (the priority update) — no reschedule/soft-delete.
    expect(triageOpTypesFor(a)).toEqual(["update_element"]);
    const row = rowFor(a);
    expect(row?.status).toBe("inbox"); // STAYS in the inbox
    expect(row?.priority).toBe(priorityFromLabel("A"));
  });

  it("setPriority without a band throws (the contract requires a band)", () => {
    const a = seedInboxSource("No band");
    expect(() => service().apply([a], "setPriority", null, NOW)).toThrow(
      /requires a priority band/,
    );
  });

  it("T127 forward-compat: a setPriority op payload carries BOTH prior and new priority", () => {
    const a = seedInboxSource("Measure later", priorityFromLabel("D"));
    service().apply([a], "setPriority", "A", NOW);
    const op = opsFor(a).find((o) => o.opType === "update_element");
    const patch = op?.payload.patch as Record<string, unknown>;
    const prev = op?.payload.prev as Record<string, unknown>;
    expect(patch.priority).toBe(priorityFromLabel("A"));
    expect(prev.priority).toBe(priorityFromLabel("D"));
  });
});

describe("InboxBulkTriageService.apply — skip-and-count", () => {
  it("classifies all four distinct skip reasons in one call AND applies the live ones", () => {
    const elementsRepo = new ElementRepository(handle.db);
    const repos = createRepositories(handle.db);

    const liveA = seedInboxSource("live A");
    const liveB = seedInboxSource("live B");

    // deleted → "deleted"
    const deleted = seedInboxSource("deleted");
    elementsRepo.softDelete(deleted);

    // parked (a live, non-inbox source) → "not_inbox"
    const parked = seedInboxSource("parked");
    elementsRepo.update(parked, { status: "parked" });

    // a non-source element (a task) → "wrong_type"
    const wrongType = repos.elements.create({
      type: "task",
      status: "inbox",
      stage: "rough_topic",
      priority: 0.5,
      title: "a task",
    }).id;

    // a non-existent id → "already_acted"
    const missing = "missing-id" as ElementId;

    const result = service().apply(
      [liveA, deleted, parked, wrongType, missing, liveB],
      "queueSoon",
      null,
      NOW,
    );

    expect(result.applied).toBe(2);
    expect(result.errored).toEqual([]);
    const byId = new Map(result.skipped.map((s) => [s.id, s.reason]));
    expect(byId.get(deleted)).toBe("deleted");
    expect(byId.get(parked)).toBe("not_inbox");
    expect(byId.get(wrongType)).toBe("wrong_type");
    expect(byId.get(missing)).toBe("already_acted");
    expect(result.skipped.length).toBe(4);
    // The live ones really applied.
    expect(rowFor(liveA)?.status).toBe("scheduled");
    expect(rowFor(liveB)?.status).toBe("scheduled");
    // The skipped ones did NOT change.
    expect(rowFor(parked)?.status).toBe("parked");
  });

  it("does not throw when the whole selection is ineligible", () => {
    const elementsRepo = new ElementRepository(handle.db);
    const deleted = seedInboxSource("deleted");
    elementsRepo.softDelete(deleted);
    const result = service().apply([deleted], "delete", null, NOW);
    expect(result.applied).toBe(0);
    expect(result.skipped).toEqual([{ id: deleted, reason: "deleted" }]);
  });
});

describe("InboxBulkTriageService.apply — errored channel (atomic abort)", () => {
  it("a real write error aborts the whole tx (zero applied, nothing persists) and is reported", () => {
    const repos = createRepositories(handle.db);
    const scheduler = new SchedulerService(handle.db);
    const svc = new InboxBulkTriageService(handle.db, {
      elements: repos.elements,
      scheduler,
      undo: new UndoService(handle.db),
    });

    const a = seedInboxSource("ok before");
    const b = seedInboxSource("boom");
    const c = seedInboxSource("after");

    const opsBefore = handle.db.select().from(operationLog).all().length;

    // Force a write error on the SECOND eligible row mid-batch.
    const original = scheduler.queueSourceSoonWithin.bind(scheduler);
    let calls = 0;
    scheduler.queueSourceSoonWithin = ((tx, id, now, extras) => {
      calls += 1;
      if (calls === 2) throw new Error("disk on fire");
      return original(tx, id, now, extras);
    }) as typeof scheduler.queueSourceSoonWithin;

    const result = svc.apply([a, b, c], "queueSoon", null, NOW);

    // Atomic: zero applied, error surfaced distinctly from a skip.
    expect(result.applied).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.errored.length).toBe(3);
    expect(result.errored[0]?.error).toMatch(/disk on fire/);
    // The errored channel carries the correct input ids (every eligible id of the
    // aborted batch), not a placeholder — so the renderer can name the failures.
    expect(result.errored.map((e) => e.id).sort()).toEqual([a, b, c].sort());
    // Nothing persisted — the transaction rolled back fully.
    expect(handle.db.select().from(operationLog).all().length).toBe(opsBefore);
    expect(rowFor(a)?.status).toBe("inbox");
    expect(rowFor(b)?.status).toBe("inbox");
    expect(rowFor(c)?.status).toBe("inbox");
  });
});

describe("InboxBulkTriageService.undoBatch — symmetry across ALL FIVE verbs", () => {
  /** Snapshot the fields a triage verb can touch. */
  function snap(id: ElementId) {
    const row = rowFor(id);
    return {
      status: row?.status ?? null,
      dueAt: row?.dueAt ?? null,
      priority: row?.priority ?? null,
      parkedAt: row?.parkedAt ?? null,
      deletedAt: row?.deletedAt ?? null,
    };
  }

  for (const action of ["accept", "queueSoon", "keepForLater", "delete"] as const) {
    it(`undo restores every row to its pre-image for bulk ${action}`, () => {
      const svc = service();
      const ids = [seedInboxSource("x"), seedInboxSource("y"), seedInboxSource("z")];
      const before = ids.map((id) => snap(id));

      const result = svc.apply(ids, action as InboxBulkTriageAction, null, NOW);
      expect(result.applied).toBe(3);
      // Confirm something actually changed.
      expect(snap(ids[0] as ElementId)).not.toEqual(before[0]);

      const undo = svc.undoBatch(result.batchId);
      expect(undo.undone).toBe(true);
      expect(undo.count).toBe(3);
      ids.forEach((id, i) => {
        expect(snap(id)).toEqual(before[i]);
      });
    });
  }

  it("undo restores BOTH status/dueAt AND priority for a combined queueSoon + B", () => {
    const svc = service();
    const a = seedInboxSource("combo", priorityFromLabel("D"));
    const before = snap(a);

    const result = svc.apply([a], "queueSoon", "B", NOW);
    expect(rowFor(a)?.priority).toBe(priorityFromLabel("B"));
    expect(rowFor(a)?.status).toBe("scheduled");

    const undo = svc.undoBatch(result.batchId);
    expect(undo.undone).toBe(true);
    // Both the priority AND the schedule are restored.
    expect(snap(a)).toEqual(before);
    expect(rowFor(a)?.priority).toBe(priorityFromLabel("D"));
    expect(rowFor(a)?.status).toBe("inbox");
  });

  it("undo restores a setPriority-only sweep", () => {
    const svc = service();
    const a = seedInboxSource("prio", priorityFromLabel("C"));
    const before = snap(a);
    const result = svc.apply([a], "setPriority", "A", NOW);
    expect(rowFor(a)?.priority).toBe(priorityFromLabel("A"));
    const undo = svc.undoBatch(result.batchId);
    expect(undo.undone).toBe(true);
    expect(snap(a)).toEqual(before);
  });

  it("undo refuses CLEANLY (no clobber) when a victim moved since the batch", () => {
    const svc = service();
    const a = seedInboxSource("moved");
    const b = seedInboxSource("still");
    const result = svc.apply([a, b], "queueSoon", null, NOW);
    expect(result.applied).toBe(2);

    // A later, independent edit moves `a` away from the batch's post-image.
    new ElementRepository(handle.db).reschedule(a, "2099-01-01T00:00:00.000Z" as IsoTimestamp);
    const movedDueAt = rowFor(a)?.dueAt;
    const stillState = snap(b);

    const undo = svc.undoBatch(result.batchId);
    expect(undo.undone).toBe(false);
    expect(undo.reason).toMatch(/changed since this batch/i);
    // NOTHING was clobbered: the moved row keeps its later edit, the other row is untouched.
    expect(rowFor(a)?.dueAt).toBe(movedDueAt);
    expect(snap(b)).toEqual(stillState);
  });

  it("undo-the-undo re-applies coherently (global undo of the restore op)", () => {
    const svc = service();
    const a = seedInboxSource("redo me");
    const result = svc.apply([a], "queueSoon", null, NOW);
    const applied = snap(a);

    const undo = svc.undoBatch(result.batchId);
    expect(undo.undone).toBe(true);
    expect(rowFor(a)?.status).toBe("inbox");

    // The undo itself wrote an inverting (and itself invertible) reschedule op, which is
    // now the newest op. Global undo of it re-applies the original queueSoon effect —
    // undo is undoable / redo-able (T044). This proves the batch is not a dead end.
    const redo = new UndoService(handle.db).undoLast();
    expect(redo.undone).toBe(true);
    expect(snap(a)).toEqual(applied);
  });

  it("a second undoBatch on a now-restored batch refuses cleanly (no double-apply)", () => {
    const svc = service();
    const a = seedInboxSource("once only");
    const result = svc.apply([a], "queueSoon", null, NOW);

    const first = svc.undoBatch(result.batchId);
    expect(first.undone).toBe(true);
    const restored = snap(a);

    // The rows no longer match the batch's post-image, so a repeat undo refuses — it
    // does NOT re-invert the original ops a second time.
    const second = svc.undoBatch(result.batchId);
    expect(second.undone).toBe(false);
    expect(snap(a)).toEqual(restored);
  });

  it("undo refuses when the batchId is unknown", () => {
    const undo = service().undoBatch("no-such-batch");
    expect(undo.undone).toBe(false);
  });
});

describe("InboxBulkTriageService.applySuggestions (T127)", () => {
  it("applies each item's OWN band under one batchId with an accepted marker", () => {
    const a = seedInboxSource("Alpha");
    const b = seedInboxSource("Beta");
    const result = service().applySuggestions([
      { id: a, band: "A", signalKinds: ["authorYield"], signalHash: "h-a" },
      { id: b, band: "B", signalKinds: ["semantic"], signalHash: "h-b" },
    ]);

    expect(result.applied).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(result.errored).toEqual([]);
    expect(rowFor(a)?.priority).toBe(priorityFromLabel("A"));
    expect(rowFor(b)?.priority).toBe(priorityFromLabel("B"));

    // Both ops share the one batchId and carry the accepted-suggestion marker.
    const opA = opsFor(a)
      .filter((o) => o.opType === "update_element")
      .at(-1);
    expect(opA?.payload).toMatchObject({
      batchId: result.batchId,
      triageSuggestion: { decision: "accepted", suggestedBand: "A", finalBand: "A" },
    });
    const opB = opsFor(b)
      .filter((o) => o.opType === "update_element")
      .at(-1);
    expect(opB?.payload).toMatchObject({ batchId: result.batchId });
  });

  it("skips an ineligible (non-inbox) id without aborting the rest", () => {
    const a = seedInboxSource("Alpha");
    const parked = seedInboxSource("Parked");
    new ElementRepository(handle.db).update(parked, { status: "parked", dueAt: null });

    const result = service().applySuggestions([
      { id: a, band: "A", signalKinds: ["authorYield"], signalHash: "h-a" },
      { id: parked, band: "B", signalKinds: ["semantic"], signalHash: "h-b" },
    ]);

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([{ id: parked, reason: "not_inbox" }]);
    expect(rowFor(a)?.priority).toBe(priorityFromLabel("A"));
  });

  it("undo restores the pre-accept priorities", () => {
    const a = seedInboxSource("Alpha", priorityFromLabel("C"));
    const svc = service();
    const result = svc.applySuggestions([
      { id: a, band: "A", signalKinds: ["authorYield"], signalHash: "h-a" },
    ]);
    expect(rowFor(a)?.priority).toBe(priorityFromLabel("A"));

    const undo = svc.undoBatch(result.batchId);
    expect(undo.undone).toBe(true);
    expect(rowFor(a)?.priority).toBe(priorityFromLabel("C"));
  });

  it("an empty item list is a no-op", () => {
    const result = service().applySuggestions([]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toEqual([]);
  });
});

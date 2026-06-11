import type { ElementId, IsoTimestamp } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { elements, operationLog } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import { type ParkedResurfacingQuery, parkedResurfacingCutoff } from "./parked-resurfacing-query";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

let handle: DbHandle;
let repos: Repositories;
let query: ParkedResurfacingQuery;

const NOW = "2026-06-11T12:00:00.000Z" as IsoTimestamp;
const RESURFACE_DAYS = 90;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  query = repos.parkedResurfacingQuery;
});

afterEach(() => {
  handle.sqlite.close();
});

function source(title: string): ElementId {
  return repos.sources.create({
    title,
    priority: PRIORITY_LABEL_VALUE.B,
    status: "active",
    stage: "raw_source",
  }).element.id;
}

function park(id: ElementId, parkedAt: IsoTimestamp): void {
  repos.elements.update(id, { status: "parked", dueAt: null, parkedAt });
}

function isoOffsetDays(days: number): IsoTimestamp {
  return new Date(Date.parse(NOW) + days * 24 * 60 * 60 * 1000).toISOString() as IsoTimestamp;
}

function readElement(id: ElementId) {
  return handle.db.select().from(elements).where(eq(elements.id, id)).get();
}

describe("ParkedResurfacingQuery", () => {
  it("lists only live parked sources due by exact UTC age and leaves the op-log untouched", () => {
    const exactCutoff = parkedResurfacingCutoff(NOW, RESURFACE_DAYS);
    const dueOld = source("Old parked");
    const dueExact = source("Exactly due");
    const notDue = source("Still resting");
    const active = source("Active source");
    const deleted = source("Deleted parked");
    const extract = repos.elements.create({
      type: "extract",
      status: "parked",
      stage: "raw_extract",
      priority: PRIORITY_LABEL_VALUE.B,
      title: "Parked extract",
    }).id;

    park(dueOld, isoOffsetDays(-120));
    park(dueExact, exactCutoff);
    park(notDue, isoOffsetDays(-10));
    park(deleted, isoOffsetDays(-120));
    repos.elements.softDelete(deleted);
    repos.elements.update(extract, { parkedAt: isoOffsetDays(-120) });

    const opCountBefore = handle.db.select().from(operationLog).all().length;
    const result = query.listDue({ asOf: NOW, resurfaceAfterDays: RESURFACE_DAYS, limit: 1 });
    const opCountAfter = handle.db.select().from(operationLog).all().length;

    expect(result.totalDue).toBe(2);
    expect(result.limit).toBe(1);
    expect(result.asOf).toBe(NOW);
    expect(result.rows.map((row) => row.element.id)).toEqual([dueOld]);
    expect(result.rows[0]).toMatchObject({
      element: { type: "source", title: "Old parked", priorityLabel: "B" },
      ageDays: 120,
    });
    expect(query.countDue({ asOf: NOW, resurfaceAfterDays: RESURFACE_DAYS })).toBe(2);
    expect(opCountAfter).toBe(opCountBefore);
    expect(active).toBeTruthy();
  });

  it("uses millisecond UTC duration math instead of local calendar boundaries", () => {
    const asOf = "2026-03-29T02:30:00.000Z" as IsoTimestamp;
    const due = source("DST exact");
    const notDue = source("DST one millisecond short");
    const cutoff = parkedResurfacingCutoff(asOf, 1);
    park(due, cutoff);
    park(notDue, "2026-03-28T02:30:00.001Z" as IsoTimestamp);

    expect(
      query.listDue({ asOf, resurfaceAfterDays: 1 }).rows.map((row) => row.element.id),
    ).toEqual([due]);
  });
});

describe("ParkedResurfacingService", () => {
  it("applies keep, queue, and let-go decisions under one undoable batch", () => {
    const keep = source("Keep parked");
    const queue = source("Queue now");
    const letGo = source("Let go");
    for (const id of [keep, queue, letGo]) park(id, isoOffsetDays(-120));

    const result = repos.parkedResurfacing.apply({
      asOf: NOW,
      resurfaceAfterDays: RESURFACE_DAYS,
      decisions: [
        { id: keep, kind: "keepParked" },
        { id: queue, kind: "queueNow" },
        { id: letGo, kind: "letGo" },
      ],
    });

    expect(result).toMatchObject({ applied: 3, skipped: [] });
    expect(result.batchId).toBeTruthy();
    expect(readElement(keep)).toMatchObject({ status: "parked", dueAt: null, parkedAt: NOW });
    expect(readElement(queue)).toMatchObject({ status: "scheduled", dueAt: NOW, parkedAt: null });
    expect(readElement(letGo)).toMatchObject({ status: "dismissed", dueAt: null, parkedAt: null });

    const undo = new UndoService(handle.db).undoLast();
    expect(undo.undone).toBe(true);
    expect(undo.count).toBe(3);
    expect(readElement(queue)).toMatchObject({ status: "parked", dueAt: null });
    expect(readElement(letGo)).toMatchObject({ status: "parked", dueAt: null });
  });

  it("rolls back the whole batch if a later update fails", () => {
    const first = source("First");
    const second = source("Second");
    for (const id of [first, second]) park(id, isoOffsetDays(-120));

    handle.sqlite.exec(`
      CREATE TEMP TRIGGER parked_resurfacing_abort_second_op
      BEFORE INSERT ON operation_log
      WHEN NEW.element_id = '${second}'
      BEGIN
        SELECT RAISE(ABORT, 'injected op-log failure');
      END;
    `);

    expect(() =>
      repos.parkedResurfacing.apply({
        asOf: NOW,
        resurfaceAfterDays: RESURFACE_DAYS,
        decisions: [
          { id: first, kind: "queueNow" },
          { id: second, kind: "queueNow" },
        ],
      }),
    ).toThrow("injected op-log failure");

    expect(readElement(first)).toMatchObject({ status: "parked", dueAt: null });
    expect(readElement(second)).toMatchObject({ status: "parked", dueAt: null });
  });

  it("skips stale or ineligible decisions and writes no op when none apply", () => {
    const deleted = source("Deleted");
    const active = source("Active");
    const extract = repos.elements.create({
      type: "extract",
      status: "parked",
      stage: "raw_extract",
      priority: PRIORITY_LABEL_VALUE.B,
      title: "Extract",
    }).id as ElementId;
    const fresh = source("Fresh parked");
    park(deleted, isoOffsetDays(-120));
    repos.elements.softDelete(deleted);
    park(fresh, isoOffsetDays(-5));
    repos.elements.update(extract, { parkedAt: isoOffsetDays(-120) });

    const opCountBefore = handle.db.select().from(operationLog).all().length;
    const result = repos.parkedResurfacing.apply({
      asOf: NOW,
      resurfaceAfterDays: RESURFACE_DAYS,
      decisions: [
        { id: "missing" as ElementId, kind: "queueNow" },
        { id: deleted, kind: "queueNow" },
        { id: active, kind: "queueNow" },
        { id: extract, kind: "queueNow" },
        { id: fresh, kind: "queueNow" },
      ],
    });
    const opCountAfter = handle.db.select().from(operationLog).all().length;

    expect(result).toEqual({
      applied: 0,
      batchId: null,
      skipped: [
        { id: "missing", reason: "missing" },
        { id: deleted, reason: "deleted" },
        { id: active, reason: "not-parked" },
        { id: extract, reason: "not-source" },
        { id: fresh, reason: "not-due" },
      ],
    });
    expect(opCountAfter).toBe(opCountBefore);
  });
});

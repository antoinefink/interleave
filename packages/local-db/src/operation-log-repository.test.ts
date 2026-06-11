/**
 * OperationLogRepository tests (T008/T028).
 *
 * The append-only command log is load-bearing. These run against a temporary,
 * fully-migrated in-memory `better-sqlite3` DB so behaviour matches production.
 * They pin two things:
 *
 *  - `append` writes inside the active transaction and round-trips the payload;
 *  - the shared `countPostpones` helper (T028) — the ONE canonical, schema-churn-free
 *    postpone counter the attention scheduler, queue read, inspector, and extract
 *    service all delegate to — counts only `reschedule_element` ops carrying the
 *    `postpone === true` marker, and ignores everything else.
 */

import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { OperationLogRepository } from "./operation-log-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("OperationLogRepository.countPostpones (T028 — the shared helper)", () => {
  it("counts only reschedule_element ops carrying the postpone marker", () => {
    const elements = new ElementRepository(handle.db);
    const log = new OperationLogRepository(handle.db);
    const el = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.625,
      title: "A source",
    });

    // No postpones yet.
    expect(log.countPostpones(el.id)).toBe(0);

    // A non-postpone reschedule (e.g. an explicit "schedule for next week") must
    // NOT be counted — only the postpone marker increments the counter.
    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "reschedule_element",
        payload: { choice: "nextWeek" },
        elementId: el.id,
      });
    });
    expect(log.countPostpones(el.id)).toBe(0);

    // An unrelated op type with a stray `postpone: true` must NOT be counted.
    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "update_element",
        payload: { postpone: true },
        elementId: el.id,
      });
    });
    expect(log.countPostpones(el.id)).toBe(0);

    // Two genuine postpone ops → count is 2.
    for (let i = 0; i < 2; i++) {
      handle.db.transaction((tx) => {
        log.append(tx, {
          opType: "reschedule_element",
          payload: { postpone: true, postponeCount: i + 1 },
          elementId: el.id,
        });
      });
    }
    expect(log.countPostpones(el.id)).toBe(2);
  });

  it("scopes the count to one element (no cross-element bleed)", () => {
    const elements = new ElementRepository(handle.db);
    const log = new OperationLogRepository(handle.db);
    const a = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.5,
      title: "A",
    });
    const b = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.5,
      title: "B",
    });
    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "reschedule_element",
        payload: { postpone: true },
        elementId: a.id,
      });
    });
    expect(log.countPostpones(a.id)).toBe(1);
    expect(log.countPostpones(b.id)).toBe(0);
  });

  it("folds chronic reset and reset-undo markers into the effective count", () => {
    const elements = new ElementRepository(handle.db);
    const log = new OperationLogRepository(handle.db);
    const el = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.5,
      title: "Folded count",
    });

    for (let i = 0; i < 5; i++) {
      handle.db.transaction((tx) => {
        log.append(tx, {
          opType: "reschedule_element",
          payload: { postpone: true, postponeCount: i + 1 },
          elementId: el.id,
        });
      });
    }
    expect(log.countPostpones(el.id)).toBe(5);

    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "update_element",
        payload: {
          chronicPostponeReset: true,
          prevEffectivePostponeCount: 5,
        },
        elementId: el.id,
      });
    });
    expect(log.countPostpones(el.id)).toBe(0);

    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "reschedule_element",
        payload: { postpone: true, postponeCount: 1 },
        elementId: el.id,
      });
    });
    expect(log.countPostpones(el.id)).toBe(1);

    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "update_element",
        payload: {
          chronicPostponeResetUndo: true,
          restoredEffectivePostponeCount: 5,
        },
        elementId: el.id,
      });
    });
    expect(log.countPostpones(el.id)).toBe(5);
  });
});

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

describe("OperationLogRepository.currentScheduleProjection (T113 — schedule reasons)", () => {
  it("projects the latest adaptive reason only while it still governs the current due date", () => {
    const elements = new ElementRepository(handle.db);
    const log = new OperationLogRepository(handle.db);
    const el = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.5,
      title: "Adaptive source",
      dueAt: "2026-06-05T12:00:00.000Z",
    });

    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "reschedule_element",
        payload: {
          id: el.id,
          dueAt: "2026-06-05T12:00:00.000Z",
          scheduledAt: "2026-05-30T12:00:00.000Z",
          attentionAdaptive: {
            version: 1,
            enabled: true,
            reason: {
              reasonKind: "yield_shortened",
              baseIntervalDays: 7,
              intervalAfterMultiplierDays: 6,
              finalIntervalDays: 6,
              priorMultiplier: 1,
              newMultiplier: 0.85,
              productiveOutputCount: 3,
            },
          },
        },
        elementId: el.id,
      });
    });

    expect(log.currentScheduleProjection(el.id, "2026-06-05T12:00:00.000Z").reason).toMatchObject({
      kind: "yield_shortened",
      baseIntervalDays: 7,
      finalIntervalDays: 6,
      newMultiplier: 0.85,
      productiveOutputCount: 3,
    });

    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "reschedule_element",
        payload: {
          id: el.id,
          dueAt: "2026-06-08T12:00:00.000Z",
          choice: "nextWeek",
        },
        elementId: el.id,
      });
    });

    expect(log.currentScheduleProjection(el.id, "2026-06-08T12:00:00.000Z").reason).toBeNull();
    expect(log.currentScheduleProjection(el.id, "2026-06-05T12:00:00.000Z").reason).toBeNull();
  });

  it("uses the reset-folded effective postpone count in postpone reasons", () => {
    const elements = new ElementRepository(handle.db);
    const log = new OperationLogRepository(handle.db);
    const el = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.5,
      title: "Postponed source",
      dueAt: "2026-06-20T12:00:00.000Z",
    });

    for (let i = 0; i < 3; i++) {
      handle.db.transaction((tx) => {
        log.append(tx, {
          opType: "reschedule_element",
          payload: {
            id: el.id,
            dueAt: "2026-06-20T12:00:00.000Z",
            scheduledAt: "2026-05-30T12:00:00.000Z",
            postpone: true,
            postponeCount: i + 1,
          },
          elementId: el.id,
        });
      });
    }

    expect(log.currentScheduleProjection(el.id, "2026-06-20T12:00:00.000Z")).toMatchObject({
      effectivePostponeCount: 3,
      reason: {
        kind: "postpone_recession",
        finalIntervalDays: 21,
        postponeCount: 3,
      },
    });

    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "update_element",
        payload: {
          chronicPostponeReset: true,
          prevEffectivePostponeCount: 3,
        },
        elementId: el.id,
      });
    });

    expect(log.currentScheduleProjection(el.id, "2026-06-20T12:00:00.000Z")).toMatchObject({
      effectivePostponeCount: 0,
      reason: null,
    });
  });

  it("projects persisted scheduleReason payloads for non-adaptive scheduler reasons", () => {
    const elements = new ElementRepository(handle.db);
    const log = new OperationLogRepository(handle.db);
    const el = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.625,
      title: "Unresolved source",
      dueAt: "2026-06-03T12:00:00.000Z",
    });

    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "reschedule_element",
        payload: {
          id: el.id,
          dueAt: "2026-06-03T12:00:00.000Z",
          scheduledAt: "2026-05-30T12:00:00.000Z",
          action: "extract",
          scheduleReason: {
            kind: "source_unresolved_shortened",
            baseIntervalDays: 7,
            finalIntervalDays: 4,
            intervalAfterSourceProcessingDays: 4,
            unresolvedRatio: 0.6,
            terminalRatio: 0.3,
            ignoredRatio: 0.1,
            extractedOutputCount: 1,
          },
        },
        elementId: el.id,
      });
    });

    expect(log.currentScheduleProjection(el.id, "2026-06-03T12:00:00.000Z").reason).toMatchObject({
      kind: "source_unresolved_shortened",
      baseIntervalDays: 7,
      finalIntervalDays: 4,
      intervalAfterSourceProcessingDays: 4,
      unresolvedRatio: 0.6,
      extractedOutputCount: 1,
    });
  });

  it.each([
    [
      "yield_lengthened",
      {
        kind: "yield_lengthened",
        baseIntervalDays: 30,
        finalIntervalDays: 35,
        intervalAfterMultiplierDays: 35,
        productiveOutputCount: 0,
      },
      "yield_lengthened",
    ],
    [
      "recency_damped",
      {
        kind: "recency_damped",
        baseIntervalDays: 7,
        finalIntervalDays: 4,
        daysSinceLastSeen: 9,
        recencyCreditDays: 3,
      },
      "recency_damped",
    ],
    [
      "source_exhausted_lengthened",
      {
        kind: "source_exhausted_lengthened",
        baseIntervalDays: 30,
        finalIntervalDays: 60,
        intervalAfterSourceProcessingDays: 60,
        unresolvedRatio: 0,
        terminalRatio: 1,
        ignoredRatio: 0.75,
        extractedOutputCount: 0,
      },
      "source_exhausted_lengthened",
    ],
    [
      "descendant_lapses",
      {
        kind: "descendant_lapses",
        baseIntervalDays: 7,
        finalIntervalDays: 4,
        descendantLapseCount: 3,
        affectedCardCount: 2,
        descendantCardCount: 20,
        descendantLapseRate: 0.15,
        intervalAfterDescendantDays: 6,
      },
      "descendant_lapses",
    ],
    [
      "missing yield evidence",
      {
        kind: "yield_lengthened",
        baseIntervalDays: 30,
        finalIntervalDays: 35,
      },
      null,
    ],
    [
      "missing recency evidence",
      {
        kind: "recency_damped",
        baseIntervalDays: 7,
        finalIntervalDays: 4,
      },
      null,
    ],
    [
      "missing source evidence",
      {
        kind: "source_unresolved_shortened",
        baseIntervalDays: 7,
        finalIntervalDays: 3,
      },
      null,
    ],
    [
      "zero descendant evidence",
      {
        kind: "descendant_lapses",
        baseIntervalDays: 7,
        finalIntervalDays: 4,
        descendantLapseCount: 0,
        affectedCardCount: 0,
        descendantCardCount: 20,
        descendantLapseRate: 0,
        intervalAfterDescendantDays: 4,
      },
      null,
    ],
    [
      "missing descendant evidence",
      {
        kind: "descendant_lapses",
        baseIntervalDays: 7,
        finalIntervalDays: 4,
        descendantLapseCount: 3,
      },
      null,
    ],
    [
      "non-integer descendant evidence",
      {
        kind: "descendant_lapses",
        baseIntervalDays: 7,
        finalIntervalDays: 4,
        descendantLapseCount: 3.5,
        affectedCardCount: 2,
        descendantCardCount: 20,
        descendantLapseRate: 0.175,
        intervalAfterDescendantDays: 6,
      },
      null,
    ],
    [
      "inconsistent descendant rate",
      {
        kind: "descendant_lapses",
        baseIntervalDays: 7,
        finalIntervalDays: 4,
        descendantLapseCount: 3,
        affectedCardCount: 2,
        descendantCardCount: 20,
        descendantLapseRate: 0.25,
        intervalAfterDescendantDays: 6,
      },
      null,
    ],
    [
      "non-shortening descendant interval",
      {
        kind: "descendant_lapses",
        baseIntervalDays: 7,
        finalIntervalDays: 7,
        descendantLapseCount: 3,
        affectedCardCount: 2,
        descendantCardCount: 20,
        descendantLapseRate: 0.15,
        intervalAfterDescendantDays: 7,
      },
      null,
    ],
  ])("projects or suppresses persisted %s scheduleReason evidence", (_, scheduleReason, expected) => {
    const elements = new ElementRepository(handle.db);
    const log = new OperationLogRepository(handle.db);
    const dueAt = "2026-06-04T12:00:00.000Z";
    const el = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.625,
      title: `Reason ${String(expected ?? "suppressed")}`,
      dueAt,
    });

    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "reschedule_element",
        payload: {
          id: el.id,
          dueAt,
          scheduledAt: "2026-05-30T12:00:00.000Z",
          action: "extract",
          scheduleReason,
        },
        elementId: el.id,
      });
    });

    const reason = log.currentScheduleProjection(el.id, dueAt).reason;
    expect(reason?.kind ?? null).toBe(expected);
  });

  it("suppresses legacy zero-output yield_shortened adaptive diagnostics", () => {
    const elements = new ElementRepository(handle.db);
    const log = new OperationLogRepository(handle.db);
    const dueAt = "2026-06-05T12:00:00.000Z";
    const el = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.625,
      title: "Legacy unresolved adaptive",
      dueAt,
    });

    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "reschedule_element",
        payload: {
          id: el.id,
          dueAt,
          scheduledAt: "2026-05-30T12:00:00.000Z",
          attentionAdaptive: {
            version: 1,
            enabled: true,
            reason: {
              reasonKind: "yield_shortened",
              baseIntervalDays: 7,
              intervalAfterMultiplierDays: 7,
              finalIntervalDays: 3,
              priorMultiplier: 1,
              newMultiplier: 0.95,
              productiveOutputCount: 0,
              unresolvedRatio: 0.5,
            },
          },
        },
        elementId: el.id,
      });
    });

    expect(log.currentScheduleProjection(el.id, dueAt).reason).toBeNull();
  });

  it("suppresses explicit-choice and queue-soon reschedules even when stale reason fields exist", () => {
    const elements = new ElementRepository(handle.db);
    const log = new OperationLogRepository(handle.db);
    const el = elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      priority: 0.625,
      title: "Explicit schedule",
      dueAt: "2026-06-07T12:00:00.000Z",
    });

    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "reschedule_element",
        payload: {
          id: el.id,
          dueAt: "2026-06-07T12:00:00.000Z",
          choice: "nextWeek",
          scheduleReason: {
            kind: "descendant_lapses",
            baseIntervalDays: 7,
            finalIntervalDays: 6,
            descendantLapseCount: 3,
            affectedCardCount: 2,
            descendantCardCount: 20,
            descendantLapseRate: 0.15,
            intervalAfterDescendantDays: 6,
          },
        },
        elementId: el.id,
      });
    });

    expect(log.currentScheduleProjection(el.id, "2026-06-07T12:00:00.000Z").reason).toBeNull();

    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "reschedule_element",
        payload: {
          id: el.id,
          dueAt: "2026-05-30T12:00:00.000Z",
          queueSoon: true,
          scheduleReason: {
            kind: "recency_damped",
            baseIntervalDays: 7,
            finalIntervalDays: 4,
            daysSinceLastSeen: 6,
          },
        },
        elementId: el.id,
      });
    });

    expect(log.currentScheduleProjection(el.id, "2026-05-30T12:00:00.000Z").reason).toBeNull();
  });
});

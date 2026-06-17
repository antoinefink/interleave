import type { BlockId, ElementId, IsoTimestamp, Priority } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { elements, operationLog } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXTRACT_AGING_POLICY_STATE_KEY,
  EXTRACT_AGING_SWEEP_LIMIT,
  ExtractAgingPolicyService,
} from "./extract-aging-policy-service";
import { ExtractService } from "./extract-service";
import { createRepositories } from "./index";
import { OperationLogRepository } from "./operation-log-repository";
import { SourceRepository } from "./source-repository";
import { SynthesisService } from "./synthesis-service";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

let handle: DbHandle;

const NOW = "2026-06-12T09:00:00.000Z" as IsoTimestamp;
const FAR_FUTURE = "2026-08-15T09:00:00.000Z" as IsoTimestamp;
const OVERDUE = "2026-06-01T09:00:00.000Z" as IsoTimestamp;
// The deterministic "created long ago" anchor for seeded extracts. `daysSinceProgress`
// is measured from the last stage advance or, absent one, `createdAt` — which the
// repository stamps with the REAL wall clock at insert. Pinning it here keeps the age
// band stable as real time approaches the fixed `FAR_FUTURE` clock; without it the band
// silently drifts (graveyard → stale) once "now" is within 2×ageDays of FAR_FUTURE.
const CREATED = "2026-04-01T09:00:00.000Z" as IsoTimestamp;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

function repos() {
  return createRepositories(handle.db);
}

function service(clock: IsoTimestamp = FAR_FUTURE): ExtractAgingPolicyService {
  return new ExtractAgingPolicyService(handle.db, repos(), () => clock);
}

function configure(policy: "off" | "suggest" | "automatic" = "suggest"): void {
  repos().settings.updateAppSettings({
    extractAgingPolicy: policy,
    extractAgingReturnThreshold: 5,
    extractAgingAgeDays: 30,
  });
}

function seedExtract(
  title: string,
  opts: {
    readonly stage?: "raw_extract" | "clean_extract" | "atomic_statement";
    readonly priority?: Priority;
    readonly parentId?: ElementId;
  } = {},
): ElementId {
  const r = repos();
  const { element: source } = r.sources.create({
    title: `${title} source`,
    priority: opts.priority ?? (0.625 as Priority),
    status: "active",
    stage: "raw_source",
  });
  const extract = new SourceRepository(handle.db).createExtract({
    sourceElementId: source.id,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    title,
    priority: opts.priority ?? (0.625 as Priority),
    selectedText: "Selected text",
    blockIds: ["block-1" as BlockId],
    label: "p1",
    stage: opts.stage ?? "raw_extract",
  });
  r.elements.update(extract.element.id, {
    status: "active",
    stage: opts.stage ?? "raw_extract",
  });
  r.elements.reschedule(extract.element.id, OVERDUE);
  // Pin the createdAt progress anchor to a fixed past instant (see CREATED) so the
  // computed age band is deterministic rather than wall-clock dependent.
  handle.db
    .update(elements)
    .set({ createdAt: CREATED })
    .where(eq(elements.id, extract.element.id))
    .run();
  return extract.element.id;
}

function postponeMarkers(id: ElementId, count = 5): void {
  handle.db.transaction((tx) => {
    const log = new OperationLogRepository(tx);
    for (let i = 0; i < count; i += 1) {
      log.append(tx, {
        opType: "reschedule_element",
        elementId: id,
        payload: { postpone: true, postponeCount: i + 1 },
      });
    }
  });
}

function eligibleExtract(title = "graveyard"): ElementId {
  const id = seedExtract(title);
  postponeMarkers(id);
  return id;
}

function batchPayloads(batchId: string): Record<string, unknown>[] {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.opType, "update_element"))
    .all()
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
    .filter((payload) => payload.batchId === batchId);
}

describe("ExtractAgingPolicyService", () => {
  it("previews only due stagnant non-terminal extracts and includes age bands", () => {
    configure("suggest");
    const eligible = eligibleExtract("eligible");
    const fated = eligibleExtract("reference");
    new ExtractService(handle.db).setFate(fated, "reference");
    const atomic = seedExtract("atomic", { stage: "atomic_statement" });
    postponeMarkers(atomic);
    const parent = eligibleExtract("parent");
    seedExtract("child", { parentId: parent });
    const synthesized = eligibleExtract("synthesized");
    const synthesis = new SynthesisService(handle.db).create({ title: "Synthesis" }).element;
    new SynthesisService(handle.db).linkElement(synthesis.id, synthesized);

    const preview = service().preview();

    expect(preview.candidates.map((row) => row.id)).toEqual([eligible]);
    expect(preview.candidates[0]?.age).toMatchObject({
      band: "graveyard",
      postponeCount: 5,
      thresholdReached: true,
    });
  });

  it("applies one reference batch with origin metadata and can undo the receipt", () => {
    configure("suggest");
    const first = eligibleExtract("first");
    const second = eligibleExtract("second");

    const result = service().applyPreview({ ids: [first, second] });

    expect(result.demoted).toBe(2);
    expect(result.receipt).toMatchObject({
      status: "actionable",
      policy: "suggest",
      demoted: 2,
      localDay: "2026-08-15",
    });
    expect(batchPayloads(result.batchId)).toHaveLength(2);
    expect(batchPayloads(result.batchId)[0]).toMatchObject({
      extractAgingOrigin: { kind: "extractAgingPolicy", policy: "suggest" },
    });
    expect(repos().elements.findById(first)?.extractFate).toBe("reference");

    const undo = service().undoReceipt(result.batchId);
    expect(undo.undo.undone).toBe(true);
    expect(undo.receipt?.status).toBe("undone");
    expect(repos().elements.findById(first)?.extractFate).toBeNull();
    expect(repos().elements.findById(second)?.extractFate).toBeNull();
  });

  it("does not let global undo partially redo a receipt restore batch", () => {
    configure("suggest");
    const first = eligibleExtract("receipt restore first");
    const second = eligibleExtract("receipt restore second");
    const result = service().applyPreview({ ids: [first, second] });

    const receiptUndo = service().undoReceipt(result.batchId);
    const globalUndo = new UndoService(handle.db).undoLast();

    expect(receiptUndo.undo.undone).toBe(true);
    expect(globalUndo.undone).toBe(false);
    expect(globalUndo.reason).toBe(`Can't undo "update_element"`);
    expect(repos().elements.findById(first)?.extractFate).toBeNull();
    expect(repos().elements.findById(second)?.extractFate).toBeNull();
    expect(service().receiptsForToday()[0]?.status).toBe("undone");
  });

  it("reports explicit skip reasons for selected ids that became stale before apply", () => {
    configure("suggest");
    const kept = eligibleExtract("kept");
    const parent = eligibleExtract("parent-stale");
    seedExtract("child-stale", { parentId: parent });
    const fated = eligibleExtract("fated-stale");
    new ExtractService(handle.db).setFate(fated, "reference");
    const future = eligibleExtract("future-stale");
    repos().elements.reschedule(future, "2026-09-01T09:00:00.000Z" as IsoTimestamp);

    const result = service().applyPreview({
      ids: [kept, parent, fated, future, "missing-extract" as ElementId],
    });

    expect(result.demoted).toBe(1);
    expect(result.receipt?.skipped).toBe(4);
    expect(Object.fromEntries(result.skipped.map((skip) => [skip.id, skip.reason]))).toEqual({
      [parent]: "has-children",
      [fated]: "terminal-fate",
      [future]: "not-due",
      "missing-extract": "not-found",
    });
  });

  it("refuses receipt undo when a demoted row no longer matches the aging reference state", () => {
    configure("suggest");
    const id = eligibleExtract("conflict");
    const result = service().applyPreview({ ids: [id] });
    new ExtractService(handle.db).reactivateFate(id);

    const undo = service().undoReceipt(result.batchId);

    expect(undo.undo.undone).toBe(false);
    expect(undo.undo.reason).toBe("Batch no longer matches current reference state");
    expect(undo.receipt?.status).toBe("actionable");
  });

  it("materializes automatic aging once per local day and records a state receipt", () => {
    configure("automatic");
    eligibleExtract("automatic");

    const first = service(FAR_FUTURE).materializeToday();
    const second = service(FAR_FUTURE).materializeToday();

    expect(first.evaluated).toBe(true);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(true);
    expect(second.receipt?.batchId).toBe(first.receipt?.batchId);
    const state = repos().settings.get<Record<string, unknown>>(EXTRACT_AGING_POLICY_STATE_KEY);
    expect(state).toMatchObject({ version: 1 });
  });

  it("keeps manual same-day sweeps as separate undoable receipts and honors the sweep limit", () => {
    configure("suggest");
    const ids = Array.from({ length: EXTRACT_AGING_SWEEP_LIMIT + 1 }, (_, i) =>
      eligibleExtract(`candidate ${i}`),
    );

    const preview = service().preview();
    const first = service().applyPreview({ ids: [ids[0] as ElementId] });
    const second = service().applyPreview({ ids: [ids[1] as ElementId] });

    expect(preview.candidates).toHaveLength(EXTRACT_AGING_SWEEP_LIMIT);
    expect(preview.remainingCandidateCount).toBe(1);
    expect(
      service()
        .receiptsForToday()
        .map((receipt) => receipt.batchId),
    ).toEqual([first.batchId, second.batchId]);
  });

  it("does not preview or mutate when the policy is off", () => {
    configure("off");
    eligibleExtract("off");

    expect(service().preview().candidates).toEqual([]);
    expect(service().applyPreview().demoted).toBe(0);
    expect(service(NOW).materializeToday().evaluated).toBe(false);
  });

  it("treats malformed persisted receipt state as empty instead of crashing", () => {
    configure("automatic");
    repos().settings.setMany({
      [EXTRACT_AGING_POLICY_STATE_KEY]: {
        version: 1,
        automaticDays: null,
        receiptsByBatchId: [],
        batchIdsByLocalDay: {},
      },
    });

    expect(() => service(FAR_FUTURE).materializeToday()).not.toThrow();
    expect(service(FAR_FUTURE).receiptsForToday()).toEqual([]);
  });
});

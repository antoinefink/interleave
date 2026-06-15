import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import {
  cards,
  elementRelations,
  elements,
  operationLog,
  rereadProposalDismissals,
  reviewLogs,
  sourceLocations,
  tasks,
} from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { newReviewLogId, newSourceLocationId } from "./ids";
import { RereadProposalService, rereadClusterStateHash } from "./reread-proposal-service";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

const AS_OF = "2026-06-12T12:00:00.000Z" as IsoTimestamp;
const PRIORITY = 0.5;
const THRESHOLDS = { minLapses: 5, windowDays: 30, minCards: 2 } as const;

function service(): RereadProposalService {
  return new RereadProposalService(handle.db);
}

function listInput(over: Partial<{ sourceId: ElementId; cap: number; enabled: boolean }> = {}) {
  return {
    asOf: AS_OF,
    enabled: over.enabled ?? true,
    thresholds: THRESHOLDS,
    cap: over.cap ?? 2,
    ...(over.sourceId ? { sourceId: over.sourceId } : {}),
  };
}

function daysAgo(days: number): IsoTimestamp {
  return new Date(Date.parse(AS_OF) - days * 86_400_000).toISOString() as IsoTimestamp;
}

function seedSource(title: string): ElementId {
  return new ElementRepository(handle.db).create({
    type: "source",
    status: "active",
    stage: "raw_source",
    priority: PRIORITY,
    title,
  }).id;
}

function seedExtract(options: {
  parentId: ElementId;
  sourceId: ElementId;
  anchorInto: ElementId;
  blockIds?: string[];
  label?: string | null;
}): ElementId {
  const repo = new ElementRepository(handle.db);
  const extract = repo.create({
    type: "extract",
    status: "active",
    stage: "raw_extract",
    priority: PRIORITY,
    title: "Extract",
    parentId: options.parentId,
    sourceId: options.sourceId,
  });
  handle.db
    .insert(sourceLocations)
    .values({
      id: newSourceLocationId(),
      elementId: extract.id,
      sourceElementId: options.anchorInto,
      blockIds: JSON.stringify(options.blockIds ?? ["blk-1"]),
      label: options.label === undefined ? "Chapter 2 · ¶4" : options.label,
      selectedText: "selected text",
    })
    .run();
  return extract.id;
}

function seedCard(options: {
  parentId: ElementId;
  sourceId: ElementId | null;
  status?: "active" | "scheduled" | "suspended";
  retired?: boolean;
  prompt?: string;
}): ElementId {
  const repo = new ElementRepository(handle.db);
  const card = repo.create({
    type: "card",
    status: options.status ?? "active",
    stage: "active_card",
    priority: PRIORITY,
    title: "Card",
    parentId: options.parentId,
    ...(options.sourceId ? { sourceId: options.sourceId } : {}),
  });
  handle.db
    .insert(cards)
    .values({
      elementId: card.id,
      kind: "qa",
      prompt: options.prompt ?? "Prompt",
      isRetired: options.retired ?? false,
    })
    .run();
  return card.id;
}

/** Append `n` consecutive true lapse increments to a card, starting from `fromLapses`. */
function seedLapses(cardId: ElementId, n: number, fromLapses = 0): void {
  for (let i = 0; i < n; i += 1) {
    handle.db
      .insert(reviewLogs)
      .values({
        id: newReviewLogId(),
        elementId: cardId,
        rating: "again",
        reviewedAt: daysAgo(2),
        responseMs: 1000,
        prevState: "review",
        nextState: "relearning",
        nextStability: 1,
        nextDifficulty: 5,
        nextDueAt: daysAgo(2),
        prevLapses: fromLapses + i,
        nextLapses: fromLapses + i + 1,
      })
      .run();
  }
}

/** Seed a full cluster: an anchored extract + `cardCount` cards, each with `lapsesPerCard`. */
function seedCluster(
  source: ElementId,
  options: { cardCount: number; lapsesPerCard: number; label?: string },
): { extract: ElementId; cardIds: ElementId[] } {
  const extract = seedExtract({
    parentId: source,
    sourceId: source,
    anchorInto: source,
    ...(options.label ? { label: options.label } : {}),
  });
  const cardIds: ElementId[] = [];
  for (let i = 0; i < options.cardCount; i += 1) {
    const card = seedCard({ parentId: extract, sourceId: source, prompt: `card-${i}` });
    seedLapses(card, options.lapsesPerCard);
    cardIds.push(card);
  }
  return { extract, cardIds };
}

function allTableRowCounts(): Record<string, number> {
  const names = handle.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  const counts: Record<string, number> = {};
  for (const { name } of names) {
    counts[name] = (
      handle.sqlite.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }
    ).n;
  }
  return counts;
}

function reviewSnapshot(): string {
  const logs = handle.sqlite.prepare("SELECT * FROM review_logs ORDER BY id").all();
  const states = handle.sqlite.prepare("SELECT * FROM review_states ORDER BY element_id").all();
  const cardRows = handle.sqlite.prepare("SELECT * FROM cards ORDER BY element_id").all();
  return JSON.stringify({ logs, states, cardRows });
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("RereadProposalService.listProposals", () => {
  it("surfaces one proposal naming the region, members, and a stable state-hash", () => {
    const source = seedSource("Source");
    const { extract } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 }); // total 6 >= 5

    const proposals = service().listProposals(listInput());
    expect(proposals).toHaveLength(1);
    const [p] = proposals;
    if (!p) throw new Error("expected one proposal");
    expect(p.ancestorId).toBe(extract);
    expect(p.region.label).toBe("Chapter 2 · ¶4");
    expect(p.affectedCardCount).toBe(3);
    expect(p.totalWindowLapses).toBe(6);
    expect(p.dismissable).toBe(true);
    expect(p.stateHash).toBe(rereadClusterStateHash(p, THRESHOLDS));
  });

  it("returns [] when the feature is disabled", () => {
    const source = seedSource("Source");
    seedCluster(source, { cardCount: 3, lapsesPerCard: 2 });
    expect(service().listProposals(listInput({ enabled: false }))).toEqual([]);
  });

  it("caps the surfaced set; accepting one does NOT reduce the others (no accept budget)", () => {
    const source = seedSource("Source");
    seedCluster(source, { cardCount: 3, lapsesPerCard: 3, label: "A" }); // total 9
    seedCluster(source, { cardCount: 3, lapsesPerCard: 2, label: "B" }); // total 6
    seedCluster(source, { cardCount: 2, lapsesPerCard: 3, label: "C" }); // total 6, 2 cards

    const svc = service();
    const first = svc.listProposals(listInput({ cap: 2 }));
    expect(first).toHaveLength(2);

    // Accept the strongest shown — a different eligible cluster fills its slot (still 2).
    const accepted = first[0];
    if (!accepted) throw new Error("expected a proposal");
    svc.accept({ ancestorId: accepted.ancestorId, asOf: AS_OF, thresholds: THRESHOLDS });
    const second = svc.listProposals(listInput({ cap: 2 }));
    expect(second).toHaveLength(2);
    expect(second.map((p) => p.ancestorId)).not.toContain(accepted.ancestorId);
  });

  it("suppresses a dismissed proposal until the cluster MATERIALLY worsens", () => {
    const source = seedSource("Source");
    const { extract, cardIds } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 }); // 6, band1
    const svc = service();

    const [p] = svc.listProposals(listInput());
    if (!p) throw new Error("expected proposal");
    expect(
      svc.dismiss({
        ancestorId: extract,
        stateHash: p.stateHash,
        asOf: AS_OF,
        thresholds: THRESHOLDS,
      }),
    ).toEqual({ dismissed: true, stale: false });
    expect(svc.listProposals(listInput())).toHaveLength(0);

    // Sub-band worsening (total 6 -> 7, still floor(./5) === 1) stays suppressed.
    seedLapses(cardIds[0] as ElementId, 1, 2);
    expect(svc.listProposals(listInput())).toHaveLength(0);

    // Band step (total -> 10, floor === 2): the hash changes, the proposal reappears.
    seedLapses(cardIds[1] as ElementId, 1, 2);
    seedLapses(cardIds[2] as ElementId, 1, 2);
    seedLapses(cardIds[0] as ElementId, 1, 3);
    expect(svc.listProposals(listInput())).toHaveLength(1);
  });

  it("reappears when a NEW member card joins the cluster (affectedCardCount changes)", () => {
    const source = seedSource("Source");
    const { extract } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 });
    const svc = service();
    const [p] = svc.listProposals(listInput());
    if (!p) throw new Error("expected proposal");
    svc.dismiss({
      ancestorId: extract,
      stateHash: p.stateHash,
      asOf: AS_OF,
      thresholds: THRESHOLDS,
    });
    expect(svc.listProposals(listInput())).toHaveLength(0);

    const newCard = seedCard({ parentId: extract, sourceId: source, prompt: "new" });
    seedLapses(newCard, 2);
    expect(svc.listProposals(listInput())).toHaveLength(1);
  });

  it("stays suppressed when a dismissed cluster IMPROVES (fewer cards, still over the floor)", () => {
    const source = seedSource("Source");
    // 3 cards x 3 lapses = 9 (band 1); retiring one leaves 2 cards x 3 = 6, still >= K=5.
    const { extract, cardIds } = seedCluster(source, { cardCount: 3, lapsesPerCard: 3 });
    const svc = service();
    const [p] = svc.listProposals(listInput());
    if (!p) throw new Error("expected proposal");
    svc.dismiss({
      ancestorId: extract,
      stateHash: p.stateHash,
      asOf: AS_OF,
      thresholds: THRESHOLDS,
    });
    expect(svc.listProposals(listInput())).toHaveLength(0);

    // Improvement: a card recovers (retired) → cluster shrinks to 2 cards / band 1. The hash
    // changes (cards3 -> cards2) but the cluster is NOT materially worse, so it stays suppressed.
    handle.db
      .update(cards)
      .set({ isRetired: true })
      .where(eq(cards.elementId, cardIds[0] as ElementId))
      .run();
    expect(svc.listProposals(listInput())).toHaveLength(0);
  });

  it("suppresses while an open re-read exists and during the grace window after completion", () => {
    const source = seedSource("Source");
    const { extract } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 });
    const svc = service();

    const accepted = svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS });
    expect(accepted.created).toBe(true);
    expect(svc.listProposals(listInput())).toHaveLength(0); // open -> suppressed

    // Complete the task (status done, element updated now) -> suppressed in grace window.
    const taskId = accepted.taskElementId as ElementId;
    handle.db.update(tasks).set({ status: "done" }).where(eq(tasks.elementId, taskId)).run();
    handle.db.update(elements).set({ updatedAt: AS_OF }).where(eq(elements.id, taskId)).run();
    expect(svc.listProposals(listInput())).toHaveLength(0);

    // Completed beyond the grace window -> eligible again.
    handle.db
      .update(elements)
      .set({ updatedAt: daysAgo(40) })
      .where(eq(elements.id, taskId))
      .run();
    expect(svc.listProposals(listInput())).toHaveLength(1);
  });

  it("writes nothing to any table (read-only) for listProposals + itemDetail", () => {
    const source = seedSource("Source");
    const { extract } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 });
    const svc = service();
    const accepted = svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS });
    const taskId = accepted.taskElementId as ElementId;

    const before = allTableRowCounts();
    svc.listProposals(listInput());
    svc.listProposals(listInput({ sourceId: source }));
    svc.itemDetail({ taskElementId: taskId, asOf: AS_OF, windowDays: THRESHOLDS.windowDays });
    expect(allTableRowCounts()).toEqual(before);
  });
});

describe("RereadProposalService.itemDetail", () => {
  it("lists live member cards with current in-window counts; excludes soft-deleted/retired", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a = seedCard({ parentId: extract, sourceId: source, prompt: "A" });
    const b = seedCard({ parentId: extract, sourceId: source, prompt: "B" });
    const gone = seedCard({ parentId: extract, sourceId: source, prompt: "GONE" });
    for (const c of [a, b, gone]) seedLapses(c, 2);

    const svc = service();
    const accepted = svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS });
    const taskId = accepted.taskElementId as ElementId;

    // Soft-delete one member after accept — it must drop out of the panel.
    new ElementRepository(handle.db).softDelete(gone);

    const detail = svc.itemDetail({ taskElementId: taskId, asOf: AS_OF, windowDays: 30 });
    if (!detail) throw new Error("expected detail");
    expect(detail.region.sourceElementId).toBe(source);
    const ids = detail.members.map((m) => m.cardId).sort();
    expect(ids).toEqual([a, b].sort());
    expect(detail.members.every((m) => m.windowLapseCount === 2)).toBe(true);
  });

  it("returns each card exactly once even with a duplicate references edge", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    const a = seedCard({ parentId: extract, sourceId: source, prompt: "A" });
    const b = seedCard({ parentId: extract, sourceId: source, prompt: "B" });
    for (const c of [a, b]) seedLapses(c, 3); // total 6 >= K=5
    const svc = service();
    const accepted = svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS });
    const taskId = accepted.taskElementId as ElementId;
    // Inject a duplicate edge.
    new ElementRepository(handle.db).addRelation({
      fromElementId: taskId,
      toElementId: a,
      relationType: "references",
    });
    const detail = svc.itemDetail({ taskElementId: taskId, asOf: AS_OF, windowDays: 30 });
    if (!detail) throw new Error("expected detail");
    expect(detail.members.filter((m) => m.cardId === a)).toHaveLength(1);
  });
});

describe("RereadProposalService.accept", () => {
  it("creates a reread_region task + tasks row + a references edge per member", () => {
    const source = seedSource("Source");
    const { extract, cardIds } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 });
    const result = service().accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS });
    expect(result.created).toBe(true);
    const taskId = result.taskElementId as ElementId;

    const taskRow = handle.db.select().from(tasks).where(eq(tasks.elementId, taskId)).get();
    expect(taskRow?.taskType).toBe("reread_region");
    expect(taskRow?.linkedElementId).toBe(extract);
    expect(taskRow?.status).toBe("scheduled");

    const edges = handle.db
      .select()
      .from(elementRelations)
      .where(eq(elementRelations.fromElementId, taskId))
      .all();
    expect(edges.map((e) => e.toElementId).sort()).toEqual(cardIds.slice().sort());
    expect(edges.every((e) => e.relationType === "references")).toBe(true);

    // Only create_element + add_relation ops were appended (no new op type).
    const opTypes = new Set(
      handle.db
        .select({ opType: operationLog.opType })
        .from(operationLog)
        .where(eq(operationLog.elementId, taskId))
        .all()
        .map((r) => r.opType),
    );
    expect([...opTypes].sort()).toEqual(["add_relation", "create_element"]);
  });

  it("refuses a second open re-read for the same region (one-open-per-region)", () => {
    const source = seedSource("Source");
    const { extract } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 });
    const svc = service();
    expect(svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS }).created).toBe(
      true,
    );
    expect(svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS })).toEqual({
      created: false,
      taskElementId: null,
      alreadyOpen: true,
      stale: false,
    });
  });

  it("re-accepts a region whose prior re-read was soft-deleted via a generic path (frees the stranded index)", () => {
    const source = seedSource("Source");
    const { extract } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 });
    const svc = service();
    const first = svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS });
    expect(first.created).toBe(true);

    // A GENERIC element soft-delete (e.g. trashing the task from the queue) sets
    // elements.deleted_at but NOT the tasks.status mirror — stranding the one-open index slot.
    new ElementRepository(handle.db).softDelete(first.taskElementId as ElementId);
    expect(
      (
        handle.sqlite
          .prepare("SELECT status FROM tasks WHERE element_id = ?")
          .get(first.taskElementId) as { status: string }
      ).status,
    ).toBe("scheduled"); // index slot still occupied

    // accept repairs the stranded slot and succeeds, instead of a false "Already scheduled".
    const second = svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS });
    expect(second.created).toBe(true);
    expect(second.taskElementId).not.toBe(first.taskElementId);
  });

  it("clears any prior dismissal for the region (accept supersedes dismiss)", () => {
    const source = seedSource("Source");
    const { extract } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 });
    const svc = service();
    const [p] = svc.listProposals(listInput());
    if (!p) throw new Error("expected proposal");
    svc.dismiss({
      ancestorId: extract,
      stateHash: p.stateHash,
      asOf: AS_OF,
      thresholds: THRESHOLDS,
    });
    expect(
      handle.db
        .select()
        .from(rereadProposalDismissals)
        .where(eq(rereadProposalDismissals.ancestorId, extract))
        .get(),
    ).toBeTruthy();

    svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS });
    expect(
      handle.db
        .select()
        .from(rereadProposalDismissals)
        .where(eq(rereadProposalDismissals.ancestorId, extract))
        .get(),
    ).toBeUndefined();
  });

  it("refuses to accept a cluster that no longer crosses the floor (stale)", () => {
    const source = seedSource("Source");
    const extract = seedExtract({ parentId: source, sourceId: source, anchorInto: source });
    // Only one lapsing card -> below minCards -> no cluster.
    const a = seedCard({ parentId: extract, sourceId: source });
    seedLapses(a, 6);
    expect(service().accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS })).toEqual({
      created: false,
      taskElementId: null,
      alreadyOpen: false,
      stale: true,
    });
  });

  it("rolls back the whole accept transaction on a mid-command failure (atomic)", () => {
    const source = seedSource("Source");
    const { extract } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 });
    const svc = service();
    // Force the edge insert to throw after the element + tasks row are created.
    let calls = 0;
    const repo = (svc as unknown as { elements: ElementRepository }).elements;
    const original = repo.addRelationWithin.bind(repo);
    repo.addRelationWithin = ((...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 2) throw new Error("boom");
      return original(...args);
    }) as typeof repo.addRelationWithin;

    const tasksBefore = (
      handle.sqlite.prepare("SELECT count(*) AS n FROM tasks").get() as { n: number }
    ).n;
    expect(() => svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS })).toThrow(
      "boom",
    );
    const tasksAfter = (
      handle.sqlite.prepare("SELECT count(*) AS n FROM tasks").get() as { n: number }
    ).n;
    expect(tasksAfter).toBe(tasksBefore); // no orphan task row
    expect(
      (
        handle.sqlite.prepare("SELECT count(*) AS n FROM elements WHERE type='task'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0); // no orphan task element
  });
});

describe("RereadProposalService.undoAccept", () => {
  it("soft-deletes the task, removing it from reads and freeing the region", () => {
    const source = seedSource("Source");
    const { extract } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 });
    const svc = service();
    const accepted = svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS });
    const taskId = accepted.taskElementId as ElementId;

    expect(svc.undoAccept(taskId)).toEqual({ removed: true });
    expect(svc.itemDetail({ taskElementId: taskId, asOf: AS_OF, windowDays: 30 })).toBeNull();
    // Region freed -> a fresh accept succeeds again.
    expect(svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS }).created).toBe(
      true,
    );
  });
});

describe("RereadProposalService.dismiss", () => {
  it("persists the dismissal with counters + an update_element op; rejects a stale hash", () => {
    const source = seedSource("Source");
    const { extract } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 });
    const svc = service();
    const [p] = svc.listProposals(listInput());
    if (!p) throw new Error("expected proposal");

    expect(
      svc.dismiss({
        ancestorId: extract,
        stateHash: "v1:wrong",
        asOf: AS_OF,
        thresholds: THRESHOLDS,
      }),
    ).toEqual({ dismissed: false, stale: true });

    expect(
      svc.dismiss({
        ancestorId: extract,
        stateHash: p.stateHash,
        asOf: AS_OF,
        thresholds: THRESHOLDS,
      }),
    ).toEqual({ dismissed: true, stale: false });

    const row = handle.db
      .select()
      .from(rereadProposalDismissals)
      .where(eq(rereadProposalDismissals.ancestorId, extract))
      .get();
    expect(row?.stateHash).toBe(p.stateHash);
    expect(row?.totalWindowLapses).toBe(6);
    expect(row?.affectedCardCount).toBe(3);

    const op = handle.db
      .select({ opType: operationLog.opType })
      .from(operationLog)
      .where(eq(operationLog.elementId, extract))
      .all();
    expect(op.some((o) => o.opType === "update_element")).toBe(true);
  });
});

describe("RereadProposalService — FSRS untouched", () => {
  it("leaves cards / review_states / review_logs byte-identical across accept + dismiss + undo", () => {
    const source = seedSource("Source");
    const { extract } = seedCluster(source, { cardCount: 3, lapsesPerCard: 2 });
    const svc = service();
    const before = reviewSnapshot();

    const [p] = svc.listProposals(listInput());
    if (!p) throw new Error("expected proposal");
    const accepted = svc.accept({ ancestorId: extract, asOf: AS_OF, thresholds: THRESHOLDS });
    svc.dismiss({
      ancestorId: extract,
      stateHash: p.stateHash,
      asOf: AS_OF,
      thresholds: THRESHOLDS,
    });
    svc.undoAccept(accepted.taskElementId as ElementId);

    expect(reviewSnapshot()).toBe(before);
  });
});

import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { elements, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { DailyWorkQuery } from "./daily-work-query";
import { ElementRepository } from "./element-repository";
import { createRepositories } from "./index";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let elementsRepo: ElementRepository;
let sources: SourceRepository;
let reviews: ReviewRepository;
let query: DailyWorkQuery;

const NOW = "2026-06-08T09:00:00.000Z" as IsoTimestamp;
const PAST = "2026-06-07T09:00:00.000Z" as IsoTimestamp;
const FUTURE = "2026-06-09T09:00:00.000Z" as IsoTimestamp;

beforeEach(() => {
  handle = createInMemoryDb();
  elementsRepo = new ElementRepository(handle.db);
  sources = new SourceRepository(handle.db);
  reviews = new ReviewRepository(handle.db);
  query = new DailyWorkQuery(createRepositories(handle.db), new BlockProcessingService(handle.db));
});

afterEach(() => {
  handle.sqlite.close();
});

function createDueCard(): ElementId {
  const { element } = reviews.createCard({
    kind: "qa",
    title: "Due card",
    prompt: "Question",
    answer: "Answer",
    priority: 0.8,
  });
  handle.db
    .update(reviewStates)
    .set({ dueAt: PAST })
    .where(eq(reviewStates.elementId, element.id))
    .run();
  return element.id;
}

function createDueAttention(): ElementId {
  return elementsRepo.create({
    type: "extract",
    status: "scheduled",
    stage: "raw_extract",
    priority: 0.6,
    title: "Due extract",
    dueAt: PAST,
  }).id;
}

function createInboxSource(): ElementId {
  return sources.createWithDocument({
    title: "Inbox article",
    priority: 0.5,
    status: "inbox",
    body: "Imported yesterday.\nNeeds triage.",
  }).element.id;
}

function createActiveUnscheduledSource(
  title = "Active article",
  body = "Read me later.\n\nStill not scheduled.",
): ElementId {
  return sources.createWithDocument({
    title,
    priority: 0.75,
    status: "active",
    body,
  }).element.id;
}

function createActiveScheduledSource(title: string, dueAt: IsoTimestamp): ElementId {
  const id = sources.createWithDocument({
    title,
    priority: 0.75,
    status: "active",
    body: "Started source.\n\nHas a return path.",
  }).element.id;
  handle.db.update(elements).set({ dueAt }).where(eq(elements.id, id)).run();
  return id;
}

describe("DailyWorkQuery", () => {
  it("recommends processing the due queue before inbox or unscheduled resume work", () => {
    createDueCard();
    createDueAttention();
    createInboxSource();
    createActiveUnscheduledSource();

    const summary = query.summary(NOW);

    expect(summary.dueQueueItems).toBe(2);
    expect(summary.inboxSources).toBe(1);
    expect(summary.activeUnscheduledSources).toBe(1);
    expect(summary.recommendedAction).toBe("process_due_queue");
  });

  it("recommends inbox triage when imports exist but no queue work is due", () => {
    createInboxSource();
    createActiveUnscheduledSource();

    const summary = query.summary(NOW);

    expect(summary.dueQueueItems).toBe(0);
    expect(summary.inboxSources).toBe(1);
    expect(summary.activeUnscheduledSources).toBe(1);
    expect(summary.recommendedAction).toBe("triage_inbox");
  });

  it("recommends resuming an active unscheduled source only after due and inbox work are empty", () => {
    const id = createActiveUnscheduledSource("Current read");

    const summary = query.summary(NOW);

    expect(summary.recommendedAction).toBe("resume_unscheduled_source");
    expect(summary.activeUnscheduledSources).toBe(1);
    expect(summary.resumeSource?.id).toBe(id);
    expect(summary.resumeSource?.unresolvedBlocks).toBeGreaterThan(0);
  });

  it("counts active scheduled sources as due queue work instead of unscheduled resume work", () => {
    const id = createActiveScheduledSource("Started scheduled read", PAST);

    const summary = query.summary(NOW);

    expect(summary.dueQueueItems).toBe(1);
    expect(summary.activeUnscheduledSources).toBe(0);
    expect(summary.resumeSource).toBeNull();
    expect(summary.recommendedAction).toBe("process_due_queue");
    expect(id).toBeTruthy();
  });

  it("does not treat active sources with a future return date as unscheduled resume work", () => {
    createActiveScheduledSource("Started future read", FUTURE);

    const summary = query.summary(NOW);

    expect(summary.dueQueueItems).toBe(0);
    expect(summary.activeUnscheduledSources).toBe(0);
    expect(summary.recommendedAction).toBe("clear");
  });

  it("prefers the most recently updated active unscheduled source when unresolved work ties", () => {
    const oldId = createActiveUnscheduledSource("Old source");
    const newId = createActiveUnscheduledSource("New source");
    handle.db
      .update(elements)
      .set({ updatedAt: "2026-06-01T09:00:00.000Z" })
      .where(eq(elements.id, oldId))
      .run();
    handle.db
      .update(elements)
      .set({ updatedAt: "2026-06-08T09:00:00.000Z" })
      .where(eq(elements.id, newId))
      .run();

    expect(query.summary(NOW).resumeSource?.id).toBe(newId);
  });

  it("prefers active unscheduled sources with more unresolved blocks before recency", () => {
    const newerId = createActiveUnscheduledSource("Newer short source", "One unresolved block.");
    const olderId = createActiveUnscheduledSource(
      "Older deeper source",
      "First unresolved block.\n\nSecond unresolved block.\n\nThird unresolved block.",
    );
    handle.db
      .update(elements)
      .set({ updatedAt: "2026-06-08T09:00:00.000Z" })
      .where(eq(elements.id, newerId))
      .run();
    handle.db
      .update(elements)
      .set({ updatedAt: "2026-06-01T09:00:00.000Z" })
      .where(eq(elements.id, olderId))
      .run();

    const summary = query.summary(NOW);

    expect(summary.resumeSource?.id).toBe(olderId);
    expect(summary.resumeSource?.unresolvedBlocks).toBeGreaterThan(1);
  });

  it("reports clear only when there is no due, inbox, or active unscheduled source work", () => {
    const summary = query.summary(NOW);

    expect(summary).toMatchObject({
      dueQueueItems: 0,
      inboxSources: 0,
      activeUnscheduledSources: 0,
      resumeSource: null,
      recommendedAction: "clear",
    });
  });
});

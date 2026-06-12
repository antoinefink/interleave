import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories } from "./index";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("local-db repository factory", () => {
  it("constructs the full repository bag behind the Electron DB boundary", () => {
    const repos = createRepositories(handle.db, { vecAvailable: false });

    expect(Object.keys(repos)).toEqual([
      "elements",
      "documents",
      "sources",
      "review",
      "queue",
      "search",
      "concepts",
      "assets",
      "settings",
      "operationLog",
      "blockProcessing",
      "trash",
      "analytics",
      "sourceDedup",
      "dedupReport",
      "lineageGap",
      "bulkActions",
      "jobs",
      "ocrPages",
      "occlusionMasks",
      "sourceYield",
      "extractStagnation",
      "schedulerConsistency",
      "parkedResurfacingQuery",
      "parkedResurfacing",
      "priorityIntegrity",
      "topicKnowledgeState",
      "chronicPostpone",
      "chronicPostponeService",
      "fallow",
      "retirementSuggestions",
      "embeddings",
      "semanticSearch",
      "tasks",
      "aiSuggestions",
      "synthesis",
      "related",
    ]);
    expect(repos.embeddings.available).toBe(false);
    expect(repos.semanticSearch).toBeDefined();
    expect(repos.related).toBeDefined();
  });
});

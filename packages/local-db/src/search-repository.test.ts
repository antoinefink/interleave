import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { SearchRepository, toMatchExpression } from "./search-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let elements: ElementRepository;
let search: SearchRepository;

beforeEach(() => {
  handle = createInMemoryDb();
  elements = new ElementRepository(handle.db);
  search = new SearchRepository(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

describe("SearchRepository direct helpers", () => {
  it("sanitizes raw FTS input into quoted prefix terms", () => {
    expect(toMatchExpression("Memory, consolidation!")).toBe('"memory"* AND "consolidation"*');
    expect(toMatchExpression("AND OR ()")).toBe('"and"* AND "or"*');
    expect(toMatchExpression("   ")).toBeNull();
  });

  it("title lookup treats LIKE wildcards as literal characters", () => {
    const percent = elements.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.5,
      title: "100% recall",
    });
    elements.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.5,
      title: "100x recall",
    });
    const underscore = elements.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.5,
      title: "a_b literal",
    });
    elements.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.5,
      title: "axb wildcard bait",
    });

    expect(search.byTitle("100%").map((item) => item.id)).toEqual([percent.id]);
    expect(search.byTitle("a_b").map((item) => item.id)).toEqual([underscore.id]);
  });

  it("returns no FTS hits for non-indexed element types", () => {
    elements.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.5,
      title: "Memory topic",
    });

    expect(search.search("memory", { type: "topic" })).toEqual([]);
    expect(search.query("memory", { type: "topic" })).toEqual([]);
  });
});

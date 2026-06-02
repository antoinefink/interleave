/**
 * OcrPagesRepository unit tests (T066) — the reviewable per-page OCR layer.
 *
 * Covers the load-bearing invariants: `upsertPage` is IDEMPOTENT (a re-OCR of the
 * same `(source, page)` OVERWRITES, never duplicates — the at-least-once job needs
 * this), `findPage`/`listForSource` reads, and the `setStatus` transitions
 * (`suggested → accepted`). Runs against this package's in-memory DB harness.
 */

import type { ElementId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { OcrPagesRepository } from "./ocr-pages-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repo: OcrPagesRepository;
let sourceId: ElementId;

beforeEach(() => {
  handle = createInMemoryDb();
  repo = new OcrPagesRepository(handle.db);
  const elements = new ElementRepository(handle.db);
  const source = elements.create({
    type: "source",
    status: "inbox",
    stage: "raw_source",
    priority: 0.375,
    title: "scanned PDF",
  });
  sourceId = source.id;
});

afterEach(() => {
  handle.sqlite.close();
});

describe("OcrPagesRepository", () => {
  it("upsertPage inserts a suggested record with confidence + words", () => {
    const page = repo.upsertPage({
      sourceElementId: sourceId,
      page: 1,
      text: "Hello world",
      meanConfidence: 87,
      words: [{ text: "Hello", confidence: 88, bbox: { x0: 0, y0: 0, x1: 10, y1: 5 } }],
    });
    expect(page.status).toBe("suggested");
    expect(page.meanConfidence).toBe(87);
    expect(page.words).toHaveLength(1);

    const found = repo.findPage(sourceId, 1);
    expect(found?.text).toBe("Hello world");
    expect(found?.words[0]?.text).toBe("Hello");
  });

  it("upsertPage is idempotent — a re-OCR overwrites the same (source, page)", () => {
    repo.upsertPage({
      sourceElementId: sourceId,
      page: 2,
      text: "first pass",
      meanConfidence: 40,
      words: [],
    });
    const second = repo.upsertPage({
      sourceElementId: sourceId,
      page: 2,
      text: "second pass",
      meanConfidence: 90,
      words: [],
    });
    // The list has EXACTLY one record for the page (no duplicate row).
    const all = repo.listForSource(sourceId).filter((p) => p.page === 2);
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toBe("second pass");
    expect(all[0]?.meanConfidence).toBe(90);
    // The id is stable across the overwrite (an update, not a fresh insert).
    expect(repo.findPage(sourceId, 2)?.id).toBe(second.id);
  });

  it("clamps an out-of-range confidence into 0–100", () => {
    const page = repo.upsertPage({
      sourceElementId: sourceId,
      page: 3,
      text: "x",
      meanConfidence: 1234,
      words: [],
    });
    expect(page.meanConfidence).toBe(100);
  });

  it("listForSource returns records ordered by page", () => {
    repo.upsertPage({
      sourceElementId: sourceId,
      page: 3,
      text: "c",
      meanConfidence: 1,
      words: [],
    });
    repo.upsertPage({
      sourceElementId: sourceId,
      page: 1,
      text: "a",
      meanConfidence: 1,
      words: [],
    });
    repo.upsertPage({
      sourceElementId: sourceId,
      page: 2,
      text: "b",
      meanConfidence: 1,
      words: [],
    });
    expect(repo.listForSource(sourceId).map((p) => p.page)).toEqual([1, 2, 3]);
  });

  it("setStatus transitions suggested → accepted", () => {
    const page = repo.upsertPage({
      sourceElementId: sourceId,
      page: 1,
      text: "y",
      meanConfidence: 50,
      words: [],
    });
    const updated = repo.setStatus(page.id, "accepted");
    expect(updated?.status).toBe("accepted");
    expect(repo.findPage(sourceId, 1)?.status).toBe("accepted");
  });
});

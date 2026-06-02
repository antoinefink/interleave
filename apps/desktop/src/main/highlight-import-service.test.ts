/**
 * HighlightImportService integration tests (T069) — against a real temp-file SQLite DB,
 * pointing `importFromFile` at the committed highlight fixtures
 * (`@interleave/importers/src/__fixtures__/highlights`). No Electron is involved — the
 * service is built through `DbService` (the same accessor the IPC layer uses); all reads
 * go through the public `svc.repos` accessors (the same pattern the EPUB test uses).
 *
 * Proves: importing a Readwise CSV creates one source per book with N `extract` children
 * each carrying a `source_locations` row (page/label/selectedText) and the right ops, and
 * creates ZERO `cards`/`review_states` rows (the load-bearing extracts-not-cards rule);
 * re-importing the SAME file does not duplicate sources or extracts (dedup); a Kindle
 * clippings import groups by book + preserves locations; and the sources + extracts
 * survive re-opening the DB (restart-persistence).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElementId } from "@interleave/core";
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbService } from "./db-service";
import { HighlightImportError } from "./highlight-import-service";

const FIXTURES = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "importers",
  "src",
  "__fixtures__",
  "highlights",
);

let dir: string;
let dbPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-hlimp-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function openSvc(): DbService {
  const svc = new DbService();
  svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR, assetsDir });
  return svc;
}

/** All extract children of a source (via the `parent_child`/`source_id` lineage). */
function extractsOf(svc: DbService, sourceId: ElementId) {
  return svc.repos.elements.listChildren(sourceId).filter((c) => c.type === "extract");
}

describe("HighlightImportService.importFromFile", () => {
  it("imports a Readwise CSV into one source per book with extract children (NOT cards)", async () => {
    const svc = openSvc();
    const result = await svc.importHighlights({
      absPath: path.join(FIXTURES, "readwise.csv"),
    });

    expect(result.status).toBe("imported");
    expect(result.format).toBe("readwise_csv");
    // The CSV has 3 valid highlights across 2 books (Attention Paper x2, Psychology x1).
    expect(result.sourceCount).toBe(2);
    expect(result.extractCount).toBe(3);
    expect(result.skipped).toBe(0);

    // Every created item is a `source`; each has `extract` children and NO review state.
    let totalExtracts = 0;
    for (const item of result.items) {
      expect(item.type).toBe("source");
      expect(item.status).toBe("inbox");
      const extracts = extractsOf(svc, item.id as ElementId);
      totalExtracts += extracts.length;
      for (const ex of extracts) {
        // The load-bearing rule: highlights become extracts, NEVER cards.
        expect(svc.repos.review.findReviewState(ex.id)).toBeNull();
        // Each extract carries a source_locations anchor with the highlight text.
        const loc = svc.repos.sources.findLocationForElement(ex.id);
        expect(loc).not.toBeNull();
        expect((loc?.selectedText ?? "").length).toBeGreaterThan(0);
      }
    }
    expect(totalExtracts).toBe(3);

    // The page-typed Readwise highlight ("Page 12") anchored a page; the location-typed
    // one ("Location 1234") kept its label with no page.
    const attention = result.items.find((i) => i.title === "Attention Paper");
    const attLocs = extractsOf(svc, attention?.id as ElementId).map((e) =>
      svc.repos.sources.findLocationForElement(e.id),
    );
    expect(attLocs.some((l) => l?.page === 12 && l?.label === "Page 12")).toBe(true);
    expect(attLocs.some((l) => l?.label === "Location 1234" && l?.page === null)).toBe(true);

    svc.close();
  });

  it("preserves attribution on the owning source (title/author)", async () => {
    const svc = openSvc();
    const result = await svc.importHighlights({ absPath: path.join(FIXTURES, "readwise.csv") });
    const attentionSource = result.items.find((i) => i.title === "Attention Paper");
    expect(attentionSource).toBeDefined();
    expect(attentionSource?.author).toBe("Vaswani, Ashish");
    // The provenance row carries the canonical URL (so a re-import dedups by it).
    const provenance = svc.repos.sources.findById(attentionSource?.id as ElementId);
    expect(provenance?.source.canonicalUrl).toBe("https://arxiv.org/abs/1706.03762");
    svc.close();
  });

  it("does NOT duplicate sources or extracts when the SAME file is re-imported (dedup)", async () => {
    const svc = openSvc();
    const first = await svc.importHighlights({ absPath: path.join(FIXTURES, "readwise.csv") });
    const firstIds = first.items.map((i) => i.id).sort();

    const second = await svc.importHighlights({ absPath: path.join(FIXTURES, "readwise.csv") });
    // Every highlight is a duplicate → all skipped, the SAME sources reused.
    expect(second.extractCount).toBe(0);
    expect(second.skipped).toBe(3);
    expect(second.items.map((i) => i.id).sort()).toEqual(firstIds);
    // The extract counts under each source are unchanged.
    for (const item of second.items) {
      const n = item.title === "Attention Paper" ? 2 : 1;
      expect(extractsOf(svc, item.id as ElementId)).toHaveLength(n);
    }
    svc.close();
  });

  it("imports Kindle clippings grouped by book, preserving locations, skipping bookmarks/notes", async () => {
    const svc = openSvc();
    const result = await svc.importHighlights({
      absPath: path.join(FIXTURES, "MyClippings.txt"),
    });
    expect(result.format).toBe("kindle_clippings");
    // 2 Pragmatic + 1 Sapiens = 3 extracts across 2 sources.
    expect(result.sourceCount).toBe(2);
    expect(result.extractCount).toBe(3);

    const pragmatic = result.items.find((i) => i.title === "The Pragmatic Programmer");
    const pragLocs = extractsOf(svc, pragmatic?.id as ElementId).map((e) =>
      svc.repos.sources.findLocationForElement(e.id),
    );
    expect(pragLocs.some((l) => l?.label === "Page 24" && l?.page === 24)).toBe(true);

    const sapiens = result.items.find((i) => i.title === "Sapiens");
    const sapLocs = extractsOf(svc, sapiens?.id as ElementId).map((e) =>
      svc.repos.sources.findLocationForElement(e.id),
    );
    expect(sapLocs.some((l) => l?.label === "Location 512-514")).toBe(true);
    svc.close();
  });

  it("imports the Readwise JSON shape", async () => {
    const svc = openSvc();
    const result = await svc.importHighlights({ absPath: path.join(FIXTURES, "readwise.json") });
    expect(result.format).toBe("readwise_json");
    // Thinking Fast and Slow (2) + Deep Work (1) = 3 extracts, 2 sources.
    expect(result.sourceCount).toBe(2);
    expect(result.extractCount).toBe(3);
    svc.close();
  });

  it("throws a typed error for an unrecognized export (and persists nothing)", async () => {
    const svc = openSvc();
    const junk = path.join(dir, "junk.dat");
    fs.writeFileSync(junk, "just some prose with no structure at all");
    await expect(svc.importHighlights({ absPath: junk })).rejects.toBeInstanceOf(
      HighlightImportError,
    );
    expect(svc.listInbox().items).toHaveLength(0);
    svc.close();
  });

  it("survives an app restart — sources + extracts persist after re-opening the DB", async () => {
    const first = openSvc();
    const imported = await first.importHighlights({
      absPath: path.join(FIXTURES, "readwise.csv"),
    });
    const ids = imported.items.map((i) => i.id);
    first.close();

    const second = openSvc();
    for (const id of ids) {
      const source = second.repos.sources.findById(id as ElementId);
      expect(source).not.toBeNull();
      const n = source?.element.title === "Attention Paper" ? 2 : 1;
      expect(extractsOf(second, id as ElementId)).toHaveLength(n);
    }
    // Re-importing after restart still dedups (no new extracts).
    const reimport = await second.importHighlights({
      absPath: path.join(FIXTURES, "readwise.csv"),
    });
    expect(reimport.extractCount).toBe(0);
    second.close();
  });
});

/**
 * SourceDedupQuery tests (T061) — the URL-import duplicate-detection lookups.
 *
 * Against a fresh in-memory SQLite DB (this package's own `createInMemoryDb`
 * harness — the same one the other repository tests use). Covers:
 *  - two sources sharing a canonical URL are BOTH returned, newest first;
 *  - a soft-deleted source is excluded (only live sources match);
 *  - `findSourceBySnapshotHash` resolves the owning source from the cleaned-HTML
 *    asset hash, returns `null` for an unknown hash, and DISAMBIGUATES — an
 *    `original.html` byte-collision does NOT resolve (only the cleaned snapshot is
 *    the dedup criterion);
 *  - a soft-deleted source's snapshot hash no longer resolves.
 */

import { canonicalizeUrl } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import type { SourceDedupQuery } from "./source-dedup-query";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let dedup: SourceDedupQuery;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  dedup = repos.sourceDedup;
});

afterEach(() => {
  handle.sqlite.close();
});

/** Create a live inbox source with the given canonical URL + accessed timestamp. */
function makeSource(canonicalUrl: string, accessedAt: string, title = "Article") {
  return repos.sources.create({
    title,
    priority: 0.5,
    status: "inbox",
    stage: "raw_source",
    url: canonicalUrl,
    canonicalUrl,
    originalUrl: canonicalUrl,
    accessedAt,
  }).element.id;
}

/** Record a `source_html` snapshot asset (metadata only) for a source. */
function addSnapshotAsset(
  sourceId: string,
  fileName: "cleaned.html" | "original.html",
  contentHash: string,
) {
  return repos.assets.create({
    owningElementId: sourceId as never,
    kind: "source_html",
    vaultRoot: "assets",
    relativePath: `sources/${sourceId}/${fileName}`,
    contentHash,
    mime: "text/html",
    size: 100,
  });
}

describe("SourceDedupQuery.findSourcesByCanonicalUrl", () => {
  it("returns all live sources sharing a canonical URL, newest first", () => {
    const url = "https://example.com/spacing";
    const older = makeSource(url, "2026-05-01T00:00:00.000Z");
    const newer = makeSource(url, "2026-05-10T00:00:00.000Z");

    const matches = dedup.findSourcesByCanonicalUrl(url);
    expect(matches.map((m) => m.elementId)).toEqual([newer, older]);
    expect(matches[0]?.matchedBy).toBe("canonicalUrl");
    expect(matches[0]?.status).toBe("inbox");
  });

  it("excludes a soft-deleted source (only live sources match)", () => {
    const url = "https://example.com/spacing";
    const live = makeSource(url, "2026-05-01T00:00:00.000Z");
    const deleted = makeSource(url, "2026-05-10T00:00:00.000Z");
    repos.elements.softDelete(deleted as never);

    const matches = dedup.findSourcesByCanonicalUrl(url);
    expect(matches.map((m) => m.elementId)).toEqual([live]);
  });

  it("returns [] for a null / unknown canonical URL", () => {
    makeSource("https://example.com/a", "2026-05-01T00:00:00.000Z");
    expect(dedup.findSourcesByCanonicalUrl(null)).toEqual([]);
    expect(dedup.findSourcesByCanonicalUrl("https://example.com/other")).toEqual([]);
  });

  it("collapses tracking-param variants via the shared canonicalizeUrl normalizer", () => {
    // The dedup relies on canonicalizeUrl folding tracking params to one key — the
    // SAME normalizer manual import + URL import use (no fork). Sanity-check it here.
    const bare = "https://example.com/spacing";
    const tagged = "https://example.com/spacing?utm_source=x&utm_campaign=y";
    expect(canonicalizeUrl(tagged)).toBe(canonicalizeUrl(bare));

    makeSource(canonicalizeUrl(bare) as string, "2026-05-01T00:00:00.000Z");
    // A candidate arriving via the tagged URL canonicalizes to the stored key.
    expect(dedup.findSourcesByCanonicalUrl(canonicalizeUrl(tagged))).toHaveLength(1);
  });
});

describe("SourceDedupQuery.findSourceBySnapshotHash", () => {
  it("resolves the owning source from the CLEANED-HTML asset hash", () => {
    const sourceId = makeSource("https://example.com/a", "2026-05-01T00:00:00.000Z");
    addSnapshotAsset(sourceId, "cleaned.html", "cleanhash");

    const match = dedup.findSourceBySnapshotHash("cleanhash");
    expect(match?.elementId).toBe(sourceId);
    expect(match?.matchedBy).toBe("contentHash");
  });

  it("returns null for an unknown hash", () => {
    makeSource("https://example.com/a", "2026-05-01T00:00:00.000Z");
    expect(dedup.findSourceBySnapshotHash("nope")).toBeNull();
  });

  it("DISAMBIGUATES: an original.html collision does NOT resolve (cleaned-only criterion)", () => {
    const sourceId = makeSource("https://example.com/a", "2026-05-01T00:00:00.000Z");
    // Only an original.html asset carries this hash — it must NOT be a dedup match.
    addSnapshotAsset(sourceId, "original.html", "originalonlyhash");
    expect(dedup.findSourceBySnapshotHash("originalonlyhash")).toBeNull();
  });

  it("excludes a soft-deleted source's snapshot hash", () => {
    const sourceId = makeSource("https://example.com/a", "2026-05-01T00:00:00.000Z");
    addSnapshotAsset(sourceId, "cleaned.html", "clean2");
    repos.elements.softDelete(sourceId as never);
    expect(dedup.findSourceBySnapshotHash("clean2")).toBeNull();
  });
});

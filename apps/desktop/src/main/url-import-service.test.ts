/**
 * UrlImportService tests (T060) — main-side, against a REAL temp-file SQLite DB +
 * a temp asset vault + a MOCKED fetch (no live network).
 *
 * Follows the desktop-main test pattern (a real `mkdtempSync` temp file, not the
 * in-memory helper — a temp file is what makes the restart-persistence assertion
 * meaningful). Covers: a successful import writes original.html + cleaned.html
 * with content-hashed asset rows, an inbox source whose snapshotKey is the cleaned
 * path and whose body parses to the expected nodes, with create_source +
 * update_document ops; restart persistence (re-open the file); error paths leave
 * NO source row + NO partial vault dir; and the importFromHtml capture entry point
 * lands the same source shape with no fetch.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type DbHandle, MIGRATIONS_DIR, migrateDatabase, openDatabase } from "@interleave/db";
import {
  AssetRepository,
  createRepositories,
  DocumentRepository,
  ElementRepository,
  OperationLogRepository,
  type Repositories,
  SourceRepository,
} from "@interleave/local-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256File } from "./backup-manifest";
import { UrlImportError, UrlImportService } from "./url-import-service";

const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><title>Spacing Effect</title></head>
  <body>
    <article>
      <h1>The Spacing Effect</h1>
      <p class="byline" rel="author">By Hermann Ebbinghaus</p>
      <p>Spaced repetition exploits the spacing effect: information is retained better when study is distributed over time rather than crammed.</p>
      <p>After each successful recall the optimal interval lengthens, because the memory trace has been reconsolidated and decays more slowly than before.</p>
      <p>The classic forgetting curve shows retention falls off exponentially without reinforcement; reviewing just before forgetting flattens it.</p>
    </article>
  </body>
</html>`;

let dir: string;
let dbPath: string;
let assetsDir: string;
let handle: DbHandle;
let repos: Repositories;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-urlimport-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(path.join(assetsDir, "sources"), { recursive: true });
  handle = openDatabase(dbPath);
  migrateDatabase(handle.db, MIGRATIONS_DIR);
  repos = createRepositories(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A mock `fetch` returning a fixed HTML body + headers. */
function htmlFetch(html: string, init?: { status?: number; contentType?: string }): typeof fetch {
  return (async () => {
    return new Response(html, {
      status: init?.status ?? 200,
      headers: { "content-type": init?.contentType ?? "text/html; charset=utf-8" },
    }) as Response & { url: string };
  }) as unknown as typeof fetch;
}

/** Build the service with the temp DB + vault + a mocked fetch. */
function makeService(fetchImpl: typeof fetch): UrlImportService {
  return new UrlImportService({ db: handle.db, repositories: repos, assetsDir, fetchImpl });
}

/** Assert an import succeeded and narrow to the `"imported"` arm (T061 discriminated result). */
function expectImported(result: Awaited<ReturnType<UrlImportService["importFromUrl"]>>): {
  status: "imported";
  id: string;
  item: { id: string };
} {
  expect(result.status).toBe("imported");
  if (result.status !== "imported") throw new Error("expected an imported result");
  return result;
}

describe("UrlImportService.importFromUrl (T060 happy path)", () => {
  it("fetches, cleans, snapshots, and creates an inbox source", async () => {
    const svc = makeService(htmlFetch(ARTICLE_HTML));
    const result = await svc.importFromUrl({ url: "https://example.com/spacing" });
    const { id } = expectImported(result);

    // Both snapshots exist on disk under assets/sources/<id>/.
    const originalPath = path.join(assetsDir, "sources", id, "original.html");
    const cleanedPath = path.join(assetsDir, "sources", id, "cleaned.html");
    expect(fs.existsSync(originalPath)).toBe(true);
    expect(fs.existsSync(cleanedPath)).toBe(true);
    // The cleaned snapshot has been sanitized (no surviving class attributes).
    expect(fs.readFileSync(cleanedPath, "utf-8")).not.toMatch(/class=/);

    // Two source_html asset rows, hashes matching the files on disk.
    const assetRows = new AssetRepository(handle.db).listForElementByKind(
      id as never,
      "source_html",
    );
    expect(assetRows).toHaveLength(2);
    const byPath = new Map(assetRows.map((a) => [a.location.vaultPath.relativePath, a]));
    expect(byPath.get(`sources/${id}/original.html`)?.contentHash).toBe(sha256File(originalPath));
    expect(byPath.get(`sources/${id}/cleaned.html`)?.contentHash).toBe(sha256File(cleanedPath));

    // The source is in the inbox with the right provenance + snapshotKey.
    const source = new SourceRepository(handle.db).findById(id as never);
    expect(source?.element.status).toBe("inbox");
    expect(source?.element.stage).toBe("raw_source");
    expect(source?.element.title).toContain("Spacing Effect");
    expect(source?.source.snapshotKey).toBe(`sources/${id}/cleaned.html`);
    expect(source?.source.originalUrl).toBe("https://example.com/spacing");
    expect(source?.source.canonicalUrl).toBe("https://example.com/spacing");
    expect(source?.source.author).toContain("Ebbinghaus");
    expect(source?.source.accessedAt).not.toBeNull();

    // The document body parses to paragraphs (no bytes in SQLite — only metadata).
    const doc = new DocumentRepository(handle.db).findById(id as never);
    expect(doc?.plainText).toContain("Spaced repetition exploits the spacing effect");
    const blocks = new DocumentRepository(handle.db).listBlocks(id as never);
    expect(blocks.length).toBeGreaterThan(0);

    // The create/update ops were appended.
    const ops = new OperationLogRepository(handle.db)
      .listForElement(id as never)
      .map((e) => e.opType);
    expect(ops).toContain("create_element");
    expect(ops).toContain("create_source");
    expect(ops).toContain("update_document");
  });

  it("survives a restart: re-opening the same file finds the source + snapshots", async () => {
    const svc = makeService(htmlFetch(ARTICLE_HTML));
    const { id } = expectImported(await svc.importFromUrl({ url: "https://example.com/spacing" }));
    handle.sqlite.close();

    // Re-open the SAME file with fresh repositories.
    const reopened = openDatabase(dbPath);
    migrateDatabase(reopened.db, MIGRATIONS_DIR);
    try {
      const source = new SourceRepository(reopened.db).findById(id as never);
      expect(source?.element.title).toContain("Spacing Effect");
      expect(source?.source.snapshotKey).toBe(`sources/${id}/cleaned.html`);
      const assetRows = new AssetRepository(reopened.db).listForElementByKind(
        id as never,
        "source_html",
      );
      expect(assetRows).toHaveLength(2);
      // The snapshot files are still on disk.
      expect(fs.existsSync(path.join(assetsDir, "sources", id, "original.html"))).toBe(true);
      expect(fs.existsSync(path.join(assetsDir, "sources", id, "cleaned.html"))).toBe(true);
    } finally {
      reopened.sqlite.close();
      // re-assign so afterEach can close without double-close.
      handle = reopened;
    }
  });

  it("still imports a non-article page (capture is never lost) with a title fallback", async () => {
    const landing = `<html lang="en"><head><title>Landing</title></head><body><div id="root"></div></body></html>`;
    const svc = makeService(htmlFetch(landing));
    const { id } = expectImported(await svc.importFromUrl({ url: "https://example.com/app" }));
    const source = new SourceRepository(handle.db).findById(id as never);
    // Title falls back to the page <title>; a reason notes the empty body.
    expect(source?.element.title).toBe("Landing");
    expect(source?.source.reasonAdded).toMatch(/no article body/i);
    // The original snapshot is still saved so the user can read it later.
    expect(fs.existsSync(path.join(assetsDir, "sources", id, "original.html"))).toBe(true);
  });

  it("keeps the user's reason AND appends the empty-body note when both apply", async () => {
    const landing = `<html lang="en"><head><title>Landing</title></head><body><div id="root"></div></body></html>`;
    const svc = makeService(htmlFetch(landing));
    const { id } = expectImported(
      await svc.importFromUrl({
        url: "https://example.com/app",
        reasonAdded: "worth keeping",
      }),
    );
    const source = new SourceRepository(handle.db).findById(id as never);
    // User intent stays first; the diagnostic note is appended, not dropped.
    expect(source?.source.reasonAdded).toMatch(/^worth keeping/);
    expect(source?.source.reasonAdded).toMatch(/no article body/i);
  });
});

describe("UrlImportService dedup (T061)", () => {
  /** Count live source elements currently in the inbox. */
  function inboxSourceCount(): number {
    return new ElementRepository(handle.db).listByStatus("inbox").filter((e) => e.type === "source")
      .length;
  }

  it("re-importing the SAME url returns `duplicate` and creates only one source", async () => {
    const svc = makeService(htmlFetch(ARTICLE_HTML));
    const first = expectImported(await svc.importFromUrl({ url: "https://example.com/spacing" }));
    expect(inboxSourceCount()).toBe(1);

    const second = await svc.importFromUrl({ url: "https://example.com/spacing" });
    expect(second.status).toBe("duplicate");
    if (second.status !== "duplicate") throw new Error("expected duplicate");
    expect(second.matches).toHaveLength(1);
    expect(second.matches[0]?.elementId).toBe(first.id);
    expect(second.matches[0]?.matchedBy).toBe("canonicalUrl");
    // Still ONE source — the duplicate created nothing.
    expect(inboxSourceCount()).toBe(1);
  });

  it("detects a tracking-param VARIANT as a canonical-URL duplicate", async () => {
    const svc = makeService(htmlFetch(ARTICLE_HTML));
    expectImported(await svc.importFromUrl({ url: "https://example.com/spacing" }));

    // A utm-tagged variant canonicalizes to the same URL → canonical duplicate.
    const variant = await svc.importFromUrl({
      url: "https://example.com/spacing?utm_source=twitter&utm_campaign=x",
    });
    expect(variant.status).toBe("duplicate");
    if (variant.status !== "duplicate") throw new Error("expected duplicate");
    expect(variant.matches[0]?.matchedBy).toBe("canonicalUrl");
    expect(inboxSourceCount()).toBe(1);
  });

  it("detects IDENTICAL bytes at a DIFFERENT canonical url as a content-hash duplicate", async () => {
    const svc = makeService(htmlFetch(ARTICLE_HTML));
    expectImported(await svc.importFromUrl({ url: "https://example.com/spacing" }));

    // A genuinely different URL (different host+path → different canonical) serving
    // the IDENTICAL article bytes → the cleaned-snapshot hash matches.
    const mirror = await svc.importFromUrl({ url: "https://mirror.example.net/copy" });
    expect(mirror.status).toBe("duplicate");
    if (mirror.status !== "duplicate") throw new Error("expected duplicate");
    expect(mirror.matches[0]?.matchedBy).toBe("contentHash");
    expect(inboxSourceCount()).toBe(1);
  });

  it("forceNewVersion imports a SECOND source sharing the canonical url", async () => {
    const svc = makeService(htmlFetch(ARTICLE_HTML));
    const first = expectImported(await svc.importFromUrl({ url: "https://example.com/spacing" }));

    const second = expectImported(
      await svc.importFromUrl({ url: "https://example.com/spacing", forceNewVersion: true }),
    );
    expect(second.id).not.toBe(first.id);
    expect(inboxSourceCount()).toBe(2);

    // Both sources share the canonical URL (the index is non-unique by design).
    const a = new SourceRepository(handle.db).findById(first.id as never);
    const b = new SourceRepository(handle.db).findById(second.id as never);
    expect(a?.source.canonicalUrl).toBe(b?.source.canonicalUrl);

    // A THIRD, dedup-checking import now surfaces BOTH live canonical-URL matches
    // (the plural `matches[]` contract) — not just the latest one. (Newest-first
    // ordering with controlled timestamps is covered in the dedup-query unit test;
    // here both imports can share a millisecond, so assert the SET of ids.)
    const third = await svc.importFromUrl({ url: "https://example.com/spacing" });
    expect(third.status).toBe("duplicate");
    if (third.status !== "duplicate") throw new Error("expected duplicate");
    expect(third.matches).toHaveLength(2);
    expect(new Set(third.matches.map((m) => m.elementId))).toEqual(new Set([first.id, second.id]));
    expect(third.matches.every((m) => m.matchedBy === "canonicalUrl")).toBe(true);
    expect(inboxSourceCount()).toBe(2);
  });

  it("a soft-deleted source does NOT block re-import (only live sources match)", async () => {
    const svc = makeService(htmlFetch(ARTICLE_HTML));
    const first = expectImported(await svc.importFromUrl({ url: "https://example.com/spacing" }));

    // Soft-delete the first source, then re-import — it should import fresh.
    new ElementRepository(handle.db).softDelete(first.id as never);
    const again = await svc.importFromUrl({ url: "https://example.com/spacing" });
    expect(again.status).toBe("imported");
    expect(inboxSourceCount()).toBe(1);
  });
});

describe("UrlImportService.importFromUrl (T060 error paths — clean rollback)", () => {
  function noSourceRows(): void {
    // No source element exists, and no partial vault dir was left behind.
    const anySource = new ElementRepository(handle.db)
      .listByStatus("inbox")
      .filter((e) => e.type === "source");
    expect(anySource).toHaveLength(0);
    const sourcesDir = path.join(assetsDir, "sources");
    const entries = fs.existsSync(sourcesDir) ? fs.readdirSync(sourcesDir) : [];
    expect(entries).toHaveLength(0);
  }

  it("throws http_error on a non-2xx response and persists nothing", async () => {
    const svc = makeService(htmlFetch("<html></html>", { status: 404 }));
    await expect(svc.importFromUrl({ url: "https://example.com/missing" })).rejects.toMatchObject({
      code: "http_error",
    });
    noSourceRows();
  });

  it("throws not_html on a non-HTML content type", async () => {
    const svc = makeService(htmlFetch("{}", { contentType: "application/json" }));
    await expect(svc.importFromUrl({ url: "https://example.com/api" })).rejects.toMatchObject({
      code: "not_html",
    });
    noSourceRows();
  });

  it("throws blocked_host for a private / loopback host (SSRF guard)", async () => {
    const svc = makeService(htmlFetch(ARTICLE_HTML));
    await expect(svc.importFromUrl({ url: "http://127.0.0.1:8080/admin" })).rejects.toMatchObject({
      code: "blocked_host",
    });
    await expect(
      svc.importFromUrl({ url: "http://169.254.169.254/latest/meta-data" }),
    ).rejects.toMatchObject({ code: "blocked_host" });
    noSourceRows();
  });

  it("throws fetch_failed when the network rejects", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const svc = makeService(failing);
    await expect(svc.importFromUrl({ url: "https://example.com/down" })).rejects.toBeInstanceOf(
      UrlImportError,
    );
    noSourceRows();
  });

  it("throws timeout when the fetch aborts and persists nothing", async () => {
    // The service aborts via an AbortController on the timeout; the mocked fetch
    // rejects with a DOMException-shaped AbortError exactly like the real abort.
    const aborting = (async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const svc = makeService(aborting);
    await expect(svc.importFromUrl({ url: "https://example.com/slow" })).rejects.toMatchObject({
      code: "timeout",
    });
    noSourceRows();
  });

  it("throws too_large when the DECLARED content-length exceeds the 8 MB cap", async () => {
    const oversizedDeclared = (async () => {
      return new Response("<html><body>small body</body></html>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(9 * 1024 * 1024),
        },
      }) as Response & { url: string };
    }) as unknown as typeof fetch;
    const svc = makeService(oversizedDeclared);
    await expect(svc.importFromUrl({ url: "https://example.com/huge" })).rejects.toMatchObject({
      code: "too_large",
    });
    noSourceRows();
  });

  it("throws too_large when the STREAMED body exceeds the 8 MB cap (no declared length)", async () => {
    // A streaming body over the cap with NO content-length header — exercises the
    // streaming readCappedBody path that measures bytes as they arrive.
    const oversizedStreamed = (async () => {
      const chunk = new Uint8Array(1024 * 1024); // 1 MB chunks.
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          // 10 MB total (> 8 MB cap) before the reader is cancelled.
          controller.enqueue(chunk);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }) as Response & { url: string };
    }) as unknown as typeof fetch;
    const svc = makeService(oversizedStreamed);
    await expect(svc.importFromUrl({ url: "https://example.com/stream" })).rejects.toMatchObject({
      code: "too_large",
    });
    noSourceRows();
  });
});

describe("UrlImportService.importFromHtml (T060 capture entry point)", () => {
  it("lands the same source shape as importFromUrl, without any network call", async () => {
    // A fetch that THROWS if called proves importFromHtml never hits the network.
    const exploding = (() => {
      throw new Error("importFromHtml must not fetch");
    }) as unknown as typeof fetch;
    const svc = makeService(exploding);

    const result = await svc.importFromHtml({
      url: "https://example.com/spacing",
      html: ARTICLE_HTML,
    });
    const { id } = expectImported(result);

    const source = new SourceRepository(handle.db).findById(id as never);
    expect(source?.element.status).toBe("inbox");
    expect(source?.element.title).toContain("Spacing Effect");
    expect(source?.source.snapshotKey).toBe(`sources/${id}/cleaned.html`);
    // Both snapshots + two asset rows, exactly like the fetch path.
    expect(fs.existsSync(path.join(assetsDir, "sources", id, "cleaned.html"))).toBe(true);
    expect(
      new AssetRepository(handle.db).listForElementByKind(id as never, "source_html"),
    ).toHaveLength(2);
    const doc = new DocumentRepository(handle.db).findById(id as never);
    expect(doc?.plainText).toContain("Spaced repetition exploits the spacing effect");
  });
});

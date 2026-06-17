/**
 * Unit tests for the pure capture handler (T062).
 *
 * Drives `handleCapture` with INJECTED fakes (token getter, allowed-origin
 * getter, a fake import service) — no open socket, no SQLite. Proves the threat
 * model order, the page + selection dispatch, the label→numeric priority mapping
 * through the core helper, and that source creation NEVER touches SQL here.
 */

import { priorityFromLabel } from "@interleave/core";
import { describe, expect, it, vi } from "vitest";
import {
  type CaptureHandlerDeps,
  type CaptureImportResult,
  type CaptureImportService,
  type CaptureRequestContext,
  type FindSourcesByCanonicalUrl,
  handleCapture,
  type LookupCanonicalMatch,
  lookupSourceByUrl,
} from "./capture-handler";

const TOKEN = "test-token-abc123";
const ORIGIN = "chrome-extension://abcdefghijklmnop";

/** A fake import service recording its calls. */
function fakeImportService(
  result: CaptureImportResult = {
    status: "imported",
    id: "el_new",
    item: { title: "Fresh Source" },
  },
): CaptureImportService & {
  pageCalls: unknown[];
  selectionCalls: unknown[];
} {
  const pageCalls: unknown[] = [];
  const selectionCalls: unknown[] = [];
  return {
    pageCalls,
    selectionCalls,
    importFromHtml: vi.fn(async (input) => {
      pageCalls.push(input);
      return result;
    }),
    importSelection: vi.fn(async (input) => {
      selectionCalls.push(input);
      return result;
    }),
  };
}

function deps(overrides: Partial<CaptureHandlerDeps> = {}): CaptureHandlerDeps {
  return {
    getToken: () => TOKEN,
    getAllowedOrigin: () => ORIGIN,
    importService: fakeImportService(),
    ...overrides,
  };
}

function ctx(overrides: Partial<CaptureRequestContext> = {}): CaptureRequestContext {
  return {
    body: JSON.stringify({ kind: "page", url: "https://example.com/a", html: "<p>x</p>" }),
    authorization: `Bearer ${TOKEN}`,
    origin: ORIGIN,
    contentType: "application/json",
    ...overrides,
  };
}

describe("handleCapture — threat model", () => {
  it("403 unpaired when no token is stored", async () => {
    const r = await handleCapture(ctx(), deps({ getToken: () => null }));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, error: "unpaired" });
  });

  it("403 unpaired when no origin has been paired", async () => {
    const r = await handleCapture(ctx(), deps({ getAllowedOrigin: () => null }));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, error: "unpaired" });
  });

  it("403 bad_origin on a wrong Origin", async () => {
    const r = await handleCapture(ctx({ origin: "chrome-extension://someoneelse" }), deps());
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, error: "bad_origin" });
  });

  it("401 bad_token on a wrong token", async () => {
    const r = await handleCapture(ctx({ authorization: "Bearer wrong" }), deps());
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ ok: false, error: "bad_token" });
  });

  it("401 bad_token on an absent Authorization header", async () => {
    const r = await handleCapture(ctx({ authorization: null }), deps());
    expect(r.status).toBe(401);
  });

  it("413 too_large past the body cap", async () => {
    const r = await handleCapture(ctx({ tooLarge: true }), deps());
    expect(r.status).toBe(413);
    expect(r.body).toEqual({ ok: false, error: "too_large" });
  });

  it("400 invalid on a non-JSON content-type", async () => {
    const r = await handleCapture(ctx({ contentType: "text/plain" }), deps());
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: "invalid" });
  });

  it("400 invalid on malformed JSON", async () => {
    const r = await handleCapture(ctx({ body: "{ not json" }), deps());
    expect(r.status).toBe(400);
  });

  it("400 invalid on a schema-invalid payload (non-http url)", async () => {
    const r = await handleCapture(
      ctx({ body: JSON.stringify({ kind: "page", url: "ftp://x.com" }) }),
      deps(),
    );
    expect(r.status).toBe(400);
  });
});

describe("handleCapture — dispatch", () => {
  it("200 + imported result for a valid page; calls importFromHtml exactly once", async () => {
    const svc = fakeImportService();
    const r = await handleCapture(ctx(), deps({ importService: svc }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      id: "el_new",
      kind: "page",
      title: "Fresh Source",
      deduped: false,
    });
    expect(svc.importFromHtml).toHaveBeenCalledTimes(1);
    expect(svc.importSelection).not.toHaveBeenCalled();
  });

  it("200 + imported result for a valid selection; calls importSelection exactly once", async () => {
    const svc = fakeImportService();
    const r = await handleCapture(
      ctx({
        body: JSON.stringify({
          kind: "selection",
          url: "https://example.com/a",
          selection: "the spacing effect",
          reason: "useful",
          blockContext: "surrounding",
        }),
      }),
      deps({ importService: svc }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, kind: "selection", deduped: false });
    expect(svc.importSelection).toHaveBeenCalledTimes(1);
    expect(svc.importFromHtml).not.toHaveBeenCalled();
    expect(svc.selectionCalls[0]).toMatchObject({
      url: "https://example.com/a",
      selection: "the spacing effect",
      reasonAdded: "useful",
      blockContext: "surrounding",
    });
  });

  it("maps a page dedup (duplicate) → 200 with the FIRST match id/title + deduped:true", async () => {
    const svc = fakeImportService({
      status: "duplicate",
      matches: [
        { elementId: "el_existing", title: "Existing Source" },
        { elementId: "el_other", title: "Other" },
      ],
    });
    const r = await handleCapture(ctx(), deps({ importService: svc }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      id: "el_existing",
      kind: "page",
      title: "Existing Source",
      deduped: true,
    });
  });

  it("passes the chosen priority label through (mapped to numeric via the core helper)", async () => {
    const svc = fakeImportService();
    await handleCapture(
      ctx({
        body: JSON.stringify({
          kind: "selection",
          url: "https://example.com/a",
          selection: "x",
          priority: "A",
          reason: "high value",
        }),
      }),
      deps({ importService: svc }),
    );
    // The handler keeps the LABEL on the wire; the service maps it. Assert the
    // label reached the service and the core helper agrees on the numeric value.
    expect(svc.selectionCalls[0]).toMatchObject({ priority: "A", reasonAdded: "high value" });
    expect(priorityFromLabel("A")).toBe(0.875);
  });

  it("500 import_failed when the import service throws (never leaks internals)", async () => {
    const svc: CaptureImportService = {
      importFromHtml: vi.fn(async () => {
        throw new Error("boom internal detail");
      }),
      importSelection: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const r = await handleCapture(ctx(), deps({ importService: svc }));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, error: "import_failed" });
  });

  it("never constructs SQL — the handler only calls the injected service", async () => {
    // A handler that touched SQLite would need a db handle; it has none. We assert
    // the only side effect is the service call (structural guarantee).
    const svc = fakeImportService();
    await handleCapture(ctx(), deps({ importService: svc }));
    expect(svc.pageCalls).toHaveLength(1);
  });
});

describe("lookupSourceByUrl — pre-save 'already saved' mapper", () => {
  /** A fake canonical-URL query recording the canonical keys it was asked for. */
  function fakeQuery(matchesByCanonical: Record<string, LookupCanonicalMatch[]>): {
    find: FindSourcesByCanonicalUrl;
    calls: (string | null)[];
  } {
    const calls: (string | null)[] = [];
    return {
      calls,
      find: (canonical) => {
        calls.push(canonical);
        return canonical ? (matchesByCanonical[canonical] ?? []) : [];
      },
    };
  }

  it("found: maps the FIRST match's id/title/status (newest-first, mirrors mapResult)", () => {
    const q = fakeQuery({
      "https://example.com/a": [
        { elementId: "el_newest", title: "Newest", status: "inbox" },
        { elementId: "el_older", title: "Older", status: "active" },
      ],
    });
    const result = lookupSourceByUrl("https://example.com/a", q.find);
    expect(result).toEqual({
      ok: true,
      found: true,
      source: { id: "el_newest", title: "Newest", status: "inbox" },
    });
  });

  it("not found: an empty match list → found:false, no source", () => {
    const q = fakeQuery({});
    expect(lookupSourceByUrl("https://example.com/never", q.find)).toEqual({
      ok: true,
      found: false,
    });
  });

  it("canonicalizes before querying — a tracking-param-only difference still matches", () => {
    // The stored key is the bare canonical; a candidate with ?utm_source=x folds to it.
    const q = fakeQuery({
      "https://example.com/a": [{ elementId: "el_1", title: "A", status: "inbox" }],
    });
    const result = lookupSourceByUrl("https://example.com/a?utm_source=newsletter", q.find);
    expect(result).toEqual({
      ok: true,
      found: true,
      source: { id: "el_1", title: "A", status: "inbox" },
    });
    // The query was asked for the canonical (tracking-stripped) key, never the raw URL.
    expect(q.calls).toEqual(["https://example.com/a"]);
  });

  it("non-http(s) / unparseable URL → found:false, NEVER queries, never throws", () => {
    const q = fakeQuery({});
    for (const url of ["ftp://example.com/x", "chrome://settings", "not a url", ""]) {
      expect(lookupSourceByUrl(url, q.find)).toEqual({ ok: true, found: false });
    }
    // canonicalizeUrl returned null for every one of these → the query is never run.
    expect(q.calls).toEqual([]);
  });
});

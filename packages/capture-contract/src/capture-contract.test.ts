/**
 * Unit tests for the framework-free capture contract (T062).
 *
 * These run with NEITHER Chrome NOR Electron — proving the contract + its pure
 * shaping/validation helpers are importable and testable in isolation (which is
 * the whole point of the package: a clean seam both sides share).
 */

import { describe, expect, it } from "vitest";
import {
  CaptureRequestSchema,
  CaptureResponseSchema,
  DEFAULT_CAPTURE_PRIORITY,
  LookupSourceErrorResponseSchema,
  LookupSourceRequestSchema,
  LookupSourceResponseSchema,
  OpenSourceErrorResponseSchema,
  OpenSourceRequestSchema,
  OpenSourceResponseSchema,
  PairingPingResponseSchema,
  shapeCapture,
  timingSafeTokenEqual,
  validateOrigin,
} from "./index";

describe("CaptureRequestSchema (discriminated union)", () => {
  it("accepts a valid page payload", () => {
    const parsed = CaptureRequestSchema.parse({
      kind: "page",
      url: "https://example.com/post",
      title: "A post",
      html: "<html><body><p>hi</p></body></html>",
      priority: "B",
      reason: "useful",
    });
    expect(parsed.kind).toBe("page");
  });

  it("accepts a valid selection payload", () => {
    const parsed = CaptureRequestSchema.parse({
      kind: "selection",
      url: "https://example.com/post",
      selection: "the spacing effect is real",
      priority: "A",
      reason: "why",
      blockContext: "surrounding text",
    });
    expect(parsed.kind).toBe("selection");
    if (parsed.kind === "selection") {
      expect(parsed.selection).toContain("spacing");
    }
  });

  it("rejects a page payload missing the url", () => {
    expect(() => CaptureRequestSchema.parse({ kind: "page" })).toThrow();
  });

  it("rejects a non-http(s) url", () => {
    expect(() =>
      CaptureRequestSchema.parse({ kind: "page", url: "ftp://example.com/x" }),
    ).toThrow();
    expect(() => CaptureRequestSchema.parse({ kind: "page", url: "file:///etc/passwd" })).toThrow();
    expect(() =>
      CaptureRequestSchema.parse({
        kind: "selection",
        url: "javascript:alert(1)",
        selection: "x",
      }),
    ).toThrow();
  });

  it("rejects a bad priority label", () => {
    expect(() =>
      CaptureRequestSchema.parse({ kind: "page", url: "https://x.com", priority: "Z" }),
    ).toThrow();
  });

  it("rejects an oversized selection (> 500k chars)", () => {
    expect(() =>
      CaptureRequestSchema.parse({
        kind: "selection",
        url: "https://x.com",
        selection: "x".repeat(500_001),
      }),
    ).toThrow();
  });

  it("rejects an empty selection", () => {
    expect(() =>
      CaptureRequestSchema.parse({ kind: "selection", url: "https://x.com", selection: "   " }),
    ).toThrow();
  });

  it("rejects an unknown kind (the discriminated-union boundary)", () => {
    expect(() => CaptureRequestSchema.parse({ kind: "video", url: "https://x.com" })).toThrow();
  });
});

describe("CaptureResponseSchema / PairingPingResponseSchema", () => {
  it("round-trips a success body", () => {
    const ok = CaptureResponseSchema.parse({
      ok: true,
      id: "el_1",
      kind: "page",
      title: "T",
      deduped: false,
    });
    expect(ok.deduped).toBe(false);
  });

  it("round-trips a ping body", () => {
    const ping = PairingPingResponseSchema.parse({ ok: true, app: "interleave", version: "0.1.1" });
    expect(ping.app).toBe("interleave");
  });

  it("rejects a ping with the wrong app name", () => {
    expect(() =>
      PairingPingResponseSchema.parse({ ok: true, app: "other", version: "1" }),
    ).toThrow();
  });
});

describe("OpenSourceRequestSchema / OpenSourceResponseSchema", () => {
  it("accepts a source id and defaults activation on", () => {
    const parsed = OpenSourceRequestSchema.parse({ id: "src_123" });
    expect(parsed).toEqual({ id: "src_123", activate: true });
  });

  it("allows activation to be disabled explicitly", () => {
    expect(OpenSourceRequestSchema.parse({ id: "src_123", activate: false })).toEqual({
      id: "src_123",
      activate: false,
    });
  });

  it("rejects empty or oversized ids", () => {
    expect(() => OpenSourceRequestSchema.parse({ id: "   " })).toThrow();
    expect(() => OpenSourceRequestSchema.parse({ id: "x".repeat(129) })).toThrow();
  });

  it("round-trips an open-source success body", () => {
    const body = OpenSourceResponseSchema.parse({ ok: true, id: "src_123", activated: true });
    expect(body.activated).toBe(true);
  });

  it("accepts only documented open-source error bodies", () => {
    for (const error of [
      "unpaired",
      "bad_token",
      "bad_origin",
      "too_large",
      "invalid",
      "not_found",
      "open_failed",
    ]) {
      expect(OpenSourceErrorResponseSchema.parse({ ok: false, error })).toEqual({
        ok: false,
        error,
      });
    }

    expect(() => OpenSourceErrorResponseSchema.parse({ ok: false, error: "sql_error" })).toThrow();
    expect(() => OpenSourceErrorResponseSchema.parse({ ok: false, error: "deleted" })).toThrow();
  });
});

describe("LookupSourceRequestSchema (permissive — canonicalization gates, not the schema)", () => {
  it("accepts a valid http(s) url", () => {
    expect(LookupSourceRequestSchema.parse({ url: "https://example.com/post" })).toEqual({
      url: "https://example.com/post",
    });
  });

  it("rejects an empty url", () => {
    expect(() => LookupSourceRequestSchema.parse({ url: "" })).toThrow();
    expect(() => LookupSourceRequestSchema.parse({ url: "   " })).toThrow();
  });

  it("rejects a url longer than 2048 chars", () => {
    expect(() =>
      LookupSourceRequestSchema.parse({ url: `https://x.com/${"a".repeat(2048)}` }),
    ).toThrow();
  });

  it("ACCEPTS a non-http(s) url (the desktop canonicalizes → found:false, not a 400)", () => {
    // KTD3: the request schema is permissive on purpose; only canonicalization
    // decides. A non-http(s) value must parse so the route can answer found:false.
    expect(LookupSourceRequestSchema.parse({ url: "ftp://example.com/x" })).toEqual({
      url: "ftp://example.com/x",
    });
    expect(LookupSourceRequestSchema.parse({ url: "chrome://settings" })).toEqual({
      url: "chrome://settings",
    });
    expect(LookupSourceRequestSchema.parse({ url: "not a url at all" })).toEqual({
      url: "not a url at all",
    });
  });
});

describe("LookupSourceResponseSchema / LookupSourceErrorResponseSchema", () => {
  it("round-trips a found body with a source", () => {
    const body = LookupSourceResponseSchema.parse({
      ok: true,
      found: true,
      source: { id: "src_123", title: "Existing", status: "inbox" },
    });
    expect(body.found).toBe(true);
    // `found: true` narrows the union arm that guarantees `source`.
    if (body.found) {
      expect(body.source).toEqual({ id: "src_123", title: "Existing", status: "inbox" });
    }
  });

  it("round-trips a not-found body without a source", () => {
    const body = LookupSourceResponseSchema.parse({ ok: true, found: false });
    expect(body.found).toBe(false);
  });

  it("REJECTS a found:true body with no source (the discriminated union enforces found ⇒ source)", () => {
    // A `{ found: true }` with no source must NOT parse — otherwise the client would
    // silently treat it as "not found". The union makes the guarantee structural.
    expect(() => LookupSourceResponseSchema.parse({ ok: true, found: true })).toThrow();
  });

  it("accepts only documented lookup-source error bodies", () => {
    for (const error of [
      "unpaired",
      "bad_token",
      "bad_origin",
      "too_large",
      "invalid",
      "lookup_failed",
    ]) {
      expect(LookupSourceErrorResponseSchema.parse({ ok: false, error })).toEqual({
        ok: false,
        error,
      });
    }

    expect(() =>
      LookupSourceErrorResponseSchema.parse({ ok: false, error: "not_found" }),
    ).toThrow();
    expect(() =>
      LookupSourceErrorResponseSchema.parse({ ok: false, error: "sql_error" }),
    ).toThrow();
  });
});

describe("shapeCapture", () => {
  it("defaults priority to C when omitted", () => {
    const shaped = shapeCapture({ kind: "page", url: "https://x.com/a" });
    expect(shaped.priority).toBe(DEFAULT_CAPTURE_PRIORITY);
    expect(shaped.priority).toBe("C");
  });

  it("trims the url/title/reason and drops empty optionals", () => {
    const shaped = shapeCapture({
      kind: "selection",
      url: "  https://x.com/a  ",
      title: "   ",
      selection: "  hello world  ",
      reason: "  because  ",
      blockContext: "   ",
    });
    expect(shaped.url).toBe("https://x.com/a");
    expect("title" in shaped).toBe(false);
    if (shaped.kind === "selection") {
      expect(shaped.selection).toBe("hello world");
      expect(shaped.reason).toBe("because");
      expect("blockContext" in shaped).toBe(false);
    }
  });

  it("carries an explicit priority + reason through (T063 panel path)", () => {
    const shaped = shapeCapture({
      kind: "selection",
      url: "https://x.com/a",
      selection: "x",
      priority: "A",
      reason: "high value",
    });
    expect(shaped.priority).toBe("A");
    if (shaped.kind === "selection") expect(shaped.reason).toBe("high value");
  });

  it("defaults a selection's priority to C when the panel omits it (T063)", () => {
    const shaped = shapeCapture({
      kind: "selection",
      url: "https://x.com/a",
      selection: "the spacing effect",
      reason: "panel reason",
    });
    expect(shaped.kind).toBe("selection");
    expect(shaped.priority).toBe(DEFAULT_CAPTURE_PRIORITY);
    expect(shaped.priority).toBe("C");
    if (shaped.kind === "selection") expect(shaped.reason).toBe("panel reason");
  });

  it("clamps an over-long reason to the schema cap (does not throw)", () => {
    const shaped = shapeCapture({
      kind: "selection",
      url: "https://x.com/a",
      selection: "x",
      reason: "y".repeat(5000),
    });
    if (shaped.kind === "selection") {
      expect(shaped.reason?.length).toBeLessThanOrEqual(2048);
    }
  });

  it("throws on a non-http url even after shaping", () => {
    expect(() => shapeCapture({ kind: "page", url: "ftp://x.com/a" })).toThrow();
  });
});

describe("validateOrigin", () => {
  const allowed = "chrome-extension://abcdefghijklmnop";

  it("exact-matches the paired origin", () => {
    expect(validateOrigin(allowed, allowed)).toBe(true);
  });

  it("rejects a near-miss (one extra char)", () => {
    expect(validateOrigin("chrome-extension://abcdefghijklmnopq", allowed)).toBe(false);
    expect(validateOrigin("chrome-extension://abcdefghijklmno", allowed)).toBe(false);
  });

  it("rejects a null/empty request origin", () => {
    expect(validateOrigin(null, allowed)).toBe(false);
    expect(validateOrigin("", allowed)).toBe(false);
    expect(validateOrigin(undefined, allowed)).toBe(false);
  });

  it("rejects when no origin has been paired (unpaired)", () => {
    expect(validateOrigin(allowed, null)).toBe(false);
    expect(validateOrigin(allowed, "")).toBe(false);
  });

  it("rejects an http(s) page origin posing as the extension", () => {
    expect(validateOrigin("https://evil.example.com", allowed)).toBe(false);
    expect(validateOrigin("http://localhost:3000", allowed)).toBe(false);
  });
});

describe("timingSafeTokenEqual", () => {
  it("is true for identical tokens", () => {
    expect(timingSafeTokenEqual("abc123", "abc123")).toBe(true);
  });

  it("is false for different same-length tokens", () => {
    expect(timingSafeTokenEqual("abc123", "abc124")).toBe(false);
  });

  it("is length-mismatch-safe (false, never throws)", () => {
    expect(timingSafeTokenEqual("abc", "abcd")).toBe(false);
    expect(timingSafeTokenEqual("", "x")).toBe(false);
    expect(timingSafeTokenEqual("abcd", "")).toBe(false);
  });

  it("is true for two empty strings", () => {
    expect(timingSafeTokenEqual("", "")).toBe(true);
  });
});

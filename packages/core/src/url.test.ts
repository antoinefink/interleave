/**
 * URL canonicalization tests (T014).
 *
 * Pin the conservative normalization contract the provenance derivation depends
 * on: tracking params stripped, fragment dropped, host lowercased, garbage → null,
 * and idempotence (an already-canonical URL is stable). Designed so the M12
 * duplicate-detection work (T061) can reuse the same guarantees.
 */

import { describe, expect, it } from "vitest";
import { canonicalizeUrl } from "./url";

describe("canonicalizeUrl", () => {
  it("strips utm_* tracking params", () => {
    expect(canonicalizeUrl("https://example.com/post?utm_source=x&utm_medium=y&id=42")).toBe(
      "https://example.com/post?id=42",
    );
  });

  it("strips fbclid / gclid and friends", () => {
    expect(canonicalizeUrl("https://example.com/a?fbclid=abc")).toBe("https://example.com/a");
    expect(canonicalizeUrl("https://example.com/a?gclid=abc&keep=1")).toBe(
      "https://example.com/a?keep=1",
    );
  });

  it("drops the fragment", () => {
    expect(canonicalizeUrl("https://example.com/doc#section-3")).toBe("https://example.com/doc");
  });

  it("lowercases the host but preserves path/query case", () => {
    expect(canonicalizeUrl("https://EXAMPLE.com/MixedCase?A=B")).toBe(
      "https://example.com/MixedCase?A=B",
    );
  });

  it("trims a redundant trailing slash on the path", () => {
    expect(canonicalizeUrl("https://example.com/a/b/")).toBe("https://example.com/a/b");
  });

  it("keeps the bare root path's slash", () => {
    expect(canonicalizeUrl("https://example.com/")).toBe("https://example.com/");
    expect(canonicalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  it("returns null for null / empty / whitespace / garbage input", () => {
    expect(canonicalizeUrl(null)).toBeNull();
    expect(canonicalizeUrl(undefined)).toBeNull();
    expect(canonicalizeUrl("")).toBeNull();
    expect(canonicalizeUrl("   ")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
    expect(canonicalizeUrl("ftp://example.com/file")).toBeNull();
    expect(canonicalizeUrl("mailto:a@b.com")).toBeNull();
  });

  it("is idempotent — an already-canonical URL is stable", () => {
    const once = canonicalizeUrl("https://EXAMPLE.com/post/?utm_source=x#frag");
    expect(once).toBe("https://example.com/post");
    expect(canonicalizeUrl(once)).toBe(once);
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(canonicalizeUrl("  https://example.com/x  ")).toBe("https://example.com/x");
  });

  it("preserves a non-tracking query and its param order", () => {
    expect(canonicalizeUrl("https://example.com/s?q=fsrs&page=2&utm_campaign=z")).toBe(
      "https://example.com/s?q=fsrs&page=2",
    );
  });
});

/**
 * Tests for the source-reference citation formatter (T043). `formatSourceRef` is
 * the one place the refblock's citation/location/href are assembled, reused by
 * review / extract view / inspector / library — so it must omit missing fields
 * cleanly, derive a usable href, and degrade gracefully to the orphan case.
 */

import { describe, expect, it } from "vitest";
import { EMPTY_SOURCE_REF, formatSourceRef, type SourceRef } from "./source-ref";

const FULL: SourceRef = {
  sourceElementId: "src-1",
  sourceTitle: "On the Measure of Intelligence",
  url: "https://arxiv.org/abs/1911.01547",
  author: "François Chollet",
  publishedAt: "2019-11-05T00:00:00.000Z",
  locationLabel: "Definition · ¶ 4",
  snippet: "Intelligence is skill-acquisition efficiency.",
};

describe("formatSourceRef", () => {
  it("assembles a citation from author / title / year", () => {
    const out = formatSourceRef(FULL);
    expect(out.citation).toBe("François Chollet. On the Measure of Intelligence (2019)");
    expect(out.locationLabel).toBe("Definition · ¶ 4");
    expect(out.href).toBe("https://arxiv.org/abs/1911.01547");
    expect(out.snippet).toBe("Intelligence is skill-acquisition efficiency.");
    expect(out.hasSource).toBe(true);
  });

  it("omits missing fields cleanly", () => {
    const out = formatSourceRef({ ...FULL, author: null });
    expect(out.citation).toBe("On the Measure of Intelligence (2019)");

    const noYear = formatSourceRef({ ...FULL, publishedAt: null });
    expect(noYear.citation).toBe("François Chollet. On the Measure of Intelligence");

    const titleOnly = formatSourceRef({
      ...EMPTY_SOURCE_REF,
      sourceTitle: "Some Title",
    });
    expect(titleOnly.citation).toBe("Some Title");
    expect(titleOnly.hasSource).toBe(true);
  });

  it("derives a year from a loose date string without aggressive reformatting", () => {
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, publishedAt: "2019" }).citation).toBe("(2019)");
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, publishedAt: "Nov 5, 2019" }).citation).toBe(
      "(2019)",
    );
    // A non-date string yields no year (and no throw).
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, publishedAt: "soon" }).citation).toBe("");
  });

  it("produces a usable href from a URL (and prefixes a scheme-less host)", () => {
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, url: "https://x.com/a" }).href).toBe(
      "https://x.com/a",
    );
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, url: "example.com/path" }).href).toBe(
      "https://example.com/path",
    );
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, url: "http://incompleteideas.net/x" }).href).toBe(
      "http://incompleteideas.net/x",
    );
    // An unusable / empty URL degrades to no link (never throws).
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, url: "not a url" }).href).toBeNull();
    expect(formatSourceRef({ ...EMPTY_SOURCE_REF, url: "  " }).href).toBeNull();
  });

  it("returns a calm orphan result when everything is null", () => {
    const out = formatSourceRef(null);
    expect(out.citation).toBe("");
    expect(out.href).toBeNull();
    expect(out.locationLabel).toBeNull();
    expect(out.snippet).toBeNull();
    expect(out.hasSource).toBe(false);

    const empty = formatSourceRef(EMPTY_SOURCE_REF);
    expect(empty.hasSource).toBe(false);
  });

  it("trims blank-but-present fields to the orphan case", () => {
    const out = formatSourceRef({
      ...EMPTY_SOURCE_REF,
      sourceTitle: "   ",
      author: "",
      snippet: "  ",
    });
    expect(out.citation).toBe("");
    expect(out.snippet).toBeNull();
    expect(out.hasSource).toBe(false);
  });
});

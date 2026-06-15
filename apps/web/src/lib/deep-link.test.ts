import { describe, expect, it } from "vitest";
import { elementDeepLink, elementRoutePath } from "./deep-link";

describe("elementDeepLink", () => {
  it("builds the canonical interleave://element/<id> reference string", () => {
    expect(elementDeepLink("abc")).toBe("interleave://element/abc");
  });

  it("trims surrounding whitespace from the id", () => {
    expect(elementDeepLink("  abc  ")).toBe("interleave://element/abc");
  });

  it("throws on an empty id", () => {
    expect(() => elementDeepLink("")).toThrow("elementDeepLink: empty element id");
  });

  it("throws on a whitespace-only id", () => {
    expect(() => elementDeepLink("   ")).toThrow("elementDeepLink: empty element id");
  });
});

describe("elementRoutePath", () => {
  it("maps a source node to the /source/$id reader route", () => {
    expect(elementRoutePath("source", "s1")).toBe("/source/s1");
  });

  it("maps a topic node to the shared /source/$id route", () => {
    expect(elementRoutePath("topic", "t1")).toBe("/source/t1");
  });

  it("maps an extract node to the /extract/$id route", () => {
    expect(elementRoutePath("extract", "e1")).toBe("/extract/e1");
  });

  it("maps a card node to the /card/$id route", () => {
    expect(elementRoutePath("card", "c1")).toBe("/card/c1");
  });

  it("falls back to the non-navigating deep-link string for unknown types", () => {
    // There is no /element/$id route, so an unknown type must NOT fabricate a
    // route; it returns the canonical reference string instead (KTD4).
    expect(elementRoutePath("synthesis_note", "x1")).toBe("interleave://element/x1");
    expect(elementRoutePath("", "x1")).toBe("interleave://element/x1");
  });
});

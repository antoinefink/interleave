import { describe, expect, it } from "vitest";
import { CAPTURED_VIA, type CapturedVia, capturedViaLabel, isCapturedVia } from "./index";

/**
 * Capture-origin tests (T126).
 *
 * `captured_via` is the queryable origin the inbox groups by. The closed tuple is
 * the single source of truth for the `sources.captured_via` CHECK, and the label
 * helper drives the group-by header — so we pin both the tuple shape and that every
 * value (plus null / unknown → "Other") maps to a stable human label.
 */
describe("CAPTURED_VIA tuple", () => {
  it("is the closed set of five capture origins", () => {
    expect(CAPTURED_VIA).toEqual(["manual", "url", "extension", "highlight_import", "file"]);
  });
});

describe("isCapturedVia", () => {
  it("accepts every canonical origin and rejects anything else", () => {
    for (const origin of CAPTURED_VIA) {
      expect(isCapturedVia(origin)).toBe(true);
    }
    expect(isCapturedVia("other")).toBe(false);
    expect(isCapturedVia("URL")).toBe(false);
    expect(isCapturedVia(null)).toBe(false);
    expect(isCapturedVia(undefined)).toBe(false);
    expect(isCapturedVia(42)).toBe(false);
  });
});

describe("capturedViaLabel", () => {
  it("maps each origin to its human label", () => {
    const expected: Record<CapturedVia, string> = {
      manual: "Manual",
      url: "URL",
      extension: "Extension",
      highlight_import: "Highlight import",
      file: "File",
    };
    for (const origin of CAPTURED_VIA) {
      expect(capturedViaLabel(origin)).toBe(expected[origin]);
    }
  });

  it("falls back to 'Other' for a null (legacy / un-recorded) origin", () => {
    expect(capturedViaLabel(null)).toBe("Other");
  });

  it("falls back to 'Other' for an unknown string origin", () => {
    expect(capturedViaLabel("legacy_value" as CapturedVia)).toBe("Other");
  });
});

/**
 * Window navigation-guard tests (T007 hardening).
 *
 * Covers the pure decision functions behind `setWindowOpenHandler` and
 * `will-navigate`: every renderer-initiated popup is denied, http(s) provenance
 * links (SourceReader "Open original", RefBlock) are routed to the OS browser,
 * and in-window navigation is restricted to the trusted renderer origin so
 * remote content can never replace the `app://` renderer in place.
 *
 * Electron is mocked because these run under Vitest (no Electron runtime);
 * `decideWindowOpen` / `isAllowedNavigation` are pure and need no window.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() },
}));

import { decideWindowOpen, isAllowedNavigation } from "./window";

describe("decideWindowOpen", () => {
  it("routes http(s) URLs to the OS browser and still denies the popup", () => {
    expect(decideWindowOpen("https://example.com/article")).toEqual({
      action: "deny",
      openExternal: "https://example.com/article",
    });
    expect(decideWindowOpen("http://example.com/x")).toEqual({
      action: "deny",
      openExternal: "http://example.com/x",
    });
    // Case-insensitive scheme match.
    expect(decideWindowOpen("HTTPS://Example.com")).toEqual({
      action: "deny",
      openExternal: "HTTPS://Example.com",
    });
  });

  it("denies non-http(s) URLs without opening anything external", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "app://bundle/evil",
      "data:text/html,<script>1</script>",
      "about:blank",
    ]) {
      expect(decideWindowOpen(url)).toEqual({ action: "deny" });
    }
  });
});

describe("isAllowedNavigation", () => {
  const prod = ["app://bundle/"];
  const dev = ["app://bundle/", "http://localhost:5173"];

  it("allows navigation that stays on the trusted renderer origin", () => {
    expect(isAllowedNavigation("app://bundle/", prod)).toBe(true);
    expect(isAllowedNavigation("app://bundle/review", prod)).toBe(true);
  });

  it("allows the dev server origin only when it is configured", () => {
    expect(isAllowedNavigation("http://localhost:5173/queue", dev)).toBe(true);
    expect(isAllowedNavigation("http://localhost:5173/queue", prod)).toBe(false);
  });

  it("blocks navigation to any other origin", () => {
    for (const url of [
      "https://example.com",
      "http://evil.test/phish",
      "file:///etc/passwd",
      "app://other/",
    ]) {
      expect(isAllowedNavigation(url, prod)).toBe(false);
    }
  });

  it("never treats an empty allowed origin as a wildcard match", () => {
    // A blank dev-server string must not match every URL.
    expect(isAllowedNavigation("https://example.com", ["app://bundle/", ""])).toBe(false);
  });
});

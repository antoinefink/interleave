/* @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const releasesUrl = "https://github.com/antoinefink/incremental-reading/releases";

function parseHomepage(): Document {
  const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

describe("static homepage contract", () => {
  it("keeps the final design structure focused on incremental reading", () => {
    const doc = parseHomepage();

    expect(doc.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Read incrementally. Remember for good.",
    );
    expect(doc.querySelector('[aria-label="Live reader to extract demo"]')).not.toBeNull();
    expect(doc.getElementById("how")).not.toBeNull();
    expect(doc.getElementById("features")).not.toBeNull();
    expect(doc.querySelectorAll('[data-action="extract"]')).toHaveLength(1);
    expect(doc.querySelectorAll('[data-action="cloze"]')).toHaveLength(1);
    expect(doc.querySelectorAll('[data-action="highlight"]')).toHaveLength(1);
  });

  it("routes every download affordance to GitHub Releases only", () => {
    const doc = parseHomepage();
    const downloadLinks = Array.from(doc.querySelectorAll<HTMLAnchorElement>("a")).filter((link) =>
      /download|release/i.test(link.textContent ?? ""),
    );

    expect(downloadLinks.length).toBeGreaterThan(0);
    expect(downloadLinks.map((link) => link.href)).toEqual(
      Array.from({ length: downloadLinks.length }, () => releasesUrl),
    );
    expect(downloadLinks.some((link) => /\.(dmg|zip|pkg)$/i.test(link.href))).toBe(false);
  });

  it("keeps the footer link lists trimmed", () => {
    const doc = parseHomepage();
    const footerLinks = Array.from(
      doc.querySelectorAll<HTMLAnchorElement>(".site-footer .footer-col a"),
    );

    expect(
      footerLinks.map((link) => ({
        href: link.href,
        label: link.textContent?.replace(/\s+/g, " ").trim(),
      })),
    ).toEqual(
      [
        ["Releases", releasesUrl],
        ["Source code", "https://github.com/antoinefink/incremental-reading"],
        ["@antoinefink", "https://antoine.fi/"],
      ].map(([label, href]) => ({ href, label })),
    );
  });

  it("does not reintroduce removed prototype affordances or desktop-only runtime hooks", () => {
    const html = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");

    for (const forbidden of [
      "xattr",
      "quarantine",
      "Star on GitHub",
      "theme toggle",
      "theme-toggle",
      "version",
      "window.appApi",
      "nodeIntegration",
      "db.query",
      "better-sqlite3",
      "fs.readFile",
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });
});

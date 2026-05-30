/**
 * Migrations resolver tests (T007).
 *
 * `resolveMigrationsDir` picks the Drizzle migrations folder from a small
 * ordered candidate list (the copy staged next to the compiled main first, the
 * workspace package as a dev fallback) and throws a descriptive error when none
 * contains a `meta/_journal.json`. A regression here only surfaces at startup,
 * so the candidate ordering + throw-on-missing behaviour is covered directly.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveMigrationsDir } from "./migrations";

let root: string;

/** Create a folder that looks like a Drizzle migrations dir. */
function makeMigrationsFolder(dir: string): string {
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ entries: [] }));
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-migrations-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveMigrationsDir", () => {
  it("prefers the copy staged next to the compiled main (dist/drizzle)", () => {
    const distDir = path.join(root, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    const staged = makeMigrationsFolder(path.join(distDir, "drizzle"));
    // Also create the workspace fallback so we prove ordering, not just presence.
    makeMigrationsFolder(path.resolve(distDir, "..", "..", "..", "packages", "db", "drizzle"));

    expect(resolveMigrationsDir(distDir)).toBe(staged);
  });

  it("falls back to the workspace package when no copy is staged", () => {
    const distDir = path.join(root, "apps", "desktop", "dist");
    fs.mkdirSync(distDir, { recursive: true });
    const workspace = makeMigrationsFolder(
      path.resolve(distDir, "..", "..", "..", "packages", "db", "drizzle"),
    );

    expect(resolveMigrationsDir(distDir)).toBe(workspace);
  });

  it("throws a descriptive error listing the candidates when none is found", () => {
    // Nest `dist` deep enough that the workspace fallback (../../../packages/db/
    // drizzle) resolves inside this temp root — never to a real on-disk folder.
    const distDir = path.join(root, "apps", "desktop", "dist");
    fs.mkdirSync(distDir, { recursive: true });

    expect(() => resolveMigrationsDir(distDir)).toThrow(/Could not locate the Drizzle migrations/);
    expect(() => resolveMigrationsDir(distDir)).toThrow(/drizzle/);
  });
});

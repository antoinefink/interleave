import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const existsSync = vi.fn<(p: string) => boolean>();

vi.mock("node:fs", () => ({
  default: { existsSync: (p: string) => existsSync(p) },
}));

import { resolveSqliteVecBinary } from "./sqlite-vec-binding";

const sep = path.sep;

function vecName(): string {
  switch (process.platform) {
    case "darwin":
      return "vec0.dylib";
    case "win32":
      return "vec0.dll";
    default:
      return "vec0.so";
  }
}

afterEach(() => {
  existsSync.mockReset();
});

describe("resolveSqliteVecBinary", () => {
  it("prefers the app.asar.unpacked vec0 binary over the in-asar candidate", () => {
    const distDir = path.join(sep, "App", "Contents", "Resources", "app.asar", "dist");
    const inAsar = path.resolve(distDir, "..", "native", vecName());
    const unpacked = inAsar.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);

    existsSync.mockImplementation((p) => p === unpacked || p === inAsar);

    expect(resolveSqliteVecBinary(distDir)).toBe(unpacked);
  });

  it("uses the vendored dev binary next to dist before falling back to npm resolution", () => {
    const distDir = path.join(sep, "repo", "apps", "desktop", "dist");
    const vendored = path.resolve(distDir, "..", "native", vecName());

    existsSync.mockImplementation((p) => p === vendored);

    expect(resolveSqliteVecBinary(distDir)).toBe(vendored);
  });

  it("returns undefined when no vendored binary exists", () => {
    existsSync.mockReturnValue(false);

    expect(resolveSqliteVecBinary(path.join(sep, "repo", "apps", "desktop", "dist"))).toBe(
      undefined,
    );
  });
});

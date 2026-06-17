/**
 * Shared `asarUnpackedVariant` tests (U1).
 *
 * The `app.asar` → `app.asar.unpacked` rewrite is a packaging-critical invariant
 * shared by every native-asset resolver (the SQLite addon, the `vec0` loadable
 * extension, and the embed worker's model dir). CI never builds a packaged app,
 * so this pure string rewrite — the `${sep}app.asar${sep}` marker semantics — is
 * covered here. Paths are normalized with `path.sep` so assertions hold on every
 * platform.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";

import { asarUnpackedVariant } from "./asar";

const sep = path.sep;

describe("asarUnpackedVariant", () => {
  it("rewrites an in-asar path to its app.asar.unpacked sibling", () => {
    const inAsar = path.join(
      sep,
      "App",
      "Contents",
      "Resources",
      "app.asar",
      "native",
      "vec0.dylib",
    );

    const result = asarUnpackedVariant(inAsar);

    expect(result).toContain(`${sep}app.asar.unpacked${sep}`);
    expect(result).toBe(inAsar.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`));
  });

  it("returns null when the path has no asar marker (dev/test)", () => {
    const devPath = path.join(sep, "repo", "apps", "desktop", "native", "vec0.dylib");

    expect(asarUnpackedVariant(devPath)).toBeNull();
  });

  it("rewrites only the first app.asar segment", () => {
    const nested = path.join(sep, "app.asar", "dist", "app.asar", "models");

    const result = asarUnpackedVariant(nested);

    expect(result).toBe(path.join(sep, "app.asar.unpacked", "dist", "app.asar", "models"));
  });

  it("returns null for an empty string", () => {
    expect(asarUnpackedVariant("")).toBeNull();
  });
});

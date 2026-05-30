/**
 * Native-binding resolver tests (T007 / packaging T050).
 *
 * The `app.asar` → `app.asar.unpacked` path rewrite is a packaging-critical
 * invariant that only takes effect inside a packaged `.app` (a native addon
 * cannot be `dlopen`ed from inside an asar archive). CI never builds a packaged
 * app, so this pure resolver — string rewrite + candidate ordering against
 * `fs.existsSync` — is covered here so a regression in the `${sep}app.asar${sep}`
 * marker or candidate ordering is caught.
 *
 * `node:fs` is mocked so `existsSync` is fully controlled; paths are normalized
 * with `path.sep` so the assertions hold on every platform.
 */

import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const existsSync = vi.fn<(p: string) => boolean>();
vi.mock("node:fs", () => ({ default: { existsSync: (p: string) => existsSync(p) } }));

import { resolveNativeBinding } from "./native-binding";

const sep = path.sep;

afterEach(() => {
  existsSync.mockReset();
});

describe("resolveNativeBinding", () => {
  it("prefers the app.asar.unpacked sibling over the in-asar path when packaged", () => {
    // Compiled main inside a packaged .app: …/Resources/app.asar/dist
    const distDir = path.join(sep, "App", "Contents", "Resources", "app.asar", "dist");
    const inAsar = path.resolve(distDir, "..", "native", "better_sqlite3.node");
    const unpacked = inAsar.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);

    // Both the in-asar and unpacked files "exist": the unpacked one must win.
    existsSync.mockImplementation((p: string) => p === unpacked || p === inAsar);

    expect(resolveNativeBinding(distDir)).toBe(unpacked);
    expect(unpacked).toContain(`${sep}app.asar.unpacked${sep}`);
  });

  it("falls back to the literal dev path when there is no asar", () => {
    // Dev layout: apps/desktop/dist, binary one level up at apps/desktop/native.
    const distDir = path.join(sep, "repo", "apps", "desktop", "dist");
    const devBinding = path.resolve(distDir, "..", "native", "better_sqlite3.node");

    existsSync.mockImplementation((p: string) => p === devBinding);

    expect(resolveNativeBinding(distDir)).toBe(devBinding);
    expect(devBinding).not.toContain("app.asar");
  });

  it("returns undefined when no candidate exists (caller falls back to default binding)", () => {
    existsSync.mockReturnValue(false);
    expect(resolveNativeBinding(path.join(sep, "anywhere", "dist"))).toBeUndefined();
  });

  it("uses the in-asar path only as a last-resort fallback when unpacked is missing", () => {
    const distDir = path.join(sep, "App", "Contents", "Resources", "app.asar", "dist");
    const inAsar = path.resolve(distDir, "..", "native", "better_sqlite3.node");

    // The unpacked sibling does NOT exist; the in-asar candidate does.
    existsSync.mockImplementation((p: string) => p === inAsar);

    expect(resolveNativeBinding(distDir)).toBe(inAsar);
  });
});

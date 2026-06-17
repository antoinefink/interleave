/**
 * Packaged `sqlite-vec` `vec0` binary resolver (T087).
 *
 * `sqlite-vec` is a loadable SQLite extension (`vec0.{dylib,so,dll}`) the main
 * process loads into the better-sqlite3 connection. Like the `better_sqlite3.node`
 * addon (`native-binding.ts`), a loadable extension CANNOT be `dlopen`ed from
 * inside an `app.asar` archive, so the binary is `asarUnpack`ed by electron-builder
 * to `app.asar.unpacked/native/…`, and this resolver prefers that real on-disk path.
 *
 * Resolution order:
 *  1. The vendored `apps/desktop/native/vec0.*` (the build-time copy — staged + the
 *     `app.asar.unpacked` rewrite preferred, mirroring `resolveNativeBinding`).
 *  2. The installed `sqlite-vec` npm package's host binary (dev / Vitest / scripts,
 *     where `node_modules` is present) — resolved by the package itself in
 *     `@interleave/db`'s `loadVectorExtension` when this returns `undefined`.
 *
 * Returns `undefined` when no vendored binary is found, in which case the caller
 * passes no explicit path and `@interleave/db` falls back to the npm-resolved host
 * binary (dev) — and if that also fails, `vecFunctional` returns `false` and the
 * app degrades to FTS-only.
 */

import fs from "node:fs";
import path from "node:path";
import { asarUnpackedVariant } from "../shared/asar";

/** Per-platform `vec0` loadable-binary file names. */
function vecBinaryNames(): string[] {
  switch (process.platform) {
    case "darwin":
      return ["vec0.dylib"];
    case "win32":
      return ["vec0.dll"];
    default:
      return ["vec0.so"];
  }
}

/**
 * Absolute path to the vendored, packaged `vec0.*` extension, or `undefined` when
 * none is vendored (the caller then lets the npm package resolve the host binary).
 * Prefers the `app.asar.unpacked` rewrite (the real file `dlopen` can open).
 */
export function resolveSqliteVecBinary(distDir: string): string | undefined {
  const base: string[] = [];
  for (const name of vecBinaryNames()) {
    // Built artifact: apps/desktop/native/vec0.* (dist is one level down).
    base.push(path.resolve(distDir, "..", "native", name));
    base.push(path.join(distDir, "native", name));
  }

  const candidates: string[] = [];
  for (const candidate of base) {
    const unpacked = asarUnpackedVariant(candidate);
    if (unpacked) candidates.push(unpacked);
    candidates.push(candidate);
  }

  return candidates.find((candidate) => fs.existsSync(candidate));
}

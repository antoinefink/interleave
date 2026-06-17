/**
 * Electron-ABI native SQLite binding resolver (T007, packaged in T050).
 *
 * The desktop app must load a `better_sqlite3.node` compiled for Electron's V8
 * ABI, not the Node-ABI binary that ships with the shared `better-sqlite3`
 * package (which serves Vitest + the dev scripts). `scripts/vendor-native.mjs`
 * builds the Electron-ABI binary into `apps/desktop/native/better_sqlite3.node`;
 * this resolver finds it so the DB client can pass it to `better-sqlite3`'s
 * `nativeBinding` option.
 *
 * `distDir` is the compiled-main directory (`__dirname`): the bundle lives at
 * `apps/desktop/dist`, so the native binary is one level up at
 * `apps/desktop/native/`.
 *
 * Packaging note (T050): inside the packaged `.app` the compiled main runs from
 * `…/Contents/Resources/app.asar/dist`, so the `..`-relative candidate resolves
 * to `app.asar/native/better_sqlite3.node`. A native addon **cannot** be
 * `dlopen`ed from inside an asar archive, so the binary is `asarUnpack`ed by
 * `electron-builder` to `app.asar.unpacked/native/…`. We therefore prefer the
 * `app.asar.unpacked` rewrite of each candidate (the real on-disk file
 * `dlopen` needs); the in-asar path is kept only as a last-resort fallback for
 * dev/test where there is no asar at all.
 */

import fs from "node:fs";
import path from "node:path";
import { asarUnpackedVariant } from "../shared/asar";

/**
 * Absolute path to the Electron-ABI `better_sqlite3.node`, or `undefined` if it
 * has not been built yet (in which case the caller falls back to the default
 * binding — useful for non-Electron contexts).
 */
export function resolveNativeBinding(distDir: string): string | undefined {
  const base = [
    // Built artifact: apps/desktop/native/better_sqlite3.node (dist is one down).
    path.resolve(distDir, "..", "native", "better_sqlite3.node"),
    // When running the bundle from an unusual cwd, also try alongside it.
    path.join(distDir, "native", "better_sqlite3.node"),
  ];

  // Prefer the asar.unpacked rewrite (the real file `dlopen` can open) ahead of
  // the in-asar candidate, then fall back to the literal paths for dev/test.
  const candidates: string[] = [];
  for (const candidate of base) {
    const unpacked = asarUnpackedVariant(candidate);
    if (unpacked) candidates.push(unpacked);
    candidates.push(candidate);
  }

  return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * Vendor the `sqlite-vec` loadable extension for the packaged Electron app (T087).
 *
 * `sqlite-vec` is a loadable SQLite extension (`vec0.{dylib,so,dll}`) the main
 * process loads into the better-sqlite3 connection. The packaged app ships NO
 * `node_modules` (electron-builder `files:` excludes it), so the runtime cannot
 * resolve the binary from the npm package — we copy the platform binary into
 * `apps/desktop/native/` (alongside the vendored `better_sqlite3.node`), which is
 * `asarUnpack`ed by electron-builder (a loadable extension cannot be `dlopen`ed
 * from inside an asar). `resolveSqliteVecBinary` (native-binding sibling) finds the
 * `app.asar.unpacked` path at runtime.
 *
 * BUILD-TIME GUARD (the central T087 infra risk): after copying, this runs the
 * SAME functional `vec0` round-trip smoke test the app uses (`vecFunctional`)
 * against the host's better-sqlite3 — so the build FAILS if the shipped
 * `sqlite-vec` binary's SQLite ABI is incompatible with this repo's better-sqlite3
 * (the documented `loadExtension`-succeeds-but-`vec0`-registers-nothing trap),
 * rather than silently shipping a non-functional vec0. Run via
 * `pnpm --filter @interleave/desktop rebuild:vec` (wired into `dist`).
 *
 * Idempotent. Skips with a clear message when the host binary cannot be resolved
 * (e.g. a CI typecheck box without the optional platform package) UNLESS
 * `INTERLEAVE_REQUIRE_VEC=1`, in which case a missing binary fails the build.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..");
const nativeDir = path.join(desktopDir, "native");
const require = createRequire(import.meta.url);

/** Per-platform `vec0` loadable-binary file name. */
function vecBinaryName() {
  if (process.platform === "darwin") return "vec0.dylib";
  if (process.platform === "win32") return "vec0.dll";
  return "vec0.so";
}

/** Resolve the host `sqlite-vec` loadable binary path via the npm package. */
function resolveHostBinary() {
  try {
    const { getLoadablePath } = require("sqlite-vec");
    const p = getLoadablePath();
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Run the functional vec0 smoke test against the copied binary (the build guard). */
function assertVecFunctional(binaryPath) {
  const db = new Database(":memory:");
  try {
    db.loadExtension(binaryPath);
    const version = db.prepare("SELECT vec_version() AS v").get();
    if (typeof version?.v !== "string") {
      throw new Error("vec_version() did not return a string");
    }
    db.exec("CREATE VIRTUAL TABLE _vec_smoke USING vec0(embedding float[384])");
    const buf = Buffer.from(new Float32Array(384).fill(0.0123).buffer);
    db.prepare("INSERT INTO _vec_smoke(rowid, embedding) VALUES (1, ?)").run(buf);
    const row = db
      .prepare("SELECT rowid FROM _vec_smoke WHERE embedding MATCH ? ORDER BY distance LIMIT 1")
      .get(buf);
    db.exec("DROP TABLE _vec_smoke");
    if (row?.rowid !== 1) throw new Error("KNN MATCH did not return the inserted row");
  } finally {
    db.close();
  }
}

function main() {
  const required = process.env.INTERLEAVE_REQUIRE_VEC === "1";
  const hostBinary = resolveHostBinary();
  if (!hostBinary) {
    const msg =
      "[desktop] sqlite-vec host binary not found — skipping vendor (semantic search will degrade to FTS-only in the packaged app)";
    if (required) throw new Error(msg);
    console.warn(msg);
    return;
  }

  mkdirSync(nativeDir, { recursive: true });
  const dest = path.join(nativeDir, vecBinaryName());
  copyFileSync(hostBinary, dest);

  // Build-time guard: fail the build if the shipped binary's vec0 is non-functional
  // against this repo's better-sqlite3 (the ABI-mismatch trap).
  assertVecFunctional(dest);
  console.log(`[desktop] vendored + verified sqlite-vec → ${path.relative(desktopDir, dest)}`);
}

main();

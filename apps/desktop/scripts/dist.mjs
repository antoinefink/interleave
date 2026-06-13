/**
 * Package the Interleave desktop app into an installable macOS .app/.dmg (T050).
 *
 * This is the single "ship" entry point — `pnpm --filter @interleave/desktop dist`
 * (or the root `pnpm dist`). It wraps the EXISTING pipeline; it does not replace
 * it. Steps, in order:
 *
 *   1. Build the renderer            → apps/web/dist (Vite, offline asset URLs)
 *   2. Vendor the Electron-ABI addon → apps/desktop/native/better_sqlite3.node
 *   3. Bundle main + preload + stage → apps/desktop/dist/{main.cjs,preload.cjs,
 *      migrations + renderer + embedding model assets}        (build.mjs)
 *   4. electron-builder              → apps/desktop/release/*.app + *.dmg
 *
 * electron-builder is packaging-ONLY: it consumes the already-built `dist/` +
 * the vendored native module and produces the installer. Signing is driven by
 * `electron-builder.config.cjs`: a plain `pnpm dist` produces an ad-hoc-signed dev
 * build, while `pnpm dist:release` (which sets INTERLEAVE_RELEASE_SIGN=1 via
 * `op run`) produces a Developer ID signed + notarized build. The
 * native addon is `asarUnpack`ed so `dlopen` finds it at runtime (the #1
 * better-sqlite3 packaging failure mode); `native-binding.ts` rewrites the in-asar
 * path to the `app.asar.unpacked` sibling.
 *
 * Set INTERLEAVE_DIST_SKIP_BUILD=1 to skip steps 1–3 (re-package an existing
 * `dist/`), or INTERLEAVE_DIST_DIR_ONLY=1 to produce only the unpacked `.app`
 * (`--dir`, no .dmg) — handy in CI / constrained environments.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");

/** Run a command, inheriting stdio; throw on non-zero exit. */
function run(cmd, args, cwd = desktopDir, env = {}) {
  console.log(`\n[dist] $ ${cmd} ${args.join(" ")}  (cwd: ${path.relative(repoRoot, cwd) || "."})`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

function main() {
  const skipBuild = process.env.INTERLEAVE_DIST_SKIP_BUILD === "1";
  const dirOnly = process.env.INTERLEAVE_DIST_DIR_ONLY === "1";

  if (!skipBuild) {
    // 1) Renderer (apps/web/dist). build.mjs (step 3) stages this into dist/renderer.
    run("pnpm", ["--filter", "@interleave/web", "build"], repoRoot);

    // 2) Electron-ABI native SQLite addon (idempotent; skips if already present
    //    for the current Electron version is the caller's responsibility — the
    //    vendor script always rebuilds, which is the safe default for a ship build).
    if (!existsSync(path.join(desktopDir, "native", "better_sqlite3.node"))) {
      run("node", ["scripts/vendor-native.mjs"]);
    } else {
      console.log("\n[dist] native/better_sqlite3.node present — skipping rebuild.");
    }

    // 2b) Vendor + verify the sqlite-vec vec0 loadable extension (T087). Runs the
    //     functional smoke test against the shipped binary and FAILS the build on an
    //     ABI mismatch, so a packaged app never ships a non-functional vec0.
    run("node", ["scripts/vendor-sqlite-vec.mjs"]);

    // 3) main.cjs + preload.cjs + dist/drizzle + dist/renderer + model assets.
    run("node", ["build.mjs"], desktopDir, { INTERLEAVE_REQUIRE_EMBEDDING_MODEL: "1" });
  } else {
    console.log("[dist] INTERLEAVE_DIST_SKIP_BUILD=1 — re-packaging existing dist/.");
  }

  // 4) Package. `--dir` skips the dmg (faster, no hdiutil) for CI/constrained envs.
  const ebArgs = ["electron-builder", "--mac", "--config", "electron-builder.config.cjs"];
  if (dirOnly) ebArgs.push("--dir");
  run("pnpm", ["exec", ...ebArgs]);

  console.log("\n[dist] done — artifacts in apps/desktop/release/");
}

main();

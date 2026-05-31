/**
 * Build the Electron-ABI native SQLite binary (T007).
 *
 * The desktop app runs on Electron's V8 ABI, while the rest of the workspace
 * (`@interleave/db` unit tests, the `db:migrate` scripts) runs on plain Node's
 * ABI. pnpm shares ONE physical copy of `better-sqlite3`, so its single
 * `build/Release/better_sqlite3.node` cannot satisfy both runtimes.
 *
 * Rather than vendor the whole JS package (and reconstruct its dependency tree),
 * we build ONLY the native addon for the Electron ABI and drop it at
 * `apps/desktop/native/better_sqlite3.node`. The desktop DB client passes that
 * path to `better-sqlite3`'s `nativeBinding` option, so it loads the Electron-ABI
 * binary while the shared package keeps its Node-ABI binary for everything else.
 *
 * Steps: copy the better-sqlite3 package sources to a temp dir, `node-gyp
 * rebuild` against the installed Electron's headers, copy the resulting `.node`
 * into `native/`, then clean up. Idempotent. Run via
 * `pnpm --filter @interleave/desktop rebuild:native`.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, "..");
const nativeDir = path.join(desktopDir, "native");
const outBinding = path.join(nativeDir, "better_sqlite3.node");

const require = createRequire(import.meta.url);

/** Resolve the real (store) better-sqlite3 package directory. */
function resolveStorePkgDir() {
  const entry = require.resolve("better-sqlite3", { paths: [desktopDir] });
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    const pkgJson = path.join(dir, "package.json");
    if (existsSync(pkgJson)) {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      if (pkg.name === "better-sqlite3") return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error("Could not locate the better-sqlite3 package directory");
}

function resolveElectronVersion() {
  const pkg = JSON.parse(
    readFileSync(require.resolve("electron/package.json", { paths: [desktopDir] }), "utf8"),
  );
  return pkg.version;
}

function main() {
  // Escape hatch for environments that don't run the Electron app (CI typecheck/
  // lint/test/build, or machines without a node-gyp toolchain): skip the
  // Electron-ABI rebuild. better-sqlite3's own Node-ABI binary (built by its own
  // install script) is untouched, so Vitest + the db scripts still work — only
  // `pnpm dev` / `pnpm e2e` / `pnpm --filter @interleave/desktop dist` need this
  // addon, and they run where the toolchain is available.
  if (process.env.INTERLEAVE_SKIP_ELECTRON_REBUILD === "1") {
    console.log(
      "[desktop] skipping Electron-ABI better-sqlite3 rebuild (INTERLEAVE_SKIP_ELECTRON_REBUILD=1)",
    );
    return;
  }

  const storeDir = resolveStorePkgDir();
  const electronVersion = resolveElectronVersion();

  const buildDir = mkdtempSync(path.join(os.tmpdir(), "interleave-bsqlite-electron-"));
  try {
    // Copy the package sources (skip any existing build artifacts so the temp
    // dir compiles fresh for the Electron ABI).
    cpSync(storeDir, buildDir, {
      recursive: true,
      dereference: true,
      filter: (src) => !src.includes(`${path.sep}build${path.sep}`),
    });

    // Rebuild the native addon against Electron's headers/ABI with node-gyp.
    execFileSync(
      "npx",
      [
        "--yes",
        "node-gyp",
        "rebuild",
        `--target=${electronVersion}`,
        `--arch=${process.arch}`,
        "--dist-url=https://electronjs.org/headers",
        "--runtime=electron",
        "--build-from-source",
      ],
      { cwd: buildDir, stdio: "inherit", env: { ...process.env, npm_config_runtime: "electron" } },
    );

    const built = path.join(buildDir, "build", "Release", "better_sqlite3.node");
    if (!existsSync(built)) {
      throw new Error(`node-gyp did not produce ${built}`);
    }

    mkdirSync(nativeDir, { recursive: true });
    cpSync(built, outBinding, { dereference: true });
    console.log(
      `[desktop] better_sqlite3.node rebuilt for Electron ${electronVersion} → ${outBinding}`,
    );
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

main();

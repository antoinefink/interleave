/**
 * Desktop bundler (T007).
 *
 * Builds the Electron main process and preload script with esbuild and stages a
 * self-contained copy of the Drizzle migrations next to the compiled main.
 *
 *   src/main/index.ts    → dist/main.cjs    (CJS, node platform)
 *   src/preload/index.ts → dist/preload.cjs (CJS, node platform)
 *   packages/db/drizzle  → dist/drizzle     (migrations, run on startup)
 *
 * Only `electron` is externalized (provided by the runtime). EVERYTHING else —
 * the workspace TS (`@interleave/db`, `@interleave/core`, `@interleave/local-db`,
 * `@interleave/scheduler`), `drizzle-orm`, `zod`, AND the `better-sqlite3` JS
 * wrapper — is bundled into a single self-contained `main.cjs`. The Electron main
 * always loads the Electron-ABI native addon by absolute path via `nativeBinding`
 * (see `native-binding.ts` + `scripts/vendor-native.mjs`), so `better-sqlite3`'s
 * own `require('bindings')('better_sqlite3.node')` lookup is NEVER reached at
 * runtime — `bindings` + `prebuild-install` are therefore kept external (they are
 * dead in our path and would otherwise drag native-prebuild machinery into the
 * bundle).
 *
 * WHY bundle better-sqlite3 (T050 packaging fix): externalizing it forced a
 * `dist/node_modules/better-sqlite3` copy that electron-builder's file matcher
 * silently DROPS (it special-cases `node_modules/` under the app dir), so the
 * packaged `require("better-sqlite3")` resolved to nothing and the .app could not
 * open SQLite. Bundling the pure-JS wrapper into `main.cjs` removes that whole
 * staging dance and makes the packaged main fully self-contained except for the
 * `asarUnpack`ed `.node` addon it loads by path.
 *
 * Pass `--watch` for an incremental dev build.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const distDir = path.join(here, "dist");
const watch = process.argv.includes("--watch");

/**
 * Runtime-provided / never-reached modules that must not be bundled.
 *   - `electron`: provided by the Electron runtime.
 *   - `bindings` / `prebuild-install`: better-sqlite3's auto native-addon loader,
 *     only reached when `nativeBinding` is unset — which the app never does (it
 *     always passes the vendored Electron-ABI addon path). Kept external so
 *     esbuild does not pull prebuild tooling into the bundle.
 */
const external = ["electron", "bindings", "prebuild-install"];

/** Path to the `import.meta.url` shim injected into the main CJS bundle. */
const importMetaShim = path.join(here, "import-meta-url-shim.js");

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  // Electron 38 ships Node 22; matching keeps native ABI assumptions sane.
  external,
  logLevel: "info",
};

/**
 * Main-only extras. The `import.meta.url` shim uses `__filename`/`require`, which
 * are unavailable in a SANDBOXED preload — so it is injected into the main bundle
 * only. The preload uses no `import.meta`, so it needs neither define nor inject.
 */
const mainExtras = {
  define: { "import.meta.url": "import_meta_url" },
  inject: [importMetaShim],
};

function stageMigrations() {
  const from = path.join(repoRoot, "packages", "db", "drizzle");
  const to = path.join(distDir, "drizzle");
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
}

/**
 * Stage the built renderer next to the compiled main (T050).
 *
 * In a packaged app `app.isPackaged` is true and `index.ts` resolves the renderer
 * at `dist/renderer` (relative to the compiled main), served offline over the
 * `app://` protocol. The renderer is built by `@interleave/web build` into
 * `apps/web/dist`; we copy it here so `electron-builder` can pack a single,
 * self-contained `dist/` tree. No-op (with a clear warning) if the renderer has
 * not been built yet — `pnpm dist` builds it first.
 */
function stageRenderer() {
  const from = path.join(repoRoot, "apps", "web", "dist");
  const to = path.join(distDir, "renderer");
  rmSync(to, { recursive: true, force: true });
  if (!existsSync(path.join(from, "index.html"))) {
    console.warn(
      `[desktop] renderer not built at ${from} — skipping renderer staging.\n` +
        "          Run `pnpm --filter @interleave/web build` (or `pnpm dist`) first.",
    );
    return;
  }
  cpSync(from, to, { recursive: true });
}

async function run() {
  mkdirSync(distDir, { recursive: true });

  const targets = [
    {
      ...common,
      ...mainExtras,
      entryPoints: [path.join(here, "src", "main", "index.ts")],
      outfile: path.join(distDir, "main.cjs"),
    },
    {
      ...common,
      entryPoints: [path.join(here, "src", "preload", "index.ts")],
      outfile: path.join(distDir, "preload.cjs"),
    },
    {
      // The background-job WORKER (T058) — its OWN self-contained bundle, forked
      // by the runner with `utilityProcess.fork(path.join(__dirname,
      // "job-worker.cjs"))`. It is DB-FREE (imports NO @interleave/db /
      // better-sqlite3 / repositories), so it bundles only the pure fetch + Zod
      // message code. Same CJS/node22 options as main; no `import.meta` shim (the
      // worker uses none). In the shared `targets` array so BOTH `--watch` and the
      // one-shot prod branch emit `dist/job-worker.cjs` (the latter is what
      // `pnpm dev` → scripts/dev.mjs runs, so the bundle exists under dev too).
      ...common,
      entryPoints: [path.join(here, "src", "worker", "job-worker.ts")],
      outfile: path.join(distDir, "job-worker.cjs"),
    },
  ];

  stageMigrations();

  if (watch) {
    const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log("[desktop] esbuild watching main + preload + job-worker…");
    return;
  }

  // Stage the built renderer for the packaged app (offline `app://` load). Skipped
  // in watch/dev (the dev server serves the renderer) and harmless when the
  // renderer dist is absent (e.g. the Playwright harness loads it from apps/web/dist).
  stageRenderer();

  await Promise.all(targets.map((t) => esbuild.build(t)));
  console.log("[desktop] built main.cjs + preload.cjs + job-worker.cjs + drizzle/");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

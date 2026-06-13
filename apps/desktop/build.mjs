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

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const require = createRequire(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const distDir = path.join(here, "dist");
const watch = process.argv.includes("--watch");
const DEFAULT_EMBEDDING_MODEL_ID = readCoreStringConstant("DEFAULT_EMBEDDING_MODEL_ID");

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
 * Stage the `tesseract.js` engine + its WASM core + the `eng.traineddata` next to
 * the worker bundle for OFFLINE OCR (T066).
 *
 * The packaged app ships NO `node_modules` (electron-builder `files:` excludes it),
 * so the OCR worker cannot `require('tesseract.js')`/load its CDN core+lang at
 * runtime. We copy a SELF-CONTAINED tree into `dist/resources/tesseract/`:
 *
 *   - `node_modules/` ← the pnpm peer dir of `tesseract.js` (the engine + its
 *     runtime deps — `tesseract.js-core`, `wasm-feature-detect`, `node-fetch`, … —
 *     laid out as a real `node_modules`, so the worker-script's `require`s resolve),
 *   - `lang/eng.traineddata.gz` ← the pinned `@tesseract.js-data/eng` (committed
 *     locally; NEVER fetched at build time — offline).
 *
 * The worker (`src/worker/ocr.ts`) points `tesseract.js` at these LOCAL staged
 * paths (`workerPath`/`corePath`/`langPath`), never `node_modules` or the CDN. This
 * dir is PACKAGED by the existing `dist/**` glob and `asarUnpack`'d (a `.wasm`/data
 * file cannot be read from inside the asar) — see electron-builder.config.cjs.
 */
function stageTesseract() {
  const stageDir = path.join(distDir, "resources", "tesseract");
  rmSync(stageDir, { recursive: true, force: true });

  // The pnpm peer node_modules dir of tesseract.js holds the engine + all its
  // runtime deps as a self-contained `node_modules` tree (so requires resolve).
  const tjsPkg = require.resolve("tesseract.js/package.json");
  // …/.pnpm/tesseract.js@<v>/node_modules/tesseract.js/package.json → that
  // grandparent `node_modules` dir is the self-contained tree.
  const tjsDir = path.dirname(tjsPkg); // …/node_modules/tesseract.js
  const peerNodeModules = path.dirname(tjsDir); // …/node_modules
  cpSync(peerNodeModules, path.join(stageDir, "node_modules"), {
    recursive: true,
    dereference: true,
  });

  // The English language data (gzipped traineddata), from the pinned data package.
  const engPkg = require.resolve("@tesseract.js-data/eng/package.json");
  const engDir = path.dirname(engPkg);
  // The package nests the data under `<version>/eng.traineddata.gz`; find the first.
  const candidates = [
    path.join(engDir, "4.0.0", "eng.traineddata.gz"),
    path.join(engDir, "4.0.0_best_int", "eng.traineddata.gz"),
  ];
  const engSrc = candidates.find((p) => existsSync(p));
  if (!engSrc) {
    throw new Error(
      `[desktop] stageTesseract: eng.traineddata.gz not found under ${engDir} — is @tesseract.js-data/eng installed?`,
    );
  }
  const langDir = path.join(stageDir, "lang");
  mkdirSync(langDir, { recursive: true });
  cpSync(engSrc, path.join(langDir, "eng.traineddata.gz"));
}

/**
 * Stage Transformers.js next to the worker bundle so the DB-free `embed` job
 * (T087) can compute local EmbeddingGemma ONNX embeddings offline.
 *
 * Same constraint as tesseract: the packaged app ships NO `node_modules`, and the
 * worker keeps `@huggingface/transformers` EXTERNAL so model/runtime assets stay as
 * real files. We copy a SELF-CONTAINED tree into
 * `dist/resources/transformers/node_modules/` (the pnpm peer dir of Transformers.js,
 * laid out as a real `node_modules` so its requires resolve). `embedding-model.ts`
 * loads it from this staged path via a
 * DYNAMIC require. This dir is packaged by the `dist/**` glob and `asarUnpack`'d (a
 * `.node`/`.onnx` cannot be read from inside the asar) — see electron-builder.config.cjs.
 *
 * The EmbeddingGemma ONNX model is vendored into `models/` for packaged builds.
 * Dev/watch builds skip model vendoring by default; set
 * `INTERLEAVE_VENDOR_EMBEDDING_MODEL=1` to prefill the local package cache. Ship
 * builds set `INTERLEAVE_REQUIRE_EMBEDDING_MODEL=1` and fail if the model cannot be
 * staged.
 */
async function stageTransformers() {
  const stageDir = path.join(distDir, "resources", "transformers");
  rmSync(stageDir, { recursive: true, force: true });

  let transformersEntry;
  try {
    transformersEntry = require.resolve("@huggingface/transformers");
  } catch {
    console.warn(
      "[desktop] stageTransformers: `@huggingface/transformers` not installed — packaged worker\n" +
        "          will use the deterministic embedding fallback.",
    );
    return;
  }
  let transformersDir = path.dirname(transformersEntry);
  while (
    transformersDir !== path.dirname(transformersDir) &&
    !existsSync(path.join(transformersDir, "package.json"))
  ) {
    transformersDir = path.dirname(transformersDir);
  }
  const stagedNodeModules = path.join(stageDir, "node_modules");
  mkdirSync(stagedNodeModules, { recursive: true });

  // pnpm's store is NESTED: each package's transitive deps live in its OWN
  // `.pnpm/<pkg>@<v>/node_modules/` peer dir (NOT flat under the runtime package), and the same
  // dep can appear at several versions. Recursively walk the dependency graph from
  // the embedding runtime, copying every reachable package's REAL dir into the staged tree —
  // hoisting to the top-level `node_modules` when the name is free, else NESTING under
  // the requiring package (so conflicting versions stay isolated, exactly like a real
  // install). This produces a self-contained tree a plain `require` resolves offline.
  collectPnpmGraph(transformersDir, stagedNodeModules);
  await stageEmbeddingModel(stageDir);
}

export async function stageEmbeddingModel(stageDir, options = {}) {
  const required = options.required ?? process.env.INTERLEAVE_REQUIRE_EMBEDDING_MODEL === "1";
  const requested =
    required || (options.requested ?? process.env.INTERLEAVE_VENDOR_EMBEDDING_MODEL === "1");
  const modelDir = path.join(stageDir, "models");
  mkdirSync(modelDir, { recursive: true });
  if (!requested) {
    console.warn(
      "[desktop] stageTransformers: skipping EmbeddingGemma model vendoring for this dev build.",
    );
    return;
  }
  try {
    const mod = options.transformers ?? (await import("@huggingface/transformers"));
    if (mod.env) {
      mod.env.cacheDir = modelDir;
      mod.env.localModelPath = modelDir;
      mod.env.allowLocalModels = true;
      // Build-time acquisition only: packaged/runtime jobs keep this false.
      mod.env.allowRemoteModels = true;
    }
    await mod.pipeline("feature-extraction", DEFAULT_EMBEDDING_MODEL_ID, { dtype: "q8" });
    writeFileSync(
      path.join(modelDir, ".interleave-model-ready.json"),
      `${JSON.stringify({ modelId: DEFAULT_EMBEDDING_MODEL_ID }, null, 2)}\n`,
    );
  } catch (error) {
    const message =
      "[desktop] stageTransformers: EmbeddingGemma model could not be staged. " +
      "Dev builds will fall back deterministically; dist builds require the model.\n" +
      `          ${error instanceof Error ? error.message : String(error)}`;
    if (required) throw new Error(message);
    console.warn(message);
  }
}

function readCoreStringConstant(name) {
  const settingsSource = readFileSync(path.join(repoRoot, "packages/core/src/settings.ts"), "utf8");
  const match = settingsSource.match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*"([^"]+)"\\s*;`),
  );
  if (!match?.[1]) throw new Error(`[desktop] could not read ${name} from core settings`);
  return match[1];
}

/**
 * Recursively stage a package + its full transitive dependency graph from the pnpm
 * store into `topNodeModules` (a real, hoisted `node_modules` layout). For each
 * package, its deps are resolved through pnpm's `.pnpm/<pkg>@<v>/node_modules/` peer
 * layout (walk up from the package dir to the `node_modules` that holds the dep),
 * then placed at top-level if that name+version is free, else NESTED under the
 * requiring package's own `node_modules` to keep conflicting versions isolated.
 */
function collectPnpmGraph(rootPkgDir, topNodeModules) {
  const fs = require("node:fs");
  // Track which version of each top-level name we've hoisted (name → version).
  const hoisted = new Map();

  /** Resolve a dep `name` required from `fromPkgDir` via the pnpm peer layout. */
  const resolveDep = (fromPkgDir, name) => {
    let dir = fromPkgDir;
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules", name);
      if (existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
      dir = path.dirname(dir);
    }
    return null;
  };

  const readPkg = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      return null;
    }
  };

  /** Place `srcReal` (a package dir) into `destNm/<name>`, then recurse its deps. */
  const place = (srcReal, destNm, visited) => {
    const pkg = readPkg(srcReal);
    if (!pkg?.name) return;
    if (visited.has(srcReal)) return; // already placed on this branch (cycle guard)
    const dest = path.join(destNm, pkg.name);
    if (!existsSync(dest)) {
      cpSync(srcReal, dest, { recursive: true, dereference: true });
    }
    const branch = new Set(visited).add(srcReal);
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
    for (const depName of Object.keys(deps)) {
      const depReal = resolveDep(srcReal, depName);
      if (!depReal) continue; // optional/absent — skip (native fallback covers it)
      const depPkg = readPkg(depReal);
      if (!depPkg?.version) continue;
      const top = hoisted.get(depName);
      if (top === undefined) {
        // Free at top-level — hoist it there.
        hoisted.set(depName, depPkg.version);
        place(depReal, topNodeModules, branch);
      } else if (top === depPkg.version) {
        // Same version already hoisted — ensure its own subtree is staged.
        place(depReal, topNodeModules, branch);
      } else {
        // Version conflict — nest under THIS package's node_modules.
        place(depReal, path.join(dest, "node_modules"), branch);
      }
    }
  };

  const rootPkg = readPkg(rootPkgDir);
  if (rootPkg?.name) hoisted.set(rootPkg.name, rootPkg.version);
  place(rootPkgDir, topNodeModules, new Set());
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
      //
      // `tesseract.js` (+ core, T066) is kept EXTERNAL: the worker loads it by a
      // DYNAMIC require from the STAGED `dist/resources/tesseract/node_modules`
      // (its node worker-thread script must be a real file on disk, so it cannot be
      // inlined). `stageTesseract()` copies that self-contained tree.
      //
      // Transformers.js (T087) is kept EXTERNAL so its ONNX/model runtime assets
      // remain real files. The worker loads it by a DYNAMIC require from the staged
      // `dist/resources/transformers/node_modules` tree that `stageTransformers()`
      // copies.
      ...common,
      external: [
        ...external,
        "tesseract.js",
        "tesseract.js-core",
        "@huggingface/transformers",
        "onnxruntime-node",
        "onnxruntime-common",
      ],
      entryPoints: [path.join(here, "src", "worker", "job-worker.ts")],
      outfile: path.join(distDir, "job-worker.cjs"),
    },
  ];

  stageMigrations();
  stageTesseract();
  await stageTransformers();

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
  console.log(
    "[desktop] built main.cjs + preload.cjs + job-worker.cjs + drizzle/ + resources/tesseract/ + resources/transformers/",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

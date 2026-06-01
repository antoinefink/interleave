/**
 * Extension bundler (T062) — esbuild (matching the desktop's tooling).
 *
 * Bundles the TS entry points to browser ESM and copies the static assets +
 * manifest + icons into `dist/`, producing a load-unpacked-ready
 * `apps/extension/dist/`:
 *
 *   src/background.ts → dist/background.js   (ESM, browser; the MV3 worker)
 *   src/options.ts    → dist/options.js
 *   src/popup.ts      → dist/popup.js
 *   src/sidepanel.ts  → dist/sidepanel.js
 *   *.html + tokens.css + manifest.json + icons/ → dist/
 *
 * The zod-only `@interleave/capture-contract` is bundled in (no externals). The
 * build FAILS if the icons are missing (the manifest references real PNGs).
 *
 * Pass `--watch` for an incremental dev build.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, "dist");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome114",
  sourcemap: false,
  // Minify the shipped bundles (the service worker bundles zod via
  // `@interleave/capture-contract` — unminified it is ~550kb; minified it is a
  // fraction of that). Watch/dev builds stay readable for debugging.
  minify: !watch,
  logLevel: "info",
};

const ENTRIES = ["background", "options", "popup", "sidepanel"];
const STATIC_FILES = [
  "manifest.json",
  "tokens.css",
  "options.html",
  "popup.html",
  "sidepanel.html",
];

function copyStatic() {
  for (const file of STATIC_FILES) {
    // tokens.css lives under src/; the rest are at the package root.
    const from = file === "tokens.css" ? path.join(here, "src", file) : path.join(here, file);
    cpSync(from, path.join(distDir, file));
  }
  // Icons — REQUIRED. Fail loudly if missing (the manifest references real PNGs).
  const iconsFrom = path.join(here, "icons");
  const needed = ["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"];
  const present = existsSync(iconsFrom) ? readdirSync(iconsFrom) : [];
  const missing = needed.filter((n) => !present.includes(n));
  if (missing.length > 0) {
    throw new Error(
      `[extension] missing required icons: ${missing.join(", ")} — run \`node scripts/make-icons.mjs\``,
    );
  }
  cpSync(iconsFrom, path.join(distDir, "icons"), { recursive: true });
}

async function run() {
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  const targets = ENTRIES.map((name) => ({
    ...common,
    entryPoints: [path.join(here, "src", `${name}.ts`)],
    outfile: path.join(distDir, `${name}.js`),
  }));

  if (watch) {
    copyStatic();
    const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
    await Promise.all(contexts.map((c) => c.watch()));
    console.log("[extension] esbuild watching…");
    return;
  }

  await Promise.all(targets.map((t) => esbuild.build(t)));
  copyStatic();
  console.log(`[extension] built dist/ (${ENTRIES.length} bundles + static assets + icons)`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

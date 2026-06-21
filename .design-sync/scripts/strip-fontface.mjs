// Produce a stable, font-free brand stylesheet from the app's Vite build output.
// The built CSS is the faithful Interleave stylesheet (tokens + every semantic
// class + the Tailwind utilities actually used), but its @font-face rules point
// at absolute /assets/*.woff2 paths esbuild's font extractor can't resolve — so
// we strip @font-face here and ship IBM Plex via cfg.extraFonts (@fontsource).
//
// Run from the repo root, AFTER `pnpm -F @interleave/web build`:
//   node .design-sync/scripts/strip-fontface.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const assets = "apps/web/dist/assets";
const cssName = readdirSync(assets).find((f) => /\.css$/.test(f));
if (!cssName) {
  console.error("no built CSS in " + assets);
  process.exit(1);
}
const css = readFileSync(join(assets, cssName), "utf8");

// Minified @font-face blocks carry no nested braces → [^}]* is safe.
const before = (css.match(/@font-face/g) || []).length;
const out = css.replace(/@font-face\s*\{[^}]*\}/g, "");
const remainingAssetUrls = (out.match(/url\(\/assets\/[^)]*\)/g) || []).length;

writeFileSync("apps/web/.ds-brand.css", out);
console.error(
  `brand css: stripped ${before} @font-face blocks from ${cssName} → apps/web/.ds-brand.css`,
);
console.error(
  `  size ${(out.length / 1024).toFixed(0)}KB; remaining url(/assets/...) refs: ${remainingAssetUrls}`,
);

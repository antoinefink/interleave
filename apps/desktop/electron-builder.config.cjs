/**
 * electron-builder configuration — package the Interleave desktop shell into an
 * installable macOS .app + .dmg.
 *
 * Ported from the former `electron-builder.yml` to a `.cjs` config so the macOS
 * SIGNING posture can be CONDITIONAL on one env flag (`INTERLEAVE_RELEASE_SIGN`).
 * YAML can't express "harden + sign only for a release" — and we must, because
 * `hardenedRuntime: true` combined with ad-hoc signing makes the app fail to
 * launch. So the signing fields below branch on `signRelease`:
 *
 *   - Release  (INTERLEAVE_RELEASE_SIGN=1): real Developer ID identity +
 *     hardened runtime + entitlements; @electron/notarize auto-runs + staples
 *     from the APPLE_* env vars; the ad-hoc afterPack hook NO-OPS.
 *   - Dev/CI   (flag unset): identity null, hardened runtime off, ad-hoc
 *     afterPack re-seal runs — BYTE-FOR-BYTE the old behavior.
 *
 * The signed-release runbook + Apple credentials live in a LOCAL, non-committed env
 * (`release.op-env`, gitignored) that the `dist:release` script feeds in via `op run`.
 *
 * WHY electron-builder (not @electron-forge): this repo already owns its build
 * pipeline — esbuild bundles `main.cjs`/`preload.cjs` (`build.mjs`), a custom
 * `app://` protocol serves the renderer offline, and `scripts/vendor-native.mjs`
 * vendors the Electron-ABI `better-sqlite3` addon. electron-builder is a
 * packaging-ONLY tool: it wraps the already-built `dist/` + `node_modules` and
 * produces the `.app`/`.dmg` with first-class `asarUnpack` for native modules,
 * slotting cleanly AROUND the existing pipeline. @electron-forge wants to OWN the
 * build (its own webpack/vite plugins + bundling lifecycle), which would fight
 * the esbuild/`build.mjs` + custom protocol + bespoke native-module vendoring.
 *
 * The packager is ADDITIVE: `pnpm dist` runs (1) the renderer build, (2)
 * `build.mjs` (which now also stages the renderer into `dist/renderer`), then
 * (3) electron-builder. The dev (`electron .`) and Playwright (`launch.ts`,
 * `INTERLEAVE_DATA_DIR`) paths are unchanged — they never invoke electron-builder.
 */

// Release signing is OFF unless explicitly requested. `pnpm dist:release` (which
// runs under `op run`) sets this to "1"; plain `pnpm dist` leaves it unset and
// gets the ad-hoc dev build exactly as before.
const signRelease = process.env.INTERLEAVE_RELEASE_SIGN === "1";

// Fail fast — BEFORE electron-builder does any work — if a release build is requested
// without the Apple notarization credentials. Without this guard the failure is silent
// and worse than it looks: electron-builder's built-in notarize only ACTIVATES when these
// env vars are present, so a missing-creds release would sign the app, SKIP notarization
// entirely, and only blow up later when the afterAllArtifactBuild DMG step hands `undefined`
// to notarytool (an opaque auth error). These are injected from 1Password by
// `pnpm dist:release`; a bare `INTERLEAVE_RELEASE_SIGN=1 pnpm dist`/`dist:pack` (no `op run`)
// trips this guard with a clear message instead of shipping a half-signed build.
if (signRelease) {
  const missing = [
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
    "INTERLEAVE_SIGNING_IDENTITY",
  ].filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `[electron-builder.config] INTERLEAVE_RELEASE_SIGN=1 but missing: ${missing.join(", ")}. ` +
        "Run releases via `pnpm --filter @interleave/desktop dist:release` (injects these from " +
        "1Password via `op run`) — not a bare `pnpm dist` / `dist:pack`.",
    );
  }
}

/**
 * macOS block. Signing-related fields are conditional on `signRelease`.
 */
const mac = {
  category: "public.app-category.productivity",
  target: [
    {
      target: "dmg",
      arch: ["arm64"],
    },
  ],
  // App icon — the layered-squares Interleave mark (build/icon.icns, generated from
  // brand/logo.pxd; see brand/). Replaces the default Electron atom icon.
  icon: "build/icon.icns",
};

if (signRelease) {
  // REAL Developer ID signing + notarization (the no-xattr experience).
  //
  // identity: electron-builder wants the identity NAME WITHOUT the
  // "Developer ID Application:" cert-type prefix — it selects the Developer ID
  // Application cert automatically and ERRORS if the prefix is included. The signing
  // identity (e.g. "Developer ID Application: <Your Name> (<TEAM_ID>)") is injected as
  // INTERLEAVE_SIGNING_IDENTITY from the local, gitignored release env via `op run` —
  // deliberately NOT `CSC_NAME`, a magic electron-builder var it would read
  // independently and choke on the prefix. We strip the prefix here; the guard above
  // guarantees the var is present, so no hardcoded fallback is needed (or committed).
  mac.identity = process.env.INTERLEAVE_SIGNING_IDENTITY.replace(
    /^Developer ID Application:\s*/i,
    "",
  );
  // hardenedRuntime is MANDATORY for notarization, and is meaningful ONLY with a
  // real identity — combining it with ad-hoc signing bricks the app, which is why
  // it lives inside this branch.
  mac.hardenedRuntime = true;
  // Suppress electron-builder's pre-notarization Gatekeeper assessment (the app
  // isn't notarized YET at packaging time, so the assessment would fail).
  mac.gatekeeperAssess = false;
  // Same file for the app and its inherited (helper/utility) processes so the
  // embedding + OCR workers also get allow-jit + disable-library-validation.
  mac.entitlements = "build/entitlements.mac.plist";
  mac.entitlementsInherit = "build/entitlements.mac.plist";
  // `notarize` is opt-OUT (enabled by default). electron-builder activates the
  // @electron/notarize integration when one of these env-var groups is present —
  // we use APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (injected from
  // 1Password). It notarizes via `notarytool` and staples the .app AND the .dmg.
  // Left unset here on purpose (= enabled); see release.op-env for the creds.
} else {
  // AD-HOC CODE SIGNING (dev / CI dir-only). REQUIRED, not optional, on Apple
  // Silicon: the arm64 kernel refuses to LOAD any executable without a VALID code
  // signature, and electron-builder's bundle modifications (asar + resource
  // staging) invalidate Electron's prebuilt linker ad-hoc seal. A bundle whose
  // seal no longer matches its bytes is reported by Gatekeeper as "'Interleave'
  // is damaged and can't be opened" (NOT the milder "unidentified developer" —
  // and so NOT bypassable via right-click → Open; that path is also gone in macOS
  // Sequoia).
  //
  // We do the ad-hoc re-sign in the `afterPack` hook (scripts/adhoc-sign.cjs),
  // NOT here: electron-builder treats `identity: "-"` as a NAMED keychain identity,
  // fails to find it, and SKIPS signing — leaving the broken seal. So we keep
  // electron-builder out of signing entirely (`identity: null`) and re-seal the
  // packed bundle ourselves with `codesign --force --deep --sign -`. The app then
  // launches on arm64 once the user strips quarantine
  // (`xattr -dr com.apple.quarantine /Applications/Interleave.app` — see RELEASE.md).
  mac.identity = null;
  // hardenedRuntime is meaningful only with a real Developer ID + notarization;
  // keep it OFF for ad-hoc signing (combining the two makes the app fail to launch).
  // MUST be set explicitly false, NOT omitted: electron-builder 26 defaults
  // hardenedRuntime to TRUE for non-MAS builds, so leaving it unset here would harden
  // an ad-hoc (identity: null) build and brick it on launch.
  mac.hardenedRuntime = false;
  // Defensive: never notarize a dev build even if stray APPLE_* vars are in the
  // shell — notarization requires a real identity anyway.
  mac.notarize = false;
}

module.exports = {
  appId: "dev.interleave.desktop",
  productName: "Interleave",
  copyright: "Copyright © 2026 Interleave",

  // The compiled main entry (esbuild output). `package.json#main` already points here;
  // directories.output is where the .app/.dmg land.
  directories: {
    output: "release",
    buildResources: "build",
  },

  // Disable electron-builder's own native rebuild — we vendor the Electron-ABI
  // `better_sqlite3.node` ourselves (`scripts/vendor-native.mjs`) and load it via
  // `native-binding.ts`. Rebuilding here would clobber that with a Node-ABI binary.
  npmRebuild: false,
  buildDependenciesFromSource: false,

  // What goes INTO the asar. esbuild bundles EVERYTHING — every workspace package
  // (`@interleave/*`), `drizzle-orm`, `zod`, AND the `better-sqlite3` JS wrapper —
  // into a single self-contained `dist/main.cjs` (`build.mjs` externalizes only
  // `electron` + better-sqlite3's never-reached `bindings`/`prebuild-install`). So
  // the packaged app needs NO runtime `node_modules` at all: we ship `dist/**` (the
  // compiled main/preload + staged renderer + drizzle migrations) and the vendored
  // native addon, and the top-level symlinked `node_modules` is excluded entirely.
  //
  // IMPORTANT — why no `@interleave/*` production deps: those packages are
  // devDependencies (see package.json). If they were production deps, pnpm would
  // symlink them into `node_modules/@interleave/*` → `../../packages/*`, and
  // electron-builder's production-dependency collector would walk OUTSIDE the app
  // dir and abort packing a `.turbo/turbo-build.log` whose relative path escapes
  // the app (`… must be under …/apps/desktop/`). Keeping them as devDeps (they are
  // already inlined into main.cjs) removes that walk and is what makes packing
  // succeed. The ONLY production dependency is `better-sqlite3`, whose JS is bundled
  // too — its `node_modules` copy is intentionally never packed.
  files: [
    "dist/**/*",
    "native/**/*",
    "package.json",
    "!dist/**/*.map",
    "!**/*.ts",
    "!**/*.test.*",
    "!node_modules/**/*",
  ],

  // The native SQLite addon CANNOT be dlopen'd from inside an asar archive, so it is
  // unpacked to `app.asar.unpacked/native/better_sqlite3.node`. `native-binding.ts`
  // rewrites the in-asar path to the `.unpacked` sibling at runtime. main.cjs loads
  // this addon by absolute path via better-sqlite3's `nativeBinding` option, so the
  // bundled JS wrapper never needs its own compiled addon.
  asar: true,
  asarUnpack: [
    "native/**/*",
    // The OCR WASM core + `eng.traineddata` + the tesseract.js node worker-script
    // (T066) cannot be read/`dlopen`'d from inside the asar archive, so the staged
    // `dist/resources/tesseract/**` tree is unpacked to `app.asar.unpacked/`. The
    // worker resolves its `workerPath`/`corePath`/`langPath` there at runtime (NEVER
    // `node_modules`, NEVER the CDN) so OCR works fully offline.
    "dist/resources/tesseract/**/*",
    // Transformers.js model/runtime assets (T087) must remain real files, so the
    // staged `dist/resources/transformers/**` tree is unpacked. The DB-free `embed`
    // worker resolves it there at runtime to compute local EmbeddingGemma vectors.
    "dist/resources/transformers/**/*",
  ],

  mac,

  // Re-seal the packed .app with a VALID ad-hoc signature (dev builds only; the hook
  // no-ops when INTERLEAVE_RELEASE_SIGN=1, letting electron-builder's real Developer
  // ID signing stand). afterPack runs after the asar + resources are fully staged and
  // BEFORE the DMG is built, so the DMG captures the re-signed bundle.
  afterPack: "scripts/adhoc-sign.cjs",

  // RELEASE ONLY: notarize + staple the DMG itself. electron-builder's built-in
  // `notarize` covers the .app (so the INSTALLED app launches offline), but the DMG is
  // an un-notarized container — a downloaded DMG would hit a Gatekeeper warning at
  // MOUNT time ("cannot be checked for malicious software"), before the user ever
  // reaches the app. Apple's notarization requirement applies to the distributed disk
  // image, so we submit the finished DMG to notarytool and staple the ticket
  // (offline-clean mount). Credentials come from the same APPLE_* env vars `op run`
  // injects. NOTE: stapling rewrites the DMG bytes, so the sibling `.blockmap` /
  // `latest-mac.yml` (electron-updater metadata) would be stale — fine today since
  // auto-update is deferred; revisit when adding electron-updater.
  afterAllArtifactBuild: async (buildResult) => {
    if (!signRelease) return [];
    const { execFileSync } = require("node:child_process");
    const dmgs = buildResult.artifactPaths.filter((p) => p.endsWith(".dmg"));
    for (const dmg of dmgs) {
      console.log(`[notarize-dmg] submitting ${dmg} to notarytool (waits for Apple)…`);
      execFileSync(
        "xcrun",
        [
          "notarytool",
          "submit",
          dmg,
          "--apple-id",
          process.env.APPLE_ID,
          "--password",
          process.env.APPLE_APP_SPECIFIC_PASSWORD,
          "--team-id",
          process.env.APPLE_TEAM_ID,
          "--wait",
        ],
        { stdio: "inherit" },
      );
      console.log(`[notarize-dmg] stapling ${dmg}…`);
      execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
    }
    return [];
  },

  dmg: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder macro — interpolated at build time, must stay a literal string (not a JS template literal).
    title: "Interleave ${version}",
    // Standard "drag to /Applications" layout.
    contents: [
      {
        x: 130,
        y: 220,
        type: "file",
      },
      {
        x: 410,
        y: 220,
        type: "link",
        path: "/Applications",
      },
    ],
  },
};

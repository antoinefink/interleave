/**
 * Secure window creation (T007).
 *
 * The renderer is untrusted, so the window is locked down by default
 * (CLAUDE.md "Electron runtime & security"):
 *   - `contextIsolation: true`  — renderer + preload run in isolated worlds
 *   - `nodeIntegration: false`  — no Node globals in the renderer
 *   - `sandbox: true`          — renderer runs in an OS sandbox
 *   - `enableRemoteModule: false` (the @electron/remote module is never enabled)
 *   - `webSecurity: true`
 *
 * The only bridge into the renderer is the compiled preload script, which
 * exposes the narrow typed `window.appApi`. In dev the window loads the Vite dev
 * server (`VITE_DEV_SERVER_URL`); in production it loads the built renderer over
 * the `app://` protocol (see `renderer-protocol.ts`) so assets and SPA routing
 * resolve at pathname `/` (loading via `file://` breaks both).
 *
 * Navigation is also locked down (the Electron security checklist's "limit
 * navigation" + "limit creation of new windows"):
 *   - `setWindowOpenHandler` DENIES every renderer-initiated `window.open` /
 *     `target="_blank"`, but routes `http(s)` URLs (user-supplied provenance
 *     links — SourceReader "Open original", RefBlock) to the OS browser via
 *     `shell.openExternal`. Without this the trusted renderer could never open
 *     those links (modern Electron denies renderer-initiated windows by default).
 *   - `will-navigate` blocks any in-window navigation away from the trusted
 *     renderer origin, so a stray/in-document link can never replace the
 *     `app://` (or dev-server) renderer with remote content in the same window.
 */

import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { RENDERER_URL } from "./renderer-protocol";

/** Where the preload bundle is emitted (relative to the compiled main file). */
const PRELOAD_FILENAME = "preload.cjs";

/** Default Vite dev server URL (matches apps/web vite.config.ts strictPort). */
const DEFAULT_DEV_SERVER_URL = "http://localhost:5173";

export interface CreateWindowOptions {
  /** Directory holding the compiled main + preload (`__dirname` of the entry). */
  readonly distDir: string;
  /** Dev server URL; when set, the window loads it instead of the built files. */
  readonly devServerUrl?: string | undefined;
}

/** What a window-open request should resolve to (pure, so it is unit-tested). */
export type WindowOpenDecision =
  | { readonly action: "deny" }
  | { readonly action: "deny"; readonly openExternal: string };

/**
 * Decide what to do with a renderer-initiated `window.open` / `target="_blank"`.
 * Every request is DENIED as a new Electron window; only `http(s)` URLs are
 * additionally handed to the OS browser. This is the pure core of the
 * `setWindowOpenHandler` so it can be tested without an Electron runtime.
 */
export function decideWindowOpen(url: string): WindowOpenDecision {
  if (/^https?:\/\//i.test(url)) {
    return { action: "deny", openExternal: url };
  }
  return { action: "deny" };
}

/**
 * Whether an in-window navigation to `url` should be allowed. Only the trusted
 * renderer origin (the `app://` URL in production, or the dev server in dev) may
 * own the window; everything else is blocked so remote content can never replace
 * the renderer in-place. Pure, so it is unit-tested.
 */
export function isAllowedNavigation(url: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.some((origin) => origin !== "" && url.startsWith(origin));
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const preloadPath = path.join(options.distDir, PRELOAD_FILENAME);

  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0b0c",
    title: "Interleave",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // `enableRemoteModule` is false by default in modern Electron and the
      // @electron/remote package is never installed/enabled.
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  // The packaged app never loads a dev server (T050): even if the env var leaks
  // into a shipped build, production loads the offline `app://` renderer.
  const devServerUrl = app.isPackaged
    ? undefined
    : (options.devServerUrl ?? process.env.VITE_DEV_SERVER_URL ?? undefined);

  // Lock down navigation + new-window creation. Deny every popup; route external
  // http(s) provenance links to the OS browser. `RENDERER_URL` is the trusted
  // origin (plus the dev server in dev); any other in-window navigation is blocked.
  const allowedOrigins = [RENDERER_URL, ...(devServerUrl ? [devServerUrl] : [])];

  win.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url);
    if ("openExternal" in decision) {
      void shell.openExternal(decision.openExternal);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, allowedOrigins)) {
      event.preventDefault();
    }
  });

  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    // Production: served by the registered `app://` protocol handler.
    void win.loadURL(RENDERER_URL);
  }

  return win;
}

export { DEFAULT_DEV_SERVER_URL };

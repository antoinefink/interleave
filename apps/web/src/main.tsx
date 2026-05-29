/**
 * App entry (T003).
 *
 * Loads the global stylesheet (tokens + Tailwind), applies the persisted theme
 * to <html> before first paint, and mounts the typed TanStack Router.
 *
 * Keep the structure thin: composition lives in `router.tsx`, theme handling in
 * `theme.ts`. No domain logic here.
 */
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { appApi, isDesktop } from "./lib/appApi";
import { router } from "./router";
import "./styles.css";
import { applyTheme, getStoredTheme } from "./theme";

// Reconcile <html data-theme> with the locally-cached preference before mount so
// the first paint is already on the correct theme (no flash).
applyTheme(getStoredTheme());

// In the desktop shell the theme is a SQLite-backed setting (T011) — the
// canonical store. Read it through the typed bridge after first paint and
// reconcile <html data-theme> + the localStorage cache, so the theme chosen in
// Settings is applied app-wide and survives an app restart.
if (isDesktop()) {
  void appApi
    .getAppSettings()
    .then(({ settings }) => applyTheme(settings.theme))
    .catch(() => {
      // Best-effort: the cached localStorage theme already painted.
    });
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);

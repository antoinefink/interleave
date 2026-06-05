/**
 * Theme controller (T003).
 *
 * Light/dark is driven by the resolved `data-theme` attribute on <html> (the
 * strategy the design tokens use — see design/tokens.css `[data-theme="dark"]`).
 * The persisted preference can also be `system`; this module resolves it through
 * `prefers-color-scheme` and keeps listening while that preference is active.
 *
 * Pure UI concern — no domain logic. The persisted user-setting version arrives
 * with T011 (local settings); until then this is a lightweight localStorage pref.
 */
export type ResolvedTheme = "light" | "dark";
export type ThemePreference = "system" | ResolvedTheme;
export type Theme = ThemePreference;

const STORAGE_KEY = "interleave.theme";
const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

let stopSystemThemeListener: (() => void) | null = null;

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function getSystemThemeQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(SYSTEM_THEME_QUERY);
  } catch {
    return null;
  }
}

function resolvedSystemTheme(query = getSystemThemeQuery()): ResolvedTheme {
  if (query) return query.matches ? "dark" : "light";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function setResolvedTheme(theme: ResolvedTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

function clearSystemThemeListener(): void {
  stopSystemThemeListener?.();
  stopSystemThemeListener = null;
}

function watchSystemTheme(): void {
  const query = getSystemThemeQuery();
  if (!query) return;

  const listener = (event: MediaQueryListEvent) => {
    setResolvedTheme(event.matches ? "dark" : "light");
  };

  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    stopSystemThemeListener = () => query.removeEventListener("change", listener);
    return;
  }

  query.addListener(listener);
  stopSystemThemeListener = () => query.removeListener(listener);
}

/** Read the persisted theme, falling back to the attribute already on <html>. */
export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isThemePreference(stored)) return stored;
  } catch {
    // localStorage may be unavailable (private mode, sandboxed iframe) — ignore.
  }
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" ? "light" : "dark";
}

/** Apply a theme to <html> and persist it. */
export function applyTheme(theme: Theme): void {
  clearSystemThemeListener();
  if (theme === "system") {
    setResolvedTheme(resolvedSystemTheme());
    watchSystemTheme();
  } else {
    setResolvedTheme(theme);
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Persistence is best-effort; the in-memory attribute still drives the UI.
  }
}

/** Flip the current theme and return the new value. */
export function toggleTheme(): Theme {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next: ResolvedTheme = current === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}

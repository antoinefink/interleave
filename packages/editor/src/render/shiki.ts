/**
 * The shared Shiki highlighter singleton (T072) — ONE highlighter for every code
 * block, in every surface (source, extract, review).
 *
 * Code must render IDENTICALLY everywhere, so the editor NodeView AND the review
 * body renderer both call {@link highlightCodeHtml} here against ONE module-level
 * highlighter (created lazily, reused forever). Shiki uses real TextMate grammars +
 * VS Code themes for accurate highlighting and runs **fully on-device**:
 *
 *  - **The JavaScript RegExp engine** (`shiki/engine/javascript`) is chosen over the
 *    WASM oniguruma engine so there is **NO `onig.wasm` asset to bundle/fetch** — the
 *    grammars compile to native JS RegExp. (The small accuracy gap is irrelevant for
 *    our bounded language set, and it sidesteps the one real packaging wrinkle: a
 *    runtime "failed to load onig.wasm over a CDN".) NO network, NO CDN.
 *  - A **bounded language set** + one light + one dark theme are loaded via explicit
 *    dynamic `import`s of `@shikijs/langs` / `@shikijs/themes` (NOT `getHighlighter`
 *    auto-loading everything). Vite bundles each as a local chunk.
 *
 * A language OUTSIDE {@link BUNDLED_LANGUAGES} degrades gracefully — the highlighter
 * is created without it and {@link highlightCodeHtml} returns a plain escaped
 * `<pre><code>` (no highlight, no crash). Highlighting is async (grammar/theme load),
 * so the caller renders raw code first and swaps in the highlighted HTML when ready.
 *
 * Framework-agnostic (no React) — usable from the Tiptap NodeView and the review face.
 */

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** The light + dark theme ids bundled (matching the design tokens' light/dark split). */
export const SHIKI_LIGHT_THEME = "github-light" as const;
export const SHIKI_DARK_THEME = "github-dark" as const;

/**
 * The bounded set of languages we ship grammars for. A documented list (per the
 * T072 spec) covering the common programming/markup languages a knowledge worker
 * cards; anything else degrades to a plain `<pre><code>`. Keep this list small so the
 * renderer bundle stays bounded.
 */
export const BUNDLED_LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "json",
  "bash",
  "sql",
  "rust",
  "css",
  "html",
] as const;

/** Common aliases → the canonical bundled language id (so `js`/`ts`/`py`/`sh` work). */
const LANGUAGE_ALIASES: Readonly<Record<string, (typeof BUNDLED_LANGUAGES)[number]>> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  rs: "rust",
  htm: "html",
};

/** Resolve a raw language string to a bundled id, or `null` when unsupported. */
export function resolveLanguage(language: string | null | undefined): string | null {
  if (!language) return null;
  const lower = language.trim().toLowerCase();
  if ((BUNDLED_LANGUAGES as readonly string[]).includes(lower)) return lower;
  return LANGUAGE_ALIASES[lower] ?? null;
}

/** The dynamic-import map for the bundled grammars (Vite serves each as a local chunk). */
const LANG_IMPORTS: Readonly<Record<string, () => Promise<unknown>>> = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  python: () => import("@shikijs/langs/python"),
  json: () => import("@shikijs/langs/json"),
  bash: () => import("@shikijs/langs/bash"),
  sql: () => import("@shikijs/langs/sql"),
  rust: () => import("@shikijs/langs/rust"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

/**
 * Get (creating once) the shared highlighter. Uses the JS RegExp engine (no WASM),
 * loads the bounded language set + the two themes. Idempotent — every caller shares
 * the SAME instance. Exported for tests to assert the singleton is reused.
 */
export function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    const [light, dark, ...langs] = await Promise.all([
      import("@shikijs/themes/github-light"),
      import("@shikijs/themes/github-dark"),
      ...BUNDLED_LANGUAGES.map((id) => LANG_IMPORTS[id]?.() ?? Promise.resolve(null)),
    ]);
    return createHighlighterCore({
      themes: [
        (light as { default: unknown }).default,
        (dark as { default: unknown }).default,
      ] as never,
      langs: langs.filter((l) => l != null) as never,
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighterPromise;
}

/** Escape a raw string for safe inclusion in HTML (the plain-fallback path). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A plain (un-highlighted) `<pre><code>` for an unsupported language / no highlighter. */
export function plainCodeHtml(code: string, language: string | null): string {
  const langAttr = language ? ` class="language-${escapeHtml(language)}"` : "";
  return `<pre class="shiki shiki--plain"><code${langAttr}>${escapeHtml(code)}</code></pre>`;
}

/** Options for {@link highlightCodeHtml}. */
export interface HighlightOptions {
  /** The block's language (raw; resolved to a bundled id or falls back to plain). */
  readonly language: string | null | undefined;
  /** Which theme to render (`light`/`dark`); tracks the app `data-theme`. */
  readonly theme?: "light" | "dark";
}

/**
 * Highlight a code string to a Shiki `<pre><code>` HTML string. An unsupported /
 * absent language (or any failure) returns a plain escaped `<pre><code>` with the
 * code intact — never throws, never blocks. The output is a fixed Shiki markup
 * shape (its own escaping), safe to set via `innerHTML`.
 */
export async function highlightCodeHtml(code: string, options: HighlightOptions): Promise<string> {
  const lang = resolveLanguage(options.language);
  if (!lang) return plainCodeHtml(code, options.language ?? null);
  try {
    const highlighter = await getHighlighter();
    return highlighter.codeToHtml(code, {
      lang,
      theme: options.theme === "dark" ? SHIKI_DARK_THEME : SHIKI_LIGHT_THEME,
    });
  } catch {
    // A grammar/theme load failure (or an unexpected lang) degrades to plain code.
    return plainCodeHtml(code, options.language ?? null);
  }
}

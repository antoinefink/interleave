/**
 * The `codeBlock` with a `language` attribute (T072) — the constrained code node.
 *
 * `codeBlock` is already in the constrained schema (`ALLOWED_NODE_NAMES`) and already
 * carries a stable `blockId`. T072 adds ONE attribute — the language string — so a
 * fenced code block round-trips its language and renders syntax-highlighted (Shiki)
 * at display time. The stored JSON keeps the raw code + the `language` string;
 * highlighting is a render-time concern, never baked into the JSON.
 *
 * To keep ONE codeBlock definition shared by the headless schema AND the React editor
 * (so they can never drift — the React editor only adds a NodeView via `.extend`),
 * this extends the standalone `@tiptap/extension-code-block` (StarterKit's `codeBlock`
 * is disabled in `buildExtensions` in favor of this). `toDOM` emits
 * `<pre><code class="language-…" data-language="…">` and `parseDOM` reads the language
 * off the `<code class>` / `data-language` — the standard Markdown/HTML code-fence
 * convention, so T068's Markdown/HTML import round-trips the language.
 *
 * React-free (imports `@tiptap/*` core only) so the schema compiles headlessly.
 */

import CodeBlock from "@tiptap/extension-code-block";

/** The DOM attribute the language renders to (alongside the `language-…` class). */
export const CODE_BLOCK_LANGUAGE_ATTR = "data-language" as const;

/** The standard fenced-code class prefix (`language-python`). */
const LANGUAGE_CLASS_PREFIX = "language-";

/** Extract a language from a `<pre>`/`<code class="language-…">`, or `null`. */
function readLanguageFromClass(element: HTMLElement): string | null {
  const codeChild = element.querySelector("code");
  const classList = `${element.className} ${codeChild?.className ?? ""}`;
  const match = classList.match(/language-([\w+#.-]+)/);
  return match?.[1] ?? null;
}

/**
 * The constrained `codeBlock` node — the standard code block plus a `language` attr.
 * Same node NAME (`codeBlock`) as StarterKit's, so the rest of the pipeline (block
 * ids, `BLOCK_ID_NODE_TYPES`, extraction) is unchanged; only the attr is new. The
 * React editor adds the Shiki NodeView via `CodeBlockWithLanguage.extend({ addNodeView })`.
 */
export const CodeBlockWithLanguage = CodeBlock.extend({
  addAttributes() {
    return {
      // Keep the parent's attributes (none load-bearing here) + the block id is added
      // globally by the BlockId extension. Add the `language` attr.
      ...this.parent?.(),
      language: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute(CODE_BLOCK_LANGUAGE_ATTR) ?? readLanguageFromClass(element),
        renderHTML: (attributes: { language?: string | null }) =>
          attributes.language
            ? {
                [CODE_BLOCK_LANGUAGE_ATTR]: attributes.language,
                class: `${LANGUAGE_CLASS_PREFIX}${attributes.language}`,
              }
            : {},
      },
    };
  },
});

/**
 * Back-compat alias: the old name some imports used. `CodeBlockLanguage` is the same
 * constrained code node (with the `language` attr) registered in `buildExtensions`.
 */
export const CodeBlockLanguage = CodeBlockWithLanguage;

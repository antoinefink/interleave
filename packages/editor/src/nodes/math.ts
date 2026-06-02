/**
 * The constrained-schema `math` node (T072) — a LaTeX-bearing inline atom.
 *
 * Adding a node to the constrained document schema is the schema's ONE sanctioned
 * growth path (an explicit, reviewed change, see `schema.ts`). A `math` node stores
 * a raw LaTeX string + a `display` flag and NOTHING else: the rendered KaTeX is a
 * render-time concern (a React NodeView in `SourceEditor`, the shared body renderer
 * in review) — never baked into the stored JSON. Keeping only the latex string in
 * the document means a re-render (theme change, re-import, a future engine swap) is
 * clean and the `plainText` mirror stays searchable.
 *
 * This module is **React-free on purpose** (it imports `@tiptap/core` only, runs
 * headless in Node): the schema must compile + round-trip without a DOM, so the
 * KaTeX NodeView is wired in the React `SourceEditor`, not here.
 *
 * ## block vs inline — one node, a `display` attr
 *
 * The node is an **inline atom** so it can sit inside a paragraph's inline content
 * (an inline formula) AND, when it is the sole content of its own paragraph, read as
 * a **block formula**. The `display` attr selects which:
 *
 * - `display: true`  → a BLOCK formula — rendered display-style (centered, larger),
 *   authored as the only child of its own paragraph so it reads as its own row. The
 *   row's stable `blockId` lives on the CONTAINING paragraph (already id-bearing) —
 *   the inline math node itself carries none (the one-id-per-row invariant), so
 *   `BLOCK_ID_NODE_TYPES` does not need the inline math node.
 * - `display: false` → an INLINE formula inside running text.
 *
 * Keeping it a single inline node (rather than two node types) is ProseMirror-correct
 * — a node's inline-ness is a static schema property, so one inline node + a `display`
 * attr is the clean way to render both forms from one stored shape.
 *
 * The DOM shape is `<span data-math data-display="…">…latex…</span>` with the LaTeX
 * in the element's TEXT content — NOT pre-rendered HTML — so the stored JSON is a
 * clean latex string the extract/review can re-render.
 */

import { mergeAttributes, Node } from "@tiptap/core";

/** The ProseMirror node name for the math node. Exported so the schema set agrees. */
export const MATH_NODE_NAME = "math" as const;

/** The DOM attribute the latex string parses from / renders to (alongside text content). */
export const MATH_DOM_ATTR = "data-math" as const;
/** The DOM attribute carrying the block/inline flag. */
export const MATH_DISPLAY_ATTR = "data-display" as const;

/** The attrs a `math` node stores: the raw latex + the block/inline flag. */
export interface MathNodeAttrs {
  /** The raw LaTeX source (e.g. `E=mc^2`). Rendered to KaTeX at display time only. */
  readonly latex: string;
  /** `true` → a block formula (display-style row); `false` → an inline formula. */
  readonly display: boolean;
}

/**
 * Read the latex string off a parsed DOM element: prefer the `data-math` attribute
 * (set on render), fall back to the element's text content (so a hand-authored
 * `<span data-math>E=mc^2</span>` still imports).
 */
function readLatex(element: HTMLElement): string {
  const attr = element.getAttribute(MATH_DOM_ATTR);
  if (attr && attr.length > 0) return attr;
  return element.textContent ?? "";
}

/**
 * The framework-agnostic `math` Tiptap node (inline atom). It is registered in
 * `buildExtensions` (schema-only); the React `SourceEditor` attaches a KaTeX
 * NodeView via `addNodeView` so the latex renders. It is an `atom` (a leaf with no
 * editable inner content): the latex lives in the `latex` attr, edited via the
 * NodeView/builder, never as inline children — so the constrained schema gains
 * exactly one opaque latex carrier, nothing more.
 */
export const MathNode = Node.create({
  name: MATH_NODE_NAME,

  // Inline so it can flow inside a paragraph; an atom leaf (no inner content,
  // selectable as a unit). The latex + display flag are attrs.
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      latex: {
        default: "",
        parseHTML: (element: HTMLElement) => readLatex(element),
        renderHTML: (attrs: { latex?: string }) =>
          attrs.latex ? { [MATH_DOM_ATTR]: attrs.latex } : {},
      },
      display: {
        default: false,
        parseHTML: (element: HTMLElement) => element.getAttribute(MATH_DISPLAY_ATTR) === "true",
        renderHTML: (attrs: { display?: boolean }) => ({
          [MATH_DISPLAY_ATTR]: attrs.display ? "true" : "false",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[${MATH_DOM_ATTR}]` }, { tag: `div[${MATH_DOM_ATTR}]` }];
  },

  /**
   * Serialize to `<span data-math data-display>latex</span>`. The LaTeX is the TEXT
   * content so a re-parse recovers it even if the `data-math` attribute is stripped,
   * and search/plainText reads it directly.
   */
  renderHTML({ HTMLAttributes, node }) {
    const latex = (node.attrs.latex as string | undefined) ?? "";
    return ["span", mergeAttributes(HTMLAttributes), latex];
  },
});

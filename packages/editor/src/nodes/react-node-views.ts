/**
 * React NodeView renderers (T072) — the KaTeX + Shiki views the React `SourceEditor`
 * attaches to the constrained schema's `math` / `codeBlock` nodes.
 *
 * The constrained schema (`schema.ts`) defines the `math` node + the `codeBlock`
 * `language` attr React-free. The React `SourceEditor` calls
 * `buildExtensions({ mathNodeView, codeBlockNodeView })`, which `.extend`s those
 * nodes with `addNodeView` — so the KaTeX/Shiki React views render in source/extract
 * WITHOUT changing the stored shape (the headless schema stays the single source of
 * truth; only a render strategy is added).
 */

export { CodeBlockNodeView } from "./CodeBlockNodeView";
export { MathNodeView } from "./MathNodeView";

/**
 * Tiptap **highlight** mark (T020).
 *
 * A highlight is a lightweight reading annotation — it renders as
 * `<mark class="hl">…</mark>` (matching the design kit's `mark.hl`), creates NO
 * element, NO schedule, and NO lineage (see the `MarkType` invariant in
 * `@interleave/core`). It is the FIRST of the M4 marks; the extracted-span (T021)
 * and processed-span (T026) marks are siblings in this folder, deliberately kept
 * separate (same `document_marks` table, different `markType`, different
 * semantics).
 *
 * This module is framework-agnostic (it imports only `@tiptap/core`, which runs
 * headless under ProseMirror) so the mark + its commands are unit-testable without
 * a DOM. Marks are applied through these Tiptap COMMANDS — never DOM surgery (the
 * prototype's `range.surroundContents` is explicitly forbidden) — so undo and
 * JSON serialization stay correct.
 *
 * ## Persistence vs in-editor mark — how T020 actually stores highlights
 *
 * The canonical persistence for a highlight is a `document_marks` row keyed by the
 * STABLE block id + a `[start,end]` character range (so it re-anchors after a
 * re-import — never an absolute ProseMirror position). The reader therefore renders
 * persisted highlights as ProseMirror *decorations* (the same overlay mechanism
 * the read-point divider + extracted-span markers use), not as stored inline marks
 * in the document JSON — that keeps highlights out of the body and out of the
 * extraction substrate. This extension exists so a highlight can still be applied
 * through a real Tiptap command (toggle/add/remove) and so the `hl` mark is a
 * first-class, testable part of the schema; the persisted source of truth is the
 * `document_marks` row.
 */

import { Mark, mergeAttributes } from "@tiptap/core";

/** The ProseMirror mark name + the DOM class the design kit styles (`mark.hl`). */
export const HIGHLIGHT_MARK_NAME = "highlight" as const;
export const HIGHLIGHT_MARK_CLASS = "hl" as const;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    interleaveHighlight: {
      /** Apply the highlight mark to the current selection. */
      setHighlight: () => ReturnType;
      /** Toggle the highlight mark on the current selection. */
      toggleHighlight: () => ReturnType;
      /** Remove the highlight mark from the current selection. */
      unsetHighlight: () => ReturnType;
    };
  }
}

/**
 * The highlight mark extension. Renders `<mark class="hl">`, parses any
 * `<mark class="hl">` back to the mark, and exposes set/toggle/unset commands.
 * Not part of the default constrained schema (highlights persist as
 * `document_marks`, not body marks); install it explicitly where a live
 * highlight command is wanted (and in the editor unit test).
 */
export const Highlight = Mark.create({
  name: HIGHLIGHT_MARK_NAME,

  // Highlights are "inclusive: false" so typing at a highlight boundary does not
  // extend the highlight — a reading annotation should not grow as the user edits.
  inclusive: false,

  parseHTML() {
    return [{ tag: `mark.${HIGHLIGHT_MARK_CLASS}` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes, { class: HIGHLIGHT_MARK_CLASS }), 0];
  },

  addCommands() {
    return {
      setHighlight:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleHighlight:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetHighlight:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

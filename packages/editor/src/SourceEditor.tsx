/**
 * The React Tiptap editor for a source body (T015).
 *
 * This is the only React-aware module in `@interleave/editor`: it wraps the
 * constrained schema ({@link interleaveExtensions}) in `@tiptap/react`'s
 * `useEditor`/`EditorContent`. The schema, serialization, and (later) block-ID
 * logic stay in framework-agnostic siblings so they remain unit-testable without
 * a DOM and reusable outside React.
 *
 * Props:
 *  - `initialDoc`  — the ProseMirror JSON to load (or `undefined` → empty doc).
 *  - `editable`    — whether the user can type; the reader (T018) defaults this
 *                    to read-leaning, but editing in place is supported.
 *  - `onChange`    — debounced emitter of `{ prosemirrorJson, plainText }`; the
 *                    renderer's `useDocument` hook persists it via
 *                    `documents.save`. `plainText` is computed here with the
 *                    shared {@link toPlainText} so the stored mirror matches.
 *  - `onEditorReady` — gives the host the live Tiptap {@link Editor} instance so
 *                    it can drive read-point capture/jump (T017/T018) without the
 *                    reader reaching into ProseMirror internals itself. Called
 *                    with the instance when it mounts and `null` when it tears
 *                    down. Read-point math still lives in `@interleave/editor`.
 *
 * Styling is class-based (`.reader` faces from the app stylesheet, derived from
 * the design tokens) — this component hard-codes no colors or pixel values.
 */

import type { Content, Editor, Extensions } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useRef } from "react";
import { CodeBlockNodeView, MathNodeView } from "./nodes/react-node-views";
import { ReaderDecorations } from "./reader-decorations";
import { buildExtensions } from "./schema";
import { emptyDoc, toPlainText } from "./serialize";

import "katex/dist/katex.min.css";

/**
 * The constrained extension array WITH the T072 KaTeX/Shiki NodeViews attached. The
 * React editor builds this (rather than the headless `interleaveExtensions`) so a
 * `math` node renders via KaTeX and a `codeBlock` via Shiki — the stored shape is
 * identical to the headless schema; only the render strategy differs.
 */
const reactInterleaveExtensions: Extensions = buildExtensions({
  mathNodeView: MathNodeView,
  codeBlockNodeView: CodeBlockNodeView,
});

/** The payload emitted on every (debounced) document change. */
export interface SourceEditorChange {
  /** The current ProseMirror document JSON. */
  readonly prosemirrorJson: unknown;
  /** The flattened plain-text mirror (kept in sync via {@link toPlainText}). */
  readonly plainText: string;
}

export interface SourceEditorProps {
  /** Initial ProseMirror JSON; `undefined` loads an empty single-paragraph doc. */
  readonly initialDoc?: unknown;
  /** Whether the editor accepts input. Defaults to `true`. */
  readonly editable?: boolean;
  /** Debounced change emitter. */
  readonly onChange?: (change: SourceEditorChange) => void;
  /** Debounce window for `onChange`, in ms. Defaults to 400. */
  readonly debounceMs?: number;
  /** Optional extra class on the editor surface (composed with `.reader`). */
  readonly className?: string;
  /**
   * Receive the live Tiptap {@link Editor} instance (or `null` on teardown) so
   * the host can drive read-point capture/jump (T017/T018). The host must not use
   * it to reach into ProseMirror directly — pass it to the `@interleave/editor`
   * read-point helpers.
   */
  readonly onEditorReady?: (editor: Editor | null) => void;
  /**
   * Install the reader display-decoration plugin ({@link ReaderDecorations}) so
   * the host can overlay the read-point divider + extracted-span markers via
   * `setReaderDecorations` (T018). View-only — it adds no schema/marks. Defaults
   * to `false` (the plain editor); the source reader sets it `true`.
   */
  readonly readerDecorations?: boolean;
}

/**
 * The constrained rich-text editor. Renders into a `.reader` surface so it
 * inherits the serif read face + spacing from the app stylesheet.
 */
export function SourceEditor({
  initialDoc,
  editable = true,
  onChange,
  debounceMs = 400,
  className,
  onEditorReady,
  readerDecorations = false,
}: SourceEditorProps): React.ReactElement {
  // Keep the latest onChange without re-creating the editor when it changes.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;
  const debounceRef = useRef(debounceMs);
  debounceRef.current = debounceMs;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The live editor + whether a debounced change is still queued, so the unmount
  // cleanup can FLUSH the pending change (not just clear the timer) and the
  // payload reflects the latest document.
  const editorRef = useRef<Editor | null>(null);
  const pendingRef = useRef(false);

  // Compose the constrained schema (with the T072 NodeViews) + the optional
  // reader-decoration plugin.
  const extensions: Extensions = useMemo(
    () =>
      readerDecorations
        ? [...reactInterleaveExtensions, ReaderDecorations]
        : reactInterleaveExtensions,
    [readerDecorations],
  );

  const editor = useEditor({
    extensions,
    // `initialDoc` is ProseMirror JSON (or empty when absent); fall back to a
    // single empty paragraph so the editor always has valid content.
    content: ((initialDoc as Content | null | undefined) ?? emptyDoc()) as Content,
    editable,
    editorProps: {
      // In reader mode, a left-click on an in-content link opens it externally. The
      // surface stays editable, but the schema keeps `openOnClick: false` so plain
      // editing never navigates — this is the controlled reader-only opt-in (other
      // editor surfaces fall through to the default click handling). Opening via
      // `window.open(_blank)` lets the desktop window-open handler route http(s) to
      // the system browser; other schemes are ignored.
      handleClick: (_view, _pos, event) => {
        if (!readerDecorations) return false;
        const anchor = (event.target as HTMLElement | null)?.closest?.(
          "a[href]",
        ) as HTMLAnchorElement | null;
        if (!anchor) return false;
        const href = anchor.getAttribute("href") ?? "";
        if (!/^https?:\/\//i.test(href)) return false;
        event.preventDefault();
        window.open(href, "_blank", "noopener,noreferrer");
        return true;
      },
    },
    // The renderer owns persistence; the editor never reaches the DB.
    onUpdate: ({ editor: instance, transaction }) => {
      const emit = onChangeRef.current;
      if (!emit) return;
      // Ignore metadata-only transactions (e.g. the reader-decoration push) — only
      // a real document change is worth persisting.
      if (!transaction.docChanged) return;
      if (timer.current) clearTimeout(timer.current);
      // Mark a change as queued so an unmount inside the debounce window flushes it.
      pendingRef.current = true;
      timer.current = setTimeout(() => {
        timer.current = null;
        pendingRef.current = false;
        const json = instance.getJSON();
        emit({ prosemirrorJson: json, plainText: toPlainText(json) });
      }, debounceRef.current);
    },
  });

  // Reflect `editable` changes without rebuilding the editor.
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  // Hand the live instance to the host (read-point capture/jump) and clear it on
  // teardown so the host never holds a stale editor. Also stash it in `editorRef`
  // so the unmount-flush cleanup can read the latest document.
  useEffect(() => {
    editorRef.current = editor ?? null;
    onEditorReadyRef.current?.(editor ?? null);
    return () => onEditorReadyRef.current?.(null);
  }, [editor]);

  // Flush any pending debounced change on unmount. If the user edits and navigates
  // away within the debounce window, the trailing edit must still reach the host's
  // `documents.save` — clearing the timer alone would silently drop the last
  // keystrokes. So we synchronously emit the pending change from the live editor
  // (compute getJSON() + toPlainText, the same payload the debounced callback would
  // have) BEFORE clearing the timer. `editorRef`/`pendingRef` hold the live editor
  // and the "a change is queued" flag without re-running this effect.
  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        if (pendingRef.current) {
          pendingRef.current = false;
          const instance = editorRef.current;
          const emit = onChangeRef.current;
          if (instance && emit) {
            const json = instance.getJSON();
            emit({ prosemirrorJson: json, plainText: toPlainText(json) });
          }
        }
      }
    };
  }, []);

  const surfaceClass = className ? `reader ${className}` : "reader";
  return <EditorContent editor={editor} className={surfaceClass} />;
}

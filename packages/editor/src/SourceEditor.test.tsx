// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  editor: {
    getJSON: vi.fn(),
    setEditable: vi.fn(),
  },
  useEditor: vi.fn(),
  lastUseEditorOptions: null as null | {
    content: unknown;
    editable: boolean;
    extensions: unknown[];
    onUpdate: (args: { editor: unknown; transaction: { docChanged: boolean } }) => void;
    editorProps?: {
      handleClick?: (view: unknown, pos: number, event: unknown) => boolean;
    };
  },
}));

vi.mock("@tiptap/react", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    useEditor: (options: typeof h.lastUseEditorOptions) => {
      h.lastUseEditorOptions = options;
      h.useEditor(options);
      return h.editor;
    },
    EditorContent: ({ editor, className }: { editor: unknown; className?: string }) =>
      React.createElement(
        "div",
        {
          "data-testid": "editor-content",
          "data-has-editor": editor ? "true" : "false",
          className,
        },
        "EditorContent",
      ),
  };
});

vi.mock("./nodes/react-node-views", () => ({
  CodeBlockNodeView: vi.fn(),
  MathNodeView: vi.fn(),
}));

vi.mock("./reader-decorations", () => ({
  ReaderDecorations: { name: "readerDecorations" },
}));

import { SourceEditor } from "./SourceEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function doc(text: string) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { blockId: "blk-a" },
        content: [{ type: "text", text }],
      },
    ],
  };
}

function renderSourceEditor(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender(next: ReactElement) {
      act(() => root.render(next));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  h.editor.getJSON.mockReset();
  h.editor.setEditable.mockReset();
  h.useEditor.mockReset();
  h.lastUseEditorOptions = null;
  h.editor.getJSON.mockReturnValue(doc("Changed"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SourceEditor", () => {
  it("renders the editor surface, reports readiness, and reflects editable changes", () => {
    const onEditorReady = vi.fn();
    const view = renderSourceEditor(
      <SourceEditor
        initialDoc={doc("Initial")}
        editable
        className="reader-extra"
        onEditorReady={onEditorReady}
      />,
    );

    const surface = view.container.querySelector("[data-testid='editor-content']");
    expect(surface?.classList.contains("reader")).toBe(true);
    expect(surface?.classList.contains("reader-extra")).toBe(true);
    expect(h.lastUseEditorOptions?.content).toEqual(doc("Initial"));
    expect(h.lastUseEditorOptions?.editable).toBe(true);
    expect(onEditorReady).toHaveBeenCalledWith(h.editor);

    view.rerender(
      <SourceEditor initialDoc={doc("Initial")} editable={false} onEditorReady={onEditorReady} />,
    );
    expect(h.editor.setEditable).toHaveBeenLastCalledWith(false);

    view.unmount();
    expect(onEditorReady).toHaveBeenLastCalledWith(null);
  });

  it("debounces document changes, ignores metadata-only updates, and emits plain text", () => {
    const onChange = vi.fn();
    renderSourceEditor(
      <SourceEditor initialDoc={doc("Initial")} debounceMs={50} onChange={onChange} />,
    );

    act(() =>
      h.lastUseEditorOptions?.onUpdate({
        editor: h.editor,
        transaction: { docChanged: false },
      }),
    );
    act(() => vi.advanceTimersByTime(60));
    expect(onChange).not.toHaveBeenCalled();

    act(() =>
      h.lastUseEditorOptions?.onUpdate({
        editor: h.editor,
        transaction: { docChanged: true },
      }),
    );
    expect(onChange).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(49));
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));

    expect(onChange).toHaveBeenCalledWith({
      prosemirrorJson: doc("Changed"),
      plainText: "Changed",
    });
  });

  it("flushes a pending debounced change on unmount", () => {
    const onChange = vi.fn();
    const view = renderSourceEditor(
      <SourceEditor initialDoc={doc("Initial")} debounceMs={500} onChange={onChange} />,
    );

    act(() =>
      h.lastUseEditorOptions?.onUpdate({
        editor: h.editor,
        transaction: { docChanged: true },
      }),
    );
    expect(onChange).not.toHaveBeenCalled();

    view.unmount();

    expect(onChange).toHaveBeenCalledWith({
      prosemirrorJson: doc("Changed"),
      plainText: "Changed",
    });
  });

  it("adds the reader decoration extension only when requested", () => {
    const plain = renderSourceEditor(<SourceEditor />);
    const plainExtensions = h.lastUseEditorOptions?.extensions ?? [];
    plain.unmount();

    renderSourceEditor(<SourceEditor readerDecorations />);
    const readerExtensions = h.lastUseEditorOptions?.extensions ?? [];

    expect(readerExtensions.length).toBe(plainExtensions.length + 1);
    expect(readerExtensions.at(-1)).toEqual({ name: "readerDecorations" });
  });

  // A ProseMirror view with a (by default collapsed) selection, and a plain
  // left-click event — the shape SourceEditor's handleClick inspects.
  const view = (selectionEmpty = true) => ({ state: { selection: { empty: selectionEmpty } } });
  const anchorEl = (href: string) => {
    const a = document.createElement("a");
    a.setAttribute("href", href);
    return a;
  };
  type ClickOverrides = Partial<{
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }>;
  const clickEvent = (target: Element, over: ClickOverrides = {}) => ({
    target,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...over,
  });

  it("opens external links on a plain left-click on a source-reading surface", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    renderSourceEditor(<SourceEditor readerDecorations openLinksOnClick />);
    const handleClick = h.lastUseEditorOptions?.editorProps?.handleClick;
    expect(handleClick).toBeTypeOf("function");

    const event = clickEvent(anchorEl("https://example.com/take-a-leap"));
    const handled = handleClick?.(view(), 0, event);

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // Consume the click so the host's mark listeners don't also fire on it.
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      "https://example.com/take-a-leap",
      "_blank",
      "noopener,noreferrer",
    );

    open.mockClear();
  });

  it("keeps caret-on-link on editable surfaces (reader decorations alone never open links)", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    // The editable extract-distillation editors enable readerDecorations but NOT
    // openLinksOnClick — clicking a linked word must place the caret, not navigate.
    renderSourceEditor(<SourceEditor readerDecorations />);
    let handleClick = h.lastUseEditorOptions?.editorProps?.handleClick;
    expect(handleClick?.(view(), 0, clickEvent(anchorEl("https://example.com")))).toBe(false);

    // A plain editor likewise never navigates.
    renderSourceEditor(<SourceEditor />);
    handleClick = h.lastUseEditorOptions?.editorProps?.handleClick;
    expect(handleClick?.(view(), 0, clickEvent(anchorEl("https://example.com")))).toBe(false);

    expect(open).not.toHaveBeenCalled();
    open.mockClear();
  });

  it("lets modified / non-primary clicks and selection drags fall through on a reading surface", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderSourceEditor(<SourceEditor readerDecorations openLinksOnClick />);
    const handleClick = h.lastUseEditorOptions?.editorProps?.handleClick;
    const anchor = anchorEl("https://example.com");

    expect(handleClick?.(view(), 0, clickEvent(anchor, { metaKey: true }))).toBe(false);
    expect(handleClick?.(view(), 0, clickEvent(anchor, { ctrlKey: true }))).toBe(false);
    expect(handleClick?.(view(), 0, clickEvent(anchor, { shiftKey: true }))).toBe(false);
    expect(handleClick?.(view(), 0, clickEvent(anchor, { button: 1 }))).toBe(false);
    // A click that ends a text-selection drag (non-empty selection) must not navigate.
    expect(handleClick?.(view(false), 0, clickEvent(anchor))).toBe(false);

    expect(open).not.toHaveBeenCalled();
    open.mockClear();
  });

  it("ignores non-http(s) link targets on a reading surface", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderSourceEditor(<SourceEditor readerDecorations openLinksOnClick />);
    const handleClick = h.lastUseEditorOptions?.editorProps?.handleClick;

    // A click on plain text (no anchor ancestor) is left to the editor.
    expect(handleClick?.(view(), 0, clickEvent(document.createElement("span")))).toBe(false);
    // A non-http scheme (e.g. javascript:) is never opened.
    expect(handleClick?.(view(), 0, clickEvent(anchorEl("javascript:alert(1)")))).toBe(false);

    expect(open).not.toHaveBeenCalled();
  });
});

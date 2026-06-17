---
title: "readerDecorations Is Not a Read-Only Signal — Gate Link-Opening on an Explicit Prop"
date: "2026-06-17"
category: "docs/solutions/ui-bugs/"
module: "packages/editor SourceEditor + apps/web reader surfaces"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "Clicking a linked word while editing an extract (process extract workbench or ExtractView) opened a browser tab instead of placing the editing caret."
  - "Link-open-on-click behaviour intended for the source reader leaked into the editable extract-distillation editors."
  - "A pointer cursor appeared over anchors on editable surfaces, implying a navigation affordance that did not belong there."
root_cause: "scope_issue"
resolution_type: "code_fix"
related_components:
  - "packages/editor/src/SourceEditor.tsx"
  - "packages/editor/src/schema.ts"
  - "apps/web/src/pages/source/SourceReader.tsx"
  - "apps/web/src/pages/queue/ProcessQueue.tsx"
  - "apps/web/src/reader/ExtractView.tsx"
  - "apps/web/src/pages/source/reader.css"
  - "apps/desktop/src/main/window.ts"
tags:
  - "source-editor"
  - "reader-decorations"
  - "open-links-on-click"
  - "prop-semantics"
  - "prosemirror"
  - "caret-placement"
---

# readerDecorations Is Not a Read-Only Signal — Gate Link-Opening on an Explicit Prop

## Problem

The reader needs in-content links to open externally on click (the Tiptap link mark keeps `openOnClick: false`, so a `handleClick` opens `http(s)` anchors via `window.open`, which the Electron main process routes to the system browser). The first implementation gated that handler on the `SourceEditor` `readerDecorations` prop — assuming `readerDecorations` meant "this is a read-only reader." It does not.

## Symptoms

- Clicking a hyperlink inside the **editable** extract-distillation editor (process session workbench, `ExtractView`) opened a browser tab instead of placing the caret to edit the linked text.
- The navigation behaviour leaked from the source-reading surfaces into every surface that renders reader decorations.

## What Didn't Work

Using `readerDecorations` as the gate. That prop means "install the reader display-decoration plugin (read-point divider, extracted-span markers)" — a *rendering* concern. It is set on **four** surfaces, three of which are editable:

| Surface | `editable` | `readerDecorations` | Should links open? |
| --- | --- | --- | --- |
| `SourceReader` (`/source/$id`) | yes | yes | **yes** |
| Process **source** workbench (`ProcessQueue`) | yes | yes | **yes** |
| Process **extract** distillation editor (`ProcessQueue`) | yes | yes | no — editing |
| `ExtractView` editable extract body | yes | yes | no — editing |

Because every `readerDecorations` consumer is also `editable`, there was no read-only surface to act as the discriminator. The unit test passed only because its "plain editing" case used a `readerDecorations={false}` config that no real consumer uses.

## Solution

Introduce an **explicit `openLinksOnClick` prop** (default `false`), orthogonal to `readerDecorations`, and set it only on the two source-*reading* surfaces. Gate the handler on it, and add click guards.

```tsx
// packages/editor/src/SourceEditor.tsx
editorProps: {
  handleClick: (view, _pos, event) => {
    if (!openLinksOnClick) return false;
    // Let modified / non-primary clicks and selection drags fall through to the
    // editor's native handling (OS new-tab, range selection, etc.).
    if (
      event.button !== 0 || event.metaKey || event.ctrlKey ||
      event.shiftKey || event.altKey || !view.state.selection.empty
    ) {
      return false;
    }
    const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!anchor) return false;
    const href = anchor.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) return false;
    event.preventDefault();
    event.stopPropagation(); // so the host's mark click-listeners don't double-fire
    window.open(href, "_blank", "noopener,noreferrer");
    return true;
  },
},
```

```tsx
// Opt-in only on the reading surfaces:
// apps/web/src/pages/source/SourceReader.tsx           -> <SourceEditor readerDecorations openLinksOnClick ... />
// apps/web/src/pages/queue/ProcessQueue.tsx (source)   -> <SourceEditor editable readerDecorations openLinksOnClick ... />
// extract workbench / ExtractView                      -> no openLinksOnClick (caret-on-click preserved)
```

The clickable cursor is scoped the same way, so editable editors never show a misleading pointer:

```css
/* apps/web/src/pages/source/reader.css — surface gets `reader--linkable` only when openLinksOnClick */
.reader--linkable a { cursor: pointer; }
```

## Why This Works

`readerDecorations` (visual rendering) and `openLinksOnClick` (click-handling policy) are independent concerns; collapsing them onto one prop conflated "shows reader markers" with "is read-only for navigation." With a dedicated opt-in, an editable surface can render reader decorations without surrendering caret-on-click. The guards keep native behaviour intact: modifier/middle clicks reach the OS, drag-selections that end on an anchor don't navigate (`selection.empty` check), `stopPropagation` prevents the reader's document-level highlight/processed-mark listeners from also firing, and the `^https?://` check blocks `javascript:`/`data:` schemes (the Electron `setWindowOpenHandler` re-validates independently).

## Prevention

- Treat a prop's name as its contract. Before reusing a flag as a proxy for another concept, enumerate **every** consumer and confirm the proxy holds for all of them. Here `readerDecorations` had four consumers; the assumption held for zero of the editable ones.
- Add a regression test that asserts the *negative* on the surface most likely to be wrongly enabled — an editable `readerDecorations` surface must NOT open links:

```ts
// packages/editor/src/SourceEditor.test.tsx
it("keeps caret-on-link on editable surfaces (reader decorations alone never open links)", () => {
  renderSourceEditor(<SourceEditor readerDecorations />); // no openLinksOnClick
  const handleClick = h.lastUseEditorOptions?.editorProps?.handleClick;
  expect(handleClick?.(view(), 0, clickEvent(anchorEl("https://example.com")))).toBe(false);
  expect(open).not.toHaveBeenCalled();
});
```

- Cover the guards (modifier/non-primary clicks, non-empty selection, non-http schemes) and add an Electron E2E that clicks a real rendered anchor and asserts `shell.openExternal` is reached (stub it via `app.evaluate`) — unit tests can't prove ProseMirror actually fires `handleClick` on a DOM anchor through Electron's window-open handler.

## Related Issues

- [Source Reader Shared Text Measure](./source-reader-shared-text-measure.md) and [Source Reader Scroll Extents and Rich Source Rendering](./source-reader-scroll-extents-rich-source-rendering.md) cover the same `SourceEditor`/`.reader` surfaces this change touches.
- [Process Queue Source Reader Unframed Workbench](./process-queue-source-reader-unframed-workbench.md) covers the process workbench that embeds the same editor.

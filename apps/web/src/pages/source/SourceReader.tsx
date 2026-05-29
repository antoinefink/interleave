/**
 * Source reading mode (T018) — the real `/source/$id` incremental reading
 * workspace, replacing the placeholder.
 *
 * A clean, serif reading column that lets the user actually process a long
 * article: a title + metadata header, the document body rendered by the T015
 * editor in a READ-LEANING resting state, a reading-progress bar, the `.readpoint`
 * divider before the first unread block, `mark.extracted` display markers for
 * already-extracted blocks, and an action bar (Set read-point · Postpone · Mark
 * done · Lower priority · Open original). It matches `design/kit/app/screen-
 * reader.jsx` in light AND dark, all reading through `window.appApi`
 * (`documents.get` / `readPoints.get` / `readPoints.set` / `inspector.get`).
 *
 * Layering: NO SQL/Node/fs here. The page orchestrates UI state + IPC only; the
 * document/editor/read-point/decoration logic lives in `@interleave/editor`
 * (`SourceEditor`, `setReaderDecorations`, the read-point helpers) and the data comes
 * through the typed bridge. Selecting the source also drives the shell's universal
 * inspector (T010), which surfaces the source's metadata, lineage, and the
 * "Extracts from this source" children — so the reader reuses the shell's right
 * panel rather than building a parallel one (per the spec).
 *
 * Scope (M4): the SELECTION TOOLBAR is wired here in T019 — selecting text pops the
 * inline Extract / Cloze / Highlight / Copy / Cancel toolbar (`useTextSelection` +
 * `SelectionToolbar`) with the `E`/`C`/`H`/`Esc` shortcuts, WITHOUT breaking the
 * ProseMirror selection. The toolbar is presentational and delegates each action to
 * callbacks: Copy/Cancel are renderer-only (clipboard + dismiss), while Highlight
 * (T020), Extract (T021), and Cloze (M6 / T033–T034) are stubs that toast until
 * those tasks land — T019 ships the UI seam only, no persistence. Postpone / Mark
 * done / Lower priority have no scheduling path until M5 (T027–T031); they render
 * disabled with a TODO rather than inventing one.
 */

import {
  type Editor,
  jumpToReadPoint,
  SourceEditor,
  setReaderDecorations,
} from "@interleave/editor";
import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { Prio, SchedulerChip, Status } from "../../components/inspector/primitives";
import { appApi, type InspectorData, isDesktop } from "../../lib/appApi";
import { SelectionToolbar, type SelectionToolbarAction } from "../../reader/SelectionToolbar";
import { useTextSelection } from "../../reader/useTextSelection";
import { Kbd } from "../../shell/Kbd";
import { useSelection } from "../../shell/selection";
import { useDocument } from "./useDocument";
import { useHighlights } from "./useHighlights";
import { useReadPoint } from "./useReadPoint";
import "./reader.css";

/** Format an ISO timestamp as a short date, or a dash. */
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** A small interpunct dot separator (matches the kit's `<Dot/>`). */
function Dot() {
  return <span className="reader-dot" aria-hidden />;
}

/** The source-metadata header row (title + provenance + chips). */
function SourceHeader({ data }: { data: InspectorData | null }) {
  const title = data?.element.title ?? "Source";
  const provenance = data?.provenance ?? null;
  return (
    <header className="reader-header" data-testid="reader-header">
      <nav className="reader-crumbs" aria-label="Breadcrumb">
        <span className="reader-crumb">
          <Icon name="library" size={14} /> Library
        </span>
        <span className="reader-crumb-sep">
          <Icon name="chevronRight" size={13} />
        </span>
        <span className="reader-crumb reader-crumb--current">
          <Icon name="source" size={14} /> {title}
        </span>
      </nav>

      <h1 className="reader-title" data-testid="reader-title">
        {title}
      </h1>

      <div className="reader-metarow">
        {provenance?.author ? (
          <>
            <span className="reader-meta">
              <Icon name="user" size={13} /> {provenance.author}
            </span>
            <Dot />
          </>
        ) : null}
        {provenance?.url ? (
          <>
            <a
              className="reader-meta reader-meta--link"
              href={provenance.url}
              target="_blank"
              rel="noreferrer"
              data-testid="reader-url"
            >
              <Icon name="globe" size={13} /> {provenance.url}
            </a>
            <Dot />
          </>
        ) : null}
        {data ? (
          <>
            <Prio priority={data.element.priority} />
            <Status status={data.element.status} />
            <Dot />
            <SchedulerChip scheduler={data.scheduler} />
            <Dot />
            <span className="reader-meta reader-meta--mono">
              last processed {fmtDate(data.scheduler.lastProcessedAt)}
              {data.element.dueAt ? ` · next ${fmtDate(data.element.dueAt)}` : ""}
            </span>
          </>
        ) : null}
      </div>
    </header>
  );
}

export function SourceReader() {
  const { id } = useParams({ from: "/source/$id" });
  const desktop = isDesktop();
  const { select } = useSelection();

  const doc = useDocument(id);
  const rp = useReadPoint(id);
  const hl = useHighlights(id);

  const [inspector, setInspector] = useState<InspectorData | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // The live Tiptap editor instance (for read-point capture/jump + decoration).
  const editorRef = useRef<Editor | null>(null);
  // A reactive mirror of the editor instance so the selection hook (T019) re-binds
  // its listeners when the editor (re)mounts; the ref above stays for imperative use.
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  // Whether we have already jumped to the read-point for the current load.
  const jumpedRef = useRef(false);

  // Drive the shell's universal inspector to this source so its metadata,
  // lineage, and "Extracts from this source" children show in the right panel.
  useEffect(() => {
    if (!desktop || !id) return;
    select(id);
  }, [desktop, id, select]);

  // Load the inspector payload (header metadata + provenance) through the bridge.
  useEffect(() => {
    if (!desktop || !id) return;
    let cancelled = false;
    void appApi
      .getInspectorData({ id })
      .then((res) => {
        if (!cancelled) setInspector(res.data);
      })
      .catch(() => {
        /* header degrades to the document title; the inspector panel shows errors */
      });
    return () => {
      cancelled = true;
    };
  }, [desktop, id]);

  // A fresh editor must be minted once per loaded document so its `content`
  // reflects the async-loaded body (Tiptap only reads `content` on creation).
  const editorKey = `${id ?? "none"}:${doc.status}`;

  const onEditorReady = useCallback((instance: Editor | null) => {
    editorRef.current = instance;
    setEditor(instance);
    setEditorReady(instance !== null);
    if (instance === null) jumpedRef.current = false;
  }, []);

  // Reset the jump latch whenever the document reloads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm on (re)load
  useEffect(() => {
    jumpedRef.current = false;
  }, [editorKey]);

  const toast = useCallback((message: string) => {
    setFlash(message);
    setTimeout(() => setFlash(null), 1600);
  }, []);

  // Text-selection toolbar (T019). The hook owns the anchor + resolved location;
  // this page owns only the action wiring. Highlight is wired in T020, Extract in
  // T021, Cloze in M6 (T033/T034) — for now those are stubs. Copy/Cancel are
  // renderer-only (no IPC). Using or dismissing the toolbar never mutates the doc.
  const selection = useTextSelection(editor, editorReady);

  const onSelectionAction = useCallback(
    (action: SelectionToolbarAction) => {
      const loc = selection.location;
      switch (action) {
        case "copy": {
          if (loc?.selectedText && typeof navigator !== "undefined" && navigator.clipboard) {
            void navigator.clipboard.writeText(loc.selectedText).then(
              () => toast("Copied to clipboard"),
              () => toast("Could not copy"),
            );
          }
          selection.dismiss();
          break;
        }
        case "highlight":
          // T020: persist the selection as a `highlight` document mark (annotation,
          // not an extract). The hook writes through `documents.marks.add`; the
          // overlay decoration re-renders from the refreshed highlight set.
          if (loc) {
            void hl.add(loc).then(
              () => toast("Highlighted"),
              () => toast("Could not highlight"),
            );
          }
          selection.dismiss();
          break;
        case "extract":
          // T021 wires extraction; surface a stub acknowledgement.
          toast("Extract lands in T021");
          selection.dismiss();
          break;
        case "cloze":
          // The card builder (Cloze) lands in M6 (T033/T034).
          toast("Cloze lands in M6");
          selection.dismiss();
          break;
        case "cancel":
          selection.dismiss();
          break;
      }
    },
    [selection, toast, hl],
  );

  // Keyboard while the toolbar is open: E → extract, C → cloze, H → highlight
  // (Escape → cancel is handled inside the hook). Mirrors the prototype's onKey;
  // ignored when there is no live selection / toolbar.
  //
  // The reader's editor is contentEditable, so a bare letter would otherwise be
  // TYPED into the selection (mutating the doc — exactly what T019 forbids on a
  // mere selection). We listen in the CAPTURE phase so this handler runs before
  // ProseMirror's own keydown handler and `preventDefault()` reliably suppresses
  // the character insertion. We also drop a real field (INPUT/TEXTAREA/SELECT) and
  // any IME composition so we never steal a genuine keystroke.
  useEffect(() => {
    if (!desktop || !selection.position) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const k = e.key.toLowerCase();
      if (k === "e") {
        e.preventDefault();
        onSelectionAction("extract");
      } else if (k === "c") {
        e.preventDefault();
        onSelectionAction("cloze");
      } else if (k === "h") {
        e.preventDefault();
        onSelectionAction("highlight");
      }
    }
    // Capture phase: beat ProseMirror's editable-surface handler to the event.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [desktop, selection.position, onSelectionAction]);

  // Push the reader's display decorations (read-point divider + extracted markers)
  // into the editor as ProseMirror decorations, and resume at the read-point on
  // first ready. Decorations are re-derived by the plugin across ProseMirror's own
  // re-renders (e.g. the T016 block-id filler), so we only push the latest inputs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rp.firstUnreadBlockId is stable per readPoint; editorKey re-arms on load
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !editorReady) return;
    setReaderDecorations(editor, {
      firstUnreadBlockId: rp.firstUnreadBlockId(doc.currentDoc),
      readPointBlockId: rp.readPoint?.blockId ?? null,
      extractedBlockIds: doc.extractedBlockIds,
      highlights: hl.highlights,
    });
    // Resume near the read-point exactly once per load, so reopening lands at the
    // saved block rather than the top.
    if (!jumpedRef.current && rp.readPoint) {
      jumpToReadPoint(editor, rp.readPoint);
      jumpedRef.current = true;
    }
  }, [
    editorReady,
    rp.readPoint,
    doc.currentDoc,
    doc.extractedBlockIds,
    rp.firstUnreadBlockId,
    hl.highlights,
    editorKey,
  ]);

  // Clicking a persisted highlight removes it (T020 — highlights are removable).
  // The highlight is rendered as an inline `mark.hl` ProseMirror decoration
  // carrying `data-mark-id`; we read that id off the click target and delete the
  // backing `document_marks` row through the hook, then the overlay re-renders.
  useEffect(() => {
    if (!desktop) return;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      const markEl = target?.closest?.("mark.hl[data-mark-id]") as HTMLElement | null;
      if (!markEl) return;
      const markId = markEl.getAttribute("data-mark-id");
      if (!markId) return;
      e.preventDefault();
      void hl.remove(markId).then(
        () => toast("Highlight removed"),
        () => toast("Could not remove highlight"),
      );
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [desktop, hl, toast]);

  // Set read-point at the current caret (Space + the primary action button).
  const onSetReadPoint = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    // Default the caret to the start of the doc so a fresh reader (no click) still
    // captures a sensible block; if the user clicked into the text, that wins.
    if (editor.state.selection.empty && editor.state.selection.from <= 1) {
      editor.commands.focus();
    }
    const resolved = await rp.setFromSelection(editor);
    toast(resolved ? "Read-point set here" : "Place the caret in the text first");
  }, [rp, toast]);

  // Keyboard: Space sets the read-point (ignored while typing in a field/modal).
  useEffect(() => {
    if (!desktop) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== " " && e.code !== "Space") return;
      const target = e.target as HTMLElement | null;
      // Don't hijack Space while editing text or inside another control.
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName))
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      void onSetReadPoint();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desktop, onSetReadPoint]);

  if (!desktop) {
    return (
      <div className="reader-state" data-testid="route-source">
        <span className="reader-state__icon">
          <Icon name="source" size={26} />
        </span>
        <h1 className="font-semibold text-text text-xl tracking-tight">Source reader</h1>
        <p className="max-w-sm">
          The reader loads documents through the desktop bridge — open the Electron app to read a
          source.
        </p>
      </div>
    );
  }

  const openOriginalUrl = inspector?.provenance?.url ?? null;
  const progress = rp.progress(doc.currentDoc);
  const progressPct = progress.total > 0 ? (progress.index / Math.max(1, progress.total)) * 100 : 0;

  return (
    <div className="reader-screen" data-testid="route-source">
      <SourceHeader data={inspector} />

      {/* action bar */}
      <div className="reader-header" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="reader-actions">
          <button
            type="button"
            className="reader-btn reader-btn--primary"
            data-testid="reader-set-readpoint"
            onClick={() => void onSetReadPoint()}
          >
            <Icon name="bookmark" size={14} /> Set read-point <Kbd keys="␣" />
          </button>
          {/* Postpone / Mark done / Lower priority have no scheduling path until M5
              (T027–T031) — render disabled rather than inventing one. */}
          <button
            type="button"
            className="reader-btn"
            disabled
            title="Scheduling lands in M5 (T027–T031)"
            data-testid="reader-postpone"
          >
            <Icon name="postpone" size={14} /> Postpone
          </button>
          <button
            type="button"
            className="reader-btn"
            disabled
            title="Scheduling lands in M5 (T027–T031)"
            data-testid="reader-mark-done"
          >
            <Icon name="checkCircle" size={14} /> Mark done
          </button>
          <button
            type="button"
            className="reader-btn"
            disabled
            title="Priority controls land in M5 (T027)"
            data-testid="reader-lower-priority"
          >
            <Icon name="arrowDown" size={14} /> Lower priority
          </button>
          {openOriginalUrl ? (
            <a
              className="reader-btn"
              href={openOriginalUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="reader-open-original"
            >
              <Icon name="external" size={14} /> Open original
            </a>
          ) : (
            <button
              type="button"
              className="reader-btn"
              disabled
              title="No original URL on this source"
              data-testid="reader-open-original"
            >
              <Icon name="external" size={14} /> Open original
            </button>
          )}
          <button
            type="button"
            className="reader-btn reader-btn--danger reader-btn--icon"
            disabled
            title="Trash + undo land in M9 (T044)"
            aria-label="Delete source"
            data-testid="reader-delete"
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>

      {/* reading column */}
      <div className="reader-page">
        <div className="reader-rail">
          <div className="reader-railhead">
            <span data-testid="reader-progress">
              {progress.total > 0
                ? `block ${Math.min(progress.index + 1, progress.total)} of ${progress.total} · ${Math.round(progressPct)}%`
                : "—"}
            </span>
            <span>read · set a read-point with ␣</span>
          </div>
          <div className="pbar" style={{ marginBottom: 28 }}>
            <div
              className="pbar__fill"
              data-testid="reader-pbar-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          {doc.status === "loading" ? (
            <p className="dimmed" data-testid="reader-loading">
              Loading source…
            </p>
          ) : doc.status === "error" ? (
            <p className="text-danger text-sm" data-testid="reader-error">
              {doc.error ?? "Failed to load this source."}
            </p>
          ) : (
            <SourceEditor
              key={editorKey}
              initialDoc={doc.initialDoc}
              editable
              readerDecorations
              onChange={doc.save}
              onEditorReady={onEditorReady}
            />
          )}
        </div>
      </div>

      <SelectionToolbar position={selection.position} onAction={onSelectionAction} />

      {flash ? (
        <div className="reader-flash" data-testid="reader-flash" role="status">
          <span
            style={{
              position: "fixed",
              bottom: 24,
              left: "50%",
              transform: "translateX(-50%)",
              background: "var(--text)",
              color: "var(--canvas)",
              padding: "9px 16px",
              borderRadius: "var(--r-full)",
              fontSize: "var(--t-sm)",
              fontWeight: 500,
              boxShadow: "var(--shadow-lg)",
              zIndex: 90,
              display: "flex",
              gap: 8,
              alignItems: "center",
            }}
          >
            <Icon name="check" size={14} />
            {flash}
          </span>
        </div>
      ) : null}
    </div>
  );
}

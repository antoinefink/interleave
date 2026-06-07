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
  jumpToSource,
  readerDecorationsKey,
  SourceEditor,
  setReaderDecorations,
} from "@interleave/editor";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalUrlLink } from "../../components/ExternalUrlLink";
import { Icon } from "../../components/Icon";
import { requestInspectorRefresh } from "../../components/inspector/Inspector";
import { Prio, SchedulerChip, Status } from "../../components/inspector/primitives";
import { appApi, type InspectorData, isDesktop } from "../../lib/appApi";
import { SelectionToolbar, type SelectionToolbarAction } from "../../reader/SelectionToolbar";
import { useTextSelection } from "../../reader/useTextSelection";
import { useActiveScope } from "../../shell/activeScope";
import { Kbd } from "../../shell/Kbd";
import { useSelection } from "../../shell/selection";
import { MediaReader } from "./MediaReader";
import { PdfReader } from "./PdfReader";
import { ProcessedSpanButtons } from "./ProcessedSpanButtons";
import { useDocument } from "./useDocument";
import { useHighlights } from "./useHighlights";
import { useProcessedSpans } from "./useProcessedSpans";
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
            <ExternalUrlLink
              className="reader-meta reader-meta--link"
              icon="globe"
              iconSize={13}
              testId="reader-url"
              url={provenance.url}
            />
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
  // Jump-to-source target (T022): `?block=<stableId>&offset=<n>&n=<nonce>` set by
  // `useNavigateToLocation` when the user clicks "Jump to source" on an extract.
  // The source route declares no `validateSearch`, so search is loosely typed.
  const search = useSearch({ strict: false }) as {
    block?: string;
    offset?: number;
    label?: string;
    n?: number;
    // T065 — jump to a PDF page (+ optional region outline to flash).
    page?: number;
    region?: { x0: number; y0: number; x1: number; y1: number };
    // T074 — seek a media reader to a clip start (milliseconds).
    t?: number;
  };
  const jumpBlock = typeof search.block === "string" ? search.block : null;
  const jumpOffset = typeof search.offset === "number" ? search.offset : 0;
  const jumpLabel = typeof search.label === "string" ? search.label : null;
  const jumpNonce = search.n;
  // The PDF page/region jump target (T065). `region` is the normalized bbox to flash.
  const jumpPage = typeof search.page === "number" ? search.page : null;
  const jumpRegion = search.region && typeof search.region.x0 === "number" ? search.region : null;
  // The media clip-start seek target (T074), in milliseconds — a clip's "open source"
  // navigates `/source/$id?t=<startMs>` so the reader seeks to the clip start.
  const jumpMs = typeof search.t === "number" ? search.t : null;
  const desktop = isDesktop();
  const { select } = useSelection();
  const navigate = useNavigate();

  /**
   * Soft-delete this source (T044) — moves it to the Trash (recoverable). Routes
   * through the typed `queue.act` delete path (`soft_delete_element`, recoverable),
   * the SAME mutation the queue uses, so no new write path is invented; the renderer
   * never touches SQLite. Accidental deletion is recoverable from `/trash` or via the
   * shell's global ⌘Z undo. After deleting we leave the (now-trashed) reader.
   */
  const deleteSource = useCallback(async () => {
    if (!isDesktop()) return;
    await appApi.actOnQueueItem({ id, action: { kind: "delete" } });
    void navigate({ to: "/queue" });
  }, [id, navigate]);

  // The reader OWNS its keyboard surface (`E`/`C`/`H` on a selection, `␣` for the
  // read-point); register the reader scope so the global shell handler defers its
  // overlapping single-letter element actions (`o`/`u`/`+`/`-`) while reading —
  // the reader has its own "Open original" + the inspector raise/lower controls
  // (T048, see `activeScope`).
  useActiveScope("reader", desktop);

  const doc = useDocument(id);
  const rp = useReadPoint(id);
  const hl = useHighlights(id);
  // Processed spans (T026): dim read/extracted paragraphs without deleting them.
  const proc = useProcessedSpans(id);

  const [inspector, setInspector] = useState<InspectorData | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // PDF reading mode (T064): the active page N of M, shown in the rail.
  const [pdfPage, setPdfPage] = useState<{ page: number; total: number }>({ page: 1, total: 0 });
  // The live Tiptap editor instance (for read-point capture/jump + decoration).
  const editorRef = useRef<Editor | null>(null);
  // A reactive mirror of the editor instance so the selection hook (T019) re-binds
  // its listeners when the editor (re)mounts; the ref above stays for imperative use.
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  // Whether we have already jumped to the read-point for the current load.
  const jumpedRef = useRef(false);

  // A token that changes whenever something that can move the paragraph anchors
  // changes (the loaded doc, the processed set — dimming shrinks a block's margin —
  // or the highlight set), so the per-paragraph "mark processed" overlay re-measures
  // its button positions. Derived (not state) so it stays in sync without an effect.
  const processedRevision =
    (doc.currentDoc ? 1 : 0) +
    proc.processed.length * 31 +
    hl.highlights.length * 7 +
    (editorReady ? 1 : 0);

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
  // T021, Cloze in M6 (T033/T034). Copy/Cancel are renderer-only (no IPC). Using or
  // dismissing the toolbar never mutates the doc.
  const selection = useTextSelection(editor, editorReady);

  // T021 — lift the current selection into an independent, attention-scheduled
  // `extract` element through `extractions.create` (all the lineage/transaction
  // work happens main-side). On success the parent paints `.extracted` over the
  // selected blocks immediately (`doc.markExtracted`) and the inspector re-fetches
  // so the new extract appears under "Extracts from this source" WITHOUT a reload.
  // The page never touches SQL — it only ships the resolved location across IPC.
  const onExtract = useCallback(async () => {
    const loc = selection.location;
    if (!id || !loc) {
      selection.dismiss();
      return;
    }
    try {
      await appApi.createExtraction({
        sourceElementId: id,
        selectedText: loc.selectedText,
        blockIds: loc.blockIds,
        startOffset: loc.startOffset,
        endOffset: loc.endOffset,
      });
      doc.markExtracted(loc.blockIds);
      // AUTO-ADVANCE-ON-EXTRACT (the T017 `markReadThrough` seam, wired here in T021
      // per the roadmap's "auto-advances when they extract"): move the read-point to
      // the END of the LAST extracted block, but only forward — extracting a passage
      // above where the user has already read must never rewind their progress. The
      // hook owns the persistence (`readPoints.set`); the read-point math lives in
      // `@interleave/editor`. Best-effort: a failure here never blocks the extract.
      const editor = editorRef.current;
      const lastBlockId = loc.blockIds.at(-1);
      if (editor && lastBlockId && rp.isAtOrAfterReadPoint(doc.currentDoc, lastBlockId)) {
        void rp.markReadThrough(editor, lastBlockId);
      }
      requestInspectorRefresh();
      toast("Extracted");
    } catch {
      toast("Could not extract");
    }
    selection.dismiss();
  }, [id, selection, doc, rp, toast]);

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
          // T021: lift the selection into an independent, attention-scheduled extract.
          void onExtract();
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
    [selection, toast, hl, onExtract],
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
    // Preserve any in-flight jump-to-source flash (T022) so re-pushing the
    // read-point/extracted/highlight inputs (e.g. on a highlight change) does not
    // wipe the accent ring before its timer clears it.
    const flashedBlockId = readerDecorationsKey.getState(editor.state)?.flashedBlockId ?? null;
    setReaderDecorations(editor, {
      firstUnreadBlockId: rp.firstUnreadBlockId(doc.currentDoc),
      readPointBlockId: rp.readPoint?.blockId ?? null,
      extractedBlockIds: doc.extractedBlockIds,
      highlights: hl.highlights,
      processed: proc.processed,
      flashedBlockId,
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
    proc.processed,
    editorKey,
  ]);

  // Jump-to-source (T022): when arriving with a `?block=…` target (clicked "Jump
  // to source" on an extract), scroll the originating paragraph into view and
  // flash the kit's accent ring once the editor is ready. The editor package owns
  // the scroll/flash (`jumpToSource`); this page only reads the param + toasts.
  // Re-runs whenever the nonce changes so re-clicking on an already-open source
  // re-fires the jump. Resolution is by STABLE block id (correct after edits).
  // biome-ignore lint/correctness/useExhaustiveDependencies: jumpNonce re-arms an intentional re-jump on an already-open source
  useEffect(() => {
    if (!desktop || !jumpBlock) return;
    const editor = editorRef.current;
    if (!editor || !editorReady) return;
    const { result, dispose } = jumpToSource(editor, jumpBlock, { offset: jumpOffset });
    if (result.kind === "fallback") {
      // The originating block was edited/removed — never a dead end: the inspector
      // still shows the stored snapshot; we just say we couldn't land precisely.
      toast("Source location moved — showing the source");
    } else {
      toast(`Jumped to source${jumpLabel ? ` · ${jumpLabel}` : ""}`);
    }
    return dispose;
  }, [desktop, jumpBlock, jumpOffset, jumpLabel, jumpNonce, editorReady, toast]);

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

  // Clicking a dimmed (processed) paragraph restores it (T026 — processed spans are
  // reversible). The processed block carries `data-processed-mark-id` via the node
  // decoration; we read that id off the clicked block and delete the backing
  // `document_marks` row through the hook. We ignore clicks that land on a highlight
  // (handled above) or that are part of a text selection (so reading/selecting a
  // dimmed paragraph still works) — only a plain click on the dimmed block restores.
  useEffect(() => {
    if (!desktop) return;
    function onClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // A highlight click is handled by its own listener — don't double-fire.
      if (target.closest("mark.hl[data-mark-id]")) return;
      // Don't restore while the user is selecting text inside the paragraph.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && (sel.toString()?.length ?? 0) > 0) return;
      const blockEl = target.closest("[data-processed-mark-id]") as HTMLElement | null;
      if (!blockEl) return;
      const markId = blockEl.getAttribute("data-processed-mark-id");
      if (!markId) return;
      e.preventDefault();
      void proc.restore(markId).then((restored) => {
        toast(restored ? "Restored" : "Could not restore");
      });
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [desktop, proc, toast]);

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
  // 1-based fraction (matches the "block N of N" label) so a read-point on the LAST
  // block reads a full 100% rather than maxing at (total-1)/total.
  const progressPct = rp.progressFraction(doc.currentDoc) * 100;

  // Media reading mode (T073): a video/audio source reuses the SAME header +
  // inspector, but swaps the editor body for an HTML5 `<video>`/`<audio>` (local,
  // streamed over `media://`) or the YouTube IFrame embed, plus a transcript pane +
  // a timestamp read-point (handled inside `MediaReader`).
  if (doc.sourceFormat === "video") {
    return (
      <div className="reader-screen" data-testid="route-source">
        <SourceHeader data={inspector} />
        <div className="reader-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="reader-actions">
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
            ) : null}
            <button
              type="button"
              className="reader-btn reader-btn--danger reader-btn--icon"
              title="Delete source (recoverable from Trash · ⌘Z to undo)"
              aria-label="Delete source"
              data-testid="reader-delete"
              onClick={() => void deleteSource()}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        </div>
        <MediaReader
          elementId={id}
          prosemirrorJson={doc.currentDoc}
          blockTimestamps={doc.blockTimestamps}
          seekToMs={jumpMs}
          onClipExtracted={() => requestInspectorRefresh()}
          toast={toast}
        />
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

  // PDF reading mode (T064): a PDF source reuses the SAME header + inspector, but
  // swaps the editor body for the `pdfjs-dist` canvas + selectable text layer. The
  // read-point + extract are page-granular (handled inside `PdfReader`).
  if (doc.sourceFormat === "pdf") {
    const pdfPct = pdfPage.total > 0 ? (pdfPage.page / pdfPage.total) * 100 : 0;
    return (
      <div className="reader-screen" data-testid="route-source">
        <SourceHeader data={inspector} />
        <div className="reader-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <div className="reader-actions">
            <span className="reader-meta reader-meta--mono" data-testid="reader-pdf-progress">
              {pdfPage.total > 0 ? `page ${pdfPage.page} of ${pdfPage.total}` : "PDF"}
            </span>
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
            ) : null}
            <button
              type="button"
              className="reader-btn reader-btn--danger reader-btn--icon"
              title="Delete source (recoverable from Trash · ⌘Z to undo)"
              aria-label="Delete source"
              data-testid="reader-delete"
              onClick={() => void deleteSource()}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        </div>
        <div className="pbar" style={{ margin: 0 }}>
          <div
            className="pbar__fill"
            data-testid="reader-pbar-fill"
            style={{ width: `${pdfPct}%` }}
          />
        </div>
        <PdfReader
          elementId={id}
          blockPages={doc.blockPages}
          onActivePageChange={(page, total) => {
            setPdfPage({ page, total });
            // A page change advances reading progress; the inspector re-reads lineage.
            requestInspectorRefresh();
          }}
          onRegionExtracted={() => requestInspectorRefresh()}
          jump={jumpPage != null ? { page: jumpPage, region: jumpRegion } : null}
          toast={toast}
        />
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
            disabled={!desktop}
            title="Delete source (recoverable from Trash · ⌘Z to undo)"
            aria-label="Delete source"
            data-testid="reader-delete"
            onClick={() => void deleteSource()}
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
            <>
              <SourceEditor
                key={editorKey}
                initialDoc={doc.initialDoc}
                editable
                readerDecorations
                onChange={doc.save}
                onEditorReady={onEditorReady}
              />
              {/* Per-paragraph "mark processed (dim)" / "restore" affordance (T026),
                  overlaid on the live editor's paragraph blocks (never mutating its
                  DOM). Re-measures whenever the doc or the processed/highlight set
                  changes (the `revision` token). */}
              <ProcessedSpanButtons
                editor={editor}
                editorReady={editorReady}
                processed={proc}
                revision={processedRevision}
                onToggled={(result) => toast(result === "marked" ? "Marked processed" : "Restored")}
                onToggleFailed={() => toast("Could not update processed mark")}
              />
            </>
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

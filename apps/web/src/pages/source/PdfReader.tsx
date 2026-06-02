/**
 * PDF reading mode (T064) — the `pdfjs-dist` canvas + selectable text layer the
 * `SourceReader` swaps in when a source is a PDF (`documents.get` →
 * `sourceFormat: "pdf"`).
 *
 * It loads the original PDF bytes ONCE through the typed `sources.getPdfData`
 * command (the renderer never resolves a vault path), renders pages LAZILY — only
 * the page(s) near the viewport are drawn, so a 500-page PDF stays responsive —
 * and overlays `pdfjs-dist`'s `TextLayer` so the user can SELECT text on a page.
 * Selecting text + pressing Extract (or `E`) lifts it into an `extract` whose
 * `source_locations.page` links it to the page it came from; the page is read off
 * `document_blocks.page` (the `blockPages` map) for that page's first block id.
 *
 * The read-point is PAGE-granular: scrolling to (or pressing "Set read-point" on)
 * a page persists that page's FIRST block id via `readPoints.set`, so reopening
 * resumes at the page. Pure UI: it calls the typed commands only — no fs/parse/SQL
 * in the renderer. Outside the desktop shell it degrades to a calm fallback.
 */

import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, TextLayer } from "pdfjs-dist";
// Vite resolves the worker file to a served URL (`?url`) so pdfjs runs its parse
// off the main thread in the renderer (a normal renderer dependency).
import PdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { appApi, isDesktop, type OcrPageSummary } from "../../lib/appApi";
import "./pdf-reader.css";

GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

/** The render scale (zoom) — fixed for T064; a future control can vary it. */
const RENDER_SCALE = 1.4;
/** How many pages above/below the viewport to keep rendered (windowing). */
const RENDER_WINDOW = 1;

/** The ordered (page → first block id) map derived from `blockPages`. */
function pageToFirstBlock(blockPages: Readonly<Record<string, number>>): Map<number, string> {
  // `blockPages` is insertion-ordered (document order) main-side, so the FIRST
  // entry seen for a page is that page's first block (its "Page N" heading).
  const out = new Map<number, string>();
  for (const [blockId, page] of Object.entries(blockPages)) {
    if (!out.has(page)) out.set(page, blockId);
  }
  return out;
}

export interface PdfReaderProps {
  /** The PDF source element id. */
  readonly elementId: string;
  /** The block→page map (stable block id → 1-based page) from `documents.get`. */
  readonly blockPages: Readonly<Record<string, number>>;
  /** Called when the active page changes (so the shell can show page N of M). */
  readonly onActivePageChange?: (page: number, total: number) => void;
  /** Called after a region extract is created (so the shell can refresh the inspector). */
  readonly onRegionExtracted?: () => void;
  /** Optional jump target (T065): scroll to + flash a page region (a fraction rect). */
  readonly jump?: { readonly page: number; readonly region?: RegionRect | null } | null;
  /** Toast helper from the parent reader (status messages). */
  readonly toast: (message: string) => void;
}

/** A normalized region rect (fractions 0–1 of the page) the rubber-band produces. */
interface RegionRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** A pending region crop awaiting confirm (the PNG + its page + normalized rect). */
interface PendingRegion {
  readonly page: number;
  readonly region: RegionRect;
  readonly imagePng: ArrayBuffer;
  /** A data URL preview of the crop for the confirm popover. */
  readonly previewUrl: string;
}

/** One rendered page's measured state. */
interface PageState {
  readonly pageNumber: number;
  readonly width: number;
  readonly height: number;
}

export function PdfReader({
  elementId,
  blockPages,
  onActivePageChange,
  onRegionExtracted,
  jump,
  toast,
}: PdfReaderProps) {
  const desktop = isDesktop();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<readonly PageState[]>([]);
  const [activePage, setActivePage] = useState(1);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "empty">("loading");
  const [error, setError] = useState<string | null>(null);
  // Region (figure) mode (T065): when on, dragging on a page draws a rubber-band
  // rect that crops to a `media_fragment` image extract instead of selecting text.
  const [regionMode, setRegionMode] = useState(false);
  const [pending, setPending] = useState<PendingRegion | null>(null);
  const [caption, setCaption] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Region outlines already extracted on a page (a light marker per page).
  const [extractedRegions, setExtractedRegions] = useState<
    readonly { page: number; region: RegionRect }[]
  >([]);
  // OCR (T066): the per-page recognized-text suggestion layer, the set of pages
  // detected as text-free (scanned), and the in-flight OCR job for the active page.
  const [ocrPages, setOcrPages] = useState<readonly OcrPageSummary[]>([]);
  const [textFreePages, setTextFreePages] = useState<ReadonlySet<number>>(new Set());
  const [ocrBusyPage, setOcrBusyPage] = useState<number | null>(null);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrJobId, setOcrJobId] = useState<string | null>(null);
  // Pages we have already AUTO-enqueued OCR for (the lazy on-first-read trigger),
  // so we enqueue each text-free page at most once automatically (the explicit
  // "Run OCR" button can still re-run a page on demand). A ref (not state) so it
  // never re-runs the auto effect by changing identity.
  const autoOcrPagesRef = useRef<Set<number>>(new Set());
  // Whether the existing OCR layer (`getOcr`) has loaded for the current source —
  // the lazy auto-enqueue waits for it so it never re-OCRs a page the user already
  // accepted/dismissed in a prior session (avoiding a redundant job on the race
  // between `status: "ready"` and the async `getOcr`).
  const [ocrLayerLoaded, setOcrLayerLoaded] = useState(false);

  const firstBlockByPage = useMemo(() => pageToFirstBlock(blockPages), [blockPages]);

  // Keep the active-page callback in a ref so the load effect does NOT depend on
  // its (per-render) identity — otherwise a fresh inline callback re-runs the load
  // effect on every parent render, cancelling the in-flight doc in a loop.
  const onActivePageChangeRef = useRef(onActivePageChange);
  onActivePageChangeRef.current = onActivePageChange;

  // Load the PDF bytes + size each page (without rendering them all — only the
  // viewport sizes, so the scroller has the right total height).
  useEffect(() => {
    if (!desktop || !elementId) return;
    let cancelled = false;
    setStatus("loading");
    setError(null);
    // Reset the per-page auto-OCR guard for the new source (each scanned PDF gets
    // its own one-auto-enqueue-per-page budget), and the OCR-layer-loaded gate.
    autoOcrPagesRef.current = new Set();
    setOcrLayerLoaded(false);
    void (async () => {
      try {
        const { bytes } = await appApi.getSourcePdfData({ elementId });
        if (cancelled) return;
        if (!bytes) {
          setStatus("empty");
          return;
        }
        const doc = await getDocument({ data: new Uint8Array(bytes) }).promise;
        if (cancelled) {
          await doc.destroy();
          return;
        }
        docRef.current = doc;
        const measured: PageState[] = [];
        const scanned = new Set<number>();
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const vp = page.getViewport({ scale: RENDER_SCALE });
          measured.push({ pageNumber: n, width: vp.width, height: vp.height });
          // A text-free (scanned) page yields no text items — the OCR target (T066).
          const tc = await page.getTextContent();
          if (tc.items.length === 0) scanned.add(n);
          page.cleanup();
        }
        if (cancelled) return;
        setPages(measured);
        setTextFreePages(scanned);
        setStatus("ready");
        onActivePageChangeRef.current?.(1, measured.length);
        // Load any existing OCR suggestions for the source, then open the lazy
        // auto-enqueue gate (so we never auto-OCR a page already handled before).
        void appApi.getOcr({ elementId }).then((r) => {
          if (!cancelled) {
            setOcrPages(r.pages);
            setOcrLayerLoaded(true);
          }
        });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      const doc = docRef.current;
      docRef.current = null;
      if (doc) void doc.destroy();
    };
  }, [desktop, elementId]);

  // Track the active page as the user scrolls (the page whose top is nearest the
  // viewport top), so the read-point + progress reflect where they are.
  const onScroll = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    const pageEls = root.querySelectorAll<HTMLElement>("[data-pdf-page]");
    const rootRect = root.getBoundingClientRect();
    // The active page is the one with the LARGEST visible area in the viewport
    // (robust when a page is only partially scrolled in, unlike a top-nearest rule).
    let best = 1;
    let bestVisible = -1;
    for (const el of pageEls) {
      const n = Number(el.getAttribute("data-pdf-page"));
      const r = el.getBoundingClientRect();
      const visible = Math.max(
        0,
        Math.min(r.bottom, rootRect.bottom) - Math.max(r.top, rootRect.top),
      );
      if (visible > bestVisible) {
        bestVisible = visible;
        best = n;
      }
    }
    setActivePage((prev) => {
      if (prev !== best) onActivePageChangeRef.current?.(best, pages.length);
      return best;
    });
  }, [pages.length]);

  /** The 1-based page a given DOM node lives on (for an extract's location). */
  const pageOfNode = useCallback((node: Node | null): number | null => {
    let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
    while (el) {
      const attr = el.getAttribute?.("data-pdf-page");
      if (attr) return Number(attr);
      el = el.parentElement;
    }
    return null;
  }, []);

  /** Extract the current text selection on the page → an `extract` linked to its page. */
  const onExtract = useCallback(async () => {
    if (!desktop) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!sel || sel.isCollapsed || text.length === 0) {
      toast("Select some text on the page first");
      return;
    }
    const page = pageOfNode(sel.anchorNode) ?? activePage;
    const firstBlockId = firstBlockByPage.get(page);
    if (!firstBlockId) {
      toast("Could not resolve the page for this selection");
      return;
    }
    try {
      await appApi.createExtraction({
        sourceElementId: elementId,
        selectedText: text,
        blockIds: [firstBlockId],
        page,
      });
      toast(`Extracted from page ${page}`);
      sel.removeAllRanges();
    } catch {
      toast("Could not extract");
    }
  }, [desktop, elementId, activePage, firstBlockByPage, pageOfNode, toast]);

  /**
   * Receive a freshly cropped region from a page (the rubber-band on mouse-up):
   * the page, the normalized rect, and the encoded PNG bytes. Stash it as a
   * `PendingRegion` so the confirm popover can collect an optional caption before
   * shipping it to MAIN. The PNG is produced from the page's own canvas (renderer-
   * side) — no fs/parse here.
   */
  const onRegionCrop = useCallback((region: PendingRegion) => {
    setCaption("");
    setPending(region);
  }, []);

  /** Discard the pending region (Esc / Cancel), revoking its preview URL. */
  const cancelPending = useCallback(() => {
    setPending((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    setCaption("");
  }, []);

  /** Ship the confirmed region crop to MAIN → a scheduled `media_fragment` extract. */
  const confirmRegion = useCallback(async () => {
    if (!desktop || !pending || submitting) return;
    const pageBlockId = firstBlockByPage.get(pending.page);
    if (!pageBlockId) {
      toast("Could not resolve the page for this region");
      return;
    }
    setSubmitting(true);
    try {
      await appApi.extractRegion({
        sourceElementId: elementId,
        page: pending.page,
        pageBlockId,
        region: pending.region,
        imagePng: pending.imagePng,
        caption: caption.trim() || null,
      });
      setExtractedRegions((prev) => [...prev, { page: pending.page, region: pending.region }]);
      toast(`Region extracted from page ${pending.page}`);
      onRegionExtracted?.();
      URL.revokeObjectURL(pending.previewUrl);
      setPending(null);
      setCaption("");
    } catch {
      toast("Could not extract the region");
    } finally {
      setSubmitting(false);
    }
  }, [
    desktop,
    pending,
    submitting,
    firstBlockByPage,
    elementId,
    caption,
    toast,
    onRegionExtracted,
  ]);

  /**
   * Persist a page-granular read-point. The target page is the page of the current
   * text selection (so "set read-point" while a passage on page N is selected lands
   * on page N), falling back to the active (scrolled) page when nothing is selected.
   */
  const setReadPoint = useCallback(async () => {
    if (!desktop) return;
    const sel = window.getSelection();
    const selPage = sel && !sel.isCollapsed ? (pageOfNode(sel.anchorNode) ?? null) : null;
    const targetPage = selPage ?? activePage;
    const firstBlockId = firstBlockByPage.get(targetPage);
    if (!firstBlockId) {
      toast("No read-point anchor for this page");
      return;
    }
    try {
      await appApi.setReadPoint({
        elementId,
        documentId: elementId,
        blockId: firstBlockId,
        offset: 0,
      });
      toast(`Read-point set on page ${targetPage}`);
    } catch {
      toast("Could not set read-point");
    }
  }, [desktop, elementId, activePage, firstBlockByPage, pageOfNode, toast]);

  // --- OCR (T066) ----------------------------------------------------------

  /** Render one page to a PNG `ArrayBuffer` (off the visible canvases) for OCR. */
  const renderPageToPng = useCallback(async (pageNumber: number): Promise<ArrayBuffer | null> => {
    const doc = docRef.current;
    if (!doc) return null;
    const pdfPage = await doc.getPage(pageNumber);
    // Render at a higher scale than the reader so OCR has crisp glyphs.
    const viewport = pdfPage.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;
    pdfPage.cleanup();
    return await new Promise<ArrayBuffer | null>((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        void blob.arrayBuffer().then(resolve);
      }, "image/png");
    });
  }, []);

  /**
   * Run OCR on a page: render it → ship the PNG → enqueue → observe the job. Used
   * by BOTH the explicit "Run OCR" button and the lazy auto-enqueue effect below
   * (the latter fires once per text-free page on first read).
   */
  const runOcr = useCallback(
    async (pageNumber: number) => {
      if (!desktop || ocrBusyPage != null) return;
      setOcrBusyPage(pageNumber);
      setOcrProgress(0);
      try {
        const imagePng = await renderPageToPng(pageNumber);
        if (!imagePng) {
          toast("Could not render the page for OCR");
          setOcrBusyPage(null);
          return;
        }
        const { jobId } = await appApi.runOcr({ elementId, page: pageNumber, imagePng });
        setOcrJobId(jobId);
      } catch {
        toast("Could not start OCR");
        setOcrBusyPage(null);
      }
    },
    [desktop, elementId, ocrBusyPage, renderPageToPng, toast],
  );

  // Observe OCR jobs (T058 jobs.subscribe): track progress for the job THIS reader
  // started, and refresh the OCR suggestion layer whenever ANY `ocr` job succeeds
  // (so an auto-on-import OCR, or one enqueued elsewhere for this source, also
  // surfaces here — the JobSummary carries no source link, so we re-read `getOcr`).
  useEffect(() => {
    if (!desktop) return;
    const unsubscribe = appApi.subscribeJobs((job) => {
      const ours = ocrJobId != null && job.id === ocrJobId;
      if (ours) setOcrProgress(job.progressRatio);
      const terminal =
        job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
      if (job.type === "ocr" && job.status === "succeeded") {
        void appApi.getOcr({ elementId }).then((r) => setOcrPages(r.pages));
      }
      if (ours && terminal) {
        setOcrBusyPage(null);
        setOcrJobId(null);
        toast(job.status === "succeeded" ? "OCR finished" : "OCR failed");
      }
    });
    return unsubscribe;
  }, [desktop, ocrJobId, elementId, toast]);

  /** Accept a page's OCR text into the body (it becomes searchable/extractable). */
  const acceptOcr = useCallback(
    async (pageNumber: number) => {
      try {
        const { accepted } = await appApi.acceptOcr({ elementId, page: pageNumber });
        if (accepted) {
          toast(`OCR accepted into page ${pageNumber}`);
          const r = await appApi.getOcr({ elementId });
          setOcrPages(r.pages);
        }
      } catch {
        toast("Could not accept the OCR text");
      }
    },
    [elementId, toast],
  );

  /** Dismiss a page's OCR suggestion. */
  const dismissOcr = useCallback(
    async (pageNumber: number) => {
      try {
        await appApi.dismissOcr({ elementId, page: pageNumber });
        const r = await appApi.getOcr({ elementId });
        setOcrPages(r.pages);
      } catch {
        toast("Could not dismiss the OCR text");
      }
    },
    [elementId, toast],
  );

  /** The OCR suggestion for the active page (or `null`). */
  const activeOcr = useMemo(
    () => ocrPages.find((p) => p.page === activePage) ?? null,
    [ocrPages, activePage],
  );

  // Lazy auto-enqueue (T066 "automatic on import"): when the reader settles on a
  // text-free (scanned) page that has NO OCR record yet, automatically enqueue OCR
  // for it — so a scanned PDF gets recognized without the user pressing a button,
  // while staying BOUNDED (one page at a time, only the page being read, at most
  // once per page) so a 500-page scan never floods the queue. A page that already
  // has any OCR record (suggested / accepted / dismissed) is skipped; the explicit
  // "Run OCR" button remains available to re-run on demand.
  useEffect(() => {
    if (!desktop || status !== "ready" || !ocrLayerLoaded) return;
    if (!textFreePages.has(activePage)) return;
    if (ocrBusyPage != null) return;
    if (activeOcr) return;
    if (autoOcrPagesRef.current.has(activePage)) return;
    autoOcrPagesRef.current.add(activePage);
    void runOcr(activePage);
  }, [desktop, status, ocrLayerLoaded, activePage, textFreePages, activeOcr, ocrBusyPage, runOcr]);

  // Keyboard: `E` extracts the page selection; `R` toggles region mode; `␣` sets
  // the page read-point; `Esc` cancels a pending region crop.
  useEffect(() => {
    if (!desktop) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === "Escape" && pending) {
        e.preventDefault();
        cancelPending();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "e") {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          e.preventDefault();
          void onExtract();
        }
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        setRegionMode((on) => !on);
      } else if (e.key === " " || e.code === "Space") {
        if (target?.isContentEditable) return;
        e.preventDefault();
        void setReadPoint();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [desktop, onExtract, setReadPoint, pending, cancelPending]);

  // Jump-to-page-region (T065): when the route carries a `jump` target, scroll that
  // page into view and flash its region outline briefly.
  const [flashRegion, setFlashRegion] = useState<{ page: number; region: RegionRect } | null>(null);
  useEffect(() => {
    if (status !== "ready" || !jump) return;
    const root = scrollRef.current;
    const el = root?.querySelector<HTMLElement>(`[data-pdf-page="${jump.page}"]`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (jump.region) {
      setFlashRegion({ page: jump.page, region: jump.region });
      const t = setTimeout(() => setFlashRegion(null), 2200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [status, jump]);

  // Revoke any pending preview URL when the reader unmounts.
  useEffect(() => () => cancelPending(), [cancelPending]);

  if (!desktop) {
    return (
      <div className="pdf-reader-state" data-testid="pdf-reader-no-desktop">
        Open the desktop app to read a PDF.
      </div>
    );
  }

  return (
    <div className="pdf-reader" data-testid="pdf-reader">
      <div className="pdf-reader-bar">
        <button
          type="button"
          className="reader-btn reader-btn--primary"
          data-testid="pdf-set-readpoint"
          // Preserve the active text selection: a plain click's mousedown would
          // collapse it before the handler reads the selection's page.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void setReadPoint()}
        >
          <Icon name="bookmark" size={14} /> Set read-point
        </button>
        <button
          type="button"
          className="reader-btn"
          data-testid="pdf-extract"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void onExtract()}
        >
          <Icon name="extract" size={14} /> Extract selection
        </button>
        <button
          type="button"
          className={`reader-btn${regionMode ? " reader-btn--primary" : ""}`}
          data-testid="pdf-region-mode"
          data-active={regionMode ? "true" : "false"}
          aria-pressed={regionMode}
          title="Draw a rectangle over a figure/table to extract it (R)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setRegionMode((on) => !on)}
        >
          <Icon name="image" size={14} /> {regionMode ? "Region mode: on" : "Region"}
        </button>
        <span className="pdf-reader-pagecount" data-testid="pdf-page-indicator">
          {status === "ready" ? `Page ${activePage} of ${pages.length}` : "—"}
        </span>
      </div>

      {status === "ready" && (textFreePages.has(activePage) || activeOcr) ? (
        <OcrPanel
          page={activePage}
          ocr={activeOcr}
          busy={ocrBusyPage === activePage}
          progress={ocrProgress}
          onRun={() => void runOcr(activePage)}
          onAccept={() => void acceptOcr(activePage)}
          onDismiss={() => void dismissOcr(activePage)}
        />
      ) : null}

      {status === "loading" ? (
        <p className="pdf-reader-state" data-testid="pdf-reader-loading">
          Loading PDF…
        </p>
      ) : status === "error" ? (
        <p className="pdf-reader-state pdf-reader-state--error" data-testid="pdf-reader-error">
          {error ?? "Failed to load the PDF."}
        </p>
      ) : status === "empty" ? (
        <p className="pdf-reader-state" data-testid="pdf-reader-empty">
          This source has no PDF bytes in the vault.
        </p>
      ) : (
        <div
          className="pdf-reader-scroll"
          data-testid="pdf-reader-scroll"
          ref={scrollRef}
          onScroll={onScroll}
        >
          {pages.map((p) => (
            <PdfPageView
              key={p.pageNumber}
              docRef={docRef}
              page={p}
              activePage={activePage}
              regionMode={regionMode}
              onRegionCrop={onRegionCrop}
              extractedRegions={extractedRegions.filter((r) => r.page === p.pageNumber)}
              flashRegion={flashRegion?.page === p.pageNumber ? (flashRegion.region ?? null) : null}
            />
          ))}
        </div>
      )}

      {pending ? (
        <div className="pdf-region-confirm" data-testid="pdf-region-confirm" role="dialog">
          <div className="pdf-region-confirm__head">
            <Icon name="image" size={14} /> Extract this region as a card topic
          </div>
          <img
            className="pdf-region-confirm__preview"
            src={pending.previewUrl}
            alt="Selected region preview"
          />
          <input
            className="pdf-region-confirm__caption"
            data-testid="pdf-region-caption"
            type="text"
            placeholder={`Caption (optional) · page ${pending.page}`}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            // Enter confirms; Esc cancels (the global handler also handles Esc).
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void confirmRegion();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelPending();
              }
            }}
          />
          <div className="pdf-region-confirm__actions">
            <button
              type="button"
              className="reader-btn"
              data-testid="pdf-region-cancel"
              disabled={submitting}
              onClick={cancelPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="reader-btn reader-btn--primary"
              data-testid="pdf-region-confirm-btn"
              disabled={submitting}
              onClick={() => void confirmRegion()}
            >
              <Icon name="check" size={14} /> {submitting ? "Extracting…" : "Extract region"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A pixel rect drawn during a rubber-band drag (CSS coords within the page box). */
interface DragRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * One page slot — a fixed-size box (so the scroller height is correct without
 * rendering everything) that LAZILY draws its canvas + text layer only when it is
 * within the render window of the active page. In region mode (T065) a transparent
 * overlay captures a rubber-band drag; on release it crops the page canvas to the
 * rect, encodes a PNG, and hands it (with the normalized rect) to the parent.
 */
function PdfPageView({
  docRef,
  page,
  activePage,
  regionMode,
  onRegionCrop,
  extractedRegions,
  flashRegion,
}: {
  docRef: React.MutableRefObject<PDFDocumentProxy | null>;
  page: PageState;
  activePage: number;
  regionMode: boolean;
  onRegionCrop: (region: PendingRegion) => void;
  extractedRegions: readonly { page: number; region: RegionRect }[];
  flashRegion: RegionRect | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const renderedRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<DragRect | null>(null);
  const shouldRender = Math.abs(page.pageNumber - activePage) <= RENDER_WINDOW;

  useEffect(() => {
    if (!shouldRender || renderedRef.current) return;
    const doc = docRef.current;
    const canvas = canvasRef.current;
    const textEl = textRef.current;
    if (!doc || !canvas || !textEl) return;
    let cancelled = false;
    void (async () => {
      const pdfPage = await doc.getPage(page.pageNumber);
      if (cancelled) return;
      const viewport = pdfPage.getViewport({ scale: RENDER_SCALE });
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;
      if (cancelled) return;
      // Text layer for selection (positioned over the canvas).
      const textContent = await pdfPage.getTextContent();
      if (cancelled) return;
      textEl.replaceChildren();
      textEl.style.width = `${viewport.width}px`;
      textEl.style.height = `${viewport.height}px`;
      const textLayer = new TextLayer({
        textContentSource: textContent,
        container: textEl,
        viewport,
      });
      await textLayer.render();
      renderedRef.current = true;
      pdfPage.cleanup();
    })();
    return () => {
      cancelled = true;
    };
  }, [shouldRender, docRef, page.pageNumber]);

  // --- region rubber-band (T065) -------------------------------------------

  /** Clamp a CSS-pixel point to the page box. */
  const clampToPage = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const box = overlayRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: Math.min(Math.max(clientX - box.left, 0), box.width),
      y: Math.min(Math.max(clientY - box.top, 0), box.height),
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!regionMode) return;
      e.preventDefault();
      overlayRef.current?.setPointerCapture(e.pointerId);
      const p = clampToPage(e.clientX, e.clientY);
      dragStartRef.current = p;
      setDrag({ x: p.x, y: p.y, w: 0, h: 0 });
    },
    [regionMode, clampToPage],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStartRef.current;
      if (!regionMode || !start) return;
      const p = clampToPage(e.clientX, e.clientY);
      setDrag({
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      });
    },
    [regionMode, clampToPage],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const start = dragStartRef.current;
      dragStartRef.current = null;
      if (!regionMode || !start) return;
      try {
        overlayRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* the capture may already be gone */
      }
      const box = overlayRef.current?.getBoundingClientRect();
      const rect = drag;
      setDrag(null);
      // Ignore a tiny accidental drag (a click without a real rectangle).
      if (!box || !rect || rect.w < 6 || rect.h < 6) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      // Normalize to fractions of the page's rendered (CSS) size.
      const x0 = rect.x / box.width;
      const y0 = rect.y / box.height;
      const x1 = (rect.x + rect.w) / box.width;
      const y1 = (rect.y + rect.h) / box.height;
      // Crop the rendered canvas (backing store is at devicePixelRatio scale) to the
      // rect. The canvas pixel size maps the page 1:1 in fractions, so multiply by
      // the backing dimensions.
      const sx = Math.round(x0 * canvas.width);
      const sy = Math.round(y0 * canvas.height);
      const sw = Math.max(1, Math.round((x1 - x0) * canvas.width));
      const sh = Math.max(1, Math.round((y1 - y0) * canvas.height));
      const out = document.createElement("canvas");
      out.width = sw;
      out.height = sh;
      const octx = out.getContext("2d");
      if (!octx) return;
      octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      out.toBlob((blob) => {
        if (!blob) return;
        void blob.arrayBuffer().then((imagePng) => {
          onRegionCrop({
            page: page.pageNumber,
            region: { x0, y0, x1, y1 },
            imagePng,
            previewUrl: URL.createObjectURL(blob),
          });
        });
      }, "image/png");
    },
    [regionMode, drag, page.pageNumber, onRegionCrop],
  );

  return (
    <div
      className="pdf-page"
      data-pdf-page={page.pageNumber}
      data-testid={`pdf-page-${page.pageNumber}`}
      style={{ width: page.width, height: page.height }}
    >
      <canvas ref={canvasRef} className="pdf-page-canvas" />
      <div ref={textRef} className="pdf-page-text textLayer" />

      {/* Already-extracted region outlines (a light marker, like extracted spans). */}
      {extractedRegions.map((r) => (
        <div
          key={`${r.region.x0}:${r.region.y0}:${r.region.x1}:${r.region.y1}`}
          className="pdf-region-mark"
          style={regionStyle(r.region)}
          aria-hidden="true"
        />
      ))}

      {/* A jump-to-region flash outline (T065). */}
      {flashRegion ? (
        <div
          className="pdf-region-mark pdf-region-mark--flash"
          data-testid={`pdf-region-flash-${page.pageNumber}`}
          style={regionStyle(flashRegion)}
          aria-hidden="true"
        />
      ) : null}

      {/* Region capture overlay — only active (and pointer-grabbing) in region mode. */}
      {regionMode ? (
        <div
          ref={overlayRef}
          className="pdf-region-overlay"
          data-testid={`pdf-region-overlay-${page.pageNumber}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {drag ? (
            <div
              className="pdf-region-rubberband"
              style={{ left: drag.x, top: drag.y, width: drag.w, height: drag.h }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Inline style positioning a normalized region rect over its page box (percent). */
function regionStyle(r: RegionRect): React.CSSProperties {
  return {
    left: `${r.x0 * 100}%`,
    top: `${r.y0 * 100}%`,
    width: `${(r.x1 - r.x0) * 100}%`,
    height: `${(r.y1 - r.y0) * 100}%`,
  };
}

/** Confidence band thresholds → a green/amber/red badge (T066). */
function confidenceBand(meanConfidence: number): "high" | "medium" | "low" {
  if (meanConfidence >= 80) return "high";
  if (meanConfidence >= 55) return "medium";
  return "low";
}

/**
 * The OCR affordance for a scanned/text-free page (T066). When the page has no OCR
 * yet it shows a "Scanned page — Run OCR" prompt; while the job runs it shows
 * progress; once recognized it shows the text as a SUGGESTION with a confidence
 * badge (green/amber/red) and Accept / Dismiss. The text is NEVER auto-merged — the
 * user accepts it into the searchable body. Low confidence is visibly flagged.
 */
function OcrPanel({
  page,
  ocr,
  busy,
  progress,
  onRun,
  onAccept,
  onDismiss,
}: {
  page: number;
  ocr: OcrPageSummary | null;
  busy: boolean;
  progress: number;
  onRun: () => void;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  // A suggestion to review (recognized + not yet accepted/dismissed).
  if (ocr && ocr.status === "suggested") {
    const band = confidenceBand(ocr.meanConfidence);
    return (
      <section
        className="pdf-ocr-panel"
        data-testid="pdf-ocr-suggestion"
        aria-label={`OCR text for page ${page}`}
      >
        <div className="pdf-ocr-panel__head">
          <Icon name="extract" size={14} /> OCR text for page {page}
          <span
            className={`pdf-ocr-badge pdf-ocr-badge--${band}`}
            data-testid="pdf-ocr-confidence"
            title="Mean recognition confidence"
          >
            {ocr.meanConfidence}% confidence
            {band === "low" ? " · low — review carefully" : ""}
          </span>
        </div>
        <p className="pdf-ocr-panel__text" data-testid="pdf-ocr-text">
          {ocr.text || "(no text recognized)"}
        </p>
        <div className="pdf-ocr-panel__actions">
          <button
            type="button"
            className="reader-btn"
            data-testid="pdf-ocr-dismiss"
            onClick={onDismiss}
          >
            Dismiss
          </button>
          <button
            type="button"
            className="reader-btn reader-btn--primary"
            data-testid="pdf-ocr-accept"
            onClick={onAccept}
          >
            <Icon name="check" size={14} /> Accept into page
          </button>
        </div>
      </section>
    );
  }

  // Already accepted — a calm confirmation.
  if (ocr && ocr.status === "accepted") {
    return (
      <div className="pdf-ocr-panel pdf-ocr-panel--done" data-testid="pdf-ocr-accepted">
        <Icon name="check" size={14} /> OCR text accepted into page {page} (now searchable).
      </div>
    );
  }

  // Not yet OCR'd (or dismissed) — the run prompt.
  return (
    <section
      className="pdf-ocr-panel"
      data-testid="pdf-ocr-prompt"
      aria-label={`OCR for page ${page}`}
    >
      <span className="pdf-ocr-panel__prompt">
        <Icon name="image" size={14} /> Scanned page — no embedded text.
      </span>
      {busy ? (
        <span className="pdf-ocr-panel__progress" data-testid="pdf-ocr-progress">
          Recognizing… {progress}%
        </span>
      ) : (
        <button
          type="button"
          className="reader-btn reader-btn--primary"
          data-testid="pdf-ocr-run"
          onClick={onRun}
        >
          <Icon name="extract" size={14} /> Run OCR on this page
        </button>
      )}
    </section>
  );
}

/**
 * `useDocument` (T015) — the renderer's load/save seam for a source body.
 *
 * Loads an element's document on mount via `appApi.getDocument`, exposes the
 * loaded ProseMirror JSON to the editor, and persists edits debounced via
 * `appApi.saveDocument`. The hook is the single place the source reader (T018)
 * drops the {@link SourceEditor} in — it never touches SQLite/Node/fs, only the
 * typed `window.appApi` bridge.
 *
 * It degrades gracefully outside the Electron shell (browser / Vite-only): when
 * `isDesktop()` is false the status is `"no-desktop"` and no IPC is attempted,
 * mirroring `DesktopStatusPanel`'s guard. All domain/editor logic (the schema,
 * `toPlainText`) lives in `@interleave/editor`; this hook only orchestrates UI
 * state + IPC.
 */

import type { SourceEditorChange } from "@interleave/editor";
import { emptyDoc, toBlockInputs } from "@interleave/editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { appApi, type DocumentPayload, isDesktop } from "../../lib/appApi";

/** Lifecycle of the document load. */
export type DocumentStatus = "loading" | "ready" | "no-desktop" | "error";

/** Debounce window before a change is persisted, in ms. */
const SAVE_DEBOUNCE_MS = 600;

export interface UseDocumentResult {
  /** Where the load is in its lifecycle. */
  readonly status: DocumentStatus;
  /**
   * The ProseMirror JSON to seed the editor with. `null` while loading; an empty
   * document when the element has no body yet (so the editor always has content).
   */
  readonly initialDoc: unknown;
  /**
   * The latest known ProseMirror JSON — the loaded body, then the most recent
   * edited body. The reader (T018) derives the progress bar + read-point divider
   * position from this. `null` while loading.
   */
  readonly currentDoc: unknown;
  /**
   * Distinct stable block ids in this source that already have a child extract
   * anchored to them (T018 display markers). M3 DISPLAYS them; creating extracts
   * is M4. Empty until the document has loaded (or when the source has none).
   */
  readonly extractedBlockIds: readonly string[];
  /**
   * The source body format — `"pdf"` for a paginated PDF source (T064), `"video"`
   * for a media source (T073, the `MediaReader`), else `null`. Loaded with the doc.
   */
  readonly sourceFormat: "pdf" | "video" | null;
  /**
   * For a MEDIA source (T073): `"local"` (a `media://` vault stream) or `"youtube"`
   * (an IFrame embed); `null` for non-media sources.
   */
  readonly mediaSource: "local" | "youtube" | null;
  /**
   * For a LOCAL media source (T073): `"video"`/`"audio"`; `null` otherwise.
   */
  readonly mediaKind: "video" | "audio" | null;
  /**
   * For a PAGINATED (PDF) source: the block→page map (stable block id → 1-based
   * page), so the PDF reader sets a page read-point + derives the page of a
   * selected block. Empty for non-paginated bodies.
   */
  readonly blockPages: Readonly<Record<string, number>>;
  /**
   * For a MEDIA source (T073): the block→time map (stable block id → cue start ms),
   * so the media reader seeks to a cue + persists a timestamp read-point. Empty for
   * non-media bodies.
   */
  readonly blockTimestamps: Readonly<Record<string, number>>;
  /** The persisted plain-text mirror most recently loaded/saved. */
  readonly plainText: string;
  /** Whether a save is in flight. */
  readonly saving: boolean;
  /** The last load/save error message, if any. */
  readonly error: string | null;
  /**
   * Persist a change from the editor (debounced). Safe to call on every keystroke
   * — only the last change within the debounce window is written.
   */
  readonly save: (change: SourceEditorChange) => void;
  /** Force-flush a pending debounced save immediately (e.g. on blur / unmount). */
  readonly flush: () => void;
  /**
   * Optimistically merge newly extracted block ids into {@link extractedBlockIds}
   * so the reader paints the `mark.extracted` display marker immediately after an
   * extraction (T021), without re-fetching the document. Idempotent.
   */
  readonly markExtracted: (blockIds: readonly string[]) => void;
}

/**
 * Manage loading + debounced saving of one element's document body.
 *
 * @param elementId The owning element id, or `null`/`undefined` to stay idle.
 */
export function useDocument(elementId: string | null | undefined): UseDocumentResult {
  const [status, setStatus] = useState<DocumentStatus>(isDesktop() ? "loading" : "no-desktop");
  const [initialDoc, setInitialDoc] = useState<unknown>(null);
  const [currentDoc, setCurrentDoc] = useState<unknown>(null);
  const [extractedBlockIds, setExtractedBlockIds] = useState<readonly string[]>([]);
  const [sourceFormat, setSourceFormat] = useState<"pdf" | "video" | null>(null);
  const [mediaSource, setMediaSource] = useState<"local" | "youtube" | null>(null);
  const [mediaKind, setMediaKind] = useState<"video" | "audio" | null>(null);
  const [blockPages, setBlockPages] = useState<Readonly<Record<string, number>>>({});
  const [blockTimestamps, setBlockTimestamps] = useState<Readonly<Record<string, number>>>({});
  const [plainText, setPlainText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pending debounced change + the element id it was enqueued FOR + timer, kept in
  // refs so the save callback is stable. The id is snapshotted at enqueue time (not
  // read late at execution) so a save queued for source A can never be written into
  // source B's row when the user navigates between sources within the debounce
  // window — the route reuses this hook across `/source/$id` param changes.
  const pending = useRef<{ change: SourceEditorChange; id: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef<string | null | undefined>(elementId);

  // Load on mount / when the element changes.
  useEffect(() => {
    if (!isDesktop()) {
      setStatus("no-desktop");
      return;
    }
    // Before switching to a new element, FLUSH any save still pending for the
    // PREVIOUS element so its trailing edit lands on ITS OWN row (the only flush
    // otherwise runs on unmount, which never fires on an in-place id swap). The
    // pending entry carries the previous id, so the flushed write targets the
    // correct source. We point `idRef` at the NEW element FIRST so the flushed
    // save sees `forCurrent = false` — it writes A's body to A's row but never
    // touches the now-current (B) source's `currentDoc`/`saving`/`error` state.
    if (idRef.current !== elementId) {
      idRef.current = elementId;
      flushRef.current();
    }
    if (!elementId) {
      setStatus("loading");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setError(null);
    void appApi
      .getDocument({ elementId })
      .then((result) => {
        if (cancelled) return;
        const doc: DocumentPayload | null = result.document;
        const loaded = doc?.prosemirrorJson ?? emptyDoc();
        setInitialDoc(loaded);
        setCurrentDoc(loaded);
        setExtractedBlockIds(result.extractedBlockIds);
        setSourceFormat(result.sourceFormat ?? null);
        setMediaSource(result.mediaSource ?? null);
        setMediaKind(result.mediaKind ?? null);
        setBlockPages(result.blockPages ?? {});
        setBlockTimestamps(result.blockTimestamps ?? {});
        setPlainText(doc?.plainText ?? "");
        setStatus("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [elementId]);

  // Persist a change AGAINST THE ELEMENT ID IT WAS ENQUEUED FOR (`targetId`), not
  // whatever the hook is now pointed at. The guard early-returns if the hook has
  // since switched elements without the pending change having been flushed for its
  // own id — so source A's body can never overwrite source B's row (the
  // load-bearing fix). `setCurrentDoc`/`setPlainText` only run when the save is
  // still for the CURRENT element, so a late-resolving save for a navigated-away
  // source never disturbs the now-visible source's UI state.
  const persist = useCallback(async (change: SourceEditorChange, targetId: string) => {
    if (!isDesktop()) return;
    // Whether this save is for the element the hook is CURRENTLY pointed at. The
    // common path (debounce/unmount-flush for the live element) is `true`; a flush
    // triggered by an element switch persists the PREVIOUS element (`false`) — it
    // must still write to `targetId` (A's body → A's row, correct) but must NOT
    // touch the now-visible source's UI state (`currentDoc`/`plainText`/`error`).
    const forCurrent = idRef.current === targetId;
    // Track the latest body so the reader's progress bar / read-point divider
    // reflect edits without a reload — only for the element on screen.
    if (forCurrent) {
      setCurrentDoc(change.prosemirrorJson);
      setSaving(true);
    }
    try {
      // Derive the stable block list from the document's `blockId` attributes
      // (T016) so every save refreshes `document_blocks` while preserving the
      // stable ids extracts/read-points anchor to. Ids are read, never minted,
      // here — the editor's additive filler already assigned them. The write goes
      // to `targetId` (the id snapshotted at enqueue time), NEVER to a source the
      // hook later navigated to — so A's body can never clobber B's row.
      const blocks = toBlockInputs(change.prosemirrorJson);
      const result = await appApi.saveDocument({
        elementId: targetId,
        prosemirrorJson: change.prosemirrorJson,
        plainText: change.plainText,
        blocks,
      });
      // Only reflect the saved plain-text mirror if the editor is still on this
      // element; a late-resolving save for a navigated-away source never disturbs
      // the now-visible source's state.
      if (idRef.current === targetId) {
        setPlainText(result.document.plainText);
        setError(null);
      }
    } catch (e) {
      if (idRef.current === targetId) setError(e instanceof Error ? e.message : String(e));
    } finally {
      // Clear the in-flight flag only if this save started it (`forCurrent`) and
      // the hook is still on this element, so we never leave a stale `saving:true`
      // nor stomp a save the new element kicked off.
      if (forCurrent && idRef.current === targetId) setSaving(false);
    }
  }, []);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const entry = pending.current;
    pending.current = null;
    // Flush ALWAYS writes against the id the change was ENQUEUED for, so a flush
    // triggered by an element switch lands the trailing edit on its own source.
    if (entry) void persist(entry.change, entry.id);
  }, [persist]);

  // Keep a stable ref to the latest `flush` so the load effect can flush the
  // PREVIOUS element's pending save on an in-place id swap without depending on
  // `flush` (which would re-run the loader on every `persist` identity change).
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const save = useCallback(
    (change: SourceEditorChange) => {
      const id = idRef.current;
      // No element in scope (or not desktop): nothing to persist this against.
      if (!id || !isDesktop()) return;
      // Snapshot the id AT ENQUEUE TIME so a later navigation cannot redirect this
      // change to a different source's row.
      pending.current = { change, id };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const next = pending.current;
        pending.current = null;
        if (next) void persist(next.change, next.id);
      }, SAVE_DEBOUNCE_MS);
    },
    [persist],
  );

  // Flush any pending save when unmounting so an edit is never lost.
  useEffect(() => flush, [flush]);

  const markExtracted = useCallback((blockIds: readonly string[]) => {
    if (blockIds.length === 0) return;
    setExtractedBlockIds((prev) => {
      const merged = new Set(prev);
      for (const id of blockIds) merged.add(id);
      return merged.size === prev.length ? prev : [...merged];
    });
  }, []);

  return {
    status,
    initialDoc,
    currentDoc,
    extractedBlockIds,
    sourceFormat,
    mediaSource,
    mediaKind,
    blockPages,
    blockTimestamps,
    plainText,
    saving,
    error,
    save,
    flush,
    markExtracted,
  };
}

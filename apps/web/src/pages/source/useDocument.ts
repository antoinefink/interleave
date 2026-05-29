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
  const [plainText, setPlainText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pending debounced change + timer, kept in refs so the save callback is stable.
  const pending = useRef<SourceEditorChange | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef<string | null | undefined>(elementId);
  idRef.current = elementId;

  // Load on mount / when the element changes.
  useEffect(() => {
    if (!isDesktop()) {
      setStatus("no-desktop");
      return;
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

  const persist = useCallback(async (change: SourceEditorChange) => {
    const id = idRef.current;
    if (!id || !isDesktop()) return;
    // Track the latest body so the reader's progress bar / read-point divider
    // reflect edits without a reload.
    setCurrentDoc(change.prosemirrorJson);
    setSaving(true);
    try {
      // Derive the stable block list from the document's `blockId` attributes
      // (T016) so every save refreshes `document_blocks` while preserving the
      // stable ids extracts/read-points anchor to. Ids are read, never minted,
      // here — the editor's additive filler already assigned them.
      const blocks = toBlockInputs(change.prosemirrorJson);
      const result = await appApi.saveDocument({
        elementId: id,
        prosemirrorJson: change.prosemirrorJson,
        plainText: change.plainText,
        blocks,
      });
      setPlainText(result.document.plainText);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, []);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const change = pending.current;
    pending.current = null;
    if (change) void persist(change);
  }, [persist]);

  const save = useCallback(
    (change: SourceEditorChange) => {
      pending.current = change;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const next = pending.current;
        pending.current = null;
        if (next) void persist(next);
      }, SAVE_DEBOUNCE_MS);
    },
    [persist],
  );

  // Flush any pending save when unmounting so an edit is never lost.
  useEffect(() => flush, [flush]);

  return {
    status,
    initialDoc,
    currentDoc,
    extractedBlockIds,
    plainText,
    saving,
    error,
    save,
    flush,
  };
}

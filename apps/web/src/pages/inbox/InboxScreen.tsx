/**
 * Import & Inbox screen (T012) — the first capture/triage surface.
 *
 * Rebuilt from the kit's `screen-inbox.jsx` for React 19 + Tailwind v4: an import
 * strip on top, then a two-pane body — a left list of inbox-status sources and a
 * right preview pane with a metadata rail, an A/B/C/D priority chip group, and a
 * triage action list (Read now / Queue soon / Save for later / Delete with keyboard hints).
 *
 * Data flows STRICTLY through the typed `window.appApi` bridge (the renderer never
 * touches SQLite): `inbox.list()` / `inbox.get(id)` to read, `sources.importManual`
 * to create, and `inbox.triage` to read now / queue soon / keep / prioritize /
 * delete. Selecting an item also sets `useSelection().select(id)` so the shell's
 * universal inspector reacts. The component is pure UI orchestration — no SQL, no
 * scheduling rules, no priority math (priority labels map to numbers on the main side).
 *
 * Every import chip is live: "Paste text" / "Manual note" open the New-source
 * modal, "Paste URL" the Import-from-URL modal, "Import PDF" / "Import file" the
 * file picker (PDF / EPUB), and "Browser capture" routes to the extension pairing.
 * Scheduling ("Read soon"), dedup/Merge, and the concept field are deferred.
 */

import { buildSchema, SourceEditor } from "@interleave/editor";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BalanceBanner } from "../../components/BalanceBanner";
import { ExternalUrlLink } from "../../components/ExternalUrlLink";
import { Icon, type IconName } from "../../components/Icon";
import { requestInspectorRefresh } from "../../components/inspector/Inspector";
import { Snackbar } from "../../components/Snackbar";
import { InlineHint } from "../../help/Contextual";
import {
  appApi,
  type InboxBulkTriageAction,
  type InboxBulkTriageResult,
  type InboxItemDetail,
  type InboxItemSummary,
  type InboxTriageSuggestionProvenance,
  isDesktop,
  type PriorityLabelInput,
  type SourceDuplicateSummary,
  type TriageSuggestionSuggestionDto,
} from "../../lib/appApi";
import { useActiveScope } from "../../shell/activeScope";
import { useInboxTriagePanel } from "../../shell/inboxTriagePanel";
import { NEW_SOURCE_EVENT, UNDO_EVENT } from "../../shell/nav";
import { useSelection } from "../../shell/selection";
import { BulkActionPanel } from "./BulkActionPanel";
import { ImportFileModal } from "./ImportFileModal";
import { ImportUrlModal } from "./ImportUrlModal";
import { groupInboxItems, type InboxGroupBy, InboxGroupedList } from "./InboxGroupedList";
import { NewSourceModal } from "./NewSourceModal";
import { priorityToLabel } from "./priority";
import { useInboxSuggestions } from "./useInboxSuggestions";
import { useInboxTriageShortcuts } from "./useInboxTriageShortcuts";
import "../source/reader.css";

/** Past-tense verb label for the snackbar + aria-live wording of a bulk sweep. */
const BULK_VERB_LABEL: Record<InboxBulkTriageAction, string> = {
  accept: "Read now",
  queueSoon: "Queued",
  keepForLater: "Saved for later",
  delete: "Deleted",
  setPriority: "Set priority",
};

/** A REMOVING verb empties the inbox of the acted ids; `setPriority` keeps them. */
function isRemovingBulkAction(action: InboxBulkTriageAction): boolean {
  return action !== "setPriority";
}

/**
 * Honest sweep summary for the snackbar + aria-live: the verb, the applied count,
 * and the skipped/errored tallies surfaced rather than masked.
 * e.g. "Queued 12 · 2 skipped" / "Set priority on 12".
 */
function bulkResultMessage(action: InboxBulkTriageAction, result: InboxBulkTriageResult): string {
  // "Set priority on 12" reads more naturally than "Set priority 12".
  const lead =
    action === "setPriority"
      ? `${BULK_VERB_LABEL[action]} on ${result.applied}`
      : `${BULK_VERB_LABEL[action]} ${result.applied}`;
  const parts = [lead];
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
  if (result.errored.length > 0) parts.push(`${result.errored.length} failed`);
  return parts.join(" · ");
}

/**
 * The per-sweep selection cap, mirroring the IPC contract's `ids.max(1000)` (KTD-8 —
 * one synchronous better-sqlite3 transaction must stay bounded). The renderer caps the
 * dispatched ids HERE so a select-all over a huge inbox triages the first N rather than
 * failing the whole batch at zod validation.
 */
const BULK_SELECTION_CAP = 1000;

/**
 * Import-strip options, all live. "Paste text" / "Manual note" open the New-source
 * modal; "Paste URL" (T060) opens the Import-from-URL modal; "Import PDF" (T064) and
 * "Import file" (T067, EPUB) open the file picker; "Browser capture" routes to the
 * extension pairing in Settings.
 */
const IMPORT_OPTS: {
  icon: IconName;
  label: string;
  hint: string;
  /** When set, clicking opens the matching modal / picker (or routes to Settings). */
  action?: "manual" | "url" | "capture" | "pdf" | "file" | "media";
}[] = [
  { icon: "link", label: "Paste URL", hint: "Fetch & clean the page", action: "url" },
  { icon: "paste", label: "Paste text", hint: "Plain text", action: "manual" },
  { icon: "source", label: "Import PDF", hint: "Read a PDF incrementally", action: "pdf" },
  {
    icon: "media",
    label: "Import media",
    hint: "Video / audio, watched incrementally",
    action: "media",
  },
  {
    icon: "library",
    label: "Import file",
    hint: "EPUB, Markdown, HTML, highlights, Anki",
    action: "file",
  },
  { icon: "globe", label: "Browser capture", hint: "Pair the extension", action: "capture" },
  { icon: "text", label: "Manual note", hint: "Your own idea", action: "manual" },
];

/** Map a thrown PDF-import `code: message` error line to a friendly message. */
function pdfImportMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // The main handler throws `code: message`; strip a leading code we recognize.
  const codes: Record<string, string> = {
    not_pdf: "That file is not a PDF.",
    too_large: "That PDF is too large to import.",
    too_many_pages: "That PDF has too many pages to import.",
    encrypted: "That PDF is password-protected.",
    unreadable: "That PDF could not be read.",
  };
  const sep = raw.indexOf(":");
  const code = sep > 0 ? raw.slice(0, sep).trim() : "";
  return codes[code] ?? "Could not import that PDF.";
}

/** Map a thrown media-import `code: message` error line to a friendly message (T073). */
function mediaImportMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const codes: Record<string, string> = {
    not_media: "That file is not a supported video or audio file.",
    too_large: "That media file is too large to import.",
    unreadable: "That media file could not be read.",
    youtube_unavailable: "That YouTube video is unavailable (private, removed, or region-locked).",
  };
  const sep = raw.indexOf(":");
  const code = sep > 0 ? raw.slice(0, sep).trim() : "";
  return codes[code] ?? "Could not import that media.";
}

const inboxPreviewSchema = buildSchema();

function validBodyDoc(value: unknown): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    inboxPreviewSchema.nodeFromJSON(value);
    return value;
  } catch {
    return null;
  }
}

/**
 * The article preview for the selected item. Triage, the priority picker, and the
 * suggestion affordances now live in the shell inspector's gated triage section
 * (see `InboxTriageSection`), so this pane is article-only: a full-width scroll
 * owner with the prose centered at the reader measure for comfortable lines.
 */
function PreviewPane({ detail }: { detail: InboxItemDetail }) {
  const { summary, provenance } = detail;
  const bodyDoc = validBodyDoc(detail.bodyDoc);
  const fallbackText = detail.bodyText ?? detail.bodyPreview ?? null;
  return (
    <div className="min-w-0 flex-1 overflow-y-auto" data-testid="inbox-preview">
      {/* Full-width scroll owner; the content centers at the reader measure so the
          freed width gives a comfortable line length rather than sprawling. */}
      <div className="mx-auto w-full max-w-[var(--reader-text-measure)] px-7 py-5">
        <div className="mb-2.5 flex items-center gap-2 text-sm text-text-3">
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-2xs">{summary.srcType}</span>
          {summary.accessedAt ? (
            <>
              <span aria-hidden>·</span>
              <span>imported {summary.accessedAt.slice(0, 10)}</span>
            </>
          ) : null}
        </div>
        <h2
          className="mb-1.5 font-semibold text-text text-xl tracking-tight"
          data-testid="inbox-preview-title"
        >
          {summary.title}
        </h2>
        {provenance.url ? (
          <div className="mb-4 flex items-center gap-1.5 text-accent-text text-sm">
            <ExternalUrlLink
              className="text-sm"
              icon="link"
              iconSize={13}
              testId="inbox-preview-url"
              url={provenance.url}
            />
          </div>
        ) : null}
        {bodyDoc ? (
          <div data-testid="inbox-preview-body">
            <SourceEditor
              key={summary.id}
              initialDoc={bodyDoc}
              editable={false}
              className="inbox-preview-reader"
            />
          </div>
        ) : fallbackText ? (
          <div
            className="font-read text-[17px] text-text leading-relaxed"
            data-testid="inbox-preview-body"
          >
            {fallbackText.split("\n\n").map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static fallback paragraphs
              <p key={i} className="mb-4">
                {p}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-3" data-testid="inbox-preview-empty">
            No body yet. Add one from the New source modal.
          </p>
        )}
      </div>
    </div>
  );
}

export function InboxScreen() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const { selectedId, select } = useSelection();
  // The relocated triage cluster renders in the shell inspector; this bridge
  // publishes the active payload and exposes the section/read-now nodes the
  // inspector registers (so reveal can scroll/focus across the component tree).
  // `registerSection` / `registerReadNowButton` are consumed by the inspector (it
  // owns the section's DOM); here we only need to publish the payload and read the
  // registered nodes back for the reveal affordance.
  const {
    setPanel: setTriagePanel,
    sectionRef: triageActionsRef,
    readNowRef: readNowButtonRef,
    registrationTick: triageRegistrationTick,
  } = useInboxTriagePanel();
  const [items, setItems] = useState<readonly InboxItemSummary[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InboxItemDetail | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [urlModalOpen, setUrlModalOpen] = useState(false);
  const [fileModalOpen, setFileModalOpen] = useState(false);
  const [defaultSourcePriority, setDefaultSourcePriority] = useState<PriorityLabelInput>("C");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triageHighlightTimerRef = useRef<number | null>(null);
  const pendingTriageFocusRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  const selIdRef = useRef<string | null>(selId);
  const triageInFlightRef = useRef(false);
  const [triageHighlighted, setTriageHighlighted] = useState(false);
  // Bumped after any list change (import / triage) so the balance banner re-reads
  // the week's counts without a full remount.
  const [balanceRefresh, setBalanceRefresh] = useState(0);

  // --- Bulk triage (T126 — U5): renderer-only selection + group-by + snackbar undo. ---
  // The selected set (multi-select), distinct from the roving cursor (`selId`).
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  // The shift-range anchor — the row a contiguous range extends from.
  const anchorRef = useRef<string | null>(null);
  // The active group-by axis (instant pure-renderer transform; switching keeps the set).
  const [groupBy, setGroupBy] = useState<InboxGroupBy>("origin");
  // The armed priority band for the bulk panel (rides with the next verb, or alone).
  const [bulkPriority, setBulkPriority] = useState<PriorityLabelInput | null>(null);
  // The snackbar's bound batch id + message (the Undo reverses exactly that batch).
  const [snack, setSnack] = useState<string | null>(null);
  const [snackBatchId, setSnackBatchId] = useState<string | null>(null);
  // The polite live-region announcement (selection count / sweep result).
  const [announce, setAnnounce] = useState("");
  // In-flight guard for a bulk sweep — reset when `busy` settles (the DoneIntentMenu rule).
  const bulkInFlightRef = useRef(false);
  // In-flight guard for the snackbar Undo, so a double-click fires only one undo call.
  const undoInFlightRef = useRef(false);
  // In-flight guard for a single-item priority/placement write — `busy` is async state, so
  // a held/double Enter could pass its check twice before React flushes; this ref blocks
  // the second synchronous fire (no duplicate accepted-provenance write).
  const mutateInFlightRef = useRef(false);

  // The `(elementId, conceptId)` pairs the user has accepted a placement for this
  // session (so the placement chip flips to the confirmed "assigned" state; re-accept is
  // a no-op). Keyed by the PAIR, not the concept alone — two inbox items can suggest the
  // same concept, and assigning one must not mark the other's chip assigned.
  const [assignedPlacements, setAssignedPlacements] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const placementKey = useCallback(
    (elementId: string, conceptId: string) => `${elementId}::${conceptId}`,
    [],
  );

  // Per-id advisory suggestions (T127 — U6), fetched by a dedicated hook that refetches
  // only when the inbox id SET changes (not on a single row's priority write) and caps
  // the batch at the IPC bound. A missing entry renders the neutral pending placeholder.
  const itemIds = useMemo(() => items.map((it) => it.id), [items]);
  const { suggestions, dropSuggestion } = useInboxSuggestions(itemIds);

  const multiSelect = selectedIds.size >= 2;

  /** Reload the list; keep/repair the current selection. */
  const refresh = useCallback(async (preferId?: string | null): Promise<boolean> => {
    if (!isDesktop()) return true;
    try {
      const { items: next } = await appApi.listInbox();
      setItems(next);
      setBalanceRefresh((n) => n + 1);
      setError(null);
      setSelId((prev) => {
        const wanted = preferId ?? prev;
        const nextId = wanted && next.some((i) => i.id === wanted) ? wanted : (next[0]?.id ?? null);
        selIdRef.current = nextId;
        return nextId;
      });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    selIdRef.current = selId;
  }, [selId]);

  // Initial load.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Source-import priority defaults are a user setting, not a hard-coded modal default.
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void appApi
      .getAppSettings()
      .then(({ settings }) => {
        if (!cancelled) setDefaultSourcePriority(priorityToLabel(settings.defaultSourcePriority));
      })
      .catch(() => {
        // Keep the built-in "C" fallback; source import remains usable if settings are unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  // Whenever the selected inbox id changes, fetch its detail + drive the shell
  // inspector selection so it shows the same element. In multi-select mode
  // (`size >= 2`) the bulk panel REPLACES the detail pane, so the per-cursor detail
  // fetch is SUPPRESSED — a 50-item sweep must not fire 50 detail IPC calls (KTD-7).
  useEffect(() => {
    if (!isDesktop() || !selId) {
      setDetail(null);
      return;
    }
    select(selId);
    if (multiSelect) {
      // The bulk panel replaces the detail pane (KTD-7); drop any stale single-item
      // detail so it can never paint against a mismatched cursor on the next collapse.
      setDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { detail: next } = await appApi.getInboxItem({ id: selId });
        if (!cancelled) setDetail(next);
      } catch (e) {
        if (!cancelled) {
          pendingTriageFocusRef.current = null;
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selId, select, multiSelect]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: section/read-now nodes are read from stable context refs at call time, not reactive deps; only the stable setter/timer refs are used.
  const revealInboxTriageActions = useCallback(() => {
    const triageActions = triageActionsRef.current;
    const readNowButton = readNowButtonRef.current;
    if (!triageActions || !readNowButton) return false;

    triageActions.scrollIntoView({ block: "nearest" });
    readNowButton.focus({ preventScroll: true });
    setTriageHighlighted(true);
    if (triageHighlightTimerRef.current !== null) {
      window.clearTimeout(triageHighlightTimerRef.current);
    }
    triageHighlightTimerRef.current = window.setTimeout(() => {
      setTriageHighlighted(false);
      triageHighlightTimerRef.current = null;
    }, 1400);
    return true;
  }, []);

  const focusInboxTriageTarget = useCallback(() => {
    if (!revealInboxTriageActions()) {
      pendingTriageFocusRef.current = selId;
    }
  }, [revealInboxTriageActions, selId]);

  // Retry a pending reveal when the detail loads OR when the inspector registers
  // the triage section's Read-now node (KTD-4): the inspector mounts that node
  // after its OWN fetch, which can land after the inbox detail does, so keying the
  // retry on `detail` alone would let the reveal no-op before the node exists.
  // biome-ignore lint/correctness/useExhaustiveDependencies: triageRegistrationTick is a deliberate retry trigger (the node is read via a ref, not a value dep).
  useEffect(() => {
    const pendingId = pendingTriageFocusRef.current;
    if (!pendingId || detail?.summary.id !== pendingId) return;
    if (revealInboxTriageActions()) {
      pendingTriageFocusRef.current = null;
    }
  }, [detail, revealInboxTriageActions, triageRegistrationTick]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset pending triage focus when the selected row changes.
  useEffect(() => {
    pendingTriageFocusRef.current = null;
  }, [selId]);

  useEffect(() => {
    return () => {
      if (triageHighlightTimerRef.current !== null) {
        window.clearTimeout(triageHighlightTimerRef.current);
      }
    };
  }, []);

  // Import a local PDF (T064) — the MAIN process opens the native file picker,
  // streams the original into the vault, parses per-page text, and creates an
  // `inbox` source. On success refresh + select it; on a typed PdfImportError
  // surface a friendly message; a cancelled picker is a no-op.
  const onImportPdf = useCallback(async () => {
    if (!isDesktop() || busy) return;
    setBusy(true);
    try {
      const result = await appApi.importPdfSource({ priority: defaultSourcePriority });
      if (result.status === "imported") {
        await refresh(result.id);
        setError(null);
      }
    } catch (e) {
      setError(pdfImportMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, defaultSourcePriority]);

  // Import a local media file (T073) — MAIN opens the native picker (filtered to
  // video/audio), then an OPTIONAL second picker for a sidecar `.vtt`/`.srt`
  // transcript, then streams the original into the vault + parses the transcript +
  // creates an `inbox` source. On success refresh + select it; a typed
  // MediaImportError surfaces a friendly message; a cancelled media picker is a no-op.
  const onImportMedia = useCallback(async () => {
    if (!isDesktop() || busy) return;
    setBusy(true);
    try {
      const picked = await appApi.pickImportFile({ kind: "media" });
      if ("cancelled" in picked || picked.paths.length === 0) {
        setBusy(false);
        return;
      }
      const mediaPath = picked.paths[0];
      if (!mediaPath) {
        setBusy(false);
        return;
      }
      // Optional sidecar transcript — the user may cancel this second picker; that is
      // fine (the media imports transcript-less). Failures here never block the import.
      let subtitlesPath: string | null = null;
      try {
        const subs = await appApi.pickImportFile({ kind: "subtitles" });
        if (!("cancelled" in subs) && subs.paths[0]) subtitlesPath = subs.paths[0];
      } catch {
        subtitlesPath = null;
      }
      const result = await appApi.importMediaSource({
        path: mediaPath,
        subtitlesPath,
        priority: defaultSourcePriority,
      });
      if (result.status === "imported") {
        await refresh(result.id);
        setError(null);
      }
    } catch (e) {
      setError(mediaImportMessage(e));
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, defaultSourcePriority]);

  const onReadNow = useCallback(async () => {
    if (!selId || busy) return;
    setBusy(true);
    try {
      const result = await appApi.triageInboxItem({ id: selId, action: { kind: "accept" } });
      if (!result.item || result.deleted) {
        await refresh(null);
        setError("Inbox item is no longer available.");
        return;
      }
      setError(null);
      // Navigating away into the reader clears the bulk selection (KTD-7 rule).
      setSelectedIds((prev) => (prev.size === 0 ? prev : new Set()));
      setBulkPriority(null);
      anchorRef.current = null;
      // Clear the triage payload BEFORE navigating so the relocated triage section
      // cannot briefly paint on the reader route during the navigate->unmount gap
      // (the source is now active, but the type+target gate would still match until
      // InboxScreen's unmount cleanup runs). Defense in depth over unmount timing.
      setTriagePanel(null);
      void navigate({ to: "/source/$id", params: { id: selId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [selId, busy, navigate, refresh, setTriagePanel]);

  const onOpenExistingDuplicate = useCallback(
    async (match: SourceDuplicateSummary) => {
      if (busy) return;
      setUrlModalOpen(false);
      if (match.status === "inbox") {
        setBusy(true);
        try {
          const result = await appApi.triageInboxItem({
            id: match.elementId,
            action: { kind: "accept" },
          });
          if (!result.item || result.deleted) {
            await refresh(null);
            setError("Inbox item is no longer available.");
            return;
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          return;
        } finally {
          setBusy(false);
        }
      }
      setError(null);
      void navigate({ to: "/source/$id", params: { id: match.elementId } });
    },
    [busy, navigate, refresh],
  );

  const onTriage = useCallback(
    async (kind: "queueSoon" | "keepForLater" | "delete") => {
      if (!selId || busy || triageInFlightRef.current) return;
      const actedId = selId;
      triageInFlightRef.current = true;
      setBusy(true);
      try {
        await appApi.triageInboxItem({ id: actedId, action: { kind } });
        // accept/queue/keep/delete all remove the source from the inbox list.
        setItems((prev) => prev.filter((item) => item.id !== actedId));
        setDetail((prev) => (prev?.summary.id === actedId ? null : prev));
        if (selIdRef.current === actedId) {
          selIdRef.current = null;
          setSelId(null);
          if (selectedIdRef.current === actedId) select(null);
        }
        const refreshed = await refresh(null);
        if (refreshed) setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        triageInFlightRef.current = false;
        setBusy(false);
      }
    },
    [selId, busy, refresh, select],
  );

  /**
   * The cursor row's banded suggestion, or `null` when there is none (still
   * computing / insufficient / no fetch). The accept/override provenance reads
   * this; the row + preview already render from the same map.
   */
  const cursorSuggestion: TriageSuggestionSuggestionDto | null = useMemo(() => {
    if (!selId) return null;
    const entry = suggestions.get(selId);
    return typeof entry === "object" && entry?.kind === "suggestion" ? entry : null;
  }, [selId, suggestions]);

  /**
   * Drop a stale chip for `id` from the suggestion map (no clobber): the
   * suggestion no longer applies because the item moved / left the inbox. The row
   * + preview re-render with no chip. Read-only on the map (never re-writes a band).
   */
  /**
   * Write a priority band on the selected item. `suggestion` carries the T127
   * accepted/overridden provenance when the write came from the suggestion chip
   * (Enter / accept) or an override (a different chip than the suggested band);
   * absent ⇒ an ordinary manual set with no marker. Staleness is re-checked here:
   * a band that already matches is a no-op (drop the chip, no clobber); an item
   * that has left the inbox surfaces a clean note.
   */
  const onSetPriority = useCallback(
    async (priority: PriorityLabelInput, suggestion?: InboxTriageSuggestionProvenance) => {
      if (!selId || busy || mutateInFlightRef.current) return;
      // Re-read live state at accept (the staleness rule): if the item already
      // carries this band, accepting is a no-op — drop the chip without a write.
      const live = items.find((it) => it.id === selId);
      if (
        live &&
        priorityToLabel(live.priority) === priority &&
        suggestion?.decision !== "overridden"
      ) {
        dropSuggestion(selId);
        return;
      }
      mutateInFlightRef.current = true;
      setBusy(true);
      try {
        const result = await appApi.triageInboxItem({
          id: selId,
          action: { kind: "setPriority", priority, ...(suggestion ? { suggestion } : {}) },
        });
        const updated = result.item;
        if (updated) {
          setItems((prev) => prev.map((item) => (item.id === selId ? updated : item)));
          setDetail((prev) => (prev ? { ...prev, summary: updated } : prev));
          // The write landed → the suggested band is now the current band, so the
          // chip would be a no-op; drop it (suppress-when-equal, no clobber).
          dropSuggestion(selId);
          // The relocated triage picker writes priority from inside the shell
          // inspector; refresh it so its own Properties priority value re-syncs
          // (the inspector fetches independently and would otherwise lag a band).
          requestInspectorRefresh();
        } else {
          // The item left the inbox since render — surface cleanly, drop the chip.
          setError("Inbox item is no longer available.");
          dropSuggestion(selId);
          await refresh(selId);
        }
        setError((prev) => (result.item ? null : prev));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        mutateInFlightRef.current = false;
        setBusy(false);
      }
    },
    [selId, busy, items, refresh, dropSuggestion],
  );

  /**
   * Set priority from a priority chip. When the chosen band DIFFERS from a live
   * suggestion this records `overridden` provenance; choosing the suggested band
   * via a chip records `accepted`; with no suggestion it is a plain manual set.
   */
  const onPickPriority = useCallback(
    (priority: PriorityLabelInput) => {
      const sug = cursorSuggestion;
      if (sug) {
        const decision = priority === sug.band ? "accepted" : "overridden";
        void onSetPriority(priority, {
          decision,
          suggestedBand: sug.band,
          signalKinds: sug.justification.signals.map((s) => s.kind),
          signalHash: sug.signalHash,
        });
        return;
      }
      void onSetPriority(priority);
    },
    [cursorSuggestion, onSetPriority],
  );

  /**
   * Accept the suggested band as-is (Enter on the cursor row, or the accept
   * affordance): write the suggested band with `accepted` provenance. A no-op when
   * the cursor row has no banded suggestion.
   */
  const onAcceptSuggestion = useCallback(() => {
    const sug = cursorSuggestion;
    if (!sug) return;
    void onSetPriority(sug.band, {
      decision: "accepted",
      suggestedBand: sug.band,
      signalKinds: sug.justification.signals.map((s) => s.kind),
      signalHash: sug.signalHash,
    });
  }, [cursorSuggestion, onSetPriority]);

  /**
   * Accept the suggested placement concept via the existing `assignConcept`
   * command (an idempotent op-logged membership edge). On success the chip flips to
   * the confirmed "assigned" state; re-accept is a client-side no-op.
   */
  const onAcceptPlacement = useCallback(
    async (conceptId: string) => {
      if (!selId || busy || mutateInFlightRef.current) return;
      const key = placementKey(selId, conceptId);
      if (assignedPlacements.has(key)) return; // re-accept (this item + concept) is a no-op
      mutateInFlightRef.current = true;
      setBusy(true);
      try {
        await appApi.assignConcept({ elementId: selId, conceptId });
        setAssignedPlacements((prev) => {
          const next = new Set(prev);
          next.add(key);
          return next;
        });
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        mutateInFlightRef.current = false;
        setBusy(false);
      }
    },
    [selId, busy, assignedPlacements, placementKey],
  );

  // Whether the cursor row's suggested placement concept has already been assigned
  // this session (drives the "assigned" confirmed state in the relocated section).
  const triagePlacementAssigned =
    selId && cursorSuggestion?.placement
      ? assignedPlacements.has(placementKey(selId, cursorSuggestion.placement.conceptId))
      : false;

  // Publish the triage payload for the single selected inbox source so the shell
  // inspector renders the relocated triage section (above Properties). Cleared when
  // nothing single is selected, in multi-select, or while detail is catching up to
  // the cursor — and on unmount (below) — so the section never leaks to other routes.
  useEffect(() => {
    if (!selId || multiSelect || !detail || detail.summary.id !== selId) {
      setTriagePanel(null);
      return;
    }
    setTriagePanel({
      targetId: detail.summary.id,
      priority: detail.summary.priority,
      busy,
      suggestion: suggestions.get(selId) ?? "pending",
      placementAssigned: triagePlacementAssigned,
      triageHighlighted,
      onReadNow,
      onTriage,
      onPickPriority,
      onAcceptSuggestion,
      onAcceptPlacement,
    });
  }, [
    selId,
    multiSelect,
    detail,
    busy,
    suggestions,
    triagePlacementAssigned,
    triageHighlighted,
    onReadNow,
    onTriage,
    onPickPriority,
    onAcceptSuggestion,
    onAcceptPlacement,
    setTriagePanel,
  ]);

  // Clear the published payload on unmount so triage never shows on other routes.
  useEffect(() => () => setTriagePanel(null), [setTriagePanel]);

  // --- Selection / grouping / bulk dispatch (T126 — U5) ---

  // Group the list by the active axis (pure renderer transform; no fetch). A flat,
  // display-ordered id list mirrors the rendered order so shift-range picks a
  // contiguous run across group boundaries the way the user sees them.
  const groups = useMemo(() => groupInboxItems(items, groupBy), [items, groupBy]);
  const orderedIds = useMemo(
    () => groups.flatMap((group) => group.items.map((it) => it.id)),
    [groups],
  );

  // The secondary group-breakdown line for the bulk panel: the labels of the groups
  // the current selection spans, in display order, deduplicated.
  const selectionBreakdown = useMemo(() => {
    if (selectedIds.size < 2) return [];
    const labels: string[] = [];
    for (const group of groups) {
      if (group.items.some((it) => selectedIds.has(it.id))) labels.push(group.label);
    }
    return labels;
  }, [groups, selectedIds]);

  /** Clear the whole selection + the armed priority + the shift anchor. */
  const clearSelection = useCallback(() => {
    setSelectedIds((prev) => (prev.size === 0 ? prev : new Set()));
    setBulkPriority(null);
    anchorRef.current = null;
  }, []);

  /**
   * Mouse selection (KTD-7): plain click selects a single id (and sets the cursor +
   * anchor); shift-click selects the contiguous range from the anchor to the clicked
   * id; ctrl/cmd-click toggles one id. The cursor (`selId`) always follows the click.
   */
  const onSelectRow = useCallback(
    (id: string, modifiers: { shift: boolean; toggle: boolean }) => {
      selIdRef.current = id;
      setSelId(id);
      if (modifiers.toggle) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        anchorRef.current = id;
        return;
      }
      if (modifiers.shift && anchorRef.current) {
        const from = orderedIds.indexOf(anchorRef.current);
        const to = orderedIds.indexOf(id);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from <= to ? [from, to] : [to, from];
          setSelectedIds(new Set(orderedIds.slice(lo, hi + 1)));
          return;
        }
      }
      // Plain click: single-select, reset the anchor here.
      setSelectedIds(new Set([id]));
      anchorRef.current = id;
    },
    [orderedIds],
  );

  /** "Select group" — add every id in the group to the selection. */
  const onSelectGroup = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    const last = ids[ids.length - 1];
    if (last) anchorRef.current = last;
  }, []);

  /** "Select all" — the visible inbox, capped at the per-sweep limit (KTD-8). */
  const onSelectAll = useCallback(() => {
    if (orderedIds.length === 0) return;
    const capped = orderedIds.slice(0, BULK_SELECTION_CAP);
    setSelectedIds(new Set(capped));
    anchorRef.current = capped[capped.length - 1] ?? null;
    if (orderedIds.length > BULK_SELECTION_CAP) {
      setAnnounce(`Selected the first ${BULK_SELECTION_CAP} of ${orderedIds.length} items.`);
    }
  }, [orderedIds]);

  // --- Keyboard cursor + selection mutators (T126 — U6) ---

  /**
   * Move the roving cursor by one row in display order (clamped at the ends). The
   * cursor is distinct from the selected set — moving it does NOT change selection;
   * it only repositions the shift anchor so a following ⇧J/⇧K range extends from
   * where the user is now.
   */
  const moveCursor = useCallback(
    (delta: 1 | -1) => {
      if (orderedIds.length === 0) return;
      const current = selIdRef.current;
      const at = current ? orderedIds.indexOf(current) : -1;
      const nextIndex =
        at === -1
          ? delta === 1
            ? 0
            : orderedIds.length - 1
          : Math.min(orderedIds.length - 1, Math.max(0, at + delta));
      const nextId = orderedIds[nextIndex];
      if (!nextId) return;
      selIdRef.current = nextId;
      setSelId(nextId);
      anchorRef.current = nextId;
      // Keep the cursor row visible during a keyboard sweep.
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(
            `[data-testid="inbox-row"][data-element-id="${nextId}"]`,
          )
          ?.scrollIntoView({ block: "nearest" });
      });
    },
    [orderedIds],
  );

  /**
   * Extend the contiguous range one row in `delta`'s direction: move the cursor,
   * then select the whole run from the shift anchor to the new cursor (mirrors a
   * ⇧-arrow range the way the user sees it across group boundaries).
   */
  const extendRange = useCallback(
    (delta: 1 | -1) => {
      if (orderedIds.length === 0) return;
      const anchor = anchorRef.current ?? selIdRef.current;
      const current = selIdRef.current;
      const at = current ? orderedIds.indexOf(current) : -1;
      const nextIndex =
        at === -1
          ? delta === 1
            ? 0
            : orderedIds.length - 1
          : Math.min(orderedIds.length - 1, Math.max(0, at + delta));
      const nextId = orderedIds[nextIndex];
      if (!nextId) return;
      selIdRef.current = nextId;
      setSelId(nextId);
      if (!anchor) anchorRef.current = nextId;
      const anchorAt = orderedIds.indexOf(anchor ?? nextId);
      if (anchorAt === -1) {
        anchorRef.current = nextId;
        setSelectedIds(new Set([nextId]));
        return;
      }
      const [lo, hi] = anchorAt <= nextIndex ? [anchorAt, nextIndex] : [nextIndex, anchorAt];
      setSelectedIds(new Set(orderedIds.slice(lo, hi + 1)));
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(
            `[data-testid="inbox-row"][data-element-id="${nextId}"]`,
          )
          ?.scrollIntoView({ block: "nearest" });
      });
    },
    [orderedIds],
  );

  /** Toggle the current cursor row in / out of the selected set (x / Space). */
  const toggleCursorRow = useCallback(() => {
    const id = selIdRef.current;
    if (!id) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchorRef.current = id;
  }, []);

  /**
   * Select the rest of the cursor's group — the cheap group sweep (a 30-item group
   * needs ONE keypress, not 30). Adds every id in the cursor row's rendered group
   * to the selection; a no-op when there is no cursor.
   */
  const selectRestOfGroup = useCallback(() => {
    const id = selIdRef.current;
    if (!id) return;
    const group = groups.find((g) => g.items.some((it) => it.id === id));
    if (!group) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const it of group.items) next.add(it.id);
      return next;
    });
    const last = group.items[group.items.length - 1];
    if (last) anchorRef.current = last.id;
  }, [groups]);

  /**
   * Move focus to the next remaining row after a REMOVING sweep dropped the acted
   * ids — keeps the keyboard path fluid (the first surviving row in display order;
   * a no-op when none remain, where the inbox-zero state takes over).
   */
  const focusNextRemainingRow = useCallback((remainingIds: readonly string[]) => {
    const target = remainingIds[0];
    if (!target) return;
    // Defer to the next frame so the re-render has painted the surviving rows.
    requestAnimationFrame(() => {
      const node = document.querySelector<HTMLButtonElement>(
        `[data-testid="inbox-row"][data-element-id="${target}"]`,
      );
      node?.focus({ preventScroll: true });
    });
  }, []);

  /**
   * Fire ONE bulk sweep over the current selection (KTD-3). A verb optionally carries
   * the armed priority in the SAME batch; a priority-only sweep (`setPriority`) keeps
   * the selection so the user can chain. Surfaces `{ applied, skipped, errored }`
   * honestly and arms the snackbar Undo to the batch id.
   */
  const runBulk = useCallback(
    async (action: InboxBulkTriageAction, priority: PriorityLabelInput | null) => {
      if (busy || bulkInFlightRef.current) return;
      const selected = [...selectedIds];
      if (selected.length === 0) return;
      // Cap the dispatched ids to the contract limit so a >1000 select-all triages the
      // first N rather than failing the entire batch at the IPC zod guard (KTD-8).
      const ids = selected.slice(0, BULK_SELECTION_CAP);
      const orderedSnapshot = orderedIds; // snapshot before the await (focus uses it post-await)
      bulkInFlightRef.current = true;
      setBusy(true);
      try {
        const result = await appApi.bulkTriageInbox({
          ids,
          action,
          ...(priority ? { priority } : {}),
        });
        const message = bulkResultMessage(action, result);
        setSnack(message);
        setSnackBatchId(result.applied > 0 ? result.batchId : null);
        const cappedNote =
          selected.length > ids.length
            ? ` First ${ids.length} of ${selected.length} selected.`
            : "";
        const erroredNote = result.errored.length > 0 ? ` ${result.errored.length} failed.` : "";
        setAnnounce(
          `${BULK_VERB_LABEL[action]} applied to ${result.applied} items. ${result.skipped.length} skipped.${erroredNote}${cappedNote}`,
        );
        // Only a removing verb that actually applied to something clears the selection;
        // a fully-skipped/errored sweep (applied === 0) keeps the set so the user can retry.
        if (isRemovingBulkAction(action) && result.applied > 0) {
          // A removing verb empties the acted rows; clear the selection (+ the armed
          // band) and refocus the next remaining row.
          const acted = new Set(ids);
          const remaining = orderedSnapshot.filter((id) => !acted.has(id));
          clearSelection();
          focusNextRemainingRow(remaining);
        }
        // A priority-only sweep KEEPS the selection AND the armed band, so the user
        // can chain a verb that combines the same band in one batch (KTD-3).
        await refresh(null);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        bulkInFlightRef.current = false;
        setBusy(false);
      }
    },
    [busy, selectedIds, orderedIds, clearSelection, focusNextRemainingRow, refresh],
  );

  /**
   * Bulk-accept each selected item's OWN suggested band (T127) in ONE batch. A
   * non-removing sweep — keeps the selection so the user can chain — that surfaces the
   * honest applied / no-suggestion / skipped tally and arms the snackbar Undo.
   */
  const onBulkApplySuggestions = useCallback(async () => {
    if (busy || bulkInFlightRef.current) return;
    const selected = [...selectedIds];
    if (selected.length === 0) return;
    const ids = selected.slice(0, BULK_SELECTION_CAP);
    bulkInFlightRef.current = true;
    setBusy(true);
    try {
      const result = await appApi.bulkApplyInboxSuggestions({ ids });
      const noSuggestion = result.skipped.filter((s) => s.reason === "no_suggestion").length;
      const otherSkipped = result.skipped.length - noSuggestion;
      const parts = [`Applied suggestions to ${result.applied}`];
      if (noSuggestion > 0) parts.push(`${noSuggestion} no suggestion`);
      if (otherSkipped > 0) parts.push(`${otherSkipped} skipped`);
      if (result.errored.length > 0) parts.push(`${result.errored.length} failed`);
      setSnack(parts.join(" · "));
      setSnackBatchId(result.applied > 0 ? result.batchId : null);
      const cappedNote =
        selected.length > ids.length ? ` First ${ids.length} of ${selected.length} selected.` : "";
      setAnnounce(
        `Applied suggestions to ${result.applied} items. ${result.skipped.length} skipped.${cappedNote}`,
      );
      await refresh(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      bulkInFlightRef.current = false;
      setBusy(false);
    }
  }, [busy, selectedIds, refresh]);

  /**
   * A bulk verb button: fire the verb + the armed band (if any) in ONE combined
   * batch — so "queue this group at B" is one `bulkTriageInbox`, one snackbar, one
   * undo (AE-2). A removing verb then clears the selection AND the armed band.
   */
  const onBulkVerb = useCallback(
    (kind: Exclude<InboxBulkTriageAction, "setPriority">) => {
      void runBulk(kind, bulkPriority);
    },
    [runBulk, bulkPriority],
  );

  /**
   * A bulk priority chip is a pure ARM TOGGLE — it fires NO batch on its own. Clicking
   * an unarmed band arms it; clicking the armed band disarms. The armed band then
   * rides with the next verb (combined, one batch) or is committed via "Set priority".
   */
  const onArmBulkPriority = useCallback((label: PriorityLabelInput) => {
    setBulkPriority((prev) => (prev === label ? null : label));
  }, []);

  /**
   * "Set priority" commits the armed band as a priority-only sweep (one batch). It
   * KEEPS the selection and the armed band so the user can chain a verb afterward.
   */
  const onSetBulkPriority = useCallback(() => {
    if (!bulkPriority) return;
    void runBulk("setPriority", bulkPriority);
  }, [runBulk, bulkPriority]);

  /**
   * Keyboard verb dispatch (U6): operate on the SELECTION SET when it is non-empty
   * (one bulk batch, carrying the armed band like the panel buttons), FALLING BACK
   * to the single cursor row (today's per-item behavior) when the set is empty — so
   * a verb key never silently widens a single-item triage into a list sweep.
   */
  const triageVerb = useCallback(
    (kind: Exclude<InboxBulkTriageAction, "setPriority">) => {
      if (selectedIds.size > 0) {
        void runBulk(kind, bulkPriority);
        return;
      }
      // Empty selection → the cursor row only, via the existing per-item commands.
      if (kind === "accept") void onReadNow();
      else void onTriage(kind);
    },
    [selectedIds.size, runBulk, bulkPriority, onReadNow, onTriage],
  );

  /** The snackbar Undo reverses exactly the bound batch (NOT the global undoLast). */
  const onBulkUndo = useCallback(() => {
    if (undoInFlightRef.current) return;
    const batchId = snackBatchId;
    setSnack(null);
    setSnackBatchId(null);
    if (!batchId) return;
    undoInFlightRef.current = true;
    void appApi
      .bulkTriageInboxUndo({ batchId })
      .then(async (result) => {
        await refresh(null);
        if (!result.undone) {
          // The movement guard refused (an item moved since the batch wrote it). Surface
          // the refusal honestly — a resolved refusal must NOT look like a success.
          setError(result.reason ?? "Undo refused — one or more items changed since this batch.");
          return;
        }
        setError(null);
        window.dispatchEvent(new CustomEvent(UNDO_EVENT));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        undoInFlightRef.current = false;
      });
  }, [snackBatchId, refresh]);

  // Drop ids from the selection that have left the list (a sweep / refresh removed
  // them). Live arrivals NEVER auto-join — the set only ever shrinks here.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(items.map((it) => it.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [items]);

  // Announce the selection count politely on every change (size >= 1).
  useEffect(() => {
    if (selectedIds.size > 0) {
      setAnnounce(`${selectedIds.size} item${selectedIds.size === 1 ? "" : "s"} selected`);
    }
  }, [selectedIds.size]);

  // The inbox is the registered "triage" keyboard scope (T126 — U6). It is the
  // active triage surface while the desktop shell shows the list and no import modal
  // is open. Marking it active makes the global shell DEFER its overlapping
  // element-action keys (`o`/`u`/`+`/`-`) to this scope so they never double-fire;
  // `⌘Z` is NOT deferred (it fires before the scope gate, so global undo always
  // works) and this scope deliberately never binds it.
  const triageScopeActive =
    desktop && items.length > 0 && !modalOpen && !urlModalOpen && !fileModalOpen;
  useActiveScope("triage", triageScopeActive);

  // The full inbox keymap (cursor move, range-extend, toggle, select-rest-of-group,
  // ⌘A select-all, Esc-clear, the four verb keys, and the A–D band-arming keys) is
  // bound in `useInboxTriageShortcuts` — a dedicated, drift-scannable hook. Verb keys
  // operate on the selection set when non-empty, falling back to the cursor row.
  useInboxTriageShortcuts(
    {
      moveCursor,
      extendRange,
      toggleCursorRow,
      selectRestOfGroup,
      selectAll: onSelectAll,
      hasSelection: () => selectedIds.size > 0,
      clearSelection,
      triageVerb,
      armPriority: onArmBulkPriority,
      acceptSuggestion: onAcceptSuggestion,
    },
    triageScopeActive,
  );

  // Open the New-source modal when the ⌘K command palette fires its event
  // ("Paste text as source…" / "New manual note…").
  useEffect(() => {
    const open = () => setModalOpen(true);
    window.addEventListener(NEW_SOURCE_EVENT, open);
    return () => window.removeEventListener(NEW_SOURCE_EVENT, open);
  }, []);

  if (!desktop) {
    return (
      <div
        className="flex h-full min-h-full flex-col items-center justify-center gap-3 px-7 py-8 text-center"
        data-testid="route-inbox"
      >
        <div className="grid size-12 place-items-center rounded-lg bg-accent-soft text-accent-text">
          <Icon name="inbox" size={26} />
        </div>
        <h1 className="font-semibold text-2xl text-text tracking-tight">Inbox</h1>
        <p className="max-w-sm text-base text-text-2">
          The inbox reads + writes sources through the desktop bridge — open the Electron app to
          triage captures.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-full flex-col" data-testid="route-inbox">
      {/* import strip */}
      <div className="border-border border-b px-6 py-4">
        <div className="mb-3 flex items-end justify-between">
          <h1 className="font-semibold text-text text-xl tracking-tight">Import &amp; Inbox</h1>
          <span className="text-sm text-text-3" data-testid="inbox-count">
            {items.length} item{items.length !== 1 ? "s" : ""} awaiting triage
            {selectedIds.size > 0 ? ` · ${selectedIds.size} selected` : ""}
          </span>
        </div>
        <div className="flex flex-wrap gap-2.5" data-coach="import">
          {IMPORT_OPTS.map((o) => {
            const enabled =
              o.action === "manual" ||
              o.action === "url" ||
              o.action === "capture" ||
              o.action === "pdf" ||
              o.action === "media" ||
              o.action === "file";
            const onClick =
              o.action === "url"
                ? () => setUrlModalOpen(true)
                : o.action === "manual"
                  ? () => setModalOpen(true)
                  : o.action === "pdf"
                    ? () => void onImportPdf()
                    : o.action === "media"
                      ? () => void onImportMedia()
                      : o.action === "file"
                        ? () => setFileModalOpen(true)
                        : o.action === "capture"
                          ? // Route to the Settings "Browser capture" pairing card (T062).
                            () => void navigate({ to: "/settings", hash: "browser-capture" })
                          : undefined;
            return (
              <button
                key={o.label}
                type="button"
                data-testid={`inbox-import-${o.label === "Manual note" ? "manual" : o.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                disabled={!enabled}
                title={enabled ? undefined : "Coming soon"}
                onClick={onClick}
                className={
                  enabled
                    ? "flex cursor-pointer items-center gap-2.5 rounded-md border border-border bg-surface px-3.5 py-2.5 text-left hover:border-border-strong"
                    : "flex cursor-not-allowed items-center gap-2.5 rounded-md border border-border bg-surface px-3.5 py-2.5 text-left opacity-50"
                }
              >
                <span className="grid size-7 place-items-center rounded-md bg-surface-2 text-text-2">
                  <Icon name={o.icon} size={14} />
                </span>
                <span className="flex flex-col">
                  <span className="font-semibold text-sm text-text">{o.label}</span>
                  <span className="text-2xs text-text-3">{o.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-2.5">
          <InlineHint slug="what-to-import" slugLabel="What to import">
            Good candidates: textbooks, overviews, technical explainers, your own notes — not
            fiction, breaking news, or do-it-to-learn tutorials.
          </InlineHint>
        </div>
      </div>

      {/* Import/process balance warning (T046) — advisory; hidden when balanced. */}
      <div className="px-2 pt-4 empty:hidden">
        <BalanceBanner
          refreshKey={balanceRefresh}
          onTriageInbox={focusInboxTriageTarget}
          triageInboxLabel="Show triage actions"
        />
      </div>

      {error ? (
        <p className="px-6 py-2 text-danger text-sm" data-testid="inbox-error">
          {error}
        </p>
      ) : null}

      {/* two-pane body */}
      <div className="flex min-h-0 flex-1">
        {items.length === 0 ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-3 px-7 text-center"
            data-testid="inbox-empty"
          >
            <div className="grid size-12 place-items-center rounded-lg bg-ok-soft text-ok">
              <Icon name="checkCircle" size={26} />
            </div>
            <h2 className="font-semibold text-text text-xl tracking-tight">Inbox zero</h2>
            <p className="max-w-sm text-base text-text-2">
              Every captured item has been triaged. New manual notes appear here.
            </p>
            <button
              type="button"
              data-testid="inbox-empty-new"
              onClick={() => setModalOpen(true)}
              className="mt-1 inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 font-medium text-sm text-text-on-accent"
            >
              <Icon name="plus" size={14} />
              New source
            </button>
          </div>
        ) : (
          <>
            <InboxGroupedList
              groups={groups}
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              selectedIds={selectedIds}
              cursorId={selId}
              suggestions={suggestions}
              totalCount={items.length}
              onSelectRow={onSelectRow}
              onSelectGroup={onSelectGroup}
              onSelectAll={onSelectAll}
            />
            {multiSelect ? (
              // size >= 2 -> the bulk panel REPLACES the per-item detail pane (KTD-7).
              <BulkActionPanel
                selectedCount={selectedIds.size}
                breakdown={selectionBreakdown}
                busy={busy}
                pendingPriority={bulkPriority}
                onVerb={onBulkVerb}
                onArmPriority={onArmBulkPriority}
                onSetPriority={onSetBulkPriority}
                onApplySuggestions={() => void onBulkApplySuggestions()}
              />
            ) : detail && detail.summary.id === selId ? (
              <PreviewPane detail={detail} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-text-3">
                Loading…
              </div>
            )}
          </>
        )}
      </div>

      {/* Polite live region: selection count + sweep result, mirroring the snackbar. */}
      <div className="sr-only" role="status" aria-live="polite" data-testid="inbox-announce">
        {announce}
      </div>

      <Snackbar
        message={snack}
        onUndo={snackBatchId ? onBulkUndo : undefined}
        onClose={() => {
          setSnack(null);
          setSnackBatchId(null);
        }}
        testId="inbox-snackbar"
        icon="check"
      />

      <NewSourceModal
        open={modalOpen}
        defaultPriority={defaultSourcePriority}
        onClose={() => setModalOpen(false)}
        onCreated={(id) => {
          setModalOpen(false);
          void refresh(id);
        }}
      />

      <ImportUrlModal
        open={urlModalOpen}
        defaultPriority={defaultSourcePriority}
        onClose={() => setUrlModalOpen(false)}
        onImported={(id) => {
          setUrlModalOpen(false);
          void refresh(id);
        }}
        onOpenExisting={onOpenExistingDuplicate}
      />

      <ImportFileModal
        open={fileModalOpen}
        initialKind="epub"
        defaultPriority={defaultSourcePriority}
        onClose={() => setFileModalOpen(false)}
        onImported={(id) => {
          setFileModalOpen(false);
          void refresh(id);
        }}
        onHighlightsImported={(firstSourceId) => {
          // Highlights produce many sources + a count summary: refresh the inbox
          // underneath but leave the modal open so the user reads the counts.
          void refresh(firstSourceId.length > 0 ? firstSourceId : null);
        }}
      />
    </div>
  );
}

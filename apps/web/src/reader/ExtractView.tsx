/**
 * Extract review mode (T024) — the real `/extract/$id` distillation workspace.
 *
 * An extract is an independent, attention-scheduled mini-topic the user processes
 * over time (T021 lifts it out of a source; this view processes it). It rebuilds
 * the LEFT + CENTER columns of `design/kit/app/screen-builder.jsx`:
 *
 *  - LEFT  — source context: the surrounding passage snapshot, a "Jump to source"
 *    affordance (T022), and the full {@link LineageTree} (T023).
 *  - CENTER — distill: the `Stage`/`SchedulerChip` chips, the `Advance stage`
 *    action + a clickable stage stepper (`raw_extract → clean_extract →
 *    atomic_statement`), the autosaved editable extract body, and the action bar
 *    — Trim, Split (T025), Convert to card (T033), Postpone, Mark done, Delete.
 *  - RIGHT — the {@link CardBuilder} (T033/T034), mounted as the third `split3`
 *    column when "Convert to card" (or the Cloze selection-toolbar action) opens
 *    it; it authors a Q&A / cloze card from THIS extract via `cards.create`.
 *
 * Every mutation flows through the typed `window.appApi` surface (`extracts.*` for
 * the distill actions, `cards.create` for card authoring) — the renderer never
 * touches SQLite/Node/fs. Stage transitions reschedule the extract on the
 * ATTENTION scheduler main-side and survive an app restart; card lineage/priority/
 * tag inheritance happens main-side in `CardService`. This component only
 * orchestrates UI state + IPC.
 *
 * Sub-extracts (T025): the same {@link SelectionToolbar} + {@link useTextSelection}
 * seam the source reader uses (T019) is reused INSIDE the extract body. Selecting a
 * fragment and pressing Extract/Sub-extract (or the Split action-bar button) calls
 * the very same `extractions.create` command as T021 — only with
 * `parentId` = THIS extract and `sourceElementId` = the original source root. That
 * reuse is what guarantees the sub-extract gets identical lineage/scheduling/logging
 * (its own body, a `source_locations` anchor INTO this extract, a `derived_from`
 * edge, inherited priority/tags, and an attention `due_at`) and the navigable chain
 * `source → extract → sub-extract`. No new service/command is added.
 */

import {
  type Editor,
  SourceEditor,
  type SourceEditorChange,
  setReaderDecorations,
  toBlockInputs,
  toPlainText,
} from "@interleave/editor";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { requestInspectorRefresh } from "../components/inspector/Inspector";
import { LineageTree } from "../components/inspector/LineageTree";
import { Prio, SchedulerChip, Stage, Status, stageLabel } from "../components/inspector/primitives";
import { RefBlock } from "../components/RefBlock";
import { HelpLink } from "../help/Contextual";
import type { CardKind } from "../lib/appApi";
import {
  appApi,
  type ExtractStage,
  type InspectorData,
  isDesktop,
  type LineageData,
} from "../lib/appApi";
import { useDocument } from "../pages/source/useDocument";
import { useHighlights } from "../pages/source/useHighlights";
import { CardDetailPanel } from "../review/CardDetailPanel";
import { useSelection } from "../shell/selection";
import { AiAssist } from "./AiAssist";
import { CardBuilder } from "./CardBuilder";
import { ClipMiniPlayer } from "./ClipMiniPlayer";
import { useNavigateToLocation } from "./navigateToLocation";
import {
  EXTRACT_SELECTION_ACTIONS,
  SelectionToolbar,
  type SelectionToolbarAction,
} from "./SelectionToolbar";
import { useTextSelection } from "./useTextSelection";
import "../pages/source/reader.css";
import "./extract-view.css";

/** The three extract distillation stages, in chain order (mirrors the main side). */
const EXTRACT_STAGES: readonly ExtractStage[] = [
  "raw_extract",
  "clean_extract",
  "atomic_statement",
];

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

export function ExtractView() {
  const { id } = useParams({ from: "/extract/$id" });
  const desktop = isDesktop();
  const navigate = useNavigate();
  const navigateToLocation = useNavigateToLocation();
  const { select } = useSelection();

  const doc = useDocument(id);
  const [inspector, setInspector] = useState<InspectorData | null>(null);
  const [lineage, setLineage] = useState<LineageData | null>(null);
  // The cropped region image (T065) for a `media_fragment` extract — fetched
  // through the typed asset-bytes command; the renderer never resolves the path.
  const [regionImageUrl, setRegionImageUrl] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Card builder (T033/T034) — null when closed; the tab + any pre-wrapped cloze
  // text are seeded when the user opens it from Convert / the Cloze toolbar action.
  const [builder, setBuilder] = useState<{
    tab: CardKind;
    clozeText?: string;
  } | null>(null);
  const [activeCardId, setActiveCardId] = useState<string | null>(null);
  const editorRef = useRef<Editor | null>(null);
  // A reactive mirror of the editor instance so the selection hook (T019/T025)
  // re-binds its listeners when the editor (re)mounts; the ref stays for imperative use.
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  // The latest edited body, mirrored so Trim can save the current text.
  const latestChange = useRef<SourceEditorChange | null>(null);
  const currentExtractIdRef = useRef(id);
  const activeCardIdRef = useRef(activeCardId);
  const reloadSeqRef = useRef(0);
  currentExtractIdRef.current = id;
  activeCardIdRef.current = activeCardId;

  const toast = useCallback((message: string) => {
    setFlash(message);
    setTimeout(() => setFlash(null), 1600);
  }, []);

  // Load the inspector payload (header chips + provenance + source location) and
  // the full lineage tree through the bridge. `reload` re-fetches both after a
  // mutation so the chips/stepper/tree reflect the new stage/due date/status.
  const reload = useCallback(() => {
    if (!desktop || !id) return;
    const requestedId = id;
    reloadSeqRef.current += 1;
    const requestSeq = reloadSeqRef.current;
    const isCurrentRequest = () =>
      reloadSeqRef.current === requestSeq && currentExtractIdRef.current === requestedId;
    void appApi
      .getInspectorData({ id: requestedId })
      .then((res) => {
        if (isCurrentRequest()) setInspector(res.data);
      })
      .catch(() => {
        /* header degrades to the document title */
      });
    void appApi
      .getLineage({ id: requestedId })
      .then((res) => {
        if (isCurrentRequest()) setLineage(res.lineage);
      })
      .catch(() => {
        /* the tree degrades to empty */
      });
  }, [desktop, id]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!id) return;
    setInspector(null);
    setLineage(null);
    setActiveCardId(null);
    select(id);
  }, [id, select]);

  // Fetch the cropped region image for a `media_fragment` extract (T065). The bytes
  // come through the typed `sources.getRegionImage` command (no path in the
  // renderer); we hold an object URL for the <img> and revoke it on change/unmount.
  useEffect(() => {
    if (
      !desktop ||
      !id ||
      inspector?.element.id !== id ||
      inspector?.element.type !== "media_fragment"
    ) {
      setRegionImageUrl(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    void appApi
      .getRegionImage({ elementId: id })
      .then((res) => {
        if (cancelled || !res.bytes) return;
        const blob = new Blob([res.bytes], { type: res.mime ?? "image/png" });
        url = URL.createObjectURL(blob);
        setRegionImageUrl(url);
      })
      .catch(() => {
        /* the figure degrades to no preview */
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      setRegionImageUrl(null);
    };
  }, [desktop, id, inspector?.element.id, inspector?.element.type]);

  const onEditorReady = useCallback((instance: Editor | null) => {
    editorRef.current = instance;
    setEditor(instance);
    setEditorReady(instance !== null);
  }, []);

  // Track the latest edited body. `useDocument.save` is the autosave path; Trim
  // reads this mirror or the live editor when applying cleanup.
  const onChange = useCallback(
    (change: SourceEditorChange) => {
      latestChange.current = change;
      doc.save(change);
    },
    [doc],
  );

  const currentInspector = inspector?.element.id === id ? inspector : null;
  const currentLineage = lineage?.elementId === id ? lineage : null;
  const element = currentInspector?.element ?? null;
  const stage = (element?.stage ?? "raw_extract") as ExtractStage;
  const stageIdx = Math.max(0, EXTRACT_STAGES.indexOf(stage));

  // Advance / set the extract's stage through `extracts.updateStage` — the main
  // side persists the stage AND reschedules on the attention scheduler in one
  // transaction. We then re-fetch so the chips + stepper + tree update.
  const setStage = useCallback(
    async (target?: ExtractStage) => {
      if (!id || busy) return;
      setBusy(true);
      try {
        const res = await appApi.updateExtractStage(target ? { id, stage: target } : { id });
        toast(`Advanced to ${stageLabel(res.extract.stage)}`);
        reload();
        requestInspectorRefresh();
      } catch {
        toast("Could not change stage");
      } finally {
        setBusy(false);
      }
    },
    [id, busy, toast, reload],
  );

  // Trim the current editor body through `extracts.rewrite` (logs update_document).
  // Plain edits autosave through `useDocument.save`; this explicit action only
  // applies whitespace cleanup before persisting the cleaned body.
  const trimBody = useCallback(async () => {
    if (!id || busy) return;
    const change = latestChange.current;
    const editor = editorRef.current;
    const liveJson = editor?.getJSON();
    const prosemirrorJson = liveJson ?? change?.prosemirrorJson ?? doc.currentDoc ?? doc.initialDoc;
    const baseText = liveJson ? toPlainText(liveJson) : (change?.plainText ?? doc.plainText);
    const plainText = baseText
      .split(/\n/)
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    setBusy(true);
    try {
      const blocks = editor ? toBlockInputs(editor.getJSON()) : undefined;
      await appApi.rewriteExtract({
        id,
        prosemirrorJson: prosemirrorJson ?? { type: "doc", content: [] },
        plainText,
        ...(blocks ? { blocks } : {}),
      });
      toast("Trimmed whitespace & filler");
      reload();
    } catch {
      toast("Could not trim");
    } finally {
      setBusy(false);
    }
  }, [id, busy, doc, toast, reload]);

  const onPostpone = useCallback(async () => {
    if (!id || busy) return;
    setBusy(true);
    try {
      const res = await appApi.postponeExtract({ id });
      toast(`Postponed · next ${fmtDate(res.extract.dueAt)}`);
      reload();
      requestInspectorRefresh();
    } catch {
      toast("Could not postpone");
    } finally {
      setBusy(false);
    }
  }, [id, busy, toast, reload]);

  const onMarkDone = useCallback(async () => {
    if (!id || busy) return;
    setBusy(true);
    try {
      await appApi.markExtractDone({ id });
      toast("Marked done");
      reload();
      requestInspectorRefresh();
    } catch {
      toast("Could not mark done");
    } finally {
      setBusy(false);
    }
  }, [id, busy, toast, reload]);

  const onDelete = useCallback(async () => {
    if (!id || busy) return;
    setBusy(true);
    try {
      await appApi.deleteExtract({ id });
      requestInspectorRefresh();
      toast("Extract deleted");
      // Soft-deleted — leave the view; route back to the owning source when known.
      const sourceId = currentInspector?.source?.id ?? currentInspector?.element.id ?? null;
      if (sourceId && sourceId !== id) {
        void navigate({ to: "/source/$id", params: { id: sourceId } });
      }
    } catch {
      toast("Could not delete");
    } finally {
      setBusy(false);
    }
  }, [id, busy, currentInspector, navigate, toast]);

  // Convert to a card (T033) — open the card builder as the third column, defaulting
  // to the Q&A tab. The builder authors a card from THIS extract via `cards.create`;
  // lineage/priority/tag inheritance happens main-side in `CardService`.
  const onConvert = useCallback(() => {
    setBuilder({ tab: "qa" });
  }, []);

  // Close the builder column (returns to the two-column distill surface).
  const onCloseBuilder = useCallback(() => setBuilder(null), []);

  const closeActiveCard = useCallback(() => {
    setActiveCardId(null);
    if (id) select(id);
  }, [id, select]);

  const onEmbeddedCardRemoved = useCallback(
    async (removedCardId: string) => {
      if (activeCardIdRef.current !== removedCardId) return;
      setActiveCardId(null);
      if (id) select(id);
      reload();
      requestInspectorRefresh();
    },
    [id, reload, select],
  );

  // After a card is authored, re-fetch the inspector + lineage so the new card
  // appears under the extract in the tree, and refresh the shared inspector panel.
  const onCardCreated = useCallback(() => {
    reload();
    requestInspectorRefresh();
  }, [reload]);

  // The original source root this extract descends from (its lineage root). The
  // inspector resolves `source` from `elements.source_id`, which points at the
  // original source for a top-level extract AND for an already-nested extract — so
  // a sub-extract's `source_id` stays the root no matter how deep the chain.
  const sourceRootId = currentInspector?.source?.id ?? null;

  // Text-selection toolbar inside the extract body (T025 reuses the T019 seam).
  // The hook owns the anchor + resolved location; this view owns only the action
  // wiring. Using or dismissing the toolbar never mutates the extract body.
  const selection = useTextSelection(editor, editorReady);
  const highlights = useHighlights(id);

  // T025 — Sub-extract: lift the current selection in THIS extract's body into a
  // NEW child extract via the SAME `extractions.create` command as T021. Only the
  // ids differ: `parentId` = this extract, `sourceElementId` = the original source
  // root, so the sub-extract's `source_id` stays the root while its location anchors
  // into this extract. On success the parent paints `.extracted` over the selected
  // blocks and the lineage tree re-fetches so the sub-extract appears in place. The
  // view never touches SQL — it only ships the resolved location across IPC.
  const onSubExtract = useCallback(async () => {
    const loc = selection.location;
    if (!id || !loc || !sourceRootId || busy) {
      selection.dismiss();
      return;
    }
    setBusy(true);
    try {
      await appApi.createExtraction({
        sourceElementId: sourceRootId,
        parentId: id,
        selectedText: loc.selectedText,
        blockIds: loc.blockIds,
        startOffset: loc.startOffset,
        endOffset: loc.endOffset,
      });
      doc.markExtracted(loc.blockIds);
      reload();
      requestInspectorRefresh();
      toast("Sub-extract created");
    } catch {
      toast("Could not create sub-extract");
    } finally {
      setBusy(false);
      selection.dismiss();
    }
  }, [id, selection, sourceRootId, busy, doc, reload, toast]);

  const onHighlightSelection = useCallback(async () => {
    const loc = selection.location;
    if (!id || !loc || busy) {
      selection.dismiss();
      return;
    }
    setBusy(true);
    try {
      await highlights.add(loc);
      toast("Highlighted");
    } catch {
      toast("Could not highlight");
    } finally {
      setBusy(false);
      selection.dismiss();
    }
  }, [id, selection, busy, highlights, toast]);

  // The selection toolbar maps Extract/Cloze/Highlight/Copy/Cancel actions inside
  // the extract body. Extract == Sub-extract here (the selection is lifted into a
  // child of THIS extract). Cloze opens the card builder; Highlight persists a
  // lightweight document mark on THIS extract; Copy/Cancel are renderer-only.
  const onSelectionAction = useCallback(
    (action: SelectionToolbarAction) => {
      const loc = selection.location;
      switch (action) {
        case "extract":
          void onSubExtract();
          break;
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
        case "cloze": {
          // Open the builder on the Cloze tab with the selection pre-wrapped as a
          // numbered cloze deletion (T033 wires the entry point; T034 completes the
          // structured cloze parsing + marks).
          const sel = loc?.selectedText?.trim();
          setBuilder(sel ? { tab: "cloze", clozeText: `{{c1::${sel}}}` } : { tab: "cloze" });
          selection.dismiss();
          break;
        }
        case "highlight":
          void onHighlightSelection();
          break;
        case "cancel":
          selection.dismiss();
          break;
      }
    },
    [selection, onSubExtract, onHighlightSelection, toast],
  );

  // The action-bar Split button acts on the live selection. When there is a
  // selection it creates a sub-extract; otherwise it prompts the user to select text
  // first (the toolbar is the primary entry point, this button is the fallback).
  const onSplit = useCallback(() => {
    if (selection.location) {
      void onSubExtract();
    } else {
      toast("Select text in the extract to sub-extract it");
    }
  }, [selection.location, onSubExtract, toast]);

  // Keyboard while the toolbar is open: E → sub-extract, C → cloze (T048 — the
  // SAME `onSelectionAction` the toolbar buttons call, opening the cloze builder
  // pre-wrapped from the selection). Mirrors the reader's T019 capture-phase
  // handler so a bare letter is not typed into the contentEditable.
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
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [desktop, selection.position, onSelectionAction]);

  // Paint the `.extracted` display marker over blocks of this extract that already
  // have a child sub-extract anchored to them (T025), mirroring the source reader.
  // `doc.markExtracted` merges the just-created sub-extract's blocks optimistically
  // so the marker appears without a reload.
  useEffect(() => {
    const instance = editorRef.current;
    if (!instance || !editorReady) return;
    setReaderDecorations(instance, {
      firstUnreadBlockId: null,
      readPointBlockId: null,
      extractedBlockIds: doc.extractedBlockIds,
      highlights: highlights.highlights,
      // Processed-span dimming (T026) is a SOURCE-reader affordance; the extract
      // body doesn't surface it here.
      processed: [],
      flashedBlockId: null,
    });
  }, [editorReady, doc.extractedBlockIds, highlights.highlights]);

  if (!desktop) {
    return (
      <div className="reader-state" data-testid="route-extract">
        <span className="reader-state__icon">
          <Icon name="extract" size={26} />
        </span>
        <h1 className="font-semibold text-text text-xl tracking-tight">Extract review</h1>
        <p className="max-w-sm">
          Extracts are processed through the desktop bridge — open the Electron app to review an
          extract.
        </p>
      </div>
    );
  }

  const location = currentInspector?.location ?? null;
  const lineageNodes = currentLineage?.nodes ?? [];
  const visibleLineageNodes = activeCardId
    ? lineageNodes.map((node) => ({ ...node, active: node.id === activeCardId }))
    : lineageNodes;

  // An image extract (T071): a `media_fragment` (T065 crops a PDF region into the
  // vault as an `image` asset) ANCHORED AT A PAGE REGION — the `region` source-location
  // is the tell that this is an occludable image, not just any media. It can be
  // occluded — the card builder swaps its text tabs for the occlusion editor when this
  // is true. Gating on "has a region image" rather than the bare `media_fragment` type
  // is forward-compatible: a future audio/video `media_fragment` (T073–T075) has no
  // region anchor, so the occlusion editor won't mount for it (matching MAIN's
  // `OcclusionService` guard, which requires an `image` asset). Unlike the rendered
  // image URL, this signal doesn't depend on the async bytes fetch succeeding.
  const isImageExtract = element?.type === "media_fragment" && location?.region != null;

  // A clip extract (T074): a `media_fragment` whose source location carries a `clip`
  // window onto a media source — the tell that this is an audio-card candidate (T075).
  // The audio card loops the SAME window on the ORIGINAL media (no re-encoding); the
  // builder opens in audio mode pre-seeded with this clip. A region (image) extract has
  // no clip, so the two never overlap.
  const audioClip =
    element?.type === "media_fragment" && location?.clip && location.sourceElementId
      ? {
          sourceElementId: location.sourceElementId,
          startMs: location.clip.startMs,
          endMs: location.clip.endMs,
        }
      : undefined;
  const isClipExtract = audioClip != null;

  return (
    <div className="reader-screen extract-view" data-testid="route-extract">
      <header className="reader-header" data-testid="extract-header">
        <nav className="reader-crumbs" aria-label="Breadcrumb">
          {currentInspector?.source ? (
            <button
              type="button"
              className="reader-crumb"
              onClick={() => {
                const sid = currentInspector.source?.id;
                if (sid) void navigate({ to: "/source/$id", params: { id: sid } });
              }}
            >
              <Icon name="source" size={14} /> {currentInspector.source.title}
            </button>
          ) : (
            <span className="reader-crumb">
              <Icon name="library" size={14} /> Library
            </span>
          )}
          <span className="reader-crumb-sep">
            <Icon name="chevronRight" size={13} />
          </span>
          <span className="reader-crumb reader-crumb--current">
            <Icon name="extract" size={14} /> {element?.title ?? "Extract"}
          </span>
        </nav>

        <h1 className="reader-title" data-testid="extract-title">
          {element?.title ?? "Extract"}
        </h1>

        <div className="reader-metarow">
          {element ? (
            <>
              <Prio priority={element.priority} />
              <Status status={element.status} />
              <Stage stage={element.stage} />
              {currentInspector ? <SchedulerChip scheduler={currentInspector.scheduler} /> : null}
              <span className="reader-meta reader-meta--mono">
                {element.dueAt ? `next ${fmtDate(element.dueAt)}` : "unscheduled"}
              </span>
            </>
          ) : null}
        </div>
      </header>

      <div className={`extract-body${builder ? " extract-body--builder" : ""}`}>
        {/* LEFT — source context + lineage */}
        <aside className="extract-context" data-testid="extract-context">
          {/* A PDF region figure (T065): the cropped image + a jump-to-page-region
              affordance. Shown for a `media_fragment` extract with a region anchor. */}
          {element?.type === "media_fragment" && location?.region ? (
            <div className="extract-region" data-testid="extract-region-figure">
              <div className="insp-sec__title">Figure</div>
              {regionImageUrl ? (
                <img
                  className="extract-region__img"
                  data-testid="extract-region-img"
                  src={regionImageUrl}
                  alt={element?.title ?? "Extracted figure"}
                />
              ) : (
                <p className="dimmed">Figure image loads through the desktop bridge.</p>
              )}
              <button
                type="button"
                className="extract-jump"
                data-testid="extract-region-jump"
                onClick={() => {
                  if (!location) return;
                  void navigate({
                    to: "/source/$id",
                    params: { id: location.sourceElementId },
                    search: {
                      page: location.page ?? 1,
                      ...(location.region ? { region: location.region } : {}),
                      n: Date.now(),
                    } as Record<string, unknown>,
                  });
                }}
              >
                <Icon name="source" size={12} /> {location.label ?? "Jump to page region"}
              </button>
            </div>
          ) : null}
          {/* A media clip (T074): a looping mini player + a jump-to-source affordance
              that seeks the media reader to the clip start. Shown for a `media_fragment`
              extract with a clip window. */}
          {element?.type === "media_fragment" && location?.clip ? (
            <div className="extract-clip" data-testid="extract-clip">
              <div className="insp-sec__title">Clip</div>
              {location.sourceElementId ? (
                <ClipMiniPlayer
                  sourceElementId={location.sourceElementId}
                  startMs={location.clip.startMs}
                  endMs={location.clip.endMs}
                />
              ) : null}
              <button
                type="button"
                className="extract-jump"
                data-testid="extract-clip-jump"
                onClick={() => {
                  if (!location?.clip) return;
                  void navigate({
                    to: "/source/$id",
                    params: { id: location.sourceElementId },
                    search: { t: location.clip.startMs, n: Date.now() } as Record<string, unknown>,
                  });
                }}
              >
                <Icon name="source" size={12} /> {location.label ?? "Jump to clip"}
              </button>
            </div>
          ) : null}
          <div className="insp-sec__title">Source context</div>
          {/* Source reference (T043) — the always-visible refblock: source
              title/URL/author/date + location + verbatim snippet, resolved from
              this extract's lineage. The jump-to-source button (T022) opens the
              originating paragraph; a source-less extract degrades to a calm
              placeholder. Reuses the shared RefBlock + formatSourceRef. */}
          {currentInspector?.sourceRef ? (
            <RefBlock
              ref={currentInspector.sourceRef}
              dedupeSnippetAgainst={doc.plainText}
              testId="extract-refblock"
              {...(location ? { onOpenSource: () => navigateToLocation(location) } : {})}
            />
          ) : location ? (
            <blockquote className="extract-passage reader" data-testid="extract-passage">
              {location.selectedText}
              <button
                type="button"
                className="extract-jump"
                data-testid="extract-jump-source"
                onClick={() => navigateToLocation(location)}
              >
                <Icon name="source" size={12} /> {location.label ?? "Jump to source"}
              </button>
            </blockquote>
          ) : (
            <p className="dimmed">No source location recorded.</p>
          )}

          <div className="insp-sec__title" style={{ marginTop: 18 }}>
            Lineage
          </div>
          {lineageNodes.length > 0 ? (
            <LineageTree
              nodes={visibleLineageNodes}
              onPick={(n) => {
                if (n.type === "source" || n.type === "topic") {
                  select(n.id);
                  setActiveCardId(null);
                  void navigate({ to: "/source/$id", params: { id: n.id } });
                } else if (n.type === "card") {
                  select(null);
                  setBuilder(null);
                  setActiveCardId(n.id);
                } else if (n.type === "extract" && n.id !== id) {
                  select(n.id);
                  setActiveCardId(null);
                  void navigate({ to: "/extract/$id", params: { id: n.id } });
                } else if (n.type === "extract") {
                  select(n.id);
                  setActiveCardId(null);
                }
              }}
            />
          ) : (
            <p className="dimmed">Lineage loads through the desktop bridge.</p>
          )}
        </aside>

        {/* CENTER — distill */}
        {activeCardId ? (
          <section className="extract-card-detail" data-testid="extract-card-detail">
            <CardDetailPanel
              cardId={activeCardId}
              initiallyRevealed={true}
              backLabel="Back to extract"
              backTestId="extract-card-back"
              emptyBackTestId="extract-card-back"
              onBack={closeActiveCard}
              onCardRemoved={onEmbeddedCardRemoved}
            />
          </section>
        ) : (
          <section className="extract-distill" data-testid="extract-distill">
            <div className="extract-distill__head">
              <span className="extract-distill__title">
                Distill extract <HelpLink slug="distilling-extracts" />
              </span>
              {stageIdx < EXTRACT_STAGES.length - 1 ? (
                <button
                  type="button"
                  className="reader-btn reader-btn--primary"
                  data-testid="extract-advance-stage"
                  disabled={busy}
                  onClick={() => void setStage()}
                >
                  <Icon name="sparkle" size={14} /> Advance stage
                </button>
              ) : null}
            </div>

            {/* stage stepper — click any step to set that stage */}
            <div className="stage-stepper" data-testid="extract-stage-stepper" data-coach="stages">
              {EXTRACT_STAGES.map((s, i) => (
                <div className="stage-step" key={s}>
                  <button
                    type="button"
                    className="stage-step__btn"
                    data-testid={`extract-stage-step-${s}`}
                    data-active={i === stageIdx ? "true" : "false"}
                    data-done={i <= stageIdx ? "true" : "false"}
                    disabled={busy}
                    onClick={() => void setStage(s)}
                  >
                    <span className="stage-step__num" data-on={i <= stageIdx ? "true" : "false"}>
                      {i + 1}
                    </span>
                    <span
                      className="stage-step__label"
                      data-current={i === stageIdx ? "true" : "false"}
                    >
                      {stageLabel(s)}
                    </span>
                  </button>
                  {i < EXTRACT_STAGES.length - 1 ? (
                    <span
                      className="stage-step__line"
                      data-done={i < stageIdx ? "true" : "false"}
                    />
                  ) : null}
                </div>
              ))}
            </div>

            {/* editable extract body */}
            <div className="extract-editor" data-testid="extract-editor">
              {doc.status === "loading" ? (
                <p className="dimmed" data-testid="extract-loading">
                  Loading extract…
                </p>
              ) : doc.status === "error" ? (
                <p className="text-danger text-sm" data-testid="extract-error">
                  {doc.error ?? "Failed to load this extract."}
                </p>
              ) : (
                <SourceEditor
                  key={`${id ?? "none"}:${doc.status}`}
                  initialDoc={doc.initialDoc}
                  editable
                  readerDecorations
                  onChange={onChange}
                  onEditorReady={onEditorReady}
                />
              )}
              <div className="extract-editor__meta">
                <span className="reader-meta reader-meta--mono">
                  {doc.plainText.trim() ? `${doc.plainText.trim().split(/\s+/).length} words` : "—"}
                </span>
                <span className="reader-meta">aim for a single, self-contained idea</span>
              </div>
            </div>

            {/* action bar */}
            <div className="reader-actions extract-actions">
              <button
                type="button"
                className="reader-btn"
                data-testid="extract-trim"
                disabled={busy}
                onClick={() => void trimBody()}
              >
                <Icon name="trim" size={14} /> Trim
              </button>
              <button
                type="button"
                className="reader-btn"
                data-testid="extract-split"
                disabled={busy}
                onClick={onSplit}
              >
                <Icon name="split" size={14} /> Split
              </button>
              <button
                type="button"
                className="reader-btn"
                data-testid="extract-convert"
                disabled={busy}
                onClick={onConvert}
              >
                <Icon
                  name={isImageExtract ? "layers" : isClipExtract ? "play" : "card"}
                  size={14}
                />{" "}
                {isImageExtract
                  ? "Occlude image"
                  : isClipExtract
                    ? "Create audio card"
                    : "Convert to card"}
              </button>
              <button
                type="button"
                className="reader-btn"
                data-testid="extract-postpone"
                disabled={busy}
                onClick={() => void onPostpone()}
              >
                <Icon name="postpone" size={14} /> Postpone
              </button>
              <button
                type="button"
                className="reader-btn"
                data-testid="extract-mark-done"
                disabled={busy}
                onClick={() => void onMarkDone()}
              >
                <Icon name="checkCircle" size={14} /> Mark done
              </button>
              <button
                type="button"
                className="reader-btn reader-btn--danger reader-btn--icon"
                aria-label="Delete extract"
                data-testid="extract-delete"
                disabled={busy}
                onClick={() => void onDelete()}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>

            {/* AI-assisted distillation (T093/T094) — DRAFTS ONLY. The extract's own
                source-location anchor is the grounding the actions run over. */}
            {id ? (
              <AiAssist
                owningElementId={id}
                grounding={
                  currentInspector?.location
                    ? {
                        sourceElementId: currentInspector.location.sourceElementId,
                        blockIds: currentInspector.location.blockIds,
                        startOffset: currentInspector.location.startOffset,
                        endOffset: currentInspector.location.endOffset,
                        selectedText: currentInspector.location.selectedText,
                      }
                    : null
                }
              />
            ) : null}
          </section>
        )}

        {/* RIGHT — card builder (T033/T034), mounted as the third split3 column. */}
        {builder ? (
          <CardBuilder
            key={`${id ?? "none"}:${builder.tab}`}
            extractId={id}
            extractPriority={element?.priority ?? 0.5}
            isImageExtract={isImageExtract}
            {...(audioClip ? { audioClip } : {})}
            // The card inherits a source location iff the extract has one — feeds the
            // T035 "missing source" quality check. The renderer ships only the boolean.
            hasSource={currentInspector?.location != null || currentInspector?.source != null}
            // T086: the source publish date feeds the time-sensitive `outdated-source`
            // quality check — the renderer ships only the string from the provenance.
            {...(currentInspector?.provenance?.publishedAt != null
              ? { sourceDate: currentInspector.provenance.publishedAt }
              : {})}
            seedBody={doc.plainText}
            initialTab={builder.tab}
            {...(builder.clozeText !== undefined ? { initialClozeText: builder.clozeText } : {})}
            onToast={toast}
            onCardCreated={onCardCreated}
            onClose={onCloseBuilder}
          />
        ) : null}
      </div>

      <SelectionToolbar
        position={selection.position}
        actions={EXTRACT_SELECTION_ACTIONS}
        onAction={onSelectionAction}
      />

      {flash ? (
        <div className="reader-flash" data-testid="extract-flash" role="status">
          <span className="extract-flash__pill">
            <Icon name="check" size={14} />
            {flash}
          </span>
        </div>
      ) : null}
    </div>
  );
}

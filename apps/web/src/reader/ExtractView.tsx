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
 *    atomic_statement`), the editable extract body, and the action bar — Trim,
 *    Rewrite (save), Split (T025), Sub-extract (T025), Convert (M6 placeholder),
 *    Postpone, Mark done, Delete.
 *
 * Every mutation flows through the typed `window.appApi` `extracts.*` surface
 * (`updateStage`/`rewrite`/`postpone`/`markDone`/`delete`) — the renderer never
 * touches SQLite/Node/fs. Stage transitions reschedule the extract on the
 * ATTENTION scheduler main-side and survive an app restart; this component only
 * orchestrates UI state + IPC. The RIGHT card-builder column is M6 (T033/T034) —
 * "Convert" routes to that placeholder.
 */

import {
  type Editor,
  SourceEditor,
  type SourceEditorChange,
  toBlockInputs,
} from "@interleave/editor";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { requestInspectorRefresh } from "../components/inspector/Inspector";
import { LineageTree } from "../components/inspector/LineageTree";
import { Prio, SchedulerChip, Stage, Status, stageLabel } from "../components/inspector/primitives";
import {
  appApi,
  type ExtractStage,
  type InspectorData,
  isDesktop,
  type LineageData,
} from "../lib/appApi";
import { useDocument } from "../pages/source/useDocument";
import { useNavigateToLocation } from "./navigateToLocation";
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

  const doc = useDocument(id);
  const [inspector, setInspector] = useState<InspectorData | null>(null);
  const [lineage, setLineage] = useState<LineageData | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  // The latest edited body, mirrored so Trim/Rewrite can save the current text.
  const latestChange = useRef<SourceEditorChange | null>(null);

  const toast = useCallback((message: string) => {
    setFlash(message);
    setTimeout(() => setFlash(null), 1600);
  }, []);

  // Load the inspector payload (header chips + provenance + source location) and
  // the full lineage tree through the bridge. `reload` re-fetches both after a
  // mutation so the chips/stepper/tree reflect the new stage/due date/status.
  const reload = useCallback(() => {
    if (!desktop || !id) return;
    void appApi
      .getInspectorData({ id })
      .then((res) => setInspector(res.data))
      .catch(() => {
        /* header degrades to the document title */
      });
    void appApi
      .getLineage({ id })
      .then((res) => setLineage(res.lineage))
      .catch(() => {
        /* the tree degrades to empty */
      });
  }, [desktop, id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const onEditorReady = useCallback((instance: Editor | null) => {
    editorRef.current = instance;
  }, []);

  // Track the latest edited body (the editor debounces and also auto-saves via
  // `useDocument.save`, but Trim/Rewrite need the current text on demand).
  const onChange = useCallback(
    (change: SourceEditorChange) => {
      latestChange.current = change;
      doc.save(change);
    },
    [doc],
  );

  const element = inspector?.element ?? null;
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

  // Save the current editor body through `extracts.rewrite` (logs update_document).
  // `normalize` runs the whitespace/filler trim main-side mirror first — the Trim
  // button collapses runs of whitespace in the plain text and resaves.
  const saveBody = useCallback(
    async (kind: "trim" | "rewrite") => {
      if (!id || busy) return;
      const change = latestChange.current;
      const editor = editorRef.current;
      const prosemirrorJson = change?.prosemirrorJson ?? doc.currentDoc ?? doc.initialDoc;
      let plainText = change?.plainText ?? doc.plainText;
      if (kind === "trim") {
        plainText = plainText
          .split(/\n/)
          .map((line) => line.replace(/[ \t]+/g, " ").trim())
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }
      setBusy(true);
      try {
        const blocks = editor ? toBlockInputs(editor.getJSON()) : undefined;
        await appApi.rewriteExtract({
          id,
          prosemirrorJson: prosemirrorJson ?? { type: "doc", content: [] },
          plainText,
          ...(blocks ? { blocks } : {}),
        });
        toast(kind === "trim" ? "Trimmed whitespace & filler" : "Extract saved");
        reload();
      } catch {
        toast(kind === "trim" ? "Could not trim" : "Could not save");
      } finally {
        setBusy(false);
      }
    },
    [id, busy, doc, toast, reload],
  );

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
      const sourceId = inspector?.source?.id ?? inspector?.element.id ?? null;
      if (sourceId && sourceId !== id) {
        void navigate({ to: "/source/$id", params: { id: sourceId } });
      }
    } catch {
      toast("Could not delete");
    } finally {
      setBusy(false);
    }
  }, [id, busy, inspector, navigate, toast]);

  // Convert to a card is M6 (T033/T034). Wire the button to the review placeholder
  // rather than inventing a builder now.
  const onConvert = useCallback(() => {
    toast("Card builder lands in M6");
    void navigate({ to: "/review" });
  }, [navigate, toast]);

  // Split + Sub-extract are T025 — surface the buttons, route to a toast until then.
  const onSplit = useCallback(() => toast("Split lands in T025"), [toast]);

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

  const location = inspector?.location ?? null;
  const lineageNodes = lineage?.nodes ?? [];

  return (
    <div className="reader-screen extract-view" data-testid="route-extract">
      <header className="reader-header" data-testid="extract-header">
        <nav className="reader-crumbs" aria-label="Breadcrumb">
          {inspector?.source ? (
            <button
              type="button"
              className="reader-crumb"
              onClick={() => {
                const sid = inspector.source?.id;
                if (sid) void navigate({ to: "/source/$id", params: { id: sid } });
              }}
            >
              <Icon name="source" size={14} /> {inspector.source.title}
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
              {inspector ? <SchedulerChip scheduler={inspector.scheduler} /> : null}
              <span className="reader-meta reader-meta--mono">
                {element.dueAt ? `next ${fmtDate(element.dueAt)}` : "unscheduled"}
              </span>
            </>
          ) : null}
        </div>
      </header>

      <div className="extract-body">
        {/* LEFT — source context + lineage */}
        <aside className="extract-context" data-testid="extract-context">
          <div className="insp-sec__title">Source context</div>
          {location ? (
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
              nodes={lineageNodes}
              onPick={(n) => {
                if (n.id === id) return;
                if (n.type === "source") {
                  void navigate({ to: "/source/$id", params: { id: n.id } });
                } else if (n.type === "extract") {
                  void navigate({ to: "/extract/$id", params: { id: n.id } });
                }
              }}
            />
          ) : (
            <p className="dimmed">Lineage loads through the desktop bridge.</p>
          )}
        </aside>

        {/* CENTER — distill */}
        <section className="extract-distill" data-testid="extract-distill">
          <div className="extract-distill__head">
            <span className="extract-distill__title">Distill extract</span>
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
          <div className="stage-stepper" data-testid="extract-stage-stepper">
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
                  <span className="stage-step__line" data-done={i < stageIdx ? "true" : "false"} />
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
                onChange={onChange}
                onEditorReady={onEditorReady}
              />
            )}
            <div className="extract-editor__meta">
              <span className="reader-meta reader-meta--mono">
                {doc.plainText.trim() ? `${doc.plainText.trim().split(/\s+/).length} words` : "—"}
                {doc.saving ? " · saving…" : ""}
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
              onClick={() => void saveBody("trim")}
            >
              <Icon name="trim" size={14} /> Trim
            </button>
            <button
              type="button"
              className="reader-btn"
              data-testid="extract-rewrite"
              disabled={busy}
              onClick={() => void saveBody("rewrite")}
            >
              <Icon name="bookmark" size={14} /> Save
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
              data-testid="extract-subextract"
              disabled={busy}
              onClick={onSplit}
            >
              <Icon name="plus" size={14} /> Sub-extract
            </button>
            <button
              type="button"
              className="reader-btn"
              data-testid="extract-convert"
              disabled={busy}
              onClick={onConvert}
            >
              <Icon name="card" size={14} /> Convert to card
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
        </section>
      </div>

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

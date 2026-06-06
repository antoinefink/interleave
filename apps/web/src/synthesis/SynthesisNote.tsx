/**
 * Synthesis-note surface (T095) — the incremental-writing workspace at
 * `/synthesis/$id`.
 *
 * A synthesis note is the EXISTING core `synthesis_note` element type — a long-lived
 * writing/thinking surface where ideas from many sources are woven together over
 * repeated passes. It is the "incremental writing" counterpart to incremental reading:
 *
 *  - CENTER — the editable note body (the Tiptap {@link SourceEditor} from T015),
 *    saved through `synthesis.editBody` (`update_document`, stable block ids preserved).
 *  - RIGHT  — the LINKED-MATERIAL panel: the collected extracts/cards (`references`
 *    edges), each jump-to-able + unlinkable, plus an "Add to note" picker; and the
 *    SCHEDULE-RETURN control (tomorrow / next week / next month / manual — the SAME T028
 *    {@link ScheduleMenu}) that returns the note on the ATTENTION scheduler (never FSRS).
 *
 * The note is also marked as the shell SELECTION, so the shared inspector (type/stage/
 * priority/due) + the lineage surfaces light up for it like any other element.
 *
 * Every mutation flows through the typed `window.appApi.synthesis.*` surface — the
 * renderer never touches SQLite/Node/fs, never schedules FSRS, and never mints lineage
 * itself. The note appears in the library, the inspector, the due queue (when
 * scheduled), and the lineage like any other element.
 */

import {
  type Editor,
  emptyDoc,
  SourceEditor,
  type SourceEditorChange,
  toBlockInputs,
} from "@interleave/editor";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { requestInspectorRefresh } from "../components/inspector/Inspector";
import { Prio, Stage, Status } from "../components/inspector/primitives";
import { ScheduleMenu } from "../components/queue/ScheduleMenu";
import {
  appApi,
  type DocumentPayload,
  isDesktop,
  type QueueScheduleChoice,
  type SynthesisDataView,
} from "../lib/appApi";
import { useSelection } from "../shell/selection";
import { AddToNote } from "./AddToNote";
import "./synthesis.css";

/** Debounce window before a body change is persisted, in ms. */
const SAVE_DEBOUNCE_MS = 600;

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

export function SynthesisNote() {
  const { id } = useParams({ from: "/synthesis/$id" });
  const desktop = isDesktop();
  const navigate = useNavigate();
  const { select } = useSelection();

  const [data, setData] = useState<SynthesisDataView | null>(null);
  const [doc, setDoc] = useState<DocumentPayload | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "no-desktop">(
    desktop ? "loading" : "no-desktop",
  );
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);

  const editorRef = useRef<Editor | null>(null);
  const latestChange = useRef<SourceEditorChange | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((message: string) => {
    setFlash(message);
    setTimeout(() => setFlash(null), 1600);
  }, []);

  // Mark this note as the shell selection so the inspector + global actions target it.
  useEffect(() => {
    if (desktop && id) select(id);
  }, [desktop, id, select]);

  // Load the note metadata (element + linked material + due) and its body.
  const reload = useCallback(() => {
    if (!desktop || !id) return;
    void appApi
      .getSynthesisNote({ noteId: id })
      .then((res) => {
        if (!res.data) {
          setStatus("error");
          return;
        }
        setData(res.data);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
    void appApi
      .getDocument({ elementId: id })
      .then((res) => setDoc(res.document))
      .catch(() => {
        /* the editor degrades to an empty doc */
      });
  }, [desktop, id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const onEditorReady = useCallback((instance: Editor | null) => {
    editorRef.current = instance;
  }, []);

  // Persist the body through `synthesis.editBody` (debounced), preserving stable
  // block ids so the note's own text can later be searched/extracted-from.
  const persistBody = useCallback(
    (change: SourceEditorChange) => {
      if (!desktop || !id) return;
      const editor = editorRef.current;
      const blocks = editor ? toBlockInputs(editor.getJSON()) : undefined;
      void appApi
        .editSynthesisBody({
          noteId: id,
          prosemirrorJson: change.prosemirrorJson ?? emptyDoc(),
          plainText: change.plainText,
          ...(blocks ? { blocks } : {}),
        })
        .catch(() => {
          /* non-fatal: the next edit re-attempts the save */
        });
    },
    [desktop, id],
  );

  const onChange = useCallback(
    (change: SourceEditorChange) => {
      latestChange.current = change;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => persistBody(change), SAVE_DEBOUNCE_MS);
    },
    [persistBody],
  );

  // Keep the latest `persistBody` in a ref so the unmount-flush effect (below) can
  // call it WITHOUT depending on it — re-running the effect on every `persistBody`
  // identity change would fire its cleanup mid-edit and lose the pending save.
  const persistBodyRef = useRef(persistBody);
  persistBodyRef.current = persistBody;

  // Flush any pending save on unmount so an in-flight (debounced) edit is never lost.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (latestChange.current) persistBodyRef.current(latestChange.current);
    };
  }, []);

  // Schedule the note to RETURN on the attention scheduler (never FSRS).
  const onSchedule = useCallback(
    async (choice: QueueScheduleChoice) => {
      if (!id || busy) return;
      setBusy(true);
      try {
        const res = await appApi.scheduleSynthesisReturn({
          noteId: id,
          when: choice,
        });
        setData(res.data);
        toast(`Returns ${fmtDate(res.data.dueAt)}`);
        requestInspectorRefresh();
      } catch {
        toast("Could not schedule");
      } finally {
        setBusy(false);
      }
    },
    [id, busy, toast],
  );

  // Unlink a collected extract/card (remove the `references` edge).
  const onUnlink = useCallback(
    async (targetId: string) => {
      if (!id || busy) return;
      setBusy(true);
      try {
        const res = await appApi.unlinkSynthesisElement({ noteId: id, targetId });
        setData(res.data);
        toast("Removed from note");
        requestInspectorRefresh();
      } catch {
        toast("Could not remove");
      } finally {
        setBusy(false);
      }
    },
    [id, busy, toast],
  );

  // Add an extract/card to the note (link it) — invoked by the picker.
  const onLink = useCallback(
    async (targetId: string) => {
      if (!id) return;
      try {
        const res = await appApi.linkSynthesisElement({ noteId: id, targetId });
        setData(res.data);
        toast("Added to note");
        requestInspectorRefresh();
      } catch {
        toast("Could not add");
      }
    },
    [id, toast],
  );

  // Jump to a linked extract/card's surface (extract view / card detail).
  const openLinked = useCallback(
    (target: { id: string; type: string }) => {
      if (target.type === "extract") {
        void navigate({ to: "/extract/$id", params: { id: target.id } });
      } else if (target.type === "card") {
        select(null);
        void navigate({ to: "/card/$id", params: { id: target.id } });
      }
    },
    [navigate, select],
  );

  if (!desktop) {
    return (
      <div className="reader-state" data-testid="route-synthesis">
        <span className="reader-state__icon">
          <Icon name="synthesis" size={26} />
        </span>
        <h1 className="font-semibold text-text text-xl tracking-tight">Synthesis note</h1>
        <p className="max-w-sm">
          Synthesis notes are edited through the desktop bridge — open the Electron app to write
          one.
        </p>
      </div>
    );
  }

  const element = data?.element ?? null;
  const linked = data?.linked ?? [];
  const initialDoc = doc?.prosemirrorJson ?? emptyDoc();

  return (
    <div className="synthesis-screen" data-testid="route-synthesis">
      <header className="reader-header" data-testid="synthesis-header">
        <nav className="reader-crumbs" aria-label="Breadcrumb">
          <button
            type="button"
            className="reader-crumb"
            onClick={() => void navigate({ to: "/library" })}
          >
            <Icon name="library" size={14} /> Library
          </button>
          <span className="reader-crumb-sep">
            <Icon name="chevronRight" size={13} />
          </span>
          <span className="reader-crumb reader-crumb--current">
            <Icon name="synthesis" size={14} /> {element?.title ?? "Synthesis note"}
          </span>
        </nav>

        <h1 className="reader-title" data-testid="synthesis-title">
          {element?.title ?? "Synthesis note"}
        </h1>

        <div className="reader-metarow">
          {element ? (
            <>
              <Prio priority={element.priority} />
              <Status status={element.status} />
              <Stage stage={element.stage} />
              <span className="reader-meta reader-meta--mono" data-testid="synthesis-due">
                {element.dueAt ? `returns ${fmtDate(element.dueAt)}` : "not scheduled to return"}
              </span>
            </>
          ) : null}
        </div>
      </header>

      <div className="synthesis-body">
        {/* CENTER — the writing surface */}
        <section className="synthesis-editor-col" data-testid="synthesis-editor-col">
          <div className="synthesis-editor-col__head">
            <span className="synthesis-editor-col__title">Write &amp; refine</span>
            <span className="reader-meta">incremental writing</span>
          </div>
          <div className="synthesis-editor" data-testid="synthesis-editor">
            {status === "loading" ? (
              <p className="dimmed" data-testid="synthesis-loading">
                Loading note…
              </p>
            ) : status === "error" ? (
              <p className="text-danger text-sm" data-testid="synthesis-error">
                This synthesis note could not be loaded.
              </p>
            ) : (
              <SourceEditor
                key={`${id ?? "none"}:${status}`}
                initialDoc={initialDoc}
                editable
                onChange={onChange}
                onEditorReady={onEditorReady}
              />
            )}
          </div>
        </section>

        {/* RIGHT — linked material + schedule + lineage */}
        <aside className="synthesis-panel" data-testid="synthesis-panel">
          <div className="synthesis-sec">
            <div className="synthesis-sec__head">
              <span className="insp-sec__title">Linked material</span>
              <button
                type="button"
                className="synthesis-add"
                data-testid="synthesis-add"
                disabled={busy}
                onClick={() => setPicker(true)}
              >
                <Icon name="plus" size={13} /> Add to note
              </button>
            </div>
            {linked.length === 0 ? (
              <p className="dimmed" data-testid="synthesis-linked-empty">
                No extracts or cards collected yet. Add the material you want to weave together.
              </p>
            ) : (
              <ul className="synthesis-linked" data-testid="synthesis-linked">
                {linked.map((l) => (
                  <li
                    key={l.relationId}
                    className="synthesis-linked__row"
                    data-testid="synthesis-linked-row"
                    data-element-type={l.type}
                  >
                    <button
                      type="button"
                      className="synthesis-linked__open"
                      data-testid="synthesis-linked-open"
                      onClick={() => openLinked(l)}
                      title={`Open ${l.type}`}
                    >
                      <Icon name={l.type === "card" ? "card" : "extract"} size={13} />
                      <span className="synthesis-linked__title">{l.title}</span>
                    </button>
                    <button
                      type="button"
                      className="synthesis-linked__remove"
                      aria-label="Remove from note"
                      data-testid="synthesis-linked-remove"
                      disabled={busy}
                      onClick={() => void onUnlink(l.id)}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="synthesis-sec">
            <div className="synthesis-sec__head">
              <span className="insp-sec__title">Schedule return</span>
              <ScheduleMenu disabled={busy} onSchedule={(c) => void onSchedule(c)} />
            </div>
            <p className="dimmed synthesis-hint">
              A synthesis note returns on the <strong>attention scheduler</strong> for incremental
              refinement — it is processed, not recalled (never FSRS review).
            </p>
            <div className="synthesis-sched-presets">
              <button
                type="button"
                className="reader-btn"
                data-testid="synthesis-return-tomorrow"
                disabled={busy}
                onClick={() => void onSchedule({ kind: "tomorrow" })}
              >
                <Icon name="calendar" size={13} /> Tomorrow
              </button>
              <button
                type="button"
                className="reader-btn"
                data-testid="synthesis-return-nextweek"
                disabled={busy}
                onClick={() => void onSchedule({ kind: "nextWeek" })}
              >
                <Icon name="calendar" size={13} /> Next week
              </button>
              <button
                type="button"
                className="reader-btn"
                data-testid="synthesis-return-nextmonth"
                disabled={busy}
                onClick={() => void onSchedule({ kind: "nextMonth" })}
              >
                <Icon name="calendar" size={13} /> Next month
              </button>
            </div>
          </div>
        </aside>
      </div>

      {picker ? (
        <AddToNote
          noteId={id}
          excludeIds={linked.map((l) => l.id)}
          onPick={(targetId) => void onLink(targetId)}
          onClose={() => setPicker(false)}
        />
      ) : null}

      {flash ? (
        <div className="reader-flash" data-testid="synthesis-flash" role="status">
          <span className="extract-flash__pill">
            <Icon name="check" size={14} />
            {flash}
          </span>
        </div>
      ) : null}
    </div>
  );
}

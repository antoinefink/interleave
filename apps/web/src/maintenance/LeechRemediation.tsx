/**
 * Leech remediation screen (T085) — the full repair workflow for repeatedly-failing
 * cards, promoting the minimal T040 cleanup view.
 *
 * A card is automatically flagged a leech once its FSRS `lapses` cross the threshold
 * (4 — `@interleave/scheduler` `LEECH_LAPSE_THRESHOLD`); it surfaces here with its
 * lapse count + source + originating-extract lineage, and the user can repair it:
 *  - **Rewrite** — an inline prompt/answer (Q&A) or cloze editor (`appApi.updateCard`),
 *    which also UN-leeches the card so a fixed card leaves the list.
 *  - **Split** — a small multi-part editor authoring 2 atomic sibling cards from the
 *    original (`appApi.splitCard`); the original is soft-deleted (recoverable).
 *  - **Add context** — a note field appending a clarifying context note
 *    (`appApi.addCardContext`); the card stays in rotation and the saved note is
 *    surfaced as a separate context line (`LeechSummary.context`, op-log-derived) so
 *    the prompt becomes answerable, not just logged.
 *  - **Open source** — jump to the originating paragraph (T022 `navigateToLocation`),
 *    fetched from the card's `sourceLocationId` via the inspector location payload.
 *  - **Back to extract** — send the parent extract back into the attention queue to
 *    re-distill it (`appApi.backToExtractCard`); disabled when the card has no live
 *    parent extract.
 *  - **Lower priority** — an A/B/C/D control (`appApi.setPriority`) so a weak card
 *    stops costing protected review time (the overload sort sacrifices it first).
 *  - **Suspend** / **Delete** / **Not a leech** — the existing T038/T040 actions.
 *
 * Architecture (non-negotiable): this is UI only — no SQL, no FSRS math, no leech
 * threshold logic, no lineage/scheduling logic. The leech list comes from
 * `appApi.reviewLeeches()` (read-only); every action is a typed `appApi.*` call over
 * the preload bridge; the main process owns the transaction + the `operation_log` op.
 * The split/add-context/back-to-extract domain logic lives in `packages/local-db`
 * (`CardRemediationService`), never here. Open-source = T022 navigation;
 * lower-priority = T027 `elements.setPriority`. No action destroys `review_logs`.
 */

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Prio, priorityLabel } from "../components/inspector/primitives";
import "../components/inspector/inspector.css";
import {
  appApi,
  type CardsSplitPart,
  isDesktop,
  type LeechSummary,
  type PriorityLabel,
} from "../lib/appApi";
import { useNavigateToLocation } from "../reader/navigateToLocation";
import "../review/review.css";
import "./leech-cleanup.css";

const PRIORITY_BANDS: readonly PriorityLabel[] = ["A", "B", "C", "D"];

/** The inline rewrite editor for one leech card. */
function RewriteEditor({
  card,
  onSaved,
  onCancel,
}: {
  card: LeechSummary;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const isCloze = card.kind === "cloze";
  const [prompt, setPrompt] = useState(card.prompt ?? "");
  const [answer, setAnswer] = useState(card.answer ?? "");
  const [cloze, setCloze] = useState(card.cloze ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await appApi.updateCard({
        cardId: card.id,
        ...(isCloze ? { cloze } : { prompt, answer }),
      });
      // A rewrite resolves the leech — un-flag it so it leaves the cleanup list.
      await appApi.markLeechCard({ cardId: card.id, leech: false });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }, [saving, card.id, isCloze, cloze, prompt, answer, onSaved]);

  return (
    <div className="rv-edit lc-edit" data-testid={`leech-edit-${card.id}`}>
      {isCloze ? (
        <label className="rv-edit__field">
          <span className="rv-edit__label">Cloze text</span>
          <textarea
            className="rv-edit__textarea"
            data-testid="leech-edit-cloze"
            value={cloze}
            onChange={(e) => setCloze(e.target.value)}
            rows={3}
          />
        </label>
      ) : (
        <>
          <label className="rv-edit__field">
            <span className="rv-edit__label">Prompt</span>
            <textarea
              className="rv-edit__textarea"
              data-testid="leech-edit-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
            />
          </label>
          <label className="rv-edit__field">
            <span className="rv-edit__label">Answer</span>
            <textarea
              className="rv-edit__textarea"
              data-testid="leech-edit-answer"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={2}
            />
          </label>
        </>
      )}
      {error ? (
        <p className="rv-edit__error" data-testid="leech-edit-error">
          {error}
        </p>
      ) : null}
      <div className="rv-edit__actions">
        <button
          type="button"
          className="rv-btn"
          data-testid="leech-edit-cancel"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="rv-btn rv-btn--primary"
          data-testid="leech-edit-save"
          onClick={() => void save()}
          disabled={saving}
        >
          <Icon name="check" size={14} />
          Save rewrite
        </button>
      </div>
    </div>
  );
}

/**
 * The split editor — author TWO atomic cards from the original multi-fact card, then
 * call `appApi.splitCard`. Each part defaults to the original's kind; a Q&A part needs
 * a prompt + answer, a cloze part needs cloze text (the main side re-validates).
 */
function SplitEditor({
  card,
  onSplit,
  onCancel,
}: {
  card: LeechSummary;
  onSplit: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const kind = card.kind === "cloze" ? "cloze" : "qa";
  // Two atomic parts authored from the multi-fact original. The stable `key` (a fixed
  // slot id) keeps React from re-mounting the textareas as the user types — the part
  // list is a fixed pair, never reordered.
  const [parts, setParts] = useState<(CardsSplitPart & { key: string })[]>([
    { key: "part-0", kind },
    { key: "part-1", kind },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setPart = useCallback((index: number, patch: Partial<CardsSplitPart>) => {
    setParts((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }, []);

  const save = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      // Strip the UI-only `key` before sending the authored parts to main.
      const payloadParts: CardsSplitPart[] = parts.map(({ key: _key, ...part }) => part);
      await appApi.splitCard({ cardId: card.id, parts: payloadParts });
      await onSplit();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }, [saving, card.id, parts, onSplit]);

  return (
    <div className="rv-edit lc-edit" data-testid={`leech-split-${card.id}`}>
      <p className="rv-edit__hint" data-testid="leech-split-hint">
        Split this card into two atomic cards — one fact each. The original is moved to trash
        (recoverable).
      </p>
      {parts.map((part, index) => (
        <div className="lc-split-part" key={part.key} data-testid={`leech-split-part-${index}`}>
          <span className="rv-edit__label">Card {index + 1}</span>
          {kind === "cloze" ? (
            <label className="rv-edit__field">
              <span className="rv-edit__label">Cloze text</span>
              <textarea
                className="rv-edit__textarea"
                data-testid={`leech-split-cloze-${index}`}
                value={part.cloze ?? ""}
                onChange={(e) => setPart(index, { cloze: e.target.value })}
                rows={2}
              />
            </label>
          ) : (
            <>
              <label className="rv-edit__field">
                <span className="rv-edit__label">Prompt</span>
                <textarea
                  className="rv-edit__textarea"
                  data-testid={`leech-split-prompt-${index}`}
                  value={part.prompt ?? ""}
                  onChange={(e) => setPart(index, { prompt: e.target.value })}
                  rows={2}
                />
              </label>
              <label className="rv-edit__field">
                <span className="rv-edit__label">Answer</span>
                <textarea
                  className="rv-edit__textarea"
                  data-testid={`leech-split-answer-${index}`}
                  value={part.answer ?? ""}
                  onChange={(e) => setPart(index, { answer: e.target.value })}
                  rows={2}
                />
              </label>
            </>
          )}
        </div>
      ))}
      {error ? (
        <p className="rv-edit__error" data-testid="leech-split-error">
          {error}
        </p>
      ) : null}
      <div className="rv-edit__actions">
        <button
          type="button"
          className="rv-btn"
          data-testid="leech-split-cancel"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="rv-btn rv-btn--primary"
          data-testid="leech-split-save"
          onClick={() => void save()}
          disabled={saving}
        >
          <Icon name="check" size={14} />
          Split into 2 cards
        </button>
      </div>
    </div>
  );
}

/** The add-context note field for one leech card. */
function ContextEditor({
  card,
  onSaved,
  onCancel,
}: {
  card: LeechSummary;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    if (saving || note.trim().length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await appApi.addCardContext({ cardId: card.id, note });
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }, [saving, note, card.id, onSaved]);

  return (
    <div className="rv-edit lc-edit" data-testid={`leech-context-${card.id}`}>
      <label className="rv-edit__field">
        <span className="rv-edit__label">Context note</span>
        <textarea
          className="rv-edit__textarea"
          data-testid="leech-context-note"
          value={note}
          placeholder="A clarifying note so the prompt is answerable…"
          onChange={(e) => setNote(e.target.value)}
          rows={2}
        />
      </label>
      {error ? (
        <p className="rv-edit__error" data-testid="leech-context-error">
          {error}
        </p>
      ) : null}
      <div className="rv-edit__actions">
        <button
          type="button"
          className="rv-btn"
          data-testid="leech-context-cancel"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="rv-btn rv-btn--primary"
          data-testid="leech-context-save"
          onClick={() => void save()}
          disabled={saving || note.trim().length === 0}
        >
          <Icon name="check" size={14} />
          Add context
        </button>
      </div>
    </div>
  );
}

/** A compact A/B/C/D control to LOWER a leech's priority (reuses T027 setPriority). */
function PriorityRow({
  card,
  busy,
  onSet,
}: {
  card: LeechSummary;
  busy: boolean;
  onSet: (band: PriorityLabel) => void;
}) {
  const current = priorityLabel(card.priority);
  return (
    <fieldset
      className="prio-edit__seg lc-prio"
      aria-label="Set priority"
      data-testid="leech-priority"
    >
      {PRIORITY_BANDS.map((band) => (
        <button
          key={band}
          type="button"
          className="prio-edit__btn"
          data-testid={`leech-priority-${band}`}
          aria-pressed={current === band}
          disabled={busy}
          onClick={() => onSet(band)}
        >
          <span
            className="prio-edit__dot"
            style={{ background: `var(--prio-${band.toLowerCase()})` }}
          />
          {band}
        </button>
      ))}
    </fieldset>
  );
}

/** Which inline editor (if any) is open for a card. */
type EditorMode = "rewrite" | "split" | "context";

export function LeechRemediation() {
  const desktop = isDesktop();
  const navigateToLocation = useNavigateToLocation();
  const [cards, setCards] = useState<readonly LeechSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ id: string; mode: EditorMode } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setLoading(false);
      return;
    }
    try {
      const res = await appApi.reviewLeeches();
      setCards(res.cards);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (id: string, action: "suspend" | "delete" | "unleech" | "backToExtract") => {
      setBusyId(id);
      setError(null);
      try {
        if (action === "suspend") await appApi.suspendCard({ cardId: id });
        else if (action === "delete") await appApi.deleteCard({ cardId: id });
        else if (action === "backToExtract") await appApi.backToExtractCard({ cardId: id });
        else await appApi.markLeechCard({ cardId: id, leech: false });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const lowerPriority = useCallback(
    async (id: string, band: PriorityLabel) => {
      setBusyId(id);
      setError(null);
      try {
        await appApi.setElementPriority({ id, action: { kind: "set", priority: band } });
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  // Open source: the full jump payload (block ids/offsets) lives on the inspector
  // location; fetch it from the card id then navigate (reusing T022). The card must
  // carry a source location for this to do anything.
  const openSource = useCallback(
    async (card: LeechSummary) => {
      if (!card.sourceLocationId) return;
      try {
        const res = await appApi.getInspectorData({ id: card.id });
        if (res.data?.location) navigateToLocation(res.data.location);
      } catch {
        // Non-fatal: the source jump is a convenience.
      }
    },
    [navigateToLocation],
  );

  if (!desktop) {
    return (
      <div className="rv-shell" data-testid="route-leech-cleanup">
        <div className="rv-blank">
          <div className="rv-empty">
            <div className="rv-empty__icon">
              <Icon name="leech" size={26} />
            </div>
            <h1 className="rv-empty__title">Leech remediation</h1>
            <p className="rv-empty__body">
              Repeatedly-failing cards are listed here for repair — open the Electron app to clean
              them up.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rv-shell lc-shell" data-testid="route-leech-cleanup">
      <div className="lc-head">
        <div>
          <h1 className="lc-title">
            <Icon name="leech" size={18} />
            Leech remediation
          </h1>
          <p className="lc-sub">
            Cards that keep lapsing (≥ 4 failures). Split, add context, send back to the extract,
            lower priority, suspend, or delete them so they stop costing review time.
          </p>
        </div>
        <span className="lc-count" data-testid="leech-count">
          {cards.length} leech{cards.length === 1 ? "" : "es"}
        </span>
      </div>

      {error ? (
        <p className="pq-error" data-testid="leech-error" style={{ padding: "8px 24px" }}>
          {error}
        </p>
      ) : null}

      <div className="lc-list">
        {loading ? (
          <p className="lc-loading" data-testid="leech-loading">
            Loading…
          </p>
        ) : cards.length === 0 ? (
          <div className="rv-empty" data-testid="leech-empty">
            <div className="rv-empty__icon">
              <Icon name="checkCircle" size={26} />
            </div>
            <h2 className="rv-empty__title">No leeches</h2>
            <p className="rv-empty__body">
              No cards have crossed the leech threshold. Cards that keep failing will appear here
              for repair.
            </p>
          </div>
        ) : (
          cards.map((card) => {
            const extractAvailable = card.parentExtractId != null;
            const isEditing = editor?.id === card.id;
            return (
              <div
                className="lc-card"
                key={card.id}
                data-testid="leech-card"
                data-card-id={card.id}
              >
                <div className="lc-card__meta">
                  <span className="badge badge--soft">
                    {card.kind === "cloze" ? "Cloze" : "Q&A"}
                  </span>
                  <Prio priority={card.priority} />
                  <span className="badge badge--leech" data-testid="leech-card-lapses">
                    {card.lapses} lapses
                  </span>
                  {card.status === "suspended" ? (
                    <span className="badge badge--suspended">Suspended</span>
                  ) : null}
                </div>
                <div className="lc-card__body">
                  <div className="lc-card__prompt" data-testid="leech-card-prompt">
                    {card.kind === "cloze" ? card.cloze : card.prompt}
                  </div>
                  {card.kind === "qa" && card.answer ? (
                    <div className="lc-card__answer">{card.answer}</div>
                  ) : null}
                  {card.sourceTitle ? (
                    <div className="refblock lc-card__src" data-testid="leech-card-src">
                      {card.sourceTitle}
                      {card.sourceLocationLabel ? ` · ${card.sourceLocationLabel}` : ""}
                    </div>
                  ) : null}
                  {card.context ? (
                    <div className="lc-card__context" data-testid="leech-card-context">
                      <Icon name="info" size={12} />
                      <span>{card.context}</span>
                    </div>
                  ) : null}
                  {extractAvailable ? (
                    <div className="lc-card__lineage" data-testid="leech-card-lineage">
                      <Icon name="extract" size={12} /> From an extract
                    </div>
                  ) : null}
                </div>

                {isEditing && editor.mode === "rewrite" ? (
                  <RewriteEditor
                    card={card}
                    onSaved={async () => {
                      setEditor(null);
                      await load();
                    }}
                    onCancel={() => setEditor(null)}
                  />
                ) : isEditing && editor.mode === "split" ? (
                  <SplitEditor
                    card={card}
                    onSplit={async () => {
                      setEditor(null);
                      await load();
                    }}
                    onCancel={() => setEditor(null)}
                  />
                ) : isEditing && editor.mode === "context" ? (
                  <ContextEditor
                    card={card}
                    onSaved={async () => {
                      setEditor(null);
                      await load();
                    }}
                    onCancel={() => setEditor(null)}
                  />
                ) : (
                  <div className="lc-card__actions" data-testid="leech-card-actions">
                    <button
                      type="button"
                      className="rv-repair__btn"
                      data-testid="leech-rewrite"
                      disabled={busyId === card.id}
                      onClick={() => setEditor({ id: card.id, mode: "rewrite" })}
                    >
                      <Icon name="edit" size={14} />
                      Rewrite
                    </button>
                    <button
                      type="button"
                      className="rv-repair__btn"
                      data-testid="leech-split"
                      disabled={busyId === card.id}
                      onClick={() => setEditor({ id: card.id, mode: "split" })}
                    >
                      <Icon name="split" size={14} />
                      Split
                    </button>
                    <button
                      type="button"
                      className="rv-repair__btn"
                      data-testid="leech-add-context"
                      disabled={busyId === card.id}
                      onClick={() => setEditor({ id: card.id, mode: "context" })}
                    >
                      <Icon name="info" size={14} />
                      Add context
                    </button>
                    {card.sourceLocationId ? (
                      <button
                        type="button"
                        className="rv-repair__btn"
                        data-testid="leech-open-source"
                        disabled={busyId === card.id}
                        onClick={() => void openSource(card)}
                      >
                        <Icon name="external" size={14} />
                        Open source
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="rv-repair__btn"
                      data-testid="leech-back-to-extract"
                      disabled={busyId === card.id || !extractAvailable}
                      title={
                        extractAvailable
                          ? "Send the originating extract back into the attention queue"
                          : "No live parent extract"
                      }
                      onClick={() => void act(card.id, "backToExtract")}
                    >
                      <Icon name="arrowUp" size={14} />
                      Back to extract
                    </button>
                    <PriorityRow
                      card={card}
                      busy={busyId === card.id}
                      onSet={(band) => void lowerPriority(card.id, band)}
                    />
                    <button
                      type="button"
                      className="rv-repair__btn"
                      data-testid="leech-suspend"
                      disabled={busyId === card.id}
                      onClick={() => void act(card.id, "suspend")}
                    >
                      <Icon name="pause" size={14} />
                      Suspend
                    </button>
                    <button
                      type="button"
                      className="rv-repair__btn"
                      data-testid="leech-unleech"
                      disabled={busyId === card.id}
                      onClick={() => void act(card.id, "unleech")}
                    >
                      <Icon name="check" size={14} />
                      Not a leech
                    </button>
                    <button
                      type="button"
                      className="rv-repair__btn"
                      data-testid="leech-delete"
                      disabled={busyId === card.id}
                      onClick={() => void act(card.id, "delete")}
                    >
                      <Icon name="trash" size={14} />
                      Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Back-compat alias — the route + nav still reference `LeechCleanup` (T040 → T085). */
export const LeechCleanup = LeechRemediation;

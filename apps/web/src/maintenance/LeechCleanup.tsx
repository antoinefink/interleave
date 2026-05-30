/**
 * Leech cleanup view (T040) — the maintenance surface for repeatedly-failing cards.
 *
 * A card is automatically flagged a leech once its FSRS `lapses` cross the
 * threshold (4 — `@interleave/scheduler` `LEECH_LAPSE_THRESHOLD`); it surfaces here
 * so the user can triage it without grinding it forever. Each leech offers the
 * minimal MVP remediation set:
 *  - **Rewrite** — an inline prompt/answer (Q&A) or cloze editor saving via
 *    `appApi.updateCard` (`cards.update`); a rewrite also UN-leeches the card
 *    (`appApi.markLeechCard({ leech: false })`) so a fixed card leaves the list.
 *  - **Suspend** — `appApi.suspendCard` (status `suspended`); the card leaves review.
 *  - **Delete** — `appApi.deleteCard` (soft-delete, recoverable from trash).
 *  - **Un-leech** — `appApi.markLeechCard({ leech: false })` for a card the user
 *    judges fine as-is.
 * (The full split / add-context / lower-priority remediation screen is M17/T085.)
 *
 * Architecture (non-negotiable): this is UI only — no SQL, no FSRS math, no leech
 * threshold logic. The leech list comes from `appApi.reviewLeeches()` (read-only),
 * and every action is a typed `appApi.*` call over the preload bridge; the main
 * process owns the transaction + the `operation_log` op. Flagging/un-flagging never
 * destroys the card or its `review_logs`.
 */

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Prio } from "../components/inspector/primitives";
import "../components/inspector/inspector.css";
import { appApi, isDesktop, type LeechSummary } from "../lib/appApi";
import "../review/review.css";
import "./leech-cleanup.css";

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

export function LeechCleanup() {
  const desktop = isDesktop();
  const [cards, setCards] = useState<readonly LeechSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
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
    async (id: string, action: "suspend" | "delete" | "unleech") => {
      setBusyId(id);
      setError(null);
      try {
        if (action === "suspend") await appApi.suspendCard({ cardId: id });
        else if (action === "delete") await appApi.deleteCard({ cardId: id });
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

  if (!desktop) {
    return (
      <div className="rv-shell" data-testid="route-leech-cleanup">
        <div className="rv-blank">
          <div className="rv-empty">
            <div className="rv-empty__icon">
              <Icon name="leech" size={26} />
            </div>
            <h1 className="rv-empty__title">Leech cleanup</h1>
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
            Leech cleanup
          </h1>
          <p className="lc-sub">
            Cards that keep lapsing (≥ 4 failures). Rewrite, suspend, or delete them so they stop
            costing review time.
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
          cards.map((card) => (
            <div className="lc-card" key={card.id} data-testid="leech-card" data-card-id={card.id}>
              <div className="lc-card__meta">
                <span className="badge badge--soft">{card.kind === "cloze" ? "Cloze" : "Q&A"}</span>
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
                  <div className="refblock lc-card__src">
                    {card.sourceTitle}
                    {card.sourceLocationLabel ? ` · ${card.sourceLocationLabel}` : ""}
                  </div>
                ) : null}
              </div>

              {editingId === card.id ? (
                <RewriteEditor
                  card={card}
                  onSaved={async () => {
                    setEditingId(null);
                    await load();
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div className="lc-card__actions" data-testid="leech-card-actions">
                  <button
                    type="button"
                    className="rv-repair__btn"
                    data-testid="leech-rewrite"
                    disabled={busyId === card.id}
                    onClick={() => setEditingId(card.id)}
                  >
                    <Icon name="edit" size={14} />
                    Rewrite
                  </button>
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
          ))
        )}
      </div>
    </div>
  );
}

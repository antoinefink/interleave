/**
 * In-review card repair row + inline editor + context drawer (T038).
 *
 * Rebuilt from `design/kit/app/screen-review.jsx`'s repair `Btn` row + context
 * `drawer`. The user fixes a bad card the MOMENT it surfaces, without leaving
 * review:
 *  - **Edit** opens an inline prompt/answer (Q&A) or cloze editor and saves via
 *    `appApi.updateCard` (`cards.update` → `update_element`); the in-flight card is
 *    patched in place (the FSRS state + lineage are untouched main-side).
 *  - **Open source** jumps back to the originating paragraph via the card's lineage
 *    (the parent screen's `onOpenSource`, reusing the T022 `navigateToLocation`).
 *  - **Add context** opens the source-context drawer (kit's `drawer`) with the
 *    refblock + an open-source affordance; richer capture is M17/T085.
 *  - **Suspend** (`cards.suspend`) and **Delete** (`cards.delete`) remove the card
 *    from the live deck and advance the session (`onCardRemoved`).
 *  - **Flag** (`cards.flag`) toggles the non-destructive flag-as-bad marker; the
 *    card stays in the deck (`onCardUpdated`).
 *
 * Architecture (non-negotiable): this is UI only. No SQL, no FSRS math, no
 * lineage/quality logic — every mutation is a typed `appApi.*` call over the
 * preload bridge; the main process owns the transaction + the `operation_log` op.
 */

import { useCallback, useState } from "react";
import { Icon } from "../components/Icon";
import { TypeIcon } from "../components/inspector/primitives";
import { appApi, type CardEditSummary, type ReviewCardView } from "../lib/appApi";

/** A patch applied to the in-flight card after an edit/flag (body + flag fields). */
export type ReviewCardPatch = Pick<
  ReviewCardView,
  "id" | "prompt" | "answer" | "cloze" | "flagged" | "leech"
>;

interface ReviewRepairBarProps {
  readonly card: ReviewCardView;
  /** True while a grade is in flight (the repair actions are disabled with it). */
  readonly busy: boolean;
  /** Jump back to the originating source paragraph (lineage). */
  readonly onOpenSource: () => void;
  /** Patch the in-flight card after an edit/flag (the card stays in the deck). */
  readonly onCardUpdated: (patch: ReviewCardPatch) => void;
  /** Remove the current card from the deck + advance (suspend/delete). */
  readonly onCardRemoved: () => void | Promise<void>;
}

/** Map a `CardEditSummary` onto the patch the parent applies to the in-flight card. */
function patchFromSummary(card: CardEditSummary): ReviewCardPatch {
  return {
    id: card.id,
    // For a cloze card the review front renders the `cloze` text as the prompt.
    prompt: card.kind === "cloze" ? (card.cloze ?? "") : (card.prompt ?? ""),
    answer: card.answer,
    cloze: card.cloze,
    flagged: card.flagged,
    leech: card.leech,
  };
}

export function ReviewRepairBar({
  card,
  busy,
  onOpenSource,
  onCardUpdated,
  onCardRemoved,
}: ReviewRepairBarProps) {
  const [editing, setEditing] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline edit-form fields, seeded from the card on open.
  const isCloze = card.kind === "cloze";
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [cloze, setCloze] = useState("");

  const openEditor = useCallback(() => {
    setPrompt(card.prompt ?? "");
    setAnswer(card.answer ?? "");
    setCloze(card.cloze ?? card.prompt ?? "");
    setError(null);
    setEditing(true);
  }, [card]);

  const saveEdit = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await appApi.updateCard({
        cardId: card.id,
        ...(isCloze ? { cloze } : { prompt, answer }),
      });
      onCardUpdated(patchFromSummary(res.card));
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [saving, card.id, isCloze, cloze, prompt, answer, onCardUpdated]);

  const suspend = useCallback(async () => {
    if (busy || saving) return;
    setSaving(true);
    try {
      await appApi.suspendCard({ cardId: card.id });
      await onCardRemoved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }, [busy, saving, card.id, onCardRemoved]);

  const remove = useCallback(async () => {
    if (busy || saving) return;
    setSaving(true);
    try {
      await appApi.deleteCard({ cardId: card.id });
      await onCardRemoved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }, [busy, saving, card.id, onCardRemoved]);

  const toggleFlag = useCallback(async () => {
    if (busy || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await appApi.flagCard({ cardId: card.id, flagged: !card.flagged });
      onCardUpdated(patchFromSummary(res.card));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [busy, saving, card.id, card.flagged, onCardUpdated]);

  const toggleLeech = useCallback(async () => {
    if (busy || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await appApi.markLeechCard({ cardId: card.id, leech: !card.leech });
      onCardUpdated(patchFromSummary(res.card));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [busy, saving, card.id, card.leech, onCardUpdated]);

  const disabled = busy || saving;

  return (
    <>
      {editing ? (
        <div className="rv-edit" data-testid="review-edit">
          {isCloze ? (
            <label className="rv-edit__field">
              <span className="rv-edit__label">Cloze text</span>
              <textarea
                className="rv-edit__textarea"
                data-testid="review-edit-cloze"
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
                  data-testid="review-edit-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={2}
                />
              </label>
              <label className="rv-edit__field">
                <span className="rv-edit__label">Answer</span>
                <textarea
                  className="rv-edit__textarea"
                  data-testid="review-edit-answer"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  rows={2}
                />
              </label>
            </>
          )}
          {error ? (
            <p className="rv-edit__error" data-testid="review-edit-error">
              {error}
            </p>
          ) : null}
          <div className="rv-edit__actions">
            <button
              type="button"
              className="rv-btn"
              data-testid="review-edit-cancel"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rv-btn rv-btn--primary"
              data-testid="review-edit-save"
              onClick={() => void saveEdit()}
              disabled={saving}
            >
              <Icon name="check" size={14} />
              Save
            </button>
          </div>
        </div>
      ) : null}

      <div className="rv-repair" data-testid="review-repair">
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="review-repair-edit"
          disabled={disabled}
          onClick={openEditor}
        >
          <Icon name="edit" size={14} />
          Edit
        </button>
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="review-repair-source"
          disabled={!card.sourceLocationLabel}
          onClick={onOpenSource}
        >
          <Icon name="source" size={14} />
          Open source
        </button>
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="review-repair-context"
          onClick={() => setDrawerOpen(true)}
        >
          <Icon name="context" size={14} />
          Add context
        </button>
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="review-repair-suspend"
          disabled={disabled}
          onClick={() => void suspend()}
        >
          <Icon name="pause" size={14} />
          Suspend
        </button>
        <button
          type="button"
          className={`rv-repair__btn${card.flagged ? " rv-repair__btn--active" : ""}`}
          data-testid="review-repair-flag"
          aria-pressed={card.flagged}
          disabled={disabled}
          onClick={() => void toggleFlag()}
        >
          <Icon name="flag" size={14} />
          {card.flagged ? "Flagged" : "Flag as bad"}
        </button>
        <button
          type="button"
          className={`rv-repair__btn${card.leech ? " rv-repair__btn--active" : ""}`}
          data-testid="review-repair-leech"
          aria-pressed={card.leech}
          disabled={disabled}
          onClick={() => void toggleLeech()}
        >
          <Icon name="leech" size={14} />
          {card.leech ? "Leech" : "Mark leech"}
        </button>
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="review-repair-delete"
          disabled={disabled}
          onClick={() => void remove()}
        >
          <Icon name="trash" size={14} />
          Delete
        </button>
      </div>

      {drawerOpen ? (
        <>
          <button
            type="button"
            className="drawer-overlay"
            aria-label="Close source context"
            data-testid="review-drawer-overlay"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="drawer" data-testid="review-context-drawer">
            <div className="drawer__head">
              <span className="drawer__title">Source context</span>
              <button
                type="button"
                className="rv-repair__btn"
                data-testid="review-drawer-close"
                onClick={() => setDrawerOpen(false)}
              >
                <Icon name="x" size={15} />
              </button>
            </div>
            <div className="drawer__body">
              <div className="drawer__src">
                <TypeIcon type="source" />
                <div className="drawer__src-meta">
                  <span className="drawer__src-title">{card.sourceTitle ?? "Source"}</span>
                  {card.sourceLocationLabel ? (
                    <span className="drawer__src-loc">{card.sourceLocationLabel}</span>
                  ) : null}
                </div>
              </div>
              {card.ref ? <div className="refblock">{card.ref}</div> : null}
              <button
                type="button"
                className="rv-btn rv-btn--primary"
                data-testid="review-drawer-open-source"
                disabled={!card.sourceLocationLabel}
                onClick={() => {
                  setDrawerOpen(false);
                  onOpenSource();
                }}
              >
                <Icon name="external" size={14} />
                Open source at this location
              </button>
            </div>
          </aside>
        </>
      ) : null}
    </>
  );
}

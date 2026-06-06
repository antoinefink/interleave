/**
 * In-review card repair row + inline editor + context drawer (T038).
 *
 * Rebuilt from `design/kit/app/screen-review.jsx`'s repair `Btn` row + context
 * `drawer`. The user fixes a bad card the MOMENT it surfaces, without leaving
 * review:
 *  - **Edit** opens an inline prompt/answer (Q&A) or cloze editor and autosaves via
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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  readonly onCardRemoved: (cardId: string) => void | Promise<void>;
  /** Lift local mutation state so parents can block conflicting grade actions. */
  readonly onBusyChange?: (busy: boolean) => void;
  /**
   * Source-context drawer open state, lifted to the parent so the leech banner's
   * "Add context" affordance (kit `screen-review.jsx`) opens the SAME drawer this
   * row's "Add context" button does — one drawer, one trigger.
   */
  readonly drawerOpen: boolean;
  readonly onDrawerOpenChange: (open: boolean) => void;
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

const EDIT_AUTOSAVE_MS = 600;

function editFingerprint(patch: Readonly<Record<string, string>>): string {
  return JSON.stringify(patch);
}

function editPatchReady(patch: Readonly<Record<string, string>>): boolean {
  return Object.values(patch).every((value) => value.trim().length > 0);
}

function reviewEditPatch(
  kind: ReviewCardView["kind"],
  values: {
    readonly prompt: string;
    readonly answer: string;
    readonly cloze: string;
  },
): Record<string, string> {
  if (kind === "image_occlusion") return { answer: values.answer };
  if (kind === "cloze") return { cloze: values.cloze };
  return { prompt: values.prompt, answer: values.answer };
}

export function ReviewRepairBar({
  card,
  busy,
  onOpenSource,
  onCardUpdated,
  onCardRemoved,
  onBusyChange,
  drawerOpen,
  onDrawerOpenChange,
}: ReviewRepairBarProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline edit-form fields, seeded from the card on open. An `image_occlusion`
  // card has no prompt/answer text body — its content is the image + masked region.
  // The only editable text is the mask's REVEAL LABEL (stored on the card's
  // `answer`), so the inline editor shows a single label field for it rather than the
  // Q&A prompt/answer form (which would be meaningless for an occlusion card).
  const isCloze = card.kind === "cloze";
  const isOcclusion = card.kind === "image_occlusion";
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [cloze, setCloze] = useState("");
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedEdit = useRef("");
  const mountedRef = useRef(false);
  const inFlightEdit = useRef<{ fingerprint: string; promise: Promise<boolean> } | null>(null);
  const latestEdit = useRef<{
    editing: boolean;
    cardId: string;
    patch: Record<string, string>;
    fingerprint: string;
  }>({
    editing: false,
    cardId: card.id,
    patch: reviewEditPatch(card.kind, { prompt: "", answer: "", cloze: "" }),
    fingerprint: "",
  });

  const setSavingState = useCallback(
    (next: boolean) => {
      if (!mountedRef.current) return;
      setSaving(next);
      onBusyChange?.(next);
    },
    [onBusyChange],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onBusyChange?.(false);
    };
  }, [onBusyChange]);

  const openEditor = useCallback(() => {
    const nextPrompt = card.prompt ?? "";
    const nextAnswer = card.answer ?? "";
    const nextCloze = card.cloze ?? card.prompt ?? "";
    setPrompt(nextPrompt);
    setAnswer(nextAnswer);
    setCloze(nextCloze);
    lastSavedEdit.current = editFingerprint(
      reviewEditPatch(card.kind, {
        prompt: nextPrompt,
        answer: nextAnswer,
        cloze: nextCloze,
      }),
    );
    setError(null);
    setEditing(true);
  }, [card]);

  const currentEditPatch = useCallback(
    () => reviewEditPatch(card.kind, { prompt, answer, cloze }),
    [card.kind, answer, cloze, prompt],
  );
  const liveEditPatch = currentEditPatch();
  const dirtyNow = editing && editFingerprint(liveEditPatch) !== lastSavedEdit.current;
  const editDirty = dirty || dirtyNow;
  latestEdit.current = {
    editing,
    cardId: card.id,
    patch: liveEditPatch,
    fingerprint: editFingerprint(liveEditPatch),
  };

  useLayoutEffect(() => {
    setDirty(dirtyNow);
    if (!saving) onBusyChange?.(dirtyNow);
  }, [dirtyNow, saving, onBusyChange]);

  const saveEditPatch = useCallback(
    async ({
      applyResult,
      cardId,
      fingerprint,
      patch,
      reportError,
      setBusy,
    }: {
      readonly applyResult: boolean;
      readonly cardId: string;
      readonly fingerprint: string;
      readonly patch: Record<string, string>;
      readonly reportError: boolean;
      readonly setBusy: boolean;
    }): Promise<boolean> => {
      const activeSave = inFlightEdit.current;
      if (activeSave) {
        if (activeSave.fingerprint === fingerprint) return activeSave.promise;
        await activeSave.promise.catch(() => false);
        return saveEditPatch({ applyResult, cardId, fingerprint, patch, reportError, setBusy });
      }
      if (setBusy) setSavingState(true);
      if (reportError) setError(null);
      const promise = appApi
        .updateCard({
          cardId,
          ...patch,
        })
        .then((res) => {
          const isLatest =
            latestEdit.current.cardId === cardId && latestEdit.current.fingerprint === fingerprint;
          if (isLatest) {
            if (applyResult) onCardUpdated(patchFromSummary(res.card));
            lastSavedEdit.current = fingerprint;
            if (mountedRef.current) setDirty(false);
          }
          return true;
        })
        .catch((e) => {
          const isLatest =
            latestEdit.current.cardId === cardId && latestEdit.current.fingerprint === fingerprint;
          if (isLatest && reportError && mountedRef.current) {
            setError(e instanceof Error ? e.message : String(e));
          }
          return false;
        })
        .finally(() => {
          if (inFlightEdit.current?.fingerprint === fingerprint) {
            inFlightEdit.current = null;
          }
          if (setBusy) setSavingState(false);
        });
      inFlightEdit.current = { fingerprint, promise };
      return promise;
    },
    [onCardUpdated, setSavingState],
  );

  const flushPendingEditOnUnmountRef = useRef<() => void>(() => {});

  const flushPendingEditOnUnmount = useCallback(() => {
    const latest = latestEdit.current;
    if (
      !latest.editing ||
      latest.fingerprint === lastSavedEdit.current ||
      !editPatchReady(latest.patch)
    ) {
      return;
    }
    if (editTimer.current) {
      clearTimeout(editTimer.current);
      editTimer.current = null;
    }
    void saveEditPatch({
      applyResult: false,
      cardId: latest.cardId,
      fingerprint: latest.fingerprint,
      patch: latest.patch,
      reportError: false,
      setBusy: false,
    });
  }, [saveEditPatch]);
  flushPendingEditOnUnmountRef.current = flushPendingEditOnUnmount;

  const persistEdit = useCallback(
    async (requireReady = false) => {
      const latest = latestEdit.current;
      const patch = latest.patch;
      const fingerprint = latest.fingerprint;
      const cardId = latest.cardId;
      if (fingerprint === lastSavedEdit.current) return true;
      if (!editPatchReady(patch)) {
        if (requireReady) setError("Complete the editable fields before closing.");
        return false;
      }
      if (editTimer.current) {
        clearTimeout(editTimer.current);
        editTimer.current = null;
      }
      return saveEditPatch({
        applyResult: true,
        cardId,
        fingerprint,
        patch,
        reportError: true,
        setBusy: true,
      });
    },
    [saveEditPatch],
  );

  useEffect(() => {
    if (!editing) return;
    if (editTimer.current) {
      clearTimeout(editTimer.current);
      editTimer.current = null;
    }
    const patch = currentEditPatch();
    if (!editPatchReady(patch) || editFingerprint(patch) === lastSavedEdit.current) return;
    editTimer.current = setTimeout(() => {
      editTimer.current = null;
      void persistEdit();
    }, EDIT_AUTOSAVE_MS);
    return () => {
      if (editTimer.current) {
        clearTimeout(editTimer.current);
        editTimer.current = null;
      }
    };
  }, [editing, currentEditPatch, persistEdit]);

  useEffect(() => {
    return () => flushPendingEditOnUnmountRef.current();
  }, []);

  const closeEditor = useCallback(async () => {
    const saved = await persistEdit(true);
    if (saved) setEditing(false);
  }, [persistEdit]);

  const suspend = useCallback(async () => {
    if (busy || saving || editDirty) return;
    const removedCardId = card.id;
    setSavingState(true);
    try {
      await appApi.suspendCard({ cardId: removedCardId });
      await onCardRemoved(removedCardId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSavingState(false);
    }
  }, [busy, saving, editDirty, card.id, onCardRemoved, setSavingState]);

  const remove = useCallback(async () => {
    if (busy || saving || editDirty) return;
    const removedCardId = card.id;
    setSavingState(true);
    try {
      await appApi.deleteCard({ cardId: removedCardId });
      await onCardRemoved(removedCardId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSavingState(false);
    }
  }, [busy, saving, editDirty, card.id, onCardRemoved, setSavingState]);

  // Retire (T082) — a low-value mature card leaves active review gracefully (kept
  // for reference, reversibly). Like suspend it drops the card from the deck +
  // advances the session, but it is a distinct exit (the durable `is_retired` flag,
  // not a status). Un-retire lives in the inspector + the maintenance inventory.
  const retire = useCallback(async () => {
    if (busy || saving || editDirty) return;
    const removedCardId = card.id;
    setSavingState(true);
    setError(null);
    try {
      await appApi.retireCard({ cardId: removedCardId });
      await onCardRemoved(removedCardId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSavingState(false);
    }
  }, [busy, saving, editDirty, card.id, onCardRemoved, setSavingState]);

  const toggleFlag = useCallback(async () => {
    if (busy || saving || editDirty) return;
    setSavingState(true);
    setError(null);
    try {
      const res = await appApi.flagCard({ cardId: card.id, flagged: !card.flagged });
      onCardUpdated(patchFromSummary(res.card));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingState(false);
    }
  }, [busy, saving, editDirty, card.id, card.flagged, onCardUpdated, setSavingState]);

  const toggleLeech = useCallback(async () => {
    if (busy || saving || editDirty) return;
    setSavingState(true);
    setError(null);
    try {
      const res = await appApi.markLeechCard({ cardId: card.id, leech: !card.leech });
      onCardUpdated(patchFromSummary(res.card));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingState(false);
    }
  }, [busy, saving, editDirty, card.id, card.leech, onCardUpdated, setSavingState]);

  // Keyboard repairs (T048) — `E` opens the inline editor, `S` suspends. These run
  // the SAME `openEditor` / `suspend` handlers the on-screen repair buttons call (no
  // second mutation path); the cheat sheet documents them as review-scope keys.
  // Suppressed while typing in a field (so editing the prompt/answer is unaffected)
  // and while the inline editor is already open. Space + 1–4 stay in `ReviewScreen`.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      if (editing || busy || saving || editDirty) return;
      const k = e.key.toLowerCase();
      if (k === "e") {
        e.preventDefault();
        openEditor();
      } else if (k === "s") {
        e.preventDefault();
        void suspend();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, editDirty, editing, saving, openEditor, suspend]);

  const disabled = busy || saving || editDirty;

  return (
    <>
      {editing ? (
        <div className="rv-edit" data-testid="review-edit">
          {isOcclusion ? (
            <label className="rv-edit__field">
              <span className="rv-edit__label">Reveal label</span>
              <textarea
                className="rv-edit__textarea"
                data-testid="review-edit-occlusion-label"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onBlur={() => void persistEdit()}
                rows={2}
              />
            </label>
          ) : isCloze ? (
            <label className="rv-edit__field">
              <span className="rv-edit__label">Cloze text</span>
              <textarea
                className="rv-edit__textarea"
                data-testid="review-edit-cloze"
                value={cloze}
                onChange={(e) => setCloze(e.target.value)}
                onBlur={() => void persistEdit()}
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
                  onBlur={() => void persistEdit()}
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
                  onBlur={() => void persistEdit()}
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
              data-testid="review-edit-done"
              onClick={() => void closeEditor()}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}

      {error && !editing ? (
        <p className="rv-edit__error" data-testid="review-edit-error">
          {error}
        </p>
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
          disabled={disabled || !card.sourceLocationLabel}
          onClick={onOpenSource}
        >
          <Icon name="source" size={14} />
          Open source
        </button>
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="review-repair-context"
          disabled={disabled}
          onClick={() => onDrawerOpenChange(true)}
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
          className="rv-repair__btn"
          data-testid="review-repair-retire"
          title="Retire (low-value, keep for reference)"
          disabled={disabled}
          onClick={() => void retire()}
        >
          <Icon name="archive" size={14} />
          Retire
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
            onClick={() => onDrawerOpenChange(false)}
          />
          <aside className="drawer" data-testid="review-context-drawer">
            <div className="drawer__head">
              <span className="drawer__title">Source context</span>
              <button
                type="button"
                className="rv-repair__btn"
                data-testid="review-drawer-close"
                onClick={() => onDrawerOpenChange(false)}
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
                disabled={disabled || !card.sourceLocationLabel}
                onClick={() => {
                  onDrawerOpenChange(false);
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

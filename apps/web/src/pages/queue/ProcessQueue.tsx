/**
 * "Process queue" learning loop (T031) — the keyboard-first daily grind.
 *
 * Takes the T029 due queue (`queue.list`, honoring the active filters/clock) and
 * presents it ONE ELEMENT AT A TIME, rendering the right surface for each type —
 * a compact read/process panel for attention items (source / topic / extract /
 * task) and the FULL inline FSRS card surface for cards (reveal → grade
 * Again/Hard/Good/Easy with next-interval previews, exactly as the review session)
 * — with the T030 actions (open-in-full / postpone / raise / lower / done /
 * dismiss / delete / skip) available inline. After EVERY action it advances the
 * cursor to the next due item automatically, so a user can process ten mixed
 * sources/extracts/cards end to end WITHOUT ever returning to the list — including
 * grading a due card inline, never detouring to /review. A progress readout
 * ("3 / 12 · N left") and a mode `Segmented` header — whose selection is a real
 * server-side ordering input threaded into `queue.list` (T076 auto-sort), not a
 * presentational toggle — frame the session; finishing shows the "Queue clear"
 * done state.
 *
 * Architecture (non-negotiable): the loop introduces NO new mutation path — the
 * T030 actions call the SAME typed `appApi.actOnQueueItem` (`queue.act`) /
 * `appApi.setElementPriority` the list uses, and a card grade calls the SAME
 * `appApi.reviewGrade` (`review.grade`) the review session uses, with previews from
 * `appApi.reviewPreview` and the full reveal-ready card from `appApi.reviewCard`
 * (a TARGETED, read-only `review.card` fetch — the loop walks a frozen order, so it
 * cannot use the soonest-due `review.session.next`). The renderer never touches
 * SQLite/Node/fs and never does FSRS math — it only carries opaque ids + measures
 * the reveal→grade response time. Cards stay on FSRS, attention items on the
 * attention scheduler — the chip + scheduling never cross (a card never sees the
 * `ScheduleMenu`). The card grade advances the FROZEN-order cursor (consistent with
 * the other loop actions), it does NOT re-read the review deck.
 *
 * Pure UI orchestration — no SQL, no scheduling math, no priority math.
 */

import { renderClozePrompt } from "@interleave/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import {
  FsrsStats,
  Prio,
  SchedulerChip,
  Stage,
  TypeIcon,
} from "../../components/inspector/primitives";
import { ScheduleMenu } from "../../components/queue/ScheduleMenu";
import { RefBlock } from "../../components/RefBlock";
import "../../components/inspector/inspector.css";
import {
  appApi,
  isDesktop,
  type QueueActAction,
  type QueueItemSummary,
  type QueueScheduleChoice,
  type ReviewCardView,
  type ReviewIntervalPreview,
  type ReviewRating,
  type SchedulerSignals,
} from "../../lib/appApi";
import { CardBody } from "../../review/CardBody";
import { CardFront } from "../../review/CardFront";
import "../../review/review.css";
import { useActiveScope } from "../../shell/activeScope";
import { Kbd } from "../../shell/Kbd";
import { useSelection } from "../../shell/selection";
import { jitterOrder } from "./jitter";
import "./queue.css";
import "./process-queue.css";
import { useProcessShortcuts } from "./useProcessShortcuts";

/**
 * The session mode (T076) — a SOFT ordering bias sent to `queue.list` as `mode`, not
 * a client-side slice. `review` floats cards to the front, `read` floats reading
 * items, `full` is neutral; BOTH types always stay in the deck (the old `modeIncludes`
 * hard filter is gone), so switching mode RE-ORDERS the loop rather than slicing it.
 */
type SessionMode = "full" | "review" | "read";
const MODES: readonly { id: SessionMode; label: string; icon: IconName }[] = [
  { id: "full", label: "Full", icon: "layers" },
  { id: "review", label: "Review-only", icon: "review" },
  { id: "read", label: "Reading-only", icon: "bookmark" },
];

/** The four FSRS ratings in display + keyboard order (1–4), matching the review session. */
const GRADES: readonly { rating: ReviewRating; label: string; key: string }[] = [
  { rating: "again", label: "Again", key: "1" },
  { rating: "hard", label: "Hard", key: "2" },
  { rating: "good", label: "Good", key: "3" },
  { rating: "easy", label: "Easy", key: "4" },
];

/** The inline non-open actions a loop item exposes (the T030 set + skip). */
type LoopActionKind = QueueActAction["kind"];

/** A loaded body preview for the current item (attention items render their text). */
interface ItemBody {
  readonly title: string;
  readonly sourceTitle: string | null;
  readonly bodyText: string | null;
}

/** The per-type title prefix (mirrors the queue list). */
function titleFor(item: QueueItemSummary): string {
  if (item.type === "card") {
    const prefix = item.cardType === "cloze" ? "Cloze · " : "Q&A · ";
    return prefix + maskCloze(item.title);
  }
  if (item.type === "extract") return `Extract · ${item.title}`;
  if (item.type === "topic") return `Topic · ${item.title}`;
  return item.title;
}

/**
 * Mask EVERY `{{cN::…}}` cloze deletion in a prompt (for the header title, where the
 * answer must never leak). Uses the core `renderClozePrompt` helper so all deletions
 * are masked — a non-global regex would leak the 2nd+ deletion.
 */
function maskCloze(text: string): string {
  return renderClozePrompt(text, { revealAll: false })
    .map((span) => (span.kind === "deletion" ? "[…]" : span.content))
    .join("");
}

/** The chip shape the SchedulerChip expects, from the queue's trimmed signals. */
function chipSignals(item: QueueItemSummary): SchedulerSignals {
  return {
    kind: item.schedulerSignals.kind,
    retrievability: item.schedulerSignals.retrievability,
    stability: item.schedulerSignals.stability,
    difficulty: null,
    reps: null,
    lapses: null,
    fsrsState: null,
    stage: item.schedulerSignals.stage,
    postponed: item.schedulerSignals.postponed,
    lastProcessedAt: null,
  };
}

/** Adapt a loaded review card's FSRS signals to the shared chip/stat shape. */
function cardChipSignals(card: ReviewCardView): SchedulerSignals {
  return {
    kind: "fsrs",
    retrievability: card.schedulerSignals.retrievability,
    stability: card.schedulerSignals.stability,
    difficulty: card.schedulerSignals.difficulty,
    reps: card.schedulerSignals.reps,
    lapses: card.schedulerSignals.lapses,
    fsrsState: card.schedulerSignals.fsrsState,
    stage: card.stage,
    postponed: 0,
    lastProcessedAt: null,
  };
}

export function ProcessQueue() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const { select } = useSelection();
  // The route declares no `validateSearch`, so search is loosely typed — an
  // optional `asOf` date-scopes the due reads (the E2E drives a fixed clock) and an
  // optional `mode` seeds the session ordering bias (T076).
  const search = useSearch({ strict: false }) as { asOf?: string; mode?: string };
  const asOf = typeof search.asOf === "string" ? search.asOf : undefined;

  const [mode, setMode] = useState<SessionMode>(
    search.mode === "review" || search.mode === "read" ? search.mode : "full",
  );
  /** Index into the ordered (T076-scored, jittered) session deck. */
  const [cursor, setCursor] = useState(0);
  /** How many items the user has processed this session (acted/scheduled/graded). */
  const [processed, setProcessed] = useState(0);
  const [body, setBody] = useState<ItemBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- The inline card-review surface state (lifted here so the keyboard can drive
  // reveal/grade while a card is the current item, exactly like the review session).
  /** The full reveal-ready view for the current CARD item (fetched by id), or null. */
  const [cardView, setCardView] = useState<ReviewCardView | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [previews, setPreviews] = useState<Record<ReviewRating, ReviewIntervalPreview> | null>(
    null,
  );
  /** When the current card was revealed (for the reveal→grade response time). */
  const revealAtRef = useRef<number | null>(null);
  /** Card ids already graded this session — the hard guard against a double grade. */
  const gradedRef = useRef<Set<string>>(new Set());

  // The ordered session list: the read's deterministic T076 SCORE order (which the
  // `mode` already biases server-side), then the stable seeded jitter (so the user
  // isn't trapped in one topic). The FULL mixed deck — `mode` re-orders it, never
  // slices it (the old `modeIncludes` filter is gone), so both cards and reading items
  // are always present. Frozen for the session's lifetime via the fetch — the cursor
  // walks THIS order; acting on an item just advances the cursor (we never re-read and
  // reshuffle mid-session, which would yank the ground out from under the user). A
  // mode switch is the ONE deliberate re-fetch (the order changes, not the membership).
  const [order, setOrder] = useState<QueueItemSummary[]>([]);

  const total = order.length;
  const current = cursor < total ? order[cursor] : null;
  const done = total === 0 || cursor >= total;
  const isCard = current?.type === "card";
  /** Items left to look at (this one + everything after) — the full mixed deck. */
  const remaining = Math.max(0, total - cursor);

  // Read the latest mode without making `load` depend on it, so a load triggered by
  // the clock alone uses whatever mode is current (a mode switch passes it explicitly).
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Load the queue (on mount, when the clock changes, and on a mode switch). `mode`
  // flows to `queue.list` as a SOFT ordering bias, so the loop reads the FULL mixed
  // deck re-ordered for the mode — no client-side slice. The loop freezes that order
  // at load so the cursor is stable; subsequent actions advance the cursor.
  const load = useCallback(
    async (modeOverride?: SessionMode) => {
      if (!isDesktop()) return;
      const activeMode = modeOverride ?? modeRef.current;
      try {
        const next = await appApi.listQueue({
          ...(asOf ? { asOf } : {}),
          mode: activeMode,
        });
        setError(null);
        setOrder(jitterOrder(next.items));
        setCursor(0);
        setProcessed(0);
        gradedRef.current = new Set();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [asOf],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Load the current item's body preview (attention items show their text) OR the
  // current card's full reveal-ready view (so reveal can unmask cloze / show the
  // Q&A answer + source ref). Read-only, through the typed bridge.
  useEffect(() => {
    let cancelled = false;
    // Reset the per-item reveal/grade surface whenever the item changes.
    setRevealed(false);
    setPreviews(null);
    revealAtRef.current = null;
    if (!current) {
      setBody(null);
      setCardView(null);
      return;
    }
    if (current.type === "card") {
      setBody(null);
      void (async () => {
        try {
          const res = await appApi.reviewCard({
            cardId: current.id,
            ...(asOf ? { asOf } : {}),
          });
          if (cancelled) return;
          setCardView(res.card);
        } catch {
          if (cancelled) return;
          setCardView(null);
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    setCardView(null);
    void (async () => {
      try {
        const [doc, insp] = await Promise.all([
          appApi.getDocument({ elementId: current.id }),
          appApi.getInspectorData({ id: current.id }),
        ]);
        if (cancelled) return;
        setBody({
          title: insp.data?.element.title ?? current.title,
          sourceTitle: insp.data?.source?.title ?? current.sourceTitle,
          bodyText: doc.document?.plainText ?? null,
        });
      } catch {
        if (cancelled) return;
        setBody({ title: current.title, sourceTitle: current.sourceTitle, bodyText: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current, asOf]);

  // Selecting the current item drives the shell inspector to its context.
  useEffect(() => {
    if (current) select(current.id);
  }, [current, select]);

  const advance = useCallback(() => {
    setCursor((c) => c + 1);
  }, []);

  /**
   * Re-order the loop when the mode changes by RE-REQUESTING `queue.list` with the new
   * `mode` (the T076 score re-orders the same full mixed deck — `review` floats cards,
   * `read` floats reading items — so this is a deliberate re-fetch, not a client-side
   * slice). The deck membership is unchanged; only its order is.
   */
  const onModeChange = useCallback(
    (next: SessionMode) => {
      setMode(next);
      void load(next);
    },
    [load],
  );

  /**
   * Apply one in-place action through the SAME typed mutation path as the list
   * (T030), then ADVANCE to the next item. postpone/raise/lower/done/dismiss/delete
   * all route through `queue.act`; the loop never returns to the list — it just
   * moves the cursor. No undo snackbar here (the list owns that affordance); the
   * loop optimizes for uninterrupted forward motion.
   */
  const act = useCallback(
    async (kind: LoopActionKind) => {
      if (!current || busy || !isDesktop()) return;
      setBusy(true);
      try {
        await appApi.actOnQueueItem({ id: current.id, action: { kind } });
        setProcessed((p) => p + 1);
        advance();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [current, busy, advance],
  );

  /**
   * Schedule the current (non-card attention) item for an EXPLICIT return (T028) —
   * tomorrow / next week / next month / a manual date — through the SAME typed
   * `queue.schedule` bridge command the list uses, then ADVANCE. Like the other
   * loop actions it never returns to the list; the scheduling math lives main-side.
   */
  const schedule = useCallback(
    async (choice: QueueScheduleChoice) => {
      if (!current || busy || !isDesktop()) return;
      setBusy(true);
      try {
        await appApi.scheduleQueueItem({ id: current.id, choice });
        setProcessed((p) => p + 1);
        advance();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [current, busy, advance],
  );

  /** Skip the current item without mutating it (just advance the cursor). */
  const skip = useCallback(() => {
    if (!current) return;
    advance();
  }, [current, advance]);

  /**
   * Reveal the current card's answer + lazily fetch the four interval previews
   * (PURE — no mutation). Captures the reveal timestamp for the response time.
   * Mirrors the review session's reveal exactly. Keyed off the cursor's `current.id`
   * (always present for a card) rather than the async-loaded `cardView`, so a fast
   * Space press never no-ops while the full view is still in flight — the answer
   * block renders the moment `cardView` arrives.
   */
  const reveal = useCallback(async () => {
    if (!isCard || !current || revealed) return;
    setRevealed(true);
    revealAtRef.current = Date.now();
    try {
      const res = await appApi.reviewPreview({
        cardId: current.id,
        ...(asOf ? { asOf } : {}),
      });
      setPreviews(res.intervals);
    } catch {
      // Previews are a nicety; grading still works without them.
      setPreviews(null);
    }
  }, [isCard, current, revealed, asOf]);

  /**
   * Grade the current card INLINE through the SAME `review.grade` the review session
   * uses (FSRS reschedule + a durable `review_logs` row, ALL main-side), measuring
   * the reveal→grade response time, then ADVANCE the FROZEN-order cursor (consistent
   * with `act` — the loop's deck is the queue order, not the review deck). Guards
   * against double-grading the same card. Cards stay FSRS-only.
   */
  const grade = useCallback(
    async (rating: ReviewRating) => {
      if (!isCard || !cardView || !revealed || busy || !isDesktop()) return;
      if (gradedRef.current.has(cardView.id)) return;
      setBusy(true);
      const responseMs = revealAtRef.current ? Math.max(0, Date.now() - revealAtRef.current) : 0;
      try {
        await appApi.reviewGrade({
          cardId: cardView.id,
          rating,
          responseMs,
          ...(asOf ? { asOf } : {}),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
        return;
      }
      gradedRef.current.add(cardView.id);
      setProcessed((p) => p + 1);
      advance();
      setBusy(false);
    },
    [isCard, cardView, revealed, busy, asOf, advance],
  );

  /** Open the current item in its full surface — the ONLY navigation in the loop. */
  const open = useCallback(() => {
    if (!current) return;
    select(current.id);
    if (current.type === "source") {
      void navigate({ to: "/source/$id", params: { id: current.id } });
    } else if (current.type === "extract") {
      void navigate({ to: "/extract/$id", params: { id: current.id } });
    } else {
      // Cards open the review surface; carry the session clock so the date-scoped
      // session (the E2E drives a fixed future clock) reads the same deck.
      void navigate({ to: "/review", search: asOf ? { asOf } : {} });
    }
  }, [current, navigate, select, asOf]);

  // Keyboard-first controls — the loop's core keys, registered in the single
  // shortcut registry (T048) and bound here through the SAME `appApi` path as the
  // buttons. While the loop is live it owns the keys it shares with the global
  // shell handler (`o`/`+`/`-`), so the shell DEFERS them (see `activeScope`). On a
  // CARD, Space reveals and 1–4 grade (after reveal) — exactly like the review
  // session — and these win over next/skip; on a non-card, Space is next/skip.
  const loopActive = desktop && !done;
  useActiveScope("queue", loopActive);
  useProcessShortcuts(
    {
      next: skip,
      postpone: () => void act("postpone"),
      markDone: () => void act("markDone"),
      dismiss: () => void act("dismiss"),
      delete: () => void act("delete"),
      raise: () => void act("raise"),
      lower: () => void act("lower"),
      open,
      isCard: !!isCard,
      revealed,
      reveal: () => void reveal(),
      grade: (rating) => void grade(rating),
    },
    loopActive,
  );

  if (!desktop) {
    return (
      <div className="pq-shell" data-testid="route-process">
        <div className="pq-center">
          <div className="q-empty">
            <div className="q-empty__icon">
              <Icon name="play" size={26} />
            </div>
            <h1 className="q-empty__title">Process queue</h1>
            <p className="q-empty__body">
              The session loop reads due items through the desktop bridge — open the Electron app to
              process your day one item at a time.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pq-shell" data-testid="route-process">
      {/* session header — progress + presentational mode steering */}
      <div className="pq-head">
        <button
          type="button"
          className="pq-end"
          data-testid="process-end"
          onClick={() => navigate({ to: "/queue", search: asOf ? { asOf } : {} })}
        >
          <Icon name="x" size={14} />
          End session
        </button>
        <div className="pq-progress" data-testid="process-progress">
          <div className="pq-progress__nums">
            <span>
              {Math.min(cursor + (done ? 0 : 1), total)} / {total}
            </span>
            <span className="pq-progress__est">{done ? "all done" : `${remaining} left`}</span>
          </div>
          <div className="pq-progress__bar">
            <span
              className="pq-progress__fill"
              style={{ width: `${total === 0 ? 0 : (Math.min(cursor, total) / total) * 100}%` }}
            />
          </div>
        </div>
        <div className="pq-modes" data-testid="process-modes">
          <span className="pq-modes__label">Mode</span>
          {MODES.map((m) => (
            <button
              type="button"
              key={m.id}
              data-testid={`process-mode-${m.id}`}
              aria-pressed={mode === m.id}
              className={`pq-seg${mode === m.id ? " pq-seg--on" : ""}`}
              onClick={() => onModeChange(m.id)}
            >
              <Icon name={m.icon} size={12} />
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="pq-error" data-testid="process-error">
          {error}
        </p>
      ) : null}

      <div className="pq-center">
        {done ? (
          <div className="q-panel pq-donepanel" data-testid="process-done">
            <div className="q-empty">
              <div className="q-empty__icon">
                <Icon name="checkCircle" size={26} />
              </div>
              <h2 className="q-empty__title">Queue clear</h2>
              <p className="q-empty__body">
                You processed {processed} item{processed === 1 ? "" : "s"} one at a time — no list,
                no detours. Your high-priority items are protected; the rest return when they're
                due.
              </p>
              <div className="pq-done__actions">
                <button
                  type="button"
                  className="pq-btn"
                  data-testid="process-restart"
                  onClick={() => void load()}
                >
                  <Icon name="review" size={14} />
                  Reload queue
                </button>
                <button
                  type="button"
                  className="sessionbar__start"
                  data-testid="process-back"
                  onClick={() => navigate({ to: "/queue", search: asOf ? { asOf } : {} })}
                >
                  <Icon name="return" size={14} />
                  Back to queue
                </button>
              </div>
            </div>
          </div>
        ) : current ? (
          <ProcessCard
            item={current}
            body={body}
            cardView={cardView}
            revealed={revealed}
            previews={previews}
            busy={busy}
            onAction={act}
            onSchedule={schedule}
            onSkip={skip}
            onOpen={open}
            onReveal={() => void reveal()}
            onGrade={(rating) => void grade(rating)}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The one-at-a-time process surface for the current item. */
function ProcessCard({
  item,
  body,
  cardView,
  revealed,
  previews,
  busy,
  onAction,
  onSchedule,
  onSkip,
  onOpen,
  onReveal,
  onGrade,
}: {
  item: QueueItemSummary;
  body: ItemBody | null;
  /** The full reveal-ready view for a CARD item (fetched by id), or null. */
  cardView: ReviewCardView | null;
  revealed: boolean;
  previews: Record<ReviewRating, ReviewIntervalPreview> | null;
  busy: boolean;
  onAction: (kind: LoopActionKind) => void;
  /** Explicit (tomorrow/next-week/next-month/manual) scheduling — attention items only. */
  onSchedule: (choice: QueueScheduleChoice) => void;
  onSkip: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onGrade: (rating: ReviewRating) => void;
}) {
  const isCard = item.type === "card";

  return (
    <div
      className="pq-card fade-up"
      data-testid="process-item"
      data-element-id={item.id}
      data-element-type={item.type}
      key={item.id}
    >
      {/* metadata row */}
      <div className="pq-card__meta">
        <div className="pq-card__chips">
          <TypeIcon type={item.type} lg />
          <Prio priority={item.priority} />
          {item.type === "extract" ? <Stage stage={item.stage} /> : null}
          {isCard && cardView?.leech ? (
            <span className="badge badge--leech" data-testid="process-card-leech">
              Leech · {cardView.lapses} lapses
            </span>
          ) : null}
        </div>
        {/* Cards carry the FSRS chip; attention items the attention chip. The
            two-scheduler split holds in the loop. */}
        <SchedulerChip
          scheduler={isCard && cardView ? cardChipSignals(cardView) : chipSignals(item)}
        />
      </div>

      <h1 className="pq-card__title">{titleFor(item)}</h1>

      {isCard ? (
        <div className="pq-cardface" data-testid="process-card-face">
          {/* The card front — the prompt (cloze masked until reveal). */}
          <p className="pq-card__prompt" data-testid="process-card-prompt">
            {cardView ? <CardFront card={cardView} revealed={false} /> : maskCloze(item.title)}
          </p>

          {revealed && cardView ? (
            <div className="pq-card__answer" data-testid="process-card-answer">
              <div className="pq-card__answertext">
                {cardView.kind === "cloze" ? (
                  <CardFront card={cardView} revealed={true} />
                ) : (
                  // T072: render the Q&A answer through the shared body renderer so
                  // math + highlighted code show here too (same path as ReviewScreen).
                  <CardBody body={cardView.answer ?? ""} />
                )}
              </div>
              {/* Source reference (T043) — shown ONLY after reveal so it can't leak
                  the answer. Reuses the shared RefBlock + formatSourceRef. */}
              {cardView.sourceRef ? (
                <RefBlock
                  ref={cardView.sourceRef}
                  testId="process-card-refblock"
                  style={{ marginTop: "var(--space-3)" }}
                />
              ) : null}

              {/* The four FSRS grades with next-interval previews (1–4), exactly as
                  the review session. Grading records the durable review log + advances. */}
              <div className="grades" data-testid="process-card-grades">
                {GRADES.map((g) => (
                  <button
                    type="button"
                    key={g.rating}
                    className={`grade grade--${g.rating}`}
                    data-testid={`process-grade-${g.rating}`}
                    disabled={busy}
                    onClick={() => onGrade(g.rating)}
                  >
                    <span className="grade__label">{g.label}</span>
                    <span className="grade__int" data-testid={`process-interval-${g.rating}`}>
                      {previews ? previews[g.rating].label : "…"}
                    </span>
                    <Kbd keys={g.key} />
                  </button>
                ))}
              </div>
              <div style={{ marginTop: "var(--space-3)" }}>
                <FsrsStats scheduler={cardChipSignals(cardView)} />
              </div>

              {/* "Open in review" stays a SECONDARY affordance — grading inline is
                  the primary path; this is no longer the only way to grade. */}
              <button
                type="button"
                className="pq-btn pq-cardface__review"
                data-testid="process-card-review"
                onClick={onOpen}
              >
                <Icon name="brain" size={14} />
                Open in review
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="sessionbar__start pq-reveal"
              data-testid="process-card-reveal"
              onClick={onReveal}
            >
              <Icon name="eye" size={14} />
              Reveal answer <Kbd keys="␣" />
            </button>
          )}
        </div>
      ) : (
        <div className="pq-body" data-testid="process-body">
          {body?.sourceTitle ? (
            <div className="pq-body__src">
              <Icon name="source" size={13} /> {body.sourceTitle}
            </div>
          ) : null}
          {body?.bodyText ? (
            <p className="pq-body__text">{body.bodyText.slice(0, 900)}</p>
          ) : (
            <p className="pq-body__text pq-body__text--empty">No body to preview for this item.</p>
          )}
        </div>
      )}

      {/* action bar — the same T030 actions, every one advances the cursor */}
      <div className="pq-actions" data-testid="process-actions">
        <button
          type="button"
          className="pq-btn pq-btn--primary"
          disabled={busy}
          data-testid="process-action-open"
          onClick={onOpen}
        >
          <Icon name="external" size={14} />
          Open in full
        </button>
        <span className="pq-actions__spacer" />
        <button
          type="button"
          className="pq-btn"
          disabled={busy}
          data-testid="process-action-raise"
          onClick={() => onAction("raise")}
        >
          <Icon name="arrowUp" size={14} />
          Raise
        </button>
        <button
          type="button"
          className="pq-btn"
          disabled={busy}
          data-testid="process-action-lower"
          onClick={() => onAction("lower")}
        >
          <Icon name="arrowDown" size={14} />
          Lower
        </button>
        <button
          type="button"
          className="pq-btn"
          disabled={busy}
          data-testid="process-action-postpone"
          onClick={() => onAction("postpone")}
        >
          <Icon name="postpone" size={14} />
          Postpone
        </button>
        {/* Explicit reschedule (tomorrow/next-week/next-month/manual) — non-card
            attention items only (cards schedule on FSRS, never the attention seam). */}
        {!isCard ? <ScheduleMenu disabled={busy} onSchedule={onSchedule} /> : null}
        <button
          type="button"
          className="pq-btn"
          disabled={busy}
          data-testid="process-action-dismiss"
          onClick={() => onAction("dismiss")}
        >
          <Icon name="x" size={14} />
          Dismiss
        </button>
        <button
          type="button"
          className="pq-btn pq-btn--danger"
          disabled={busy}
          data-testid="process-action-delete"
          onClick={() => onAction("delete")}
        >
          <Icon name="trash" size={14} />
          Delete
        </button>
        <button
          type="button"
          className="pq-btn"
          disabled={busy}
          data-testid="process-action-skip"
          onClick={onSkip}
        >
          <Icon name="return" size={14} />
          Skip
        </button>
        <button
          type="button"
          className="pq-btn pq-btn--done"
          disabled={busy}
          data-testid="process-action-markDone"
          onClick={() => onAction("markDone")}
        >
          <Icon name="check" size={14} />
          Done
        </button>
      </div>

      <p className="pq-keys">
        {isCard ? (
          <>
            <kbd>␣</kbd> reveal · <kbd>1</kbd>–<kbd>4</kbd> grade · <kbd>d</kbd> done · <kbd>x</kbd>{" "}
            dismiss · <kbd>o</kbd> open · <kbd>n</kbd> next
          </>
        ) : (
          <>
            <kbd>d</kbd> done · <kbd>p</kbd> postpone · <kbd>x</kbd> dismiss · <kbd>+</kbd>/
            <kbd>-</kbd> priority · <kbd>o</kbd> open · <kbd>n</kbd> next
          </>
        )}
      </p>
    </div>
  );
}

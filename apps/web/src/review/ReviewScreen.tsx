/**
 * Active-recall review session (T037) — the FSRS review loop.
 *
 * Rebuilt from `design/kit/app/screen-review.jsx` (the `ReviewScreen`: `rcard`,
 * reveal-on-`Space`, the four `grades` with `card.intervals[g]` previews + `1`/`2`/
 * `3`/`4` keys, `FsrsStats`, the `pbar` + `SessionClock`, the `refblock`
 * jump-to-source, the repair-action row, and the `EmptyState` "Session complete"
 * summary) for React 19 + Tailwind v4 + `lucide-react`.
 *
 * Architecture (non-negotiable): the renderer holds ONLY UI/session state — the
 * deck cursor (driven by `review.session.next({ exclude })`), the revealed flag,
 * and the reveal→grade response timer. It performs NO FSRS math and NO SQL: the
 * scheduling + the durable `review_logs` row happen MAIN-side. Every grade calls
 * the typed `appApi.reviewGrade` with the measured `responseMs`; the previews come
 * from `appApi.reviewPreview` (PURE, no mutation). Driving each step through
 * `review.session.next({ exclude })` keeps the deck-selection seam main-side so
 * T039 sibling-burying can layer on without reordering in React.
 *
 * The session is the plain FSRS due-card deck (cards only — sources/extracts are
 * attention items, not part of review). In-review repair actions (edit / open
 * source / suspend / delete / mark leech) and the leech banner are wired by
 * T038/T040; T037 ships the reveal → grade → advance loop + jump-to-source.
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { FsrsStats, Prio, SchedulerChip, Stage } from "../components/inspector/primitives";
import { RefBlock } from "../components/RefBlock";
import "../components/inspector/inspector.css";
import {
  appApi,
  isDesktop,
  type ReviewCardView,
  type ReviewIntervalPreview,
  type ReviewRating,
  type SchedulerSignals,
} from "../lib/appApi";
import { useNavigateToLocation } from "../reader/navigateToLocation";
import { useActiveScope } from "../shell/activeScope";
import { Kbd } from "../shell/Kbd";
import { useSelection } from "../shell/selection";
import { CardFront } from "./CardFront";
import { ReviewRepairBar } from "./ReviewRepairBar";
import "./review.css";

/** The four ratings in display + keyboard order (1–4). */
const GRADES: readonly { rating: ReviewRating; label: string; key: string }[] = [
  { rating: "again", label: "Again", key: "1" },
  { rating: "hard", label: "Hard", key: "2" },
  { rating: "good", label: "Good", key: "3" },
  { rating: "easy", label: "Easy", key: "4" },
];

/** Adapt a review card's FSRS signals to the shared `SchedulerChip`/`FsrsStats` shape. */
function chipSignals(card: ReviewCardView): SchedulerSignals {
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

/** mm:ss for a millisecond duration. */
function clockLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/** A live mm:ss session clock (ticks every second). */
function SessionClock({ startMs }: { startMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="rv-progress__clock" data-testid="review-clock">
      {clockLabel(now - startMs)}
    </span>
  );
}

export function ReviewScreen() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const { select } = useSelection();
  const navigateToLocation = useNavigateToLocation();

  // The route declares no `validateSearch`; an optional `asOf` date-scopes the due
  // read (the E2E drives a fixed clock so the seeded near-future card reads as due).
  const search = useSearch({ strict: false }) as { asOf?: string };
  const asOf = typeof search.asOf === "string" ? search.asOf : undefined;

  const [card, setCard] = useState<ReviewCardView | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [total, setTotal] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [previews, setPreviews] = useState<Record<ReviewRating, ReviewIntervalPreview> | null>(
    null,
  );
  const [reviewed, setReviewed] = useState(0);
  const [graded, setGraded] = useState<ReviewRating[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [startMs] = useState(() => Date.now());
  const [endMs, setEndMs] = useState<number | null>(null);
  // The source-context drawer is owned here so the leech banner's "Add context"
  // action and the repair bar's "Add context" button drive the same drawer.
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  // The number of cards removed from the live deck WITHOUT a grade (suspend/delete).
  // The progress bar's denominator subtracts these so a completed session reaches
  // 100% even when some cards were repaired away rather than reviewed.
  const [removed, setRemoved] = useState(0);

  // The set of card ids already reviewed this session — passed to `session.next`
  // so the deck advances.
  const excludeRef = useRef<string[]>([]);
  // The sibling group of the card shown most recently (opaque session state passed
  // to `session.next` so the MAIN side buries siblings — T039). The renderer never
  // computes sibling relationships; it only carries the previous card's group id
  // forward. The MVP window is the immediately-preceding card.
  const recentSiblingGroupRef = useRef<string | null>(null);
  // When the current card was revealed, for the reveal→grade response time.
  const revealAtRef = useRef<number | null>(null);

  /**
   * Load the next due card (excluding the already-seen set; burying recent
   * siblings). Returns `true` on success and `false` if the read failed, so the
   * grade path can clear the just-graded card on a post-grade advance failure
   * (otherwise it would stay on screen and be re-gradable).
   */
  const loadNext = useCallback(async (): Promise<boolean> => {
    if (!isDesktop()) return false;
    try {
      const recent = recentSiblingGroupRef.current;
      const res = await appApi.reviewSessionNext({
        exclude: excludeRef.current,
        ...(recent ? { recentSiblingGroups: [recent] } : {}),
        ...(asOf ? { asOf } : {}),
      });
      setError(null);
      setRevealed(false);
      setPreviews(null);
      setContextDrawerOpen(false);
      revealAtRef.current = null;
      if (!res.card) {
        setCard(null);
        setRemaining(0);
        setTotal(res.total);
        // Distinguish a finished session (cards were reviewed → the completion
        // summary) from a deck that was empty from the start (the "no cards due"
        // state). `excludeRef` is non-empty once at least one card was graded.
        if (excludeRef.current.length > 0) {
          setDone(true);
          setEndMs(Date.now());
        }
        return true;
      }
      setCard(res.card);
      setRemaining(res.remaining);
      setTotal((t) => (t === 0 ? res.total + excludeRef.current.length : t));
      // Remember this card's sibling group so the NEXT load buries it (T039). The
      // window is one card (the immediately-preceding); a card with no group clears
      // it so an unrelated card never suppresses anything.
      recentSiblingGroupRef.current = res.card.siblingGroupId;
      select(res.card.id);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [asOf, select]);

  // Load the first card on mount.
  useEffect(() => {
    void loadNext();
  }, [loadNext]);

  /** Reveal the answer + fetch the four interval previews (lazily, on reveal). */
  const reveal = useCallback(async () => {
    if (!card || revealed) return;
    setRevealed(true);
    revealAtRef.current = Date.now();
    try {
      const res = await appApi.reviewPreview({
        cardId: card.id,
        ...(asOf ? { asOf } : {}),
      });
      setPreviews(res.intervals);
    } catch {
      // Previews are a nicety; grading still works without them.
      setPreviews(null);
    }
  }, [card, revealed, asOf]);

  /** Grade the current card, write the review log, and advance. */
  const grade = useCallback(
    async (rating: ReviewRating) => {
      if (!card || !revealed || busy || !isDesktop()) return;
      // Guard against double-grading the same card: once a card has been recorded
      // in the exclude set it has a durable `review_logs` row + an advanced FSRS
      // state, so a second grade (e.g. after a transient advance failure left it on
      // screen) must not write a second log / advance FSRS twice.
      if (excludeRef.current.includes(card.id)) return;
      setBusy(true);
      // Reveal→grade response time; fall back to 0 if the reveal timestamp is lost.
      const responseMs = revealAtRef.current ? Math.max(0, Date.now() - revealAtRef.current) : 0;
      try {
        await appApi.reviewGrade({
          cardId: card.id,
          rating,
          responseMs,
          ...(asOf ? { asOf } : {}),
        });
      } catch (e) {
        // The grade itself failed — nothing was recorded; leave the card in place
        // so the user can retry the same grade.
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
        return;
      }
      // The grade is durable. Record it locally, then advance. If the advance fails
      // (a transient IPC error), the just-graded card must NOT stay on screen — that
      // would let the user grade it a second time — so clear it (the next
      // `loadNext`/restart re-reads the deck minus this excluded card). The
      // `excludeRef` guard above is the hard backstop against a double review_logs
      // row; clearing the card is the UX so the stale card is never re-presented.
      excludeRef.current = [...excludeRef.current, card.id];
      setReviewed((r) => r + 1);
      setGraded((g) => [...g, rating]);
      const advanced = await loadNext();
      if (!advanced) {
        setCard(null);
        setRevealed(false);
        setPreviews(null);
        revealAtRef.current = null;
      }
      setBusy(false);
    },
    [card, revealed, busy, asOf, loadNext],
  );

  /**
   * Advance past the current card WITHOUT recording a grade (suspend/delete remove
   * it from the live deck — they are repairs, not reviews). The card is added to the
   * `exclude` set so `session.next` returns the next due card, and `reviewed`/the
   * per-grade tally are left untouched.
   */
  const advancePastCurrent = useCallback(async () => {
    if (!card) return;
    excludeRef.current = [...excludeRef.current, card.id];
    // Removed-without-a-grade: shrink the progress denominator so the bar still
    // reaches 100% at completion (suspend/delete don't count as reviews).
    setRemoved((n) => n + 1);
    await loadNext();
  }, [card, loadNext]);

  /** Jump back to the originating source paragraph (lineage: card → location → source). */
  const openSource = useCallback(() => {
    if (!card?.sourceLocationLabel) return;
    // The full jump payload (block ids/offsets) lives on the inspector location;
    // fetch it then navigate. Open-source repair is fleshed out in T038.
    void (async () => {
      try {
        const res = await appApi.getInspectorData({ id: card.id });
        if (res.data?.location) navigateToLocation(res.data.location);
      } catch {
        // Non-fatal: the source jump is a convenience.
      }
    })();
  }, [card, navigateToLocation]);

  /** Restart the session from the top (re-reads the due deck). */
  const restart = useCallback(() => {
    excludeRef.current = [];
    recentSiblingGroupRef.current = null;
    setReviewed(0);
    setGraded([]);
    setRemoved(0);
    setDone(false);
    setEndMs(null);
    setTotal(0);
    void loadNext();
  }, [loadNext]);

  // While a card is in front of the user the review surface OWNS the keyboard
  // (Space + 1–4, plus `e`/`o`/`s` repairs); the global shell handler defers its
  // overlapping element-action keys (`o`/`+`/`-`/`u`) so it never double-fires
  // during a session (see `activeScope`).
  useActiveScope("review", desktop && !done);

  // Keyboard: Space reveals; 1–4 grade. Ignored while focus is in an input/textarea
  // (exactly as the prototype's `onKey`).
  useEffect(() => {
    if (!desktop || done) return;
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (!revealed) void reveal();
        return;
      }
      // `o` → open the originating source (lineage jump) — the SAME `openSource`
      // the repair bar's "Open source" button calls (T022/T048). Available before
      // or after reveal so the user can ground a card without leaving review.
      if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        openSource();
        return;
      }
      if (revealed) {
        const found = GRADES.find((g) => g.key === e.key);
        if (found) {
          e.preventDefault();
          void grade(found.rating);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desktop, done, revealed, reveal, grade, openSource]);

  if (!desktop) {
    return (
      <div className="rv-shell" data-testid="route-review">
        <div className="rv-blank">
          <div className="rv-empty">
            <div className="rv-empty__icon">
              <Icon name="brain" size={26} />
            </div>
            <h1 className="rv-empty__title">Review</h1>
            <p className="rv-empty__body">
              The active-recall session reads your due cards through the desktop bridge — open the
              Electron app to review.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const reviewedCount = reviewed;
  const leftCount = done ? 0 : remaining + (card ? 1 : 0);
  // Cards removed without a grade (suspend/delete) shrink the denominator so the
  // bar still fills to 100% at completion — they're repairs, not reviews.
  const progressTotal = Math.max(reviewedCount, (total || reviewedCount + leftCount) - removed);
  const progressPct = progressTotal === 0 ? 0 : (reviewedCount / progressTotal) * 100;

  return (
    <div className="rv-shell" data-testid="route-review">
      <div className="rv-top">
        <div className="rv-progress">
          <div className="rv-progress__nums">
            <span className="rv-progress__count" data-testid="review-progress">
              {reviewedCount} reviewed · {Math.max(0, leftCount)} left
            </span>
            <SessionClock startMs={startMs} />
          </div>
          <div className="pbar">
            <div className="pbar__fill" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
        <button
          type="button"
          className="rv-end"
          data-testid="review-end"
          onClick={() => navigate({ to: "/queue", search: asOf ? { asOf } : {} })}
        >
          <Icon name="x" size={14} />
          End session
        </button>
      </div>

      {error ? (
        <p className="pq-error" data-testid="review-error" style={{ padding: "8px 24px" }}>
          {error}
        </p>
      ) : null}

      <div className="rv-page">
        {done ? (
          <div className="rv-summary" data-testid="review-summary">
            <div className="rv-empty">
              <div className="rv-empty__icon">
                <Icon name="checkCircle" size={26} />
              </div>
              <h2 className="rv-empty__title">Session complete</h2>
              <p className="rv-empty__body">
                {reviewedCount} card{reviewedCount === 1 ? "" : "s"} reviewed in{" "}
                {clockLabel((endMs ?? Date.now()) - startMs)}. Your due cards are rescheduled — they
                return when FSRS says you're about to forget.
              </p>
              <div className="rv-empty__actions">
                <button
                  type="button"
                  className="rv-btn"
                  data-testid="review-restart"
                  onClick={restart}
                >
                  <Icon name="review" size={14} />
                  Review again
                </button>
                <button
                  type="button"
                  className="rv-btn rv-btn--primary"
                  data-testid="review-back"
                  onClick={() => navigate({ to: "/queue", search: asOf ? { asOf } : {} })}
                >
                  <Icon name="return" size={14} />
                  Back to queue
                </button>
              </div>
            </div>
            <div className="rv-summary__metrics" data-testid="review-tally">
              {GRADES.map((g) => (
                <div className="metric" key={g.rating} data-testid={`review-tally-${g.rating}`}>
                  <span className="metric__val">{graded.filter((x) => x === g.rating).length}</span>
                  <span className="metric__label">{g.label}</span>
                </div>
              ))}
            </div>
          </div>
        ) : card ? (
          <div
            className="rv-stage rv-fade"
            key={card.id}
            data-testid="review-card"
            data-card-id={card.id}
          >
            {/* metadata row */}
            <div className="rv-meta">
              <div className="rv-meta__chips">
                <span className="badge badge--soft" data-testid="review-kind">
                  {card.kind === "cloze" ? "Cloze" : "Q&A"}
                </span>
                {card.concept ? <span className="concept-tag">{card.concept}</span> : null}
                <Prio priority={card.priority} />
                <Stage stage={card.stage} />
                {card.leech ? (
                  <span className="badge badge--leech">Leech · {card.lapses} lapses</span>
                ) : null}
              </div>
              <SchedulerChip scheduler={chipSignals(card)} />
            </div>

            {card.leech ? (
              <div className="banner" data-testid="review-leech-banner">
                <Icon name="leech" size={16} />
                <div>
                  <div className="banner__title">This card keeps lapsing</div>
                  <div className="banner__body">
                    Consider rewriting it, adding context, or splitting the fact.
                  </div>
                </div>
                <div className="banner__actions">
                  <button
                    type="button"
                    className="banner__action"
                    data-testid="review-leech-add-context"
                    onClick={() => setContextDrawerOpen(true)}
                  >
                    <Icon name="context" size={14} />
                    Add context
                  </button>
                </div>
              </div>
            ) : null}

            {/* the card */}
            <div className="rcard">
              <div className="rcard__face">
                <div className="rcard__prompt" data-testid="review-prompt">
                  <CardFront card={card} revealed={false} />
                </div>
                {revealed ? (
                  <div className="rcard__reveal-wrap rv-fade" data-testid="review-answer">
                    <div className="rcard__answer">
                      {card.kind === "cloze" ? (
                        <CardFront card={card} revealed={true} />
                      ) : (
                        (card.answer ?? "")
                      )}
                    </div>
                    {/* Source reference (T043) — the enriched refblock, shown ONLY
                        after reveal so it can't leak the answer. Reuses the shared
                        RefBlock + formatSourceRef; the jump-to-source button is wired
                        when the card carries a location (T022). */}
                    {card.sourceRef ? (
                      <RefBlock
                        ref={card.sourceRef}
                        testId="review-refblock"
                        style={{ marginTop: 16 }}
                        {...(card.sourceLocationLabel ? { onOpenSource: openSource } : {})}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
              <hr className="card-sep" />
              <div className="rcard__pad">
                {!revealed ? (
                  <button
                    type="button"
                    className="rv-reveal"
                    data-testid="review-reveal"
                    onClick={() => void reveal()}
                  >
                    <Icon name="eye" size={16} />
                    Reveal answer <Kbd keys="␣" />
                  </button>
                ) : (
                  <>
                    <div className="grades" data-testid="review-grades">
                      {GRADES.map((g) => (
                        <button
                          type="button"
                          key={g.rating}
                          className={`grade grade--${g.rating}`}
                          data-testid={`review-grade-${g.rating}`}
                          disabled={busy}
                          onClick={() => void grade(g.rating)}
                        >
                          <span className="grade__label">{g.label}</span>
                          <span className="grade__int" data-testid={`review-interval-${g.rating}`}>
                            {previews ? previews[g.rating].label : "…"}
                          </span>
                          <Kbd keys={g.key} />
                        </button>
                      ))}
                    </div>
                    <div style={{ marginTop: 14 }}>
                      <FsrsStats scheduler={chipSignals(card)} />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* repair actions (T038) — edit / open source / add context / suspend /
                flag / delete; open-source jumps back via lineage (T022). */}
            <ReviewRepairBar
              card={card}
              busy={busy}
              onOpenSource={openSource}
              onCardUpdated={(updated) =>
                setCard((c) => (c && c.id === updated.id ? { ...c, ...updated } : c))
              }
              onCardRemoved={advancePastCurrent}
              drawerOpen={contextDrawerOpen}
              onDrawerOpenChange={setContextDrawerOpen}
            />
          </div>
        ) : (
          <div className="rv-summary" data-testid="review-empty">
            <div className="rv-empty">
              <div className="rv-empty__icon">
                <Icon name="checkCircle" size={26} />
              </div>
              <h2 className="rv-empty__title">No cards due</h2>
              <p className="rv-empty__body">
                Nothing is due for review right now. New cards arrive as you distill extracts into
                atomic statements.
              </p>
              <div className="rv-empty__actions">
                <button
                  type="button"
                  className="rv-btn rv-btn--primary"
                  data-testid="review-empty-back"
                  onClick={() => navigate({ to: "/queue", search: asOf ? { asOf } : {} })}
                >
                  <Icon name="return" size={14} />
                  Back to queue
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

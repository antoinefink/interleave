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

import { DEFAULT_RANDOM_AUDIT_SIZE, isReviewModeKind, reviewModeLabel } from "@interleave/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConflictSection } from "../components/ConflictSection";
import { Icon } from "../components/Icon";
import { FsrsStats, Prio, SchedulerChip, Stage } from "../components/inspector/primitives";
import { RefBlock } from "../components/RefBlock";
import { HelpLink, InlineHint } from "../help/Contextual";
import "../components/inspector/inspector.css";
import {
  appApi,
  isDesktop,
  type ReviewCardView,
  type ReviewIntervalPreview,
  type ReviewModeSelector,
  type ReviewRating,
  type SchedulerSignals,
} from "../lib/appApi";
import { useNavigateToLocation } from "../reader/navigateToLocation";
import { useActiveScope } from "../shell/activeScope";
import { Kbd } from "../shell/Kbd";
import { useSelection } from "../shell/selection";
import { CardAudioFace } from "./CardAudioFace";
import { CardBody } from "./CardBody";
import { CardFront } from "./CardFront";
import { CardOcclusionFace } from "./CardOcclusionFace";
import { ExpiryBanner } from "./ExpiryBanner";
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

/**
 * Loose review-search params: the optional `asOf` (existing) + the T096 review-mode
 * descriptor. The route declares NO `validateSearch` (loose search is the codebase
 * convention — see `reader/navigateToLocation.ts`), so we read the params loosely and
 * validate the `mode` kind with the `@interleave/core` `isReviewModeKind` guard before
 * constructing a typed `ReviewModeSelector`. An unknown / malformed mode → `null`
 * (the plain daily due session), never an error.
 */
interface ReviewSearch {
  readonly asOf?: string;
  /** The review-mode kind (T096): `concept`/`source`/`branch`/`search`/`semantic`/`stale`/`leech`/`random`. */
  readonly mode?: string;
  readonly conceptId?: string;
  readonly sourceId?: string;
  readonly rootId?: string;
  readonly query?: string;
  readonly size?: string;
  readonly seed?: string;
}

/** Parse the loose search params into a typed {@link ReviewModeSelector}, or `null` (daily). */
function parseReviewMode(search: ReviewSearch): ReviewModeSelector | null {
  const kind = search.mode;
  if (!isReviewModeKind(kind)) return null;
  switch (kind) {
    case "concept":
      return search.conceptId ? { kind, conceptId: search.conceptId } : null;
    case "source":
      return search.sourceId ? { kind, sourceId: search.sourceId } : null;
    case "branch":
      return search.rootId ? { kind, rootId: search.rootId } : null;
    case "search":
    case "semantic":
      return search.query ? { kind, query: search.query } : null;
    case "stale":
      return { kind };
    case "leech":
      return { kind };
    case "random": {
      const size = Number.parseInt(search.size ?? "", 10);
      const seed = Number.parseInt(search.seed ?? "", 10);
      return {
        kind,
        size: Number.isFinite(size) && size > 0 ? size : DEFAULT_RANDOM_AUDIT_SIZE,
        ...(Number.isFinite(seed) ? { seed } : {}),
      };
    }
    default:
      return null;
  }
}

export function ReviewScreen() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const { select } = useSelection();
  const navigateToLocation = useNavigateToLocation();

  // The route declares no `validateSearch`; an optional `asOf` date-scopes the due
  // read (the E2E drives a fixed clock so the seeded near-future card reads as due).
  // The T096 review-mode descriptor (`mode` + its parameter) also rides loose search.
  const search = useSearch({ strict: false }) as ReviewSearch;
  const asOf = typeof search.asOf === "string" ? search.asOf : undefined;
  // A targeted review mode (T096), or `null` for the plain daily due session. Memoized
  // so the deck-walk effects don't re-run on every render (the selector is stable).
  const mode = useMemo(() => parseReviewMode(search), [search]);
  const modeLabel = mode ? reviewModeLabel(mode.kind) : null;

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
  const [repairBusy, setRepairBusy] = useState(false);
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
  // T096 mode state: the deck was fetched + capped (`truncated`), and the underlying
  // subset size (`modeTotal`) so the header can say "first 500 of N".
  const [truncated, setTruncated] = useState(false);
  const [modeTotal, setModeTotal] = useState(0);

  // The set of card ids already reviewed this session — passed to `session.next`
  // so the deck advances.
  const excludeRef = useRef<string[]>([]);
  // T096: the FROZEN ordered mode deck (fetched ONCE on mount, walked by index). In
  // mode, `loadNext` draws the next unseen card from this in-memory deck (with
  // sibling burying) instead of calling the due-session read — the selection is
  // already done MAIN-side. `null` until the deck is fetched (or in the daily session).
  const modeDeckRef = useRef<ReviewCardView[] | null>(null);
  // The sibling group of the card shown most recently (opaque session state passed
  // to `session.next` so the MAIN side buries siblings — T039). The renderer never
  // computes sibling relationships; it only carries the previous card's group id
  // forward. The MVP window is the immediately-preceding card.
  const recentSiblingGroupRef = useRef<string | null>(null);
  // When the current card was revealed, for the reveal→grade response time.
  const revealAtRef = useRef<number | null>(null);
  const loadSessionSeqRef = useRef(0);
  const loadNextSeqRef = useRef(0);
  const previewSeqRef = useRef(0);
  const sourceLookupSeqRef = useRef(0);
  const repairBusyRef = useRef(false);
  repairBusyRef.current = repairBusy;
  const mountedRef = useRef(false);
  const currentCardIdRef = useRef<string | null>(null);
  currentCardIdRef.current = card?.id ?? null;

  const invalidateCardSideEffects = useCallback(() => {
    previewSeqRef.current += 1;
    sourceLookupSeqRef.current += 1;
  }, []);

  const setRepairBusyNow = useCallback((next: boolean) => {
    repairBusyRef.current = next;
    if (next) sourceLookupSeqRef.current += 1;
    setRepairBusy(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadSessionSeqRef.current += 1;
      loadNextSeqRef.current += 1;
      previewSeqRef.current += 1;
      sourceLookupSeqRef.current += 1;
    };
  }, []);

  /**
   * Pick the next card from the FROZEN mode deck (T096): the first card not in the
   * already-seen `exclude` set, burying the recent sibling group (session-ordering
   * only — same window as the daily session). Returns the chosen card or `null` when
   * the deck is drained. Mirrors `ReviewSessionService.nextReviewCard`'s burying but
   * over the in-memory ordered deck (the selection was already done main-side).
   */
  const nextFromModeDeck = useCallback((): ReviewCardView | null => {
    const deck = modeDeckRef.current;
    if (!deck) return null;
    const seen = new Set(excludeRef.current);
    const remainingDeck = deck.filter((c) => !seen.has(c.id));
    if (remainingDeck.length === 0) return null;
    const recent = recentSiblingGroupRef.current;
    if (recent) {
      // Prefer the first card whose group was NOT just shown (else fall through so
      // the deck still drains — burying never starves the session).
      const nonSibling = remainingDeck.find((c) => c.siblingGroupId !== recent);
      if (nonSibling) return nonSibling;
    }
    return remainingDeck[0] ?? null;
  }, []);

  /**
   * Load the next card (excluding the already-seen set; burying recent siblings).
   * In the daily session this reads `reviewSessionNext` (the FSRS due deck); in a
   * TARGETED mode (T096) it walks the FROZEN mode deck fetched once on mount. Returns
   * `true` on success and `false` if the read failed, so the grade path can clear the
   * just-graded card on a post-grade advance failure (otherwise it would stay on
   * screen and be re-gradable).
   */
  const loadNext = useCallback(async (): Promise<boolean> => {
    if (!isDesktop()) return false;
    const sessionSeq = loadSessionSeqRef.current;
    const requestSeq = ++loadNextSeqRef.current;
    const isCurrentLoad = () =>
      mountedRef.current &&
      loadSessionSeqRef.current === sessionSeq &&
      loadNextSeqRef.current === requestSeq;
    if (!isCurrentLoad()) return true;
    try {
      // ---- Targeted mode (T096): walk the in-memory ordered deck ----
      if (mode) {
        const next = nextFromModeDeck();
        if (!isCurrentLoad()) return true;
        setError(null);
        setRevealed(false);
        setPreviews(null);
        setContextDrawerOpen(false);
        setRepairBusyNow(false);
        revealAtRef.current = null;
        const deckSize = modeDeckRef.current?.length ?? 0;
        if (!next) {
          setCard(null);
          setRemaining(0);
          // A drained mode deck after at least one grade → the completion summary.
          if (excludeRef.current.length > 0) {
            setDone(true);
            setEndMs(Date.now());
          }
          return true;
        }
        setCard(next);
        setRemaining(Math.max(0, deckSize - excludeRef.current.length - 1));
        recentSiblingGroupRef.current = next.siblingGroupId;
        select(next.id);
        return true;
      }

      // ---- Daily due session (T037) ----
      const recent = recentSiblingGroupRef.current;
      const res = await appApi.reviewSessionNext({
        exclude: excludeRef.current,
        ...(recent ? { recentSiblingGroups: [recent] } : {}),
        ...(asOf ? { asOf } : {}),
      });
      if (!isCurrentLoad()) return true;
      setError(null);
      setRevealed(false);
      setPreviews(null);
      setContextDrawerOpen(false);
      setRepairBusyNow(false);
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
      if (!isCurrentLoad()) return true;
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [asOf, mode, nextFromModeDeck, select, setRepairBusyNow]);

  // Load the first card on mount. In a TARGETED mode (T096) fetch the FROZEN deck
  // ONCE first (the selection is done main-side), then walk it; in the daily session
  // `loadNext` reads the due deck directly.
  useEffect(() => {
    let cancelled = false;
    loadSessionSeqRef.current += 1;
    loadNextSeqRef.current += 1;
    void (async () => {
      if (mode && isDesktop()) {
        try {
          const res = await appApi.reviewModeDeck({
            selector: mode,
            ...(asOf ? { asOf } : {}),
          });
          if (cancelled) return;
          modeDeckRef.current = [...res.deck];
          setTotal(res.deck.length);
          setModeTotal(res.total);
          setTruncated(res.truncated);
        } catch (e) {
          if (cancelled) return;
          modeDeckRef.current = [];
          setError(e instanceof Error ? e.message : String(e));
        }
      }
      if (!cancelled) await loadNext();
    })();
    return () => {
      cancelled = true;
      loadSessionSeqRef.current += 1;
      loadNextSeqRef.current += 1;
    };
  }, [mode, asOf, loadNext]);

  /** Reveal the answer + fetch the four interval previews (lazily, on reveal). */
  const reveal = useCallback(async () => {
    if (!card || revealed) return;
    const requestedCardId = card.id;
    const requestSeq = ++previewSeqRef.current;
    setRevealed(true);
    setPreviews(null);
    revealAtRef.current = Date.now();
    try {
      const res = await appApi.reviewPreview({
        cardId: requestedCardId,
        ...(asOf ? { asOf } : {}),
      });
      if (
        !mountedRef.current ||
        currentCardIdRef.current !== requestedCardId ||
        previewSeqRef.current !== requestSeq
      ) {
        return;
      }
      setPreviews(res.intervals);
    } catch {
      if (
        !mountedRef.current ||
        currentCardIdRef.current !== requestedCardId ||
        previewSeqRef.current !== requestSeq
      ) {
        return;
      }
      // Previews are a nicety; grading still works without them.
      setPreviews(null);
    }
  }, [card, revealed, asOf]);

  /** Grade the current card, write the review log, and advance. */
  const grade = useCallback(
    async (rating: ReviewRating) => {
      if (!card || !revealed || busy || repairBusyRef.current || !isDesktop()) return;
      // Guard against double-grading the same card: once a card has been recorded
      // in the exclude set it has a durable `review_logs` row + an advanced FSRS
      // state, so a second grade (e.g. after a transient advance failure left it on
      // screen) must not write a second log / advance FSRS twice.
      if (excludeRef.current.includes(card.id)) return;
      setBusy(true);
      invalidateCardSideEffects();
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
        setRepairBusyNow(false);
        revealAtRef.current = null;
      }
      setBusy(false);
    },
    [card, revealed, busy, asOf, loadNext, invalidateCardSideEffects, setRepairBusyNow],
  );

  /**
   * Advance past the current card WITHOUT recording a grade (suspend/delete remove
   * it from the live deck — they are repairs, not reviews). The card is added to the
   * `exclude` set so `session.next` returns the next due card, and `reviewed`/the
   * per-grade tally are left untouched.
   */
  const advancePastCurrent = useCallback(
    async (removedCardId: string) => {
      if (currentCardIdRef.current !== removedCardId) return;
      invalidateCardSideEffects();
      excludeRef.current = [...excludeRef.current, removedCardId];
      // Removed-without-a-grade: shrink the progress denominator so the bar still
      // reaches 100% at completion (suspend/delete don't count as reviews).
      setRemoved((n) => n + 1);
      const advanced = await loadNext();
      if (!advanced) {
        setCard(null);
        setRevealed(false);
        setPreviews(null);
        setRepairBusyNow(false);
        revealAtRef.current = null;
      }
    },
    [loadNext, invalidateCardSideEffects, setRepairBusyNow],
  );

  /** Jump back to the originating source paragraph (lineage: card → location → source). */
  const openSource = useCallback(() => {
    if (busy || repairBusyRef.current) return;
    if (!card?.sourceLocationLabel) return;
    const requestedCardId = card.id;
    const requestSeq = ++sourceLookupSeqRef.current;
    // The full jump payload (block ids/offsets) lives on the inspector location;
    // fetch it then navigate. Open-source repair is fleshed out in T038.
    void (async () => {
      try {
        const res = await appApi.getInspectorData({ id: requestedCardId });
        if (
          !mountedRef.current ||
          currentCardIdRef.current !== requestedCardId ||
          sourceLookupSeqRef.current !== requestSeq
        ) {
          return;
        }
        if (res.data?.location) navigateToLocation(res.data.location);
      } catch {
        // Non-fatal: the source jump is a convenience.
      }
    })();
  }, [busy, card, navigateToLocation]);

  /**
   * Create a "verify this claim" verification task (T092) for the current card,
   * straight from the post-reveal expiry banner — a scheduled `task`-type element
   * linked to the card (`tasks.create`, one transaction + `create_element` +
   * `add_relation`). The fact stays in review; this just queues the maintenance work.
   */
  const createVerifyTask = useCallback(async () => {
    if (!card) return;
    await appApi.createTask({
      taskType: "verify_claim",
      title: card.sourceTitle ? `Verify claim from ${card.sourceTitle}` : "Verify this claim",
      linkedElementId: card.id,
    });
  }, [card]);

  /**
   * Restart the session from the top. In the daily session this re-reads the due
   * deck; in a TARGETED mode (T096) it re-walks the SAME frozen deck already in
   * `modeDeckRef` (no re-fetch — the subset is stable, so a re-run reviews the same
   * cards), keeping `total` at the deck size.
   */
  const restart = useCallback(() => {
    excludeRef.current = [];
    recentSiblingGroupRef.current = null;
    setReviewed(0);
    setGraded([]);
    setRemoved(0);
    setDone(false);
    setEndMs(null);
    if (!mode) setTotal(0);
    void loadNext();
  }, [loadNext, mode]);

  // While a card is in front of the user the review surface OWNS the keyboard
  // (Space + 1–4, plus `e`/`o`/`s` repairs); the global shell handler defers its
  // overlapping element-action keys (`o`/`+`/`-`/`u`) so it never double-fires
  // during a session (see `activeScope`).
  useActiveScope("review", desktop && !done);

  useEffect(() => {
    if (!revealed && contextDrawerOpen) {
      setContextDrawerOpen(false);
    }
  }, [revealed, contextDrawerOpen]);

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
      // `o` -> open the originating source (lineage jump) after reveal. Source
      // context can contain the answer/evidence, so it shares the reveal gate.
      if (revealed && !busy && !repairBusyRef.current && (e.key === "o" || e.key === "O")) {
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
  }, [desktop, done, revealed, busy, reveal, grade, openSource]);

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
  const gradeBusy = busy || repairBusy;

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
          disabled={gradeBusy}
          onClick={() => {
            if (!gradeBusy) navigate({ to: "/queue", search: asOf ? { asOf } : {} });
          }}
        >
          <Icon name="x" size={14} />
          End session
        </button>
      </div>

      {/* Mode header (T096) — a calm chip row above the card describing the chosen
          subset + an explicit "outside scheduling" hint + an exit-to-daily affordance.
          Shown ONLY in a targeted mode (the daily session is unchanged). */}
      {mode && modeLabel ? (
        <div className="rv-mode" data-testid="review-mode-header">
          <span className="rv-mode__chip" data-testid="review-mode-label">
            <Icon name="target" size={13} />
            {modeLabel}
          </span>
          <span className="rv-mode__count" data-testid="review-mode-count">
            Reviewing {truncated ? `the first ${total}` : total} card{total === 1 ? "" : "s"}
            {truncated ? ` of ${modeTotal}` : ""}
          </span>
          <span className="rv-mode__hint">· not limited to what's due</span>
          <button
            type="button"
            className="rv-mode__exit"
            data-testid="review-mode-exit"
            disabled={gradeBusy}
            onClick={() => {
              if (!gradeBusy) navigate({ to: "/review", search: asOf ? { asOf } : {} });
            }}
          >
            <Icon name="x" size={12} />
            Exit mode
          </button>
        </div>
      ) : null}

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
              <p className="rv-empty__body" data-testid="review-summary-body">
                {reviewedCount} card{reviewedCount === 1 ? "" : "s"} reviewed in{" "}
                {clockLabel((endMs ?? Date.now()) - startMs)}.{" "}
                {mode && modeLabel
                  ? `Reviewed ${reviewedCount} of the ${modeLabel} subset — these cards are rescheduled through FSRS just like any review.`
                  : "Your due cards are rescheduled — they return when FSRS says you're about to forget."}
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
                {mode ? (
                  <button
                    type="button"
                    className="rv-btn"
                    data-testid="review-back-daily"
                    onClick={() => navigate({ to: "/review", search: asOf ? { asOf } : {} })}
                  >
                    <Icon name="brain" size={14} />
                    Back to daily review
                  </button>
                ) : null}
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
            data-coach="review-card"
            data-card-id={card.id}
          >
            {/* metadata row */}
            <div className="rv-meta">
              <div className="rv-meta__chips">
                <span className="badge badge--soft" data-testid="review-kind">
                  {card.kind === "cloze"
                    ? "Cloze"
                    : card.kind === "image_occlusion"
                      ? "Occlusion"
                      : "Q&A"}
                </span>
                {/* Audio badge (T075) — a presentation modifier, shown alongside the
                    kind (an audio card is still a Q&A/cloze card, never a new kind). */}
                {card.mediaRef ? (
                  <span className="badge badge--soft" data-testid="review-audio-badge">
                    <Icon name="play" size={11} /> Audio
                  </span>
                ) : null}
                {card.concept ? <span className="concept-tag">{card.concept}</span> : null}
                <Prio priority={card.priority} />
                <Stage stage={card.stage} />
                {card.leech ? (
                  <span className="badge badge--leech">Leech · {card.lapses} lapses</span>
                ) : null}
              </div>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <SchedulerChip scheduler={chipSignals(card)} />
                <HelpLink slug="two-schedulers" />
              </span>
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
                  <HelpLink slug="leeches" variant="inline">
                    What’s a leech?
                  </HelpLink>
                  <button
                    type="button"
                    className="banner__action"
                    data-testid="review-leech-add-context"
                    disabled={!revealed || gradeBusy}
                    onClick={() => {
                      if (revealed && !gradeBusy) setContextDrawerOpen(true);
                    }}
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
                {/* An image-occlusion card (T071) renders the base image with its
                    one masked region hidden on the front, revealed on reveal —
                    instead of the string prompt/answer. Q&A/cloze unchanged. */}
                {card.kind === "image_occlusion" && card.occlusion ? (
                  <>
                    <div className="rcard__prompt" data-testid="review-prompt">
                      <CardOcclusionFace occlusion={card.occlusion} revealed={revealed} />
                    </div>
                    {revealed ? (
                      <div className="rcard__reveal-wrap rv-fade" data-testid="review-answer">
                        {card.sourceRef ? (
                          <RefBlock
                            ref={card.sourceRef}
                            testId="review-refblock"
                            style={{ marginTop: 16 }}
                            {...(card.sourceLocationLabel ? { onOpenSource: openSource } : {})}
                          />
                        ) : null}
                        {/* Expiry banner (T090) — a calm "may be out of date" line, shown
                            ONLY post-reveal (it rides the reveal gate so it can't leak the
                            answer). Absent for a fresh / lifetime-less card (`expiry: null`). */}
                        {card.expiry ? (
                          <ExpiryBanner expiry={card.expiry} onCreateTask={createVerifyTask} />
                        ) : null}
                        {/* Possible-conflict flags (T089) — shown ONLY post-reveal so
                            they can't leak the answer; suggestive, never authoritative. */}
                        <ConflictSection
                          elementId={card.id}
                          variant="inline"
                          onOpen={(id) => select(id)}
                        />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div className="rcard__prompt" data-testid="review-prompt">
                      {/* Audio prompt (T075): a looping clip plays on the front when
                          `media_ref.on ∈ {prompt, both}`. It never leaks the answer —
                          an audio-ANSWER card plays nothing here. Rendered ABOVE the
                          (possibly empty) written prompt; an audio card can be audio +
                          text or audio-only. */}
                      {card.mediaRef &&
                      (card.mediaRef.on === "prompt" || card.mediaRef.on === "both") ? (
                        <CardAudioFace
                          mediaRef={card.mediaRef}
                          mediaSource={card.mediaSource}
                          youtubeId={card.youtubeId}
                          face="prompt"
                        />
                      ) : null}
                      <CardFront card={card} revealed={false} />
                    </div>
                    {revealed ? (
                      <div className="rcard__reveal-wrap rv-fade" data-testid="review-answer">
                        {/* Audio answer (T075): the clip plays only AFTER reveal when
                            `media_ref.on ∈ {answer, both}` — the strict reveal-gating
                            that keeps an audio answer from leaking, mirroring the text
                            answer/refblock. */}
                        {card.mediaRef &&
                        (card.mediaRef.on === "answer" || card.mediaRef.on === "both") ? (
                          <CardAudioFace
                            mediaRef={card.mediaRef}
                            mediaSource={card.mediaSource}
                            youtubeId={card.youtubeId}
                            face="answer"
                          />
                        ) : null}
                        <div className="rcard__answer">
                          {card.kind === "cloze" ? (
                            <CardFront card={card} revealed={true} />
                          ) : (
                            // T072: the Q&A answer is a SEPARATE call site from the
                            // prompt (`CardFront`). Render it through the shared
                            // `CardBody` so math + highlighted code show on the back
                            // too — never as a raw LaTeX/source string.
                            <CardBody body={card.answer ?? ""} />
                          )}
                        </div>
                        {/* Source reference (T043) — the enriched refblock, shown ONLY
                            after reveal so it can't leak the answer. Reuses the shared
                            RefBlock + formatSourceRef; the jump-to-source button is wired
                            when the card carries a location (T022). */}
                        {card.sourceRef ? (
                          <RefBlock
                            ref={card.sourceRef}
                            dedupeSnippetAgainst={card.kind === "qa" ? card.answer : null}
                            testId="review-refblock"
                            style={{ marginTop: 16 }}
                            {...(card.sourceLocationLabel ? { onOpenSource: openSource } : {})}
                          />
                        ) : null}
                        {/* Expiry banner (T090) — a calm "may be out of date" line, shown
                            ONLY post-reveal (it rides the reveal gate so it can't leak the
                            answer). Absent for a fresh / lifetime-less card (`expiry: null`). */}
                        {card.expiry ? (
                          <ExpiryBanner expiry={card.expiry} onCreateTask={createVerifyTask} />
                        ) : null}
                        {/* Possible-conflict flags (T089) — shown ONLY post-reveal so
                            they can't leak the answer; suggestive, never authoritative. */}
                        <ConflictSection
                          elementId={card.id}
                          variant="inline"
                          onOpen={(id) => select(id)}
                        />
                      </div>
                    ) : null}
                  </>
                )}
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
                          disabled={gradeBusy}
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
                    <div style={{ marginTop: 10 }}>
                      <InlineHint slug="grading-honestly" slugLabel="How to grade">
                        Grade honestly — the text under each button is when the card returns.{" "}
                        <b>Again</b> isn’t failure; it just brings the card back sooner.
                      </InlineHint>
                    </div>
                    <div style={{ marginTop: 14 }}>
                      <FsrsStats scheduler={chipSignals(card)} />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* repair actions (T038) — edit / open source / add context / suspend /
                flag / delete. They are post-reveal because edit/source context can
                expose answer evidence before the user has recalled it. */}
            {revealed ? (
              <ReviewRepairBar
                card={card}
                busy={busy}
                onBusyChange={setRepairBusyNow}
                onOpenSource={openSource}
                onCardUpdated={(updated) =>
                  setCard((c) => (c && c.id === updated.id ? { ...c, ...updated } : c))
                }
                onCardRemoved={advancePastCurrent}
                drawerOpen={contextDrawerOpen}
                onDrawerOpenChange={setContextDrawerOpen}
              />
            ) : null}
          </div>
        ) : (
          <div className="rv-summary" data-testid="review-empty">
            <div className="rv-empty">
              <div className="rv-empty__icon">
                <Icon name="checkCircle" size={26} />
              </div>
              <h2 className="rv-empty__title">
                {mode && modeLabel ? "No cards in this subset" : "No cards due"}
              </h2>
              <p className="rv-empty__body">
                {mode && modeLabel
                  ? `The ${modeLabel} subset has no cards to review right now.`
                  : "Nothing is due for review right now. New cards arrive as you distill extracts into atomic statements."}
              </p>
              {!mode && (
                <div style={{ marginBottom: 14 }}>
                  <HelpLink slug="no-cards-due" variant="inline">
                    Why some cards aren’t due
                  </HelpLink>
                </div>
              )}
              <div className="rv-empty__actions">
                {mode ? (
                  <button
                    type="button"
                    className="rv-btn"
                    data-testid="review-empty-back-daily"
                    onClick={() => navigate({ to: "/review", search: asOf ? { asOf } : {} })}
                  >
                    <Icon name="brain" size={14} />
                    Back to daily review
                  </button>
                ) : null}
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

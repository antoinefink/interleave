/**
 * "Process queue" learning loop (T031) — the keyboard-first daily grind.
 *
 * Takes the T029 due queue (`queue.list`, honoring the active filters/clock) and
 * presents it ONE ELEMENT AT A TIME, rendering the right surface for each type —
 * a compact read/process panel for attention items (source / topic / extract /
 * task) and the FULL inline FSRS card surface for cards (reveal → grade
 * Again/Hard/Good/Easy with next-interval previews, exactly as the review session)
 * — with the T030 actions (open-in-full / postpone menu / raise / lower / done /
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
 * prompt-side and reveal→grade response timings. Cards stay on FSRS, attention items on the
 * attention scheduler — the chip + scheduling never cross (a card never sees the
 * attention `Postpone` menu). The card grade advances the FROZEN-order cursor (consistent with
 * the other loop actions), it does NOT re-read the review deck.
 *
 * Pure UI orchestration — no SQL, no scheduling math, no priority math.
 */

import { renderClozePrompt } from "@interleave/core";
import {
  type Editor,
  SourceEditor,
  type SourceEditorChange,
  setReaderDecorations,
  toBlockInputs,
  toPlainText,
} from "@interleave/editor";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { requestInspectorRefresh } from "../../components/inspector/Inspector";
import {
  Prio,
  SchedulerChip,
  Stage,
  stageLabel,
  TypeIcon,
} from "../../components/inspector/primitives";
import { LineageDeleteMenu } from "../../components/lineage/LineageDeleteMenu";
import {
  type LineageDeleteActions,
  useLineageDelete,
} from "../../components/lineage/useLineageDelete";
import { type DoneIntent, DoneIntentMenu } from "../../components/queue/DoneIntentMenu";
import { ProcessOverflowMenu } from "../../components/queue/ProcessOverflowMenu";
import { QueueSnackbar } from "../../components/queue/QueueSnackbar";
import { listenQueueRefresh } from "../../components/queue/queueRefresh";
import { ScheduleMenu } from "../../components/queue/ScheduleMenu";
import { RefBlock } from "../../components/RefBlock";
import { Snackbar } from "../../components/Snackbar";
import "../../components/inspector/inspector.css";
import {
  appApi,
  type CardKind,
  type DailyWorkSummaryResult,
  type DirectExtractFate,
  type ExtractFate,
  type ExtractionCreateResult,
  type ExtractStage,
  type InspectorData,
  isDesktop,
  type QueueActAction,
  type QueueActUndo,
  type QueueItemSummary,
  type QueueMinuteBudget,
  type QueueQuotaComposition,
  type QueueScheduleChoice,
  type QueueTimeEstimate,
  type ReviewCardView,
  type ReviewIntervalPreview,
  type ReviewRating,
  type SchedulerSignals,
  type SourceBlockProcessingSummaryPayload,
} from "../../lib/appApi";
import { formatDifficulty, formatStability } from "../../lib/formatFsrs";
import { CardBody } from "../../review/CardBody";
import { CardFront } from "../../review/CardFront";
import { type UseDocumentResult, useDocument } from "../source/useDocument";
import { useHighlights } from "../source/useHighlights";
import { type UseReadPointResult, useReadPoint } from "../source/useReadPoint";
import "../../review/review.css";
import {
  AtomicExtractPrompt,
  type AtomicExtractPromptState,
} from "../../reader/AtomicExtractPrompt";
import { CardBuilder } from "../../reader/CardBuilder";
import "../../reader/extract-view.css";
import { SessionGauge } from "../../components/queue/SessionGauge";
import {
  EXTRACT_SELECTION_ACTIONS,
  SelectionToolbar,
  type SelectionToolbarAction,
  type SelectionToolbarItem,
  type SelectionToolbarPosition,
} from "../../reader/SelectionToolbar";
import { useTextSelection } from "../../reader/useTextSelection";
import { useActiveScope } from "../../shell/activeScope";
import { Kbd } from "../../shell/Kbd";
import { useSelection } from "../../shell/selection";
import { useStatusHint } from "../../shell/statusHint";
import { resumeLabel } from "./doneIntentBreakdown";
import { jitterOrder } from "./jitter";
import { openQueueItem } from "./openQueueItem";
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

function processableQueueItems(items: readonly QueueItemSummary[]): QueueItemSummary[] {
  return items.filter((item) => item.taskType !== "weekly_review");
}

/** The four FSRS ratings in display + keyboard order (1–4), matching the review session. */
const GRADES: readonly { rating: ReviewRating; label: string; key: string }[] = [
  { rating: "again", label: "Again", key: "1" },
  { rating: "hard", label: "Hard", key: "2" },
  { rating: "good", label: "Good", key: "3" },
  { rating: "easy", label: "Easy", key: "4" },
];

/** The inline non-open actions a loop item exposes (the T030 set + skip). */
type LoopActionKind = QueueActAction["kind"];

type ProcessUndoState = {
  readonly id: string;
  readonly index: number;
  readonly undo:
    | { readonly kind: "queue"; readonly recipe: QueueActUndo }
    | { readonly kind: "last" };
};

/** The three extract distillation stages, in chain order (mirrors `ExtractView`). */
const EXTRACT_STAGES: readonly ExtractStage[] = [
  "raw_extract",
  "clean_extract",
  "atomic_statement",
];

const PROCESS_SOURCE_SELECTION_ACTIONS: readonly SelectionToolbarItem[] = [
  { action: "extract", label: "Extract", icon: "extract", keys: "E", accent: true },
  { action: "highlight", label: "Highlight", icon: "highlight", keys: "H" },
  { action: "copy", label: "Copy", icon: "copy", title: "Copy selection", dividerBefore: true },
  { action: "cancel", label: "", icon: "x", title: "Cancel (Esc)", ariaLabel: "Cancel" },
];

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
    scheduleReason: item.schedulerSignals.scheduleReason,
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
    scheduleReason: null,
    lastProcessedAt: null,
  };
}

export function ProcessQueue() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const { select } = useSelection();
  // The route declares no `validateSearch`, so search is loosely typed — an
  // optional `asOf` date-scopes the due reads (the E2E drives a fixed clock), an
  // optional `mode` seeds the session ordering bias (T076), and an optional `target`
  // sets the ambient gauge's reference line (a non-binding minute box, NOT a frozen
  // deck — there is no `assembled` handoff anymore; the loop always serves the live queue).
  const search = useSearch({ strict: false }) as {
    asOf?: string;
    mode?: string;
    target?: string | number;
  };
  const asOf = typeof search.asOf === "string" ? search.asOf : undefined;
  // A valid session target is a whole number of minutes >= 1 (stricter than the
  // preview's >= 0 check so a 0/blank target never fires the wrap-up prompt on mount).
  const targetMinutes = (() => {
    const raw = search.target;
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    return Number.isFinite(n) && Number.isInteger(n) && n >= 1 ? n : undefined;
  })();

  const [mode, setMode] = useState<SessionMode>(
    search.mode === "review" || search.mode === "read" ? search.mode : "full",
  );
  /** Index into the ordered (T076-scored, jittered) session deck. */
  const [cursor, setCursor] = useState(0);
  /** How many items the user has processed this session (acted/scheduled/graded). */
  const [processed, setProcessed] = useState(0);
  const [inspector, setInspector] = useState<InspectorData | null>(null);
  const [extractDraft, setExtractDraft] = useState<SourceEditorChange | null>(null);
  const [sourceEditor, setSourceEditor] = useState<Editor | null>(null);
  const [sourceEditorReady, setSourceEditorReady] = useState(false);
  const sourceJumpedRef = useRef<string | null>(null);
  const [extractEditor, setExtractEditor] = useState<Editor | null>(null);
  const [extractEditorReady, setExtractEditorReady] = useState(false);
  const [extractBuilder, setExtractBuilder] = useState<{
    tab: CardKind;
    clozeText?: string;
  } | null>(null);
  const [postponeMenuOpenSignal, setPostponeMenuOpenSignal] = useState(0);
  // Bumped by the `d` key (or the action bar) to run the DoneIntentMenu trigger logic
  // for a SOURCE — fetch the block summary, then take the 0-unresolved fast path or open
  // the intent popover. Mirrors `postponeMenuOpenSignal`/`ScheduleMenu`.
  const [doneIntentSignal, setDoneIntentSignal] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [atomicPrompt, setAtomicPrompt] = useState<AtomicExtractPromptState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoState, setUndoState] = useState<ProcessUndoState | null>(null);
  // The visible Undo snackbar for the destructive source intents (Finished / Abandon).
  // Other loop actions keep the silent local ⌘Z undo only — this stays null for them.
  const [doneIntentSnackbar, setDoneIntentSnackbar] = useState<string | null>(null);
  const [dailyWork, setDailyWork] = useState<DailyWorkSummaryResult | null>(null);
  const [deckLoading, setDeckLoading] = useState(true);
  const [deckLoaded, setDeckLoaded] = useState(false);
  // The ambient, adaptive minute gauge's backend-priced inputs (T115/T116). Refreshed
  // after each action and on a cross-surface queue refresh so "remaining" tracks the
  // live due universe; the renderer never re-prices locally.
  const [minuteBudget, setMinuteBudget] = useState<QueueMinuteBudget | null>(null);
  const [timeEstimate, setTimeEstimate] = useState<QueueTimeEstimate | null>(null);
  const [dayComposition, setDayComposition] = useState<QueueQuotaComposition | null>(null);
  const sessionStartedAtRef = useRef(Date.now());
  // Every id that has appeared in an order this session — the basis for the
  // end-of-order "new work arrived" check (KTD-7). Kept SEPARATE from `gradedRef`
  // (the card double-grade guard) so undo can re-serve a restored item.
  const seenIdsRef = useRef<Set<string>>(new Set());
  // When the live deck drains, a reprice surfaces genuinely-new actionable work as a
  // user-driven "keep going?" affordance rather than auto-extending the loop.
  const [newWorkAvailable, setNewWorkAvailable] = useState(0);
  const endOfOrderCheckedRef = useRef(false);
  // The soft "wrap up or keep going?" nudge — shown once when elapsed crosses the
  // reference target, dismissible without re-nagging (KTD-6). Never a hard gate.
  const [wrapUpVisible, setWrapUpVisible] = useState(false);
  const [wrapUpDismissed, setWrapUpDismissed] = useState(false);
  const wrapUpShownRef = useRef(false);
  // A queueRefresh that arrives mid-action is deferred (not dropped): this flag makes
  // the reconcile run once the action settles, so external mutations are never lost.
  const refreshDirtyRef = useRef(false);

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
  /** When the current card became visible (for the card-shown→reveal prompt time). */
  const cardShownAtRef = useRef<number | null>(null);
  /** Frozen prompt time captured at reveal, then persisted with the grade. */
  const promptMsRef = useRef<number>(0);
  /** Card ids already graded this session — the hard guard against a double grade. */
  const gradedRef = useRef<Set<string>>(new Set());

  // The ordered live-serve deck: the read's deterministic T076 SCORE order (which the
  // `mode` already biases server-side), then the stable seeded jitter (so the user
  // isn't trapped in one topic). The FULL mixed deck — `mode` re-orders it, never
  // slices it — so both cards and reading items are always present. The cursor walks
  // THIS order; an action just advances the cursor. Unlike the old frozen deck, the
  // live queue is the source of truth: a cross-surface refresh RECONCILES the order by
  // id (preserving the user's place, appending new work at the tail) instead of
  // restarting, and reopening /process re-derives the next best item — there is no
  // frozen snapshot to lose, so a session can never "expire".
  const [order, setOrder] = useState<QueueItemSummary[]>([]);

  const total = order.length;
  const current = cursor < total ? order[cursor] : null;
  const currentId = current?.id ?? null;
  const currentType = current?.type ?? null;
  const currentItemIdRef = useRef(currentId);
  currentItemIdRef.current = currentId;
  // Live mirrors so the ambient reprice can reconcile against the current order/cursor
  // without re-subscribing or going stale inside a [asOf]-scoped callback.
  const orderRef = useRef(order);
  orderRef.current = order;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const done = deckLoaded && (total === 0 || cursor >= total);
  const zeroLoad = deckLoaded && total === 0 && processed === 0;
  const isCard = current?.type === "card";
  /** Items left to look at (this one + everything after) — the full mixed deck. */
  const remaining = Math.max(0, total - cursor);
  const isRenderingExtract = !deckLoading && !done && current?.type === "extract";
  const isRenderingSource = !deckLoading && !done && current?.type === "source";
  const isRenderingCard = !deckLoading && !done && current?.type === "card";
  const centerClassName = `pq-center${isRenderingExtract ? " pq-center--extract" : ""}${isRenderingSource ? " pq-center--source" : ""}${isRenderingCard ? " pq-center--review" : ""}`;
  const documentElementId = current && current.type !== "card" ? current.id : null;
  const doc = useDocument(documentElementId);
  const sourceReadPoint = useReadPoint(current?.type === "source" ? current.id : null);
  const sourceHighlights = useHighlights(current?.type === "source" ? current.id : null);
  const extractHighlights = useHighlights(current?.type === "extract" ? current.id : null);
  const sourceSelection = useTextSelection(
    current?.type === "source" ? sourceEditor : null,
    current?.type === "source" && sourceEditorReady,
  );
  const extractSelection = useTextSelection(
    current?.type === "extract" ? extractEditor : null,
    current?.type === "extract" && extractEditorReady,
  );

  // Read the latest mode without making `load` depend on it, so a load triggered by
  // the clock alone uses whatever mode is current (a mode switch passes it explicitly).
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Mirror of `busy` for the queueRefresh subscription closure: a refresh that lands
  // mid-action is deferred (refreshDirtyRef) and flushed when busy clears.
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const toast = useCallback((message: string) => {
    setFlash(message);
    window.setTimeout(() => setFlash(null), 1600);
  }, []);

  const noteCreatedExtract = useCallback((result: ExtractionCreateResult) => {
    if (result.extract.stage !== "atomic_statement") {
      setAtomicPrompt(null);
      return;
    }
    setAtomicPrompt({
      extractId: result.extract.id,
      title: result.extract.title || "Atomic extract ready",
    });
  }, []);

  const openAtomicPrompt = useCallback(() => {
    const prompt = atomicPrompt;
    if (!prompt) return;
    setAtomicPrompt(null);
    void navigate({
      to: "/extract/$id",
      params: { id: prompt.extractId },
      search: { cardBuilder: "qa" } as Record<string, unknown>,
    });
  }, [atomicPrompt, navigate]);

  const clearUndo = useCallback(() => {
    setUndoState(null);
    setDoneIntentSnackbar(null);
  }, []);

  const dismissDoneIntentSnackbar = useCallback(() => {
    setDoneIntentSnackbar(null);
  }, []);

  const patchCurrentExtract = useCallback(
    (extract: {
      id: string;
      status: string;
      stage: string;
      priority: number;
      title: string;
      dueAt: string | null;
      extractFate?: ExtractFate | null;
    }) => {
      setOrder((items) =>
        items.map((item) =>
          item.id === extract.id
            ? {
                ...item,
                status: extract.status,
                stage: extract.stage,
                priority: extract.priority,
                title: extract.title,
                dueAt: extract.dueAt,
                schedulerSignals: { ...item.schedulerSignals, stage: extract.stage },
              }
            : item,
        ),
      );
      setInspector((prev) =>
        prev?.element.id === extract.id
          ? {
              ...prev,
              element: {
                ...prev.element,
                status: extract.status,
                stage: extract.stage,
                priority: extract.priority,
                title: extract.title,
                dueAt: extract.dueAt,
                extractFate: extract.extractFate ?? prev.element.extractFate,
              },
              scheduler: { ...prev.scheduler, stage: extract.stage },
            }
          : prev,
      );
    },
    [],
  );

  const reloadInspector = useCallback(async (id: string) => {
    try {
      const res = await appApi.getInspectorData({ id });
      setInspector(res.data);
    } catch {
      setInspector(null);
    }
  }, []);

  // Push the backend-priced minute inputs into the ambient gauge. Pure setter — the
  // renderer never recomputes pricing/eligibility/quota locally (read-model invariant).
  const applyGauge = useCallback(
    (value: {
      minuteBudget?: QueueMinuteBudget;
      timeEstimate?: QueueTimeEstimate;
      dayComposition?: QueueQuotaComposition;
    }) => {
      setMinuteBudget(value.minuteBudget ?? null);
      setTimeEstimate(value.timeEstimate ?? null);
      setDayComposition(value.dayComposition ?? null);
    },
    [],
  );

  // Full (re)load — mount, mode switch, manual "Reload queue", and the user-confirmed
  // end-of-order continuation. `mode` flows to `queue.list` as a SOFT ordering bias, so
  // the loop reads the FULL mixed deck re-ordered for the mode. Resets the cursor and
  // session bookkeeping; the cursor then walks this order until the next rebuild.
  const rebuildDeck = useCallback(
    async (modeOverride?: SessionMode) => {
      if (!isDesktop()) return;
      const activeMode = modeOverride ?? modeRef.current;
      setDeckLoading(true);
      try {
        const [queueResult, workResult] = await Promise.allSettled([
          appApi.listQueue({
            ...(asOf ? { asOf } : {}),
            mode: activeMode,
            includeTimeEstimate: true,
          }),
          appApi.getDailyWorkSummary(asOf ? { asOf } : {}),
        ]);
        let nextError: string | null = null;
        setUndoState(null);
        setDoneIntentSnackbar(null);
        if (queueResult.status === "fulfilled") {
          const items = jitterOrder(processableQueueItems(queueResult.value.items));
          setOrder(items);
          setCursor(0);
          setProcessed(0);
          sessionStartedAtRef.current = Date.now();
          gradedRef.current = new Set();
          seenIdsRef.current = new Set(items.map((item) => item.id));
          setNewWorkAvailable(0);
          endOfOrderCheckedRef.current = false;
          refreshDirtyRef.current = false;
          setWrapUpVisible(false);
          setWrapUpDismissed(false);
          wrapUpShownRef.current = false;
          applyGauge(queueResult.value);
          setDeckLoaded(true);
        } else {
          setOrder([]);
          setDeckLoaded(false);
          nextError =
            queueResult.reason instanceof Error
              ? queueResult.reason.message
              : String(queueResult.reason);
        }
        if (workResult.status === "fulfilled") {
          setDailyWork(workResult.value);
        } else {
          setDailyWork(null);
          nextError =
            nextError ??
            (workResult.reason instanceof Error
              ? workResult.reason.message
              : String(workResult.reason));
        }
        setError(nextError);
      } catch (e) {
        setDeckLoaded(false);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setDeckLoading(false);
      }
    },
    [asOf, applyGauge],
  );

  // Ambient refresh — runs after each action, on a cross-surface queueRefresh, and at
  // end-of-order. Always re-prices the gauge from the live due universe. When
  // `reconcile` is set (an EXTERNAL mutation may have changed the upcoming items), it
  // reconciles the order BY ID: the already-seen prefix stays put (no re-jitter), the
  // current item is preserved (or the loop advances to the nearest surviving item if it
  // vanished), and genuinely-new work is appended at the tail in score order. A failed
  // read is non-destructive — it never blanks a live session.
  const repriceDeck = useCallback(
    async (options?: { reconcile?: boolean }) => {
      if (!isDesktop()) return;
      const [queueResult, workResult] = await Promise.allSettled([
        appApi.listQueue({
          ...(asOf ? { asOf } : {}),
          mode: modeRef.current,
          includeTimeEstimate: true,
        }),
        appApi.getDailyWorkSummary(asOf ? { asOf } : {}),
      ]);
      if (workResult.status === "fulfilled") setDailyWork(workResult.value);
      if (queueResult.status !== "fulfilled") return; // non-destructive on failure
      applyGauge(queueResult.value);
      if (!options?.reconcile) return;
      const fresh = jitterOrder(processableQueueItems(queueResult.value.items));
      const prevOrder = orderRef.current;
      const prevCursor = cursorRef.current;
      const anchorId = prevOrder[prevCursor]?.id ?? null;
      const prefix = prevOrder.slice(0, prevCursor);
      const prefixIds = new Set(prefix.map((item) => item.id));
      const upcoming = fresh.filter((item) => !prefixIds.has(item.id));
      const nextOrder = [...prefix, ...upcoming];
      for (const item of upcoming) seenIdsRef.current.add(item.id);
      const anchorIdx = anchorId == null ? -1 : upcoming.findIndex((item) => item.id === anchorId);
      // anchor present → keep the user on it; anchor gone → nearest surviving item
      // (first upcoming); was already at/after the end → end-of-order.
      const nextCursor = anchorIdx >= 0 ? prefix.length + anchorIdx : prefix.length;
      setOrder(nextOrder);
      setCursor(Math.min(nextCursor, nextOrder.length));
    },
    [asOf, applyGauge],
  );

  useEffect(() => {
    void rebuildDeck();
  }, [rebuildDeck]);

  // A cross-surface queue mutation reconciles the live deck in place (preserving the
  // user's spot). One that lands mid-action is deferred via refreshDirtyRef and flushed
  // by the busy-clear effect below, so an external mutation is never silently lost.
  useEffect(() => {
    if (!desktop) return;
    return listenQueueRefresh(() => {
      if (busyRef.current) {
        refreshDirtyRef.current = true;
        return;
      }
      void repriceDeck({ reconcile: true });
    });
  }, [desktop, repriceDeck]);

  useEffect(() => {
    if (busy || !refreshDirtyRef.current) return;
    refreshDirtyRef.current = false;
    void repriceDeck({ reconcile: true });
  }, [busy, repriceDeck]);

  // End-of-order continuity (KTD-7): when the live deck drains, re-read once and surface
  // genuinely-new actionable work (ids not seen this session — e.g. extracts created
  // mid-session) as a user-driven "keep going?" affordance, rather than silently
  // auto-extending the loop. Reaching the end is a legitimate stopping point.
  useEffect(() => {
    if (!done) {
      endOfOrderCheckedRef.current = false;
      return;
    }
    if (zeroLoad || !deckLoaded || deckLoading || endOfOrderCheckedRef.current || !isDesktop()) {
      return;
    }
    endOfOrderCheckedRef.current = true;
    void (async () => {
      try {
        const res = await appApi.listQueue({
          ...(asOf ? { asOf } : {}),
          mode: modeRef.current,
          includeTimeEstimate: true,
        });
        applyGauge(res);
        const fresh = processableQueueItems(res.items);
        const newCount = fresh.filter((item) => !seenIdsRef.current.has(item.id)).length;
        setNewWorkAvailable(newCount);
      } catch {
        // Non-destructive — the done panel just shows the plain "Queue clear" copy.
      }
    })();
  }, [done, zeroLoad, deckLoaded, deckLoading, asOf, applyGauge]);

  // Load the current card's full reveal-ready view OR the current attention item's
  // inspector context. The body itself comes from `useDocument`, so extract editing
  // and the generic preview read through the same document hook.
  useEffect(() => {
    let cancelled = false;
    // Reset the per-item reveal/grade surface whenever the item changes.
    setRevealed(false);
    setPreviews(null);
    revealAtRef.current = null;
    cardShownAtRef.current = currentType === "card" ? Date.now() : null;
    promptMsRef.current = 0;
    setExtractDraft(null);
    sourceJumpedRef.current = null;
    setExtractBuilder(null);
    if (!currentId || !currentType) {
      setCardView(null);
      setInspector(null);
      return;
    }
    if (currentType === "card") {
      setInspector(null);
      void (async () => {
        try {
          const res = await appApi.reviewCard({
            cardId: currentId,
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
        const insp = await appApi.getInspectorData({ id: currentId });
        if (cancelled) return;
        setInspector(insp.data);
      } catch {
        if (cancelled) return;
        setInspector(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentId, currentType, asOf]);

  // Selecting the current item drives the shell inspector to its context.
  useEffect(() => {
    if (currentId) select(currentId);
  }, [currentId, select]);

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
      void rebuildDeck(next);
    },
    [rebuildDeck],
  );

  const openRecommendedWork = useCallback(() => {
    if (dailyWork?.recommendedAction === "triage_inbox") {
      void navigate({ to: "/inbox" });
      return;
    }
    if (dailyWork?.recommendedAction === "resume_unscheduled_source" && dailyWork.resumeSource) {
      select(dailyWork.resumeSource.id);
      void navigate({
        to: "/source/$id",
        params: { id: dailyWork.resumeSource.id },
      });
    }
  }, [dailyWork, navigate, select]);

  /**
   * Apply one fully-shaped action through the SAME typed mutation path as the list
   * (T030), then ADVANCE to the next item. raise/lower/done/dismiss/delete and
   * card-only postpone route through `queue.act`; attention-item postpone uses the
   * explicit schedule menu below. The loop never returns to the list — it just moves
   * the cursor. Recoverable mutations keep a local undo recipe so ⌘Z can restore the
   * item and cursor in place, but they do not raise a snackbar on every item transition.
   *
   * `withSnackbar` raises a VISIBLE Undo snackbar for the destructive source-lifecycle
   * intents (Finished / Abandon) routed from {@link DoneIntentMenu}; the recipe it shows
   * is the SAME op ⌘Z hits, so the two paths can never diverge.
   */
  const runAction = useCallback(
    async (action: QueueActAction, withSnackbar = false) => {
      if (!current || busy || !isDesktop()) return;
      const undoIndex = cursor;
      const kind = action.kind;
      clearUndo();
      setBusy(true);
      try {
        const res = await appApi.actOnQueueItem({ id: current.id, action });
        setProcessed((p) => p + 1);
        advance();
        requestInspectorRefresh();
        void repriceDeck();
        const undo: ProcessUndoState["undo"] | null = res.undo
          ? { kind: "queue", recipe: res.undo }
          : kind === "postpone" ||
              kind === "raise" ||
              kind === "lower" ||
              kind === "markDone" ||
              kind === "dismiss" ||
              kind === "delete"
            ? { kind: "last" }
            : null;
        if (undo) {
          setUndoState({
            id: current.id,
            index: undoIndex,
            undo,
          });
          if (withSnackbar) {
            setDoneIntentSnackbar(kind === "dismiss" ? "Source abandoned" : "Source done");
          }
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [current, busy, cursor, clearUndo, advance, repriceDeck],
  );

  /**
   * Apply a simple keyboard/button action by kind. The source done-gate is handled
   * separately by {@link DoneIntentMenu} (the `d` key / Done button for a source bumps
   * `doneIntentSignal`), so this never carries the `confirmUnresolvedBlocks` override.
   */
  const act = useCallback((kind: LoopActionKind) => runAction({ kind }), [runAction]);

  // Descendant-aware delete (T135 / U7) for the loop's Delete action. A leaf routes
  // through the existing `runAction({delete})` path (advances the cursor + keeps the
  // loop's own undo recipe, so we suppress the controller's leaf snackbar); a node with
  // live descendants opens the intent menu. A keep/branch/mark-done outcome advances the
  // cursor and refreshes; the branch-delete Undo restores the exact batch (KTD10).
  const lineageDelete = useLineageDelete({
    quietDelete: async () => {
      await runAction({ kind: "delete" });
    },
    hostOwnsQuietUndo: true,
    onAfter: (_target, kind) => {
      if (kind === "quiet") return; // runAction already advanced + bookkept.
      setProcessed((p) => p + 1);
      clearUndo();
      advance();
      requestInspectorRefresh();
      void repriceDeck();
    },
    onUndoAfter: (target) => {
      // Restore the cursor BY ID (the reconcile may have shifted indices) so the
      // cursor and the inspector selection always agree on the restored item.
      const idx = orderRef.current.findIndex((item) => item.id === target.id);
      setCursor(idx >= 0 ? idx : Math.min(cursorRef.current, Math.max(0, orderRef.current.length)));
      setProcessed((p) => Math.max(0, p - 1));
      select(target.id);
      requestInspectorRefresh();
      void repriceDeck();
    },
  });
  // The `delete` key and the overflow menu's Delete item both bump this so the
  // loop's LineageDeleteMenu runs the same descendant-aware flow.
  const [deleteSignal, setDeleteSignal] = useState(0);
  const requestDelete = useCallback(() => {
    // Guard on the combined busy (page + lineage mutation), matching the busy the
    // overflow trigger is disabled on, so the keyboard path can't bump mid-delete.
    if (!busy && !lineageDelete.busy) setDeleteSignal((n) => n + 1);
  }, [busy, lineageDelete.busy]);

  /**
   * Fetch the current source's block-processing summary for {@link DoneIntentMenu}. The
   * surface uses it to take the 0-unresolved fast path (mark done with no popover) or to
   * render the honest per-state breakdown. A failed read aborts silently (returns null).
   */
  const getDoneIntentSummary = useCallback(async () => {
    if (current?.type !== "source") return null;
    try {
      const res = await appApi.getBlockProcessingSummary({ sourceElementId: current.id });
      return res.summary;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [current]);

  /**
   * Route a chosen done-intent to the SAME `act()` paths the rest of the loop uses, so
   * `ProcessUndoState` + local ⌘Z keep working. Return later → postpone (read-point left
   * untouched); Abandon → dismiss. Finished/Abandon raise the visible Undo snackbar.
   *
   * Finished RE-FETCHES the summary (KTD5) to close the non-modal staleness race: the doc
   * can change while the popover is open, so the 0-unresolved fast path (and any blocks the
   * user resolved meanwhile) marks done cleanly with NO confirm override, while a still-open
   * source passes `confirmUnresolvedBlocks` for the authoritative server gate.
   */
  const onDoneIntentResolved = useCallback(
    (intent: DoneIntent) => {
      if (intent === "later") {
        void runAction({ kind: "postpone" });
      } else if (intent === "abandon") {
        void runAction({ kind: "dismiss" }, true);
      } else {
        void (async () => {
          const summary = await getDoneIntentSummary();
          // A failed re-read (null) is treated as still-unresolved — the server gate is
          // the final authority and rejects a bad override anyway.
          const fresh = summary?.canMarkDoneWithoutConfirmation
            ? { kind: "markDone" as const }
            : { kind: "markDone" as const, confirmUnresolvedBlocks: true };
          await runAction(fresh, true);
        })();
      }
    },
    [runAction, getDoneIntentSummary],
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
      const undoIndex = cursor;
      clearUndo();
      setBusy(true);
      try {
        await appApi.scheduleQueueItem({ id: current.id, choice });
        setProcessed((p) => p + 1);
        advance();
        requestInspectorRefresh();
        void repriceDeck();
        setUndoState({
          id: current.id,
          index: undoIndex,
          undo: { kind: "last" },
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [current, busy, cursor, clearUndo, advance, repriceDeck],
  );

  const undoLastProcessAction = useCallback(async () => {
    const pending = undoState;
    if (!pending || busy || !isDesktop()) return;
    setUndoState(null);
    setDoneIntentSnackbar(null);
    setBusy(true);
    try {
      if (pending.undo.kind === "queue") {
        await appApi.undoQueueAction({
          id: pending.id,
          undo: pending.undo.recipe,
        });
      } else {
        const res = await appApi.undoLast();
        if (!res.undone) {
          toast(res.reason ?? "Nothing to undo");
          return;
        }
      }
      // Restore the cursor BY ID — a post-action gauge reprice leaves `order` intact
      // (the acted item is still in place behind the cursor), but a cross-surface
      // reconcile may have shifted indices, so locate the restored item by id and fall
      // back to the captured index only if it is no longer in the live order.
      const restoreIdx = orderRef.current.findIndex((item) => item.id === pending.id);
      setCursor(
        restoreIdx >= 0
          ? restoreIdx
          : Math.min(pending.index, Math.max(0, orderRef.current.length)),
      );
      setProcessed((p) => Math.max(0, p - 1));
      select(pending.id);
      requestInspectorRefresh();
      void repriceDeck();
      toast("Undone");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      toast("Could not undo");
    } finally {
      setBusy(false);
    }
  }, [undoState, busy, select, repriceDeck, toast]);

  const onExtractChange = useCallback(
    (change: SourceEditorChange) => {
      setExtractDraft(change);
      doc.save(change);
    },
    [doc],
  );

  const onExtractEditorReady = useCallback((instance: Editor | null) => {
    setExtractEditor(instance);
    setExtractEditorReady(instance !== null);
  }, []);

  const onSourceEditorReady = useCallback((instance: Editor | null) => {
    setSourceEditor(instance);
    setSourceEditorReady(instance !== null);
  }, []);

  useEffect(() => {
    if (currentType !== "source" || !sourceEditor || !sourceEditorReady) return;
    setReaderDecorations(sourceEditor, {
      firstUnreadBlockId: sourceReadPoint.firstUnreadBlockId(doc.currentDoc),
      readPointBlockId: sourceReadPoint.readPoint?.blockId ?? null,
      extractedBlockIds: doc.extractedBlockIds,
      highlights: sourceHighlights.highlights,
      processed: [],
      flashedBlockId: null,
    });
    if (currentId && sourceReadPoint.readPoint && sourceJumpedRef.current !== currentId) {
      sourceReadPoint.jump(sourceEditor);
      sourceJumpedRef.current = currentId;
    }
  }, [
    currentId,
    currentType,
    sourceEditor,
    sourceEditorReady,
    sourceReadPoint,
    sourceReadPoint.readPoint,
    doc.currentDoc,
    doc.extractedBlockIds,
    sourceHighlights.highlights,
  ]);

  useEffect(() => {
    if (current?.type !== "extract" || !extractEditor || !extractEditorReady) return;
    setReaderDecorations(extractEditor, {
      firstUnreadBlockId: null,
      readPointBlockId: null,
      extractedBlockIds: doc.extractedBlockIds,
      highlights: extractHighlights.highlights,
      processed: [],
      flashedBlockId: null,
    });
  }, [
    current?.type,
    extractEditor,
    extractEditorReady,
    doc.extractedBlockIds,
    extractHighlights.highlights,
  ]);

  const setExtractStage = useCallback(
    async (target?: ExtractStage) => {
      if (current?.type !== "extract" || busy || !isDesktop()) return;
      clearUndo();
      setBusy(true);
      try {
        const res = await appApi.updateExtractStage(
          target ? { id: current.id, stage: target } : { id: current.id },
        );
        patchCurrentExtract(res.extract);
        await reloadInspector(current.id);
        requestInspectorRefresh();
        toast(`Advanced to ${stageLabel(res.extract.stage)}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        toast("Could not change stage");
      } finally {
        setBusy(false);
      }
    },
    [current, busy, clearUndo, patchCurrentExtract, reloadInspector, toast],
  );

  const trimExtract = useCallback(async () => {
    if (current?.type !== "extract" || busy || !isDesktop()) return;
    clearUndo();
    setBusy(true);
    try {
      await settleEditorInput();
      const liveJson = extractEditor?.getJSON();
      let prosemirrorJson =
        liveJson ?? extractDraft?.prosemirrorJson ?? doc.currentDoc ?? doc.initialDoc;
      let plainText = liveJson ? toPlainText(liveJson) : (extractDraft?.plainText ?? doc.plainText);
      const visibleText = visibleEditorPlainText(extractEditor);
      if (
        visibleText !== null &&
        normalizePlainText(visibleText) !== normalizePlainText(plainText)
      ) {
        plainText = visibleText;
        prosemirrorJson = plainTextToSimpleDoc(plainText, prosemirrorJson);
      }
      plainText = plainText
        .split(/\n/)
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      prosemirrorJson = plainTextToSimpleDoc(plainText, prosemirrorJson);
      const blocks = toBlockInputs(prosemirrorJson);
      const res = await appApi.rewriteExtract({
        id: current.id,
        prosemirrorJson: prosemirrorJson ?? { type: "doc", content: [] },
        plainText,
        ...(blocks ? { blocks } : {}),
      });
      patchCurrentExtract(res.extract);
      setExtractDraft({
        prosemirrorJson: prosemirrorJson ?? { type: "doc", content: [] },
        plainText,
      });
      await reloadInspector(current.id);
      requestInspectorRefresh();
      toast("Trimmed extract");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      toast("Could not trim");
    } finally {
      setBusy(false);
    }
  }, [
    current,
    busy,
    extractDraft,
    doc.currentDoc,
    doc.initialDoc,
    doc.plainText,
    extractEditor,
    clearUndo,
    patchCurrentExtract,
    reloadInspector,
    toast,
  ]);

  const setExtractFate = useCallback(
    async (fate: DirectExtractFate) => {
      if (current?.type !== "extract" || busy || !isDesktop()) return;
      clearUndo();
      setBusy(true);
      try {
        const res = await appApi.setExtractFate({ id: current.id, fate });
        patchCurrentExtract(res.extract);
        await reloadInspector(current.id);
        requestInspectorRefresh();
        toast(fate === "reference" ? "Kept as reference" : "Marked done without card");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        toast("Could not set extract fate");
      } finally {
        setBusy(false);
      }
    },
    [current, busy, clearUndo, patchCurrentExtract, reloadInspector, toast],
  );

  const onCardCreatedFromExtract = useCallback(() => {
    clearUndo();
    if (current?.type === "extract") {
      void reloadInspector(current.id);
      requestInspectorRefresh();
    }
  }, [current, clearUndo, reloadInspector]);

  const setSourceReadPoint = useCallback(async () => {
    if (current?.type !== "source" || !sourceEditor) return;
    clearUndo();
    const resolved = await sourceReadPoint.setFromSelection(sourceEditor);
    toast(resolved ? "Read-point set here" : "Place the caret in the source first");
    if (resolved) {
      requestInspectorRefresh();
      await reloadInspector(current.id);
    }
  }, [current, sourceEditor, clearUndo, sourceReadPoint, reloadInspector, toast]);

  const createProcessSourceExtract = useCallback(async () => {
    const loc = sourceSelection.location;
    if (!loc) {
      toast("Select text in the source to extract it");
      return;
    }
    if (current?.type !== "source" || busy || !isDesktop()) return;
    const ownerId = current.id;
    clearUndo();
    setBusy(true);
    try {
      const result = await appApi.createExtraction({
        sourceElementId: ownerId,
        selectedText: loc.selectedText,
        blockIds: loc.blockIds,
        startOffset: loc.startOffset,
        endOffset: loc.endOffset,
      });
      if (currentItemIdRef.current !== ownerId) return;
      noteCreatedExtract(result);
      doc.markExtracted(loc.blockIds);
      const lastBlockId = loc.blockIds.at(-1);
      if (
        sourceEditor &&
        lastBlockId &&
        sourceReadPoint.isAtOrAfterReadPoint(doc.currentDoc, lastBlockId)
      ) {
        void sourceReadPoint.markReadThrough(sourceEditor, lastBlockId);
      }
      await reloadInspector(ownerId);
      requestInspectorRefresh();
      toast(result.extract.stage === "atomic_statement" ? "Atomic extract ready" : "Extracted");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      toast("Could not extract");
    } finally {
      setBusy(false);
      sourceSelection.dismiss();
      clearConsumedEditorSelection(sourceEditor);
    }
  }, [
    current,
    busy,
    clearUndo,
    sourceSelection,
    doc,
    sourceEditor,
    sourceReadPoint,
    reloadInspector,
    toast,
    noteCreatedExtract,
  ]);

  const highlightProcessSourceSelection = useCallback(async () => {
    const loc = sourceSelection.location;
    if (!loc) {
      toast("Select text in the source to highlight it");
      return;
    }
    if (current?.type !== "source" || busy || !isDesktop()) return;
    clearUndo();
    setBusy(true);
    try {
      await sourceHighlights.add(loc);
      toast("Highlighted");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      toast("Could not highlight");
    } finally {
      setBusy(false);
      sourceSelection.dismiss();
      clearConsumedEditorSelection(sourceEditor);
    }
  }, [current, busy, clearUndo, sourceSelection, sourceHighlights, sourceEditor, toast]);

  const onSourceSelectionAction = useCallback(
    (action: SelectionToolbarAction) => {
      const loc = sourceSelection.location;
      switch (action) {
        case "extract":
          void createProcessSourceExtract();
          break;
        case "highlight":
          void highlightProcessSourceSelection();
          break;
        case "copy": {
          if (loc?.selectedText && typeof navigator !== "undefined" && navigator.clipboard) {
            void navigator.clipboard.writeText(loc.selectedText).then(
              () => toast("Copied to clipboard"),
              () => toast("Could not copy"),
            );
          }
          sourceSelection.dismiss();
          break;
        }
        case "cloze":
          toast("Create an extract first, then make a cloze");
          sourceSelection.dismiss();
          break;
        case "cancel":
          sourceSelection.dismiss();
          break;
      }
    },
    [sourceSelection, createProcessSourceExtract, highlightProcessSourceSelection, toast],
  );

  useEffect(() => {
    if (!desktop || current?.type !== "source" || !sourceSelection.position) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const k = e.key.toLowerCase();
      if (k === "e") {
        e.preventDefault();
        onSourceSelectionAction("extract");
      } else if (k === "h") {
        e.preventDefault();
        onSourceSelectionAction("highlight");
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [desktop, current?.type, sourceSelection.position, onSourceSelectionAction]);

  const createProcessSubExtract = useCallback(async () => {
    const loc = extractSelection.location;
    if (!loc) {
      toast("Select text in the extract to sub-extract it");
      return;
    }
    if (current?.type !== "extract" || busy || !isDesktop()) return;
    const sourceRootId = inspector?.source?.id ?? current.sourceId ?? null;
    if (!sourceRootId) {
      toast("Could not find the source for this extract");
      extractSelection.dismiss();
      return;
    }
    const ownerId = current.id;
    clearUndo();
    setBusy(true);
    try {
      const result = await appApi.createExtraction({
        sourceElementId: sourceRootId,
        parentId: ownerId,
        selectedText: loc.selectedText,
        blockIds: loc.blockIds,
        startOffset: loc.startOffset,
        endOffset: loc.endOffset,
      });
      if (currentItemIdRef.current !== ownerId) return;
      noteCreatedExtract(result);
      doc.markExtracted(loc.blockIds);
      await reloadInspector(ownerId);
      requestInspectorRefresh();
      toast(
        result.extract.stage === "atomic_statement"
          ? "Atomic sub-extract ready"
          : "Sub-extract created",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      toast("Could not create sub-extract");
    } finally {
      setBusy(false);
      extractSelection.dismiss();
      clearConsumedEditorSelection(extractEditor);
    }
  }, [
    current,
    busy,
    clearUndo,
    inspector,
    extractSelection,
    extractEditor,
    doc,
    reloadInspector,
    toast,
    noteCreatedExtract,
  ]);

  const highlightProcessExtractSelection = useCallback(async () => {
    const loc = extractSelection.location;
    if (!loc) {
      toast("Select text in the extract to highlight it");
      return;
    }
    if (current?.type !== "extract" || busy || !isDesktop()) return;
    clearUndo();
    setBusy(true);
    try {
      await extractHighlights.add(loc);
      toast("Highlighted");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      toast("Could not highlight");
    } finally {
      setBusy(false);
      extractSelection.dismiss();
      clearConsumedEditorSelection(extractEditor);
    }
  }, [current, busy, clearUndo, extractSelection, extractHighlights, extractEditor, toast]);

  const onExtractSelectionAction = useCallback(
    (action: SelectionToolbarAction) => {
      const loc = extractSelection.location;
      switch (action) {
        case "extract":
          void createProcessSubExtract();
          break;
        case "cloze": {
          const selected = loc?.selectedText.trim();
          setExtractBuilder(
            selected ? { tab: "cloze", clozeText: `{{c1::${selected}}}` } : { tab: "cloze" },
          );
          extractSelection.dismiss();
          break;
        }
        case "copy": {
          if (loc?.selectedText && typeof navigator !== "undefined" && navigator.clipboard) {
            void navigator.clipboard.writeText(loc.selectedText).then(
              () => toast("Copied to clipboard"),
              () => toast("Could not copy"),
            );
          }
          extractSelection.dismiss();
          break;
        }
        case "highlight":
          void highlightProcessExtractSelection();
          break;
        case "cancel":
          extractSelection.dismiss();
          break;
      }
    },
    [extractSelection, createProcessSubExtract, highlightProcessExtractSelection, toast],
  );

  useEffect(() => {
    if (!desktop || current?.type !== "extract" || !extractSelection.position) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const k = e.key.toLowerCase();
      if (k === "e") {
        e.preventDefault();
        onExtractSelectionAction("extract");
      } else if (k === "c") {
        e.preventDefault();
        onExtractSelectionAction("cloze");
      } else if (k === "h") {
        e.preventDefault();
        onExtractSelectionAction("highlight");
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [desktop, current?.type, extractSelection.position, onExtractSelectionAction]);

  /** Skip the current item without mutating it (just advance the cursor). */
  const skip = useCallback(() => {
    if (!current) return;
    advance();
  }, [current, advance]);

  /**
   * Reveal the current card's answer + lazily fetch the four interval previews
   * (PURE — no mutation). Captures prompt-side and reveal timestamps for review timing.
   * Mirrors the review session's reveal exactly. Keyed off the cursor's `current.id`
   * (always present for a card) rather than the async-loaded `cardView`, so a fast
   * Space press never no-ops while the full view is still in flight — the answer
   * block renders the moment `cardView` arrives.
   */
  const reveal = useCallback(async () => {
    if (!isCard || !current || revealed) return;
    setRevealed(true);
    const revealedAt = Date.now();
    promptMsRef.current =
      cardShownAtRef.current == null ? 0 : Math.max(0, revealedAt - cardShownAtRef.current);
    revealAtRef.current = revealedAt;
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
   * prompt-side and reveal→grade timings, then ADVANCE the FROZEN-order cursor (consistent
   * with `act` — the loop's deck is the queue order, not the review deck). Guards
   * against double-grading the same card. Cards stay FSRS-only.
   */
  const grade = useCallback(
    async (rating: ReviewRating) => {
      if (!isCard || !cardView || !revealed || busy || !isDesktop()) return;
      if (gradedRef.current.has(cardView.id)) return;
      clearUndo();
      setBusy(true);
      const responseMs = revealAtRef.current ? Math.max(0, Date.now() - revealAtRef.current) : 0;
      try {
        await appApi.reviewGrade({
          cardId: cardView.id,
          rating,
          responseMs,
          promptMs: promptMsRef.current,
          ...(asOf ? { asOf } : {}),
        });
        requestInspectorRefresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
        return;
      }
      gradedRef.current.add(cardView.id);
      setProcessed((p) => p + 1);
      advance();
      setBusy(false);
      void repriceDeck();
    },
    [isCard, cardView, revealed, busy, clearUndo, asOf, advance, repriceDeck],
  );

  /** Open the current item in its full surface — the ONLY navigation in the loop. */
  const open = useCallback(() => {
    if (!current) return;
    openQueueItem({ item: current, navigate, select, asOf });
  }, [current, navigate, select, asOf]);

  // Keyboard-first controls — the loop's core keys, registered in the single
  // shortcut registry (T048) and bound here through the SAME `appApi` path as the
  // buttons. While the loop is live it owns the keys it shares with the global
  // shell handler (`o`/`+`/`-`), so the shell DEFERS them (see `activeScope`). On a
  // CARD, Space reveals and 1–4 grade (after reveal) — exactly like the review
  // session — and these win over next/skip; on a non-card, Space is next/skip.
  const loopActive = desktop && !done;
  const processKeysActive = desktop && (!done || undoState !== null);
  useActiveScope("queue", loopActive);

  // The ambient gauge's reference line: the explicit ?target= box when valid, else the
  // configured daily minute budget. Drives the soft wrap-up nudge so EVERY entry path
  // (preview "Start", deep-link, reload) behaves consistently.
  const wrapUpReference =
    targetMinutes ??
    (minuteBudget && minuteBudget.targetMinutes > 0 ? minuteBudget.targetMinutes : undefined);

  const dismissWrapUp = useCallback(() => {
    setWrapUpVisible(false);
    setWrapUpDismissed(true);
  }, []);

  // Fire the "wrap up or keep going?" nudge ONCE when elapsed crosses the reference. A
  // single timeout (not a poll) avoids re-rendering the loop every tick; keep-going /
  // Esc suppresses it for the rest of the session. Never a hard stop.
  useEffect(() => {
    if (!loopActive || wrapUpReference == null || wrapUpDismissed || wrapUpShownRef.current) {
      return;
    }
    const fire = () => {
      wrapUpShownRef.current = true;
      setWrapUpVisible(true);
    };
    const remainingMs = wrapUpReference * 60_000 - (Date.now() - sessionStartedAtRef.current);
    if (remainingMs <= 0) {
      fire();
      return;
    }
    const handle = window.setTimeout(fire, remainingMs);
    return () => window.clearTimeout(handle);
  }, [loopActive, wrapUpReference, wrapUpDismissed]);

  // Esc dismisses the nudge as "keep going" (non-modal, no focus trap).
  useEffect(() => {
    if (!wrapUpVisible) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissWrapUp();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [wrapUpVisible, dismissWrapUp]);
  useProcessShortcuts(
    {
      canProcess: !done,
      next: skip,
      postpone: () => {
        if (busy) return;
        if (current?.type === "card") void act("postpone");
        else if (current) setPostponeMenuOpenSignal((n) => n + 1);
      },
      markDone: () => {
        if (busy) return;
        // A SOURCE routes Done through the intent surface (fetch → 0-unresolved fast path
        // or open the popover) by bumping its trigger signal — mirroring the Postpone menu.
        // Everything else (cards/extracts/topics) keeps the immediate, source-only-gate-free
        // markDone.
        if (current?.type === "source") setDoneIntentSignal((n) => n + 1);
        else void act("markDone");
      },
      dismiss: () => void act("dismiss"),
      // Delete routes through the descendant-aware intent menu (T135 / U7): a leaf
      // deletes quietly, a node with live descendants opens the menu. Bumping the
      // trigger signal runs the exact same flow the Delete button does.
      delete: requestDelete,
      raise: () => void act("raise"),
      lower: () => void act("lower"),
      open,
      canUndo: undoState !== null,
      undo: () => void undoLastProcessAction(),
      isCard: !!isCard,
      revealed,
      reveal: () => void reveal(),
      grade: (rating) => void grade(rating),
    },
    processKeysActive,
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

  const sessionControls: ProcessSessionControlsProps = {
    cursor,
    total,
    done,
    remaining,
    mode,
    // The source document heading rides in the toolbar row (replacing the old
    // .pq-source__header band). Gated on isRenderingSource (not deckLoading, not
    // done) so the loading/done panels never flash the prior source's title
    // mid-reload — same title expression the workbench used.
    itemTitle: isRenderingSource ? (inspector?.element.title ?? current?.title) : undefined,
    // The ambient minute gauge — hidden during a rebuild (deckLoading) so it never
    // flashes the prior deck's stale minutes (mirrors the itemTitle stale-flash guard).
    gauge: deckLoading
      ? undefined
      : {
          startedAt: sessionStartedAtRef.current,
          estimate: timeEstimate,
          reference: wrapUpReference,
          composition: dayComposition,
        },
    onModeChange,
    onEnd: () => navigate({ to: "/queue", search: asOf ? { asOf } : {} }),
  };

  // The source's "block N of M" resume location for the DoneIntentMenu — only when an
  // actual read-point exists (read-point = where, decoupled from due-date = when). Null
  // for a never-opened source or a non-source item.
  const sourceDoneProgress =
    current?.type === "source" ? sourceReadPoint.progress(doc.currentDoc) : null;
  const sourceDoneResumeLabel =
    current?.type === "source" && sourceReadPoint.readPoint && sourceDoneProgress
      ? resumeLabel(sourceDoneProgress.index + 1, sourceDoneProgress.total)
      : null;

  return (
    <div className="pq-shell" data-testid="route-process">
      {error ? (
        <p className="pq-error" data-testid="process-error">
          {error}
        </p>
      ) : null}

      <div className={centerClassName} data-testid="process-center">
        {deckLoading ? (
          <div className="q-panel pq-donepanel" data-testid="process-loading">
            <ProcessSessionControls {...sessionControls} />
            <div className="q-empty">
              <div className="q-empty__icon q-empty__icon--filter">
                <Icon name="queue" size={24} />
              </div>
              <h2 className="q-empty__title">Loading due queue</h2>
              <p className="q-empty__body">Checking scheduled work for today.</p>
            </div>
          </div>
        ) : done ? (
          <div className="q-panel pq-donepanel" data-testid="process-done">
            <ProcessSessionControls {...sessionControls} />
            <div className="q-empty">
              <div className="q-empty__icon">
                <Icon name="checkCircle" size={26} />
              </div>
              <h2 className="q-empty__title">{zeroLoad ? "No due items today" : "Queue clear"}</h2>
              {zeroLoad ? (
                <p className="q-empty__body">
                  There are no scheduled queue items due right now.
                  {dailyWork?.recommendedAction === "triage_inbox"
                    ? ` ${dailyWork.inboxSources} inbox source${dailyWork.inboxSources === 1 ? "" : "s"} still need triage.`
                    : dailyWork?.recommendedAction === "resume_unscheduled_source" &&
                        dailyWork.resumeSource
                      ? ` ${dailyWork.resumeSource.title} is active without a return date.`
                      : ""}
                </p>
              ) : newWorkAvailable > 0 ? (
                <p className="q-empty__body" data-testid="process-newwork">
                  You cleared the queue — {processed} item{processed === 1 ? "" : "s"} processed.{" "}
                  {newWorkAvailable} new item{newWorkAvailable === 1 ? "" : "s"} arrived while you
                  worked.
                </p>
              ) : (
                <p className="q-empty__body">
                  You processed {processed} item{processed === 1 ? "" : "s"}, one at a time. Your
                  high-priority items are protected; the rest return when they're due.
                </p>
              )}
              <div className="pq-done__actions">
                {zeroLoad &&
                (dailyWork?.recommendedAction === "triage_inbox" ||
                  (dailyWork?.recommendedAction === "resume_unscheduled_source" &&
                    dailyWork.resumeSource)) ? (
                  <button
                    type="button"
                    className="sessionbar__start"
                    data-testid="process-next-work"
                    onClick={openRecommendedWork}
                  >
                    <Icon
                      name={dailyWork.recommendedAction === "triage_inbox" ? "inbox" : "source"}
                      size={14}
                    />
                    {dailyWork.recommendedAction === "triage_inbox"
                      ? "Triage inbox"
                      : "Resume source"}
                  </button>
                ) : null}
                {newWorkAvailable > 0 ? (
                  <button
                    type="button"
                    className="sessionbar__start"
                    data-testid="process-keep-going"
                    onClick={() => void rebuildDeck()}
                  >
                    <Icon name="play" size={14} />
                    Keep going
                  </button>
                ) : (
                  <button
                    type="button"
                    className="pq-btn"
                    data-testid="process-restart"
                    onClick={() => void rebuildDeck()}
                  >
                    <Icon name="review" size={14} />
                    Reload queue
                  </button>
                )}
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
            doc={doc}
            inspector={inspector}
            extractDraft={extractDraft}
            extractBuilder={extractBuilder}
            postponeMenuOpenSignal={postponeMenuOpenSignal}
            doneIntentSignal={doneIntentSignal}
            doneIntentResumeLabel={sourceDoneResumeLabel}
            onDoneIntentSummary={getDoneIntentSummary}
            onDoneIntentResolved={onDoneIntentResolved}
            cardView={cardView}
            revealed={revealed}
            previews={previews}
            busy={busy || lineageDelete.busy}
            canUndo={undoState !== null}
            onAction={act}
            deleteActions={lineageDelete.actions}
            deleteSignal={deleteSignal}
            onRequestDelete={requestDelete}
            onSchedule={schedule}
            onSkip={skip}
            onOpen={open}
            onExtractChange={onExtractChange}
            sourceReadPoint={sourceReadPoint}
            sourceSelectionPosition={sourceSelection.position}
            onSourceSelectionAction={onSourceSelectionAction}
            onSourceEditorReady={onSourceEditorReady}
            onSetSourceReadPoint={() => void setSourceReadPoint()}
            extractSelectionPosition={extractSelection.position}
            onExtractSelectionAction={onExtractSelectionAction}
            onExtractEditorReady={onExtractEditorReady}
            onSetExtractStage={setExtractStage}
            onTrimExtract={trimExtract}
            onSetExtractFate={setExtractFate}
            onOpenExtractBuilder={(tab) => setExtractBuilder({ tab })}
            onCloseExtractBuilder={() => setExtractBuilder(null)}
            onExtractCardCreated={onCardCreatedFromExtract}
            onToast={toast}
            onReveal={() => void reveal()}
            onGrade={(rating) => void grade(rating)}
            sessionControls={sessionControls}
          />
        ) : null}
      </div>
      {wrapUpVisible && !done ? (
        <div className="pq-wrapup" role="alert" data-testid="process-wrapup">
          <span className="pq-wrapup__text">
            You've spent about{" "}
            {Math.max(0, Math.round((Date.now() - sessionStartedAtRef.current) / 60000))} min
            {wrapUpReference != null ? ` of your ~${wrapUpReference} min target` : ""}. Wrap up or
            keep going?
          </span>
          <div className="pq-wrapup__actions">
            <button
              type="button"
              className="pq-btn"
              data-testid="process-wrapup-keep"
              onClick={dismissWrapUp}
            >
              <Icon name="play" size={13} />
              Keep going
            </button>
            <button
              type="button"
              className="sessionbar__start"
              data-testid="process-wrapup-end"
              onClick={() => navigate({ to: "/queue", search: asOf ? { asOf } : {} })}
            >
              <Icon name="return" size={13} />
              Wrap up
            </button>
          </div>
        </div>
      ) : null}
      {flash ? (
        <div className="reader-flash" data-testid="process-flash" role="status">
          <span className="extract-flash__pill">
            <Icon name="check" size={14} />
            {flash}
          </span>
        </div>
      ) : null}
      <AtomicExtractPrompt
        prompt={atomicPrompt}
        onConvert={openAtomicPrompt}
        onDismiss={() => setAtomicPrompt(null)}
      />
      {/* The visible Undo affordance for the destructive source intents (Finished / Abandon).
          Undo hits the SAME op as ⌘Z; auto-dismiss only clears the toast, so ⌘Z still works
          after it fades. Other loop actions stay silent (local ⌘Z only). */}
      <QueueSnackbar
        message={doneIntentSnackbar}
        onUndo={undoState ? () => void undoLastProcessAction() : undefined}
        onClose={dismissDoneIntentSnackbar}
      />

      {/* The descendant-aware delete outcome (T135 / U7). The branch-delete Undo restores
          the exact batch (order-independent), the leaf path uses the loop's own undo. */}
      <Snackbar
        message={lineageDelete.snackbar?.message ?? null}
        onUndo={lineageDelete.snackbar?.onUndo}
        onClose={() => lineageDelete.setSnackbar(null)}
        icon={lineageDelete.snackbar?.icon ?? "trash"}
        timeoutMs={lineageDelete.snackbar?.timeoutMs}
        testId="process-delete-snackbar"
      />
    </div>
  );
}

type ProcessSessionControlsProps = {
  cursor: number;
  total: number;
  done: boolean;
  remaining: number;
  mode: SessionMode;
  /** Source document heading, lifted into the toolbar row. Source items only;
      omitted/empty for every other type and the loading/done panels. */
  itemTitle?: string | undefined;
  /** The ambient minute gauge inputs (omitted while a rebuild is loading). */
  gauge?:
    | {
        startedAt: number;
        estimate: QueueTimeEstimate | null;
        reference: number | undefined;
        composition: QueueQuotaComposition | null;
      }
    | undefined;
  onModeChange: (mode: SessionMode) => void;
  onEnd: () => void;
};

function ProcessSessionControls({
  cursor,
  total,
  done,
  remaining,
  mode,
  itemTitle,
  gauge,
  onModeChange,
  onEnd,
}: ProcessSessionControlsProps) {
  const position = Math.min(cursor + (done ? 0 : 1), total);
  const fillPct = total === 0 ? 0 : (Math.min(cursor, total) / total) * 100;
  // Spoken progress: a single clean label so screen readers don't read "1 slash 3
  // middle dot 1 left". The visual count/separator/estimate are aria-hidden.
  const spokenProgress = done
    ? "Session complete"
    : `${position} of ${total}, ${remaining} remaining`;
  const title = itemTitle?.trim();
  return (
    <div className="pq-session" data-testid="process-session-controls">
      <div className="pq-session__row">
        <div className="pq-progress" data-testid="process-progress">
          <span className="pq-progress__sr">{spokenProgress}</span>
          <span className="pq-progress__count" aria-hidden>
            {position} / {total}
          </span>
          <span className="pq-progress__sep" aria-hidden>
            ·
          </span>
          <span className="pq-progress__est" aria-hidden>
            {done ? "all done" : `${remaining} left`}
          </span>
        </div>
        {gauge ? (
          <SessionGauge
            startedAt={gauge.startedAt}
            estimate={gauge.estimate}
            reference={gauge.reference}
            composition={gauge.composition}
            done={done}
          />
        ) : null}
        {title ? (
          <h1 className="pq-session__title" data-testid="process-session-title" title={title}>
            {title}
          </h1>
        ) : null}
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
        <button type="button" className="pq-end" data-testid="process-end" onClick={onEnd}>
          <Icon name="x" size={14} />
          End session
        </button>
      </div>
      <div className="pq-progress__bar" aria-hidden>
        <span className="pq-progress__fill" style={{ width: `${fillPct}%` }} />
      </div>
    </div>
  );
}

function asExtractStage(stage: string | null | undefined): ExtractStage {
  return EXTRACT_STAGES.includes(stage as ExtractStage) ? (stage as ExtractStage) : "raw_extract";
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

async function settleEditorInput(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function normalizePlainText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function visibleEditorPlainText(editor: Editor | null): string | null {
  const dom =
    (editor as { view?: { dom?: HTMLElement } } | null)?.view?.dom ??
    (document.querySelector(
      '[data-testid="process-extract-editor"] .ProseMirror',
    ) as HTMLElement | null);
  if (!dom) return null;
  return normalizePlainText(dom.innerText ?? dom.textContent ?? "");
}

function clearConsumedEditorSelection(editor: Editor | null): void {
  const selection = editor?.state?.selection;
  if (editor && selection) {
    editor.commands.setTextSelection(selection.to);
    editor.commands.blur();
  }
  if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
}

function plainTextToSimpleDoc(plainText: string, previousDoc: unknown): unknown {
  const existingIds = toBlockInputs(previousDoc).map((b) => b.stableBlockId);
  const paragraphs = plainText
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const content = (paragraphs.length > 0 ? paragraphs : [""]).map((text, index) => {
    const blockId = existingIds[index] ?? newProcessBlockId();
    return {
      type: "paragraph",
      attrs: { blockId },
      ...(text ? { content: [{ type: "text", text }] } : {}),
    };
  });
  return { type: "doc", content };
}

function newProcessBlockId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `process_${random}`;
}

/** A small interpunct dot separator for source metadata rows. */
function SourceMetaDot() {
  return <span className="pq-source__dot" aria-hidden />;
}

function ProcessSourceWorkbench({
  item,
  doc,
  readPoint,
  selectionPosition,
  onEditorReady,
  onSelectionAction,
}: {
  item: QueueItemSummary;
  doc: UseDocumentResult;
  readPoint: UseReadPointResult;
  selectionPosition: SelectionToolbarPosition | null;
  onEditorReady: (editor: Editor | null) => void;
  onSelectionAction: (action: SelectionToolbarAction) => void;
}) {
  const progress = readPoint.progress(doc.currentDoc);
  const progressPct = readPoint.progressFraction(doc.currentDoc) * 100;
  // Identity (title, author, URL, status, priority, scheduler) is owned by the
  // right-hand Inspector SOURCE column; the document heading now rides in the
  // session toolbar row (ProcessSessionControls.itemTitle). The workbench keeps
  // only the reading-position caption (see the redesign plan).
  const progressLabel =
    progress.total > 0
      ? `block ${Math.min(progress.index + 1, progress.total)} of ${progress.total} · ${Math.round(progressPct)}%`
      : "no readable blocks";

  if (doc.sourceFormat === "pdf" || doc.sourceFormat === "video") {
    return (
      <div className="pq-source" data-testid="process-source-workbench">
        <p className="pq-body__text pq-body__text--empty">
          This source uses a specialized reader. Open it in full to extract from pages, regions, or
          media timestamps.
        </p>
      </div>
    );
  }

  return (
    <div className="pq-source" data-testid="process-source-workbench">
      <div className="pq-source__rail" data-testid="process-source-rail">
        <div className="pbar pq-source__pbar" data-testid="process-source-pbar">
          <div
            className="pbar__fill"
            data-testid="process-source-pbar-fill"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        {/* Reading-position caption: the one piece of the old metadata row not
            owned by the Inspector. Rail-local, aligned to the text measure. */}
        <div className="pq-source__railmeta">
          <span className="pq-source__meta--mono" data-testid="process-source-progress">
            {progressLabel}
          </span>
          <SourceMetaDot />
          <span className="pq-source__meta--mono" data-testid="process-source-words">
            {wordCount(doc.plainText)} words
          </span>
        </div>

        <div className="pq-source__editor" data-testid="process-source-editor">
          {doc.status === "loading" ? (
            <p className="pq-body__text pq-body__text--empty">Loading source…</p>
          ) : doc.status === "error" ? (
            <p className="pq-error" data-testid="process-source-error">
              {doc.error ?? "Failed to load this source."}
            </p>
          ) : (
            <SourceEditor
              key={`${item.id}:${doc.status}`}
              initialDoc={doc.initialDoc}
              editable
              readerDecorations
              openLinksOnClick
              debounceMs={180}
              onChange={doc.save}
              onEditorReady={onEditorReady}
            />
          )}
        </div>
      </div>

      <SelectionToolbar
        position={selectionPosition}
        actions={PROCESS_SOURCE_SELECTION_ACTIONS}
        onAction={onSelectionAction}
      />
    </div>
  );
}

function ProcessExtractWorkbench({
  item,
  doc,
  inspector,
  draft,
  builder,
  busy,
  selectionPosition,
  onChange,
  onEditorReady,
  onSelectionAction,
  onSetStage,
  onTrim,
  onSetFate,
  onOpenBuilder,
  onCloseBuilder,
  onCardCreated,
  onToast,
}: {
  item: QueueItemSummary;
  doc: UseDocumentResult;
  inspector: InspectorData | null;
  draft: SourceEditorChange | null;
  builder: { tab: CardKind; clozeText?: string } | null;
  busy: boolean;
  selectionPosition: SelectionToolbarPosition | null;
  onChange: (change: SourceEditorChange) => void;
  onEditorReady: (editor: Editor | null) => void;
  onSelectionAction: (action: SelectionToolbarAction) => void;
  onSetStage: (stage?: ExtractStage) => void;
  onTrim: () => void;
  onSetFate: (fate: DirectExtractFate) => void;
  onOpenBuilder: (tab: CardKind) => void;
  onCloseBuilder: () => void;
  onCardCreated: () => void;
  onToast: (message: string) => void;
}) {
  const stage = asExtractStage(inspector?.element.stage ?? item.stage);
  const stageIdx = Math.max(0, EXTRACT_STAGES.indexOf(stage));
  const plainText = draft?.plainText ?? doc.plainText;
  const sourceTitle = inspector?.source?.title ?? item.sourceTitle;
  const sourceRef = inspector?.sourceRef ?? null;
  const hasSource = inspector?.location != null || inspector?.source != null;
  const extractFate = inspector?.element.extractFate ?? null;
  const canCreateCard = extractFate === null;

  return (
    <div className="pq-extract" data-testid="process-extract-workbench">
      <div className="pq-extract__top">
        <div className="pq-extract__source">
          {sourceTitle ? (
            <span className="pq-body__src">
              <Icon name="source" size={13} /> {sourceTitle}
            </span>
          ) : (
            <span className="pq-body__src pq-body__src--muted">
              <Icon name="source" size={13} /> No source title
            </span>
          )}
        </div>
        <button
          type="button"
          className="pq-btn pq-btn--primary"
          data-testid="process-extract-advance"
          disabled={busy || stageIdx >= EXTRACT_STAGES.length - 1}
          onClick={() => onSetStage()}
        >
          <Icon name="sparkle" size={14} />
          Advance stage
        </button>
      </div>

      <div className="stage-stepper pq-stage-stepper" data-testid="process-extract-stage-stepper">
        {EXTRACT_STAGES.map((s, i) => (
          <div className="stage-step" key={s}>
            <button
              type="button"
              className="stage-step__btn"
              data-testid={`process-extract-stage-${s}`}
              data-active={i === stageIdx ? "true" : "false"}
              data-done={i <= stageIdx ? "true" : "false"}
              disabled={busy}
              onClick={() => onSetStage(s)}
            >
              <span className="stage-step__num" data-on={i <= stageIdx ? "true" : "false"}>
                {i + 1}
              </span>
              <span className="stage-step__label" data-current={i === stageIdx ? "true" : "false"}>
                {stageLabel(s)}
              </span>
            </button>
            {i < EXTRACT_STAGES.length - 1 ? (
              <span className="stage-step__line" data-done={i < stageIdx ? "true" : "false"} />
            ) : null}
          </div>
        ))}
      </div>

      {sourceRef ? (
        <div className="pq-extract__ref">
          <RefBlock
            ref={sourceRef}
            dedupeSnippetAgainst={plainText}
            testId="process-extract-refblock"
          />
        </div>
      ) : null}

      <div className="pq-extract__editor" data-testid="process-extract-editor">
        {doc.status === "loading" ? (
          <p className="pq-body__text pq-body__text--empty">Loading extract…</p>
        ) : doc.status === "error" ? (
          <p className="pq-error" data-testid="process-extract-error">
            {doc.error ?? "Failed to load this extract."}
          </p>
        ) : (
          <SourceEditor
            key={`${item.id}:${doc.status}`}
            initialDoc={doc.initialDoc}
            editable
            readerDecorations
            debounceMs={120}
            onChange={onChange}
            onEditorReady={onEditorReady}
          />
        )}
        <div className="pq-extract__meta">
          <span>{wordCount(plainText)} words</span>
        </div>
      </div>

      <div className="pq-extract__tools" data-testid="process-extract-tools">
        <button
          type="button"
          className="pq-btn"
          data-testid="process-extract-trim"
          disabled={busy}
          onClick={onTrim}
        >
          <Icon name="trim" size={14} />
          Trim
        </button>
        <button
          type="button"
          className="pq-btn"
          data-testid="process-extract-fate-reference"
          disabled={busy}
          onClick={() => onSetFate("reference")}
        >
          <Icon name="bookmark" size={14} />
          Reference
        </button>
        <button
          type="button"
          className="pq-btn"
          data-testid="process-extract-fate-done-without-card"
          disabled={busy}
          onClick={() => onSetFate("done_without_card")}
        >
          <Icon name="checkCircle" size={14} />
          Done without card
        </button>
        <span className="pq-extract__toolspacer" />
        <button
          type="button"
          className="pq-btn pq-btn--primary"
          data-testid="process-extract-make-qa"
          disabled={busy || !canCreateCard}
          title={canCreateCard ? undefined : "Reactivate this extract before creating a card"}
          onClick={() => onOpenBuilder("qa")}
        >
          <Icon name="card" size={14} />
          Make Q&amp;A
        </button>
        <button
          type="button"
          className="pq-btn"
          data-testid="process-extract-make-cloze"
          disabled={busy || !canCreateCard}
          title={canCreateCard ? undefined : "Reactivate this extract before creating a card"}
          onClick={() => onOpenBuilder("cloze")}
        >
          <Icon name="sparkle" size={14} />
          Make cloze
        </button>
      </div>

      {builder ? (
        <div className="pq-extract__builder" data-testid="process-extract-builder">
          <CardBuilder
            key={`${item.id}:${builder.tab}`}
            extractId={item.id}
            extractPriority={item.priority}
            hasSource={hasSource}
            {...(inspector?.provenance?.publishedAt != null
              ? { sourceDate: inspector.provenance.publishedAt }
              : {})}
            seedBody={plainText}
            initialTab={builder.tab}
            {...(builder.clozeText !== undefined ? { initialClozeText: builder.clozeText } : {})}
            onToast={onToast}
            onCardCreated={onCardCreated}
            onClose={onCloseBuilder}
          />
        </div>
      ) : null}

      <SelectionToolbar
        position={selectionPosition}
        actions={EXTRACT_SELECTION_ACTIONS}
        onAction={onSelectionAction}
      />
    </div>
  );
}

/** The one-at-a-time process surface for the current item. */
function ProcessCard({
  item,
  doc,
  inspector,
  extractDraft,
  extractBuilder,
  postponeMenuOpenSignal,
  doneIntentSignal,
  doneIntentResumeLabel,
  onDoneIntentSummary,
  onDoneIntentResolved,
  cardView,
  revealed,
  previews,
  busy,
  canUndo,
  onAction,
  deleteActions,
  deleteSignal,
  onRequestDelete,
  onSchedule,
  onSkip,
  onOpen,
  onExtractChange,
  sourceReadPoint,
  sourceSelectionPosition,
  onSourceSelectionAction,
  onSourceEditorReady,
  onSetSourceReadPoint,
  extractSelectionPosition,
  onExtractSelectionAction,
  onExtractEditorReady,
  onSetExtractStage,
  onTrimExtract,
  onSetExtractFate,
  onOpenExtractBuilder,
  onCloseExtractBuilder,
  onExtractCardCreated,
  onToast,
  onReveal,
  onGrade,
  sessionControls,
}: {
  item: QueueItemSummary;
  doc: UseDocumentResult;
  inspector: InspectorData | null;
  extractDraft: SourceEditorChange | null;
  extractBuilder: { tab: CardKind; clozeText?: string } | null;
  postponeMenuOpenSignal: number;
  /** Bumped by the `d` key to run the DoneIntentMenu trigger logic for a SOURCE. */
  doneIntentSignal: number;
  /** The source's "block N of M" resume location, or null when there is no read-point. */
  doneIntentResumeLabel: string | null;
  /** Fetch the source's block summary for DoneIntentMenu; null aborts silently. */
  onDoneIntentSummary: () => Promise<SourceBlockProcessingSummaryPayload | null>;
  /** Apply a chosen done-intent (Finished / Return later / Abandon). */
  onDoneIntentResolved: (intent: DoneIntent) => void;
  /** The full reveal-ready view for a CARD item (fetched by id), or null. */
  cardView: ReviewCardView | null;
  revealed: boolean;
  previews: Record<ReviewRating, ReviewIntervalPreview> | null;
  busy: boolean;
  canUndo: boolean;
  onAction: (kind: LoopActionKind) => void;
  /** The shared descendant-aware delete controller (T135 / U7) for the Delete action. */
  deleteActions: LineageDeleteActions;
  /** Bumped by the `delete` key to run the Delete intent flow from the keyboard. */
  deleteSignal: number;
  /** Run the Delete intent flow from the overflow menu's Delete item (same flow as the key). */
  onRequestDelete: () => void;
  /** Explicit (tomorrow/next-week/next-month/manual) scheduling — attention items only. */
  onSchedule: (choice: QueueScheduleChoice) => void;
  onSkip: () => void;
  onOpen: () => void;
  onExtractChange: (change: SourceEditorChange) => void;
  sourceReadPoint: UseReadPointResult;
  sourceSelectionPosition: SelectionToolbarPosition | null;
  onSourceSelectionAction: (action: SelectionToolbarAction) => void;
  onSourceEditorReady: (editor: Editor | null) => void;
  onSetSourceReadPoint: () => void;
  extractSelectionPosition: SelectionToolbarPosition | null;
  onExtractSelectionAction: (action: SelectionToolbarAction) => void;
  onExtractEditorReady: (editor: Editor | null) => void;
  onSetExtractStage: (stage?: ExtractStage) => void;
  onTrimExtract: () => void;
  onSetExtractFate: (fate: DirectExtractFate) => void;
  onOpenExtractBuilder: (tab: CardKind) => void;
  onCloseExtractBuilder: () => void;
  onExtractCardCreated: () => void;
  onToast: (message: string) => void;
  onReveal: () => void;
  onGrade: (rating: ReviewRating) => void;
  sessionControls: ProcessSessionControlsProps;
}) {
  const isCard = item.type === "card";
  const isExtract = item.type === "extract";
  const isSource = item.type === "source";
  const isWorkbench = isExtract || isSource;
  // FSRS chip signals for the card — derived once, reused by the header chip and the footer
  // recall readout (falls back to the trimmed queue signals while the card view loads).
  const cardSig: SchedulerSignals = cardView ? cardChipSignals(cardView) : chipSignals(item);

  // Publish this item's action keys into the shell status bar (statusHint.tsx)
  // instead of a second footer row inside the scrolling card — reclaiming a line
  // of reading space. Cleared on unmount so the hint never outlives the session.
  const { setHint } = useStatusHint();
  const sessionHint = useMemo<ReactNode>(
    () =>
      isCard ? (
        <>
          <kbd>␣</kbd> reveal · <kbd>1</kbd>–<kbd>4</kbd> grade · <kbd>d</kbd> done · <kbd>x</kbd>{" "}
          dismiss · <kbd>o</kbd> open · <kbd>n</kbd> next
          {canUndo ? (
            <>
              {" "}
              · <kbd>⌘Z</kbd> undo
            </>
          ) : null}
        </>
      ) : (
        <>
          <kbd>d</kbd> done · <kbd>p</kbd> postpone · <kbd>x</kbd> dismiss · <kbd>+</kbd>/
          <kbd>-</kbd> priority · <kbd>o</kbd> open · <kbd>n</kbd> next
          {canUndo ? (
            <>
              {" "}
              · <kbd>⌘Z</kbd> undo
            </>
          ) : null}
        </>
      ),
    [isCard, canUndo],
  );
  useEffect(() => {
    setHint(sessionHint);
    return () => setHint(null);
  }, [sessionHint, setHint]);

  return (
    <div
      className={`pq-card fade-up${isWorkbench ? " pq-card--workbench" : ""}${isSource ? " pq-card--source" : ""}${isExtract ? " pq-card--extract" : ""}${isCard ? " pq-card--review" : ""}${extractBuilder ? " pq-card--builder" : ""}`}
      data-testid="process-item"
      data-element-id={item.id}
      data-element-type={item.type}
      key={item.id}
    >
      <ProcessSessionControls {...sessionControls} />

      {/* metadata row — cards carry their identity inside the .pq-rc header instead */}
      {!isSource && !isCard ? (
        <>
          <div className="pq-card__meta">
            <div className="pq-card__chips">
              <TypeIcon type={item.type} lg />
              <Prio priority={item.priority} />
              {item.type === "extract" ? <Stage stage={item.stage} /> : null}
            </div>
            {/* This row only renders for non-card attention items now (cards carry their
                identity in the .pq-rc header), so the attention chip is the only case. */}
            <SchedulerChip scheduler={chipSignals(item)} />
          </div>

          <h1 className="pq-card__title">{titleFor(item)}</h1>
        </>
      ) : null}

      {isCard ? (
        <div className="pq-rc-center">
          {/* Three-zone review card: pinned header / scrolling body / pinned grade footer.
              Only `.pq-rc__body` scrolls, so the grades stay reachable at any content size. */}
          <article className="pq-rc" data-testid="process-card-face">
            {/* ---- pinned identity header (cards carry their meta here, not in pq-card__meta) ---- */}
            <header className="pq-rc__head">
              <div className="pq-rc__ident">
                <TypeIcon type={item.type} lg />
                <div className="pq-rc__idtext">
                  <div className="pq-rc__kindline">
                    <span className="pq-rc__kind">
                      {item.cardType === "cloze" ? "Cloze" : "Q&A"}
                    </span>
                    <span className="pq-rc__name">· {maskCloze(item.title)}</span>
                  </div>
                  <div className="pq-rc__sub">
                    <Prio priority={item.priority} />
                    {cardView?.leech ? (
                      <span className="badge badge--leech" data-testid="process-card-leech">
                        Leech · {cardView.lapses} lapses
                      </span>
                    ) : null}
                    {cardView?.sourceLocationLabel ? (
                      <span className="pq-rc__crumb">
                        <Icon name="extract" size={12} /> from extract ·{" "}
                        {cardView.sourceLocationLabel}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              {/* Cards carry the FSRS chip; the inspector owns the full three-stat readout. */}
              <div className="pq-rc__state">
                <SchedulerChip scheduler={cardSig} />
                {item.dueLabel ? <span className="pq-rc__due">{item.dueLabel}</span> : null}
              </div>
            </header>

            {/* ---- scrolling body (the ONLY scroll region) ---- */}
            <div className="pq-rc__body">
              <section>
                <span className="pq-rc__eyebrow">Prompt</span>
                <p className="pq-rc__prompt" data-testid="process-card-prompt">
                  {cardView ? (
                    <CardFront card={cardView} revealed={false} />
                  ) : (
                    maskCloze(item.title)
                  )}
                </p>
              </section>

              {revealed && cardView ? (
                <div className="pq-rc__answerwrap" data-testid="process-card-answer">
                  <div className="pq-rc__rule" />
                  <section>
                    <span className="pq-rc__eyebrow">Answer</span>
                    <div className="pq-rc__answer">
                      {cardView.kind === "cloze" ? (
                        <CardFront card={cardView} revealed={true} />
                      ) : (
                        // T072: render the Q&A answer through the shared body renderer so
                        // math + highlighted code show here too (same path as ReviewScreen).
                        <CardBody body={cardView.answer ?? ""} />
                      )}
                    </div>
                  </section>

                  {/* Source provenance (T043) — shown ONLY after reveal so it can't leak the
                      answer. Bounded section: the excerpt scrolls inside its own cap when large.
                      Reuses the shared RefBlock + formatSourceRef. */}
                  {cardView.sourceRef ? (
                    <section>
                      <span className="pq-rc__eyebrow">Source</span>
                      <div className="pq-rc__source">
                        <RefBlock
                          ref={cardView.sourceRef}
                          dedupeSnippetAgainst={cardView.kind === "qa" ? cardView.answer : null}
                          testId="process-card-refblock"
                        />
                      </div>
                    </section>
                  ) : null}
                </div>
              ) : (
                <div className="pq-rc__revealwrap">
                  <button
                    type="button"
                    className="sessionbar__start pq-reveal"
                    data-testid="process-card-reveal"
                    onClick={onReveal}
                  >
                    <Icon name="eye" size={14} />
                    Reveal answer <Kbd keys="␣" />
                  </button>
                </div>
              )}
            </div>

            {/* ---- pinned grade footer (rendered only after reveal so grades can't leak the
                    answer, and so a short card sizes to content with no footer) ---- */}
            {revealed && cardView ? (
              <footer className="pq-rc__foot">
                {/* The four FSRS grades with next-interval previews (1–4), exactly as the
                    review session. Grading records the durable review log + advances. */}
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
                {/* Compact, de-duplicated recall readout — the FSRS triple-stat box lives in
                    the Card inspector now; the card face keeps only this single mono line. */}
                <div className="pq-rc__recall" data-testid="process-card-recall">
                  <span>
                    <b>
                      {formatStability(cardSig.stability ?? 0)}
                      <span className="pq-rc__unit">d</span>
                    </b>{" "}
                    stability
                  </span>
                  <span className="pq-rc__sep" />
                  <span>
                    <b>
                      {formatDifficulty(cardSig.difficulty ?? 0)}
                      <span className="pq-rc__unit">/10</span>
                    </b>{" "}
                    difficulty
                  </span>
                  <span className="pq-rc__sep" />
                  <span>
                    <b>
                      {cardSig.retrievability === null
                        ? "—"
                        : `${Math.round(cardSig.retrievability * 100)}%`}
                    </b>{" "}
                    retrievability
                  </span>
                </div>
              </footer>
            ) : null}
          </article>
        </div>
      ) : isSource ? (
        <ProcessSourceWorkbench
          item={item}
          doc={doc}
          readPoint={sourceReadPoint}
          selectionPosition={sourceSelectionPosition}
          onEditorReady={onSourceEditorReady}
          onSelectionAction={onSourceSelectionAction}
        />
      ) : isExtract ? (
        <ProcessExtractWorkbench
          item={item}
          doc={doc}
          inspector={inspector}
          draft={extractDraft}
          builder={extractBuilder}
          busy={busy}
          selectionPosition={extractSelectionPosition}
          onChange={onExtractChange}
          onEditorReady={onExtractEditorReady}
          onSelectionAction={onExtractSelectionAction}
          onSetStage={onSetExtractStage}
          onTrim={onTrimExtract}
          onSetFate={onSetExtractFate}
          onOpenBuilder={onOpenExtractBuilder}
          onCloseBuilder={onCloseExtractBuilder}
          onCardCreated={onExtractCardCreated}
          onToast={onToast}
        />
      ) : (
        <div className="pq-body" data-testid="process-body">
          {(inspector?.source?.title ?? item.sourceTitle) ? (
            <div className="pq-body__src">
              <Icon name="source" size={13} /> {inspector?.source?.title ?? item.sourceTitle}
            </div>
          ) : null}
          {doc.plainText ? (
            <p className="pq-body__text">{doc.plainText.slice(0, 900)}</p>
          ) : (
            <p className="pq-body__text pq-body__text--empty">No body to preview for this item.</p>
          )}
        </div>
      )}

      {/* action bar — the same T030 actions, every one advances the cursor */}
      <div className="pq-actions" data-testid="process-actions">
        {/* The read-point lives in the action bar (not a header band) — the
            primary "I read to here" action for a text source. Text sources only;
            PDF/video have no inline read-point, cards/extracts have no read-point.
            Gate off the loading/error states (where the editor isn't shown) so it
            doesn't flash while a PDF/video source loads — its format resolves from
            null to pdf/video only after the doc read returns. */}
        {isSource &&
        doc.status !== "loading" &&
        doc.status !== "error" &&
        doc.sourceFormat === null ? (
          <button
            type="button"
            className="pq-btn pq-btn--primary"
            disabled={busy || sourceReadPoint.saving}
            data-testid="process-source-readpoint"
            onClick={onSetSourceReadPoint}
          >
            <Icon name="bookmark" size={14} />
            Set read-point
          </button>
        ) : null}
        <button
          type="button"
          className="pq-btn"
          disabled={busy}
          data-testid="process-action-open"
          onClick={onOpen}
        >
          <Icon name="external" size={14} />
          Open in full
        </button>
        <span className="pq-actions__spacer" />
        {/* Raise / Lower / Delete are used infrequently, so they collapse behind a
            single "⋯" overflow. The descendant-aware LineageDeleteMenu stays mounted
            with its trigger inert and overlaying the kebab (see .pq-overflow-host) so
            the leaf-quiet / branch-confirm flow stays authoritative and the confirm
            popover anchors under the ⋯ control. */}
        <span className="pq-overflow-host">
          <ProcessOverflowMenu busy={busy} onAction={onAction} onDelete={onRequestDelete} />
          <LineageDeleteMenu
            target={{ id: item.id, type: item.type, title: item.title }}
            actions={deleteActions}
            busy={busy}
            triggerSignal={deleteSignal}
            triggerClassName="pq-overflow__delete-anchor"
            triggerIcon="trash"
            triggerTestId="process-delete-anchor"
            tooltipLabel="Delete"
            triggerAriaLabel="Delete"
          />
        </span>
        {/* Non-card attention items use Postpone as the explicit reschedule menu
            (tomorrow/next-week/next-month/manual). Cards stay on FSRS, so their
            Postpone button remains the immediate queue action. */}
        {isCard ? (
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
        ) : (
          <ScheduleMenu
            disabled={busy}
            onSchedule={onSchedule}
            triggerClassName="pq-btn"
            triggerIcon="postpone"
            triggerLabel="Postpone"
            triggerTestId="process-action-postpone"
            openSignal={postponeMenuOpenSignal}
            tooltipLabel="Postpone"
            ariaLabel="Postpone until tomorrow, next week, next month, or a manual date"
          />
        )}
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
          className="pq-btn"
          disabled={busy}
          data-testid="process-action-skip"
          onClick={onSkip}
        >
          <Icon name="return" size={14} />
          Skip
        </button>
        {isSource ? (
          // A SOURCE routes Done through the non-modal intent surface (0-unresolved fast
          // path → immediate markDone with no popover; otherwise Finished / Return later /
          // Abandon). The server done-gate stays authoritative; this only collects intent.
          <DoneIntentMenu
            getSummary={onDoneIntentSummary}
            onResolved={onDoneIntentResolved}
            busy={busy}
            resumeLabel={doneIntentResumeLabel}
            triggerSignal={doneIntentSignal}
            triggerClassName="pq-btn pq-btn--done"
            triggerLabel="Done"
            triggerTestId="process-action-markDone"
          />
        ) : (
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
        )}
      </div>
    </div>
  );
}

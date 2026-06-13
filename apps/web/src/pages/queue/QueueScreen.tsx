/**
 * Daily Queue screen (T029) — the real `/queue`, replacing the placeholder.
 *
 * Rebuilt from the kit's `screen-queue.jsx` for React 19 + Tailwind v4: a page head
 * ("Daily Queue", N items due, est. minutes), an overload strip with the
 * `BudgetMeter` (items due vs the daily review budget) + at-risk metrics, a filter
 * `chip` row (All / Cards / Sources / Extracts / Tasks / High-priority, each with a
 * count), and the `qitem` list — each row showing the `TypeIcon`, title, a per-type
 * meta line, the load-bearing `SchedulerChip` (FSRS for cards, attention for the
 * rest), the `Prio` band, a due `Status` badge, a `next-action` pill, and the
 * `--protected` accent bar for A-priority items. A "Start session" button routes to
 * the T031 process loop (the `/review` placeholder until then).
 *
 * Data flows STRICTLY through the typed `window.appApi` bridge (the renderer never
 * touches SQLite): `queue.list({ types, concept, statuses })` returns the
 * already-sorted (priority-then-due-date), flat rows + counts + budget. The 10–20%
 * jitter is applied here as a STABLE, seeded shuffle (`jitterOrder`) so the order is
 * steady within a render but varies day to day. Clicking a row selects it in the
 * shell inspector; clicking its body / `next-action` opens it (source → reader,
 * extract → extract review, card → review when M7 lands).
 *
 * This component is pure UI orchestration — no SQL, no scheduling math, no priority
 * math (all of that is `packages/local-db` + `packages/scheduler` behind IPC).
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AutoPostponeReceiptLine } from "../../components/AutoPostponeReceiptLine";
import { Icon, type IconName } from "../../components/Icon";
import {
  formatAttentionScheduleReason,
  Prio,
  ScheduleReasonLine,
  SchedulerChip,
  TypeIcon,
} from "../../components/inspector/primitives";
import { LineageDeleteMenu } from "../../components/lineage/LineageDeleteMenu";
import {
  type LineageDeleteActions,
  useLineageDelete,
} from "../../components/lineage/useLineageDelete";
import {
  dismissNoticeUntil,
  isNoticeDismissed,
  NOTICE_DISMISSALS_KEY,
  type NoticeDismissals,
  ONE_WEEK_NOTICE_DISMISSAL_MS,
  parseNoticeDismissals,
} from "../../components/noticeDismissals";
import { BudgetMeter } from "../../components/queue/BudgetMeter";
import { type DoneIntent, DoneIntentMenu } from "../../components/queue/DoneIntentMenu";
import { QueueSnackbar } from "../../components/queue/QueueSnackbar";
import { listenQueueRefresh } from "../../components/queue/queueRefresh";
import { ScheduleMenu } from "../../components/queue/ScheduleMenu";
import { Snackbar } from "../../components/Snackbar";
import { Tooltip } from "../../components/Tooltip";
import { AutoVirtualList } from "../../components/VirtualList";
import "../../components/inspector/inspector.css";
import {
  appApi,
  type DailyWorkSummaryResult,
  isDesktop,
  type PriorityIntegrityGetResult,
  type QueueActAction,
  type QueueActUndo,
  type QueueItemSummary,
  type QueueListResult,
  type QueueScheduleChoice,
  type SchedulerSignals,
} from "../../lib/appApi";
import { formatQueueTimeEstimate } from "../../lib/queueTimeEstimate";
import { UNDO_EVENT } from "../../shell/nav";
import { useSelection } from "../../shell/selection";
import "./queue.css";
import { HelpLink } from "../../help/Contextual";
import { jitterOrder } from "./jitter";
import { OverloadBanner } from "./OverloadBanner";
import { openQueueItem } from "./openQueueItem";
import { actionFor, DueBadge, metaFor, titleFor } from "./queueRow";
import { RecoveryPanel } from "./RecoveryPanel";
import { SessionAssemblyPreview } from "./SessionAssemblyPreview";

/** The non-open queue actions a row exposes, with their icon + label (T030). */
type RowActionKind = QueueActAction["kind"];
const ROW_ACTIONS: readonly {
  kind: RowActionKind;
  icon: IconName;
  label: string;
  danger?: boolean;
}[] = [
  { kind: "postpone", icon: "postpone", label: "Postpone" },
  { kind: "raise", icon: "arrowUp", label: "Raise priority" },
  { kind: "lower", icon: "arrowDown", label: "Lower priority" },
  { kind: "markDone", icon: "check", label: "Mark done" },
  { kind: "dismiss", icon: "x", label: "Dismiss" },
  { kind: "delete", icon: "trash", label: "Delete", danger: true },
];

/** The filter chips, in kit order. `type` narrows by element type; `high` by band A. */
type FilterId = "all" | "card" | "source" | "extract" | "task" | "high";
const FILTERS: readonly { id: FilterId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "card", label: "Cards" },
  { id: "source", label: "Sources" },
  { id: "extract", label: "Extracts" },
  { id: "task", label: "Tasks" },
  { id: "high", label: "High priority" },
];

/**
 * The plural noun used in the filtered-empty heading ("No cards" / "No sources"…),
 * matching the (plural) filter chip labels rather than the raw singular FilterId so
 * the empty state never reads "No card items" / "No source items".
 */
const FILTER_EMPTY_NOUN: Record<Exclude<FilterId, "all">, string> = {
  card: "cards",
  source: "sources",
  extract: "extracts",
  task: "tasks",
  high: "high-priority items",
};

/**
 * The lifecycle-status filter (T029 Notes — "status filters are fully functional in
 * M5"). The due read already excludes done/dismissed/suspended/deleted, so the
 * meaningful split over the due set is freshly-pulled-in `active`/`pending` items vs
 * `scheduled` returns. `all` sends no `statuses` (the full due set). The selected
 * statuses are passed to `queue.list({ statuses })` — the narrowing happens
 * main-side in `QueueQuery.matchesFilters`, never in React.
 */
type StatusFilterId = "all" | "active" | "scheduled";
const STATUS_FILTERS: readonly {
  id: StatusFilterId;
  label: string;
  statuses?: readonly string[];
}[] = [
  { id: "all", label: "Any status" },
  { id: "active", label: "Active", statuses: ["active", "pending", "inbox"] },
  { id: "scheduled", label: "Scheduled", statuses: ["scheduled"] },
];

const PRIORITY_INTEGRITY_QUEUE_NOTICE_ID = "priorityIntegrity.queue";

/** Map a {@link DoneIntent} to the existing `queue.act` mutation for a source row. */
function actionForDoneIntent(intent: DoneIntent): QueueActAction {
  if (intent === "later") return { kind: "postpone" };
  if (intent === "abandon") return { kind: "dismiss" };
  return { kind: "markDone", confirmUnresolvedBlocks: true };
}

/** One queue row (the kit's `qitem`). */
function QueueItem({
  item,
  active,
  busy,
  onSelect,
  onOpen,
  onAction,
  deleteActions,
  onDismissRetirementSuggestion,
  onResolveDone,
  onSchedule,
}: {
  item: QueueItemSummary;
  active: boolean;
  /** Whether ANY queue action is in flight (every row's action buttons disable). */
  busy: boolean;
  onSelect: (item: QueueItemSummary) => void;
  onOpen: (item: QueueItemSummary) => void;
  onAction: (item: QueueItemSummary, kind: RowActionKind) => void;
  /**
   * The shared descendant-aware delete controller (T135 / U7). The row's `delete`
   * action routes through a {@link LineageDeleteMenu} so a node with live descendants
   * opens the intent menu instead of a silent single-row prune.
   */
  deleteActions: LineageDeleteActions;
  onDismissRetirementSuggestion: (item: QueueItemSummary) => void;
  /**
   * Resolve a source's "Done" intent (Finished / Return later / Abandon) chosen in the
   * {@link DoneIntentMenu}. Source rows route their `markDone` action through this rather than
   * the plain {@link onAction} so a partially-processed source gets the intent surface.
   */
  onResolveDone: (item: QueueItemSummary, intent: DoneIntent) => void;
  /** Explicit (tomorrow/next-week/next-month/manual) scheduling — attention items only. */
  onSchedule: (item: QueueItemSummary, choice: QueueScheduleChoice) => void;
}) {
  const scheduleReasonId = useId();
  const action = actionFor(item);
  // The per-type meta sub-line, matching the kit's `QueueItem` (one branch per
  // type so every row reads with real content before the SchedulerChip). `concept`
  // is null until T041; when there's NO preceding meta content the leading dot
  // separator is suppressed so we never render an orphan dot before the chip.
  const meta = metaFor(item);
  const hasLeadingMeta = meta !== null || item.concept !== null;
  // The chip reads the queue's trimmed signals as the inspector's wider shape.
  const chip: SchedulerSignals = {
    kind: item.schedulerSignals.kind,
    retrievability: item.schedulerSignals.retrievability,
    stability: item.schedulerSignals.stability,
    difficulty: null,
    reps: null,
    lapses: item.schedulerSignals.lapses,
    fsrsState: item.schedulerSignals.fsrsState,
    stage: item.schedulerSignals.stage,
    postponed: item.schedulerSignals.postponed,
    scheduleReason: item.schedulerSignals.scheduleReason ?? null,
    lastProcessedAt: null,
    retirementSuggestion: item.schedulerSignals.retirementSuggestion,
  };
  const scheduleReasonText = formatAttentionScheduleReason(chip);
  const retirementSuggestion = item.schedulerSignals.retirementSuggestion;
  const [retirementReviewSignal, setRetirementReviewSignal] = useState(0);
  // Stable per-row callbacks for the source Done intent surface (mirrors the useCallback
  // wiring at the other two call sites), so DoneIntentMenu's handleTrigger isn't
  // reconstructed on every parent render.
  const getDoneSummary = useCallback(
    () =>
      appApi
        .getBlockProcessingSummary({ sourceElementId: item.id })
        .then((r) => r.summary)
        .catch(() => null),
    [item.id],
  );
  const handleDoneResolved = useCallback(
    (intent: DoneIntent) => onResolveDone(item, intent),
    [item, onResolveDone],
  );
  // The row is a <div> hosting TWO independent zones (so real action buttons can
  // live in the row without nesting interactive elements, which is invalid HTML):
  //  - `qitem__open` is the click target that selects + OPENS the element (source →
  //    reader, extract → review, card → review). It is the only navigation path.
  //  - `qitem__acts` holds the in-place actions (postpone / raise / lower / done /
  //    dismiss / delete). Each is a real button whose click does NOT open the row.
  return (
    <div
      data-testid="queue-item"
      data-element-id={item.id}
      data-element-type={item.type}
      data-scheduler={item.scheduler}
      aria-current={active ? "true" : undefined}
      className={`qitem${item.protected ? " qitem--protected" : ""}${active ? " qitem--active" : ""}`}
    >
      <button
        type="button"
        className="qitem__open"
        data-testid="queue-open"
        aria-describedby={scheduleReasonText ? scheduleReasonId : undefined}
        onClick={() => {
          onSelect(item);
          onOpen(item);
        }}
      >
        <TypeIcon type={item.type} />
        <span className="qitem__main">
          <span className="qitem__title truncate">{titleFor(item)}</span>
          <span className="qitem__meta">
            {meta}
            {item.concept ? (
              <>
                {meta !== null ? <span className="dot-sep" /> : null}
                <span className="concept-tag">{item.concept}</span>
              </>
            ) : null}
            {hasLeadingMeta ? <span className="dot-sep" /> : null}
            <SchedulerChip scheduler={chip} />
            {item.fallowState ? (
              <>
                <span className="dot-sep" />
                <span
                  className={`qitem__fallow qitem__fallow--${item.fallowState}`}
                  data-testid="queue-fallow-badge"
                >
                  <Icon name="pause" size={12} />
                  {item.fallowState === "active" ? "Resting" : "Returned"}
                  {item.fallowReason ? ` · ${item.fallowReason}` : ""}
                </span>
              </>
            ) : null}
          </span>
          {scheduleReasonText ? (
            <ScheduleReasonLine
              id={scheduleReasonId}
              scheduler={chip}
              className="qitem__schedule-reason"
            />
          ) : null}
        </span>
        <span className="qitem__action">
          <Prio priority={item.priority} />
          <DueBadge item={item} />
          <span className="next-action">
            <Icon name={action.icon} size={12} />
            {action.label}
          </span>
        </span>
      </button>
      <span className="qitem__acts" data-testid="queue-actions">
        {/* Explicit reschedule (tomorrow/next-week/next-month/manual) — non-card
            attention items only (cards schedule on FSRS, never the attention seam). */}
        {item.type !== "card" ? (
          <ScheduleMenu disabled={busy} onSchedule={(choice) => onSchedule(item, choice)} />
        ) : null}
        {ROW_ACTIONS.map((a) =>
          // A SOURCE's "Mark done" routes through the non-modal DoneIntentMenu (the
          // partial-source intent surface): 0-unresolved marks done immediately (fast
          // path inside the menu); ≥1 unresolved opens a popover offering Finished /
          // Return later / Abandon. Non-source rows (and every other action) keep the
          // plain icon-button. The trigger keeps the row icon-button look + the
          // `queue-action-markDone` testid so existing tests/e2e still find it.
          a.kind === "markDone" && item.type === "source" ? (
            <DoneIntentMenu
              key={a.kind}
              getSummary={getDoneSummary}
              onResolved={handleDoneResolved}
              busy={busy}
              resumeLabel={null}
              triggerClassName="qitem__act"
              triggerIcon={a.icon}
              triggerTestId={`queue-action-${a.kind}`}
              tooltipLabel={a.label}
              triggerAriaLabel={a.label}
              forceOpenSignal={retirementReviewSignal}
              suggestedIntent={retirementSuggestion?.kind ?? null}
            />
          ) : a.kind === "delete" ? (
            // The row's Delete routes through the descendant-aware intent menu (T135 /
            // U7): a leaf deletes quietly; a node with live descendants opens the menu.
            // Keeps the row icon-button look + the `queue-action-delete` testid.
            <LineageDeleteMenu
              key={a.kind}
              target={{ id: item.id, type: item.type, title: item.title }}
              actions={deleteActions}
              busy={busy}
              triggerClassName="qitem__act qitem__act--danger"
              triggerIcon={a.icon}
              triggerTestId={`queue-action-${a.kind}`}
              tooltipLabel={a.label}
              triggerAriaLabel={a.label}
            />
          ) : (
            // Styled (portaled) tooltip in place of the slow native `title`; the
            // button keeps its `aria-label` as the accessible name. Suppressed while
            // busy (the buttons are disabled then — don't surface an affordance for a
            // control that can't be used).
            <Tooltip key={a.kind} label={a.label} disabled={busy}>
              <button
                type="button"
                disabled={busy}
                aria-label={a.label}
                data-testid={`queue-action-${a.kind}`}
                className={`qitem__act${a.danger ? " qitem__act--danger" : ""}`}
                onClick={() => onAction(item, a.kind)}
              >
                <Icon name={a.icon} size={14} />
              </button>
            </Tooltip>
          ),
        )}
        {retirementSuggestion ? (
          <span className="qitem__retirement" data-testid="queue-retirement-suggestion">
            <Tooltip label="Review done suggestion" disabled={busy}>
              <button
                type="button"
                disabled={busy}
                aria-label="Review done suggestion"
                data-testid="queue-retirement-review"
                className="qitem__retirement-btn"
                onClick={() => setRetirementReviewSignal((value) => value + 1)}
              >
                <Icon name="warning" size={13} />
                <span>Done?</span>
              </button>
            </Tooltip>
            <Tooltip label="Dismiss suggestion" disabled={busy}>
              <button
                type="button"
                disabled={busy}
                aria-label="Dismiss done suggestion"
                data-testid="queue-retirement-dismiss"
                className="qitem__retirement-icon"
                onClick={() => onDismissRetirementSuggestion(item)}
              >
                <Icon name="x" size={12} />
              </button>
            </Tooltip>
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function QueueScreen() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const { selectedId, select } = useSelection();
  // The queue route declares no `validateSearch`, so search is loosely typed. An
  // optional `asOf` date-scopes the due reads (used by the E2E to drive a fixed
  // clock; in normal use the read defaults to the server's "now"). An optional
  // `concept` narrows the read by concept NAME — the T029 deliverable wires this
  // param now so the documented filter surface is genuinely stable; the concept
  // filter CONTROL lands with T041 (the narrowing already runs main-side in
  // `QueueQuery.matchesFilters`, never in React).
  const search = useSearch({ strict: false }) as { asOf?: string; concept?: string };
  const asOf = typeof search.asOf === "string" ? search.asOf : undefined;
  const concept = typeof search.concept === "string" ? search.concept : undefined;
  const [data, setData] = useState<QueueListResult | null>(null);
  const [dailyWork, setDailyWork] = useState<DailyWorkSummaryResult | null>(null);
  const [priorityIntegrity, setPriorityIntegrity] = useState<PriorityIntegrityGetResult | null>(
    null,
  );
  const [priorityDismissals, setPriorityDismissals] = useState<NoticeDismissals>({});
  const [priorityDismissed, setPriorityDismissed] = useState(false);
  const [priorityDismissError, setPriorityDismissError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilterId>("all");
  const [sessionPreviewOpen, setSessionPreviewOpen] = useState(false);
  const activeStatuses = STATUS_FILTERS.find((s) => s.id === statusFilter)?.statuses;
  const activeTypes = useMemo(
    () => (filter !== "all" && filter !== "high" ? ([filter] as readonly string[]) : undefined),
    [filter],
  );
  const [error, setError] = useState<string | null>(null);
  /** The id of the row whose action is currently in flight (its buttons disable). */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Batch queue operations keep a snackbar because they are not simple row advancement. */
  const [batchUndoState, setBatchUndoState] = useState<{ message: string } | null>(null);
  /**
   * A destructive source "Done" intent (Finished / Abandon) raises a single-action Undo
   * snackbar with the row's own `queue.act` undo recipe — distinct from the batch snackbar
   * (which reverses through the command-level `undo.last`). Return later is non-destructive
   * (its `undo` recipe is null) and relies on the shell ⌘Z, so it raises no snackbar.
   */
  const [doneUndoState, setDoneUndoState] = useState<{
    id: string;
    message: string;
    undo: QueueActUndo;
  } | null>(null);
  const refreshRequestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      const requestId = refreshRequestId.current + 1;
      refreshRequestId.current = requestId;
      // The active status filter is passed THROUGH to the read so the narrowing
      // happens main-side (`QueueQuery.matchesFilters`), never in React. `all` sends
      // no `statuses` (the full due set). The `concept` param is forwarded too (when
      // present) so the documented T041 filter surface is genuinely wired end-to-end.
      const [queueResult, workResult, priorityResult, noticeResult] = await Promise.allSettled([
        appApi.listQueue({
          ...(asOf ? { asOf } : {}),
          ...(activeTypes ? { types: activeTypes } : {}),
          ...(activeStatuses ? { statuses: activeStatuses } : {}),
          ...(concept ? { concept } : {}),
          includeTimeEstimate: true,
        }),
        appApi.getDailyWorkSummary(asOf ? { asOf } : {}),
        appApi.getPriorityIntegrity(asOf ? { asOf } : undefined),
        appApi.getSettings({ key: NOTICE_DISMISSALS_KEY }),
      ]);
      if (refreshRequestId.current !== requestId) return;
      let nextError: string | null = null;
      if (queueResult.status === "fulfilled") {
        setData(queueResult.value);
      } else {
        setData(null);
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
      if (priorityResult.status === "fulfilled") {
        setPriorityIntegrity(priorityResult.value);
      } else {
        setPriorityIntegrity(null);
      }
      if (noticeResult.status === "fulfilled") {
        const parsedDismissals = parseNoticeDismissals(
          noticeResult.value.settings[NOTICE_DISMISSALS_KEY],
        );
        setPriorityDismissals(parsedDismissals);
        setPriorityDismissed(
          isNoticeDismissed(parsedDismissals, PRIORITY_INTEGRITY_QUEUE_NOTICE_ID),
        );
      }
      setError(nextError);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [asOf, activeTypes, activeStatuses, concept]);

  useEffect(() => {
    if (!priorityDismissed) return;
    const until = priorityDismissals[PRIORITY_INTEGRITY_QUEUE_NOTICE_ID]?.until;
    if (!until) return;
    const untilMs = Date.parse(until);
    if (!Number.isFinite(untilMs)) return;
    const delay = untilMs - Date.now();
    if (delay <= 0) {
      void refresh();
      return;
    }
    const timer = window.setTimeout(() => void refresh(), delay + 100);
    return () => window.clearTimeout(timer);
  }, [priorityDismissed, priorityDismissals, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Descendant-aware delete (T135 / U7) for the row `delete` action. A leaf deletes
  // quietly through the SAME `queue.act` `delete` op (preserving the existing undo); a
  // node with live descendants opens the intent menu. The branch-delete Undo restores
  // the exact batch (order-independent, KTD10). After any outcome the queue re-reads.
  const lineageDelete = useLineageDelete({
    quietDelete: async (target) => {
      await appApi.actOnQueueItem({ id: target.id, action: { kind: "delete" } });
    },
    onAfter: () => {
      void refresh();
    },
  });

  useEffect(() => {
    if (!desktop) return;
    return listenQueueRefresh(() => {
      void refresh();
    });
  }, [desktop, refresh]);

  useEffect(() => {
    if (!desktop) return;
    const onUndo = () => {
      void refresh();
    };
    window.addEventListener(UNDO_EVENT, onUndo);
    return () => window.removeEventListener(UNDO_EVENT, onUndo);
  }, [desktop, refresh]);

  // The sorted rows from the read, then the stable seeded jitter, then the active
  // filter. The read already sorted priority-then-due-date; jitter + filter are the
  // only presentation transforms.
  const visible = useMemo(() => {
    if (!data) return [] as QueueItemSummary[];
    const jittered = jitterOrder(data.items);
    if (filter === "all") return jittered;
    if (filter === "high") return jittered.filter((i) => i.protected);
    return jittered.filter((i) => i.type === filter);
  }, [data, filter]);

  const counts = data?.counts;
  const dueCount = counts?.all ?? 0;
  const estimateLabel = formatQueueTimeEstimate(data?.timeEstimate);
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const onSelect = useCallback(
    (item: QueueItemSummary) => {
      const targetType =
        item.type === "task" && item.linkedElementId ? item.linkedElementType : item.type;
      const targetId =
        item.type === "task" && item.linkedElementId ? item.linkedElementId : item.id;
      select(targetType === "card" ? null : targetId);
    },
    [select],
  );

  const onOpen = useCallback(
    (item: QueueItemSummary) => {
      openQueueItem({ item, navigate, select, asOf });
    },
    [navigate, select, asOf],
  );

  const startSession = useCallback(() => {
    if (!dailyWork) return;
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
      return;
    }
    if (dailyWork?.recommendedAction === "clear" && (dailyWork.dueQueueItems ?? dueCount) === 0) {
      void navigate({ to: "/inbox" });
      return;
    }
    setSessionPreviewOpen(true);
  }, [navigate, select, dailyWork, dueCount]);

  /**
   * Apply one in-place queue action through the SAME typed `appApi` mutation path
   * (T030). postpone / raise / lower update the row in place (the read re-sorts);
   * markDone / dismiss / delete remove it. No navigation happens — only the explicit
   * "open" navigates. The whole queue is re-read after the mutation so the sort +
   * counts + budget stay authoritative. The mutation remains command-logged, so the
   * shell-level ⌘Z can still restore it without a per-row snackbar.
   */
  const onAction = useCallback(
    async (item: QueueItemSummary, kind: RowActionKind) => {
      if (!isDesktop() || busyId) return;
      setBusyId(item.id);
      try {
        await appApi.actOnQueueItem({ id: item.id, action: { kind } });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, refresh],
  );

  /**
   * Resolve a source's "Done" intent chosen in the {@link DoneIntentMenu} (T-partial-source).
   * The three intents map 1:1 to existing `queue.act` mutations: Finished → `markDone` with the
   * server gate's `confirmUnresolvedBlocks` override, Return later → `postpone`, Abandon →
   * `dismiss`. Same re-read-after-action model as {@link onAction} (the row leaves on refresh);
   * `busyId` is set only HERE (on submit), never when the surface merely opens, so opening the
   * menu on one row leaves every other row's actions usable (the surface is truly non-modal).
   * Finished / Abandon return an undo recipe → raise the single-action Undo snackbar; Return
   * later returns `undo:null` and relies on the shell ⌘Z.
   */
  const onResolveDone = useCallback(
    async (item: QueueItemSummary, intent: DoneIntent) => {
      if (!isDesktop() || busyId) return;
      setBusyId(item.id);
      try {
        const action = actionForDoneIntent(intent);
        const res = await appApi.actOnQueueItem({ id: item.id, action });
        if (res.undo) {
          setDoneUndoState({
            id: item.id,
            message: intent === "abandon" ? "Source abandoned" : "Source done",
            undo: res.undo,
          });
        }
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, refresh],
  );

  const onDismissRetirementSuggestion = useCallback(
    async (item: QueueItemSummary) => {
      const suggestion = item.schedulerSignals.retirementSuggestion;
      if (!isDesktop() || busyId || !suggestion) return;
      setBusyId(item.id);
      try {
        const result = await appApi.dismissSourceRetirementSuggestion({
          sourceElementId: item.id,
          signalHash: suggestion.signalHash,
        });
        await refresh();
        if (result.stale) {
          setError("Source changed; refreshed the done suggestion.");
        } else {
          setError(null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, refresh],
  );

  /**
   * Schedule a non-card attention item for an EXPLICIT return (T028) — tomorrow /
   * next week / next month / a manual date — through the typed `queue.schedule`
   * surface, then re-read the queue (the item usually recedes from the due set). The
   * scheduling math lives main-side; the renderer only sends the intent.
   */
  const onSchedule = useCallback(
    async (item: QueueItemSummary, choice: QueueScheduleChoice) => {
      if (!isDesktop() || busyId) return;
      setBusyId(item.id);
      try {
        await appApi.scheduleQueueItem({ id: item.id, choice });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [busyId, refresh],
  );

  /**
   * Undo the last batch queue action through the command log, then re-read the queue.
   * Per-row lifecycle actions intentionally rely on the shell-level ⌘Z path instead
   * of showing a snackbar on every row transition.
   */
  const onUndo = useCallback(async () => {
    const pending = batchUndoState;
    setBatchUndoState(null);
    if (!pending || !isDesktop()) return;
    try {
      await appApi.undoLast();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [batchUndoState, refresh]);

  /**
   * Undo a source "Done" intent (Finished / Abandon) through the row's own `queue.act` undo
   * recipe, then re-read the queue (the restored row reappears). Hits the same op as the shell
   * ⌘Z, so both paths restore the prior status + `due_at`.
   */
  const onUndoDone = useCallback(async () => {
    const pending = doneUndoState;
    setDoneUndoState(null);
    if (!pending || !isDesktop()) return;
    try {
      await appApi.undoQueueAction({ id: pending.id, undo: pending.undo });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [doneUndoState, refresh]);

  /**
   * After a successful overload auto-postpone (T077): re-read the queue (the sweep moved N
   * items out of the due set) and raise a "Postponed N · Undo" snackbar. Undo reverses the
   * whole batch through the general command-level `undo.last`.
   */
  const onPostponed = useCallback(
    (count: number) => {
      void refresh();
      if (count > 0) {
        setBatchUndoState({
          message: `Postponed ${count} low-priority item${count === 1 ? "" : "s"}`,
        });
      }
    },
    [refresh],
  );

  /**
   * After a successful catch-up or vacation apply (T078): re-read the queue (the plan moved /
   * suspended items) and raise a "… N · Undo" snackbar. Undo reverses the whole batch through
   * the general command-level `undo.last` (restoring both due fields + any suspended status).
   */
  const onRecoveryApplied = useCallback(
    (label: string, count: number) => {
      void refresh();
      if (count > 0) {
        setBatchUndoState({
          message: `${label} ${count} item${count === 1 ? "" : "s"}`,
        });
      }
    },
    [refresh],
  );

  const viewPriorityIntegrity = useCallback(() => {
    void navigate({ to: "/analytics", hash: "priority-integrity" });
  }, [navigate]);

  const hidePriorityIntegrityForWeek = useCallback(async () => {
    const until = new Date(Date.now() + ONE_WEEK_NOTICE_DISMISSAL_MS).toISOString();
    const next = dismissNoticeUntil(priorityDismissals, PRIORITY_INTEGRITY_QUEUE_NOTICE_ID, until);
    try {
      await appApi.updateSetting({ key: NOTICE_DISMISSALS_KEY, value: next });
      setPriorityDismissals(next);
      setPriorityDismissed(true);
      setPriorityDismissError(null);
    } catch {
      setPriorityDismissError("Could not save that dismissal.");
    }
  }, [priorityDismissals]);

  if (!desktop) {
    return (
      <div
        className="flex h-full min-h-full flex-col items-center justify-center gap-3 px-7 py-8 text-center"
        data-testid="route-queue"
      >
        <div className="grid size-12 place-items-center rounded-lg bg-accent-soft text-accent-text">
          <Icon name="queue" size={26} />
        </div>
        <h1 className="font-semibold text-2xl text-text tracking-tight">Daily Queue</h1>
        <p className="max-w-sm text-base text-text-2">
          The queue reads due items through the desktop bridge — open the Electron app to process
          your day.
        </p>
      </div>
    );
  }

  const primaryLabel =
    dailyWork?.recommendedAction === "triage_inbox"
      ? "Triage inbox"
      : dailyWork?.recommendedAction === "resume_unscheduled_source"
        ? "Resume source"
        : dailyWork?.recommendedAction === "clear"
          ? "Open inbox"
          : "Start session";
  const primaryIcon =
    dailyWork?.recommendedAction === "triage_inbox"
      ? "inbox"
      : dailyWork?.recommendedAction === "resume_unscheduled_source"
        ? "source"
        : dailyWork?.recommendedAction === "clear"
          ? "inbox"
          : "play";
  const sessionNote =
    dailyWork?.recommendedAction === "triage_inbox"
      ? `${dailyWork.inboxSources} inbox source${dailyWork.inboxSources === 1 ? "" : "s"} awaiting triage.`
      : dailyWork?.recommendedAction === "resume_unscheduled_source" && dailyWork.resumeSource
        ? `Resume ${dailyWork.resumeSource.title}.`
        : dailyWork?.recommendedAction === "clear"
          ? "No due queue or inbox work right now."
          : "Process one item at a time — sorted by priority, then due date.";
  const hasActiveFilters = filter !== "all" || statusFilter !== "all" || concept !== undefined;
  const priorityFlags = priorityIntegrity?.thresholdFlags;
  const showPriorityIntegrityWarning =
    Boolean(
      priorityFlags?.aBandInflation ||
        priorityFlags?.aBandDeferredRecently ||
        priorityFlags?.postponeDebtHigh,
    ) && !priorityDismissed;
  const priorityReason = priorityFlags?.aBandDeferredRecently
    ? "A-priority work was deferred in this window."
    : priorityFlags?.postponeDebtHigh
      ? "Postponed work has accumulated priority debt."
      : "A-priority items are taking a large share of the live queue.";

  return (
    <div className="q-page" data-testid="route-queue">
      <div className="q-pad">
        <div className="q-head">
          <div>
            <h1 className="q-title">
              Daily Queue <HelpLink slug="daily-loop" />
            </h1>
            <p className="q-sub" data-testid="queue-subtitle">
              {data ? (
                <>
                  {today} · {dueCount} item{dueCount === 1 ? "" : "s"} due
                  {estimateLabel ? (
                    <>
                      {" "}
                      · est.{" "}
                      <span>
                        {estimateLabel.text}
                        <span className="sr-only"> {estimateLabel.ariaLabel}</span>
                      </span>
                    </>
                  ) : null}
                </>
              ) : (
                today
              )}
            </p>
          </div>
        </div>

        {error ? (
          <p className="q-sub" data-testid="queue-error" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        {showPriorityIntegrityWarning ? (
          <div className="q-priority" data-testid="queue-priority-integrity">
            <div className="q-priority__icon">
              <Icon name="warning" size={15} />
            </div>
            <div className="q-priority__body">
              <div className="q-priority__title">Priority integrity needs attention</div>
              <div className="q-priority__text">{priorityReason}</div>
              {priorityDismissError ? (
                <div className="q-priority__error" data-testid="queue-priority-dismiss-error">
                  {priorityDismissError}
                </div>
              ) : null}
            </div>
            <div className="q-priority__actions">
              <button
                type="button"
                className="q-priority__button"
                data-testid="queue-priority-view-analytics"
                onClick={viewPriorityIntegrity}
              >
                <Icon name="analytics" size={13} />
                View analytics
              </button>
              <button
                type="button"
                className="q-priority__icon-button"
                data-testid="queue-priority-hide-week"
                aria-label="Hide priority integrity warning for a week"
                onClick={hidePriorityIntegrityForWeek}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          </div>
        ) : null}

        {/* overload-management strip: budget meter + at-risk metrics */}
        <div className="q-panel q-panel-pad q-overload" style={{ marginBottom: 14 }}>
          <BudgetMeter
            used={data?.minuteBudget?.usedMinutes ?? data?.budget.used ?? 0}
            target={data?.minuteBudget?.targetMinutes ?? data?.budget.target ?? 0}
            confidence={data?.minuteBudget?.confidence ?? "learned"}
            composition={data?.dayComposition}
          />
          <div className="q-overload__div" />
          <div className="q-metrics">
            <div className="q-metric">
              <span className="q-metric__v">{counts?.all ?? 0}</span>
              <span className="q-metric__l">due today</span>
            </div>
            <div className="q-metric">
              <span
                className={`q-metric__v${counts?.overdue ? " q-metric__v--danger" : ""}`}
                data-testid="queue-overdue-count"
              >
                {counts?.overdue ?? 0}
              </span>
              <span className="q-metric__l">overdue</span>
            </div>
            <div className="q-metric">
              <span className="q-metric__v" data-testid="queue-protected-count">
                {counts?.protected ?? 0}
              </span>
              <span className="q-metric__l">protected</span>
            </div>
          </div>
        </div>

        {/* overload valve (T077): when the due load exceeds today's budget, offer an
            auto-postpone of the lowest-priority topics + mature cards (high-priority fragile
            cards are protected). The preview shows the cost before committing. */}
        {data && filter !== "high" ? (
          <OverloadBanner
            used={data.minuteBudget?.usedMinutes ?? data.budget.used}
            target={data.minuteBudget?.targetMinutes ?? data.budget.target}
            confidence={data.minuteBudget?.confidence ?? "learned"}
            {...(asOf ? { asOf } : {})}
            filters={{
              ...(activeTypes ? { types: activeTypes } : {}),
              ...(activeStatuses ? { statuses: activeStatuses } : {}),
              ...(concept ? { concept } : {}),
            }}
            onPostponed={onPostponed}
          />
        ) : null}

        <AutoPostponeReceiptLine
          receipt={dailyWork?.autoPostponeReceipt ?? null}
          onUndo={async (batchId) => {
            const result = await appApi.undoDailyWorkAutoPostponeReceipt({ batchId });
            if (result.undone) await refresh();
            return result;
          }}
        />

        {/* catch-up & vacation (T078): recover from a backlog (spread overdue forward) or
            pre-adjust the away-window load — BOTH show the cost (the before/after per-day load
            curve + what slips) before committing. Always available; the planning + spread math
            lives main-side (pure `planCatchUp`/`planVacation`), the renderer only shows it. */}
        {data ? <RecoveryPanel {...(asOf ? { asOf } : {})} onApplied={onRecoveryApplied} /> : null}

        {/* session controls (the Segmented modes are wired in T031/T076) */}
        <div className="sessionbar">
          <button
            type="button"
            className="sessionbar__start"
            data-testid="queue-start-session"
            data-coach="start-session"
            disabled={!dailyWork}
            onClick={startSession}
          >
            <Icon name={primaryIcon} size={14} />
            {primaryLabel}
          </button>
          <span className="sessionbar__note">{sessionNote}</span>
        </div>

        <SessionAssemblyPreview
          open={sessionPreviewOpen}
          origin="queue"
          {...(asOf ? { asOf } : {})}
          defaultTargetMinutes={data?.minuteBudget?.targetMinutes ?? 25}
          request={{
            ...(activeTypes ? { types: activeTypes } : {}),
            ...(activeStatuses ? { statuses: activeStatuses } : {}),
            ...(filter === "high" ? { protectedOnly: true } : {}),
            ...(concept ? { concept } : {}),
            mode: "full",
          }}
          onClose={() => setSessionPreviewOpen(false)}
        />

        {/* filters */}
        <div className="q-filters" data-testid="queue-filters">
          {FILTERS.map((f) => {
            const count =
              f.id === "all"
                ? (counts?.all ?? 0)
                : f.id === "high"
                  ? (counts?.highPriority ?? 0)
                  : (counts?.[f.id] ?? 0);
            return (
              <button
                type="button"
                key={f.id}
                data-testid={`queue-filter-${f.id}`}
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={`chip${filter === f.id ? " chip--active" : ""}`}
              >
                {f.label}
                <span className="chip__count">{count}</span>
              </button>
            );
          })}
        </div>

        {/* status filter (passed through to the read — narrowing happens main-side) */}
        <div className="q-filters q-filters--status" data-testid="queue-status-filters">
          {STATUS_FILTERS.map((s) => (
            <button
              type="button"
              key={s.id}
              data-testid={`queue-status-${s.id}`}
              aria-pressed={statusFilter === s.id}
              onClick={() => setStatusFilter(s.id)}
              className={`chip${statusFilter === s.id ? " chip--active" : ""}`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* list — virtualized once it crosses the threshold (years-of-use scale, T100),
            inline below it so the everyday queue keeps its exact kit layout. */}
        {visible.length > 0 ? (
          <AutoVirtualList
            items={visible}
            itemKey={(item) => item.id}
            estimateSize={72}
            height={620}
            className="q-list q-list--virtual"
            rowClassName="q-list__vrow"
            testId="queue-list"
            renderInline={() => (
              <div className="q-list" data-testid="queue-list">
                {visible.map((item) => (
                  <QueueItem
                    key={item.id}
                    item={item}
                    active={selectedId === item.id}
                    busy={busyId !== null || lineageDelete.busy}
                    onSelect={onSelect}
                    onOpen={onOpen}
                    onAction={onAction}
                    deleteActions={lineageDelete.actions}
                    onDismissRetirementSuggestion={onDismissRetirementSuggestion}
                    onResolveDone={onResolveDone}
                    onSchedule={onSchedule}
                  />
                ))}
              </div>
            )}
            renderItem={(item) => (
              <QueueItem
                item={item}
                active={selectedId === item.id}
                // While ANY row's action is in flight the queue is mid-mutation and
                // about to be re-read + re-sorted, so EVERY row's action buttons
                // disable — visual honesty (the guard below also drops clicks while
                // busyId is set, so leaving other rows enabled would silently no-op).
                busy={busyId !== null || lineageDelete.busy}
                onSelect={onSelect}
                onOpen={onOpen}
                onAction={onAction}
                deleteActions={lineageDelete.actions}
                onDismissRetirementSuggestion={onDismissRetirementSuggestion}
                onResolveDone={onResolveDone}
                onSchedule={onSchedule}
              />
            )}
          />
        ) : !data ? null : dueCount === 0 && !hasActiveFilters ? (
          <div className="q-panel">
            {dailyWork?.recommendedAction === "triage_inbox" ? (
              <div className="q-empty" data-testid="queue-inbox-work">
                <div className="q-empty__icon q-empty__icon--filter">
                  <Icon name="inbox" size={24} />
                </div>
                <h2 className="q-empty__title">No due items today</h2>
                <p className="q-empty__body">
                  {dailyWork.inboxSources} inbox source
                  {dailyWork.inboxSources === 1 ? "" : "s"} awaiting triage.
                </p>
                <button
                  type="button"
                  className="sessionbar__start"
                  data-testid="queue-go-inbox"
                  onClick={() => void navigate({ to: "/inbox" })}
                >
                  <Icon name="inbox" size={14} />
                  Triage inbox
                </button>
              </div>
            ) : dailyWork?.recommendedAction === "resume_unscheduled_source" &&
              dailyWork.resumeSource ? (
              <div className="q-empty" data-testid="queue-resume-source">
                <div className="q-empty__icon q-empty__icon--filter">
                  <Icon name="source" size={24} />
                </div>
                <h2 className="q-empty__title">No due items today</h2>
                <p className="q-empty__body">
                  {dailyWork.resumeSource.title} is active without a return date.
                </p>
                <button
                  type="button"
                  className="sessionbar__start"
                  data-testid="queue-resume-source-button"
                  onClick={() => {
                    const source = dailyWork.resumeSource;
                    if (!source) return;
                    const id = source.id;
                    select(id);
                    void navigate({ to: "/source/$id", params: { id } });
                  }}
                >
                  <Icon name="source" size={14} />
                  Resume source
                </button>
              </div>
            ) : (
              <div className="q-empty" data-testid="queue-empty">
                <div className="q-empty__icon">
                  <Icon name="checkCircle" size={26} />
                </div>
                <h2 className="q-empty__title">Queue clear for today</h2>
                <p className="q-empty__body">
                  You've processed everything due. The next items unlock as they come due — your
                  high-priority sources are protected and won't pile up.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="q-panel">
            <div className="q-empty" data-testid="queue-empty-filtered">
              <div className="q-empty__icon q-empty__icon--filter">
                <Icon name="filter" size={24} />
              </div>
              <h2 className="q-empty__title">
                No {filter === "all" ? "items" : FILTER_EMPTY_NOUN[filter]}
              </h2>
              <p className="q-empty__body">
                Nothing matches this filter right now. Try another filter or clear it.
              </p>
              <button
                type="button"
                onClick={() => setFilter("all")}
                className="sessionbar__start"
                data-testid="queue-show-all"
              >
                Show all
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Undo snackbar for a source's destructive "Done" intent (Finished / Abandon) — its
          Undo hits the row's own queue.act recipe (the same op as the shell ⌘Z). Return later
          is non-destructive and stays quiet. Takes precedence over the batch snackbar when both
          are pending (the just-resolved source is the freshest action). */}
      {doneUndoState ? (
        <QueueSnackbar
          message={doneUndoState.message}
          onUndo={onUndoDone}
          onClose={() => setDoneUndoState(null)}
        />
      ) : (
        /* Undo snackbar for larger queue batches; ordinary row advancement stays quiet. */
        <QueueSnackbar
          message={batchUndoState?.message ?? null}
          onUndo={batchUndoState ? onUndo : undefined}
          onClose={() => setBatchUndoState(null)}
        />
      )}

      {/* The descendant-aware delete outcome (T135 / U7). Its Undo restores the exact
          batch for a branch delete (order-independent), the last op for a leaf. */}
      <Snackbar
        message={lineageDelete.snackbar?.message ?? null}
        onUndo={lineageDelete.snackbar?.onUndo}
        onClose={() => lineageDelete.setSnackbar(null)}
        icon={lineageDelete.snackbar?.icon ?? "trash"}
        timeoutMs={lineageDelete.snackbar?.timeoutMs}
        testId="queue-delete-snackbar"
      />
    </div>
  );
}

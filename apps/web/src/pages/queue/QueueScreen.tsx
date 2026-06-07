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
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { Prio, SchedulerChip, TypeIcon } from "../../components/inspector/primitives";
import { BudgetMeter } from "../../components/queue/BudgetMeter";
import { QueueSnackbar } from "../../components/queue/QueueSnackbar";
import { listenQueueRefresh } from "../../components/queue/queueRefresh";
import { ScheduleMenu } from "../../components/queue/ScheduleMenu";
import { Tooltip } from "../../components/Tooltip";
import { AutoVirtualList } from "../../components/VirtualList";
import "../../components/inspector/inspector.css";
import {
  appApi,
  isDesktop,
  type QueueActAction,
  type QueueItemSummary,
  type QueueListResult,
  type QueueScheduleChoice,
  type SchedulerSignals,
} from "../../lib/appApi";
import { UNDO_EVENT } from "../../shell/nav";
import { useSelection } from "../../shell/selection";
import "./queue.css";
import { HelpLink } from "../../help/Contextual";
import { jitterOrder } from "./jitter";
import { OverloadBanner } from "./OverloadBanner";
import { openQueueItem } from "./openQueueItem";
import { actionFor, DueBadge, metaFor, titleFor } from "./queueRow";
import { RecoveryPanel } from "./RecoveryPanel";

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

async function actionWithSourceDoneGate(
  item: QueueItemSummary,
  kind: RowActionKind,
): Promise<QueueActAction | null> {
  if (kind !== "markDone" || item.type !== "source") return { kind };
  const { summary } = await appApi.getBlockProcessingSummary({ sourceElementId: item.id });
  if (summary.canMarkDoneWithoutConfirmation) return { kind };
  const ok = window.confirm(
    `This source still has ${summary.unresolvedBlocks} unresolved blocks. Mark it done anyway?`,
  );
  return ok ? { kind, confirmUnresolvedBlocks: true } : null;
}

/** One queue row (the kit's `qitem`). */
function QueueItem({
  item,
  active,
  busy,
  onSelect,
  onOpen,
  onAction,
  onSchedule,
}: {
  item: QueueItemSummary;
  active: boolean;
  /** Whether ANY queue action is in flight (every row's action buttons disable). */
  busy: boolean;
  onSelect: (item: QueueItemSummary) => void;
  onOpen: (item: QueueItemSummary) => void;
  onAction: (item: QueueItemSummary, kind: RowActionKind) => void;
  /** Explicit (tomorrow/next-week/next-month/manual) scheduling — attention items only. */
  onSchedule: (item: QueueItemSummary, choice: QueueScheduleChoice) => void;
}) {
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
    lastProcessedAt: null,
  };
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
          </span>
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
        {ROW_ACTIONS.map((a) => (
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
        ))}
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
  const [filter, setFilter] = useState<FilterId>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilterId>("all");
  const [error, setError] = useState<string | null>(null);
  /** The id of the row whose action is currently in flight (its buttons disable). */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Batch queue operations keep a snackbar because they are not simple row advancement. */
  const [batchUndoState, setBatchUndoState] = useState<{ message: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      // The active status filter is passed THROUGH to the read so the narrowing
      // happens main-side (`QueueQuery.matchesFilters`), never in React. `all` sends
      // no `statuses` (the full due set). The `concept` param is forwarded too (when
      // present) so the documented T041 filter surface is genuinely wired end-to-end.
      const statuses = STATUS_FILTERS.find((s) => s.id === statusFilter)?.statuses;
      const next = await appApi.listQueue({
        ...(asOf ? { asOf } : {}),
        ...(statuses ? { statuses } : {}),
        ...(concept ? { concept } : {}),
      });
      setData(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [asOf, statusFilter, concept]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
  const estMin = Math.max(8, dueCount * 2);
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
    // The T031 "Process queue" loop lives at /process: one element at a time,
    // advancing after each action, reusing the same typed mutation path as this
    // list. Carry the `asOf` clock so the loop reads the SAME due set the list shows.
    void navigate({ to: "/process", search: asOf ? { asOf } : {} });
  }, [navigate, asOf]);

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
        const action = await actionWithSourceDoneGate(item, kind);
        if (!action) return;
        await appApi.actOnQueueItem({ id: item.id, action });
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

  return (
    <div className="q-page" data-testid="route-queue">
      <div className="q-pad">
        <div className="q-head">
          <div>
            <h1 className="q-title">
              Daily Queue <HelpLink slug="daily-loop" />
            </h1>
            <p className="q-sub" data-testid="queue-subtitle">
              {today} · {dueCount} item{dueCount === 1 ? "" : "s"} due · est. {estMin} min
            </p>
          </div>
        </div>

        {error ? (
          <p className="q-sub" data-testid="queue-error" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        {/* overload-management strip: budget meter + at-risk metrics */}
        <div className="q-panel q-panel-pad q-overload" style={{ marginBottom: 14 }}>
          <BudgetMeter used={data?.budget.used ?? 0} target={data?.budget.target ?? 0} />
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
        {data ? (
          <OverloadBanner
            used={data.budget.used}
            target={data.budget.target}
            {...(asOf ? { asOf } : {})}
            onPostponed={onPostponed}
          />
        ) : null}

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
            onClick={startSession}
          >
            <Icon name="play" size={14} />
            Start session
          </button>
          <span className="sessionbar__note">
            Process one item at a time — sorted by priority, then due date.
          </span>
        </div>

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
                    busy={busyId !== null}
                    onSelect={onSelect}
                    onOpen={onOpen}
                    onAction={onAction}
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
                busy={busyId !== null}
                onSelect={onSelect}
                onOpen={onOpen}
                onAction={onAction}
                onSchedule={onSchedule}
              />
            )}
          />
        ) : dueCount === 0 ? (
          <div className="q-panel">
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

      {/* Undo snackbar for larger queue batches; ordinary row advancement stays quiet. */}
      <QueueSnackbar
        message={batchUndoState?.message ?? null}
        onUndo={batchUndoState ? onUndo : undefined}
        onClose={() => setBatchUndoState(null)}
      />
    </div>
  );
}

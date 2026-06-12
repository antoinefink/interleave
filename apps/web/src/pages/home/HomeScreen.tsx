/**
 * Home Command Center (Daily Queue landing dashboard) — the real `/` index,
 * replacing the Placeholder.
 *
 * A READ-ONLY command center that orients the user at a glance and routes INTO the
 * existing interactive surfaces (/process, /queue, /review, /inbox) rather than
 * duplicating the full actionable queue list. It composes TWO live reads already on
 * the bridge — `appApi.listQueue()` (per-type counts, the budget gauge, and the
 * already priority-then-due sorted items for a top-due preview) and
 * `appApi.getAnalytics()` (streak, retention, due cards/topics, new cards/extracts,
 * leeches, reviews-per-day) — so NO new backend/appApi/repository work is required.
 *
 * Mirrors the kit's `screen-queue.jsx` command-center aesthetic (page head with
 * greeting + due/est, the `BudgetMeter` + at-risk metrics strip, a primary "Start
 * session" CTA, streak + retention, a compact read-only top-due preview, the
 * reviews-per-day spark, and quick-nav tiles). It reuses the queue chrome
 * (`q-*`/`sessionbar`/`BudgetMeter`) and the analytics chrome (`an-*`/spark) plus a
 * thin `home.css` for the preview rows + tile grid.
 *
 * Architecture (non-negotiable): UI ONLY — no SQL, no scheduling/priority math, no
 * date math beyond formatting. All numbers come pre-computed from the typed
 * `window.appApi` bridge; the renderer holds no domain logic. Re-reads both sources
 * on a global undo (⌘Z) so the dashboard stays live.
 */

import { DEFAULT_RANDOM_AUDIT_SIZE } from "@interleave/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import {
  formatAttentionScheduleReason,
  Prio,
  ScheduleReasonLine,
  SchedulerChip,
  TypeIcon,
} from "../../components/inspector/primitives";
import { BudgetMeter } from "../../components/queue/BudgetMeter";
import "../../components/inspector/inspector.css";
import {
  type AnalyticsGetResult,
  appApi,
  type DailyWorkSummaryResult,
  isDesktop,
  type KnowledgeGraduationEvent,
  type QueueItemSummary,
  type QueueListResult,
  type ReviewModeSelector,
  type SchedulerSignals,
} from "../../lib/appApi";
import { formatQueueTimeEstimate } from "../../lib/queueTimeEstimate";
import { ReviewModeButton } from "../../review/ReviewModeButton";
import "../../review/review.css";
import { UNDO_EVENT } from "../../shell/nav";
import { useSelection } from "../../shell/selection";
import "../../analytics/analytics.css";
import "../queue/queue.css";
import { openQueueItem } from "../queue/openQueueItem";
import { actionFor, DueBadge, metaFor, titleFor } from "../queue/queueRow";
import "./home.css";

/** Format a `[0,1]` retention fraction as a whole-percent string, or `null` if none. */
function retentionPct(value: number | null): number | null {
  if (value === null) return null;
  return Math.round(value * 100);
}

/** A greeting keyed to the local hour (morning / afternoon / evening). */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** How many top-due rows the read-only preview shows (a glance, not the full list). */
const PREVIEW_LIMIT = 5;
const EMPTY_GRADUATION_EVENTS: readonly KnowledgeGraduationEvent[] = [];

/** A quick-navigation tile (calm at-a-glance affordance into a key surface). */
const TILES: readonly {
  to: string;
  icon: "inbox" | "review" | "library" | "analytics";
  label: string;
  sub: string;
  testId: string;
}[] = [
  { to: "/inbox", icon: "inbox", label: "Inbox", sub: "Triage imports", testId: "home-tile-inbox" },
  {
    to: "/review",
    icon: "review",
    label: "Review",
    sub: "Active recall",
    testId: "home-tile-review",
  },
  {
    to: "/library",
    icon: "library",
    label: "Library",
    sub: "Browse your collection",
    testId: "home-tile-library",
  },
  {
    to: "/analytics",
    icon: "analytics",
    label: "Analytics",
    sub: "Learning health",
    testId: "home-tile-analytics",
  },
];

/**
 * One read-only top-due preview row — a slim variant of the kit's `qitem`. It shows
 * the `TypeIcon`, the prefixed title, the load-bearing `SchedulerChip`, the `Prio`
 * band, and the `DueBadge`, and navigates to the element on click (source → reader,
 * extract → extract view, card → card detail). It deliberately omits the actionable
 * controls (postpone/raise/lower/done/dismiss/delete, schedule menu) — those stay on
 * the full `/queue` list.
 */
function PreviewRow({
  item,
  onOpen,
}: {
  item: QueueItemSummary;
  onOpen: (item: QueueItemSummary) => void;
}) {
  const scheduleReasonId = useId();
  const action = actionFor(item);
  // The per-type meta sub-line (shared with the Daily Queue list so the two
  // surfaces never drift); `null` for a type with no sub-line content.
  const meta = metaFor(item);
  const chip: SchedulerSignals = {
    kind: item.schedulerSignals.kind,
    retrievability: item.schedulerSignals.retrievability,
    stability: item.schedulerSignals.stability,
    difficulty: null,
    reps: null,
    lapses: null,
    fsrsState: null,
    stage: item.schedulerSignals.stage,
    postponed: item.schedulerSignals.postponed,
    scheduleReason: item.schedulerSignals.scheduleReason ?? null,
    lastProcessedAt: null,
  };
  const scheduleReasonText = formatAttentionScheduleReason(chip);
  return (
    <button
      type="button"
      data-testid="home-preview-row"
      data-element-id={item.id}
      data-element-type={item.type}
      aria-describedby={scheduleReasonText ? scheduleReasonId : undefined}
      className={`home-prow${item.protected ? " home-prow--protected" : ""}`}
      onClick={() => onOpen(item)}
    >
      <TypeIcon type={item.type} />
      <span className="home-prow__main">
        <span className="home-prow__title truncate">{titleFor(item)}</span>
        <span className="home-prow__meta">
          {meta}
          {item.concept ? <span className="concept-tag">{item.concept}</span> : null}
          <SchedulerChip scheduler={chip} />
        </span>
        {scheduleReasonText ? (
          <ScheduleReasonLine
            id={scheduleReasonId}
            scheduler={chip}
            className="home-prow__schedule-reason"
          />
        ) : null}
      </span>
      <span className="home-prow__action">
        <Prio priority={item.priority} />
        <DueBadge item={item} />
        <span className="next-action">
          <Icon name={action.icon} size={12} />
          {action.label}
        </span>
      </span>
    </button>
  );
}

function GraduationReceipts({
  events,
  onOpenConcept,
}: {
  events: readonly KnowledgeGraduationEvent[];
  onOpenConcept: (conceptId: string) => void;
}) {
  if (events.length === 0) return null;
  return (
    <div className="home-graduations" data-testid="home-graduation-events">
      <span className="home-graduations__icon">
        <Icon name="checkCircle" size={15} />
      </span>
      <div className="home-graduations__lines">
        {events.map((event) =>
          event.subjectType === "concept" ? (
            <button
              type="button"
              key={event.eventId}
              className="home-graduations__line home-graduations__line--link"
              data-testid="home-graduation-link"
              onClick={() => onOpenConcept(event.subjectId)}
            >
              <span>{event.title}</span>
              <small>concept reached mature knowledge state</small>
              <Icon name="chevronRight" size={13} />
            </button>
          ) : (
            <span
              key={event.eventId}
              className="home-graduations__line"
              data-testid="home-graduation-line"
            >
              <span>{event.title}</span>
              <small>topic reached mature knowledge state</small>
            </span>
          ),
        )}
      </div>
    </div>
  );
}

export function HomeScreen() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const { select } = useSelection();
  // The index route declares no `validateSearch`, so search is loosely typed. An
  // optional `asOf` date-scopes BOTH reads (used by the E2E to drive a fixed clock);
  // in normal use the reads default to the server's "now".
  const search = useSearch({ strict: false }) as { asOf?: string };
  const asOf = typeof search.asOf === "string" ? search.asOf : undefined;
  // T096 random audit: mint a seed ONCE when the home screen mounts and carry it in
  // the selector so the audit launches the SAME sample its count was computed from
  // (the seed travels in the descriptor, never persisted). `Math.random` here is only
  // for picking which sample to audit — the SHUFFLE itself is deterministic main-side.
  const randomAuditSelector = useMemo<ReviewModeSelector>(
    () => ({
      kind: "random",
      size: DEFAULT_RANDOM_AUDIT_SIZE,
      seed: Math.floor(Math.random() * 0x7fffffff),
    }),
    [],
  );
  const [queue, setQueue] = useState<QueueListResult | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsGetResult | null>(null);
  const [dailyWork, setDailyWork] = useState<DailyWorkSummaryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setLoading(false);
      return;
    }
    try {
      const [queueResult, analyticsResult, workResult] = await Promise.allSettled([
        appApi.listQueue({ ...(asOf ? { asOf } : {}), includeTimeEstimate: true }),
        appApi.getAnalytics(asOf ? { asOf } : {}),
        appApi.getDailyWorkSummary(asOf ? { asOf } : {}),
      ]);
      let nextError: string | null = null;
      if (queueResult.status === "fulfilled") {
        setQueue(queueResult.value);
      } else {
        setQueue(null);
        nextError =
          queueResult.reason instanceof Error
            ? queueResult.reason.message
            : String(queueResult.reason);
      }
      if (analyticsResult.status === "fulfilled") {
        setAnalytics(analyticsResult.value);
      } else {
        setAnalytics(null);
        nextError =
          nextError ??
          (analyticsResult.reason instanceof Error
            ? analyticsResult.reason.message
            : String(analyticsResult.reason));
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [asOf]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read after a global undo (⌘Z) reverts a mutation elsewhere so the dashboard
  // numbers stay live without a manual refresh (matches AnalyticsScreen).
  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(UNDO_EVENT, handler);
    return () => window.removeEventListener(UNDO_EVENT, handler);
  }, [load]);

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
    if (dailyWork?.recommendedAction === "clear" && (queue?.counts.all ?? 0) === 0) {
      void navigate({ to: "/inbox" });
      return;
    }
    // Due scheduled work is the only case that starts the T031 one-at-a-time loop.
    void navigate({ to: "/process", search: asOf ? { asOf } : {} });
  }, [navigate, select, asOf, dailyWork, queue]);

  const graduationEvents = dailyWork?.graduationEvents ?? EMPTY_GRADUATION_EVENTS;

  useEffect(() => {
    if (!dailyWork) return;
    void appApi.ackDailyWorkGraduationEvents({
      asOf: dailyWork.asOf,
      eventIds: graduationEvents.map((event) => event.eventId),
    });
  }, [dailyWork, graduationEvents]);

  if (!desktop) {
    return (
      <div
        className="flex h-full min-h-full flex-col items-center justify-center gap-3 px-7 py-8 text-center"
        data-testid="route-home"
      >
        <div className="grid size-12 place-items-center rounded-lg bg-accent-soft text-accent-text">
          <Icon name="layers" size={26} />
        </div>
        <h1 className="font-semibold text-2xl text-text tracking-tight">Home</h1>
        <p className="max-w-sm text-base text-text-2">
          Your daily command center — the queue, streak, and next actions — reads through the
          desktop bridge. Open the Electron app to see your day at a glance.
        </p>
      </div>
    );
  }

  // Whether each independent read actually resolved. The two reads (listQueue +
  // getAnalytics) are awaited together but reported through a single `error`; gating
  // each panel on its own source being present means a failed read shows a calm "—"
  // placeholder (next to the error line) instead of a fabricated `0` ("0 due today"
  // reads as a real empty queue, which a failed read is NOT).
  const hasQueue = queue !== null;
  const hasAnalytics = analytics !== null;
  const hasDailyWork = dailyWork !== null;
  /** Render a metric value: the number when its source loaded, else an em-dash. */
  const num = (present: boolean, value: number | undefined): string =>
    present ? String(value ?? 0) : "—";

  const counts = queue?.counts;
  const dueCount = counts?.all ?? 0;
  const estimateLabel = formatQueueTimeEstimate(queue?.timeEstimate);
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const streak = analytics?.dayStreak ?? 0;
  const retPct = retentionPct(analytics?.retention30d ?? null);
  const spark = analytics?.reviewsByDay ?? [];
  const sparkMax = spark.reduce((m, d) => Math.max(m, d.count), 0);
  const topDue = (queue?.items ?? []).slice(0, PREVIEW_LIMIT);
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

  return (
    <div className="q-page" data-testid="route-home">
      <div className="q-pad">
        <div className="q-head">
          <div>
            <h1 className="q-title">{greeting()}</h1>
            <p className="q-sub" data-testid="home-subtitle">
              {hasQueue ? (
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
          <p className="q-sub" data-testid="home-error" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        {loading ? (
          <p className="q-sub" data-testid="home-loading">
            Loading…
          </p>
        ) : null}

        {/* Hero overload strip — BudgetMeter + at-risk metrics (mirrors QueueScreen). */}
        <div className="q-panel q-panel-pad q-overload" style={{ marginBottom: 14 }}>
          <BudgetMeter used={queue?.budget.used ?? 0} target={queue?.budget.target ?? 0} />
          <div className="q-overload__div" />
          <div className="q-metrics">
            <div className="q-metric">
              <span className="q-metric__v" data-testid="home-due-today">
                {num(hasQueue, counts?.all)}
              </span>
              <span className="q-metric__l">due today</span>
            </div>
            <div className="q-metric">
              <span
                className={`q-metric__v${counts?.overdue ? " q-metric__v--danger" : ""}`}
                data-testid="home-overdue-count"
              >
                {num(hasQueue, counts?.overdue)}
              </span>
              <span className="q-metric__l">overdue</span>
            </div>
            <div className="q-metric">
              <span className="q-metric__v" data-testid="home-protected-count">
                {num(hasQueue, counts?.protected)}
              </span>
              <span className="q-metric__l">protected</span>
            </div>
          </div>
        </div>

        {/* Streak + retention banner — calm, never invents data (hidden at 0). */}
        {streak > 0 ? (
          <div className="home-streak" data-testid="home-streak">
            <span className="home-streak__icon">
              <Icon name="flame" size={16} />
            </span>
            <span className="home-streak__n">{streak}-day streak</span>
            {retPct !== null ? (
              <span className="home-streak__l" data-testid="home-streak-retention">
                {retPct}% retention · last 30d
              </span>
            ) : null}
          </div>
        ) : null}

        {/* Primary CTA / session bar — Start session → /process (the queue's target). */}
        <div className="sessionbar">
          <button
            type="button"
            className="sessionbar__start"
            data-testid="home-start-session"
            disabled={!hasDailyWork}
            onClick={startSession}
          >
            <Icon name={primaryIcon} size={14} />
            {primaryLabel}
          </button>
          <button
            type="button"
            className="home-sessionbar__link"
            data-testid="home-open-queue"
            onClick={() => void navigate({ to: "/queue" })}
          >
            <Icon name="queue" size={14} />
            Open queue
          </button>
          {/* Gated on `hasAnalytics` (not just `> 0`): when the analytics read FAILS the
              due-card count is unknown, not a real zero, so the Review affordance hides as
              "unknown" rather than silently vanishing as if there were genuinely no cards —
              consistent with the em-dash metric values. */}
          {hasAnalytics && (analytics?.dueCards ?? 0) > 0 ? (
            <button
              type="button"
              className="home-sessionbar__link"
              data-testid="home-open-review"
              onClick={() => void navigate({ to: "/review" })}
            >
              <Icon name="review" size={14} />
              Review
            </button>
          ) : null}
          <span className="sessionbar__note">{sessionNote}</span>
        </div>

        <GraduationReceipts
          events={graduationEvents}
          onOpenConcept={(conceptId) => void navigate({ to: "/concepts", search: { conceptId } })}
        />

        {/* Today's-status metric tiles (analytics chrome). */}
        <div className="an-metrics an-metrics--sm" style={{ marginBottom: 14 }}>
          <div
            className={`an-metric an-metric--sm${
              hasAnalytics && (analytics?.dueCards ?? 0) > 0 ? " an-metric--danger" : ""
            }`}
            data-testid="metric-due"
          >
            <span className="an-metric__val">{num(hasAnalytics, analytics?.dueCards)}</span>
            <span className="an-metric__label">Due cards</span>
          </div>
          <div className="an-metric an-metric--sm" data-testid="metric-topics">
            <span className="an-metric__val">{num(hasAnalytics, analytics?.dueTopics)}</span>
            <span className="an-metric__label">Due topics</span>
          </div>
          <div className="an-metric an-metric--sm" data-testid="metric-new-cards">
            <span className="an-metric__val">{num(hasAnalytics, analytics?.newCards)}</span>
            <span className="an-metric__label">New cards</span>
          </div>
          <div className="an-metric an-metric--sm" data-testid="metric-new-extracts">
            <span className="an-metric__val">{num(hasAnalytics, analytics?.newExtracts)}</span>
            <span className="an-metric__label">New extracts</span>
          </div>
        </div>

        {/* Top-due preview (read-only) — a glance + entry, NOT the full actionable list. */}
        {topDue.length > 0 ? (
          <div className="home-section">
            <div className="home-section__head">
              <span className="home-section__title">Top due</span>
              <button
                type="button"
                className="home-section__link"
                data-testid="home-see-queue"
                onClick={() => void navigate({ to: "/queue" })}
              >
                See full queue
                <Icon name="chevronRight" size={13} />
              </button>
            </div>
            <div className="home-preview" data-testid="home-preview">
              {topDue.map((item) => (
                <PreviewRow key={item.id} item={item} onOpen={onOpen} />
              ))}
            </div>
          </div>
        ) : hasQueue &&
          hasDailyWork &&
          dueCount === 0 &&
          dailyWork.recommendedAction === "triage_inbox" &&
          !loading ? (
          <div className="q-panel">
            <div className="q-empty" data-testid="home-inbox-work">
              <div className="q-empty__icon q-empty__icon--filter">
                <Icon name="inbox" size={24} />
              </div>
              <h2 className="q-empty__title">Inbox needs triage</h2>
              <p className="q-empty__body">
                {dailyWork.inboxSources} imported source
                {dailyWork.inboxSources === 1 ? "" : "s"} waiting. Triage them before starting a
                due-queue session.
              </p>
              <button
                type="button"
                className="sessionbar__start"
                data-testid="home-go-inbox"
                onClick={() => void navigate({ to: "/inbox" })}
              >
                <Icon name="inbox" size={14} />
                Triage inbox
              </button>
            </div>
          </div>
        ) : hasQueue &&
          hasDailyWork &&
          dueCount === 0 &&
          dailyWork.recommendedAction === "resume_unscheduled_source" &&
          dailyWork.resumeSource &&
          !loading ? (
          <div className="q-panel">
            <div className="q-empty" data-testid="home-resume-source">
              <div className="q-empty__icon q-empty__icon--filter">
                <Icon name="source" size={24} />
              </div>
              <h2 className="q-empty__title">Resume unscheduled source</h2>
              <p className="q-empty__body">
                {dailyWork.resumeSource.title} is active without a return date.
              </p>
              <button
                type="button"
                className="sessionbar__start"
                data-testid="home-resume-source-button"
                onClick={() => {
                  const source = dailyWork.resumeSource;
                  if (!source) return;
                  const id = source.id;
                  select(id);
                  void navigate({
                    to: "/source/$id",
                    params: { id },
                  });
                }}
              >
                <Icon name="source" size={14} />
                Resume source
              </button>
            </div>
          </div>
        ) : hasQueue &&
          hasDailyWork &&
          dueCount === 0 &&
          dailyWork.recommendedAction === "clear" &&
          !loading ? (
          <div className="q-panel">
            <div className="q-empty" data-testid="home-empty">
              <div className="q-empty__icon">
                <Icon name="checkCircle" size={26} />
              </div>
              <h2 className="q-empty__title">Queue clear for today</h2>
              <p className="q-empty__body">
                You've processed everything due. Import or triage something new to keep the pipeline
                moving.
              </p>
              <button
                type="button"
                className="sessionbar__start"
                data-testid="home-go-inbox"
                onClick={() => void navigate({ to: "/inbox" })}
              >
                <Icon name="inbox" size={14} />
                Go to inbox
              </button>
            </div>
          </div>
        ) : null}

        {/* Reviews-per-day spark (analytics chrome). */}
        <div className="an-panel" style={{ marginTop: 14 }}>
          <div className="an-panel__head">
            <span className="an-panel__title">Reviews per day</span>
            <span className="an-panel__meta">{analytics?.windowDays ?? 30} days</span>
          </div>
          <div className="an-spark" data-testid="home-spark">
            {spark.map((d, i) => (
              <span
                key={d.date}
                className={
                  i === spark.length - 1 && d.count > 0
                    ? "an-spark__bar an-spark__bar--hot"
                    : "an-spark__bar"
                }
                title={`${d.date}: ${d.count}`}
                style={{ height: `${sparkMax > 0 ? (d.count / sparkMax) * 100 : 0}%` }}
              />
            ))}
          </div>
        </div>

        {/* Maintenance nudge — only when there are leeches to repair. */}
        {(analytics?.leeches ?? 0) > 0 ? (
          <button
            type="button"
            className="an-banner"
            data-testid="home-banner-leeches"
            style={{ marginTop: 14 }}
            onClick={() => void navigate({ to: "/maintenance/leeches" })}
          >
            <Icon name="leech" size={16} />
            <span className="an-banner__title">
              {analytics?.leeches} leech{analytics?.leeches === 1 ? "" : "es"} to repair
            </span>
            <Icon name="chevronRight" size={14} />
          </button>
        ) : null}

        {/* Quick-navigation tiles — calm at-a-glance affordances into key surfaces. */}
        <div className="home-section">
          <div className="home-section__head">
            <span className="home-section__title">Jump to</span>
          </div>
          <div className="home-tiles" data-testid="home-tiles">
            {TILES.map((tile) => (
              <button
                type="button"
                key={tile.to + tile.label}
                className="home-tile"
                data-testid={tile.testId}
                onClick={() => void navigate({ to: tile.to })}
              >
                <span className="home-tile__icon">
                  <Icon name={tile.icon} size={16} />
                </span>
                <span className="home-tile__label">{tile.label}</span>
                <span className="home-tile__sub">{tile.sub}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Targeted review modes (T096) — review a chosen card subset OUTSIDE normal
            scheduling. The random audit always offers a fresh, seeded sample; the stale
            review is omitted when nothing is stale (the button resolves its own count). */}
        <div className="home-section">
          <div className="home-section__head">
            <span className="home-section__title">Targeted review</span>
          </div>
          <div className="home-review-modes" data-testid="home-review-modes">
            <ReviewModeButton
              selector={randomAuditSelector}
              {...(asOf ? { asOf } : {})}
              icon="target"
              label={(n) => `Audit ${Math.min(n, DEFAULT_RANDOM_AUDIT_SIZE)} random cards`}
              testId="home-review-random"
            />
            <ReviewModeButton
              selector={{ kind: "stale" }}
              {...(asOf ? { asOf } : {})}
              hideWhileLoading
              icon="clock"
              label={(n) => `Review ${n} stale card${n === 1 ? "" : "s"}`}
              testId="home-review-stale"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

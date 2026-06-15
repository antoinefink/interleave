/**
 * Weekly Review screen (U3 — Weekly Review redesign).
 *
 * Rebuilt to the Claude Design handoff: a kicker/title header with a window +
 * cadence + sections-left line and a progress-ring chip + Snooze/Complete; "The
 * ledger" group with a Sources → Extracts → Cards → Matured funnel (with real
 * week-over-week deltas when the optional `*Prev` ledger fields are present); five
 * numbered, iconified section frames (Ledger, Integrity, Parked, Chronic, Fallow)
 * each with a state pill + Skip/Done; priority-miss severity bars; integrity flag
 * cards (amber when active) with resting-topic concept pills; and the
 * Parked/Chronic/Fallow forced-decision rows.
 *
 * This is a presentational rebuild: every behavior, mutation call, `data-testid`,
 * and decision button label is preserved. All domain logic stays behind the typed
 * `window.appApi` bridge (`getWeeklyReviewSummary`, `updateWeeklyReviewProgress`,
 * `maintenance.parkedResurfacingApply`, `maintenance.chronicPostponesApply`,
 * `completeWeeklyReview`, `dismissWeeklyReview`). The progress ring reflects the
 * real server-persisted `summary.progress.sections`.
 *
 * The shared element primitives (`TypeIcon`, `Prio`, `ConceptTag`) come from the
 * inspector layer; `inspector.css` is imported so they render.
 */

import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import "../components/inspector/inspector.css";
import { ConceptTag, Prio, TypeIcon } from "../components/inspector/primitives";
import {
  appApi,
  type ChronicPostponeDecisionInput,
  type ChronicPostponeDecisionKind,
  type ChronicPostponeRowSummary,
  type ParkedResurfacingDecisionKind,
  type ParkedResurfacingRowSummary,
  type TaskSummary,
  type WeeklyReviewFallowSuggestion,
  type WeeklyReviewLedger,
  type WeeklyReviewPriorityMiss,
  type WeeklyReviewSectionId,
  type WeeklyReviewSummaryResult,
} from "../lib/appApi";
import "./weekly-review.css";

type SectionState = "pending" | "done" | "skipped";

interface SectionMeta {
  readonly id: WeeklyReviewSectionId;
  readonly n: string;
  readonly icon: IconName;
  readonly title: string;
  readonly sub: string;
}

const SECTIONS: Readonly<Record<WeeklyReviewSectionId, SectionMeta>> = {
  ledger: {
    id: "ledger",
    n: "01",
    icon: "analytics",
    title: "Ledger",
    sub: "Priority work that slipped this window",
  },
  integrity: {
    id: "integrity",
    n: "02",
    icon: "shield",
    title: "Integrity",
    sub: "Attention-health checks for the week",
  },
  parked: {
    id: "parked",
    n: "03",
    icon: "bookmark",
    title: "Parked",
    sub: "Saved-for-later sources now due to resurface",
  },
  chronic: {
    id: "chronic",
    n: "04",
    icon: "postpone",
    title: "Chronic",
    sub: "Repeatedly postponed — force a verdict",
  },
  fallow: {
    id: "fallow",
    n: "05",
    icon: "hourglass",
    title: "Fallow",
    sub: "Topics that have earned a rest",
  },
};

const SECTION_COUNT = Object.keys(SECTIONS).length;

const CHRONIC_FALLOW_REASON = "Rested from weekly integrity session";

const PRIO_VAR: Record<string, string> = {
  a: "var(--prio-a)",
  b: "var(--prio-b)",
  c: "var(--prio-c)",
  d: "var(--prio-d)",
};

/** Tiny readable className join (page-local; not the help-layer `cx`). */
const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: WeeklyReviewSummaryResult };

export function WeeklyReviewScreen() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(async (opts?: { background?: boolean }) => {
    // Background reloads (every user-triggered refetch) keep the current `ready`
    // data rendered — stale-while-revalidate — so `<WeeklyReviewBody>` never
    // unmounts and the scroll container keeps its position. Only the initial load
    // shows the full-page loading placeholder.
    const background = opts?.background ?? false;
    if (!background) setState({ status: "loading" });
    try {
      setState({ status: "ready", data: await appApi.getWeeklyReviewSummary() });
    } catch (error) {
      // In background mode, re-throw so the calling action handler surfaces the
      // error inline via its try/catch → `setActionError`, instead of blowing the
      // mounted body away with the full-page error state.
      if (background) throw error;
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === "loading") {
    return (
      <div className="wk">
        <p className="wk-window">Loading weekly review...</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="wk" data-testid="weekly-error">
        <div className="wk-complete">
          <div className="banner banner--danger">
            <Icon name="warning" size={16} />
            <div className="grow">
              <div className="banner__title">Couldn't load the weekly review</div>
              <div className="banner__body">{state.message}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <WeeklyReviewBody summary={state.data} onReload={() => load({ background: true })} />;
}

function WeeklyReviewBody({
  summary,
  onReload,
}: {
  readonly summary: WeeklyReviewSummaryResult;
  readonly onReload: () => Promise<void>;
}) {
  const progress = summary.progress;
  const [busySection, setBusySection] = useState<WeeklyReviewSectionId | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // After Complete, the server creates the next session with `dueAt = now + cadence`
  // so `summary.due` flips false while `summary.session` stays non-null. We gate the
  // editable form on `due` and otherwise show a calm acknowledgment, so Complete no
  // longer looks like it silently reset the screen. `reviewNow` is the escape hatch:
  // it lets the user re-open the (not-yet-due) form on demand without changing data.
  const [reviewNow, setReviewNow] = useState(false);
  // Distinguishes the two ways the not-yet-due acknowledgment is reached: a fresh
  // Complete in this session (celebratory "Weekly review complete") vs. simply
  // landing on a session that isn't due yet / was never started ("you're all caught
  // up"). Without this, a brand-new user who enables weekly review would be told the
  // review is "complete" before ever doing one. Local-only; resets on remount.
  const [justCompleted, setJustCompleted] = useState(false);

  const completion = useMemo(() => {
    if (!progress) return { done: 0, total: SECTION_COUNT };
    return {
      done: Object.values(progress.sections).filter(
        (sectionState) => sectionState === "done" || sectionState === "skipped",
      ).length,
      total: SECTION_COUNT,
    };
  }, [progress]);
  const remaining = completion.total - completion.done;
  const locked = !summary.session;

  const stateOf = (id: WeeklyReviewSectionId): SectionState => progress?.sections[id] ?? "pending";

  const setSection = async (id: WeeklyReviewSectionId, sectionState: SectionState) => {
    if (!summary.session) return;
    setActionError(null);
    setBusySection(id);
    try {
      await appApi.updateWeeklyReviewProgress({
        taskId: summary.session.id,
        sections: { [id]: sectionState },
      });
      await onReload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySection(null);
    }
  };

  /** Skip toggles skipped↔pending; Done toggles done↔pending (matches the mock). */
  const toggleSection = (id: WeeklyReviewSectionId, target: "done" | "skipped") => {
    void setSection(id, stateOf(id) === target ? "pending" : target);
  };

  const runParkedDecisions = async (
    decisions: readonly { readonly id: string; readonly kind: ParkedResurfacingDecisionKind }[],
  ) => {
    setActionError(null);
    setBusySection("parked");
    try {
      const result = await appApi.maintenance.parkedResurfacingApply({ decisions });
      setMessage(
        result.applied > 0
          ? `Applied ${result.applied} parked decisions`
          : "No parked decisions applied",
      );
      await setSection("parked", "done");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySection(null);
    }
  };

  const runChronicDecisions = async (decisions: readonly ChronicPostponeDecisionInput[]) => {
    setActionError(null);
    setBusySection("chronic");
    try {
      const result = await appApi.maintenance.chronicPostponesApply({ decisions });
      setMessage(
        result.applied > 0
          ? `Applied ${result.applied} chronic decisions`
          : "No chronic decisions applied",
      );
      await setSection("chronic", "done");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySection(null);
    }
  };

  const complete = async () => {
    if (!summary.session) return;
    setActionError(null);
    setBusySection("ledger");
    try {
      await appApi.completeWeeklyReview({ taskId: summary.session.id });
      // Reset the early-review override too: after a successful Complete the next
      // session is not-yet-due, and leaving `reviewNow` set would re-render the
      // editable form (a reset-looking session) instead of the acknowledgment —
      // the exact regression this screen exists to avoid, reached via "Review now".
      setReviewNow(false);
      setJustCompleted(true);
      await onReload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySection(null);
    }
  };

  const dismiss = async () => {
    if (!summary.session) return;
    setActionError(null);
    setBusySection("ledger");
    try {
      await appApi.dismissWeeklyReview({ taskId: summary.session.id, snoozeDays: 1 });
      await onReload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusySection(null);
    }
  };

  const sectionProps = (id: WeeklyReviewSectionId) =>
    ({
      meta: SECTIONS[id],
      state: stateOf(id),
      locked,
      busy: busySection === id,
      onToggle: (target: "done" | "skipped") => toggleSection(id, target),
    }) as const;

  // Weekly review is turned off entirely — no live session exists. Show a quiet
  // off-state panel that points at Settings instead of a fully-locked form.
  if (!summary.session) {
    return <WeeklyReviewOff />;
  }

  // A session exists but is not yet due (e.g. just completed → next session is
  // scheduled `cadence` ahead). Render the acknowledgment unless the user has
  // explicitly chosen to review early via "Review now".
  if (!summary.due && !reviewNow) {
    return (
      <WeeklyReviewNotDue
        session={summary.session}
        justCompleted={justCompleted}
        onReviewNow={() => setReviewNow(true)}
      />
    );
  }

  return (
    <div className="wk" data-testid="weekly-review">
      {/* header */}
      <div className="wk-head">
        <div>
          <p className="wk-kicker">Weekly session</p>
          <h1 className="wk-title">Ledger and integrity</h1>
          <p className="wk-window">
            <span className="mono">
              {formatDate(summary.window.start)} – {formatDate(summary.window.end)}
            </span>
            <span className="dot-sep" />
            {cadenceLabel(summary.cadenceDays)}
            <span className="dot-sep" />
            {remaining === 0
              ? "all reviewed"
              : `${remaining} section${remaining === 1 ? "" : "s"} left`}
          </p>
        </div>
        <div className="wk-actions">
          <span
            className="wk-prog"
            title={`${completion.done} of ${completion.total} sections reviewed`}
          >
            <span
              className="wk-prog__ring"
              style={{
                background: `conic-gradient(var(--ok) ${(completion.done / completion.total) * 360}deg, var(--border) 0)`,
              }}
            >
              <i />
            </span>
            <span className="wk-prog__txt">
              <b>{completion.done}</b>/{completion.total}
            </span>
          </span>
          <button
            type="button"
            className="btn"
            disabled={busySection !== null || locked}
            onClick={() => void dismiss()}
          >
            <Icon name="clock" size={14} />
            Snooze
          </button>
          <button
            type="button"
            className="btn btn--primary"
            // `justCompleted` guards against a double-submit when the Complete
            // mutation succeeded but the follow-up reload failed: the stale (still
            // "due") form stays mounted with the button re-enabled, and a second
            // click would re-complete an already-done session.
            disabled={busySection !== null || locked || justCompleted}
            onClick={() => void complete()}
          >
            <Icon name="check" size={14} />
            Complete
          </button>
        </div>
      </div>

      {message && !actionError ? <div className="wk-msg">{message}</div> : null}
      {actionError ? (
        <div className="wk-msg wk-msg--error" data-testid="weekly-action-error">
          {actionError}
        </div>
      ) : null}

      {/* THE LEDGER */}
      <div className="wk-group">
        <span className="wk-group__t">The ledger</span>
        <span className="wk-group__line" />
        <span className="wk-group__n">what the week produced</span>
      </div>
      <LedgerFunnel ledger={summary.ledger} />

      <Section {...sectionProps("ledger")}>
        {summary.ledger.priorityMisses.length === 0 ? (
          emptyOk("No priority misses in this window. Every due band was served.")
        ) : (
          <PriorityMissList misses={summary.ledger.priorityMisses} />
        )}
      </Section>

      <Section {...sectionProps("integrity")}>
        <div className="wk-flags">
          {[
            {
              label: "A-band deferred",
              active: summary.integrity.thresholdFlags.aBandDeferredRecently,
              value: summary.integrity.thresholdFlags.aBandDeferredRecently ? "Yes" : "No",
            },
            {
              label: "Postpone debt",
              active: summary.integrity.thresholdFlags.postponeDebtHigh,
              value: summary.integrity.thresholdFlags.postponeDebtHigh ? "High" : "Normal",
            },
          ].map((flag) => (
            <FlagCard key={flag.label} label={flag.label} active={flag.active} value={flag.value} />
          ))}
          <FlagCard label="Resting topics" active={false} value={summary.integrity.resting.length}>
            {summary.integrity.resting.length > 0 ? (
              <div className="wk-flag__pills">
                {summary.integrity.resting.map((topic) => (
                  <ConceptTag key={topic.topicId} name={topic.title} />
                ))}
              </div>
            ) : null}
          </FlagCard>
        </div>
      </Section>

      {/* DECISIONS */}
      <div className="wk-group">
        <span className="wk-group__t">Decisions</span>
        <span className="wk-group__line" />
        <span className="wk-group__n">forced dispositions</span>
      </div>

      <Section {...sectionProps("parked")}>
        <ParkedDecisions
          busy={busySection === "parked"}
          locked={locked}
          rows={summary.decisions.parked.rows}
          onApply={runParkedDecisions}
        />
      </Section>

      <Section {...sectionProps("chronic")}>
        <ChronicDecisions
          busy={busySection === "chronic"}
          locked={locked}
          rows={summary.decisions.chronic.rows}
          onApply={runChronicDecisions}
        />
      </Section>

      <Section {...sectionProps("fallow")}>
        <FallowDecisions rows={summary.decisions.fallowSuggestions} locked={locked} />
      </Section>
    </div>
  );
}

/** Shared kicker/title header for the panel states (off, not-due). The editable
 * form keeps its own richer header (window line + actions). */
function WeeklyHeader() {
  return (
    <div className="wk-head">
      <div>
        <p className="wk-kicker">Weekly session</p>
        <h1 className="wk-title">Ledger and integrity</h1>
      </div>
    </div>
  );
}

/**
 * Off-state panel: weekly review is disabled, so there is no session to render.
 * Mirrors the `.wk-complete` card shell with a neutral (non-`--ok`) icon and a
 * pointer to Settings, rather than presenting a fully-locked editable form.
 */
function WeeklyReviewOff() {
  return (
    <div className="wk" data-testid="weekly-off">
      <WeeklyHeader />
      <div className="wk-complete">
        <div className="wk-complete__panel">
          <span className="wk-complete__icon wk-complete__icon--muted">
            <Icon name="calendar" size={26} />
          </span>
          <h2 className="wk-complete__title">Weekly review is turned off</h2>
          <p className="wk-complete__body">
            Enable the weekly session in Settings to run the ledger-and-integrity review.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Not-yet-due acknowledgment: a session exists but is not due. Reached two ways,
 * which the copy distinguishes via `justCompleted`:
 *  - just finished a session this visit → celebratory "Weekly review complete";
 *  - simply landed before the next one is due (or never started one) → calm
 *    "you're all caught up".
 * Keeps the kicker/title header for continuity, shows the next due date, and a
 * "Review now" escape hatch to open the not-yet-due session early.
 *
 * Purely presentational — it renders because the body now reads `summary.due`; no
 * mutation, mount guard, or loading state is involved.
 */
function WeeklyReviewNotDue({
  session,
  justCompleted,
  onReviewNow,
}: {
  readonly session: TaskSummary;
  readonly justCompleted: boolean;
  readonly onReviewNow: () => void;
}) {
  const title = justCompleted ? "Weekly review complete" : "You're all caught up";
  const body = justCompleted
    ? "Your weekly session is done — the next one is scheduled below."
    : "No weekly review is due right now.";
  return (
    <div className="wk" data-testid="weekly-complete">
      <WeeklyHeader />
      <div className="wk-complete">
        <div className="wk-complete__panel">
          <span className="wk-complete__icon">
            <Icon name="checkCircle" size={26} />
          </span>
          <h2 className="wk-complete__title">{title}</h2>
          <p className="wk-complete__body">{body}</p>
          {session.dueAt ? (
            <p className="wk-complete__due">
              <Icon name="calendar" size={13} />
              Next session due <span className="mono">{formatDate(session.dueAt)}</span>
            </p>
          ) : null}
          <div className="wk-complete__actions">
            <button
              type="button"
              className="btn btn--ghost"
              data-testid="weekly-review-now"
              onClick={onReviewNow}
            >
              <Icon name="review" size={14} />
              Review now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({
  meta,
  state,
  locked,
  busy,
  onToggle,
  children,
}: {
  readonly meta: SectionMeta;
  readonly state: SectionState;
  readonly locked: boolean;
  readonly busy: boolean;
  readonly onToggle: (target: "done" | "skipped") => void;
  readonly children: ReactNode;
}) {
  const cls = cx(
    "wk-sec",
    state === "done" && "wk-sec--done",
    state === "skipped" && "wk-sec--skipped",
  );
  return (
    <section className={cls} data-state={state} data-screen-label={`Weekly · ${meta.title}`}>
      <div className="wk-sec__head">
        <span className="wk-sec__num">{meta.n}</span>
        <span className="wk-sec__ico">
          <Icon name={meta.icon} size={16} />
        </span>
        <div className="wk-sec__tt">
          <div className="wk-sec__title">
            {meta.title}
            <WkState state={state} />
          </div>
          <div className="wk-sec__sub">{meta.sub}</div>
        </div>
        <div className="wk-sec__actions">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={locked || busy}
            onClick={() => onToggle("skipped")}
          >
            Skip
          </button>
          <button
            type="button"
            className={`btn btn--sm${state === "done" ? " btn--soft" : ""}`}
            disabled={locked || busy}
            onClick={() => onToggle("done")}
          >
            {state === "done" ? (
              <>
                <Icon name="check" size={13} />
                Done
              </>
            ) : (
              "Done"
            )}
          </button>
        </div>
      </div>
      <div className="wk-sec__body">{children}</div>
    </section>
  );
}

function WkState({ state }: { state: SectionState }) {
  if (state === "done") {
    return (
      <span className="wk-state wk-state--done">
        <Icon name="check" size={11} />
        Done
      </span>
    );
  }
  if (state === "skipped") {
    return <span className="wk-state wk-state--skipped">Skipped</span>;
  }
  return <span className="wk-state wk-state--pending">Pending</span>;
}

function LedgerFunnel({ ledger }: { ledger: WeeklyReviewLedger }) {
  const stages: readonly {
    key: "source" | "extract" | "card" | "matured";
    label: string;
    icon: IconName;
    cur: number;
    prev: number | undefined;
  }[] = [
    {
      key: "source",
      label: "Sources read",
      icon: "source",
      cur: ledger.sources,
      prev: ledger.sourcesPrev,
    },
    {
      key: "extract",
      label: "Extracts made",
      icon: "extract",
      cur: ledger.extracts,
      prev: ledger.extractsPrev,
    },
    {
      key: "card",
      label: "Cards created",
      icon: "card",
      cur: ledger.cards,
      prev: ledger.cardsPrev,
    },
    {
      key: "matured",
      label: "Cards matured",
      icon: "brain",
      cur: ledger.maturedCards,
      prev: ledger.maturedCardsPrev,
    },
  ];
  return (
    <div className="wk-funnel">
      {stages.map((stage, i) => (
        <Fragment key={stage.key}>
          <div className={`wk-stage wk-stage--${stage.key}`}>
            <span className="wk-stage__lbl">
              <Icon name={stage.icon} size={13} />
              {stage.label}
            </span>
            <span className="wk-stage__val">{stage.cur}</span>
            <Delta cur={stage.cur} prev={stage.prev} />
          </div>
          {i < stages.length - 1 ? (
            <div className="wk-arrow">
              <Icon name="chevronRight" size={16} />
            </div>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

function Delta({ cur, prev }: { cur: number; prev: number | undefined }) {
  if (prev === undefined) return null;
  const diff = cur - prev;
  if (diff === 0) return <span className="wk-stage__delta down">±0 vs last wk</span>;
  const up = diff > 0;
  return (
    <span className={`wk-stage__delta ${up ? "up" : "down"}`}>
      <Icon name={up ? "arrowUp" : "arrowDown"} size={11} />
      {Math.abs(diff)} vs last wk
    </span>
  );
}

/** A single integrity boolean-flag card (`.wk-flag`, amber when `active`). */
function FlagCard({
  label,
  active,
  value,
  children,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly value: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className={cx("wk-flag", active && "wk-flag--on")}>
      <div className="wk-flag__top">
        <span className="wk-flag__lbl">{label}</span>
        <span className="wk-flag__dot" />
      </div>
      <span className="wk-flag__val">{value}</span>
      {children}
    </div>
  );
}

/** Priority-miss severity bars, normalized to the largest deferred count. */
function PriorityMissList({ misses }: { misses: readonly WeeklyReviewPriorityMiss[] }) {
  const max = Math.max(1, ...misses.map((miss) => miss.deferred));
  return (
    <div className="wk-misses">
      {misses.map((miss) => {
        const band = miss.band.toLowerCase();
        return (
          <div className="wk-miss" key={miss.band}>
            <span className="wk-miss__band">
              <span className={`prio-dot prio-dot--${band}`} />
              Band {miss.band}
            </span>
            <span className="wk-miss__bar">
              <i
                style={{
                  width: `${(miss.deferred / max) * 100}%`,
                  background: PRIO_VAR[band] ?? "var(--text-3)",
                }}
              />
            </span>
            <span className="wk-miss__debt">
              <b>{miss.deferred}</b> deferred · {miss.postponeDebtDays.toFixed(1)}d debt
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Display-only fallow suggestions (no apply); parallels Parked/Chronic decisions. */
function FallowDecisions({
  rows,
  locked: _locked,
}: {
  readonly rows: readonly WeeklyReviewFallowSuggestion[];
  readonly locked: boolean;
}) {
  if (rows.length === 0) {
    return emptyOk("No fallow suggestions — nothing is ready to rest.");
  }
  return (
    <div className="wk-decisions">
      {rows.map((row) => (
        <div className="wk-decision" key={row.topicId}>
          <div className="wk-decision__main">
            <TypeIcon type="topic" />
            <div className="wk-decision__txt">
              <div className="wk-decision__title truncate">{row.title}</div>
              <div className="wk-decision__meta">
                <span className="badge badge--soft">Band {row.band}</span>
                <span className="mono">{row.deferred} deferred</span>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ParkedDecisions({
  rows,
  busy,
  locked,
  onApply,
}: {
  readonly rows: readonly ParkedResurfacingRowSummary[];
  readonly busy: boolean;
  readonly locked: boolean;
  readonly onApply: (
    decisions: readonly { readonly id: string; readonly kind: ParkedResurfacingDecisionKind }[],
  ) => Promise<void>;
}) {
  const [decisions, setDecisions] = useState<Record<string, ParkedResurfacingDecisionKind>>({});

  useEffect(() => {
    setDecisions((previous) => {
      const next: Record<string, ParkedResurfacingDecisionKind> = {};
      for (const row of rows) next[row.element.id] = previous[row.element.id] ?? "keepParked";
      return next;
    });
  }, [rows]);

  if (rows.length === 0) {
    return emptyOk("No parked sources are due to resurface.");
  }

  return (
    <>
      <div className="wk-decisions">
        {rows.map((row) => {
          const current = decisions[row.element.id] ?? "keepParked";
          return (
            <div className="wk-decision" key={row.element.id}>
              <div className="wk-decision__main">
                <TypeIcon type={row.element.type} />
                <div className="wk-decision__txt">
                  <div className="wk-decision__title truncate">{row.element.title}</div>
                  <div className="wk-decision__meta">
                    <Prio priority={row.element.priority} />
                    <span className="mono">parked {row.ageDays}d</span>
                  </div>
                </div>
              </div>
              <div className="wk-decision__right">
                <WkSeg<ParkedResurfacingDecisionKind>
                  ariaLabel={`Decision for ${row.element.title}`}
                  disabled={busy}
                  value={current}
                  options={[
                    ["keepParked", "Keep", "go"],
                    ["queueNow", "Queue", "go"],
                    ["letGo", "Let go", "danger"],
                  ]}
                  onChange={(kind) =>
                    setDecisions((previous) => ({ ...previous, [row.element.id]: kind }))
                  }
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="wk-applybar">
        <span className="wk-applybar__note">
          Decisions run through the same parked-resurfacing commands as Maintenance.
        </span>
        <button
          type="button"
          className="btn btn--soft"
          disabled={busy || locked}
          onClick={() =>
            void onApply(
              rows.map((row) => ({
                id: row.element.id,
                kind: decisions[row.element.id] ?? "keepParked",
              })),
            )
          }
        >
          <Icon name="check" size={14} />
          Apply parked decisions
        </button>
      </div>
    </>
  );
}

function ChronicDecisions({
  rows,
  busy,
  locked,
  onApply,
}: {
  readonly rows: readonly ChronicPostponeRowSummary[];
  readonly busy: boolean;
  readonly locked: boolean;
  readonly onApply: (decisions: readonly ChronicPostponeDecisionInput[]) => Promise<void>;
}) {
  const [decisions, setDecisions] = useState<Record<string, ChronicPostponeDecisionKind>>({});
  const [fallowDates, setFallowDates] = useState<Record<string, string>>({});

  useEffect(() => {
    const activeIds = new Set(rows.map((row) => row.element.id));
    setDecisions((previous) => pruneRecord(previous, activeIds));
    setFallowDates((previous) => pruneRecord(previous, activeIds));
  }, [rows]);

  if (rows.length === 0) {
    return emptyOk("No chronic postpones are due for reckoning.");
  }

  const selected: ChronicPostponeDecisionInput[] = [];
  let hasInvalidFallowDate = false;
  for (const row of rows) {
    const kind = decisions[row.element.id];
    if (!kind) continue;
    if (kind === "fallow") {
      const fallowUntil = fallowDateToIso(fallowDates[row.element.id] ?? "");
      if (!fallowUntil) {
        hasInvalidFallowDate = true;
        continue;
      }
      selected.push({
        id: row.element.id,
        kind,
        fallowUntil,
        fallowReason: CHRONIC_FALLOW_REASON,
      });
    } else {
      selected.push({ id: row.element.id, kind });
    }
  }

  const setDecision = (id: string, kind: ChronicPostponeDecisionKind) => {
    setDecisions((previous) => ({ ...previous, [id]: kind }));
    if (kind === "fallow") {
      setFallowDates((previous) =>
        previous[id] ? previous : { ...previous, [id]: defaultFallowDate() },
      );
    }
  };

  const applyNote = hasInvalidFallowDate
    ? "Set a valid return date to apply."
    : selected.length > 0
      ? `${selected.length} verdict${selected.length === 1 ? "" : "s"} ready.`
      : "Pick a verdict for each chronic item.";

  return (
    <>
      <div className="wk-decisions">
        {rows.map((row) => {
          const current = decisions[row.element.id] ?? null;
          return (
            <div className="wk-decision" key={row.element.id}>
              <div className="wk-decision__main">
                <TypeIcon type={row.element.type} />
                <div className="wk-decision__txt">
                  <div className="wk-decision__title truncate">{row.element.title}</div>
                  <div className="wk-decision__meta">
                    <Prio priority={row.element.priority} />
                    <span className="mono">postponed {row.postponeCount}×</span>
                  </div>
                </div>
              </div>
              <div className="wk-decision__right">
                {current === "fallow" ? (
                  <label className="wk-date">
                    <span>Return</span>
                    <input
                      type="date"
                      value={fallowDates[row.element.id] ?? defaultFallowDate()}
                      disabled={busy}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setFallowDates((previous) => ({ ...previous, [row.element.id]: value }));
                      }}
                    />
                  </label>
                ) : null}
                <WkSeg<ChronicPostponeDecisionKind>
                  ariaLabel={`Decision for ${row.element.title}`}
                  disabled={busy}
                  value={current}
                  options={[
                    ["keep", "Keep", "go"],
                    ["demote", "Demote", "go"],
                    ["done", "Done", "ok"],
                    ["delete", "Delete", "danger"],
                    ...(row.element.type === "topic"
                      ? ([["fallow", "Rest", "rest"]] as const)
                      : []),
                  ]}
                  onChange={(kind) => setDecision(row.element.id, kind)}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="wk-applybar">
        <span className="wk-applybar__note">{applyNote}</span>
        <button
          type="button"
          className="btn btn--soft"
          disabled={busy || locked || selected.length === 0 || hasInvalidFallowDate}
          onClick={() => void onApply(selected)}
        >
          <Icon name="check" size={14} />
          Apply chronic decisions
        </button>
      </div>
    </>
  );
}

/** Page-local segmented decision control (matches the mock's `.wk-seg`). */
function WkSeg<T extends string>({
  ariaLabel,
  disabled,
  value,
  options,
  onChange,
}: {
  readonly ariaLabel: string;
  readonly disabled: boolean;
  readonly value: T | null;
  readonly options: readonly (readonly [T, string, string])[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <fieldset className="wk-seg" aria-label={ariaLabel}>
      {options.map(([option, label, tone]) => (
        <button
          type="button"
          key={option}
          data-active={value === option}
          data-tone={tone}
          aria-pressed={value === option}
          disabled={disabled}
          onClick={() => onChange(option)}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}

function emptyOk(text: string) {
  return (
    <div className="wk-empty">
      <span className="wk-empty__ico">
        <Icon name="check" size={13} />
      </span>
      {text}
    </div>
  );
}

function cadenceLabel(cadenceDays: number): string {
  if (cadenceDays === 7) return "Weekly";
  if (cadenceDays === 1) return "Daily";
  return `Every ${cadenceDays}d`;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
}

function defaultFallowDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 14);
  return date.toISOString().slice(0, 10);
}

function fallowDateToIso(dateValue: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return null;
  const date = new Date(`${dateValue}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return null;
  return date.toISOString();
}

function pruneRecord<T>(
  record: Record<string, T>,
  activeIds: ReadonlySet<string>,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [id, value] of Object.entries(record)) {
    if (activeIds.has(id)) next[id] = value;
  }
  return next;
}

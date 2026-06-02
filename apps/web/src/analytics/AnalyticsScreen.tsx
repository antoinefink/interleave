/**
 * Analytics view (T045) — the system-wide learning-health snapshot.
 *
 * Rebuilt from the design kit's `AnalyticsScreen` (`design/kit/app/screen-analytics.jsx`):
 * a centered column with a top row of `Metric` tiles (Retention, Reviews, Day
 * streak, Due), a "Reviews per day" `Spark` panel, and a "System health" panel of
 * `Banner`s (leeches → /maintenance/leeches; deletions → /trash).
 *
 * Architecture (non-negotiable): this is UI ONLY — NO aggregation, NO SQL, NO date
 * math beyond formatting the already-computed numbers. The entire snapshot comes
 * from `appApi.getAnalytics()` (read-only; the domain `AnalyticsService` does all
 * the work over `review_logs`/`elements`/`review_states`), so the numbers are
 * correct, survive an app restart, and match what the user actually graded.
 *
 * The kit's "7-day forecast" + "Retention by concept" panels need a forecast model
 * + concept-level retention — both deferred to M17/T083; M9 renders only the data
 * we actually have. T046 will add the import/process balance `Banner` here.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { BalanceBanner } from "../components/BalanceBanner";
import { Icon } from "../components/Icon";
import { type AnalyticsGetResult, appApi, isDesktop } from "../lib/appApi";
import { UNDO_EVENT } from "../shell/nav";
import "./analytics.css";

/** Format a `[0,1]` retention fraction as a percentage string, or "—" when null. */
function formatRetention(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}`;
}

/** A small whole-number formatter with thousands separators. */
function formatCount(value: number): string {
  return Math.round(value).toLocaleString();
}

export function AnalyticsScreen() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const [data, setData] = useState<AnalyticsGetResult | null>(null);
  // The number of low-yield sources (T083) — drives the "Low-yield sources" banner.
  // Read from the SAME read-only `SourceYieldQuery` the dedicated view renders.
  const [lowYieldCount, setLowYieldCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setLoading(false);
      return;
    }
    try {
      const [res, yield_] = await Promise.all([appApi.getAnalytics(), appApi.getSourceYield()]);
      setData(res);
      setLowYieldCount(yield_.lowYieldCount);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read after a global undo (⌘Z) reverts a mutation elsewhere so the numbers
  // stay live without a manual refresh.
  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(UNDO_EVENT, handler);
    return () => window.removeEventListener(UNDO_EVENT, handler);
  }, [load]);

  if (!desktop) {
    return (
      <div className="an-shell" data-testid="route-analytics">
        <div className="an-empty">
          <div className="an-empty__icon">
            <Icon name="analytics" size={26} />
          </div>
          <h1 className="an-empty__title">Analytics</h1>
          <p className="an-empty__body">
            Your learning system at a glance — daily reviews, retention, and what is due. Open the
            Electron app to see the numbers.
          </p>
        </div>
      </div>
    );
  }

  const sparkData = data?.reviewsByDay ?? [];
  const sparkMax = sparkData.reduce((m, d) => Math.max(m, d.count), 0);

  return (
    <div className="an-shell" data-testid="route-analytics">
      <div className="an-head">
        <div>
          <h1 className="an-title">Analytics</h1>
          <p className="an-sub">
            Your learning system at a glance · last {data?.windowDays ?? 30} days
          </p>
        </div>
      </div>

      {error ? (
        <p className="an-error" data-testid="analytics-error">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="an-loading" data-testid="analytics-loading">
          Loading…
        </p>
      ) : data ? (
        <div className="an-body" data-testid="analytics-body">
          {/* Import/process balance warning (T046) — advisory; hidden when balanced. */}
          <BalanceBanner asOf={data.asOf} />

          {/* Top metric row */}
          <div className="an-metrics">
            <div className="an-metric" data-testid="metric-retention">
              <span className="an-metric__val">
                {formatRetention(data.retention30d)}
                {data.retention30d !== null ? <span className="an-metric__suffix">%</span> : null}
              </span>
              <span className="an-metric__label">Retention</span>
              <span className="an-metric__sub">not-again, 30d</span>
            </div>
            <div className="an-metric" data-testid="metric-reviews">
              <span className="an-metric__val">{formatCount(data.reviewsTotal)}</span>
              <span className="an-metric__label">Reviews</span>
              <span className="an-metric__sub">≈ {Math.round(data.reviewsPerDayAvg)} / day</span>
            </div>
            <div className="an-metric" data-testid="metric-streak">
              <span className="an-metric__val">{formatCount(data.dayStreak)}</span>
              <span className="an-metric__label">Day streak</span>
              <span className="an-metric__sub">consecutive days</span>
            </div>
            <div
              className={`an-metric${data.dueCards > 0 ? " an-metric--danger" : ""}`}
              data-testid="metric-due"
            >
              <span className="an-metric__val">{formatCount(data.dueCards)}</span>
              <span className="an-metric__label">Due cards</span>
              <span className="an-metric__sub">{formatCount(data.dueTopics)} topics due</span>
            </div>
          </div>

          {/* Secondary metric row — throughput + maintenance counts */}
          <div className="an-metrics an-metrics--sm">
            <div className="an-metric an-metric--sm" data-testid="metric-new-cards">
              <span className="an-metric__val">{formatCount(data.newCards)}</span>
              <span className="an-metric__label">New cards</span>
            </div>
            <div className="an-metric an-metric--sm" data-testid="metric-new-extracts">
              <span className="an-metric__val">{formatCount(data.newExtracts)}</span>
              <span className="an-metric__label">New extracts</span>
            </div>
            <div className="an-metric an-metric--sm" data-testid="metric-deletions">
              <span className="an-metric__val">{formatCount(data.deletions)}</span>
              <span className="an-metric__label">Deletions</span>
            </div>
            <div className="an-metric an-metric--sm" data-testid="metric-leeches">
              <span className="an-metric__val">{formatCount(data.leeches)}</span>
              <span className="an-metric__label">Leeches</span>
            </div>
            <div className="an-metric an-metric--sm" data-testid="metric-retired">
              <span className="an-metric__val">{formatCount(data.retired)}</span>
              <span className="an-metric__label">Retired</span>
            </div>
          </div>

          {/* Reviews per day spark */}
          <div className="an-panel">
            <div className="an-panel__head">
              <span className="an-panel__title">Reviews per day</span>
              <span className="an-panel__meta">{data.windowDays} days</span>
            </div>
            <div className="an-spark" data-testid="analytics-spark">
              {sparkData.map((d, i) => (
                <span
                  key={d.date}
                  className={
                    i === sparkData.length - 1 && d.count > 0
                      ? "an-spark__bar an-spark__bar--hot"
                      : "an-spark__bar"
                  }
                  title={`${d.date}: ${d.count}`}
                  style={{ height: `${sparkMax > 0 ? (d.count / sparkMax) * 100 : 0}%` }}
                />
              ))}
            </div>
          </div>

          {/* System health banners */}
          <div className="an-panel">
            <div className="an-panel__head">
              <span className="an-panel__title">System health</span>
            </div>
            <div className="an-banners">
              {data.leeches > 0 ? (
                <button
                  type="button"
                  className="an-banner"
                  data-testid="banner-leeches"
                  onClick={() => void navigate({ to: "/maintenance/leeches" })}
                >
                  <Icon name="leech" size={16} />
                  <span className="an-banner__title">
                    {data.leeches} leech{data.leeches === 1 ? "" : "es"} to repair
                  </span>
                  <Icon name="chevronRight" size={14} />
                </button>
              ) : null}
              {data.deletions > 0 ? (
                <button
                  type="button"
                  className="an-banner"
                  data-testid="banner-deletions"
                  onClick={() => void navigate({ to: "/trash" })}
                >
                  <Icon name="trash" size={16} />
                  <span className="an-banner__title">
                    {data.deletions} item{data.deletions === 1 ? "" : "s"} deleted this window
                  </span>
                  <Icon name="chevronRight" size={14} />
                </button>
              ) : null}
              {data.retired > 0 ? (
                <button
                  type="button"
                  className="an-banner"
                  data-testid="banner-retired"
                  onClick={() => void navigate({ to: "/maintenance/retired" })}
                >
                  <Icon name="archive" size={16} />
                  <span className="an-banner__title">
                    {data.retired} retired card{data.retired === 1 ? "" : "s"} kept for reference
                  </span>
                  <Icon name="chevronRight" size={14} />
                </button>
              ) : null}
              {/* Low-yield sources (T083) — links to the ranked per-source yield view. */}
              {lowYieldCount > 0 ? (
                <button
                  type="button"
                  className="an-banner"
                  data-testid="banner-source-yield"
                  onClick={() => void navigate({ to: "/analytics/sources" })}
                >
                  <Icon name="library" size={16} />
                  <span className="an-banner__title">
                    {lowYieldCount} low-yield source{lowYieldCount === 1 ? "" : "s"} to review
                  </span>
                  <Icon name="chevronRight" size={14} />
                </button>
              ) : null}
              {data.leeches === 0 && data.deletions === 0 && lowYieldCount === 0 ? (
                <div className="an-banner an-banner--ok" data-testid="banner-healthy">
                  <Icon name="checkCircle" size={16} />
                  <span className="an-banner__title">No maintenance needed</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

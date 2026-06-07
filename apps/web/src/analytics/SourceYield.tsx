/**
 * Source-yield view (T083) — the ranked "which sources are not paying their way?"
 * surface.
 *
 * For every live source the domain layer (`SourceYieldQuery` in `packages/local-db`)
 * computes what it actually PRODUCED — read %, extracts/cards/mature-cards created
 * (via the persisted `sourceId` lineage), leeches, and review time — plus a derived
 * `yieldScore`/`yieldBand` (the pure `@interleave/core` `scoreSourceYield` rule). This
 * screen renders those already-computed rows as a ranked table, **lowest-yield first**,
 * so the user can see at a glance which sources to abandon and which paid off.
 *
 * Architecture (non-negotiable): this is UI ONLY — NO SQL, NO scoring, NO read-%
 * math, NO aggregation. The whole payload comes from `appApi.getSourceYield()`
 * (read-only; the domain query does all the work over `elements`/`read_points`/
 * `document_blocks`/`review_states`/`review_logs`/`cards`), so the numbers are
 * correct, survive an app restart, and match what the user produced. Each row's
 * "Open" navigates to the source reader (`/source/$id`); the view never mutates.
 *
 * The FSRS-vs-attention split stays labeled: the source is an attention item; its
 * leeches/mature-cards are its FSRS-card outputs. `timeSpentMs` is REVIEW time on
 * the source's cards (reading time is not tracked) — the column labels it so.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Prio } from "../components/inspector/primitives";
import "../components/inspector/inspector.css";
import { appApi, isDesktop, type SourceYieldListResult, type YieldBand } from "../lib/appApi";
import { UNDO_EVENT } from "../shell/nav";
import "./source-yield.css";

/** Format a `[0,1]` read fraction as a whole-percent string. */
function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Format a review-time duration (ms) compactly: "—" / "Ns" / "Nm" / "Nh Mm". */
function formatTime(ms: number): string {
  if (ms <= 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

/** The human label for a yield band. */
function bandLabel(band: YieldBand): string {
  switch (band) {
    case "high":
      return "High yield";
    case "medium":
      return "Medium";
    case "low":
      return "Low yield";
    default:
      return "Not started";
  }
}

export function SourceYield() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const [data, setData] = useState<SourceYieldListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setLoading(false);
      return;
    }
    try {
      const res = await appApi.getSourceYield();
      setData(res);
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

  // Re-read after a global undo (⌘Z) so the numbers stay live.
  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(UNDO_EVENT, handler);
    return () => window.removeEventListener(UNDO_EVENT, handler);
  }, [load]);

  if (!desktop) {
    return (
      <div className="sy-shell" data-testid="route-source-yield">
        <div className="sy-empty">
          <div className="sy-empty__icon">
            <Icon name="analytics" size={26} />
          </div>
          <h1 className="sy-empty__title">Source yield</h1>
          <p className="sy-empty__body">
            See, per source, what it actually produced — read %, extracts, cards, and review time —
            so you can tell which sources to abandon. Open the Electron app to see the numbers.
          </p>
        </div>
      </div>
    );
  }

  const rows = data?.rows ?? [];

  return (
    <div className="sy-shell" data-testid="route-source-yield">
      <div className="sy-head">
        <div>
          <h1 className="sy-title">
            <Icon name="library" size={18} />
            Source yield
          </h1>
          <p className="sy-sub">
            What each source actually produced, ranked lowest-yield first. Time is review time on
            the source's cards.
          </p>
        </div>
        {data ? (
          <span className="sy-count" data-testid="source-yield-low-count">
            {data.lowYieldCount} low-yield
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="sy-error" data-testid="source-yield-error">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="sy-loading" data-testid="source-yield-loading">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <div className="sy-empty" data-testid="source-yield-empty">
          <div className="sy-empty__icon">
            <Icon name="checkCircle" size={26} />
          </div>
          <h2 className="sy-empty__title">No sources yet</h2>
          <p className="sy-empty__body">
            Import a source and start reading — its yield (read %, extracts, cards, review time)
            will appear here so you can see which sources pay off.
          </p>
        </div>
      ) : (
        <div className="sy-body" data-testid="source-yield-body">
          <div className="sy-table">
            <div className="sy-row sy-row--head">
              <span className="sy-cell sy-cell--src">Source</span>
              <span className="sy-cell sy-cell--read">Read</span>
              <span className="sy-cell sy-cell--blocks">Blocks</span>
              <span className="sy-cell sy-cell--num">Extracts</span>
              <span className="sy-cell sy-cell--num">Cards</span>
              <span className="sy-cell sy-cell--num">Mature</span>
              <span className="sy-cell sy-cell--num">Leeches</span>
              <span className="sy-cell sy-cell--time">Review time</span>
              <span className="sy-cell sy-cell--band">Yield</span>
              <span className="sy-cell sy-cell--act" />
            </div>

            {rows.map((row) => (
              <div
                className={`sy-row sy-row--band-${row.yieldBand}`}
                key={row.source.id}
                data-testid="source-yield-row"
                data-source-id={row.source.id}
                data-band={row.yieldBand}
              >
                <span className="sy-cell sy-cell--src">
                  <Icon name="source" size={14} />
                  <span className="sy-src__title" title={row.source.title}>
                    {row.source.title}
                  </span>
                  <Prio priority={row.source.priority} />
                </span>

                <span className="sy-cell sy-cell--read">
                  <span className="sy-bar" aria-hidden="true">
                    <span
                      className="sy-bar__fill"
                      data-testid="source-yield-readbar"
                      style={{ width: `${Math.round(row.readPct * 100)}%` }}
                    />
                  </span>
                  <span className="sy-read__pct">{formatPct(row.readPct)}</span>
                </span>

                <span className="sy-cell sy-cell--blocks">
                  {formatPct(row.processedBlockRatio)}
                  <span className="sy-cell__sub">{row.unresolvedBlocks} open</span>
                </span>
                <span className="sy-cell sy-cell--num">{row.extractsCreated}</span>
                <span className="sy-cell sy-cell--num">{row.cardsCreated}</span>
                <span className="sy-cell sy-cell--num">{row.matureCards}</span>
                <span className={`sy-cell sy-cell--num${row.leeches > 0 ? " sy-cell--warn" : ""}`}>
                  {row.leeches}
                </span>
                <span className="sy-cell sy-cell--time">
                  <Icon name="clock" size={12} />
                  {formatTime(row.timeSpentMs)}
                </span>

                <span className="sy-cell sy-cell--band">
                  <span
                    className={`sy-band sy-band--${row.yieldBand}`}
                    data-testid="source-yield-band"
                  >
                    <span className="sy-band__dot" aria-hidden="true" />
                    {bandLabel(row.yieldBand)}
                  </span>
                </span>

                <span className="sy-cell sy-cell--act">
                  <button
                    type="button"
                    className="sy-open"
                    data-testid="source-yield-open"
                    onClick={() =>
                      void navigate({ to: "/source/$id", params: { id: row.source.id } })
                    }
                  >
                    Open
                    <Icon name="chevronRight" size={13} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

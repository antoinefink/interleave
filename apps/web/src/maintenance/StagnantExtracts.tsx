/**
 * Stagnant-extracts maintenance view (T084) — the attention-side mirror of the leech
 * cleanup screen.
 *
 * Where leeches surface FSRS *cards* that keep failing, this surfaces attention
 * *extracts* that keep COMING BACK without ever PROGRESSING: their stage never
 * advances (`raw_extract → clean_extract → atomic_statement`), they produced no
 * children, and they have been postponed repeatedly. The domain layer
 * (`ExtractStagnationQuery` in `packages/local-db`) detects them with the PURE
 * `@interleave/scheduler` `isStagnant` heuristic and returns each one with its
 * `reasons` + a recommended remediation; this screen renders those already-computed
 * rows and offers the four T024 remedies, the suggested one highlighted:
 *  - **Rewrite** — open the extract editor (`/extract/$id`) to clean it up.
 *  - **Convert** — open the extract editor to turn it into a card (the existing
 *    extract→card path).
 *  - **Postpone** — `appApi.postponeExtract` (a deliberate deferral; removes the row).
 *  - **Delete** — `appApi.deleteExtract` (soft-delete, undoable from trash).
 *
 * Architecture (non-negotiable): UI ONLY — NO detection logic, NO stage/postpone math.
 * The list comes from `appApi.getExtractStagnation()` (read-only), and every action is
 * a typed `appApi.*` call over the preload bridge; the main process owns the
 * transaction + the `operation_log` op. Stagnation is an ATTENTION concern; an extract
 * is never called a "leech".
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Prio } from "../components/inspector/primitives";
import "../components/inspector/inspector.css";
import {
  appApi,
  isDesktop,
  type StagnantExtractRow,
  type StagnationReason,
  type StagnationSuggestion,
} from "../lib/appApi";
import { UNDO_EVENT } from "../shell/nav";
import "../review/review.css";
import "./leech-cleanup.css";
import "./stagnant-extracts.css";

/** The human label for each fired reason (the calm chips). */
const REASON_LABEL: Record<StagnationReason, string> = {
  "postponed-repeatedly": "Postponed repeatedly",
  "no-progress": "No progress",
  "no-children": "No children",
  stale: "Stale",
};

/** The human label + the verb for each suggested remediation. */
const SUGGESTION_LABEL: Record<StagnationSuggestion, string> = {
  rewrite: "Rewrite",
  convert: "Convert to card",
  postpone: "Postpone",
  delete: "Delete",
};

/** The readable extract-stage label for the meta row. */
function stageLabel(stage: string): string {
  switch (stage) {
    case "raw_extract":
      return "Raw";
    case "clean_extract":
      return "Clean";
    case "atomic_statement":
      return "Atomic";
    default:
      return stage;
  }
}

export function StagnantExtracts() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  // The route declares no `validateSearch`, so search is loosely typed. An optional
  // `asOf` date-scopes the scan (used by the E2E to drive a fixed clock so a freshly
  // created, never-aged extract reads as stale); in normal use it defaults to "now".
  const search = useSearch({ strict: false }) as { asOf?: string };
  const asOf = typeof search.asOf === "string" ? search.asOf : undefined;
  const [rows, setRows] = useState<readonly StagnantExtractRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isDesktop()) {
      setLoading(false);
      return;
    }
    try {
      const res = await appApi.getExtractStagnation(asOf ? { asOf } : undefined);
      setRows(res.rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [asOf]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read after a global undo (⌘Z) so a restored extract reappears.
  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(UNDO_EVENT, handler);
    return () => window.removeEventListener(UNDO_EVENT, handler);
  }, [load]);

  /** Rewrite / Convert both OPEN the extract editor — the place to act on it. */
  const open = useCallback(
    (id: string) => {
      void navigate({ to: "/extract/$id", params: { id } });
    },
    [navigate],
  );

  /** Postpone / Delete are direct typed commands; remove the row optimistically. */
  const act = useCallback(
    async (id: string, action: "postpone" | "delete") => {
      setBusyId(id);
      setError(null);
      try {
        if (action === "postpone") await appApi.postponeExtract({ id });
        else await appApi.deleteExtract({ id });
        setRows((prev) => prev.filter((r) => r.extract.id !== id));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  if (!desktop) {
    return (
      <div className="rv-shell" data-testid="route-stagnant-extracts">
        <div className="rv-blank">
          <div className="rv-empty">
            <div className="rv-empty__icon">
              <Icon name="hourglass" size={26} />
            </div>
            <h1 className="rv-empty__title">Stagnant extracts</h1>
            <p className="rv-empty__body">
              Extracts that keep returning without progressing are listed here for repair — open the
              Electron app to clean them up.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rv-shell lc-shell" data-testid="route-stagnant-extracts">
      <div className="lc-head">
        <div>
          <h1 className="lc-title">
            <Icon name="hourglass" size={18} />
            Stagnant extracts
          </h1>
          <p className="lc-sub">
            Extracts that keep coming back without progressing — postponed repeatedly, never
            advanced a stage, no children. Finish, rewrite, postpone deliberately, or drop them.
          </p>
        </div>
        <span className="lc-count" data-testid="stagnant-count">
          {rows.length} stagnant
        </span>
      </div>

      {error ? (
        <p className="pq-error" data-testid="stagnant-error" style={{ padding: "8px 24px" }}>
          {error}
        </p>
      ) : null}

      <div className="lc-list">
        {loading ? (
          <p className="lc-loading" data-testid="stagnant-loading">
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <div className="rv-empty" data-testid="stagnant-empty">
            <div className="rv-empty__icon">
              <Icon name="checkCircle" size={26} />
            </div>
            <h2 className="rv-empty__title">No stagnant extracts</h2>
            <p className="rv-empty__body">
              No extracts are stuck. Extracts that keep returning without ever advancing or
              producing anything will appear here so you can finish or drop them.
            </p>
          </div>
        ) : (
          rows.map((row) => (
            <div
              className="lc-card se-card"
              key={row.extract.id}
              data-testid="stagnant-row"
              data-extract-id={row.extract.id}
              data-suggestion={row.suggestion}
            >
              <div className="lc-card__meta">
                <span className="badge badge--soft">{stageLabel(row.extract.stage)}</span>
                <Prio priority={row.extract.priority} />
                <span className="badge se-badge--postpone" data-testid="stagnant-postpones">
                  Postponed ×{row.postponeCount}
                </span>
                <span className="badge badge--soft" data-testid="stagnant-stale">
                  {row.daysSinceProgress}d no progress
                </span>
              </div>

              <div className="lc-card__body">
                <div className="lc-card__prompt" data-testid="stagnant-title">
                  <Icon name="extract" size={14} />
                  <span className="se-title" title={row.extract.title}>
                    {row.extract.title}
                  </span>
                </div>
                <div className="se-reasons" data-testid="stagnant-reasons">
                  {row.reasons.map((reason) => (
                    <span className="se-reason" key={reason} data-reason={reason}>
                      {REASON_LABEL[reason]}
                    </span>
                  ))}
                </div>
                <div className="se-suggest" data-testid="stagnant-suggestion">
                  <Icon name="sparkle" size={12} />
                  Suggested: {SUGGESTION_LABEL[row.suggestion]}
                </div>
              </div>

              <div className="lc-card__actions" data-testid="stagnant-actions">
                <button
                  type="button"
                  className={`rv-repair__btn${row.suggestion === "rewrite" ? " se-btn--suggested" : ""}`}
                  data-testid="stagnant-rewrite"
                  disabled={busyId === row.extract.id}
                  onClick={() => open(row.extract.id)}
                >
                  <Icon name="edit" size={14} />
                  Rewrite
                </button>
                <button
                  type="button"
                  className={`rv-repair__btn${row.suggestion === "convert" ? " se-btn--suggested" : ""}`}
                  data-testid="stagnant-convert"
                  disabled={busyId === row.extract.id}
                  onClick={() => open(row.extract.id)}
                >
                  <Icon name="card" size={14} />
                  Convert
                </button>
                <button
                  type="button"
                  className={`rv-repair__btn${row.suggestion === "postpone" ? " se-btn--suggested" : ""}`}
                  data-testid="stagnant-postpone"
                  disabled={busyId === row.extract.id}
                  onClick={() => void act(row.extract.id, "postpone")}
                >
                  <Icon name="hourglass" size={14} />
                  Postpone
                </button>
                <button
                  type="button"
                  className={`rv-repair__btn${row.suggestion === "delete" ? " se-btn--suggested" : ""}`}
                  data-testid="stagnant-delete"
                  disabled={busyId === row.extract.id}
                  onClick={() => void act(row.extract.id, "delete")}
                >
                  <Icon name="trash" size={14} />
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

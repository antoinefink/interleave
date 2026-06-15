/**
 * Maintenance hub (T099) — the janitor's dashboard for a large collection.
 *
 * A single view surfacing a fixed set of READ-ONLY reports — duplicate
 * sources/cards/extracts, orphan media, broken sources, cards without sources,
 * low-value-stale candidates, and DB + vault integrity — each as a count card that
 * expands to its drill-down list, and each paired with a CONFIRMABLE cleanup action.
 *
 * Architecture (non-negotiable): UI ONLY — no SQL, no dedup/integrity logic, no
 * scheduling. Every report is read via the typed `appApi.maintenance.*` bridge (the
 * domain queries live in `packages/local-db` + the main `MaintenanceService`); every
 * action is a typed command. Reports append no `operation_log`; cleanup actions are
 * transactional, op-logged, soft-delete / undoable on the main side (the only hard
 * deletes are the existing Trash purge + the vault orphan GC). After a reversible
 * action the screen shows a `Snackbar` "Undo" wired to `appApi.undoLast()` and
 * dispatches `UNDO_EVENT` so the shell + counts re-read; the deep integrity check is
 * on-demand only (never auto-run on view open).
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { Snackbar } from "../components/Snackbar";
import { AutoVirtualList } from "../components/VirtualList";
import {
  appApi,
  type BrokenSourceRowSummary,
  type ChronicPostponeDecisionInput,
  type ChronicPostponeDecisionKind,
  type ChronicPostponeRowSummary,
  type DuplicateReportResult,
  isDesktop,
  type LapseClustersListResult,
  type LineageGapRowSummary,
  type LowValueRowSummary,
  type MaintenanceIntegrityResult,
  type MaintenanceReportResult,
  type ParkedResurfacingDecisionKind,
  type ParkedResurfacingRowSummary,
  type RereadProposalDto,
  type RereadProposalsListResult,
} from "../lib/appApi";
import { UNDO_EVENT } from "../shell/nav";
import "../review/review.css";
import "../maintenance/leech-cleanup.css";
import "./maintenance.css";

/** Format a byte count for the orphan-media metric. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatChronicSkipReason(reason: string | undefined): string {
  switch (reason) {
    case "below-threshold":
      return "below threshold";
    case "already-lowest":
      return "already lowest priority";
    case "source-unresolved-blocks":
      return "source has open blocks";
    case "retired-card":
      return "retired card";
    case "not-actionable":
      return "not actionable";
    case "unsupported-type":
      return "unsupported type";
    case "deleted":
      return "deleted";
    case "missing":
      return "missing";
    default:
      return "stale row";
  }
}

function defaultChronicFallowDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}

function chronicFallowDateToIso(dateValue: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return null;
  const iso = `${dateValue}T00:00:00.000Z`;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== iso) return null;
  return parsed.getTime() > Date.now() ? iso : null;
}

/** Which report card is expanded (one at a time). */
type ExpandedReport =
  | "duplicates"
  | "broken"
  | "sourceless"
  | "lowValue"
  | "parked"
  | "chronic"
  | "clusters"
  | "orphan"
  | null;

export function MaintenanceScreen() {
  const desktop = isDesktop();
  const navigate = useNavigate();
  const [report, setReport] = useState<MaintenanceReportResult | null>(null);
  // Lapse clusters (T128) load eagerly: the count drives the card, the list the drill-down.
  const [clusters, setClusters] = useState<LapseClustersListResult | null>(null);
  // Re-read proposals (T129): the capped, dismissible actionable subset over the clusters.
  // When the feature is off, the panel falls back to the read-only T128 cluster list.
  const [proposals, setProposals] = useState<RereadProposalsListResult | null>(null);
  const [rereadEnabled, setRereadEnabled] = useState(true);
  /** The proposal row (ancestorId) whose accept/dismiss request is in flight. */
  const [rereadBusyId, setRereadBusyId] = useState<string | null>(null);
  /** A quiet inline note per proposal row (cap reached / already scheduled / recovered). */
  const [rereadNote, setRereadNote] = useState<{ ancestorId: string; text: string } | null>(null);
  /** When set, the Snackbar "Undo" reverses the just-accepted re-read (soft-delete), not undoLast. */
  const [rereadUndoTaskId, setRereadUndoTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ExpandedReport>(null);
  const [snack, setSnack] = useState<string | null>(null);
  const [snackUndoable, setSnackUndoable] = useState(false);
  const [busy, setBusy] = useState(false);

  // Drill-down payloads, loaded lazily when a card expands.
  const [duplicates, setDuplicates] = useState<DuplicateReportResult | null>(null);
  const [broken, setBroken] = useState<readonly BrokenSourceRowSummary[] | null>(null);
  const [sourceless, setSourceless] = useState<readonly LineageGapRowSummary[] | null>(null);
  const [lowValue, setLowValue] = useState<readonly LowValueRowSummary[] | null>(null);
  const [parked, setParked] = useState<readonly ParkedResurfacingRowSummary[] | null>(null);
  const [chronic, setChronic] = useState<readonly ChronicPostponeRowSummary[] | null>(null);

  // The on-demand deep integrity check.
  const [integrity, setIntegrity] = useState<MaintenanceIntegrityResult | null>(null);
  const [integrityRunning, setIntegrityRunning] = useState(false);

  const loadReport = useCallback(async () => {
    if (!isDesktop()) {
      setLoading(false);
      return;
    }
    try {
      const res = await appApi.maintenance.report();
      setReport(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // Lapse clusters come from their own read-only channel (not the maintenance report).
    // A failed fetch is non-fatal — the card just shows "—" rather than blocking the hub.
    try {
      setClusters(await appApi.getLapseClusters());
    } catch {
      setClusters({ asOf: "", windowDays: 30, clusters: [] });
    }
    // Re-read proposals (T129): the capped, dismissible subset + the feature toggle. When the
    // toggle is off the panel reverts to the read-only T128 cluster list (Open source only).
    try {
      setRereadEnabled((await appApi.getAppSettings()).settings.rereadProposalsEnabled);
    } catch {
      setRereadEnabled(true);
    }
    try {
      setProposals(await appApi.getRereadProposals());
    } catch {
      setProposals({ asOf: "", windowDays: 30, proposals: [] });
    }
  }, []);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const reloadExpanded = useCallback(async (which: ExpandedReport) => {
    if (!isDesktop()) return;
    try {
      if (which === "duplicates") setDuplicates(await appApi.maintenance.duplicates());
      else if (which === "broken") setBroken((await appApi.maintenance.brokenSources()).rows);
      else if (which === "sourceless")
        setSourceless((await appApi.maintenance.cardsWithoutSources()).rows);
      else if (which === "lowValue") setLowValue((await appApi.maintenance.lowValue()).rows);
      else if (which === "parked")
        setParked((await appApi.maintenance.parkedResurfacing({ limit: 50 })).rows);
      else if (which === "chronic")
        setChronic((await appApi.maintenance.chronicPostpones({ limit: 50 })).rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Re-read counts + the open drill-down after a global undo (⌘Z or our own).
  useEffect(() => {
    const handler = () => {
      void loadReport();
      if (expanded) void reloadExpanded(expanded);
    };
    window.addEventListener(UNDO_EVENT, handler);
    return () => window.removeEventListener(UNDO_EVENT, handler);
  }, [loadReport, expanded, reloadExpanded]);

  const toggle = useCallback(
    async (which: Exclude<ExpandedReport, null>) => {
      const next = expanded === which ? null : which;
      setExpanded(next);
      // Clusters load eagerly; everything else (except orphan) lazy-loads on expand.
      if (next && next !== "orphan" && next !== "clusters") await reloadExpanded(next);
    },
    [expanded, reloadExpanded],
  );

  /**
   * The interim remedy verb (T128 → T129): open the source AT the struggling region so
   * the user can re-read the context. Read-only navigation by stable block id.
   */
  const openClusterRegion = useCallback(
    (region: { sourceElementId: string; blockIds: readonly string[]; label: string }) => {
      const block = region.blockIds[0];
      void navigate({
        to: "/source/$id",
        params: { id: region.sourceElementId },
        search: (block ? { block, label: region.label, n: Date.now() } : {}) as Record<
          string,
          unknown
        >,
      });
    },
    [navigate],
  );

  /**
   * Accept a re-read proposal (T129): schedule the re-read item, then open the source AT the
   * region with the `reread` param so the reader shows the failing-cards panel. The Snackbar
   * "Undo" reverses via the soft-delete path (NOT `undoLast` — a create isn't globally
   * invertible). `capReached`/`alreadyOpen`/`stale` surface a quiet inline note, not an error.
   */
  const onAcceptReread = useCallback(
    async (proposal: RereadProposalDto) => {
      setRereadBusyId(proposal.ancestorId);
      setRereadNote(null);
      setError(null);
      try {
        const res = await appApi.acceptRereadProposal({ ancestorId: proposal.ancestorId });
        if (res.created && res.taskElementId) {
          setProposals(await appApi.getRereadProposals());
          setRereadUndoTaskId(res.taskElementId);
          setSnack("Re-read scheduled");
          setSnackUndoable(true);
          // Pass ONLY `reread` — the reader owns the region jump from the fetched item detail.
          // Passing `block` too would fire a second, redundant jump + toast (matches the queue path).
          void navigate({
            to: "/source/$id",
            params: { id: proposal.region.sourceElementId },
            search: { reread: res.taskElementId, n: Date.now() } as Record<string, unknown>,
          });
        } else if (res.alreadyOpen) {
          setRereadNote({ ancestorId: proposal.ancestorId, text: "Already scheduled" });
        } else if (res.stale) {
          setRereadNote({
            ancestorId: proposal.ancestorId,
            text: "This group has already recovered",
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRereadBusyId(null);
      }
    },
    [navigate],
  );

  /** Dismiss a re-read proposal (T129): remembered against the cluster's state-hash. */
  const onDismissReread = useCallback(async (proposal: RereadProposalDto) => {
    setRereadBusyId(proposal.ancestorId);
    setRereadNote(null);
    setError(null);
    try {
      const res = await appApi.dismissRereadProposal({
        ancestorId: proposal.ancestorId,
        stateHash: proposal.stateHash,
      });
      if (res.dismissed) {
        setProposals(await appApi.getRereadProposals());
      } else if (res.stale) {
        setRereadNote({ ancestorId: proposal.ancestorId, text: "This group has changed" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRereadBusyId(null);
    }
  }, []);

  /** Run a reversible cleanup action, then toast an Undo + refresh. */
  const runUndoable = useCallback(
    async (fn: () => Promise<{ affected: number; batchId: string }>, label: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fn();
        if (res.affected > 0) {
          setSnack(`${label} (${res.affected})`);
          setSnackUndoable(true);
        } else {
          setSnack("Nothing to clean up");
          setSnackUndoable(false);
        }
        await loadReport();
        if (expanded) await reloadExpanded(expanded);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [expanded, loadReport, reloadExpanded],
  );

  /**
   * The Snackbar "Undo". A just-accepted re-read reverses via its soft-delete path (T129 —
   * a create is NOT globally invertible by `undoLast`); everything else reverses the LAST
   * op/batch via the shared command-level undo.
   */
  const onUndo = useCallback(() => {
    setSnack(null);
    setSnackUndoable(false);
    const taskId = rereadUndoTaskId;
    setRereadUndoTaskId(null);
    const reversal = taskId
      ? appApi.undoAcceptRereadProposal({ taskElementId: taskId }).then(async () => {
          setProposals(await appApi.getRereadProposals());
        })
      : appApi.undoLast().then(() => undefined);
    void reversal
      .then(() => window.dispatchEvent(new CustomEvent(UNDO_EVENT)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [rereadUndoTaskId]);

  const runIntegrity = useCallback(async () => {
    setIntegrityRunning(true);
    setError(null);
    try {
      setIntegrity(await appApi.maintenance.integrity());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIntegrityRunning(false);
    }
  }, []);

  const runParkedResurfacing = useCallback(
    async (
      decisions: readonly { readonly id: string; readonly kind: ParkedResurfacingDecisionKind }[],
    ) => {
      setBusy(true);
      setError(null);
      try {
        const res = await appApi.maintenance.parkedResurfacingApply({ decisions });
        if (res.applied > 0) {
          const skipped = res.skipped.length > 0 ? ` · ${res.skipped.length} skipped` : "";
          setSnack(`Updated parked sources (${res.applied})${skipped}`);
          setSnackUndoable(true);
        } else {
          setSnack("Nothing to clean up");
          setSnackUndoable(false);
        }
        await loadReport();
        if (expanded) await reloadExpanded(expanded);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [expanded, loadReport, reloadExpanded],
  );

  const runChronicPostpones = useCallback(
    async (decisions: readonly ChronicPostponeDecisionInput[]) => {
      setBusy(true);
      setError(null);
      try {
        const res = await appApi.maintenance.chronicPostponesApply({ decisions });
        const skippedReason =
          res.skipped.length > 0 ? `: ${formatChronicSkipReason(res.skipped[0]?.reason)}` : "";
        if (res.applied > 0) {
          const skipped =
            res.skipped.length > 0 ? ` · ${res.skipped.length} skipped${skippedReason}` : "";
          setSnack(`Updated chronic postpones (${res.applied})${skipped}`);
          setSnackUndoable(true);
        } else if (res.skipped.length > 0) {
          setSnack(`No changes applied · ${res.skipped.length} skipped${skippedReason}`);
          setSnackUndoable(false);
        } else {
          setSnack("Nothing to clean up");
          setSnackUndoable(false);
        }
        await loadReport();
        if (expanded) await reloadExpanded(expanded);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [expanded, loadReport, reloadExpanded],
  );

  if (!desktop) {
    return (
      <div className="rv-shell" data-testid="route-maintenance">
        <div className="rv-blank">
          <div className="rv-empty">
            <div className="rv-empty__icon">
              <Icon name="shield" size={26} />
            </div>
            <h1 className="rv-empty__title">Maintenance</h1>
            <p className="rv-empty__body">
              Duplicates, orphan media, broken sources, lineage gaps, and integrity checks for a
              large collection live here — open the Electron app to clean up.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rv-shell lc-shell mt-shell" data-testid="route-maintenance">
      <div className="lc-head">
        <div>
          <h1 className="lc-title">
            <Icon name="shield" size={18} />
            Maintenance
          </h1>
          <p className="lc-sub">
            Keep a large collection healthy: find and reclaim duplicates, orphan media, broken
            sources, and lineage gaps — every cleanup is reversible from Trash + Undo.
          </p>
        </div>
        <div className="mt-links" data-testid="maintenance-links">
          <Link to="/maintenance/leeches" className="mt-link">
            Leeches
          </Link>
          <Link to="/maintenance/retired" className="mt-link">
            Retired
          </Link>
          <Link to="/maintenance/stagnant" className="mt-link">
            Stagnant
          </Link>
          <Link
            to="/maintenance/reverify"
            className="mt-link"
            data-testid="maintenance-link-reverify"
          >
            Re-verify
          </Link>
          <Link to="/trash" className="mt-link">
            Trash
          </Link>
        </div>
      </div>

      {error ? (
        <p className="pq-error" data-testid="maintenance-error" style={{ padding: "8px 24px" }}>
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="lc-loading" data-testid="maintenance-loading">
          Loading…
        </p>
      ) : !report ? null : (
        <div className="mt-grid" data-testid="maintenance-grid">
          {/* Duplicates */}
          <MetricCard
            icon="copy"
            title="Duplicates"
            value={report.duplicateCount}
            unit="removable copies"
            testId="metric-duplicates"
            expanded={expanded === "duplicates"}
            onToggle={() => void toggle("duplicates")}
          >
            <DuplicatesPanel
              data={duplicates}
              busy={busy}
              onDedupe={(ids, label) =>
                void runUndoable(() => appApi.maintenance.dedupe({ removeIds: ids }), label)
              }
            />
          </MetricCard>

          {/* Orphan media */}
          <MetricCard
            icon="trash"
            title="Orphan media"
            value={report.orphanFileCount}
            unit={`files · ${formatBytes(report.orphanBytes)}`}
            testId="metric-orphan"
            expanded={expanded === "orphan"}
            onToggle={() => void toggle("orphan")}
          >
            <OrphanPanel
              count={report.orphanFileCount}
              bytes={report.orphanBytes}
              busy={busy}
              onCollect={async () => {
                setBusy(true);
                setError(null);
                try {
                  const res = await appApi.maintenance.orphanMedia({ confirm: true });
                  setSnack(`Reclaimed ${res.removed} files · ${formatBytes(res.freedBytes)}`);
                  await loadReport();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </MetricCard>

          {/* Broken sources */}
          <MetricCard
            icon="warning"
            title="Broken sources"
            value={report ? undefined : 0}
            unit="snapshot missing"
            testId="metric-broken"
            expanded={expanded === "broken"}
            onToggle={() => void toggle("broken")}
            countOf={broken?.length}
          >
            <BrokenPanel
              rows={broken}
              busy={busy}
              onTrash={(ids) =>
                void runUndoable(
                  () => appApi.maintenance.bulkTrash({ ids }),
                  "Moved broken sources to trash",
                )
              }
            />
          </MetricCard>

          {/* Cards without sources */}
          <MetricCard
            icon="link"
            title="Cards without sources"
            value={report.cardsWithoutSourcesCount}
            unit="lineage gaps"
            testId="metric-sourceless"
            expanded={expanded === "sourceless"}
            onToggle={() => void toggle("sourceless")}
          >
            <SourcelessPanel
              rows={sourceless}
              busy={busy}
              onTrash={(ids) =>
                void runUndoable(
                  () => appApi.maintenance.bulkTrash({ ids }),
                  "Moved sourceless cards to trash",
                )
              }
            />
          </MetricCard>

          {/* Low-value candidates */}
          <MetricCard
            icon="hourglass"
            title="Low-value candidates"
            value={report.lowValueCount}
            unit="low-priority, stale"
            testId="metric-lowvalue"
            expanded={expanded === "lowValue"}
            onToggle={() => void toggle("lowValue")}
          >
            <LowValuePanel
              rows={lowValue}
              busy={busy}
              onPostpone={(ids) =>
                void runUndoable(
                  () => appApi.maintenance.bulkPostpone({ ids }),
                  "Postponed low-value items",
                )
              }
              onArchive={(ids, mode) =>
                void runUndoable(
                  () => appApi.maintenance.bulkArchive({ ids, mode }),
                  mode === "trash"
                    ? "Trashed low-value items"
                    : mode === "dismiss"
                      ? "Dismissed low-value items"
                      : "Retired low-value cards",
                )
              }
            />
          </MetricCard>

          {/* Parked resurfacing */}
          <MetricCard
            icon="bookmark"
            title="Parked resurfacing"
            value={report.parkedResurfacingCount}
            unit="saved-for-later due"
            testId="metric-parked"
            expanded={expanded === "parked"}
            onToggle={() => void toggle("parked")}
          >
            <ParkedPanel
              rows={parked}
              busy={busy}
              onApply={(decisions) => void runParkedResurfacing(decisions)}
            />
          </MetricCard>

          {/* Chronic-postpone reckoning */}
          <MetricCard
            icon="hourglass"
            title="Chronic postpones"
            value={report.chronicPostponeCount}
            unit="need a decision"
            testId="metric-chronic"
            expanded={expanded === "chronic"}
            onToggle={() => void toggle("chronic")}
          >
            <ChronicPanel
              rows={chronic}
              busy={busy}
              onApply={(decisions) => void runChronicPostpones(decisions)}
            />
          </MetricCard>

          {/* Struggling card groups (T128) + re-read proposals (T129). When proposals are
              enabled the rows gain Re-read / Dismiss; otherwise the panel stays read-only. */}
          <MetricCard
            icon="layers"
            title="Struggling card groups"
            value={rereadEnabled ? proposals?.proposals.length : clusters?.clusters.length}
            unit="cards failing together"
            testId="metric-clusters"
            expanded={expanded === "clusters"}
            onToggle={() => void toggle("clusters")}
          >
            <ClusterPanel
              enabled={rereadEnabled}
              clusters={clusters}
              proposals={proposals}
              busyId={rereadBusyId}
              note={rereadNote}
              onOpenRegion={openClusterRegion}
              onAccept={onAcceptReread}
              onDismiss={onDismissReread}
            />
          </MetricCard>

          {/* Integrity (on-demand) */}
          <IntegrityCard
            running={integrityRunning}
            report={integrity}
            onRun={() => void runIntegrity()}
          />
        </div>
      )}

      <Snackbar
        message={snack}
        onUndo={snack && snackUndoable ? onUndo : undefined}
        onClose={() => {
          setSnack(null);
          setSnackUndoable(false);
        }}
        testId="maintenance-snackbar"
      />
    </div>
  );
}

/** One report metric card with an expandable drill-down body. */
function MetricCard({
  icon,
  title,
  value,
  countOf,
  unit,
  testId,
  expanded,
  onToggle,
  children,
}: {
  icon: IconName;
  title: string;
  value?: number | undefined;
  countOf?: number | undefined;
  unit: string;
  testId: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const display = value ?? countOf;
  const bodyId = `${testId}-body`;
  return (
    <div className="mt-card" data-testid={testId} data-expanded={expanded}>
      <button
        type="button"
        className="mt-card__head"
        onClick={onToggle}
        data-testid={`${testId}-toggle`}
        aria-expanded={expanded}
        aria-controls={bodyId}
      >
        <span className="mt-card__icon">
          <Icon name={icon} size={16} />
        </span>
        <span className="mt-card__title">{title}</span>
        <span className="mt-card__value" data-testid={`${testId}-value`}>
          {display ?? "—"}
        </span>
        <span className="mt-card__unit">{unit}</span>
        <Icon name={expanded ? "chevronDown" : "chevronRight"} size={14} />
      </button>
      {expanded ? (
        <div className="mt-card__body" id={bodyId}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function DuplicatesPanel({
  data,
  busy,
  onDedupe,
}: {
  data: DuplicateReportResult | null;
  busy: boolean;
  onDedupe: (ids: string[], label: string) => void;
}) {
  if (!data) return <p className="mt-muted">Loading…</p>;
  const clusters = [
    ...data.sourceClusters.map((c) => ({ kind: "source" as const, c })),
    ...data.cardClusters.map((c) => ({ kind: "card" as const, c })),
    ...data.extractClusters.map((c) => ({ kind: "extract" as const, c })),
  ];
  if (clusters.length === 0) {
    return <EmptyRow message="No duplicates found." />;
  }
  const allRemovable = clusters.flatMap(({ c }) => c.duplicates.map((d) => d.id));
  return (
    <div data-testid="duplicates-panel">
      <div className="mt-bulkbar">
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="dedupe-all"
          disabled={busy || allRemovable.length === 0}
          onClick={() => onDedupe(allRemovable, "Trashed redundant copies")}
        >
          <Icon name="trash" size={13} />
          Remove all {allRemovable.length} duplicates
        </button>
      </div>
      {clusters.map(({ kind, c }) => (
        <div className="mt-cluster" key={`${kind}-${c.key}`} data-testid="duplicate-cluster">
          <div className="mt-cluster__head">
            <span className="badge badge--soft">{kind}</span>
            <span className="mt-cluster__match">{c.matchedBy}</span>
            <span className="mt-keeper" data-testid="cluster-keeper">
              keep: {c.canonical.title}
            </span>
          </div>
          <ul className="mt-dup-list">
            {c.duplicates.map((d) => (
              <li key={d.id} data-testid="duplicate-row" data-element-id={d.id}>
                <span className="mt-dup-title" title={d.title}>
                  {d.title}
                </span>
                <button
                  type="button"
                  className="mt-row-btn"
                  data-testid="dedupe-one"
                  disabled={busy}
                  onClick={() => onDedupe([d.id], "Trashed a redundant copy")}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function OrphanPanel({
  count,
  bytes,
  busy,
  onCollect,
}: {
  count: number;
  bytes: number;
  busy: boolean;
  onCollect: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (count === 0) return <EmptyRow message="No orphan media files." />;
  return (
    <div data-testid="orphan-panel">
      <p className="mt-muted">
        {count} vault files reference no live asset (the bytes a hard-purge left behind) —{" "}
        {formatBytes(bytes)}. Reclaiming them is the one vault-side hard delete (it cannot be
        undone, but it never touches a referenced file).
      </p>
      {confirming ? (
        <div className="mt-confirm" data-testid="orphan-confirm">
          <span>Permanently delete {count} orphan files?</span>
          <button
            type="button"
            className="rv-repair__btn rv-repair__btn--danger"
            data-testid="orphan-confirm-yes"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              onCollect();
            }}
          >
            Delete {count} files
          </button>
          <button type="button" className="mt-row-btn" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="orphan-collect"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          <Icon name="trash" size={13} />
          Reclaim {formatBytes(bytes)}
        </button>
      )}
    </div>
  );
}

function BrokenPanel({
  rows,
  busy,
  onTrash,
}: {
  rows: readonly BrokenSourceRowSummary[] | null;
  busy: boolean;
  onTrash: (ids: string[]) => void;
}) {
  if (!rows) return <p className="mt-muted">Loading…</p>;
  if (rows.length === 0) return <EmptyRow message="No broken sources." />;
  const renderRow = (r: BrokenSourceRowSummary) => (
    <li key={r.source.id} data-testid="broken-row" data-element-id={r.source.id}>
      <span className="mt-dup-title" title={r.source.title}>
        {r.source.title}
      </span>
      <span className="badge badge--soft" data-testid="broken-reason">
        {r.reason === "missingFile" ? "file missing" : "no snapshot"}
      </span>
      <Link to="/source/$id" params={{ id: r.source.id }} className="mt-row-btn">
        Open
      </Link>
      <button
        type="button"
        className="mt-row-btn"
        data-testid="broken-trash"
        disabled={busy}
        onClick={() => onTrash([r.source.id])}
      >
        Trash
      </button>
    </li>
  );
  return (
    <div data-testid="broken-panel">
      {/* Virtualized once the report crosses the threshold (T100); inline below it. */}
      <AutoVirtualList
        items={rows}
        itemKey={(r) => r.source.id}
        estimateSize={40}
        height={420}
        className="mt-dup-list mt-dup-list--virtual"
        renderInline={() => <ul className="mt-dup-list">{rows.map(renderRow)}</ul>}
        renderItem={renderRow}
      />
    </div>
  );
}

function SourcelessPanel({
  rows,
  busy,
  onTrash,
}: {
  rows: readonly LineageGapRowSummary[] | null;
  busy: boolean;
  onTrash: (ids: string[]) => void;
}) {
  if (!rows) return <p className="mt-muted">Loading…</p>;
  if (rows.length === 0) return <EmptyRow message="No cards without sources." />;
  const renderRow = (r: LineageGapRowSummary) => (
    <li key={r.card.id} data-testid="sourceless-row" data-element-id={r.card.id}>
      <span className="mt-dup-title" title={r.card.title}>
        {r.card.title}
      </span>
      <button
        type="button"
        className="mt-row-btn"
        data-testid="sourceless-trash"
        disabled={busy}
        onClick={() => onTrash([r.card.id])}
      >
        Trash
      </button>
    </li>
  );
  return (
    <div data-testid="sourceless-panel">
      <p className="mt-muted">
        These cards trace to no source. Open one to attach a source (fix the lineage), or trash it —
        a sourceless card may be intentional, so nothing is auto-deleted.
      </p>
      {/* Virtualized once the report crosses the threshold (T100); inline below it. */}
      <AutoVirtualList
        items={rows}
        itemKey={(r) => r.card.id}
        estimateSize={40}
        height={420}
        className="mt-dup-list mt-dup-list--virtual"
        renderInline={() => <ul className="mt-dup-list">{rows.map(renderRow)}</ul>}
        renderItem={renderRow}
      />
    </div>
  );
}

function LowValuePanel({
  rows,
  busy,
  onPostpone,
  onArchive,
}: {
  rows: readonly LowValueRowSummary[] | null;
  busy: boolean;
  onPostpone: (ids: string[]) => void;
  onArchive: (ids: string[], mode: "trash" | "dismiss" | "retire") => void;
}) {
  if (!rows) return <p className="mt-muted">Loading…</p>;
  if (rows.length === 0) return <EmptyRow message="No low-value, stale candidates." />;
  const ids = rows.map((r) => r.element.id);
  return (
    <div data-testid="lowvalue-panel">
      <div className="mt-bulkbar">
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="lowvalue-postpone"
          disabled={busy}
          onClick={() => onPostpone(ids)}
        >
          <Icon name="hourglass" size={13} />
          Postpone all {ids.length}
        </button>
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="lowvalue-dismiss"
          disabled={busy}
          onClick={() => onArchive(ids, "dismiss")}
        >
          <Icon name="archive" size={13} />
          Dismiss all
        </button>
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="lowvalue-trash"
          disabled={busy}
          onClick={() => onArchive(ids, "trash")}
        >
          <Icon name="trash" size={13} />
          Trash all
        </button>
      </div>
      {/* Virtualized once the report crosses the threshold (T100); inline below it. */}
      <AutoVirtualList
        items={rows}
        itemKey={(r) => r.element.id}
        estimateSize={40}
        height={420}
        className="mt-dup-list mt-dup-list--virtual"
        renderInline={() => <ul className="mt-dup-list">{rows.map(renderLowValueRow)}</ul>}
        renderItem={renderLowValueRow}
      />
    </div>
  );
}

function ParkedPanel({
  rows,
  busy,
  onApply,
}: {
  rows: readonly ParkedResurfacingRowSummary[] | null;
  busy: boolean;
  onApply: (
    decisions: readonly { readonly id: string; readonly kind: ParkedResurfacingDecisionKind }[],
  ) => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, ParkedResurfacingDecisionKind>>({});

  useEffect(() => {
    if (!rows) return;
    setDecisions((prev) => {
      const next: Record<string, ParkedResurfacingDecisionKind> = {};
      for (const row of rows) next[row.element.id] = prev[row.element.id] ?? "keepParked";
      return next;
    });
  }, [rows]);

  if (!rows) return <p className="mt-muted">Loading…</p>;
  if (rows.length === 0) return <EmptyRow message="No parked sources are due to resurface." />;

  const apply = () => {
    onApply(
      rows.map((row) => ({
        id: row.element.id,
        kind: decisions[row.element.id] ?? "keepParked",
      })),
    );
  };

  const renderRowContent = (row: ParkedResurfacingRowSummary) => {
    const current = decisions[row.element.id] ?? "keepParked";
    return (
      <>
        <span className="badge badge--soft">{row.element.priorityLabel}</span>
        <span className="mt-dup-title" title={row.element.title}>
          {row.element.title}
        </span>
        <span className="mt-muted">{row.ageDays}d parked</span>
        <fieldset className="mt-segment">
          <legend className="sr-only">Decision for {row.element.title}</legend>
          <button
            type="button"
            className="mt-segment__btn"
            data-active={current === "keepParked"}
            data-testid="parked-decision-keep"
            aria-pressed={current === "keepParked"}
            disabled={busy}
            onClick={() => setDecisions((prev) => ({ ...prev, [row.element.id]: "keepParked" }))}
          >
            Keep
          </button>
          <button
            type="button"
            className="mt-segment__btn"
            data-active={current === "queueNow"}
            data-testid="parked-decision-queue"
            aria-pressed={current === "queueNow"}
            disabled={busy}
            onClick={() => setDecisions((prev) => ({ ...prev, [row.element.id]: "queueNow" }))}
          >
            Queue
          </button>
          <button
            type="button"
            className="mt-segment__btn"
            data-active={current === "letGo"}
            data-testid="parked-decision-letgo"
            aria-pressed={current === "letGo"}
            disabled={busy}
            onClick={() => setDecisions((prev) => ({ ...prev, [row.element.id]: "letGo" }))}
          >
            Let go
          </button>
        </fieldset>
      </>
    );
  };

  const renderInlineRow = (row: ParkedResurfacingRowSummary) => (
    <li key={row.element.id} data-testid="parked-row" data-element-id={row.element.id}>
      {renderRowContent(row)}
    </li>
  );

  const renderVirtualRow = (row: ParkedResurfacingRowSummary) => {
    return (
      <div data-maintenance-row="true" data-testid="parked-row" data-element-id={row.element.id}>
        {renderRowContent(row)}
      </div>
    );
  };

  return (
    <div data-testid="parked-panel">
      <div className="mt-bulkbar">
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="parked-apply"
          disabled={busy}
          onClick={apply}
        >
          <Icon name="check" size={13} />
          Apply {rows.length} decisions
        </button>
      </div>
      <AutoVirtualList
        items={rows}
        itemKey={(row) => row.element.id}
        estimateSize={44}
        height={420}
        className="mt-dup-list mt-dup-list--virtual"
        role="list"
        rowRole="listitem"
        renderInline={() => <ul className="mt-dup-list">{rows.map(renderInlineRow)}</ul>}
        renderItem={renderVirtualRow}
      />
    </div>
  );
}

function ChronicPanel({
  rows,
  busy,
  onApply,
}: {
  rows: readonly ChronicPostponeRowSummary[] | null;
  busy: boolean;
  onApply: (decisions: readonly ChronicPostponeDecisionInput[]) => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, ChronicPostponeDecisionKind>>({});
  const [fallowDates, setFallowDates] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!rows) return;
    setDecisions((prev) => {
      const activeIds = new Set(rows.map((row) => row.element.id));
      const next: Record<string, ChronicPostponeDecisionKind> = {};
      for (const [id, decision] of Object.entries(prev)) {
        if (activeIds.has(id)) next[id] = decision;
      }
      return next;
    });
    setFallowDates((prev) => {
      const activeIds = new Set(rows.map((row) => row.element.id));
      const next: Record<string, string> = {};
      for (const [id, date] of Object.entries(prev)) {
        if (activeIds.has(id)) next[id] = date;
      }
      return next;
    });
  }, [rows]);

  if (!rows) return <p className="mt-muted">Loading…</p>;
  if (rows.length === 0) return <EmptyRow message="No chronically postponed items." />;

  const selected: ChronicPostponeDecisionInput[] = [];
  let hasInvalidFallowDate = false;
  for (const row of rows) {
    const kind = decisions[row.element.id];
    if (!kind) continue;
    if (kind === "fallow") {
      const fallowUntil = chronicFallowDateToIso(fallowDates[row.element.id] ?? "");
      if (!fallowUntil) {
        hasInvalidFallowDate = true;
        continue;
      }
      selected.push({
        id: row.element.id,
        kind,
        fallowUntil,
        fallowReason: "Rested from chronic-postpone reckoning",
      });
    } else {
      selected.push({ id: row.element.id, kind });
    }
  }

  const setDecision = (id: string, kind: ChronicPostponeDecisionKind) => {
    setDecisions((prev) => ({ ...prev, [id]: kind }));
    if (kind === "fallow") {
      setFallowDates((prev) => (prev[id] ? prev : { ...prev, [id]: defaultChronicFallowDate() }));
    }
  };

  const renderRowContent = (row: ChronicPostponeRowSummary) => {
    const current = decisions[row.element.id] ?? null;
    const fallowDate = fallowDates[row.element.id] ?? defaultChronicFallowDate();
    return (
      <>
        <span className="badge badge--soft">{row.element.priorityLabel}</span>
        <span className="mt-dup-title" title={row.element.title}>
          {row.element.title}
        </span>
        <span className="mt-muted">
          {row.element.type} · {row.scheduler} · {row.postponeCount}x
        </span>
        <fieldset className="mt-segment">
          <legend className="sr-only">Decision for {row.element.title}</legend>
          <button
            type="button"
            className="mt-segment__btn"
            data-active={current === "keep"}
            data-testid="chronic-decision-keep"
            aria-pressed={current === "keep"}
            disabled={busy}
            onClick={() => setDecision(row.element.id, "keep")}
          >
            Keep
          </button>
          <button
            type="button"
            className="mt-segment__btn"
            data-active={current === "demote"}
            data-testid="chronic-decision-demote"
            aria-pressed={current === "demote"}
            disabled={busy}
            onClick={() => setDecision(row.element.id, "demote")}
          >
            Demote
          </button>
          <button
            type="button"
            className="mt-segment__btn"
            data-active={current === "done"}
            data-testid="chronic-decision-done"
            aria-pressed={current === "done"}
            disabled={busy}
            onClick={() => setDecision(row.element.id, "done")}
          >
            Done
          </button>
          <button
            type="button"
            className="mt-segment__btn"
            data-active={current === "delete"}
            data-testid="chronic-decision-delete"
            aria-pressed={current === "delete"}
            disabled={busy}
            onClick={() => setDecision(row.element.id, "delete")}
          >
            Delete
          </button>
          {row.element.type === "topic" ? (
            <button
              type="button"
              className="mt-segment__btn"
              data-active={current === "fallow"}
              data-testid="chronic-decision-fallow"
              aria-pressed={current === "fallow"}
              disabled={busy}
              onClick={() => setDecision(row.element.id, "fallow")}
            >
              Rest
            </button>
          ) : null}
        </fieldset>
        {current === "fallow" ? (
          <label className="mt-fallow-date">
            <span>Return</span>
            <input
              type="date"
              value={fallowDate}
              data-testid="chronic-fallow-date"
              disabled={busy}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setFallowDates((prev) => ({
                  ...prev,
                  [row.element.id]: value,
                }));
              }}
            />
          </label>
        ) : null}
      </>
    );
  };

  const renderInlineRow = (row: ChronicPostponeRowSummary) => (
    <li key={row.element.id} data-testid="chronic-row" data-element-id={row.element.id}>
      {renderRowContent(row)}
    </li>
  );

  const renderVirtualRow = (row: ChronicPostponeRowSummary) => (
    <div data-maintenance-row="true" data-testid="chronic-row" data-element-id={row.element.id}>
      {renderRowContent(row)}
    </div>
  );

  return (
    <div data-testid="chronic-panel">
      <div className="mt-bulkbar">
        <button
          type="button"
          className="rv-repair__btn"
          data-testid="chronic-apply"
          disabled={busy || selected.length === 0 || hasInvalidFallowDate}
          onClick={() => onApply(selected)}
        >
          <Icon name="check" size={13} />
          Apply {selected.length} decisions
        </button>
      </div>
      <AutoVirtualList
        items={rows}
        itemKey={(row) => row.element.id}
        estimateSize={44}
        height={420}
        className="mt-dup-list mt-dup-list--virtual"
        role="list"
        rowRole="listitem"
        renderInline={() => <ul className="mt-dup-list">{rows.map(renderInlineRow)}</ul>}
        renderItem={renderVirtualRow}
      />
    </div>
  );
}

/** One low-value row — shared by the inline + virtualized paths. */
function renderLowValueRow(r: LowValueRowSummary) {
  return (
    <li key={r.element.id} data-testid="lowvalue-row" data-element-id={r.element.id}>
      <span className="badge badge--soft">{r.element.priorityLabel ?? r.element.type}</span>
      <span className="mt-dup-title" title={r.element.title}>
        {r.element.title}
      </span>
      <span className="mt-muted">{r.daysSinceActivity}d stale</span>
    </li>
  );
}

function IntegrityCard({
  running,
  report,
  onRun,
}: {
  running: boolean;
  report: MaintenanceIntegrityResult | null;
  onRun: () => void;
}) {
  const ok = report ? report.db.ok && report.vault.missing.length === 0 : null;
  return (
    <div className="mt-card mt-card--integrity" data-testid="metric-integrity" data-ok={ok}>
      <div className="mt-card__head mt-card__head--static">
        <span className="mt-card__icon">
          <Icon name="shield" size={16} />
        </span>
        <span className="mt-card__title">DB + vault integrity</span>
        {report ? (
          <span
            className={`mt-card__value ${ok ? "mt-ok" : "mt-bad"}`}
            data-testid="integrity-status"
          >
            {ok ? "OK" : "Issues"}
          </span>
        ) : (
          <button
            type="button"
            className="rv-repair__btn"
            data-testid="integrity-run"
            disabled={running}
            onClick={onRun}
          >
            {running ? "Checking…" : "Run check"}
          </button>
        )}
      </div>
      {report ? (
        <div className="mt-card__body" data-testid="integrity-body">
          <ul className="mt-int-list">
            <li>
              DB: <strong>{report.db.ok ? "ok" : report.db.integrityCheck.join(", ")}</strong> ·{" "}
              {report.db.foreignKeyViolations} FK violations · {report.db.mode}
            </li>
            <li>
              Vault: {report.vault.ok} intact · {report.vault.missing.length} missing ·{" "}
              {report.vault.mismatched.length} mismatched · {report.vault.extraFiles.length} extra
            </li>
          </ul>
          <button
            type="button"
            className="mt-row-btn"
            data-testid="integrity-rerun"
            onClick={onRun}
          >
            Re-run
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EmptyRow({ message }: { message: string }) {
  return (
    <div className="mt-empty" data-testid="maintenance-empty-row">
      <Icon name="checkCircle" size={16} />
      <span>{message}</span>
    </div>
  );
}

/**
 * Lapse-cluster drill-down (T128). READ-ONLY: unlike every other panel here, it has NO
 * mutation buttons — the only affordance is opening the source at the struggling region
 * (the interim remedy verb until T129's re-read proposals). The raw strength score is not
 * shown (it only orders the list); member counts are labeled "in {N}d" so they never read
 * as the leech screen's cumulative lapse count.
 */
type ClusterRegion = { sourceElementId: string; blockIds: readonly string[]; label: string };

function OpenSourceButton({
  region,
  onOpenRegion,
}: {
  region: ClusterRegion;
  onOpenRegion: (region: ClusterRegion) => void;
}) {
  return (
    <button
      type="button"
      className="rv-repair__btn"
      data-testid="cluster-open"
      onClick={() => onOpenRegion(region)}
    >
      <Icon name="link" size={13} />
      Open source
    </button>
  );
}

/**
 * The "Struggling card groups" panel. When re-read proposals are ENABLED it renders the capped,
 * dismissible proposal set with Re-read / Dismiss (+ Open source); dismissed/accepted/recent
 * clusters are pre-filtered out server-side. When DISABLED it falls back to the read-only T128
 * cluster list (Open source only). Navigation/region copy is calm — this is help, not an alarm.
 */
function ClusterPanel({
  enabled,
  clusters,
  proposals,
  busyId,
  note,
  onOpenRegion,
  onAccept,
  onDismiss,
}: {
  enabled: boolean;
  clusters: LapseClustersListResult | null;
  proposals: RereadProposalsListResult | null;
  busyId: string | null;
  note: { ancestorId: string; text: string } | null;
  onOpenRegion: (region: ClusterRegion) => void;
  onAccept: (proposal: RereadProposalDto) => void;
  onDismiss: (proposal: RereadProposalDto) => void;
}) {
  // Feature off → the read-only T128 list (navigation only).
  if (!enabled) {
    if (!clusters) return <p className="mt-muted">Loading…</p>;
    if (clusters.clusters.length === 0) {
      return (
        <EmptyRow message="No struggling card groups. Cards that fail together under the same source region will appear here." />
      );
    }
    return (
      <div data-testid="clusters-panel">
        <p className="mt-muted mt-clusters__note">
          These groups are read-only. Open the source to re-read the region the cards share.
        </p>
        {clusters.clusters.map((cluster) => (
          <div className="mt-cluster" key={cluster.ancestorId} data-testid="cluster-row">
            <div className="mt-cluster__head">
              <span className="mt-cluster__source" title={cluster.sourceTitle}>
                {cluster.sourceTitle || "Untitled source"}
              </span>
              <span className="badge badge--soft">{cluster.region.label}</span>
            </div>
            <div className="mt-cluster__meta">
              {cluster.affectedCardCount} cards · {cluster.totalWindowLapses} lapses in{" "}
              {clusters.windowDays}d
            </div>
            <div className="mt-bulkbar">
              <OpenSourceButton region={cluster.region} onOpenRegion={onOpenRegion} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!proposals) return <p className="mt-muted">Loading…</p>;
  if (proposals.proposals.length === 0) {
    return (
      <EmptyRow message="No re-read proposals. When several cards under one source region keep failing together, a quiet re-read suggestion will appear here." />
    );
  }
  return (
    <div data-testid="clusters-panel">
      <p className="mt-muted mt-clusters__note">
        Re-reading a struggling section can repair the encoding. Accept to schedule it, or dismiss —
        dismissals stick until the group gets worse.
      </p>
      {proposals.proposals.map((proposal) => {
        const busy = busyId === proposal.ancestorId;
        return (
          <div className="mt-cluster" key={proposal.ancestorId} data-testid="cluster-row">
            <div className="mt-cluster__head">
              <span className="mt-cluster__source" title={proposal.sourceTitle}>
                {proposal.sourceTitle || "Untitled source"}
              </span>
              <span className="badge badge--soft">{proposal.region.label}</span>
            </div>
            <div className="mt-cluster__meta">
              {proposal.affectedCardCount} cards · {proposal.totalWindowLapses} lapses in{" "}
              {proposals.windowDays}d
            </div>
            <div className="mt-bulkbar">
              <button
                type="button"
                className="rv-repair__btn rv-repair__btn--primary"
                data-testid="cluster-reread"
                disabled={busy}
                onClick={() => onAccept(proposal)}
              >
                Re-read
              </button>
              <button
                type="button"
                className="rv-repair__btn"
                data-testid="cluster-dismiss"
                disabled={busy}
                onClick={() => onDismiss(proposal)}
              >
                Dismiss
              </button>
              <OpenSourceButton region={proposal.region} onOpenRegion={onOpenRegion} />
            </div>
            {note?.ancestorId === proposal.ancestorId ? (
              <p className="mt-muted mt-cluster__note" role="status" data-testid="cluster-note">
                {note.text}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

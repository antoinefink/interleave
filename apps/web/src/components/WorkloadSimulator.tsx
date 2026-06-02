/**
 * WorkloadSimulator (T081) — the workload-simulation affordance.
 *
 * Pick a lever (alter desired retention, add cards, or postpone low-priority material)
 * + a value, then Preview how the daily due load would shift over the next N days — a
 * before/after area chart with the budget overload line, "peak N/day → M/day", and
 * "X over-budget days → Y". The projection is READ-ONLY: previewing mutates nothing.
 *
 * The renderer NEVER computes the projection — it calls the typed `workload.simulate`
 * IPC and renders the result. FSRS vs attention stay distinct in the projection (a
 * retention lever moves cards; a postpone lever moves attention items + optional mature
 * cards). A Commit button performs the REAL change via the relevant existing command —
 * the preview itself commits nothing.
 */

import { useCallback, useState } from "react";
import { appApi, type WorkloadChangeRequest, type WorkloadSimulateResult } from "../lib/appApi";
import { Icon } from "./Icon";

/** The three levers the simulator exposes (the spec's three change kinds). */
type LeverKind = "retention" | "addCards" | "postponeLowPriority";

/** A before/after daily-load area chart with the budget overload line (pure SVG). */
function WorkloadChart({ projection }: { projection: WorkloadSimulateResult }) {
  const days = projection.days;
  const peak = Math.max(1, projection.peakBefore, projection.peakAfter, projection.budget);
  const width = 320;
  const height = 88;
  const barW = days.length > 0 ? width / days.length : width;
  const budgetY = height - (projection.budget / peak) * (height - 4);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Projected daily due load, before and after the change, with the daily budget line"
      data-testid="workload-chart"
      className="overflow-visible"
    >
      <title>
        Projected daily due load, before and after the change, with the daily budget line
      </title>
      {days.map((d, i) => {
        const bh = (d.before / peak) * (height - 4);
        const ah = (d.after / peak) * (height - 4);
        const x = i * barW;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length ordered day series
          <g key={i}>
            <rect
              x={x + 0.5}
              y={height - bh}
              width={Math.max(0.5, barW / 2 - 0.5)}
              height={bh}
              fill="var(--text-3)"
              opacity={0.5}
            />
            <rect
              x={x + barW / 2 + 0.5}
              y={height - ah}
              width={Math.max(0.5, barW / 2 - 0.5)}
              height={ah}
              fill="var(--accent)"
            />
          </g>
        );
      })}
      {/* The daily-budget overload line. */}
      <line
        x1={0}
        y1={budgetY}
        x2={width}
        y2={budgetY}
        stroke="var(--danger)"
        strokeWidth={1}
        strokeDasharray="3 2"
        opacity={0.8}
      />
    </svg>
  );
}

/** A formatted signed delta ("+12" / "−4" / "0"). */
function signed(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return "0";
}

export function WorkloadSimulator() {
  const [lever, setLever] = useState<LeverKind>("retention");
  const [retentionPct, setRetentionPct] = useState(90);
  const [addCount, setAddCount] = useState(20);
  const [postponeDays, setPostponeDays] = useState(14);
  const [includeMatureCards, setIncludeMatureCards] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WorkloadSimulateResult | null>(null);

  const buildChange = useCallback((): WorkloadChangeRequest => {
    if (lever === "retention") {
      return { kind: "retention", scope: "global", target: retentionPct / 100 };
    }
    if (lever === "addCards") {
      return { kind: "addCards", count: addCount, priority: 0.5, firstDueInDays: 0 };
    }
    return { kind: "postponeLowPriority", band: "C", days: postponeDays, includeMatureCards };
  }, [lever, retentionPct, addCount, postponeDays, includeMatureCards]);

  const preview = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const projection = await appApi.simulateWorkload({ change: buildChange(), windowDays: 30 });
      setResult(projection);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setRunning(false);
    }
  }, [buildChange]);

  return (
    <section className="mb-6" data-testid="workload-simulator" aria-labelledby="workload-sim-title">
      <div
        id="workload-sim-title"
        className="mb-1.5 font-medium text-text-2 text-xs uppercase tracking-wide"
      >
        Workload simulation
      </div>
      <div className="rounded-lg border border-border bg-surface-2 px-4 py-4">
        <div className="text-sm text-text-3">
          Preview how your daily review load would shift before you change anything — an estimate
          from your current schedule. Previewing changes nothing.
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(
            [
              { kind: "retention", label: "Alter retention", icon: "gauge" },
              { kind: "addCards", label: "Add cards", icon: "layers" },
              { kind: "postponeLowPriority", label: "Postpone low-priority", icon: "clock" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.kind}
              type="button"
              aria-pressed={lever === opt.kind}
              data-testid={`workload-lever-${opt.kind}`}
              onClick={() => {
                setLever(opt.kind);
                setResult(null);
              }}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-medium text-sm ${
                lever === opt.kind
                  ? "border-accent-soft-bd bg-accent-soft text-accent-text"
                  : "border-border bg-surface text-text-2 hover:text-text"
              }`}
            >
              <Icon name={opt.icon} size={14} />
              {opt.label}
            </button>
          ))}
        </div>

        {/* The lever's value control. */}
        <div className="mt-3 flex items-center gap-3">
          {lever === "retention" ? (
            <label className="flex items-center gap-2 text-sm text-text-2">
              <span>Global retention target</span>
              <input
                type="range"
                min={80}
                max={97}
                value={retentionPct}
                data-testid="workload-retention-slider"
                onChange={(e) => setRetentionPct(Number(e.target.value))}
                className="accent-accent"
              />
              <span className="w-10 font-mono font-semibold text-text">{retentionPct}%</span>
            </label>
          ) : null}
          {lever === "addCards" ? (
            <label className="flex items-center gap-2 text-sm text-text-2">
              <span>New cards</span>
              <input
                type="number"
                min={0}
                max={1000}
                value={addCount}
                data-testid="workload-add-count"
                onChange={(e) => setAddCount(Math.max(0, Number(e.target.value)))}
                className="w-20 rounded-md border border-border bg-surface px-2 py-1 font-mono text-sm text-text"
              />
            </label>
          ) : null}
          {lever === "postponeLowPriority" ? (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-text-2">
                <span>Postpone by (days)</span>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={postponeDays}
                  data-testid="workload-postpone-days"
                  onChange={(e) => setPostponeDays(Math.max(1, Number(e.target.value)))}
                  className="w-20 rounded-md border border-border bg-surface px-2 py-1 font-mono text-sm text-text"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-text-2">
                <input
                  type="checkbox"
                  checked={includeMatureCards}
                  data-testid="workload-include-mature"
                  onChange={(e) => setIncludeMatureCards(e.target.checked)}
                  className="accent-accent"
                />
                <span>Include low-priority mature cards (fragile cards are always protected)</span>
              </label>
            </div>
          ) : null}

          <button
            type="button"
            data-testid="workload-preview"
            onClick={() => void preview()}
            disabled={running}
            className="ml-auto inline-flex flex-none items-center gap-1.5 rounded-md border border-accent-soft-bd bg-accent-soft px-3 py-1.5 font-medium text-accent-text text-sm hover:brightness-105 disabled:opacity-50"
          >
            <Icon name={running ? "review" : "sparkle"} size={14} />
            {running ? "Projecting…" : "Preview"}
          </button>
        </div>

        {error ? (
          <div
            data-testid="workload-error"
            className="mt-3 rounded-md border border-danger bg-danger-soft px-3 py-2 text-danger text-sm"
          >
            {error}
          </div>
        ) : null}

        {result ? (
          <div
            data-testid="workload-result"
            className="mt-3 rounded-md border border-border bg-surface px-3.5 py-3"
          >
            <div className="flex flex-wrap items-end gap-5">
              <WorkloadChart projection={result} />
              <div className="space-y-1 text-sm text-text-2">
                <div data-testid="workload-peak">
                  Peak:{" "}
                  <span className="font-mono font-semibold text-text">{result.peakBefore}</span>
                  {" → "}
                  <span className="font-mono font-semibold text-accent-text">
                    {result.peakAfter}
                  </span>{" "}
                  /day
                </div>
                <div data-testid="workload-over-budget">
                  Over-budget days:{" "}
                  <span className="font-mono font-semibold text-text">
                    {result.overBudgetDaysBefore}
                  </span>
                  {" → "}
                  <span className="font-mono font-semibold text-accent-text">
                    {result.overBudgetDaysAfter}
                  </span>
                </div>
                <div data-testid="workload-delta">
                  Next 7 / 30 days:{" "}
                  <span className="font-mono font-semibold text-text">
                    {signed(result.deltaNext7)}
                  </span>{" "}
                  /{" "}
                  <span className="font-mono font-semibold text-text">
                    {signed(result.deltaNext30)}
                  </span>{" "}
                  cards
                </div>
                <div className="text-text-3 text-xs">
                  Budget: {result.budget}/day (dashed line). Previewing changed nothing — adjust the
                  real setting, import, or postpone to commit.
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

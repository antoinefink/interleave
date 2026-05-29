/**
 * Inspector design primitives (T010).
 *
 * Rebuilt from the kit's `components.jsx` (`TypeIcon`, `Prio`, `Status`, `Stage`,
 * `SchedulerChip`, `FsrsStats`, `MetaRow`, `Tag`) for React 19 + Tailwind v4,
 * driven entirely by the design tokens via the kit class names (defined in
 * `inspector.css`). They translate the canonical `@interleave/core` enum values
 * (`raw_extract`, `mature_card`, …) into the kit's human display labels and the
 * priority A/B/C/D bands, so the inspector renders type-appropriate metadata and
 * the load-bearing FSRS-vs-attention scheduler split exactly like the prototype.
 *
 * UI only — no domain logic, no data fetching. The values come from the typed
 * `window.appApi` inspector payload.
 */

import type { SchedulerSignals } from "../../lib/appApi";
import { Icon, type IconName } from "../Icon";

/** Canonical element-type → kit type-icon name + tone class suffix. */
const TYPE_ICON: Record<string, { icon: IconName; tone: string; label: string }> = {
  source: { icon: "source", tone: "source", label: "Source" },
  topic: { icon: "topic", tone: "topic", label: "Topic" },
  extract: { icon: "extract", tone: "extract", label: "Extract" },
  card: { icon: "card", tone: "card", label: "Card" },
  task: { icon: "task", tone: "task", label: "Task" },
  concept: { icon: "concept", tone: "concept", label: "Concept" },
  media_fragment: { icon: "media", tone: "media", label: "Media fragment" },
  synthesis_note: { icon: "synthesis", tone: "synthesis", label: "Synthesis note" },
};

/** Human label for a canonical element type. */
export function typeLabel(type: string): string {
  return TYPE_ICON[type]?.label ?? type;
}

/** Element-type chip (8 types), colored by `--el-*` token. */
export function TypeIcon({ type, lg }: { type: string; lg?: boolean }) {
  const entry = TYPE_ICON[type] ?? TYPE_ICON.source;
  return (
    <span className={`tico tico--${entry?.tone}${lg ? " tico--lg" : ""}`}>
      <Icon name={entry?.icon ?? "source"} size={lg ? 17 : 14} />
    </span>
  );
}

/** Numeric priority `0.0`–`1.0` → coarse A/B/C/D label (mirrors core/priority). */
export function priorityLabel(priority: number): "A" | "B" | "C" | "D" {
  const v = Math.min(1, Math.max(0, priority));
  if (v >= 0.75) return "A";
  if (v >= 0.5) return "B";
  if (v >= 0.25) return "C";
  return "D";
}

/** Priority A/B/C/D badge. */
export function Prio({ priority }: { priority: number }) {
  const label = priorityLabel(priority);
  return <span className={`badge prio prio--${label.toLowerCase()}`}>{label}</span>;
}

/** Lifecycle status → kit badge variant + display label. */
const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  inbox: { cls: "badge--new", label: "Inbox" },
  pending: { cls: "badge--soft", label: "Pending" },
  active: { cls: "badge--due", label: "Active" },
  scheduled: { cls: "badge--soft", label: "Scheduled" },
  done: { cls: "badge--done", label: "Done" },
  dismissed: { cls: "badge--dismissed", label: "Dismissed" },
  suspended: { cls: "badge--suspended", label: "Suspended" },
  deleted: { cls: "badge--trashed", label: "Trashed" },
};

/** Status badge. */
export function Status({ status }: { status: string }) {
  const entry = STATUS_BADGE[status] ?? { cls: "badge--soft", label: status };
  return <span className={`badge ${entry.cls}`}>{entry.label}</span>;
}

/** Canonical distillation stage → kit display label + dot color token. */
const STAGE_META: Record<string, { label: string; dot: string }> = {
  raw_source: { label: "Reading", dot: "var(--el-source)" },
  rough_topic: { label: "Topic", dot: "var(--el-topic)" },
  raw_extract: { label: "Raw extract", dot: "var(--text-3)" },
  clean_extract: { label: "Clean extract", dot: "var(--el-extract)" },
  atomic_statement: { label: "Atomic statement", dot: "var(--accent)" },
  card_draft: { label: "Card draft", dot: "var(--el-card)" },
  active_card: { label: "Active card", dot: "var(--el-card)" },
  mature_card: { label: "Mature card", dot: "var(--ok)" },
  synthesis: { label: "Synthesis", dot: "var(--el-synthesis)" },
};

/** Human label for a canonical distillation stage. */
export function stageLabel(stage: string): string {
  return STAGE_META[stage]?.label ?? stage;
}

/** Stage badge with a colored dot. */
export function Stage({ stage }: { stage: string }) {
  const entry = STAGE_META[stage] ?? { label: stage, dot: "var(--text-3)" };
  return (
    <span className="stage">
      <span className="stage-dot" style={{ background: entry.dot }} />
      {entry.label}
    </span>
  );
}

/** Retrievability → color token (matches the kit's `retrColor`). */
function retrColor(r: number): string {
  return r >= 0.85 ? "var(--ok)" : r >= 0.7 ? "var(--warn)" : "var(--danger)";
}

/**
 * The scheduler chip — the visible FSRS-vs-attention split (load-bearing).
 *
 * Cards (`kind: "fsrs"`): `brain` icon + `--sched-fsrs` accent, retrievability %
 * + stability days. Everything else (`kind: "attention"`): `gauge` icon +
 * `--sched-attn` accent, stage + postponed ×N.
 */
export function SchedulerChip({ scheduler }: { scheduler: SchedulerSignals }) {
  if (scheduler.kind === "fsrs") {
    const r = scheduler.retrievability;
    return (
      <span
        className="sched sched--fsrs"
        data-scheduler="fsrs"
        data-testid="scheduler-chip"
        title="FSRS · spaced repetition"
      >
        <Icon name="brain" size={12} />
        {r !== null ? (
          <span>
            <b>{Math.round(r * 100)}%</b> recall
          </span>
        ) : (
          <span>new</span>
        )}
        {scheduler.stability !== null && (
          <>
            <span className="sched__sep">·</span>
            <span>S {scheduler.stability}d</span>
          </>
        )}
      </span>
    );
  }
  return (
    <span
      className="sched sched--attn"
      data-scheduler="attention"
      data-testid="scheduler-chip"
      title="Attention scheduler · when to process again"
    >
      <Icon name="gauge" size={12} />
      <span>{stageLabel(scheduler.stage)}</span>
      {scheduler.postponed > 0 && (
        <>
          <span className="sched__sep">·</span>
          <span>postponed ×{scheduler.postponed}</span>
        </>
      )}
    </span>
  );
}

/** The FSRS three-stat readout (Stability / Difficulty / Retrievability). */
export function FsrsStats({ scheduler }: { scheduler: SchedulerSignals }) {
  const stability = scheduler.stability ?? 0;
  const difficulty = scheduler.difficulty ?? 0;
  const r = scheduler.retrievability;
  const rPct = r === null ? 0 : Math.round(r * 100);
  return (
    <div className="fsrs-stats" data-testid="fsrs-stats">
      <div className="fstat">
        <span className="fstat__v">
          {stability}
          <span style={{ fontSize: "var(--t-xs)", color: "var(--text-3)" }}>d</span>
        </span>
        <span className="fstat__l">Stability</span>
        <span className="fstat__bar">
          <i
            style={{
              width: `${Math.min(100, (stability / 60) * 100)}%`,
              background: "var(--accent)",
            }}
          />
        </span>
      </div>
      <div className="fstat">
        <span className="fstat__v">
          {difficulty}
          <span style={{ fontSize: "var(--t-xs)", color: "var(--text-3)" }}>/10</span>
        </span>
        <span className="fstat__l">Difficulty</span>
        <span className="fstat__bar">
          <i
            style={{
              width: `${difficulty * 10}%`,
              background: difficulty > 6 ? "var(--warn)" : "var(--text-3)",
            }}
          />
        </span>
      </div>
      <div className="fstat">
        <span className="fstat__v" style={{ color: r === null ? "var(--text-3)" : retrColor(r) }}>
          {r === null ? "—" : `${rPct}%`}
        </span>
        <span className="fstat__l">Retrievability</span>
        <span className="fstat__bar">
          <i
            style={{
              width: `${rPct}%`,
              background: r === null ? "var(--border)" : retrColor(r),
            }}
          />
        </span>
      </div>
    </div>
  );
}

/** Inspector key/value row. */
export function MetaRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="meta-row">
      <span className="meta-key">{k}</span>
      <span className="meta-val">{children}</span>
    </div>
  );
}

/** Flat tag pill. */
export function Tag({ name }: { name: string }) {
  return <span className="tag">{name}</span>;
}

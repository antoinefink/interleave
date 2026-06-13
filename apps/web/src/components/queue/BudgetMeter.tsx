/**
 * BudgetMeter (T029) — the daily-budget gauge for the Daily Queue.
 *
 * Ported from the design kit's `components.jsx` `BudgetMeter` for React 19, driven
 * entirely by the `.budget` tokens in `queue.css`. It shows estimated minutes vs the
 * configured daily budget (from `SettingsRepository`), splitting the bar
 * into a within-budget segment (accent) and, when over, an over-budget segment
 * (danger) + an "N min over budget" badge. The over-budget AUTO-POSTPONE action is M16
 * (T077/T078) — this only VISUALIZES the over-budget minutes; it never postpones.
 *
 * UI only — no domain logic, no data fetching. The values come from the typed
 * `window.appApi.queue.list` budget payload.
 */

import type { QueueQuotaComposition } from "../../lib/appApi";

export function BudgetMeter({
  used,
  target,
  confidence = "learned",
  composition,
}: {
  used: number;
  target: number;
  confidence?: "learned" | "default";
  composition?: QueueQuotaComposition | undefined;
}) {
  const over = Math.max(0, used - target);
  const within = Math.min(used, target);
  const denom = Math.max(target, used, 1);
  const approximate = confidence === "default" ? "~" : "";
  const usedLabel = Math.round(used);
  const targetLabel = Math.round(target);
  const overLabel = Math.max(0, usedLabel - targetLabel);
  const compositionLabel = compositionText(composition);
  const splitLabel = compositionSplitLabel(composition);
  const ariaLabel = [
    `${approximate}${usedLabel} of ${targetLabel} minutes today`,
    overLabel > 0 ? `${overLabel} minutes over budget` : null,
    compositionLabel,
    splitLabel,
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <section className="budget" data-testid="budget-meter" aria-label={ariaLabel}>
      <div className="budget__head">
        <span className="budget__num">
          {approximate}
          {usedLabel} <span>/ {targetLabel} min today</span>
        </span>
        {over > 0 && (
          <span className="badge badge--overdue" data-testid="budget-over">
            {overLabel} min over budget
          </span>
        )}
      </div>
      <div className="budget__bar">
        <span className="budget__used" style={{ width: `${(within / denom) * 100}%` }} />
        {over > 0 && (
          <span className="budget__over" style={{ width: `${(over / denom) * 100}%` }} />
        )}
      </div>
      <div className="budget__legend">
        <span>
          <i style={{ background: "var(--accent)" }} />
          Within budget
        </span>
        {over > 0 && (
          <span>
            <i style={{ background: "var(--danger)" }} />
            Over budget
          </span>
        )}
      </div>
      {composition && composition.status !== "unavailable_no_time_estimate" ? (
        <div className="budget__composition" data-testid="budget-composition">
          <span>{compositionLabel}</span>
          <span className="budget__chips">
            {compositionChips(composition).map((chip) => (
              <span className="badge" key={chip.label}>
                {chip.label} {chip.minutes} min
              </span>
            ))}
          </span>
        </div>
      ) : null}
    </section>
  );
}

function compositionText(composition: QueueQuotaComposition | undefined): string | null {
  if (!composition) return null;
  if (composition.status === "active") {
    return `Distillation floor active: ${composition.quotaFloorMinutes} min reserved.`;
  }
  if (composition.status === "returned_empty_backlog") {
    return "Distillation share returned: no due extracts.";
  }
  if (composition.status === "inactive_filtered_out") {
    return "Current filter: distillation quota inactive.";
  }
  if (composition.status === "inactive_zero_target") return "Distillation floor off.";
  return null;
}

function compositionChips(
  composition: QueueQuotaComposition,
): readonly { readonly label: string; readonly minutes: number }[] {
  const chips = [
    { label: "Cards", minutes: Math.round(composition.cardMinutes) },
    { label: "Distillation", minutes: Math.round(composition.distillationMinutes) },
    { label: "Other", minutes: Math.round(composition.otherMinutes) },
  ];
  const visible = chips.filter((chip) => chip.minutes > 0);
  return visible.length > 0 ? visible : chips;
}

function compositionSplitLabel(composition: QueueQuotaComposition | undefined): string | null {
  if (!composition || composition.status === "unavailable_no_time_estimate") return null;
  return compositionChips(composition)
    .map((chip) => `${chip.label} ${chip.minutes} minutes`)
    .join(", ");
}

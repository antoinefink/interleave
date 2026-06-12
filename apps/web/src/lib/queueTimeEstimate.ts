import type { QueueTimeEstimate } from "./appApi";

export interface QueueTimeEstimateLabel {
  readonly text: string;
  readonly ariaLabel: string;
}

function pluralizeMinutes(minutes: number): string {
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function formatQueueTimeEstimate(
  estimate: QueueTimeEstimate | null | undefined,
): QueueTimeEstimateLabel | null {
  if (!estimate) return null;
  const rounded =
    estimate.pricedItemCount > 0 && estimate.totalMinutes > 0
      ? Math.max(1, Math.round(estimate.totalMinutes))
      : Math.max(0, Math.round(estimate.totalMinutes));
  if (estimate.confidence === "default") {
    return {
      text: `~${rounded} min`,
      ariaLabel: `About ${pluralizeMinutes(rounded)}; some estimates use defaults.`,
    };
  }
  return {
    text: `${rounded} min`,
    ariaLabel: pluralizeMinutes(rounded),
  };
}

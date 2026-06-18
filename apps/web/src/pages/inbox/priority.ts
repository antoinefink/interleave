/**
 * Shared inbox priority-label helpers.
 *
 * Both `InboxScreen` and the relocated `InboxTriageSection` (rendered inside the
 * shell inspector) need the numeric→band mapping and the per-band cadence hint, so
 * they live here rather than in either component — keeping the inspector section
 * free of an import back into `InboxScreen` (which would form a cycle through the
 * inspector).
 */

import type { PriorityLabelInput } from "../../lib/appApi";

/** Numeric priority `0.0`–`1.0` → coarse A/B/C/D label (mirrors core/priority). */
export function priorityToLabel(priority: number): PriorityLabelInput {
  const v = Math.min(1, Math.max(0, priority));
  if (v >= 0.75) return "A";
  if (v >= 0.5) return "B";
  if (v >= 0.25) return "C";
  return "D";
}

/** Per-band one-line cadence hint shown under the priority picker. */
export const PRIORITY_HINT: Record<PriorityLabelInput, string> = {
  A: "Protected · review daily",
  B: "Important · frequent",
  C: "Normal cadence",
  D: "Someday · low cadence",
};

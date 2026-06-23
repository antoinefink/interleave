/**
 * SessionGauge — the ambient, adaptive minute readout for the /process loop.
 *
 * A compact INLINE readout (not a second full-width bar — the item-progress bar in
 * `ProcessSessionControls` stays the divider) that shows elapsed wall-clock time against
 * the live "remaining due work" estimate. "Remaining" is the backend-priced full filtered
 * due universe (`timeEstimate.totalMinutes`, T115) — the renderer never sums minutes
 * itself. The gauge owns its own seconds tick so the elapsed display stays live WITHOUT
 * re-rendering the heavy process surface every interval.
 *
 * UI only — no domain logic, no data fetching. Confidence-aware (`~` + an sr-only
 * "defaults" clause when any estimate is defaulted) and degrade-safe: an unpriced deck
 * shows "estimate unavailable" rather than a false "0 min left".
 */

import { useEffect, useState } from "react";
import type { QueueQuotaComposition, QueueTimeEstimate } from "../../lib/appApi";
import { formatQueueTimeEstimate } from "../../lib/queueTimeEstimate";

/** Re-tick the elapsed display on this cadence (minute-granularity display, so coarse). */
const TICK_MS = 5000;

export function SessionGauge({
  startedAt,
  estimate,
  reference,
  composition,
  done = false,
}: {
  /** Epoch ms when the current session started (for elapsed wall-clock). */
  startedAt: number;
  /** Backend-priced remaining due work, or null when pricing is unavailable. */
  estimate: QueueTimeEstimate | null;
  /** The reference minute box (explicit target or daily budget), if any. */
  reference: number | undefined;
  /** The day's distillation composition — kept VISIBLE so a card-heavy day's
      distillation share is never silently crowded out of the live-serve order (KTD-5). */
  composition: QueueQuotaComposition | null;
  /** When the deck has drained, freeze the tick and drop the "remaining" framing. */
  done?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (done) return;
    const handle = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(handle);
  }, [done]);

  const elapsedMin = Math.max(0, Math.floor((now - startedAt) / 60000));
  const overMin = reference != null ? Math.max(0, elapsedMin - reference) : 0;

  // A 0-priced deck (`pricedItemCount === 0`) is "unknown", not "done" — never render a
  // false "0 min left" while items remain.
  const remaining =
    estimate && estimate.pricedItemCount > 0 ? formatQueueTimeEstimate(estimate) : null;

  const elapsedText =
    reference != null
      ? overMin > 0
        ? `${elapsedMin} / ${reference} min · +${overMin} over`
        : `${elapsedMin} / ${reference} min`
      : `${elapsedMin} min`;
  const remainingText = done ? "queue clear" : remaining ? `${remaining.text} left` : "—";

  // Distillation visibility (KTD-5): show how much of today's due work is extract
  // distillation, so a card-heavy day makes the share obvious rather than hiding it.
  const distillMin =
    composition && composition.status !== "unavailable_no_time_estimate"
      ? Math.round(composition.distillationMinutes)
      : null;
  const distillText = !done && distillMin != null && distillMin > 0 ? `${distillMin} distill` : null;

  const spoken = done
    ? `${elapsedMin} minutes elapsed; queue clear.`
    : [
        remaining
          ? `About ${remaining.text.replace(/^~/, "")} of due work left`
          : "Time left unknown",
        `${elapsedMin} minutes elapsed`,
        reference != null ? `${reference} minute target` : null,
        distillText ? `${distillMin} minutes distillation due` : null,
        remaining?.ariaLabel.includes("defaults") ? "Some estimates use defaults." : null,
      ]
        .filter(Boolean)
        .join(", ");

  return (
    <div className="pq-gauge" data-testid="process-gauge">
      <span className="pq-gauge__sr" aria-live="polite">
        {spoken}
      </span>
      <span className="pq-gauge__elapsed" aria-hidden>
        {elapsedText}
      </span>
      <span className="pq-gauge__sep" aria-hidden>
        ·
      </span>
      <span className="pq-gauge__remaining" aria-hidden>
        {remainingText}
      </span>
      {distillText ? (
        <span className="pq-gauge__distill" data-testid="process-gauge-distill" aria-hidden>
          {distillText}
        </span>
      ) : null}
    </div>
  );
}

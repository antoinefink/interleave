/**
 * Pure order reconciliation for the live-serve process loop.
 *
 * When a cross-surface mutation refreshes the queue mid-session, the loop must update
 * its order WITHOUT yanking the user's place. This is the trickiest piece of that logic,
 * extracted as a pure function so its branches are table-testable without a React/IPC
 * harness: the already-seen prefix stays put (no re-jitter), the current item is preserved
 * by id (or the loop advances to the nearest surviving item if it vanished), and
 * genuinely-new work is appended at the tail in the fresh score order.
 *
 * When the loop was already drained (cursor at/after the end), reconciliation deliberately
 * STAYS drained — new work is surfaced through the explicit end-of-order "keep going"
 * affordance, never by silently resuming the loop under the user.
 */

export interface ReconcileResult<T> {
  /** The reconciled order: stable seen-prefix + live upcoming (new work appended at tail). */
  readonly nextOrder: readonly T[];
  /** Where the cursor should land (preserves the current item by id; clamped in range). */
  readonly nextCursor: number;
  /** Ids newly appeared in this order (the caller folds these into its seen-id set). */
  readonly newlySeenIds: readonly string[];
}

export function reconcileOrder<T extends { readonly id: string }>(
  prevOrder: readonly T[],
  prevCursor: number,
  fresh: readonly T[],
): ReconcileResult<T> {
  const wasDrained = prevCursor >= prevOrder.length;
  const anchorId = prevOrder[prevCursor]?.id ?? null;
  const prefix = prevOrder.slice(0, prevCursor);
  const prefixIds = new Set(prefix.map((item) => item.id));
  const upcoming = fresh.filter((item) => !prefixIds.has(item.id));
  const nextOrder = [...prefix, ...upcoming];
  const newlySeenIds = upcoming.map((item) => item.id);

  let nextCursor: number;
  if (wasDrained) {
    // Stay drained: newly-arrived work is surfaced via the "keep going" affordance, not
    // by silently resuming the loop the user already finished.
    nextCursor = nextOrder.length;
  } else {
    const anchorIdx = anchorId == null ? -1 : upcoming.findIndex((item) => item.id === anchorId);
    // anchor present -> keep the user on it; anchor gone -> nearest surviving item
    // (the first upcoming item at/after the old position).
    nextCursor = anchorIdx >= 0 ? prefix.length + anchorIdx : prefix.length;
  }

  return {
    nextOrder,
    nextCursor: Math.max(0, Math.min(nextCursor, nextOrder.length)),
    newlySeenIds,
  };
}

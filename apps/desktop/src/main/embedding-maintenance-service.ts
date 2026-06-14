/**
 * EmbeddingMaintenanceService (U3) — the self-healing index supervisor.
 *
 * A main-process lifecycle service (mirroring `AutomaticBackupService`) that keeps
 * the semantic index healthy WITHOUT user action:
 *
 *  - **Startup triage** — shortly after launch (deferred so it doesn't compete with
 *    launch-critical work), if the real model is ready and `embedded < total`, it
 *    enqueues a reindex pass. This is the fix for "0 of N embedded forever": a
 *    pre-existing corpus that never fired the per-mutation auto-embed gets indexed.
 *  - **Paginated catch-up (R11)** — `reindex()` is capped at the batch limit, so a
 *    corpus larger than the cap needs several passes. The poll re-checks and enqueues
 *    the NEXT batch only once the prior one has drained (`queued + running === 0`),
 *    so it converges on a large vault without ever double-queuing the same element.
 *  - **Orphan scrub** — periodically prunes orphan `vec0` rows (rate-limited).
 *  - **Safety (R3, KTD3)** — auto-index is gated on `modelState === "ready"` (never
 *    auto-build with the fallback embedder); ticks are failure-isolated (a thrown
 *    error is logged, the timer survives); writes are skipped while a local-data
 *    replacement (restore/reset) is in progress; and the HEAVY bulk reindex defers
 *    while on battery — the cheap model probe still runs, so the status surface stays
 *    honest — a minimal courtesy ahead of the full power policy.
 *
 * The service depends on a small injected interface (not the whole `DbService`) so
 * the triage/scrub logic is unit-testable without Electron or a database.
 */

import type { SemanticModelState } from "../shared/contract";

/** The trusted operations the supervisor drives (wired to `DbService` in `index.ts`). */
export interface EmbeddingMaintenanceDeps {
  /** Whether the `vec0` store is usable — the supervisor no-ops entirely when false. */
  isAvailable(): boolean;
  /** Honest model probe (cached); the auto-index gate requires `"ready"`. */
  probeModelState(): Promise<SemanticModelState>;
  /** Enqueue one (paginated) reindex pass; returns how many `embed` jobs were enqueued. */
  reindex(): { enqueued: number };
  /** Prune orphan `vec0` rows; returns the pruned count. */
  pruneOrphans(): number;
  /** Current coverage stats. */
  stats(): { embedded: number; total: number };
  /** In-flight `embed` job counts (used to avoid double-queuing a draining batch). */
  embedJobStats(): { queued: number; running: number };
  /** True while a restore/reset is replacing the local store — skip all writes. */
  isReplacingLocalData(): boolean;
  /** True when on battery — defer triage (minimal courtesy ahead of idea 7's throttle). */
  isOnBattery(): boolean;
  /** Optional logger for failure-isolated ticks. */
  log?(message: string): void;
}

export interface EmbeddingMaintenanceOptions {
  /** Delay before the first triage after `start()` (let the window settle). */
  readonly startupDelayMs?: number;
  /** Poll interval that drives catch-up + rate-limited scrub. */
  readonly pollIntervalMs?: number;
}

/** Default delay before the first triage — long enough to clear the launch window. */
const DEFAULT_STARTUP_DELAY_MS = 4_000;
/** Default poll interval for catch-up + scrub. */
const DEFAULT_POLL_INTERVAL_MS = 20_000;
/** Prune orphan vectors every N ticks (with a 20s poll, ~every 30 min) + on the first tick. */
const PRUNE_EVERY_N_TICKS = 90;

type TickReason = "startup" | "scrub" | "manual";

export class EmbeddingMaintenanceService {
  private readonly deps: EmbeddingMaintenanceDeps;
  private readonly startupDelayMs: number;
  private readonly pollIntervalMs: number;
  private running = false;
  /** Single-flight guard: only one tick (and thus one reindex pass) runs at a time. */
  private passInFlight = false;
  private tickCount = 0;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: EmbeddingMaintenanceDeps, options: EmbeddingMaintenanceOptions = {}) {
    this.deps = deps;
    this.startupDelayMs = options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Start the supervisor: a deferred first triage, then a steady poll. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.tick("startup");
      this.pollTimer = setInterval(() => void this.tick("scrub"), this.pollIntervalMs);
      this.pollTimer.unref?.();
    }, this.startupDelayMs);
    this.startupTimer.unref?.();
  }

  /** Stop the supervisor and clear its timers. Safe to call repeatedly / before start. */
  stop(): void {
    this.running = false;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Run one maintenance tick. Failure-isolated — it never throws out (so a poll timer
   * survives a bad tick). `"manual"` runs even when stopped (for tests / explicit use).
   */
  async tick(reason: TickReason = "manual"): Promise<void> {
    if (reason !== "manual" && !this.running) return;
    if (this.passInFlight) return;
    if (!this.deps.isAvailable()) return;
    if (this.deps.isReplacingLocalData()) return;

    this.passInFlight = true;
    try {
      const shouldPrune = this.tickCount % PRUNE_EVERY_N_TICKS === 0;
      this.tickCount += 1;
      if (shouldPrune) this.deps.pruneOrphans();

      // Gate auto-index on a REAL model (KTD3) — never auto-build with the fallback.
      const modelState = await this.deps.probeModelState();
      if (modelState !== "ready") return;
      // The probe is async; bail if we were stopped or a replacement began meanwhile.
      if (reason !== "manual" && !this.running) return;
      if (this.deps.isReplacingLocalData()) return;

      const { embedded, total } = this.deps.stats();
      if (embedded >= total) return; // caught up — nothing to do

      // Power courtesy: the cheap probe + prune above ALWAYS run (so the model state
      // stays honest and the panel can report it), but the HEAVY bulk reindex defers
      // while on battery. Plugging in — or the ungated manual Rebuild — resumes it.
      if (this.deps.isOnBattery()) return;

      // Don't double-queue: only enqueue the next batch once the prior one has drained.
      const { queued, running } = this.deps.embedJobStats();
      if (queued + running > 0) return;

      this.deps.reindex();
    } catch (err) {
      this.deps.log?.(`[embedding-maintenance] ${reason} tick failed: ${errorText(err)}`);
    } finally {
      this.passInFlight = false;
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

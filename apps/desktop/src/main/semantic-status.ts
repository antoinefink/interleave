/**
 * Pure assembly of the expanded {@link SemanticStatusResult} (U2).
 *
 * The status surface (Settings panel + Library label) reads model state, index
 * health, coverage, failures, and an ETA. Keeping the derivation in a pure function
 * (rather than inline in `db-service`) makes the health/coverage logic unit-testable
 * without standing up a database — `db-service.semanticStatus()` just gathers the
 * inputs (repo stats, job stats, cached probe state, ETA) and calls this.
 */

import {
  SEMANTIC_COVERAGE_THRESHOLD,
  type SemanticIndexHealth,
  type SemanticModelState,
  type SemanticStatusResult,
} from "../shared/contract";

export interface SemanticStatusInputs {
  /** Whether `sqlite-vec` `vec0` is loaded + functional. */
  readonly vecAvailable: boolean;
  /** The persisted `embeddingModelDownloaded` flag (last reconciled truth). */
  readonly modelDownloaded: boolean;
  readonly embedded: number;
  readonly total: number;
  readonly modelId: string;
  /** The last probed model state, or `null` if not probed yet this session. */
  readonly cachedModelState: SemanticModelState | null;
  /** Queued/running/failed `embed` job counts + most recent failed error. */
  readonly queued: number;
  readonly running: number;
  readonly failed: number;
  readonly lastError: string | null;
  /**
   * Why the on-device model last fell back to the deterministic embedder (U3), or `null`.
   * Forwarded to the result ONLY when the derived `modelState` is `fallback` (else nulled,
   * so a stale reason never lingers on a now-`ready`/`loading` row).
   */
  readonly modelLoadError: string | null;
  /** Seconds-to-complete estimate from the embed-throughput tracker, or `null`. */
  readonly etaSeconds: number | null;
  /** Why automatic indexing is paused right now (`"battery"`), or `null` when free to run. */
  readonly autoIndexPaused: "battery" | null;
}

/** Derive the expanded status result from gathered inputs (pure, deterministic). */
export function assembleSemanticStatus(inputs: SemanticStatusInputs): SemanticStatusResult {
  const coverageRatio = inputs.total > 0 ? inputs.embedded / inputs.total : 0;

  // Honest model state: prefer the probe's cached answer; before the first probe
  // resolves, fall back to the last persisted truth (downloaded → ready, else loading).
  // When vec is unavailable the real model can't be exercised → degraded/fallback.
  const modelState: SemanticModelState = !inputs.vecAvailable
    ? "fallback"
    : (inputs.cachedModelState ?? (inputs.modelDownloaded ? "ready" : "loading"));

  const building = inputs.queued + inputs.running > 0;

  let indexHealth: SemanticIndexHealth;
  if (!inputs.vecAvailable || modelState === "fallback") {
    // Real semantic vectors aren't being produced — quality is reduced regardless of count.
    indexHealth = "degraded";
  } else if (inputs.total === 0) {
    // Nothing to index — an empty vault is healthy, not "stale".
    indexHealth = "healthy";
  } else if (building) {
    indexHealth = "building";
  } else if (coverageRatio < SEMANTIC_COVERAGE_THRESHOLD) {
    indexHealth = "stale";
  } else {
    indexHealth = "healthy";
  }

  return {
    enabled: true,
    vecAvailable: inputs.vecAvailable,
    modelDownloaded: inputs.modelDownloaded,
    embedded: inputs.embedded,
    total: inputs.total,
    modelId: inputs.modelId,
    modelState,
    indexHealth,
    coverageRatio,
    failedCount: inputs.failed,
    lastError: inputs.lastError,
    // The model-load reason is meaningful only while we're actually in fallback; null it
    // otherwise so a `ready`/`loading` row never carries a stale reason from an earlier probe.
    modelLoadError: modelState === "fallback" ? inputs.modelLoadError : null,
    // ETA only means something while work is in flight.
    etaSeconds: building ? inputs.etaSeconds : null,
    // Forwarded verbatim — db-service decides the reason from the live power source.
    autoIndexPaused: inputs.autoIndexPaused,
  };
}

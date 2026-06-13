/**
 * EmbeddingMaintenanceService (U3) — supervisor triage / scrub / lifecycle tests.
 *
 * The deps are fully faked (no Electron, no DB) so each guard, the auto-index gate,
 * the no-double-queue rule, single-flight, failure isolation, and the start/stop
 * timer lifecycle are deterministic.
 */

import { describe, expect, it, vi } from "vitest";
import type { SemanticModelState } from "../shared/contract";
import {
  type EmbeddingMaintenanceDeps,
  EmbeddingMaintenanceService,
} from "./embedding-maintenance-service";

function makeDeps(over: Partial<EmbeddingMaintenanceDeps> = {}): EmbeddingMaintenanceDeps {
  return {
    isAvailable: vi.fn(() => true),
    probeModelState: vi.fn(async () => "ready" as SemanticModelState),
    reindex: vi.fn(() => ({ enqueued: 1 })),
    pruneOrphans: vi.fn(() => 0),
    stats: vi.fn(() => ({ embedded: 0, total: 10 })),
    embedJobStats: vi.fn(() => ({ queued: 0, running: 0 })),
    isReplacingLocalData: vi.fn(() => false),
    isOnBattery: vi.fn(() => false),
    log: vi.fn(),
    ...over,
  };
}

describe("EmbeddingMaintenanceService", () => {
  it("triages: enqueues a reindex when the model is ready and embedded < total", async () => {
    const deps = makeDeps();
    await new EmbeddingMaintenanceService(deps).tick("manual");
    expect(deps.reindex).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-build with the fallback model (KTD3)", async () => {
    const deps = makeDeps({ probeModelState: vi.fn(async () => "fallback" as SemanticModelState) });
    await new EmbeddingMaintenanceService(deps).tick("manual");
    expect(deps.reindex).not.toHaveBeenCalled();
  });

  it("does nothing when the corpus is fully embedded", async () => {
    const deps = makeDeps({ stats: vi.fn(() => ({ embedded: 10, total: 10 })) });
    await new EmbeddingMaintenanceService(deps).tick("manual");
    expect(deps.reindex).not.toHaveBeenCalled();
  });

  it("does not double-queue while a prior batch is still draining (R11/A3)", async () => {
    const deps = makeDeps({ embedJobStats: vi.fn(() => ({ queued: 100, running: 2 })) });
    await new EmbeddingMaintenanceService(deps).tick("manual");
    expect(deps.reindex).not.toHaveBeenCalled();
  });

  it("prunes orphan vectors on the first tick", async () => {
    const deps = makeDeps();
    await new EmbeddingMaintenanceService(deps).tick("manual");
    expect(deps.pruneOrphans).toHaveBeenCalledTimes(1);
  });

  it("isolates a failing tick — never throws, logs instead", async () => {
    const deps = makeDeps({
      probeModelState: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await expect(new EmbeddingMaintenanceService(deps).tick("manual")).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalled();
  });

  it("no-ops (no probe, no reindex) when vec is unavailable", async () => {
    const deps = makeDeps({ isAvailable: vi.fn(() => false) });
    await new EmbeddingMaintenanceService(deps).tick("manual");
    expect(deps.probeModelState).not.toHaveBeenCalled();
    expect(deps.reindex).not.toHaveBeenCalled();
  });

  it("no-ops while a local-data replacement is in progress", async () => {
    const deps = makeDeps({ isReplacingLocalData: vi.fn(() => true) });
    await new EmbeddingMaintenanceService(deps).tick("manual");
    expect(deps.reindex).not.toHaveBeenCalled();
  });

  it("defers while on battery (courtesy ahead of the full power policy)", async () => {
    const deps = makeDeps({ isOnBattery: vi.fn(() => true) });
    await new EmbeddingMaintenanceService(deps).tick("manual");
    expect(deps.reindex).not.toHaveBeenCalled();
  });

  it("single-flights overlapping ticks (one probe, one reindex)", async () => {
    let resolveProbe: (s: SemanticModelState) => void = () => {};
    const deps = makeDeps({
      probeModelState: vi.fn(
        () =>
          new Promise<SemanticModelState>((resolve) => {
            resolveProbe = resolve;
          }),
      ),
    });
    const svc = new EmbeddingMaintenanceService(deps);
    const first = svc.tick("manual");
    const second = svc.tick("manual"); // re-enters while first is mid-probe → early return
    resolveProbe("ready");
    await Promise.all([first, second]);
    expect(deps.probeModelState).toHaveBeenCalledTimes(1);
    expect(deps.reindex).toHaveBeenCalledTimes(1);
  });

  it("start() fires a deferred triage and stop() halts further ticks", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const svc = new EmbeddingMaintenanceService(deps, {
        startupDelayMs: 1_000,
        pollIntervalMs: 5_000,
      });
      svc.start();
      expect(deps.reindex).not.toHaveBeenCalled(); // deferred
      await vi.advanceTimersByTimeAsync(1_000); // startup triage fires
      expect(deps.reindex).toHaveBeenCalledTimes(1);
      svc.stop();
      await vi.advanceTimersByTimeAsync(30_000); // no further ticks after stop
      expect(deps.reindex).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("EmbeddingMaintenanceService post-probe guards", () => {
  it("does not reindex if a replacement begins while the probe is in flight", async () => {
    let resolveProbe: (s: SemanticModelState) => void = () => {};
    let replacing = false;
    const deps = makeDeps({
      probeModelState: vi.fn(
        () =>
          new Promise<SemanticModelState>((resolve) => {
            resolveProbe = resolve;
          }),
      ),
      isReplacingLocalData: vi.fn(() => replacing),
    });
    const tick = new EmbeddingMaintenanceService(deps).tick("manual");
    replacing = true; // a restore/reset begins mid-probe
    resolveProbe("ready");
    await tick;
    expect(deps.reindex).not.toHaveBeenCalled();
  });

  it("does not reindex if stopped while a scrub tick's probe is in flight", async () => {
    let resolveProbe: (s: SemanticModelState) => void = () => {};
    const deps = makeDeps({
      probeModelState: vi.fn(
        () =>
          new Promise<SemanticModelState>((resolve) => {
            resolveProbe = resolve;
          }),
      ),
    });
    const svc = new EmbeddingMaintenanceService(deps, {
      startupDelayMs: 999_999,
      pollIntervalMs: 999_999,
    });
    svc.start(); // running = true
    const tick = svc.tick("scrub");
    svc.stop(); // running flips false during the probe await
    resolveProbe("ready");
    await tick;
    expect(deps.reindex).not.toHaveBeenCalled();
  });
});

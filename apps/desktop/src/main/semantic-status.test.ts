/**
 * assembleSemanticStatus (U2) — pure derivation of the expanded status result.
 *
 * Pins the health/coverage/model-state rollup that drives the Settings panel headline
 * and the Library coverage label, without standing up a database.
 */

import { describe, expect, it } from "vitest";
import { SEMANTIC_COVERAGE_THRESHOLD } from "../shared/contract";
import { assembleSemanticStatus, type SemanticStatusInputs } from "./semantic-status";

const base: SemanticStatusInputs = {
  vecAvailable: true,
  modelDownloaded: true,
  embedded: 0,
  total: 0,
  modelId: "onnx-community/embeddinggemma-300m-ONNX",
  cachedModelState: "ready",
  queued: 0,
  running: 0,
  failed: 0,
  lastError: null,
  modelLoadError: null,
  etaSeconds: null,
  autoIndexPaused: null,
};

describe("assembleSemanticStatus", () => {
  it("coverageRatio is 0 (not NaN) when total is 0, and an empty vault is healthy", () => {
    const s = assembleSemanticStatus({ ...base, total: 0, embedded: 0 });
    expect(s.coverageRatio).toBe(0);
    expect(s.indexHealth).toBe("healthy");
  });

  it("coverageRatio = embedded / total", () => {
    const s = assembleSemanticStatus({ ...base, total: 10, embedded: 5 });
    expect(s.coverageRatio).toBeCloseTo(0.5);
  });

  it("degraded when the model is in fallback", () => {
    const s = assembleSemanticStatus({
      ...base,
      total: 10,
      embedded: 10,
      cachedModelState: "fallback",
    });
    expect(s.modelState).toBe("fallback");
    expect(s.indexHealth).toBe("degraded");
  });

  it("degraded + fallback model when vec is unavailable", () => {
    const s = assembleSemanticStatus({ ...base, vecAvailable: false, total: 10, embedded: 10 });
    expect(s.modelState).toBe("fallback");
    expect(s.indexHealth).toBe("degraded");
  });

  it("building when embed jobs are in flight (real model) and ETA passes through", () => {
    const s = assembleSemanticStatus({
      ...base,
      total: 100,
      embedded: 10,
      running: 2,
      etaSeconds: 42,
    });
    expect(s.indexHealth).toBe("building");
    expect(s.etaSeconds).toBe(42);
  });

  it("stale when below the reliability threshold and idle; ETA is null when not building", () => {
    const below = Math.floor(SEMANTIC_COVERAGE_THRESHOLD * 10) - 1; // < threshold of 10
    const s = assembleSemanticStatus({
      ...base,
      total: 10,
      embedded: below,
      etaSeconds: 99,
    });
    expect(s.indexHealth).toBe("stale");
    expect(s.etaSeconds).toBeNull();
  });

  it("healthy when fully covered with the real model and no jobs running", () => {
    const s = assembleSemanticStatus({ ...base, total: 10, embedded: 10 });
    expect(s.indexHealth).toBe("healthy");
  });

  it("provisional model state before probe: downloaded -> ready, else loading", () => {
    const ready = assembleSemanticStatus({
      ...base,
      cachedModelState: null,
      modelDownloaded: true,
    });
    expect(ready.modelState).toBe("ready");
    const loading = assembleSemanticStatus({
      ...base,
      cachedModelState: null,
      modelDownloaded: false,
    });
    expect(loading.modelState).toBe("loading");
  });

  it("surfaces failed count and last error", () => {
    const s = assembleSemanticStatus({
      ...base,
      total: 10,
      embedded: 9,
      failed: 2,
      lastError: "OVERSIZED: element text too large",
    });
    expect(s.failedCount).toBe(2);
    expect(s.lastError).toBe("OVERSIZED: element text too large");
  });

  it("forwards modelLoadError ONLY when the model state is fallback", () => {
    const fellBack = assembleSemanticStatus({
      ...base,
      cachedModelState: "fallback",
      modelLoadError: "ENOTDIR: not a directory, open '.../app.asar/.../model_fp16.onnx'",
    });
    expect(fellBack.modelState).toBe("fallback");
    expect(fellBack.modelLoadError).toContain("ENOTDIR");
  });

  it("nulls modelLoadError when the model is ready (no stale reason on a healthy row)", () => {
    const ready = assembleSemanticStatus({
      ...base,
      cachedModelState: "ready",
      modelLoadError: "stale reason from an earlier probe",
    });
    expect(ready.modelState).toBe("ready");
    expect(ready.modelLoadError).toBeNull();
  });

  it("nulls modelLoadError while loading (reason only ever rides a fallback row)", () => {
    const loading = assembleSemanticStatus({
      ...base,
      vecAvailable: true,
      cachedModelState: null,
      modelDownloaded: false,
      modelLoadError: "stale reason from a prior probe",
    });
    expect(loading.modelState).toBe("loading");
    expect(loading.modelLoadError).toBeNull();
  });

  it("forwards the autoIndexPaused reason verbatim", () => {
    const paused = assembleSemanticStatus({
      ...base,
      total: 10,
      embedded: 3,
      autoIndexPaused: "battery",
    });
    expect(paused.autoIndexPaused).toBe("battery");
    const free = assembleSemanticStatus({ ...base, total: 10, embedded: 3 });
    expect(free.autoIndexPaused).toBeNull();
  });
});

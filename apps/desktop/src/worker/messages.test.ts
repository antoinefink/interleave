/**
 * Worker message-shape round-trip tests (T058 + T087).
 *
 * The main↔worker channel is Zod-validated in both directions. These pin that the
 * `embed` job (T087) rides the EXISTING `WorkerRequest`/`WorkerMessage` shapes with
 * no message-shape change: a request carrying an `embed` payload validates, and the
 * worker's `embed` result `data = { vector, modelId, dim }` round-trips through
 * `WorkerMessageSchema` (the `JsonValueSchema` carries the `number[]` vector).
 */

import { describe, expect, it } from "vitest";
import { WorkerMessageSchema, WorkerRequestSchema } from "./messages";

describe("worker messages — embed (T087)", () => {
  it("validates an embed job request (type + payload)", () => {
    const request = {
      jobId: "job-1",
      type: "embed" as const,
      payload: {
        text: "spaced repetition",
        modelId: "local:minilm-hash-384",
        provider: "local",
        dim: 384,
        persist: true,
      },
    };
    const parsed = WorkerRequestSchema.safeParse(request);
    expect(parsed.success).toBe(true);
  });

  it("round-trips an embed result message (vector + modelId + dim)", () => {
    const message = {
      kind: "result" as const,
      jobId: "job-1",
      data: { vector: [0.1, 0.2, 0.3], modelId: "local:minilm-hash-384", dim: 384 },
    };
    const parsed = WorkerMessageSchema.safeParse(message);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === "result") {
      expect((parsed.data.data as { dim: number }).dim).toBe(384);
    }
  });

  it("rejects a malformed worker message (bad kind)", () => {
    expect(WorkerMessageSchema.safeParse({ kind: "nope", jobId: "x" }).success).toBe(false);
  });
});

/**
 * Typed message channel between the Electron MAIN process and the background-job
 * `utilityProcess` WORKER (T058).
 *
 * The worker is an out-of-process Node child the main spawns at startup; main and
 * the worker talk over the `utilityProcess` message channel (`child.postMessage`
 * / `child.on("message")` ↔ `process.parentPort`). This module is the ONE shared
 * message-shape definition, imported by BOTH sides and validated with Zod in BOTH
 * directions, so the channel is typed and a malformed message is rejected at the
 * boundary (mirroring the IPC-contract discipline). Keeping it in one module
 * means the two sides can never silently drift.
 *
 * Main → worker: {@link WorkerRequest} — "run this job" (id + type + payload).
 * Worker → main: {@link WorkerMessage} — `progress` | `result` | `error`, each
 * carrying the `jobId` so main routes it to the right job.
 *
 * The worker is DB-FREE: it does pure compute + network I/O and returns plain
 * serializable data; ALL DB writes happen in main after a `result` arrives. So no
 * `@interleave/db`/`better-sqlite3`/repository type ever appears here — only Zod
 * + plain JSON shapes.
 */

import type { JobJsonValue } from "@interleave/core";
import { JOB_TYPES } from "@interleave/core";
import { z } from "zod";

/** Any plain JSON value carried in a job payload / result (recursive). */
export const JsonValueSchema: z.ZodType<JobJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** Main → worker: execute one job off-main. */
export const WorkerRequestSchema = z.object({
  jobId: z.string().min(1),
  type: z.enum(JOB_TYPES),
  payload: JsonValueSchema,
});
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

/** Worker → main: incremental progress for a running job (ratio 0–1). */
export const WorkerProgressMessageSchema = z.object({
  kind: z.literal("progress"),
  jobId: z.string().min(1),
  progress: z.object({
    ratio: z.number().min(0).max(1),
    note: z.string().optional(),
  }),
});
export type WorkerProgressMessage = z.infer<typeof WorkerProgressMessageSchema>;

/**
 * Worker → main: the job produced a serializable result; main applies it.
 *
 * `data` is an open `JsonValue` (every job type carries its own shape, re-validated at
 * main's per-type apply boundary). The `embed` result rides this as
 * `{ vector, modelId, dim }` plus an OPTIONAL `modelLoadError` string when the worker
 * fell back — both validate and round-trip through `JsonValueSchema` with no schema
 * change here.
 */
export const WorkerResultMessageSchema = z.object({
  kind: z.literal("result"),
  jobId: z.string().min(1),
  data: JsonValueSchema,
});
export type WorkerResultMessage = z.infer<typeof WorkerResultMessageSchema>;

/** Worker → main: the job failed (a typed `code` + a human message). */
export const WorkerErrorMessageSchema = z.object({
  kind: z.literal("error"),
  jobId: z.string().min(1),
  code: z.string().min(1),
  message: z.string(),
});
export type WorkerErrorMessage = z.infer<typeof WorkerErrorMessageSchema>;

/** Any worker → main message. */
export const WorkerMessageSchema = z.discriminatedUnion("kind", [
  WorkerProgressMessageSchema,
  WorkerResultMessageSchema,
  WorkerErrorMessageSchema,
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

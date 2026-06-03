import { describe, expect, it } from "vitest";
import type { JobId } from "./ids";
import type { Job, JobJsonValue } from "./job";

describe("job model shape", () => {
  it("carries serializable payload, progress, result, and retry metadata", () => {
    const payload = {
      url: "https://example.test",
      options: { snapshot: true, labels: ["research"] },
    } satisfies JobJsonValue;

    const job = {
      id: "job" as JobId,
      type: "url_import",
      payload,
      status: "running",
      attempts: 1,
      maxAttempts: 3,
      progress: { ratio: 0.5, note: "fetching" },
      result: null,
      error: null,
      notBefore: null,
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:01.000Z",
      startedAt: "2026-06-03T00:00:01.000Z",
      finishedAt: null,
    } satisfies Job;

    expect(job.type).toBe("url_import");
    expect(job.progress.ratio).toBe(0.5);
    expect(job.attempts).toBeLessThan(job.maxAttempts);
  });
});

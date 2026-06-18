/**
 * Scale budget GATE (T100) — the hard p95 budget assertions.
 *
 * This is the FAIL-ON-REGRESSION side of the benchmark: it seeds a large collection
 * (smoke profile in CI, full profile locally), measures each hot read path's p95
 * over N samples, prints a `path | p50 | p95 | budget | status` table, and `expect`s
 * each hard-budget path's p95 to be within budget. The backup snapshot is a SOFT
 * ceiling — printed, never failed. See `bench-harness.ts` for the budgets + the
 * throwaway-bench-DB builder.
 *
 * It is run via `pnpm bench` (which uses `vitest.bench-gate.config.ts`, including
 * ONLY this file) and is NOT collected by the normal `pnpm test` (the local-db
 * project's `include` is `src/**`; this lives under `bench/`). CI runs the SMOKE
 * profile (`INTERLEAVE_BENCH_N=smoke`); the full 100k run is the documented local
 * `pnpm bench`.
 *
 * ============================================================================
 * CI vs LOCAL — the documented split (T100)
 * ----------------------------------------------------------------------------
 *   CI / fast:   `pnpm bench`                       (SMOKE profile, a few-thousand N;
 *                                                    every path < 16 ms — finishes in
 *                                                    seconds; this is what every PR runs)
 *   LOCAL / full: `INTERLEAVE_BENCH_N=full pnpm bench`
 *                                                   (~100k cards / ~100k extracts / ~1M
 *                                                    review_logs / ~980 MB temp DB; the
 *                                                    seed builds in ~20 s via the bulk
 *                                                    fast path, the full gate ~3 min;
 *                                                    needs ~1 GB temp disk — opt-in)
 *
 * Reference-machine FULL p95 (Apple-silicon laptop, macOS, better-sqlite3 Node-ABI,
 * sqlite-vec loaded) AFTER the T100 N+1 fixes + the `0027` indexes + the score-candidate
 * cap: queueList ~1.5 s (was ~24 s), queueListFiltered ~1.6 s (was ~18.7 s), search
 * ~2 ms, semanticKnn ~60 ms, reviewNext ~0.5 s, analytics ~0.77 s (p95 GC-variable to
 * ~2.3 s), maintenanceReport ~0.67 s, backupSnapshot ~2.4 s (soft). The budgets in
 * `bench-harness.ts` are these numbers + headroom, so the gate catches a REGRESSION
 * back toward the old per-row N+1 rather than failing on the (now-fixed) baseline.
 * The full run is the executable backing of the M20 "Scale QA checklist" steps 1–2.
 */

import { type ElementId, EMBEDDING_DIM, embedTextLocal } from "@interleave/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueueQuery } from "../src/queue-query";
import { ReviewSessionService } from "../src/review-session-service";
import {
  BENCH_AS_OF,
  BENCH_BUDGETS_MS,
  type BenchWorld,
  buildBenchWorld,
  measure,
  provenanceHeader,
  useSmokeProfile,
} from "./bench-harness";

let world: BenchWorld;
let queryVector: number[];
let conceptName: string | undefined;
/** A representative 50-element id slice from the seeded DB, for summaryForMany. */
let sampleElementIds: ElementId[] = [];
/** A single live source id from the seeded DB, for getSourceYield. */
let sampleSourceId: ElementId | undefined;
/** A tag name present in the seeded DB, for the tag-filter queue gauge. */
let sampleTagName: string | undefined;
// Collected for the summary table.
const rows: { name: string; p50: number; p95: number; budget: number; soft?: boolean }[] = [];

beforeAll(() => {
  const t0 = Date.now();
  world = buildBenchWorld();
  // eslint-disable-next-line no-console
  console.log(`\n${provenanceHeader(world, Date.now() - t0)}\n`);
  queryVector = embedTextLocal("spaced repetition intervals memory", EMBEDDING_DIM);
  const row = world.handle.sqlite.prepare("SELECT name FROM concepts LIMIT 1").get() as
    | { name?: string }
    | undefined;
  conceptName = row?.name;

  // Grab a representative element-id slice (up to 50) for summaryForMany.
  const elementRows = world.handle.sqlite
    .prepare("SELECT id FROM elements WHERE deleted_at IS NULL LIMIT 50")
    .all() as { id: string }[];
  sampleElementIds = elementRows.map((r) => r.id as ElementId);

  // A single live source id for getSourceYield.
  const sourceRow = world.handle.sqlite
    .prepare("SELECT id FROM elements WHERE type='source' AND deleted_at IS NULL LIMIT 1")
    .get() as { id: string } | undefined;
  sampleSourceId = sourceRow?.id as ElementId | undefined;

  // A tag name that has at least one membership (seed always creates tags).
  const tagRow = world.handle.sqlite
    .prepare("SELECT t.name FROM tags t JOIN element_tags et ON et.tag_id = t.id LIMIT 1")
    .get() as { name: string } | undefined;
  sampleTagName = tagRow?.name;
});

afterAll(() => {
  // Print the summary table the spec asks for.
  // eslint-disable-next-line no-console
  console.log("\n[scale.bench] p95 vs budget:");
  for (const r of rows) {
    const status = r.p95 <= r.budget ? "PASS" : r.soft ? "SOFT" : "FAIL";
    // eslint-disable-next-line no-console
    console.log(
      `  ${status.padEnd(4)} ${r.name}: p50=${r.p50.toFixed(1)}ms p95=${r.p95.toFixed(1)}ms ` +
        `budget=${r.budget}ms${r.soft ? " (soft)" : ""}`,
    );
  }
  world?.cleanup();
});

/** Run a measured path, record the row, and return its p95. */
function gauge(name: string, budget: number, fn: () => void, soft = false): number {
  const m = measure(fn, useSmokeProfile() ? 30 : 20);
  rows.push({ name, p50: m.p50, p95: m.p95, budget, soft });
  return m.p95;
}

describe("scale budget gate — hot read paths within p95 budgets", () => {
  it("QueueQuery.list (daily queue, full mode) is within budget", () => {
    const p95 = gauge("QueueQuery.list (full)", BENCH_BUDGETS_MS.queueList, () => {
      void new QueueQuery(world.repos).list({ asOf: BENCH_AS_OF, limit: 50 });
    });
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.queueList);
  });

  it("QueueQuery.list (concept-filtered — the N+1 seam) is within budget", () => {
    const p95 = gauge(
      "QueueQuery.list (concept-filtered)",
      BENCH_BUDGETS_MS.queueListFiltered,
      () => {
        void new QueueQuery(world.repos).list({
          asOf: BENCH_AS_OF,
          limit: 50,
          ...(conceptName ? { filters: { concept: conceptName } } : {}),
        });
      },
    );
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.queueListFiltered);
  });

  it("SearchRepository.search (multi-term FTS) is within budget", () => {
    const p95 = gauge("SearchRepository.search", BENCH_BUDGETS_MS.search, () => {
      void world.repos.search.search("intelligence efficiency memory", { limit: 30 });
    });
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.search);
  });

  it("EmbeddingRepository.knn (vec0 KNN) is within budget (or vec unavailable)", () => {
    if (!world.vecOk) {
      // FTS-only degrade: vec0 unavailable on this host — same contract as T096.
      // eslint-disable-next-line no-console
      console.log("  [skip] EmbeddingRepository.knn — vec0 unavailable (FTS-only degrade)");
      return;
    }
    const p95 = gauge("EmbeddingRepository.knn", BENCH_BUDGETS_MS.semanticKnn, () => {
      void world.repos.embeddings.knn(queryVector, { limit: 20 });
    });
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.semanticKnn);
  });

  it("ReviewSessionService.nextReviewCard (FSRS next-pick + bury) is within budget", () => {
    const p95 = gauge("ReviewSessionService.nextReviewCard", BENCH_BUDGETS_MS.reviewNext, () => {
      void new ReviewSessionService(world.handle.db).nextReviewCard({
        asOf: BENCH_AS_OF,
        limit: 50,
      });
    });
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.reviewNext);
  });

  it("AnalyticsService.computeAnalytics (window over the review history) is within budget", () => {
    const p95 = gauge("AnalyticsService.computeAnalytics", BENCH_BUDGETS_MS.analytics, () => {
      void world.repos.analytics.computeAnalytics(BENCH_AS_OF);
    });
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.analytics);
  });

  it("MaintenanceQuery.report (dedup + lineage-gap scans) is within budget", () => {
    const p95 = gauge("MaintenanceQuery.report", BENCH_BUDGETS_MS.maintenanceReport, () => {
      void world.repos.dedupReport.duplicateSources();
      void world.repos.lineageGap.cardsWithoutSources();
      void world.repos.lineageGap.brokenSourceCandidates();
      void world.repos.lineageGap.lowValueCandidates({ asOf: BENCH_AS_OF });
    });
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.maintenanceReport);
  });

  // ── U15 gauges: batched hot paths ───────────────────────────────────────────

  it("QueueQuery.summaryForMany (50-element slice) is within budget", () => {
    if (sampleElementIds.length === 0) {
      // eslint-disable-next-line no-console
      console.log("  [skip] QueueQuery.summaryForMany — no seeded elements");
      return;
    }
    const p95 = gauge(
      "QueueQuery.summaryForMany (50-el)",
      BENCH_BUDGETS_MS.queueSummaryForMany,
      () => {
        void new QueueQuery(world.repos).summaryForMany(sampleElementIds, BENCH_AS_OF);
      },
    );
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.queueSummaryForMany);
  });

  it("SourceYieldQuery.getSourceYield (single-source, U9) is within budget", () => {
    if (!sampleSourceId) {
      // eslint-disable-next-line no-console
      console.log("  [skip] SourceYieldQuery.getSourceYield — no seeded source");
      return;
    }
    const id = sampleSourceId;
    const p95 = gauge(
      "SourceYieldQuery.getSourceYield (single)",
      BENCH_BUDGETS_MS.sourceYieldSingle,
      () => {
        void world.repos.sourceYield.getSourceYield(id, BENCH_AS_OF);
      },
    );
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.sourceYieldSingle);
  });

  it("SourceYieldQuery.listSourceYield (whole-library, U10) is within budget", () => {
    const p95 = gauge(
      "SourceYieldQuery.listSourceYield (all)",
      BENCH_BUDGETS_MS.sourceYieldList,
      () => {
        void world.repos.sourceYield.listSourceYield(BENCH_AS_OF, {
          limit: Number.MAX_SAFE_INTEGER,
        });
      },
    );
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.sourceYieldList);
  });

  it("SchedulerConsistencyQuery.count (U13) is within budget", () => {
    const p95 = gauge(
      "SchedulerConsistencyQuery.count",
      BENCH_BUDGETS_MS.schedulerConsistencyCount,
      () => {
        void world.repos.schedulerConsistency.count();
      },
    );
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.schedulerConsistencyCount);
  });

  it("ChronicPostponeQuery.countDue (U13) is within budget", () => {
    const p95 = gauge(
      "ChronicPostponeQuery.countDue",
      BENCH_BUDGETS_MS.chronicPostponeCountDue,
      () => {
        // threshold:5 is the app default (CHRONIC_POSTPONE_THRESHOLD default from core).
        void world.repos.chronicPostpone.countDue({ threshold: 5 });
      },
    );
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.chronicPostponeCountDue);
  });

  it("QueueQuery.list (tag-filtered — batched tag-membership path, U11) is within budget", () => {
    const p95 = gauge(
      "QueueQuery.list (tag-filtered)",
      BENCH_BUDGETS_MS.queueListTagFiltered,
      () => {
        void new QueueQuery(world.repos).list({
          asOf: BENCH_AS_OF,
          limit: 50,
          ...(sampleTagName ? { filters: { tag: sampleTagName } } : {}),
        });
      },
    );
    expect(p95).toBeLessThanOrEqual(BENCH_BUDGETS_MS.queueListTagFiltered);
  });

  it("backupDatabaseTo (wal_checkpoint + VACUUM INTO) — SOFT ceiling, printed only", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const p95 = gauge(
      "backupDatabaseTo (snapshot)",
      BENCH_BUDGETS_MS.backupSnapshot,
      () => {
        const dest = path.join(world.dir, `backup-${Date.now()}-${Math.random()}.sqlite`);
        world.handle.sqlite.pragma("wal_checkpoint(PASSIVE)");
        world.handle.sqlite.prepare("VACUUM INTO ?").run(dest);
        fs.rmSync(dest, { force: true });
      },
      true,
    );
    // SOFT: do not fail; just sanity-bound it well above the ceiling so a pathological
    // hang (minutes) still surfaces as a failure rather than hanging the suite.
    expect(p95).toBeLessThan(BENCH_BUDGETS_MS.backupSnapshot * 4);
  });
});

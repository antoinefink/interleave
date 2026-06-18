/**
 * Shared scale-bench harness (T100) — the budgets, the throwaway bench-DB builder,
 * and the manual p95 measurement helper, used by BOTH the informational
 * `scale.bench.ts` (Vitest `bench` comparative table) AND the hard-budget
 * `scale-budget.test.ts` gate (real `expect`s). One place for the numbers.
 *
 * Everything here runs behind the local-db boundary (it constructs the repositories
 * directly against a throwaway temp/in-memory DB). NO renderer, NO `window.appApi`,
 * NO generic `db.query`. The bench DB is ALWAYS a throwaway temp file — never the
 * user/dev DB.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IsoTimestamp } from "@interleave/core";
import {
  type DbHandle,
  loadVectorExtension,
  migrateDatabase,
  openDatabase,
  vecFunctional,
} from "@interleave/db";
import {
  DEFAULT_LARGE_PROFILE,
  type LargeSeedStats,
  SMOKE_LARGE_PROFILE,
  seedLargeCollection,
} from "../../testing/src/large-seed";
import { createRepositories, type Repositories } from "../src/index";

/**
 * The hot-path p95 budgets (milliseconds), the SINGLE tunable place.
 *
 * Pinned to the T100 reference machine (Apple-silicon laptop, macOS, better-sqlite3
 * Node-ABI, sqlite-vec loaded) at the **FULL profile** — ~100k cards / ~100k extracts /
 * ~1M `review_logs` / ~980 MB DB, the worst-case deep-overload point where ~40k cards
 * are due AT ONCE. Budgets are machine-relative + scale-relative — re-tune here on a
 * new machine or a larger profile. The CI **smoke** profile (a few-thousand N) runs
 * the SAME gate and clears these by 1–2 orders of magnitude (every smoke path is
 * sub-10 ms), so the budgets gate the full-scale run while CI stays green + fast.
 *
 * **How these were set (T100).** The first full run exposed real N+1 blowups —
 * `QueueQuery.list` at **~24 s** p95 (a per-row `findReviewState`/`findCardById`/
 * `firstConceptName`/`sourceContext`/`countPostpones` over EVERY due card). The fix
 * (batched scoring maps + the `dueCardsWithState` join + deferring the expensive
 * display reads to the ≤limit survivors + a 2 000-card score-candidate cap + the `0027`
 * indexes + SQL `COUNT(*)` on the analytics path) cut the hot paths **~9–12×**
 * (`QueueQuery.list` ~24 s → ~2.8 s; concept-filtered ~18.7 s → ~1.6 s). The budgets
 * below are the post-fix reference p95 + headroom, so the gate now catches a REGRESSION
 * back toward the old N+1 rather than failing on the (now-fixed) baseline. The residual
 * at 100k is inherent — counting + light-scoring tens of thousands of simultaneously-due
 * rows over a ~1 GB DB — and is a deep-overload extreme no real day reaches.
 */
export const BENCH_BUDGETS_MS = {
  // ~1.25 s p50 / ~2.8 s p95 at full scale (down from ~24 s); 4 s leaves p95 headroom.
  queueList: 4_000,
  // ~1.5 s p50 / ~1.6 s p95 at full scale (down from ~18.7 s); 2.5 s headroom.
  queueListFiltered: 2_500,
  // FTS5 is fully indexed — ~2 ms even at 100k; the tight budget proves it.
  search: 100,
  // vec0 KNN ~50 ms over ~200k vectors; 300 ms headroom.
  semanticKnn: 300,
  // ~0.5 s p95 at full scale (bounded SQL read + small deck); 1 s headroom.
  reviewNext: 1_000,
  // ~0.66 s p50 at full scale (windowed review_log scan + COUNT(*)s). The p95 is
  // GC-variable on the ~1 GB DB (the 30-day window still materializes ~80k review_log
  // rows into JS to bucket them by local day) — it swings ~0.7–2.3 s run to run — so
  // the budget tracks that observed p95 ceiling, not the p50. Catches a real regression
  // (pre-fix this path was ~0.87 s p95 with the per-row `.length` reads it now counts in
  // SQL) while tolerating the windowed-scan GC jitter.
  analytics: 2_500,
  // ~0.7 s p95 at full scale (dedup + lineage-gap scans); 1.2 s headroom.
  maintenanceReport: 1_200,
  /** SOFT ceiling — printed, never a hard fail (I/O-bound + machine-dependent). */
  backupSnapshot: 30_000,

  // ── U15 new gauges (batched hot paths) ──────────────────────────────────────
  // Budgets set from observed post-fix smoke-profile p95 × ~2–3× headroom.
  // The full-profile values will be higher but clear these by 1–2 orders of
  // magnitude below the budget (same pattern as existing entries above).

  // QueueQuery.summaryForMany over a 50-id slice of the seeded elements.
  // Batched path: ~few ms on smoke; budget 500 ms covers the full-scale envelope.
  queueSummaryForMany: 500,

  // SourceYieldQuery.getSourceYield(singleSourceId) — scoped single-source query.
  // Very fast (few SQL reads); budget 150 ms is ~3× a worst-case indexed read.
  sourceYieldSingle: 150,

  // SourceYieldQuery.listSourceYield() — whole-library batched rollup (U10).
  // The full-profile run over 1k sources + 100k descendants is the bottleneck;
  // 10 s leaves room for both the smoke (sub-10 ms) and the full run (~few s).
  sourceYieldList: 10_000,

  // SchedulerConsistencyQuery.count() — full live-element scan (U13).
  // Bounded SQL scan, no per-row reads; 1 s covers the worst-case full-profile.
  schedulerConsistencyCount: 1_000,

  // ChronicPostponeQuery.countDue() — batched op-log scan over all candidates (U13).
  // The batched path is fast; 1 s covers the full-profile op-log size.
  chronicPostponeCountDue: 1_000,

  // QueueQuery.list with a tag filter active (U11 batched tag-membership path).
  // Similar to the concept-filtered path; budget tracks the same envelope.
  queueListTagFiltered: 2_500,
} as const;

export const BENCH_AS_OF = "2026-06-01T12:00:00.000Z" as IsoTimestamp;

/** Whether to use the small CI profile (`INTERLEAVE_BENCH_N=smoke`) or the full run. */
export function useSmokeProfile(): boolean {
  return process.env.INTERLEAVE_BENCH_N === "smoke";
}

/** The bench DB + repos + the seed stats + whether vec0 is available. */
export interface BenchWorld {
  readonly dir: string;
  readonly dbPath: string;
  readonly handle: DbHandle;
  readonly repos: Repositories;
  readonly stats: LargeSeedStats;
  readonly vecOk: boolean;
  /** Close + remove the throwaway bench DB + dir. */
  cleanup(): void;
}

/**
 * Build a throwaway, file-based bench DB and seed a large collection into it (the
 * smoke or full profile). The file lives under `os.tmpdir()` (overridable by the
 * caller's `dir`) and is removed by {@link BenchWorld.cleanup}.
 */
export function buildBenchWorld(): BenchWorld {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-bench-"));
  const dbPath = path.join(dir, "bench.sqlite");
  const handle = openDatabase(dbPath);
  loadVectorExtension(handle.sqlite);
  const vecOk = vecFunctional(handle.sqlite);
  migrateDatabase(handle.db, { vecAvailable: vecOk });
  const repos = createRepositories(handle.db, { vecAvailable: vecOk });
  const profile = useSmokeProfile() ? SMOKE_LARGE_PROFILE : DEFAULT_LARGE_PROFILE;
  const stats = seedLargeCollection(repos, handle.db, {
    ...profile,
    embeddings: vecOk,
    seed: "interleave-bench",
    asOf: BENCH_AS_OF,
  });
  return {
    dir,
    dbPath,
    handle,
    repos,
    stats,
    vecOk,
    cleanup(): void {
      try {
        handle.sqlite.close();
      } catch {
        // already closed — ignore.
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The one-line provenance header the spec wants. */
export function provenanceHeader(world: BenchWorld, seedMs: number): string {
  const s = world.stats;
  return (
    `[scale.bench] profile=${useSmokeProfile() ? "smoke" : "full"} vec=${world.vecOk} ` +
    `sources=${s.sources} extracts=${s.extracts} cards=${s.cards} reviewLogs=${s.reviewLogs} ` +
    `embeddings=${s.embeddings} elements=${s.elements} seedMs=${seedMs} ` +
    `dbSize=${s.dbSizeBytes != null ? `${(s.dbSizeBytes / 1e6).toFixed(1)}MB` : "n/a"}`
  );
}

/**
 * Measure `fn` `n` times and return p50/p95 (milliseconds). A small warm-up pass
 * primes the prepared-statement + page caches so the percentiles reflect steady
 * state, not cold-start compilation.
 */
export function measure(fn: () => void, n = 30): { p50: number; p95: number; min: number } {
  for (let i = 0; i < 3; i++) fn(); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const pct = (p: number): number => samples[Math.min(samples.length - 1, Math.floor(n * p))] ?? 0;
  return { p50: pct(0.5), p95: pct(0.95), min: samples[0] ?? 0 };
}

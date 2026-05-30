/**
 * AnalyticsService (T045) — the system-wide learning-health snapshot.
 *
 * A single READ-ONLY aggregation over the durable tables (`review_logs`,
 * `elements`, `review_states`/`cards`) that powers the Analytics screen. It
 * answers "how is the whole system doing?" — daily reviews, retention, what is
 * due now, what was created/deleted in the window, and how many leeches need
 * repair. It is NOT source-yield analytics (read %, per-source extracts/cards) —
 * that is the *per-source* view, deferred to M17/T083.
 *
 * Architecture (non-negotiable):
 *  - Read-only. It NEVER mutates and NEVER appends an `operation_log` row — there
 *    is nothing to undo about looking at your stats.
 *  - All aggregation lives HERE (the domain layer), never in React. The renderer
 *    reads one `AnalyticsSummary` payload over the typed `window.appApi` bridge.
 *  - Computed from durable tables, so the numbers survive an app restart and match
 *    exactly what the user actually graded.
 *
 * ## Definitions (the contract the screen + T046's balance banner depend on)
 *
 * - **Day bucketing** uses the LOCAL calendar day (the user's machine timezone),
 *   derived from `review_logs.reviewedAt`. We aggregate in JS rather than via SQL
 *   `date()` (which is UTC-only in SQLite) so a review graded at 11pm local time
 *   lands on the day the user perceives it. The window is the last `windowDays`
 *   calendar days INCLUDING `asOf`'s local day (so `windowDays = 30` is a 30-bucket
 *   span ending today).
 *
 * - **`retention30d`** = the fraction of reviews in the window graded `hard` /
 *   `good` / `easy` (i.e. NOT `again`) — the simple recall-success proxy. It is a
 *   number in `[0, 1]` (the renderer formats it as a percentage), or `null` when
 *   there are no reviews in the window. This is deliberately the naive "% not
 *   again" definition; FSRS-true retrievability + retention-by-concept are a later
 *   refinement (M17/T083) — do NOT compute them here.
 *
 * - **`newCards` / `newExtracts`** count elements of that type whose `createdAt`
 *   falls in the window, REGARDLESS of whether they were later soft-deleted —
 *   these measure *throughput* (how much you produced), not the live inventory.
 *
 * - **`deletions`** counts elements whose `deletedAt` falls in the window (the live
 *   trash-rate), preferred over counting `soft_delete_element` ops so a restored-
 *   then-re-deleted element is counted by its current state.
 *
 * - **`dueCards` / `dueTopics`** are the LIVE due-now counts from the two
 *   schedulers (the load-bearing split): `dueCards` is FSRS cards due at/below
 *   `asOf` (`QueueRepository.dueCards`), `dueTopics` is due attention items
 *   (sources/topics/extracts via `QueueRepository.dueAttentionItems`). Both exclude
 *   soft-deleted / suspended / done / dismissed rows (the queue's own filter).
 */

import type { IsoTimestamp } from "@interleave/core";
import { elements, type InterleaveDatabase, reviewLogs } from "@interleave/db";
import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import { QueueRepository } from "./queue-repository";
import { ReviewRepository } from "./review-repository";

/** Default analytics window — the kit's "last 30 days". */
export const DEFAULT_ANALYTICS_WINDOW_DAYS = 30;

/** One calendar day's review count (the `Spark` series). `date` is `YYYY-MM-DD` (local). */
export interface ReviewsByDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly date: string;
  readonly count: number;
}

/** The complete system-wide analytics snapshot the screen reads (one payload). */
export interface AnalyticsSummary {
  /** The `asOf` instant the snapshot was computed for (ISO-8601). */
  readonly asOf: IsoTimestamp;
  /** The window length in calendar days (default 30). */
  readonly windowDays: number;
  /** Reviews grouped by local calendar day over the window, oldest day first. */
  readonly reviewsByDay: readonly ReviewsByDay[];
  /** Total reviews graded in the window. */
  readonly reviewsTotal: number;
  /** Mean reviews per day over the window (`reviewsTotal / windowDays`). */
  readonly reviewsPerDayAvg: number;
  /**
   * Fraction of window reviews graded NOT-`again` (`hard`/`good`/`easy`), in
   * `[0, 1]`; `null` when there are no reviews in the window.
   */
  readonly retention30d: number | null;
  /** Cards due for FSRS review at/before `asOf` (live, non-suspended). */
  readonly dueCards: number;
  /** Sources/topics/extracts due for re-processing at/before `asOf` (attention). */
  readonly dueTopics: number;
  /** `card` elements created in the window (throughput; counts later-deleted ones). */
  readonly newCards: number;
  /** `extract` elements created in the window (throughput; counts later-deleted ones). */
  readonly newExtracts: number;
  /** Elements soft-deleted in the window (the trash-rate). */
  readonly deletions: number;
  /** Cards currently flagged a leech (live). */
  readonly leeches: number;
  /**
   * Consecutive days (ending on `asOf`'s local day) with ≥1 review — a cheap
   * streak from `reviewsByDay`. `0` when no review was graded today.
   */
  readonly dayStreak: number;
}

/** Options for {@link AnalyticsService.computeAnalytics}. */
export interface AnalyticsOptions {
  /** Window length in calendar days (default {@link DEFAULT_ANALYTICS_WINDOW_DAYS}). */
  readonly windowDays?: number;
}

/** The local-day key (`YYYY-MM-DD`) for an ISO timestamp, in the machine timezone. */
function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The start-of-local-day instant (00:00:00.000 local) for a date, as a Date. */
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export class AnalyticsService {
  private readonly queue: QueueRepository;
  private readonly review: ReviewRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.queue = new QueueRepository(db);
    this.review = new ReviewRepository(db);
  }

  /**
   * Compute the full {@link AnalyticsSummary} for `asOf` over `windowDays`. One
   * read pass: it queries `review_logs` for the window once and buckets in JS,
   * counts `elements` by `createdAt`/`deletedAt`, and reads the two due counts +
   * the live leech count. Read-only.
   */
  computeAnalytics(asOf: IsoTimestamp, options: AnalyticsOptions = {}): AnalyticsSummary {
    const windowDays = options.windowDays ?? DEFAULT_ANALYTICS_WINDOW_DAYS;
    const asOfDate = new Date(asOf);

    // The window is the last `windowDays` LOCAL calendar days including `asOf`'s
    // day: [startOfDay(asOf) - (windowDays - 1) days, asOf]. We compute the lower
    // bound as a local-midnight instant so a review at any time on the first day of
    // the window is included.
    const windowStartDay = startOfLocalDay(asOfDate);
    windowStartDay.setDate(windowStartDay.getDate() - (windowDays - 1));
    const windowStartIso = windowStartDay.toISOString();

    // ---- reviews in the window (one query, bucketed in JS by local day) ----
    const logs = this.db
      .select({ rating: reviewLogs.rating, reviewedAt: reviewLogs.reviewedAt })
      .from(reviewLogs)
      .where(and(gte(reviewLogs.reviewedAt, windowStartIso), lte(reviewLogs.reviewedAt, asOf)))
      .all();

    // Pre-seed every day bucket (so the spark has a bar per day, even at 0).
    const buckets = new Map<string, number>();
    const orderedDays: string[] = [];
    for (let i = 0; i < windowDays; i++) {
      const d = new Date(windowStartDay);
      d.setDate(d.getDate() + i);
      const key = localDayKey(d.toISOString());
      buckets.set(key, 0);
      orderedDays.push(key);
    }

    let reviewsTotal = 0;
    let notAgain = 0;
    for (const log of logs) {
      reviewsTotal += 1;
      if (log.rating !== "again") notAgain += 1;
      const key = localDayKey(log.reviewedAt);
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    const reviewsByDay: ReviewsByDay[] = orderedDays.map((date) => ({
      date,
      count: buckets.get(date) ?? 0,
    }));
    const reviewsPerDayAvg = windowDays > 0 ? reviewsTotal / windowDays : 0;
    const retention30d = reviewsTotal > 0 ? notAgain / reviewsTotal : null;

    // ---- day streak (consecutive days ending today with ≥1 review) ----
    let dayStreak = 0;
    for (let i = reviewsByDay.length - 1; i >= 0; i--) {
      if ((reviewsByDay[i]?.count ?? 0) > 0) dayStreak += 1;
      else break;
    }

    // ---- new cards / extracts created in the window (throughput) ----
    const newCards = this.countCreatedInWindow("card", windowStartIso, asOf);
    const newExtracts = this.countCreatedInWindow("extract", windowStartIso, asOf);

    // ---- deletions in the window (trash-rate) ----
    const deletions = this.db
      .select({ id: elements.id })
      .from(elements)
      .where(
        and(
          isNotNull(elements.deletedAt),
          gte(elements.deletedAt, windowStartIso),
          lte(elements.deletedAt, asOf),
        ),
      )
      .all().length;

    // ---- live due counts (the two-scheduler split) + leeches ----
    const dueCards = this.queue.dueCards(asOf).length;
    const dueTopics = this.queue.dueAttentionItems(asOf).length;
    const leeches = this.review.listLeechCards().length;

    return {
      asOf,
      windowDays,
      reviewsByDay,
      reviewsTotal,
      reviewsPerDayAvg,
      retention30d,
      dueCards,
      dueTopics,
      newCards,
      newExtracts,
      deletions,
      leeches,
      dayStreak,
    };
  }

  /** Count elements of `type` whose `createdAt` is within `[start, end]` (inclusive). */
  private countCreatedInWindow(type: "card" | "extract", start: string, end: string): number {
    return this.db
      .select({ id: elements.id })
      .from(elements)
      .where(
        and(eq(elements.type, type), gte(elements.createdAt, start), lte(elements.createdAt, end)),
      )
      .all().length;
  }
}

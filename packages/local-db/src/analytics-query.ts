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

import {
  type BalanceJudgment,
  type BalanceSeverity,
  DEFAULT_IMPORT_BALANCE_FACTOR,
  type IsoTimestamp,
  judgeBalance,
} from "@interleave/core";
import { elements, type InterleaveDatabase, reviewLogs } from "@interleave/db";
import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import { QueueRepository } from "./queue-repository";
import { ReviewRepository } from "./review-repository";

/** Default analytics window — the kit's "last 30 days". */
export const DEFAULT_ANALYTICS_WINDOW_DAYS = 30;

/** Default import/process balance window — "this week". */
export const DEFAULT_BALANCE_WINDOW_DAYS = 7;

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
  /** Cards currently RETIRED (live) — out of active review, kept for reference (T082). */
  readonly retired: number;
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

/** Options for {@link AnalyticsService.computeBalance}. */
export interface BalanceOptions {
  /** Window length in calendar days (default {@link DEFAULT_BALANCE_WINDOW_DAYS}). */
  readonly windowDays?: number;
  /**
   * The imbalance factor (how lopsided imports vs processing must be before the
   * warning fires). Defaults to `@interleave/core`'s {@link DEFAULT_IMPORT_BALANCE_FACTOR};
   * the main side passes the user's `importBalanceFactor` setting. Clamped by the
   * pure rule, so a malformed value can never disable the warning.
   */
  readonly factor?: number;
}

/**
 * The import/process balance snapshot (T046) — the four weekly headline numbers
 * plus the imbalance judgment. Reuses the T045 windowed aggregation (the SAME
 * `createdAt`-in-window counting), only with a 7-day window and the
 * import-vs-output framing, so the inbox banner + the analytics view can never
 * disagree. The judgment is the pure `@interleave/core` `judgeBalance` rule.
 *
 * Advisory only — it NEVER mutates a schedule (auto-postpone is M16/T077).
 */
export interface BalanceSummary {
  /** The `asOf` instant the snapshot was computed for (ISO-8601). */
  readonly asOf: IsoTimestamp;
  /** The window length in calendar days (default 7). */
  readonly windowDays: number;
  /** `source` elements imported (created) in the window. */
  readonly sourcesImported: number;
  /** `extract` elements created in the window. */
  readonly extractsCreated: number;
  /** `card` elements created in the window. */
  readonly cardsCreated: number;
  /** Cards due for FSRS review within the next `windowDays` days (forward-looking). */
  readonly reviewsDueThisWeek: number;
  /** True when imports outpace processing (`severity !== "ok"`). */
  readonly imbalanced: boolean;
  /** The severity bucket driving the banner variant (`ok`/`warn`/`danger`). */
  readonly severity: BalanceSeverity;
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
    // Retired cards (T082) — out of active review, kept for reference. The
    // maintenance inventory + analytics surface count them like leeches.
    const retired = this.review.countRetiredCards();

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
      retired,
      dayStreak,
    };
  }

  /**
   * Compute the import/process {@link BalanceSummary} for `asOf` over `windowDays`
   * (default 7). REUSES the T045 windowed aggregation — the same
   * `createdAt`-in-window counting — so the inbox banner and the analytics view
   * read the SAME numbers and can never disagree. The imbalance judgment is the
   * pure `@interleave/core` `judgeBalance` rule (the single tunable place).
   * Read-only — no mutation, no `operation_log`, no schedule changes.
   */
  computeBalance(asOf: IsoTimestamp, options: BalanceOptions = {}): BalanceSummary {
    const windowDays = options.windowDays ?? DEFAULT_BALANCE_WINDOW_DAYS;
    const factor = options.factor ?? DEFAULT_IMPORT_BALANCE_FACTOR;
    const asOfDate = new Date(asOf);

    // The same local-day window the analytics snapshot uses, just 7 days wide.
    const windowStartDay = startOfLocalDay(asOfDate);
    windowStartDay.setDate(windowStartDay.getDate() - (windowDays - 1));
    const windowStartIso = windowStartDay.toISOString();

    const sourcesImported = this.countCreatedInWindow("source", windowStartIso, asOf);
    const extractsCreated = this.countCreatedInWindow("extract", windowStartIso, asOf);
    const cardsCreated = this.countCreatedInWindow("card", windowStartIso, asOf);

    // "Reviews due this week" looks FORWARD: cards due within the next `windowDays`.
    const windowEnd = new Date(asOfDate);
    windowEnd.setDate(windowEnd.getDate() + windowDays);
    const reviewsDueThisWeek = this.queue.dueCardsBetween(
      asOf,
      windowEnd.toISOString() as IsoTimestamp,
    );

    const judgment: BalanceJudgment = judgeBalance(
      { sourcesImported, extractsCreated, cardsCreated },
      factor,
    );

    return {
      asOf,
      windowDays,
      sourcesImported,
      extractsCreated,
      cardsCreated,
      reviewsDueThisWeek,
      imbalanced: judgment.imbalanced,
      severity: judgment.severity,
    };
  }

  /** Count elements of `type` whose `createdAt` is within `[start, end]` (inclusive). */
  private countCreatedInWindow(
    type: "card" | "extract" | "source",
    start: string,
    end: string,
  ): number {
    return this.db
      .select({ id: elements.id })
      .from(elements)
      .where(
        and(eq(elements.type, type), gte(elements.createdAt, start), lte(elements.createdAt, end)),
      )
      .all().length;
  }
}

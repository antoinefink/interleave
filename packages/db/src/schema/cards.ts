/**
 * Card + FSRS review tables (T006): `cards`, `review_states`, `review_logs`.
 *
 * `cards` is the active-recall side-table for a `card`-type element (keyed 1:1
 * by element id). `kind` is `qa` or `cloze` (only these ship in the MVP);
 * `sourceLocationId` links the card back to the exact source position — the top
 * of the lineage chain `card → source location → source`.
 *
 * `review_states` holds the persisted FSRS memory state for a card (mirrors
 * {@link ReviewState}); FSRS scheduling applies to **cards only**. `review_logs`
 * is the append-only history of grading events (mirrors {@link ReviewLog}) — one
 * immutable row per review, snapshotting the before/after FSRS state so sessions
 * are repairable and parameters can later be optimized.
 */

import { CARD_KINDS, FSRS_STATES, REVIEW_RATINGS } from "@interleave/core";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";
import { elements } from "./elements";
import { sourceLocations } from "./sources";

export const cards = sqliteTable(
  "cards",
  {
    /** Mirrors the owning `card` element's id (one-to-one). */
    elementId: text("element_id")
      .primaryKey()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** `qa` or `cloze`. */
    kind: text("kind").notNull(),
    /** Q&A prompt; `null` for pure cloze cards. */
    prompt: text("prompt"),
    /** Q&A answer; `null` for pure cloze cards. */
    answer: text("answer"),
    /** Cloze text with `{{c1::answer}}` markers; `null` for Q&A cards. */
    cloze: text("cloze"),
    /** Link to the exact source position this card derives from. */
    sourceLocationId: text("source_location_id").references(() => sourceLocations.id, {
      onDelete: "set null",
    }),
    /**
     * Durable leech flag (T040). A card is automatically flagged a leech once its
     * cumulative `review_states.lapses` reaches the leech threshold (4 — see
     * `@interleave/scheduler` `isLeech`); the flag is set in the SAME transaction as
     * the failing grade so the cleanup view + analytics can query it cheaply
     * (`WHERE is_leech = 1`) without recomputing from the lapse history. Stored on
     * the CARD side (a quality attribute), not `review_states` (the FSRS memory
     * state). A remediated card can be un-leeched. `0`/`1` (SQLite boolean).
     */
    isLeech: integer("is_leech", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    check("cards_kind_check", inList(table.kind, CARD_KINDS)),
    index("cards_source_location_idx").on(table.sourceLocationId),
    // The leech cleanup view + analytics filter on the leech flag (T040).
    index("cards_is_leech_idx").on(table.isLeech),
  ],
);

export const reviewStates = sqliteTable(
  "review_states",
  {
    /** The card element this FSRS state belongs to (one-to-one). */
    elementId: text("element_id")
      .primaryKey()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** Next due time; the queue/review session reads this. */
    dueAt: text("due_at"),
    /** FSRS memory stability (days). */
    stability: real("stability").notNull().default(0),
    /** FSRS item difficulty. */
    difficulty: real("difficulty").notNull().default(0),
    /** Days since the previous review when this state was computed. */
    elapsedDays: real("elapsed_days").notNull().default(0),
    /** Interval (days) FSRS scheduled at the previous review. */
    scheduledDays: real("scheduled_days").notNull().default(0),
    /** Total successful-enough repetitions. */
    reps: integer("reps").notNull().default(0),
    /** Total lapses (failed reviews); drives leech detection. */
    lapses: integer("lapses").notNull().default(0),
    /** Current FSRS phase — one of the canonical `FsrsState` values. */
    fsrsState: text("fsrs_state").notNull().default("new"),
    /** When this card was last reviewed; `null` for a brand-new card. */
    lastReviewedAt: text("last_reviewed_at"),
  },
  (table) => [
    check("review_states_fsrs_state_check", inList(table.fsrsState, FSRS_STATES)),
    index("review_states_due_idx").on(table.dueAt),
  ],
);

export const reviewLogs = sqliteTable(
  "review_logs",
  {
    id: text("id").primaryKey(),
    /** The card element that was reviewed. */
    elementId: text("element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** Grade — one of the canonical `ReviewRating` values. */
    rating: text("rating").notNull(),
    reviewedAt: text("reviewed_at").notNull(),
    /** Time-to-answer in milliseconds (reveal → grade). */
    responseMs: integer("response_ms").notNull(),
    /** FSRS state captured immediately before this review. */
    prevState: text("prev_state").notNull(),
    /** FSRS state assigned by this review. */
    nextState: text("next_state").notNull(),
    /** Card stability after this review (days). */
    nextStability: real("next_stability").notNull(),
    /** Card difficulty after this review. */
    nextDifficulty: real("next_difficulty").notNull(),
    /** Due time scheduled by this review. */
    nextDueAt: text("next_due_at").notNull(),
  },
  (table) => [
    check("review_logs_rating_check", inList(table.rating, REVIEW_RATINGS)),
    check("review_logs_prev_state_check", inList(table.prevState, FSRS_STATES)),
    check("review_logs_next_state_check", inList(table.nextState, FSRS_STATES)),
    index("review_logs_element_idx").on(table.elementId),
    index("review_logs_reviewed_idx").on(table.reviewedAt),
  ],
);

export type CardRow = typeof cards.$inferSelect;
export type NewCardRow = typeof cards.$inferInsert;
export type ReviewStateRow = typeof reviewStates.$inferSelect;
export type NewReviewStateRow = typeof reviewStates.$inferInsert;
export type ReviewLogRow = typeof reviewLogs.$inferSelect;
export type NewReviewLogRow = typeof reviewLogs.$inferInsert;

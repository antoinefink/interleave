/**
 * Task vocabulary (T092/T110) — the closed set of `task`-type element "kinds" +
 * their human labels.
 *
 * A `task` is the EXISTING core {@link ElementType} (see `enums.ts`), an
 * ATTENTION-scheduled maintenance action that protects time-sensitive knowledge
 * from rotting: "verify this claim", "find a better source", "update this outdated
 * card", "check the current version". It is NEVER a card and NEVER FSRS-scheduled.
 *
 * The `taskType` lives on the `tasks` side-table (`tasks.task_type`); this tuple is
 * the SINGLE source of truth for both the domain union AND the `tasks.task_type`
 * CHECK constraint (built from this tuple via `inList`), so the DB and the domain
 * can't silently drift — "a rename is a migration".
 *
 * Pure, framework-free (no React, no Drizzle, no DB), like every other `@interleave/
 * core` vocabulary. The renderer renders {@link taskTypeLabel}; the main process and
 * the DB validate against {@link TASK_TYPES} / {@link isTaskType}.
 */

/**
 * The closed set of task kinds. The four verification roadmap kinds plus `custom`
 * (a hand-created maintenance action with no fixed semantics) and system-owned
 * `weekly_review` (T110):
 *  - `verify_claim`          — re-check that a claim is still true.
 *  - `find_better_source`    — replace a weak/low-tier source with a stronger one.
 *  - `update_outdated_card`  — refresh a card whose fact has changed.
 *  - `check_current_version` — confirm a version-specific claim still holds.
 *  - `custom`                — a free-form maintenance action (no fixed semantics).
 *  - `weekly_review`         — the scheduled weekly ledger/integrity session.
 *  - `reread_region`         — a system-owned re-read of a source region whose
 *                              descendant cards keep lapsing together (T129); created
 *                              only by accepting a re-read proposal, never by hand.
 *
 * `verify_claim` is the default kind generated from T090 expiry (a fact past
 * `review_by`/`valid_until`).
 */
export const TASK_TYPES = [
  "verify_claim",
  "find_better_source",
  "update_outdated_card",
  "check_current_version",
  "custom",
  "weekly_review",
  "reread_region",
] as const;

/** A verification-task kind — one of {@link TASK_TYPES}. */
export type TaskType = (typeof TASK_TYPES)[number];

/** Type guard: is `value` one of the {@link TASK_TYPES} kinds? */
export function isTaskType(value: unknown): value is TaskType {
  return typeof value === "string" && (TASK_TYPES as readonly string[]).includes(value);
}

/** System-owned task kinds that generic task creation must not mint directly. */
export const SYSTEM_TASK_TYPES = [
  "weekly_review",
  "reread_region",
] as const satisfies readonly TaskType[];

/** A system-owned task kind — one of {@link SYSTEM_TASK_TYPES}. */
export type SystemTaskType = (typeof SYSTEM_TASK_TYPES)[number];

/** Type guard: is `value` one of the system-owned task kinds? */
export function isSystemTaskType(value: unknown): value is SystemTaskType {
  return typeof value === "string" && (SYSTEM_TASK_TYPES as readonly string[]).includes(value);
}

/** Human, sentence-case labels for each {@link TaskType} — the UI's task-kind label. */
export const TASK_TYPE_LABEL: Readonly<Record<TaskType, string>> = {
  verify_claim: "Verify claim",
  find_better_source: "Find better source",
  update_outdated_card: "Update outdated card",
  check_current_version: "Check current version",
  custom: "Custom task",
  weekly_review: "Weekly review",
  reread_region: "Re-read section",
};

/**
 * The human label for a task kind. Defensive: an unknown value (e.g. a legacy row
 * predating the CHECK, or a malformed input) falls back to {@link TASK_TYPE_LABEL.custom}
 * rather than throwing — the label is presentation, never a gate.
 */
export function taskTypeLabel(taskType: string): string {
  return isTaskType(taskType) ? TASK_TYPE_LABEL[taskType] : TASK_TYPE_LABEL.custom;
}

/**
 * @interleave/testing — shared factories, fixtures, and test harness helpers.
 *
 * Provides the in-memory native-SQLite harness (`createInMemoryDb`) reused by
 * both Vitest unit/repository tests (T008) and the seed/factory work (T009).
 * Deterministic element/document/review factories land in T009.
 */
export const TESTING_PACKAGE = "@interleave/testing" as const;

/** Native-SQLite, fully-migrated in-memory database for repository tests (T008). */
export { createInMemoryDb } from "./db";

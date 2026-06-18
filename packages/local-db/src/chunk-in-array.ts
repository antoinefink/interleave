/**
 * Shared chunking helper for batched `IN (...)` reads.
 *
 * SQLite's `SQLITE_MAX_VARIABLE_NUMBER` is 999 on older/default builds. Any
 * `inArray(column, ids)` over an unbounded id set will throw
 * "too many SQL variables" once `ids.length` crosses that floor — exactly the
 * large-vault scenario batched reads are meant to serve. Splitting the id list
 * into chunks well under the floor keeps every batched read bounded while
 * remaining output-identical to a single `IN (...)`: chunking is purely a
 * transport split, so callers merge the per-chunk results back into one Map or
 * array.
 *
 * The constant is shared so every primitive uses the same (already battle-tested
 * in `time-cost-query.ts`) size rather than inventing a smaller ad-hoc one.
 */

/** Safe `IN (...)` list size, comfortably under SQLite's 999 variable floor. */
export const SQLITE_SAFE_IN_ARRAY_SIZE = 900;

/**
 * Split `ids` into contiguous chunks of at most `SQLITE_SAFE_IN_ARRAY_SIZE`.
 * Order is preserved, so a fold over the flattened result is identical to a fold
 * over the original list. Returns an empty array for empty input.
 */
export function chunkIds<T>(ids: readonly T[], size: number = SQLITE_SAFE_IN_ARRAY_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/**
 * Shared local-db plumbing types (T008).
 *
 * `DbClient` is the structural type every repository method accepts — it covers
 * BOTH the top-level Drizzle client (`InterleaveDatabase`) and the transaction
 * client Drizzle hands a `db.transaction(tx => …)` callback. Repositories take a
 * `DbClient` for reads and require the transaction client for writes, so a write
 * + its `operation_log` append always commit atomically.
 */

import type { InterleaveDatabase } from "@interleave/db";

/**
 * A Drizzle client capable of the query builders the repositories use. Both the
 * root `InterleaveDatabase` and the transaction object passed to
 * `db.transaction(...)` satisfy this, so a method can run standalone or inside a
 * larger transaction.
 */
export type DbClient = InterleaveDatabase | TransactionClient;

/** The argument Drizzle passes to a `better-sqlite3` transaction callback. */
export type TransactionClient = Parameters<Parameters<InterleaveDatabase["transaction"]>[0]>[0];

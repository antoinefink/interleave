/**
 * SettingsRepository (T008) — the canonical local store for user/domain settings.
 *
 * Settings (daily review budget, default desired retention, default topic
 * interval, default source priority, keyboard layout, theme) live in the SQLite
 * `settings` key/value table (T011 builds the UI on top). Values are stored as
 * JSON text and parsed on read. App-level desktop settings (e.g. window bounds)
 * stay in Electron config, not here.
 *
 * Settings have no dedicated op in the canonical `OPERATION_TYPES` vocabulary, so
 * writes do not append an op-log entry; they are idempotent upserts on the key.
 */

import { type InterleaveDatabase, settings } from "@interleave/db";
import { eq } from "drizzle-orm";

export class SettingsRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /** Read and JSON-parse one setting by key, or `null` if unset. */
  get<T = unknown>(key: string): T | null {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? (JSON.parse(row.value) as T) : null;
  }

  /** Read one setting, falling back to `fallback` when unset. */
  getOr<T>(key: string, fallback: T): T {
    const value = this.get<T>(key);
    return value === null ? fallback : value;
  }

  /** Read all settings as a parsed key→value record. */
  getAll(): Record<string, unknown> {
    const rows = this.db.select().from(settings).all();
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      out[row.key] = JSON.parse(row.value) as unknown;
    }
    return out;
  }

  /** Create or overwrite one setting (JSON-encoded). Returns the stored value. */
  set<T>(key: string, value: T): T {
    const json = JSON.stringify(value ?? null);
    this.db
      .insert(settings)
      .values({ key, value: json })
      .onConflictDoUpdate({ target: settings.key, set: { value: json } })
      .run();
    return value;
  }

  /** Create/overwrite many settings in one transaction. */
  setMany(values: Record<string, unknown>): void {
    this.db.transaction((tx) => {
      for (const [key, value] of Object.entries(values)) {
        const json = JSON.stringify(value ?? null);
        tx.insert(settings)
          .values({ key, value: json })
          .onConflictDoUpdate({ target: settings.key, set: { value: json } })
          .run();
      }
    });
  }

  /** Delete one setting by key (settings are not user data — hard delete is fine). */
  delete(key: string): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }
}

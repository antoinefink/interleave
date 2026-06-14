/**
 * Capture origin (`captured_via`) — where a `source` entered the system (T126).
 *
 * Capture throughput exceeds triage throughput, and the morning-triage feature
 * groups the inbox by WHERE material came from. That requires capture origin to be
 * a queryable, persisted fact on every new `source`, written at each import seam —
 * extension and URL captures are otherwise indistinguishable in storage (both flow
 * through the same `UrlImportService` pipeline).
 *
 * This module is the framework-agnostic single source of truth for the closed set
 * of origins and their human labels: `packages/db` CHECK-constrains the
 * `sources.captured_via` column against {@link CAPTURED_VIA} (the DB + the domain
 * union can never drift), and the renderer's group-by-origin view derives its
 * header label from {@link capturedViaLabel}. The column is NULLABLE: legacy rows
 * with no recorded origin (and any genuinely-ambiguous backfill) render as
 * "Other", so honest-unknown beats confident-wrong (the provenance invariant).
 */

/**
 * The closed set of capture origins a `source` can carry:
 *
 *  - `manual`           — a hand-typed note / pasted source (manual import).
 *  - `url`              — a URL background-runner import (fetched + snapshotted).
 *  - `extension`        — a browser-extension loopback capture (page / selection).
 *  - `highlight_import` — a Readwise / Kindle highlight export (T069).
 *  - `file`             — a local file import (epub / markdown / html / anki / pdf / media).
 */
export const CAPTURED_VIA = ["manual", "url", "extension", "highlight_import", "file"] as const;

/** A capture origin — one of {@link CAPTURED_VIA}. */
export type CapturedVia = (typeof CAPTURED_VIA)[number];

/** Type guard: is `value` one of the {@link CAPTURED_VIA} origins? */
export function isCapturedVia(value: unknown): value is CapturedVia {
  return typeof value === "string" && (CAPTURED_VIA as readonly string[]).includes(value);
}

/** Human labels for each capture origin (the group-by-origin header label). */
const CAPTURED_VIA_LABEL: Record<CapturedVia, string> = {
  manual: "Manual",
  url: "URL",
  extension: "Extension",
  highlight_import: "Highlight import",
  file: "File",
};

/**
 * Map a capture origin to its human label for the group-by-origin header. A `null`
 * (legacy / un-recorded origin) OR any unknown string falls back to "Other" — the
 * stable bucket that absorbs nulls so honest-unknown reads calmly rather than as a
 * fabricated origin.
 */
export function capturedViaLabel(value: CapturedVia | null): string {
  return isCapturedVia(value) ? CAPTURED_VIA_LABEL[value] : "Other";
}

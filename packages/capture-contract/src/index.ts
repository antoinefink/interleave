/**
 * @interleave/capture-contract (T062) — the framework-free, zod-only wire
 * contract shared by the Chrome extension AND the Electron main's loopback
 * capture server.
 *
 * This package is the deliberate SEAM between two worlds that must NOT share
 * code otherwise:
 *
 *   - the **browser extension** (`apps/extension`) — an MV3 background worker +
 *     options/popup pages that run in Chrome. It must NOT import `@interleave/core`,
 *     `@interleave/local-db`, `apps/web`, or Electron (that would drag SQLite/Node/
 *     React/electron into a browser bundle and break the security boundary).
 *   - the **Electron main** loopback capture server (`apps/desktop/src/main`),
 *     which validates an incoming capture and dispatches it into the M12 import
 *     service.
 *
 * So the ONLY dependency here is `zod`. Everything both sides agree on — the
 * capture request/response shapes, the priority-label enum (a local COPY of
 * `@interleave/core`'s labels, kept identical), and the pure shaping/validation
 * helpers — lives in this one file with no transitive workspace imports.
 *
 * Nothing here does I/O: no `fetch`, no `node:crypto`, no `chrome.*`. The pure
 * functions (`shapeCapture` / `validateOrigin` / `timingSafeTokenEqual`) are
 * therefore unit-testable with neither Chrome nor Electron, and importable in
 * BOTH bundles.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Priority — a LOCAL copy of @interleave/core's A/B/C/D labels.
//
// The extension cannot import @interleave/core, so the label enum is duplicated
// here. It MUST stay identical to core's `PriorityLabel` ("A" | "B" | "C" | "D");
// the desktop maps the label → a numeric priority with core's `priorityFromLabel`
// AFTER validation (the contract never carries the numeric value — the label is
// the wire shape).
// ---------------------------------------------------------------------------

export const PriorityLabelSchema = z.enum(["A", "B", "C", "D"]);
export type PriorityLabel = z.infer<typeof PriorityLabelSchema>;

/** What kind of thing the user captured: the whole page, or a text selection. */
export const CaptureKindSchema = z.enum(["page", "selection"]);
export type CaptureKind = z.infer<typeof CaptureKindSchema>;

// ---------------------------------------------------------------------------
// Field caps — generous but bounded, so a malicious/buggy extension can never
// hand the desktop an unbounded payload (the server ALSO enforces a hard byte
// cap on the raw body before parsing; these are the per-field schema limits).
// ---------------------------------------------------------------------------

const URL_MAX = 2048;
const TITLE_MAX = 512;
/** The page's scraped outerHTML (the worker already has the rendered DOM). */
const HTML_MAX = 5_000_000;
const SELECTION_MAX = 500_000;
const REASON_MAX = 2048;
const BLOCK_CONTEXT_MAX = 4000;

/** An http/https URL within the length cap. */
const CaptureUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(URL_MAX)
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "url must be http(s)",
  });

/** Save the WHOLE page the user is reading (runs the M12 page import pipeline). */
export const CapturePageRequestSchema = z.object({
  kind: z.literal("page"),
  url: CaptureUrlSchema,
  title: z.string().trim().max(TITLE_MAX).optional(),
  /** The page's scraped outerHTML, so the desktop need not re-fetch (paywalls/JS). */
  html: z.string().max(HTML_MAX).optional(),
  priority: PriorityLabelSchema.optional(),
  reason: z.string().trim().max(REASON_MAX).optional(),
});
export type CapturePageRequest = z.infer<typeof CapturePageRequestSchema>;

/** Save the current text SELECTION (lands a fresh selection source — no snapshot). */
export const CaptureSelectionRequestSchema = z.object({
  kind: z.literal("selection"),
  url: CaptureUrlSchema,
  title: z.string().trim().max(TITLE_MAX).optional(),
  /** The selected text (1–500k); the body of the new inbox source. */
  selection: z.string().trim().min(1).max(SELECTION_MAX),
  priority: PriorityLabelSchema.optional(),
  reason: z.string().trim().max(REASON_MAX).optional(),
  /** Surrounding text anchor for selection lineage (folded into reason_added). */
  blockContext: z.string().trim().max(BLOCK_CONTEXT_MAX).optional(),
  /** ISO accessed timestamp; defaults to "now" main-side when omitted. */
  accessedAt: z.string().trim().max(64).optional(),
});
export type CaptureSelectionRequest = z.infer<typeof CaptureSelectionRequestSchema>;

/** The discriminated capture request the extension POSTs to `/capture`. */
export const CaptureRequestSchema = z.discriminatedUnion("kind", [
  CapturePageRequestSchema,
  CaptureSelectionRequestSchema,
]);
export type CaptureRequest = z.infer<typeof CaptureRequestSchema>;

// ---------------------------------------------------------------------------
// Responses.
// ---------------------------------------------------------------------------

/** A successful capture — `id`/`title` echo the created (or deduped) source. */
export const CaptureResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  kind: CaptureKindSchema,
  title: z.string(),
  /** True when a page capture matched an existing source (T061 dedup); never for selections. */
  deduped: z.boolean(),
});
export type CaptureResponse = z.infer<typeof CaptureResponseSchema>;

/** The typed error codes the server returns (each maps to a fixed HTTP status). */
export const CaptureErrorCodeSchema = z.enum([
  "unpaired",
  "bad_token",
  "bad_origin",
  "too_large",
  "invalid",
  "import_failed",
]);
export type CaptureErrorCode = z.infer<typeof CaptureErrorCodeSchema>;

/** A failed capture — a typed `error` code, never leaking internals. */
export const CaptureErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: CaptureErrorCodeSchema,
});
export type CaptureErrorResponse = z.infer<typeof CaptureErrorResponseSchema>;

// ---------------------------------------------------------------------------
// Open captured source command.
// ---------------------------------------------------------------------------

const ELEMENT_ID_MAX = 128;

/**
 * Ask the desktop app to focus and open a captured source. This is deliberately
 * NOT a generic command channel: the extension may only name the source id it just
 * received from `/capture` or recent-capture storage.
 */
export const OpenSourceRequestSchema = z.object({
  id: z.string().trim().min(1).max(ELEMENT_ID_MAX),
  /** When true, an inbox source is activated before opening the reader. */
  activate: z.boolean().optional().default(true),
});
export type OpenSourceRequestInput = z.input<typeof OpenSourceRequestSchema>;
export type OpenSourceRequest = z.output<typeof OpenSourceRequestSchema>;

/** The desktop accepted the open request and focused/routed the source reader. */
export const OpenSourceResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  activated: z.boolean(),
});
export type OpenSourceResponse = z.infer<typeof OpenSourceResponseSchema>;

export const OpenSourceErrorCodeSchema = z.enum([
  "unpaired",
  "bad_token",
  "bad_origin",
  "too_large",
  "invalid",
  "not_found",
  "open_failed",
]);
export type OpenSourceErrorCode = z.infer<typeof OpenSourceErrorCodeSchema>;

/** Failed open-source command; never leaks DB/window internals. */
export const OpenSourceErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: OpenSourceErrorCodeSchema,
});
export type OpenSourceErrorResponse = z.infer<typeof OpenSourceErrorResponseSchema>;

// ---------------------------------------------------------------------------
// Lookup source command (the pre-save "already saved" hint).
//
// A read-only loopback question the popup asks on open — "is this page already a
// saved source?" — BEFORE the user clicks Save. The desktop canonicalizes the URL
// and reproduces ONLY the canonical-URL dedup signal that `/capture` (T061) uses,
// so the up-front answer is correct-by-construction for that signal.
//
// POSITIVE-ONLY CONTRACT: a `found: false` answer is NOT a guarantee that a
// subsequent save will not dedup. The two other dedup signals — the cleaned-HTML
// content-hash backstop, and post-redirect canonical drift — cannot be resolved
// at popup-open time (there is no fetched/cleaned HTML yet, and no redirect has
// happened). Those are intentional, accepted false-negatives surfaced only at
// save time, where `/capture` remains authoritative. This route reproduces the
// canonical-URL match and nothing else.
// ---------------------------------------------------------------------------

/**
 * Ask the desktop whether a page is already a saved source, by URL. The request
 * is deliberately PERMISSIVE — any non-empty string within the length cap, NOT
 * the strict `CaptureUrlSchema`. The desktop canonicalizes the URL and answers
 * `found: false` for a non-http(s) / unparseable value rather than rejecting it,
 * so the route stays robust even if the client fails to short-circuit.
 */
export const LookupSourceRequestSchema = z.object({
  url: z.string().trim().min(1).max(URL_MAX),
});
export type LookupSourceRequest = z.infer<typeof LookupSourceRequestSchema>;

/**
 * The lookup answer: `found` plus, when found, the newest matching source's
 * `id`/`title`/`status`. `source` is present IFF `found` is true (the route
 * guarantees this; the schema keeps it optional so a `found: false` body need not
 * carry one). `status` is a plain bounded string — the contract must NOT import
 * core's status enum — used by the popup only for display copy.
 */
export const LookupSourceResponseSchema = z.object({
  ok: z.literal(true),
  found: z.boolean(),
  source: z
    .object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
    })
    .optional(),
});
export type LookupSourceResponse = z.infer<typeof LookupSourceResponseSchema>;

export const LookupSourceErrorCodeSchema = z.enum([
  "unpaired",
  "bad_token",
  "bad_origin",
  "too_large",
  "invalid",
  "lookup_failed",
]);
export type LookupSourceErrorCode = z.infer<typeof LookupSourceErrorCodeSchema>;

/** Failed lookup-source command; never leaks DB/window internals. */
export const LookupSourceErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: LookupSourceErrorCodeSchema,
});
export type LookupSourceErrorResponse = z.infer<typeof LookupSourceErrorResponseSchema>;

/** The unauthenticated `GET /ping` body — reveals only the app name + version. */
export const PairingPingResponseSchema = z.object({
  ok: z.literal(true),
  app: z.literal("interleave"),
  version: z.string(),
});
export type PairingPingResponse = z.infer<typeof PairingPingResponseSchema>;

// ---------------------------------------------------------------------------
// Pure shaping + validation helpers (no I/O — importable in BOTH bundles).
// ---------------------------------------------------------------------------

/** The default capture priority — new material must never dominate older work. */
export const DEFAULT_CAPTURE_PRIORITY: PriorityLabel = "C";

/** The raw, possibly-dirty inputs the browser side gathers before shaping. */
export interface ShapeCaptureInput {
  readonly kind: CaptureKind;
  readonly url: string;
  readonly title?: string | null;
  /** For a page capture: the scraped outerHTML. */
  readonly html?: string | null;
  /** For a selection capture: the selected text. */
  readonly selection?: string | null;
  readonly priority?: PriorityLabel | null;
  readonly reason?: string | null;
  readonly blockContext?: string | null;
  readonly accessedAt?: string | null;
}

/** Trim a string; return `undefined` when it is null/empty (so `.optional()` drops it). */
function clean(value: string | null | undefined, max: number): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Shape raw browser-side inputs into a normalized, schema-valid `CaptureRequest`:
 * trim + clamp every field, default the priority to `C`, and drop empty optionals.
 * Pure — no Chrome, no network. THROWS (via `CaptureRequestSchema.parse`) if the
 * result is still invalid (e.g. a non-http url, an empty selection), so a caller
 * never ships a malformed payload.
 */
export function shapeCapture(input: ShapeCaptureInput): CaptureRequest {
  const url = (input.url ?? "").trim();
  const title = clean(input.title, TITLE_MAX);
  const priority = input.priority ?? DEFAULT_CAPTURE_PRIORITY;
  const reason = clean(input.reason, REASON_MAX);

  if (input.kind === "page") {
    // For HTML we clamp the length but keep internal whitespace (it is markup).
    const rawHtml = input.html == null ? undefined : input.html;
    const html =
      rawHtml && rawHtml.length > 0
        ? rawHtml.length > HTML_MAX
          ? rawHtml.slice(0, HTML_MAX)
          : rawHtml
        : undefined;
    return CapturePageRequestSchema.parse({
      kind: "page",
      url,
      ...(title !== undefined ? { title } : {}),
      ...(html !== undefined ? { html } : {}),
      priority,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  const selection = clean(input.selection, SELECTION_MAX) ?? "";
  const blockContext = clean(input.blockContext, BLOCK_CONTEXT_MAX);
  const accessedAt = clean(input.accessedAt, 64);
  return CaptureSelectionRequestSchema.parse({
    kind: "selection",
    url,
    ...(title !== undefined ? { title } : {}),
    selection,
    priority,
    ...(reason !== undefined ? { reason } : {}),
    ...(blockContext !== undefined ? { blockContext } : {}),
    ...(accessedAt !== undefined ? { accessedAt } : {}),
  });
}

/**
 * Exact-match a request `Origin` against the paired extension origin
 * (`chrome-extension://<id>`). Used by the loopback server's CORS/Origin gate.
 * A `null`/empty request origin, an unpaired (null) allowed origin, or any
 * non-exact value is rejected. Pure.
 */
export function validateOrigin(
  origin: string | null | undefined,
  allowedExtensionOrigin: string | null | undefined,
): boolean {
  if (!origin || !allowedExtensionOrigin) return false;
  return origin === allowedExtensionOrigin;
}

/**
 * Constant-time string comparison for the pairing token. Rejects a length
 * mismatch first (the only length-dependent branch — lengths are not secret),
 * then XORs every char code so the loop time does not depend on WHERE the first
 * difference is. No `node:crypto` — implemented in pure JS so the module stays
 * importable in the extension build too (only the server actually calls it).
 */
export function timingSafeTokenEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** The body shapes `shapeCapture` can emit (mirrors the discriminated union). */
export type { CaptureRequest as ShapedCapture };

/**
 * The pure capture-request handler (T062).
 *
 * This is the TESTABLE CORE of the loopback `/capture` route, deliberately
 * separated from the socket-binding `capture-server.ts` so it can be unit-tested
 * with injected fakes and NO open port. It takes the raw request body + headers
 * and the injected dependencies (the token getter, the allowed-origin getter, the
 * M12 import service) and returns an HTTP status + a typed `CaptureResponse` /
 * error body. It NEVER constructs SQL, never touches the filesystem, and never
 * re-fetches — all source creation stays inside the injected import service.
 *
 * The full threat model is enforced here, IN ORDER:
 *   1. unpaired  → 403  (no token OR no allowed origin stored)
 *   2. bad_origin→ 403  (Origin header ≠ the paired extension origin)
 *   3. bad_token → 401  (Authorization bearer ≠ the stored token, constant-time)
 *   4. too_large → 413  (raw body past the cap — the server signals this via `tooLarge`)
 *   5. invalid   → 400  (not JSON / Zod-invalid payload)
 *   6. dispatch into the import service → 200 / import_failed → 500
 */

import {
  type CaptureErrorCode,
  type CaptureRequest,
  CaptureRequestSchema,
  type CaptureResponse,
  timingSafeTokenEqual,
  validateOrigin,
} from "@interleave/capture-contract";
import type { PriorityLabel } from "@interleave/core";

/**
 * The discriminated import result both `importFromHtml` (page) and
 * `importSelection` return — a structural subset of the service's `UrlImportResult`
 * (so the unit test can pass a fake without importing the whole service).
 */
export type CaptureImportResult =
  | { readonly status: "imported"; readonly id: string; readonly item: { readonly title: string } }
  | {
      readonly status: "duplicate";
      readonly matches: readonly { readonly elementId: string; readonly title: string }[];
    };

/** The narrow import-service surface the handler dispatches into (page + selection). */
export interface CaptureImportService {
  importFromHtml(input: {
    url: string;
    html: string;
    title?: string | null;
    priority?: PriorityLabel;
    reasonAdded?: string | null;
    accessedAt?: string | null;
  }): Promise<CaptureImportResult>;
  importSelection(input: {
    url: string;
    title?: string | null;
    selection: string;
    priority?: PriorityLabel;
    reasonAdded?: string | null;
    blockContext?: string | null;
    accessedAt?: string | null;
  }): Promise<CaptureImportResult>;
}

/** The request shape the handler sees (already read off the HTTP request). */
export interface CaptureRequestContext {
  /** The raw request body text (JSON), already capped by the server. */
  readonly body: string;
  /** Lower-cased header lookups. */
  readonly authorization: string | null;
  readonly origin: string | null;
  readonly contentType: string | null;
  /** True when the server aborted reading because the body exceeded the cap. */
  readonly tooLarge?: boolean;
}

/** The injected dependencies (fakes in the unit test). */
export interface CaptureHandlerDeps {
  /** The stored pairing token, or `null` when never minted (unpaired). */
  getToken(): string | null;
  /** The paired extension origin, or `null` when no extension has paired (unpaired). */
  getAllowedOrigin(): string | null;
  /** The single shared M12 import service instance. */
  readonly importService: CaptureImportService;
}

/** The handler's HTTP outcome. */
export interface CaptureHandlerResult {
  readonly status: number;
  readonly body: CaptureResponse | { ok: false; error: CaptureErrorCode };
}

/** A small helper to build the typed error body. */
function err(status: number, error: CaptureErrorCode): CaptureHandlerResult {
  return { status, body: { ok: false, error } };
}

/**
 * Handle one `/capture` request. Pure except for awaiting the injected import
 * service. The server wraps this with the socket; this function owns the policy.
 */
export async function handleCapture(
  ctx: CaptureRequestContext,
  deps: CaptureHandlerDeps,
): Promise<CaptureHandlerResult> {
  const token = deps.getToken();
  const allowedOrigin = deps.getAllowedOrigin();

  // 1. Unpaired — no token OR no paired origin → closed for captures.
  if (!token || !allowedOrigin) {
    return err(403, "unpaired");
  }

  // 2. Origin/CORS — exact-match the paired extension origin.
  if (!validateOrigin(ctx.origin, allowedOrigin)) {
    return err(403, "bad_origin");
  }

  // 3. Token — constant-time bearer compare.
  const bearer = parseBearer(ctx.authorization);
  if (!bearer || !timingSafeTokenEqual(bearer, token)) {
    return err(401, "bad_token");
  }

  // 4. Body size — the server flags an over-cap body (it aborts the read early).
  if (ctx.tooLarge) {
    return err(413, "too_large");
  }

  // 5. Validate — must be JSON of the right content-type + a valid CaptureRequest.
  const mime = (ctx.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime !== "application/json") {
    return err(400, "invalid");
  }
  let parsed: CaptureRequest;
  try {
    const json: unknown = JSON.parse(ctx.body);
    parsed = CaptureRequestSchema.parse(json);
  } catch {
    return err(400, "invalid");
  }

  // 6. Dispatch into the M12 import service (NEVER SQLite directly).
  let result: CaptureImportResult;
  try {
    result = await dispatch(parsed, deps.importService);
  } catch {
    // Logged main-side by the server; never leak internals to the extension.
    return err(500, "import_failed");
  }

  return mapResult(parsed.kind, result);
}

/** Route a validated request into the matching import-service method. */
function dispatch(
  request: CaptureRequest,
  importService: CaptureImportService,
): Promise<CaptureImportResult> {
  // The wire carries the validated LABEL ("A"|"B"|"C"|"D"); the import service maps
  // it to numeric internally. The contract enum is identical to core's PriorityLabel.
  const priority = request.priority;
  if (request.kind === "page") {
    return importService.importFromHtml({
      url: request.url,
      html: request.html ?? "",
      title: request.title ?? null,
      ...(priority ? { priority } : {}),
      reasonAdded: request.reason ?? null,
    });
  }
  return importService.importSelection({
    url: request.url,
    title: request.title ?? null,
    selection: request.selection,
    ...(priority ? { priority } : {}),
    reasonAdded: request.reason ?? null,
    blockContext: request.blockContext ?? null,
    ...(request.accessedAt ? { accessedAt: request.accessedAt } : {}),
  });
}

/** Map the discriminated import result → the `CaptureResponse` (200) for BOTH arms. */
function mapResult(
  kind: CaptureRequest["kind"],
  result: CaptureImportResult,
): CaptureHandlerResult {
  if (result.status === "imported") {
    return {
      status: 200,
      body: { ok: true, id: result.id, kind, title: result.item.title, deduped: false },
    };
  }
  // "duplicate" — reachable only for a page (T061 dedup); echo the FIRST match's
  // existing source id/title with deduped: true. `matches` is non-empty here.
  const first = result.matches[0];
  if (!first) {
    // Defensive: a duplicate arm with no matches is a service bug; treat as failure.
    return err(500, "import_failed");
  }
  return {
    status: 200,
    body: { ok: true, id: first.elementId, kind, title: first.title, deduped: true },
  };
}

/** Extract the bearer token from an `Authorization: Bearer <token>` header. */
function parseBearer(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() ?? null;
}

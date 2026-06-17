/**
 * Shared extension helpers (T062) — storage keys, the paired-config reader, and
 * the loopback HTTP client.
 *
 * IMPORTANT BOUNDARY: this runs in the BROWSER (Chrome), not the Electron
 * renderer. It must NOT import `@interleave/core`, `@interleave/local-db`,
 * `apps/web`, or Electron. Its only workspace dependency is the zod-only
 * `@interleave/capture-contract` — the shared wire contract. Everything the
 * extension knows about the desktop is that contract + the loopback URL.
 */

import {
  type CaptureRequest,
  type CaptureResponse,
  type LookupSourceRequest,
  LookupSourceResponseSchema,
  type OpenSourceErrorCode,
  OpenSourceErrorResponseSchema,
  type OpenSourceRequestInput,
  OpenSourceResponseSchema,
  type ShapeCaptureInput,
  shapeCapture,
} from "@interleave/capture-contract";

/** The canonical loopback port the desktop binds first (a fallback scan may pick +1…). */
export const DEFAULT_CAPTURE_PORT = 47615;

/** `chrome.storage.local` keys for the paired config + the recent-captures list. */
export const STORAGE_KEYS = {
  token: "interleave.token",
  port: "interleave.port",
  recentCaptures: "interleave.recentCaptures",
} as const;

/** The paired config the user set in the options page. */
export interface PairedConfig {
  readonly token: string | null;
  readonly port: number;
}

/** A normalized outcome the popup/panel render (success / each failure mode). */
export type CaptureOutcome =
  | { readonly kind: "ok"; readonly response: CaptureResponse }
  | { readonly kind: "not-paired" }
  | { readonly kind: "not-running" }
  | { readonly kind: "bad-token" }
  | { readonly kind: "error"; readonly message: string };

/** A normalized outcome for opening a captured source in the desktop app. */
export type OpenSourceOutcome =
  | { readonly kind: "ok"; readonly sourceId: string }
  | { readonly kind: "not-paired" }
  | { readonly kind: "not-running" }
  | { readonly kind: "bad-token" }
  | { readonly kind: "error"; readonly message: string };

export interface OpenCapturedSourceOptions {
  readonly activate?: boolean;
}

/**
 * A normalized outcome for the pre-save "is this page already saved?" lookup.
 *
 * `ok` carries the newest matching source (or `null` when nothing matched). Every
 * other variant means "no banner" to the popup (R5): `not-applicable` (a
 * non-http(s) / missing url — short-circuited without a fetch), the same auth /
 * connectivity failure modes as {@link OpenSourceOutcome}, and `errored` (a
 * timeout, an unparseable body, or a schema mismatch).
 */
export type LookupOutcome =
  | { readonly kind: "ok"; readonly source: { id: string; title: string; status: string } | null }
  | { readonly kind: "not-applicable" }
  | { readonly kind: "not-paired" }
  | { readonly kind: "not-running" }
  | { readonly kind: "bad-token" }
  | { readonly kind: "errored" };

/** How long the pre-save lookup waits before aborting a slow desktop (R8). */
const LOOKUP_TIMEOUT_MS = 2500;

/** This extension's own origin (`chrome-extension://<id>`), the pairing identity. */
export function extensionOrigin(): string {
  return `chrome-extension://${chrome.runtime.id}`;
}

/** Read the paired token + port from `chrome.storage.local`. */
export async function readPairedConfig(): Promise<PairedConfig> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.port]);
  const token = typeof stored[STORAGE_KEYS.token] === "string" ? stored[STORAGE_KEYS.token] : null;
  const port =
    typeof stored[STORAGE_KEYS.port] === "number"
      ? stored[STORAGE_KEYS.port]
      : DEFAULT_CAPTURE_PORT;
  return { token, port };
}

/** Persist the paired token + port. */
export async function writePairedConfig(token: string, port: number): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.token]: token,
    [STORAGE_KEYS.port]: port,
  });
}

/** The loopback base URL for a given port. */
export function loopbackBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Probe `GET /ping` (unauthenticated) — returns true when the app is running. */
export async function pingApp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${loopbackBase(port)}/ping`, { method: "GET" });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; app?: string };
    return body.ok === true && body.app === "interleave";
  } catch {
    return false;
  }
}

/**
 * Pair: POST this extension's origin to `/pair` authenticated by the token, so
 * the desktop locks CORS to us. Returns true on success.
 */
export async function pairWithApp(token: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`${loopbackBase(port)}/pair`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ extensionOrigin: extensionOrigin() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Shape + POST a capture to the loopback `/capture` endpoint with the bearer
 * token. Returns a normalized {@link CaptureOutcome} the UI renders. A refused
 * connection → "not-running"; a `401` → "bad-token"; a `403` unpaired → "not-paired".
 */
export async function sendCapture(input: ShapeCaptureInput): Promise<CaptureOutcome> {
  const { token, port } = await readPairedConfig();
  if (!token) return { kind: "not-paired" };

  let request: CaptureRequest;
  try {
    request = shapeCapture(input);
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }

  let res: Response;
  try {
    res = await fetch(`${loopbackBase(port)}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
  } catch {
    // A refused/aborted connection means the desktop app is not running.
    return { kind: "not-running" };
  }

  if (res.status === 401) return { kind: "bad-token" };
  if (res.status === 403) {
    // Either unpaired or a bad origin — both mean "re-pair from the options page".
    return { kind: "not-paired" };
  }
  let body: CaptureResponse | { ok: false; error?: string };
  try {
    body = (await res.json()) as CaptureResponse | { ok: false; error?: string };
  } catch {
    return { kind: "error", message: `Unexpected response (${res.status})` };
  }
  if (res.ok && body.ok === true) {
    return { kind: "ok", response: body };
  }
  return {
    kind: "error",
    message: "error" in body && body.error ? String(body.error) : `Capture failed (${res.status})`,
  };
}

/**
 * POST a narrow open-source command to the paired loopback server. This stays on
 * the extension side of the boundary: no renderer/Electron/local-db imports, just
 * the bearer token + source id command shape the desktop validates.
 */
export async function openCapturedSource(
  sourceId: string,
  options: OpenCapturedSourceOptions = {},
): Promise<OpenSourceOutcome> {
  const cleanSourceId = sourceId.trim();
  if (!cleanSourceId) return { kind: "error", message: "Missing source id" };

  const { token, port } = await readPairedConfig();
  if (!token) return { kind: "not-paired" };

  const request: OpenSourceRequestInput = {
    id: cleanSourceId,
    activate: options.activate ?? true,
  };

  let res: Response;
  try {
    res = await fetch(`${loopbackBase(port)}/open-source`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
  } catch {
    return { kind: "not-running" };
  }

  if (res.status === 401) return { kind: "bad-token" };
  if (res.status === 403) return { kind: "not-paired" };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "error", message: `Unexpected response (${res.status})` };
  }

  const ok = OpenSourceResponseSchema.safeParse(body);
  if (ok.success) {
    if (res.ok) return { kind: "ok", sourceId: ok.data.id };
    return { kind: "error", message: `Open failed (${res.status})` };
  }

  const error = OpenSourceErrorResponseSchema.safeParse(body);
  if (error.success) {
    return { kind: "error", message: openSourceErrorMessage(error.data.error, res.status) };
  }

  return { kind: "error", message: `Unexpected response (${res.status})` };
}

function openSourceErrorMessage(error: OpenSourceErrorCode | undefined, status: number): string {
  switch (error) {
    case "not_found":
      return "Source not found";
    case "invalid":
      return "Could not open source";
    case "bad_token":
      return "Bad token — re-pair in Options";
    case "bad_origin":
    case "unpaired":
      return "Not paired — open Options";
    default:
      return error ? String(error) : `Open failed (${status})`;
  }
}

/**
 * Ask the paired desktop whether a page is already a saved source, by URL — the
 * read-only pre-save "already saved" hint the popup shows on open. Cloned from
 * {@link openCapturedSource} (same header set, status mapping, and `safeParse`
 * discipline) with two differences: it short-circuits non-http(s) urls without a
 * fetch (KTD3, client side), and it bounds a slow desktop with an
 * `AbortController` (R8) — an abort/timeout resolves to `errored` (no banner).
 *
 * POSITIVE-ONLY: a `{ kind: "ok", source: null }` answer is a hint, not a
 * guarantee that a subsequent save will not dedup; save-time stays authoritative.
 */
export async function lookupSource(url: string): Promise<LookupOutcome> {
  const cleanUrl = (url ?? "").trim();
  // Short-circuit non-http(s) / empty urls — no useful round-trip (KTD3).
  if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) return { kind: "not-applicable" };

  const { token, port } = await readPairedConfig();
  if (!token) return { kind: "not-paired" };

  const request: LookupSourceRequest = { url: cleanUrl };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  // Clear the timer in a `finally` that runs AFTER the body is read (R8): the
  // ~2.5s budget bounds the WHOLE round-trip (headers + body), not just
  // time-to-headers — a desktop that streams headers fast but stalls the body
  // is still aborted.
  try {
    let res: Response;
    try {
      res = await fetch(`${loopbackBase(port)}/lookup-source`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (err) {
      // An abort (the timeout fired) means the desktop is too slow → no banner.
      // Any other thrown fetch (connection refused) means the app is not running.
      if (err instanceof DOMException && err.name === "AbortError") return { kind: "errored" };
      return { kind: "not-running" };
    }

    if (res.status === 401) return { kind: "bad-token" };
    if (res.status === 403) return { kind: "not-paired" };

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: "errored" };
    }

    // The response is a discriminated union on `found`: a successful parse with
    // `found: true` GUARANTEES `source` is present (a `{ found: true }` body with no
    // source no longer parses → `errored`). `found: false` → no banner.
    const parsed = LookupSourceResponseSchema.safeParse(body);
    if (!parsed.success) return { kind: "errored" };
    if (parsed.data.found) {
      return { kind: "ok", source: parsed.data.source };
    }
    return { kind: "ok", source: null };
  } finally {
    clearTimeout(timer);
  }
}

/** One recent capture row (kept in chrome.storage for the side panel — T063). */
export interface RecentCapture {
  readonly id: string;
  readonly title: string;
  readonly kind: "page" | "selection";
  readonly timestamp: number;
}

const RECENT_CAP_MAX = 20;

/** Append a successful capture to the bounded `recentCaptures` list. */
export async function recordRecentCapture(entry: RecentCapture): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.recentCaptures);
  const list: RecentCapture[] = Array.isArray(stored[STORAGE_KEYS.recentCaptures])
    ? (stored[STORAGE_KEYS.recentCaptures] as RecentCapture[])
    : [];
  const next = [entry, ...list].slice(0, RECENT_CAP_MAX);
  await chrome.storage.local.set({ [STORAGE_KEYS.recentCaptures]: next });
}

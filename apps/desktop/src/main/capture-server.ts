/**
 * Loopback capture server (T062) — the ONLY new local network surface.
 *
 * A minimal Node `http` server (no Express — two routes) mounted in the Electron
 * MAIN at `app.whenReady`, through which the browser extension delivers captures.
 * It is the seam between an untrusted browser extension and the trusted M12 import
 * service; everything that makes it safe is the threat model below.
 *
 * THREAT MODEL (all enforced):
 *   - **Bind `127.0.0.1` ONLY** (never `0.0.0.0`) so no other machine on the LAN
 *     can reach it; additionally reject any request whose socket `remoteAddress`
 *     is not loopback (defense in depth).
 *   - **Per-install token** (constant-time compare) on every `/capture` request.
 *   - **Exact-Origin CORS**, locked to the paired extension origin learned via the
 *     pairing handshake (`POST /pair`); never `*`.
 *   - **POST-only** narrow `/capture` + **GET-only** `/ping`; everything else 405.
 *   - **Zod-validated** payloads (in the pure `capture-handler`).
 *   - **Hard body-size cap** — the read aborts past the cap (no unbounded buffer).
 *   - **Off until paired** — `bootstrap()` only starts it when `capture.enabled`.
 *
 * PORT ORDERING (so `getPairing()` never reports an unbound port):
 *   1. BIND the socket FIRST (await `listening`, read the actual port).
 *   2. THEN persist the chosen port into settings (`capture.port`).
 *   3. THEN mark the server running (resolve `startCaptureServer`).
 * On stop/disable: mark not-running and CLEAR `capture.port` (→ null) so a stopped
 * server never advertises a stale port.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CaptureRequest, PairingPingResponse } from "@interleave/capture-contract";
import { CaptureRequestSchema, timingSafeTokenEqual } from "@interleave/capture-contract";
import type { PriorityLabel } from "@interleave/core";
import type { SettingsRepository } from "@interleave/local-db";
import {
  type CaptureImportResult,
  type CaptureImportService,
  handleCapture,
} from "./capture-handler";
import {
  clearCapturePort,
  getAllowedOrigin,
  getOrCreateCaptureToken,
  setAllowedOrigin,
  setCapturePort,
} from "./capture-pairing";

/** The canonical loopback port; a small fallback scan handles a stray holder. */
const CANONICAL_PORT = 47615;
const PORT_FALLBACK_COUNT = 8;
/** Hard request-body cap (bytes). The read aborts the moment this is exceeded. */
const MAX_BODY_BYTES = 6 * 1024 * 1024;

/** The full import-service surface the server needs (page + selection). */
export interface CaptureServerImportService extends CaptureImportService {
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

/** Options for {@link startCaptureServer}. */
export interface StartCaptureServerOptions {
  /** The raw settings repository (the `capture.*` key/value path). */
  readonly settings: SettingsRepository;
  /** The single shared M12 import service instance (page + selection). */
  readonly importService: CaptureServerImportService;
  /** The app version, surfaced in the unauthenticated `/ping` body. */
  readonly appVersion: string;
}

/** The running server handle. */
export interface CaptureServerHandle {
  /** The actually-bound port (read off the socket). */
  readonly port: number;
  /** Stop the server and clear the recorded port. */
  stop(): Promise<void>;
}

/** Whether a socket remote address is loopback (IPv4 or IPv6). */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

/** Read the whole request body with a hard cap; returns `{ tooLarge: true }` past it. */
function readBody(req: IncomingMessage): Promise<{ body: string; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        // Stop reading and resolve as too-large (the handler maps this to 413).
        req.destroy();
        resolve({ body: "", tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      resolve({ body: Buffer.concat(chunks).toString("utf-8"), tooLarge: false });
    });
    req.on("error", (err) => {
      if (aborted) return;
      reject(err);
    });
  });
}

/** Write a JSON response with the given status. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** Apply the exact-Origin CORS headers (echo only the paired origin, never `*`). */
function applyCors(
  res: ServerResponse,
  allowedOrigin: string | null,
  requestOrigin: string | null,
): void {
  // Only echo the request origin when it exactly matches the paired one.
  if (allowedOrigin && requestOrigin && requestOrigin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Vary", "Origin");
  }
}

/**
 * Start the loopback capture server. Binds `127.0.0.1` FIRST, then persists the
 * port, then resolves with the running handle. Throws if no port in the fallback
 * range can be bound.
 */
export async function startCaptureServer(
  opts: StartCaptureServerOptions,
): Promise<CaptureServerHandle> {
  const { settings, importService, appVersion } = opts;
  let running = false;

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      console.error("[capture] request handler error:", error);
      try {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: "import_failed" });
      } catch {
        // ignore — the socket may already be gone.
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Defense in depth: reject any non-loopback remote address outright.
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.writeHead(403).end();
      return;
    }

    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const path = url.split("?")[0];
    const requestOrigin = headerValue(req, "origin");
    const allowedOrigin = getAllowedOrigin(settings);

    // GET /ping — unauthenticated health probe (reveals only app name + version).
    if (path === "/ping") {
      if (method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      const ping: PairingPingResponse = { ok: true, app: "interleave", version: appVersion };
      sendJson(res, 200, ping);
      return;
    }

    // POST /pair — the pairing handshake: a token-authenticated request that
    // teaches the desktop the extension's origin. Once stored, `/capture` opens.
    if (path === "/pair") {
      if (method === "OPTIONS") {
        applyCors(res, allowedOrigin, requestOrigin);
        res.writeHead(204).end();
        return;
      }
      if (method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      await handlePair(req, res, requestOrigin);
      return;
    }

    // POST /capture — the narrow capture endpoint (the real mutation).
    if (path === "/capture") {
      if (method === "OPTIONS") {
        applyCors(res, allowedOrigin, requestOrigin);
        res.writeHead(204).end();
        return;
      }
      if (method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      await handleCaptureRoute(req, res, requestOrigin, allowedOrigin);
      return;
    }

    // Everything else → 405 (no generic surface).
    res.writeHead(405).end();
  }

  /**
   * The pairing handshake. The options page POSTs `{ extensionOrigin }`
   * authenticated by the pasted token. On a valid token we store the origin so
   * `/capture` can lock CORS to it. The token must already exist (the desktop
   * minted it lazily when the user opened the pairing card); a wrong token → 401.
   */
  async function handlePair(
    req: IncomingMessage,
    res: ServerResponse,
    requestOrigin: string | null,
  ): Promise<void> {
    const token = getOrCreateCaptureToken(settings);
    const bearer = parseBearer(headerValue(req, "authorization"));
    if (!bearer || !timingSafeTokenEqual(bearer, token)) {
      sendJson(res, 401, { ok: false, error: "bad_token" });
      return;
    }
    const { body, tooLarge } = await readBody(req);
    if (tooLarge) {
      sendJson(res, 413, { ok: false, error: "too_large" });
      return;
    }
    let extensionOrigin: string | null = null;
    try {
      const json = JSON.parse(body) as { extensionOrigin?: unknown };
      if (typeof json.extensionOrigin === "string") extensionOrigin = json.extensionOrigin.trim();
    } catch {
      extensionOrigin = null;
    }
    // Accept the origin from the body, or fall back to the request Origin header.
    const origin = extensionOrigin || requestOrigin;
    // Real load-unpacked Chrome extension ids are exactly 32 lowercase letters in [a-p].
    if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      sendJson(res, 400, { ok: false, error: "invalid" });
      return;
    }
    setAllowedOrigin(settings, origin);
    // Echo CORS for the now-paired origin so the options-page fetch can read the body.
    applyCors(res, origin, requestOrigin);
    sendJson(res, 200, { ok: true, paired: true, origin });
  }

  /** The `/capture` route: read the body (capped), then run the pure handler. */
  async function handleCaptureRoute(
    req: IncomingMessage,
    res: ServerResponse,
    requestOrigin: string | null,
    allowedOrigin: string | null,
  ): Promise<void> {
    applyCors(res, allowedOrigin, requestOrigin);
    const { body, tooLarge } = await readBody(req);
    const result = await handleCapture(
      {
        body,
        authorization: headerValue(req, "authorization"),
        origin: requestOrigin,
        contentType: headerValue(req, "content-type"),
        tooLarge,
      },
      {
        getToken: () => settings.get<string>("capture.token"),
        getAllowedOrigin: () => getAllowedOrigin(settings),
        importService,
      },
    );
    sendJson(res, result.status, result.body);
  }

  // --- bind 127.0.0.1, scanning a small fallback range ----------------------
  const boundPort = await listenWithFallback(server, CANONICAL_PORT, PORT_FALLBACK_COUNT);

  // THEN persist the bound port, THEN mark running (strict ordering).
  setCapturePort(settings, boundPort);
  running = true;

  return {
    port: boundPort,
    async stop(): Promise<void> {
      if (!running) return;
      running = false;
      clearCapturePort(settings);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Bind 127.0.0.1 on the canonical port, scanning up to `count` fallbacks. */
function listenWithFallback(server: Server, start: number, count: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryPort = (port: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("error", onError);
        if (err.code === "EADDRINUSE" && attempt < count) {
          attempt += 1;
          tryPort(port + 1);
          return;
        }
        reject(err);
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        const address = server.address();
        const bound = typeof address === "object" && address ? address.port : port;
        resolve(bound);
      });
    };
    tryPort(start);
  });
}

/** Read a header value (lower-cased lookup), joining arrays. */
function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** Extract the bearer token from an `Authorization: Bearer <token>` header. */
function parseBearer(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() ?? null;
}

// Re-export the validated request type so callers need not reach into the contract.
export type { CaptureRequest };
export { CaptureRequestSchema };

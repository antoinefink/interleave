import { EventEmitter } from "node:events";
import type { SettingsRepository } from "@interleave/local-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_ALLOWED_ORIGIN_KEY, CAPTURE_PORT_KEY, CAPTURE_TOKEN_KEY } from "./capture-pairing";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

const httpMock = vi.hoisted(() => {
  let requestHandler: ((req: unknown, res: unknown) => void) | null = null;
  let boundPort = 0;
  const server = {
    listen: vi.fn((port: number, _host: string, callback: () => void) => {
      boundPort = port;
      callback();
      return server;
    }),
    once: vi.fn(),
    removeListener: vi.fn(),
    address: vi.fn(() => ({ port: boundPort })),
    close: vi.fn((callback: () => void) => callback()),
  };
  return {
    server,
    createServer: vi.fn((handler: (req: unknown, res: unknown) => void) => {
      requestHandler = handler;
      return server;
    }),
    handler: () => requestHandler,
  };
});

vi.mock("node:http", () => ({
  createServer: httpMock.createServer,
}));

import type { LookupSourceResponse } from "@interleave/capture-contract";
import {
  type CaptureOpenSourceInput,
  type CaptureOpenSourceResult,
  startCaptureServer,
} from "./capture-server";

class MemorySettings {
  readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | null {
    return this.values.has(key) ? (this.values.get(key) as T) : null;
  }

  getOr<T>(key: string, fallback: T): T {
    const value = this.get<T>(key);
    return value === null ? fallback : value;
  }

  set<T>(key: string, value: T): T {
    this.values.set(key, value);
    return value;
  }

  asRepository(): SettingsRepository {
    return this as unknown as SettingsRepository;
  }
}

function fakeImportService() {
  return {
    importFromHtml: vi.fn(async () => ({
      status: "imported" as const,
      id: "source-1",
      item: { title: "Captured page" },
    })),
    importSelection: vi.fn(async () => ({
      status: "imported" as const,
      id: "extract-1",
      item: { title: "Captured selection" },
    })),
  };
}

function makeReq(input: {
  readonly method: string;
  readonly url: string;
  readonly headers?: Record<string, string> | undefined;
  readonly body?: string | undefined;
  readonly remoteAddress?: string | undefined;
}) {
  const req = new EventEmitter() as EventEmitter & {
    method: string;
    url: string;
    headers: Record<string, string>;
    socket: { remoteAddress: string };
    destroy: () => void;
  };
  req.method = input.method;
  req.url = input.url;
  req.headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  req.socket = { remoteAddress: input.remoteAddress ?? "127.0.0.1" };
  req.destroy = () => req.emit("error", new Error("destroyed"));
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: new Map<string, string>(),
    headersSent: false,
    body: "",
    ended: false,
    setHeader(name: string, value: string) {
      res.headers.set(name.toLowerCase(), value);
      return res;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      res.headersSent = true;
      for (const [key, value] of Object.entries(headers ?? {})) {
        res.headers.set(key.toLowerCase(), value);
      }
      return res;
    },
    end(payload?: string) {
      res.ended = true;
      res.body = payload ?? "";
      return res;
    },
    json() {
      return JSON.parse(res.body) as unknown;
    },
  };
  return res;
}

async function tick() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function route(input: {
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly remoteAddress?: string;
}) {
  const handler = httpMock.handler();
  if (!handler) throw new Error("server handler was not registered");
  const req = makeReq({
    method: input.method,
    url: input.path,
    headers: input.headers,
    body: input.body,
    remoteAddress: input.remoteAddress,
  });
  const res = makeRes();
  handler(req, res);
  if (input.body !== undefined) req.emit("data", Buffer.from(input.body));
  req.emit("end");
  await tick();
  return res;
}

beforeEach(() => {
  httpMock.createServer.mockClear();
  httpMock.server.listen.mockClear();
  httpMock.server.once.mockClear();
  httpMock.server.removeListener.mockClear();
  httpMock.server.address.mockClear();
  httpMock.server.close.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function start(
  settings: MemorySettings,
  importService = fakeImportService(),
  openSource: (input: CaptureOpenSourceInput) => Promise<CaptureOpenSourceResult> = vi.fn(
    async () => ({ status: "opened" as const, activated: true }),
  ),
  lookupSourceByUrl: (url: string) => LookupSourceResponse = vi.fn(() => ({
    ok: true as const,
    found: false as const,
  })),
) {
  const handle = await startCaptureServer({
    settings: settings.asRepository(),
    importService,
    openSource,
    lookupSourceByUrl,
    appVersion: "0.2.0",
  });
  return { handle, importService, openSource, lookupSourceByUrl };
}

describe("startCaptureServer", () => {
  it("binds loopback, serves ping, persists the bound port, and clears it on stop", async () => {
    const settings = new MemorySettings();
    const started = await start(settings);

    const response = await route({ method: "GET", path: "/ping" });

    expect(httpMock.server.listen).toHaveBeenCalledWith(47615, "127.0.0.1", expect.any(Function));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      app: "interleave",
      version: "0.2.0",
    });
    expect(settings.values.get(CAPTURE_PORT_KEY)).toBe(started.handle.port);

    await started.handle.stop();
    expect(settings.values.get(CAPTURE_PORT_KEY)).toBeNull();
    expect(httpMock.server.close).toHaveBeenCalledOnce();
  });

  it("pairs an exact Chrome extension origin and then accepts authenticated page captures", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    const { importService } = await start(settings);

    const pair = await route({
      method: "POST",
      path: "/pair",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        Origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify({ extensionOrigin: EXTENSION_ORIGIN }),
    });

    expect(pair.statusCode).toBe(200);
    expect(pair.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
    expect(pair.json()).toEqual({ ok: true, paired: true, origin: EXTENSION_ORIGIN });
    expect(settings.values.get(CAPTURE_ALLOWED_ORIGIN_KEY)).toBe(EXTENSION_ORIGIN);

    const capture = await route({
      method: "POST",
      path: "/capture",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        Origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify({
        kind: "page",
        url: "https://example.com/a",
        html: "<article>captured</article>",
      }),
    });

    expect(capture.statusCode).toBe(200);
    expect(capture.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
    expect(capture.json()).toMatchObject({
      ok: true,
      id: "source-1",
      kind: "page",
      deduped: false,
    });
    expect(importService.importFromHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/a",
        html: "<article>captured</article>",
      }),
    );
  });

  it("rejects bad pairing tokens without storing an extension origin", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    await start(settings);

    const response = await route({
      method: "POST",
      path: "/pair",
      headers: {
        Authorization: "Bearer wrong",
        "Content-Type": "application/json",
        Origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify({ extensionOrigin: EXTENSION_ORIGIN }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, error: "bad_token" });
    expect(settings.values.has(CAPTURE_ALLOWED_ORIGIN_KEY)).toBe(false);
  });

  it("rejects non-loopback requests before routing", async () => {
    const settings = new MemorySettings();
    await start(settings);

    const response = await route({
      method: "GET",
      path: "/ping",
      remoteAddress: "192.168.0.10",
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe("");
  });

  it("opens a captured source through the authenticated loopback route", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
    const { openSource } = await start(settings);

    const response = await route({
      method: "POST",
      path: "/open-source",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        Origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify({ id: "source-1" }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
    expect(response.json()).toEqual({ ok: true, id: "source-1", activated: true });
    expect(openSource).toHaveBeenCalledWith({ id: "source-1", activate: true });
  });

  it("serves open-source preflight for the paired extension origin", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
    await start(settings);

    const response = await route({
      method: "OPTIONS",
      path: "/open-source",
      headers: { Origin: EXTENSION_ORIGIN },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type",
    );
  });

  it("propagates activate=false to the desktop opener", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
    const { openSource } = await start(settings);

    const response = await route({
      method: "POST",
      path: "/open-source",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        Origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify({ id: "source-1", activate: false }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, id: "source-1", activated: true });
    expect(openSource).toHaveBeenCalledWith({ id: "source-1", activate: false });
  });

  it("rejects open-source requests with the same pairing guards as capture", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
    const { openSource } = await start(settings);

    const response = await route({
      method: "POST",
      path: "/open-source",
      headers: {
        Authorization: "Bearer wrong",
        "Content-Type": "application/json",
        Origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify({ id: "source-1" }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, error: "bad_token" });
    expect(openSource).not.toHaveBeenCalled();
  });

  it("rejects unpaired, bad-origin, and invalid open-source requests before opening", async () => {
    const cases = [
      {
        name: "unpaired",
        setup: (_settings: MemorySettings) => undefined,
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          Origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify({ id: "source-1" }),
        status: 403,
        error: "unpaired",
      },
      {
        name: "bad origin",
        setup: (settings: MemorySettings) => {
          settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
          settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
        },
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          Origin: "chrome-extension://wrong",
        },
        body: JSON.stringify({ id: "source-1" }),
        status: 403,
        error: "bad_origin",
      },
      {
        name: "wrong content type",
        setup: (settings: MemorySettings) => {
          settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
          settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
        },
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "text/plain",
          Origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify({ id: "source-1" }),
        status: 400,
        error: "invalid",
      },
      {
        name: "invalid JSON",
        setup: (settings: MemorySettings) => {
          settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
          settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
        },
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          Origin: EXTENSION_ORIGIN,
        },
        body: "{",
        status: 400,
        error: "invalid",
      },
      {
        name: "invalid schema",
        setup: (settings: MemorySettings) => {
          settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
          settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
        },
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          Origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify({ id: "" }),
        status: 400,
        error: "invalid",
      },
      {
        name: "too large",
        setup: (settings: MemorySettings) => {
          settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
          settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
        },
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          Origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify({ id: "x".repeat(6 * 1024 * 1024) }),
        status: 413,
        error: "too_large",
      },
    ] as const;

    for (const c of cases) {
      const settings = new MemorySettings();
      c.setup(settings);
      const { openSource } = await start(settings);

      const response = await route({
        method: "POST",
        path: "/open-source",
        headers: c.headers,
        body: c.body,
      });

      expect(response.statusCode, c.name).toBe(c.status);
      expect(response.json(), c.name).toEqual({ ok: false, error: c.error });
      expect(openSource, c.name).not.toHaveBeenCalled();
    }
  });

  it("returns not_found when the desktop cannot open that source id", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
    await start(
      settings,
      fakeImportService(),
      vi.fn(async () => ({ status: "not_found" as const })),
    );

    const response = await route({
      method: "POST",
      path: "/open-source",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        Origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify({ id: "missing" }),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ ok: false, error: "not_found" });
  });

  it("maps desktop opener failures to the open-source error contract", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
    await start(
      settings,
      fakeImportService(),
      vi.fn(async () => {
        throw new Error("window failed");
      }),
    );

    const response = await route({
      method: "POST",
      path: "/open-source",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        Origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify({ id: "source-1" }),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "open_failed" });
  });

  it("answers a lookup-source request for a saved URL through the authenticated route", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
    const lookup = vi.fn(
      (_url: string): LookupSourceResponse => ({
        ok: true,
        found: true,
        source: { id: "source-1", title: "Existing", status: "inbox" },
      }),
    );
    await start(settings, fakeImportService(), undefined, lookup);

    const response = await route({
      method: "POST",
      path: "/lookup-source",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        Origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify({ url: "https://example.com/a" }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
    expect(response.json()).toEqual({
      ok: true,
      found: true,
      source: { id: "source-1", title: "Existing", status: "inbox" },
    });
    expect(lookup).toHaveBeenCalledWith("https://example.com/a");
  });

  it("answers found:false for a never-saved URL", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
    const lookup = vi.fn((): LookupSourceResponse => ({ ok: true, found: false }));
    await start(settings, fakeImportService(), undefined, lookup);

    const response = await route({
      method: "POST",
      path: "/lookup-source",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        Origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify({ url: "https://example.com/never" }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, found: false });
  });

  it("answers found:false (NOT 400) for a non-http(s) URL in the body", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
    // The real lookup canonicalizes a non-http(s) URL to null → found:false. Mirror
    // that here so the test asserts the route does NOT 400 a permissive-but-odd URL.
    const lookup = vi.fn((): LookupSourceResponse => ({ ok: true, found: false }));
    await start(settings, fakeImportService(), undefined, lookup);

    const response = await route({
      method: "POST",
      path: "/lookup-source",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        Origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify({ url: "chrome://settings" }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, found: false });
    expect(lookup).toHaveBeenCalledWith("chrome://settings");
  });

  it("serves lookup-source preflight for the paired extension origin", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
    await start(settings);

    const response = await route({
      method: "OPTIONS",
      path: "/lookup-source",
      headers: { Origin: EXTENSION_ORIGIN },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type",
    );
  });

  it("rejects a GET on the lookup-source route (405)", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
    const { lookupSourceByUrl } = await start(settings);

    const response = await route({
      method: "GET",
      path: "/lookup-source",
      headers: { Origin: EXTENSION_ORIGIN },
    });

    expect(response.statusCode).toBe(405);
    expect(lookupSourceByUrl).not.toHaveBeenCalled();
  });

  it("enforces the same threat model as open-source on the lookup-source route", async () => {
    const cases = [
      {
        name: "unpaired",
        setup: (_settings: MemorySettings) => undefined,
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          Origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify({ url: "https://example.com/a" }),
        status: 403,
        error: "unpaired",
      },
      {
        name: "bad origin",
        setup: (settings: MemorySettings) => {
          settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
          settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
        },
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          Origin: "chrome-extension://wrong",
        },
        body: JSON.stringify({ url: "https://example.com/a" }),
        status: 403,
        error: "bad_origin",
      },
      {
        name: "bad token",
        setup: (settings: MemorySettings) => {
          settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
          settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
        },
        headers: {
          Authorization: "Bearer wrong",
          "Content-Type": "application/json",
          Origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify({ url: "https://example.com/a" }),
        status: 401,
        error: "bad_token",
      },
      {
        name: "wrong content type",
        setup: (settings: MemorySettings) => {
          settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
          settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
        },
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "text/plain",
          Origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify({ url: "https://example.com/a" }),
        status: 400,
        error: "invalid",
      },
      {
        name: "invalid JSON",
        setup: (settings: MemorySettings) => {
          settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
          settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
        },
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          Origin: EXTENSION_ORIGIN,
        },
        body: "{",
        status: 400,
        error: "invalid",
      },
      {
        name: "invalid schema (empty url)",
        setup: (settings: MemorySettings) => {
          settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
          settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
        },
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          Origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify({ url: "" }),
        status: 400,
        error: "invalid",
      },
      {
        name: "too large",
        setup: (settings: MemorySettings) => {
          settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
          settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
        },
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
          Origin: EXTENSION_ORIGIN,
        },
        body: JSON.stringify({ url: `https://x.com/${"a".repeat(6 * 1024 * 1024)}` }),
        status: 413,
        error: "too_large",
      },
    ] as const;

    for (const c of cases) {
      const settings = new MemorySettings();
      c.setup(settings);
      const lookup = vi.fn((): LookupSourceResponse => ({ ok: true, found: false }));
      await start(settings, fakeImportService(), undefined, lookup);

      const response = await route({
        method: "POST",
        path: "/lookup-source",
        headers: c.headers,
        body: c.body,
      });

      expect(response.statusCode, c.name).toBe(c.status);
      expect(response.json(), c.name).toEqual({ ok: false, error: c.error });
      expect(lookup, c.name).not.toHaveBeenCalled();
    }
  });

  it("maps an unexpected lookup failure to the lookup_failed error contract", async () => {
    const settings = new MemorySettings();
    settings.values.set(CAPTURE_TOKEN_KEY, "secret-token");
    settings.values.set(CAPTURE_ALLOWED_ORIGIN_KEY, EXTENSION_ORIGIN);
    const lookup = vi.fn((): LookupSourceResponse => {
      throw new Error("dedup query blew up");
    });
    await start(settings, fakeImportService(), undefined, lookup);

    const response = await route({
      method: "POST",
      path: "/lookup-source",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        Origin: EXTENSION_ORIGIN,
      },
      body: JSON.stringify({ url: "https://example.com/a" }),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, error: "lookup_failed" });
  });
});

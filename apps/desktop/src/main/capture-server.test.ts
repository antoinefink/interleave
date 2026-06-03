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

import { startCaptureServer } from "./capture-server";

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

async function start(settings: MemorySettings, importService = fakeImportService()) {
  const handle = await startCaptureServer({
    settings: settings.asRepository(),
    importService,
    appVersion: "0.2.0",
  });
  return { handle, importService };
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
});

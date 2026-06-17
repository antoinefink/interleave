import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CAPTURE_PORT,
  lookupSource,
  loopbackBase,
  openCapturedSource,
  STORAGE_KEYS,
} from "./shared";

const fetchMock = vi.fn();

function installChromeStorage(stored: Record<string, unknown>): void {
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async () => stored),
      },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extension shared constants", () => {
  it("pins the loopback capture defaults and storage keys used by every extension surface", () => {
    expect(DEFAULT_CAPTURE_PORT).toBe(47615);
    expect(loopbackBase(DEFAULT_CAPTURE_PORT)).toBe("http://127.0.0.1:47615");
    expect(STORAGE_KEYS).toEqual({
      token: "interleave.token",
      port: "interleave.port",
      recentCaptures: "interleave.recentCaptures",
    });
  });
});

describe("openCapturedSource", () => {
  it("posts an authenticated open-source request with activate enabled by default", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47616,
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, id: "src-1", activated: true }), { status: 200 }),
    );

    await expect(openCapturedSource(" src-1 ")).resolves.toEqual({
      kind: "ok",
      sourceId: "src-1",
    });

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:47616/open-source", {
      method: "POST",
      headers: {
        Authorization: "Bearer paired-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: "src-1", activate: true }),
    });
  });

  it("does not call loopback when the extension is not paired", async () => {
    installChromeStorage({ [STORAGE_KEYS.token]: null, [STORAGE_KEYS.port]: 47616 });

    await expect(openCapturedSource("src-1")).resolves.toEqual({ kind: "not-paired" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps loopback open-source auth and connectivity failures", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47615,
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 401 }));
    await expect(openCapturedSource("src-1")).resolves.toEqual({ kind: "bad-token" });

    fetchMock.mockRejectedValueOnce(new TypeError("connection refused"));
    await expect(openCapturedSource("src-1")).resolves.toEqual({ kind: "not-running" });
  });

  it("sends activate=false when requested", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47615,
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, id: "src-1", activated: false }), { status: 200 }),
    );

    await expect(openCapturedSource("src-1", { activate: false })).resolves.toEqual({
      kind: "ok",
      sourceId: "src-1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:47615/open-source",
      expect.objectContaining({
        body: JSON.stringify({ id: "src-1", activate: false }),
      }),
    );
  });

  it("maps non-auth open-source failures through the shared error schema", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47615,
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 }),
    );

    await expect(openCapturedSource("src-1")).resolves.toEqual({
      kind: "error",
      message: "Source not found",
    });
  });

  it("rejects malformed open-source response bodies", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47615,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, activated: true }), { status: 200 }),
    );
    await expect(openCapturedSource("src-1")).resolves.toEqual({
      kind: "error",
      message: "Unexpected response (200)",
    });

    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 500 }));
    await expect(openCapturedSource("src-1")).resolves.toEqual({
      kind: "error",
      message: "Unexpected response (500)",
    });
  });
});

describe("lookupSource", () => {
  it("returns the matched source when the desktop reports found", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47616,
    });
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          found: true,
          source: { id: "src-9", title: "Saved article", status: "inbox" },
        }),
        { status: 200 },
      ),
    );

    await expect(lookupSource("https://example.com/articles/one")).resolves.toEqual({
      kind: "ok",
      source: { id: "src-9", title: "Saved article", status: "inbox" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:47616/lookup-source",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer paired-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: "https://example.com/articles/one" }),
      }),
    );
  });

  it("returns errored when found:true arrives without a source (the union rejects it)", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47615,
    });
    // A `{ ok:true, found:true }` with no source must NOT be silently read as "not
    // found": the discriminated-union schema rejects it → errored (no banner).
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, found: true }), { status: 200 }),
    );

    await expect(lookupSource("https://example.com/one")).resolves.toEqual({
      kind: "errored",
    });
  });

  it("returns a null source when the desktop reports not found", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47615,
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, found: false }), { status: 200 }),
    );

    await expect(lookupSource("https://example.com/never-saved")).resolves.toEqual({
      kind: "ok",
      source: null,
    });
  });

  it("short-circuits non-http(s) and empty urls without fetching", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47615,
    });

    await expect(lookupSource("chrome://extensions")).resolves.toEqual({
      kind: "not-applicable",
    });
    await expect(lookupSource("file:///Users/me/doc.pdf")).resolves.toEqual({
      kind: "not-applicable",
    });
    await expect(lookupSource("")).resolves.toEqual({ kind: "not-applicable" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when the extension is not paired", async () => {
    installChromeStorage({ [STORAGE_KEYS.token]: null, [STORAGE_KEYS.port]: 47615 });

    await expect(lookupSource("https://example.com/one")).resolves.toEqual({
      kind: "not-paired",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps loopback auth failures", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47615,
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 401 }));
    await expect(lookupSource("https://example.com/one")).resolves.toEqual({
      kind: "bad-token",
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 403 }));
    await expect(lookupSource("https://example.com/one")).resolves.toEqual({
      kind: "not-paired",
    });
  });

  it("maps a refused connection to not-running", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47615,
    });
    fetchMock.mockRejectedValueOnce(new TypeError("connection refused"));

    await expect(lookupSource("https://example.com/one")).resolves.toEqual({
      kind: "not-running",
    });
  });

  it("aborts a never-resolving fetch at the timeout and returns errored", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47615,
    });
    // Honor the AbortController: reject with an AbortError when the signal fires.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    vi.useFakeTimers();
    try {
      const pending = lookupSource("https://example.com/slow");
      await vi.advanceTimersByTimeAsync(2500);
      await expect(pending).resolves.toEqual({ kind: "errored" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns errored for non-JSON and schema-mismatched bodies", async () => {
    installChromeStorage({
      [STORAGE_KEYS.token]: "paired-token",
      [STORAGE_KEYS.port]: 47615,
    });

    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    await expect(lookupSource("https://example.com/one")).resolves.toEqual({
      kind: "errored",
    });

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, found: "yes" }), { status: 200 }),
    );
    await expect(lookupSource("https://example.com/one")).resolves.toEqual({
      kind: "errored",
    });
  });
});

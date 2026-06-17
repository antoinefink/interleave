import type { SettingsRepository } from "@interleave/local-db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_ENABLED_KEY, CAPTURE_TOKEN_KEY } from "./capture-pairing";

const startCaptureServer = vi.fn();

vi.mock("./capture-server", () => ({
  startCaptureServer: (...args: unknown[]) => startCaptureServer(...args),
}));

import { CaptureController } from "./capture-controller";

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

beforeEach(() => {
  startCaptureServer.mockReset();
});

function makeController(settings = new MemorySettings()) {
  const importService = { importFromHtml: vi.fn(), importSelection: vi.fn() };
  const openSource = vi.fn(async () => ({ status: "opened" as const, activated: true }));
  const lookupSourceByUrl = vi.fn(() => ({ ok: true as const, found: false as const }));
  const stop = vi.fn(async () => {});
  startCaptureServer.mockResolvedValue({ port: 47615, stop });

  const controller = new CaptureController({
    settings: settings.asRepository(),
    getImportService: () => importService as never,
    openSource,
    lookupSourceByUrl,
    appVersion: "0.2.0",
  });

  return { controller, settings, importService, openSource, lookupSourceByUrl, stop };
}

describe("CaptureController", () => {
  it("does not start the loopback server while capture is disabled", async () => {
    const { controller } = makeController();

    await controller.startIfEnabled();

    expect(startCaptureServer).not.toHaveBeenCalled();
    expect(controller.getPairing()).toMatchObject({ enabled: false, running: false, port: null });
  });

  it("starts at most once when capture is enabled", async () => {
    const { controller, settings, importService, openSource, lookupSourceByUrl } = makeController();
    settings.values.set(CAPTURE_ENABLED_KEY, true);

    await controller.startIfEnabled();
    await controller.startIfEnabled();

    expect(startCaptureServer).toHaveBeenCalledTimes(1);
    expect(startCaptureServer).toHaveBeenCalledWith({
      settings: settings.asRepository(),
      importService,
      openSource,
      lookupSourceByUrl,
      appVersion: "0.2.0",
    });
    expect(controller.getPairing()).toMatchObject({ enabled: true, running: true, port: 47615 });
  });

  it("setEnabled(true) persists the flag, mints a token, and starts the server", async () => {
    const { controller, settings } = makeController();

    const pairing = await controller.setEnabled(true);

    expect(settings.values.get(CAPTURE_ENABLED_KEY)).toBe(true);
    expect(settings.values.get(CAPTURE_TOKEN_KEY)).toEqual(expect.any(String));
    expect(startCaptureServer).toHaveBeenCalledTimes(1);
    expect(pairing).toMatchObject({ enabled: true, running: true, port: 47615 });
  });

  it("setEnabled(false) stops the live handle and reports a stopped pairing", async () => {
    const { controller, settings, stop } = makeController();
    await controller.setEnabled(true);

    const pairing = await controller.setEnabled(false);

    expect(settings.values.get(CAPTURE_ENABLED_KEY)).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(pairing).toMatchObject({ enabled: false, running: false, port: null });
  });

  it("regenerateToken rotates the token without starting the server", () => {
    const { controller, settings } = makeController();
    const first = controller.getPairing().token;

    const next = controller.regenerateToken();

    expect(next).not.toBe(first);
    expect(settings.values.get(CAPTURE_TOKEN_KEY)).toBe(next);
    expect(startCaptureServer).not.toHaveBeenCalled();
  });
});

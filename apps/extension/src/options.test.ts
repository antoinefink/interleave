// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairWithApp, pingApp, writePairedConfig } from "./shared";

const h = vi.hoisted(() => ({
  readPairedConfig: vi.fn(),
  writePairedConfig: vi.fn(),
  pingApp: vi.fn(),
  pairWithApp: vi.fn(),
}));

vi.mock("./shared", async () => {
  const actual = await vi.importActual<typeof import("./shared")>("./shared");
  return {
    ...actual,
    readPairedConfig: h.readPairedConfig,
    writePairedConfig: h.writePairedConfig,
    pingApp: h.pingApp,
    pairWithApp: h.pairWithApp,
  };
});

function installDom() {
  document.body.innerHTML = `
    <input id="token" />
    <input id="port" />
    <button id="save"></button>
    <span id="status" hidden></span>
  `;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  installDom();
  h.readPairedConfig.mockResolvedValue({ token: "saved-token", port: 47616 });
  h.writePairedConfig.mockResolvedValue(undefined);
  h.pingApp.mockResolvedValue(true);
  h.pairWithApp.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importOptions() {
  await import("./options");
}

describe("extension options page", () => {
  it("loads the paired token and port into the form", async () => {
    await importOptions();

    await vi.waitFor(() =>
      expect((document.getElementById("token") as HTMLInputElement).value).toBe("saved-token"),
    );
    expect((document.getElementById("port") as HTMLInputElement).value).toBe("47616");
  });

  it("warns before saving when the token is missing", async () => {
    h.readPairedConfig.mockResolvedValue({ token: null, port: 47615 });
    await importOptions();
    await vi.waitFor(() =>
      expect((document.getElementById("port") as HTMLInputElement).value).toBe("47615"),
    );

    (document.getElementById("save") as HTMLButtonElement).click();

    expect(writePairedConfig).not.toHaveBeenCalled();
    expect(document.getElementById("status")?.textContent).toContain("Paste the token");
    expect(document.getElementById("status")?.className).toBe("status warn");
  });

  it("persists pairing, pings the app, pairs the extension origin, and reports success", async () => {
    await importOptions();
    await vi.waitFor(() =>
      expect((document.getElementById("token") as HTMLInputElement).value).toBe("saved-token"),
    );

    (document.getElementById("token") as HTMLInputElement).value = "new-token";
    (document.getElementById("port") as HTMLInputElement).value = "47619";
    (document.getElementById("save") as HTMLButtonElement).click();

    await vi.waitFor(() => expect(writePairedConfig).toHaveBeenCalledWith("new-token", 47619));
    expect(pingApp).toHaveBeenCalledWith(47619);
    await vi.waitFor(() => expect(pairWithApp).toHaveBeenCalledWith("new-token", 47619));
    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toContain("Paired"),
    );
    expect(document.getElementById("status")?.className).toBe("status ok");
  });
});

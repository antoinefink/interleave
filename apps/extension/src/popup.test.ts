// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessage = vi.fn();
const openOptionsPage = vi.fn();

function installChromeMock() {
  vi.stubGlobal("chrome", {
    tabs: {
      query: vi.fn(async () => [{ id: 5, title: "Current article", url: "https://example.com" }]),
    },
    runtime: {
      lastError: null,
      sendMessage,
      openOptionsPage,
    },
    sidePanel: {
      open: vi.fn(async () => undefined),
    },
  });
}

function installDom() {
  document.body.innerHTML = `
    <p id="page-title"></p>
    <div id="result"></div>
    <button id="save-page"></button>
    <button id="save-inbox"></button>
    <button id="save-selection"></button>
    <button id="open-options"></button>
    <button id="open-panel"></button>
  `;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  installDom();
  installChromeMock();
  sendMessage.mockImplementation((_message, cb) => {
    cb({ kind: "ok", response: { title: "Saved article", deduped: false } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extension popup", () => {
  it("shows the active tab title and dispatches popup save messages", async () => {
    await import("./popup");

    await vi.waitFor(() =>
      expect(document.getElementById("page-title")?.textContent).toContain("Current article"),
    );

    (document.getElementById("save-selection") as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledWith({ type: "save-selection" }, expect.any(Function));
    await vi.waitFor(() =>
      expect(document.getElementById("result")?.textContent).toContain("Saved article"),
    );
    expect(document.querySelector("#result .status.ok")).not.toBeNull();
  });

  it("opens the options page from the popup", async () => {
    await import("./popup");

    (document.getElementById("open-options") as HTMLButtonElement).click();

    expect(openOptionsPage).toHaveBeenCalledOnce();
  });
});

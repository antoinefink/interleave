import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordRecentCapture, sendCapture } from "./shared";

const h = vi.hoisted(() => ({
  sendCapture: vi.fn(),
  recordRecentCapture: vi.fn(),
}));

vi.mock("./shared", async () => {
  const actual = await vi.importActual<typeof import("./shared")>("./shared");
  return {
    ...actual,
    sendCapture: h.sendCapture,
    recordRecentCapture: h.recordRecentCapture,
  };
});

interface ChromeListeners {
  onInstalled: (() => void) | undefined;
  onClicked:
    | ((info: { menuItemId: string; selectionText?: string }, tab?: { id?: number }) => void)
    | undefined;
  onCommand: ((command: string) => void) | undefined;
  onMessage:
    | ((
        message: {
          type: "save-page" | "save-selection";
          priority?: "A" | "B" | "C" | "D";
          reason?: string;
        },
        sender: unknown,
        sendResponse: (response: unknown) => void,
      ) => true)
    | undefined;
}

const listeners: ChromeListeners = {
  onInstalled: undefined,
  onClicked: undefined,
  onCommand: undefined,
  onMessage: undefined,
};

function installChromeMock() {
  listeners.onInstalled = undefined;
  listeners.onClicked = undefined;
  listeners.onCommand = undefined;
  listeners.onMessage = undefined;

  vi.stubGlobal("chrome", {
    runtime: {
      onInstalled: { addListener: vi.fn((fn) => (listeners.onInstalled = fn)) },
      onMessage: { addListener: vi.fn((fn) => (listeners.onMessage = fn)) },
    },
    contextMenus: {
      removeAll: vi.fn((cb) => cb()),
      create: vi.fn(),
      onClicked: { addListener: vi.fn((fn) => (listeners.onClicked = fn)) },
    },
    commands: { onCommand: { addListener: vi.fn((fn) => (listeners.onCommand = fn)) } },
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: "https://example.com/a", title: "Tab title" }]),
    },
    scripting: {
      executeScript: vi.fn(async () => [
        {
          result: {
            url: "https://example.com/canonical",
            title: "Canonical title",
            html: "<html><body>Article</body></html>",
          },
        },
      ]),
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
    notifications: { create: vi.fn() },
    sidePanel: {
      setPanelBehavior: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.clearAllMocks();
  h.sendCapture.mockResolvedValue({
    kind: "ok",
    response: { ok: true, id: "src-1", kind: "page", title: "Saved title", deduped: false },
  });
  h.recordRecentCapture.mockResolvedValue(undefined);
  installChromeMock();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function importBackground() {
  await import("./background");
  return chrome as typeof chrome & {
    contextMenus: typeof chrome.contextMenus & { create: ReturnType<typeof vi.fn> };
    action: typeof chrome.action & {
      setBadgeText: ReturnType<typeof vi.fn>;
      setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
    };
    notifications: typeof chrome.notifications & { create: ReturnType<typeof vi.fn> };
  };
}

describe("extension background worker", () => {
  it("registers context menus and disables side-panel action-click behavior on install", async () => {
    const chromeMock = await importBackground();

    listeners.onInstalled?.();

    expect(chromeMock.contextMenus.create).toHaveBeenCalledWith({
      id: "interleave-save-page",
      title: "Save page to Interleave",
      contexts: ["page"],
    });
    expect(chromeMock.contextMenus.create).toHaveBeenCalledWith({
      id: "interleave-save-selection",
      title: "Save selection to Interleave",
      contexts: ["selection"],
    });
    expect(chrome.sidePanel?.setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: false,
    });
  });

  it("saves the active page through the loopback capture path and records recent captures", async () => {
    const chromeMock = await importBackground();
    const response = new Promise((resolve) => {
      const keptOpen = listeners.onMessage?.(
        { type: "save-page", priority: "B", reason: "Worth reading" },
        {},
        resolve,
      );
      expect(keptOpen).toBe(true);
    });

    await expect(response).resolves.toMatchObject({ kind: "ok" });
    expect(sendCapture).toHaveBeenCalledWith({
      kind: "page",
      url: "https://example.com/canonical",
      title: "Canonical title",
      html: "<html><body>Article</body></html>",
      priority: "B",
      reason: "Worth reading",
    });
    expect(recordRecentCapture).toHaveBeenCalledWith({
      id: "src-1",
      title: "Saved title",
      kind: "page",
      timestamp: expect.any(Number),
    });
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "✓" });
    expect(chromeMock.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#2e7d32" });
    expect(chromeMock.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Interleave", message: "Saved: Saved title" }),
    );

    vi.advanceTimersByTime(4000);
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: "" });
  });
});

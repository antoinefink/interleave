// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupOutcome, OpenSourceOutcome } from "./shared";

const sendMessage = vi.fn();
const openOptionsPage = vi.fn();
const queryTabs = vi.fn();
const executeScript = vi.fn();
type OpenCapturedSource = (
  sourceId: string,
  options?: { readonly activate?: boolean },
) => Promise<OpenSourceOutcome>;
type LookupSource = (url: string) => Promise<LookupOutcome>;

const h = vi.hoisted(() => ({
  openCapturedSource: vi.fn<OpenCapturedSource>(),
  readPairedConfig: vi.fn(),
  pingApp: vi.fn(),
  lookupSource: vi.fn<LookupSource>(),
}));

vi.mock("./shared", async () => {
  const actual = await vi.importActual<typeof import("./shared")>("./shared");
  return {
    ...actual,
    openCapturedSource: h.openCapturedSource,
    readPairedConfig: h.readPairedConfig,
    pingApp: h.pingApp,
    lookupSource: h.lookupSource,
  };
});

function installChromeMock(selection = "Important selected passage") {
  queryTabs.mockResolvedValue([
    { id: 5, title: "Current article", url: "https://example.com/articles/one" },
  ]);
  executeScript.mockResolvedValue([
    { result: { selection, url: "https://example.com/articles/one" } },
  ]);
  vi.stubGlobal("chrome", {
    tabs: {
      query: queryTabs,
    },
    scripting: {
      executeScript,
    },
    runtime: {
      lastError: null,
      sendMessage,
      openOptionsPage,
    },
  });
}

function installDom() {
  document.body.innerHTML = `
    <div class="popup-shell" role="dialog" aria-label="Save to Interleave">
      <span id="connection-pill"></span>
      <main id="popup-body"></main>
      <button id="open-options" type="button"></button>
    </div>
  `;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  installDom();
  installChromeMock();
  h.openCapturedSource.mockResolvedValue({ kind: "ok", sourceId: "src-1" });
  h.readPairedConfig.mockResolvedValue({ token: "token", port: 47615 });
  h.pingApp.mockResolvedValue(true);
  h.lookupSource.mockResolvedValue({ kind: "ok", source: null });
  sendMessage.mockImplementation((_message, cb) => {
    cb({
      kind: "ok",
      response: {
        ok: true,
        id: "src-1",
        kind: "selection",
        title: "Saved article",
        deduped: false,
      },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extension popup", () => {
  it("shows active tab context, selected text, connected state, and default priority", async () => {
    await import("./popup");

    await vi.waitFor(() =>
      expect(document.querySelector(".page-title")?.textContent).toContain("Current article"),
    );
    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("Connected"),
    );

    expect(document.querySelector(".selection-preview")?.textContent).toContain(
      "Important selected passage",
    );
    expect(document.querySelector('[data-priority="C"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.body.textContent).not.toContain("Save to inbox");
    expect(document.body.textContent).not.toContain("Open side panel");
  });

  it("sends the selected priority with selection saves", async () => {
    await import("./popup");
    await vi.waitFor(() => expect(document.querySelector('[data-priority="A"]')).not.toBeNull());

    (document.querySelector('[data-priority="A"]') as HTMLButtonElement).click();
    (document.getElementById("save-selection") as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledWith(
      {
        type: "save-selection",
        priority: "A",
        selection: "Important selected passage",
      },
      expect.any(Function),
    );
    await vi.waitFor(() =>
      expect(document.querySelector(".done-title")?.textContent).toBe("Extract saved"),
    );
    expect(document.querySelector(".badge-prio")?.textContent).toContain("A");
  });

  it("uses save-time priority for slow selection saves", async () => {
    let respond: ((outcome: unknown) => void) | undefined;
    sendMessage.mockImplementation((_message, cb) => {
      respond = cb;
    });
    await import("./popup");
    await vi.waitFor(() => expect(document.querySelector('[data-priority="D"]')).not.toBeNull());

    (document.querySelector('[data-priority="D"]') as HTMLButtonElement).click();
    (document.getElementById("save-selection") as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledWith(
      {
        type: "save-selection",
        priority: "D",
        selection: "Important selected passage",
      },
      expect.any(Function),
    );
    expect((document.querySelector('[data-priority="A"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    (document.querySelector('[data-priority="A"]') as HTMLButtonElement).click();

    respond?.({
      kind: "ok",
      response: {
        ok: true,
        id: "src-1",
        kind: "selection",
        title: "Saved article",
        deduped: false,
      },
    });

    await vi.waitFor(() =>
      expect(document.querySelector(".done-title")?.textContent).toBe("Extract saved"),
    );
    expect(document.querySelector(".badge-prio")?.textContent).toContain("D");
  });

  it("falls back to a page-only layout when there is no current selection", async () => {
    installDom();
    installChromeMock("");
    await import("./popup");

    await vi.waitFor(() => expect(document.querySelector(".selection-empty")).not.toBeNull());
    expect(document.getElementById("save-selection")).toBeNull();

    (document.getElementById("save-page") as HTMLButtonElement).click();

    expect(sendMessage).toHaveBeenCalledWith(
      { type: "save-page", priority: "C" },
      expect.any(Function),
    );
  });

  it("renders an open action after capture success and opens the captured source", async () => {
    await import("./popup");

    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());
    (document.getElementById("save-selection") as HTMLButtonElement).click();

    const open = await vi.waitFor(() => {
      const button = document.getElementById("open-source") as HTMLButtonElement | null;
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });

    open.click();

    await vi.waitFor(() =>
      expect(h.openCapturedSource).toHaveBeenCalledWith("src-1", { activate: true }),
    );
    await vi.waitFor(() => expect(open.textContent).toBe("Opened in Interleave"));
  });

  it("renders duplicate captures as already saved", async () => {
    sendMessage.mockImplementation((_message, cb) => {
      cb({
        kind: "ok",
        response: {
          ok: true,
          id: "existing-1",
          kind: "page",
          title: "Saved article",
          deduped: true,
        },
      });
    });
    await import("./popup");

    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());
    (document.getElementById("save-page") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.querySelector(".done-title")?.textContent).toContain("Already saved"),
    );
    (document.getElementById("open-source") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(h.openCapturedSource).toHaveBeenCalledWith("existing-1", { activate: true }),
    );
  });

  it("renders not-paired and opens the options page", async () => {
    h.readPairedConfig.mockResolvedValue({ token: null, port: 47615 });
    await import("./popup");

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("Not paired"),
    );
    expect(document.body.textContent).toContain("Extension not paired");

    (document.getElementById("pair-options") as HTMLButtonElement).click();
    expect(openOptionsPage).toHaveBeenCalledOnce();
  });

  it("renders app-offline state and can retry the connection", async () => {
    h.pingApp.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await import("./popup");

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("App offline"),
    );

    (document.getElementById("retry-connection") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("Connected"),
    );
  });

  it("runs the lookup after a successful retry from an offline start", async () => {
    installDom();
    installChromeMock("");
    // Start offline (first ping fails), then come online on retry. The lookup must
    // fire after the retry succeeds (R1) — not only on the initial connect.
    h.pingApp.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    h.lookupSource.mockResolvedValue({
      kind: "ok",
      source: { id: "existing-7", title: "Existing source", status: "inbox" },
    });
    await import("./popup");

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("App offline"),
    );
    // No lookup yet while offline.
    expect(h.lookupSource).not.toHaveBeenCalled();

    (document.getElementById("retry-connection") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("Connected"),
    );
    // The retry triggered the lookup, and the already-saved banner now renders.
    await vi.waitFor(() =>
      expect(h.lookupSource).toHaveBeenCalledWith("https://example.com/articles/one"),
    );
    await vi.waitFor(() =>
      expect(document.querySelector(".banner--info")?.textContent).toContain("Already saved"),
    );
  });

  it("renders app-offline state when the app disappears during save", async () => {
    sendMessage.mockImplementation((_message, cb) => {
      cb({ kind: "not-running" });
    });
    await import("./popup");
    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());

    (document.getElementById("save-selection") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("App offline"),
    );
    expect(document.body.textContent).toContain("Interleave is not reachable");
  });

  it("maps a bad token save outcome to the unpaired setup state", async () => {
    sendMessage.mockImplementation((_message, cb) => {
      cb({ kind: "bad-token" });
    });
    await import("./popup");
    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());

    (document.getElementById("save-selection") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("Not paired"),
    );
    expect(document.body.textContent).toContain("Extension not paired");
  });

  it("renders open-source failures without leaving the button disabled", async () => {
    h.openCapturedSource.mockResolvedValueOnce({ kind: "bad-token" });
    await import("./popup");
    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());

    (document.getElementById("save-selection") as HTMLButtonElement).click();
    const open = await vi.waitFor(() => {
      const button = document.getElementById("open-source") as HTMLButtonElement | null;
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });

    open.click();

    await vi.waitFor(() =>
      expect(document.getElementById("save-result")?.textContent).toContain("Bad token"),
    );
    expect(open.disabled).toBe(false);
    expect(open.textContent).toContain("Open in Interleave");
  });

  it("ignores stale open-source results after the saved view is dismissed", async () => {
    let resolveOpen: ((outcome: OpenSourceOutcome) => void) | undefined;
    h.openCapturedSource.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );
    await import("./popup");
    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());

    (document.getElementById("save-selection") as HTMLButtonElement).click();
    const open = await vi.waitFor(() => {
      const button = document.getElementById("open-source") as HTMLButtonElement | null;
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });
    open.click();
    (document.getElementById("save-another") as HTMLButtonElement).click();

    resolveOpen?.({ kind: "bad-token" });

    await vi.waitFor(() => expect(document.getElementById("save-selection")).not.toBeNull());
    expect(document.getElementById("save-result")?.textContent).not.toContain("Bad token");
  });

  it("opens the options page from the footer", async () => {
    await import("./popup");

    (document.getElementById("open-options") as HTMLButtonElement).click();

    expect(openOptionsPage).toHaveBeenCalledOnce();
  });

  it("shows an already-saved banner with Open in Interleave on a found page", async () => {
    installDom();
    installChromeMock("");
    h.lookupSource.mockResolvedValue({
      kind: "ok",
      source: { id: "existing-7", title: "Existing source", status: "inbox" },
    });
    await import("./popup");

    await vi.waitFor(() =>
      expect(document.querySelector(".banner--info")?.textContent).toContain("Already saved"),
    );
    expect(document.querySelector(".banner--info")?.textContent).toContain("Existing source");
    expect(document.getElementById("open-source")).not.toBeNull();
    // The page-save button is demoted to a secondary "Save anyway" affordance.
    expect(document.getElementById("save-page")?.textContent).toContain("Save anyway");
    expect(h.lookupSource).toHaveBeenCalledWith("https://example.com/articles/one");
  });

  it("opens the matched source without activating it (activate:false)", async () => {
    installDom();
    installChromeMock("");
    h.lookupSource.mockResolvedValue({
      kind: "ok",
      source: { id: "existing-7", title: "Existing source", status: "inbox" },
    });
    await import("./popup");

    const open = await vi.waitFor(() => {
      const button = document.getElementById("open-source") as HTMLButtonElement | null;
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });
    open.click();

    await vi.waitFor(() =>
      expect(h.openCapturedSource).toHaveBeenCalledWith("existing-7", { activate: false }),
    );
  });

  it("looks up the ABSOLUTE canonical url the probe resolved (relative href stays out)", async () => {
    installDom();
    // The injected probe resolves the canonical `link.href` to an absolute url even
    // when the page's `<link rel=canonical href="/article/123">` is relative. Mirror
    // that resolved value here; the popup must hand the absolute url to the lookup
    // (a raw relative `/article/123` would fail the `^https?://` guard, no lookup).
    queryTabs.mockResolvedValue([
      { id: 5, title: "Current article", url: "https://example.com/articles/one" },
    ]);
    executeScript.mockResolvedValue([
      { result: { selection: "", url: "https://example.com/article/123" } },
    ]);
    h.lookupSource.mockResolvedValue({ kind: "ok", source: null });
    await import("./popup");

    await vi.waitFor(() =>
      expect(h.lookupSource).toHaveBeenCalledWith("https://example.com/article/123"),
    );
  });

  it("opens the matched source from the selection-present page note (activate:false)", async () => {
    // A selection IS present, so the page-saved NOTE (not the whole-page banner) shows
    // its own "Open page in Interleave" button (#open-source-page). Clicking it must
    // open without activating (KTD4 — browsing, not capturing).
    h.lookupSource.mockResolvedValue({
      kind: "ok",
      source: { id: "existing-7", title: "Existing source", status: "inbox" },
    });
    await import("./popup");

    const openNote = await vi.waitFor(() => {
      const button = document.getElementById("open-source-page") as HTMLButtonElement | null;
      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    });
    openNote.click();

    await vi.waitFor(() =>
      expect(h.openCapturedSource).toHaveBeenCalledWith("existing-7", { activate: false }),
    );
  });

  it("clears the already-saved banner when the user picks Save another", async () => {
    installDom();
    installChromeMock("");
    h.lookupSource.mockResolvedValue({
      kind: "ok",
      source: { id: "existing-7", title: "Existing source", status: "inbox" },
    });
    await import("./popup");

    // The whole-page already-saved banner renders first (no selection).
    await vi.waitFor(() => expect(document.querySelector(".banner--info")).not.toBeNull());

    // Save anyway, then choose "Save another" from the saved view.
    (document.getElementById("save-page") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.getElementById("save-another")).not.toBeNull());
    (document.getElementById("save-another") as HTMLButtonElement).click();

    // Back on a CLEAN idle view: the demoted banner + "Save anyway" layout are gone.
    await vi.waitFor(() => expect(document.getElementById("save-page")).not.toBeNull());
    expect(document.querySelector(".banner--info")).toBeNull();
    expect(document.getElementById("save-page")?.textContent).toContain("Save page");
    expect(document.getElementById("save-page")?.textContent).not.toContain("Save anyway");
  });

  it("keeps Save selection primary and shows only a page note when a selection is present", async () => {
    h.lookupSource.mockResolvedValue({
      kind: "ok",
      source: { id: "existing-7", title: "Existing source", status: "inbox" },
    });
    await import("./popup");

    await vi.waitFor(() => expect(document.querySelector(".page-saved-note")).not.toBeNull());
    expect(document.querySelector(".page-saved-note")?.textContent).toContain(
      "This page is already saved",
    );
    // No whole-page "already saved" banner when a selection is the primary action.
    expect(document.querySelector(".banner--info")).toBeNull();
    const saveSelection = document.getElementById("save-selection") as HTMLButtonElement;
    expect(saveSelection).not.toBeNull();
    expect(saveSelection.classList.contains("btn--primary")).toBe(true);
    expect(saveSelection.disabled).toBe(false);
    expect(saveSelection.textContent).toContain("Save selection");
    expect(saveSelection.textContent).not.toContain("anyway");
  });

  it("shows no banner when the lookup finds nothing", async () => {
    installDom();
    installChromeMock("");
    h.lookupSource.mockResolvedValue({ kind: "ok", source: null });
    await import("./popup");

    await vi.waitFor(() => expect(document.getElementById("save-page")).not.toBeNull());
    expect(document.querySelector(".banner--info")).toBeNull();
    expect(document.querySelector(".page-saved-note")).toBeNull();
    expect(document.getElementById("save-page")?.textContent).toContain("Save page");
  });

  it("shows no banner when the lookup errors or is not applicable", async () => {
    installDom();
    installChromeMock("");
    h.lookupSource.mockResolvedValue({ kind: "errored" });
    await import("./popup");

    await vi.waitFor(() => expect(document.getElementById("save-page")).not.toBeNull());
    expect(document.querySelector(".banner--info")).toBeNull();
  });

  it("never calls lookupSource when the extension is not paired", async () => {
    h.readPairedConfig.mockResolvedValue({ token: null, port: 47615 });
    await import("./popup");

    await vi.waitFor(() => expect(document.body.textContent).toContain("Extension not paired"));
    expect(h.lookupSource).not.toHaveBeenCalled();
  });

  it("never calls lookupSource when the app is offline", async () => {
    h.pingApp.mockResolvedValue(false);
    await import("./popup");

    await vi.waitFor(() =>
      expect(document.getElementById("connection-pill")?.textContent).toContain("App offline"),
    );
    expect(h.lookupSource).not.toHaveBeenCalled();
  });

  it("does not call lookupSource or banner on a restricted page with no http(s) url", async () => {
    installDom();
    queryTabs.mockResolvedValue([{ id: 5, title: "Extensions", url: "chrome://extensions" }]);
    // Injection fails on a restricted page → no probe url → fall back to tab url.
    executeScript.mockRejectedValue(new Error("Cannot access a chrome:// URL"));
    await import("./popup");

    await vi.waitFor(() => expect(document.getElementById("save-page")).not.toBeNull());
    expect(h.lookupSource).not.toHaveBeenCalled();
    expect(document.querySelector(".banner--info")).toBeNull();
  });

  it("ignores a stale lookup result after the user starts saving", async () => {
    installDom();
    installChromeMock("");
    sendMessage.mockImplementation((_message, cb) => {
      cb({
        kind: "ok",
        response: { ok: true, id: "src-1", kind: "page", title: "Saved article", deduped: false },
      });
    });
    let resolveLookup: ((outcome: LookupOutcome) => void) | undefined;
    h.lookupSource.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    await import("./popup");

    await vi.waitFor(() => expect(document.getElementById("save-page")).not.toBeNull());
    // Move off the idle view before the lookup resolves.
    (document.getElementById("save-page") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(document.querySelector(".done-title")?.textContent).toBe("Saved to inbox"),
    );

    resolveLookup?.({
      kind: "ok",
      source: { id: "existing-7", title: "Existing source", status: "inbox" },
    });
    await Promise.resolve();
    await Promise.resolve();

    // The saved view stays put; the stale lookup made no DOM mutation.
    expect(document.querySelector(".banner--info")).toBeNull();
    expect(document.querySelector(".done-title")?.textContent).toBe("Saved to inbox");
  });
});

/**
 * Background service worker (T062) — the extension's only persistent logic.
 *
 * BROWSER BOUNDARY: runs in Chrome's MV3 service worker, NOT the Electron
 * renderer. It imports only `@interleave/capture-contract` (via `./shared`) — no
 * `@interleave/core`, `apps/web`, or Electron. All capture delivery goes over the
 * token-protected `127.0.0.1` loopback server; it never writes the desktop DB.
 *
 * Responsibilities:
 *   - register the context menus ("Save page" / "Save selection to Interleave"),
 *   - answer popup/side-panel messages (save page / save selection),
 *   - scrape the active tab (outerHTML + title + url) via `chrome.scripting`,
 *   - POST the shaped capture (with the bearer token) to the loopback server,
 *   - surface success / failure / not-running / not-paired via the action badge +
 *     a notification, and append successful captures to the recent-captures list.
 */

import type { CaptureOutcome } from "./shared";
import { recordRecentCapture, sendCapture } from "./shared";

const MENU_SAVE_PAGE = "interleave-save-page";
const MENU_SAVE_SELECTION = "interleave-save-selection";
const MENU_OPEN_PANEL = "interleave-open-panel";

/** A tiny in-page scrape returning the rendered DOM + title + canonical-ish url. */
interface PageScrape {
  readonly url: string;
  readonly title: string;
  readonly html: string;
}

// --- lifecycle: register context menus + side-panel behavior ----------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SAVE_PAGE,
      title: "Save page to Interleave",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: MENU_SAVE_SELECTION,
      title: "Save selection to Interleave",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: MENU_OPEN_PANEL,
      title: "Open Interleave panel",
      contexts: ["page", "selection"],
    });
  });
  // The action click opens the popup (default); the panel opens explicitly (T063).
  if (chrome.sidePanel?.setPanelBehavior) {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  }
});

// --- context-menu clicks ----------------------------------------------------

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === MENU_SAVE_PAGE) {
    void savePage(tab);
  } else if (info.menuItemId === MENU_SAVE_SELECTION) {
    void saveSelection(tab, info.selectionText ?? null);
  } else if (info.menuItemId === MENU_OPEN_PANEL && chrome.sidePanel?.open) {
    void chrome.sidePanel.open({ tabId: tab.id });
  }
});

// --- popup / side-panel messages -------------------------------------------

interface SaveMessage {
  readonly type: "save-page" | "save-selection";
  readonly priority?: "A" | "B" | "C" | "D";
  readonly reason?: string;
  /** The panel may pass an explicit selection it already pulled. */
  readonly selection?: string;
}

chrome.runtime.onMessage.addListener((message: SaveMessage, _sender, sendResponse) => {
  void (async () => {
    const tab = await activeTab();
    if (!tab) {
      sendResponse({ kind: "error", message: "No active tab" } satisfies CaptureOutcome);
      return;
    }
    let outcome: CaptureOutcome;
    if (message.type === "save-page") {
      outcome = await savePage(tab, message.priority, message.reason);
    } else {
      outcome = await saveSelection(
        tab,
        message.selection ?? null,
        message.priority,
        message.reason,
      );
    }
    sendResponse(outcome);
  })();
  // Returning true keeps the message channel open for the async sendResponse.
  return true;
});

// --- capture flows ----------------------------------------------------------

/** Save the WHOLE page: scrape the rendered DOM, then POST a page capture. */
async function savePage(
  tab: chrome.tabs.Tab,
  priority?: "A" | "B" | "C" | "D",
  reason?: string,
): Promise<CaptureOutcome> {
  const scrape = await scrapePage(tab);
  if (!scrape) {
    return finish({ kind: "error", message: "Could not read this page" });
  }
  const outcome = await sendCapture({
    kind: "page",
    url: scrape.url,
    title: scrape.title,
    html: scrape.html,
    ...(priority ? { priority } : {}),
    ...(reason ? { reason } : {}),
  });
  return finish(outcome);
}

/** Save the current SELECTION: resolve the text, then POST a selection capture. */
async function saveSelection(
  tab: chrome.tabs.Tab,
  explicitSelection: string | null,
  priority?: "A" | "B" | "C" | "D",
  reason?: string,
): Promise<CaptureOutcome> {
  const url = tab.url ?? "";
  const title = tab.title ?? "";
  let selection = explicitSelection;
  let blockContext: string | null = null;
  if (!selection && tab.id) {
    const fromPage = await requestSelectionFromContentScript(tab.id);
    selection = fromPage?.selection ?? null;
    blockContext = fromPage?.blockContext ?? null;
  }
  if (!selection || selection.trim().length === 0) {
    return finish({ kind: "error", message: "No text selected" });
  }
  const outcome = await sendCapture({
    kind: "selection",
    url,
    title,
    selection,
    ...(blockContext ? { blockContext } : {}),
    ...(priority ? { priority } : {}),
    ...(reason ? { reason } : {}),
  });
  return finish(outcome);
}

// --- helpers ----------------------------------------------------------------

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/** Inject a tiny scrape grabbing outerHTML + title + the canonical/href url. */
async function scrapePage(tab: chrome.tabs.Tab): Promise<PageScrape | null> {
  if (!tab.id) return null;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Read the canonical as an HTMLLinkElement so its `.href` property is the
        // ABSOLUTE url the DOM resolved (a relative `href="/x"` becomes the full
        // url) — save-time and lookup-time must agree on the same absolute url, and
        // a relative canonical would otherwise be rejected by the strict CaptureUrlSchema.
        const link = document.querySelector('link[rel="canonical"]');
        const canonical = link instanceof HTMLLinkElement ? link.href : "";
        return {
          url: canonical || location.href,
          title: document.title || location.href,
          html: document.documentElement.outerHTML,
        };
      },
    });
    return (result?.result as PageScrape | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Ask the content script for the current selection + surrounding context. */
async function requestSelectionFromContentScript(
  tabId: number,
): Promise<{ selection: string; blockContext: string | null } | null> {
  // Inject the selection reader directly (avoids a persistent content script and
  // works on pages where one was not auto-injected). It does NO network I/O.
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const sel = window.getSelection();
        const text = sel ? sel.toString() : "";
        let context: string | null = null;
        if (sel && sel.rangeCount > 0) {
          const node = sel.getRangeAt(0).commonAncestorContainer;
          const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
          const full = el?.textContent ?? "";
          if (full && full.length > text.length) {
            context = full.trim().slice(0, 2000);
          }
        }
        return { selection: text, blockContext: context };
      },
    });
    const value = result?.result as { selection: string; blockContext: string | null } | undefined;
    return value ?? null;
  } catch {
    return null;
  }
}

/** Surface the outcome via the action badge + a notification + recent list. */
async function finish(outcome: CaptureOutcome): Promise<CaptureOutcome> {
  const { text, color, message } = badgeFor(outcome);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  // Clear the badge after a few seconds so it does not linger.
  setTimeout(() => void chrome.action.setBadgeText({ text: "" }), 4000);

  if (outcome.kind === "ok") {
    await recordRecentCapture({
      id: outcome.response.id,
      title: outcome.response.title,
      kind: outcome.response.kind,
      timestamp: Date.now(),
    });
  }
  notify(message);
  return outcome;
}

function badgeFor(outcome: CaptureOutcome): { text: string; color: string; message: string } {
  switch (outcome.kind) {
    case "ok":
      return {
        text: "✓",
        color: "#2e7d32",
        message: outcome.response.deduped
          ? `Already saved: ${outcome.response.title}`
          : `Saved: ${outcome.response.title}`,
      };
    case "not-paired":
      return {
        text: "!",
        color: "#b26a00",
        message: "Not paired — open Options and paste the token",
      };
    case "not-running":
      return { text: "✕", color: "#b00020", message: "Interleave app is not running" };
    case "bad-token":
      return { text: "!", color: "#b26a00", message: "Bad token — re-pair in Options" };
    default:
      return { text: "✕", color: "#b00020", message: outcome.message };
  }
}

function notify(message: string): void {
  if (!chrome.notifications?.create) return;
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-48.png",
    title: "Interleave",
    message,
  });
}

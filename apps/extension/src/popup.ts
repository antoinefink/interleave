/**
 * Action popup (T062).
 *
 * BROWSER BOUNDARY: runs in Chrome, styled with the re-declared design tokens.
 * It dispatches save messages to the background worker (which holds the loopback
 * client) and renders the worker's normalized outcome. "Save to inbox" is a page
 * save (the whole page into the inbox) — the richer priority+reason capture is
 * the side panel (T063).
 */

import type { CaptureOutcome } from "./shared";

const titleEl = document.getElementById("page-title") as HTMLParagraphElement;
const resultEl = document.getElementById("result") as HTMLDivElement;

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  titleEl.textContent = tab?.title ?? tab?.url ?? "Current tab";
}

function render(outcome: CaptureOutcome): void {
  resultEl.innerHTML = "";
  const el = document.createElement("span");
  switch (outcome.kind) {
    case "ok":
      el.className = "status ok";
      el.textContent = outcome.response.deduped
        ? `Already saved: ${outcome.response.title}`
        : `Saved: ${outcome.response.title}`;
      break;
    case "not-paired":
      el.className = "status warn";
      el.textContent = "Not paired — open Options";
      break;
    case "bad-token":
      el.className = "status warn";
      el.textContent = "Bad token — re-pair in Options";
      break;
    case "not-running":
      el.className = "status err";
      el.textContent = "App not running";
      break;
    default:
      el.className = "status err";
      el.textContent = outcome.message;
  }
  resultEl.appendChild(el);
}

function send(type: "save-page" | "save-selection"): void {
  resultEl.textContent = "Saving…";
  chrome.runtime.sendMessage({ type }, (outcome: CaptureOutcome) => {
    if (chrome.runtime.lastError) {
      render({ kind: "error", message: chrome.runtime.lastError.message ?? "Failed" });
      return;
    }
    render(outcome);
  });
}

document.getElementById("save-page")?.addEventListener("click", () => send("save-page"));
document.getElementById("save-inbox")?.addEventListener("click", () => send("save-page"));
document.getElementById("save-selection")?.addEventListener("click", () => send("save-selection"));
document.getElementById("open-options")?.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

void init();

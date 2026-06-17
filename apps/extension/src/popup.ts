/**
 * Action popup.
 *
 * BROWSER BOUNDARY: runs in Chrome, styled with the re-declared design tokens.
 * It reads only the active tab + selected text, dispatches narrow save messages
 * to the background worker, and renders the worker's normalized outcome.
 */

import type { CaptureOutcome, OpenSourceOutcome, PairedConfig } from "./shared";
import { lookupSource, openCapturedSource, pingApp, readPairedConfig } from "./shared";

type Priority = "A" | "B" | "C" | "D";
type ConnectionState = "checking" | "ok" | "offline" | "not-paired";
type Phase = "idle" | "saving" | "saved";

interface PageContext {
  readonly title: string;
  readonly url: string;
  readonly domain: string;
}

interface SavedState {
  readonly kind: "page" | "selection";
  readonly priority: Priority;
  readonly title: string;
  readonly sourceId: string;
  readonly deduped: boolean;
}

const PRIORITY_HINT: Readonly<Record<Priority, readonly [string, string]>> = {
  A: ["Protected", "high value - resurfaces soon"],
  B: ["Important", "useful to keep around"],
  C: ["Normal", "standard review cadence"],
  D: ["Someday", "low priority - background decay"],
};

const bodyEl = document.getElementById("popup-body") as HTMLElement;
const pillEl = document.getElementById("connection-pill") as HTMLSpanElement;
const optionsButton = document.getElementById("open-options") as HTMLButtonElement;

let page: PageContext = {
  title: "Current tab",
  url: "",
  domain: "current page",
};
let selection = "";
let priority: Priority = "C";
let phase: Phase = "idle";
let connection: ConnectionState = "checking";
let savedState: SavedState | null = null;
let lastError: string | null = null;
let pairedConfig: PairedConfig | null = null;
/** The pre-save "already saved" hint: the matched source, or null for no banner. */
let alreadySaved: { id: string; title: string; status: string } | null = null;
let lookupState: "idle" | "pending" | "done" = "idle";

async function init(): Promise<void> {
  optionsButton.addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  page = pageFromTab(tab);
  // One-shot in-page read: the current selection AND the scrape-equivalent url
  // (`link[rel="canonical"]` href, else `location.href` — mirrors `scrapePage`
  // in background.ts, KTD5). On a restricted page the injection fails and we keep
  // the tab url.
  const probe = await readPageProbe(tab?.id);
  selection = probe.selection;
  if (probe.url) {
    page = { ...page, url: probe.url, domain: domainFromUrl(probe.url) };
  }
  render();
  await refreshConnection();
  await runLookup();
}

/**
 * After the connection probe reports "ok" and we have an http(s) url, ask the
 * desktop whether this page is already saved (R1). Stale-render guarded (R8):
 * if the popup was dismissed or the user started saving before this resolves, it
 * makes no DOM mutation. Every non-`ok`/non-source outcome leaves the idle view
 * untouched (R5). Never throws.
 */
async function runLookup(): Promise<void> {
  if (lookupState !== "idle") return;
  if (connection !== "ok") return;
  const url = page.url;
  if (!/^https?:\/\//i.test(url)) return;

  lookupState = "pending";
  const outcome = await lookupSource(url);
  lookupState = "done";
  // Bail if the user moved off the idle view or the popup body went away (R8).
  if (phase !== "idle" || !bodyEl.isConnected) return;
  if (outcome.kind === "ok" && outcome.source) {
    alreadySaved = outcome.source;
    render();
  }
}

function pageFromTab(tab: chrome.tabs.Tab | undefined): PageContext {
  const url = tab?.url ?? "";
  return {
    title: tab?.title ?? url ?? "Current tab",
    url,
    domain: domainFromUrl(url),
  };
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "current page";
  }
}

interface PageProbe {
  readonly selection: string;
  /** The scrape-equivalent url, or "" when injection failed (restricted page). */
  readonly url: string;
}

/**
 * One-shot in-page read: the current selection plus the scrape-equivalent url
 * (`link[rel="canonical"]` href, else `location.href`). Folding both into a
 * single `executeScript` keeps popup-open to one injection (KTD5). Returns empty
 * fields on a restricted page (injection throws) so the caller falls back to the
 * tab url.
 */
async function readPageProbe(tabId: number | undefined): Promise<PageProbe> {
  if (!tabId || !chrome.scripting?.executeScript) return { selection: "", url: "" };
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href");
        return {
          selection: window.getSelection()?.toString().trim() ?? "",
          url: canonical || location.href,
        };
      },
    });
    const value = result?.result as { selection?: unknown; url?: unknown } | undefined;
    return {
      selection: typeof value?.selection === "string" ? value.selection.trim() : "",
      url: typeof value?.url === "string" ? value.url : "",
    };
  } catch {
    return { selection: "", url: "" };
  }
}

async function refreshConnection(): Promise<void> {
  connection = "checking";
  render();
  pairedConfig = await readPairedConfig();
  if (!pairedConfig.token) {
    connection = "not-paired";
    render();
    return;
  }
  connection = (await pingApp(pairedConfig.port)) ? "ok" : "offline";
  render();
}

function render(): void {
  renderConnectionPill();
  if (phase === "saved" && savedState) {
    renderSaved();
    return;
  }
  if (connection === "offline" || connection === "not-paired") {
    renderBlocked();
    return;
  }
  renderIdle();
}

function renderConnectionPill(): void {
  switch (connection) {
    case "ok":
      pillEl.className = "conn-pill conn-pill--ok";
      pillEl.innerHTML = `${icon("shield")} Connected`;
      pillEl.title = "Paired with Interleave. Captures stay on 127.0.0.1.";
      break;
    case "offline":
      pillEl.className = "conn-pill conn-pill--err";
      pillEl.innerHTML = `<span class="conn-dot"></span> App offline`;
      pillEl.title = "The Interleave desktop app is not reachable.";
      break;
    case "not-paired":
      pillEl.className = "conn-pill conn-pill--warn";
      pillEl.innerHTML = `<span class="conn-dot"></span> Not paired`;
      pillEl.title = "Pair this extension from Options.";
      break;
    default:
      pillEl.className = "conn-pill conn-pill--warn";
      pillEl.textContent = "Checking";
      pillEl.title = "Checking the Interleave desktop app.";
  }
}

function renderIdle(): void {
  const hasSelection = selection.length > 0;
  const saving = phase === "saving";
  const saved = alreadySaved;
  const [hintTitle, hintBody] = PRIORITY_HINT[priority];

  // The page is already saved AND the user is saving the whole page (no
  // selection): lead with the "already saved" banner and demote Save to a
  // secondary "Save anyway" affordance (save-time stays authoritative).
  const pageAlreadySaved = saved !== null && !hasSelection;

  bodyEl.innerHTML = `
    ${pageRow()}
    ${pageAlreadySaved ? alreadySavedBanner(saved) : ""}
    <section class="capture-section">
      <div class="section-label">
        <span>Selection</span>
        <span class="label-action">${
          hasSelection ? `<b>${wordCount(selection)}</b> words -> extract` : "whole page"
        }</span>
      </div>
      ${
        hasSelection
          ? `<div class="selection-preview">${escapeHtml(selection)}</div>`
          : `<div class="selection-empty">${icon("text")} Select text on the page to save just a passage</div>`
      }
    </section>
    ${
      saved !== null && hasSelection
        ? `<div class="page-saved-note">${icon("bookmark")}<span>This page is already saved</span><button id="open-source-page" class="link-btn" type="button">Open page in Interleave</button></div>`
        : ""
    }
    <section class="capture-section">
      <div class="section-label"><span>Priority</span></div>
      ${priorityGroup(saving)}
      <div class="priority-hint"><b>${hintTitle}</b> - ${hintBody}</div>
    </section>
    ${lastError ? `<div class="banner banner--danger" role="alert">${icon("warning")}<span>${escapeHtml(lastError)}</span></div>` : ""}
    <div class="popup-actions">
      ${
        hasSelection
          ? `<button id="save-selection" class="btn btn--primary btn--lg btn--block" type="button" ${
              saving ? "disabled" : ""
            }>${saving ? spinner() : icon("extract")}${saving ? "Saving..." : "Save selection"}</button>
             <button id="save-page" class="btn btn--block" type="button" ${saving ? "disabled" : ""}>${icon("bookmark")}Save whole page instead</button>`
          : pageAlreadySaved
            ? `<button id="open-source" class="btn btn--primary btn--lg btn--block" type="button">${icon("external")}Open in Interleave</button>
               <button id="save-page" class="btn btn--block" type="button" ${saving ? "disabled" : ""}>${saving ? spinner() : icon("bookmark")}${saving ? "Saving..." : "Save anyway"}</button>`
            : `<button id="save-page" class="btn btn--primary btn--lg btn--block" type="button" ${
                saving ? "disabled" : ""
              }>${saving ? spinner() : icon("bookmark")}${saving ? "Saving..." : "Save page"}</button>`
      }
    </div>
    <div id="save-result" class="${pageAlreadySaved ? "open-result" : "sr-only"}" aria-live="polite"></div>
  `;

  wirePriority();
  bodyEl.querySelector<HTMLButtonElement>("#save-page")?.addEventListener("click", () => {
    send("save-page");
  });
  bodyEl.querySelector<HTMLButtonElement>("#save-selection")?.addEventListener("click", () => {
    send("save-selection");
  });
  if (saved) {
    bodyEl.querySelector<HTMLButtonElement>("#open-source")?.addEventListener("click", (event) => {
      void openSourceFromButton(saved.id, event.currentTarget as HTMLButtonElement, {
        activate: false,
      });
    });
    bodyEl
      .querySelector<HTMLButtonElement>("#open-source-page")
      ?.addEventListener("click", (event) => {
        void openSourceFromButton(saved.id, event.currentTarget as HTMLButtonElement, {
          activate: false,
        });
      });
  }
}

/** The pre-save "Already saved" indicator (whole-page case), reusing the
 * `bookmark`-led, `done-source`/`badge-prio` vocabulary of {@link renderSaved}. */
function alreadySavedBanner(saved: { id: string; title: string; status: string }): string {
  const statusHint = saved.status === "inbox" ? " - in your inbox" : "";
  return `
    <div class="banner banner--info" role="status">
      ${icon("bookmark")}
      <span>
        <b>Already saved${escapeHtml(statusHint)}</b>
        <span class="banner-source">
          <span class="source-icon">${icon("source")}</span>
          <span class="done-source-title">${escapeHtml(saved.title)}</span>
        </span>
      </span>
    </div>
  `;
}

function renderSaved(): void {
  const saved = savedState;
  if (!saved) return;
  const isSelection = saved.kind === "selection";
  bodyEl.innerHTML = `
    <div class="saved-wrap">
      <span class="done-ring">${icon(saved.deduped ? "bookmark" : "check")}</span>
      <div class="done-title">${
        saved.deduped ? "Already saved" : isSelection ? "Extract saved" : "Saved to inbox"
      }</div>
      <div class="done-source">
        <span class="source-icon">${icon(isSelection ? "extract" : "source")}</span>
        <span class="done-source-title">${escapeHtml(isSelection ? clip(selection, 54) : saved.title)}</span>
      </div>
      <div class="done-meta">
        <span class="badge-prio" data-p="${saved.priority}"><span class="prio-dot"></span>${saved.priority}</span>
        <span>${isSelection ? "extract" : "page"} - just now</span>
      </div>
    </div>
    <div class="popup-actions">
      <button id="open-source" class="btn btn--primary btn--lg btn--block" type="button">${icon("external")}Open in Interleave</button>
      <button id="save-another" class="btn btn--ghost btn--block" type="button">Save another</button>
    </div>
    <div id="save-result" class="open-result" aria-live="polite"></div>
  `;

  bodyEl.querySelector<HTMLButtonElement>("#open-source")?.addEventListener("click", (event) => {
    void openSourceFromButton(saved.sourceId, event.currentTarget as HTMLButtonElement);
  });
  bodyEl.querySelector<HTMLButtonElement>("#save-another")?.addEventListener("click", () => {
    phase = "idle";
    savedState = null;
    lastError = null;
    render();
  });
}

function renderBlocked(): void {
  const offline = connection === "offline";
  bodyEl.innerHTML = `
    <div class="dimmed">${pageRow()}</div>
    <div class="banner ${offline ? "banner--danger" : ""}" role="alert">
      ${icon("warning")}
      <span>
        <b>${offline ? "Interleave is not reachable" : "Extension not paired"}</b>
        <small>${
          offline
            ? "Open the desktop app and make sure Browser capture is enabled."
            : "Paste the desktop pairing token in Options to start capturing."
        }</small>
      </span>
    </div>
    <div class="popup-actions">
      ${
        offline
          ? `<button id="retry-connection" class="btn btn--lg btn--block" type="button">${icon("refresh")}Retry connection</button>`
          : `<button id="pair-options" class="btn btn--primary btn--lg btn--block" type="button">${icon("settings")}Open Options to pair</button>`
      }
    </div>
  `;
  bodyEl.querySelector<HTMLButtonElement>("#retry-connection")?.addEventListener("click", () => {
    void refreshConnection();
  });
  bodyEl.querySelector<HTMLButtonElement>("#pair-options")?.addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });
}

function pageRow(): string {
  return `
    <section class="page-row">
      <span class="favicon-tile" aria-hidden="true">${escapeHtml(page.domain.charAt(0).toUpperCase() || "I")}</span>
      <span class="page-main">
        <span class="page-title">${escapeHtml(page.title)}</span>
        <span class="page-meta">${icon("globe")}<span>${escapeHtml(page.domain)}</span></span>
      </span>
    </section>
  `;
}

function priorityGroup(disabled = false): string {
  return `
    <div class="priority-row" role="group" aria-label="Priority">
      ${(["A", "B", "C", "D"] as const)
        .map(
          (p) => `
            <button class="priority-chip ${priority === p ? "priority-chip--on" : ""}" data-priority="${p}" type="button" aria-pressed="${priority === p}" ${
              disabled ? "disabled" : ""
            }>
              <span class="prio-dot"></span>${p}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function wirePriority(): void {
  for (const chip of bodyEl.querySelectorAll<HTMLButtonElement>(".priority-chip")) {
    chip.addEventListener("click", () => {
      if (phase === "saving") return;
      priority = chip.dataset.priority as Priority;
      render();
    });
  }
}

function send(type: "save-page" | "save-selection"): void {
  const submittedPriority = priority;
  const submittedSelection = selection;
  phase = "saving";
  lastError = null;
  render();
  chrome.runtime.sendMessage(
    {
      type,
      priority: submittedPriority,
      ...(type === "save-selection" && submittedSelection ? { selection: submittedSelection } : {}),
    },
    (outcome: CaptureOutcome) => {
      if (chrome.runtime.lastError) {
        phase = "idle";
        lastError = chrome.runtime.lastError.message ?? "Failed";
        render();
        return;
      }
      renderCaptureOutcome(type, outcome, submittedPriority);
    },
  );
}

function renderCaptureOutcome(
  type: "save-page" | "save-selection",
  outcome: CaptureOutcome,
  submittedPriority: Priority,
): void {
  phase = "idle";
  switch (outcome.kind) {
    case "ok":
      savedState = {
        kind: outcome.response.kind,
        priority: submittedPriority,
        title: outcome.response.title,
        sourceId: outcome.response.id,
        deduped: outcome.response.deduped,
      };
      phase = "saved";
      lastError = null;
      render();
      return;
    case "not-paired":
    case "bad-token":
      connection = "not-paired";
      lastError = null;
      render();
      return;
    case "not-running":
      connection = "offline";
      lastError = null;
      render();
      return;
    default:
      lastError =
        outcome.message ||
        (type === "save-selection" ? "Could not save selection" : "Could not save page");
      render();
  }
}

async function openSourceFromButton(
  sourceId: string,
  button: HTMLButtonElement,
  options: { readonly activate?: boolean } = {},
): Promise<void> {
  button.disabled = true;
  button.innerHTML = `${spinner()}Opening...`;
  const result = document.getElementById("save-result") as HTMLDivElement | null;
  // The pre-save banner opens with activate:false (KTD4 — browsing, not
  // capturing, so no silent inbox-accept); the post-save screen keeps the
  // explicit activate:true.
  const outcome = await openCapturedSource(sourceId, { activate: options.activate ?? true });
  renderOpenOutcome(outcome, button, result);
}

function renderOpenOutcome(
  outcome: OpenSourceOutcome,
  button: HTMLButtonElement,
  result: HTMLDivElement | null,
): void {
  if (!button.isConnected) return;
  if (outcome.kind === "ok") {
    button.textContent = "Opened in Interleave";
    if (result?.isConnected) result.textContent = "Opened in Interleave";
    return;
  }
  button.disabled = false;
  button.innerHTML = `${icon("external")}Open in Interleave`;

  if (!result?.isConnected) return;
  result.className = "open-result open-result--error";
  switch (outcome.kind) {
    case "not-paired":
      result.textContent = "Not paired - open Options";
      break;
    case "bad-token":
      result.textContent = "Bad token - re-pair in Options";
      break;
    case "not-running":
      result.textContent = "App not running";
      break;
    default:
      result.textContent = outcome.message;
  }
}

function icon(name: string): string {
  const paths: Record<string, string> = {
    bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />',
    check: '<path d="M20 6 9 17l-5-5" />',
    external:
      '<path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />',
    extract: '<path d="M5 4h14" /><path d="M5 9h14" /><path d="M5 14h9" /><path d="M5 19h6" />',
    globe:
      '<circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 0 20" /><path d="M12 2a15.3 15.3 0 0 0 0 20" />',
    refresh:
      '<path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" /><path d="M3 21v-5h5" /><path d="M3 12A9 9 0 0 1 18.5 5.7L21 8" /><path d="M21 3v5h-5" />',
    settings:
      '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.2a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.3a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.3a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.2a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.2a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.3a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.3a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.2a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3" />',
    shield:
      '<path d="M20 13c0 5-3.5 7.5-7.7 8.9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z" />',
    source:
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />',
    text: '<path d="M17 6.1H3" /><path d="M21 12.1H3" /><path d="M15.1 18H3" />',
    warning:
      '<path d="m21.7 18-8.5-14.7a1.4 1.4 0 0 0-2.4 0L2.3 18a1.4 1.4 0 0 0 1.2 2.1h17a1.4 1.4 0 0 0 1.2-2.1Z" /><path d="M12 9v4" /><path d="M12 17h.01" />',
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}

function spinner(): string {
  return '<span class="spin" aria-hidden="true"></span>';
}

function wordCount(value: string): number {
  return value.trim().match(/\S+/g)?.length ?? 0;
}

function clip(value: string, max: number): string {
  const clean = value.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

void init();

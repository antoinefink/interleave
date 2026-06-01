/**
 * Options / pairing page (T062).
 *
 * BROWSER BOUNDARY: runs in Chrome, styled with the re-declared design tokens
 * (`tokens.css`) — NOT the renderer's React/Tailwind. The user pastes the token
 * shown in the desktop's Settings; "Save & test" pings the app, runs the pairing
 * handshake (POSTing THIS extension's `chrome.runtime.id`-derived origin so the
 * desktop can lock CORS to it), and reports paired / not-paired.
 */

import {
  DEFAULT_CAPTURE_PORT,
  pairWithApp,
  pingApp,
  readPairedConfig,
  writePairedConfig,
} from "./shared";

const tokenInput = document.getElementById("token") as HTMLInputElement;
const portInput = document.getElementById("port") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLSpanElement;

function setStatus(kind: "ok" | "warn" | "err", message: string): void {
  statusEl.hidden = false;
  statusEl.className = `status ${kind}`;
  statusEl.textContent = message;
}

async function load(): Promise<void> {
  const { token, port } = await readPairedConfig();
  if (token) tokenInput.value = token;
  portInput.value = String(port || DEFAULT_CAPTURE_PORT);
}

async function saveAndTest(): Promise<void> {
  const token = tokenInput.value.trim();
  const port = Number(portInput.value) || DEFAULT_CAPTURE_PORT;
  if (!token) {
    setStatus("warn", "Paste the token from Settings first");
    return;
  }
  await writePairedConfig(token, port);

  setStatus("warn", "Testing…");
  const running = await pingApp(port);
  if (!running) {
    setStatus("err", "App not reachable — is Interleave running with capture enabled?");
    return;
  }
  const paired = await pairWithApp(token, port);
  if (!paired) {
    setStatus("err", "Bad token — copy it again from Settings");
    return;
  }
  setStatus("ok", "Paired ✓");
}

saveButton.addEventListener("click", () => void saveAndTest());
void load();

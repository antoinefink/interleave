# @interleave/extension — local-first browser capture (MV3)

A Manifest V3 Chrome extension that saves the page you are reading — the **whole
article** or the **current selection** — into the running Interleave desktop
app's **inbox**, with full source lineage, **entirely locally**. The extension
never touches SQLite and never makes a cloud call: it POSTs the capture (with a
per-install pairing token) to a token-protected `127.0.0.1` loopback HTTP capture
server mounted inside the Electron main process, which runs the same M12 import
pipeline the desktop's "Import from URL" uses.

## Architecture boundary (read this first)

This extension runs in **Chrome**, not the Electron renderer. It must NOT import
`@interleave/core`, `@interleave/local-db`, `apps/web`, or Electron. Its only
workspace dependency is the zod-only **`@interleave/capture-contract`** (the
shared wire contract). The options / popup / side-panel pages reuse Interleave's
**design language** — the OKLCH tokens, IBM Plex type, and priority colors
re-declared locally in `src/tokens.css` — **not** the renderer's React components.

## Build

```sh
pnpm --filter @interleave/extension build
```

This bundles the TS entry points (`background` / `options` / `popup` /
`sidepanel`) to browser ESM and copies the HTML + `tokens.css` + `manifest.json`
+ the 16/32/48/128 PNG icons into a **load-unpacked-ready `apps/extension/dist/`**.
(Selection reading is injected on demand via `chrome.scripting.executeScript`, so
there is no standing `content` script in T062 — T063 adds one if it needs to.)

Regenerate the icons with `node apps/extension/scripts/make-icons.mjs` (they are
committed PNGs downscaled from the canonical brand mark `brand/logo.png` — the
layered-stack glyph on a transparent ground; a Chrome manifest icon cannot be an
SVG). Production bundles are **minified** (the worker bundles zod via
`@interleave/capture-contract`); `--watch` builds stay unminified for debugging.

### Permissions (manifest)

The extension requests the minimum surface it needs:

- `activeTab` + `scripting` — inject the page-scrape / selection-read **on demand
  into the active tab** when the user invokes a save (no standing content script).
- `contextMenus` — the right-click "Save … to Interleave" entries.
- `sidePanel` — the T063 side-panel capture UI (priority + reason, recent captures).
- `storage` — persist the paired loopback port + recent-capture list.
- `notifications` — show the capture success / failure / "app not running" toast.
- `host_permissions: http://127.0.0.1/*` — POST captures to the loopback server only.

## Manual load-unpacked verification checklist

Playwright-Electron drives the Electron **main / loopback server**, not a real
Chrome with the extension loaded (a real extension runtime cannot be
Playwright-driven). So the automated coverage is:

1. `packages/capture-contract` unit tests (the wire contract + pure shaping/validation),
2. `apps/desktop/src/main/capture-handler.test.ts` (the pure capture handler),
3. `tests/electron/capture-server.spec.ts` (the loopback server end-to-end + restart).

The extension's own runtime is verified once by hand with this checklist:

1. **Build:** `pnpm --filter @interleave/extension build`.
2. **Load:** Chrome → `chrome://extensions` → enable **Developer mode** → **Load
   unpacked** → select `apps/extension/dist`.
3. **Enable capture in the app:** launch the desktop app (`pnpm dev`) → **Settings
   → Browser capture** → toggle it **on** → **Copy** the token.
4. **Pair:** click the extension's icon → **Open options / pairing** → paste the
   token → **Save & test connection** → expect **“Paired ✓”**.
5. **Save page:** on any article → action popup → **Save page** → expect a success
   badge (✓) and the article appearing in the desktop **inbox** with a snapshot +
   body.
6. **Save selection:** select text → right-click → **Save selection to
   Interleave** → expect a selection source in the inbox (its “why added”
   provenance carries the surrounding-text context anchor).
7. **Side panel (T063):** action popup → **Open side panel** (or the “Open
   Interleave panel” context-menu / command) → the panel opens beside the page.
   Select text on the page → **Use current selection** → pick priority **A** →
   type a **reason** → **Save selection** → expect a success status, the source
   appearing in the panel’s **Recent captures**, and the desktop inbox source
   carrying that **priority** and a **“why added”** holding the reason + the
   folded-in surrounding-text anchor.
8. **Not running / disabled:** disable capture in **Settings** → a save now shows
   **“App not running / capture disabled.”**

## Security / threat model (enforced by the desktop loopback server)

- Binds `127.0.0.1` **only** (never `0.0.0.0`); rejects non-loopback remote addresses.
- A **per-install token** (constant-time compare) is required on every `/capture`.
- **Exact-Origin CORS** locked to this extension's `chrome-extension://<id>`
  origin via a pairing handshake (the options page POSTs its origin during
  “Test connection”); never `*`.
- **POST-only** `/capture` + a **GET-only** unauthenticated `/ping`; everything
  else → `405`. No generic command surface, no `db.query`.
- **Zod-validated** payloads + a hard body-size cap.
- **Off until paired** — the server does not open a port on a fresh install.

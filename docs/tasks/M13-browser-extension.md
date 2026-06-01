# M13 — Browser extension (T062–T063)

Detailed, buildable specs for the thirteenth milestone, **rebuilt LOCAL-FIRST**. After these
two tasks the user can install a Manifest V3 Chrome extension that captures the page they are
reading — the **whole article** or a **selection** (with a priority + a short reason) — and have
it land in the running Interleave desktop app's **inbox**, with full source lineage, **with no
cloud backend**. The extension never touches SQLite and never makes a cloud call: it POSTs the
capture to a **token-protected `127.0.0.1` loopback HTTP capture server** mounted inside the
Electron **main** process, which runs the **same M12 local import pipeline** (fetch → Readability
→ sanitize → snapshot-to-vault → HTML→ProseMirror → `createSource` + `operation_log`) the
renderer's "Import from URL" affordance uses. A saved page becomes a proper inbox `source`; a
saved selection becomes an inbox capture. Pairing is offline and explicit: the desktop shows a
random per-install token in Settings, the user pastes it into the extension's options page, and
every capture request carries it.

Everything here obeys the M1 architecture exactly as the rest of the app does:

- **No cloud. No Postgres. No S3. No auth server. No pg-boss worker.** Despite the roadmap's
  original M11/M12 cloud framing, this milestone is built **local-first** against the **existing**
  `window.appApi` + asset-vault stack (see the Upstream-dependency note). The only new local
  network surface is the loopback capture server, and it is minimal, off until paired, and bound
  to `127.0.0.1` only.
- **The renderer (`apps/web`) and the extension never touch SQLite, Node, or arbitrary `fs`.** The
  renderer reaches the import service through the typed, Zod-validated `window.appApi` bridge
  (T062 adds `sources.importUrl` in M12; M13 reuses it). The extension reaches the **same**
  pipeline only by POSTing a Zod-validated capture payload to the loopback server, which calls the
  M12 import service main-side. There is no generic command surface and no `db.query`.
- **Pure domain transforms live in a package**, not in React, not buried in `apps/desktop/main`:
  HTML→clean-article→ProseMirror JSON is M12's **`@interleave/importers`** (`packages/importers/`)
  package, and URL canonicalization (`canonicalizeUrl`) is `@interleave/core` — both with
  fixture-driven unit tests. M13 adds **one pure module** — the capture-payload shaping +
  token/origin validation — to a package so it is
  unit-testable without Electron. The orchestrating glue (binding the HTTP server, reading the
  token from SQLite settings, calling the import service) is main-side.
- **Multi-table mutations run in ONE transaction that appends an `operation_log` entry**
  (`create_source`, `create_element`, `update_document`; see
  [`../../packages/core/src/operation-log.ts`](../../packages/core/src/operation-log.ts)). Deletes
  are soft. **Source lineage is sacred** — a page captured by the extension is indistinguishable
  from one imported via the renderer (same `sources` provenance row, same vault snapshot, same
  lineage root). FSRS schedules cards only; the attention scheduler schedules sources/extracts —
  M13 crosses neither.
- **Every capture must survive an app restart** and be verified with native `pnpm`
  (`typecheck`/`lint`/`test` + an Electron integration test). The Chrome extension itself **cannot
  be driven by Playwright-Electron**, so its testing is scoped realistically (unit tests for the
  capture-message shaping + token/origin validation + the loopback request handler; an integration
  test of the loopback server against the Electron main-side services + a restart-persistence step;
  and a documented manual load-unpacked checklist).

Read first:
- [`../design-system.md`](../design-system.md) + [`../../design/tokens.css`](../../design/tokens.css)
  — the panel and options pages are **visible UI**, so reuse the OKLCH tokens, IBM Plex type, and
  `lucide-react` icons. **Note:** the side panel + options page run in the **browser**, not in the
  Electron renderer, so they reuse the design *language* (tokens, type scale, priority colors,
  icon set) — **not** the renderer's React components or `window.appApi`. State this in the code
  comments so a later reader does not try to import renderer code into the extension.
- [`../domain-model.md`](../domain-model.md) — the `source` element type, `inbox` status,
  `raw_source` stage, priority A/B/C/D, the `sources` provenance row (`url`/`canonicalUrl`/
  `originalUrl`/`accessedAt`/`snapshotKey`/`reasonAdded`), and the operation-log shapes.
- [`../architecture.md`](../architecture.md) — the "Manifest V3 browser extension … sends captures
  to the Electron app … never writes the database directly" line (§Later platforms) and the
  `apps/extension/` slot in the monorepo layout.
- [`../../CLAUDE.md`](../../CLAUDE.md) — layering, Electron security, SQLite rules, data rules.
- Spec contract: [`_TEMPLATE.md`](./_TEMPLATE.md). Format/depth exemplar:
  [`M2-capture-and-inbox.md`](./M2-capture-and-inbox.md) (the closest analog — import/inbox — this
  milestone mirrors its structure, depth, and "Done when"/deliverables/tests style).

What already exists (confirmed by inspecting the repo — **do not rebuild these**):
- The whole **inbox/import surface**: `SourceRepository.create` + `createWithDocument` in
  [`../../packages/local-db/src/source-repository.ts`](../../packages/local-db/src/source-repository.ts)
  (creates a `source` element + `sources` provenance row + document body + stable
  `document_blocks`, all in **one** transaction, logging `create_source` / `create_element` /
  `update_document`); `CreateSourceInput` **already accepts** `url`/`canonicalUrl`/`originalUrl`/
  `accessedAt`/`snapshotKey`/`reasonAdded`/`publishedAt`/`author` and defaults `status: "inbox"`,
  `stage: "raw_source"`. **The capture pipeline reuses this — it never invents a new source path.**
- The IPC seam: shared contract
  [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts)
  (esp. `SourcesImportManualRequestSchema` ~line 770, `SourcesImportManualResult` ~line 810, the
  `AppApi.sources`/`AppApi.inbox` surface ~line 2501, the `AppApi.settings` surface ~line 2446) +
  channels [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts)
  (`IPC_CHANNELS`), router [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts)
  (the `registerIpcHandlers(dbService, context?)` pattern, every handler `Schema.parse`-ing first),
  DB service [`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts),
  preload [`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts),
  and the renderer client `apps/web/src/lib/appApi.ts`.
- The URL canonicalizer `canonicalizeUrl(raw): string | null` in
  [`../../packages/core/src/url.ts`](../../packages/core/src/url.ts) (lowercases host, strips
  `utm_*`/`fbclid`/`gclid`/…, drops fragment, trims trailing slash; idempotent; `http(s)` only).
  **M12 (T060/T061) reuses this** for canonical-URL capture + dedup; M13 captures land through M12
  and therefore inherit it.
- The plain-text→ProseMirror converter `plainTextToProseMirrorDoc(text)` in
  [`../../packages/core/src/prosemirror.ts`](../../packages/core/src/prosemirror.ts) (paragraphs +
  STABLE block IDs as node `attrs.blockId` mirrored into `document_blocks`). The HTML→ProseMirror
  output **M12 builds** must satisfy the constrained editor schema in
  [`../../packages/editor/src/schema.ts`](../../packages/editor/src/schema.ts) (allowed nodes:
  paragraph/heading(1–3)/blockquote/bulletList/orderedList/listItem/codeBlock/horizontalRule/
  hardBreak; marks: bold/italic/link/code) and carry stable block IDs per
  [`../../packages/editor/src/block-id.ts`](../../packages/editor/src/block-id.ts). M13 ships
  **selection** captures as plain text via `plainTextToProseMirrorDoc`; M12 owns the page→HTML→PM path.
- The **asset vault**: `AssetRepository` in
  [`../../packages/local-db/src/asset-repository.ts`](../../packages/local-db/src/asset-repository.ts)
  (metadata only — bytes on disk; note `findByContentHash` for dedup) and the vault paths
  (`assets/sources/<source_id>/`) resolved in
  [`../../apps/desktop/src/main/paths.ts`](../../apps/desktop/src/main/paths.ts). **M12** writes
  `original.html` / `cleaned.html` here and sets `snapshotKey`; M13 captures reuse that.
- The **Settings** screen [`../../apps/web/src/pages/Settings.tsx`](../../apps/web/src/pages/Settings.tsx)
  reading/writing through `appApi.settings.getAll()` / `updateMany()`; the typed settings live in
  `@interleave/core` + the SQLite `settings` key/value table via
  [`../../packages/local-db/src/settings-repository.ts`](../../packages/local-db/src/settings-repository.ts)
  (`SettingsRepository.get`/`set`/`getAll`). **The pairing token is stored here.**
- The **inbox import strip** in
  [`../../apps/web/src/pages/inbox/InboxScreen.tsx`](../../apps/web/src/pages/inbox/InboxScreen.tsx)
  already renders a **"Browser capture"** button (`{ icon: "globe", label: "Browser capture", hint:
  "From the extension — coming soon" }` in `IMPORT_OPTS`, ~line 65) marked *"From the extension —
  coming soon"* and disabled (enablement is hard-coded `o.action === "manual"`, ~line 470). M13
  turns that hint into a real pairing entry point (open Settings → the new "Browser capture" pairing
  card), widening the `action` union to include `"capture"`. Do **not** invent a new import surface.
- The Electron lifecycle in
  [`../../apps/desktop/src/main/index.ts`](../../apps/desktop/src/main/index.ts): `bootstrap()` is
  defined at ~line 47 and wired via `app.whenReady().then(bootstrap)` at ~lines 123–124; the
  existing `app.on("will-quit", …)` disposer is at ~line 142. The loopback server is started inside
  `bootstrap()` (after the DB is open, alongside `registerIpcHandlers`) and stopped in that
  `will-quit` disposer. Window
  security defaults (`contextIsolation`/`sandbox`/`nodeIntegration: false`) live in
  [`../../apps/desktop/src/main/window.ts`](../../apps/desktop/src/main/window.ts) (unchanged).
- Build tooling: a **pnpm workspace** (`pnpm-workspace.yaml`: `apps/*`, `packages/*`), Turborepo
  for `build`/`typecheck`. The renderer (`apps/web`) builds with **Vite**; the desktop
  main/preload build with **esbuild** ([`../../apps/desktop/build.mjs`](../../apps/desktop/build.mjs)).
  `pnpm@9.12.1`. Electron `^38.8.6` (Chromium-based; Side Panel API available in modern Chrome ≥114).

What is **missing** and this milestone adds:
- A new workspace package `apps/extension` — the MV3 extension (manifest, background service
  worker, content script, side panel, options/pairing page) with a small build script.
- A **loopback capture server** module in `apps/desktop/src/main` mounted at `app.whenReady`,
  token-protected, `127.0.0.1`-only, POST-only, Zod-validated, **off until paired**.
- A **shared capture contract** (Zod request/response schemas + types) in a place the extension
  and the Electron main can **both** import **without** the extension importing Electron or
  `packages/local-db` — a new tiny `packages/capture-contract` (framework-free, depends only on
  `zod`). The desktop's existing `apps/desktop/src/shared/contract.ts` cannot serve this directly
  because it pulls in `@interleave/core` IDs/enums; the capture contract is a clean, dependency-free
  subset both sides agree on.
- A **pairing token** in SQLite settings + a desktop **pairing UI** in Settings (display, copy,
  regenerate, enable/disable the server, show running state).
- M12's `sources.importUrl` import service (the **Upstream dependency** — see below) — its
  loopback caller is the deliverable here.

Build order is the task order; **T063 depends on T062** (the side panel reuses T062's loopback
client + capture contract). T062 depends on M12's import service + the loopback seam (see
"Upstream dependency").

### Upstream dependency (read this before starting)

M13 **consumes the M12 local-first import service + the loopback seam**. The roadmap's original
M11/M12 entries are written cloud-first (`apps/worker` + S3); they are **superseded** for the
local-first MVP. The concrete contract M13 relies on — **named, packaged, and signed exactly as
M12 defines it** (this section MUST stay byte-compatible with M12; do not introduce a different
name, package, or signature) — owned and delivered by **M12**, is:

1. **One local import service in the Electron main** — it is named **`UrlImportService`** (NOT
   `ImportService`) and lives in `apps/desktop/src/main/url-import-service.ts`, composing the pure
   **`@interleave/importers`** package (`packages/importers/`, NOT `packages/import`) for the
   HTML→clean-article→PM transform + `canonicalizeUrl` from `@interleave/core` + `AssetRepository`
   for the vault snapshot + `SourceRepository.createWithDocument` for the transactional
   `createSource`. Its **dependencies (the open DB / repositories + the vault `assetsDir`) are
   injected at construction time** (`new UrlImportService({ db, repositories, assetsDir })`) — there
   is **no per-call `ctx`** — so M13's loopback server receives one already-built instance and calls
   its methods directly. M12 threads `assetsDir` into `DbService` (at `open()`/`setPaths()`) and
   exposes a **public `get urlImportService(): UrlImportService` accessor** returning that one built
   instance; M13's `bootstrap()` reads `dbService.urlImportService` and passes it as
   `startCaptureServer({ …, importService })`. Its methods:
   ```ts
   // Fetch-and-import (the renderer "Import from URL" caller):
   importFromUrl(input: {
     url: string;
     priority?: PriorityLabel;          // default "C"
     reasonAdded?: string | null;
     forceNewVersion?: boolean;         // T061 dedup escape hatch
   }): Promise<UrlImportResult>;

   // Capture pre-fetched HTML (the extension's "save page" caller — the worker
   // already has the rendered DOM, which gets past paywalls/JS the bare fetch
   // cannot). SAME Readability→sanitize→snapshot→createSource pipeline, fetch
   // step skipped. Owned and defined by M12 (see its T060 + Downstream notes).
   importFromHtml(input: {
     url: string;
     html: string;
     title?: string | null;
     priority?: PriorityLabel;          // default "C"
     reasonAdded?: string | null;
     accessedAt?: string | null;        // ISO; defaults to "now"
     forceNewVersion?: boolean;
   }): Promise<UrlImportResult>;
   ```
   where the shared result is the **discriminated `UrlImportResult`** M12 defines —
   `{ status: "imported"; id: string; item: InboxItemSummary } | { status: "duplicate"; matches:
   readonly SourceDuplicateSummary[] }` (NOT a `{ deduped: boolean }` shape). Each method runs
   fetch (or uses provided `html`) → Readability/sanitize → write `original.html` + `cleaned.html`
   to `assets/sources/<id>/` via `AssetRepository` (setting `snapshotKey`) → HTML→ProseMirror
   (constrained schema, stable block IDs) → `SourceRepository.createWithDocument` in one
   transaction (`create_source` + `create_element` + `update_document`), landing the source in
   `inbox`/`raw_source` with full provenance. Dedup against `canonicalUrl` (the `"duplicate"` arm)
   is T061.
2. **`window.appApi.sources.importUrl(req)`** — the renderer affordance over the same service
   (added by M12; "Import from URL" in the inbox import strip uses it). M13 does not build the
   renderer affordance; it builds the **second caller**: the loopback server calls
   `UrlImportService` directly (main-side), not through IPC.

If M12 has not yet landed `UrlImportService` when a builder picks up M13, **T062's first
deliverable is to land the minimal `UrlImportService.importFromUrl` + `importFromHtml` + the pure
`@interleave/importers` transforms with fixture tests** (per the M12 spec), since both tasks share
them. Do not duplicate the source/snapshot logic in M13 — both the renderer and the extension
converge on the one service.

**File-ownership contract (so M13 edits, not recreates, the M12 file).** `UrlImportService` lives in
the ONE file `apps/desktop/src/main/url-import-service.ts`, CREATED by M12. M12 ships
`importFromUrl` + `importFromHtml` + the discriminated `UrlImportResult` / `SourceDuplicateSummary`
shapes. **M13 only APPENDS one additive method — `importSelection` — to that existing file**; it does
NOT recreate the file or redefine `importFromUrl`/`importFromHtml`/`UrlImportResult`. A builder
picking up M13 after M12 has landed therefore opens the existing file and adds one method. The
`importFromHtml` signature and the discriminated `UrlImportResult` shape are byte-identical across the
two specs and MUST stay so (if either spec changes one, change both). In the (M12-not-yet-landed)
fallback above, the builder creates the file with `importFromUrl`/`importFromHtml` first, then adds
`importSelection` — still one file, one service.

---

## T062 — Browser extension MVP (local-first capture)

- **Status:** `[ ]`  · **Depends on:** T060, T053 (re-scoped: **depends on the M12 local
  `UrlImportService` + the loopback seam**; the original T053 cloud-auth dependency does not apply
  to the local-first build)
- **Roadmap line:** Done when a Manifest V3 extension can "save page" / "save selection" / "save
  to inbox" via its service worker. (Pivot: the extension sends captures to the **Electron app**;
  it never writes the SQLite DB directly.)

### Goal

A Manifest V3 Chrome extension (new `apps/extension` workspace package) that lets the user, from
the page they are reading, **save the whole page**, **save the current selection**, or **save to
inbox** — and have the capture land in the running Interleave desktop app's **inbox** with full
source lineage, **entirely locally**. The extension's background service worker shapes a capture
message and POSTs it (with the pairing token) to a `127.0.0.1` loopback HTTP capture server mounted
in the Electron main; for a "save page" the Electron side runs the **M12 import pipeline** (fetch +
Readability + snapshot-to-vault + HTML→ProseMirror + `createSource` + `operation_log`) so the saved
page becomes a proper inbox `source`; for a "save selection" it lands a selection capture in the
inbox. The extension shows clear **success / failure / not-running / not-paired** states. The
desktop Settings page shows a random per-install **pairing token** (with copy + regenerate) plus
the server's enabled/running state, which the user pastes into the extension's options page.

### Context to load first

- Reference: [`../architecture.md`](../architecture.md) §Later platforms (the extension "never
  writes the database directly") + the `apps/extension/` monorepo slot;
  [`../domain-model.md`](../domain-model.md) (`source`/`inbox`/`raw_source`, provenance row,
  priority); [`../design-system.md`](../design-system.md) + [`../../design/tokens.css`](../../design/tokens.css)
  for the popup/options pages (browser-side reuse of the design language, not the renderer code).
- Existing code to inspect: the lifecycle (`bootstrap()` + `will-quit` in
  [`../../apps/desktop/src/main/index.ts`](../../apps/desktop/src/main/index.ts)), the IPC
  router/contract/channels seam (for the *pattern* of validated handlers + the new settings
  channels), `SettingsRepository`
  ([`../../packages/local-db/src/settings-repository.ts`](../../packages/local-db/src/settings-repository.ts)),
  the M12 `UrlImportService` (Upstream dependency), `canonicalizeUrl`
  ([`../../packages/core/src/url.ts`](../../packages/core/src/url.ts)),
  `plainTextToProseMirrorDoc` ([`../../packages/core/src/prosemirror.ts`](../../packages/core/src/prosemirror.ts)),
  `SourceRepository.createWithDocument`, the inbox import strip
  ([`../../apps/web/src/pages/inbox/InboxScreen.tsx`](../../apps/web/src/pages/inbox/InboxScreen.tsx))
  + the Settings page ([`../../apps/web/src/pages/Settings.tsx`](../../apps/web/src/pages/Settings.tsx)),
  the workspace + build tooling (`pnpm-workspace.yaml`, [`../../apps/desktop/build.mjs`](../../apps/desktop/build.mjs)).
- Invariants in play: extension/renderer never touch SQLite/Node/`fs`; the loopback server is the
  only new local network surface (`127.0.0.1` only, token-gated, POST-only, Zod-validated, off
  until paired); captures reuse the **existing** source-import pipeline (one transaction +
  `operation_log`); soft-delete only; lineage preserved (a captured page is a clean lineage root
  with provenance + a vault snapshot); default capture priority **`C`** so new material never
  dominates older high-value material.

### Deliverables

- [ ] **New package `packages/capture-contract`** (framework-free, depends only on `zod`) — the
      shared wire contract both the extension **and** the Electron main import, so they agree
      without the extension importing Electron/`packages/local-db`/`@interleave/core`:
  - `CaptureKindSchema = z.enum(["page", "selection"])`.
  - `PriorityLabelSchema = z.enum(["A","B","C","D"])` (a local copy — the extension must not pull
    `@interleave/core`; keep it identical to core's labels).
  - `CapturePageRequestSchema` — `{ kind: "page", url: string (http/https, ≤2048), title?: string
    (≤512), html?: string (≤5_000_000, the page's outerHTML the worker scraped so the main side
    need not re-fetch), priority?: PriorityLabel, reason?: string (≤2048) }`.
  - `CaptureSelectionRequestSchema` — `{ kind: "selection", url: string, title?: string, selection:
    string (1–500_000), priority?: PriorityLabel, reason?: string (≤2048), blockContext?: string
    (≤4000, surrounding text for lineage), accessedAt?: string }`.
  - `CaptureRequestSchema = z.discriminatedUnion("kind", [CapturePageRequestSchema,
    CaptureSelectionRequestSchema])` and the inferred `CaptureRequest` type.
  - `CaptureResponseSchema` / `CaptureResponse` — `{ ok: true, id: string, kind: CaptureKind,
    title: string, deduped: boolean }` on success; the server returns a typed error body
    `{ ok: false, error: "unpaired" | "bad_token" | "bad_origin" | "too_large" | "invalid" |
    "import_failed" }` with the matching HTTP status (see security). **`id`/`title` on a dedup
    hit:** when the import returns the discriminated `{ status: "duplicate", matches }` arm (no
    newly-created source — only for `kind: "page"`, which runs T061 dedup; selections never
    dedup), the success body's `id` echoes the **first match's existing source `elementId`** and
    `title` echoes that **first match's `title`**, with `deduped: true`. (So a `200` is always a
    fully-populated `CaptureResponse` whether the source was freshly created or an existing
    duplicate was reused — see the capture handler's mapping below.)
  - A `PairingPingResponseSchema` for a tiny `GET /ping` health probe (`{ ok: true, app:
    "interleave", version: string }`) the extension uses to detect "app running" **without** a
    token (it reveals nothing sensitive and never mutates).
  - Export everything from `packages/capture-contract/src/index.ts`. Add the package to
    `pnpm-workspace.yaml` coverage (it already globs `packages/*`).
- [ ] **Pure capture-message shaping + validation** in `packages/capture-contract` (so it is
      unit-testable with no Chrome/Electron):
  - `shapeCapture(input): CaptureRequest` — given the raw browser-side inputs (kind, active-tab
    url/title, selection text / page html, priority label, reason), produce a normalized, schema-
    valid `CaptureRequest` (trim, clamp lengths, default priority `C`, drop empty fields). Pure.
  - `validateOrigin(origin: string, allowedExtensionOrigin: string): boolean` — exact-match the
    request `Origin` against the paired extension origin (`chrome-extension://<id>`); used by the
    server's CORS/Origin check. Pure.
  - `timingSafeTokenEqual(a: string, b: string): boolean` — constant-time token comparison
    (length-independent; reject on length mismatch first). Pure (no `node:crypto`; implement a
    constant-time string compare so the module stays importable in the extension build too, though
    only the server uses it).
- [ ] **`apps/extension` workspace package (MV3)** — layout:
  - `apps/extension/package.json` (`name: @interleave/extension`, `private: true`,
    `dependencies: { "@interleave/capture-contract": "workspace:*" }`, scripts `build`/`dev`/
    `typecheck`; **no React, no `@interleave/web`, no Electron**).
  - `apps/extension/manifest.json` — **Manifest V3**:
    - `manifest_version: 3`, `name`, `version`, `description`.
    - `permissions: ["activeTab", "scripting", "contextMenus", "sidePanel", "storage"]`,
      `host_permissions: ["http://127.0.0.1/*"]` (the loopback server origin; **only** loopback —
      no broad host access, no `<all_urls>` host permission beyond what `activeTab`/`scripting`
      grant on the focused tab). **As built (T062):** the manifest also declares `notifications`,
      the smallest reasonable permission for the capture-outcome surfacing this same spec
      anticipates below (`background.ts` calls `chrome.notifications.create` for the
      success ✓ / failure ✕ / "not running" / "not paired" result). It is benign (no host or
      network reach) and still avoids any broad host access.
    - `background: { service_worker: "background.js", type: "module" }`.
    - `action: { default_popup: "popup.html" }` (a tiny popup with Save page / Save selection /
      Save to inbox buttons + status).
    - `options_page: "options.html"` (the pairing page).
    - `side_panel: { default_path: "sidepanel.html" }` (T063 fills it in; T062 ships a minimal
      placeholder so the manifest is valid).
    - `commands` (keyboard): `save-page` (e.g. `Ctrl+Shift+S` / `Command+Shift+S`) and
      `save-selection`.
    - `icons` (and `action.default_icon`): `16`/`32`/`48`/`128` **raster PNGs**. These are a
      **build deliverable** — create the four PNGs under `apps/extension/icons/` (or
      `apps/extension/public/icons/`) and have `build.mjs` copy them into `dist/`. `lucide` is
      React/SVG and **cannot** be a Chrome manifest icon directly, so the manifest references real
      PNG files (derive them from a lucide glyph at build/author time, but the committed artifacts
      are PNGs). The build fails the manifest load if they are missing.
    - **No `content_security_policy` relaxation**; MV3's default CSP (no remote code) stands.
  - `apps/extension/src/background.ts` — the **service worker**: registers a context-menu
    ("Save page to Interleave", "Save selection to Interleave"), the `commands` listeners, and the
    popup-message listener; on a save it (a) reads the paired token + server port from
    `chrome.storage.local`, (b) for a selection uses the value the content script returned / the
    context-menu `info.selectionText`; for a page injects a tiny scrape via `chrome.scripting`
    to grab `document.documentElement.outerHTML` + title + canonical-ish URL, (c) calls
    `shapeCapture(...)`, (d) POSTs to `http://127.0.0.1:<port>/capture` with header
    `Authorization: Bearer <token>` + `Content-Type: application/json`, (e) surfaces the result via
    `chrome.action.setBadgeText` / a notification (success ✓ / failure ✕ / "not running" / "not
    paired"). It must handle a refused connection (app not running) and a `401`/`403` (bad/absent
    token → prompt to re-pair via the options page).
  - The in-page selection reader: on demand returns `window.getSelection().toString()` + a short
    surrounding-text `blockContext` for selection lineage. It runs in the page and does **no**
    network I/O. **As built (T062):** rather than a standing `content.ts` content script declared
    in the manifest, the worker injects this reader on demand via `chrome.scripting.executeScript`
    (`requestSelectionFromContentScript` in `background.ts`) — functionally equivalent, needs only
    `activeTab` + `scripting` (no broad host permission, no `content_scripts` block), and leaves no
    persistent in-page code. A static `content.ts` is an acceptable equivalent if reintroduced.
  - `apps/extension/src/options.ts` + `options.html` — the **pairing page**: a token input
    (paste the desktop's token), an optional port field (default the canonical port), a "Test
    connection" button that hits `GET /ping` then a token-authenticated probe, and clear paired /
    not-paired status. Persists to `chrome.storage.local`. Styled with the design tokens
    (re-declared locally as CSS variables — the extension cannot import `apps/web`).
  - `apps/extension/src/popup.ts` + `popup.html` — the action popup (Save page / Save selection /
    Save to inbox + last-result status + a link to options when unpaired).
  - `apps/extension/src/sidepanel.ts` + `sidepanel.html` — minimal placeholder in T062 (T063 fills
    it in).
  - `apps/extension/build.mjs` — an **esbuild** build (match the desktop's tooling) that bundles
    `background.ts` → `background.js` (ESM, `format: "esm"`, `platform: "browser"`),
    `options.ts`/`popup.ts`/`sidepanel.ts` (and `content.ts` → `content.js` only if a static content
    script is reintroduced — T062 injects the selection reader on demand instead, see above), copies
    the `.html` + `manifest.json` + icons into `apps/extension/dist/`. `pnpm --filter @interleave/extension build`
    produces a **load-unpacked-ready `apps/extension/dist/`**. Document the dev flow (below).
  - `apps/extension/tsconfig.json` with `@types/chrome` (dev dependency) for the WebExtension API.
- [ ] **Loopback capture server** `apps/desktop/src/main/capture-server.ts` — a Node `http` server
      (no Express; the surface is two routes) created and bound by a `startCaptureServer(opts)`
      returning `{ port, stop() }`:
  - Binds to `127.0.0.1` **only** (`server.listen(port, "127.0.0.1")`); never `0.0.0.0`. Uses a
    fixed canonical port (e.g. `47615`) with a small fallback scan if taken. **Strict ordering (so
    `getPairing()` never reports a port the server has not bound):** (1) **bind the socket FIRST**
    — `await` the `listening` event and read the actually-bound port off `server.address()`; (2)
    **THEN persist** the chosen port into settings (`capture.port`); (3) **THEN mark the server
    running** (set the in-memory `running` flag / resolve `startCaptureServer`). Only after all
    three is `{ running: true, port }` observable. **On stop/disable:** set `running = false` and
    **clear `capture.port`** (set it to `null`) so a stopped server never advertises a stale port —
    `getPairing()` then returns `{ running: false, port: null }` consistently. (If you instead
    RETAIN the last port while stopped, `getPairing` MUST still report `running: false` and the
    pairing UI must treat a non-running server as not-reachable regardless of the recorded port —
    but clearing it is the simpler, race-free default; pick one and be consistent.) Reject any
    request whose socket `remoteAddress` is not loopback as defense-in-depth.
  - Routes (POST-only mutation, GET-only probe — everything else → `405`):
    - `GET /ping` → `PairingPingResponse` (unauthenticated; reveals only app name + version).
    - `POST /capture` → the capture handler.
  - **The capture handler** (the testable core lives in a pure
    `apps/desktop/src/main/capture-handler.ts` `handleCapture(rawBody, headers, ctx)` so it is unit-
    tested without binding a socket):
    1. If the server is **not paired** (no token in settings) → `403 { ok:false, error:"unpaired" }`.
    2. **Origin/CORS:** require the `Origin` header to exact-match the paired extension origin via
       `validateOrigin`; set `Access-Control-Allow-Origin` to that exact origin only (never `*`),
       `Access-Control-Allow-Methods: POST`, `Access-Control-Allow-Headers: Authorization,
       Content-Type`; answer `OPTIONS` preflight accordingly. A mismatched/absent Origin →
       `403 { error:"bad_origin" }`.
    3. **Token:** require `Authorization: Bearer <token>`; compare to the stored token with
       `timingSafeTokenEqual`. Mismatch/absent → `401 { error:"bad_token" }`.
    4. **Body size:** cap the request body (e.g. 6 MB hard limit; abort + `413 { error:"too_large"
       }` once exceeded — do not buffer unbounded). Reject non-JSON / `Content-Type` ≠ JSON.
    5. **Validate:** `CaptureRequestSchema.parse(body)`; a Zod failure → `400 { error:"invalid" }`.
    6. **Dispatch into the M12 import service** (NOT SQLite directly), on the single shared,
       construction-injected `UrlImportService` instance: for `kind: "page"` call
       `importService.importFromHtml({ url, html, title, priority, reasonAdded: reason })` (the
       extension already has the rendered DOM, so it uses the **pre-fetched-HTML** entry point M12
       owns — the main side does NOT re-fetch); for `kind: "selection"` call the
       `importService.importSelection({ url, title, selection, priority, reason, blockContext })`
       method (**defined and owned here in M13 — see the `importSelection` deliverable below**),
       which creates an inbox `source` via `SourceRepository.createWithDocument` with the selection
       as the body (`plainTextToProseMirrorDoc`), `originalUrl: url`, `canonicalUrl:
       canonicalizeUrl(url)`, `reasonAdded: reason`, `accessedAt: now` — one transaction,
       `create_source`/`create_element`/`update_document`. Both return the discriminated
       `UrlImportResult` (`{ status: "imported", id, item }` / `{ status: "duplicate", matches }`),
       which the handler maps to the `CaptureResponse` as follows (so the integration test can
       assert `200` + the mapped fields for BOTH arms):
       - `status: "imported"` → `{ ok: true, id: result.id, kind, title: result.item.title,
         deduped: false }`.
       - `status: "duplicate"` (only reachable for `kind: "page"` via T061 — selections never
         dedup) → `{ ok: true, id: result.matches[0].elementId, kind, title:
         result.matches[0].title, deduped: true }` — i.e. echo the **FIRST match's** existing source
         `elementId` as `id` and that match's `title` as `title`. (`matches` is non-empty whenever
         the arm is `"duplicate"`.)
       Keep ALL source creation in the service, never in the server module.
    7. On success → `200 CaptureResponse { ok:true, id, kind, title, deduped }`. On a thrown import
       error → `500 { error:"import_failed" }` (logged main-side, never leaking internals to the
       extension).
  - The handler takes its dependencies (the token getter, the import service, the allowed origin
    getter) by injection so the unit test passes fakes.
- [ ] **`UrlImportService.importSelection` (M13 OWNS and defines this).** M12 ships
      `importFromUrl`/`importFromHtml` (page captures); the **selection** capture path is M13's, so
      define it concretely here as a third method **appended to the existing M12 file**
      `apps/desktop/src/main/url-import-service.ts` (edit, do not recreate — see the File-ownership
      contract in the Upstream-dependency section):
      `importSelection(input: { url: string; title?: string | null; selection: string; priority?:
      PriorityLabel; reasonAdded?: string | null; blockContext?: string | null; accessedAt?: string
      | null }): Promise<UrlImportResult>`. It creates an inbox `source` via
      `SourceRepository.createWithDocument` passing the `selection` as the raw `body` — reusing the
      repo's EXISTING raw-body path, which already runs `plainTextToProseMirrorDoc(body)` to produce
      the constrained-schema doc + stable block ids (no pre-built `conversion` needed) — with
      `status: "inbox"`, `stage: "raw_source"`, the chosen numeric priority (default `C`), `title`
      (or the page host), `url`/`originalUrl: url`, `canonicalUrl: canonicalizeUrl(url)`,
      `accessedAt: now`, and the composed `reasonAdded` — one transaction,
      `create_source`/`create_element`/`update_document`. **No vault snapshot** (a selection is a
      fresh document, not a page snapshot) and **no `source_locations` row** (a selection capture is
      a clean lineage root pointing at no existing source document, so there is nothing to anchor a
      location INTO). `importSelection` **does NOT run T061 canonical-URL/content-hash dedup**
      (distinct selections from the same page are intentionally separate captures, and the body is
      not a page snapshot to hash), so it always returns the `{ status: "imported", … }` arm of
      `UrlImportResult` (the dispatch's `deduped` is therefore always `false` for selections).
  - **`blockContext` storage (no schema change).** `CreateSourceWithDocumentInput` and the `sources`
    table have **no** `blockContext` column, and there is no `source_locations` row to hold it. So
    do **not** add a column or migration: persist the captured `blockContext` (the surrounding-text
    anchor) by **folding it into `reasonAdded`** — `importSelection` composes the stored
    `reasonAdded` as the user's `reason` plus, when `blockContext` is present, an appended
    `"\n\nContext: <blockContext>"` line (the exact composition is the service's; keep it readable).
    This keeps the anchor text durable, searchable, and visible in the inspector's "why added"
    provenance WITHOUT a schema change, and it is honest about lineage: it is anchor text for a
    future jump-to-source, NOT a block-level mapping into a page we never snapshotted. (Block-level
    selection lineage into a live page DOM is out of scope — the captured source is its own
    document.)
- [ ] **Pairing token + server lifecycle (main)** —
  - `apps/desktop/src/main/capture-pairing.ts`: `getOrCreateCaptureToken(settings)` mints a random
    32-byte token (`node:crypto` `randomBytes(32).toString("base64url")`) on first read and
    persists it to settings (`capture.token`); `regenerateCaptureToken(settings)` replaces it;
    `getCaptureEnabled(settings)` / `setCaptureEnabled(...)` read/write `capture.enabled`. **Use the
    raw `SettingsRepository.get`/`set` key/value path** ([`../../packages/local-db/src/settings-repository.ts`](../../packages/local-db/src/settings-repository.ts) ~lines 27/49)
    for all `capture.*` keys — NOT the typed `appApi.settings.updateMany` / the `AppSettings` patch
    layer. The typed `AppSettings` layer in
    [`../../packages/core/src/settings.ts`](../../packages/core/src/settings.ts) only round-trips the
    KNOWN, fixed `SETTINGS_KEYS`: `appSettingsFromStored` (~line 228) reads ONLY those fixed keys (so
    it drops any unknown stored key), and `coerceSettingsPatch` (~line 268, doc-comment "Unknown/extra
    fields are dropped") drops unknown patch fields. So routing the token through the typed patch
    would **silently drop** `capture.token`/`capture.enabled`/`capture.port` (and `settings.getAll()`
    never surfaces them — which is the desired isolation, not a bug). **Decide
    + justify the default:** `capture.enabled` defaults to **`false`** (off until the user opts in
    from the pairing UI) — the server is a network surface, so it must not open on a fresh install
    before the user has chosen to pair. The token is minted lazily so a never-paired install never
    persists one needlessly.
  - **Test opt-in env (`INTERLEAVE_CAPTURE_ENABLED`).** So the Electron integration test can launch
    with the server already on (default is off), add a new opt-in env read in `bootstrap()`, mirroring
    the existing `INTERLEAVE_SEED_ON_EMPTY` / `INTERLEAVE_SUPPRESS_ONBOARDING` reads (index.ts ~lines
    64-84): when `process.env.INTERLEAVE_CAPTURE_ENABLED === "1"`, call `setCaptureEnabled(settings,
    true)` **BEFORE** the conditional "start the server only if `capture.enabled`" check below, so the
    server actually starts in the test. (Order matters: set the flag first, then the start gate reads
    it.) Never affects production.
  - In `bootstrap()` ([`../../apps/desktop/src/main/index.ts`](../../apps/desktop/src/main/index.ts)),
    **after** `registerIpcHandlers` (~line 88), obtain the **single already-built import service** via
    the M12 public accessor — `const importService = dbService.urlImportService` (the SAME instance the
    renderer IPC `importUrl` path uses; M12's DB-service deliverable threads `assetsDir` into
    `DbService` at `open()`/`setPaths()` and exposes this `get urlImportService()` accessor) — and start
    the capture server **only if `capture.enabled`** by calling `startCaptureServer({ dbService, settings,
    importService, getAllowedOrigin })`. Hold the returned handle in a module-scoped `let` (mirroring the
    existing `let disposeIpc` at index.ts ~line 29) and `stop()` it in the existing
    `app.on("will-quit", …)` disposer (index.ts ~line 142, alongside `disposeIpc?.()`) and on disable from
    the IPC command. Starting/stopping on toggle is driven by the new settings command below — flipping
    `capture.enabled` starts or stops the server live (the toggle handler reuses the same
    `dbService.urlImportService` accessor so a live-started server shares the one instance too).
- [ ] **Allowed-origin pairing handshake (how the desktop learns the extension origin to lock
      CORS).** The Origin lockdown above is only enforceable once the desktop KNOWS the extension's
      origin — and a load-unpacked extension's id (hence its `chrome-extension://<id>` origin) is
      assigned by Chrome at install time and differs per machine, so it cannot be hard-coded in the
      manifest or the desktop. Make the **pairing handshake** the primary path:
  - During pairing, the extension's **options page** computes its own origin from
    `chrome.runtime.id` (`chrome-extension://${chrome.runtime.id}`) and **POSTs it to the desktop
    once** as part of the token-authenticated pairing probe — e.g. include `extensionOrigin:
    "chrome-extension://<id>"` in the body of the "Test connection" request (or a dedicated
    `POST /pair` route alongside `/capture`), authenticated by the pasted token.
  - The desktop **stores it** as `capture.allowedOrigin` via the raw
    `SettingsRepository.get`/`set` path (same key/value isolation as `capture.token`), and
    `getAllowedOrigin(settings)` returns the stored value. The server's `validateOrigin` check
    exact-matches each `/capture` request's `Origin` header against it.
  - **Until an origin is stored, the server is unpaired/closed for captures:** `getAllowedOrigin`
    returns `null`, and `/capture` rejects every request with `403 { error: "unpaired" }` (treat a
    missing `capture.allowedOrigin` the same as a missing token — both gate the open). `/ping`
    stays unauthenticated.
  - `capture.getPairing()`'s **`extensionOriginHint`** is exactly this stored
    `capture.allowedOrigin` (so the Settings card can show "Paired with chrome-extension://<id>"),
    `null` when not yet paired. `regenerateToken` and `setEnabled(false)` do not clear it; a future
    "unpair" may.
  - **Alternative (mention, not primary):** pinning a manifest `key` to fix the extension id (so the
    `chrome-extension://<id>` origin is stable and known ahead of time) is acceptable for a packaged
    build, but it does NOT work for load-unpacked dev, so the handshake is the primary path and the
    `key` is an optional production hardening.
- [ ] **IPC contract for pairing** (the desktop renderer needs to read/regenerate the token +
      toggle the server) — add to the shared seam, following the exact existing pattern:
  - [`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts):
    `captureGetPairing: "capture:getPairing"`, `captureRegenerateToken: "capture:regenerateToken"`,
    `captureSetEnabled: "capture:setEnabled"` (mirror the existing `sourcesImportManual` entry at
    channels.ts ~line 26).
  - [`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts): Zod
    request schemas + result types for `capture.getPairing()` → `{ enabled: boolean; running:
    boolean; port: number | null; token: string; extensionOriginHint: string | null }`
    (`extensionOriginHint` is the stored `capture.allowedOrigin` from the pairing handshake — `null`
    until an extension has paired),
    `capture.regenerateToken()` → the new token (+ a note that this **unpairs** existing
    extensions), `capture.setEnabled({ enabled })` → the new running state. Add a `capture` group to
    the `AppApi` interface — insert it next to the existing `settings` group (~line 2446) /
    `sources` group (~line 2501), modeling the readonly group shape on `AppApi.sources` /
    `AppApi.settings`.
  - [`../../apps/desktop/src/main/ipc.ts`](../../apps/desktop/src/main/ipc.ts): one
    `ipcMain.handle` per channel, each `Schema.parse`-ing first (mirror the existing
    `sourcesImportManual` handler's `Schema.parse`-then-route pattern), routing to the
    `capture-pairing` helpers + (for `setEnabled`) starting/stopping the server.
  - [`../../apps/desktop/src/preload/index.ts`](../../apps/desktop/src/preload/index.ts): add a
    `capture: { getPairing, regenerateToken, setEnabled }` block mirroring the existing `sources`
    block (preload/index.ts ~lines 105-107, `sources.importManual` invoking
    `IPC_CHANNELS.sourcesImportManual`).
  - `apps/web/src/lib/appApi.ts`: mirror the three methods on `appApi.capture.*` AND add the
    `readonly capture: { … }` group to the exported `AppApi` interface next to the existing
    `readonly sources` group (appApi.ts ~lines 1507-1508 — `readonly sources: { importManual(...) }`
    is the exact model for the group shape). **The token is only ever read by the trusted desktop
    renderer to display it; the extension obtains it by the user pasting it — there is no IPC path
    that hands the token to a web page.**
- [ ] **Desktop pairing UI** — a "Browser capture" card on the **Settings** screen
      ([`../../apps/web/src/pages/Settings.tsx`](../../apps/web/src/pages/Settings.tsx)): an
      enable/disable toggle (drives `capture.setEnabled`), the running state + port, the **pairing
      token** shown with a copy button and a "Regenerate" button (with a confirm — it unpairs the
      current extension), and short instructions ("Install the Interleave extension, open its
      Options, and paste this token"). Wire the inbox import strip's existing **"Browser capture"**
      entry ([`../../apps/web/src/pages/inbox/InboxScreen.tsx`](../../apps/web/src/pages/inbox/InboxScreen.tsx),
      `IMPORT_OPTS`, the `{ icon: "globe", label: "Browser capture", … }` chip ~line 65) to navigate
      to this Settings card instead of being a dead "coming soon" stub. **Note the concrete
      type/handler change:** `IMPORT_OPTS`'s `action` field is typed `action?: "manual"` (M12 widens
      it to `"manual" | "url"`) and the chip enablement is hard-coded `const enabled = o.action ===
      "manual"` (~lines 55-66 / 469-475) — widen the `action` union further to include `"capture"`
      and extend the enable/click logic so the "Browser capture" chip is enabled and routes to the
      Settings "Browser capture" card (`o.action === "capture" ? navigateToCaptureSettings : …`),
      not the New-source modal.
- [ ] **Tests (unit — `packages/capture-contract`)** —
      `packages/capture-contract/src/capture-contract.test.ts`: `CaptureRequestSchema` accepts valid
      page + selection payloads and rejects malformed ones (missing `url`, bad priority label,
      non-`http(s)` url, oversized selection, unknown `kind`); `shapeCapture` trims/clamps/defaults
      priority `C`/drops empties; `validateOrigin` exact-matches and rejects a near-miss
      (`chrome-extension://abc` vs `chrome-extension://abcd`, a `null`/empty origin, an `http://`
      origin); `timingSafeTokenEqual` is correct + length-mismatch-safe.
- [ ] **Tests (unit — capture handler)** `apps/desktop/src/main/capture-handler.test.ts`: with
      injected fakes (token getter, allowed-origin getter, a fake import service) the pure
      `handleCapture` returns `403 unpaired` when no token, `403 bad_origin` on a wrong Origin,
      `401 bad_token` on a wrong/absent token, `413 too_large` past the cap, `400 invalid` on a bad
      body, and `200` + the fake import result on a valid page **and** a valid selection; it calls
      the import service exactly once with the mapped arguments; it never constructs SQL.
- [ ] **Tests (integration — Electron main + restart)** `tests/electron/capture-server.spec.ts`
      (Playwright-Electron, driving the **main**, not a real Chrome): launch the app against a temp
      data dir with `capture.enabled` pre-set via the new `INTERLEAVE_CAPTURE_ENABLED` opt-in env
      (defined in the lifecycle deliverable above, mirroring the existing `INTERLEAVE_SEED_ON_EMPTY`
      pattern in [`../../apps/desktop/src/main/index.ts`](../../apps/desktop/src/main/index.ts)).
      **Two concrete wiring points the test needs (do both):** (a) the `bootstrap()` env read added in
      the lifecycle deliverable, which must `setCaptureEnabled(true)` BEFORE the conditional
      `startCaptureServer` gate; and (b) a matching typed launch-helper field — add `readonly
      captureEnabled?: boolean` to `LaunchOptions` and inject the env in `launchApp` in
      [`../../tests/electron/launch.ts`](../../tests/electron/launch.ts) (~lines 100-134), exactly as
      `seedOnEmpty` maps to `INTERLEAVE_SEED_ON_EMPTY` (`...(options.captureEnabled ? {
      INTERLEAVE_CAPTURE_ENABLED: "1" } : {})`). The spec passes `launchApp(dataDir, { captureEnabled:
      true })`. Then read the
      token + port via `appApi.capture.getPairing()` (through the renderer); from the test process
      `POST /capture` a `selection` payload to `127.0.0.1:<port>` with the right `Authorization` +
      `Origin` headers and assert `200`; assert a wrong token → `401`, a wrong Origin → `403`, no
      token configured → `403`; assert the captured selection now appears in `appApi.inbox.list()`
      as a `source`; **restart the app against the same data dir** and assert the captured source
      still exists in the inbox/library (survives restart) and the token + port are stable. **Port
      ordering:** assert `getPairing()` reports `{ running: true, port: <bound> }` only once the
      socket is actually bound (the spec's `POST /capture` to that exact port succeeds, proving the
      reported port is the bound one — never a stale/unbound value), per the bind→persist→mark-running
      order in the server deliverable.
- [ ] **Tests (contract)** — extend
      [`../../apps/desktop/src/shared/contract.test.ts`](../../apps/desktop/src/shared/contract.test.ts)
      so each new `capture.*` schema accepts a valid payload and rejects malformed ones.
- [ ] **Fixtures/seed** — seed: no change needed for T062 (captures are exercised by the
      capture-contract unit tests, the `handleCapture` unit tests, and the Electron integration test,
      which create their own data; no seed row is required). Optionally add one extension-captured
      demo source to the seed so the inspector shows capture provenance — nice-to-have, not required.
- [ ] **Docs** — a **manual load-unpacked verification checklist** at
      `apps/extension/README.md` (since Playwright-Electron cannot drive a real Chrome extension —
      see Notes); check the T062 box in [`../roadmap.md`](../roadmap.md) with the commit ref + a
      Progress-log line; note the local-first re-scope of M12/M13.

### Done when

- A Manifest V3 extension (built by `pnpm --filter @interleave/extension build` into
  `apps/extension/dist`, **loadable unpacked** in Chrome) can **save the page**, **save the
  selection**, or **save to inbox** via its background service worker, and the capture lands in the
  running desktop app's **inbox** as a `source` with full provenance + (for a page) a vault snapshot
  + a constrained-schema ProseMirror body with stable block IDs.
- Captures travel **only** over the token-protected `127.0.0.1` loopback capture server, which
  validates the token + Origin + body on every request, exposes **no** generic command surface,
  and is **off until the user pairs** (default `capture.enabled = false`). The extension never
  writes SQLite and never makes a cloud call.
- Every capture reuses the **existing** source-import pipeline (the M12 `UrlImportService` →
  `SourceRepository.createWithDocument`): one transaction, the correct `operation_log` entries
  (`create_source`/`create_element`/`update_document`), default priority `C`, `inbox`/`raw_source`,
  full lineage.
- The desktop **Settings** page shows the pairing token (copy + regenerate) + the server's
  enabled/running state/port; the inbox "Browser capture" entry routes there.
- The Electron integration test proves a token-authenticated `127.0.0.1` POST lands a capture in the
  inbox, rejects bad token / bad Origin / unpaired requests, and the capture **survives an app
  restart**.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass.

### Notes / risks

- **Why a loopback HTTP server and not stdio / a custom protocol?** A browser extension's service
  worker can only reach a local app over `fetch` to `http://127.0.0.1:<port>` (or native messaging,
  which needs a separately-installed host manifest — heavier and OS-specific). Loopback HTTP is the
  standard, debuggable choice; the threat model below is what makes it safe.
- **Full threat model for the loopback server** (specify + honor all of it):
  - **Bind `127.0.0.1` only** — never `0.0.0.0`; reject any non-loopback `remoteAddress`. Other
    machines on the LAN can never reach it.
  - **Random per-install pairing token** (32 bytes, base64url) stored in SQLite settings, surfaced
    in the desktop UI for the user to paste into the extension. Validated on **every** request with
    a **constant-time** compare. Regenerating it unpairs existing extensions.
  - **Origin/CORS lockdown** — `Access-Control-Allow-Origin` echoes the **exact** paired extension
    origin (`chrome-extension://<id>`), never `*`; a mismatched/absent Origin is rejected. The
    desktop learns that origin via the **pairing handshake** (the options page POSTs its
    `chrome.runtime.id`-derived origin during pairing; the desktop stores it as
    `capture.allowedOrigin` and `getAllowedOrigin` returns it) — so until an origin is stored the
    server is unpaired and `/capture` is closed (see the "Allowed-origin pairing handshake"
    deliverable). (Origin alone is spoofable by a native client, which is why the token is the real
    gate; Origin stops a random *web page* from POSTing to the loopback port via the browser.)
  - **POST-only, narrow endpoints** (`/capture` POST + `/ping` GET); everything else → `405`. **No**
    generic command surface, no path that runs SQL or arbitrary code, no file read/write exposed.
  - **Zod-validated payloads**; reject oversized bodies (hard byte cap, abort early) and malformed
    JSON.
  - **Off by default** until the user enables pairing — the server is the only new local network
    surface, so a fresh install opens no port.
- **`capture.token` lives in SQLite settings, not Electron config**, so it is part of the user's
  data dir + backups and survives restart like everything else. It is never handed to a web page —
  only displayed in the trusted desktop renderer; the user transports it by paste. **Store/read it
  (and `capture.enabled`/`capture.port`) via the raw `SettingsRepository.get`/`set` key/value path,
  never the typed `AppSettings` patch (`updateMany`)** — the typed layer (`appSettingsFromStored` /
  `coerceSettingsPatch` in [`../../packages/core/src/settings.ts`](../../packages/core/src/settings.ts))
  only round-trips the known, fixed `SETTINGS_KEYS` and silently drops unknown ones, so the typed path
  would lose the token (and `settings.getAll()` correctly never surfaces these capture-internal keys).
- **The extension must not import `@interleave/core`, `@interleave/local-db`, `apps/web`, or
  Electron.** Its only workspace dependency is `@interleave/capture-contract` (zod-only). This keeps
  the extension bundle clean and the security boundary honest.
- **Testing scope is deliberate.** Playwright-Electron drives the Electron main, **not** a real
  Chrome with the extension loaded, so the extension's own runtime is covered by (1) unit tests of
  the pure shaping/validation in `packages/capture-contract`, (2) unit tests of the pure
  `handleCapture`, (3) an Electron integration test that drives the loopback server exactly as the
  extension would (token + Origin headers) + a restart step, and (4) a **documented manual
  load-unpacked checklist** in `apps/extension/README.md`:
  1. `pnpm --filter @interleave/extension build`.
  2. Chrome → `chrome://extensions` → enable Developer mode → "Load unpacked" → select
     `apps/extension/dist`.
  3. Launch the desktop app (`pnpm dev`); Settings → Browser capture → enable + copy the token.
  4. Extension → Options → paste token + "Test connection" → expect "Paired ✓".
  5. On any article: action popup → "Save page" → expect a success badge and the article appearing
     in the desktop inbox with a snapshot + body.
  6. Select text → context menu "Save selection to Interleave" → expect a selection source in the
     inbox.
  7. Disable capture in Settings → a save now shows "App not running / capture disabled".
- **Deferred:** cloud delivery (the extension talking to a hosted API) — out of scope for the
  local-first MVP; the contract is structured so a future cloud adapter is a second transport behind
  the same `CaptureRequest`. AI summarization of captured pages → later (M-AI). The side-panel
  priority+reason capture is **T063**.
- **Port collision / multiple installs:** the single-instance lock in `index.ts` already prevents
  two app processes; the port-fallback scan handles a stray process holding the canonical port.
  Persist the chosen port in settings so the pairing UI always shows the live one.

---

## T063 — Side-panel capture

- **Status:** `[ ]`  · **Depends on:** T062
- **Roadmap line:** Done when the extension's Side Panel shows inbox/import UI beside the page and
  can save a selection with priority + reason, routed to the Electron app. (Pivot: not direct DB
  writes.)

### Goal

A Chrome **Side Panel** (Side Panel API) that opens beside the page and gives the user a richer
capture surface than the popup: it shows what is currently selected, lets the user pick a
**priority** (A/B/C/D) and type a short **reason** ("why this matters"), and saves the selection
(or the whole page) to the desktop app's **inbox** through the **same loopback capture path** as
T062 — never a direct DB write. It also shows the recent captures / connection status so the panel
reads like a lightweight inbox-side companion to the page. The panel runs in the **browser**, so it
reuses Interleave's **design language** (tokens, type, priority colors, lucide icons) — not the
renderer's React components or `window.appApi`.

### Context to load first

- Reference: [`../design-system.md`](../design-system.md) + [`../../design/tokens.css`](../../design/tokens.css)
  (priority A/B/C/D color tokens, IBM Plex, surfaces/borders) — re-declared as local CSS variables
  in the panel since it cannot import `apps/web`. The kit inbox preview/metadata rail
  ([`../../design/kit/app/screen-inbox.jsx`](../../design/kit/app/screen-inbox.jsx)) is the visual
  reference for the priority chip group + reason field. [`../domain-model.md`](../domain-model.md)
  for priority semantics.
- Existing code to inspect: everything T062 built — the capture contract
  (`packages/capture-contract`, esp. `CaptureSelectionRequestSchema`'s `priority` + `reason`
  fields), the background worker's POST client, the content script's selection+`blockContext`
  return, the loopback handler's selection path (which already maps `priority` + `reason` →
  `SourceRepository.createWithDocument`).
- Invariants in play: the panel routes through the **same** token-protected loopback capture path
  (no new network surface, no direct DB write); priority defaults to `C`; the reason maps to the
  `sources.reason_added` provenance field (lineage-grade "why saved"); selection lineage anchor text
  (`blockContext`) is preserved by being **folded into `reason_added`** by `importSelection` (T062's
  decision — there is no `blockContext` column and no `source_locations` row for a selection
  capture). It is anchor text for a future jump-to-source, NOT a block-level mapping into the page.

### Deliverables

- [ ] **Side Panel UI** `apps/extension/src/sidepanel.ts` + `sidepanel.html` (replace the T062
      placeholder): a panel that
  - shows the active tab's title + url and the **current selection** (subscribing to selection
    changes via a message from the content script, or a "Use current selection" button that pulls
    it on demand);
  - a **priority** chip group (A/B/C/D, default **C**, using the priority color tokens) and a short
    **reason** text input ("Why save this?");
  - **Save selection** and **Save page** buttons that build a `CaptureSelectionRequest` /
    `CapturePageRequest` (with `priority` + `reason`) via `shapeCapture` and send it through the
    **same** background-worker POST path as T062;
  - clear **success / failure / not-running / not-paired** status (reuse the worker's result
    states), and a small **recent captures** list so the panel feels like an inbox companion.
    **Persistence source (concrete):** the **background service worker** appends each SUCCESSFUL
    capture (`{ id, title, kind, timestamp }`, read off the `200` `CaptureResponse`) to a
    **bounded** `recentCaptures` array in `chrome.storage` (`session` or `local`; cap the array,
    e.g. last 20, dropping the oldest) on every `200` response. The Side Panel renders that list by
    **subscribing to `chrome.storage.onChanged`** (reading the initial value on open, then updating
    live as the worker appends) — it does NOT call any loopback read endpoint. (A live inbox-read
    endpoint on the loopback server stays OUT of scope — see Deferred — so the panel shows only its
    own recent captures, not the full desktop inbox.);
  - styled strictly with the local design-token CSS variables (light + dark to match the page/OS),
    `lucide` SVGs inlined (the extension can ship the icon SVGs; it must not import `lucide-react`/
    React). **Comment that this is design-language reuse, not renderer-component reuse.**
- [ ] **Open-the-panel wiring** in `apps/extension/src/background.ts`: register the side panel
      (`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })` + a context-menu /
      command "Open Interleave panel" that calls `chrome.sidePanel.open({ tabId })`), and a
      `commands` entry for it. The action popup gains an "Open side panel" affordance.
- [ ] **Selection-with-priority+reason path** — confirm/extend the T062 loopback handler +
      `UrlImportService.importSelection` so `priority` (label→numeric) and `reason` reach
      `SourceRepository.createWithDocument`: the chosen priority lands as the source's numeric
      priority, and `reason_added` holds the typed reason WITH the `blockContext` anchor text folded
      in (per T062's `importSelection`/`blockContext` storage decision — no `blockContext` column).
      They already flow through `CaptureSelectionRequestSchema`; assert they reach
      `createWithDocument` (priority → numeric, reason+blockContext → `reasonAdded`). No new
      endpoint — the **same** `/capture` route.
- [ ] **Tests (unit)** — extend `packages/capture-contract/src/capture-contract.test.ts`:
      `shapeCapture` for a selection carries `priority` + `reason` through and defaults priority `C`
      when omitted; a too-long reason is clamped/rejected per the schema.
- [ ] **Tests (unit — handler)** — extend `apps/desktop/src/main/capture-handler.test.ts`: a
      selection capture with `priority: "A"` + a `reason` calls the (fake) import service with the
      mapped numeric priority + the reason; assert the mapping label→numeric uses the core helper
      (not a hand-rolled table).
- [ ] **Tests (integration — Electron)** — extend `tests/electron/capture-server.spec.ts`: POST a
      `selection` capture with `priority: "A"`, a `reason`, and a `blockContext` to the loopback
      server; assert the created inbox `source` has the high numeric priority and a `reason_added`
      provenance containing BOTH the typed reason and the folded-in `blockContext` anchor text,
      visible via `appApi.inbox.get()` / the inspector, and survives an app restart.
- [ ] **Fixtures/seed** — seed: no change needed for T063 (the side-panel priority+reason path is
      covered by the extended unit / handler / Electron integration tests, which create their own
      captures; no seed row is required).
- [ ] **Docs** — extend `apps/extension/README.md`'s manual checklist with a side-panel step (open
      panel → select text → set priority A + reason → Save → verify the inbox source has that
      priority + reason); check the T063 box in [`../roadmap.md`](../roadmap.md) + a Progress-log line.

### Done when

- The extension's **Side Panel** opens beside the page, shows the current selection + the active
  tab, lets the user pick a **priority** and type a **reason**, and **saves a selection (or page)**
  to the desktop app's **inbox** through the **same** token-protected loopback capture path — never
  a direct DB write.
- The saved selection becomes an inbox `source` whose numeric **priority** reflects the chosen
  A/B/C/D label and whose **`reason_added`** holds the typed reason WITH the selection lineage
  anchor text (`blockContext`) folded in (no `blockContext` column — see T062) — one transaction +
  the right `operation_log` entries — and it **survives an app restart**.
- The panel uses the Interleave **design language** (tokens/type/priority colors/lucide), reads
  correctly in light + dark, and reuses no renderer React component or `window.appApi`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm e2e --project=electron` pass.

### Notes / risks

- **Panel ≠ renderer.** The single most important constraint: the side panel runs in Chrome, not in
  the Electron renderer. It must not import `apps/web`, `@interleave/core`, `@interleave/local-db`,
  or `window.appApi`. It reuses only the **visual** design system (re-declared CSS variables + the
  priority color tokens from [`../../design/tokens.css`](../../design/tokens.css)) and the
  zod-only `@interleave/capture-contract`. State this explicitly in the panel's source comment.
- **No new network surface.** T063 adds UI + the priority/reason fields on top of T062's single
  `/capture` endpoint; it must **not** add a second server, port, or route. The "richer capture"
  is richer *payload*, not a wider attack surface.
- **Selection lineage:** `blockContext` (surrounding text) is stored — folded into `reason_added`
  by `importSelection`, since there is no `blockContext` column and no `source_locations` row for a
  selection capture (see T062's storage decision) — so a future "jump to source" has anchor text
  even though the extension cannot map into the page's block IDs (the captured source is a fresh
  document, not the live page DOM). This is intentionally anchor text only: keep it honest — do not
  claim block-level lineage into a page we did not snapshot.
- **Deferred:** live two-way sync of the desktop inbox into the panel (the panel shows only its own
  recent captures, not the full inbox — pulling the live inbox would need a read endpoint on the
  loopback server, which is intentionally out of scope to keep the surface minimal); AI summary of
  the selection; multi-selection batching.

---

## Exit criteria for M13

- Both T062 and T063 are `[x]` in [`../roadmap.md`](../roadmap.md) with commit refs + Progress-log
  entries (noting the local-first re-scope of M12/M13).
- A user can install a Manifest V3 Chrome extension (built with `pnpm`, loaded unpacked), pair it
  to the desktop app with a token shown in Settings, and from any page **save the whole article**,
  **save a selection** (with a priority + reason via the **Side Panel**), or **save to inbox** — and
  have it land in the desktop app's **inbox** as a `source` with full lineage, a vault snapshot
  (for pages), a constrained-schema ProseMirror body with stable block IDs, and the chosen
  priority/reason — **entirely locally, with no cloud**.
- Every capture travels **only** over the token-protected, Origin-locked, POST-only, Zod-validated
  `127.0.0.1` loopback capture server (off until paired), reuses the **existing** M12 import service
  + `SourceRepository.createWithDocument` pipeline (one transaction + the right `operation_log`
  entries), and **survives an app restart** (proven by `tests/electron/capture-server.spec.ts`). The
  extension never touches SQLite, Node, or the filesystem; there is no generic command surface and
  no `db.query`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the Electron Playwright E2E are green in CI, and
  the manual load-unpacked checklist in `apps/extension/README.md` is documented and verified once
  by hand.

When M13 is complete, generate `tasks/M14-document-import.md` from the roadmap before starting T064
(PDF import).

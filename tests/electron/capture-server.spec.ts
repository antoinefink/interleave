/**
 * Loopback capture server E2E (T062) — drives the Electron MAIN / loopback HTTP
 * server exactly as the browser extension would, but from the test process (a
 * real Chrome extension CANNOT be Playwright-driven — see apps/extension/README).
 *
 * It proves the whole local-first capture path end to end:
 *
 *   1. the capture server is OFF by default, opened here via the
 *      INTERLEAVE_CAPTURE_ENABLED opt-in env (mirrors INTERLEAVE_SEED_ON_EMPTY);
 *   2. `appApi.capture.getPairing()` reports `{ enabled, running, port }` only once
 *      the socket is actually bound (the POST to that exact port succeeds — the
 *      reported port is the bound one, per the bind→persist→mark-running order);
 *   3. the threat model holds: a wrong token → 401, a wrong Origin → 403,
 *      unpaired (no stored origin) → 403;
 *   4. after the pairing handshake (`POST /pair` with the token + the extension
 *      Origin), a token+Origin-authenticated `POST /capture` of a selection lands
 *      an inbox `source` visible via `appApi.inbox.list()`;
 *   5. after an APP RESTART against the same data dir, the captured source still
 *      exists and the token + port are stable (survives restart).
 */

import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

/** A stable fake extension origin the test pairs with. */
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Launch with the capture server pre-enabled (off by default). */
async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { captureEnabled: true });
}

/** Read the pairing state through the renderer bridge. */
async function getPairing(page: Page): Promise<{
  enabled: boolean;
  running: boolean;
  port: number | null;
  token: string;
  extensionOriginHint: string | null;
}> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      capture: {
        getPairing(): Promise<{
          enabled: boolean;
          running: boolean;
          port: number | null;
          token: string;
          extensionOriginHint: string | null;
        }>;
      };
    };
    return api.capture.getPairing();
  });
}

/** List inbox sources through the bridge. */
async function listInbox(page: Page): Promise<{ id: string; title: string; status: string }[]> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string; title: string; status: string }[] }> };
    };
    const { items } = await api.inbox.list();
    return items;
  });
}

/** Read one inbox source's detail (numeric priority + `reasonAdded` provenance). */
async function inboxGet(
  page: Page,
  id: string,
): Promise<{ priority: number; reasonAdded: string | null } | null> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inbox: {
        get(req: { id: string }): Promise<{
          detail: {
            summary: { priority: number };
            provenance: { reasonAdded: string | null };
          } | null;
        }>;
      };
    };
    const { detail } = await api.inbox.get({ id: elementId });
    if (!detail) return null;
    return {
      priority: detail.summary.priority,
      reasonAdded: detail.provenance.reasonAdded,
    };
  }, id);
}

/**
 * POST a JSON body to the loopback server FROM THE NODE TEST PROCESS (not the
 * renderer), so we control the Authorization + Origin headers exactly like the
 * extension would. Returns the status + parsed JSON body.
 */
async function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

/**
 * GET a path on the loopback server (used to prove a POST-only route rejects the
 * wrong method with 405), mirroring {@link post}'s header control.
 */
async function get(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "GET", headers });
  return { status: res.status };
}

test("the capture server binds, reports a stable port, and gates the threat model", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The renderer surfaces capture.getPairing (no generic db.query).
  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      capture?: { getPairing?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasGetPairing: typeof api?.capture?.getPairing === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasGetPairing).toBe(true);
  expect(surface.hasQuery).toBe(false);

  // Wait for the socket to actually bind (running: true + a real port).
  let pairing = await getPairing(page);
  for (let i = 0; i < 20 && !(pairing.running && pairing.port); i++) {
    await page.waitForTimeout(100);
    pairing = await getPairing(page);
  }
  expect(pairing.enabled).toBe(true);
  expect(pairing.running).toBe(true);
  expect(pairing.port).toBeGreaterThan(0);
  const port = pairing.port as number;
  const token = pairing.token;
  expect(token.length).toBeGreaterThan(20);

  // /ping is unauthenticated and reveals only the app name + version.
  const ping = await fetch(`http://127.0.0.1:${port}/ping`);
  expect(ping.status).toBe(200);
  const pingBody = (await ping.json()) as { ok: boolean; app: string };
  expect(pingBody).toMatchObject({ ok: true, app: "interleave" });

  // Unpaired (no allowed origin yet) → /capture is closed → 403 unpaired.
  const beforePair = await post(
    port,
    "/capture",
    { kind: "selection", url: "https://example.com/a", selection: "x" },
    { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
  );
  expect(beforePair.status).toBe(403);
  expect(beforePair.json.error).toBe("unpaired");

  // Pair: POST the extension origin authenticated by the token.
  const pair = await post(
    port,
    "/pair",
    { extensionOrigin: EXT_ORIGIN },
    {
      Authorization: `Bearer ${token}`,
      Origin: EXT_ORIGIN,
    },
  );
  expect(pair.status).toBe(200);
  expect(pair.json.paired).toBe(true);

  // Wrong token → 401.
  const badToken = await post(
    port,
    "/capture",
    { kind: "selection", url: "https://example.com/a", selection: "x" },
    { Authorization: "Bearer wrong-token", Origin: EXT_ORIGIN },
  );
  expect(badToken.status).toBe(401);
  expect(badToken.json.error).toBe("bad_token");

  // Wrong Origin → 403 bad_origin.
  const badOrigin = await post(
    port,
    "/capture",
    { kind: "selection", url: "https://example.com/a", selection: "x" },
    { Authorization: `Bearer ${token}`, Origin: "chrome-extension://someoneelse" },
  );
  expect(badOrigin.status).toBe(403);
  expect(badOrigin.json.error).toBe("bad_origin");

  await app.close();
});

test("a token+Origin-authenticated selection capture lands an inbox source", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  let pairing = await getPairing(page);
  for (let i = 0; i < 20 && !(pairing.running && pairing.port); i++) {
    await page.waitForTimeout(100);
    pairing = await getPairing(page);
  }
  const port = pairing.port as number;
  const token = pairing.token;

  // The origin paired in the previous launch survives (settings persist), so a
  // capture works immediately. (Re-pair defensively in case ordering differs.)
  await post(
    port,
    "/pair",
    { extensionOrigin: EXT_ORIGIN },
    {
      Authorization: `Bearer ${token}`,
      Origin: EXT_ORIGIN,
    },
  );
  expect(pairing.extensionOriginHint).toBe(EXT_ORIGIN);

  const capture = await post(
    port,
    "/capture",
    {
      kind: "selection",
      url: "https://example.com/spacing",
      title: "The Spacing Effect",
      selection: "Distributed practice beats cramming for durable retention.",
      priority: "A",
      reason: "core idea",
      blockContext: "The classic forgetting curve shows retention falls off exponentially.",
    },
    { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
  );
  expect(capture.status).toBe(200);
  expect(capture.json.ok).toBe(true);
  expect(capture.json.kind).toBe("selection");
  expect(capture.json.deduped).toBe(false);
  const capturedId = capture.json.id as string;
  expect(typeof capturedId).toBe("string");

  // The captured selection now appears in the inbox as a source.
  const items = await listInbox(page);
  const found = items.find((i) => i.id === capturedId);
  expect(found).toBeTruthy();
  expect(found?.title).toBe("The Spacing Effect");

  // T063: the chosen priority A maps to the high numeric priority, and the
  // `reason_added` provenance carries BOTH the typed reason AND the folded-in
  // blockContext anchor text (no `blockContext` column — see T062's decision).
  const detail = await inboxGet(page, capturedId);
  expect(detail).toBeTruthy();
  // priorityFromLabel("A") === 0.875 (core's A/B/C/D → numeric mapping).
  expect(detail?.priority).toBeCloseTo(0.875, 5);
  expect(detail?.reasonAdded).toContain("core idea");
  expect(detail?.reasonAdded).toContain(
    "The classic forgetting curve shows retention falls off exponentially.",
  );

  await app.close();
});

test("open-source opens and activates a captured inbox source", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  let pairing = await getPairing(page);
  for (let i = 0; i < 20 && !(pairing.running && pairing.port); i++) {
    await page.waitForTimeout(100);
    pairing = await getPairing(page);
  }
  const port = pairing.port as number;
  const token = pairing.token;

  const before = await listInbox(page);
  const captured = before.find((i) => i.title === "The Spacing Effect");
  expect(captured).toBeTruthy();
  expect(captured?.status).toBe("inbox");

  const opened = await post(
    port,
    "/open-source",
    { id: captured?.id },
    { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
  );

  expect(opened.status).toBe(200);
  expect(opened.json).toMatchObject({ ok: true, id: captured?.id, activated: true });
  await expect(page).toHaveURL(new RegExp(`/source/${captured?.id}$`));

  const after = await listInbox(page);
  expect(after.find((i) => i.id === captured?.id)).toBeUndefined();

  await app.close();
});

test("the captured source survives an app restart; token + port stay stable", async () => {
  // Capture the token/port BEFORE restart.
  const app1 = await launch();
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");
  let p1 = await getPairing(page1);
  for (let i = 0; i < 20 && !(p1.running && p1.port); i++) {
    await page1.waitForTimeout(100);
    p1 = await getPairing(page1);
  }
  const tokenBefore = p1.token;
  const captured = await page1.evaluate(() => {
    const api = window.appApi as unknown as {
      library: {
        browse(req: { types: ["source"]; limit: number }): Promise<{
          items: { id: string; priority: number; status: string; title: string; type: string }[];
        }>;
      };
    };
    return api.library
      .browse({ types: ["source"], limit: 500 })
      .then((result) => result.items.find((row) => row.title === "The Spacing Effect") ?? null);
  });
  expect(captured).toBeTruthy();
  await app1.close();

  // Restart against the SAME data dir.
  const app2 = await launch();
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  let p2 = await getPairing(page2);
  for (let i = 0; i < 20 && !(p2.running && p2.port); i++) {
    await page2.waitForTimeout(100);
    p2 = await getPairing(page2);
  }

  // The token is stable across restart (stored in SQLite settings + backups).
  expect(p2.token).toBe(tokenBefore);
  // The paired origin also persisted.
  expect(p2.extensionOriginHint).toBe(EXT_ORIGIN);

  // The captured selection source still exists after restart.
  const stillThere = await page2.evaluate((id) => {
    const api = window.appApi as unknown as {
      library: {
        browse(req: { types: ["source"]; limit: number }): Promise<{
          items: { id: string; priority: number; status: string; title: string; type: string }[];
        }>;
      };
    };
    return api.library
      .browse({ types: ["source"], limit: 500 })
      .then((result) => result.items.find((row) => row.id === id) ?? null);
  }, captured?.id);
  expect(stillThere).toBeTruthy();
  expect(stillThere?.title).toBe("The Spacing Effect");

  // T063: the chosen priority survives the restart even after /open-source moved
  // the source out of Inbox.
  expect(stillThere?.priority).toBeCloseTo(0.875, 5);
  expect(stillThere?.status).toBe("active");

  await app2.close();
});

/**
 * U6 — `/lookup-source` end-to-end parity coverage.
 *
 * The pre-save "already saved" hint (`POST /lookup-source`) is a READ-ONLY
 * loopback question the popup asks on open. It reuses the EXACT canonical-URL
 * dedup query that save-time page-dedup (T061) uses, so this suite proves, over
 * the real Electron loopback server, that the pre-save answer AGREES with the
 * save-time `deduped` outcome for the same URL (same source id) — pre-save ==
 * save-time, end to end — and that the route enforces the identical threat model
 * as `/open-source`.
 *
 * It owns its OWN data dir (separate from the capture suite above) so the inbox
 * state under test is deterministic and not entangled with that suite's source.
 */
test.describe("lookup-source pre-save / save-time parity", () => {
  test.describe.configure({ mode: "serial" });

  let lookupDataDir: string;

  test.beforeAll(() => {
    lookupDataDir = makeDataDir();
  });

  /** Launch this suite's app against its own data dir, capture server pre-enabled. */
  async function launchLookup(): Promise<ElectronApplication> {
    return launchApp(lookupDataDir, { captureEnabled: true });
  }

  /** Bring up the app, wait for the bound port, and ensure the EXT origin is paired. */
  async function bootPaired(): Promise<{
    app: ElectronApplication;
    page: Page;
    port: number;
    token: string;
  }> {
    const app = await launchLookup();
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    let pairing = await getPairing(page);
    for (let i = 0; i < 20 && !(pairing.running && pairing.port); i++) {
      await page.waitForTimeout(100);
      pairing = await getPairing(page);
    }
    const port = pairing.port as number;
    const token = pairing.token;

    // Pair the extension origin (idempotent — survives restart, re-pair defensively).
    await post(
      port,
      "/pair",
      { extensionOrigin: EXT_ORIGIN },
      { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
    );

    return { app, page, port, token };
  }

  test("a captured page is found pre-save with the SAME id /capture echoes; re-capture dedups to it", async () => {
    const { app, port, token } = await bootPaired();

    const url = "https://example.com/lookup-parity/spacing-effect";

    // Capture the whole page → lands a fresh inbox source (deduped: false).
    const capture = await post(
      port,
      "/capture",
      {
        kind: "page",
        url,
        title: "The Spacing Effect (page)",
        html: "<html><head><title>The Spacing Effect</title></head><body><p>Distributed practice beats cramming.</p></body></html>",
        priority: "B",
        reason: "lookup parity fixture",
      },
      { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
    );
    expect(capture.status).toBe(200);
    expect(capture.json.ok).toBe(true);
    expect(capture.json.kind).toBe("page");
    expect(capture.json.deduped).toBe(false);
    const capturedId = capture.json.id as string;
    expect(typeof capturedId).toBe("string");

    // PRE-SAVE: /lookup-source for the same URL → found:true with the SAME id.
    const lookup = await post(
      port,
      "/lookup-source",
      { url },
      { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
    );
    expect(lookup.status).toBe(200);
    expect(lookup.json.ok).toBe(true);
    expect(lookup.json.found).toBe(true);
    const source = lookup.json.source as { id: string; title: string; status: string };
    expect(source.id).toBe(capturedId);
    expect(source.title).toBe("The Spacing Effect (page)");
    expect(source.status).toBe("inbox");

    // SAVE-TIME: re-capture the same URL → deduped:true echoing the SAME id.
    const recapture = await post(
      port,
      "/capture",
      {
        kind: "page",
        url,
        title: "The Spacing Effect (page)",
        html: "<html><head><title>The Spacing Effect</title></head><body><p>Distributed practice beats cramming.</p></body></html>",
      },
      { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
    );
    expect(recapture.status).toBe(200);
    expect(recapture.json.ok).toBe(true);
    expect(recapture.json.deduped).toBe(true);
    expect(recapture.json.id).toBe(capturedId);

    // The pre-save id == the save-time deduped id == the originally captured id.
    expect(source.id).toBe(recapture.json.id);

    await app.close();
  });

  test("a never-saved URL is found:false pre-save and dedups:false at save time (negative parity)", async () => {
    const { app, port, token } = await bootPaired();

    const url = "https://example.com/lookup-parity/never-saved-page";

    // PRE-SAVE: nothing under this URL → found:false, no `source`.
    const lookup = await post(
      port,
      "/lookup-source",
      { url },
      { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
    );
    expect(lookup.status).toBe(200);
    expect(lookup.json.ok).toBe(true);
    expect(lookup.json.found).toBe(false);
    expect(lookup.json.source).toBeUndefined();

    // SAVE-TIME: the first capture of that URL is NOT a dedup.
    const capture = await post(
      port,
      "/capture",
      {
        kind: "page",
        url,
        title: "A Brand New Page",
        html: "<html><head><title>A Brand New Page</title></head><body><p>Fresh content.</p></body></html>",
      },
      { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
    );
    expect(capture.status).toBe(200);
    expect(capture.json.ok).toBe(true);
    expect(capture.json.deduped).toBe(false);

    await app.close();
  });

  test("the /lookup-source threat model matches /open-source", async () => {
    // A FRESH data dir so we can probe the UNPAIRED state (no stored origin yet).
    const freshDir = makeDataDir();
    const app = await launchApp(freshDir, { captureEnabled: true });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    let pairing = await getPairing(page);
    for (let i = 0; i < 20 && !(pairing.running && pairing.port); i++) {
      await page.waitForTimeout(100);
      pairing = await getPairing(page);
    }
    const port = pairing.port as number;
    const token = pairing.token;

    const body = { url: "https://example.com/lookup-parity/threat" };

    // Unpaired (no allowed origin yet) → 403 unpaired.
    const unpaired = await post(port, "/lookup-source", body, {
      Authorization: `Bearer ${token}`,
      Origin: EXT_ORIGIN,
    });
    expect(unpaired.status).toBe(403);
    expect(unpaired.json.error).toBe("unpaired");

    // Pair the extension origin so the remaining cases reach the authed branch.
    const pair = await post(
      port,
      "/pair",
      { extensionOrigin: EXT_ORIGIN },
      { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
    );
    expect(pair.status).toBe(200);

    // Bad origin → 403 bad_origin.
    const badOrigin = await post(port, "/lookup-source", body, {
      Authorization: `Bearer ${token}`,
      Origin: "chrome-extension://someoneelse",
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.json.error).toBe("bad_origin");

    // Bad token → 401 bad_token.
    const badToken = await post(port, "/lookup-source", body, {
      Authorization: "Bearer wrong-token",
      Origin: EXT_ORIGIN,
    });
    expect(badToken.status).toBe(401);
    expect(badToken.json.error).toBe("bad_token");

    // Oversized body (> the 6 MiB hard cap) → 413 too_large is covered by the
    // in-process unit test (capture-server.test.ts). It is deliberately NOT
    // asserted here: `readBody` calls `req.destroy()` past the cap, which races
    // the 413 write over a real socket (the client sees ECONNRESET, not a clean
    // 413) — the same reason the /capture e2e threat-model test omits it.

    // Non-JSON / invalid body → 400 invalid. (Raw POST so we control the body bytes.)
    const invalidRes = await fetch(`http://127.0.0.1:${port}/lookup-source`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Origin: EXT_ORIGIN,
      },
      body: "not json at all",
    });
    expect(invalidRes.status).toBe(400);
    expect(((await invalidRes.json()) as { error: string }).error).toBe("invalid");

    // A well-formed JSON body that violates the schema (missing `url`) → 400 invalid.
    const missingUrl = await post(
      port,
      "/lookup-source",
      { notUrl: "https://example.com/x" },
      { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
    );
    expect(missingUrl.status).toBe(400);
    expect(missingUrl.json.error).toBe("invalid");

    // Wrong method (GET on a POST-only route) → 405.
    const wrongMethod = await get(port, "/lookup-source", {
      Authorization: `Bearer ${token}`,
      Origin: EXT_ORIGIN,
    });
    expect(wrongMethod.status).toBe(405);

    await app.close();
  });

  test("a non-http(s) URL in the body resolves to found:false (not a 400) — guards KTD3", async () => {
    const { app, port, token } = await bootPaired();

    // The request schema is permissive; canonicalization (not the schema) gates the
    // URL, so a non-http(s) value resolves to found:false rather than rejecting.
    const lookup = await post(
      port,
      "/lookup-source",
      { url: "chrome://extensions" },
      { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
    );
    expect(lookup.status).toBe(200);
    expect(lookup.json.ok).toBe(true);
    expect(lookup.json.found).toBe(false);
    expect(lookup.json.source).toBeUndefined();

    await app.close();
  });

  test("a captured page is still found:true after an app restart", async () => {
    const restartDir = makeDataDir();
    const url = "https://example.com/lookup-parity/survives-restart";

    // First launch: pair + capture the page.
    const app1 = await launchApp(restartDir, { captureEnabled: true });
    const page1 = await app1.firstWindow();
    await page1.waitForLoadState("domcontentloaded");
    let p1 = await getPairing(page1);
    for (let i = 0; i < 20 && !(p1.running && p1.port); i++) {
      await page1.waitForTimeout(100);
      p1 = await getPairing(page1);
    }
    const port1 = p1.port as number;
    const token1 = p1.token;
    await post(
      port1,
      "/pair",
      { extensionOrigin: EXT_ORIGIN },
      { Authorization: `Bearer ${token1}`, Origin: EXT_ORIGIN },
    );
    const capture = await post(
      port1,
      "/capture",
      {
        kind: "page",
        url,
        title: "Survives Restart",
        html: "<html><head><title>Survives Restart</title></head><body><p>Persisted.</p></body></html>",
      },
      { Authorization: `Bearer ${token1}`, Origin: EXT_ORIGIN },
    );
    expect(capture.status).toBe(200);
    const capturedId = capture.json.id as string;
    await app1.close();

    // Relaunch against the SAME data dir (token + paired origin persist).
    const app2 = await launchApp(restartDir, { captureEnabled: true });
    const page2 = await app2.firstWindow();
    await page2.waitForLoadState("domcontentloaded");
    let p2 = await getPairing(page2);
    for (let i = 0; i < 20 && !(p2.running && p2.port); i++) {
      await page2.waitForTimeout(100);
      p2 = await getPairing(page2);
    }
    const port2 = p2.port as number;
    const token2 = p2.token;
    expect(p2.extensionOriginHint).toBe(EXT_ORIGIN);

    // The lookup still reports the same persisted source after restart.
    const lookup = await post(
      port2,
      "/lookup-source",
      { url },
      { Authorization: `Bearer ${token2}`, Origin: EXT_ORIGIN },
    );
    expect(lookup.status).toBe(200);
    expect(lookup.json.found).toBe(true);
    expect((lookup.json.source as { id: string }).id).toBe(capturedId);

    await app2.close();
  });

  test("a soft-deleted source is no longer found (matches the deleted_at IS NULL dedup filter)", async () => {
    const { app, page, port, token } = await bootPaired();

    const url = "https://example.com/lookup-parity/soft-delete";

    // Capture a page, confirm it is found pre-save.
    const capture = await post(
      port,
      "/capture",
      {
        kind: "page",
        url,
        title: "To Be Trashed",
        html: "<html><head><title>To Be Trashed</title></head><body><p>Doomed.</p></body></html>",
      },
      { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
    );
    expect(capture.status).toBe(200);
    const capturedId = capture.json.id as string;

    const before = await post(
      port,
      "/lookup-source",
      { url },
      { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
    );
    expect(before.json.found).toBe(true);
    expect((before.json.source as { id: string }).id).toBe(capturedId);

    // Soft-delete the source through the typed bridge (the SAME mutation the UI
    // uses for a lineage-aware delete — moves it to the trash, deleted_at set).
    await page.evaluate(async (id) => {
      const api = window.appApi as unknown as {
        elements: {
          softDeleteSubtree(req: {
            id: string;
            includeSubtree?: boolean;
          }): Promise<{ affected: readonly string[] }>;
        };
      };
      await api.elements.softDeleteSubtree({ id, includeSubtree: true });
    }, capturedId);

    // The dedup query filters `deleted_at IS NULL`, so the trashed source no
    // longer reports saved (consistent with save-time re-import behavior).
    const after = await post(
      port,
      "/lookup-source",
      { url },
      { Authorization: `Bearer ${token}`, Origin: EXT_ORIGIN },
    );
    expect(after.status).toBe(200);
    expect(after.json.found).toBe(false);
    expect(after.json.source).toBeUndefined();

    await app.close();
  });
});

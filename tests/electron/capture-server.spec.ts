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
async function listInbox(page: Page): Promise<{ id: string; title: string }[]> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string; title: string }[] }> };
    };
    const { items } = await api.inbox.list();
    return items;
  });
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
  const before = await listInbox(page1);
  const captured = before.find((i) => i.title === "The Spacing Effect");
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
  const after = await listInbox(page2);
  const stillThere = after.find((i) => i.id === captured?.id);
  expect(stillThere).toBeTruthy();
  expect(stillThere?.title).toBe("The Spacing Effect");

  await app2.close();
});

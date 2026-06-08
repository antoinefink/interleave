/**
 * In-review card repair (T038) E2E — drives the real Electron app.
 *
 * The `/review` repair row (Edit / Open source / Add context / Suspend / Flag /
 * Delete) lets the user fix a bad card the MOMENT it fails, without leaving
 * review. This spec launches the built desktop app against a fresh data dir seeded
 * with the shared demo collection (a due Q&A card + an un-due cloze card) and
 * asserts:
 *
 *   1. the `cards.*` repair bridge surface exists (update / suspend / delete / flag)
 *      and there is no generic `db.query`;
 *   2. in review, EDIT a card's answer → Done flushes the autosaved edit, it is
 *      persisted (re-read through the bridge), and SURVIVES an app restart;
 *   3. FLAG a card as bad → the flag persists, rides the review card view, and
 *      survives an app restart;
 *   4. OPEN SOURCE → navigates to the originating source reader (lineage jump-back);
 *   5. SUSPEND a card → it leaves the due deck (no longer surfaced) and stays out
 *      after restart.
 *
 * The seed's Q&A card is due `2026-06-03`, so the screen + bridge are driven with a
 * fixed FUTURE `asOf` so it reads as due deterministically. The destructive suspend
 * test gets its OWN data dir (the deck has a single due card); the non-destructive
 * edit/flag/open-source tests share one dir (none removes the card from the deck).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

/** The shared dir for the non-destructive edit/flag/open-source tests. */
let dataDir: string;
/** The renderer base URL (`app://bundle`), captured from the first window. */
let baseUrl: string;

/** A fixed future clock so the seeded near-future card due reads as due. */
const AS_OF = "2027-06-01T12:00:00.000Z";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Open `/review` (date-scoped via `?asOf=`) and wait for it to render. */
async function openReview(page: Page, asOf: string): Promise<void> {
  await page.goto(`${baseUrl}/review?asOf=${encodeURIComponent(asOf)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-review")).toBeVisible();
}

async function revealForRepair(page: Page): Promise<void> {
  await page.getByTestId("review-reveal").click();
  await expect(page.getByTestId("review-answer")).toBeVisible();
  await expect(page.getByTestId("review-repair-edit")).toBeVisible();
}

/** The due card (id + kind + body + flag) via the session bridge, or null. */
async function dueCardView(
  page: Page,
  asOf: string,
): Promise<{
  id: string;
  kind: string;
  answer: string | null;
  cloze: string | null;
  flagged: boolean;
} | null> {
  return page.evaluate(async (clock) => {
    const api = window.appApi as unknown as {
      review: {
        sessionNext(req: { asOf: string }): Promise<{
          card: {
            id: string;
            kind: string;
            answer: string | null;
            cloze: string | null;
            flagged: boolean;
          } | null;
        }>;
      };
    };
    const res = await api.review.sessionNext({ asOf: clock });
    return res.card
      ? {
          id: res.card.id,
          kind: res.card.kind,
          answer: res.card.answer,
          cloze: res.card.cloze,
          flagged: res.card.flagged,
        }
      : null;
  }, asOf);
}

/** A card's lifecycle status via the inspector. */
async function cardStatus(page: Page, cardId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{ data: { element: { status: string } } | null }>;
      };
    };
    const insp = await api.inspector.get({ id });
    return insp.data?.element.status ?? "missing";
  }, cardId);
}

test("the cards.* repair bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      cards?: { update?: unknown; suspend?: unknown; delete?: unknown; flag?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasUpdate: typeof api?.cards?.update === "function",
      hasSuspend: typeof api?.cards?.suspend === "function",
      hasDelete: typeof api?.cards?.delete === "function",
      hasFlag: typeof api?.cards?.flag === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasUpdate).toBe(true);
  expect(surface.hasSuspend).toBe(true);
  expect(surface.hasDelete).toBe(true);
  expect(surface.hasFlag).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("editing a card's body in review persists and survives a restart", async () => {
  let cardId = "";
  let kind = "";
  const newAnswer = "Edited at the moment of failure — skill-acquisition efficiency.";
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const card = await dueCardView(page, AS_OF);
    if (!card) throw new Error("no due card");
    cardId = card.id;
    kind = card.kind;

    await openReview(page, AS_OF);
    await expect(page.getByTestId("review-card")).toBeVisible();
    await revealForRepair(page);

    await page.getByTestId("review-repair-edit").click();
    if (kind === "cloze") {
      await page
        .getByTestId("review-edit-cloze")
        .fill("Intelligence is {{c1::edited efficiency}}.");
    } else {
      await page.getByTestId("review-edit-answer").fill(newAnswer);
    }
    await page.getByTestId("review-edit-done").click();
    await expect(page.getByTestId("review-edit")).toHaveCount(0);

    // The edit is persisted (read back through the session bridge).
    const persisted = await dueCardView(page, AS_OF);
    if (kind === "cloze") {
      expect(persisted?.cloze).toContain("edited efficiency");
    } else {
      expect(persisted?.answer).toBe(newAnswer);
    }
    await app.close();
  }

  // Restart against the SAME data dir — the edit is read back from SQLite.
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const after = await dueCardView(page, AS_OF);
    expect(after?.id).toBe(cardId);
    if (kind === "cloze") {
      expect(after?.cloze).toContain("edited efficiency");
    } else {
      expect(after?.answer).toBe(newAnswer);
    }
    await app.close();
  }
});

test("flagging a card as bad persists and survives an app restart", async () => {
  let cardId = "";
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const card = await dueCardView(page, AS_OF);
    if (!card) throw new Error("no due card");
    cardId = card.id;

    await openReview(page, AS_OF);
    await expect(page.getByTestId("review-card")).toBeVisible();
    await revealForRepair(page);

    await page.getByTestId("review-repair-flag").click();
    await expect(page.getByTestId("review-repair-flag")).toHaveText(/flagged/i);

    expect((await dueCardView(page, AS_OF))?.flagged).toBe(true);
    await app.close();
  }

  // Restart — the flag is read back from the op-log.
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const after = await dueCardView(page, AS_OF);
    expect(after?.id).toBe(cardId);
    expect(after?.flagged).toBe(true);
    await app.close();
  }
});

test("open source jumps back to the originating source reader (lineage)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openReview(page, AS_OF);
  await expect(page.getByTestId("review-card")).toBeVisible();
  await revealForRepair(page);

  const openBtn = page.getByTestId("review-repair-source");
  await expect(openBtn).toBeEnabled();
  await openBtn.click();

  // The reader route opened for the originating source (lineage jump-back).
  await page.waitForURL(/\/source\//, { timeout: 5000 });
  expect(page.url()).toMatch(/\/source\//);

  await app.close();
});

test("suspending a card removes it from the live deck (own dir; survives restart)", async () => {
  const suspendDir = makeDataDir();
  let cardId = "";
  {
    const app = await launchApp(suspendDir, { seedOnEmpty: true });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const url = new URL(page.url());
    baseUrl = `${url.protocol}//${url.host}`;

    const card = await dueCardView(page, AS_OF);
    if (!card) throw new Error("no due card");
    cardId = card.id;

    await openReview(page, AS_OF);
    await expect(page.getByTestId("review-card")).toBeVisible();
    await revealForRepair(page);
    await page.getByTestId("review-repair-suspend").click();
    await page.waitForTimeout(250);

    // The suspended card is no longer the current due card.
    const current = await page.evaluate(
      () =>
        document.querySelector('[data-testid="review-card"]')?.getAttribute("data-card-id") ?? null,
    );
    expect(current).not.toBe(cardId);
    expect(await cardStatus(page, cardId)).toBe("suspended");
    // The deck no longer surfaces it.
    expect((await dueCardView(page, AS_OF))?.id ?? null).not.toBe(cardId);
    await app.close();
  }

  // Restart — the card stays suspended + out of the deck.
  {
    const app = await launchApp(suspendDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    expect(await cardStatus(page, cardId)).toBe("suspended");
    expect((await dueCardView(page, AS_OF))?.id ?? null).not.toBe(cardId);
    await app.close();
  }
});

/**
 * Leech remediation workflow (T085) E2E — drives the real Electron app.
 *
 * Promotes the minimal T040 cleanup view into the full repair workflow. This spec
 * launches the built desktop app against a fresh data dir seeded with the shared demo
 * collection, authors leech cards from a seeded extract (so each carries a real parent
 * extract + source-location anchor), opens `/maintenance/leeches`, and exercises the
 * NEW compositions end to end:
 *
 *   1. the `cards.split` / `cards.addContext` / `cards.backToExtract` bridge surface
 *      exists (no raw SQL);
 *   2. a leech card shows with its lapse count + the FULL action row;
 *   3. SPLIT it into two atomic cards → the two new sibling cards exist (lineage
 *      preserved) and the original is gone from the leech list;
 *   4. BACK TO EXTRACT on a second leech → its parent extract is reactivated (due-now,
 *      attention) and the card is suspended;
 *   5. LOWER PRIORITY on a third → its numeric priority drops;
 *   6. it SURVIVES AN APP RESTART — the split cards, the rescheduled extract, the
 *      lowered priority, and the suspension all persist (computed from durable tables).
 *
 * The seed clock is 2026; a fixed FUTURE `asOf` makes the seeded cards read as due.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Open the leech remediation view and wait for it to render. */
async function openRemediation(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/maintenance/leeches`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-leech-cleanup")).toBeVisible();
}

/**
 * Author a fresh card from the seeded extract (it has a valid source location + is a
 * live `extract` parent) and drive it past 4 lapses through the typed bridge so it
 * becomes a leech. Returns the new card id + its parent extract id.
 */
async function makeFreshLeech(
  page: Page,
  body: { prompt: string; answer: string },
): Promise<{ cardId: string; extractId: string }> {
  return page.evaluate(async (b) => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
      cards: {
        create(req: {
          extractId: string;
          kind: string;
          prompt: string;
          answer: string;
        }): Promise<{ card: { id: string; parentId: string | null } }>;
      };
      review: {
        grade(req: {
          cardId: string;
          rating: string;
          responseMs: number;
          asOf: string;
        }): Promise<{ reviewState: { dueAt: string | null; lapses: number } }>;
      };
    };

    const { elements } = await api.inspector.list();
    const extract = elements.find((e) => e.type === "extract");
    if (!extract) throw new Error("no seeded extract");
    const { card } = await api.cards.create({
      extractId: extract.id,
      kind: "qa",
      prompt: b.prompt,
      answer: b.answer,
    });

    let clock = Date.parse("2027-06-02T00:00:00.000Z");
    const grade = async (rating: string) => {
      const at = new Date(clock).toISOString();
      const res = await api.review.grade({ cardId: card.id, rating, responseMs: 4000, asOf: at });
      clock = res.reviewState.dueAt
        ? Date.parse(res.reviewState.dueAt) + 86_400_000
        : clock + 86_400_000;
    };
    await grade("easy"); // new → review
    for (let i = 0; i < 4; i++) {
      await grade("again");
      if (i < 3) await grade("good");
    }
    return { cardId: card.id, extractId: card.parentId ?? extract.id };
  }, body);
}

test("the remediation bridge surface exists (split / addContext / backToExtract, no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      cards?: { split?: unknown; addContext?: unknown; backToExtract?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasSplit: typeof api?.cards?.split === "function",
      hasAddContext: typeof api?.cards?.addContext === "function",
      hasBackToExtract: typeof api?.cards?.backToExtract === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasSplit).toBe(true);
  expect(surface.hasAddContext).toBe(true);
  expect(surface.hasBackToExtract).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("add context: the saved note is surfaced as a context line and re-appears after refresh", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Author a fresh leech off the seeded extract.
  const { cardId } = await makeFreshLeech(page, {
    prompt: "An under-specified leech that needs context?",
    answer: "Disambiguated.",
  });

  await openRemediation(page);
  const card = page.locator(`[data-testid="leech-card"][data-card-id="${cardId}"]`);
  await expect(card).toBeVisible();
  // No context line before a note is added.
  await expect(card.getByTestId("leech-card-context")).toHaveCount(0);

  // Add a clarifying context note via the inline editor.
  const note = "Refers specifically to the ARC-AGI benchmark, not ARC the format.";
  await card.getByTestId("leech-add-context").click();
  await card.getByTestId("leech-context-note").fill(note);
  await card.getByTestId("leech-context-save").click();

  // After the editor closes and the list refreshes, the note is SURFACED on the card
  // (the deliverable's purpose — the note is not merely logged + then lost from view).
  const refreshed = page.locator(`[data-testid="leech-card"][data-card-id="${cardId}"]`);
  await expect(refreshed.getByTestId("leech-card-context")).toContainText(note);

  // It is op-log-derived, so re-opening the route (a fresh reviewLeeches read) still
  // shows it — the note actually makes the prompt answerable, not write-only.
  await openRemediation(page);
  const reopened = page.locator(`[data-testid="leech-card"][data-card-id="${cardId}"]`);
  await expect(reopened.getByTestId("leech-card-context")).toContainText(note);

  await app.close();
});

/** Captured across the serial spec so the restart test can verify persistence. */
const state = {
  splitCardId: "",
  splitChildIds: [] as string[],
  backCardId: "",
  backExtractId: "",
  prioCardId: "",
};

test("split a leech into two atomic cards; back-to-extract + lower-priority on others", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Author three fresh leeches off the seeded extract.
  const split = await makeFreshLeech(page, {
    prompt: "A multi-fact leech: what is X and what is Y?",
    answer: "X is foo and Y is bar.",
  });
  const back = await makeFreshLeech(page, {
    prompt: "A leech to send back to its extract?",
    answer: "Re-distill me.",
  });
  const prio = await makeFreshLeech(page, {
    prompt: "A low-value leech to deprioritize?",
    answer: "C-band me.",
  });
  state.splitCardId = split.cardId;
  state.backCardId = back.cardId;
  state.backExtractId = back.extractId;
  state.prioCardId = prio.cardId;

  await openRemediation(page);

  // The split card shows with its lapse count + the full action row.
  const splitCard = page.locator(`[data-testid="leech-card"][data-card-id="${split.cardId}"]`);
  await expect(splitCard).toBeVisible();
  await expect(splitCard.getByTestId("leech-card-lapses")).toBeVisible();
  await expect(splitCard.getByTestId("leech-split")).toBeVisible();
  await expect(splitCard.getByTestId("leech-add-context")).toBeVisible();
  await expect(splitCard.getByTestId("leech-back-to-extract")).toBeVisible();
  await expect(splitCard.getByTestId("leech-priority")).toBeVisible();

  // Snapshot the extract's LIVE card children (soft-deleted excluded) BEFORE the split
  // so we can diff exactly which two new cards the split minted.
  const childrenBefore = await page.evaluate(async (extractId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{ data: { children: { id: string }[] } | null }>;
      };
    };
    const insp = await api.inspector.get({ id: extractId });
    return (insp.data?.children ?? []).map((c) => c.id);
  }, split.extractId);

  // SPLIT it into two atomic cards via the inline editor.
  await splitCard.getByTestId("leech-split").click();
  await splitCard.getByTestId("leech-split-prompt-0").fill("What is X?");
  await splitCard.getByTestId("leech-split-answer-0").fill("X is foo.");
  await splitCard.getByTestId("leech-split-prompt-1").fill("What is Y?");
  await splitCard.getByTestId("leech-split-answer-1").fill("Y is bar.");
  await splitCard.getByTestId("leech-split-save").click();

  // The original is gone from the leech list.
  await expect(
    page.locator(`[data-testid="leech-card"][data-card-id="${split.cardId}"]`),
  ).toHaveCount(0);

  // Exactly two NEW live cards now hang off the extract (the split siblings), each with
  // the original's lineage (parent extract) + a FRESH `new` review state (0 lapses);
  // the original dropped out of the live children (soft-deleted).
  const splitResult = await page.evaluate(
    async (p) => {
      const api = window.appApi as unknown as {
        inspector: {
          get(req: { id: string }): Promise<{
            data: {
              children: { id: string }[];
              review: { lapses: number | null } | null;
            } | null;
          }>;
        };
      };
      const insp = await api.inspector.get({ id: p.extractId });
      const childIds = (insp.data?.children ?? []).map((c) => c.id);
      const newIds = childIds.filter((id) => !p.before.includes(id));
      const checks = await Promise.all(
        newIds.map(async (id) => {
          const ci = await api.inspector.get({ id });
          return { id, lapses: ci.data?.review?.lapses ?? null };
        }),
      );
      return {
        newIds,
        originalGone: !childIds.includes(p.originalId),
        freshChecks: checks,
      };
    },
    { extractId: split.extractId, before: childrenBefore, originalId: split.cardId },
  );
  expect(splitResult.newIds.length).toBe(2);
  expect(splitResult.originalGone).toBe(true);
  state.splitChildIds = splitResult.newIds;
  for (const c of splitResult.freshChecks) expect(c.lapses ?? 0).toBe(0);

  // BACK TO EXTRACT on the second leech: its parent extract is reactivated (due-now)
  // and the card is suspended. The card stays a leech (still listed, now with a
  // "Suspended" badge — `listLeechCards` keeps suspended cards), so we verify the
  // suspension below through the bridge rather than asserting it leaves the list.
  await openRemediation(page);
  const backCard = page.locator(`[data-testid="leech-card"][data-card-id="${back.cardId}"]`);
  await expect(backCard.getByTestId("leech-back-to-extract")).toBeEnabled();
  await backCard.getByTestId("leech-back-to-extract").click();
  await expect(backCard.getByText("Suspended")).toBeVisible();

  // LOWER PRIORITY on the third leech (A/B/C/D control → C).
  await openRemediation(page);
  const prioCard = page.locator(`[data-testid="leech-card"][data-card-id="${prio.cardId}"]`);
  await prioCard.getByTestId("leech-priority-D").click();

  // Verify the live state through the typed bridge (no SQL).
  const live = await page.evaluate(async (s) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { element: { status: string; priority: number; dueAt: string | null } } | null;
        }>;
      };
    };
    const backCardInsp = await api.inspector.get({ id: s.backCardId });
    const backExtractInsp = await api.inspector.get({ id: s.backExtractId });
    const prioInsp = await api.inspector.get({ id: s.prioCardId });
    return {
      backCardStatus: backCardInsp.data?.element.status,
      backExtractStatus: backExtractInsp.data?.element.status,
      backExtractDueAt: backExtractInsp.data?.element.dueAt,
      prioPriority: prioInsp.data?.element.priority,
    };
  }, state);
  expect(live.backCardStatus).toBe("suspended");
  expect(live.backExtractStatus).toBe("scheduled");
  expect(live.backExtractDueAt).toBeTruthy();
  // D band is the lowest numeric priority.
  expect(live.prioPriority ?? 1).toBeLessThan(0.5);

  await app.close();
});

test("the split cards, rescheduled extract, suspension, and lowered priority survive restart", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const after = await page.evaluate(async (s) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { element: { status: string; priority: number; dueAt: string | null } } | null;
        }>;
      };
      review: { leeches(): Promise<{ cards: { id: string; status: string }[] }> };
    };
    // The soft-deleted original is excluded from `inspector.get` (returns null) AND
    // from the leech list — both are the durable-table read after restart.
    const split = await api.inspector.get({ id: s.splitCardId });
    const { cards: leeches } = await api.review.leeches();
    const children = await Promise.all(
      s.splitChildIds.map(async (id) => {
        const insp = await api.inspector.get({ id });
        return insp.data?.element.status ?? "missing";
      }),
    );
    const backCard = await api.inspector.get({ id: s.backCardId });
    const backExtract = await api.inspector.get({ id: s.backExtractId });
    const prio = await api.inspector.get({ id: s.prioCardId });
    return {
      originalResolves: split.data != null,
      originalInLeechList: leeches.some((c) => c.id === s.splitCardId),
      childStatuses: children,
      backCardStatus: backCard.data?.element.status,
      backExtractStatus: backExtract.data?.element.status,
      backExtractDueAt: backExtract.data?.element.dueAt,
      prioPriority: prio.data?.element.priority,
    };
  }, state);

  // The split original is soft-deleted (no longer resolves, gone from the leech list);
  // the two split children are live; the extract is still scheduled due-now; the back
  // card is suspended; the priority is lowered.
  expect(after.originalResolves).toBe(false);
  expect(after.originalInLeechList).toBe(false);
  expect(after.childStatuses.every((s) => s !== "missing" && s !== "deleted")).toBe(true);
  expect(after.childStatuses.length).toBe(2);
  expect(after.backCardStatus).toBe("suspended");
  expect(after.backExtractStatus).toBe("scheduled");
  expect(after.backExtractDueAt).toBeTruthy();
  expect(after.prioPriority ?? 1).toBeLessThan(0.5);

  await app.close();
});

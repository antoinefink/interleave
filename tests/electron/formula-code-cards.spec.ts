/**
 * Formula & code cards E2E (T072) — math + highlighted code render in source AND
 * review, and survive an app restart.
 *
 * Launches the BUILT desktop app against a fresh SEEDED data dir (the demo collection
 * includes a "Backpropagation in one page" source whose body has a BLOCK formula
 * (`$$…$$` math node), an INLINE formula, and a `language`-tagged Python code block;
 * plus a code fill-in CLOZE card and a math Q&A card distilled from a code extract).
 * It proves the on-device KaTeX/Shiki render path:
 *
 *   1. open the seeded source → the reader renders the block formula via KaTeX (a
 *      `.katex-html` node, NOT raw LaTeX) and the code block via the Shiki NodeView;
 *   2. the seeded math Q&A card's view carries its `$$…$$` answer; the code cloze
 *      card carries a fenced `{{cN::…}}` body (the review faces render them as math +
 *      highlighted code via the shared CardBody renderer, covered by the unit tests);
 *   3. after an APP RESTART, the source body, the cards, and their math/code bodies
 *      all survive.
 *
 * Rendering is 100% on-device — KaTeX CSS/fonts + the Shiki grammars/themes are
 * bundled (no CDN). The renderer reaches data only through `window.appApi`.
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

/** Resolve a seeded element id by title (via the inspector list bridge). */
async function resolveByTitle(page: Page, title: string): Promise<string> {
  return page.evaluate(async (wanted) => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; title: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const found = elements.find((e) => e.title === wanted);
    if (!found) throw new Error(`seeded element not found: ${wanted}`);
    return found.id;
  }, title);
}

/** The reveal-ready review view (kind + prompt + answer + cloze) for one card. */
async function reviewCard(page: Page, id: string) {
  return page.evaluate(async (cardId) => {
    const api = window.appApi as unknown as {
      review: {
        card(req: { cardId: string }): Promise<{
          card: {
            kind: string;
            prompt: string;
            answer: string | null;
            cloze: string | null;
          } | null;
        }>;
      };
    };
    const { card } = await api.review.card({ cardId });
    return card;
  }, id);
}

test("math + highlighted code render in source and review, and survive restart", async () => {
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const sourceId = await resolveByTitle(page, "Backpropagation in one page");

  // (a) SOURCE — open the seeded source; the reader renders the block formula via
  //     KaTeX (a `.katex` node, not raw LaTeX) and the code via the Shiki NodeView.
  await page.goto(`${baseUrl}/source/${sourceId}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-source")).toBeVisible();

  // The math NodeView renders KaTeX markup (block + inline formulas). KaTeX emits a
  // `.katex-html` visual node + a hidden MathML annotation (the raw LaTeX lives ONLY
  // in that accessibility annotation, never as visible text) — assert the rendered
  // markup is present.
  await expect(page.locator(".reader .katex-html").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".reader .math-node--block").first()).toBeVisible();
  await expect(page.locator(".reader .math-node--inline").first()).toBeAttached();
  // The code NodeView mounted with the seeded language.
  const codeNode = page.getByTestId("code-node").first();
  await expect(codeNode).toBeVisible();
  await expect(codeNode).toHaveAttribute("data-language", "python");
  // The code text is present (raw first, highlighted overlay swapped in async).
  await expect(codeNode).toContainText("def step");

  // (b) REVIEW DATA — the seeded math Q&A card carries a `$$…$$` answer; the code
  //     cloze card carries a fenced cloze body. (Resolved via the typed bridge.)
  const qaId = await resolveByTitle(page, "Gradient of the loss (math Q&A)");
  const clozeId = await resolveByTitle(page, "Gradient step (code cloze)");

  const qa = await reviewCard(page, qaId);
  expect(qa?.kind).toBe("qa");
  expect(qa?.answer ?? "").toContain("$$");

  const cloze = await reviewCard(page, clozeId);
  expect(cloze?.kind).toBe("cloze");
  expect(cloze?.cloze ?? "").toContain("```");
  expect(cloze?.cloze ?? "").toContain("{{c1::");

  // (c) RESTART — relaunch against the same data dir; everything survives.
  await app.close();
  app = await launchApp(dataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url2 = new URL(page.url());
  baseUrl = `${url2.protocol}//${url2.host}`;

  // The source body still renders KaTeX math + the python code block after restart.
  await page.goto(`${baseUrl}/source/${sourceId}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".reader .katex-html").first()).toBeVisible({ timeout: 15_000 });
  const codeAfter = page.getByTestId("code-node").first();
  await expect(codeAfter).toHaveAttribute("data-language", "python");
  await expect(codeAfter).toContainText("def step");

  // The seeded cards still resolve with their math/code bodies intact.
  const qaAfter = await reviewCard(page, qaId);
  expect(qaAfter?.answer ?? "").toContain("$$");
  const clozeAfter = await reviewCard(page, clozeId);
  expect(clozeAfter?.cloze ?? "").toContain("```");

  await app.close();
});

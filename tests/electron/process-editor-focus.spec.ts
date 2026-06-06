import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.beforeAll(() => {
  ensureBuilt();
});

const AS_OF = "2027-06-01T12:00:00.000Z";

async function findSourceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{
          elements: { id: string; type: string; status: string; title: string }[];
        }>;
      };
    };
    const { elements } = await api.inspector.list();
    const source =
      elements.find((e) => e.type === "source" && e.title.includes("Measure of Intelligence")) ??
      elements.find((e) => e.type === "source" && e.status === "active");
    if (!source) throw new Error("seeded active source with a body not found");
    return source.id;
  });
}

async function createExtract(page: Page, sourceId: string): Promise<string> {
  return page.evaluate(async (sourceElementId) => {
    const api = window.appApi as unknown as {
      extractions: {
        create(req: {
          sourceElementId: string;
          selectedText: string;
          blockIds: string[];
          startOffset?: number;
          endOffset?: number;
          title?: string;
        }): Promise<{ extract: { id: string } }>;
      };
    };
    const res = await api.extractions.create({
      sourceElementId,
      selectedText: "Focused process editor extract",
      blockIds: ["blk_intro_p1"],
      startOffset: 0,
      endOffset: 30,
      title: "Focused process editor extract",
    });
    return res.extract.id;
  }, sourceId);
}

async function openProcess(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/process?asOf=${encodeURIComponent(AS_OF)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-process")).toBeVisible();
}

async function moveProcessCursorTo(page: Page, id: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const item = page.getByTestId("process-item");
    await expect(item).toHaveCount(1);
    if ((await item.getAttribute("data-element-id")) === id) return;
    await item.getByTestId("process-action-skip").click();
    await page.waitForTimeout(40);
  }
  throw new Error(`process item ${id} did not surface before the queue ended`);
}

test("clicking blank extract editor space focuses the editor without drawing an inner border", async () => {
  const app = await launchApp(makeDataDir(), { seedOnEmpty: true });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const url = new URL(page.url());
    const baseUrl = `${url.protocol}//${url.host}`;

    const sourceId = await findSourceId(page);
    const extractId = await createExtract(page, sourceId);

    await openProcess(page, baseUrl);
    await moveProcessCursorTo(page, extractId);

    const editorPanel = page.getByTestId("process-extract-editor");
    const editor = page.locator('[data-testid="process-extract-editor"] .ProseMirror');
    await expect(editorPanel).toBeVisible();
    await expect(editor).toBeVisible();
    const panelBox = await editorPanel.boundingBox();
    if (!panelBox) throw new Error("process extract editor panel was not measurable");
    const editorBox = await editor.boundingBox();
    if (!editorBox) throw new Error("process extract editor surface was not measurable");
    expect(editorBox.width).toBeGreaterThan(panelBox.width - 40);

    await page.mouse.click(editorBox.x + editorBox.width - 8, editorBox.y + editorBox.height / 2);

    await expect(editor).toBeFocused();
    expect(await editor.evaluate((node) => getComputedStyle(node).boxShadow)).toBe("none");
  } finally {
    await app.close();
  }
});

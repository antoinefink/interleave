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

async function createExtract(
  page: Page,
  sourceId: string,
  selectedText = "Focused process editor extract",
  options: { readonly saveSelectedTextAsBody?: boolean } = {},
): Promise<string> {
  return page.evaluate(
    async ({ sourceElementId, text, saveSelectedTextAsBody }) => {
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
        documents: {
          save(req: {
            elementId: string;
            prosemirrorJson: unknown;
            plainText: string;
            blocks?: { blockType: string; order: number; stableBlockId: string }[];
          }): Promise<unknown>;
        };
      };
      const res = await api.extractions.create({
        sourceElementId,
        selectedText: text,
        blockIds: ["blk_intro_p1"],
        startOffset: 0,
        endOffset: text.length,
        title: "Focused process editor extract",
      });
      if (saveSelectedTextAsBody) {
        const paragraphs = text
          .split(/\n\s*\n/)
          .map((paragraph) => paragraph.trim())
          .filter((paragraph) => paragraph.length > 0);
        const blocks = paragraphs.map((_, order) => ({
          blockType: "paragraph",
          order,
          stableBlockId: `process_extract_long_${order + 1}`,
        }));
        await api.documents.save({
          elementId: res.extract.id,
          prosemirrorJson: {
            type: "doc",
            content: paragraphs.map((paragraph, order) => ({
              type: "paragraph",
              attrs: { blockId: blocks[order]?.stableBlockId },
              content: [{ type: "text", text: paragraph }],
            })),
          },
          plainText: paragraphs.join("\n\n"),
          blocks,
        });
      }
      return res.extract.id;
    },
    { sourceElementId: sourceId, text: selectedText, ...options },
  );
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

test("process extract card fills the work area while keeping actions reachable", async () => {
  const app = await launchApp(makeDataDir(), { seedOnEmpty: true });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForLoadState("domcontentloaded");
    const url = new URL(page.url());
    const baseUrl = `${url.protocol}//${url.host}`;

    const sourceId = await findSourceId(page);
    const extractText = Array.from(
      { length: 36 },
      (_, index) =>
        `Long process extract paragraph ${index + 1}. The reader should scroll inside the editor while the process controls stay visible.`,
    )
      .concat(
        "Final process extract paragraph. It should be reachable by scrolling the reader, not the whole process card.",
      )
      .join("\n\n");
    const extractId = await createExtract(page, sourceId, extractText, {
      saveSelectedTextAsBody: true,
    });

    await openProcess(page, baseUrl);
    await moveProcessCursorTo(page, extractId);

    const layout = await page.evaluate(() => {
      function required(testId: string): HTMLElement {
        const node = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
        if (!node) throw new Error(`missing ${testId}`);
        return node;
      }
      const center = required("process-center");
      const card = required("process-item");
      const editor = required("process-extract-editor");
      const tools = required("process-extract-tools");
      const actions = card.querySelector<HTMLElement>(".pq-actions");
      const reader = editor.querySelector<HTMLElement>(".reader");
      if (!actions || !reader) throw new Error("process extract layout nodes missing");

      const centerStyle = getComputedStyle(center);
      const readerStyle = getComputedStyle(reader);
      const centerRect = center.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const toolsRect = tools.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      const readerRect = reader.getBoundingClientRect();
      const finalParagraph = Array.from(reader.querySelectorAll<HTMLElement>(".ProseMirror p")).at(
        -1,
      );
      if (!finalParagraph) throw new Error("process extract paragraphs missing");
      reader.scrollTop = reader.scrollHeight;
      const finalParagraphRect = finalParagraph.getBoundingClientRect();
      const paddingTop = Number.parseFloat(centerStyle.paddingTop);
      const paddingBottom = Number.parseFloat(centerStyle.paddingBottom);
      const centerVisibleBottom = centerRect.bottom - paddingBottom;
      return {
        centerJustify: centerStyle.justifyContent,
        centerOverflowY: centerStyle.overflowY,
        readerOverflowY: readerStyle.overflowY,
        readerClientHeight: reader.clientHeight,
        readerScrollHeight: reader.scrollHeight,
        readerScrollTop: reader.scrollTop,
        finalParagraphReachable:
          finalParagraphRect.bottom > readerRect.top + 1 &&
          finalParagraphRect.top < readerRect.bottom - 1,
        centerContentHeight: centerRect.height - paddingTop - paddingBottom,
        centerVisibleBottom,
        cardHeight: cardRect.height,
        cardBottom: cardRect.bottom,
        editorBottom: editorRect.bottom,
        toolsTop: toolsRect.top,
        toolsBottom: toolsRect.bottom,
        actionsTop: actionsRect.top,
        actionsBottom: actionsRect.bottom,
      };
    });

    expect(layout.centerJustify).toBe("flex-start");
    expect(layout.centerOverflowY).toBe("hidden");
    expect(layout.readerOverflowY).toBe("auto");
    expect(layout.readerScrollHeight).toBeGreaterThan(layout.readerClientHeight);
    expect(layout.readerScrollTop).toBeGreaterThan(0);
    expect(layout.finalParagraphReachable).toBe(true);
    expect(layout.cardHeight).toBeGreaterThan(layout.centerContentHeight * 0.9);
    expect(layout.editorBottom).toBeLessThanOrEqual(layout.toolsTop + 1);
    expect(layout.toolsBottom).toBeLessThanOrEqual(layout.actionsTop + 1);
    expect(layout.actionsBottom).toBeLessThanOrEqual(layout.cardBottom + 1);
    expect(layout.actionsBottom).toBeLessThanOrEqual(layout.centerVisibleBottom + 1);
  } finally {
    await app.close();
  }
});

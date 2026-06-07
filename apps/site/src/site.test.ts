/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySystemTheme,
  bindReaderDemo,
  bindSystemTheme,
  bootstrapSite,
  createExtractCardHtml,
  escapeHtml,
  handleReaderAction,
  paintIcons,
  renderPipeline,
  updateSelectionToolbar,
} from "./site";

type MediaListener = (event: MediaQueryListEvent) => void;

function createMediaStub(initialMatches: boolean) {
  let matches = initialMatches;
  let listener: MediaListener | null = null;

  return {
    get matches() {
      return matches;
    },
    addEventListener: vi.fn((type: "change", nextListener: MediaListener) => {
      if (type === "change") {
        listener = nextListener;
      }
    }),
    removeEventListener: vi.fn(),
    dispatch(nextMatches: boolean) {
      matches = nextMatches;
      listener?.({ matches: nextMatches } as MediaQueryListEvent);
    },
  };
}

function installMatchMedia(media: ReturnType<typeof createMediaStub>) {
  const previous = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => media as unknown as MediaQueryList,
  });

  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: previous,
    });
  };
}

function setupReaderDemo(text = "Sleep after learning saves new memory."): Text {
  document.body.innerHTML = `
    <div id="readerBody"><p id="readerText">${text}</p></div>
    <aside>
      <span id="railCount">1</span>
      <div id="railBody"><article class="xcard">Existing extract</article></div>
    </aside>
    <div id="selFloat">
      <button type="button" data-action="extract">Extract</button>
      <button type="button" data-action="cloze">Cloze</button>
      <button type="button" data-action="highlight">Highlight</button>
    </div>
  `;

  const textNode = document.getElementById("readerText")?.firstChild;

  if (!(textNode instanceof Text)) {
    throw new Error("Reader text node was not created");
  }

  return textNode;
}

function setupReaderDemoWithTwoParagraphs(): { first: Text; second: Text } {
  document.body.innerHTML = `
    <div id="readerBody">
      <p id="readerTextOne">Sleep after learning saves new memory.</p>
      <p id="readerTextTwo">Deep sleep consolidates yesterday's lessons.</p>
    </div>
    <aside>
      <span id="railCount">1</span>
      <div id="railBody"><article class="xcard">Existing extract</article></div>
    </aside>
    <div id="selFloat">
      <button type="button" data-action="extract">Extract</button>
      <button type="button" data-action="cloze">Cloze</button>
      <button type="button" data-action="highlight">Highlight</button>
    </div>
  `;

  const first = document.getElementById("readerTextOne")?.firstChild;
  const second = document.getElementById("readerTextTwo")?.firstChild;

  if (!(first instanceof Text) || !(second instanceof Text)) {
    throw new Error("Reader paragraph text nodes were not created");
  }

  return { first, second };
}

function selectText(textNode: Text, selectedText: string): void {
  const start = textNode.data.indexOf(selectedText);

  if (start < 0) {
    throw new Error(`Could not find text to select: ${selectedText}`);
  }

  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, start + selectedText.length);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function selectAcrossTextNodes(
  startNode: Text,
  startText: string,
  endNode: Text,
  endText: string,
): void {
  const start = startNode.data.indexOf(startText);
  const endStart = endNode.data.indexOf(endText);

  if (start < 0 || endStart < 0) {
    throw new Error("Could not find cross-node selection text");
  }

  const range = document.createRange();
  range.setStart(startNode, start);
  range.setEnd(endNode, endStart + endText.length);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("paintIcons", () => {
  it("paints known and unknown data-icon nodes", () => {
    document.body.innerHTML = `
      <span id="known" data-icon="download" data-size="22"></span>
      <span id="unknown" data-icon="missing"></span>
    `;

    paintIcons(document);

    expect(document.querySelector("#known svg")?.getAttribute("width")).toBe("22");
    expect(document.querySelector("#known path")).not.toBeNull();
    expect(document.querySelector("#unknown svg")).not.toBeNull();
    expect(document.querySelector("#unknown path")).toBeNull();
  });
});

describe("system theme helpers", () => {
  it("applies the current system color scheme", () => {
    const media = createMediaStub(true);

    expect(applySystemTheme(document, media)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    media.dispatch(false);
    expect(applySystemTheme(document, media)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("binds and unbinds system color scheme changes", () => {
    const media = createMediaStub(false);
    const cleanup = bindSystemTheme(document, {
      matchMedia: () => media as unknown as MediaQueryList,
    });

    expect(document.documentElement.dataset.theme).toBe("light");

    media.dispatch(true);
    expect(document.documentElement.dataset.theme).toBe("dark");

    cleanup();
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);
  });
});

describe("renderPipeline", () => {
  it("renders six pipeline steps with completed and current states", () => {
    const container = document.createElement("div");

    renderPipeline(container, "atomic");

    const steps = Array.from(container.querySelectorAll<HTMLElement>(".pipe-step"));
    expect(steps).toHaveLength(6);
    expect(steps.map((step) => step.textContent?.trim())).toEqual([
      "Source",
      "Extract",
      "Clean",
      "Atomic",
      "Card",
      "Mature",
    ]);
    expect(container.querySelectorAll(".pipe-step--done")).toHaveLength(3);
    expect(container.querySelector(".pipe-step--on")?.getAttribute("data-step")).toBe("atomic");
    expect(container.querySelectorAll("svg")).toHaveLength(6);
  });
});

describe("HTML helpers", () => {
  it("escapes HTML-special characters", () => {
    expect(escapeHtml(`<tag data-x="1">Tom & 'Jerry'</tag>`)).toBe(
      "&lt;tag data-x=&quot;1&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/tag&gt;",
    );
  });

  it("renders extract cards with escaped text", () => {
    const html = createExtractCardHtml(`<img src=x onerror=alert(1)> & "quoted"`, "extract");
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const card = parsed.querySelector<HTMLElement>(".xcard");

    expect(card?.dataset.cardKind).toBe("extract");
    expect(parsed.querySelector(".xcard__stage")?.textContent).toContain("Clean extract");
    expect(parsed.querySelector(".xcard__text")?.textContent).toBe(
      `<img src=x onerror=alert(1)> & "quoted"`,
    );
    expect(parsed.querySelector(".xcard__text img")).toBeNull();
  });

  it("renders cloze cards with card-draft semantics", () => {
    const parsed = new DOMParser().parseFromString(
      createExtractCardHtml({ text: "Distributed practice spaces learning.", kind: "cloze" }),
      "text/html",
    );

    expect(parsed.querySelector<HTMLElement>(".xcard")?.dataset.cardKind).toBe("cloze");
    expect(parsed.querySelector(".xcard__stage")?.textContent).toContain("Cloze draft");
    expect(parsed.querySelector(".sched--fsrs")?.textContent).toContain("Draft");
  });
});

describe("reader demo actions", () => {
  it("extract adds a rail card and marks the selection as extracted", () => {
    const textNode = setupReaderDemo();
    selectText(textNode, "Sleep after learning");

    expect(handleReaderAction("extract", document, window)).toBe(true);

    expect(document.querySelector("mark.extracted")?.textContent).toBe("Sleep after learning");
    expect(document.getElementById("railCount")?.textContent).toBe("2");
    expect(document.querySelector("#railBody .xcard")?.textContent).toContain(
      "Sleep after learning",
    );
  });

  it("cloze adds a card draft and marks the selection as extracted", () => {
    const textNode = setupReaderDemo();
    selectText(textNode, "new memory");

    expect(handleReaderAction("cloze", document, window)).toBe(true);

    expect(document.querySelector("mark.extracted")?.textContent).toBe("new memory");
    expect(document.getElementById("railCount")?.textContent).toBe("2");
    expect(document.querySelector("#railBody .xcard")?.textContent).toContain("Cloze draft");
  });

  it("highlight marks text only and does not add a rail card", () => {
    const textNode = setupReaderDemo();
    selectText(textNode, "saves new memory");

    expect(handleReaderAction("highlight", document, window)).toBe(true);

    expect(document.querySelector("mark.hl")?.textContent).toBe("saves new memory");
    expect(document.querySelector("mark.extracted")).toBeNull();
    expect(document.getElementById("railCount")?.textContent).toBe("1");
    expect(document.querySelectorAll("#railBody .xcard")).toHaveLength(1);
  });

  it("selection outside the reader no-ops", () => {
    setupReaderDemo();
    document.body.insertAdjacentHTML("beforeend", '<p id="outside">Outside selected text.</p>');

    const outside = document.getElementById("outside")?.firstChild;
    if (!(outside instanceof Text)) {
      throw new Error("Outside text node was not created");
    }

    selectText(outside, "Outside selected");

    expect(handleReaderAction("extract", document, window)).toBe(false);
    expect(document.getElementById("railCount")?.textContent).toBe("1");
    expect(document.querySelector("mark")).toBeNull();
  });

  it("extract supports cross-paragraph selections without rewriting reader structure", () => {
    const { first, second } = setupReaderDemoWithTwoParagraphs();
    selectAcrossTextNodes(first, "learning", second, "Deep sleep");

    expect(handleReaderAction("extract", document, window)).toBe(true);

    expect(document.getElementById("railCount")?.textContent).toBe("2");
    expect(document.querySelectorAll("#railBody .xcard")).toHaveLength(2);
    expect(document.querySelector("#railBody .xcard")?.textContent).toContain(
      "learning saves new memory. Deep sleep",
    );
    expect(document.querySelectorAll("mark.extracted")).toHaveLength(2);
    expect(document.querySelectorAll("mark.extracted")[0]?.textContent).toBe(
      "learning saves new memory.",
    );
    expect(document.querySelectorAll("mark.extracted")[1]?.textContent).toBe("Deep sleep");
    expect(document.querySelectorAll("#readerBody p")).toHaveLength(2);
    expect(document.getElementById("readerBody")?.textContent).toContain(
      "Sleep after learning saves new memory.",
    );
    expect(document.getElementById("readerBody")?.textContent).toContain(
      "Deep sleep consolidates yesterday's lessons.",
    );
  });

  it("shows the toolbar for cross-paragraph selections", () => {
    const { first, second } = setupReaderDemoWithTwoParagraphs();
    selectAcrossTextNodes(first, "learning", second, "Deep sleep");

    const range = window.getSelection()?.getRangeAt(0) as
      | (Range & { getBoundingClientRect: () => DOMRect })
      | undefined;
    const toolbar = document.getElementById("selFloat");

    if (!range || !toolbar) {
      throw new Error("Selection toolbar fixture was not created");
    }

    range.getBoundingClientRect = () =>
      DOMRect.fromRect({ height: 96, width: 480, x: 180, y: 420 });
    Object.defineProperty(toolbar, "offsetWidth", { configurable: true, value: 210 });
    Object.defineProperty(toolbar, "offsetHeight", { configurable: true, value: 42 });

    expect(
      updateSelectionToolbar(document, {
        getSelection: () => window.getSelection(),
        innerWidth: 900,
        scrollX: 0,
        scrollY: 0,
      } as unknown as Window),
    ).toBe(true);

    expect(toolbar.style.left).toBe("315px");
    expect(toolbar.style.top).toBe("368px");
    expect(toolbar.classList.contains("sel-float--on")).toBe(true);
  });

  it("bindReaderDemo wires toolbar button actions", () => {
    const textNode = setupReaderDemo();
    selectText(textNode, "Sleep after learning");

    const cleanup = bindReaderDemo(document, window);
    document.querySelector<HTMLButtonElement>('[data-action="extract"]')?.click();

    expect(document.querySelector("mark.extracted")?.textContent).toBe("Sleep after learning");
    expect(document.getElementById("railCount")?.textContent).toBe("2");

    cleanup();
  });

  it("positions the fixed selection toolbar in viewport coordinates", () => {
    const textNode = setupReaderDemo();
    selectText(textNode, "Sleep after learning");

    const range = window.getSelection()?.getRangeAt(0) as
      | (Range & { getBoundingClientRect: () => DOMRect })
      | undefined;
    const toolbar = document.getElementById("selFloat");

    if (!range || !toolbar) {
      throw new Error("Selection toolbar fixture was not created");
    }

    range.getBoundingClientRect = () =>
      DOMRect.fromRect({ height: 20, width: 120, x: 220, y: 360 });
    Object.defineProperty(toolbar, "offsetWidth", { configurable: true, value: 180 });
    Object.defineProperty(toolbar, "offsetHeight", { configurable: true, value: 42 });

    expect(
      updateSelectionToolbar(document, {
        getSelection: () => window.getSelection(),
        innerWidth: 900,
        scrollX: 500,
        scrollY: 1200,
      } as unknown as Window),
    ).toBe(true);

    expect(toolbar.style.left).toBe("190px");
    expect(toolbar.style.top).toBe("308px");
    expect(toolbar.classList.contains("sel-float--on")).toBe(true);
  });

  it("updates and cleans up the toolbar on window scroll and resize", () => {
    const textNode = setupReaderDemo();
    selectText(textNode, "Sleep after learning");
    const range = window.getSelection()?.getRangeAt(0) as
      | (Range & { getBoundingClientRect: () => DOMRect })
      | undefined;
    const toolbar = document.getElementById("selFloat");

    if (!range || !toolbar) {
      throw new Error("Selection toolbar fixture was not created");
    }

    Object.defineProperty(toolbar, "offsetWidth", { configurable: true, value: 180 });
    Object.defineProperty(toolbar, "offsetHeight", { configurable: true, value: 42 });
    range.getBoundingClientRect = () =>
      DOMRect.fromRect({ height: 20, width: 120, x: 220, y: 360 });

    const cleanup = bindReaderDemo(document, window);
    document.dispatchEvent(new Event("selectionchange"));
    expect(toolbar.style.top).toBe("308px");

    range.getBoundingClientRect = () =>
      DOMRect.fromRect({ height: 20, width: 120, x: 220, y: 460 });
    window.dispatchEvent(new Event("scroll"));
    expect(toolbar.style.top).toBe("408px");

    window.dispatchEvent(new Event("resize"));
    expect(toolbar.classList.contains("sel-float--on")).toBe(true);

    cleanup();
    range.getBoundingClientRect = () =>
      DOMRect.fromRect({ height: 20, width: 120, x: 220, y: 560 });
    window.dispatchEvent(new Event("scroll"));
    expect(toolbar.style.top).toBe("408px");
  });
});

describe("bootstrapSite", () => {
  it("paints icons, applies system theme, renders the pipeline, and binds reader actions", () => {
    const media = createMediaStub(true);
    const restoreMatchMedia = installMatchMedia(media);
    const textNode = setupReaderDemo();
    document.body.insertAdjacentHTML(
      "afterbegin",
      '<span id="downloadIcon" data-icon="download"></span><div id="pipeline"></div>',
    );

    const cleanup = bootstrapSite(document, window);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector("#downloadIcon svg")).not.toBeNull();
    expect(document.querySelectorAll("#pipeline .pipe-step")).toHaveLength(6);

    selectText(textNode, "Sleep after learning");
    document.querySelector<HTMLButtonElement>('[data-action="extract"]')?.click();
    expect(document.getElementById("railCount")?.textContent).toBe("2");

    cleanup();
    restoreMatchMedia();
  });
});

import { type IconName, iconSvg } from "./icons";

const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";
const ACTIVE_PIPELINE_STEP = "atomic";

export type ThemeName = "light" | "dark";

type ThemeMediaQueryList = Pick<MediaQueryList, "matches"> & {
  addEventListener?: MediaQueryList["addEventListener"];
  removeEventListener?: MediaQueryList["removeEventListener"];
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
};

type ThemeWindow = Pick<Window, "matchMedia">;
type ReaderWindow = Pick<
  Window,
  "addEventListener" | "getSelection" | "innerWidth" | "removeEventListener"
>;

export const PIPELINE_STEPS = [
  { key: "source", icon: "source", label: "Source" },
  { key: "extract", icon: "extract", label: "Extract" },
  { key: "clean", icon: "highlight", label: "Clean" },
  { key: "atomic", icon: "target", label: "Atomic" },
  { key: "card", icon: "card", label: "Card" },
  { key: "mature", icon: "brain", label: "Mature" },
] as const satisfies ReadonlyArray<{ key: string; icon: IconName; label: string }>;

export type PipelineStepKey = (typeof PIPELINE_STEPS)[number]["key"];
export type ReaderAction = "extract" | "cloze" | "highlight";
export type ExtractCardKind = "extract" | "cloze";

export type ExtractCardInput = {
  text: string;
  kind?: ExtractCardKind;
};

export type ReaderSelection = {
  selection: Selection;
  range: Range;
  text: string;
  rect: DOMRect | null;
};

function currentDocument(): Document | undefined {
  return typeof document === "undefined" ? undefined : document;
}

function currentWindow(doc?: Document): Window | undefined {
  if (doc?.defaultView) {
    return doc.defaultView;
  }

  return typeof window === "undefined" ? undefined : window;
}

function getSystemThemeMedia(doc?: Document, win?: ThemeWindow): ThemeMediaQueryList | undefined {
  const view = win ?? currentWindow(doc);

  if (!view || typeof view.matchMedia !== "function") {
    return undefined;
  }

  return view.matchMedia(SYSTEM_THEME_QUERY);
}

function normalizeIconSize(size: string | null): number {
  const parsed = Number.parseInt(size ?? "", 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 16;
  }

  return parsed;
}

export function paintIcons(root?: ParentNode): void {
  const scope = root ?? currentDocument();

  if (!scope) {
    return;
  }

  for (const node of scope.querySelectorAll<HTMLElement>("[data-icon]")) {
    const iconName = node.dataset.icon ?? "";
    const size = normalizeIconSize(node.dataset.size ?? null);
    node.innerHTML = iconSvg(iconName, size);
  }
}

export function applySystemTheme(
  doc?: Document,
  media?: Pick<ThemeMediaQueryList, "matches">,
): ThemeName {
  const target = doc ?? currentDocument();
  const matcher = media ?? getSystemThemeMedia(target);
  const theme: ThemeName = matcher?.matches ? "dark" : "light";

  if (target) {
    target.documentElement.dataset.theme = theme;
  }

  return theme;
}

export function bindSystemTheme(doc?: Document, win?: ThemeWindow): () => void {
  const target = doc ?? currentDocument();
  const media = getSystemThemeMedia(target, win);

  applySystemTheme(target, media);

  if (!media) {
    return () => undefined;
  }

  const sync = () => {
    applySystemTheme(target, media);
  };

  if (media.addEventListener) {
    media.addEventListener("change", sync);

    return () => {
      media.removeEventListener?.("change", sync);
    };
  }

  media.addListener?.(sync);

  return () => {
    media.removeListener?.(sync);
  };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

export function renderPipeline(
  container?: Element | null,
  activeKey: PipelineStepKey | string | null = ACTIVE_PIPELINE_STEP,
): void {
  const target = container ?? currentDocument()?.getElementById("pipeline");

  if (!target) {
    return;
  }

  const activeIndex =
    activeKey == null ? -1 : PIPELINE_STEPS.findIndex((step) => step.key === activeKey);

  target.innerHTML = PIPELINE_STEPS.map((step, index) => {
    const stateClass =
      activeIndex < 0
        ? ""
        : index < activeIndex
          ? " pipe-step--done"
          : index === activeIndex
            ? " pipe-step--on"
            : "";

    return [
      `<div class="pipe-step${stateClass}" data-step="${escapeHtml(step.key)}">`,
      `<span class="pipe-step__dot">${iconSvg(step.icon, 14)}</span>`,
      `<span class="pipe-step__lbl">${escapeHtml(step.label)}</span>`,
      "</div>",
    ].join("");
  }).join("");
}

export function createExtractCardHtml(text: string, kind?: ExtractCardKind): string;
export function createExtractCardHtml(input: ExtractCardInput): string;
export function createExtractCardHtml(
  input: string | ExtractCardInput,
  kind: ExtractCardKind = "extract",
): string {
  const normalizedText = typeof input === "string" ? input : input.text;
  const normalizedKind = typeof input === "string" ? kind : (input.kind ?? "extract");
  const isCloze = normalizedKind === "cloze";
  const cardIcon = isCloze ? "cloze" : "extract";
  const iconClass = isCloze ? "tico tico--card" : "tico tico--extract";
  const stageColor = isCloze ? "var(--el-card)" : "var(--el-extract)";
  const stageLabel = isCloze ? "Cloze draft" : "Clean extract";
  const schedClass = isCloze ? "sched sched--fsrs" : "sched sched--attn";
  const schedIcon = isCloze ? "brain" : "gauge";
  const schedLabel = isCloze ? "Draft" : "Queued";

  return [
    `<article class="xcard fade-up" data-card-kind="${normalizedKind}">`,
    '<div class="xcard__top">',
    `<span class="${iconClass}">${iconSvg(cardIcon, 14)}</span>`,
    '<span class="stage xcard__stage">',
    `<span class="stage-dot" style="background: ${stageColor}"></span>`,
    escapeHtml(stageLabel),
    "</span>",
    "</div>",
    `<div class="xcard__text">${escapeHtml(normalizedText)}</div>`,
    '<div class="xcard__foot">',
    `<span class="${schedClass}">${iconSvg(schedIcon, 12)}${escapeHtml(schedLabel)}</span>`,
    '<span class="badge prio prio--a">A</span>',
    "</div>",
    "</article>",
  ].join("");
}

export function isReaderAction(action: string | null | undefined): action is ReaderAction {
  return action === "extract" || action === "cloze" || action === "highlight";
}

function selectionNodeInside(container: Element, node: Node | null): boolean {
  return node != null && container.contains(node);
}

function selectionRangeRect(range: Range): DOMRect | null {
  const rangeWithRect = range as Range & { getBoundingClientRect?: () => DOMRect };

  if (typeof rangeWithRect.getBoundingClientRect !== "function") {
    return null;
  }

  return rangeWithRect.getBoundingClientRect();
}

type TextSelectionSegment = {
  node: Text;
  start: number;
  end: number;
};

function selectedTextSegments(reader: Element, range: Range): TextSelectionSegment[] {
  const doc = reader.ownerDocument;
  const showText = doc.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = doc.createTreeWalker(reader, showText);
  const segments: TextSelectionSegment[] = [];

  let current = walker.nextNode();

  while (current) {
    if (current.nodeType === 3 && range.intersectsNode(current)) {
      const textNode = current as Text;
      const start = textNode === range.startContainer ? range.startOffset : 0;
      const end = textNode === range.endContainer ? range.endOffset : textNode.data.length;

      if (start < end && textNode.data.slice(start, end).trim().length > 0) {
        segments.push({ node: textNode, start, end });
      }
    }

    current = walker.nextNode();
  }

  return segments;
}

function wrapTextSegment(
  doc: Document,
  segment: TextSelectionSegment,
  className: string,
): HTMLElement | null {
  const parent = segment.node.parentNode;

  if (!parent) {
    return null;
  }

  const selected = segment.node.splitText(segment.start);
  selected.splitText(segment.end - segment.start);

  const mark = doc.createElement("mark");
  mark.className = className;
  parent.insertBefore(mark, selected);
  mark.appendChild(selected);

  return mark;
}

export function getReaderSelection(doc?: Document, win?: ReaderWindow): ReaderSelection | null {
  const target = doc ?? currentDocument();
  const view = win ?? currentWindow(target);
  const reader = target?.getElementById("readerBody");

  if (!target || !view || !reader) {
    return null;
  }

  const selection = view.getSelection();

  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);

  if (
    !selectionNodeInside(reader, range.commonAncestorContainer) ||
    !selectionNodeInside(reader, selection.anchorNode) ||
    !selectionNodeInside(reader, selection.focusNode)
  ) {
    return null;
  }

  const text = selection.toString().replace(/\s+/g, " ").trim();

  if (text.length === 0) {
    return null;
  }

  return {
    selection,
    range,
    text,
    rect: selectionRangeRect(range),
  };
}

export function hideSelectionToolbar(doc?: Document): void {
  const target = doc ?? currentDocument();
  const toolbar = target?.getElementById("selFloat");

  toolbar?.classList.remove("sel-float--on");
}

export function updateSelectionToolbar(doc?: Document, win?: ReaderWindow): boolean {
  const target = doc ?? currentDocument();
  const view = win ?? currentWindow(target);
  const toolbar = target?.getElementById("selFloat");
  const readerSelection = getReaderSelection(target, view);

  if (!target || !view || !toolbar || !readerSelection?.rect) {
    hideSelectionToolbar(target);
    return false;
  }

  const toolbarElement = toolbar as HTMLElement;
  const rect = readerSelection.rect;
  const leftLimit = Math.max(12, view.innerWidth - toolbarElement.offsetWidth - 12);
  const centeredLeft = rect.left + rect.width / 2 - toolbarElement.offsetWidth / 2;
  const left = Math.min(leftLimit, Math.max(12, centeredLeft));
  const top = Math.max(12, rect.top - toolbarElement.offsetHeight - 10);

  toolbarElement.style.left = `${Math.round(left)}px`;
  toolbarElement.style.top = `${Math.round(top)}px`;
  toolbarElement.classList.add("sel-float--on");

  return true;
}

function updateRailCount(doc: Document): void {
  const rail = doc.getElementById("railBody");
  const railCount = doc.getElementById("railCount");

  if (!rail || !railCount) {
    return;
  }

  railCount.textContent = String(rail.querySelectorAll(".xcard").length);
}

function markReaderSelection(
  doc: Document,
  readerSelection: ReaderSelection,
  action: ReaderAction,
): HTMLElement {
  const reader = doc.getElementById("readerBody");
  const markClass = action === "highlight" ? "hl flash" : "extracted flash";
  const segments = reader ? selectedTextSegments(reader, readerSelection.range) : [];
  const marks: HTMLElement[] = [];

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];

    if (!segment) {
      continue;
    }

    const mark = wrapTextSegment(doc, segment, markClass);

    if (mark) {
      marks.unshift(mark);
    }
  }

  readerSelection.selection.removeAllRanges();

  return marks[0] ?? doc.createElement("mark");
}

export function handleReaderAction(
  action: ReaderAction | string,
  doc?: Document,
  win?: ReaderWindow,
): boolean {
  if (!isReaderAction(action)) {
    return false;
  }

  const target = doc ?? currentDocument();
  const view = win ?? currentWindow(target);
  const readerSelection = getReaderSelection(target, view);

  if (!target || !readerSelection) {
    return false;
  }

  markReaderSelection(target, readerSelection, action);

  if (action !== "highlight") {
    const rail = target.getElementById("railBody");
    rail?.insertAdjacentHTML(
      "afterbegin",
      createExtractCardHtml(readerSelection.text, action === "cloze" ? "cloze" : "extract"),
    );
    updateRailCount(target);
  }

  hideSelectionToolbar(target);

  return true;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as Element | null;

  if (!element || typeof element.closest !== "function") {
    return false;
  }

  return Boolean(element.closest("input, textarea, select, [contenteditable='true']"));
}

function actionForKey(event: KeyboardEvent): ReaderAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }

  switch (event.key.toLowerCase()) {
    case "e":
      return "extract";
    case "c":
      return "cloze";
    case "h":
      return "highlight";
    default:
      return null;
  }
}

export function bindReaderDemo(doc?: Document, win?: ReaderWindow): () => void {
  const target = doc ?? currentDocument();
  const view = win ?? currentWindow(target);

  if (!target || !view) {
    return () => undefined;
  }

  const syncToolbar = () => {
    updateSelectionToolbar(target, view);
  };

  const handleClick = (event: Event) => {
    const action = (event.currentTarget as HTMLElement | null)?.dataset.action;

    if (isReaderAction(action)) {
      handleReaderAction(action, target, view);
    }
  };

  const preserveSelection = (event: Event) => {
    event.preventDefault();
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) {
      return;
    }

    const action = actionForKey(event);

    if (!action || !getReaderSelection(target, view)) {
      return;
    }

    event.preventDefault();
    handleReaderAction(action, target, view);
  };

  target.addEventListener("mouseup", syncToolbar);
  target.addEventListener("keyup", syncToolbar);
  target.addEventListener("selectionchange", syncToolbar);
  target.addEventListener("keydown", handleKeydown);
  view.addEventListener("scroll", syncToolbar, { passive: true });
  view.addEventListener("resize", syncToolbar);

  const buttons = Array.from(target.querySelectorAll<HTMLButtonElement>("[data-action]"));
  for (const button of buttons) {
    button.addEventListener("mousedown", preserveSelection);
    button.addEventListener("click", handleClick);
  }

  return () => {
    target.removeEventListener("mouseup", syncToolbar);
    target.removeEventListener("keyup", syncToolbar);
    target.removeEventListener("selectionchange", syncToolbar);
    target.removeEventListener("keydown", handleKeydown);
    view.removeEventListener("scroll", syncToolbar);
    view.removeEventListener("resize", syncToolbar);

    for (const button of buttons) {
      button.removeEventListener("mousedown", preserveSelection);
      button.removeEventListener("click", handleClick);
    }
  };
}

export function bootstrapSite(doc?: Document, win?: Window): () => void {
  const target = doc ?? currentDocument();
  const view = win ?? currentWindow(target);

  if (!target || !view) {
    return () => undefined;
  }

  paintIcons(target);
  const cleanupTheme = bindSystemTheme(target, view);
  renderPipeline(target.getElementById("pipeline"));
  const cleanupReader = bindReaderDemo(target, view);

  return () => {
    cleanupReader();
    cleanupTheme();
  };
}

function bootstrapBrowserSite(): void {
  const target = currentDocument();
  const view = currentWindow(target);

  if (!target || !view) {
    return;
  }

  const start = () => {
    bootstrapSite(target, view);
  };

  if (target.readyState === "loading") {
    target.addEventListener("DOMContentLoaded", start, { once: true });
    return;
  }

  start();
}

if (import.meta.env.MODE !== "test") {
  bootstrapBrowserSite();
}

/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const processQueueCssPath =
  [
    path.join(process.cwd(), "apps/web/src/pages/queue/process-queue.css"),
    path.join(process.cwd(), "src/pages/queue/process-queue.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const processQueueCss = readFileSync(processQueueCssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(processQueueCss);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("process queue styles", () => {
  it("uses inline session controls instead of the removed page header bar", () => {
    const session = cssBlock(".pq-session");
    const donePanelSession = cssBlock(".pq-donepanel > .pq-session");

    expect(session).toContain("display: flex;");
    expect(session).toContain("padding-bottom: var(--s-3);");
    expect(session).toContain("background: transparent;");
    expect(donePanelSession).toContain("padding: var(--s-4) var(--s-5) var(--s-3);");
  });

  it("opens action-bar popovers upward so they don't clip below the low bar", () => {
    // The bar sits low in the work area; the kebab-anchored delete confirm and the
    // shared Postpone/Done menus must open upward (bottom: 100%) inside .pq-actions.
    const deleteConfirm = cssBlock(".pq-overflow-host .lindel__pop");
    expect(deleteConfirm).toContain("bottom: calc(100% + 6px);");
    expect(deleteConfirm).toContain("top: auto;");

    // The shared Postpone (.schedmenu) / Done (.doneintent) menus get the same upward
    // override, scoped to .pq-actions (a comma-joined rule cssBlock can't parse).
    expect(processQueueCss).toContain(".pq-actions .schedmenu__pop");
    expect(processQueueCss).toContain(".pq-actions .doneintent__pop");
    expect(processQueueCss).toMatch(
      /\.pq-actions \.schedmenu__pop,\s*\.pq-actions \.doneintent__pop \{[^}]*bottom: calc\(100% \+ 6px\);/,
    );
  });

  it("renders source reading as a full-height unframed workbench", () => {
    const center = cssBlock(".pq-center--source");
    const card = cssBlock(".pq-card--source");
    const source = cssBlock(".pq-source");
    const header = cssBlock(".pq-source__header");
    const rail = cssBlock(".pq-source__rail");
    const sourceActions = cssBlock(".pq-card--source .pq-actions");

    expect(center).toContain("align-items: stretch;");
    expect(center).toContain("justify-content: flex-start;");
    expect(center).toContain("overflow: hidden;");
    expect(center).toContain("padding: 0;");
    expect(card).toContain("flex: 1 1 0;");
    expect(card).toContain("height: 100%;");
    expect(card).toContain("max-width: none;");
    expect(card).toContain("border: 0;");
    expect(card).toContain("border-radius: 0;");
    expect(card).toContain("background: transparent;");
    expect(card).toContain("padding: var(--s-4) var(--s-6);");
    expect(source).toContain("flex: 1 1 auto;");
    expect(source).toContain("min-height: 0;");
    expect(header).toContain("margin-inline: calc(var(--s-6) * -1);");
    expect(header).toContain("padding: var(--s-3) var(--s-6) var(--s-2);");
    expect(header).toContain("border-bottom: 1px solid var(--border);");
    expect(rail).toContain("flex: 1 1 auto;");
    // The rail spans the full work-area width so the side gutters fall inside the
    // scroll region; the reading measure is applied to the editor content instead.
    expect(rail).toContain("width: 100%;");
    expect(rail).not.toContain("max-width:");
    expect(sourceActions).toContain("margin-inline: calc(var(--s-6) * -1);");
    expect(sourceActions).toContain("padding-inline: var(--s-6);");
  });

  it("keeps source progress bar in the centered reader rail", () => {
    const pbar = cssBlock(".pq-source__pbar");

    expect(pbar).toContain("width: 100%;");
    expect(pbar).not.toContain("max-width: 320px;");
    // Now the rail is full-width, the pbar carries the reading measure + centering
    // itself so it stays aligned with the text column.
    expect(pbar).toContain("max-width: var(--reader-text-measure);");
    expect(pbar).toContain("margin: 0 auto var(--s-2);");
  });

  it("uses tokenized source header spacing and a rail-local reading caption", () => {
    // The duplicated metadata row was removed (the Inspector owns identity); the
    // reading-position caption is the only survivor and lives in the rail.
    const title = cssBlock(".pq-source__title");
    const railMeta = cssBlock(".pq-source__railmeta");
    const monoMeta = cssBlock(".pq-source__meta--mono");
    const dot = cssBlock(".pq-source__dot");

    expect(title).toContain("margin: 0 0 var(--s-2);");
    expect(railMeta).toContain("gap: var(--s-2);");
    expect(railMeta).toContain("max-width: var(--reader-text-measure);");
    expect(monoMeta).toContain("font-family: var(--font-mono);");
    expect(monoMeta).toContain("font-size: var(--t-2xs);");
    expect(dot).toContain("width: var(--s-1);");
    expect(dot).toContain("height: var(--s-1);");
  });

  it("frames the review card as a three-zone surface where only the body scrolls", () => {
    const center = cssBlock(".pq-center--review");
    const frame = cssBlock(".pq-card--review");
    const cardCenter = cssBlock(".pq-rc-center");
    const card = cssBlock(".pq-rc");
    const head = cssBlock(".pq-rc__head");
    const body = cssBlock(".pq-rc__body");
    const source = cssBlock(".pq-rc__source");
    const foot = cssBlock(".pq-rc__foot");
    const footGrade = cssBlock(".pq-rc__foot .grade");

    // the work area fills height for cards instead of vertically centering
    expect(center).toContain("align-items: stretch;");
    expect(center).toContain("justify-content: flex-start;");
    expect(center).toContain("min-height: 0;");

    // the borderless layout frame holds the chrome; the base .pq-card keeps its flat border
    expect(frame).toContain("flex: 1 1 0;");
    expect(frame).toContain("min-height: 0;");
    expect(frame).toContain("border: 0;");
    expect(frame).toContain("max-width: none;");

    // the centering wrapper bounds the card so it can scroll internally
    expect(cardCenter).toContain("min-height: 0;");
    expect(cardCenter).toContain("overflow: hidden;");

    // the bordered card box never exceeds the viewport — its body scrolls instead
    expect(card).toContain("display: flex;");
    expect(card).toContain("flex-direction: column;");
    expect(card).toContain("min-height: 0;");
    expect(card).toContain("max-height: 100%;");
    expect(card).toContain("overflow: hidden;");

    // header + footer are pinned; only the body owns the single overflow-y scroll
    expect(head).toContain("flex: none;");
    expect(body).toContain("flex: 1 1 auto;");
    expect(body).toContain("min-height: 0;");
    expect(body).toContain("overflow-y: auto;");
    expect(foot).toContain("flex: none;");
    expect(foot).toContain("border-top: 1px solid var(--border);");

    // the source excerpt is bounded + scroll-contained so a large quote can't push the
    // grade footer off-screen, and its wheel scroll doesn't chain out to the body
    expect(source).toContain("max-height: 280px;");
    expect(source).toContain("overflow-y: auto;");
    expect(source).toContain("overscroll-behavior: contain;");

    // card-face grades are left-aligned (the shared review .grade stays centered)
    expect(footGrade).toContain("align-items: flex-start;");
    expect(footGrade).toContain("text-align: left;");
  });

  it("lets the source editor fill the rail without its own border", () => {
    const editor = cssBlock(".pq-source__editor");
    const reader = cssBlock(".pq-source__editor .reader");
    const proseMirror = cssBlock(".pq-source__editor .ProseMirror");

    expect(editor).toContain("border: 0;");
    expect(editor).toContain("border-radius: 0;");
    expect(editor).toContain("background: transparent;");
    expect(editor).toContain("flex: 1 1 auto;");
    expect(editor).toContain("min-height: 0;");
    // The full-width .reader owns the scroll, so wheeling over the side gutters
    // (inside it, beside the centered text) scrolls the source.
    expect(reader).toContain("flex: 1 1 auto;");
    expect(reader).toContain("width: 100%;");
    expect(reader).toContain("max-width: none;");
    expect(reader).toContain("margin: 0;");
    expect(reader).toContain("max-height: none;");
    expect(reader).toContain("overflow-y: auto;");
    // The reading measure lives on the content, keeping the text column centered
    // inside the full-width scroller.
    expect(proseMirror).toContain("max-width: var(--reader-text-measure);");
    expect(proseMirror).toContain("margin: 0 auto;");
  });
});

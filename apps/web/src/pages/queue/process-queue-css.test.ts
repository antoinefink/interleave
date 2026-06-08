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
  it("renders source reading as a full-height unframed workbench", () => {
    const center = cssBlock(".pq-center--source");
    const card = cssBlock(".pq-card--source");
    const source = cssBlock(".pq-source");

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
    expect(source).toContain("flex: 1 1 auto;");
    expect(source).toContain("min-height: 0;");
  });

  it("lets the source editor fill the workbench without its own border", () => {
    const editor = cssBlock(".pq-source__editor");
    const reader = cssBlock(".pq-source__editor .reader");

    expect(editor).toContain("border: 0;");
    expect(editor).toContain("border-radius: 0;");
    expect(editor).toContain("background: transparent;");
    expect(editor).toContain("flex: 1 1 auto;");
    expect(editor).toContain("min-height: 0;");
    expect(reader).toContain("flex: 1 1 auto;");
    expect(reader).toContain("width: 100%;");
    expect(reader).toContain("max-width: var(--reader-text-measure);");
    expect(reader).toContain("margin: 0 auto;");
    expect(reader).not.toContain("max-width: none;");
    expect(reader).toContain("max-height: none;");
    expect(reader).toContain("overflow-y: auto;");
  });
});

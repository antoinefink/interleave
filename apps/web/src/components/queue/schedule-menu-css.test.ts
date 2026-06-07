/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath =
  [
    path.join(process.cwd(), "apps/web/src/components/queue/schedule-menu.css"),
    path.join(process.cwd(), "src/components/queue/schedule-menu.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const css = readFileSync(cssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(css);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("schedule menu CSS", () => {
  it("owns the reusable icon-button trigger styling", () => {
    const trigger = cssBlock(".schedmenu__trigger");

    expect(trigger).toContain("display: inline-flex;");
    expect(trigger).toContain("width: 26px;");
    expect(trigger).toContain("height: 26px;");
    expect(trigger).toContain("border: 1px solid transparent;");
  });

  it("keeps disabled triggers visibly inactive", () => {
    const disabled = cssBlock(".schedmenu__trigger:disabled");

    expect(disabled).toContain("opacity: 0.4;");
    expect(disabled).toContain("cursor: default;");
  });
});

/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const stylesPath =
  [
    path.join(process.cwd(), "apps/web/src/styles.css"),
    path.join(process.cwd(), "src/styles.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const stylesCss = readFileSync(stylesPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(stylesCss);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("global styles", () => {
  it("keeps native date picker icons visible in dark mode", () => {
    const dateInput = cssBlock('input[type="date"]');
    const darkDateInput = cssBlock('[data-theme="dark"] input[type="date"]');
    const indicator = cssBlock('input[type="date"]::-webkit-calendar-picker-indicator');

    expect(dateInput).toContain("color-scheme: light;");
    expect(darkDateInput).toContain("color-scheme: dark;");
    expect(indicator).toContain("cursor: pointer;");
    expect(indicator).toContain("opacity: 0.72;");
  });
});

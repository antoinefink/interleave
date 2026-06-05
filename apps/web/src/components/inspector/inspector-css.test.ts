/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const inspectorCssPath =
  [
    path.join(process.cwd(), "apps/web/src/components/inspector/inspector.css"),
    path.join(process.cwd(), "src/components/inspector/inspector.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const inspectorCss = readFileSync(inspectorCssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(inspectorCss);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("inspector CSS", () => {
  it("keeps prerequisite concept pills separated in the Related section", () => {
    const row = cssBlock(".related-bucket__concepts");

    expect(row).toContain("display: flex;");
    expect(row).toContain("flex-wrap: wrap;");
    expect(row).toContain("gap: 6px;");
  });
});

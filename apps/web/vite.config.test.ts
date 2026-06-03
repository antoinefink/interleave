import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "./vite.config";

describe("web Vite config", () => {
  it("serves the renderer on the fixed desktop dev-server endpoint", () => {
    expect(config.plugins).toHaveLength(2);
    expect(config.server?.host).toBe("0.0.0.0");
    expect(config.server?.port).toBe(5173);
    expect(config.server?.strictPort).toBe(true);
    expect(config.preview?.host).toBe("0.0.0.0");
    expect(config.preview?.port).toBe(5173);
    expect(config.preview?.strictPort).toBe(true);
  });

  it("allows imports from the monorepo root for shared design tokens", () => {
    const allow = config.server?.fs?.allow ?? [];

    expect(allow).toEqual([resolve(import.meta.dirname, "../..")]);
  });
});

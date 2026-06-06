import { describe, expect, it } from "vitest";
import { router } from "./router";

describe("application router", () => {
  it("registers every persistent-shell route", () => {
    const routesByPath = (router as unknown as { routesByPath: Record<string, unknown> })
      .routesByPath;

    expect(Object.keys(routesByPath).sort()).toEqual([
      "/",
      "/analytics",
      "/analytics/sources",
      "/card/$id",
      "/concepts",
      "/extract/$id",
      "/inbox",
      "/library",
      "/maintenance",
      "/maintenance/leeches",
      "/maintenance/retired",
      "/maintenance/stagnant",
      "/process",
      "/queue",
      "/review",
      "/search",
      "/settings",
      "/source/$id",
      "/synthesis/$id",
      "/synthesis/new",
      "/trash",
    ]);
  });
});

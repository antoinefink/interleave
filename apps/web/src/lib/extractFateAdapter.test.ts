import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canReactivateExtractFate,
  canSetExtractFate,
  EXTRACT_FATE_BRIDGE_HINT,
  reactivateExtractFate,
  setExtractFate,
} from "./extractFateAdapter";

describe("extractFateAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.appApi;
  });

  it("does not claim support when the real preload bridge lacks T104 extract fate methods", async () => {
    window.appApi = { extracts: {} } as NonNullable<typeof window.appApi>;

    expect(canSetExtractFate()).toBe(false);
    expect(canReactivateExtractFate()).toBe(false);
    await expect(setExtractFate("ex-1", "reference")).rejects.toThrow(EXTRACT_FATE_BRIDGE_HINT);
    await expect(reactivateExtractFate("ex-1")).rejects.toThrow(EXTRACT_FATE_BRIDGE_HINT);
  });

  it("uses the real preload methods when they exist", async () => {
    const setFate = vi.fn(async () => ({ extract: { id: "ex-1", extractFate: "reference" } }));
    const reactivateFate = vi.fn(async () => ({ extract: { id: "ex-1", extractFate: null } }));
    window.appApi = { extracts: { setFate, reactivateFate } } as unknown as NonNullable<
      typeof window.appApi
    >;

    expect(canSetExtractFate()).toBe(true);
    expect(canReactivateExtractFate()).toBe(true);
    await setExtractFate("ex-1", "reference");
    await reactivateExtractFate("ex-1");
    expect(setFate).toHaveBeenCalledWith({ id: "ex-1", fate: "reference" });
    expect(reactivateFate).toHaveBeenCalledWith({ id: "ex-1" });
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTURE_PORT, loopbackBase, STORAGE_KEYS } from "./shared";

describe("extension shared constants", () => {
  it("pins the loopback capture defaults and storage keys used by every extension surface", () => {
    expect(DEFAULT_CAPTURE_PORT).toBe(47615);
    expect(loopbackBase(DEFAULT_CAPTURE_PORT)).toBe("http://127.0.0.1:47615");
    expect(STORAGE_KEYS).toEqual({
      token: "interleave.token",
      port: "interleave.port",
      recentCaptures: "interleave.recentCaptures",
    });
  });
});

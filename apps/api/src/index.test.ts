import { describe, expect, it } from "vitest";
import { API_APP, apiPlaceholder } from "./index";

describe("api package placeholder", () => {
  it("exports a stable package marker until the backup API is implemented", () => {
    expect(API_APP).toBe("@interleave/api");
    expect(apiPlaceholder()).toBe(API_APP);
  });
});

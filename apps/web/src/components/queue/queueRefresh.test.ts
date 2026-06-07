import { describe, expect, it, vi } from "vitest";
import { listenQueueRefresh, requestQueueRefresh } from "./queueRefresh";

describe("queueRefresh", () => {
  it("notifies mounted queue surfaces and unsubscribes cleanly", () => {
    const handler = vi.fn();
    const unsubscribe = listenQueueRefresh(handler);

    requestQueueRefresh();
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    requestQueueRefresh();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

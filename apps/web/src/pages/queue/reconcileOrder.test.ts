import { describe, expect, it } from "vitest";
import { reconcileOrder } from "./reconcileOrder";

const items = (...ids: string[]) => ids.map((id) => ({ id }));

describe("reconcileOrder", () => {
  it("keeps the user on the current item by id when the fresh queue is unchanged", () => {
    const prev = items("a", "b", "c");
    const r = reconcileOrder(prev, 1, items("a", "b", "c"));
    expect(r.nextOrder.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(r.nextCursor).toBe(1); // still on "b"
    expect(r.newlySeenIds).toEqual(["b", "c"]);
  });

  it("preserves the current item by id even when the fresh score order reshuffles", () => {
    const prev = items("a", "b", "c");
    // cursor at 0 (on "a"); fresh re-ranks a behind b.
    const r = reconcileOrder(prev, 0, items("b", "a", "c"));
    expect(r.nextOrder.map((i) => i.id)).toEqual(["b", "a", "c"]);
    expect(r.nextOrder[r.nextCursor]?.id).toBe("a"); // stayed on "a"
  });

  it("advances to the nearest surviving item when the current item vanished", () => {
    const prev = items("a", "b", "c");
    // on "b" (cursor 1); fresh dropped "b".
    const r = reconcileOrder(prev, 1, items("a", "c", "d"));
    expect(r.nextOrder.map((i) => i.id)).toEqual(["a", "c", "d"]);
    expect(r.nextOrder[r.nextCursor]?.id).toBe("c"); // nearest surviving, not item 0
  });

  it("appends genuinely-new work at the tail without re-jittering the seen prefix", () => {
    const prev = items("a", "b", "c");
    const r = reconcileOrder(prev, 1, items("a", "b", "c", "e"));
    expect(r.nextOrder.map((i) => i.id)).toEqual(["a", "b", "c", "e"]);
    expect(r.nextCursor).toBe(1); // place preserved
    expect(r.newlySeenIds).toContain("e");
  });

  it("keeps a skipped (non-mutating) item in the prefix exactly once", () => {
    const prev = items("a", "b", "c");
    // skipped "a" (cursor moved to 1); "a" is still due and reappears in the fresh read.
    const r = reconcileOrder(prev, 1, items("a", "b", "c"));
    expect(r.nextOrder.filter((i) => i.id === "a")).toHaveLength(1);
  });

  it("stays drained when reconciling a finished deck (new work goes to 'keep going', not a silent resume)", () => {
    const prev = items("a", "b");
    // cursor past the end (done); fresh has a brand-new item "e".
    const r = reconcileOrder(prev, 2, items("a", "b", "e"));
    expect(r.nextOrder.map((i) => i.id)).toEqual(["a", "b", "e"]);
    expect(r.nextCursor).toBe(3); // == length → still done; end-of-order surfaces "e"
    expect(r.newlySeenIds).toEqual(["e"]);
  });

  it("clamps the cursor in range when the upcoming set is empty", () => {
    const prev = items("a", "b", "c");
    const r = reconcileOrder(prev, 1, []);
    expect(r.nextOrder.map((i) => i.id)).toEqual(["a"]); // only the seen prefix survives
    expect(r.nextCursor).toBe(1); // == length → done
    expect(r.nextCursor).toBeLessThanOrEqual(r.nextOrder.length);
  });
});

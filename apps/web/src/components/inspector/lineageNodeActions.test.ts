/**
 * Catalog-builder shape test (U4).
 *
 * `buildLineageNodeMenu` is pure, so these tests assert the produced
 * `ContextMenuItem[]` directly: which ids appear for each node type, the exclusive
 * tombstone branch, the 4-child priority submenu, rename capability-gating, and that
 * each item's `onSelect` calls the matching injected handler with the node (and the
 * priority child with its label).
 */
import { describe, expect, it, vi } from "vitest";
import type { LineageNode } from "../../lib/appApi";
import type { ContextMenuActionItem, ContextMenuItem, ContextMenuSubmenuItem } from "../menu/types";
import { buildLineageNodeMenu, type LineageNodeMenuHandlers } from "./lineageNodeActions";

/** A full handler bag of stubs; `rename` included so it can be omitted per-test. */
function makeHandlers(): {
  [K in keyof Required<LineageNodeMenuHandlers>]: ReturnType<typeof vi.fn>;
} {
  return {
    open: vi.fn(),
    copyReference: vi.fn(),
    copyText: vi.fn(),
    setPriority: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    advanceStage: vi.fn(),
    createCard: vi.fn(),
    postpone: vi.fn(),
    markDone: vi.fn(),
    suspend: vi.fn(),
    flagLeech: vi.fn(),
    retire: vi.fn(),
    restore: vi.fn(),
    restoreAncestorChain: vi.fn(),
    purge: vi.fn(),
  };
}

function makeNode(overrides: Partial<LineageNode> = {}): LineageNode {
  return {
    id: "el-1",
    type: "source",
    title: "On the Measure of Intelligence",
    stage: "raw_source",
    depth: 0,
    meta: "source",
    active: false,
    deleted: false,
    ...overrides,
  };
}

/** Top-level ids in order (separators included as the empty string for readability). */
function topLevelIds(items: readonly ContextMenuItem[]): string[] {
  return items.map((item) => (item.kind === "separator" ? "" : item.id));
}

/** All ids anywhere in the tree (top level + submenu children). */
function allIds(items: readonly ContextMenuItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.kind === "separator") continue;
    ids.push(item.id);
    if (item.kind === "submenu") {
      for (const child of item.items) ids.push(child.id);
    }
  }
  return ids;
}

function findAction(
  items: readonly ContextMenuItem[],
  id: string,
): ContextMenuActionItem | undefined {
  for (const item of items) {
    if (item.kind === "action" && item.id === id) return item;
    if (item.kind === "submenu") {
      const child = item.items.find((c) => c.id === id);
      if (child) return child;
    }
  }
  return undefined;
}

function findSubmenu(
  items: readonly ContextMenuItem[],
  id: string,
): ContextMenuSubmenuItem | undefined {
  const found = items.find(
    (item): item is ContextMenuSubmenuItem => item.kind === "submenu" && item.id === id,
  );
  return found;
}

const ALL_LIVE_IDS = [
  "open",
  "copy-ref",
  "copy-text",
  "priority",
  "priority-A",
  "priority-B",
  "priority-C",
  "priority-D",
  "rename",
  "delete",
];

const EXTRACT_ONLY_IDS = ["advance-stage", "create-card", "postpone", "mark-done"];
const CARD_ONLY_IDS = ["suspend", "flag-leech", "retire"];

describe("buildLineageNodeMenu", () => {
  describe("source node", () => {
    it("contains exactly the All items and no extract/card extras", () => {
      const items = buildLineageNodeMenu(makeNode({ type: "source" }), makeHandlers());
      const ids = allIds(items);
      for (const id of ALL_LIVE_IDS) expect(ids).toContain(id);
      for (const id of [...EXTRACT_ONLY_IDS, ...CARD_ONLY_IDS]) {
        expect(ids).not.toContain(id);
      }
      // none of the tombstone-only ids leak in
      for (const id of ["restore", "restore-chain", "purge", "purge-confirm"]) {
        expect(ids).not.toContain(id);
      }
    });

    it("orders the top-level items open → copy-ref → copy-text → … → priority → rename → delete", () => {
      const items = buildLineageNodeMenu(makeNode({ type: "source" }), makeHandlers());
      const order = topLevelIds(items).filter((id) => id !== "");
      expect(order).toEqual(["open", "copy-ref", "copy-text", "priority", "rename", "delete"]);
    });

    it("exposes a 4-child priority submenu A/B/C/D with hints", () => {
      const items = buildLineageNodeMenu(makeNode({ type: "source" }), makeHandlers());
      const priority = findSubmenu(items, "priority");
      expect(priority).toBeDefined();
      expect(priority?.items.map((c) => c.id)).toEqual([
        "priority-A",
        "priority-B",
        "priority-C",
        "priority-D",
      ]);
      expect(priority?.items.map((c) => c.label)).toEqual(["A", "B", "C", "D"]);
      expect(priority?.items[0].hint).toBe("Highest");
      expect(priority?.items[3].hint).toBe("Low");
    });
  });

  describe("topic node", () => {
    it("matches the source catalog (All items, no extras)", () => {
      const items = buildLineageNodeMenu(makeNode({ type: "topic" }), makeHandlers());
      const ids = allIds(items);
      for (const id of ALL_LIVE_IDS) expect(ids).toContain(id);
      for (const id of [...EXTRACT_ONLY_IDS, ...CARD_ONLY_IDS]) {
        expect(ids).not.toContain(id);
      }
    });
  });

  describe("extract node", () => {
    it("adds Advance stage, Create card, Postpone, Mark done on top of the All items", () => {
      const items = buildLineageNodeMenu(makeNode({ type: "extract" }), makeHandlers());
      const ids = allIds(items);
      for (const id of [...ALL_LIVE_IDS, ...EXTRACT_ONLY_IDS]) expect(ids).toContain(id);
      for (const id of CARD_ONLY_IDS) expect(ids).not.toContain(id);
    });
  });

  describe("card node", () => {
    it("adds Suspend, Flag leech, Retire and offers NO postpone", () => {
      const items = buildLineageNodeMenu(makeNode({ type: "card" }), makeHandlers());
      const ids = allIds(items);
      for (const id of [...ALL_LIVE_IDS, ...CARD_ONLY_IDS]) expect(ids).toContain(id);
      for (const id of EXTRACT_ONLY_IDS) expect(ids).not.toContain(id);
      expect(ids).not.toContain("postpone");
    });
  });

  describe("tombstone node", () => {
    for (const type of ["source", "topic", "extract", "card"]) {
      it(`(${type}) returns only restore / restore-chain / separator / purge submenu`, () => {
        const items = buildLineageNodeMenu(makeNode({ type, deleted: true }), makeHandlers());
        // exact top-level shape: restore, restore-chain, separator, purge submenu
        expect(topLevelIds(items)).toEqual(["restore", "restore-chain", "", "purge"]);
        const purge = findSubmenu(items, "purge");
        expect(purge?.danger).toBe(true);
        expect(purge?.items.map((c) => c.id)).toEqual(["purge-confirm"]);
        expect(purge?.items[0].danger).toBe(true);
        // none of the live-node ids appear
        const ids = allIds(items);
        for (const id of [...ALL_LIVE_IDS, ...EXTRACT_ONLY_IDS, ...CARD_ONLY_IDS]) {
          expect(ids).not.toContain(id);
        }
      });
    }
  });

  describe("rename capability gate", () => {
    it("omits the rename item when no rename handler is provided", () => {
      const { rename: _rename, ...withoutRename } = makeHandlers();
      const items = buildLineageNodeMenu(makeNode(), withoutRename);
      expect(allIds(items)).not.toContain("rename");
    });

    it("includes the rename item when a rename handler is provided", () => {
      const items = buildLineageNodeMenu(makeNode(), makeHandlers());
      expect(allIds(items)).toContain("rename");
    });
  });

  describe("onSelect dispatch", () => {
    it("calls the matching handler with the node for every live action", () => {
      const node = makeNode({ type: "extract" });
      const handlers = makeHandlers();
      const items = buildLineageNodeMenu(node, handlers);

      const cases: Array<[string, ReturnType<typeof vi.fn>]> = [
        ["open", handlers.open],
        ["copy-ref", handlers.copyReference],
        ["copy-text", handlers.copyText],
        ["rename", handlers.rename],
        ["delete", handlers.delete],
        ["advance-stage", handlers.advanceStage],
        ["create-card", handlers.createCard],
        ["postpone", handlers.postpone],
        ["mark-done", handlers.markDone],
      ];

      for (const [id, handler] of cases) {
        const item = findAction(items, id);
        expect(item, `missing action ${id}`).toBeDefined();
        item?.onSelect();
        expect(handler).toHaveBeenCalledWith(node);
      }
    });

    it("calls the card handlers with the node", () => {
      const node = makeNode({ type: "card" });
      const handlers = makeHandlers();
      const items = buildLineageNodeMenu(node, handlers);

      findAction(items, "suspend")?.onSelect();
      findAction(items, "flag-leech")?.onSelect();
      findAction(items, "retire")?.onSelect();

      expect(handlers.suspend).toHaveBeenCalledWith(node);
      expect(handlers.flagLeech).toHaveBeenCalledWith(node);
      expect(handlers.retire).toHaveBeenCalledWith(node);
    });

    it("priority children call setPriority(node, label)", () => {
      const node = makeNode();
      const handlers = makeHandlers();
      const items = buildLineageNodeMenu(node, handlers);

      findAction(items, "priority-B")?.onSelect();
      expect(handlers.setPriority).toHaveBeenCalledWith(node, "B");

      findAction(items, "priority-A")?.onSelect();
      findAction(items, "priority-C")?.onSelect();
      findAction(items, "priority-D")?.onSelect();
      expect(handlers.setPriority).toHaveBeenCalledWith(node, "A");
      expect(handlers.setPriority).toHaveBeenCalledWith(node, "C");
      expect(handlers.setPriority).toHaveBeenCalledWith(node, "D");
    });

    it("tombstone actions call restore / restoreAncestorChain / purge with the node", () => {
      const node = makeNode({ deleted: true });
      const handlers = makeHandlers();
      const items = buildLineageNodeMenu(node, handlers);

      findAction(items, "restore")?.onSelect();
      findAction(items, "restore-chain")?.onSelect();
      findAction(items, "purge-confirm")?.onSelect();

      expect(handlers.restore).toHaveBeenCalledWith(node);
      expect(handlers.restoreAncestorChain).toHaveBeenCalledWith(node);
      expect(handlers.purge).toHaveBeenCalledWith(node);
    });
  });
});

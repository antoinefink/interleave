/**
 * Stable block-id tests (T016).
 *
 * These prove the single most load-bearing guarantee in the document layer: a
 * block's id is assigned once and PRESERVED across editing, serializing,
 * re-parsing, reordering, and re-importing — only genuinely new blocks get fresh
 * ids. They run headlessly against a ProseMirror `EditorState` (no DOM): the
 * additive filler is extracted as `fillMissingBlockIds`, which both the live
 * plugin and these tests call, so the preservation logic is exercised without a
 * browser.
 */

import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { BLOCK_ID_DOM_ATTR, BLOCK_ID_NODE_TYPES, fillMissingBlockIds } from "./block-id";
import { newBlockId } from "./block-ids";
import { blockIdsOf, toBlockInputs } from "./blocks";
import { buildSchema } from "./schema";

const schema = buildSchema();

/** A deterministic, monotonic minter so test expectations are stable. */
function counterMinter(prefix = "id") {
  let n = 0;
  return () => `${prefix}_${String(n++).padStart(3, "0")}` as ReturnType<typeof newBlockId>;
}

/** Build an EditorState from doc JSON, run the filler once, return the filled doc JSON. */
function fillOnce(json: unknown, mint = counterMinter()): unknown {
  let state = EditorState.create({ schema, doc: PmNode.fromJSON(schema, json) });
  const tr = fillMissingBlockIds(state, mint);
  if (tr) state = state.apply(tr);
  return state.doc.toJSON();
}

const PARA = (text: string, blockId?: string) => ({
  type: "paragraph",
  ...(blockId ? { attrs: { blockId } } : {}),
  content: [{ type: "text", text }],
});

describe("newBlockId — renderer-safe ULID minter", () => {
  it("mints 26-char Crockford-base32 ULIDs", () => {
    const id = newBlockId();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is collision-resistant across many mints", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newBlockId()));
    expect(ids.size).toBe(5000);
  });

  it("is lexicographically time-ordered (later mint sorts after earlier)", () => {
    const a = newBlockId();
    // Sequential mints within the same ms share the time prefix; across a tick
    // boundary the prefix increases. Compare the 10-char time component only.
    const b = newBlockId();
    expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true);
  });
});

describe("fillMissingBlockIds — strictly additive", () => {
  it("mints an id for every block that lacks one", () => {
    const json = {
      type: "doc",
      content: [PARA("first"), PARA("second"), { type: "horizontalRule" }],
    };
    const ids = blockIdsOf(fillOnce(json));
    expect(ids).toEqual(["id_000", "id_001", "id_002"]);
  });

  it("does NOT change a block that already has an id (preservation)", () => {
    const json = {
      type: "doc",
      content: [PARA("kept", "EXISTING_A"), PARA("new")],
    };
    const ids = blockIdsOf(fillOnce(json));
    // The existing id is preserved; only the second block gets a fresh one.
    expect(ids[0]).toBe("EXISTING_A");
    expect(ids[1]).toBe("id_000");
  });

  it("returns no transaction when every block already has a unique id (no churn)", () => {
    const json = {
      type: "doc",
      content: [PARA("a", "X1"), PARA("b", "X2")],
    };
    const state = EditorState.create({ schema, doc: PmNode.fromJSON(schema, json) });
    expect(fillMissingBlockIds(state, counterMinter())).toBeUndefined();
  });

  it("assigns ids to list items (granularity) but not list containers", () => {
    const json = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [PARA("one")] },
            { type: "listItem", content: [PARA("two")] },
          ],
        },
      ],
    };
    const filled = fillOnce(json) as { content: { type: string; attrs?: { blockId?: string } }[] };
    // The container carries no blockId; its items + their paragraphs do.
    expect(filled.content[0]?.type).toBe("bulletList");
    expect(filled.content[0]?.attrs?.blockId).toBeUndefined();
    const inputs = toBlockInputs(filled);
    expect(inputs.some((b) => b.blockType === "listItem")).toBe(true);
    expect(inputs.some((b) => b.blockType === "bulletList")).toBe(false);
  });

  it("re-mints a same-document duplicate id but keeps the first occurrence", () => {
    const json = {
      type: "doc",
      content: [PARA("a", "DUP"), PARA("b", "DUP")],
    };
    const ids = blockIdsOf(fillOnce(json));
    expect(ids[0]).toBe("DUP");
    expect(ids[1]).not.toBe("DUP");
    expect(new Set(ids).size).toBe(2);
  });
});

describe("preservation across edit → serialize → re-parse", () => {
  it("round-trips identical blockIds through a JSON re-parse", () => {
    const filled = fillOnce({ type: "doc", content: [PARA("a"), PARA("b"), PARA("c")] });
    const before = blockIdsOf(filled);

    // Serialize → re-parse (what save → reload does) and re-run the filler:
    // nothing should change because every block already has an id.
    const reloaded = fillOnce(JSON.parse(JSON.stringify(filled)), counterMinter());
    expect(blockIdsOf(reloaded)).toEqual(before);
  });

  it("inserting a new paragraph mints exactly ONE new id, leaving others untouched", () => {
    const filled = fillOnce(
      { type: "doc", content: [PARA("a"), PARA("b")] },
      counterMinter("orig"),
    ) as {
      type: string;
      content: unknown[];
    };
    const original = blockIdsOf(filled);

    // Insert a fresh (id-less) paragraph in the middle, then re-run the filler
    // with a DISTINCT minter so a new id is unmistakably distinguishable.
    const edited = {
      type: "doc",
      content: [filled.content[0], PARA("inserted"), filled.content[1]],
    };
    const result = blockIdsOf(fillOnce(edited, counterMinter("new")));

    expect(result).toHaveLength(3);
    // Originals kept their ids, in place.
    expect(result[0]).toBe(original[0]);
    expect(result[2]).toBe(original[1]);
    // Exactly one brand-new id was minted (the inserted block).
    expect(result[1]).toBe("new_000");
    expect(result[1]).not.toBe(original[0]);
    expect(result[1]).not.toBe(original[1]);
  });

  it("reordering blocks preserves ids — only `order` changes", () => {
    const filled = fillOnce({ type: "doc", content: [PARA("a"), PARA("b"), PARA("c")] }) as {
      content: unknown[];
    };
    const before = toBlockInputs(filled);

    const reordered = {
      type: "doc",
      content: [filled.content[2], filled.content[0], filled.content[1]],
    };
    const after = toBlockInputs(fillOnce(reordered, counterMinter()));

    // Same id set, in the new order, with re-sequenced `order` values.
    expect(after.map((b) => b.stableBlockId)).toEqual([
      before[2]?.stableBlockId,
      before[0]?.stableBlockId,
      before[1]?.stableBlockId,
    ]);
    expect(after.map((b) => b.order)).toEqual([0, 1, 2]);
  });
});

describe("the blockId attribute is part of the schema + renders to data-block-id", () => {
  it("registers blockId on exactly the block-level node types", () => {
    for (const name of BLOCK_ID_NODE_TYPES) {
      expect(
        schema.nodes[name]?.spec.attrs?.blockId,
        `${name} should accept blockId`,
      ).toBeDefined();
    }
    // List containers do NOT carry a blockId.
    expect(schema.nodes.bulletList?.spec.attrs?.blockId).toBeUndefined();
    expect(schema.nodes.orderedList?.spec.attrs?.blockId).toBeUndefined();
  });

  it("renders blockId to the DOM as data-block-id", () => {
    const filled = fillOnce({ type: "doc", content: [PARA("hello")] });
    const node = PmNode.fromJSON(schema, filled);
    const para = node.firstChild;
    expect(para).not.toBeNull();
    const rendered = para?.type.spec.toDOM?.(para) as [
      string,
      Record<string, string>,
      ...unknown[],
    ];
    expect(rendered[1][BLOCK_ID_DOM_ATTR]).toMatch(/^id_/);
  });
});

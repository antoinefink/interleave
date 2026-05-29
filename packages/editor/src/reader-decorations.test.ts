/**
 * Reader decoration plugin tests (T018).
 *
 * The reader overlays a `.readpoint` divider + `mark.extracted` display markers on
 * the live editor as ProseMirror DECORATIONS (not DOM mutation), anchored to the
 * stable block ids (T016). These tests run headlessly against an `EditorState`
 * built with the constrained schema + the {@link ReaderDecorations} plugin: they
 * push inputs through {@link setReaderDecorations}'s meta and assert the resulting
 * `DecorationSet` carries the right node/widget decorations — no DOM/browser, so
 * they run in plain Vitest. (The end-to-end DOM rendering is covered by the
 * Playwright reader spec.)
 */

import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";
import {
  createReaderDecorationsPlugin,
  type ReaderDecorationState,
  readerDecorationsKey,
} from "./reader-decorations";
import { buildSchema } from "./schema";

// One schema (the constrained one, with the `blockId` attribute) shared by all
// tests — building it via the package's own `buildSchema` keeps a single
// prosemirror-model instance (mixing compile paths loads two and throws).
const schema = buildSchema();

/** Build a headless EditorState with the reader-decoration plugin installed. */
function buildState(docJson: unknown): EditorState {
  return EditorState.create({
    schema,
    doc: PmNode.fromJSON(schema, docJson),
    plugins: [createReaderDecorationsPlugin()],
  });
}

const PARA = (text: string, blockId: string) => ({
  type: "paragraph",
  attrs: { blockId },
  content: [{ type: "text", text }],
});

const DOC = {
  type: "doc",
  content: [PARA("first", "b1"), PARA("second", "b2"), PARA("third", "b3")],
};

/** A fully-defaulted decoration-input state; spread + override the fields a test needs. */
const BASE: ReaderDecorationState = {
  firstUnreadBlockId: null,
  readPointBlockId: null,
  extractedBlockIds: [],
  highlights: [],
};

/** Apply a decoration-input meta to the state (mirrors `setReaderDecorations`). */
function withInputs(state: EditorState, inputs: Partial<ReaderDecorationState>): EditorState {
  const tr = state.tr.setMeta(readerDecorationsKey, { state: { ...BASE, ...inputs } });
  return state.apply(tr);
}

/** A structural view of a decoration's runtime internals (not in the public types). */
interface DecorationInternal {
  readonly type?: { readonly attrs?: Record<string, string> };
  readonly spec?: { readonly key?: string };
}

/** Read the plugin's current decoration set (its `decorations` prop output). */
function decorationsOf(state: EditorState): DecorationSet {
  const plugin = readerDecorationsKey.get(state);
  const set = plugin?.props.decorations?.call(plugin, state) as DecorationSet | null | undefined;
  return set ?? DecorationSet.empty;
}

describe("ReaderDecorations plugin", () => {
  it("draws no decorations when no inputs are pushed", () => {
    const state = buildState(DOC);
    const set = decorationsOf(state);
    expect(set.find()).toHaveLength(0);
  });

  it("adds the `extracted` class to extracted blocks only", () => {
    const state = withInputs(buildState(DOC), {
      firstUnreadBlockId: null,
      readPointBlockId: null,
      extractedBlockIds: ["b2"],
    });
    const decos = decorationsOf(state).find();
    // One node decoration carrying the `extracted` class (node-decoration attrs
    // live on `decoration.type.attrs`).
    const extracted = decos.filter((d) =>
      (d as unknown as DecorationInternal).type?.attrs?.class?.includes("extracted"),
    );
    expect(extracted).toHaveLength(1);
  });

  it("inserts a widget divider before the first unread block", () => {
    const state = withInputs(buildState(DOC), {
      firstUnreadBlockId: "b2",
      readPointBlockId: "b1",
      extractedBlockIds: [],
    });
    const decos = decorationsOf(state).find();
    // A widget decoration keyed to the read-point divider exists.
    const widget = decos.filter(
      (d) => (d as unknown as DecorationInternal).spec?.key === "readpoint-divider",
    );
    expect(widget).toHaveLength(1);
  });

  it("marks the read-point block with the resume-anchor attribute", () => {
    const state = withInputs(buildState(DOC), {
      firstUnreadBlockId: "b2",
      readPointBlockId: "b1",
      extractedBlockIds: [],
    });
    const decos = decorationsOf(state).find();
    const anchor = decos.filter(
      (d) => (d as unknown as DecorationInternal).type?.attrs?.["data-readpoint-block"] === "true",
    );
    expect(anchor).toHaveLength(1);
  });

  it("re-derives decorations after the inputs change (idempotent push)", () => {
    let state = withInputs(buildState(DOC), {
      firstUnreadBlockId: "b2",
      readPointBlockId: null,
      extractedBlockIds: ["b1"],
    });
    expect(decorationsOf(state).find()).not.toHaveLength(0);
    // Clear the inputs again → no decorations.
    state = withInputs(state, {
      firstUnreadBlockId: null,
      readPointBlockId: null,
      extractedBlockIds: [],
    });
    expect(decorationsOf(state).find()).toHaveLength(0);
  });

  it("overlays a persisted highlight as an inline `hl` decoration with its mark id", () => {
    const state = withInputs(buildState(DOC), {
      highlights: [{ markId: "m1", blockId: "b2", start: 0, end: 6 }],
    });
    const decos = decorationsOf(state).find();
    const inline = decos.filter(
      (d) => (d as unknown as DecorationInternal).type?.attrs?.class === "hl",
    );
    expect(inline).toHaveLength(1);
    expect((inline[0] as unknown as DecorationInternal).type?.attrs?.["data-mark-id"]).toBe("m1");
  });

  it("clamps a highlight range to the block text length", () => {
    // "first" is 5 chars; an end of 999 must clamp so the decoration never runs
    // past the block (a stale/over-long range can't produce a bad position).
    const state = withInputs(buildState(DOC), {
      highlights: [{ markId: "m1", blockId: "b1", start: 0, end: 999 }],
    });
    const inline = decorationsOf(state)
      .find()
      .filter((d) => (d as unknown as DecorationInternal).type?.attrs?.class === "hl");
    expect(inline).toHaveLength(1);
    // The decoration's `to` must not exceed the block's text end (b1 text = "first").
    const deco = inline[0];
    if (!deco) throw new Error("expected one highlight decoration");
    expect(deco.to - deco.from).toBe(5);
  });

  it("drops a degenerate highlight (end <= start) without throwing", () => {
    const state = withInputs(buildState(DOC), {
      highlights: [{ markId: "m1", blockId: "b1", start: 3, end: 3 }],
    });
    const inline = decorationsOf(state)
      .find()
      .filter((d) => (d as unknown as DecorationInternal).type?.attrs?.class === "hl");
    expect(inline).toHaveLength(0);
  });
});

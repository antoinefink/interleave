import { BLOCK_ID_DOM_ATTR, type Editor } from "@interleave/editor";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessedSpanButtons } from "./ProcessedSpanButtons";
import type { UseProcessedSpansResult } from "./useProcessedSpans";

function setRect(el: HTMLElement, top: number): void {
  el.getBoundingClientRect = vi.fn(() => ({
    top,
    left: 0,
    right: 100,
    bottom: top + 20,
    width: 100,
    height: 20,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }));
}

function buildEditorDom(): { rail: HTMLElement; editor: Editor } {
  const rail = document.createElement("div");
  rail.className = "reader-rail";
  setRect(rail, 100);

  const editorDom = document.createElement("div");
  const paragraphA = document.createElement("p");
  paragraphA.setAttribute(BLOCK_ID_DOM_ATTR, "blk-a");
  setRect(paragraphA, 140);
  const heading = document.createElement("h2");
  heading.setAttribute(BLOCK_ID_DOM_ATTR, "blk-heading");
  setRect(heading, 160);
  const paragraphB = document.createElement("p");
  paragraphB.setAttribute(BLOCK_ID_DOM_ATTR, "blk-b");
  setRect(paragraphB, 190);

  editorDom.append(paragraphA, heading, paragraphB);
  rail.append(editorDom);
  document.body.append(rail);

  const editor = {
    view: { dom: editorDom },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Editor;
  return { rail, editor };
}

function processed(
  processedIds: readonly string[] = [],
  states: Partial<Record<string, ReturnType<UseProcessedSpansResult["stateFor"]>>> = {},
): UseProcessedSpansResult {
  return {
    processed: processedIds.map((blockId) => ({ blockId, markId: `mark-${blockId}` })),
    blocks: [],
    summary: null,
    isProcessed: (blockId: string) => processedIds.includes(blockId),
    markIdFor: (blockId: string) => (processedIds.includes(blockId) ? `mark-${blockId}` : null),
    stateFor: (blockId: string) =>
      states[blockId] ?? (processedIds.includes(blockId) ? "processed_without_output" : "unread"),
    mark: vi.fn(async () => true),
    restore: vi.fn(async () => true),
    toggle: vi.fn(async (blockId: string) =>
      processedIds.includes(blockId) ? "restored" : "marked",
    ),
    markIgnored: vi.fn(async () => true),
    markNeedsLater: vi.fn(async () => true),
    reload: vi.fn(async () => undefined),
    error: null,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ProcessedSpanButtons", () => {
  it("measures paragraph blocks only and renders positioned toggle buttons", async () => {
    const { editor } = buildEditorDom();
    const model = processed(["blk-b"]);
    const { getByTestId, queryByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={model} revision={0} />,
    );

    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());
    expect(queryByTestId("processed-toggle-blk-heading")).not.toBeInTheDocument();
    expect(getByTestId("processed-toggle-blk-a").closest(".readpara__actions")).toHaveStyle({
      top: "40px",
    });
    expect(getByTestId("processed-toggle-blk-a")).toHaveAttribute("aria-pressed", "false");
    expect(getByTestId("processed-toggle-blk-a")).toHaveAccessibleName("Mark paragraph processed");
    expect(getByTestId("processed-toggle-blk-a")).toHaveAttribute(
      "title",
      "Mark processed without output",
    );
    expect(getByTestId("processed-toggle-blk-b").closest(".readpara__actions")).toHaveStyle({
      top: "90px",
    });
    expect(getByTestId("processed-toggle-blk-b")).toHaveAttribute("aria-pressed", "true");
    expect(getByTestId("processed-toggle-blk-b")).toHaveAccessibleName(
      "Restore processed paragraph",
    );
    expect(getByTestId("processed-ignore-blk-a")).toHaveAccessibleName("Ignore paragraph");
    expect(getByTestId("processed-needs-later-blk-a")).toHaveAccessibleName(
      "Mark paragraph needs later",
    );
  });

  it("delegates toggle and reports whether the action marked or restored", async () => {
    const { editor } = buildEditorDom();
    const onToggled = vi.fn();
    const model = processed(["blk-b"]);
    const { getByTestId } = render(
      <ProcessedSpanButtons
        editor={editor}
        editorReady
        processed={model}
        revision={0}
        onToggled={onToggled}
      />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    fireEvent.click(getByTestId("processed-toggle-blk-a"));
    fireEvent.click(getByTestId("processed-toggle-blk-b"));

    await waitFor(() => expect(model.toggle).toHaveBeenCalledTimes(2));
    expect(model.toggle).toHaveBeenNthCalledWith(1, "blk-a");
    expect(model.toggle).toHaveBeenNthCalledWith(2, "blk-b");
    await waitFor(() => expect(onToggled).toHaveBeenCalledWith("marked"));
    expect(onToggled).toHaveBeenCalledWith("restored");
  });

  it("delegates ignore and needs-later actions", async () => {
    const { editor } = buildEditorDom();
    const onToggled = vi.fn();
    const model = processed();
    const { getByTestId } = render(
      <ProcessedSpanButtons
        editor={editor}
        editorReady
        processed={model}
        revision={0}
        onToggled={onToggled}
      />,
    );
    await waitFor(() => expect(getByTestId("processed-ignore-blk-a")).toBeInTheDocument());

    fireEvent.click(getByTestId("processed-ignore-blk-a"));
    fireEvent.click(getByTestId("processed-needs-later-blk-a"));

    await waitFor(() => expect(model.markIgnored).toHaveBeenCalledWith("blk-a"));
    expect(model.markNeedsLater).toHaveBeenCalledWith("blk-a");
    expect(onToggled).toHaveBeenCalledWith("marked");
  });

  it("disables restore and secondary actions for extracted blocks", async () => {
    const { editor } = buildEditorDom();
    const model = processed(["blk-a"], { "blk-a": "extracted" });
    const { getByTestId } = render(
      <ProcessedSpanButtons editor={editor} editorReady processed={model} revision={0} />,
    );

    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    expect(getByTestId("processed-toggle-blk-a")).toBeDisabled();
    expect(getByTestId("processed-toggle-blk-a")).toHaveAccessibleName("Extracted paragraph");
    expect(getByTestId("processed-ignore-blk-a")).toBeDisabled();
    expect(getByTestId("processed-needs-later-blk-a")).toBeDisabled();

    fireEvent.click(getByTestId("processed-toggle-blk-a"));
    fireEvent.click(getByTestId("processed-ignore-blk-a"));
    fireEvent.click(getByTestId("processed-needs-later-blk-a"));

    expect(model.toggle).not.toHaveBeenCalled();
    expect(model.markIgnored).not.toHaveBeenCalled();
    expect(model.markNeedsLater).not.toHaveBeenCalled();
  });

  it("does not render controls for blocks hidden by the active reader filter", async () => {
    const { editor } = buildEditorDom();
    const model = processed(["blk-a", "blk-b"], {
      "blk-a": "processed_without_output",
      "blk-b": "needs_later",
    });
    const { getByTestId, queryByTestId } = render(
      <ProcessedSpanButtons
        editor={editor}
        editorReady
        processed={model}
        processingFilter="unresolved"
        revision={0}
      />,
    );

    await waitFor(() => expect(getByTestId("processed-toggle-blk-b")).toBeInTheDocument());
    expect(queryByTestId("processed-toggle-blk-a")).not.toBeInTheDocument();
  });

  it("reports a toggle failure without calling the success handler", async () => {
    const { editor } = buildEditorDom();
    const onToggled = vi.fn();
    const onToggleFailed = vi.fn();
    const model = processed();
    vi.mocked(model.toggle).mockResolvedValue(null);
    const { getByTestId } = render(
      <ProcessedSpanButtons
        editor={editor}
        editorReady
        processed={model}
        revision={0}
        onToggled={onToggled}
        onToggleFailed={onToggleFailed}
      />,
    );
    await waitFor(() => expect(getByTestId("processed-toggle-blk-a")).toBeInTheDocument());

    fireEvent.click(getByTestId("processed-toggle-blk-a"));

    await waitFor(() => expect(onToggleFailed).toHaveBeenCalled());
    expect(onToggled).not.toHaveBeenCalled();
  });

  it("clears anchors when the editor is not ready", () => {
    const { editor } = buildEditorDom();
    const { getByTestId, queryByTestId } = render(
      <ProcessedSpanButtons
        editor={editor}
        editorReady={false}
        processed={processed()}
        revision={0}
      />,
    );

    expect(getByTestId("processed-overlay")).toBeInTheDocument();
    expect(queryByTestId("processed-toggle-blk-a")).not.toBeInTheDocument();
  });
});

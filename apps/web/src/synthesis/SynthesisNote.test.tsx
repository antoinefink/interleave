import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  navigate: vi.fn(),
  select: vi.fn(),
  requestInspectorRefresh: vi.fn(),
  getSynthesisNote: vi.fn(),
  getDocument: vi.fn(),
  editSynthesisBody: vi.fn(),
  scheduleSynthesisReturn: vi.fn(),
  unlinkSynthesisElement: vi.fn(),
  linkSynthesisElement: vi.fn(),
  toBlockInputs: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
  useParams: () => ({ id: "note-1" }),
}));

vi.mock("@interleave/editor", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const actual = await vi.importActual<typeof import("@interleave/editor")>("@interleave/editor");
  return {
    ...actual,
    SourceEditor: ({
      onChange,
      onEditorReady,
    }: {
      onChange?: (change: { prosemirrorJson: unknown; plainText: string }) => void;
      onEditorReady?: (editor: { getJSON: () => unknown } | null) => void;
    }) => {
      React.useEffect(() => {
        onEditorReady?.({ getJSON: () => ({ type: "doc", content: [] }) });
        return () => onEditorReady?.(null);
      }, [onEditorReady]);
      return React.createElement(
        "button",
        {
          type: "button",
          "data-testid": "mock-source-editor",
          onClick: () =>
            onChange?.({
              prosemirrorJson: { type: "doc", content: [{ type: "paragraph" }] },
              plainText: "updated body",
            }),
        },
        "Edit body",
      );
    },
    toBlockInputs: h.toBlockInputs,
  };
});

vi.mock("../components/inspector/Inspector", () => ({
  requestInspectorRefresh: h.requestInspectorRefresh,
}));

vi.mock("../shell/selection", () => ({
  useSelection: () => ({ select: h.select }),
}));

vi.mock("./AddToNote", () => ({
  AddToNote: ({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) => (
    <div data-testid="mock-add-to-note">
      <button type="button" data-testid="mock-pick" onClick={() => onPick("card-2")}>
        Pick
      </button>
      <button type="button" data-testid="mock-close" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      getSynthesisNote: h.getSynthesisNote,
      getDocument: h.getDocument,
      editSynthesisBody: h.editSynthesisBody,
      scheduleSynthesisReturn: h.scheduleSynthesisReturn,
      unlinkSynthesisElement: h.unlinkSynthesisElement,
      linkSynthesisElement: h.linkSynthesisElement,
    },
  };
});

import { SynthesisNote } from "./SynthesisNote";

const noteData = {
  element: {
    id: "note-1",
    type: "synthesis_note",
    status: "active",
    stage: "synthesis",
    priority: 0.875,
    title: "Big idea",
    dueAt: null,
  },
  linked: [
    {
      id: "ext-1",
      relationId: "rel-1",
      type: "extract",
      title: "Linked extract",
    },
    {
      id: "card-1",
      relationId: "rel-2",
      type: "card",
      title: "Linked card",
    },
  ],
};

beforeEach(() => {
  h.desktop = true;
  h.navigate.mockReset();
  h.select.mockReset();
  h.requestInspectorRefresh.mockReset();
  h.getSynthesisNote.mockReset();
  h.getDocument.mockReset();
  h.editSynthesisBody.mockReset();
  h.scheduleSynthesisReturn.mockReset();
  h.unlinkSynthesisElement.mockReset();
  h.linkSynthesisElement.mockReset();
  h.toBlockInputs.mockReset();

  h.getSynthesisNote.mockResolvedValue({ data: noteData });
  h.getDocument.mockResolvedValue({
    document: { prosemirrorJson: { type: "doc", content: [] }, plainText: "Body" },
  });
  h.editSynthesisBody.mockResolvedValue({});
  h.toBlockInputs.mockReturnValue([{ stableBlockId: "b1", blockType: "paragraph", order: 0 }]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SynthesisNote", () => {
  it("renders the desktop-only fallback without the bridge", () => {
    h.desktop = false;
    const { getByTestId, getByText } = render(<SynthesisNote />);

    expect(getByTestId("route-synthesis")).toBeInTheDocument();
    expect(getByText(/open the Electron app/i)).toBeInTheDocument();
    expect(h.getSynthesisNote).not.toHaveBeenCalled();
  });

  it("loads note metadata, linked material, document body, and selects the note", async () => {
    const { getByTestId, getAllByTestId } = render(<SynthesisNote />);

    await waitFor(() => expect(getByTestId("synthesis-title")).toHaveTextContent("Big idea"));
    expect(h.getSynthesisNote).toHaveBeenCalledWith({ noteId: "note-1" });
    expect(h.getDocument).toHaveBeenCalledWith({ elementId: "note-1" });
    expect(h.select).toHaveBeenCalledWith("note-1");
    expect(getAllByTestId("synthesis-linked-row")).toHaveLength(2);
    expect(getByTestId("mock-source-editor")).toBeInTheDocument();
  });

  it("opens linked extracts through navigation and cards through cleared selection plus card detail navigation", async () => {
    const { getAllByTestId } = render(<SynthesisNote />);

    await waitFor(() => expect(getAllByTestId("synthesis-linked-open")).toHaveLength(2));
    h.navigate.mockClear();
    h.select.mockClear();

    fireEvent.click(getAllByTestId("synthesis-linked-open")[0] as HTMLElement);
    expect(h.navigate).toHaveBeenCalledWith({ to: "/extract/$id", params: { id: "ext-1" } });

    fireEvent.click(getAllByTestId("synthesis-linked-open")[1] as HTMLElement);
    expect(h.select).toHaveBeenCalledWith(null);
    expect(h.navigate).toHaveBeenLastCalledWith({ to: "/card/$id", params: { id: "card-1" } });
  });

  it("schedules return and refreshes inspector state", async () => {
    const scheduled = {
      ...noteData,
      element: { ...noteData.element, dueAt: "2026-06-04T00:00:00.000Z" },
      dueAt: "2026-06-04T00:00:00.000Z",
    };
    h.scheduleSynthesisReturn.mockResolvedValue({ data: scheduled });
    const { getByTestId, findByTestId } = render(<SynthesisNote />);

    await findByTestId("synthesis-return-tomorrow");
    fireEvent.click(getByTestId("synthesis-return-tomorrow"));

    await waitFor(() =>
      expect(h.scheduleSynthesisReturn).toHaveBeenCalledWith({
        noteId: "note-1",
        when: { kind: "tomorrow" },
      }),
    );
    expect(h.requestInspectorRefresh).toHaveBeenCalled();
    expect(getByTestId("synthesis-due")).toHaveTextContent("2026-06-04");
  });

  it("unlinks and links material through the synthesis bridge", async () => {
    h.unlinkSynthesisElement.mockResolvedValue({
      data: { ...noteData, linked: [noteData.linked[1]] },
    });
    h.linkSynthesisElement.mockResolvedValue({
      data: {
        ...noteData,
        linked: [
          ...noteData.linked,
          { id: "card-2", relationId: "rel-3", type: "card", title: "New card" },
        ],
      },
    });
    const { getAllByTestId, getByTestId, findByTestId } = render(<SynthesisNote />);

    await waitFor(() => expect(getAllByTestId("synthesis-linked-remove")).toHaveLength(2));
    fireEvent.click(getAllByTestId("synthesis-linked-remove")[0] as HTMLElement);
    await waitFor(() =>
      expect(h.unlinkSynthesisElement).toHaveBeenCalledWith({
        noteId: "note-1",
        targetId: "ext-1",
      }),
    );

    fireEvent.click(getByTestId("synthesis-add"));
    fireEvent.click(await findByTestId("mock-pick"));
    await waitFor(() =>
      expect(h.linkSynthesisElement).toHaveBeenCalledWith({
        noteId: "note-1",
        targetId: "card-2",
      }),
    );
  });

  it("debounces body edits and sends block inputs from the live editor", async () => {
    const { getByTestId } = render(<SynthesisNote />);

    await waitFor(() => expect(getByTestId("mock-source-editor")).toBeInTheDocument());
    vi.useFakeTimers();
    fireEvent.click(getByTestId("mock-source-editor"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(h.editSynthesisBody).toHaveBeenCalledWith({
      noteId: "note-1",
      prosemirrorJson: { type: "doc", content: [{ type: "paragraph" }] },
      plainText: "updated body",
      blocks: [{ stableBlockId: "b1", blockType: "paragraph", order: 0 }],
    });
  });
});

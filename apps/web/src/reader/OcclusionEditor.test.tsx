/**
 * OcclusionEditor component tests (T071).
 *
 * Covers the renderer seam the spec calls out:
 *  - drawing a rubber-band rect over the base image ADDS a mask;
 *  - labeling a mask + deleting a mask work;
 *  - pressing Generate cards calls the typed `cards.generateOcclusion` client with
 *    the drawn masks (normalized regions + labels) — the renderer ships ONLY the
 *    imageElementId + the vector masks (no bytes, no path).
 *
 * The component is presentational: it loads the base image bytes through the typed
 * `getRegionImage` command and calls `generateOcclusionCards`. No SQLite/IPC/fs.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getRegionImage: vi.fn(),
  generateOcclusionCards: vi.fn(),
  onToast: vi.fn(),
  onCardsCreated: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock("../lib/appApi", () => ({
  isDesktop: () => true,
  appApi: {
    getRegionImage: h.getRegionImage,
    generateOcclusionCards: h.generateOcclusionCards,
  },
}));

import { OcclusionEditor } from "./OcclusionEditor";

// jsdom lacks pointer-capture + object URLs; stub them so pointer events flow.
beforeAll(() => {
  if (!("setPointerCapture" in Element.prototype)) {
    // biome-ignore lint/suspicious/noExplicitAny: jsdom shim
    (Element.prototype as any).setPointerCapture = () => {};
    // biome-ignore lint/suspicious/noExplicitAny: jsdom shim
    (Element.prototype as any).releasePointerCapture = () => {};
    // biome-ignore lint/suspicious/noExplicitAny: jsdom shim
    (Element.prototype as any).hasPointerCapture = () => false;
  }
  if (!("createObjectURL" in URL)) {
    // biome-ignore lint/suspicious/noExplicitAny: jsdom shim
    (URL as any).createObjectURL = () => "blob:mock";
    // biome-ignore lint/suspicious/noExplicitAny: jsdom shim
    (URL as any).revokeObjectURL = () => {};
  }
});

function renderEditor() {
  return render(
    <OcclusionEditor
      imageElementId="img_1"
      imagePriority={0.625} // → "B"
      onToast={h.onToast}
      onCardsCreated={h.onCardsCreated}
      onClose={h.onClose}
    />,
  );
}

/** Make the overlay report a real 200×200 box so the fraction math is non-zero. */
function stubOverlayBox() {
  const overlay = screen.getByTestId("occlusion-overlay");
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 200,
    right: 200,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return overlay;
}

/**
 * Draw a rubber-band rect from (px0,py0) to (px1,py1) in CSS px over the overlay.
 *
 * jsdom in this environment does not implement `PointerEvent`, so `fireEvent.pointer*`
 * would dispatch a base Event without `clientX`/`button`. We dispatch `MouseEvent`s
 * (which jsdom supports with coords + button) under the `pointer*` type names — the
 * React `onPointer*` handlers listen on the event TYPE, not the constructor.
 */
function drawRect(
  overlay: HTMLElement,
  [px0, py0]: [number, number],
  [px1, py1]: [number, number],
) {
  const mk = (type: string, x: number, y: number) =>
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  fireEvent(overlay, mk("pointerdown", px0, py0));
  fireEvent(overlay, mk("pointermove", px1, py1));
  fireEvent(overlay, mk("pointerup", px1, py1));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getRegionImage.mockResolvedValue({ bytes: new ArrayBuffer(8), mime: "image/png" });
  h.generateOcclusionCards.mockResolvedValue({
    siblingGroupId: "sg_1",
    cards: [
      {
        id: "c1",
        type: "card",
        status: "pending",
        stage: "card_draft",
        priority: 0.625,
        title: "R1",
        kind: "image_occlusion",
        parentId: "img_1",
        sourceId: "src_1",
        siblingGroupId: "sg_1",
      },
    ],
  });
});

describe("OcclusionEditor", () => {
  it("loads the base image through getRegionImage", async () => {
    renderEditor();
    await waitFor(() => expect(screen.getByTestId("occlusion-base-img")).toBeInTheDocument());
    expect(h.getRegionImage).toHaveBeenCalledWith({ elementId: "img_1" });
  });

  it("drawing a rect adds a mask", async () => {
    renderEditor();
    await waitFor(() => screen.getByTestId("occlusion-base-img"));
    const overlay = stubOverlayBox();
    expect(screen.queryByTestId("occlusion-list-row")).toBeNull();
    drawRect(overlay, [20, 20], [100, 100]); // 0.1..0.5 fraction — well above the min
    expect(screen.getAllByTestId("occlusion-list-row")).toHaveLength(1);
  });

  it("ignores a tiny accidental drag (a click, not a rectangle)", async () => {
    renderEditor();
    await waitFor(() => screen.getByTestId("occlusion-base-img"));
    const overlay = stubOverlayBox();
    drawRect(overlay, [20, 20], [22, 22]); // 0.01 fraction — below the min
    expect(screen.queryByTestId("occlusion-list-row")).toBeNull();
  });

  it("labeling and deleting a mask work", async () => {
    renderEditor();
    await waitFor(() => screen.getByTestId("occlusion-base-img"));
    const overlay = stubOverlayBox();
    drawRect(overlay, [20, 20], [100, 100]);
    const input = screen.getByTestId("occlusion-label-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Hippocampus" } });
    expect(input.value).toBe("Hippocampus");
    fireEvent.click(screen.getByTestId("occlusion-delete"));
    expect(screen.queryByTestId("occlusion-list-row")).toBeNull();
  });

  it("Generate cards calls generateOcclusionCards with the drawn masks + priority", async () => {
    renderEditor();
    await waitFor(() => screen.getByTestId("occlusion-base-img"));
    const overlay = stubOverlayBox();
    drawRect(overlay, [20, 20], [100, 100]);
    fireEvent.change(screen.getByTestId("occlusion-label-input"), {
      target: { value: "Hippocampus" },
    });
    // Generate is disabled with no masks, enabled with one.
    const generate = screen.getByTestId("occlusion-generate");
    expect(generate).toBeEnabled();
    fireEvent.click(generate);

    await waitFor(() => expect(h.generateOcclusionCards).toHaveBeenCalledTimes(1));
    const arg = h.generateOcclusionCards.mock.calls[0]?.[0];
    expect(arg.imageElementId).toBe("img_1");
    expect(arg.priority).toBe("B");
    expect(arg.masks).toHaveLength(1);
    expect(arg.masks[0].label).toBe("Hippocampus");
    // The region is normalized fractions 0..1 (20/200=0.1 .. 100/200=0.5).
    expect(arg.masks[0].region.x0).toBeCloseTo(0.1, 5);
    expect(arg.masks[0].region.x1).toBeCloseTo(0.5, 5);
    expect(h.onCardsCreated).toHaveBeenCalled();
    expect(h.onToast).toHaveBeenCalledWith("1 occlusion card created");
  });

  it("Generate is disabled until at least one mask is drawn", async () => {
    renderEditor();
    await waitFor(() => screen.getByTestId("occlusion-base-img"));
    expect(screen.getByTestId("occlusion-generate")).toBeDisabled();
  });
});

/**
 * CardOcclusionFace component tests (T071).
 *
 * Covers the review-face seam:
 *  - the FRONT renders the base image with the card's region masked (a solid box);
 *  - reveal CLEARS the mask box and shows the label;
 *  - the base image is loaded through the typed `getRegionImage` command (the
 *    renderer never resolves a vault path / re-encodes the image).
 */

import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getRegionImage: vi.fn() }));

vi.mock("../lib/appApi", () => ({
  isDesktop: () => true,
  appApi: { getRegionImage: h.getRegionImage },
}));

import { CardOcclusionFace } from "./CardOcclusionFace";

beforeAll(() => {
  if (!("createObjectURL" in URL)) {
    // biome-ignore lint/suspicious/noExplicitAny: jsdom shim
    (URL as any).createObjectURL = () => "blob:mock";
    // biome-ignore lint/suspicious/noExplicitAny: jsdom shim
    (URL as any).revokeObjectURL = () => {};
  }
});

const OCCLUSION = {
  imageElementId: "img_1",
  region: { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.5 },
  label: "Hippocampus",
  otherRegions: [{ x0: 0.5, y0: 0.2, x1: 0.8, y1: 0.5 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getRegionImage.mockResolvedValue({ bytes: new ArrayBuffer(8), mime: "image/png" });
});

describe("CardOcclusionFace", () => {
  it("renders the base image masked on the front (no label, no revealed box)", async () => {
    render(<CardOcclusionFace occlusion={OCCLUSION} revealed={false} />);
    await waitFor(() => expect(screen.getByTestId("review-occlusion-img")).toBeInTheDocument());
    expect(h.getRegionImage).toHaveBeenCalledWith({ elementId: "img_1" });
    // The masked box is present; the revealed box + label are not.
    expect(screen.getByTestId("review-occlusion-mask")).toBeInTheDocument();
    expect(screen.queryByTestId("review-occlusion-revealed")).toBeNull();
    expect(screen.queryByTestId("review-occlusion-label")).toBeNull();
  });

  it("positions the mask box over the card's region (percentage box)", async () => {
    render(<CardOcclusionFace occlusion={OCCLUSION} revealed={false} />);
    await waitFor(() => screen.getByTestId("review-occlusion-img"));
    const mask = screen.getByTestId("review-occlusion-mask");
    expect(mask.style.left).toBe("10%");
    expect(mask.style.top).toBe("20%");
    expect(mask.style.width).toBe("30%"); // (0.4 - 0.1) * 100
    expect(mask.style.height).toBe("30%"); // (0.5 - 0.2) * 100
  });

  it("on reveal clears the mask and shows the label", async () => {
    render(<CardOcclusionFace occlusion={OCCLUSION} revealed={true} />);
    await waitFor(() => screen.getByTestId("review-occlusion-img"));
    // The solid masked box is gone; the revealed (thin outline) box + label show.
    expect(screen.queryByTestId("review-occlusion-mask")).toBeNull();
    expect(screen.getByTestId("review-occlusion-revealed")).toBeInTheDocument();
    expect(screen.getByTestId("review-occlusion-label")).toHaveTextContent("Hippocampus");
  });

  it("degrades to a calm placeholder when the image is unavailable", async () => {
    h.getRegionImage.mockResolvedValue({ bytes: null, mime: null });
    render(<CardOcclusionFace occlusion={OCCLUSION} revealed={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("review-occlusion-no-image")).toBeInTheDocument(),
    );
  });
});

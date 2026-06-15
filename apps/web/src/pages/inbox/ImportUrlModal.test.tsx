import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  importUrlSource: vi.fn(),
  suggestTriageForMetadata: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      importUrlSource: h.importUrlSource,
      suggestTriageForMetadata: h.suggestTriageForMetadata,
    },
  };
});

import { ImportUrlModal } from "./ImportUrlModal";

beforeEach(() => {
  h.desktop = true;
  h.importUrlSource.mockReset();
  h.importUrlSource.mockResolvedValue({ status: "imported", id: "source-1" });
  h.suggestTriageForMetadata.mockReset();
  // Default: no suggestion, so the existing import tests render no chip.
  h.suggestTriageForMetadata.mockResolvedValue({
    kind: "insufficient_signal",
    reason: "no_signal_fired",
  });
});

describe("ImportUrlModal", () => {
  it("imports a URL with optional reason and priority", async () => {
    const onImported = vi.fn();
    const { getByTestId } = render(
      <ImportUrlModal open onClose={vi.fn()} onImported={onImported} />,
    );

    fireEvent.change(getByTestId("import-url-input"), {
      target: { value: " https://example.com/a " },
    });
    fireEvent.change(getByTestId("import-url-reason"), { target: { value: " For research " } });
    fireEvent.click(getByTestId("import-url-priority-A"));
    fireEvent.click(getByTestId("import-url-submit"));

    await waitFor(() =>
      expect(h.importUrlSource).toHaveBeenCalledWith({
        url: "https://example.com/a",
        priority: "A",
        reasonAdded: "For research",
      }),
    );
    expect(onImported).toHaveBeenCalledWith("source-1");
  });

  it("shows duplicate choices, opens existing, and can force a new version", async () => {
    h.importUrlSource.mockResolvedValueOnce({
      status: "duplicate",
      matches: [
        {
          elementId: "existing-1",
          title: "Existing article",
          status: "active",
          accessedAt: "2026-06-01T00:00:00.000Z",
          matchedBy: "canonicalUrl",
        },
      ],
    });
    h.importUrlSource.mockResolvedValueOnce({ status: "imported", id: "source-new" });
    const onImported = vi.fn();
    const onOpenExisting = vi.fn();
    const { getByTestId, findByTestId } = render(
      <ImportUrlModal
        open
        defaultPriority="B"
        onClose={vi.fn()}
        onImported={onImported}
        onOpenExisting={onOpenExisting}
      />,
    );

    expect(getByTestId("import-url-priority-B")).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(getByTestId("import-url-input"), { target: { value: "https://example.com" } });
    fireEvent.click(getByTestId("import-url-submit"));
    expect(await findByTestId("import-url-duplicate")).toHaveTextContent("Existing article");

    fireEvent.click(getByTestId("import-url-open-existing"));
    expect(onOpenExisting).toHaveBeenCalledWith({
      elementId: "existing-1",
      title: "Existing article",
      status: "active",
      accessedAt: "2026-06-01T00:00:00.000Z",
      matchedBy: "canonicalUrl",
    });

    fireEvent.click(getByTestId("import-url-new-version"));
    await waitFor(() =>
      expect(h.importUrlSource).toHaveBeenLastCalledWith({
        url: "https://example.com",
        priority: "B",
        forceNewVersion: true,
      }),
    );
    expect(onImported).toHaveBeenCalledWith("source-new");
  });

  it("maps typed import errors to friendly copy and is inert outside desktop", async () => {
    h.importUrlSource.mockRejectedValueOnce(new Error("timeout: fetch exceeded"));
    const { getByTestId, findByTestId, rerender } = render(
      <ImportUrlModal open onClose={vi.fn()} onImported={vi.fn()} />,
    );

    fireEvent.change(getByTestId("import-url-input"), { target: { value: "https://slow.test" } });
    fireEvent.click(getByTestId("import-url-submit"));
    expect(await findByTestId("import-url-error")).toHaveTextContent(
      "Timed out reaching that page.",
    );

    h.desktop = false;
    h.importUrlSource.mockClear();
    rerender(<ImportUrlModal open onClose={vi.fn()} onImported={vi.fn()} />);
    fireEvent.change(getByTestId("import-url-input"), { target: { value: "https://x.test" } });
    fireEvent.click(getByTestId("import-url-submit"));
    expect(h.importUrlSource).not.toHaveBeenCalled();
  });

  it("shows a metadata suggestion for the entered URL and accepts it into the picker (T127)", async () => {
    h.suggestTriageForMetadata.mockResolvedValue({
      kind: "suggestion",
      band: "A",
      justification: {
        signals: [
          {
            kind: "domainYield",
            workedSourceCount: 3,
            totalCards: 11,
            totalMatureCards: 4,
            band: "high",
          },
        ],
      },
      signalHash: "hash-A",
    });
    const { getByTestId, findByTestId } = render(
      <ImportUrlModal open onClose={vi.fn()} onImported={vi.fn()} />,
    );

    fireEvent.change(getByTestId("import-url-input"), {
      target: { value: "https://blog.example.com/post" },
    });

    // The debounced metadata read fires; the suggestion chip appears.
    const chip = await findByTestId("inbox-suggestion-chip");
    // Accept defaults the picker to the suggested band (never auto-submits).
    fireEvent.click(chip);
    await waitFor(() =>
      expect(getByTestId("import-url-priority-A")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(h.importUrlSource).not.toHaveBeenCalled();
  });

  it("renders no suggestion chip when the metadata signal is thin (T127)", async () => {
    const { getByTestId, queryByTestId } = render(
      <ImportUrlModal open onClose={vi.fn()} onImported={vi.fn()} />,
    );
    fireEvent.change(getByTestId("import-url-input"), {
      target: { value: "https://unknown.example/x" },
    });
    await waitFor(() => expect(h.suggestTriageForMetadata).toHaveBeenCalled());
    expect(queryByTestId("inbox-suggestion-chip")).toBeNull();
  });
});

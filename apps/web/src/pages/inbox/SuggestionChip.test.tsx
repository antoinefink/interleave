import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TriageJustification } from "../../lib/appApi";
import { formatTriageJustification, SuggestionChip, SuggestionPending } from "./SuggestionChip";

describe("formatTriageJustification (T127 — U6)", () => {
  it("renders a semantic clause citing the neighbor count + band lean", () => {
    const justification: TriageJustification = {
      signals: [{ kind: "semantic", neighborCount: 2, lean: "A" }],
    };
    expect(formatTriageJustification(justification)).toBe("Near 2 priority-A neighbors");
  });

  it("renders an author-yield clause citing the real worked-source + card counts", () => {
    const justification: TriageJustification = {
      signals: [
        {
          kind: "authorYield",
          workedSourceCount: 3,
          totalCards: 11,
          totalMatureCards: 4,
          band: "high",
        },
      ],
    };
    expect(formatTriageJustification(justification)).toBe(
      "This author's last 3 sources made 11 cards",
    );
  });

  it("joins multiple fired signals into one line in structured order", () => {
    const justification: TriageJustification = {
      signals: [
        { kind: "semantic", neighborCount: 2, lean: "B" },
        {
          kind: "domainYield",
          workedSourceCount: 4,
          totalCards: 9,
          totalMatureCards: 2,
          band: "medium",
        },
      ],
    };
    expect(formatTriageJustification(justification)).toBe(
      "Near 2 priority-B neighbors · This domain's last 4 sources made 9 cards",
    );
  });

  it("a yield-only suggestion renders NO semantic clause (honesty — only fired signals)", () => {
    const justification: TriageJustification = {
      signals: [
        {
          kind: "authorYield",
          workedSourceCount: 2,
          totalCards: 5,
          totalMatureCards: 1,
          band: "high",
        },
      ],
    };
    const line = formatTriageJustification(justification);
    expect(line).toBe("This author's last 2 sources made 5 cards");
    expect(line).not.toMatch(/neighbor/i);
  });

  it("pluralizes single-count clauses correctly (no '1 neighbors' / '1 cards')", () => {
    expect(
      formatTriageJustification({ signals: [{ kind: "semantic", neighborCount: 1, lean: "A" }] }),
    ).toBe("Near 1 priority-A neighbor");
    expect(
      formatTriageJustification({
        signals: [
          {
            kind: "authorYield",
            workedSourceCount: 1,
            totalCards: 1,
            totalMatureCards: 0,
            band: "high",
          },
        ],
      }),
    ).toBe("This author's last 1 source made 1 card");
  });

  it("returns an empty string when no signals fired (caller renders no line)", () => {
    expect(formatTriageJustification({ signals: [] })).toBe("");
  });
});

describe("SuggestionChip (T127 — U6)", () => {
  it("renders the suggested band, the sparkle glyph, and a distinct dashed treatment", () => {
    const { getByTestId } = render(<SuggestionChip band="A" />);
    const chip = getByTestId("inbox-suggestion-chip");
    expect(chip).toHaveAttribute("data-suggested-band", "A");
    expect(chip).toHaveTextContent("A");
    // Visually distinct from the solid `Prio` badge: a dashed outline.
    expect(chip).toHaveClass("border-dashed");
    // Display-only chip renders as a non-interactive span (no accept handler).
    expect(chip.tagName).toBe("SPAN");
  });

  it("calls onAccept when the accept affordance is clicked", () => {
    const onAccept = vi.fn();
    const { getByTestId } = render(<SuggestionChip band="B" onAccept={onAccept} />);
    const chip = getByTestId("inbox-suggestion-chip");
    expect(chip.tagName).toBe("BUTTON");
    fireEvent.click(chip);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("disables the accept button while busy", () => {
    const onAccept = vi.fn();
    const { getByTestId } = render(<SuggestionChip band="B" onAccept={onAccept} busy />);
    const chip = getByTestId("inbox-suggestion-chip");
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("renders the neutral pending placeholder distinct from the suggestion chip", () => {
    const { getByTestId, queryByTestId } = render(<SuggestionPending />);
    expect(getByTestId("inbox-suggestion-pending")).toBeInTheDocument();
    expect(queryByTestId("inbox-suggestion-chip")).not.toBeInTheDocument();
  });
});

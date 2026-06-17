import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { StatusHintProvider, useStatusHint } from "./statusHint";

/** Renders whatever the active screen has published into the hint slot. */
function HintReadout() {
  const { hint } = useStatusHint();
  return <div data-testid="readout">{hint}</div>;
}

/** A screen that publishes `label` on mount and clears the slot on unmount. */
function Publisher({ label }: { label: string }) {
  const { setHint } = useStatusHint();
  useEffect(() => {
    setHint(<span>{label}</span>);
    return () => setHint(null);
  }, [label, setHint]);
  return null;
}

describe("statusHint", () => {
  it("renders children and starts with an empty slot", () => {
    render(
      <StatusHintProvider>
        <HintReadout />
      </StatusHintProvider>,
    );
    expect(screen.getByTestId("readout")).toBeEmptyDOMElement();
  });

  it("surfaces what a screen publishes and clears it when the screen unmounts", () => {
    const { rerender } = render(
      <StatusHintProvider>
        <HintReadout />
        <Publisher label="d done · p postpone" />
      </StatusHintProvider>,
    );
    expect(screen.getByTestId("readout")).toHaveTextContent("d done · p postpone");

    // The publishing screen leaves — the slot must not outlive it.
    rerender(
      <StatusHintProvider>
        <HintReadout />
      </StatusHintProvider>,
    );
    expect(screen.getByTestId("readout")).toBeEmptyDOMElement();
  });

  it("throws when used outside the provider", () => {
    const Bare = () => {
      useStatusHint();
      return null;
    };
    expect(() => render(<Bare />)).toThrow(/StatusHintProvider/);
  });
});

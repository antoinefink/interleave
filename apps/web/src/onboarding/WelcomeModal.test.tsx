import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WelcomeModal } from "./WelcomeModal";

function setup(open = true) {
  const props = {
    open,
    theme: "light" as const,
    onPickTheme: vi.fn(),
    onStartTour: vi.fn(),
    onImport: vi.fn(),
    onExplore: vi.fn(),
    onDisableTips: vi.fn(),
  };
  render(<WelcomeModal {...props} />);
  return props;
}

describe("WelcomeModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <WelcomeModal
        open={false}
        theme="light"
        onPickTheme={() => {}}
        onStartTour={() => {}}
        onImport={() => {}}
        onExplore={() => {}}
        onDisableTips={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("leads with the method and the three myth-busters", () => {
    setup();
    expect(screen.getByText("A refinery for what you read")).toBeInTheDocument();
    expect(screen.getByText(/don’t finish what you import/i)).toBeInTheDocument();
    expect(screen.getByText(/highlight is not an extract/i)).toBeInTheDocument();
    expect(screen.getByText(/Don’t card everything/i)).toBeInTheDocument();
  });

  it("starts the tour", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /Start the 60-second tour/ }));
    expect(p.onStartTour).toHaveBeenCalled();
  });

  it("imports the user's own source", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /Import my own source/ }));
    expect(p.onImport).toHaveBeenCalled();
  });

  it("skips and turns off tips", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: /Skip & turn off contextual tips/ }));
    expect(p.onDisableTips).toHaveBeenCalled();
  });

  it("picks a theme from the segmented control", () => {
    const p = setup();
    fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(p.onPickTheme).toHaveBeenCalledWith("system");
  });

  it("explores on Escape", () => {
    const p = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(p.onExplore).toHaveBeenCalled();
  });
});

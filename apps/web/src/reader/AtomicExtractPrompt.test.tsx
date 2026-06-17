import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AtomicExtractPrompt } from "./AtomicExtractPrompt";

const prompt = { extractId: "ex-1", title: "Money is a required pursuit for life." };

const promptCssPath =
  [
    path.join(process.cwd(), "apps/web/src/reader/AtomicExtractPrompt.css"),
    path.join(process.cwd(), "src/reader/AtomicExtractPrompt.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";

describe("AtomicExtractPrompt", () => {
  it("renders nothing when there is no prompt", () => {
    const { container } = render(
      <AtomicExtractPrompt prompt={null} onConvert={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a concise explanatory tooltip on the Convert-now button on hover", async () => {
    render(<AtomicExtractPrompt prompt={prompt} onConvert={vi.fn()} onDismiss={vi.fn()} />);

    const button = screen.getByTestId("atomic-extract-convert-now");
    // The button keeps its own accessible name ("Convert now") — the tooltip adds context.
    expect(button).toHaveAccessibleName(/convert now/i);
    expect(screen.queryByTestId("tooltip")).toBeNull();

    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    expect(screen.getByTestId("tooltip")).toHaveTextContent(
      "Turn this statement into a review card",
    );
  });

  it("invokes the convert + dismiss callbacks", () => {
    const onConvert = vi.fn();
    const onDismiss = vi.fn();
    render(<AtomicExtractPrompt prompt={prompt} onConvert={onConvert} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId("atomic-extract-convert-now"));
    expect(onConvert).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /dismiss convert-now prompt/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("pins to the bottom-right corner with a symmetric inset", () => {
    const css = readFileSync(promptCssPath, "utf8");
    // The bar is viewport-fixed in the corner with equal right/bottom insets.
    expect(css).toMatch(/position:\s*fixed/);
    expect(css).toMatch(/right:\s*var\(--atomic-extract-prompt-inset\)/);
    expect(css).toMatch(/bottom:\s*var\(--atomic-extract-prompt-inset\)/);
    // It still floats above content, so it keeps its elevation shadow.
    expect(css).toMatch(/box-shadow:\s*var\(--shadow-lg\)/);
  });
});

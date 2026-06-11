/**
 * VirtualList tests (T100) — the row-virtualization primitive renders a BOUNDED
 * number of DOM rows for a large payload (the rendering-at-scale guard the spec
 * asks for: "a 10k-row payload renders a bounded number of DOM rows").
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VirtualList } from "./VirtualList";

function makeRows(n: number): { id: string; label: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, label: `Row ${i}` }));
}

// jsdom reports no layout (`getBoundingClientRect` → 0×0), so the virtualizer can't
// measure a viewport and VirtualList engages its bounded top-window fallback
// (viewportRows + overscan, derived from height / estimateSize) — which is exactly
// the rendering-at-scale guarantee under test: a bounded DOM-row count regardless of
// the payload size, in BOTH this no-layout environment AND the real Chromium renderer
// (where the live rect drives the same windowing).
const VIEWPORT = 600;
const ROW = 40;

describe("VirtualList", () => {
  it("renders only a bounded window of DOM rows for a 10k-row payload", () => {
    const items = makeRows(10_000);
    render(
      <VirtualList
        items={items}
        itemKey={(it) => it.id}
        estimateSize={ROW}
        height={VIEWPORT}
        testId="vlist"
        renderItem={(it) => <span data-testid="vrow">{it.label}</span>}
      />,
    );

    const rendered = screen.getAllByTestId("vrow");
    // A 600px viewport over 40px rows shows ~15 rows; with overscan the DOM count
    // is well under 100 even though the payload is 10,000 — the whole point.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(100);
    expect(rendered.length).toBeLessThan(items.length);
  });

  it("sizes the inner spacer to the full virtual height (scrollbar reflects all rows)", () => {
    const items = makeRows(1000);
    render(
      <VirtualList
        items={items}
        itemKey={(it) => it.id}
        estimateSize={ROW}
        height={VIEWPORT}
        testId="vlist"
        renderItem={(it) => <span data-testid="vrow">{it.label}</span>}
      />,
    );
    const container = screen.getByTestId("vlist");
    const spacer = container.firstElementChild as HTMLElement;
    // 1000 rows × 40px = 40,000px total scrollable height, independent of how many
    // rows are actually painted — the scrollbar reflects the WHOLE list.
    expect(spacer.style.height).toBe("40000px");
  });

  it("renders the first rows of the payload (the window starts at the top)", () => {
    const items = makeRows(500);
    render(
      <VirtualList
        items={items}
        itemKey={(it) => it.id}
        estimateSize={ROW}
        height={VIEWPORT}
        renderItem={(it) => <span data-testid="vrow">{it.label}</span>}
      />,
    );
    expect(screen.getByText("Row 0")).toBeInTheDocument();
    // A row far past the viewport is NOT painted (it is virtualized away).
    expect(screen.queryByText("Row 499")).not.toBeInTheDocument();
  });

  it("renders nothing for an empty payload without crashing", () => {
    render(
      <VirtualList
        items={[]}
        itemKey={(it: { id: string }) => it.id}
        estimateSize={ROW}
        testId="vlist-empty"
        renderItem={() => <span data-testid="vrow" />}
      />,
    );
    expect(screen.getByTestId("vlist-empty")).toBeInTheDocument();
    expect(screen.queryAllByTestId("vrow").length).toBe(0);
  });

  it("can expose list semantics for virtualized rows", () => {
    const items = makeRows(100);
    render(
      <VirtualList
        items={items}
        itemKey={(it) => it.id}
        estimateSize={ROW}
        height={VIEWPORT}
        role="list"
        rowRole="listitem"
        renderItem={(it) => <span>{it.label}</span>}
      />,
    );

    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  });
});

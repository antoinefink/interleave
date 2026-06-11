/**
 * VirtualList (T100) — a small row-virtualization primitive for the long lists.
 *
 * At years-of-use scale a screen can be handed thousands of rows (the queue, the
 * library/search results, the trash, the maintenance drill-downs). Mapping every row
 * to the DOM freezes the renderer. `VirtualList` windows the list with
 * `@tanstack/react-virtual`: it renders ONLY the rows in (or near) the viewport plus
 * a small overscan, so a 10k-row payload paints a bounded number of DOM nodes and
 * stays smooth.
 *
 * This is pure presentation — it holds NO domain logic. The IPC reads that feed it
 * stay paginated/limited main-side (`QueueQuery.list`'s `limit`,
 * `SearchRepository.search`'s `limit`, the review-mode `MAX_REVIEW_MODE_DECK` cap),
 * so the renderer is never handed an unbounded list in the first place; windowing is
 * the second line of defence for the lists that CAN still grow large.
 *
 * Robustness without layout: `useVirtualizer` measures the scroll element via the
 * live layout (ResizeObserver + `getBoundingClientRect`), which an environment with
 * NO layout (jsdom) reports as `0×0` — there it would window down to nothing and
 * render an empty list. To stay correct everywhere, when the virtualizer yields no
 * virtual items even though there ARE rows (the "no measured viewport yet" case),
 * `VirtualList` falls back to a bounded top window (`viewportRows + overscan`,
 * derived from `height / estimateSize`). In the real Chromium renderer the live rect
 * drives the window; the fallback only ever engages before/without layout, and is
 * itself bounded — so the DOM-row count stays small in BOTH environments.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { type AriaRole, useRef } from "react";

export interface VirtualListProps<T> {
  /** The full (already main-side-limited) row set to window. */
  readonly items: readonly T[];
  /** Stable key for a row (used as the React key + measurement key). */
  readonly itemKey: (item: T, index: number) => string;
  /** Render one row's CONTENT (VirtualList owns the absolute-positioned wrapper). */
  readonly renderItem: (item: T, index: number) => React.ReactNode;
  /** Estimated row height in px (the virtualizer refines it from real measurements). */
  readonly estimateSize: number;
  /** The fixed viewport height in px (the scroll container). Default 600. */
  readonly height?: number;
  /** Rows to render beyond the viewport on each side (smooth scrolling). Default 6. */
  readonly overscan?: number;
  /** Class for the scroll container. */
  readonly className?: string;
  /** `data-testid` for the scroll container. */
  readonly testId?: string;
  /** Optional ARIA role for the scroll container when it presents semantic rows. */
  readonly role?: AriaRole;
  /** Optional ARIA role for each absolute row wrapper. */
  readonly rowRole?: AriaRole;
  /** Optional class for each absolute row wrapper. */
  readonly rowClassName?: string;
}

/** The nominal width used for the test-time `initialRect` (jsdom has no layout). */
const NOMINAL_WIDTH = 800;

export function VirtualList<T>({
  items,
  itemKey,
  renderItem,
  estimateSize,
  height = 600,
  overscan = 6,
  className,
  testId,
  role,
  rowRole,
  rowClassName,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan,
    // Give the window a real viewport before the live rect is measured, so the
    // bounded-DOM-row behaviour is deterministic even where layout is unavailable
    // (jsdom). The live `getBoundingClientRect` takes over after mount in Chromium.
    initialRect: { width: NOMINAL_WIDTH, height },
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Fallback bounded window for the no-measured-layout case (jsdom, or the first
  // paint before the live rect arrives): a top slice of viewportRows + overscan.
  // Always bounded, so the DOM-row count stays small. The virtualizer's own window
  // takes over the moment a real viewport is measured (the normal Chromium path).
  const useFallback = virtualItems.length === 0 && items.length > 0;
  const fallbackCount = Math.min(
    items.length,
    Math.ceil(height / Math.max(1, estimateSize)) + overscan,
  );

  return (
    <div
      ref={scrollRef}
      className={className}
      data-testid={testId}
      data-virtualized="true"
      role={role}
      style={{ height, overflowY: "auto", position: "relative", contain: "strict" }}
    >
      <div
        style={{
          height: useFallback ? items.length * estimateSize : totalSize,
          width: "100%",
          position: "relative",
        }}
      >
        {useFallback
          ? items.slice(0, fallbackCount).map((item, index) => (
              <div
                key={itemKey(item, index)}
                data-index={index}
                data-virtual-row="true"
                role={rowRole}
                className={rowClassName}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${index * estimateSize}px)`,
                }}
              >
                {renderItem(item, index)}
              </div>
            ))
          : virtualItems.map((virtualRow) => {
              const item = items[virtualRow.index];
              if (item === undefined) return null;
              return (
                <div
                  key={itemKey(item, virtualRow.index)}
                  data-index={virtualRow.index}
                  data-virtual-row="true"
                  role={rowRole}
                  ref={virtualizer.measureElement}
                  className={rowClassName}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {renderItem(item, virtualRow.index)}
                </div>
              );
            })}
      </div>
    </div>
  );
}

/**
 * The default row-count at/above which {@link AutoVirtualList} switches to windowing.
 * Below it, the screens render their normal inline list so the kit's exact layout
 * (flex gaps, grouped sections, two-line meta) is preserved pixel-for-pixel for the
 * everyday case; windowing only engages once a list could genuinely freeze the DOM.
 */
export const VIRTUALIZE_THRESHOLD = 80;

export interface AutoVirtualListProps<T> extends VirtualListProps<T> {
  /**
   * Render the WHOLE list inline (the screen's existing markup) — used verbatim
   * below the threshold so small lists keep their exact layout + tests.
   */
  readonly renderInline: () => React.ReactNode;
  /** Row-count at/above which to virtualize. Default {@link VIRTUALIZE_THRESHOLD}. */
  readonly threshold?: number;
}

/**
 * Render a list inline for the common (small) case and switch to a windowed
 * {@link VirtualList} once it crosses `threshold` rows — so the everyday screen keeps
 * its pixel-exact kit layout while a years-of-use payload (thousands of rows) still
 * paints a bounded number of DOM nodes. Pure presentation; no domain logic.
 */
export function AutoVirtualList<T>({
  renderInline,
  threshold = VIRTUALIZE_THRESHOLD,
  ...virtualProps
}: AutoVirtualListProps<T>) {
  if (virtualProps.items.length < threshold) return <>{renderInline()}</>;
  return <VirtualList {...virtualProps} />;
}

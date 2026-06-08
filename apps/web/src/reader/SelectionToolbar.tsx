/**
 * The floating text-selection toolbar (T019).
 *
 * Selecting any run of text in the reader pops this inline toolbar anchored above
 * the selection, offering the single entry point to every M4 action: **Extract**
 * (accent, `E`), **Cloze** (`C`), **Highlight** (`H`), **Copy**, and **Cancel**.
 * It rebuilds `design/kit/app/screen-reader.jsx`'s `SelToolbar` against the
 * canonical `.sel-toolbar` / `.sel-tool` tokens, positioned `fixed` above the
 * selection's visible rect with `transform: translate(-50%, -100%)`; after
 * render it clamps that anchor so the measured toolbar remains in the viewport.
 *
 * This component is PURELY PRESENTATIONAL — it holds no SQL, no lineage logic, no
 * selection state: it takes the resolved anchor position from the
 * {@link useTextSelection} hook and delegates each action to the callbacks the
 * reader passes in (which T020 wires to highlight, T021 to extract, M6 to the card
 * builder; `Copy`/`Cancel` are renderer-only). The critical interaction detail
 * (from the prototype) is `onMouseDown={preventDefault}` on the toolbar so
 * clicking a button never collapses the live ProseMirror selection (the marks are
 * applied through Tiptap commands, never DOM surgery — see the T019 risk note).
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { Kbd } from "../shell/Kbd";

const VIEWPORT_MARGIN = 12;

/** The action a toolbar button dispatches. */
export type SelectionToolbarAction = "extract" | "cloze" | "highlight" | "copy" | "cancel";

export interface SelectionToolbarItem {
  readonly action: SelectionToolbarAction;
  readonly label: string;
  readonly icon: IconName;
  readonly keys?: string;
  readonly accent?: boolean;
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly dividerBefore?: boolean;
}

export const SOURCE_SELECTION_ACTIONS: readonly SelectionToolbarItem[] = [
  { action: "extract", label: "Extract", icon: "extract", keys: "E", accent: true },
  { action: "cloze", label: "Cloze", icon: "cloze", keys: "C" },
  { action: "highlight", label: "Highlight", icon: "highlight", keys: "H" },
  { action: "copy", label: "Copy", icon: "copy", title: "Copy selection", dividerBefore: true },
  { action: "cancel", label: "", icon: "x", title: "Cancel (Esc)", ariaLabel: "Cancel" },
];

export const EXTRACT_SELECTION_ACTIONS: readonly SelectionToolbarItem[] = [
  { action: "extract", label: "Sub-extract", icon: "extract", keys: "E", accent: true },
  { action: "cloze", label: "Cloze", icon: "cloze", keys: "C" },
  { action: "highlight", label: "Highlight", icon: "highlight", keys: "H" },
  { action: "copy", label: "Copy", icon: "copy", title: "Copy selection", dividerBefore: true },
  { action: "cancel", label: "", icon: "x", title: "Cancel (Esc)", ariaLabel: "Cancel" },
];

/** Where to anchor the toolbar: the top + horizontal-centre of the visible selection rect. */
export interface SelectionToolbarPosition {
  /** Viewport `top` (px) — the toolbar is translated up by 100% above this. */
  readonly top: number;
  /** Viewport `left` (px) — the toolbar is centred on this with translate(-50%). */
  readonly left: number;
}

export interface SelectionToolbarProps {
  /** The anchor position, or `null` to hide the toolbar entirely. */
  readonly position: SelectionToolbarPosition | null;
  /** Dispatch a toolbar action. The reader maps these to the M4 commands. */
  readonly onAction: (action: SelectionToolbarAction) => void;
  /** Context-specific buttons. Defaults to the source-reader action set. */
  readonly actions?: readonly SelectionToolbarItem[];
}

function viewportSize(): { width: number; height: number } {
  const doc = typeof document !== "undefined" ? document.documentElement : null;
  return {
    width: typeof window !== "undefined" ? (window.innerWidth ?? doc?.clientWidth ?? 0) : 0,
    height: typeof window !== "undefined" ? (window.innerHeight ?? doc?.clientHeight ?? 0) : 0,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return value;
  return Math.min(Math.max(value, min), max);
}

function clampRenderedToolbarAnchor(
  position: SelectionToolbarPosition,
  toolbar: HTMLElement,
): SelectionToolbarPosition {
  const { width: viewportWidth, height: viewportHeight } = viewportSize();
  const rect = toolbar.getBoundingClientRect();
  if (viewportWidth <= 0 || viewportHeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    return position;
  }
  return {
    top: clamp(position.top, rect.height + VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN),
    left: clamp(
      position.left,
      rect.width / 2 + VIEWPORT_MARGIN,
      viewportWidth - rect.width / 2 - VIEWPORT_MARGIN,
    ),
  };
}

function samePosition(a: SelectionToolbarPosition, b: SelectionToolbarPosition): boolean {
  return Math.abs(a.top - b.top) < 0.5 && Math.abs(a.left - b.left) < 0.5;
}

/**
 * Render the floating selection toolbar, or nothing when `position` is null.
 *
 * `onMouseDown` is prevented on the container so pressing a button keeps the text
 * selection intact (the prototype's load-bearing trick) — the actual mark/extract
 * runs through Tiptap commands the action callbacks own, not here.
 */
export function SelectionToolbar({
  position,
  onAction,
  actions = SOURCE_SELECTION_ACTIONS,
}: SelectionToolbarProps): React.ReactElement | null {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [renderedPosition, setRenderedPosition] = useState(position);

  const clampToViewport = useCallback(() => {
    if (!position || !toolbarRef.current) {
      setRenderedPosition(position);
      return;
    }
    const next = clampRenderedToolbarAnchor(position, toolbarRef.current);
    setRenderedPosition((current) => (current && samePosition(current, next) ? current : next));
  }, [position]);

  useLayoutEffect(() => {
    if (!position) {
      setRenderedPosition(null);
      return;
    }
    setRenderedPosition(position);
  }, [position]);

  useLayoutEffect(() => {
    if (!position || typeof window === "undefined") return;
    clampToViewport();

    const toolbar = toolbarRef.current;
    let resizeObserver: ResizeObserver | null = null;
    if (toolbar && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => clampToViewport());
      resizeObserver.observe(toolbar);
    }
    window.addEventListener("resize", clampToViewport);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", clampToViewport);
    };
  }, [position, clampToViewport]);

  if (!position) return null;
  return (
    <div
      ref={toolbarRef}
      className="sel-toolbar fade-up"
      data-testid="selection-toolbar"
      role="toolbar"
      aria-label="Selection actions"
      style={{
        position: "fixed",
        top: renderedPosition?.top ?? position.top,
        left: renderedPosition?.left ?? position.left,
        transform: "translate(-50%, -100%)",
        zIndex: 80,
      }}
      // Keep the live ProseMirror selection alive when a button is pressed.
      onMouseDown={(e) => e.preventDefault()}
    >
      {actions.map((item) => (
        <span className="sel-tool-wrap" key={item.action}>
          {item.dividerBefore ? <span className="tool-div" aria-hidden /> : null}
          <button
            type="button"
            className={`sel-tool${item.accent ? " sel-tool--accent" : ""}`}
            data-testid={`sel-tool-${item.action}`}
            title={item.title}
            aria-label={item.ariaLabel}
            onClick={() => onAction(item.action)}
          >
            <Icon name={item.icon} size={14} />
            {item.label ? <> {item.label}</> : null}
            {item.keys ? (
              <>
                {" "}
                <Kbd keys={item.keys} />
              </>
            ) : null}
          </button>
        </span>
      ))}
    </div>
  );
}

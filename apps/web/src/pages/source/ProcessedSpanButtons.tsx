/**
 * Per-paragraph block-processing affordance for the reader.
 *
 * Matches `design/kit/app/screen-reader.jsx`'s `.readpara__mark` button: a small
 * control anchored to each body paragraph that toggles the block between "Mark
 * The primary button toggles processed-without-output/unread; the compact adjacent
 * buttons mark a paragraph ignored or needing a later pass. The visual dimming is
 * a projection of durable block-processing state.
 *
 * Because the body is a live ProseMirror editor (we must NOT mutate its DOM directly —
 * the kit's per-paragraph wrapper would fight the editor's MutationObserver and be
 * wiped on re-render), the buttons are rendered as an OVERLAY positioned over each
 * block's measured rect (relative to the scrolling rail), the same hands-off pattern
 * the decoration layer uses. The button reads its block via the stable
 * `data-block-id` the block-id extension emits, and toggles the mark through the
 * {@link useProcessedSpans} hook — the page never touches SQL; persistence flows over
 * the typed `documents.marks.*` bridge.
 *
 * Layering: presentational only. All persistence + block-id math lives elsewhere
 * (the hook + `@interleave/editor`); this component just measures + positions +
 * delegates the toggle.
 */

import type { Editor } from "@interleave/editor";
import { BLOCK_ID_DOM_ATTR } from "@interleave/editor";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import type { UseProcessedSpansResult } from "./useProcessedSpans";

export type ProcessingFilter = "all" | "hide_processed" | "unresolved" | "extracted";

/**
 * Padding (px) added to each paragraph's vertical band so adjacent bands meet and
 * crossing the inter-paragraph margin maps to the nearer paragraph rather than
 * flickering to null mid-gap.
 */
const HOVER_BAND_TOLERANCE_PX = 24;

/** A measured anchor for one body paragraph: its stable id + top/bottom offsets in the rail. */
interface BlockAnchor {
  readonly blockId: string;
  /** Top offset of the block relative to the positioning rail (`.reader-rail`). */
  readonly top: number;
  /** Bottom offset of the block relative to the positioning rail (`.reader-rail`). */
  readonly bottom: number;
}

export interface ProcessedSpanButtonsProps {
  /** The live Tiptap editor whose paragraph blocks get the affordance. */
  readonly editor: Editor | null;
  /** Whether the editor is mounted/ready (gates measuring). */
  readonly editorReady: boolean;
  /** The processed-span hook (toggle + current state). */
  readonly processed: UseProcessedSpansResult;
  /** Active reader filter; overlay controls should match visible blocks. */
  readonly processingFilter?: ProcessingFilter;
  /** Whether ignored blocks are currently hidden. */
  readonly hideIgnored?: boolean;
  /** A monotonically-changing token to force a re-measure (doc/decoration change). */
  readonly revision: number;
  /**
   * Notified after a successful toggle with which way it went, so the host can show
   * the right confirmation toast ("Marked processed" vs "Restored").
   */
  readonly onToggled?: (result: "marked" | "restored") => void;
  /** Notified when persistence failed, so the host can show an error toast. */
  readonly onToggleFailed?: () => void;
}

/** The element this button toggles is a body paragraph (the kit only marks `<p>`). */
function isParagraph(el: HTMLElement): boolean {
  return el.tagName === "P";
}

/**
 * Measure every body-paragraph block's top offset relative to the rail, so a button
 * can be absolutely positioned beside each one. Headings/blockquotes/lists are left
 * alone (the kit dims body paragraphs only).
 */
function measureAnchors(rail: HTMLElement): BlockAnchor[] {
  const railTop = rail.getBoundingClientRect().top;
  const anchors: BlockAnchor[] = [];
  const blocks = rail.querySelectorAll<HTMLElement>(`[${BLOCK_ID_DOM_ATTR}]`);
  for (const block of blocks) {
    if (!isParagraph(block)) continue;
    const blockId = block.getAttribute(BLOCK_ID_DOM_ATTR);
    if (!blockId) continue;
    const rect = block.getBoundingClientRect();
    anchors.push({ blockId, top: rect.top - railTop, bottom: rect.bottom - railTop });
  }
  return anchors;
}

/** The paragraph whose vertical band contains y (rail-relative), or null. Bands are
 *  padded by HOVER_BAND_TOLERANCE_PX so adjacent paragraphs meet and the gap between
 *  them maps to the nearer paragraph rather than flickering to null. */
function blockIdForY(y: number, anchors: readonly BlockAnchor[]): string | null {
  let best: { blockId: string; distance: number } | null = null;
  for (const a of anchors) {
    if (y >= a.top - HOVER_BAND_TOLERANCE_PX && y <= a.bottom + HOVER_BAND_TOLERANCE_PX) {
      // distance to the band center, so overlapping padded bands resolve to the closer one
      const center = (a.top + a.bottom) / 2;
      const distance = Math.abs(y - center);
      if (!best || distance < best.distance) best = { blockId: a.blockId, distance };
    }
  }
  return best ? best.blockId : null;
}

function stateTitle(state: string | null): string {
  switch (state) {
    case "extracted":
      return "Extracted";
    case "ignored":
      return "Ignored";
    case "processed_without_output":
      return "Processed";
    case "needs_later":
      return "Needs later";
    case "stale_after_edit":
      return "Stale after edit";
    case "read":
      return "Read";
    default:
      return "Unread";
  }
}

function isTerminalState(state: string | null): boolean {
  return state === "extracted" || state === "ignored" || state === "processed_without_output";
}

function isVisibleUnderFilter(
  state: string | null,
  processingFilter: ProcessingFilter,
  hideIgnored: boolean,
): boolean {
  if (hideIgnored && state === "ignored") return false;
  switch (processingFilter) {
    case "hide_processed":
      return !isTerminalState(state);
    case "unresolved":
      return !isTerminalState(state);
    case "extracted":
      return state === "extracted";
    default:
      return true;
  }
}

export function ProcessedSpanButtons({
  editor,
  editorReady,
  processed,
  processingFilter = "all",
  hideIgnored = false,
  revision,
  onToggled,
  onToggleFailed,
}: ProcessedSpanButtonsProps) {
  const [anchors, setAnchors] = useState<readonly BlockAnchor[]>([]);
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);

  // Latest anchors for the pointer listener, so it resolves the band without the
  // effect re-subscribing on every measure (keeps the effect deps stable).
  const anchorsRef = useRef<readonly BlockAnchor[]>([]);
  // Mirror of `hoveredBlockId` so the high-frequency pointer handler can change-guard
  // without going through React state on intra-paragraph movement (KTD2).
  const activeRef = useRef<string | null>(null);
  // The most recent pointer Y (viewport coords) so a scroll of the reader body can
  // re-resolve which paragraph is under the still-stationary cursor without a pointermove.
  const lastPointerYRef = useRef<number | null>(null);

  const setActive = useCallback((id: string | null) => {
    if (activeRef.current === id) return;
    activeRef.current = id;
    setHoveredBlockId(id);
  }, []);

  const remeasure = useCallback(() => {
    const dom = editor?.view.dom as HTMLElement | undefined;
    if (!dom) {
      anchorsRef.current = [];
      setAnchors([]);
      setActive(null);
      return;
    }
    const rail = dom.closest(".reader-rail") as HTMLElement | null;
    if (!rail) {
      anchorsRef.current = [];
      setAnchors([]);
      setActive(null);
      return;
    }
    const next = measureAnchors(rail).filter((anchor) =>
      isVisibleUnderFilter(processed.stateFor(anchor.blockId), processingFilter, hideIgnored),
    );
    anchorsRef.current = next;
    setAnchors(next);
    // If the paragraph we were hovering is no longer measured (e.g. a filter hid it),
    // drop the dangling hover so activeRef/hoveredBlockId never point at an unrendered block.
    if (activeRef.current !== null && !next.some((a) => a.blockId === activeRef.current)) {
      setActive(null);
    }
  }, [editor, hideIgnored, processed, processingFilter, setActive]);

  // Re-measure when the editor (re)mounts, the doc/decoration set changes, the
  // viewport resizes, OR the editor dispatches a transaction (e.g. the T016 block-id
  // filler mints ids just after mount — the paragraphs gain their `data-block-id`
  // then, so we must re-scan). A `ResizeObserver` on the editor surface catches
  // reflow from dimming a block (its margin shrinks) so the remaining buttons
  // re-anchor.
  useEffect(() => {
    if (!editorReady || !editor) {
      anchorsRef.current = [];
      setAnchors([]);
      setActive(null);
      return;
    }
    remeasure();
    const dom = editor.view.dom as HTMLElement;
    const onTx = () => remeasure();
    editor.on("transaction", onTx);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => remeasure());
      ro.observe(dom);
    }
    window.addEventListener("resize", remeasure);

    // Track the hovered paragraph by the cursor's vertical position (KTD1): map
    // clientY (rail-relative) to the paragraph whose band contains it. Because the
    // icon group shares its paragraph's Y band, reaching horizontally into the margin
    // keeps the same paragraph active without any close-grace timer (R3).
    const rail = dom.closest(".reader-rail") as HTMLElement | null;
    // The inner reader body owns vertical scroll; re-resolve the band on scroll so the
    // reveal follows the paragraph under a stationary cursor (wheel/trackpad reading).
    const scroller = dom.closest(".reader-page") as HTMLElement | null;
    const onPointerMove = (e: PointerEvent) => {
      if (!rail) return;
      lastPointerYRef.current = e.clientY;
      setActive(blockIdForY(e.clientY - rail.getBoundingClientRect().top, anchorsRef.current));
    };
    const onPointerLeave = () => {
      lastPointerYRef.current = null;
      setActive(null);
    };
    const onScroll = () => {
      const y = lastPointerYRef.current;
      if (y === null || !rail) return;
      setActive(blockIdForY(y - rail.getBoundingClientRect().top, anchorsRef.current));
    };
    if (rail) {
      rail.addEventListener("pointermove", onPointerMove);
      rail.addEventListener("pointerleave", onPointerLeave);
      // pointercancel (touch/pen, OS gesture capture) fires instead of pointerleave;
      // clear hover so a group never sticks revealed when the pointer stream is cut.
      rail.addEventListener("pointercancel", onPointerLeave);
    }
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      editor.off("transaction", onTx);
      ro?.disconnect();
      window.removeEventListener("resize", remeasure);
      if (rail) {
        rail.removeEventListener("pointermove", onPointerMove);
        rail.removeEventListener("pointerleave", onPointerLeave);
        rail.removeEventListener("pointercancel", onPointerLeave);
      }
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [editor, editorReady, remeasure, setActive]);

  // The `revision` token (decoration/processed/doc change) forces a re-measure even
  // when the ResizeObserver doesn't fire (e.g. a dim that doesn't change height).
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit re-measure trigger
  useEffect(() => {
    if (editorReady) remeasure();
  }, [revision, editorReady, remeasure]);

  // Always render the overlay container (so it is present for hover + tests) even
  // before the paragraphs are measured; the buttons appear once anchors resolve.
  return (
    <div className="readpara-overlay" aria-hidden={false} data-testid="processed-overlay">
      {editorReady &&
        anchors.map((a) => {
          const isProc = processed.isProcessed(a.blockId);
          const state = processed.stateFor(a.blockId);
          const isExtracted = state === "extracted";
          return (
            <div
              key={a.blockId}
              className="readpara__actions"
              style={{ top: a.top }}
              data-hovered={a.blockId === hoveredBlockId ? "true" : "false"}
            >
              <button
                type="button"
                className="readpara__mark"
                title={
                  isExtracted
                    ? "Extracted blocks stay linked to their output"
                    : isProc
                      ? `${stateTitle(state)} — click to restore`
                      : "Mark processed without output"
                }
                aria-label={
                  isExtracted
                    ? "Extracted paragraph"
                    : isProc
                      ? "Restore processed paragraph"
                      : "Mark paragraph processed"
                }
                aria-pressed={isProc}
                disabled={isExtracted}
                data-testid={`processed-toggle-${a.blockId}`}
                data-processed={isProc ? "true" : "false"}
                onClick={() => {
                  void processed
                    .toggle(a.blockId)
                    .then((result) => {
                      if (result) onToggled?.(result);
                      else onToggleFailed?.();
                    })
                    .catch(() => onToggleFailed?.());
                }}
              >
                <Icon name={isExtracted ? "extract" : isProc ? "restore" : "archive"} size={13} />
              </button>
              <button
                type="button"
                className="readpara__mark readpara__mark--secondary"
                title={
                  isExtracted ? "Extracted blocks stay linked to their output" : "Ignore paragraph"
                }
                aria-label={
                  isExtracted ? "Extracted paragraph cannot be ignored" : "Ignore paragraph"
                }
                disabled={isExtracted}
                data-testid={`processed-ignore-${a.blockId}`}
                onClick={() => {
                  void processed.markIgnored(a.blockId).then(
                    (ok) => (ok ? onToggled?.("marked") : onToggleFailed?.()),
                    () => onToggleFailed?.(),
                  );
                }}
              >
                <Icon name="x" size={12} />
              </button>
              <button
                type="button"
                className="readpara__mark readpara__mark--secondary"
                title={isExtracted ? "Extracted blocks stay linked to their output" : "Needs later"}
                aria-label={
                  isExtracted
                    ? "Extracted paragraph cannot be marked needs later"
                    : "Mark paragraph needs later"
                }
                disabled={isExtracted}
                data-testid={`processed-needs-later-${a.blockId}`}
                onClick={() => {
                  void processed.markNeedsLater(a.blockId).then(
                    (ok) => (ok ? onToggled?.("marked") : onToggleFailed?.()),
                    () => onToggleFailed?.(),
                  );
                }}
              >
                <Icon name="clock" size={12} />
              </button>
            </div>
          );
        })}
    </div>
  );
}

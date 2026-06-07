/**
 * Per-paragraph "mark processed" affordance for the reader (T026).
 *
 * Matches `design/kit/app/screen-reader.jsx`'s `.readpara__mark` button: a small
 * control anchored to each body paragraph that toggles the block between "Mark
 * processed (dim)" and "Processed — click to restore". Marking a paragraph processed
 * DIMS it (`.dimmed`, applied as a ProseMirror node decoration by `reader-decorations`)
 * so the user can declutter a long source WITHOUT deleting content; restoring removes
 * the `processed_span` `document_marks` row (fully reversible).
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
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import type { UseProcessedSpansResult } from "./useProcessedSpans";

/** A measured anchor for one body paragraph: its stable id + top offset in the rail. */
interface BlockAnchor {
  readonly blockId: string;
  /** Top offset of the block relative to the positioning rail (`.reader-rail`). */
  readonly top: number;
}

export interface ProcessedSpanButtonsProps {
  /** The live Tiptap editor whose paragraph blocks get the affordance. */
  readonly editor: Editor | null;
  /** Whether the editor is mounted/ready (gates measuring). */
  readonly editorReady: boolean;
  /** The processed-span hook (toggle + current state). */
  readonly processed: UseProcessedSpansResult;
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
    const top = block.getBoundingClientRect().top - railTop;
    anchors.push({ blockId, top });
  }
  return anchors;
}

export function ProcessedSpanButtons({
  editor,
  editorReady,
  processed,
  revision,
  onToggled,
  onToggleFailed,
}: ProcessedSpanButtonsProps) {
  const [anchors, setAnchors] = useState<readonly BlockAnchor[]>([]);

  const remeasure = useCallback(() => {
    const dom = editor?.view.dom as HTMLElement | undefined;
    if (!dom) {
      setAnchors([]);
      return;
    }
    const rail = dom.closest(".reader-rail") as HTMLElement | null;
    if (!rail) {
      setAnchors([]);
      return;
    }
    setAnchors(measureAnchors(rail));
  }, [editor]);

  // Re-measure when the editor (re)mounts, the doc/decoration set changes, the
  // viewport resizes, OR the editor dispatches a transaction (e.g. the T016 block-id
  // filler mints ids just after mount — the paragraphs gain their `data-block-id`
  // then, so we must re-scan). A `ResizeObserver` on the editor surface catches
  // reflow from dimming a block (its margin shrinks) so the remaining buttons
  // re-anchor.
  useEffect(() => {
    if (!editorReady || !editor) {
      setAnchors([]);
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
    return () => {
      editor.off("transaction", onTx);
      ro?.disconnect();
      window.removeEventListener("resize", remeasure);
    };
  }, [editor, editorReady, remeasure]);

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
          return (
            <button
              key={a.blockId}
              type="button"
              className="readpara__mark"
              style={{ top: a.top }}
              title={isProc ? "Processed — click to restore" : "Mark processed (dim)"}
              aria-label={isProc ? "Restore processed paragraph" : "Mark paragraph processed"}
              aria-pressed={isProc}
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
              <Icon name={isProc ? "restore" : "archive"} size={13} />
            </button>
          );
        })}
    </div>
  );
}

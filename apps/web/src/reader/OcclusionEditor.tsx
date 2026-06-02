/**
 * Occlusion editor (T071) — draw mask regions over a `media_fragment` image
 * extract and generate N sibling `image_occlusion` cards.
 *
 * The THIRD card-builder tab ("Image occlusion"), enabled when the current element
 * is an image extract. It:
 *  - loads the base image bytes through the typed `getRegionImage` command (the
 *    renderer never resolves a vault path) → an `<img>`;
 *  - lets the user draw rubber-band mask rects over the image (native pointer
 *    events, the SAME technique the PDF region-select uses), each normalized to
 *    `RegionRect` fractions 0–1 so it maps at any render zoom — no library;
 *  - supports adding, selecting, LABELING (an inline field per mask), and deleting
 *    masks; renders each as a translucent SVG box with its label;
 *  - on Generate cards, calls `appApi.generateOcclusionCards` → MAIN mints one
 *    `image_occlusion` card per mask (one sibling group), stores the masks SEPARATELY
 *    from the base image, and refreshes the inspector/lineage so the siblings appear.
 *
 * Pure UI: it calls the typed commands only — NO fs, NO SQL, NO vault path, NO image
 * re-encoding. The masks are vector regions composited at render time; the base crop
 * is never mutated. An edit-then-regenerate re-runs `replaceMasksForImage` MAIN-side.
 */

import { useCallback, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { priorityLabel } from "../components/inspector/primitives";
import { appApi, type PriorityLabel, type RegionRectInput } from "../lib/appApi";
import { useRegionImage } from "./useRegionImage";

/** A drawn mask: a normalized region + an optional reveal label + a stable local id. */
interface DraftMask {
  readonly id: string;
  region: RegionRectInput;
  label: string;
}

const PRIORITY_LABELS: readonly PriorityLabel[] = ["A", "B", "C", "D"];

/** Minimum normalized drag size; smaller is an accidental click, ignored. */
const MIN_MASK_FRACTION = 0.02;

let localMaskCounter = 0;
function nextMaskId(): string {
  localMaskCounter += 1;
  return `mask-${localMaskCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface OcclusionEditorProps {
  /** The `media_fragment` image extract id the masks are drawn over. */
  readonly imageElementId: string;
  /** The extract's numeric priority — the default A/B/C/D chip selection. */
  readonly imagePriority: number;
  /** Surface a transient status message (reuses the host view's toast). */
  readonly onToast: (message: string) => void;
  /** Re-fetch the inspector + lineage so the new siblings appear under the image. */
  readonly onCardsCreated: () => void;
  /** Close the builder column (returns to the two-column distill surface). */
  readonly onClose: () => void;
}

export function OcclusionEditor({
  imageElementId,
  imagePriority,
  onToast,
  onCardsCreated,
  onClose,
}: OcclusionEditorProps) {
  const imageUrl = useRegionImage(imageElementId);
  const [masks, setMasks] = useState<DraftMask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [priority, setPriority] = useState<PriorityLabel>(priorityLabel(imagePriority));
  const [busy, setBusy] = useState(false);

  // The rubber-band drag, in normalized fractions of the image box.
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<RegionRectInput | null>(null);

  // Map a pointer event to a clamped fraction 0–1 within the image overlay box.
  const toFraction = useCallback((clientX: number, clientY: number) => {
    const box = overlayRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.min(Math.max((clientX - box.left) / box.width, 0), 1),
      y: Math.min(Math.max((clientY - box.top) / box.height, 0), 1),
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only the left button draws; ignore clicks on an existing mask (selection).
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = toFraction(e.clientX, e.clientY);
      dragStartRef.current = p;
      setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    },
    [toFraction],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = dragStartRef.current;
      if (!start) return;
      const p = toFraction(e.clientX, e.clientY);
      setDrag({
        x0: Math.min(start.x, p.x),
        y0: Math.min(start.y, p.y),
        x1: Math.max(start.x, p.x),
        y1: Math.max(start.y, p.y),
      });
    },
    [toFraction],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const start = dragStartRef.current;
      dragStartRef.current = null;
      const rect = drag;
      setDrag(null);
      if (!start || !rect) return;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // Ignore a tiny accidental drag (a click without a real rectangle).
      if (rect.x1 - rect.x0 < MIN_MASK_FRACTION || rect.y1 - rect.y0 < MIN_MASK_FRACTION) return;
      const id = nextMaskId();
      setMasks((prev) => [...prev, { id, region: rect, label: "" }]);
      setSelectedId(id);
    },
    [drag],
  );

  const setLabel = useCallback((id: string, label: string) => {
    setMasks((prev) => prev.map((m) => (m.id === id ? { ...m, label } : m)));
  }, []);

  const removeMask = useCallback((id: string) => {
    setMasks((prev) => prev.filter((m) => m.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  const generate = useCallback(async () => {
    if (masks.length === 0 || busy) return;
    setBusy(true);
    try {
      const result = await appApi.generateOcclusionCards({
        imageElementId,
        priority,
        masks: masks.map((m) => ({
          region: m.region,
          label: m.label.trim() ? m.label.trim() : null,
        })),
      });
      const n = result.cards.length;
      onToast(`${n} occlusion card${n === 1 ? "" : "s"} created`);
      onCardsCreated();
      // Leave the editor ready: an edit-then-regenerate re-runs replaceMasksForImage
      // MAIN-side (deterministic). Keep the masks so the user can tweak + regenerate.
    } catch {
      onToast("Could not generate occlusion cards");
    } finally {
      setBusy(false);
    }
  }, [masks, busy, imageElementId, priority, onToast, onCardsCreated]);

  return (
    <aside className="card-builder" data-testid="occlusion-editor">
      <div className="card-builder__tabs" role="tablist" aria-label="Card type">
        <button
          type="button"
          role="tab"
          aria-selected={true}
          className="cb-tab"
          data-on="true"
          data-testid="cb-tab-occlusion"
        >
          Image occlusion
        </button>
        <button
          type="button"
          className="cb-tab cb-tab--close"
          aria-label="Close card builder"
          data-testid="occlusion-close"
          onClick={onClose}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <div className="card-builder__body">
        <div className="cb-field__hint" data-testid="occlusion-hint">
          Drag over the image to mask a region. Each mask becomes one sibling card.
        </div>

        <div className="occlusion-canvas-wrap" data-testid="occlusion-canvas">
          {imageUrl ? (
            <div className="occlusion-stage">
              <img
                className="occlusion-stage__img"
                data-testid="occlusion-base-img"
                src={imageUrl}
                alt="Diagram to occlude"
                draggable={false}
              />
              {/* The pointer-grabbing overlay + the SVG mask boxes (normalized). */}
              <div
                ref={overlayRef}
                className="occlusion-overlay"
                data-testid="occlusion-overlay"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
              >
                <svg className="occlusion-svg" preserveAspectRatio="none" viewBox="0 0 1 1">
                  <title>Mask regions</title>
                  {masks.map((m, i) => (
                    <rect
                      key={m.id}
                      data-testid="occlusion-mask"
                      className={`occlusion-mask${selectedId === m.id ? " occlusion-mask--sel" : ""}`}
                      x={m.region.x0}
                      y={m.region.y0}
                      width={Math.max(0, m.region.x1 - m.region.x0)}
                      height={Math.max(0, m.region.y1 - m.region.y0)}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setSelectedId(m.id);
                      }}
                    >
                      <title>{m.label.trim() || `Region ${i + 1}`}</title>
                    </rect>
                  ))}
                  {drag ? (
                    <rect
                      className="occlusion-mask occlusion-mask--draft"
                      x={drag.x0}
                      y={drag.y0}
                      width={Math.max(0, drag.x1 - drag.x0)}
                      height={Math.max(0, drag.y1 - drag.y0)}
                    />
                  ) : null}
                </svg>
              </div>
            </div>
          ) : (
            <p className="dimmed" data-testid="occlusion-no-image">
              The figure image loads through the desktop bridge.
            </p>
          )}
        </div>

        {/* The mask list — label + delete per mask. */}
        <div className="insp-sec">
          <div className="insp-sec__title">Masks · {masks.length}</div>
          {masks.length === 0 ? (
            <p className="dimmed" data-testid="occlusion-empty">
              No masks yet — drag over the image above.
            </p>
          ) : (
            <ul className="occlusion-list" data-testid="occlusion-list">
              {masks.map((m, i) => (
                <li
                  key={m.id}
                  className={`occlusion-list__row${selectedId === m.id ? " occlusion-list__row--sel" : ""}`}
                  data-testid="occlusion-list-row"
                >
                  <span className="occlusion-list__n">{i + 1}</span>
                  <input
                    type="text"
                    className="occlusion-list__label"
                    data-testid="occlusion-label-input"
                    value={m.label}
                    placeholder={`Region ${i + 1} (label, optional)`}
                    onFocus={() => setSelectedId(m.id)}
                    onChange={(e) => setLabel(m.id, e.target.value)}
                  />
                  <button
                    type="button"
                    className="occlusion-list__del"
                    aria-label={`Delete mask ${i + 1}`}
                    data-testid="occlusion-delete"
                    onClick={() => removeMask(m.id)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Priority & schedule — A/B/C/D chips + the FSRS preview chip. */}
        <div className="insp-sec cb-schedule">
          <div className="insp-sec__title">Priority &amp; schedule</div>
          <div className="cb-prio-row" data-testid="occlusion-priority">
            {PRIORITY_LABELS.map((p) => (
              <button
                key={p}
                type="button"
                className="cb-prio-chip"
                data-active={priority === p ? "true" : "false"}
                data-testid={`occlusion-priority-${p}`}
                onClick={() => setPriority(p)}
              >
                <span className={`prio-dot prio-dot--${p.toLowerCase()}`} />
                {p}
              </button>
            ))}
          </div>
          <div className="cb-meta">
            <div className="cb-meta__row">
              <span className="cb-meta__k">Scheduler</span>
              <span className="cb-meta__v">
                <span className="sched sched--fsrs" data-testid="occlusion-scheduler-fsrs">
                  <Icon name="brain" size={12} /> FSRS
                </span>
              </span>
            </div>
          </div>
        </div>

        <button
          type="button"
          className="cb-create"
          data-testid="occlusion-generate"
          disabled={masks.length === 0 || busy}
          onClick={() => void generate()}
        >
          <Icon name="layers" size={14} /> Generate {masks.length || ""} card
          {masks.length === 1 ? "" : "s"}
        </button>
      </div>
    </aside>
  );
}

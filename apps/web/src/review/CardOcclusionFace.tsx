/**
 * Image-occlusion review face (T071) — render the base image with ONE masked
 * region hidden on the front, revealed on reveal.
 *
 * An `image_occlusion` card carries (resolved MAIN-side from `occlusion_masks`) its
 * own masked `region`, the optional `label`, and the sibling masks (`otherRegions`).
 * The face loads the base image bytes through the typed `getRegionImage` command
 * (the renderer never resolves a vault path) and composites a SOLID box over the
 * card's `region` on the FRONT — the masking is PRESENTATIONAL (a CSS/SVG box over
 * the clean `<img>`), the image is NEVER re-encoded. On reveal the box is cleared so
 * the region shows, and the `label` text is shown.
 *
 * The same clean base crop powers every sibling card (the masks are stored
 * separately, never baked into the image). No SQL, no scheduling, no fs.
 */

import { useRegionImage } from "../reader/useRegionImage";

/** A normalized region the face composites over the image (fractions 0–1). */
interface FaceRegion {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface CardOcclusionFaceInput {
  readonly imageElementId: string;
  readonly region: FaceRegion;
  readonly label: string | null;
  readonly otherRegions: readonly FaceRegion[];
}

/** Round a fraction to a clean percentage string (avoids FP noise like 30.0000004%). */
function pct(fraction: number): string {
  return `${Number((fraction * 100).toFixed(4))}%`;
}

/** Inline style positioning a normalized region as a percentage box over the image. */
function boxStyle(region: FaceRegion): React.CSSProperties {
  return {
    left: pct(region.x0),
    top: pct(region.y0),
    width: pct(Math.max(0, region.x1 - region.x0)),
    height: pct(Math.max(0, region.y1 - region.y0)),
  };
}

/**
 * Render an image-occlusion card. On the FRONT (`revealed === false`) the card's
 * own `region` is hidden by a solid mask box; the sibling regions are lightly
 * dimmed so the eye knows others exist. On reveal the masked box is cleared and the
 * `label` is shown below the image.
 */
export function CardOcclusionFace({
  occlusion,
  revealed,
}: {
  occlusion: CardOcclusionFaceInput;
  revealed: boolean;
}) {
  const imageUrl = useRegionImage(occlusion.imageElementId);

  return (
    <div className="rcard-occlusion" data-testid="review-occlusion">
      {imageUrl ? (
        <div className="rcard-occlusion__stage">
          <img
            className="rcard-occlusion__img"
            data-testid="review-occlusion-img"
            src={imageUrl}
            alt="Diagram with one region occluded"
            draggable={false}
          />
          {/* The sibling regions — a light dim so the diagram reads as "there are
              other labels", without revealing this card's answer. */}
          {occlusion.otherRegions.map((r, i) => (
            <div
              // Positional, never reordered within one render.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional sibling regions
              key={i}
              className="rcard-occlusion__sibling"
              style={boxStyle(r)}
              aria-hidden="true"
            />
          ))}
          {/* This card's masked region: a solid box on the front, cleared on reveal. */}
          {!revealed ? (
            <div
              className="rcard-occlusion__mask"
              data-testid="review-occlusion-mask"
              style={boxStyle(occlusion.region)}
            />
          ) : (
            <div
              className="rcard-occlusion__mask rcard-occlusion__mask--revealed"
              data-testid="review-occlusion-revealed"
              style={boxStyle(occlusion.region)}
            />
          )}
        </div>
      ) : (
        <p className="dimmed" data-testid="review-occlusion-no-image">
          The figure image loads through the desktop bridge.
        </p>
      )}
      {revealed && occlusion.label ? (
        <div className="rcard-occlusion__label" data-testid="review-occlusion-label">
          {occlusion.label}
        </div>
      ) : null}
    </div>
  );
}

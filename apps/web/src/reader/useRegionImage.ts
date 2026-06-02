/**
 * useRegionImage (T071) — load a `media_fragment` extract's base image bytes as an
 * object URL through the typed `sources.getRegionImage` command.
 *
 * The renderer NEVER resolves a vault path or reads bytes off disk: MAIN owns the
 * asset vault and returns the cropped PNG bytes for an element id; we wrap them in
 * an object URL for an `<img>` and revoke it on change/unmount. Reused by the
 * occlusion editor (drawing masks over the base image) and the review occlusion
 * face (compositing one mask over the clean base image). Degrades to `null`
 * (no preview) outside desktop or when the element has no image asset.
 */

import { useEffect, useState } from "react";
import { appApi, isDesktop } from "../lib/appApi";

/** The object URL for an element's base image, or `null` while loading / unavailable. */
export function useRegionImage(elementId: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop() || !elementId) {
      setUrl(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    void appApi
      .getRegionImage({ elementId })
      .then((res) => {
        if (cancelled || !res.bytes) return;
        const blob = new Blob([res.bytes], { type: res.mime ?? "image/png" });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        /* the figure degrades to no preview */
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [elementId]);

  return url;
}

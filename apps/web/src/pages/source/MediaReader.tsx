/**
 * Media reading mode (T073) — the `<video>`/`<audio>` (local) or YouTube IFrame
 * (referenced) body the `SourceReader` swaps in when `documents.get` reports
 * `sourceFormat: "video"`.
 *
 * It loads the source's playable data ONCE through the typed `sources.getMediaData`
 * command (the renderer never resolves a vault path):
 *   - a LOCAL source plays the privileged `media://<elementId>` URL in an HTML5
 *     `<video controls>` / `<audio controls>` (streamed with Range support — the
 *     bytes are never buffered over IPC);
 *   - a YOUTUBE source embeds the IFrame player (`youtube.com/embed/<id>`) — no
 *     bytes, an on-device-rendered iframe; a manual "Set read-point at current time"
 *     captures the time the user enters (the IFrame Player API is a clean upgrade).
 *
 * A transcript pane (when the body has cue paragraphs from `blockTimestamps`) lets
 * the user click a cue to SEEK the player to that cue's `timestampMs`; the
 * currently-playing cue is highlighted (derived from `currentTime` → the nearest
 * cue). A "Set read-point" press persists the current cue's stable block id via
 * `readPoints.set` (a transcript-backed video reuses `read_points` exactly); a
 * transcript-LESS video persists the TITLE-HEADING block id with `offset =
 * floor(currentTimeMs)` (the offset-as-seconds convention), so the single
 * `read_points` table serves both cases with NO new `sources` column. Reopening
 * seeks the player to the saved cue time (or the saved second).
 *
 * Pure UI: typed commands only — no fs/fetch/parse/SQL in the renderer. Outside the
 * desktop shell it degrades to a calm fallback.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { appApi, isDesktop, type SourcesGetMediaDataResult } from "../../lib/appApi";
import "./media-reader.css";

/** One transcript cue derived from the body + `blockTimestamps`. */
interface Cue {
  /** The stable block id (the read-point anchor). */
  readonly blockId: string;
  /** The cue start in milliseconds. */
  readonly timestampMs: number;
  /** The cue text. */
  readonly text: string;
}

export interface MediaReaderProps {
  /** The media source element id. */
  readonly elementId: string;
  /** The loaded ProseMirror body JSON (the transcript heading + cue paragraphs). */
  readonly prosemirrorJson: unknown;
  /** The block→time map (stable block id → cue start ms) from `documents.get`. */
  readonly blockTimestamps: Readonly<Record<string, number>>;
  /** Toast helper from the parent reader (status messages). */
  readonly toast: (message: string) => void;
}

/**
 * Walk the constrained ProseMirror doc + the `blockTimestamps` map into an ordered
 * cue list. The body is a title heading + one paragraph per cue (T073); a paragraph
 * whose stable block id is in `blockTimestamps` is a cue.
 */
function deriveCues(
  doc: unknown,
  blockTimestamps: Readonly<Record<string, number>>,
): { cues: Cue[]; titleBlockId: string | null } {
  const cues: Cue[] = [];
  let titleBlockId: string | null = null;
  const root = doc as { content?: unknown[] } | null;
  const content = Array.isArray(root?.content) ? root.content : [];
  for (const node of content) {
    const n = node as {
      type?: string;
      attrs?: { blockId?: string };
      content?: { type?: string; text?: string }[];
    };
    const blockId = n.attrs?.blockId ?? null;
    if (!blockId) continue;
    const text = (n.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
    if (n.type === "heading" && titleBlockId == null) {
      titleBlockId = blockId;
      continue;
    }
    const ts = blockTimestamps[blockId];
    if (typeof ts === "number") {
      cues.push({ blockId, timestampMs: ts, text });
    }
  }
  return { cues, titleBlockId };
}

/** Format ms as `m:ss` / `h:mm:ss` for the transcript pane + chips. */
function fmtTime(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function MediaReader({
  elementId,
  prosemirrorJson,
  blockTimestamps,
  toast,
}: MediaReaderProps) {
  const desktop = isDesktop();
  const [media, setMedia] = useState<SourcesGetMediaDataResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const mediaElRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  const { cues, titleBlockId } = useMemo(
    () => deriveCues(prosemirrorJson, blockTimestamps),
    [prosemirrorJson, blockTimestamps],
  );
  const hasTranscript = cues.length > 0;

  // Load the playable data once per element.
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    setMedia(null);
    setLoadError(null);
    void appApi
      .getMediaData({ elementId })
      .then((result) => {
        if (!cancelled) setMedia(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [desktop, elementId]);

  // The cue currently playing (the last cue whose start <= currentMs).
  const activeCueIndex = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < cues.length; i += 1) {
      const cue = cues[i];
      if (cue && cue.timestampMs <= currentMs) idx = i;
      else break;
    }
    return idx;
  }, [cues, currentMs]);

  /** Seek the local player to a millisecond offset. */
  const seekTo = useCallback((ms: number) => {
    const el = mediaElRef.current;
    if (el) {
      el.currentTime = ms / 1000;
      void el.play?.().catch(() => {});
    }
  }, []);

  // Resume from the saved read-point once the media + cues are known.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (!desktop || resumedRef.current) return;
    // Only resume the LOCAL player (the YouTube IFrame has no seek without the API).
    if (media?.mediaSource !== "local") return;
    resumedRef.current = true;
    void appApi
      .getReadPoint({ elementId })
      .then((result) => {
        const rp = result.readPoint;
        if (!rp) return;
        // Transcript-backed: the block id is a cue → resume at the cue's timestamp.
        const cue = cues.find((c) => c.blockId === rp.blockId);
        if (cue) {
          seekTo(cue.timestampMs);
          return;
        }
        // Transcript-less: the title-heading block id carries `offset` = seconds.
        if (rp.blockId === titleBlockId && rp.offset > 0) {
          seekTo(rp.offset * 1000);
        }
      })
      .catch(() => {});
  }, [desktop, media?.mediaSource, elementId, cues, titleBlockId, seekTo]);

  /**
   * Persist the timestamp read-point. Transcript-backed → the ACTIVE cue's block id
   * (offset 0). Transcript-less → the TITLE-heading block id with `offset =
   * floor(currentSeconds)` (the offset-as-seconds convention). Both write the single
   * `read_points` row.
   */
  const setReadPoint = useCallback(async () => {
    try {
      let blockId: string | null = null;
      let offset = 0;
      if (hasTranscript && activeCueIndex >= 0) {
        blockId = cues[activeCueIndex]?.blockId ?? null;
        offset = 0;
      } else if (titleBlockId) {
        blockId = titleBlockId;
        offset = Math.floor(currentMs / 1000);
      }
      if (!blockId) {
        toast("Play the media first to set a read-point.");
        return;
      }
      await appApi.setReadPoint({ elementId, documentId: elementId, blockId, offset });
      toast(
        hasTranscript
          ? "Read-point set at the current cue."
          : `Read-point set at ${fmtTime(currentMs)}.`,
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not set the read-point.");
    }
  }, [hasTranscript, activeCueIndex, cues, titleBlockId, currentMs, elementId, toast]);

  if (!desktop) {
    return (
      <div className="reader-state" data-testid="media-reader-nodesktop">
        <span className="reader-state__icon">
          <Icon name="media" size={26} />
        </span>
        <p className="max-w-sm">
          The media reader plays through the desktop bridge — open the Electron app to watch a video
          or audio source.
        </p>
      </div>
    );
  }

  return (
    <div className="media-reader" data-testid="media-reader">
      <div className="media-reader-bar">
        <button
          type="button"
          className="reader-btn reader-btn--primary"
          data-testid="media-set-readpoint"
          onClick={() => void setReadPoint()}
        >
          <Icon name="bookmark" size={14} /> Set read-point
        </button>
        <span className="media-reader-time" data-testid="media-current-time">
          {fmtTime(currentMs)}
          {media?.durationMs ? ` / ${fmtTime(media.durationMs)}` : ""}
        </span>
      </div>

      {loadError ? (
        <p className="media-reader-error" data-testid="media-reader-error">
          {loadError}
        </p>
      ) : null}

      <div
        className={
          hasTranscript ? "media-reader-body media-reader-body--split" : "media-reader-body"
        }
      >
        <div className="media-reader-player">
          {media == null ? (
            <div className="media-reader-loading">Loading media…</div>
          ) : media.mediaSource === "youtube" && media.youtubeId ? (
            <iframe
              className="media-reader-iframe"
              data-testid="media-reader-iframe"
              src={`https://www.youtube.com/embed/${media.youtubeId}`}
              title="YouTube video"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          ) : media.mediaSource === "local" && media.mediaUrl && media.mediaKind === "audio" ? (
            // biome-ignore lint/a11y/useMediaCaption: captions render in the transcript pane (T073)
            <audio
              ref={mediaElRef as React.RefObject<HTMLAudioElement>}
              className="media-reader-audio"
              data-testid="media-reader-audio"
              src={media.mediaUrl}
              controls
              onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
            />
          ) : media.mediaSource === "local" && media.mediaUrl ? (
            // biome-ignore lint/a11y/useMediaCaption: captions render in the transcript pane (T073)
            <video
              ref={mediaElRef as React.RefObject<HTMLVideoElement>}
              className="media-reader-video"
              data-testid="media-reader-video"
              src={media.mediaUrl}
              controls
              onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
            />
          ) : (
            <div className="media-reader-loading" data-testid="media-reader-unplayable">
              This media source has no playable data.
            </div>
          )}
        </div>

        {hasTranscript ? (
          <div className="media-reader-transcript" data-testid="media-reader-transcript">
            <div className="media-reader-transcript-head">Transcript</div>
            <ol className="media-reader-cues">
              {cues.map((cue, i) => (
                <li key={cue.blockId}>
                  <button
                    type="button"
                    className={
                      i === activeCueIndex
                        ? "media-reader-cue media-reader-cue--active"
                        : "media-reader-cue"
                    }
                    data-testid="media-reader-cue"
                    data-active={i === activeCueIndex ? "true" : undefined}
                    onClick={() => {
                      if (media?.mediaSource === "local") seekTo(cue.timestampMs);
                    }}
                  >
                    <span className="media-reader-cue-time">{fmtTime(cue.timestampMs)}</span>
                    <span className="media-reader-cue-text">{cue.text}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="media-reader-noscript" data-testid="media-reader-noscript">
            No transcript available — play the media and set timestamp read-points; clip by
            selecting a start/end time (coming in T074).
          </div>
        )}
      </div>
    </div>
  );
}

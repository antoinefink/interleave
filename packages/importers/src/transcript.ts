/**
 * Transcript (VTT/SRT) → typed cue list (T073) — a pure, framework-agnostic parse.
 *
 * A media source's transcript comes from EXISTING captions: a YouTube caption
 * track, or a sidecar `.vtt`/`.srt` the user picks beside a local file (NO ASR in
 * this milestone — see the M15 "Scope honesty"). This module turns the raw caption
 * STRING into a clean, sorted `TranscriptCue[]` the `transcriptToProseMirrorDoc`
 * transform walks into the constrained ProseMirror body. It wraps `subsrt-ts` (a
 * tiny, dependency-free, pure-TS parser that reads BOTH WebVTT and SRT into a typed
 * cue list with millisecond timings + tag-stripped `text`), then normalizes:
 *
 *   - keeps only real caption cues (drops `subsrt-ts`'s `meta`/`style` entries),
 *   - drops empty / whitespace-only cues,
 *   - collapses inline whitespace in each cue's text (clean for search/preview),
 *   - sorts by `startMs` (overlapping cues are kept, ordered by start),
 *   - tolerates a missing end time (`endMs = null`).
 *
 * It handles the cue-timing edge cases the milestone calls out (fixture-tested):
 * overlapping cues, a cue with no end time, `\r\n` line endings, an empty/whitespace
 * cue (dropped), a cue with `<c>`/`<i>` styling tags (stripped to text), SRT
 * comma-millisecond vs VTT dot-millisecond, and a BOM-prefixed file — all delegated
 * to `subsrt-ts`'s parse + this normalization. Pure: string in, structured cues out;
 * no `fs`, no Electron, no network.
 */

import { parse as parseSubtitles } from "subsrt-ts";

/**
 * One transcript cue: a start (and optional end) in MILLISECONDS plus the
 * tag-stripped, whitespace-collapsed text. `endMs` is `null` when the source cue
 * carried no end time (a degenerate but valid VTT/SRT case).
 */
export interface TranscriptCue {
  readonly startMs: number;
  readonly endMs: number | null;
  readonly text: string;
}

/** The subtitle format hint passed to {@link parseTranscript}. */
export type TranscriptFormat = "vtt" | "srt" | "auto";

/**
 * Parse a raw VTT/SRT transcript string into a clean, sorted {@link TranscriptCue}
 * list. `format` is a hint: `"auto"` lets `subsrt-ts` detect VTT vs SRT (it reads
 * the magic `WEBVTT` header for VTT, else SRT). A parse that throws (a truly
 * malformed file) returns `[]` — a transcript is best-effort, never a hard failure
 * (the import degrades to the transcript-less placeholder).
 *
 * @param text the raw caption text (BOM/CRLF tolerated by `subsrt-ts`).
 * @param format the subtitle format, or `"auto"` to detect.
 */
export function parseTranscript(text: string, format: TranscriptFormat = "auto"): TranscriptCue[] {
  if (typeof text !== "string" || text.trim().length === 0) return [];

  let raw: ReturnType<typeof parseSubtitles>;
  try {
    raw = parseSubtitles(text, format === "auto" ? {} : { format });
  } catch {
    // A truly unparseable transcript is treated as "no transcript" (best-effort).
    return [];
  }

  const cues: TranscriptCue[] = [];
  for (const entry of raw) {
    // `subsrt-ts` yields `meta`/`style` entries alongside captions; keep captions.
    if (entry.type !== "caption") continue;
    // Prefer the tag-stripped `text`; fall back to `content` if absent.
    const rawText = (entry.text ?? entry.content ?? "").toString();
    const cleaned = rawText.replace(/\s+/g, " ").trim();
    if (cleaned.length === 0) continue; // drop empty/whitespace-only cues

    const startMs = Number.isFinite(entry.start) ? Math.max(0, Math.round(entry.start)) : 0;
    const endRaw = entry.end;
    // A missing/<=start end time → `null` (a degenerate but valid cue).
    const endMs =
      typeof endRaw === "number" && Number.isFinite(endRaw) && endRaw > startMs
        ? Math.round(endRaw)
        : null;

    cues.push({ startMs, endMs, text: cleaned });
  }

  // Stable sort by start (overlapping cues are kept; ties preserve input order).
  return cues
    .map((cue, index) => ({ cue, index }))
    .sort((a, b) => a.cue.startMs - b.cue.startMs || a.index - b.index)
    .map(({ cue }) => cue);
}

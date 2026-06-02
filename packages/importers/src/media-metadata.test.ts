/**
 * Unit tests for the pure media duration probe (T073), against the tiny committed
 * fixture media files under `src/__fixtures__/transcript/`.
 *
 * Proves: an MP4 (ISO-BMFF) header is probed to its `mvhd` duration in ms; an
 * unrecognized/headerless buffer degrades to `null` (best-effort, never throws).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MEDIA_PROBE_BYTES, probeMediaDurationMs } from "./media-metadata";

const here = path.dirname(fileURLToPath(import.meta.url));

function readHead(name: string): Uint8Array {
  const buf = readFileSync(path.join(here, "__fixtures__", "transcript", name));
  const end = Math.min(buf.byteLength, MEDIA_PROBE_BYTES);
  return new Uint8Array(buf.buffer, buf.byteOffset, end);
}

describe("probeMediaDurationMs", () => {
  it("reads an MP4 (ISO-BMFF) duration from the mvhd box (~1000ms fixture)", () => {
    const ms = probeMediaDurationMs(readHead("tiny-video.mp4"));
    expect(ms).not.toBeNull();
    // The fixture is a 1-second clip; allow a small container-rounding tolerance.
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(ms).toBeLessThanOrEqual(1100);
  });

  it("returns null for an unrecognized/headerless buffer (never throws)", () => {
    expect(probeMediaDurationMs(new Uint8Array([0, 1, 2, 3, 4, 5]))).toBeNull();
    expect(probeMediaDurationMs(new Uint8Array(0))).toBeNull();
    // An MP3 frame header is not a container we probe → null (no crash).
    expect(probeMediaDurationMs(readHead("tiny-audio.mp3"))).toBeNull();
  });
});

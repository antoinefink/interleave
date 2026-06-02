/**
 * Local media duration probe (T073) — a pure, dependency-free container reader.
 *
 * A local media file's `durationMs` is useful provenance (the inspector shows it,
 * the T074 clip path bounds a clip to it). We do NOT bundle `ffmpeg` (see the M15
 * "Scope honesty"), so this reads the duration straight from the two common
 * container formats' headers, degrading to `null` for anything it does not
 * recognize (the import never fails on an unprobeable file):
 *
 *   - **ISO-BMFF (MP4 / M4A / MOV)** — walk the top-level boxes to `moov` → `mvhd`,
 *     reading `timescale` + `duration` (v0 32-bit or v1 64-bit) → ms.
 *   - **Matroska / WebM** — scan the EBML for the `Segment` → `Info` → `Duration`
 *     float, scaled by `TimecodeScale` (ns), → ms.
 *
 * It works on the FIRST N bytes (the header region) — it does not read whole files
 * — so the caller passes a small head buffer. Pure: a `Uint8Array` in, a number (or
 * `null`) out; no `fs`, no Electron.
 */

/** How many leading bytes the caller should read for the probe (covers most headers). */
export const MEDIA_PROBE_BYTES = 256 * 1024;

/**
 * Probe a media file's duration in milliseconds from its header bytes, or `null`
 * when the format is unrecognized or the duration box is absent. Best-effort —
 * never throws.
 *
 * @param head the first {@link MEDIA_PROBE_BYTES} (or fewer) bytes of the file.
 */
export function probeMediaDurationMs(head: Uint8Array): number | null {
  try {
    const isoMp4 = probeIsoBmff(head);
    if (isoMp4 != null) return isoMp4;
    const matroska = probeMatroska(head);
    if (matroska != null) return matroska;
  } catch {
    // A malformed header is just "unknown duration" — never a hard failure.
  }
  return null;
}

// --- ISO-BMFF (MP4 / M4A / MOV) ------------------------------------------------

/** Walk ISO-BMFF boxes to `moov` → `mvhd` and read the duration. */
function probeIsoBmff(buf: Uint8Array): number | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // A real ISO-BMFF file starts with an `ftyp` box.
  if (buf.byteLength < 8 || readType(buf, 4) !== "ftyp") return null;

  const moov = findBox(buf, view, 0, buf.byteLength, "moov");
  if (!moov) return null;
  const mvhd = findBox(buf, view, moov.contentStart, moov.end, "mvhd");
  if (!mvhd) return null;

  const p = mvhd.contentStart;
  if (p + 4 > buf.byteLength) return null;
  const version = buf[p];
  if (version === 1) {
    // v1: 8 (creation) + 8 (modification) + 4 (timescale) + 8 (duration).
    const tsOffset = p + 4 + 8 + 8;
    const durOffset = tsOffset + 4;
    if (durOffset + 8 > buf.byteLength) return null;
    const timescale = view.getUint32(tsOffset);
    const duration = Number(view.getBigUint64(durOffset));
    return timescale > 0 ? Math.round((duration / timescale) * 1000) : null;
  }
  // v0: 4 (creation) + 4 (modification) + 4 (timescale) + 4 (duration).
  const tsOffset = p + 4 + 4 + 4;
  const durOffset = tsOffset + 4;
  if (durOffset + 4 > buf.byteLength) return null;
  const timescale = view.getUint32(tsOffset);
  const duration = view.getUint32(durOffset);
  return timescale > 0 ? Math.round((duration / timescale) * 1000) : null;
}

interface BoxRange {
  readonly contentStart: number;
  readonly end: number;
}

/** Find the first child box of `type` within `[start, limit)`, or `null`. */
function findBox(
  buf: Uint8Array,
  view: DataView,
  start: number,
  limit: number,
  type: string,
): BoxRange | null {
  let offset = start;
  while (offset + 8 <= limit) {
    const size = view.getUint32(offset);
    const boxType = readType(buf, offset + 4);
    let headerSize = 8;
    let boxSize = size;
    if (size === 1) {
      // 64-bit largesize follows the type.
      if (offset + 16 > limit) break;
      boxSize = Number(view.getBigUint64(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      // Box extends to the end of the file/region.
      boxSize = limit - offset;
    }
    if (boxSize < headerSize) break;
    const end = Math.min(offset + boxSize, limit);
    if (boxType === type) {
      return { contentStart: offset + headerSize, end };
    }
    offset += boxSize;
  }
  return null;
}

/** Read a 4-char ASCII box type. */
function readType(buf: Uint8Array, at: number): string {
  return String.fromCharCode(buf[at] ?? 0, buf[at + 1] ?? 0, buf[at + 2] ?? 0, buf[at + 3] ?? 0);
}

// --- Matroska / WebM -----------------------------------------------------------

/** EBML element ids we care about (as their full id bytes, big-endian). */
const EBML_SEGMENT = 0x18538067;
const EBML_INFO = 0x1549a966;
const EBML_TIMECODE_SCALE = 0x2ad7b1;
const EBML_DURATION = 0x4489;

/**
 * Scan an EBML/Matroska header for `Segment` → `Info` → `Duration`, scaled by
 * `TimecodeScale` (default 1,000,000 ns). Returns ms, or `null`.
 */
function probeMatroska(buf: Uint8Array): number | null {
  // EBML files start with the magic `0x1A45DFA3`.
  if (
    buf.byteLength < 4 ||
    buf[0] !== 0x1a ||
    buf[1] !== 0x45 ||
    buf[2] !== 0xdf ||
    buf[3] !== 0xa3
  ) {
    return null;
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const segment = scanForElement(buf, 0, buf.byteLength, EBML_SEGMENT);
  if (!segment) return null;
  const info = scanForElement(buf, segment.contentStart, segment.contentEnd, EBML_INFO);
  if (!info) return null;

  let timecodeScale = 1_000_000; // ns, the Matroska default.
  let durationTicks: number | null = null;

  let offset = info.contentStart;
  while (offset < info.contentEnd) {
    const el = readElement(buf, offset, info.contentEnd);
    if (!el) break;
    if (el.id === EBML_TIMECODE_SCALE) {
      timecodeScale = readUintValue(buf, el.contentStart, el.contentEnd) ?? timecodeScale;
    } else if (el.id === EBML_DURATION) {
      const len = el.contentEnd - el.contentStart;
      if (len === 4) durationTicks = view.getFloat32(el.contentStart);
      else if (len === 8) durationTicks = view.getFloat64(el.contentStart);
    }
    offset = el.contentEnd;
  }
  if (durationTicks == null) return null;
  // duration (in timecode ticks) * timecodeScale (ns/tick) / 1e6 → ms.
  return Math.round((durationTicks * timecodeScale) / 1_000_000);
}

interface EbmlElement {
  readonly id: number;
  readonly contentStart: number;
  readonly contentEnd: number;
}

/** Read one EBML element (id + size + content range) at `offset`, or `null`. */
function readElement(buf: Uint8Array, offset: number, limit: number): EbmlElement | null {
  if (offset >= limit) return null;
  const id = readVint(buf, offset, limit, true);
  if (!id) return null;
  const size = readVint(buf, id.end, limit, false);
  if (!size) return null;
  const contentStart = size.end;
  const contentEnd = size.value < 0 ? limit : Math.min(contentStart + size.value, limit);
  return { id: id.value, contentStart, contentEnd };
}

/** Recursively find the first descendant element of `id` within a master element. */
function scanForElement(
  buf: Uint8Array,
  start: number,
  limit: number,
  targetId: number,
): EbmlElement | null {
  let offset = start;
  while (offset < limit) {
    const el = readElement(buf, offset, limit);
    if (!el) break;
    if (el.id === targetId) return el;
    offset = el.contentEnd;
  }
  return null;
}

interface Vint {
  readonly value: number;
  readonly end: number;
}

/** Read an EBML variable-length integer; `keepMarker` preserves the length marker (for ids). */
function readVint(
  buf: Uint8Array,
  offset: number,
  limit: number,
  keepMarker: boolean,
): Vint | null {
  if (offset >= limit) return null;
  const first = buf[offset] ?? 0;
  if (first === 0) return null;
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > limit) return null;

  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + (buf[offset + i] ?? 0);
  }
  return { value, end: offset + length };
}

/** Read an unsigned big-endian integer from a byte range. */
function readUintValue(buf: Uint8Array, start: number, end: number): number | null {
  if (end <= start || end - start > 8) return null;
  let value = 0;
  for (let i = start; i < end; i += 1) {
    value = value * 256 + (buf[i] ?? 0);
  }
  return value;
}

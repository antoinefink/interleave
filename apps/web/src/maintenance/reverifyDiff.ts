/**
 * reverifyDiff (T124) — a small, pure word-level diff for the re-verify surface.
 *
 * The re-verify screen shows "what changed" between the anchor text an output was
 * extracted from (`oldAnchorText`) and the source block's current text
 * (`currentBlockText`) so a user can confirm/rebase/detach with the drift in view. This
 * only needs to be LEGIBLE, not a full Myers diff — a word-level longest-common-
 * subsequence over whitespace-delimited tokens is enough and keeps the renderer cheap.
 *
 * Pure presentation helper: no domain logic, no `appApi`. Returns ordered segments the
 * screen paints with token-driven colors (insertions `--ok`, deletions `--danger`).
 */

/** One contiguous run of the diff: unchanged, inserted (new), or deleted (old). */
export interface ReverifyDiffSegment {
  readonly type: "equal" | "insert" | "delete";
  readonly text: string;
}

/**
 * Tokenize into words AND the whitespace between them, so reassembling the segments
 * reproduces the input exactly (spacing is preserved, not collapsed). Each token is
 * either a maximal run of non-whitespace or a maximal run of whitespace.
 */
function tokenize(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

/**
 * Coalesce adjacent same-type pieces into one segment, dropping empties — so the screen
 * renders one `<span>` per run rather than one per token.
 */
function coalesce(pieces: ReverifyDiffSegment[]): ReverifyDiffSegment[] {
  const out: ReverifyDiffSegment[] = [];
  for (const piece of pieces) {
    if (piece.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.type === piece.type) {
      out[out.length - 1] = { type: last.type, text: last.text + piece.text };
    } else {
      out.push(piece);
    }
  }
  return out;
}

/**
 * Word-level diff of `oldText` → `newText`. Identical inputs yield a single `equal`
 * segment (or none when both are empty). Uses an LCS table over tokens, then walks it
 * to emit delete (old-only), insert (new-only), and equal runs in reading order.
 */
export function reverifyDiff(oldText: string, newText: string): ReverifyDiffSegment[] {
  if (oldText === newText) {
    return oldText.length === 0 ? [] : [{ type: "equal", text: oldText }];
  }
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;
  // Within-bounds reads are never actually undefined; `?? ""`/`?? 0` only satisfy
  // `noUncheckedIndexedAccess` without scattering non-null assertions.
  const tok = (arr: string[], k: number): string => arr[k] ?? "";

  // LCS length table: lcs[i][j] = LCS length of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number): number => lcs[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] ?? [];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const pieces: ReverifyDiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pieces.push({ type: "equal", text: tok(a, i) });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      pieces.push({ type: "delete", text: tok(a, i) });
      i++;
    } else {
      pieces.push({ type: "insert", text: tok(b, j) });
      j++;
    }
  }
  while (i < n) {
    pieces.push({ type: "delete", text: tok(a, i) });
    i++;
  }
  while (j < m) {
    pieces.push({ type: "insert", text: tok(b, j) });
    j++;
  }
  return coalesce(pieces);
}

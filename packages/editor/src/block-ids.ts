/**
 * Renderer-safe stable block-ID minting (T016).
 *
 * Every block-level node in a document carries a STABLE id that survives editing,
 * saving, and re-importing the same source — it is the single most load-bearing
 * guarantee in the document layer, because extracts, read-points, source-
 * locations, and the eventual sync all anchor to it.
 *
 * ## ID strategy: ULID, minted in the editor (decision, documented here)
 *
 * Block ids are **ULID** strings (Crockford-base32, 26 chars): lexicographically
 * sortable, time-ordered, and collision-resistant. We mint them in the EDITOR at
 * block-creation time rather than in `packages/local-db` because the editor runs
 * in the **sandboxed renderer**, which has NO Node access — `node:crypto` /
 * `local-db`'s `newRowId` are unavailable there. This minter therefore uses only
 * `globalThis.crypto.getRandomValues`, which exists in both the renderer (Chromium)
 * and the Electron main process / Node 19+, so the exact same minter is safe to
 * import anywhere.
 *
 * ## `document_blocks.id` (PK) vs `stableBlockId` (anchor) — distinct on purpose
 *
 * `packages/local-db`'s `newRowId` mints a UUID v4 for `document_blocks.id`, the
 * surrogate primary key of the block row. That is an internal row identity and is
 * free to change. The **stable block id** (`stableBlockId`) is a different value:
 * it is the ULID carried in the ProseMirror `blockId` attribute, persisted to
 * `document_blocks.stable_block_id`, and is what all lineage references. The two
 * are intentionally separate — a block row's PK and its lineage anchor have
 * different lifetimes and different generators.
 */

import type { BlockId } from "@interleave/core";

/** Crockford base32 alphabet (ULID spec) — excludes I, L, O, U. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Encode a millisecond timestamp into the 10-char ULID time component. */
function encodeTime(now: number): string {
  let out = "";
  let value = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = value % ENCODING_LEN;
    out = ENCODING[mod] + out;
    value = (value - mod) / ENCODING_LEN;
  }
  return out;
}

/**
 * Encode the 16-char ULID random component using a CSPRNG.
 *
 * Uses `globalThis.crypto.getRandomValues` (Web Crypto), which is available in
 * the sandboxed renderer AND in the Electron main process — never `node:crypto`,
 * so this module imports cleanly in either world.
 */
function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    // Map each byte into the 32-char alphabet (mod 32 ⇒ uniform over 0..31).
    out += ENCODING[byte % ENCODING_LEN];
  }
  return out;
}

/**
 * Mint a fresh stable block id (a 26-char ULID), branded as {@link BlockId}.
 *
 * Time-ordered + sortable so a document's blocks compare in creation order, and
 * collision-resistant enough that two blocks (even created in the same ms) get
 * distinct ids. The schema's unique `(documentId, stableBlockId)` index is the
 * backstop against the astronomically unlikely collision.
 */
export function newBlockId(): BlockId {
  return (encodeTime(Date.now()) + encodeRandom()) as BlockId;
}

/** The shape of an injectable minter (used by tests for determinism). */
export type BlockIdMinter = () => BlockId;

/**
 * Shared `app.asar` → `app.asar.unpacked` path rewrite.
 *
 * A native `dlopen`/`open` (a native addon, a loadable SQLite extension, or
 * onnxruntime's native model open) CANNOT read from inside an `app.asar`
 * archive — the archive is a single file, so a path that traverses it is not a
 * real directory on disk. Electron transparently redirects JS `fs` reads from
 * `app.asar` to the `app.asar.unpacked` sibling, but native opens bypass that
 * redirect. So any asset a native consumer opens is `asarUnpack`ed by
 * electron-builder to `app.asar.unpacked/…`, and every resolver that hands such
 * a path to native code must rewrite the in-asar path to its unpacked sibling.
 *
 * CONSTRAINT: this module is imported by the DB-free worker bundle, so it must
 * import only Node built-ins (`node:path`) — never `electron`, `@interleave/db`,
 * `better-sqlite3`, or anything beyond Node built-ins.
 */

import path from "node:path";

/** If `p` points inside an `app.asar`, return the `app.asar.unpacked` sibling path. */
export function asarUnpackedVariant(p: string): string | null {
  const marker = `${path.sep}app.asar${path.sep}`;
  if (!p.includes(marker)) return null;
  return p.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`);
}

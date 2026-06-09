/**
 * Single source of truth for the restore path-safety / zip-slip guard.
 *
 * Restore-from-file extracts an UNTRUSTED `.zip` the user picked on disk, and
 * restore-from-directory verifies every manifest-listed entry. Both paths must
 * reject any relative path that could escape its containment root BEFORE a
 * single byte is read or written. This helper is the one place that logic
 * lives, so the archive extractor (`backup-archive.ts`) and the restore service
 * (`backup-restore-service.ts`) cannot drift apart on a security-sensitive
 * check.
 *
 * Framework-free on purpose (only `node:path`) so it is trivially unit-testable
 * and reusable from any main-side helper.
 */

import path from "node:path";

/**
 * Validate `rel` against zip-slip / path-traversal and resolve it to an absolute
 * path GUARANTEED to stay inside `root`. Rejects absolute paths, backslashes,
 * the empty string, and any `/`-split segment that is empty / `.` / `..`, then
 * re-checks containment against the resolved path with a `path.sep` boundary so
 * a sibling like `<root>-evil` cannot masquerade as `<root>`. Throws
 * `new Error(`${errorLabel} ${rel}`)` on any violation; otherwise returns the
 * safe absolute path.
 */
export function safeContainedJoin(root: string, rel: string, errorLabel: string): string {
  if (path.isAbsolute(rel) || rel.includes("\\") || rel.length === 0) {
    throw new Error(`${errorLabel} ${rel}`);
  }
  const parts = rel.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`${errorLabel} ${rel}`);
  }
  const abs = path.join(root, ...parts);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error(`${errorLabel} ${rel}`);
  }
  return abs;
}

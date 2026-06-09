/**
 * Tests for the shared restore path-safety / zip-slip guard.
 *
 * Both restore paths (archive extraction and directory verification) funnel
 * untrusted relative paths through {@link safeContainedJoin}, so it must reject
 * every traversal shape (absolute, `..`, backslash, empty, empty/dot segment)
 * and only resolve genuinely contained paths to an absolute path under the root.
 * The `errorLabel` is carried verbatim so each caller keeps its own message.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeContainedJoin } from "./safe-archive-path";

const ROOT = path.join(path.sep, "tmp", "interleave-root");
const LABEL = "test guard: unsafe entry";

describe("safeContainedJoin", () => {
  it("resolves a valid contained path to an absolute path under the root", () => {
    expect(safeContainedJoin(ROOT, "assets/sources/a.txt", LABEL)).toBe(
      path.join(ROOT, "assets", "sources", "a.txt"),
    );
  });

  it("resolves a single root-relative nested file to its absolute path", () => {
    expect(safeContainedJoin(ROOT, "app.sqlite", LABEL)).toBe(path.join(ROOT, "app.sqlite"));
  });

  it("rejects an absolute path", () => {
    expect(() => safeContainedJoin(ROOT, "/etc/evil", LABEL)).toThrow(`${LABEL} /etc/evil`);
  });

  it("rejects a `..` traversal segment", () => {
    expect(() => safeContainedJoin(ROOT, "a/../../escape", LABEL)).toThrow(LABEL);
    expect(() => safeContainedJoin(ROOT, "../escape.txt", LABEL)).toThrow(LABEL);
  });

  it("rejects a backslash", () => {
    expect(() => safeContainedJoin(ROOT, "a\\b", LABEL)).toThrow(LABEL);
  });

  it("rejects an empty rel", () => {
    expect(() => safeContainedJoin(ROOT, "", LABEL)).toThrow(LABEL);
  });

  it("rejects an empty segment and a `.` segment", () => {
    expect(() => safeContainedJoin(ROOT, "a//b", LABEL)).toThrow(LABEL);
    expect(() => safeContainedJoin(ROOT, "a/./b", LABEL)).toThrow(LABEL);
  });

  it("carries the supplied errorLabel prefix into the thrown message", () => {
    expect(() => safeContainedJoin(ROOT, "../escape.txt", "backup restore: unsafe path")).toThrow(
      "backup restore: unsafe path ../escape.txt",
    );
  });
});

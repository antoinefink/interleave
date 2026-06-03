import { describe, expect, it } from "vitest";
import {
  ANKI_FIELD_SEPARATOR,
  detectHighlightFormat,
  extractHtmlTitle,
  htmlFileToProseMirrorDoc,
  htmlToProseMirrorDoc,
  IMPORTERS_PACKAGE,
  MEDIA_PROBE_BYTES,
  markdownToProseMirrorDoc,
  NO_TRANSCRIPT_PLACEHOLDER,
  parseTranscript,
  pdfPagesToProseMirrorDoc,
  sanitizeArticleHtml,
  transcriptToProseMirrorDoc,
} from "./index";

describe("importers barrel", () => {
  it("exports the package marker and representative pure import helpers", () => {
    expect(IMPORTERS_PACKAGE).toBe("@interleave/importers");
    expect(ANKI_FIELD_SEPARATOR).toBe("\x1f");
    expect(MEDIA_PROBE_BYTES).toBeGreaterThan(0);
    expect(NO_TRANSCRIPT_PLACEHOLDER).toContain("No transcript");
    expect(typeof extractHtmlTitle).toBe("function");
    expect(typeof htmlFileToProseMirrorDoc).toBe("function");
    expect(typeof htmlToProseMirrorDoc).toBe("function");
    expect(typeof markdownToProseMirrorDoc).toBe("function");
    expect(typeof pdfPagesToProseMirrorDoc).toBe("function");
    expect(typeof parseTranscript).toBe("function");
    expect(typeof sanitizeArticleHtml).toBe("function");
    expect(typeof transcriptToProseMirrorDoc).toBe("function");
    expect(detectHighlightFormat("notes.md", "plain notes")).toBeNull();
  });
});

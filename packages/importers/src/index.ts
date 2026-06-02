/**
 * @interleave/importers — pure, framework-agnostic web-import transforms (T060).
 *
 * Owns the import pipeline's pure stages: raw page HTML → readable article
 * (Mozilla Readability over a linkedom DOM) → sanitized article HTML
 * (sanitize-html allowlist) → constrained ProseMirror document (with stable block
 * ids, matching `@interleave/editor`'s schema). It depends on `@interleave/core`
 * (the ProseMirror conversion types) and the React-free schema/block-id modules of
 * `@interleave/editor` — but NOT on Electron, `fs`, or the network. The
 * orchestrating `UrlImportService` (Electron main) does the fetch + vault write +
 * DB transaction; this package never touches I/O so it bundles cleanly into
 * `main.cjs` and is unit-testable against fixtures.
 */

export const IMPORTERS_PACKAGE = "@interleave/importers" as const;

export {
  type ChapterConversion,
  chapterToProseMirror,
  EpubParseError,
  type EpubParseErrorCode,
  type ParsedEpub,
  type ParsedEpubChapter,
  type ParsedEpubMetadata,
  type ParsedFootnote,
  parseEpub,
} from "./epub";
export {
  detectHighlightFormat,
  type HighlightFormat,
  HighlightParseError,
  type ImportedHighlight,
  parseHighlights,
  parseKindleClippings,
  parseReadwiseCsv,
  parseReadwiseJson,
} from "./highlights";
export { extractHtmlTitle, htmlFileToProseMirrorDoc } from "./html-file";
export { htmlToProseMirrorDoc } from "./html-to-prosemirror";
export { markdownToProseMirrorDoc, proseMirrorDocToMarkdown } from "./markdown";
export {
  aggregateOcrWords,
  type OcrResult,
  type OcrWord,
  type RawOcrWord,
} from "./ocr";
export {
  extractPdfPages,
  extractPdfTitle,
  type PdfPage,
  type PdfTextLine,
} from "./pdf-text";
export { pdfPagesToProseMirrorDoc } from "./pdf-to-prosemirror";
export {
  type ExtractArticleOptions,
  type ExtractedArticle,
  extractArticle,
} from "./readability";
export {
  SANITIZE_ALLOWED_TAGS,
  sanitizeArticleHtml,
} from "./sanitize";

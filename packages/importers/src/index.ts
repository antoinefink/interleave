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
  ANKI_FIELD_SEPARATOR,
  type AnkiCardsRow,
  type AnkiCollectionRows,
  type AnkiExportRows,
  type AnkiModel,
  type AnkiNoteRecord,
  type AnkiNotesRow,
  AnkiParseError,
  type AnkiParseErrorCode,
  type AnkiReviewLogEntry,
  type AnkiRevlogRow,
  type AnkiScheduling,
  ankiChecksumFromSha1Hex,
  ankiRowsToNotes,
  type BuiltAnkiCard,
  type BuiltAnkiNote,
  buildAnkiDconf,
  buildAnkiDecks,
  buildAnkiModels,
  buildApkgZip,
  EXPORT_BASIC_FIELDS,
  EXPORT_BASIC_MODEL_ID,
  EXPORT_CLOZE_FIELDS,
  EXPORT_CLOZE_MODEL_ID,
  EXPORT_DECK_ID,
  type ExportNote,
  guidFromId,
  notesToAnkiRows,
  type ParsedApkg,
  parseAnkiTags,
  parseApkgZip,
  sourceRefSlug,
  stripAnkiFieldHtml,
} from "./anki";
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
export { MEDIA_PROBE_BYTES, probeMediaDurationMs } from "./media-metadata";
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
export {
  parseTranscript,
  type TranscriptCue,
  type TranscriptFormat,
} from "./transcript";
export {
  NO_TRANSCRIPT_PLACEHOLDER,
  type TranscriptToProseMirrorInput,
  transcriptToProseMirrorDoc,
} from "./transcript-to-prosemirror";
export {
  discoverCaptionTrackUrl,
  type FetchLike,
  fetchYouTubeMetadata,
  isYouTubeUrl,
  parseYouTubeId,
  YouTubeImportError,
  type YouTubeImportErrorCode,
  type YouTubeMeta,
  youTubeWatchUrl,
} from "./youtube";

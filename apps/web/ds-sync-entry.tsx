// design-sync curated entry (gitignored build input — NOT app code).
// Re-exports only the presentational, isolation-safe Interleave components that
// the claude.ai/design bundle should expose on window.Interleave.*. esbuild
// bundles this; the component LIST shown as cards comes from cfg.componentSrcMap.

// Badges, priority & stages (inspector primitives)
// biome-ignore assist/source/organizeImports: exports are grouped by concern (badges, controls, icons, lineage, banners) on purpose — sorting would scramble the curated card order.
export {
  Prio,
  Status,
  Stage,
  TypeIcon,
  Tag,
  ConceptTag,
  SchedulerChip,
  FsrsStats,
  MetaRow,
} from "./src/components/inspector/primitives";

// Controls
export { Btn, Segmented, Pipeline } from "./src/help/primitives";
export { Kbd } from "./src/shell/Kbd";
export { SuggestionChip } from "./src/pages/inbox/SuggestionChip";
export { LibrarySearchField } from "./src/library/LibrarySearchField";

// Icons
export { Icon } from "./src/components/Icon";

// Source lineage & references
export { RefBlock } from "./src/components/RefBlock";
export { ExternalUrlLink } from "./src/components/ExternalUrlLink";
export { LineageTree } from "./src/components/inspector/LineageTree";

// NOTE: the review-card faces (CardBody/CardFront) pull @interleave/editor →
// KaTeX, whose CSS references .ttf fonts the converter's bundler can't load.
// Deferred (see .design-sync/NOTES.md). ExpiryBanner represents the review surface.

// Banners & states
export { ExpiryBanner } from "./src/review/ExpiryBanner";
export { AutoPostponeReceiptLine } from "./src/components/AutoPostponeReceiptLine";
export { ExtractAgingReceiptLine } from "./src/components/ExtractAgingReceiptLine";

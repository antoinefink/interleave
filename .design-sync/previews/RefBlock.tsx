import { RefBlock } from "@interleave/web";

// A resolved web-paper source reference: title, author, year, location, the
// verbatim snippet, plus T091 reliability metadata.
const paper = {
  sourceElementId: "src_chollet",
  sourceTitle: "On the Measure of Intelligence",
  url: "https://arxiv.org/abs/1911.01547",
  author: "François Chollet",
  publishedAt: "2019-11-05",
  locationLabel: "§II.1 · ¶ 4",
  snippet:
    "We argue that the measure of intelligence should be based on skill-acquisition efficiency, highlighting priors, experience, and generalization difficulty.",
  sourceType: "paper",
  reliabilityTier: "primary",
  confidence: "high",
  reliabilityNotes: null,
};

/** A fully-resolved reference: serif quote, citation line, location, primary-source badge, link. */
export const WithSource = () => <RefBlock ref={paper} onOpenSource={() => {}} />;

/** A low-confidence source — the badge tints to the warn cue and shows the caveat note. */
export const WithUncertainty = () => (
  <RefBlock
    ref={{
      ...paper,
      sourceTitle: "Why scaling is all you need",
      url: "https://example.com/scaling-post",
      author: "Anonymous",
      publishedAt: "2023",
      locationLabel: null,
      sourceType: "blog",
      reliabilityTier: "tertiary",
      confidence: "low",
      reliabilityNotes: "Single-author opinion piece; no citations.",
    }}
  />
);

/** The orphan case — a source-less ref degrades to a calm placeholder, never a broken link. */
export const Orphaned = () => <RefBlock ref={null} />;

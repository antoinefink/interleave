import { Tag } from "@interleave/web";

/** A handful of realistic domain tags rendered as flat pills. */
export const DomainTags = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <Tag name="spaced-repetition" />
    <Tag name="memory" />
    <Tag name="fsrs" />
    <Tag name="active-recall" />
    <Tag name="cognitive-load" />
  </div>
);

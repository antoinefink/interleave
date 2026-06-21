import { SuggestionChip } from "@interleave/web";

/** All four priority bands as static display chips. */
export const AllBands = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 12, flexWrap: "wrap" }}>
    <SuggestionChip band="A" />
    <SuggestionChip band="B" />
    <SuggestionChip band="C" />
    <SuggestionChip band="D" />
  </div>
);

/** An accept button — clicking it accepts the triage suggestion. */
export const Acceptable = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 12 }}>
    <SuggestionChip band="B" onAccept={() => {}} />
    <SuggestionChip band="A" onAccept={() => {}} />
  </div>
);

/** Compact variant for dense inbox list rows. */
export const Compact = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 12 }}>
    <SuggestionChip band="A" compact />
    <SuggestionChip band="C" compact />
    <SuggestionChip band="D" compact onAccept={() => {}} />
  </div>
);

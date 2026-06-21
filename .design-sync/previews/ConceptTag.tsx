import { ConceptTag } from "@interleave/web";

/** Static concept pills — rendered as plain spans, no interaction. */
export const Static = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <ConceptTag name="Interleaving" />
    <ConceptTag name="Desirable difficulty" />
    <ConceptTag name="Retrieval practice" />
  </div>
);

/** Clickable concept pills — rendered as buttons, cursor pointer, navigation intent. */
export const Clickable = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <ConceptTag name="Interleaving" onClick={() => {}} />
    <ConceptTag name="Desirable difficulty" onClick={() => {}} />
    <ConceptTag name="Retrieval practice" onClick={() => {}} />
  </div>
);

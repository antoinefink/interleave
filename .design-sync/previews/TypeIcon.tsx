import { TypeIcon } from "@interleave/web";

/** All 8 element types at default size (14px), each with its colored tone chip. */
export const AllTypes = () => (
  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <TypeIcon type="source" />
    <TypeIcon type="topic" />
    <TypeIcon type="extract" />
    <TypeIcon type="card" />
    <TypeIcon type="task" />
    <TypeIcon type="concept" />
    <TypeIcon type="media_fragment" />
    <TypeIcon type="synthesis_note" />
  </div>
);

/** All 8 types at large size (17px, lg prop) — the inspector heading variant. */
export const AllTypesLg = () => (
  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
    <TypeIcon type="source" lg />
    <TypeIcon type="topic" lg />
    <TypeIcon type="extract" lg />
    <TypeIcon type="card" lg />
    <TypeIcon type="task" lg />
    <TypeIcon type="concept" lg />
    <TypeIcon type="media_fragment" lg />
    <TypeIcon type="synthesis_note" lg />
  </div>
);

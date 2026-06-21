import { Stage } from "@interleave/web";

/** All nine distillation stages swept in a column — each dot gets its own token color. */
export const AllStages = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
    <Stage stage="raw_source" />
    <Stage stage="rough_topic" />
    <Stage stage="raw_extract" />
    <Stage stage="clean_extract" />
    <Stage stage="atomic_statement" />
    <Stage stage="card_draft" />
    <Stage stage="active_card" />
    <Stage stage="mature_card" />
    <Stage stage="synthesis" />
  </div>
);

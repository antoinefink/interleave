import { MetaRow, Prio, Status, Tag } from "@interleave/web";

/** A stack of inspector MetaRows composing other primitives as values. */
export const InspectorStack = () => (
  <div style={{ width: 280 }}>
    <MetaRow k="Status">
      <Status status="active" />
    </MetaRow>
    <MetaRow k="Priority">
      <Prio priority={0.9} />
    </MetaRow>
    <MetaRow k="Tags">
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Tag name="memory" />
        <Tag name="fsrs" />
        <Tag name="spaced-repetition" />
      </div>
    </MetaRow>
    <MetaRow k="Reps">9</MetaRow>
    <MetaRow k="Lapses">1</MetaRow>
  </div>
);

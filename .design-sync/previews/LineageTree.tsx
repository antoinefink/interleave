import { LineageTree } from "@interleave/web";

const chain = [
  {
    id: "s",
    type: "source",
    title: "On the Measure of Intelligence",
    stage: "raw_source",
    depth: 0,
    meta: "source",
    active: false,
    deleted: false,
  },
  {
    id: "e",
    type: "extract",
    title: "Skill-acquisition efficiency over task skill",
    stage: "clean_extract",
    depth: 1,
    meta: "extract",
    active: false,
    deleted: false,
  },
  {
    id: "a",
    type: "extract",
    title: "ARC measures broad generalization",
    stage: "atomic_statement",
    depth: 2,
    meta: "sub-extract",
    active: false,
    deleted: false,
  },
  {
    id: "c",
    type: "card",
    title: "What does ARC-AGI measure?",
    stage: "mature_card",
    depth: 3,
    meta: "card",
    active: true,
    deleted: false,
  },
] as const;

/** Active card in a four-level source→extract→sub-extract→card chain; the leaf node is highlighted. */
export const FullChain = () => (
  <div style={{ width: 300 }}>
    <LineageTree nodes={chain} onPick={() => {}} />
  </div>
);

/** Chain that includes a soft-deleted tombstone ancestor; shows the muted/struck restore treatment. */
export const WithTombstone = () => (
  <div style={{ width: 300 }}>
    <LineageTree
      nodes={[
        {
          id: "s2",
          type: "source",
          title: "FSRS: Free Spaced Repetition Scheduler",
          stage: "raw_source",
          depth: 0,
          meta: "source",
          active: false,
          deleted: true,
        },
        {
          id: "e2",
          type: "extract",
          title: "Optimal retrievability at 0.9 for long-term retention",
          stage: "clean_extract",
          depth: 1,
          meta: "extract",
          active: false,
          deleted: false,
        },
        {
          id: "c2",
          type: "card",
          title: "What retrievability target does FSRS optimise for?",
          stage: "active_card",
          depth: 2,
          meta: "card",
          active: true,
          deleted: false,
        },
      ]}
      onPick={() => {}}
      onRestore={() => {}}
    />
  </div>
);

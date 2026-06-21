import { SchedulerChip } from "@interleave/web";

const fsrsSignals = {
  kind: "fsrs" as const,
  retrievability: 0.82,
  stability: 34.5,
  difficulty: 6.2,
  reps: 9,
  lapses: 1,
  fsrsState: "review",
  stage: "mature_card",
  postponed: 0,
  lastProcessedAt: "2026-06-10",
  scheduleReason: null,
};

const attentionSignals = {
  kind: "attention" as const,
  retrievability: null,
  stability: null,
  difficulty: null,
  reps: null,
  lapses: null,
  fsrsState: null,
  stage: "clean_extract",
  postponed: 2,
  lastProcessedAt: "2026-06-18",
  scheduleReason: null,
};

/** FSRS card chip — brain icon, recall %, stability days. */
export const FsrsCard = () => <SchedulerChip scheduler={fsrsSignals} />;

/** Attention scheduler chip — gauge icon, stage label, postponed count. */
export const AttentionItem = () => <SchedulerChip scheduler={attentionSignals} />;

/** Both chips side-by-side, showing the FSRS-vs-attention split at a glance. */
export const BothSideBySide = () => (
  <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
    <SchedulerChip scheduler={fsrsSignals} />
    <SchedulerChip scheduler={attentionSignals} />
  </div>
);

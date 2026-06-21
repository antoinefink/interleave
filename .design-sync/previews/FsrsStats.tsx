import { FsrsStats } from "@interleave/web";

const strongCard = {
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

const weakCard = {
  kind: "fsrs" as const,
  retrievability: 0.41,
  stability: 3.2,
  difficulty: 8.7,
  reps: 4,
  lapses: 3,
  fsrsState: "review",
  stage: "active_card",
  postponed: 0,
  lastProcessedAt: "2026-06-19",
  scheduleReason: null,
};

/** A well-established card — high retrievability (82%), medium-high difficulty, stable. */
export const StrongCard = () => (
  <div style={{ width: 280 }}>
    <FsrsStats scheduler={strongCard} />
  </div>
);

/** A struggling card — low retrievability (41%), high difficulty, short stability. */
export const WeakCard = () => (
  <div style={{ width: 280 }}>
    <FsrsStats scheduler={weakCard} />
  </div>
);

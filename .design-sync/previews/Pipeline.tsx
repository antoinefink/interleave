import { Pipeline } from "@interleave/web";

/** Mid-progress: source and extract are done, clean is active. */
export const MidProgress = () => (
  <div style={{ width: 480, padding: 20 }}>
    <Pipeline active="extract" />
  </div>
);

/** Late stage: source through atomic are done, card is active. */
export const LateStage = () => (
  <div style={{ width: 480, padding: 20 }}>
    <Pipeline active="card" />
  </div>
);

/** Neutral diagram — all steps uniform, used in help-center pipeline figure. */
export const Neutral = () => (
  <div style={{ width: 480, padding: 20 }}>
    <Pipeline active={null} />
  </div>
);

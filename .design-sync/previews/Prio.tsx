import { Prio } from "@interleave/web";

/** The four priority bands, highest → lowest (A ≥ 0.75, B ≥ 0.5, C ≥ 0.25, else D). */
export const Bands = () => (
  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
    <Prio priority={0.92} />
    <Prio priority={0.62} />
    <Prio priority={0.38} />
    <Prio priority={0.1} />
  </div>
);

/** A single high-priority badge as it appears inline next to an item title. */
export const Inline = () => (
  <div
    style={{
      display: "flex",
      gap: 8,
      alignItems: "center",
      font: "var(--t-base)/1.4 var(--font-ui)",
      color: "var(--text)",
    }}
  >
    <Prio priority={0.92} />
    <span>Spaced repetition and the forgetting curve</span>
  </div>
);

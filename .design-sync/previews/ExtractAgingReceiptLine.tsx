import { ExtractAgingReceiptLine } from "@interleave/web";

const appliedReceipt = {
  batchId: "b1",
  localDay: "Jun 21",
  status: "applied",
  policy: "suggest",
  demoted: 4,
  remainingCandidateCount: 9,
  thresholds: { returnThreshold: 3, ageDays: 30 },
} as const;

/** Applied extract-aging receipt — shows demoted count, policy, thresholds, and the Undo button. */
export const Applied = () => (
  <div style={{ width: 520 }}>
    <ExtractAgingReceiptLine
      receipt={appliedReceipt}
      onUndo={async () => ({ undo: { undone: true } })}
    />
  </div>
);

/** Already-undone extract-aging receipt — Undo button replaced by the "Undone" label. */
export const Undone = () => (
  <div style={{ width: 520 }}>
    <ExtractAgingReceiptLine
      receipt={{ ...appliedReceipt, status: "undone" }}
      onUndo={async () => ({ undo: { undone: true } })}
    />
  </div>
);

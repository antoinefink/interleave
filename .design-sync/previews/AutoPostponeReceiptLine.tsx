import { AutoPostponeReceiptLine } from "@interleave/web";

const appliedReceipt = {
  batchId: "b1",
  localDay: "Jun 21",
  status: "applied",
  postponed: 7,
  postponedMinutes: 35,
  remainingMinutesAfter: 12,
  priorityBands: ["C", "D"],
} as const;

/** Applied auto-postpone receipt — shows item count, minutes, bands, and the Undo button. */
export const Applied = () => (
  <div style={{ width: 520 }}>
    <AutoPostponeReceiptLine
      receipt={appliedReceipt}
      onUndo={async () => ({ undone: true })}
    />
  </div>
);

/** Already-undone receipt — the Undo button is replaced by the "Undone" label. */
export const Undone = () => (
  <div style={{ width: 520 }}>
    <AutoPostponeReceiptLine
      receipt={{ ...appliedReceipt, status: "undone" }}
      onUndo={async () => ({ undone: true })}
    />
  </div>
);

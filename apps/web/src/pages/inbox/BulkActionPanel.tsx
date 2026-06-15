/**
 * Inbox bulk action panel (T126 — U5).
 *
 * In multi-select mode (`selectedSet.size >= 2`) this panel REPLACES the per-item
 * preview pane as the right pane (no floating bottom bar — the bulk panel IS the
 * right pane, per the U5 pinned decisions). It shows a count headline
 * ("12 selected"), a secondary group breakdown ("URL · Manual · Other"), the four
 * triage verbs, and the A/B/C/D priority chips reusing the preview pane's chip
 * styling.
 *
 * Each verb fires ONE bulk sweep over the whole selection. A priority chip can ride
 * along with a verb (combined: pass `priority` alongside the verb in one call) or be
 * applied alone (action `setPriority`). Read now (accept) at bulk scale does NOT
 * navigate (KTD-4) — it activates with a return date for every selected item.
 *
 * Pure presentation: it owns no IPC and no domain logic. The parent fires the bulk
 * command and surfaces `{ applied, skipped, errored }` honestly.
 */

import { Icon, type IconName } from "../../components/Icon";
import {
  type InboxBulkTriageAction,
  PRIORITY_LABELS,
  type PriorityLabelInput,
} from "../../lib/appApi";

type BulkVerb = Exclude<InboxBulkTriageAction, "setPriority">;

const VERBS: readonly {
  kind: BulkVerb;
  icon: IconName;
  label: string;
  testid: string;
  danger?: boolean;
  primary?: boolean;
}[] = [
  { kind: "accept", icon: "play", label: "Read now", testid: "inbox-bulk-read-now", primary: true },
  { kind: "queueSoon", icon: "queue", label: "Queue soon", testid: "inbox-bulk-queue-soon" },
  { kind: "keepForLater", icon: "bookmark", label: "Save for later", testid: "inbox-bulk-keep" },
  { kind: "delete", icon: "trash", label: "Delete", testid: "inbox-bulk-delete", danger: true },
];

function VerbButton({
  icon,
  label,
  testid,
  danger,
  primary,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  testid: string;
  danger?: boolean | undefined;
  primary?: boolean | undefined;
  disabled?: boolean | undefined;
  onClick: () => void;
}) {
  const tone = danger
    ? "border-danger-soft bg-danger-soft text-danger hover:opacity-90"
    : primary
      ? "border-transparent bg-accent text-text-on-accent hover:opacity-90"
      : "border-border bg-surface text-text-2 hover:text-text";
  return (
    <button
      type="button"
      data-testid={testid}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 font-medium text-sm disabled:cursor-not-allowed disabled:opacity-55 ${tone}`}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
    </button>
  );
}

/**
 * The bulk panel. `selectedCount` is the size of the selection (always `>= 2`
 * when this renders); `breakdown` is the ordered group-label list for the secondary
 * line; `pendingPriority` is the priority band the user has armed (rides with the
 * next verb, or applies alone).
 */
export function BulkActionPanel({
  selectedCount,
  breakdown,
  busy,
  pendingPriority,
  onVerb,
  onArmPriority,
  onSetPriority,
  onApplySuggestions,
}: {
  selectedCount: number;
  breakdown: readonly string[];
  busy: boolean;
  pendingPriority: PriorityLabelInput | null;
  /** Fire ONE bulk sweep with this verb (carrying the armed priority, if any). */
  onVerb: (kind: BulkVerb) => void;
  /** Arm/disarm a priority band — a pure UI toggle; it fires NO batch on its own. */
  onArmPriority: (label: PriorityLabelInput) => void;
  /** Commit the armed band as a priority-only sweep (keeps the selection + band). */
  onSetPriority: () => void;
  /**
   * Bulk-accept each selected item's OWN suggested band as one batch (T127). Ids with
   * no suggestion are skipped; the parent surfaces the honest applied/skipped tally.
   */
  onApplySuggestions: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="inbox-bulk-panel">
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-7 py-6">
        <div>
          <h2
            className="font-semibold text-text text-xl tracking-tight"
            data-testid="inbox-bulk-headline"
          >
            {selectedCount} selected
          </h2>
          {breakdown.length > 0 ? (
            <p className="mt-1 text-sm text-text-3" data-testid="inbox-bulk-breakdown">
              {breakdown.join(" · ")}
            </p>
          ) : null}
        </div>

        <section data-testid="inbox-bulk-priority">
          <div className="mb-2 font-medium text-text-2 text-xs uppercase tracking-wide">
            Priority
          </div>
          <div className="flex gap-1.5">
            {PRIORITY_LABELS.map((p) => {
              const armed = pendingPriority === p;
              return (
                <button
                  key={p}
                  type="button"
                  data-testid={`inbox-bulk-priority-${p}`}
                  aria-pressed={armed}
                  disabled={busy}
                  onClick={() => onArmPriority(p)}
                  className={
                    armed
                      ? "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-accent-soft-bd bg-accent-soft px-2 py-1 font-medium text-accent-text text-sm disabled:cursor-not-allowed disabled:opacity-55"
                      : "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 font-medium text-sm text-text-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-55"
                  }
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ background: `var(--prio-${p.toLowerCase()})` }}
                  />
                  {p}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            data-testid="inbox-bulk-set-priority"
            disabled={busy || !pendingPriority}
            onClick={onSetPriority}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 py-2 font-medium text-sm text-text-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-55"
          >
            Set priority{pendingPriority ? ` ${pendingPriority}` : ""}
          </button>
          <p className="mt-1.5 text-text-3 text-xs">
            {pendingPriority
              ? `Band ${pendingPriority} is armed — it rides with the next verb in one sweep, or apply it alone with “Set priority”.`
              : "Arm a band to combine it with a verb in one sweep, or set it on the selection alone."}
          </p>
          <button
            type="button"
            data-testid="inbox-bulk-apply-suggestions"
            disabled={busy}
            onClick={onApplySuggestions}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-accent-soft-bd border-dashed bg-accent-soft px-3 py-2 font-medium text-accent-text text-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-55"
          >
            <Icon name="sparkle" size={14} />
            Apply suggestions
          </button>
          <p className="mt-1.5 text-text-3 text-xs">
            Accepts each selected item’s own suggested band in one sweep. Items with no suggestion
            are skipped.
          </p>
        </section>

        <section data-testid="inbox-bulk-verbs">
          <div className="mb-2 font-medium text-text-2 text-xs uppercase tracking-wide">
            Apply to selection
          </div>
          <div className="space-y-2">
            {VERBS.map((verb) => (
              <VerbButton
                key={verb.kind}
                icon={verb.icon}
                label={verb.label}
                testid={verb.testid}
                danger={verb.danger}
                primary={verb.primary}
                disabled={busy}
                onClick={() => onVerb(verb.kind)}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * Inbox triage section (rendered inside the shell inspector, above Properties).
 *
 * This is the relocated inbox triage cluster — the four triage actions
 * (Read now / Queue soon / Save for later / Delete with their `1·2·3·6` hints),
 * the provenance-aware A/B/C/D priority picker, and the T127 suggestion
 * affordances (suggested band + suggested placement). It used to live in a
 * metadata rail in the inbox `PreviewPane`; moving it here frees the inbox
 * article preview to use the full width.
 *
 * Pure presentation: every control calls a handler from the `panel` payload
 * (published by `InboxScreen` through {@link useInboxTriagePanel}). No data
 * fetching, no priority math, no domain logic — the triage business logic stays
 * in `InboxScreen`. The inspector renders this only when an inbox source is
 * selected and the payload's `targetId` matches the inspected element.
 */

import type { Ref } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { HelpLink } from "../../help/Contextual";
import {
  PRIORITY_LABELS,
  type PriorityLabelInput,
  type TriageSuggestionSuggestionDto,
} from "../../lib/appApi";
import type { InboxTriagePanel } from "../../shell/inboxTriagePanel";
import { Kbd } from "../../shell/Kbd";
import { PRIORITY_HINT, priorityToLabel } from "./priority";
import { formatTriageJustification, SuggestionChip } from "./SuggestionChip";

/** A triage action button (block, with a keyboard hint). */
function TriageButton({
  icon,
  label,
  hint,
  danger,
  primary,
  disabled,
  ariaLabel,
  onClick,
  testid,
  buttonRef,
}: {
  icon: IconName;
  label: string;
  hint: string;
  danger?: boolean;
  primary?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  onClick: () => void;
  testid: string;
  buttonRef?: Ref<HTMLButtonElement>;
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
      ref={buttonRef}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 font-medium text-sm disabled:cursor-not-allowed disabled:opacity-55 ${tone}`}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
      <span className="flex-1" />
      <Kbd keys={hint} />
    </button>
  );
}

/**
 * The gated triage section. Rendered by `InspectorBody` above Properties only when
 * an inbox source with a matching payload is inspected; the caller passes the
 * non-null `panel` plus the stable node-registration callbacks (so the reveal
 * affordance in `InboxScreen` can scroll/focus this section across the component
 * boundary).
 */
export function InboxTriageSection({
  panel,
  registerSection,
  registerReadNowButton,
}: {
  panel: InboxTriagePanel;
  registerSection: (node: HTMLElement | null) => void;
  registerReadNowButton: (node: HTMLButtonElement | null) => void;
}) {
  const { busy, suggestion } = panel;
  const current = priorityToLabel(panel.priority);
  // A banded suggestion drives the accept affordance + justification + placement;
  // `insufficient_signal` / `"pending"` / `null` render none of it.
  const banded: TriageSuggestionSuggestionDto | null =
    typeof suggestion === "object" && suggestion?.kind === "suggestion" ? suggestion : null;
  const justification = banded ? formatTriageJustification(banded.justification) : "";
  const placement = banded?.placement ?? null;

  return (
    <div
      ref={registerSection}
      className={`insp-sec${panel.triageHighlighted ? " insp-triage--highlighted" : ""}`}
      data-testid="inbox-triage-actions"
      data-highlighted={panel.triageHighlighted ? "true" : undefined}
    >
      <div className="insp-sec__title">
        <span>Triage</span>
        <span className="font-normal text-text-3 normal-case tracking-normal">1 · 2 · 3 · 6</span>
      </div>

      {/* Triage actions */}
      <div className="space-y-2">
        <TriageButton
          testid="inbox-read-now"
          buttonRef={registerReadNowButton}
          icon="play"
          label="Read now"
          hint="1"
          ariaLabel="Read now: activate and open in reader"
          primary
          disabled={busy}
          onClick={panel.onReadNow}
        />
        <TriageButton
          testid="inbox-queue-soon"
          icon="queue"
          label="Queue soon"
          hint="2"
          ariaLabel="Queue soon: schedule in the due queue without opening"
          disabled={busy}
          onClick={() => panel.onTriage("queueSoon")}
        />
        <TriageButton
          testid="inbox-keep"
          icon="bookmark"
          label="Save for later"
          hint="3"
          disabled={busy}
          onClick={() => panel.onTriage("keepForLater")}
        />
        <TriageButton
          testid="inbox-delete"
          icon="trash"
          label="Delete"
          hint="6"
          danger
          disabled={busy}
          onClick={() => panel.onTriage("delete")}
        />
      </div>

      {/* Priority — the provenance-aware A/B/C/D picker (records T127 accepted/
          overridden), kept here rather than the inspector's generic Set-priority
          control so inbox priority writes preserve their suggestion provenance. */}
      <div data-testid="inbox-priority">
        <div className="mb-2 flex items-center gap-1.5 font-medium text-text-2 text-xs uppercase tracking-wide">
          Priority <HelpLink slug="priority-abcd" />
        </div>
        <div className="flex gap-1.5">
          {PRIORITY_LABELS.map((p: PriorityLabelInput) => {
            const active = current === p;
            return (
              <button
                key={p}
                type="button"
                data-testid={`inbox-priority-${p}`}
                aria-pressed={active}
                disabled={busy}
                onClick={() => panel.onPickPriority(p)}
                className={
                  active
                    ? "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-accent-soft-bd bg-accent-soft px-2 py-1 font-medium text-accent-text text-sm"
                    : "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 font-medium text-sm text-text-2 hover:text-text"
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
        <p className="mt-1.5 text-text-3 text-xs">{PRIORITY_HINT[current]}</p>

        {/* Suggested priority (T127): accept-as-is (Enter does the same), or override
            by picking a DIFFERENT chip above. Only a banded suggestion renders. */}
        {banded ? (
          <div className="mt-3 flex flex-col gap-1.5" data-testid="inbox-suggestion">
            <div className="flex items-center gap-2">
              <SuggestionChip band={banded.band} onAccept={panel.onAcceptSuggestion} busy={busy} />
              <span className="text-text-3 text-xs">Press Enter to accept</span>
            </div>
            {justification ? (
              <p className="text-text-3 text-xs" data-testid="inbox-suggestion-justification">
                {justification}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Suggested placement (T127): assign the concept the neighbors share, via the
          existing assignConcept command. Re-accept is a no-op (confirmed state). */}
      {placement ? (
        <div data-testid="inbox-suggestion-placement">
          <div className="mb-2 font-medium text-text-2 text-xs uppercase tracking-wide">
            Suggested placement
          </div>
          {panel.placementAssigned ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-ok-soft bg-ok-soft px-2 py-1 text-ok text-xs"
              data-testid="inbox-suggestion-placement-assigned"
            >
              <Icon name="check" size={13} />
              Assigned to {placement.conceptName}
            </span>
          ) : (
            <button
              type="button"
              data-testid="inbox-suggestion-placement-accept"
              disabled={busy}
              onClick={() => panel.onAcceptPlacement(placement.conceptId)}
              className="inline-flex items-center gap-1.5 rounded-md border border-accent-soft-bd border-dashed bg-accent-soft px-2 py-1 text-accent-text text-xs hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-55"
            >
              <Icon name="sparkle" size={13} />
              Place in {placement.conceptName}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

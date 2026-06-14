/**
 * Shared, pure queue-row presentation helpers (T029 / Home command center).
 *
 * The per-row TITLE prefix ("Extract · …", "Q&A · …"), the open-action affordance
 * (icon + label per type), and the due-state `DueBadge` are needed by BOTH the
 * actionable Daily Queue list (`QueueScreen`) and the read-only top-due preview on
 * the Home command center (`HomeScreen`). They are extracted here so the two
 * surfaces can never drift — the slim preview reuses the SAME title/badge logic as
 * the full list WITHOUT pulling in the actionable `QueueItem` (its row actions,
 * schedule menu, selection wiring) which is queue-only.
 *
 * UI only — pure functions over the typed `window.appApi` `QueueItemSummary`; no
 * SQL, no scheduling math, no data fetching.
 */

import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { Stage } from "../../components/inspector/primitives";
import type { ExtractAgeBand, QueueItemSummary } from "../../lib/appApi";

function elementTypeNoun(type: string | null): string {
  if (type === "source") return "source";
  if (type === "topic") return "topic";
  if (type === "extract") return "extract";
  if (type === "card") return "card";
  if (type === "synthesis_note") return "synthesis note";
  return "item";
}

/**
 * The per-row title with the kit's type prefix ("Extract · …", "Q&A · …").
 *
 * Only the types whose bare title would be ambiguous get a prefix: card
 * ("Q&A · …" / "Cloze · …"), extract ("Extract · …"), and topic ("Topic · …").
 * source / task / synthesis_note return their title bare — their content already
 * reads as a title, and the per-row meta line (`metaFor`) carries the type label,
 * so prefixing them too would be redundant.
 */
export function titleFor(item: QueueItemSummary): string {
  if (item.type === "card") {
    const prefix = item.cardType === "cloze" ? "Cloze · " : "Q&A · ";
    return prefix + item.title.replace(/\{\{(.+?)\}\}/, "[…]");
  }
  if (item.type === "extract") return `Extract · ${item.title}`;
  if (item.type === "topic") return `Topic · ${item.title}`;
  return item.title;
}

/**
 * The per-type meta sub-line for a queue row (the kit's `QueueItem` meta), or
 * `null` when the type carries no sub-line content. One branch per element type so
 * EVERY type — source (author), card (from sourceTitle), extract (Stage), topic
 * ("N sources · M cards" is later; the stage stands in for now), synthesis_note
 * ("N words" is later; the type label stands in), task ("<kind> task") — reads
 * with real content before the SchedulerChip, matching the kit. Returning `null`
 * lets the caller suppress the otherwise-orphan leading dot separator.
 *
 * Pure presentation, shared by the Daily Queue list + the Home top-due preview so
 * the two surfaces can never drift.
 */
export function metaFor(item: QueueItemSummary): ReactElement | null {
  if (item.type === "source") {
    return item.author ? (
      <span className="qitem__sub">
        <Icon name="globe" size={13} /> {item.author}
      </span>
    ) : null;
  }
  if (item.type === "card") {
    return item.sourceTitle ? (
      <span className="qitem__sub">
        from <i>{item.sourceTitle}</i>
      </span>
    ) : null;
  }
  if (item.type === "extract") return <Stage stage={item.stage} />;
  if (item.type === "topic") {
    return (
      <span className="qitem__sub">
        <Icon name="layers" size={13} /> Topic
      </span>
    );
  }
  if (item.type === "synthesis_note") {
    return (
      <span className="qitem__sub">
        <Icon name="synthesis" size={13} /> Synthesis note
      </span>
    );
  }
  if (item.type === "task") {
    const detail = item.linkedElementId
      ? `Protects ${elementTypeNoun(item.linkedElementType)}`
      : "Task";
    return (
      <span className="qitem__sub">
        <Icon name="task" size={13} /> {detail}
      </span>
    );
  }
  return null;
}

function ageBandLabel(band: ExtractAgeBand): string {
  if (band === "fresh") return "Fresh";
  if (band === "aging") return "Aging";
  if (band === "stale") return "Stale";
  return "Graveyard";
}

export function ExtractAgeChip({ item }: { item: QueueItemSummary }): ReactElement | null {
  const aging = item.extractAging;
  if (!aging) return null;
  return (
    <span
      className={`extract-age-chip extract-age-chip--${aging.band}`}
      data-testid="extract-age-chip"
      title={`${aging.daysSinceProgress} days since progress; postponed ${aging.postponeCount} times`}
    >
      <Icon name="clock" size={12} />
      {ageBandLabel(aging.band)}
      {aging.thresholdReached ? " · return" : ""}
    </span>
  );
}

/**
 * T123 → T124 — the content-staleness chip, now ACTIONABLE. A source block this item
 * derives from was edited, so its body may no longer match. The chip links to the T124
 * re-verify drain (`/maintenance/reverify`) where the flag resolves as confirm / rebase /
 * detach. Styled at the same `--warn` advisory severity as a stale extract-age chip, NOT
 * `--danger`.
 */
export function ReverifyChip({ item }: { item: QueueItemSummary }): ReactElement | null {
  if (!item.schedulerSignals.needsReverify) return null;
  return (
    <Link
      to="/maintenance/reverify"
      className="reverify-chip reverify-chip--action"
      data-testid="reverify-chip"
      title="Source content changed — click to re-verify"
    >
      <Icon name="warning" size={12} />
      Re-verify
    </Link>
  );
}

/** The open-action icon + label per type (the `next-action` affordance). */
export function actionFor(item: QueueItemSummary): { icon: IconName; label: string } {
  if (item.type === "card") return { icon: "brain", label: "Review" };
  if (item.type === "source") return { icon: "eye", label: "Continue reading from read point" };
  if (item.type === "extract") return { icon: "extract", label: "Process" };
  if (item.type === "task" && item.taskType === "weekly_review") {
    return { icon: "calendar", label: "Weekly review" };
  }
  // A verification task LINKED to a protected element opens that element's reader (T092),
  // so the affordance reads "Verify" — a free-standing (unlinked) task reads "Open".
  if (item.type === "task" && item.linkedElementId) return { icon: "eye", label: "Verify" };
  return { icon: "return", label: "Open" };
}

/** A due-state badge (overdue / today / soon) — distinct from the lifecycle `Status`. */
export function DueBadge({ item }: { item: QueueItemSummary }) {
  const cls =
    item.due === "overdue" ? "badge--overdue" : item.due === "today" ? "badge--due" : "badge--soft";
  return (
    <span className={`badge ${cls}`} data-testid="queue-due-badge">
      {item.dueLabel}
    </span>
  );
}

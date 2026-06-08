/**
 * BalanceBanner (T046) — the import/process balance warning.
 *
 * Rebuilt from the design kit's `Banner` (`design/kit/app/components.jsx` + the
 * `.banner` styles in `design/kit/styles/app.css`) for React 19 + Tailwind v4: a
 * left warning icon, a title + body, and trailing soft actions. It catches the
 * core failure mode of incremental reading — importing faster than you process —
 * and shows the four weekly headline numbers (sources imported / extracts created
 * / cards created / reviews due this week).
 *
 * Architecture (non-negotiable): UI ONLY. The numbers + the imbalance judgment are
 * computed in the DOMAIN layer (`packages/local-db` `AnalyticsService.computeBalance`
 * + the pure `@interleave/core` `judgeBalance` rule); this component just READS one
 * `balance.get()` payload through the typed `window.appApi` bridge and renders it.
 * It also respects the `balanceWarnings` on/off setting (read via `settings.getAll`).
 * Advisory only — it never postpones or deletes (auto-postpone is M16/T077).
 *
 * Shared by the inbox (`screen-inbox`) and the analytics view (`screen-analytics`)
 * so both surfaces read the SAME computed numbers and can never disagree. Renders
 * `null` when the warning is disabled, the snapshot is `ok`, no current action is
 * available, or we are not running inside the desktop shell.
 */

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { appApi, type BalanceGetResult, isDesktop, type SettingValue } from "../lib/appApi";
import { UNDO_EVENT } from "../shell/nav";
import { Icon } from "./Icon";

const NOTICE_DISMISSALS_KEY = "ui.noticeDismissals";
const BALANCE_NOTICE_ID = "balance.importProcess";
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface NoticeDismissal {
  readonly until?: string;
}

type NoticeDismissals = Record<string, NoticeDismissal>;

function isSettingObject(value: SettingValue | undefined): value is Record<string, SettingValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNoticeDismissals(value: SettingValue | undefined): NoticeDismissals {
  if (!isSettingObject(value)) return {};

  const dismissals: NoticeDismissals = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isSettingObject(raw)) continue;
    const until = typeof raw.until === "string" ? raw.until : undefined;
    if (until) dismissals[id] = { until };
  }
  return dismissals;
}

function isNoticeDismissed(dismissals: NoticeDismissals, id: string, now = Date.now()): boolean {
  const dismissal = dismissals[id];
  if (!dismissal) return false;
  if (!dismissal.until) return false;
  const untilMs = Date.parse(dismissal.until);
  return Number.isFinite(untilMs) && untilMs > now;
}

export interface BalanceBannerProps {
  /** Optional instant to compute the snapshot for (ISO-8601); defaults to "now". */
  readonly asOf?: string;
  /**
   * Bump to force a re-fetch (e.g. after the host triages an item or imports a
   * source) so the banner reflects the latest counts without a full remount.
   */
  readonly refreshKey?: number;
  /** Optional same-route handler; when absent the action navigates to `/inbox`. */
  readonly onTriageInbox?: () => void;
  /** Optional label for same-route hosts that reveal existing triage controls. */
  readonly triageInboxLabel?: string;
}

export function BalanceBanner({
  asOf,
  refreshKey = 0,
  onTriageInbox,
  triageInboxLabel = "Triage inbox",
}: BalanceBannerProps) {
  const navigate = useNavigate();
  const [data, setData] = useState<BalanceGetResult | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [dismissals, setDismissals] = useState<NoticeDismissals>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const firstMenuItemRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (!isDesktop()) return;
    try {
      // Read the on/off setting + notice dismissal + snapshot together. The snapshot
      // is always computed main-side; toggles only govern whether we surface it here.
      const [{ settings }, snapshot, noticeResult] = await Promise.all([
        appApi.getAppSettings(),
        appApi.getBalance(asOf ? { asOf } : undefined),
        appApi.getSettings({ key: NOTICE_DISMISSALS_KEY }),
      ]);
      const parsedDismissals = parseNoticeDismissals(noticeResult.settings[NOTICE_DISMISSALS_KEY]);
      setEnabled(settings.balanceWarnings);
      setData(snapshot);
      setDismissals(parsedDismissals);
      setDismissed(isNoticeDismissed(parsedDismissals, BALANCE_NOTICE_ID));
      setDismissError(null);
    } catch {
      // Advisory banner: a read failure simply hides it (never blocks the screen).
      setData(null);
    }
  }, [asOf]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate re-fetch trigger
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Re-read after a global undo (⌘Z) so a restored/undeleted item updates counts.
  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(UNDO_EVENT, handler);
    return () => window.removeEventListener(UNDO_EVENT, handler);
  }, [load]);

  useEffect(() => {
    if (!menuOpen) return;
    firstMenuItemRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        menuTriggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!dismissed) return;
    const until = dismissals[BALANCE_NOTICE_ID]?.until;
    if (!until) return;
    const untilMs = Date.parse(until);
    if (!Number.isFinite(untilMs)) return;
    const delay = untilMs - Date.now();
    if (delay <= 0) {
      void load();
      return;
    }
    const timer = window.setTimeout(() => void load(), delay + 100);
    return () => window.clearTimeout(timer);
  }, [dismissed, dismissals, load]);

  const triageInbox = useCallback(() => {
    if (onTriageInbox) {
      onTriageInbox();
      return;
    }
    void navigate({ to: "/inbox" });
  }, [navigate, onTriageInbox]);

  const hideForWeek = useCallback(async () => {
    const until = new Date(Date.now() + ONE_WEEK_MS).toISOString();
    const next = { ...dismissals, [BALANCE_NOTICE_ID]: { until } };
    try {
      await appApi.updateSetting({ key: NOTICE_DISMISSALS_KEY, value: next });
      setDismissals(next);
      setDismissed(true);
      setDismissError(null);
      setMenuOpen(false);
    } catch {
      setDismissError("Could not save that dismissal.");
    }
  }, [dismissals]);

  const turnOffWarning = useCallback(async () => {
    try {
      await appApi.updateAppSettings({ patch: { balanceWarnings: false } });
      setEnabled(false);
      setDismissError(null);
      setMenuOpen(false);
    } catch {
      setDismissError("Could not turn off this warning.");
    }
  }, []);

  const hasDueQueueWork = (data?.dueQueueItems ?? 0) > 0;
  const hasInboxWork = (data?.inboxSources ?? 0) > 0;

  // Hidden when disabled, balanced, no data, or there is no honest action to offer.
  if (!enabled || dismissed || !data?.imbalanced || (!hasDueQueueWork && !hasInboxWork))
    return null;

  const guidance =
    hasDueQueueWork && hasInboxWork
      ? "Process queue work or triage inbox sources before importing more."
      : hasDueQueueWork
        ? "Open the queue before importing more."
        : "Triage inbox sources before importing more.";

  const danger = data.severity === "danger";
  const tone = danger
    ? "border-danger bg-danger-soft text-text"
    : "border-warn bg-warn-soft text-text";
  const iconTone = danger ? "text-danger" : "text-warn";

  return (
    <div
      className={`flex items-start gap-3 rounded-md border px-4 py-3 text-sm ${tone}`}
      data-testid="balance-banner"
      data-severity={data.severity}
      role="status"
    >
      <span className={`mt-0.5 flex-none ${iconTone}`}>
        <Icon name="warning" size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-semibold" data-testid="balance-banner-title">
          You're importing faster than you process
        </div>
        <div className="mt-0.5 text-text-2">
          <span data-testid="balance-sources">{data.sourcesImported}</span> source
          {data.sourcesImported === 1 ? "" : "s"} in this week, but only{" "}
          <span data-testid="balance-extracts">{data.extractsCreated}</span> extract
          {data.extractsCreated === 1 ? "" : "s"} and{" "}
          <span data-testid="balance-cards">{data.cardsCreated}</span> card
          {data.cardsCreated === 1 ? "" : "s"} created —{" "}
          <span data-testid="balance-reviews">{data.reviewsDueThisWeek}</span> review
          {data.reviewsDueThisWeek === 1 ? "" : "s"} due this week. {guidance}
        </div>
        {dismissError ? (
          <div className="mt-1 text-danger text-xs" data-testid="balance-dismiss-error">
            {dismissError}
          </div>
        ) : null}
      </div>
      <div className="ml-auto flex flex-none items-center gap-2">
        {hasDueQueueWork ? (
          <button
            type="button"
            data-testid="balance-open-queue"
            onClick={() => void navigate({ to: "/queue" })}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-sm text-text-2 hover:text-text"
          >
            <Icon name="play" size={13} />
            Open queue
          </button>
        ) : null}
        {hasInboxWork ? (
          <button
            type="button"
            data-testid="balance-triage-inbox"
            onClick={triageInbox}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-sm text-text-2 hover:text-text"
          >
            <Icon name="inbox" size={13} />
            {triageInboxLabel}
          </button>
        ) : null}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            ref={menuTriggerRef}
            data-testid="balance-dismiss-menu-trigger"
            aria-label="Balance warning options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-surface text-text-2 hover:text-text"
          >
            <Icon name="more" size={14} />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              data-testid="balance-dismiss-menu"
              className="absolute right-0 z-20 mt-1 min-w-44 rounded-md border border-border bg-surface p-1 shadow-lg"
            >
              <button
                type="button"
                ref={firstMenuItemRef}
                role="menuitem"
                data-testid="balance-hide-week"
                onClick={() => void hideForWeek()}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-text-2 hover:bg-surface-2 hover:text-text"
              >
                <Icon name="clock" size={13} />
                Hide for a week
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="balance-turn-off"
                onClick={() => void turnOffWarning()}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-text-2 hover:bg-surface-2 hover:text-text"
              >
                <Icon name="pause" size={13} />
                <span className="flex flex-col">
                  <span>Hide forever</span>
                  <span className="text-2xs text-text-3">Re-enable in Settings</span>
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

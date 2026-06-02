/**
 * Settings screen (T011).
 *
 * The real preferences surface, rebuilt from `design/kit/app/screen-settings.jsx`
 * for React 19 + Tailwind v4. It reads and writes the typed user/domain settings
 * (daily review budget, desired retention, default topic interval, default source
 * priority, keyboard layout, theme) THROUGH the typed `window.appApi`
 * (`settings.getAll()` / `settings.updateMany()`) — the renderer never touches
 * SQLite. Every change persists immediately to the SQLite `settings` table and
 * survives an app restart; the same values are what the scheduler reads.
 *
 * Pure UI: no domain logic lives here. Validation/clamping/defaults are owned by
 * `@interleave/core` (and re-validated on the main side); this component only
 * orchestrates UI state + optimistic updates and awaits the IPC promises. Outside
 * Electron (browser/Vite-only) it shows a clear "desktop only" state.
 */

import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import {
  type AppSettings,
  appApi,
  type BackupsCreateResult,
  type CapturePairingResult,
  isDesktop,
  type ThemePreference,
} from "../lib/appApi";
import { SETTINGS_CHANGED_EVENT } from "../shell/nav";
import { applyTheme } from "../theme";

/** Human-readable byte size for the backup toast. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Local fallback defaults mirroring `@interleave/core`'s DEFAULT_APP_SETTINGS. */
const FALLBACK_SETTINGS: AppSettings = {
  dailyReviewBudget: 60,
  defaultDesiredRetention: 0.9,
  defaultTopicIntervalDays: 7,
  defaultSourcePriority: 0.375,
  burySiblings: true,
  trashRetentionDays: 30,
  balanceWarnings: true,
  importBalanceFactor: 1.5,
  keyboardLayout: "qwerty",
  theme: "dark",
  displayName: "",
  retentionByBand: {},
  retentionByBandEnabled: false,
};

/** Max length of the display name (mirrors `@interleave/core` `DISPLAY_NAME_MAX`). */
const DISPLAY_NAME_MAX = 64;

const PRIORITY_LABELS = ["A", "B", "C", "D"] as const;
type PriorityLabel = (typeof PRIORITY_LABELS)[number];
const PRIORITY_VALUE: Record<PriorityLabel, number> = { A: 0.875, B: 0.625, C: 0.375, D: 0.125 };

/** Numeric priority → coarse A/B/C/D label (mirrors core/priority). */
function priorityToLabel(priority: number): PriorityLabel {
  const v = Math.min(1, Math.max(0, priority));
  if (v >= 0.75) return "A";
  if (v >= 0.5) return "B";
  if (v >= 0.25) return "C";
  return "D";
}

/** Inclusive UI bounds for desired retention (mirrors `@interleave/core`). */
const DESIRED_RETENTION_MIN = 0.8;
const DESIRED_RETENTION_MAX = 0.97;

const TOPIC_INTERVAL_OPTIONS = [3, 7, 14, 30] as const;
const KEYBOARD_LAYOUTS: { value: AppSettings["keyboardLayout"]; label: string }[] = [
  { value: "qwerty", label: "QWERTY" },
  { value: "dvorak", label: "Dvorak" },
  { value: "vim", label: "Vim" },
];

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-5 border-border-faint border-b py-3.5 last:border-b-0">
      <div className="min-w-0">
        <div className="font-medium text-base text-text">{label}</div>
        {hint ? <div className="mt-0.5 text-sm text-text-3">{hint}</div> : null}
      </div>
      <div className="flex-none">{children}</div>
    </div>
  );
}

function SectionPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-1.5 font-medium text-text-2 text-xs uppercase tracking-wide">{title}</div>
      <div className="rounded-lg border border-border bg-surface-2 px-4">{children}</div>
    </section>
  );
}

/** A small segmented control matching the kit's `Segmented`. */
function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  name,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  name: string;
}) {
  return (
    <fieldset className="inline-flex rounded-md border border-border bg-surface p-0.5">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            data-testid={`${name}-option-${opt.value}`}
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={
              active
                ? "rounded-[5px] bg-accent px-3 py-1 font-medium text-sm text-text-on-accent"
                : "rounded-[5px] px-3 py-1 font-medium text-sm text-text-2 hover:text-text"
            }
          >
            {opt.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/** A small on/off switch matching the kit's `Toggle`. */
function Toggle({
  checked,
  onChange,
  name,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  name: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-testid={name}
      onClick={() => onChange(!checked)}
      className={
        checked
          ? "relative inline-flex h-6 w-11 items-center rounded-full bg-accent transition-colors"
          : "relative inline-flex h-6 w-11 items-center rounded-full bg-surface transition-colors ring-1 ring-border"
      }
    >
      <span
        className={
          checked
            ? "inline-block size-5 translate-x-[22px] rounded-full bg-text-on-accent transition-transform"
            : "inline-block size-5 translate-x-0.5 rounded-full bg-text-3 transition-transform"
        }
      />
    </button>
  );
}

/**
 * One A/B/C/D band's desired-retention control (T079). A band with no stored target
 * INHERITS the global default — the slider shows that effective value and a muted
 * "inherits" note; nudging the slider sets a per-band override, and a "Reset" link
 * clears it back to inherit. The hint reads "shorter/longer intervals" relative to
 * the global so the user understands the load trade-off.
 */
function RetentionBandRow({
  band,
  target,
  global,
  enabled,
  onSet,
}: {
  band: "A" | "B" | "C" | "D";
  target: number | undefined;
  global: number;
  enabled: boolean;
  onSet: (band: "A" | "B" | "C" | "D", target: number | null) => void;
}) {
  const effective = target ?? global;
  const pct = Math.round(effective * 100);
  const inherits = target === undefined;
  const delta = Math.round((effective - global) * 100);
  const hint =
    delta === 0 ? "matches global" : delta > 0 ? "shorter intervals" : "longer intervals";
  return (
    <SettingRow
      label={`Band ${band}`}
      hint={inherits ? "Inherits the global default" : `${hint} than global`}
    >
      <div className="flex items-center gap-2.5">
        <input
          type="range"
          min={Math.round(DESIRED_RETENTION_MIN * 100)}
          max={Math.round(DESIRED_RETENTION_MAX * 100)}
          step={1}
          value={pct}
          disabled={!enabled}
          data-testid={`setting-retention-band-${band}`}
          onChange={(e) => onSet(band, Number(e.target.value) / 100)}
          className="w-32 accent-accent disabled:opacity-40"
        />
        <span
          data-testid={`setting-retention-band-${band}-value`}
          className="w-12 text-right font-mono font-semibold text-accent-text text-sm"
        >
          {pct}%
        </span>
        <button
          type="button"
          data-testid={`setting-retention-band-${band}-reset`}
          disabled={!enabled || inherits}
          onClick={() => onSet(band, null)}
          className="text-text-3 text-xs hover:text-text disabled:opacity-30"
        >
          Reset
        </button>
      </div>
    </SettingRow>
  );
}

export function Settings() {
  const desktop = isDesktop();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [backup, setBackup] = useState<BackupsCreateResult | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  // Browser-capture pairing (T062) — the loopback server's token + running state.
  const [pairing, setPairing] = useState<CapturePairingResult | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokenRevealed, setTokenRevealed] = useState(false);

  /**
   * Trigger a full backup through the typed bridge (the main process does ALL the
   * work — snapshot `app.sqlite`, copy the vault, write the hashed manifest, zip).
   * The renderer only awaits the result + shows the path/size; it never touches
   * the filesystem.
   */
  const runBackup = useCallback(async () => {
    setBackingUp(true);
    setBackupError(null);
    try {
      const result = await appApi.createBackup();
      setBackup(result);
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : String(e));
    } finally {
      setBackingUp(false);
    }
  }, []);

  // Load the persisted settings from SQLite through the bridge on mount.
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    void (async () => {
      try {
        const { settings: loaded } = await appApi.getAppSettings();
        if (cancelled) return;
        setSettings(loaded);
        applyTheme(loaded.theme);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the browser-capture pairing state (token + enabled/running/port) (T062).
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await appApi.getCapturePairing();
        if (!cancelled) setPairing(result);
      } catch (e) {
        if (!cancelled) setPairingError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Enable/disable the loopback capture server (starts/stops it live). */
  const toggleCapture = useCallback(async (enabled: boolean) => {
    setPairingError(null);
    try {
      const next = await appApi.setCaptureEnabled({ enabled });
      // setEnabled returns enabled/running/port; re-read for the token + origin hint.
      const full = await appApi.getCapturePairing();
      setPairing({ ...full, ...next });
    } catch (e) {
      setPairingError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** Regenerate the pairing token (UNPAIRS the current extension). */
  const regenerateToken = useCallback(async () => {
    if (
      !window.confirm(
        "Regenerate the pairing token? The currently paired extension will stop working until you paste the new token into its options.",
      )
    ) {
      return;
    }
    setPairingError(null);
    try {
      await appApi.regenerateCaptureToken();
      const full = await appApi.getCapturePairing();
      setPairing(full);
      setTokenCopied(false);
    } catch (e) {
      setPairingError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** Copy the token to the clipboard for the user to paste into the extension. */
  const copyToken = useCallback(async () => {
    if (!pairing?.token) return;
    try {
      await navigator.clipboard.writeText(pairing.token);
      setTokenCopied(true);
      window.setTimeout(() => setTokenCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable; reveal the token so the user can copy manually.
      setTokenRevealed(true);
    }
  }, [pairing?.token]);

  /**
   * Optimistically apply a patch in the UI, persist it through the bridge, and
   * reconcile with the validated/coerced result the main side returns. Theme is
   * applied to <html> immediately so the change is visible.
   */
  const patch = useCallback(async (next: Partial<AppSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...next } : prev));
    if (next.theme) applyTheme(next.theme);
    try {
      const { settings: confirmed } = await appApi.updateAppSettings({ patch: next });
      setSettings(confirmed);
      applyTheme(confirmed.theme);
      setSavedAt(new Date().toISOString());
      setError(null);
      // Tell settings-reading shell chrome (the sidebar identity chip) to re-read
      // the change live — no remount required.
      window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /**
   * Toggle the per-priority/per-concept retention feature (T079) through the typed
   * `retention.setBandEnabled` command (which also invalidates the per-card scheduler
   * cache), then re-read the full settings so the resolved targets reflect the change.
   */
  const setRetentionEnabled = useCallback(async (enabled: boolean) => {
    setSettings((prev) => (prev ? { ...prev, retentionByBandEnabled: enabled } : prev));
    try {
      await appApi.setRetentionBandEnabled({ enabled });
      const { settings: confirmed } = await appApi.getAppSettings();
      setSettings(confirmed);
      setSavedAt(new Date().toISOString());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /**
   * Set/clear one priority-band desired-retention target (T079). `target === null`
   * clears the override (the band inherits the global default). Persists through the
   * typed `retention.setBand` command (which bumps the per-card scheduler cache), then
   * re-reads the full settings so the band map + the implied intervals reflect it.
   */
  const setRetentionBand = useCallback(
    async (band: "A" | "B" | "C" | "D", target: number | null) => {
      setSettings((prev) => {
        if (!prev) return prev;
        const nextBand = { ...prev.retentionByBand };
        if (target === null) delete nextBand[band];
        else nextBand[band] = target;
        return { ...prev, retentionByBand: nextBand };
      });
      try {
        const { retention } = await appApi.setRetentionBand({ band, target });
        setSettings((prev) =>
          prev
            ? {
                ...prev,
                retentionByBand: retention.byBand,
                retentionByBandEnabled: retention.byBandEnabled,
              }
            : prev,
        );
        setSavedAt(new Date().toISOString());
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  if (!desktop) {
    return (
      <div
        className="mx-auto h-full w-full max-w-3xl overflow-auto px-7 py-8"
        data-testid="route-settings"
      >
        <header className="mb-6">
          <h1 className="font-semibold text-2xl text-text tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-text-2">Local-first · everything stays on this device</p>
        </header>
        <section
          data-testid="settings-desktop-only"
          className="rounded-lg border border-border bg-surface-2 p-4"
        >
          <p className="text-sm text-text-2">
            Running in a browser — settings persist in the native SQLite database, which is only
            available in the Electron desktop app.
          </p>
        </section>
      </div>
    );
  }

  const s = settings ?? FALLBACK_SETTINGS;
  const retentionPct = Math.round(s.defaultDesiredRetention * 100);

  return (
    <div
      className="mx-auto h-full w-full max-w-3xl overflow-auto px-7 py-8"
      data-testid="route-settings"
    >
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-semibold text-2xl text-text tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-text-2">Local-first · everything stays on this device</p>
        </div>
        {savedAt ? (
          <span
            data-testid="settings-saved"
            className="inline-flex items-center gap-1.5 rounded-md bg-ok-soft px-2.5 py-1 text-ok text-xs"
          >
            <Icon name="check" size={13} />
            Saved
          </span>
        ) : null}
      </header>

      <SectionPanel title="Review & scheduling">
        <SettingRow
          label="Daily review budget"
          hint="Soft cap on items surfaced per day. Overflow auto-postpones by priority."
        >
          <div className="flex items-center gap-2.5">
            <input
              type="range"
              min={10}
              max={300}
              step={5}
              value={s.dailyReviewBudget}
              data-testid="setting-budget"
              onChange={(e) => void patch({ dailyReviewBudget: Number(e.target.value) })}
              className="w-40 accent-accent"
            />
            <span
              data-testid="setting-budget-value"
              className="w-16 text-right font-mono font-semibold text-sm text-text"
            >
              {s.dailyReviewBudget}/day
            </span>
          </div>
        </SettingRow>

        <SettingRow
          label="Desired retention"
          hint="FSRS target recall probability. Higher = more reviews, stronger memory."
        >
          <div className="flex items-center gap-2.5">
            <input
              type="range"
              min={80}
              max={97}
              step={1}
              value={retentionPct}
              data-testid="setting-retention"
              onChange={(e) =>
                void patch({ defaultDesiredRetention: Number(e.target.value) / 100 })
              }
              className="w-40 accent-accent"
            />
            <span
              data-testid="setting-retention-value"
              className="w-16 text-right font-mono font-semibold text-accent-text text-sm"
            >
              {retentionPct}%
            </span>
          </div>
        </SettingRow>

        <SettingRow
          label="Default topic interval"
          hint="How often a topic resurfaces on the attention scheduler."
        >
          <Segmented
            name="setting-topic-interval"
            value={s.defaultTopicIntervalDays}
            onChange={(value) => void patch({ defaultTopicIntervalDays: value })}
            options={TOPIC_INTERVAL_OPTIONS.map((d) => ({ value: d, label: `${d}d` }))}
          />
        </SettingRow>

        <SettingRow
          label="Default source priority"
          hint="Priority assigned to newly imported sources."
        >
          <div className="flex items-center gap-1.5" data-testid="setting-priority">
            {PRIORITY_LABELS.map((p) => {
              const active = priorityToLabel(s.defaultSourcePriority) === p;
              return (
                <button
                  key={p}
                  type="button"
                  data-testid={`setting-priority-${p}`}
                  aria-pressed={active}
                  onClick={() => void patch({ defaultSourcePriority: PRIORITY_VALUE[p] })}
                  className={
                    active
                      ? "inline-flex min-w-9 items-center justify-center gap-1.5 rounded-md border border-accent-soft-bd bg-accent-soft px-2 py-1 font-medium text-accent-text text-sm"
                      : "inline-flex min-w-9 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 font-medium text-sm text-text-2 hover:text-text"
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
        </SettingRow>

        <SettingRow
          label="Bury siblings"
          hint="Don't show cards from the same extract or cloze group back-to-back in a review session."
        >
          <Toggle
            name="setting-bury-siblings"
            checked={s.burySiblings}
            onChange={(value) => void patch({ burySiblings: value })}
          />
        </SettingRow>

        <SettingRow
          label="Import / process balance warnings"
          hint="Warn on the inbox and analytics when you import faster than you process."
        >
          <Toggle
            name="setting-balance-warnings"
            checked={s.balanceWarnings}
            onChange={(value) => void patch({ balanceWarnings: value })}
          />
        </SettingRow>
      </SectionPanel>

      <SectionPanel title="Retention by priority">
        <SettingRow
          label="Per-priority retention"
          hint="Hold high-value (A) cards to a higher target and let low-value (D) cards drift — protecting fragile memory while trimming daily load. Off = one global retention for every card."
        >
          <Toggle
            name="setting-retention-by-band"
            checked={s.retentionByBandEnabled}
            onChange={(value) => void setRetentionEnabled(value)}
          />
        </SettingRow>
        {PRIORITY_LABELS.map((band) => (
          <RetentionBandRow
            key={band}
            band={band}
            target={s.retentionByBand[band]}
            global={s.defaultDesiredRetention}
            enabled={s.retentionByBandEnabled}
            onSet={(b, t) => void setRetentionBand(b, t)}
          />
        ))}
      </SectionPanel>

      <SectionPanel title="Interface">
        <SettingRow
          label="Display name"
          hint="Shown in the sidebar. Local to this vault — there is no account."
        >
          <input
            type="text"
            data-testid="setting-display-name"
            value={s.displayName}
            maxLength={DISPLAY_NAME_MAX}
            placeholder="Local vault"
            onChange={(e) => void patch({ displayName: e.target.value })}
            className="w-48 rounded-md border border-border bg-surface px-2.5 py-1 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </SettingRow>

        <SettingRow label="Theme" hint="Light or dark.">
          <Segmented
            name="setting-theme"
            value={s.theme}
            onChange={(value) => void patch({ theme: value as ThemePreference })}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </SettingRow>

        <SettingRow label="Keyboard layout" hint="Affects default shortcut bindings.">
          <Segmented
            name="setting-keyboard"
            value={s.keyboardLayout}
            onChange={(value) => void patch({ keyboardLayout: value })}
            options={KEYBOARD_LAYOUTS}
          />
        </SettingRow>
      </SectionPanel>

      <SectionPanel title="Data & backup">
        <SettingRow
          label="Back up now"
          hint="Export the database + asset vault to a portable, hashed ZIP under backups/."
        >
          <button
            type="button"
            data-testid="settings-backup-now"
            disabled={backingUp}
            onClick={() => void runBackup()}
            className={
              backingUp
                ? "inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 font-medium text-sm text-text-3"
                : "inline-flex items-center gap-2 rounded-md border border-accent-soft-bd bg-accent-soft px-3 py-1.5 font-medium text-accent-text text-sm hover:bg-accent-soft/80"
            }
          >
            <Icon name="download" size={14} />
            {backingUp ? "Backing up…" : "Back up now"}
          </button>
        </SettingRow>
        {backup ? (
          <SettingRow label="Last backup" hint={backup.path}>
            <span
              data-testid="settings-backup-result"
              className="inline-flex items-center gap-1.5 rounded-md bg-ok-soft px-2.5 py-1 text-ok text-xs"
            >
              <Icon name="check" size={13} />
              {formatBytes(backup.sizeBytes)} · {backup.fileCount} files · {backup.schemaVersion}
            </span>
          </SettingRow>
        ) : null}
        {backupError ? (
          <SettingRow label="Backup failed" hint="See the error below.">
            <span data-testid="settings-backup-error" className="text-danger text-sm">
              {backupError}
            </span>
          </SettingRow>
        ) : null}
      </SectionPanel>

      {/* Browser capture (T062) — the loopback-server pairing card. */}
      <section className="mb-6 scroll-mt-6" id="browser-capture" data-testid="settings-capture">
        <div className="mb-1.5 font-medium text-text-2 text-xs uppercase tracking-wide">
          Browser capture
        </div>
        <div className="rounded-lg border border-border bg-surface-2 px-4">
          <SettingRow
            label="Capture server"
            hint="Let the Interleave browser extension save pages & selections into your inbox — over a local 127.0.0.1 connection only, never the cloud."
          >
            <button
              type="button"
              data-testid="settings-capture-toggle"
              role="switch"
              aria-checked={pairing?.enabled ?? false}
              onClick={() => void toggleCapture(!(pairing?.enabled ?? false))}
              className={
                pairing?.enabled
                  ? "inline-flex items-center gap-2 rounded-md border border-accent-soft-bd bg-accent-soft px-3 py-1.5 font-medium text-accent-text text-sm"
                  : "inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 font-medium text-sm text-text-2 hover:border-border-strong"
              }
            >
              <Icon name={pairing?.enabled ? "check" : "globe"} size={14} />
              {pairing?.enabled ? "Enabled" : "Disabled"}
            </button>
          </SettingRow>

          {pairing?.enabled ? (
            <>
              <SettingRow
                label="Status"
                hint={
                  pairing.running ? `Listening on 127.0.0.1:${pairing.port ?? "—"}` : "Starting…"
                }
              >
                <span
                  data-testid="settings-capture-status"
                  className={
                    pairing.running
                      ? "inline-flex items-center gap-1.5 rounded-md bg-ok-soft px-2.5 py-1 text-ok text-xs"
                      : "inline-flex items-center gap-1.5 rounded-md bg-surface px-2.5 py-1 text-text-3 text-xs"
                  }
                >
                  <Icon name={pairing.running ? "check" : "clock"} size={13} />
                  {pairing.running ? "Running" : "Stopped"}
                </span>
              </SettingRow>

              <SettingRow
                label="Pairing token"
                hint="Open the extension's Options and paste this token to pair."
              >
                <div className="flex items-center gap-2">
                  <code
                    data-testid="settings-capture-token"
                    className="max-w-[15rem] truncate rounded bg-surface px-2 py-1 font-mono text-text-2 text-xs"
                    title={tokenRevealed ? pairing.token : "Hidden — use Copy"}
                  >
                    {tokenRevealed ? pairing.token : "•".repeat(24)}
                  </code>
                  <button
                    type="button"
                    data-testid="settings-capture-copy"
                    onClick={() => void copyToken()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 font-medium text-sm text-text-2 hover:border-border-strong"
                  >
                    <Icon name={tokenCopied ? "check" : "copy"} size={13} />
                    {tokenCopied ? "Copied" : "Copy"}
                  </button>
                  <button
                    type="button"
                    data-testid="settings-capture-regenerate"
                    onClick={() => void regenerateToken()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 font-medium text-sm text-text-3 hover:border-border-strong"
                  >
                    <Icon name="review" size={13} />
                    Regenerate
                  </button>
                </div>
              </SettingRow>

              {pairing.extensionOriginHint ? (
                <SettingRow label="Paired with" hint="The extension that completed pairing.">
                  <span
                    data-testid="settings-capture-origin"
                    className="font-mono text-text-3 text-xs"
                  >
                    {pairing.extensionOriginHint}
                  </span>
                </SettingRow>
              ) : null}
            </>
          ) : null}

          {pairingError ? (
            <SettingRow label="Capture error" hint="See the error below.">
              <span data-testid="settings-capture-error" className="text-danger text-sm">
                {pairingError}
              </span>
            </SettingRow>
          ) : null}
        </div>
      </section>

      {error ? (
        <p data-testid="settings-error" className="mt-2 text-danger text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Capture-server pairing state (T062) — the per-install token, enabled flag,
 * bound port, and paired extension origin.
 *
 * ALL `capture.*` keys are read/written through the RAW `SettingsRepository`
 * key/value path (`get`/`set`/`delete`), NEVER the typed `AppSettings` patch
 * (`updateAppSettings` / `appSettingsFromStored` / `coerceSettingsPatch`). The
 * typed layer only round-trips the fixed `SETTINGS_KEYS` and SILENTLY DROPS
 * unknown keys — so routing the token through it would lose it, and
 * `settings.getAll()` (the typed surface) correctly never surfaces these
 * capture-internal keys. That isolation is intentional: the pairing token is
 * capture-server plumbing, not a user-facing app setting.
 *
 * The token lives in SQLite settings (not Electron config) so it is part of the
 * user's data dir + backups and survives a restart like all other data. It is
 * displayed ONLY in the trusted desktop renderer; the user transports it by paste
 * into the extension — there is no IPC path that hands it to a web page.
 *
 * Security defaults:
 *   - `capture.enabled` defaults to FALSE — the loopback server is a network
 *     surface, so a fresh install opens no port until the user explicitly pairs.
 *   - the token is minted LAZILY (only on first read), so a never-paired install
 *     never persists one needlessly.
 */

import { randomBytes } from "node:crypto";
import type { SettingsRepository } from "@interleave/local-db";

/** The canonical settings keys (raw key/value — not in `SETTINGS_KEYS`). */
export const CAPTURE_TOKEN_KEY = "capture.token";
export const CAPTURE_ENABLED_KEY = "capture.enabled";
export const CAPTURE_PORT_KEY = "capture.port";
export const CAPTURE_ALLOWED_ORIGIN_KEY = "capture.allowedOrigin";

/**
 * Read the pairing token, minting + persisting a fresh 32-byte base64url token on
 * first read. Idempotent thereafter (the same token until `regenerateCaptureToken`).
 */
export function getOrCreateCaptureToken(settings: SettingsRepository): string {
  const existing = settings.get<string>(CAPTURE_TOKEN_KEY);
  if (existing && typeof existing === "string" && existing.length > 0) {
    return existing;
  }
  const token = randomBytes(32).toString("base64url");
  settings.set(CAPTURE_TOKEN_KEY, token);
  return token;
}

/**
 * Replace the pairing token with a fresh one and return it. This UNPAIRS any
 * extension still holding the old token (its next capture fails `bad_token`).
 * It does NOT clear the stored allowed origin — a future "unpair" may, but a
 * regenerate just rotates the secret.
 */
export function regenerateCaptureToken(settings: SettingsRepository): string {
  const token = randomBytes(32).toString("base64url");
  settings.set(CAPTURE_TOKEN_KEY, token);
  return token;
}

/** Whether the capture server is enabled (default FALSE — off until paired). */
export function getCaptureEnabled(settings: SettingsRepository): boolean {
  return settings.getOr<boolean>(CAPTURE_ENABLED_KEY, false);
}

/** Enable/disable the capture server (persisted). */
export function setCaptureEnabled(settings: SettingsRepository, enabled: boolean): void {
  settings.set(CAPTURE_ENABLED_KEY, enabled);
}

/** The last bound port (set AFTER the socket binds), or `null` when not running. */
export function getCapturePort(settings: SettingsRepository): number | null {
  const value = settings.get<number>(CAPTURE_PORT_KEY);
  return typeof value === "number" ? value : null;
}

/** Persist the bound port (called AFTER `server.listen` resolves). */
export function setCapturePort(settings: SettingsRepository, port: number): void {
  settings.set(CAPTURE_PORT_KEY, port);
}

/** Clear the recorded port (on stop/disable) so a stopped server advertises none. */
export function clearCapturePort(settings: SettingsRepository): void {
  settings.set(CAPTURE_PORT_KEY, null);
}

/**
 * The paired extension origin (`chrome-extension://<id>`) learned via the pairing
 * handshake, or `null` when no extension has paired yet. Until this is set, the
 * server treats EVERY `/capture` request as unpaired (closed) — the CORS/Origin
 * gate has nothing to match against.
 */
export function getAllowedOrigin(settings: SettingsRepository): string | null {
  const value = settings.get<string>(CAPTURE_ALLOWED_ORIGIN_KEY);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Store the paired extension origin (the options-page handshake POSTs it). */
export function setAllowedOrigin(settings: SettingsRepository, origin: string): void {
  settings.set(CAPTURE_ALLOWED_ORIGIN_KEY, origin);
}

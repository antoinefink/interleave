/**
 * CaptureController (T062) — the small main-side object that owns the live
 * loopback-server handle and brokers start/stop/read so BOTH the lifecycle
 * (`bootstrap()` / `will-quit`) AND the IPC pairing commands (`capture.setEnabled`
 * / `capture.getPairing` / `capture.regenerateToken`) operate on ONE source of
 * truth.
 *
 * The IPC layer never touches the raw HTTP server or the settings keys directly —
 * it calls this controller, which holds the running handle in a private field and
 * (re)reads the `capture.*` settings via the pairing helpers. This keeps the
 * start-socket-FIRST → persist-port → mark-running ordering (and the symmetric
 * stop) in exactly one place.
 */

import type { SettingsRepository } from "@interleave/local-db";
import {
  getAllowedOrigin,
  getCaptureEnabled,
  getOrCreateCaptureToken,
  regenerateCaptureToken,
  setCaptureEnabled,
} from "./capture-pairing";
import {
  type CaptureServerHandle,
  type CaptureServerImportService,
  startCaptureServer,
} from "./capture-server";

/** The pairing state the Settings card reads. */
export interface CapturePairing {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly port: number | null;
  readonly token: string;
  readonly extensionOriginHint: string | null;
}

export interface CaptureControllerDeps {
  readonly settings: SettingsRepository;
  /** A getter for the single shared M12 import service (built lazily on first start). */
  getImportService(): CaptureServerImportService;
  readonly appVersion: string;
}

export class CaptureController {
  private handle: CaptureServerHandle | null = null;

  constructor(private readonly deps: CaptureControllerDeps) {}

  /** Start the server if `capture.enabled` is set; a no-op when already running. */
  async startIfEnabled(): Promise<void> {
    if (this.handle) return;
    if (!getCaptureEnabled(this.deps.settings)) return;
    await this.start();
  }

  /** Start the server (idempotent). Binds the socket, then persists the port. */
  private async start(): Promise<void> {
    if (this.handle) return;
    this.handle = await startCaptureServer({
      settings: this.deps.settings,
      importService: this.deps.getImportService(),
      appVersion: this.deps.appVersion,
    });
  }

  /** Stop the server (idempotent); clears the recorded port. */
  async stop(): Promise<void> {
    if (!this.handle) return;
    const handle = this.handle;
    this.handle = null;
    await handle.stop();
  }

  /** Enable/disable + start/stop the server live; returns the new state. */
  async setEnabled(enabled: boolean): Promise<CapturePairing> {
    setCaptureEnabled(this.deps.settings, enabled);
    if (enabled) {
      // Minting the token here means the pairing card always has one to show the
      // moment the user enables capture.
      getOrCreateCaptureToken(this.deps.settings);
      await this.start();
    } else {
      await this.stop();
    }
    return this.getPairing();
  }

  /** Mint a fresh token (unpairs the current extension); returns it. */
  regenerateToken(): string {
    return regenerateCaptureToken(this.deps.settings);
  }

  /** Read the current pairing state (single source of truth). */
  getPairing(): CapturePairing {
    const enabled = getCaptureEnabled(this.deps.settings);
    // Mint the token lazily on read so the card never shows an empty token field
    // once the user has reached it (a never-paired install still has one minted
    // here, but never persists a server/port).
    const token = getOrCreateCaptureToken(this.deps.settings);
    const handle = this.handle;
    return {
      enabled,
      running: handle !== null,
      // The bound port is authoritative ONLY while running; a stopped server reports null.
      port: handle?.port ?? null,
      token,
      extensionOriginHint: getAllowedOrigin(this.deps.settings),
    };
  }
}

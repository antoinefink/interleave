import { type IsoTimestamp, priorityToLabel } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  type AutoPostponeApplyResult,
  type AutoPostponePlanSnapshot,
  AutoPostponeService,
  type PostponeOriginPayload,
} from "./auto-postpone-service";
import { newRowId, nowIso } from "./ids";
import type { Repositories } from "./index";
import { type UndoResult, UndoService } from "./undo-service";

export const STANDING_AUTO_POSTPONE_STATE_KEY = "dailyWork.standingAutoPostpone.v1";
const RETAIN_DAYS = 31;

export type StandingAutoPostponeReceiptStatus = "actionable" | "undone";

export interface StandingAutoPostponeReceipt {
  readonly batchId: string;
  readonly localDay: string;
  readonly status: StandingAutoPostponeReceiptStatus;
  readonly postponed: number;
  readonly postponedMinutes: number;
  readonly remainingMinutesAfter: number;
  readonly distillationFloor?: AutoPostponeApplyResult["distillationFloor"];
  readonly priorityBands: readonly string[];
  readonly createdAt: IsoTimestamp;
  readonly undoneAt?: IsoTimestamp;
}

interface StandingAutoPostponeDayState {
  readonly localDay: string;
  readonly evaluatedAt: IsoTimestamp;
  readonly policy: "automatic";
  readonly receipt?: StandingAutoPostponeReceipt;
}

interface StandingAutoPostponeState {
  readonly version: 1;
  readonly days: Record<string, StandingAutoPostponeDayState>;
}

export interface StandingAutoPostponeMaterializeResult {
  readonly localDay: string;
  readonly evaluated: boolean;
  readonly applied: boolean;
  readonly receipt: StandingAutoPostponeReceipt | null;
}

export interface StandingAutoPostponeUndoResult {
  readonly receipt: StandingAutoPostponeReceipt | null;
  readonly undo: UndoResult;
}

export class StandingAutoPostponeService {
  private readonly autoPostpone: AutoPostponeService;
  private readonly undo: UndoService;

  constructor(
    private readonly db: InterleaveDatabase,
    private readonly repos: Repositories,
    private readonly clock: () => IsoTimestamp = nowIso,
  ) {
    this.autoPostpone = new AutoPostponeService(db, repos);
    this.undo = new UndoService(db);
  }

  materializeToday(): StandingAutoPostponeMaterializeResult {
    const now = this.clock();
    const localDay = localDayOf(now);
    const existing = this.day(localDay);
    if (existing) {
      return {
        localDay,
        evaluated: true,
        applied: Boolean(existing.receipt),
        receipt: existing.receipt ?? null,
      };
    }

    const settings = this.repos.settings.getAppSettings();
    if (settings.overloadPolicy !== "automatic") {
      return { localDay, evaluated: false, applied: false, receipt: null };
    }

    const snapshot = this.autoPostpone.planSnapshot({ asOf: now });
    const batchId = newRowId();
    const origin: PostponeOriginPayload = {
      kind: "standingAutoPostpone",
      localDay,
      overloadPolicy: "automatic",
    };
    const result = this.db.transaction((tx) => {
      const applied = this.autoPostpone.applySnapshotWithin(tx, snapshot, {
        batchId,
        payloadExtras: { postponeOrigin: origin },
      });
      const receipt = receiptFromApply(snapshot, applied, localDay, now);
      const state = this.withDay(localDay, {
        localDay,
        evaluatedAt: now,
        policy: "automatic",
        ...(receipt ? { receipt } : {}),
      });
      this.repos.settings.setManyWithin(tx, { [STANDING_AUTO_POSTPONE_STATE_KEY]: state });
      return { applied, receipt };
    });

    return {
      localDay,
      evaluated: true,
      applied: result.applied.postponed > 0,
      receipt: result.receipt,
    };
  }

  receiptForToday(): StandingAutoPostponeReceipt | null {
    return this.day(localDayOf(this.clock()))?.receipt ?? null;
  }

  undoReceipt(batchId: string): StandingAutoPostponeUndoResult {
    const state = this.state();
    const entry = Object.values(state.days).find((day) => day.receipt?.batchId === batchId);
    const receipt = entry?.receipt ?? null;
    if (!entry || !receipt) {
      return {
        receipt: null,
        undo: {
          undone: false,
          opType: null,
          elementId: null,
          label: "",
          reason: "Receipt not found",
          count: 0,
        },
      };
    }
    if (receipt.status === "undone") {
      return {
        receipt,
        undo: {
          undone: false,
          opType: null,
          elementId: null,
          label: "",
          reason: "Receipt already undone",
          count: 0,
        },
      };
    }

    const now = this.clock();
    const undoneReceipt: StandingAutoPostponeReceipt = {
      ...receipt,
      status: "undone",
      undoneAt: now,
    };
    const undo = this.undo.undoBatch(batchId, {
      requirePostponeOriginKind: "standingAutoPostpone",
      requireCurrentDueMatch: true,
      restoredPayloadExtras: {
        receiptRestore: true,
        restoredBatchId: batchId,
        postponeOrigin: {
          kind: "standingAutoPostpone",
          localDay: receipt.localDay,
          overloadPolicy: "automatic",
          restored: true,
        } satisfies PostponeOriginPayload,
      },
      afterUndo: (tx) => {
        this.repos.settings.setManyWithin(tx, {
          [STANDING_AUTO_POSTPONE_STATE_KEY]: {
            ...state,
            days: {
              ...state.days,
              [entry.localDay]: {
                ...entry,
                receipt: undoneReceipt,
              },
            },
          } satisfies StandingAutoPostponeState,
        });
      },
    });
    if (!undo.undone) return { receipt, undo };
    return { receipt: undoneReceipt, undo };
  }

  private day(localDay: string): StandingAutoPostponeDayState | null {
    return this.state().days[localDay] ?? null;
  }

  private withDay(localDay: string, day: StandingAutoPostponeDayState): StandingAutoPostponeState {
    const days = { ...this.state().days, [localDay]: day };
    const ordered = Object.keys(days).sort();
    for (const stale of ordered.slice(0, Math.max(0, ordered.length - RETAIN_DAYS))) {
      delete days[stale];
    }
    return { version: 1, days };
  }

  private state(): StandingAutoPostponeState {
    const raw = this.repos.settings.get<StandingAutoPostponeState>(
      STANDING_AUTO_POSTPONE_STATE_KEY,
    );
    if (!raw || typeof raw !== "object" || raw.version !== 1 || typeof raw.days !== "object") {
      return { version: 1, days: {} };
    }
    return raw;
  }
}

function receiptFromApply(
  snapshot: AutoPostponePlanSnapshot,
  result: AutoPostponeApplyResult,
  localDay: string,
  createdAt: IsoTimestamp,
): StandingAutoPostponeReceipt | null {
  if (result.postponed === 0) return null;
  const rowsById = new Map(snapshot.items.map((row) => [row.id, row]));
  const bands = [
    ...new Set(
      snapshot.plan.items.map((item) => priorityToLabel(rowsById.get(item.id)?.priority ?? 0)),
    ),
  ].sort();
  return {
    batchId: result.batchId,
    localDay,
    status: "actionable",
    postponed: result.postponed,
    postponedMinutes: result.postponedMinutes,
    remainingMinutesAfter: result.remainingMinutesAfter,
    distillationFloor: result.distillationFloor,
    priorityBands: bands,
    createdAt,
  };
}

function localDayOf(iso: IsoTimestamp): string {
  const date = new Date(iso);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

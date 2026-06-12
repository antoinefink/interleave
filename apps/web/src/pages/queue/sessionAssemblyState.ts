import type {
  QueueItemSummary,
  QueueSessionMode,
  QueueSessionPlanCutItem,
  QueueSessionPlanResult,
} from "../../lib/appApi";

export type SessionAssemblyOrigin = "home" | "queue";

export function sessionMinuteLabel(minutes: number, approximate: boolean): string {
  const rounded = Number.isInteger(minutes) ? minutes : Math.round(minutes * 10) / 10;
  return `${approximate ? "~" : ""}${rounded} min`;
}

export interface AcceptedSessionAssembly {
  readonly id: string;
  readonly origin: SessionAssemblyOrigin;
  readonly acceptedAt: string;
  readonly asOf?: string;
  readonly targetMinutes: number;
  readonly mode: QueueSessionMode;
  readonly filters: {
    readonly types?: readonly string[];
    readonly statuses?: readonly string[];
    readonly protectedOnly?: boolean;
    readonly concept?: string;
    readonly tag?: string;
  };
  readonly plannedItems: readonly QueueItemSummary[];
  readonly plannedEstimates: Readonly<Record<string, number>>;
  readonly plannedMinutes: number;
  readonly confidence: "learned" | "default";
  readonly usesDefaultEstimate: boolean;
  readonly cut: {
    readonly detailedItems: readonly QueueSessionPlanCutItem[];
    readonly totalCount: number;
    readonly totalMinutes: number;
  };
}

let accepted: AcceptedSessionAssembly | null = null;

export function acceptSessionAssembly(input: {
  readonly origin: SessionAssemblyOrigin;
  readonly asOf?: string;
  readonly mode?: QueueSessionMode;
  readonly filters?: AcceptedSessionAssembly["filters"];
  readonly plan: QueueSessionPlanResult;
}): AcceptedSessionAssembly {
  const next: AcceptedSessionAssembly = {
    id: `session-${Date.now().toString(36)}`,
    origin: input.origin,
    acceptedAt: new Date().toISOString(),
    ...(input.asOf ? { asOf: input.asOf } : {}),
    targetMinutes: input.plan.targetMinutes,
    mode: input.mode ?? "full",
    filters: input.filters ?? {},
    plannedItems: input.plan.items.map((row) => row.item),
    plannedEstimates: Object.fromEntries(
      input.plan.items.map((row) => [row.item.id, row.estimatedMinutes]),
    ),
    plannedMinutes: input.plan.plannedMinutes,
    confidence: input.plan.confidence,
    usesDefaultEstimate: input.plan.usesDefaultEstimate,
    cut: {
      detailedItems: input.plan.cut.items,
      totalCount: input.plan.cut.totalCount,
      totalMinutes: input.plan.cut.totalMinutes,
    },
  };
  accepted = next;
  return next;
}

export function consumeAcceptedSessionAssembly(): AcceptedSessionAssembly | null {
  const next = accepted;
  accepted = null;
  return next;
}

export function clearAcceptedSessionAssembly(): void {
  accepted = null;
}

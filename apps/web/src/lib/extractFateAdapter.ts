import { appApi } from "./appApi";

export type ExtractFate = "reference" | "synthesized" | "done_without_card";
export type DirectExtractFate = Exclude<ExtractFate, "synthesized">;

export interface ExtractFateActionResult {
  readonly extract?: {
    readonly id: string;
    readonly status?: string;
    readonly stage?: string;
    readonly dueAt?: string | null;
    readonly extractFate?: ExtractFate | null;
  };
}

type FateRequest = { readonly id: string; readonly fate: DirectExtractFate };
type ReactivateRequest = { readonly id: string };
type FateMethod = (request: FateRequest) => Promise<ExtractFateActionResult>;
type ReactivateMethod = (request: ReactivateRequest) => Promise<ExtractFateActionResult>;

interface OptionalExtractFateBridge {
  readonly setExtractFate?: FateMethod;
  readonly reactivateExtractFate?: ReactivateMethod;
  readonly extracts?: {
    readonly setFate?: FateMethod;
    readonly setExtractFate?: FateMethod;
    readonly reactivateFate?: ReactivateMethod;
    readonly reactivateExtractFate?: ReactivateMethod;
  };
}

export const EXTRACT_FATE_BRIDGE_HINT =
  "Desktop bridge does not expose extract fate actions yet. Required: extracts.setFate({ id, fate }) and extracts.reactivateFate({ id }).";

function optionalBridges(): readonly OptionalExtractFateBridge[] {
  const raw =
    typeof window !== "undefined"
      ? ((window.appApi as unknown as OptionalExtractFateBridge | undefined) ?? undefined)
      : undefined;
  return raw ? [raw] : [appApi as unknown as OptionalExtractFateBridge];
}

function setFateMethod(): FateMethod | null {
  for (const bridge of optionalBridges()) {
    const method =
      bridge.setExtractFate ?? bridge.extracts?.setFate ?? bridge.extracts?.setExtractFate;
    if (typeof method === "function") return method;
  }
  return null;
}

function reactivateMethod(): ReactivateMethod | null {
  for (const bridge of optionalBridges()) {
    const method =
      bridge.reactivateExtractFate ??
      bridge.extracts?.reactivateFate ??
      bridge.extracts?.reactivateExtractFate;
    if (typeof method === "function") return method;
  }
  return null;
}

export function canSetExtractFate(): boolean {
  return setFateMethod() !== null;
}

export function canReactivateExtractFate(): boolean {
  return reactivateMethod() !== null;
}

export async function setExtractFate(
  id: string,
  fate: DirectExtractFate,
): Promise<ExtractFateActionResult> {
  const method = setFateMethod();
  if (!method) throw new Error(EXTRACT_FATE_BRIDGE_HINT);
  return method({ id, fate });
}

export async function reactivateExtractFate(id: string): Promise<ExtractFateActionResult> {
  const method = reactivateMethod();
  if (!method) throw new Error(EXTRACT_FATE_BRIDGE_HINT);
  return method({ id });
}

export function extractFateOf(value: unknown): ExtractFate | null {
  const fate = (value as { extractFate?: unknown } | null | undefined)?.extractFate;
  return fate === "reference" || fate === "synthesized" || fate === "done_without_card"
    ? fate
    : null;
}

export function extractFateLabel(fate: ExtractFate): string {
  switch (fate) {
    case "reference":
      return "Reference";
    case "synthesized":
      return "Synthesized";
    case "done_without_card":
      return "Done without card";
  }
}

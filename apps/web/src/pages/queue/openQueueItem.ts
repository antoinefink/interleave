import type { NavigateFn } from "@tanstack/react-router";

export interface OpenableItem {
  readonly id: string;
  readonly type: string | null;
  readonly taskType?: string | null;
  readonly linkedElementId?: string | null;
  readonly linkedElementType?: string | null;
  /** The owning-source id of the linked element (T129 re-read routing); see queue-query. */
  readonly linkedSourceId?: string | null;
}

interface OpenQueueItemOptions {
  readonly item: OpenableItem;
  readonly navigate: NavigateFn;
  readonly select: (id: string | null) => void;
  readonly asOf?: string | undefined;
}

function routeToProcess(navigate: NavigateFn, asOf?: string): void {
  void navigate({ to: "/process", search: asOf ? { asOf } : {} });
}

function routeToCard(navigate: NavigateFn, id: string): void {
  void navigate({ to: "/card/$id", params: { id } });
}

function routeToElement(
  type: string | null,
  id: string,
  navigate: NavigateFn,
  asOf?: string,
  options: { linkedTaskTarget?: boolean } = {},
): void {
  if (type === "source" || (options.linkedTaskTarget && type === "topic")) {
    void navigate({ to: "/source/$id", params: { id } });
    return;
  }

  if (type === "extract") {
    void navigate({ to: "/extract/$id", params: { id } });
    return;
  }

  if (type === "card") {
    routeToCard(navigate, id);
    return;
  }

  routeToProcess(navigate, asOf);
}

/**
 * Open an element row in its work surface. Linked verification tasks open the element
 * they protect, while unlinked tasks stay in the process loop.
 */
export function openQueueItem({ item, navigate, select, asOf }: OpenQueueItemOptions): void {
  if (item.type === "task" && item.taskType === "weekly_review") {
    select(item.id);
    void navigate({ to: "/weekly", search: asOf ? { asOf } : {} });
    return;
  }

  // A T129 re-read task links the ancestor EXTRACT, but its work surface is the SOURCE
  // READER at the failing region — not the extract view. Route to /source/$id with the
  // task id as `?reread` (the reader fetches the failing-cards panel + jumps to the
  // region) and a fresh nonce so re-opening an already-open source re-fires the panel.
  // Falls through to the generic linked-task branch only if the owning source is unknown.
  if (item.type === "task" && item.taskType === "reread_region" && item.linkedSourceId) {
    select(item.linkedSourceId);
    void navigate({
      to: "/source/$id",
      params: { id: item.linkedSourceId },
      search: { reread: item.id, n: Date.now() },
    });
    return;
  }

  if (item.type === "task" && item.linkedElementId) {
    select(item.linkedElementType === "card" ? null : item.linkedElementId);
    routeToElement(item.linkedElementType ?? null, item.linkedElementId, navigate, asOf, {
      linkedTaskTarget: true,
    });
    return;
  }

  select(item.type === "card" ? null : item.id);
  routeToElement(item.type, item.id, navigate, asOf);
}

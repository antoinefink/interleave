import type { NavigateFn } from "@tanstack/react-router";

export interface OpenableItem {
  readonly id: string;
  readonly type: string | null;
  readonly linkedElementId?: string | null;
  readonly linkedElementType?: string | null;
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

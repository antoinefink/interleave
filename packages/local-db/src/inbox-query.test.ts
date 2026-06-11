/**
 * Inbox query + triage domain tests (T012).
 *
 * Run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` database
 * (via `createInMemoryDb`), so behaviour matches production exactly. They cover
 * the inbox read query (`InboxQuery.list/get`) and the underlying triage
 * mutations (the same `SourceRepository` / `ElementRepository` calls the Electron
 * DB service composes), asserting the load-bearing invariants:
 *
 *  - creating a source lands it in `inbox` (status + `raw_source` stage);
 *  - `list` returns only live inbox sources (not active/parked/dismissed/deleted ones);
 *  - accept flips status to `active` and writes an `update_element` op;
 *  - `setPriority` stores the right numeric value (label → number);
 *  - delete soft-deletes (`deletedAt` set, status `deleted`) + writes
 *    `soft_delete_element`, and the item drops out of `list`.
 */

import type { IsoTimestamp } from "@interleave/core";
import { priorityFromLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { InboxQuery } from "./inbox-query";
import { createRepositories, type Repositories } from "./index";
import { OperationLogRepository } from "./operation-log-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let inbox: InboxQuery;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  inbox = new InboxQuery(repos);
});

afterEach(() => {
  handle.sqlite.close();
});

/** Create an inbox source the way the DB service does (default priority C). */
function importInbox(title: string, priority = priorityFromLabel("C")) {
  return new SourceRepository(handle.db).create({
    title,
    priority,
    status: "inbox",
    stage: "raw_source",
  });
}

describe("InboxQuery (T012)", () => {
  it("creating a source lands it in inbox with the raw_source stage", () => {
    const { element } = importInbox("On the Measure of Intelligence");
    expect(element.status).toBe("inbox");
    expect(element.stage).toBe("raw_source");
    expect(element.type).toBe("source");

    const list = inbox.list();
    expect(list.map((i) => i.title)).toContain("On the Measure of Intelligence");
    const item = list.find((i) => i.id === element.id);
    expect(item?.priority).toBe(priorityFromLabel("C"));
    expect(item?.srcType).toBe("Manual note");
  });

  it("labels inbox sources from provenance instead of treating every source as a manual note", () => {
    const sources = new SourceRepository(handle.db);
    const manual = importInbox("Handwritten note").element;
    const web = sources.create({
      title: "Fetched article",
      priority: priorityFromLabel("C"),
      status: "inbox",
      stage: "raw_source",
      url: "https://example.com/post",
      canonicalUrl: "https://example.com/post",
      originalUrl: "https://example.com/post",
      snapshotKey: "sources/web/cleaned.html",
      sourceType: "article",
    }).element;
    const pdf = sources.create({
      title: "Imported PDF",
      priority: priorityFromLabel("C"),
      status: "inbox",
      stage: "raw_source",
      snapshotKey: "sources/pdf/original.pdf",
    }).element;

    const byId = new Map(inbox.list().map((item) => [item.id, item.srcType]));
    expect(byId.get(manual.id)).toBe("Manual note");
    expect(byId.get(web.id)).toBe("Web article");
    expect(byId.get(pdf.id)).toBe("PDF");
  });

  it("list returns only live inbox sources (not active / dismissed / deleted)", () => {
    const elements = new ElementRepository(handle.db);
    const inboxOne = importInbox("Inbox one").element;
    const accepted = importInbox("Accepted").element;
    const dismissed = importInbox("Dismissed").element;
    const deleted = importInbox("Deleted").element;

    elements.update(accepted.id, { status: "active" });
    elements.update(dismissed.id, { status: "dismissed" });
    elements.softDelete(deleted.id);

    const titles = inbox.list().map((i) => i.title);
    expect(titles).toEqual(["Inbox one"]);
    expect(titles).not.toContain("Accepted");
    expect(titles).not.toContain("Dismissed");
    expect(titles).not.toContain("Deleted");
    void inboxOne;
  });

  it("list does NOT include non-source inbox elements", () => {
    const elements = new ElementRepository(handle.db);
    importInbox("A source");
    elements.create({
      type: "task",
      status: "inbox",
      stage: "rough_topic",
      priority: 0.5,
      title: "A task in inbox",
    });
    expect(inbox.list().map((i) => i.title)).toEqual(["A source"]);
  });

  it("get returns the detail for an inbox source and null for a non-inbox one", () => {
    const elements = new ElementRepository(handle.db);
    const { element } = importInbox("Readable");
    const detail = inbox.get(element.id);
    expect(detail?.summary.title).toBe("Readable");
    expect(detail?.provenance.elementId).toBe(element.id);

    elements.update(element.id, { status: "active" });
    expect(inbox.get(element.id)).toBeNull();
  });

  it("get surfaces canonical + original URL provenance when present (T014)", () => {
    const { element } = new SourceRepository(handle.db).create({
      title: "Provenance source",
      priority: priorityFromLabel("C"),
      status: "inbox",
      stage: "raw_source",
      url: "https://example.com/a?utm_source=x",
      canonicalUrl: "https://example.com/a",
      originalUrl: "https://example.com/a?utm_source=x",
      accessedAt: "2026-05-29T10:00:00.000Z",
    });
    const detail = inbox.get(element.id);
    expect(detail?.provenance.canonicalUrl).toBe("https://example.com/a");
    expect(detail?.provenance.originalUrl).toBe("https://example.com/a?utm_source=x");
    expect(detail?.provenance.accessedAt).toBe("2026-05-29T10:00:00.000Z");
  });

  it("accept flips status to active and writes update_element", () => {
    const elements = new ElementRepository(handle.db);
    const ops = new OperationLogRepository(handle.db);
    const { element } = importInbox("To activate");

    elements.update(element.id, { status: "active" });

    expect(elements.findById(element.id)?.status).toBe("active");
    expect(ops.listForElement(element.id).map((e) => e.opType)).toContain("update_element");
    // It has left the inbox.
    expect(inbox.list().map((i) => i.id)).not.toContain(element.id);
  });

  it("keepForLater flips status to parked and leaves the inbox", () => {
    const elements = new ElementRepository(handle.db);
    const { element } = importInbox("To keep");
    elements.update(element.id, {
      status: "parked",
      dueAt: null,
      parkedAt: "2026-06-09T10:00:00.000Z" as IsoTimestamp,
    });
    expect(elements.findById(element.id)).toMatchObject({
      status: "parked",
      parkedAt: "2026-06-09T10:00:00.000Z",
    });
    expect(inbox.list().map((i) => i.id)).not.toContain(element.id);
  });

  it("setPriority stores the right numeric value (label → number)", () => {
    const elements = new ElementRepository(handle.db);
    const { element } = importInbox("Reprioritize");
    elements.update(element.id, { priority: priorityFromLabel("A") });
    const updated = elements.findById(element.id);
    expect(updated?.priority).toBe(priorityFromLabel("A"));
    // The source stays in the inbox (priority does not change status).
    expect(inbox.list().find((i) => i.id === element.id)?.priority).toBe(priorityFromLabel("A"));
  });

  it("delete soft-deletes (deletedAt + status deleted) + writes soft_delete_element and drops from list", () => {
    const elements = new ElementRepository(handle.db);
    const ops = new OperationLogRepository(handle.db);
    const { element } = importInbox("To delete");

    const deleted = elements.softDelete(element.id);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.status).toBe("deleted");
    // The row is NOT physically removed (soft delete).
    expect(elements.findById(element.id)).not.toBeNull();
    expect(ops.listForElement(element.id).map((e) => e.opType)).toContain("soft_delete_element");
    expect(inbox.list().map((i) => i.id)).not.toContain(element.id);
    expect(inbox.get(element.id)).toBeNull();
  });

  it("summary surfaces a body preview, full body doc, and full untruncated body text", () => {
    const { element } = importInbox("With body");
    const prosemirrorJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "blk-body" },
          content: [{ type: "text", text: "First paragraph." }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "blk-tail" },
          content: [{ type: "text", text: "Formatted tail sentinel." }],
        },
      ],
    };
    const longTail = `First paragraph.\n\n${"word ".repeat(900)}final word`;
    repos.documents.upsert({
      elementId: element.id,
      prosemirrorJson,
      plainText: longTail,
    });
    const detail = inbox.get(element.id);
    expect(detail?.summary.charCount).toBeGreaterThan(0);
    expect(detail?.bodyDoc).toEqual(prosemirrorJson);
    expect(detail?.bodyText).toBe(longTail);
    expect(detail?.bodyText).toContain("final word");
    expect(detail?.bodyPreview).toContain("First paragraph");
    expect(detail?.bodyPreview?.length).toBeLessThan(longTail.length);
    expect(detail?.summary.previewSnippet).toContain("First paragraph");
  });

  it("returns a formatted body doc even when the plain-text mirror is empty", () => {
    const { element } = importInbox("Empty formatted body");
    const prosemirrorJson = {
      type: "doc",
      content: [],
    };
    repos.documents.upsert({
      elementId: element.id,
      prosemirrorJson,
      plainText: "",
    });

    const detail = inbox.get(element.id);
    expect(detail?.bodyDoc).toEqual(prosemirrorJson);
    expect(detail?.bodyText).toBe("");
    expect(detail?.bodyPreview).toBeNull();
  });
});

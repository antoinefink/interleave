import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "./channels";

describe("IPC_CHANNELS", () => {
  it("keeps channel values unique", () => {
    const values = Object.values(IPC_CHANNELS);

    expect(new Set(values).size).toBe(values.length);
  });

  it("pins trusted-boundary channels and never exposes a generic SQL channel", () => {
    const values = Object.values(IPC_CHANNELS);

    expect(IPC_CHANNELS.appHealth).toBe("app:health");
    expect(IPC_CHANNELS.dbGetStatus).toBe("db:getStatus");
    expect(IPC_CHANNELS.documentsSave).toBe("documents:save");
    expect(IPC_CHANNELS.jobsUpdated).toBe("jobs:updated");
    expect(IPC_CHANNELS.menuShowShortcuts).toBe("menu:showShortcuts");
    expect(IPC_CHANNELS.menuCreateBackup).toBe("menu:createBackup");
    expect(values).not.toContain("db:query");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const send = vi.fn();
  return {
    send,
    focusedWindow: { webContents: { send } },
    fallbackWindow: { webContents: { send } },
    getFocusedWindow: vi.fn(),
    getAllWindows: vi.fn(),
    buildFromTemplate: vi.fn((template) => template),
    setApplicationMenu: vi.fn(),
  };
});

vi.mock("electron", () => ({
  app: { name: "Interleave" },
  BrowserWindow: {
    getFocusedWindow: electron.getFocusedWindow,
    getAllWindows: electron.getAllWindows,
  },
  Menu: {
    buildFromTemplate: electron.buildFromTemplate,
    setApplicationMenu: electron.setApplicationMenu,
  },
}));

import { IPC_CHANNELS } from "../shared/channels";
import { installApplicationMenu } from "./menu";

function installedTemplate(): Array<{ label?: string; role?: string; submenu?: unknown[] }> {
  return electron.setApplicationMenu.mock.calls[0]?.[0] as never;
}

function menuItem(label: string) {
  for (const section of installedTemplate()) {
    const submenu = section.submenu ?? [];
    const found = submenu.find((item) => (item as { label?: string }).label === label);
    if (found) return found as { click: () => void; accelerator?: string };
  }
  throw new Error(`missing menu item ${label}`);
}

beforeEach(() => {
  electron.send.mockReset();
  electron.getFocusedWindow.mockReset();
  electron.getAllWindows.mockReset();
  electron.buildFromTemplate.mockClear();
  electron.setApplicationMenu.mockClear();
});

describe("installApplicationMenu", () => {
  it("installs native menu sections and wires backup/shortcut commands to the focused renderer", () => {
    electron.getFocusedWindow.mockReturnValue(electron.focusedWindow);
    electron.getAllWindows.mockReturnValue([electron.fallbackWindow]);

    installApplicationMenu();

    expect(electron.buildFromTemplate).toHaveBeenCalledOnce();
    expect(electron.setApplicationMenu).toHaveBeenCalledWith(installedTemplate());
    expect(installedTemplate().map((section) => section.label ?? section.role)).toContain("File");
    expect(installedTemplate().map((section) => section.label ?? section.role)).toContain("Edit");
    expect(installedTemplate().map((section) => section.label ?? section.role)).toContain("View");
    expect(installedTemplate().map((section) => section.label ?? section.role)).toContain("Window");
    expect(installedTemplate().map((section) => section.label ?? section.role)).toContain("help");

    menuItem("Back up…").click();
    menuItem("Keyboard shortcuts").click();

    expect(electron.send).toHaveBeenNthCalledWith(1, IPC_CHANNELS.menuCreateBackup);
    expect(electron.send).toHaveBeenNthCalledWith(2, IPC_CHANNELS.menuShowShortcuts);
    expect(menuItem("Back up…").accelerator).toBe("CmdOrCtrl+B");
    expect(menuItem("Keyboard shortcuts").accelerator).toBe("CmdOrCtrl+/");
  });

  it("falls back to the first window when no focused renderer exists", () => {
    electron.getFocusedWindow.mockReturnValue(null);
    electron.getAllWindows.mockReturnValue([electron.fallbackWindow]);

    installApplicationMenu();
    menuItem("Keyboard shortcuts").click();

    expect(electron.send).toHaveBeenCalledWith(IPC_CHANNELS.menuShowShortcuts);
  });
});

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { notifyDesktop, notifyTurnComplete, resolveNotificationSettings, ringBell, type SpawnLike } from "../src/notifications.js";

describe("notification settings", () => {
  it("defaults the bell on and desktop notifications off", () => {
    expect(resolveNotificationSettings({})).toEqual({ bell: true, desktop: false });
  });

  it("honors explicit opt-out and opt-in flags", () => {
    expect(resolveNotificationSettings({ ALFACODE_NOTIFY_BELL: "0" }).bell).toBe(false);
    expect(resolveNotificationSettings({ ALFACODE_NOTIFY_DESKTOP: "1" }).desktop).toBe(true);
    expect(resolveNotificationSettings({ ALFACODE_NOTIFY_BELL: "false" }).bell).toBe(false);
    expect(resolveNotificationSettings({ ALFACODE_NOTIFY_DESKTOP: "true" }).desktop).toBe(true);
  });

  it("falls back to the default for an unrecognized value", () => {
    expect(resolveNotificationSettings({ ALFACODE_NOTIFY_BELL: "sometimes" }).bell).toBe(true);
  });
});

describe("ringBell", () => {
  it("writes the terminal bell control character", () => {
    const write = vi.fn();
    ringBell({ write });
    expect(write).toHaveBeenCalledWith("");
  });
});

function fakeChildProcess(): EventEmitter & { unref: () => void } {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  return child;
}

describe("notifyDesktop", () => {
  it("shells out to osascript on macOS with a quoted display-notification script", () => {
    const child = fakeChildProcess();
    const run = vi.fn((_command: string, _args: readonly string[], _options: unknown) => child);
    notifyDesktop("AlfaCode", "Turn finished", "darwin", run as unknown as SpawnLike);
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args, options] = run.mock.calls[0]!;
    expect(command).toBe("osascript");
    expect(args).toEqual(["-e", 'display notification "Turn finished" with title "AlfaCode"']);
    expect(options).toMatchObject({ stdio: "ignore" });
    expect(child.unref).toHaveBeenCalled();
  });

  it("escapes quotes and strips newlines before shelling out", () => {
    const child = fakeChildProcess();
    const run = vi.fn((_command: string, _args: readonly string[], _options: unknown) => child);
    notifyDesktop('Say "hi"', "line one\nline two", "darwin", run as unknown as SpawnLike);
    const [, args] = run.mock.calls[0]!;
    expect(args).toEqual(["-e", 'display notification "line one line two" with title "Say \\"hi\\""']);
  });

  it("does nothing on non-macOS platforms", () => {
    const run = vi.fn();
    notifyDesktop("AlfaCode", "Turn finished", "linux", run as unknown as SpawnLike);
    expect(run).not.toHaveBeenCalled();
  });

  it("never throws when the spawn call itself throws", () => {
    const run = vi.fn(() => {
      throw new Error("spawn ENOENT");
    }) as unknown as SpawnLike;
    expect(() => notifyDesktop("AlfaCode", "Turn finished", "darwin", run)).not.toThrow();
  });

  it("swallows an async spawn error event", () => {
    const child = fakeChildProcess();
    const run = vi.fn(() => child) as unknown as SpawnLike;
    notifyDesktop("AlfaCode", "Turn finished", "darwin", run);
    expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow();
  });
});

describe("notifyTurnComplete", () => {
  it("rings the bell and skips the desktop notification when only bell is enabled", () => {
    const write = vi.fn();
    const run = vi.fn();
    notifyTurnComplete({
      settings: { bell: true, desktop: false },
      title: "AlfaCode",
      body: "Turn finished",
      target: { write },
      platform: "darwin",
      run: run as unknown as SpawnLike,
    });
    expect(write).toHaveBeenCalledWith("");
    expect(run).not.toHaveBeenCalled();
  });

  it("fires the desktop notification when enabled, independent of the bell setting", () => {
    const write = vi.fn();
    const child = fakeChildProcess();
    const run = vi.fn(() => child) as unknown as SpawnLike;
    notifyTurnComplete({
      settings: { bell: false, desktop: true },
      title: "AlfaCode",
      body: "Permission needed",
      target: { write },
      platform: "darwin",
      run,
    });
    expect(write).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never throws even when the bell target write throws", () => {
    const target = { write: vi.fn(() => { throw new Error("EPIPE"); }) };
    expect(() => notifyTurnComplete({ settings: { bell: true, desktop: false }, title: "AlfaCode", body: "Turn finished", target })).not.toThrow();
  });
});

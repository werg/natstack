import { describe, expect, it, vi } from "vitest";
import { HeadlessHost } from "./headlessHost.js";
import type { HeadlessHostConfig } from "./config.js";

function config(): HeadlessHostConfig {
  return {
    serverUrl: "http://127.0.0.1:3030",
    auth: { kind: "token", token: "token" },
    label: "Headless Test",
    clientSessionId: "headless-test",
    maxPanels: 8,
    idleUnloadMs: 60_000,
    cacheDir: "/tmp/natstack-test-cache",
    profileDir: "/tmp/natstack-test-profile",
  };
}

describe("HeadlessHost lifecycle guards", () => {
  it("coalesces duplicate browser-gone signals for the active generation", async () => {
    const host = new HeadlessHost(config());
    let resolveRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    const recoverBrowser = vi.fn(() => recovery);
    Object.assign(host as unknown as { browserGeneration: number; recoverBrowser: () => void }, {
      browserGeneration: 1,
      recoverBrowser,
    });

    const first = (host as unknown as { handleBrowserGone(generation: number): Promise<void> })
      .handleBrowserGone(1);
    const second = (host as unknown as { handleBrowserGone(generation: number): Promise<void> })
      .handleBrowserGone(1);

    expect(recoverBrowser).toHaveBeenCalledTimes(1);
    resolveRecovery();
    await Promise.all([first, second]);
  });

  it("ignores stale browser-gone signals from an older generation", async () => {
    const host = new HeadlessHost(config());
    const recoverBrowser = vi.fn();
    Object.assign(host as unknown as { browserGeneration: number; recoverBrowser: () => void }, {
      browserGeneration: 2,
      recoverBrowser,
    });

    await (host as unknown as { handleBrowserGone(generation: number): Promise<void> })
      .handleBrowserGone(1);

    expect(recoverBrowser).not.toHaveBeenCalled();
  });

  it("releases and unloads a panel when a load intent fails", async () => {
    const host = new HeadlessHost(config());
    const processIntent = vi.fn(async () => {
      throw new Error("load failed");
    });
    const releaseAndUnload = vi.fn(async () => undefined);
    Object.assign(
      host as unknown as {
        processIntent: typeof processIntent;
        releaseAndUnload: typeof releaseAndUnload;
        intentQueue: Promise<void>;
      },
      {
        processIntent,
        releaseAndUnload,
        intentQueue: Promise.resolve(),
      }
    );

    (host as unknown as { enqueueIntents(produce: () => unknown[]): void }).enqueueIntents(() => [
      {
        kind: "load",
        slotId: "panel-1",
        runtimeEntityId: "panel:entry-1",
        connectionId: "lease-1",
      },
    ]);
    await (host as unknown as { intentQueue: Promise<void> }).intentQueue;

    expect(releaseAndUnload).toHaveBeenCalledWith("panel-1", "load failed");
  });
});

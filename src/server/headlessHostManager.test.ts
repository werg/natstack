import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenManager } from "@natstack/shared/tokenManager";
import { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import { HeadlessHostManager } from "./headlessHostManager.js";

/**
 * Always-on headless host: startKeepAlive spawns one at boot and re-spawns it
 * when the child exits, so a programmatic panel always has a default CDP host
 * to lease to. Spawn failures degrade gracefully (no throw, no hang).
 */
describe("HeadlessHostManager keep-alive", () => {
  let coordinator: PanelRuntimeCoordinator;
  let children: MockChild[];

  class MockChild extends EventEmitter {
    exitCode: number | null = null;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    send = vi.fn();
    kill = vi.fn((_signal?: string) => {
      this.exitCode = 0;
      // Defer the exit event so listeners attached after construction still fire.
      queueMicrotask(() => this.emit("exit", 0));
      return true;
    });
  }

  const tokenManager = {
    ensureToken: vi.fn(() => "token"),
  } as unknown as TokenManager;

  // Registering a headless client makes coordinator.getDefaultCdpHostClient
  // resolve — i.e. the spawned host "connected".
  const registerHeadless = (sessionId: string) => {
    coordinator.registerClient({
      clientSessionId: sessionId,
      hostConnectionId: sessionId,
      label: "Headless",
      platform: "headless",
      loadOnLeaseAssignment: true,
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    coordinator = new PanelRuntimeCoordinator();
    children = [];
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function makeManager(opts: { connect: boolean }) {
    const spawnFn = vi.fn((_entry: string): ChildProcess => {
      const child = new MockChild();
      children.push(child);
      if (opts.connect) registerHeadless(`headless-${children.length}`);
      return child as unknown as ChildProcess;
    });
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: {
        enabled: true,
        keepAlive: true,
        entryPath: "/fake/entry.js",
        spawnTimeoutMs: 1_000,
      },
      spawnFn,
    });
    return { manager, spawnFn };
  }

  it("spawns a host on startKeepAlive", async () => {
    const { manager, spawnFn } = makeManager({ connect: true });
    manager.startKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("re-spawns the host after the child exits", async () => {
    const { manager, spawnFn } = makeManager({ connect: true });
    manager.startKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    // Simulate the host process dying — and its client deregistering, so the
    // coordinator no longer reports an available default host.
    const first = children[0];
    if (!first) throw new Error("expected a spawned child");
    coordinator.unregisterClient("headless-1");
    first.exitCode = 1;
    first.emit("exit", 1);

    // Respawn is scheduled with a small backoff.
    await vi.advanceTimersByTimeAsync(300);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    await manager.stop();
  });

  it("does not re-spawn after stop()", async () => {
    const { manager, spawnFn } = makeManager({ connect: true });
    manager.startKeepAlive();
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);

    await manager.stop();
    spawnFn.mockClear();

    // Any pending exit/respawn must be a no-op once stopped.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("degrades gracefully and disables auto-spawn after repeated failures", async () => {
    // Host never connects → each spawn times out and records a failure. After
    // maxRestarts the manager disables itself instead of looping forever.
    const spawnFn = vi.fn((_entry: string): ChildProcess => {
      const child = new MockChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const manager = new HeadlessHostManager({
      tokenManager,
      coordinator,
      isHostAvailable: () => true,
      getServerUrl: () => "http://127.0.0.1:0",
      config: {
        enabled: true,
        keepAlive: true,
        entryPath: "/fake/entry.js",
        spawnTimeoutMs: 100,
        maxRestarts: 2,
      },
      spawnFn,
    });

    manager.startKeepAlive();
    // Drive several spawn/timeout/backoff cycles; must settle (disabled), not hang.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    // Disabled after maxRestarts: spawn count is bounded, not unbounded.
    expect(spawnFn.mock.calls.length).toBeLessThanOrEqual(2);
    await manager.stop();
  });
});

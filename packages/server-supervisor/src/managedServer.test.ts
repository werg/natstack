import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessAdapter } from "@natstack/process-adapter";
import { ManagedServer } from "./managedServer.js";

class FakeProcess extends EventEmitter implements ProcessAdapter {
  readonly messages: unknown[] = [];
  readonly kill = vi.fn(() => true);
  readonly stdout = null;
  readonly stderr = null;
  readonly pid = 123;

  postMessage(msg: unknown): void {
    this.messages.push(msg);
  }
}

describe("ManagedServer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves readiness from the child IPC payload", async () => {
    const proc = new FakeProcess();
    const manager = new ManagedServer({
      spawn: () => proc,
      onCrash: vi.fn(),
    });

    const ready = manager.start();
    proc.emit("message", {
      type: "ready",
      gatewayPort: 3131,
      workerdPort: 4141,
      adminToken: "admin",
      shellToken: "shell",
    });

    await expect(ready).resolves.toEqual({
      gatewayPort: 3131,
      workerdPort: 4141,
      adminToken: "admin",
      shellToken: "shell",
    });
    expect(manager.getPorts()?.gatewayPort).toBe(3131);
  });

  it("clears the forced-kill timer after clean shutdown", async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    const manager = new ManagedServer({
      spawn: () => proc,
      onCrash: vi.fn(),
    });
    const ready = manager.start();
    proc.emit("message", { type: "ready", gatewayPort: 3131, adminToken: "admin" });
    await ready;

    const shutdown = manager.shutdown();
    proc.emit("exit", 0);
    await shutdown;
    await vi.advanceTimersByTimeAsync(5000);

    expect(proc.messages).toContainEqual({ type: "shutdown" });
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("responds to correlated IPC requests", async () => {
    const proc = new FakeProcess();
    const manager = new ManagedServer({
      spawn: () => proc,
      onCrash: vi.fn(),
      onIpcRequest: async () => ({ workspaces: [{ name: "a" }] }),
    });
    const ready = manager.start();
    proc.emit("message", { type: "ready", gatewayPort: 3131, adminToken: "admin" });
    await ready;

    proc.emit("message", { type: "workspace-list-request", id: "req-1" });
    await vi.waitFor(() => {
      expect(proc.messages).toContainEqual({
        type: "workspace-list-response",
        id: "req-1",
        workspaces: [{ name: "a" }],
      });
    });
  });

  it("shuts down and clears an unready child that reports startup error", async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    const manager = new ManagedServer({
      spawn: () => proc,
      onCrash: vi.fn(),
    });

    const started = manager.start();
    const expectedFailure = expect(started).rejects.toThrow(/bad workspace/);
    proc.emit("message", { type: "error", message: "bad workspace" });
    await vi.advanceTimersByTimeAsync(5000);

    await expectedFailure;
    expect(proc.messages).toContainEqual({ type: "shutdown" });
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(manager.getPorts()).toBeNull();
  });

  it("clears an unready child that exits during startup without waiting for kill timer", async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    const manager = new ManagedServer({
      spawn: () => proc,
      onCrash: vi.fn(),
    });

    const started = manager.start();
    const expectedFailure = expect(started).rejects.toThrow(/exited during startup/);
    proc.emit("exit", 1);

    await expectedFailure;
    await vi.advanceTimersByTimeAsync(5000);
    expect(proc.messages).toEqual([]);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(manager.getPorts()).toBeNull();
  });

  it("restarts unexpected exits until the crash window is exceeded", async () => {
    const first = new FakeProcess();
    const second = new FakeProcess();
    const onRestart = vi.fn();
    const onCrash = vi.fn();
    const manager = new ManagedServer({
      spawn: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
      onRestart,
      onCrash,
    });
    const ready = manager.start();
    first.emit("message", { type: "ready", gatewayPort: 3131, adminToken: "admin" });
    await ready;

    first.emit("exit", 1);
    second.emit("message", { type: "ready", gatewayPort: 4141, adminToken: "admin2" });

    await vi.waitFor(() => {
      expect(onRestart).toHaveBeenCalledWith({ gatewayPort: 4141, adminToken: "admin2" });
    });
    expect(onCrash).not.toHaveBeenCalled();
  });
});

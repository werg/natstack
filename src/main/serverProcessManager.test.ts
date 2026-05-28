import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessAdapter } from "@natstack/process-adapter";
import { ServerProcessManager } from "./serverProcessManager.js";

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

class FakeStream extends EventEmitter {
  readable = true;
  read(): null {
    return null;
  }
  setEncoding(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  isPaused(): boolean {
    return false;
  }
  pipe<T extends NodeJS.WritableStream>(destination: T): T {
    return destination;
  }
  unpipe(): this {
    return this;
  }
  unshift(): void {}
  wrap(): this {
    return this;
  }
  write(_chunk: unknown): boolean {
    return true;
  }
}

function createManager(proc: FakeProcess): ServerProcessManager {
  const manager = new ServerProcessManager({
    wsDir: "/workspace",
    appRoot: "/app",
    onCrash: vi.fn(),
  });
  (manager as unknown as { proc: ProcessAdapter | null }).proc = proc;
  return manager;
}

describe("ServerProcessManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears the forced-kill timer after a clean shutdown exit", async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    const manager = createManager(proc);

    const shutdown = manager.shutdown();
    proc.emit("exit", 0);
    await shutdown;
    await vi.advanceTimersByTimeAsync(5000);

    expect(proc.messages).toEqual([{ type: "shutdown" }]);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("kills the captured process when graceful shutdown times out", async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    const manager = createManager(proc);

    const shutdown = manager.shutdown();
    await vi.advanceTimersByTimeAsync(5000);
    await shutdown;

    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it("shuts down a spawned process when startup reports an error before ready", async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    const manager = new ServerProcessManager({
      wsDir: "/workspace",
      appRoot: "/app",
      onCrash: vi.fn(),
    });
    vi.spyOn(manager as unknown as { spawn: () => ProcessAdapter }, "spawn").mockReturnValue(proc);

    const start = manager.start().then(
      () => null,
      (error: unknown) => error
    );
    proc.emit("message", { type: "error", message: "Gateway port is already in use" });
    await vi.advanceTimersByTimeAsync(5000);

    await expect(start).resolves.toEqual(expect.any(Error));
    await expect(start).resolves.toMatchObject({
      message: expect.stringContaining("Gateway port is already in use"),
    });
    expect(proc.messages).toEqual([{ type: "shutdown" }]);
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect((manager as unknown as { proc: ProcessAdapter | null }).proc).toBeNull();
  });

  it("does not wait for shutdown when the process already exited during startup", async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    const manager = new ServerProcessManager({
      wsDir: "/workspace",
      appRoot: "/app",
      onCrash: vi.fn(),
    });
    vi.spyOn(manager as unknown as { spawn: () => ProcessAdapter }, "spawn").mockReturnValue(proc);

    const start = manager.start().then(
      () => null,
      (error: unknown) => error
    );
    proc.emit("exit", 1);

    await expect(start).resolves.toMatchObject({
      message: "Server exited during startup with code 1",
    });
    expect(proc.messages).toEqual([]);
    expect(proc.kill).not.toHaveBeenCalled();
    expect((manager as unknown as { proc: ProcessAdapter | null }).proc).toBeNull();
  });

  it("keeps forwarding startup stderr even when startup fails", async () => {
    vi.useFakeTimers();
    const proc = new FakeProcess();
    const stderr = new FakeStream();
    (proc as unknown as { stderr: NodeJS.ReadableStream }).stderr =
      stderr as unknown as NodeJS.ReadableStream;
    const manager = new ServerProcessManager({
      wsDir: "/workspace",
      appRoot: "/app",
      onCrash: vi.fn(),
    });
    vi.spyOn(manager as unknown as { spawn: () => ProcessAdapter }, "spawn").mockReturnValue(proc);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const start = manager.start().then(
      () => null,
      (error: unknown) => error
    );
    stderr.emit("data", Buffer.from("failure details"));
    proc.emit("message", { type: "error", message: "startup failed" });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(start).resolves.toMatchObject({
      message: expect.stringContaining("startup failed"),
    });

    expect(write).toHaveBeenCalledWith("[server:err] failure details");
    write.mockRestore();
  });
});

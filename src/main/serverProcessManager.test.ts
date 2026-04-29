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
});

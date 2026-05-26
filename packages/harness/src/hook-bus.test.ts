import { describe, it, expect, vi } from "vitest";

import { HookBus } from "./hook-bus.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("HookBus.emitEvent", () => {
  it("awaits async listeners in registration order", async () => {
    const bus = new HookBus();
    const seen: string[] = [];
    bus.on("event", async (e) => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(`a:${e.type}`);
    });
    bus.on("event", (e) => {
      seen.push(`b:${e.type}`);
    });
    await bus.emitEvent({ type: "agent_start" } as any);
    expect(seen).toEqual(["a:agent_start", "b:agent_start"]);
  });

  it("raises throwing listeners and does not dispatch to later listeners", async () => {
    const bus = new HookBus();
    const seen: string[] = [];
    bus.on("event", () => { throw new Error("boom"); });
    bus.on("event", (e) => { seen.push(e.type); return; });
    await expect(bus.emitEvent({ type: "turn_start" } as any)).rejects.toThrow("boom");
    expect(seen).toEqual([]);
  });

  it("unsubscribes via the returned cleanup", async () => {
    const bus = new HookBus();
    const seen: string[] = [];
    const off = bus.on("event", (e) => { seen.push(e.type); });
    off();
    await bus.emitEvent({ type: "agent_start" } as any);
    expect(seen).toEqual([]);
  });

  it("fans NatStack system events to subscribers", async () => {
    const bus = new HookBus();
    const seen: any[] = [];
    bus.on("event", (e) => { seen.push(e); });
    await bus.emitEvent({
      type: "system_event",
      kind: "orphan_file_mutation_intent",
      intentEntryId: "intent-1",
      path: "src/app.ts",
    });
    expect(seen).toEqual([{
      type: "system_event",
      kind: "orphan_file_mutation_intent",
      intentEntryId: "intent-1",
      path: "src/app.ts",
    }]);
  });
});

describe("HookBus.emitTransformContext", () => {
  it("threads each listener's output into the next listener", async () => {
    const bus = new HookBus();
    bus.on("transform_context", (msgs) => [...msgs, { role: "system", content: "step1", timestamp: 1 } as any]);
    bus.on("transform_context", (msgs) => [...msgs, { role: "system", content: "step2", timestamp: 2 } as any]);
    const out = await bus.emitTransformContext([]);
    expect(out).toHaveLength(2);
    expect((out[0] as any).content).toBe("step1");
    expect((out[1] as any).content).toBe("step2");
  });

  it("ignores non-array returns and preserves the prior value", async () => {
    const bus = new HookBus();
    bus.on("transform_context", () => undefined as unknown as any[]);
    const out = await bus.emitTransformContext([{ role: "user", content: "hi", timestamp: 1 } as any]);
    expect(out).toHaveLength(1);
  });

  it("raises transform listener failures", async () => {
    const bus = new HookBus();
    bus.on("transform_context", () => { throw new Error("transform boom"); });
    await expect(bus.emitTransformContext([])).rejects.toThrow("transform boom");
  });

  it("clear() removes every registered listener", async () => {
    const bus = new HookBus();
    const seen: string[] = [];
    bus.on("event", (e) => { seen.push(e.type); });
    bus.on("transform_context", (msgs) => msgs);
    bus.clear();
    await bus.emitEvent({ type: "agent_start" } as any);
    expect(seen).toEqual([]);
  });

  it("passes abort signals to awaited listeners and reports active diagnostics", async () => {
    const bus = new HookBus();
    const gate = deferred<any[]>();
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    bus.on("transform_context", (_msgs, context) => {
      seenSignal = context?.signal;
      return gate.promise;
    });

    const pending = bus.emitTransformContext([], { signal: controller.signal });
    await Promise.resolve();

    expect(seenSignal).toBe(controller.signal);
    expect(bus.getDebugState().active).toMatchObject({
      hook: "transform_context",
      listenerIndex: 0,
      listenerCount: 1,
      aborted: false,
    });

    controller.abort();
    await expect(pending).rejects.toThrow("Hook listener aborted");
    expect(bus.getDebugState().active).toBeNull();
  });
});

describe("HookBus.emitBeforeProviderRequest", () => {
  it("raises provider request listener failures", async () => {
    const bus = new HookBus();
    bus.on("before_provider_request", () => { throw new Error("provider boom"); });
    await expect(
      bus.emitBeforeProviderRequest({ type: "before_provider_request" } as any),
    ).rejects.toThrow("provider boom");
  });
});

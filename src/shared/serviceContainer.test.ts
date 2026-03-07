/**
 * Tests for ServiceContainer — topological lifecycle management.
 */

import { describe, it, expect, vi } from "vitest";
import { ServiceContainer } from "./serviceContainer.js";
import type { ManagedService } from "./managedService.js";
import { rpcService } from "./managedService.js";

vi.mock("./devLog.js", () => ({
  createDevLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    verbose: vi.fn(),
    error: vi.fn(),
  }),
}));

function createService(
  name: string,
  deps: string[] = [],
  value: unknown = name,
  hooks?: { onStart?: () => void; onStop?: () => void }
): ManagedService {
  return {
    name,
    dependencies: deps,
    start: vi.fn(async () => {
      hooks?.onStart?.();
      return value;
    }),
    stop: vi.fn(async () => {
      hooks?.onStop?.();
    }),
  };
}

describe("ServiceContainer", () => {
  it("starts services in dependency order", async () => {
    const container = new ServiceContainer();
    const order: string[] = [];

    container.register(createService("c", ["a", "b"], "c", { onStart: () => order.push("c") }));
    container.register(createService("a", [], "a", { onStart: () => order.push("a") }));
    container.register(createService("b", ["a"], "b", { onStart: () => order.push("b") }));

    await container.startAll();

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("resolves dependency instances in start()", async () => {
    const container = new ServiceContainer();

    container.register(createService("db", [], { connection: "sqlite" }));
    container.register({
      name: "repo",
      dependencies: ["db"],
      start: vi.fn(async (resolve: <D>(name: string) => D) => {
        const db = resolve<{ connection: string }>("db");
        return { dbType: db.connection };
      }),
    });

    await container.startAll();

    expect(container.get("repo")).toEqual({ dbType: "sqlite" });
  });

  it("stops services in reverse dependency order", async () => {
    const container = new ServiceContainer();
    const order: string[] = [];

    container.register(createService("a", [], "a", { onStop: () => order.push("a") }));
    container.register(createService("b", ["a"], "b", { onStop: () => order.push("b") }));
    container.register(createService("c", ["b"], "c", { onStop: () => order.push("c") }));

    await container.startAll();
    await container.stopAll();

    expect(order).toEqual(["c", "b", "a"]);
  });

  it("cleans up on partial startup failure", async () => {
    const container = new ServiceContainer();
    const stopped: string[] = [];

    container.register(createService("a", [], "a", { onStop: () => stopped.push("a") }));
    container.register({
      name: "b",
      dependencies: ["a"],
      start: vi.fn(async () => { throw new Error("boom"); }),
      stop: vi.fn(),
    });

    await expect(container.startAll()).rejects.toThrow("boom");
    expect(stopped).toEqual(["a"]);
  });

  it("detects dependency cycles", async () => {
    const container = new ServiceContainer();

    container.register(createService("a", ["b"]));
    container.register(createService("b", ["a"]));

    await expect(container.startAll()).rejects.toThrow(/cycle/i);
  });

  it("detects missing dependencies", async () => {
    const container = new ServiceContainer();

    container.register(createService("a", ["missing"]));

    await expect(container.startAll()).rejects.toThrow(/missing/i);
  });

  it("throws on duplicate registration", () => {
    const container = new ServiceContainer();

    container.register(createService("a"));
    expect(() => container.register(createService("a"))).toThrow(/already registered/);
  });

  it("get() throws for unknown services", async () => {
    const container = new ServiceContainer();
    container.register(createService("a"));
    await container.startAll();

    expect(() => container.get("unknown")).toThrow(/not available/);
  });

  it("has() returns correct values", async () => {
    const container = new ServiceContainer();
    container.register(createService("a"));
    await container.startAll();

    expect(container.has("a")).toBe(true);
    expect(container.has("b")).toBe(false);
  });

  it("auto-registers service definitions on dispatcher", async () => {
    const registerService = vi.fn();
    const dispatcher = { registerService } as any;
    const container = new ServiceContainer(dispatcher);

    const serviceDef = { name: "myRpc", methods: {}, handler: vi.fn(), policy: { allowed: ["shell" as const] } };
    container.register({
      name: "a",
      start: vi.fn(async () => "a"),
      getServiceDefinition: () => serviceDef,
    });

    await container.startAll();

    expect(registerService).toHaveBeenCalledWith(serviceDef);
  });

  it("skips dispatcher registration when no getServiceDefinition", async () => {
    const registerService = vi.fn();
    const dispatcher = { registerService } as any;
    const container = new ServiceContainer(dispatcher);

    container.register(createService("a"));
    await container.startAll();

    expect(registerService).not.toHaveBeenCalled();
  });

  it("works without a dispatcher", async () => {
    const container = new ServiceContainer();

    container.register({
      name: "a",
      start: vi.fn(async () => "a"),
      getServiceDefinition: () => ({ name: "rpc", methods: {}, handler: vi.fn() } as any),
    });

    await container.startAll();
    expect(container.get("a")).toBe("a");
  });

  it("handles services without start() (definition-only)", async () => {
    const registerService = vi.fn();
    const dispatcher = { registerService } as any;
    const container = new ServiceContainer(dispatcher);

    const serviceDef = { name: "myRpc", methods: {}, handler: vi.fn(), policy: { allowed: ["shell" as const] } };
    container.register({
      name: "noStart",
      getServiceDefinition: () => serviceDef,
    });

    await container.startAll();

    expect(container.has("noStart")).toBe(true);
    expect(container.get("noStart")).toBeUndefined();
    expect(registerService).toHaveBeenCalledWith(serviceDef);
  });

  it("rpcService() creates a definition-only ManagedService", async () => {
    const registerService = vi.fn();
    const dispatcher = { registerService } as any;
    const container = new ServiceContainer(dispatcher);

    const def = { name: "events", methods: {}, handler: vi.fn(), policy: { allowed: ["shell" as const] } };
    const service = rpcService(def, ["db"]);

    expect(service.name).toBe("events");
    expect(service.dependencies).toEqual(["db"]);
    expect(service.start).toBeUndefined();
    expect(service.getServiceDefinition!()).toBe(def);

    // Works in container with dependency
    container.register(createService("db"));
    container.register(service);
    await container.startAll();

    expect(container.has("events")).toBe(true);
    expect(registerService).toHaveBeenCalledWith(def);
  });
});

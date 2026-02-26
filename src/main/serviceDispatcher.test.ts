/**
 * Tests for ServiceDispatcher and parseServiceMethod.
 *
 * Since the ServiceDispatcher class is not exported, we use vi.resetModules()
 * and dynamic imports to get a fresh singleton for each test group.
 */

import { ServiceError, parseServiceMethod } from "./serviceDispatcher.js";
import type { ServiceContext, ServiceHandler } from "./serviceDispatcher.js";

/**
 * Helper: dynamically import a fresh getServiceDispatcher (resets the singleton).
 */
async function freshDispatcher() {
  vi.resetModules();
  const mod = await import("./serviceDispatcher.js");
  return mod.getServiceDispatcher();
}

const ctx: ServiceContext = {
  callerId: "test",
  callerKind: "shell",
};

describe("ServiceDispatcher", () => {
  it("dispatch throws ServiceError when not initialized", async () => {
    const sd = await freshDispatcher();
    sd.register("echo", (async (_ctx, method, args) => ({ method, args })) as ServiceHandler);

    await expect(sd.dispatch(ctx, "echo", "hello", [])).rejects.toThrow(
      "Services not yet initialized"
    );
  });

  it("dispatch throws ServiceError for unknown service", async () => {
    const sd = await freshDispatcher();
    sd.markInitialized();

    await expect(sd.dispatch(ctx, "nope", "foo", [])).rejects.toThrow(
      "Unknown service"
    );
  });

  it("dispatch calls registered handler and returns result", async () => {
    const sd = await freshDispatcher();
    sd.register("echo", (async (_ctx, method, args) => ({ method, args })) as ServiceHandler);
    sd.markInitialized();

    const result = await sd.dispatch(ctx, "echo", "hello", ["world"]);
    expect(result).toEqual({ method: "hello", args: ["world"] });
  });

  it("dispatch wraps non-ServiceError exceptions in ServiceError", async () => {
    const sd = await freshDispatcher();
    sd.register("fail", (async () => {
      throw new Error("boom");
    }) as ServiceHandler);
    sd.markInitialized();

    try {
      await sd.dispatch(ctx, "fail", "run", []);
      expect.fail("should have thrown");
    } catch (err: any) {
      // Cannot use toBeInstanceOf(ServiceError) here because vi.resetModules()
      // causes the dynamically-imported class to differ from the static import.
      expect(err.name).toBe("ServiceError");
      expect(err.service).toBe("fail");
      expect(err.method).toBe("run");
      expect(err.message).toContain("boom");
    }
  });

  it("register warns on overwrite", async () => {
    const sd = await freshDispatcher();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const handler = (async () => {}) as ServiceHandler;
    sd.register("svc", handler);
    sd.register("svc", handler);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Overwriting handler for service: svc")
    );
    warnSpy.mockRestore();
  });

  it("hasService and getServices reflect registrations", async () => {
    const sd = await freshDispatcher();
    const handler = (async () => {}) as ServiceHandler;
    sd.register("alpha", handler);
    sd.register("beta", handler);

    expect(sd.hasService("alpha")).toBe(true);
    expect(sd.hasService("gamma")).toBe(false);
    expect(sd.getServices()).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });
});

describe("parseServiceMethod", () => {
  it("parses 'service.method' format", () => {
    expect(parseServiceMethod("bridge.createPanel")).toEqual({
      service: "bridge",
      method: "createPanel",
    });
  });

  it("returns null for input without a dot", () => {
    expect(parseServiceMethod("nomethod")).toBeNull();
  });
});

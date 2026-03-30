/**
 * Tests for ServiceDispatcher and parseServiceMethod.
 */

import { z } from "zod";
import {
  ServiceDispatcher,
  ServiceError,
  parseServiceMethod,
} from "@natstack/shared/serviceDispatcher";
import type { ServiceContext, ServiceHandler } from "@natstack/shared/serviceDispatcher";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";

const ctx: ServiceContext = {
  callerId: "test",
  callerKind: "shell",
};

function makeService(name: string, handler: ServiceHandler): ServiceDefinition {
  return {
    name,
    policy: { allowed: ["shell", "panel", "server"] },
    methods: {},
    handler,
  };
}

describe("ServiceDispatcher", () => {
  it("dispatch throws ServiceError when not initialized", async () => {
    const sd = new ServiceDispatcher();
    sd.registerService(makeService("echo", async (_ctx, method, args) => ({ method, args })));

    await expect(sd.dispatch(ctx, "echo", "hello", [])).rejects.toThrow(
      "Services not yet initialized"
    );
  });

  it("dispatch throws ServiceError for unknown service", async () => {
    const sd = new ServiceDispatcher();
    sd.markInitialized();

    await expect(sd.dispatch(ctx, "nope", "foo", [])).rejects.toThrow(
      "Unknown service"
    );
  });

  it("dispatch calls registered handler and returns result", async () => {
    const sd = new ServiceDispatcher();
    sd.registerService(makeService("echo", async (_ctx, method, args) => ({ method, args })));
    sd.markInitialized();

    const result = await sd.dispatch(ctx, "echo", "hello", ["world"]);
    expect(result).toEqual({ method: "hello", args: ["world"] });
  });

  it("dispatch wraps non-ServiceError exceptions in ServiceError", async () => {
    const sd = new ServiceDispatcher();
    sd.registerService(makeService("fail", async () => { throw new Error("boom"); }));
    sd.markInitialized();

    try {
      await sd.dispatch(ctx, "fail", "run", []);
      expect.fail("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(ServiceError);
      expect(err.service).toBe("fail");
      expect(err.method).toBe("run");
      expect(err.message).toContain("boom");
    }
  });

  it("registerService warns on overwrite", async () => {
    const sd = new ServiceDispatcher();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    sd.registerService(makeService("svc", async () => {}));
    sd.registerService(makeService("svc", async () => {}));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Overwriting handler for service: svc")
    );
    warnSpy.mockRestore();
  });

  it("hasService and getServices reflect registrations", async () => {
    const sd = new ServiceDispatcher();
    sd.registerService(makeService("alpha", async () => {}));
    sd.registerService(makeService("beta", async () => {}));

    expect(sd.hasService("alpha")).toBe(true);
    expect(sd.hasService("gamma")).toBe(false);
    expect(sd.getServices()).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("getServiceDefinitions returns all definitions", () => {
    const sd = new ServiceDispatcher();
    sd.registerService(makeService("a", async () => {}));
    sd.registerService(makeService("b", async () => {}));

    const defs = sd.getServiceDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name).sort()).toEqual(["a", "b"]);
  });

  it("getPolicy returns policy from definition", () => {
    const sd = new ServiceDispatcher();
    sd.registerService({
      name: "restricted",
      policy: { allowed: ["shell"] },
      methods: {},
      handler: async () => {},
    });

    expect(sd.getPolicy("restricted")).toEqual({ allowed: ["shell"] });
    expect(sd.getPolicy("nonexistent")).toBeUndefined();
  });

  it("validates args against Zod schema when method is defined", async () => {
    const sd = new ServiceDispatcher();
    sd.registerService({
      name: "typed",
      policy: { allowed: ["shell"] },
      methods: {
        greet: { args: z.tuple([z.string()]) },
      },
      handler: async (_ctx, _method, args) => `hello ${args[0]}`,
    });
    sd.markInitialized();

    // Valid args
    const result = await sd.dispatch(ctx, "typed", "greet", ["world"]);
    expect(result).toBe("hello world");

    // Invalid args
    await expect(sd.dispatch(ctx, "typed", "greet", [42])).rejects.toThrow(
      "Invalid args"
    );
  });

  it("getMethodSchema returns method definition", () => {
    const sd = new ServiceDispatcher();
    sd.registerService({
      name: "svc",
      policy: { allowed: ["shell"] },
      methods: {
        doStuff: { args: z.tuple([z.string()]), description: "does stuff" },
      },
      handler: async () => {},
    });

    const schema = sd.getMethodSchema("svc", "doStuff");
    expect(schema).toBeDefined();
    expect(schema?.description).toBe("does stuff");
    expect(sd.getMethodSchema("svc", "nope")).toBeUndefined();
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

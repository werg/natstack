/**
 * Tests for ServiceDefinition integration with ServiceDispatcher.
 */

import { z } from "zod";
import { ServiceDispatcher, type ServiceContext } from "../shared/serviceDispatcher.js";
import type { ServiceDefinition } from "../shared/serviceDefinition.js";

const ctx: ServiceContext = {
  callerId: "test",
  callerKind: "shell",
};

describe("ServiceDispatcher.registerService", () => {
  it("registers and dispatches a service definition", async () => {
    const sd = new ServiceDispatcher();

    const def: ServiceDefinition = {
      name: "echo",
      policy: { allowed: ["shell", "panel"] },
      methods: {
        greet: { args: z.tuple([z.string()]) },
      },
      handler: async (_ctx, method, args) => {
        if (method === "greet") return `hello ${args[0]}`;
        throw new Error(`Unknown method: ${method}`);
      },
    };

    sd.registerService(def);
    sd.markInitialized();

    const result = await sd.dispatch(ctx, "echo", "greet", ["world"]);
    expect(result).toBe("hello world");
  });

  it("validates args against Zod schema and rejects invalid args", async () => {
    const sd = new ServiceDispatcher();

    const def: ServiceDefinition = {
      name: "math",
      policy: { allowed: ["shell"] },
      methods: {
        add: { args: z.tuple([z.number(), z.number()]) },
      },
      handler: async (_ctx, _method, args) => (args[0] as number) + (args[1] as number),
    };

    sd.registerService(def);
    sd.markInitialized();

    // Valid args
    const result = await sd.dispatch(ctx, "math", "add", [1, 2]);
    expect(result).toBe(3);

    // Invalid args (strings instead of numbers)
    await expect(sd.dispatch(ctx, "math", "add", ["a", "b"])).rejects.toThrow(
      "Invalid args"
    );
  });

  it("allows unknown methods (no schema validation)", async () => {
    const sd = new ServiceDispatcher();

    const def: ServiceDefinition = {
      name: "flex",
      policy: { allowed: ["shell"] },
      methods: {
        known: { args: z.tuple([z.string()]) },
      },
      handler: async (_ctx, method, args) => ({ method, args }),
    };

    sd.registerService(def);
    sd.markInitialized();

    // Unknown method — no schema to validate against, passes through
    const result = await sd.dispatch(ctx, "flex", "unknown", [42]);
    expect(result).toEqual({ method: "unknown", args: [42] });
  });

  it("getPolicy returns policy for registered services", () => {
    const sd = new ServiceDispatcher();

    const def: ServiceDefinition = {
      name: "secret",
      policy: { allowed: ["server"] },
      methods: {},
      handler: async () => {},
    };

    sd.registerService(def);

    expect(sd.getPolicy("secret")).toEqual({ allowed: ["server"] });
    expect(sd.getPolicy("nonexistent")).toBeUndefined();
  });

  it("getServiceDefinitions returns all registered definitions", () => {
    const sd = new ServiceDispatcher();

    sd.registerService({
      name: "a",
      policy: { allowed: ["shell"] },
      methods: {},
      handler: async () => {},
    });

    sd.registerService({
      name: "b",
      policy: { allowed: ["panel"] },
      methods: {},
      handler: async () => {},
    });

    const defs = sd.getServiceDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs.map(d => d.name).sort()).toEqual(["a", "b"]);
  });

  it("getMethodSchema returns schema for known methods", () => {
    const sd = new ServiceDispatcher();
    const argsSchema = z.tuple([z.string()]);

    sd.registerService({
      name: "svc",
      policy: { allowed: ["shell"] },
      methods: {
        foo: { args: argsSchema, description: "test method" },
      },
      handler: async () => {},
    });

    const schema = sd.getMethodSchema("svc", "foo");
    expect(schema).toBeDefined();
    expect(schema!.description).toBe("test method");

    expect(sd.getMethodSchema("svc", "bar")).toBeUndefined();
    expect(sd.getMethodSchema("nonexistent", "foo")).toBeUndefined();
  });
});

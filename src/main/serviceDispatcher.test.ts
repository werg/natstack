/**
 * Tests for ServiceDispatcher and parseServiceMethod.
 */

import { z } from "zod";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  ServiceError,
  parseServiceMethod,
} from "@natstack/shared/serviceDispatcher";
import { fsMethods } from "@natstack/shared/serviceSchemas/fs";
import { gitMethods } from "@natstack/shared/serviceSchemas/git";
import type { ServiceContext, ServiceHandler } from "@natstack/shared/serviceDispatcher";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";

const ctx: ServiceContext = { caller: createVerifiedCaller("test", "shell") };

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

    await expect(sd.dispatch(ctx, "nope", "foo", [])).rejects.toThrow("Unknown service");
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
    sd.registerService(
      makeService("fail", async () => {
        throw new Error("boom");
      })
    );
    sd.markInitialized();

    try {
      await sd.dispatch(ctx, "fail", "run", []);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ServiceError);
      const serviceError = err as ServiceError;
      expect(serviceError.service).toBe("fail");
      expect(serviceError.method).toBe("run");
      expect(serviceError.message).toContain("boom");
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
    await expect(sd.dispatch(ctx, "typed", "greet", [42])).rejects.toThrow("Invalid args");
  });

  it("validates declared return schemas in dev/test", async () => {
    const sd = new ServiceDispatcher();
    sd.registerService({
      name: "typedReturn",
      policy: { allowed: ["shell"] },
      methods: {
        ok: { args: z.tuple([]), returns: z.object({ count: z.number() }) },
        bad: { args: z.tuple([]), returns: z.object({ count: z.number() }) },
      },
      handler: async (_ctx, method) => (method === "ok" ? { count: 1 } : { count: "one" }),
    });
    sd.markInitialized();

    await expect(sd.dispatch(ctx, "typedReturn", "ok", [])).resolves.toEqual({ count: 1 });
    await expect(sd.dispatch(ctx, "typedReturn", "bad", [])).rejects.toThrow(
      "Invalid return: invalid return count — expected number, received string"
    );
  });

  it("accepts null as the wire representation of declared void returns", async () => {
    const sd = new ServiceDispatcher();
    sd.registerService({
      name: "voidReturn",
      policy: { allowed: ["shell"] },
      methods: {
        okNull: { args: z.tuple([]), returns: z.void() },
        okUndefined: { args: z.tuple([]), returns: z.void() },
        badObject: { args: z.tuple([]), returns: z.object({ count: z.number() }) },
      },
      handler: async (_ctx, method) => {
        if (method === "okUndefined") return undefined;
        return null;
      },
    });
    sd.markInitialized();

    await expect(sd.dispatch(ctx, "voidReturn", "okNull", [])).resolves.toBeUndefined();
    await expect(sd.dispatch(ctx, "voidReturn", "okUndefined", [])).resolves.toBeUndefined();
    await expect(sd.dispatch(ctx, "voidReturn", "badObject", [])).rejects.toThrow(
      "Invalid return: invalid return (return) — expected object, received null"
    );
  });

  it("reports service, method, argument path, and a readable summary on validation failure", async () => {
    const sd = new ServiceDispatcher();
    sd.registerService({
      name: "workspace",
      policy: { allowed: ["shell"] },
      methods: {
        logs: { args: z.tuple([z.string(), z.object({ limit: z.number() })]) },
      },
      handler: async () => {},
    });
    sd.markInitialized();

    try {
      await sd.dispatch(ctx, "workspace", "logs", ["unit-1", { limit: "ten" }]);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ServiceError);
      const serviceError = err as ServiceError;
      expect(serviceError.service).toBe("workspace");
      expect(serviceError.method).toBe("logs");
      expect(serviceError.message).toContain("[workspace.logs]");
      expect(serviceError.message).toContain(
        "Invalid args: invalid argument [1].limit — expected number, received string"
      );
    }
  });

  it("normalizes wire args: pads omitted trailing optionals and maps null→undefined", async () => {
    const sd = new ServiceDispatcher();
    let seen: unknown[] = [];
    sd.registerService({
      name: "norm",
      policy: { allowed: ["shell"] },
      methods: {
        m: { args: z.tuple([z.string(), z.number().optional(), z.boolean().optional()]) },
      },
      handler: async (_ctx, _method, args) => {
        seen = args;
      },
    });
    sd.markInitialized();

    // Short array: trailing optionals padded with undefined
    await sd.dispatch(ctx, "norm", "m", ["a"]);
    expect(seen).toEqual(["a", undefined, undefined]);

    // null (JSON round-trip of undefined) becomes undefined at optional positions
    await sd.dispatch(ctx, "norm", "m", ["a", null, true]);
    expect(seen).toEqual(["a", undefined, true]);

    // null at a required position is left alone (and fails validation)
    await expect(sd.dispatch(ctx, "norm", "m", [null])).rejects.toThrow("Invalid args");
  });

  it("normalizes wire args for tuple overload unions", async () => {
    const sd = new ServiceDispatcher();
    let seen: unknown[] = [];
    sd.registerService({
      name: "overloaded",
      policy: { allowed: ["shell"] },
      methods: {
        readFile: {
          args: z.union([
            z.tuple([z.string(), z.string().optional()]),
            z.tuple([z.string(), z.string(), z.string().optional()]),
          ]),
        },
      },
      handler: async (_ctx, _method, args) => {
        seen = args;
      },
    });
    sd.markInitialized();

    await sd.dispatch(ctx, "overloaded", "readFile", ["skills/system-testing/SKILL.md"]);
    expect(seen).toEqual(["skills/system-testing/SKILL.md", undefined]);

    await sd.dispatch(ctx, "overloaded", "readFile", ["skills/system-testing/SKILL.md", null]);
    expect(seen).toEqual(["skills/system-testing/SKILL.md", undefined]);

    await sd.dispatch(ctx, "overloaded", "readFile", [
      "ctx-1",
      "skills/system-testing/SKILL.md",
      null,
    ]);
    expect(seen).toEqual(["ctx-1", "skills/system-testing/SKILL.md", undefined]);

    // Already-valid overload calls keep their original arity so service
    // handlers can continue applying caller-kind-specific conventions.
    await sd.dispatch(ctx, "overloaded", "readFile", ["ctx-1", "skills/system-testing/SKILL.md"]);
    expect(seen).toEqual(["ctx-1", "skills/system-testing/SKILL.md"]);

    await expect(sd.dispatch(ctx, "overloaded", "readFile", ["path", 42])).rejects.toThrow(
      "Invalid args"
    );
  });

  it("normalizes the real fs and context-git overloaded schemas", async () => {
    const sd = new ServiceDispatcher();
    const seen = new Map<string, unknown[]>();
    sd.registerService({
      name: "realFs",
      policy: { allowed: ["shell"] },
      methods: {
        readFile: fsMethods.readFile,
        glob: fsMethods.glob,
      },
      handler: async (_ctx, method, args) => {
        seen.set(`fs.${method}`, args);
        if (method === "glob") return [];
        return "";
      },
    });
    sd.registerService({
      name: "realGit",
      policy: { allowed: ["shell"] },
      methods: {
        contextDiff: gitMethods.contextDiff,
      },
      handler: async (_ctx, method, args) => {
        seen.set(`git.${method}`, args);
        return "";
      },
    });
    sd.markInitialized();

    await sd.dispatch(ctx, "realFs", "readFile", ["skills/system-testing/SKILL.md"]);
    expect(seen.get("fs.readFile")).toEqual(["skills/system-testing/SKILL.md", undefined]);

    await sd.dispatch(ctx, "realFs", "glob", ["skills", null]);
    expect(seen.get("fs.glob")).toEqual(["skills", undefined]);

    await sd.dispatch(ctx, "realGit", "contextDiff", ["panels/example", null]);
    expect(seen.get("git.contextDiff")).toEqual(["panels/example", undefined]);

    await sd.dispatch(ctx, "realGit", "contextDiff", ["ctx-1", "panels/example", null]);
    expect(seen.get("git.contextDiff")).toEqual(["ctx-1", "panels/example", undefined]);
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

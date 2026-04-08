import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { SERVER_SERVICE_NAMES } from "@natstack/rpc";
import { ServiceDispatcher, type ServiceContext } from "../../../packages/shared/src/serviceDispatcher.js";
import { createMetaService } from "./metaService.js";
import { panelRuntimeSurface } from "../../../workspace/packages/runtime/src/shared/runtimeSurface.panel.js";
import { workerRuntimeSurface } from "../../../workspace/packages/runtime/src/shared/runtimeSurface.worker.js";
import type { ServiceDefinition } from "../../../packages/shared/src/serviceDefinition.js";

const ctx: ServiceContext = { callerId: "panel:test", callerKind: "panel" };

function makeService(name: string): ServiceDefinition {
  return {
    name,
    description: `${name} service`,
    policy: { allowed: ["panel", "worker", "server"] },
    methods: {
      ping: {
        description: `Ping ${name}`,
        args: z.tuple([z.string()]),
      },
    },
    handler: vi.fn(async () => "ok"),
  };
}

describe("metaService", () => {
  let dispatcher: ServiceDispatcher;

  beforeEach(() => {
    dispatcher = new ServiceDispatcher();
    dispatcher.registerService(makeService("workspace"));
    dispatcher.registerService(makeService("workers"));
    dispatcher.registerService(createMetaService({
      dispatcher,
      runtimeSurfaces: {
        panel: panelRuntimeSurface,
        workerRuntime: workerRuntimeSurface,
      },
    }));
    dispatcher.markInitialized();
  });

  it("lists registered services", async () => {
    const result = await dispatcher.dispatch(ctx, "meta", "listServices", []) as Array<{ name: string }>;

    expect(result.map((item) => item.name)).toEqual(["workspace", "workers", "meta"]);
  });

  it("describes a named service with method metadata", async () => {
    const result = await dispatcher.dispatch(ctx, "meta", "describeService", ["workspace"]) as {
      name: string;
      methods: Record<string, { argsSchema: Record<string, unknown> }>;
    };

    expect(result.name).toBe("workspace");
    expect(result.methods["ping"]).toBeDefined();
    expect(result.methods["ping"]!.argsSchema).toMatchObject({ type: "array" });
  });

  it("returns the checked-in runtime surfaces", async () => {
    await expect(
      dispatcher.dispatch(ctx, "meta", "getRuntimeSurface", ["panel"]),
    ).resolves.toEqual(panelRuntimeSurface);

    await expect(
      dispatcher.dispatch(ctx, "meta", "getRuntimeSurface", ["workerRuntime"]),
    ).resolves.toEqual(workerRuntimeSurface);
  });

  it("is included in SERVER_SERVICE_NAMES for shell/electron forwarding", () => {
    expect((SERVER_SERVICE_NAMES as readonly string[]).includes("meta")).toBe(true);
  });
});

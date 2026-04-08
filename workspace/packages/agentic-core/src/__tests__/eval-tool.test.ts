import { describe, it, expect, vi } from "vitest";
import { buildEvalTool } from "../eval-tool.js";

describe("buildEvalTool", () => {
  it("binds help() to the requested runtime target", async () => {
    const rpc = {
      call: vi.fn(async (_target: string, method: string, ...args: unknown[]) => {
        if (method === "meta.listServices") return [{ name: "workspace" }];
        if (method === "meta.getRuntimeSurface") return { target: args[0] };
        throw new Error(`Unexpected method: ${method}`);
      }),
    };

    let capturedHelp: ((serviceName?: string) => Promise<unknown>) | undefined;
    const tool = buildEvalTool({
      sandbox: {
        rpc,
        db: { open: vi.fn() as any },
        loadImport: vi.fn(async () => ""),
      },
      rpc,
      runtimeTarget: "workerRuntime",
      getChatSandboxValue: () => ({}) as any,
      getScope: () => ({}),
      executeSandbox: vi.fn(async (_code, opts) => {
        capturedHelp = opts.bindings?.help as typeof capturedHelp;
        return { success: true, returnValue: "ok", consoleOutput: "" };
      }),
    });

    await tool.execute?.({ code: "return 1;" }, {
      stream: vi.fn(async () => undefined),
    } as any);

    expect(capturedHelp).toBeDefined();
    await expect(capturedHelp!()).resolves.toEqual({
      services: [{ name: "workspace" }],
      runtime: { target: "workerRuntime" },
    });
    expect(rpc.call).toHaveBeenCalledWith("main", "meta.getRuntimeSurface", "workerRuntime");
  });
});

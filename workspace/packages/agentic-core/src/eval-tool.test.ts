import { describe, expect, it } from "vitest";
import type { SandboxOptions, SandboxResult } from "@workspace/eval";
import type { MethodExecutionContext } from "@workspace/pubsub";
import { buildEvalTool } from "./eval-tool.js";

function createEvalTool(overrides: Partial<Parameters<typeof buildEvalTool>[0]> = {}) {
  const scope = overrides.getScope?.() ?? {};
  return buildEvalTool({
    sandbox: {
      rpc: {
        call: async () => ({}),
      },
      loadImport: async () => "",
    },
    rpc: {
      call: async () => ({}),
    },
    runtimeTarget: "panel",
    getChatSandboxValue: () => ({
      publish: async () => ({}),
      send: async () => ({}),
      publishCustomMessage: async () => ({ messageId: "custom-1", pubsubId: 1 }),
      updateCustomMessage: async () => 2,
      registerMessageType: async () => 1,
      clearMessageType: async () => 1,
      getMessageType: async () => null,
      getMessageTypes: async () => [],
      callMethod: async () => ({}),
      callMethodResult: async () => ({ content: {} }),
      participantByHandle: () => null,
      callMethodByHandle: async () => ({}),
      callMethodResultByHandle: async () => ({ content: {} }),
      contextId: "ctx-test",
      channelId: "channel-test",
      rpc: { call: async () => ({}) },
    }),
    getScope: () => scope,
    ...overrides,
  });
}

describe("buildEvalTool", () => {
  it("does not accept a timeout parameter", () => {
    const tool = createEvalTool();

    const parsed = tool.parameters.safeParse({
      code: "return 1;",
      timeout: 10_000,
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts the supported eval parameters", () => {
    const tool = createEvalTool();

    const parsed = tool.parameters.safeParse({
      code: "return 1;",
      syntax: "tsx",
      imports: { lodash: "npm:^4.17.21" },
    });

    expect(parsed.success).toBe(true);
  });

  it("reports path source loading failures with eval-specific context", async () => {
    const tool = createEvalTool({
      rpc: {
        call: async () => {
          throw new Error("ENOENT: no such file or directory");
        },
      },
    });

    await expect(
      tool.execute({ path: "/tmp/run_category.ts" }, { stream: async () => undefined } as never)
    ).rejects.toThrow("Failed to load eval source from path \"/tmp/run_category.ts\"");
    await expect(
      tool.execute({ path: "/tmp/run_category.ts" }, { stream: async () => undefined } as never)
    ).rejects.toThrow("current context filesystem");
  });

  it("documents pre-injected bindings and runtime import usage in help", async () => {
    const tool = createEvalTool({
      executeSandbox: async (_code, opts) => ({
        success: true,
        consoleOutput: "",
        returnValue: await (opts.bindings?.["help"] as () => Promise<unknown>)(),
      }),
    });

    const result = await tool.execute({ code: "return help();" }, {
      stream: async () => undefined,
    } as never);

    expect(JSON.stringify(result)).toContain("preInjected");
    expect(JSON.stringify(result)).toContain("contextId, fs, rpc");
  });

  it("adds an import hint when eval references a runtime export as a global", async () => {
    const tool = createEvalTool({
      executeSandbox: async () => ({
        success: false,
        consoleOutput: "",
        error: "contextId is not defined",
      }),
    });

    await expect(
      tool.execute({ code: "return contextId;" }, { stream: async () => undefined } as never)
    ).rejects.toThrow('import { contextId } from "@workspace/runtime"');
  });

  it("adds a file-loaded eval hint for missing relative imports", async () => {
    const tool = createEvalTool({
      executeSandbox: async () => ({
        success: false,
        consoleOutput: "",
        error: 'Module "./panels/spectrolite/mdx/docModule" not available. For npm packages, add the imports parameter.',
      }),
    });

    await expect(
      tool.execute(
        { code: 'import "./panels/spectrolite/mdx/docModule";' },
        { stream: async () => undefined } as never
      )
    ).rejects.toThrow("inline eval has no source file for resolving relative imports");
  });

  it("bounds huge return values and stores the full value in blobstore", async () => {
    const scope: Record<string, unknown> = {};
    const stored: string[] = [];
    const huge = Array.from({ length: 100 }, (_, index) => ({
      seq: index + 1,
      metadata: "x".repeat(2000),
    }));
    const tool = createEvalTool({
      getScope: () => scope,
      rpc: {
        call: async (_target: string, _method: string, args: unknown[]) => {
          stored.push(String(args[0]));
          return { digest: "digest-huge", size: stored[0]?.length ?? 0 };
        },
      } as never,
      executeSandbox: async () => ({
        success: true,
        consoleOutput: "",
        returnValue: huge,
      }),
    });

    const result = await tool.execute({ code: "return huge;" }, {
      stream: async () => undefined,
    } as never);
    const rendered = JSON.stringify(result);

    expect(rendered.length).toBeLessThan(80_000);
    expect(rendered).toContain("omitted from tool transcript");
    expect(rendered).toContain("digest=digest-huge");
    expect(scope["__lastEvalReturn"]).toBeUndefined();
    expect(stored[0]).toContain('"metadata"');
  });

  it("summarizes oversized diagnostic arrays before the preview", async () => {
    const diagnostics = Array.from({ length: 400 }, (_, index) => ({
      file: index % 2 === 0 ? "/ctx/panels/spectrolite/index.tsx" : "/ctx/panels/spectrolite/App.tsx",
      line: index + 1,
      column: 7,
      severity: index % 3 === 0 ? "warning" : "error",
      code: index % 2 === 0 ? 2307 : 7026,
      message: index % 2 === 0
        ? "Cannot find module 'react' or its corresponding type declarations."
        : "JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.",
      payload: "x".repeat(500),
    }));
    const tool = createEvalTool({
      executeSandbox: async () => ({
        success: true,
        consoleOutput: "",
        returnValue: { diagnostics },
      }),
    });

    const result = await tool.execute({ code: "return diagnostics;" }, {
      stream: async () => undefined,
    } as never);
    const rendered = JSON.stringify(result);

    expect(rendered).toContain("diagnostics array length 400");
    expect(rendered).toContain("By severity:");
    expect(rendered).toContain("Top codes:");
    expect(rendered).toContain("Missing modules: react=200");
    expect(rendered).toContain("Examples:");
    expect(rendered).toContain("[preview]");
  });

  it("passes the method abort signal into sandbox execution", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const tool = createEvalTool({
      executeSandbox: async (_code: string, opts: SandboxOptions): Promise<SandboxResult> => {
        capturedSignal = opts.signal;
        return { success: true, consoleOutput: "" };
      },
    });

    await tool.execute?.(
      { code: "return 1;" },
      {
        callId: "call-1",
        invocationId: "invocation-1",
        transportCallId: "transport-1",
        callerId: "caller-1",
        signal: controller.signal,
        stream: async () => undefined,
        streamWithAttachments: async () => undefined,
        resultWithAttachments: (content: unknown) => ({ content, attachments: [] }),
        progress: async () => undefined,
      } as MethodExecutionContext
    );

    expect(capturedSignal).toBe(controller.signal);
  });
});

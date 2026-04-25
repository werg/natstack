import { describe, it, expect, vi } from "vitest";
import { PiExtensionRuntime } from "./pi-extension-runtime.js";
import type {
  AgentTool,
  PiExtensionAPI,
  PiExtensionFactory,
} from "./pi-extension-api.js";
import type { NatStackScopedUiContext } from "./natstack-extension-context.js";

// Minimal stub UI context for tests. Every method is a vi.fn so dispatch
// works without side-effects.
function createStubUI(): NatStackScopedUiContext {
  return {
    selectForTool: vi.fn().mockResolvedValue(undefined),
    confirmForTool: vi.fn().mockResolvedValue(true),
    inputForTool: vi.fn().mockResolvedValue(undefined),
    editorForTool: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    setWorkingMessage: vi.fn(),
  };
}

// Minimal AgentTool factory; the runtime never invokes execute() itself,
// it only stores the tool by name and surfaces it via getActiveTools().
function makeTool(
  name: string,
  description = `desc-${name}`,
): AgentTool<any, any> {
  return {
    name,
    label: name,
    description,
    parameters: { type: "object", properties: {} } as never,
    execute: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: `result-${name}` }],
      details: undefined,
    }),
  } as unknown as AgentTool<any, any>;
}

describe("PiExtensionRuntime", () => {
  describe("registerTool", () => {
    it("Map.set semantics: re-registering with the same name overwrites", async () => {
      const runtime = new PiExtensionRuntime("/tmp");
      let captured: PiExtensionAPI | null = null;
      const factory: PiExtensionFactory = (api) => {
        captured = api;
      };
      await runtime.loadFactories([factory]);

      const first = makeTool("inline_ui", "first description");
      const second = makeTool("inline_ui", "second description");
      captured!.registerTool(first);
      captured!.registerTool(second);

      expect(runtime.getRegisteredToolNames()).toEqual(["inline_ui"]);
      // After overwrite, getActiveTools(builtins) with the name in active
      // set should return the second registration.
      captured!.setActiveTools(["inline_ui"]);
      const active = runtime.getActiveTools([]);
      expect(active).toHaveLength(1);
      expect(active[0]!.description).toBe("second description");
    });
  });

  describe("setActiveTools / getActiveTools", () => {
    it("returns builtin + filtered extension tools", async () => {
      const runtime = new PiExtensionRuntime("/tmp");
      let captured: PiExtensionAPI | null = null;
      await runtime.loadFactories([
        (api) => {
          captured = api;
          api.registerTool(makeTool("inline_ui"));
          api.registerTool(makeTool("eval"));
          api.registerTool(makeTool("ping"));
          api.setActiveTools(["bash", "read", "inline_ui", "eval"]);
        },
      ]);

      expect(captured).not.toBeNull();
      const builtin = [makeTool("bash"), makeTool("read")];
      const active = runtime.getActiveTools(builtin);
      const names = active.map((t) => t.name);
      // Built-ins always present
      expect(names).toContain("bash");
      expect(names).toContain("read");
      // Active extension tools present
      expect(names).toContain("inline_ui");
      expect(names).toContain("eval");
      // Inactive extension tool absent
      expect(names).not.toContain("ping");
      // No duplicates
      expect(names).toHaveLength(4);
    });

    it("does not duplicate built-ins when their names are also in the active set", async () => {
      const runtime = new PiExtensionRuntime("/tmp");
      await runtime.loadFactories([
        (api) => {
          api.registerTool(makeTool("read")); // shadow attempt
          api.setActiveTools(["read"]);
        },
      ]);
      const builtin = [makeTool("read")];
      const active = runtime.getActiveTools(builtin);
      // Built-in wins; the extension's "read" is filtered out.
      expect(active.map((t) => t.name)).toEqual(["read"]);
    });
  });

  describe("dispatch", () => {
    it("fires handlers in registration order", async () => {
      const runtime = new PiExtensionRuntime("/tmp");
      runtime.bindUI(createStubUI());

      const order: string[] = [];
      await runtime.loadFactories([
        (api) => {
          api.on("tool_call", () => {
            order.push("first");
          });
          api.on("tool_call", () => {
            order.push("second");
          });
        },
        (api) => {
          api.on("tool_call", () => {
            order.push("third");
          });
        },
      ]);

      const result = await runtime.dispatch("tool_call", {
        type: "tool_call",
        toolCallId: "id-1",
        toolName: "bash",
        input: {},
      });
      expect(result).toBeNull();
      expect(order).toEqual(["first", "second", "third"]);
    });

    it("returns the first {block: true} result and stops processing", async () => {
      const runtime = new PiExtensionRuntime("/tmp");
      runtime.bindUI(createStubUI());

      const calls: string[] = [];
      await runtime.loadFactories([
        (api) => {
          api.on("tool_call", () => {
            calls.push("a");
            return undefined;
          });
          api.on("tool_call", () => {
            calls.push("b");
            return { block: true, reason: "blocked by b" };
          });
          api.on("tool_call", () => {
            calls.push("c");
          });
        },
      ]);

      const result = await runtime.dispatch("tool_call", {
        type: "tool_call",
        toolCallId: "id-1",
        toolName: "bash",
        input: {},
      });
      expect(result).toEqual({ block: true, reason: "blocked by b" });
      expect(calls).toEqual(["a", "b"]); // c not invoked
    });

    it("returns null when no handlers are registered for the event", async () => {
      const runtime = new PiExtensionRuntime("/tmp");
      runtime.bindUI(createStubUI());
      await runtime.loadFactories([
        (api) => {
          api.on("session_start", () => {});
        },
      ]);
      const result = await runtime.dispatch("tool_call", {});
      expect(result).toBeNull();
    });

    it("throws if bindUI was never called before dispatch", async () => {
      const runtime = new PiExtensionRuntime("/tmp");
      await runtime.loadFactories([
        (api) => {
          api.on("tool_call", () => {});
        },
      ]);
      await expect(
        runtime.dispatch("tool_call", { toolName: "bash" }),
      ).rejects.toThrow(/UI context not bound/);
    });

    it("provides cwd via the context", async () => {
      const runtime = new PiExtensionRuntime("/work/dir");
      runtime.bindUI(createStubUI());
      let observedCwd: string | null = null;
      await runtime.loadFactories([
        (api) => {
          api.on("tool_call", (_event, ctx) => {
            observedCwd = ctx.cwd;
          });
        },
      ]);
      await runtime.dispatch("tool_call", { toolName: "bash" });
      expect(observedCwd).toBe("/work/dir");
    });

    it("binds toolCallId-scoped UI for tool_call events", async () => {
      const runtime = new PiExtensionRuntime("/tmp");
      const ui = createStubUI();
      runtime.bindUI(ui);
      await runtime.loadFactories([
        (api) => {
          api.on("tool_call", async (_event, ctx) => {
            await ctx.ui.confirm("Proceed?", "Run it");
          });
        },
      ]);
      await runtime.dispatch("tool_call", {
        type: "tool_call",
        toolCallId: "tool-1",
        toolName: "bash",
        input: {},
      });
      expect(ui.confirmForTool).toHaveBeenCalledWith(
        "tool-1",
        "Proceed?",
        "Run it",
        undefined,
        expect.objectContaining({ toolCallId: "tool-1", toolName: "bash" }),
      );
    });
  });

  describe("api.getAllTools / getActiveTools (string list)", () => {
    it("getAllTools returns tool info objects with name/description/parameters", async () => {
      const runtime = new PiExtensionRuntime("/tmp");
      let captured: PiExtensionAPI | null = null;
      await runtime.loadFactories([
        (api) => {
          captured = api;
          api.registerTool(makeTool("inline_ui", "Inline UI"));
        },
      ]);
      const all = captured!.getAllTools();
      expect(all).toHaveLength(1);
      expect(all[0]!.name).toBe("inline_ui");
      expect(all[0]!.description).toBe("Inline UI");
    });

    it("api.getActiveTools returns the configured name list", async () => {
      const runtime = new PiExtensionRuntime("/tmp");
      let captured: PiExtensionAPI | null = null;
      await runtime.loadFactories([
        (api) => {
          captured = api;
          api.setActiveTools(["a", "b", "c"]);
        },
      ]);
      expect(captured!.getActiveTools()).toEqual(["a", "b", "c"]);
    });
  });
});

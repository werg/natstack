import { describe, it, expect, vi } from "vitest";
import {
  createApprovalGateExtension,
  DEFAULT_SAFE_TOOL_NAMES,
  type ApprovalLevel,
} from "./approval-gate.js";

interface MockHandler {
  (event: { toolName: string; input: unknown }, ctx: MockCtx): Promise<unknown>;
}

interface MockCtx {
  hasUI: boolean;
  ui: { confirm: (title: string, message: string) => Promise<boolean> };
}

function createMockApi() {
  let toolCallHandler: MockHandler | null = null;
  return {
    on: vi.fn((event: string, handler: MockHandler) => {
      if (event === "tool_call") toolCallHandler = handler;
    }),
    callToolCall: async (input: { toolName: string; input: unknown }, ctx: MockCtx) => {
      if (!toolCallHandler) throw new Error("no tool_call handler registered");
      return toolCallHandler(input, ctx);
    },
  };
}

describe("createApprovalGateExtension", () => {
  it("level 2 (full auto) bypasses all approval", async () => {
    let level: ApprovalLevel = 2;
    const factory = createApprovalGateExtension({
      getApprovalLevel: () => level,
      safeToolNames: DEFAULT_SAFE_TOOL_NAMES,
      preApprovedCallIds: new Set(),
    });
    const api = createMockApi();
    factory(api as never);
    const confirmSpy = vi.fn().mockResolvedValue(true);
    const ctx: MockCtx = { hasUI: true, ui: { confirm: confirmSpy } };

    const result = await api.callToolCall(
      { toolName: "bash", input: { command: "rm -rf /" } },
      ctx,
    );
    expect(result).toBeUndefined();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("level 1 (auto safe) auto-approves safe tools", async () => {
    const factory = createApprovalGateExtension({
      getApprovalLevel: () => 1,
      safeToolNames: DEFAULT_SAFE_TOOL_NAMES,
      preApprovedCallIds: new Set(),
    });
    const api = createMockApi();
    factory(api as never);
    const confirmSpy = vi.fn().mockResolvedValue(true);
    const ctx: MockCtx = { hasUI: true, ui: { confirm: confirmSpy } };

    const result = await api.callToolCall(
      { toolName: "read", input: { path: "/tmp" } },
      ctx,
    );
    expect(result).toBeUndefined();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("level 1 prompts for unsafe tools", async () => {
    const factory = createApprovalGateExtension({
      getApprovalLevel: () => 1,
      safeToolNames: DEFAULT_SAFE_TOOL_NAMES,
      preApprovedCallIds: new Set(),
    });
    const api = createMockApi();
    factory(api as never);
    const confirmSpy = vi.fn().mockResolvedValue(true);
    const ctx: MockCtx = { hasUI: true, ui: { confirm: confirmSpy } };

    const result = await api.callToolCall(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(result).toBeUndefined();
    expect(confirmSpy).toHaveBeenCalledOnce();
  });

  it("level 0 prompts for every tool, including safe ones", async () => {
    const factory = createApprovalGateExtension({
      getApprovalLevel: () => 0,
      safeToolNames: DEFAULT_SAFE_TOOL_NAMES,
      preApprovedCallIds: new Set(),
    });
    const api = createMockApi();
    factory(api as never);
    const confirmSpy = vi.fn().mockResolvedValue(true);
    const ctx: MockCtx = { hasUI: true, ui: { confirm: confirmSpy } };

    await api.callToolCall({ toolName: "read", input: {} }, ctx);
    expect(confirmSpy).toHaveBeenCalledOnce();
  });

  it("blocks when user denies", async () => {
    const factory = createApprovalGateExtension({
      getApprovalLevel: () => 0,
      safeToolNames: DEFAULT_SAFE_TOOL_NAMES,
      preApprovedCallIds: new Set(),
    });
    const api = createMockApi();
    factory(api as never);
    const ctx: MockCtx = {
      hasUI: true,
      ui: { confirm: vi.fn().mockResolvedValue(false) },
    };

    const result = await api.callToolCall(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(result).toEqual({ block: true, reason: "User denied tool call" });
  });

  it("blocks when no UI is available and approval is needed", async () => {
    const factory = createApprovalGateExtension({
      getApprovalLevel: () => 0,
      safeToolNames: DEFAULT_SAFE_TOOL_NAMES,
      preApprovedCallIds: new Set(),
    });
    const api = createMockApi();
    factory(api as never);
    const ctx: MockCtx = {
      hasUI: false,
      ui: { confirm: vi.fn() },
    };

    const result = await api.callToolCall(
      { toolName: "bash", input: { command: "ls" } },
      ctx,
    );
    expect(result).toEqual({
      block: true,
      reason: 'Tool "bash" requires approval but no UI is bound (headless)',
    });
  });

  it("reads approval level lazily so worker mutations are visible", async () => {
    let level: ApprovalLevel = 0;
    const factory = createApprovalGateExtension({
      getApprovalLevel: () => level,
      safeToolNames: DEFAULT_SAFE_TOOL_NAMES,
      preApprovedCallIds: new Set(),
    });
    const api = createMockApi();
    factory(api as never);
    const confirmSpy = vi.fn().mockResolvedValue(true);
    const ctx: MockCtx = { hasUI: true, ui: { confirm: confirmSpy } };

    // First call: level 0 → prompt
    await api.callToolCall({ toolName: "read", input: {} }, ctx);
    expect(confirmSpy).toHaveBeenCalledOnce();

    // Worker mutates level to 2
    level = 2;
    confirmSpy.mockClear();

    // Second call: level 2 → no prompt
    await api.callToolCall({ toolName: "bash", input: {} }, ctx);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

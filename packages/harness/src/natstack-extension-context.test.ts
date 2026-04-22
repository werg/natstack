import { describe, it, expect, vi } from "vitest";
import {
  NatStackExtensionUIContext,
  type NatStackScopedUiContext,
} from "./natstack-extension-context.js";

function createCallbacks(): NatStackScopedUiContext {
  return {
    selectForTool: vi.fn().mockResolvedValue("a"),
    confirmForTool: vi.fn().mockResolvedValue(true),
    inputForTool: vi.fn().mockResolvedValue("input value"),
    editorForTool: vi.fn().mockResolvedValue("editor value"),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    setWorkingMessage: vi.fn(),
    requestProviderOAuth: vi.fn(),
  };
}

describe("NatStackExtensionUIContext", () => {
  it("forwards select() to showSelect callback", async () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs, { toolCallId: "tool-1" });
    const result = await ctx.select("Pick", ["a", "b"]);
    expect(cbs.selectForTool).toHaveBeenCalledWith(
      "tool-1",
      "Pick",
      ["a", "b"],
      undefined,
      { toolCallId: "tool-1" },
    );
    expect(result).toBe("a");
  });

  it("forwards confirm() to showConfirm callback", async () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs, { toolCallId: "tool-1" });
    const result = await ctx.confirm("Proceed?", "Are you sure?");
    expect(cbs.confirmForTool).toHaveBeenCalledWith(
      "tool-1",
      "Proceed?",
      "Are you sure?",
      undefined,
      { toolCallId: "tool-1" },
    );
    expect(result).toBe(true);
  });

  it("forwards input() to showInput callback", async () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs, { toolCallId: "tool-1" });
    const result = await ctx.input("Name", "Type here");
    expect(cbs.inputForTool).toHaveBeenCalledWith(
      "tool-1",
      "Name",
      "Type here",
      undefined,
      { toolCallId: "tool-1" },
    );
    expect(result).toBe("input value");
  });

  it("forwards editor() to showEditor callback", async () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs, { toolCallId: "tool-1" });
    const result = await ctx.editor("Notes", "prefill");
    expect(cbs.editorForTool).toHaveBeenCalledWith(
      "tool-1",
      "Notes",
      "prefill",
      { toolCallId: "tool-1" },
    );
    expect(result).toBe("editor value");
  });

  it("dispatchApproval marks the meta as approval", async () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs, {
      toolCallId: "tool-1",
      toolName: "write",
      toolInput: { path: "a.txt" },
    });
    await ctx.dispatchApproval("Allow tool call?", "Tool: write");
    expect(cbs.confirmForTool).toHaveBeenCalledWith(
      "tool-1",
      "Allow tool call?",
      "Tool: write",
      undefined,
      {
        toolCallId: "tool-1",
        toolName: "write",
        toolInput: { path: "a.txt" },
        mode: "approval",
      },
    );
  });

  it("throws outside tool_call dispatch for interactive methods", async () => {
    const ctx = new NatStackExtensionUIContext(createCallbacks());
    await expect(ctx.confirm("Proceed?", "No tool call")).rejects.toThrow(
      /outside tool_call dispatch/,
    );
  });

  it("forwards notify() with type", () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    ctx.notify("Heads up", "warning");
    expect(cbs.notify).toHaveBeenCalledWith("Heads up", "warning");
  });

  it("forwards setStatus() with key and text", () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    ctx.setStatus("net", "online");
    expect(cbs.setStatus).toHaveBeenCalledWith("net", "online");
  });

  it("forwards setWorkingMessage()", () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    ctx.setWorkingMessage("Thinking…");
    expect(cbs.setWorkingMessage).toHaveBeenCalledWith("Thinking…");
  });

  it("forwards string-array setWidget calls", () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    ctx.setWidget("status", ["line 1", "line 2"]);
    expect(cbs.setWidget).toHaveBeenCalledWith("status", ["line 1", "line 2"], undefined);
  });

  it("drops factory-style setWidget calls (TUI-only)", () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    ctx.setWidget("status", (() => ({})) as never);
    expect(cbs.setWidget).not.toHaveBeenCalled();
  });

  it("undefined setWidget is forwarded (clear)", () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    ctx.setWidget("status", undefined);
    expect(cbs.setWidget).toHaveBeenCalledWith("status", undefined, undefined);
  });

  it("custom() throws", async () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    await expect(ctx.custom()).rejects.toThrow(/not supported/);
  });

  it("TUI-only methods are no-ops", () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    expect(() => ctx.setHeader()).not.toThrow();
    expect(() => ctx.setFooter()).not.toThrow();
    expect(() => ctx.setTitle()).not.toThrow();
    expect(() => ctx.setEditorText()).not.toThrow();
    expect(() => ctx.pasteToEditor()).not.toThrow();
    expect(ctx.getEditorText()).toBe("");
    const unsub = ctx.onTerminalInput();
    expect(typeof unsub).toBe("function");
  });

  it("getAllThemes returns empty array", () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    expect(ctx.getAllThemes()).toEqual([]);
  });

  it("setTheme returns failure", () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    const result = ctx.setTheme();
    expect(result.success).toBe(false);
  });

  it("forwards requestProviderOAuth() to the callback", () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    ctx.requestProviderOAuth("openai-codex", "ChatGPT");
    expect(cbs.requestProviderOAuth).toHaveBeenCalledWith("openai-codex", "ChatGPT");
  });
});

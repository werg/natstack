import { describe, it, expect, vi } from "vitest";
import {
  NatStackExtensionUIContext,
  type NatStackUIBridgeCallbacks,
} from "./natstack-extension-context.js";

function createCallbacks(): NatStackUIBridgeCallbacks {
  return {
    showSelect: vi.fn().mockResolvedValue("a"),
    showConfirm: vi.fn().mockResolvedValue(true),
    showInput: vi.fn().mockResolvedValue("input value"),
    showEditor: vi.fn().mockResolvedValue("editor value"),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    setWorkingMessage: vi.fn(),
  };
}

describe("NatStackExtensionUIContext", () => {
  it("forwards select() to showSelect callback", async () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    const result = await ctx.select("Pick", ["a", "b"]);
    expect(cbs.showSelect).toHaveBeenCalledWith("Pick", ["a", "b"], undefined);
    expect(result).toBe("a");
  });

  it("forwards confirm() to showConfirm callback", async () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    const result = await ctx.confirm("Proceed?", "Are you sure?");
    expect(cbs.showConfirm).toHaveBeenCalledWith("Proceed?", "Are you sure?", undefined);
    expect(result).toBe(true);
  });

  it("forwards input() to showInput callback", async () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    const result = await ctx.input("Name", "Type here");
    expect(cbs.showInput).toHaveBeenCalledWith("Name", "Type here", undefined);
    expect(result).toBe("input value");
  });

  it("forwards editor() to showEditor callback", async () => {
    const cbs = createCallbacks();
    const ctx = new NatStackExtensionUIContext(cbs);
    const result = await ctx.editor("Notes", "prefill");
    expect(cbs.showEditor).toHaveBeenCalledWith("Notes", "prefill");
    expect(result).toBe("editor value");
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
});

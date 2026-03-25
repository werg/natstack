import { describe, expect, it } from "vitest";
import { resolveChatContextId } from "./bootstrap.js";

describe("resolveChatContextId", () => {
  it("prefers the state-args context when present", () => {
    expect(resolveChatContextId("ctx-from-state", "ctx-from-runtime")).toBe("ctx-from-state");
  });

  it("falls back to the runtime context", () => {
    expect(resolveChatContextId(undefined, "ctx-from-runtime")).toBe("ctx-from-runtime");
  });

  it("returns null when no usable context is available", () => {
    expect(resolveChatContextId(undefined, undefined)).toBeUndefined();
    expect(resolveChatContextId("", "   ")).toBeUndefined();
  });
});

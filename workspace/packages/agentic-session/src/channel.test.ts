/**
 * Regression tests for the unified headless subscription contract.
 *
 * The point of these tests is to lock in the *unified* state: a headless
 * subscription must NOT carry a tool restriction or any other lockdown shape
 * that would diverge from the panel-hosted path. Prompt overrides are
 * optional pass-through values; the helper should not invent one by default.
 */

import { describe, it, expect, vi } from "vitest";
import {
  getRecommendedChannelConfig,
  retireHeadlessAgent,
  subscribeHeadlessAgent,
  unsubscribeHeadlessAgent,
} from "./channel.js";

function makeRpcCall(captured: {
  config?: Record<string, unknown>;
  createSpec?: Record<string, unknown>;
  subscribeTarget?: string;
}): (target: string, method: string, args: unknown[]) => Promise<unknown> {
  return vi.fn(async (target: string, method: string, args: unknown[]) => {
    if (target === "main" && method === "runtime.createEntity") {
      captured.createSpec = args[0] as Record<string, unknown>;
      return {
        id: "do:workers/agent-worker:AiChatWorker:obj-1",
        targetId: "do:workers/agent-worker:AiChatWorker:obj-1",
      };
    }
    captured.subscribeTarget = target;
    const payload = args[0] as { config?: Record<string, unknown> } | undefined;
    captured.config = payload?.config;
    return { ok: true, participantId: "agent-1" };
  });
}

describe("subscribeHeadlessAgent — unified contract", () => {
  it("does not pass a toolAllowlist (lockdown regression guard)", async () => {
    const captured: { config?: Record<string, unknown> } = {};
    await subscribeHeadlessAgent({
      rpcCall: makeRpcCall(captured),
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
      contextId: "ctx-1",
    });

    expect(captured.config).toBeDefined();
    expect(captured.config!["toolAllowlist"]).toBeUndefined();
  });

  it("registers the headless DO through runtime.createEntity before subscribing", async () => {
    const captured: { createSpec?: Record<string, unknown>; subscribeTarget?: string } = {};
    const rpcCall = makeRpcCall(captured);

    const result = await subscribeHeadlessAgent({
      rpcCall,
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
      contextId: "ctx-1",
    });

    expect(captured.createSpec).toEqual({
      kind: "do",
      source: "workers/agent-worker",
      className: "AiChatWorker",
      key: "obj-1",
      contextId: "ctx-1",
    });
    expect(captured.subscribeTarget).toBe("do:workers/agent-worker:AiChatWorker:obj-1");
    expect(result.entityId).toBe("do:workers/agent-worker:AiChatWorker:obj-1");
    expect(result.targetId).toBe("do:workers/agent-worker:AiChatWorker:obj-1");
  });

  it("retires the runtime entity if subscription fails after creation", async () => {
    const calls: Array<{ target: string; method: string; args: unknown[] }> = [];
    const rpcCall = vi.fn(async (target: string, method: string, args: unknown[]) => {
      calls.push({ target, method, args });
      if (method === "runtime.createEntity") {
        return {
          id: "do:workers/agent-worker:AiChatWorker:obj-1",
          targetId: "do:workers/agent-worker:AiChatWorker:obj-1",
        };
      }
      if (method === "subscribeChannel") {
        throw new Error("subscribe failed");
      }
      return undefined;
    });

    await expect(subscribeHeadlessAgent({
      rpcCall,
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
      contextId: "ctx-1",
    })).rejects.toThrow("subscribe failed");

    expect(calls[calls.length - 1]).toEqual({
      target: "main",
      method: "runtime.retireEntity",
      args: [{ id: "do:workers/agent-worker:AiChatWorker:obj-1" }],
    });
  });

  it("does not pass a systemPrompt by default", async () => {
    const captured: { config?: Record<string, unknown> } = {};
    await subscribeHeadlessAgent({
      rpcCall: makeRpcCall(captured),
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
      contextId: "ctx-1",
    });

    expect(captured.config!["systemPrompt"]).toBeUndefined();
    expect(captured.config!["systemPromptMode"]).toBeUndefined();
  });

  it("sets full-auto approval (the only headless-specific channel config)", async () => {
    const captured: { config?: Record<string, unknown> } = {};
    await subscribeHeadlessAgent({
      rpcCall: makeRpcCall(captured),
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
      contextId: "ctx-1",
    });

    expect(captured.config!["approvalLevel"]).toBe(2);
  });

  it("forwards extraConfig pass-through values without smuggling in a toolAllowlist", async () => {
    const captured: { config?: Record<string, unknown> } = {};
    await subscribeHeadlessAgent({
      rpcCall: makeRpcCall(captured),
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
      contextId: "ctx-1",
      extraConfig: { model: "anthropic:claude-opus-4-5", thinkingLevel: "high" },
    });

    expect(captured.config!["model"]).toBe("anthropic:claude-opus-4-5");
    expect(captured.config!["thinkingLevel"]).toBe("high");
    expect(captured.config!["toolAllowlist"]).toBeUndefined();
  });

  it("forwards prompt pass-through values when explicitly provided", async () => {
    const captured: { config?: Record<string, unknown> } = {};
    await subscribeHeadlessAgent({
      rpcCall: makeRpcCall(captured),
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
      contextId: "ctx-1",
      extraConfig: {
        systemPrompt: "Headless prompt",
        systemPromptMode: "replace-natstack",
      },
    });

    expect(captured.config!["systemPrompt"]).toBe("Headless prompt");
    expect(captured.config!["systemPromptMode"]).toBe("replace-natstack");
  });
});

describe("getRecommendedChannelConfig", () => {
  it("returns full-auto approval and nothing else", () => {
    const config = getRecommendedChannelConfig();
    expect(config).toEqual({ approvalLevel: 2 });
  });
});

describe("retireHeadlessAgent", () => {
  it("retires the registered runtime entity", async () => {
    const rpcCall = vi.fn(async () => undefined);

    await retireHeadlessAgent({ rpcCall, entityId: "do:workers/agent-worker:AiChatWorker:obj-1" });

    expect(rpcCall).toHaveBeenCalledWith("main", "runtime.retireEntity", [
      { id: "do:workers/agent-worker:AiChatWorker:obj-1" },
    ]);
  });
});

describe("unsubscribeHeadlessAgent", () => {
  it("asks the registered agent DO to leave the channel before retirement", async () => {
    const rpcCall = vi.fn(async () => undefined);

    await unsubscribeHeadlessAgent({
      rpcCall,
      targetId: "do:workers/agent-worker:AiChatWorker:obj-1",
      channelId: "ch-1",
    });

    expect(rpcCall).toHaveBeenCalledWith(
      "do:workers/agent-worker:AiChatWorker:obj-1",
      "unsubscribeChannel",
      ["ch-1"],
    );
  });
});

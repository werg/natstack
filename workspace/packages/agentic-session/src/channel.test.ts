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
        contextId: (captured.createSpec?.["contextId"] as string | undefined) ?? "ctx-minted",
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
      // Per-agent config is seeded from creation stateArgs — here the full
      // subscriptionConfig (headless full-auto approval, no extraConfig).
      stateArgs: { agentConfig: { approvalLevel: 2 } },
    });
    expect(captured.subscribeTarget).toBe("do:workers/agent-worker:AiChatWorker:obj-1");
    expect(result.entityId).toBe("do:workers/agent-worker:AiChatWorker:obj-1");
    expect(result.targetId).toBe("do:workers/agent-worker:AiChatWorker:obj-1");
    expect(result.contextId).toBe("ctx-1");
  });

  it("lets runtime.createEntity mint an isolated context when none is supplied", async () => {
    const captured: { createSpec?: Record<string, unknown>; config?: Record<string, unknown> } = {};
    const rpcCall = makeRpcCall(captured);

    const result = await subscribeHeadlessAgent({
      rpcCall,
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
    });

    expect(captured.createSpec).toEqual({
      kind: "do",
      source: "workers/agent-worker",
      className: "AiChatWorker",
      key: "obj-1",
      stateArgs: { agentConfig: { approvalLevel: 2 } },
    });
    expect(result.contextId).toBe("ctx-minted");
    expect(rpcCall).toHaveBeenLastCalledWith(
      "do:workers/agent-worker:AiChatWorker:obj-1",
      "subscribeChannel",
      [
        expect.objectContaining({
          channelId: "ch-1",
          contextId: "ctx-minted",
        }),
      ],
    );
  });

  it("retires the runtime entity if subscription fails after creation", async () => {
    const calls: Array<{ target: string; method: string; args: unknown[] }> = [];
    const rpcCall = vi.fn(async (target: string, method: string, args: unknown[]) => {
      calls.push({ target, method, args });
      if (method === "runtime.createEntity") {
        return {
          id: "do:workers/agent-worker:AiChatWorker:obj-1",
          targetId: "do:workers/agent-worker:AiChatWorker:obj-1",
          contextId: "ctx-1",
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

  it("retires the runtime entity if an isolated spawn does not return a context", async () => {
    const calls: Array<{ target: string; method: string; args: unknown[] }> = [];
    const rpcCall = vi.fn(async (target: string, method: string, args: unknown[]) => {
      calls.push({ target, method, args });
      if (method === "runtime.createEntity") {
        return {
          id: "do:workers/agent-worker:AiChatWorker:obj-1",
          targetId: "do:workers/agent-worker:AiChatWorker:obj-1",
        };
      }
      return undefined;
    });

    await expect(subscribeHeadlessAgent({
      rpcCall,
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
    })).rejects.toThrow("runtime.createEntity did not return a contextId");

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

  it("seeds full-auto approval into the agent's creation config (per-agent), not the subscription", async () => {
    const captured: { config?: Record<string, unknown>; createSpec?: Record<string, unknown> } = {};
    await subscribeHeadlessAgent({
      rpcCall: makeRpcCall(captured),
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
      contextId: "ctx-1",
    });

    const agentConfig = (
      captured.createSpec!["stateArgs"] as { agentConfig: Record<string, unknown> }
    ).agentConfig;
    expect(agentConfig["approvalLevel"]).toBe(2);
    // Settings no longer ride the (membership-only) subscription.
    expect(captured.config!["approvalLevel"]).toBeUndefined();
  });

  it("seeds extraConfig settings into the creation config, not the subscription, and no toolAllowlist", async () => {
    const captured: { config?: Record<string, unknown>; createSpec?: Record<string, unknown> } = {};
    await subscribeHeadlessAgent({
      rpcCall: makeRpcCall(captured),
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
      contextId: "ctx-1",
      extraConfig: { model: "anthropic:claude-opus-4-5", thinkingLevel: "high" },
    });

    const agentConfig = (
      captured.createSpec!["stateArgs"] as { agentConfig: Record<string, unknown> }
    ).agentConfig;
    expect(agentConfig["model"]).toBe("anthropic:claude-opus-4-5");
    expect(agentConfig["thinkingLevel"]).toBe("high");
    expect(captured.config!["model"]).toBeUndefined();
    expect(captured.config!["toolAllowlist"]).toBeUndefined();
    expect(agentConfig["toolAllowlist"]).toBeUndefined();
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

  it("preserves worker-specific extras on the subscription while stripping settings", async () => {
    const captured: { config?: Record<string, unknown> } = {};
    await subscribeHeadlessAgent({
      rpcCall: makeRpcCall(captured),
      source: "workers/test-agent",
      className: "TestAgentWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
      contextId: "ctx-1",
      extraConfig: {
        model: "anthropic:claude-opus-4-5", // a setting — stripped
        deterministicResponse: true, // worker extras — survive
        responseText: "hi",
      },
    });

    expect(captured.config!["deterministicResponse"]).toBe(true);
    expect(captured.config!["responseText"]).toBe("hi");
    expect(captured.config!["model"]).toBeUndefined();
    expect(captured.config!["approvalLevel"]).toBeUndefined();
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

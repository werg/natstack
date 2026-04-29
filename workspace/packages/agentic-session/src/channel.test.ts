/**
 * Regression tests for the unified headless subscription contract.
 *
 * The point of these tests is to lock in the *unified* state: a headless
 * subscription must NOT carry a tool restriction or any other lockdown shape
 * that would diverge from the panel-hosted path. Prompt overrides are
 * optional pass-through values; the helper should not invent one by default.
 */

import { describe, it, expect, vi } from "vitest";
import { subscribeHeadlessAgent, getRecommendedChannelConfig } from "./channel.js";

function makeRpcCall(captured: { config?: Record<string, unknown> }): (target: string, method: string, ...args: unknown[]) => Promise<unknown> {
  return vi.fn(async (_target: string, _method: string, ..._args: unknown[]) => {
    // workers.callDO(source, className, objectKey, "subscribeChannel", payload)
    const payload = _args[4] as { config?: Record<string, unknown> } | undefined;
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

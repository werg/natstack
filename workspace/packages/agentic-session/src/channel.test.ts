/**
 * Regression tests for the unified headless subscription contract.
 *
 * The point of these tests is to lock in the *unified* state: a headless
 * subscription must NOT carry a tool restriction, replacement system prompt,
 * or any other lockdown shape that would diverge from the panel-hosted path.
 * They exist because a previous refactor silently introduced exactly such a
 * lockdown without anyone asking for it; if it ever happens again, this file
 * fails loudly.
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

  it("does not set systemPromptMode to a replacement mode by default", async () => {
    const captured: { config?: Record<string, unknown> } = {};
    await subscribeHeadlessAgent({
      rpcCall: makeRpcCall(captured),
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
      contextId: "ctx-1",
    });

    expect(captured.config!["systemPromptMode"]).toBeUndefined();
  });

  it("does not pass any systemPrompt", async () => {
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

  it("respects extraConfig overrides without smuggling in a toolAllowlist", async () => {
    const captured: { config?: Record<string, unknown> } = {};
    await subscribeHeadlessAgent({
      rpcCall: makeRpcCall(captured),
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "obj-1",
      channelId: "ch-1",
      contextId: "ctx-1",
      extraConfig: { model: "claude-opus-4-6" },
    });

    expect(captured.config!["systemPromptMode"]).toBeUndefined();
    expect(captured.config!["model"]).toBe("claude-opus-4-6");
    expect(captured.config!["toolAllowlist"]).toBeUndefined();
  });
});

describe("getRecommendedChannelConfig", () => {
  it("returns full-auto approval and nothing else", () => {
    const config = getRecommendedChannelConfig();
    expect(config).toEqual({ approvalLevel: 2 });
  });
});

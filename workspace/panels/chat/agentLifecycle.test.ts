/**
 * Panel-rpc harness: drives createAndSubscribeAgent against a mocked
 * `@workspace/runtime` rpc and asserts the per-agent config seeds into the
 * entity's creation stateArgs while the subscription stays presentation-only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  call: vi.fn(async (_target: string, method: string, _args: unknown[]) => {
    if (method === "runtime.createEntity") return { targetId: "do:workers/agent-worker:AiChatWorker:k" };
    return { ok: true, participantId: "p-1" };
  }),
}));

vi.mock("@workspace/runtime", () => ({ rpc: { call: mocks.call } }));

import { createAndSubscribeAgent } from "./agentLifecycle.js";

function callsFor(method: string): unknown[][] {
  return mocks.call.mock.calls.filter((c) => c[1] === method).map((c) => c[2] as unknown[]);
}

describe("createAndSubscribeAgent (panel-rpc harness)", () => {
  beforeEach(() => mocks.call.mockClear());

  it("seeds per-agent settings into creation stateArgs; subscription is presentation-only", async () => {
    const result = await createAndSubscribeAgent({
      source: "workers/agent-worker",
      className: "AiChatWorker",
      key: "k",
      channelId: "ch-1",
      channelContextId: "ctx-1",
      config: {
        model: "openai:gpt-5.3",
        approvalLevel: 1,
        respondPolicy: "mentioned-or-followup",
        handle: "bot",
        systemPrompt: "be terse",
      },
    });
    expect(result).toEqual({ ok: true, participantId: "p-1" });

    // createEntity seeds the FULL config (vessel sanitizes to the 7) under stateArgs.
    const createSpec = callsFor("runtime.createEntity")[0]![0] as {
      kind: string;
      stateArgs: { agentConfig: Record<string, unknown> };
    };
    expect(createSpec.kind).toBe("do");
    expect(createSpec.stateArgs.agentConfig).toMatchObject({
      model: "openai:gpt-5.3",
      approvalLevel: 1,
      respondPolicy: "mentioned-or-followup",
    });

    // The subscription carries presentation only — no behavior settings leak.
    const subConfig = (callsFor("subscribeChannel")[0]![0] as { config: Record<string, unknown> })
      .config;
    expect(subConfig).toEqual({ handle: "bot", systemPrompt: "be terse" });
    expect(subConfig).not.toHaveProperty("model");
    expect(subConfig).not.toHaveProperty("approvalLevel");
    expect(subConfig).not.toHaveProperty("respondPolicy");
  });

  it("preserves worker-specific extras on the subscription (e.g. test-agent deterministic keys)", async () => {
    await createAndSubscribeAgent({
      source: "workers/test-agent",
      className: "TestAgentWorker",
      key: "k",
      channelId: "ch-1",
      channelContextId: "ctx-1",
      config: {
        model: "openai:gpt-5.3", // a setting — must be stripped
        deterministicResponse: true, // worker extras — must survive
        responseText: "hi",
        code: "read('a')",
        handle: "test-agent",
      },
    });
    const subConfig = (callsFor("subscribeChannel")[0]![0] as { config: Record<string, unknown> })
      .config;
    expect(subConfig).toEqual({
      deterministicResponse: true,
      responseText: "hi",
      code: "read('a')",
      handle: "test-agent",
    });
    expect(subConfig).not.toHaveProperty("model");
    // The settings still seed the agent's creation config:
    const createSpec = callsFor("runtime.createEntity")[0]![0] as {
      stateArgs: { agentConfig: Record<string, unknown> };
    };
    expect(createSpec.stateArgs.agentConfig).toMatchObject({ model: "openai:gpt-5.3" });
  });

  it("creates the entity before subscribing, on the channel's context", async () => {
    await createAndSubscribeAgent({
      source: "workers/agent-worker",
      className: "AiChatWorker",
      key: "k",
      channelId: "ch-1",
      channelContextId: "ctx-1",
    });
    const order = mocks.call.mock.calls.map((c) => c[1]);
    expect(order).toEqual(["runtime.createEntity", "subscribeChannel"]);
    const createSpec = callsFor("runtime.createEntity")[0]![0] as { contextId: string };
    expect(createSpec.contextId).toBe("ctx-1");
  });

  it("refuses to subscribe without a context id", async () => {
    await expect(
      createAndSubscribeAgent({
        source: "workers/agent-worker",
        className: "AiChatWorker",
        key: "k",
        channelId: "ch-1",
        channelContextId: "",
      })
    ).rejects.toThrow(/context ID/);
    expect(mocks.call).not.toHaveBeenCalled();
  });
});

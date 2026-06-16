import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWithAgent: vi.fn(async (config: unknown) => ({ config })),
  createPanelSandboxConfig: vi.fn(() => ({ kind: "sandbox" })),
  getStateArgs: vi.fn(() => ({ agentConfig: { model: "anthropic:test-model" } })),
  rpc: {
    selfId: "panel:nav-test",
    call: vi.fn(),
  },
  slotId: "panel:slot-test",
  gad: {},
}));

vi.mock("@workspace/agentic-session", () => ({
  HeadlessSession: { createWithAgent: mocks.createWithAgent },
}));

vi.mock("@workspace/agentic-core", () => ({
  createPanelSandboxConfig: mocks.createPanelSandboxConfig,
}));

vi.mock("@workspace/runtime", () => ({
  gad: mocks.gad,
  rpc: mocks.rpc,
  slotId: mocks.slotId,
  getStateArgs: mocks.getStateArgs,
}));

import { HeadlessRunner, SYSTEM_TEST_AGENT_PROMPT } from "./runner.js";

describe("HeadlessRunner", () => {
  beforeEach(() => {
    mocks.createWithAgent.mockClear();
    mocks.createPanelSandboxConfig.mockClear();
    mocks.getStateArgs.mockClear();
    mocks.rpc.call.mockClear();
  });

  it("spawns system-test agents without a model-call cap by default", async () => {
    const runner = new HeadlessRunner("ctx-test");

    await runner.spawn();

    expect(mocks.createWithAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: "ctx-test",
        extraConfig: expect.objectContaining({
          model: "anthropic:test-model",
        }),
      })
    );
    const config = mocks.createWithAgent.mock.calls[0]![0] as {
      config: { clientId: string };
      extraConfig: Record<string, unknown>;
    };
    expect(config.config.clientId).toBe("panel:slot-test");
    expect(config.extraConfig).not.toHaveProperty("maxModelCallsPerTurn");
  });

  it("prompts system-test agents to probe the documented path instead of solving independently", async () => {
    const runner = new HeadlessRunner("ctx-test");

    await runner.spawn();

    const config = mocks.createWithAgent.mock.calls[0]![0] as {
      extraConfig: Record<string, unknown>;
    };
    expect(config.extraConfig["systemPrompt"]).toBe(SYSTEM_TEST_AGENT_PROMPT);
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("exercise the documented path honestly");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("most straightforward supported approach");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("If that documented approach fails, stop");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("When reporting a failure");
    expect(SYSTEM_TEST_AGENT_PROMPT).toContain("exact error or unexpected result");
    expect(SYSTEM_TEST_AGENT_PROMPT).not.toContain("smallest relevant canonical workspace docs");
  });
});

import { describe, it, expect } from "vitest";
import type {
  ChannelEvent,
  WorkerAction,
} from "@natstack/harness";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { TestAgentWorker } from "./test-agent-worker.js";

function makeEvent(overrides: Partial<ChannelEvent> = {}): ChannelEvent {
  return {
    id: 1,
    messageId: "msg-1",
    type: "message",
    payload: { content: "Hello" },
    senderId: "user-1",
    senderType: "panel",
    ts: Date.now(),
    persist: true,
    ...overrides,
  };
}

describe("TestAgentWorker", () => {
  it("returns custom participant info", async () => {
    const { instance } = await createTestDO(TestAgentWorker);
    const desc = await instance.subscribeChannel({
      channelId: "ch-1",
      contextId: "ctx-1",
    });
    expect(desc.handle).toBe("test-agent");
    expect(desc.name).toBe("Test Agent");
    expect(desc.type).toBe("agent");
  });

  it("spawn-harness action includes custom system prompt config", async () => {
    const { instance } = await createTestDO(TestAgentWorker);
    await instance.subscribeChannel({
      channelId: "ch-1",
      contextId: "ctx-1",
    });

    const event = makeEvent({ id: 10 });
    const result = await instance.onChannelEvent("ch-1", event);

    const spawn = result.actions.find(
      (a) => "op" in a && a.op === "spawn-harness",
    ) as Extract<WorkerAction, { op: "spawn-harness" }>;

    expect(spawn).toBeDefined();
    expect(spawn.config).toBeDefined();
    expect(spawn.config!.systemPrompt).toContain("the agent says: ");
    expect(spawn.initialTurn).toBeDefined();
    expect(spawn.initialTurn!.input.content).toBe("Hello");
  });

  it("uses claude-sdk harness type by default", async () => {
    const { instance } = await createTestDO(TestAgentWorker);
    await instance.subscribeChannel({
      channelId: "ch-1",
      contextId: "ctx-1",
    });

    const event = makeEvent({ id: 10 });
    const result = await instance.onChannelEvent("ch-1", event);

    const spawn = result.actions.find(
      (a) => "op" in a && a.op === "spawn-harness",
    ) as Extract<WorkerAction, { op: "spawn-harness" }>;
    expect(spawn.type).toBe("claude-sdk");
  });

  it("filters non-panel events", async () => {
    const { instance } = await createTestDO(TestAgentWorker);
    await instance.subscribeChannel({
      channelId: "ch-1",
      contextId: "ctx-1",
    });

    const event = makeEvent({ id: 10, senderType: "agent" });
    const result = await instance.onChannelEvent("ch-1", event);

    expect(result.actions).toHaveLength(0);
  });
});

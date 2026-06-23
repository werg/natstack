import { describe, expect, it } from "vitest";
import { buildModelContext } from "./context.js";
import { initialAgentState, type AgentLoopConfig, type AgentState, type SessionEntry } from "./state.js";

const config = {
  model: "anthropic:claude-sonnet-4-6",
  thinkingLevel: "medium",
  approvalLevel: 2,
  respondPolicy: "all",
  systemPromptHash: "blob:sys",
  activeToolNames: ["read"],
  roster: { participants: [] },
} as unknown as AgentLoopConfig;

describe("buildModelContext: multi-agent attribution", () => {
  it("presents another agent's message as an attributed user turn, own as assistant", () => {
    const selfId = "agent:self";
    const entries: SessionEntry[] = [
      {
        kind: "assistant",
        seq: 1,
        messageId: "m1",
        senderRef: { kind: "agent", id: "agent:other", metadata: { handle: "ai-chat" } },
        blocks: [
          { type: "thinking", content: "hidden reasoning" },
          { type: "text", content: "I added the explorer" },
        ],
      },
      {
        kind: "assistant",
        seq: 2,
        messageId: "m2",
        senderRef: { kind: "agent", id: selfId },
        blocks: [{ type: "text", content: "my own turn" }],
      },
    ];
    const state: AgentState = { ...initialAgentState({ channelId: "c", config, selfId }), entries };

    const msgs = buildModelContext(state);
    // ai-chat's message is NOT the explorer's own voice — it's attributed user context.
    expect(msgs[0]).toEqual({ role: "user", content: "[ai-chat]: I added the explorer" });
    // the explorer's own message stays assistant.
    expect(msgs[1]).toEqual({ role: "assistant", blocks: [{ type: "text", content: "my own turn" }] });
  });

  it("without a selfId, leaves all assistant entries as assistant (back-compat)", () => {
    const entries: SessionEntry[] = [
      {
        kind: "assistant",
        seq: 1,
        messageId: "m1",
        senderRef: { kind: "agent", id: "agent:other" },
        blocks: [],
      },
    ];
    const state: AgentState = { ...initialAgentState({ channelId: "c", config }), entries };
    expect(buildModelContext(state)[0]?.role).toBe("assistant");
  });
});

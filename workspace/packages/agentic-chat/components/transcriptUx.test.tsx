// @vitest-environment jsdom

import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PubSubClient } from "@workspace/pubsub";
import { MessageList } from "./MessageList.js";
import { useChannelMessages } from "../hooks/useChannelMessages.js";
import {
  appendTrajectoryEventsAndBroadcast,
  assistantMessage,
  createTranscriptHarness,
  invocationCompleted,
  invocationStarted,
} from "../hooks/transcriptTestHarness.js";
import {
  AGENTIC_PROTOCOL_VERSION,
  brandId,
  type AgenticEvent,
  type InvocationId,
} from "@workspace/agentic-protocol";

const hookState = vi.hoisted(() => {
  const scrollElement = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    addEventListener() {},
    removeEventListener() {},
  };
  const contentElement = {};
  const scrollRef = Object.assign((_node: unknown) => {}, { current: scrollElement });
  const contentRef = Object.assign((_node: unknown) => {}, { current: contentElement });
  return {
    scrollRef,
    contentRef,
    scrollToBottom: vi.fn(() => true),
  };
});

vi.mock("../hooks/useStickToBottom.js", () => ({
  useStickToBottom: () => ({
    scrollRef: hookState.scrollRef,
    contentRef: hookState.contentRef,
    scrollToBottom: hookState.scrollToBottom,
    isAtBottom: true,
  }),
}));

function TranscriptView({ client }: { client: PubSubClient }) {
  const { messages } = useChannelMessages(client);
  return (
    <MessageList
      messages={messages}
      participants={{}}
      selfId="panel:chat"
      allParticipants={{}}
    />
  );
}

describe("transcript UX smoke", () => {
  it("renders GAD-published agent messages and exact invocation beads", async () => {
    const harness = await createTranscriptHarness("transcript-ux");
    const panel = harness.connectParticipant({
      id: "panel:chat",
      name: "User",
      type: "panel",
      handle: "user",
    });

    render(<TranscriptView client={panel} />);
    await panel.ready();

    await act(async () => {
      await appendTrajectoryEventsAndBroadcast(harness, [
        assistantMessage("assistant-visible", "Welcome to NatStack."),
        invocationStarted("call-eval", "eval", { code: "read('skills/onboarding/SKILL.md')" }),
        invocationCompleted("call-eval", {
          toolCallId: "call-eval",
          toolName: "eval",
          details: { input: { code: "read('skills/onboarding/SKILL.md')" } },
          content: [{ type: "text", text: "ok" }],
        }),
      ]);
    });

    await waitFor(() => {
      expect(screen.getByText("Welcome to NatStack.")).toBeTruthy();
      expect(screen.getByText("Eval")).toBeTruthy();
      expect(document.body.textContent).toContain("code: SKILL.md')");
    });

    panel.close();
  });

  it("preserves exact MCP-style method names and terminal failures", async () => {
    const harness = await createTranscriptHarness("transcript-ux-methods");
    const panel = harness.connectParticipant({
      id: "panel:chat",
      name: "User",
      type: "panel",
      handle: "user",
    });

    render(<TranscriptView client={panel} />);
    await panel.ready();

    const failed: AgenticEvent<"invocation.failed"> = {
      kind: "invocation.failed",
      actor: { kind: "agent", id: "agent:onboarding", displayName: "Onboarding Agent" },
      causality: { invocationId: brandId<InvocationId>("call-list") },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "permission denied",
        error: {
          toolName: "mcp__workspace__ListDirectory",
          details: { input: { path: "src" } },
        },
      },
      createdAt: new Date().toISOString(),
    };

    await act(async () => {
      await appendTrajectoryEventsAndBroadcast(harness, [failed]);
    });

    await waitFor(() => {
      expect(screen.getByText("ListDirectory")).toBeTruthy();
      expect(document.body.textContent).toContain("path: src");
      expect(document.body.textContent).toContain("permission denied");
      expect(document.body.querySelector('[data-invocation-name="mcp__workspace__ListDirectory"]')).toBeTruthy();
      expect(document.body.querySelector('[data-invocation-status="error"]')).toBeTruthy();
    });

    panel.close();
  });
});

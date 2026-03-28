// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MessageList } from "./MessageList.js";

function makeMessage(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    senderId: "agent-1",
    content: "",
    kind: "message",
    complete: false,
    ...overrides,
  };
}

describe("MessageList typing indicators", () => {
  it("renders active typing at the bottom even after later agent output", () => {
    render(React.createElement(MessageList, {
      messages: [
        makeMessage({
          id: "typing-1",
          contentType: "typing",
          content: JSON.stringify({ senderName: "AI Chat" }),
        }),
        makeMessage({
          id: "msg-1",
          content: "Working...",
        }),
      ],
      allParticipants: {},
    } as never));

    const textNode = screen.getByText("Working...");
    const typingNode = screen.getByText("AI Chat typing");

    expect(typingNode).toBeTruthy();
    expect(textNode.compareDocumentPosition(typingNode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows only the latest active typing badge per sender", () => {
    render(React.createElement(MessageList, {
      messages: [
        makeMessage({
          id: "typing-1",
          contentType: "typing",
          content: JSON.stringify({ senderName: "AI Chat" }),
        }),
        makeMessage({
          id: "typing-2",
          contentType: "typing",
          content: JSON.stringify({ senderName: "AI Chat" }),
        }),
      ],
      allParticipants: {},
    } as never));

    expect(screen.getAllByText("AI Chat typing")).toHaveLength(1);
  });

  it("hides redundant eval action beads when the method bead is present", () => {
    render(React.createElement(MessageList, {
      messages: [
        makeMessage({
          id: "action-1",
          contentType: "action",
          content: JSON.stringify({
            type: "eval",
            description: "Evaluate code",
            toolUseId: "tool-1",
            status: "complete",
          }),
          complete: true,
        }),
        {
          id: "method-call-1",
          senderId: "panel-1",
          content: "",
          kind: "method",
          complete: true,
          method: {
            callId: "call-1",
            methodName: "eval",
            args: { code: "1+1" },
            status: "success",
            startedAt: 1,
          },
        },
      ],
      allParticipants: {},
    } as never));

    expect(screen.getByText(/\(code: 1\+1\)/)).toBeTruthy();
    expect(screen.queryByText("Evaluate code")).toBeNull();
  });
});

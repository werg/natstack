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

  it("renders action beads in inline groups", () => {
    render(React.createElement(MessageList, {
      messages: [
        makeMessage({
          id: "action-1",
          contentType: "action",
          content: JSON.stringify({
            type: "Read",
            description: "Read src/app.ts",
            toolUseId: "tool-1",
            status: "complete",
          }),
          complete: true,
        }),
        makeMessage({
          id: "action-2",
          contentType: "action",
          content: JSON.stringify({
            type: "Edit",
            description: "Edit src/config.ts",
            toolUseId: "tool-2",
            status: "complete",
          }),
          complete: true,
        }),
      ],
      allParticipants: {},
    } as never));

    expect(screen.getByText("Read src/app.ts")).toBeTruthy();
    expect(screen.getByText("Edit src/config.ts")).toBeTruthy();
  });
});

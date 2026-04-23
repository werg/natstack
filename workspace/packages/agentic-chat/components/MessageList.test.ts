// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

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

vi.mock("use-stick-to-bottom", () => ({
  useStickToBottom: () => ({
    scrollRef: hookState.scrollRef,
    contentRef: hookState.contentRef,
    scrollToBottom: hookState.scrollToBottom,
    isAtBottom: true,
  }),
}));

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

function makeParticipant(id: string, metadata: Record<string, unknown>) {
  return { [id]: { id, metadata: { name: "AI Chat", type: "agent", handle: "agent", ...metadata } } };
}

describe("MessageList typing indicators (roster-based)", () => {
  it("shows typing indicator when participant metadata has typing=true", () => {
    render(React.createElement(MessageList, {
      messages: [],
      participants: makeParticipant("agent-1", { typing: true }),
      selfId: "user-1",
      allParticipants: {},
    } as never));

    expect(screen.getByText("AI Chat typing")).toBeTruthy();
  });

  it("does not show typing for participants with typing=false", () => {
    render(React.createElement(MessageList, {
      messages: [],
      participants: makeParticipant("agent-1", { typing: false }),
      selfId: "user-1",
      allParticipants: {},
    } as never));

    expect(screen.queryByText("AI Chat typing")).toBeNull();
  });

  it("does not show own typing indicator", () => {
    render(React.createElement(MessageList, {
      messages: [],
      participants: makeParticipant("user-1", { typing: true, name: "User", type: "panel" }),
      selfId: "user-1",
      allParticipants: {},
    } as never));

    expect(screen.queryByText("User typing")).toBeNull();
  });

  it("renders toolCall beads in inline groups", () => {
    render(React.createElement(MessageList, {
      messages: [
        makeMessage({
          id: "action-1",
          contentType: "toolCall",
          content: "",
          toolCall: {
            id: "tool-1",
            name: "Read",
            arguments: { file_path: "src/app.ts" },
            execution: { status: "complete", description: "Read src/app.ts" },
          },
          complete: true,
        }),
        makeMessage({
          id: "action-2",
          contentType: "toolCall",
          content: "",
          toolCall: {
            id: "tool-2",
            name: "Edit",
            arguments: { file_path: "src/config.ts" },
            execution: { status: "complete", description: "Edit src/config.ts" },
          },
          complete: true,
        }),
      ],
      participants: {},
      selfId: "user-1",
      allParticipants: {},
    } as never));

    expect(screen.getByText("Read src/app.ts")).toBeTruthy();
    expect(screen.getByText("Edit src/config.ts")).toBeTruthy();
  });
});

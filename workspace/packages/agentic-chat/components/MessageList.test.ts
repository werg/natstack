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
      participants: {},
      selfId: "user-1",
      allParticipants: {},
    } as never));

    expect(screen.getByText("Read src/app.ts")).toBeTruthy();
    expect(screen.getByText("Edit src/config.ts")).toBeTruthy();
  });
});

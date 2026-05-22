// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { InlineItem } from "./InlineGroup.js";

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

  it("renders invocation beads in inline groups", () => {
    render(React.createElement(MessageList, {
      messages: [
        makeMessage({
          id: "action-1",
          contentType: "invocation",
          content: "",
          invocation: {
            id: "tool-1",
            name: "Read",
            arguments: { file_path: "src/app.ts" },
            execution: { status: "complete", description: "Read src/app.ts" },
          },
          complete: true,
        }),
        makeMessage({
          id: "action-2",
          contentType: "invocation",
          content: "",
          invocation: {
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

  it("renders durable typing indicators in their own inline row", () => {
    render(React.createElement(MessageList, {
      messages: [
        makeMessage({
          id: "action-1",
          contentType: "invocation",
          content: "",
          invocation: {
            id: "tool-1",
            name: "Read",
            arguments: { file_path: "src/app.ts" },
            execution: { status: "pending", description: "Read src/app.ts" },
          },
          complete: false,
        }),
        makeMessage({
          id: "typing-1",
          contentType: "typing",
          senderMetadata: { name: "Agent One", type: "agent", handle: "agent-1" },
          complete: false,
        }),
      ],
      participants: {},
      selfId: "user-1",
      allParticipants: {},
      renderInlineGroup: (items: InlineItem[]) => React.createElement(
        "div",
        { "data-testid": "inline-group" },
        items.map((item) => item.type).join(","),
      ),
    } as never));

    expect(screen.getAllByTestId("inline-group").map((node) => node.textContent)).toEqual([
      "invocation",
      "typing",
    ]);
  });

  it("does not synthesize generic invocation UI for malformed invocation messages", () => {
    render(React.createElement(MessageList, {
      messages: [
        makeMessage({
          id: "action-without-payload",
          contentType: "invocation",
          content: "",
          complete: false,
        }),
      ],
      participants: {},
      selfId: "user-1",
      allParticipants: {},
    } as never));

    expect(screen.queryByText("Invocation")).toBeNull();
    expect(screen.queryByText("Tool")).toBeNull();
    expect(document.body.querySelector('[data-testid="invocation-pill"]')).toBeNull();
  });

  it("renders durable approval cards", () => {
    render(React.createElement(MessageList, {
      messages: [
        makeMessage({
          id: "approval-1",
          contentType: "approval",
          content: "",
          approval: {
            id: "approval-1",
            invocationId: "call-1",
            question: "Allow tool call?",
            status: "requested",
          },
          complete: false,
        }),
      ],
      participants: {},
      selfId: "user-1",
      allParticipants: {},
    } as never));

    expect(screen.getByText("Approval requested")).toBeTruthy();
    expect(screen.getByText("Allow tool call?")).toBeTruthy();
    expect(screen.queryByText("call-1")).toBeNull();
  });

  it("wires MDX ActionButton to publish a follow-up message", async () => {
    const publishMessage = vi.fn();
    render(React.createElement(MessageList, {
      messages: [
        makeMessage({
          id: "mdx-1",
          content: '<ActionButton message="Refresh the data">Refresh</ActionButton>',
          complete: true,
        }),
      ],
      participants: {},
      selfId: "user-1",
      allParticipants: {},
      mdxActions: { publishMessage },
    } as never));

    const button = await waitFor(() => screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(button);

    expect(publishMessage).toHaveBeenCalledWith("Refresh the data");
  });
});

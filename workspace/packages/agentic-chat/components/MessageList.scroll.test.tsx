// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types";

const hookState = vi.hoisted(() => {
  const scrollListeners = new Set<() => void>();
  const scrollElement = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    addEventListener(event: string, listener: () => void) {
      if (event === "scroll") scrollListeners.add(listener);
    },
    removeEventListener(event: string, listener: () => void) {
      if (event === "scroll") scrollListeners.delete(listener);
    },
  };
  const contentElement = {};
  const scrollRef = Object.assign((_node: unknown) => {}, { current: scrollElement });
  const contentRef = Object.assign((_node: unknown) => {}, { current: contentElement });
  return {
    contentElement,
    contentRef,
    isAtBottom: true,
    scrollElement,
    scrollListeners,
    scrollRef,
    scrollToBottom: vi.fn(() => true),
  };
});

vi.mock("use-stick-to-bottom", () => ({
  useStickToBottom: () => ({
    scrollRef: hookState.scrollRef,
    contentRef: hookState.contentRef,
    scrollToBottom: hookState.scrollToBottom,
    isAtBottom: hookState.isAtBottom,
  }),
}));

import { MessageList } from "./MessageList.js";

function makeMessage(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    senderId: "agent-1",
    content: id,
    kind: "message" as const,
    complete: true,
    ...overrides,
  };
}

describe("MessageList scroll behavior", () => {
  beforeEach(() => {
    hookState.isAtBottom = true;
    hookState.scrollElement.scrollTop = 0;
    hookState.scrollElement.scrollHeight = 0;
    hookState.scrollElement.clientHeight = 0;
    hookState.scrollListeners.clear();
    hookState.scrollToBottom.mockClear();
  });

  it("does not re-trigger history loading on message append while already near the top", async () => {
    hookState.isAtBottom = false;
    hookState.scrollElement.scrollTop = 100;

    const onLoadEarlierMessages = vi.fn();
    const { rerender } = render(
      <MessageList
        messages={[makeMessage("m1")]}
        allParticipants={{}}
        hasMoreHistory={true}
        loadingMore={false}
        onLoadEarlierMessages={onLoadEarlierMessages}
      />,
    );

    await waitFor(() => expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1));

    rerender(
      <MessageList
        messages={[makeMessage("m1"), makeMessage("m2")]}
        allParticipants={{}}
        hasMoreHistory={true}
        loadingMore={false}
        onLoadEarlierMessages={onLoadEarlierMessages}
      />,
    );

    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
  });

  it("preserves the visible position when older messages are prepended away from bottom", () => {
    hookState.isAtBottom = false;
    hookState.scrollElement.scrollTop = 120;
    hookState.scrollElement.scrollHeight = 400;

    const { rerender } = render(
      <MessageList
        messages={[makeMessage("m2"), makeMessage("m3")]}
        allParticipants={{}}
      />,
    );

    hookState.scrollElement.scrollHeight = 550;

    rerender(
      <MessageList
        messages={[makeMessage("m1"), makeMessage("m2"), makeMessage("m3")]}
        allParticipants={{}}
      />,
    );

    expect(hookState.scrollElement.scrollTop).toBe(270);
    expect(screen.queryByText("New messages")).toBeNull();
  });

  it("shows the new content indicator for appended messages away from bottom and scrolls on click", () => {
    hookState.isAtBottom = false;

    const { rerender } = render(
      <MessageList
        messages={[makeMessage("m1")]}
        allParticipants={{}}
      />,
    );

    rerender(
      <MessageList
        messages={[makeMessage("m1"), makeMessage("m2")]}
        allParticipants={{}}
      />,
    );

    fireEvent.click(screen.getByText("New messages"));

    expect(hookState.scrollToBottom).toHaveBeenCalledWith({ animation: "instant" });
    expect(screen.queryByText("New messages")).toBeNull();
  });
});

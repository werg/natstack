// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Theme } from "@radix-ui/themes";
import { ChatInput } from "./ChatInput";
import { ChatContext } from "../context/ChatContext";
import { ChatInputContext } from "../context/ChatInputContext";
import type {
  ChatContextValue,
  ChatInputContextValue,
  FlushNarration,
  PrimaryActionIntent,
  UndoableAction,
} from "../types";

beforeAll(() => {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  );
});

interface Harness {
  onSendMessage: ReturnType<typeof vi.fn>;
  flushOutboxAndInterrupt: ReturnType<typeof vi.fn>;
  undoLastAction: ReturnType<typeof vi.fn>;
}

function renderInput(
  opts: {
    input?: string;
    agentBusy?: boolean;
    hasOpenTurn?: boolean;
    primaryActionIntent?: PrimaryActionIntent;
    flushNarration?: FlushNarration;
    undoableAction?: UndoableAction;
    pendingSendCount?: number;
  } = {}
): Harness {
  const onSendMessage = vi.fn(async () => {});
  const flushOutboxAndInterrupt = vi.fn(async () => {});
  const undoLastAction = vi.fn();

  const ctx = {
    connected: true,
    allParticipants: {},
    agentBusy: opts.agentBusy ?? false,
    hasOpenTurn: opts.hasOpenTurn ?? false,
    primaryActionIntent: opts.primaryActionIntent ?? "send",
    flushOutboxAndInterrupt,
    flushNarration: opts.flushNarration,
    undoableAction: opts.undoableAction,
    undoLastAction,
    pendingSendCount: opts.pendingSendCount ?? 0,
  } as unknown as ChatContextValue;

  const inputCtx = {
    input: opts.input ?? "hello",
    pendingImages: [],
    onInputChange: vi.fn(),
    onSendMessage,
    onImagesChange: vi.fn(),
    replyTo: null,
    replyToMessage: null,
    setReplyTo: vi.fn(),
  } as unknown as ChatInputContextValue;

  render(
    <Theme>
      <ChatContext.Provider value={ctx}>
        <ChatInputContext.Provider value={inputCtx}>
          <ChatInput />
        </ChatInputContext.Provider>
      </ChatContext.Provider>
    </Theme>
  );
  return { onSendMessage, flushOutboxAndInterrupt, undoLastAction };
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
}

describe("ChatInput keyboard shortcuts", () => {
  it("Enter sends with default mode (no after-turn metadata)", () => {
    const { onSendMessage } = renderInput();
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    const [, options] = onSendMessage.mock.calls[0]!;
    expect(options?.metadata?.deliverAfterTurn).toBeUndefined();
  });

  it("Shift+Enter does NOT send (newline)", () => {
    const { onSendMessage } = renderInput();
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  // "Send & interrupt" was removed: interrupting is now the separate flush-queue
  // control. Cmd/Ctrl+Enter just sends (default mode), never flushing.
  it("Ctrl+Enter sends (default mode, no interrupt/flush)", () => {
    const { onSendMessage, flushOutboxAndInterrupt } = renderInput({ agentBusy: true });
    fireEvent.keyDown(textarea(), { key: "Enter", ctrlKey: true });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    const [, options] = onSendMessage.mock.calls[0]!;
    expect(options?.metadata?.deliverAfterTurn).toBeUndefined();
    expect(flushOutboxAndInterrupt).not.toHaveBeenCalled();
  });

  it("Cmd+Enter (metaKey) also sends (default mode, no flush)", () => {
    const { onSendMessage, flushOutboxAndInterrupt } = renderInput({ agentBusy: true });
    fireEvent.keyDown(textarea(), { key: "Enter", metaKey: true });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    expect(flushOutboxAndInterrupt).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+Enter sends after the turn (deliverAfterTurn metadata)", () => {
    const { onSendMessage } = renderInput({ agentBusy: true, hasOpenTurn: true });
    fireEvent.keyDown(textarea(), { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    const [, options] = onSendMessage.mock.calls[0]!;
    expect(options?.metadata?.deliverAfterTurn).toBe(true);
  });

  it("Ctrl+Shift+Enter falls back to default send when no turn is open", () => {
    const { onSendMessage } = renderInput({ agentBusy: true, hasOpenTurn: false });
    fireEvent.keyDown(textarea(), { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(onSendMessage).toHaveBeenCalledTimes(1);
    const [, options] = onSendMessage.mock.calls[0]!;
    expect(options?.metadata?.deliverAfterTurn).toBeUndefined();
  });

  it("Escape flushes (advance pipeline) only when composer empty and agent busy", () => {
    const { flushOutboxAndInterrupt } = renderInput({ input: "", agentBusy: true });
    fireEvent.keyDown(textarea(), { key: "Escape" });
    expect(flushOutboxAndInterrupt).toHaveBeenCalledTimes(1);
  });

  it("Escape does NOT flush when the composer has text", () => {
    const { flushOutboxAndInterrupt } = renderInput({ input: "draft", agentBusy: true });
    fireEvent.keyDown(textarea(), { key: "Escape" });
    expect(flushOutboxAndInterrupt).not.toHaveBeenCalled();
  });
});

describe("ChatInput send-button intent", () => {
  // The primary send control is icon-only; intent is exposed via aria-label.
  it("idle shows the Send intent", () => {
    renderInput({ agentBusy: false, primaryActionIntent: "send" });
    expect(screen.getByLabelText(/^Send \(/)).toBeTruthy();
  });

  it("agent busy shows the Steer intent", () => {
    renderInput({ agentBusy: true, primaryActionIntent: "steer" });
    expect(screen.getByLabelText(/^Steer \(/)).toBeTruthy();
  });

  it("keeps send options available for attachment when the composer is empty", () => {
    renderInput({ input: "" });
    const primary = screen.getByLabelText(/^Send \(/).closest("button");
    const options = screen.getByLabelText("Send options").closest("button");
    expect(primary?.hasAttribute("disabled")).toBe(true);
    expect(options?.hasAttribute("disabled")).toBe(false);
  });
});

describe("ChatInput narration / undo / ghost", () => {
  it("renders the flush narration pill with an aria-live region", () => {
    renderInput({ flushNarration: { text: "Delivered 2 steers", remaining: 0 } });
    const pill = screen.getByText("Delivered 2 steers");
    expect(pill).toBeTruthy();
    expect(pill.closest('[aria-live="polite"]')).toBeTruthy();
  });

  it("renders the undo snackbar and fires undoLastAction", () => {
    const { undoLastAction } = renderInput({
      undoableAction: { kind: "cancel", messageIds: ["m1"], expiresAt: Date.now() + 5000 },
    });
    fireEvent.click(screen.getByText("Undo"));
    expect(undoLastAction).toHaveBeenCalledTimes(1);
  });

  it("shows the Sending… ghost while a send is in flight", () => {
    renderInput({ pendingSendCount: 1 });
    expect(screen.getByText("Sending…")).toBeTruthy();
  });
});

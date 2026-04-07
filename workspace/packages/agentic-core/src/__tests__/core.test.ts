/**
 * Unit tests for @workspace/agentic-core
 *
 * Tests the pure/unit-testable pieces:
 * - TypedEmitter
 * - MessageState + messageWindowReducer
 * - MethodHistoryTracker
 * - dispatchAgenticEvent + aggregatedToChatMessage
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TypedEmitter } from "../emitter.js";
import { MessageState } from "../message-state.js";
import {
  messageWindowReducer,
  messageWindowInitialState,
  type MessageWindowState,
} from "../message-reducer.js";
import { MethodHistoryTracker } from "../method-history.js";
import {
  dispatchAgenticEvent,
  aggregatedToChatMessage,
  type AgentEventHandlers,
  type EventMiddleware,
} from "../event-dispatch.js";
import type { ChatMessage, MethodHistoryEntry, ChatParticipantMetadata } from "../types.js";
import type {
  IncomingEvent,
  IncomingMethodResult,
  AggregatedMessage,
  Participant,
} from "@natstack/pubsub";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockHandlers() {
  const messages: ChatMessage[][] = [];
  return {
    handlers: {
      setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
        const prev = messages[messages.length - 1] ?? [];
        messages.push(updater(prev));
      },
      addMethodHistoryEntry: vi.fn(),
      handleMethodResult: vi.fn(),
    } satisfies AgentEventHandlers,
    getMessages: () => messages[messages.length - 1] ?? [],
    getAllSnapshots: () => messages,
  };
}

function makeChatMessage(overrides: Partial<ChatMessage> & { id: string; senderId: string }): ChatMessage {
  return {
    content: "",
    kind: "message",
    ...overrides,
  };
}

function makeIncomingMessage(overrides: Partial<IncomingEvent> = {}): IncomingEvent {
  return {
    type: "message",
    kind: "persisted",
    senderId: "agent-1",
    ts: Date.now(),
    id: "msg-1",
    content: "Hello",
    ...overrides,
  } as IncomingEvent;
}

// ============================================================================
// TypedEmitter
// ============================================================================

describe("TypedEmitter", () => {
  interface TestEvents {
    greet: (name: string) => void;
    count: (n: number) => void;
    noArgs: () => void;
  }

  let emitter: TypedEmitter<TestEvents>;

  beforeEach(() => {
    emitter = new TypedEmitter<TestEvents>();
  });

  it("on/emit basic functionality", () => {
    const handler = vi.fn();
    emitter.on("greet", handler);
    emitter.emit("greet", "Alice");
    expect(handler).toHaveBeenCalledWith("Alice");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("supports multiple handlers for the same event", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    emitter.on("greet", handler1);
    emitter.on("greet", handler2);
    emitter.emit("greet", "Bob");
    expect(handler1).toHaveBeenCalledWith("Bob");
    expect(handler2).toHaveBeenCalledWith("Bob");
  });

  it("does not fire handlers for other events", () => {
    const greetHandler = vi.fn();
    const countHandler = vi.fn();
    emitter.on("greet", greetHandler);
    emitter.on("count", countHandler);
    emitter.emit("greet", "Alice");
    expect(greetHandler).toHaveBeenCalledTimes(1);
    expect(countHandler).not.toHaveBeenCalled();
  });

  it("once fires only once", () => {
    const handler = vi.fn();
    emitter.once("greet", handler);
    emitter.emit("greet", "First");
    emitter.emit("greet", "Second");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("First");
  });

  it("unsubscribe works via return value from on()", () => {
    const handler = vi.fn();
    const unsub = emitter.on("greet", handler);
    emitter.emit("greet", "Before");
    expect(handler).toHaveBeenCalledTimes(1);
    unsub();
    emitter.emit("greet", "After");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe works via return value from once()", () => {
    const handler = vi.fn();
    const unsub = emitter.once("greet", handler);
    unsub();
    emitter.emit("greet", "Should not fire");
    expect(handler).not.toHaveBeenCalled();
  });

  it("removeAllListeners removes all events", () => {
    const greetHandler = vi.fn();
    const countHandler = vi.fn();
    emitter.on("greet", greetHandler);
    emitter.on("count", countHandler);
    emitter.removeAllListeners();
    emitter.emit("greet", "nope");
    emitter.emit("count", 42);
    expect(greetHandler).not.toHaveBeenCalled();
    expect(countHandler).not.toHaveBeenCalled();
  });

  it("removeListenersFor removes only a specific event", () => {
    const greetHandler = vi.fn();
    const countHandler = vi.fn();
    emitter.on("greet", greetHandler);
    emitter.on("count", countHandler);
    emitter.removeListenersFor("greet");
    emitter.emit("greet", "nope");
    emitter.emit("count", 42);
    expect(greetHandler).not.toHaveBeenCalled();
    expect(countHandler).toHaveBeenCalledWith(42);
  });

  it("errors in one handler do not crash other handlers", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const badHandler = vi.fn(() => {
      throw new Error("boom");
    });
    const goodHandler = vi.fn();
    emitter.on("greet", badHandler);
    emitter.on("greet", goodHandler);
    emitter.emit("greet", "test");
    expect(badHandler).toHaveBeenCalled();
    expect(goodHandler).toHaveBeenCalledWith("test");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("emitting an event with no listeners does not throw", () => {
    expect(() => emitter.emit("noArgs")).not.toThrow();
  });
});

// ============================================================================
// messageWindowReducer
// ============================================================================

describe("messageWindowReducer", () => {
  it("replace action with updater function appends messages", () => {
    const state = { ...messageWindowInitialState };
    const msg: ChatMessage = makeChatMessage({ id: "1", senderId: "s", content: "hi", pubsubId: 10 });
    const next = messageWindowReducer(state, {
      type: "replace",
      updater: (prev) => [...prev, msg],
    });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]!.id).toBe("1");
  });

  it("replace with identity function returns same state ref (no onChange)", () => {
    const msg: ChatMessage = makeChatMessage({ id: "1", senderId: "s", content: "hi" });
    const state: MessageWindowState = {
      messages: [msg],
      oldestLoadedId: null,
      paginationExhausted: false,
    };
    const next = messageWindowReducer(state, {
      type: "replace",
      updater: (prev) => prev, // identity
    });
    expect(next).toBe(state); // same reference
  });

  it("initializes oldestLoadedId from first message with pubsubId", () => {
    const state = { ...messageWindowInitialState };
    const msg: ChatMessage = makeChatMessage({ id: "1", senderId: "s", pubsubId: 42 });
    const next = messageWindowReducer(state, {
      type: "replace",
      updater: () => [msg],
    });
    expect(next.oldestLoadedId).toBe(42);
  });

  it("does not overwrite oldestLoadedId once initialized", () => {
    const state: MessageWindowState = {
      messages: [makeChatMessage({ id: "1", senderId: "s", pubsubId: 10 })],
      oldestLoadedId: 10,
      paginationExhausted: false,
    };
    const newMsg = makeChatMessage({ id: "2", senderId: "s", pubsubId: 5 });
    const next = messageWindowReducer(state, {
      type: "replace",
      updater: (prev) => [newMsg, ...prev],
    });
    expect(next.oldestLoadedId).toBe(10);
  });

  it("auto-trims when exceeding threshold (2 * 500 = 1000)", () => {
    // The threshold is TRIM_THRESHOLD = MAX_VISIBLE_MESSAGES * 2 = 1000
    // Create state with messages and add enough to exceed threshold
    const state = { ...messageWindowInitialState };
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 1001; i++) {
      messages.push(makeChatMessage({ id: `msg-${i}`, senderId: "s", pubsubId: i + 1 }));
    }
    const next = messageWindowReducer(state, {
      type: "replace",
      updater: () => messages,
    });
    // Should be trimmed to MAX_VISIBLE_MESSAGES = 500
    expect(next.messages.length).toBe(500);
    // Should keep the last 500 messages
    expect(next.messages[0]!.id).toBe("msg-501");
    expect(next.messages[499]!.id).toBe("msg-1000");
    // oldestLoadedId should be updated to the first message in trimmed window
    expect(next.oldestLoadedId).toBe(502); // pubsubId of msg-501
    // paginationExhausted should be reset
    expect(next.paginationExhausted).toBe(false);
  });

  describe("prepend action", () => {
    it("prepends older messages and updates cursor", () => {
      const existing = makeChatMessage({ id: "new-1", senderId: "s", pubsubId: 100 });
      const state: MessageWindowState = {
        messages: [existing],
        oldestLoadedId: 100,
        paginationExhausted: false,
      };
      const older = makeChatMessage({ id: "old-1", senderId: "s", pubsubId: 50 });
      const next = messageWindowReducer(state, {
        type: "prepend",
        olderMessages: [older],
        newCursor: 50,
        exhausted: false,
      });
      expect(next.messages).toHaveLength(2);
      expect(next.messages[0]!.id).toBe("old-1");
      expect(next.messages[1]!.id).toBe("new-1");
      expect(next.oldestLoadedId).toBe(50);
    });

    it("deduplicates by pubsubId", () => {
      const existing = makeChatMessage({ id: "m1", senderId: "s", pubsubId: 10 });
      const state: MessageWindowState = {
        messages: [existing],
        oldestLoadedId: 10,
        paginationExhausted: false,
      };
      const duplicate = makeChatMessage({ id: "m1-dup", senderId: "s", pubsubId: 10 });
      const next = messageWindowReducer(state, {
        type: "prepend",
        olderMessages: [duplicate],
        newCursor: 5,
        exhausted: false,
      });
      expect(next.messages).toHaveLength(1);
      expect(next.messages[0]!.id).toBe("m1");
    });

    it("deduplicates by message id", () => {
      const existing = makeChatMessage({ id: "same-id", senderId: "s", pubsubId: 10 });
      const state: MessageWindowState = {
        messages: [existing],
        oldestLoadedId: 10,
        paginationExhausted: false,
      };
      const duplicate = makeChatMessage({ id: "same-id", senderId: "s", pubsubId: 5 });
      const next = messageWindowReducer(state, {
        type: "prepend",
        olderMessages: [duplicate],
        newCursor: 3,
        exhausted: false,
      });
      expect(next.messages).toHaveLength(1);
    });

    it("sets paginationExhausted flag", () => {
      const state: MessageWindowState = {
        messages: [],
        oldestLoadedId: null,
        paginationExhausted: false,
      };
      const next = messageWindowReducer(state, {
        type: "prepend",
        olderMessages: [],
        newCursor: 0,
        exhausted: true,
      });
      expect(next.paginationExhausted).toBe(true);
    });

    it("returns same messages array when all prepended messages are duplicates", () => {
      const existing = makeChatMessage({ id: "m1", senderId: "s", pubsubId: 10 });
      const state: MessageWindowState = {
        messages: [existing],
        oldestLoadedId: 10,
        paginationExhausted: false,
      };
      const next = messageWindowReducer(state, {
        type: "prepend",
        olderMessages: [makeChatMessage({ id: "m1", senderId: "s", pubsubId: 10 })],
        newCursor: 5,
        exhausted: false,
      });
      // Messages array should be the same reference since no new items were added
      expect(next.messages).toBe(state.messages);
    });
  });
});

// ============================================================================
// MessageState (imperative wrapper)
// ============================================================================

describe("MessageState", () => {
  it("setMessages calls onChange when messages change", () => {
    const onChange = vi.fn();
    const ms = new MessageState(onChange);
    ms.setMessages(() => [makeChatMessage({ id: "1", senderId: "s" })]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(ms.messages).toHaveLength(1);
  });

  it("setMessages with identity updater does NOT call onChange", () => {
    const onChange = vi.fn();
    const ms = new MessageState(onChange);
    ms.setMessages(() => [makeChatMessage({ id: "1", senderId: "s" })]);
    onChange.mockClear();
    ms.setMessages((prev) => prev); // identity
    expect(onChange).not.toHaveBeenCalled();
  });

  it("prepend deduplicates and calls onChange", () => {
    const onChange = vi.fn();
    const ms = new MessageState(onChange);
    ms.setMessages(() => [makeChatMessage({ id: "m1", senderId: "s", pubsubId: 10 })]);
    onChange.mockClear();
    ms.prepend(
      [makeChatMessage({ id: "m0", senderId: "s", pubsubId: 5 })],
      5,
      false,
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(ms.messages).toHaveLength(2);
    expect(ms.messages[0]!.id).toBe("m0");
    expect(ms.oldestLoadedId).toBe(5);
  });

  it("tracks paginationExhausted", () => {
    const ms = new MessageState(vi.fn());
    expect(ms.paginationExhausted).toBe(false);
    ms.prepend([], 0, true);
    expect(ms.paginationExhausted).toBe(true);
  });

  it("window accessor returns current state", () => {
    const ms = new MessageState(vi.fn());
    expect(ms.window.messages).toEqual([]);
    expect(ms.window.oldestLoadedId).toBeNull();
    expect(ms.window.paginationExhausted).toBe(false);
  });
});

// ============================================================================
// MethodHistoryTracker
// ============================================================================

describe("MethodHistoryTracker", () => {
  let tracker: MethodHistoryTracker;
  let messageSnapshots: ChatMessage[][];
  let onChangeCalls: ReadonlyMap<string, MethodHistoryEntry>[];

  function setMessages(updater: (prev: ChatMessage[]) => ChatMessage[]) {
    const prev = messageSnapshots[messageSnapshots.length - 1] ?? [];
    messageSnapshots.push(updater(prev));
  }
  function getMessages() {
    return messageSnapshots[messageSnapshots.length - 1] ?? [];
  }

  beforeEach(() => {
    messageSnapshots = [];
    onChangeCalls = [];
    tracker = new MethodHistoryTracker({
      clientId: "panel-1",
      setMessages,
      onChange: (entries) => {
        onChangeCalls.push(new Map(entries));
      },
    });
  });

  it("addEntry creates a new entry and a method message", () => {
    const entry: MethodHistoryEntry = {
      callId: "call-1",
      methodName: "doStuff",
      args: { x: 1 },
      status: "pending",
      startedAt: 1000,
    };
    tracker.addEntry(entry);
    expect(tracker.current.get("call-1")).toBeDefined();
    expect(tracker.current.get("call-1")!.methodName).toBe("doStuff");
    // Should have added a method message
    const msgs = getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.id).toBe("method-call-1");
    expect(msgs[0]!.kind).toBe("method");
    expect(msgs[0]!.senderId).toBe("panel-1");
    // onChange should have been called
    expect(onChangeCalls.length).toBeGreaterThan(0);
  });

  it("addEntry with existing callId merges", () => {
    tracker.addEntry({
      callId: "call-1",
      methodName: "doStuff",
      args: { x: 1 },
      status: "pending",
      startedAt: 1000,
    });
    const msgsBefore = getMessages();
    tracker.addEntry({
      callId: "call-1",
      methodName: "doStuff",
      args: { x: 2 },
      status: "pending",
      startedAt: 1000,
      description: "updated",
    });
    // Should have merged, not created a second entry
    expect(tracker.current.size).toBe(1);
    expect(tracker.current.get("call-1")!.args).toEqual({ x: 2 });
    expect(tracker.current.get("call-1")!.description).toBe("updated");
    // Should NOT have added a second method message
    const msgsAfter = getMessages();
    expect(msgsAfter.length).toBe(msgsBefore.length);
  });

  it("handleMethodResult updates status to success", () => {
    tracker.addEntry({
      callId: "call-1",
      methodName: "doStuff",
      args: {},
      status: "pending",
      startedAt: 1000,
    });
    const result: IncomingMethodResult = {
      kind: "persisted",
      senderId: "provider-1",
      ts: 2000,
      callId: "call-1",
      content: { answer: 42 },
      complete: true,
      isError: false,
    };
    tracker.handleMethodResult(result);
    const entry = tracker.current.get("call-1")!;
    expect(entry.status).toBe("success");
    expect(entry.result).toEqual({ answer: 42 });
    expect(entry.completedAt).toBeDefined();
  });

  it("handleMethodResult updates status to error", () => {
    tracker.addEntry({
      callId: "call-1",
      methodName: "doStuff",
      args: {},
      status: "pending",
      startedAt: 1000,
    });
    const result: IncomingMethodResult = {
      kind: "persisted",
      senderId: "provider-1",
      ts: 2000,
      callId: "call-1",
      content: { error: "something broke" },
      complete: true,
      isError: true,
    };
    tracker.handleMethodResult(result);
    const entry = tracker.current.get("call-1")!;
    expect(entry.status).toBe("error");
    expect(entry.error).toBe("something broke");
  });

  it("handleMethodResult with string error content", () => {
    tracker.addEntry({
      callId: "call-1",
      methodName: "doStuff",
      args: {},
      status: "pending",
      startedAt: 1000,
    });
    const result: IncomingMethodResult = {
      kind: "persisted",
      senderId: "provider-1",
      ts: 2000,
      callId: "call-1",
      content: "direct error string",
      complete: true,
      isError: true,
    };
    tracker.handleMethodResult(result);
    expect(tracker.current.get("call-1")!.error).toBe("direct error string");
  });

  it("handleMethodResult ignores unknown callId", () => {
    const result: IncomingMethodResult = {
      kind: "persisted",
      senderId: "provider-1",
      ts: 2000,
      callId: "unknown-call",
      content: {},
      complete: true,
      isError: false,
    };
    // Should not throw
    tracker.handleMethodResult(result);
    expect(tracker.current.size).toBe(0);
  });

  it("handleMethodResult updates progress", () => {
    tracker.addEntry({
      callId: "call-1",
      methodName: "doStuff",
      args: {},
      status: "pending",
      startedAt: 1000,
    });
    const result: IncomingMethodResult = {
      kind: "ephemeral",
      senderId: "provider-1",
      ts: 1500,
      callId: "call-1",
      complete: false,
      isError: false,
      progress: 50,
    };
    tracker.handleMethodResult(result);
    expect(tracker.current.get("call-1")!.progress).toBe(50);
    expect(tracker.current.get("call-1")!.status).toBe("pending"); // not complete yet
  });

  describe("console chunk handling", () => {
    it("appendConsoleOutput appends lines", () => {
      tracker.addEntry({
        callId: "call-1",
        methodName: "run",
        args: {},
        status: "pending",
        startedAt: 1000,
      });
      const consoleResult: IncomingMethodResult = {
        kind: "ephemeral",
        senderId: "provider-1",
        ts: 1500,
        callId: "call-1",
        content: { type: "console", content: "line 1" },
        complete: false,
        isError: false,
      };
      tracker.handleMethodResult(consoleResult);
      expect(tracker.current.get("call-1")!.consoleOutput).toBe("line 1");

      const consoleResult2: IncomingMethodResult = {
        ...consoleResult,
        content: { type: "console", content: "line 2" },
      };
      tracker.handleMethodResult(consoleResult2);
      expect(tracker.current.get("call-1")!.consoleOutput).toBe("line 1\nline 2");
    });

    it("skips console output when handledLocally and consoleOutput already exists", () => {
      tracker.addEntry({
        callId: "call-1",
        methodName: "run",
        args: {},
        status: "pending",
        startedAt: 1000,
        handledLocally: true,
        consoleOutput: "existing output",
      });
      const consoleResult: IncomingMethodResult = {
        kind: "ephemeral",
        senderId: "provider-1",
        ts: 1500,
        callId: "call-1",
        content: { type: "console", content: "remote line" },
        complete: false,
        isError: false,
      };
      tracker.handleMethodResult(consoleResult);
      // Should not append because handledLocally=true AND consoleOutput exists
      expect(tracker.current.get("call-1")!.consoleOutput).toBe("existing output");
    });
  });

  describe("pruning", () => {
    it("prunes completed entries when exceeding 80% of 2000 (1600)", () => {
      // Add 1600 completed entries (hits the PRUNE_THRESHOLD)
      for (let i = 0; i < 1600; i++) {
        tracker.addEntry({
          callId: `call-${i}`,
          methodName: "m",
          args: {},
          status: "success",
          startedAt: i,
          completedAt: i + 1,
        });
      }
      // Add one more to trigger pruning (size will be 1601 > 1600)
      tracker.addEntry({
        callId: "call-trigger",
        methodName: "m",
        args: {},
        status: "success",
        startedAt: 9999,
        completedAt: 10000,
      });

      // After pruning, should be at or below PRUNE_TARGET = 1400
      expect(tracker.current.size).toBeLessThanOrEqual(1400);
    });

    it("pruning removes oldest completed entries first", () => {
      // Add a pending entry and many completed entries
      tracker.addEntry({
        callId: "pending-1",
        methodName: "m",
        args: {},
        status: "pending",
        startedAt: 0,
      });

      for (let i = 1; i <= 1600; i++) {
        tracker.addEntry({
          callId: `completed-${i}`,
          methodName: "m",
          args: {},
          status: "success",
          startedAt: i,
          completedAt: i + 1,
        });
      }

      // The pending entry should survive pruning
      expect(tracker.current.has("pending-1")).toBe(true);
      // The most recent completed entries should survive
      expect(tracker.current.has("completed-1600")).toBe(true);
    });

    it("pruning also removes method messages from messages list", () => {
      for (let i = 0; i < 1601; i++) {
        tracker.addEntry({
          callId: `call-${i}`,
          methodName: "m",
          args: {},
          status: "success",
          startedAt: i,
          completedAt: i + 1,
        });
      }

      // Messages should have been pruned too
      const msgs = getMessages();
      // The pruned method messages should be removed
      expect(msgs.length).toBeLessThan(1601);
    });
  });

  it("clear removes all entries", () => {
    tracker.addEntry({
      callId: "call-1",
      methodName: "m",
      args: {},
      status: "pending",
      startedAt: 1000,
    });
    tracker.clear();
    expect(tracker.current.size).toBe(0);
    expect(onChangeCalls[onChangeCalls.length - 1]!.size).toBe(0);
  });
});

// ============================================================================
// dispatchAgenticEvent
// ============================================================================

describe("dispatchAgenticEvent", () => {
  const selfId = "panel-1";
  const participants: Record<string, Participant<ChatParticipantMetadata>> = {
    "provider-1": {
      id: "provider-1",
      metadata: {
        name: "AI Agent",
        type: "agent",
        handle: "claude",
        methods: [{ name: "doStuff", description: "Does stuff", parameters: {} }],
      },
    },
  };

  describe("message event", () => {
    it("creates a ChatMessage from incoming message", () => {
      const { handlers, getMessages } = createMockHandlers();
      const event = makeIncomingMessage({
        id: "msg-1",
        content: "Hello world",
        senderId: "agent-1",
        pubsubId: 10,
      });
      dispatchAgenticEvent(event, handlers, selfId, participants);
      const msgs = getMessages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.id).toBe("msg-1");
      expect(msgs[0]!.content).toBe("Hello world");
      expect(msgs[0]!.senderId).toBe("agent-1");
      expect(msgs[0]!.kind).toBe("message");
      expect(msgs[0]!.pubsubId).toBe(10);
    });

    it("deduplicates by pubsubId on message events", () => {
      const { handlers, getMessages } = createMockHandlers();
      const event1 = makeIncomingMessage({ id: "msg-1", pubsubId: 10 });
      const event2 = makeIncomingMessage({ id: "msg-2", pubsubId: 10 });
      dispatchAgenticEvent(event1, handlers, selfId, participants);
      dispatchAgenticEvent(event2, handlers, selfId, participants);
      expect(getMessages()).toHaveLength(1);
    });

    it("deduplicates by id (existing message)", () => {
      const { handlers, getMessages } = createMockHandlers();
      const event = makeIncomingMessage({ id: "msg-1" });
      dispatchAgenticEvent(event, handlers, selfId, participants);
      dispatchAgenticEvent(event, handlers, selfId, participants);
      expect(getMessages()).toHaveLength(1);
    });

    it("marks replay messages as complete", () => {
      const { handlers, getMessages } = createMockHandlers();
      const event = makeIncomingMessage({ id: "msg-1", kind: "replay" });
      dispatchAgenticEvent(event, handlers, selfId, participants);
      expect(getMessages()[0]!.complete).toBe(true);
    });

    it("self-message detection (isPanelSender) marks complete", () => {
      const { handlers, getMessages } = createMockHandlers();
      const event = makeIncomingMessage({
        id: "msg-1",
        senderId: selfId,
        kind: "persisted",
      });
      dispatchAgenticEvent(event, handlers, selfId, participants);
      expect(getMessages()[0]!.complete).toBe(true);
    });

    it("panel type sender is marked complete", () => {
      const { handlers, getMessages } = createMockHandlers();
      const event = makeIncomingMessage({
        id: "msg-1",
        senderId: "other-panel",
        kind: "persisted",
        senderMetadata: { type: "panel", name: "Panel", handle: "user" },
      });
      dispatchAgenticEvent(event, handlers, selfId, participants);
      expect(getMessages()[0]!.complete).toBe(true);
    });

    it("non-panel non-self sender is NOT marked complete", () => {
      const { handlers, getMessages } = createMockHandlers();
      const event = makeIncomingMessage({
        id: "msg-1",
        senderId: "agent-1",
        kind: "persisted",
        senderMetadata: { type: "agent", name: "Agent", handle: "claude" },
      });
      dispatchAgenticEvent(event, handlers, selfId, participants);
      expect(getMessages()[0]!.complete).toBe(false);
    });

    it("updates pending message to non-pending when received from server", () => {
      const { handlers, getMessages } = createMockHandlers();
      // First, add a pending message directly
      handlers.setMessages(() => [
        makeChatMessage({ id: "msg-1", senderId: selfId, content: "hi", pending: true }),
      ]);
      // Now dispatch the server echo
      const event = makeIncomingMessage({
        id: "msg-1",
        senderId: selfId,
        content: "hi",
        kind: "persisted",
      });
      dispatchAgenticEvent(event, handlers, selfId, participants);
      const msg = getMessages().find((m) => m.id === "msg-1");
      expect(msg!.pending).toBe(false);
      expect(msg!.complete).toBe(true); // isPanelSender
    });

    it("stores senderMetadata snapshot on new messages", () => {
      const { handlers, getMessages } = createMockHandlers();
      const event = makeIncomingMessage({
        id: "msg-1",
        senderId: "agent-1",
        senderMetadata: { name: "Claude", type: "agent", handle: "claude" },
      });
      dispatchAgenticEvent(event, handlers, selfId, participants);
      expect(getMessages()[0]!.senderMetadata).toEqual({
        name: "Claude",
        type: "agent",
        handle: "claude",
      });
    });
  });

  describe("update-message event", () => {
    it("appends content to existing message", () => {
      const { handlers, getMessages } = createMockHandlers();
      // Create initial message
      const initial = makeIncomingMessage({ id: "msg-1", content: "Hello" });
      dispatchAgenticEvent(initial, handlers, selfId, participants);
      // Update with more content
      const update: IncomingEvent = {
        type: "update-message",
        kind: "ephemeral",
        senderId: "agent-1",
        ts: Date.now(),
        id: "msg-1",
        content: " world",
      } as IncomingEvent;
      dispatchAgenticEvent(update, handlers, selfId, participants);
      expect(getMessages()[0]!.content).toBe("Hello world");
    });

    it("marks message complete on update", () => {
      const { handlers, getMessages } = createMockHandlers();
      const initial = makeIncomingMessage({ id: "msg-1", content: "Hi" });
      dispatchAgenticEvent(initial, handlers, selfId, participants);
      const update: IncomingEvent = {
        type: "update-message",
        kind: "ephemeral",
        senderId: "agent-1",
        ts: Date.now(),
        id: "msg-1",
        complete: true,
      } as IncomingEvent;
      dispatchAgenticEvent(update, handlers, selfId, participants);
      expect(getMessages()[0]!.complete).toBe(true);
    });
  });

  describe("error event", () => {
    it("marks message complete with error", () => {
      const { handlers, getMessages } = createMockHandlers();
      const initial = makeIncomingMessage({ id: "msg-1", content: "Processing..." });
      dispatchAgenticEvent(initial, handlers, selfId, participants);
      const error: IncomingEvent = {
        type: "error",
        kind: "persisted",
        senderId: "agent-1",
        ts: Date.now(),
        id: "msg-1",
        error: "Something went wrong",
      } as IncomingEvent;
      dispatchAgenticEvent(error, handlers, selfId, participants);
      const msg = getMessages()[0]!;
      expect(msg.complete).toBe(true);
      expect(msg.error).toBe("Something went wrong");
    });
  });

  describe("method-call event", () => {
    it("creates method history entry", () => {
      const { handlers } = createMockHandlers();
      const event: IncomingEvent = {
        type: "method-call",
        kind: "persisted",
        senderId: "agent-1",
        ts: 5000,
        callId: "call-1",
        methodName: "doStuff",
        providerId: "provider-1",
        args: { x: 1 },
      } as IncomingEvent;
      dispatchAgenticEvent(event, handlers, selfId, participants);
      expect(handlers.addMethodHistoryEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: "call-1",
          methodName: "doStuff",
          args: { x: 1 },
          status: "pending",
          providerId: "provider-1",
          callerId: "agent-1",
          description: "Does stuff",
        }),
      );
    });

    it("sets handledLocally when provider is self", () => {
      const { handlers } = createMockHandlers();
      const event: IncomingEvent = {
        type: "method-call",
        kind: "persisted",
        senderId: "agent-1",
        ts: 5000,
        callId: "call-1",
        methodName: "localMethod",
        providerId: selfId,
        args: {},
      } as IncomingEvent;
      dispatchAgenticEvent(event, handlers, selfId, participants);
      expect(handlers.addMethodHistoryEntry).toHaveBeenCalledWith(
        expect.objectContaining({ handledLocally: true }),
      );
    });

    it("sets handledLocally=false when provider is not self", () => {
      const { handlers } = createMockHandlers();
      const event: IncomingEvent = {
        type: "method-call",
        kind: "persisted",
        senderId: "agent-1",
        ts: 5000,
        callId: "call-1",
        methodName: "doStuff",
        providerId: "provider-1",
        args: {},
      } as IncomingEvent;
      dispatchAgenticEvent(event, handlers, selfId, participants);
      expect(handlers.addMethodHistoryEntry).toHaveBeenCalledWith(
        expect.objectContaining({ handledLocally: false }),
      );
    });

    it("uses event.ts for startedAt, falls back to Date.now()", () => {
      const { handlers } = createMockHandlers();
      const event: IncomingEvent = {
        type: "method-call",
        kind: "persisted",
        senderId: "agent-1",
        ts: 12345,
        callId: "call-1",
        methodName: "doStuff",
        providerId: "provider-1",
        args: {},
      } as IncomingEvent;
      dispatchAgenticEvent(event, handlers, selfId, participants);
      expect(handlers.addMethodHistoryEntry).toHaveBeenCalledWith(
        expect.objectContaining({ startedAt: 12345 }),
      );
    });
  });

  describe("method-result event", () => {
    it("delegates to handleMethodResult", () => {
      const { handlers } = createMockHandlers();
      const event: IncomingEvent = {
        type: "method-result",
        kind: "persisted",
        senderId: "provider-1",
        ts: Date.now(),
        callId: "call-1",
        content: { answer: 42 },
        complete: true,
        isError: false,
      } as IncomingEvent;
      dispatchAgenticEvent(event, handlers, selfId, participants);
      expect(handlers.handleMethodResult).toHaveBeenCalledWith(
        expect.objectContaining({ callId: "call-1" }),
      );
    });
  });

  describe("middleware", () => {
    it("calling next() continues to default handling", () => {
      const { handlers, getMessages } = createMockHandlers();
      const middleware: EventMiddleware = (_event, next) => {
        next();
      };
      const event = makeIncomingMessage({ id: "msg-1", content: "Hi" });
      dispatchAgenticEvent(event, handlers, selfId, participants, [middleware]);
      expect(getMessages()).toHaveLength(1);
    });

    it("not calling next() swallows the event", () => {
      const { handlers, getMessages } = createMockHandlers();
      const middleware: EventMiddleware = (_event, _next) => {
        // intentionally do nothing - swallow the event
      };
      const event = makeIncomingMessage({ id: "msg-1", content: "Hi" });
      dispatchAgenticEvent(event, handlers, selfId, participants, [middleware]);
      expect(getMessages()).toHaveLength(0);
    });

    it("multiple middleware chain correctly", () => {
      const { handlers, getMessages } = createMockHandlers();
      const callOrder: string[] = [];
      const mw1: EventMiddleware = (_event, next) => {
        callOrder.push("mw1-before");
        next();
        callOrder.push("mw1-after");
      };
      const mw2: EventMiddleware = (_event, next) => {
        callOrder.push("mw2-before");
        next();
        callOrder.push("mw2-after");
      };
      const event = makeIncomingMessage({ id: "msg-1", content: "Hi" });
      dispatchAgenticEvent(event, handlers, selfId, participants, [mw1, mw2]);
      expect(getMessages()).toHaveLength(1);
      expect(callOrder).toEqual(["mw1-before", "mw2-before", "mw2-after", "mw1-after"]);
    });

    it("second middleware swallowing prevents default handling", () => {
      const { handlers, getMessages } = createMockHandlers();
      const mw1: EventMiddleware = (_event, next) => {
        next(); // continues to mw2
      };
      const mw2: EventMiddleware = (_event, _next) => {
        // swallow
      };
      const event = makeIncomingMessage({ id: "msg-1", content: "Hi" });
      dispatchAgenticEvent(event, handlers, selfId, participants, [mw1, mw2]);
      expect(getMessages()).toHaveLength(0);
    });

    it("empty middleware array processes event normally", () => {
      const { handlers, getMessages } = createMockHandlers();
      const event = makeIncomingMessage({ id: "msg-1", content: "Hi" });
      dispatchAgenticEvent(event, handlers, selfId, participants, []);
      expect(getMessages()).toHaveLength(1);
    });
  });

  describe("execution-pause event", () => {
    it("marks the referenced message as complete", () => {
      const { handlers, getMessages } = createMockHandlers();
      const initial = makeIncomingMessage({ id: "msg-1", content: "Working..." });
      dispatchAgenticEvent(initial, handlers, selfId, participants);
      expect(getMessages()[0]!.complete).toBe(false);

      const pause: IncomingEvent = {
        type: "execution-pause",
        kind: "ephemeral",
        senderId: "agent-1",
        ts: Date.now(),
        messageId: "msg-1",
        status: "paused",
      } as IncomingEvent;
      dispatchAgenticEvent(pause, handlers, selfId, participants);
      expect(getMessages()[0]!.complete).toBe(true);
    });
  });
});

// ============================================================================
// aggregatedToChatMessage
// ============================================================================

describe("aggregatedToChatMessage", () => {
  it("converts AggregatedMessage fields correctly", () => {
    const agg: AggregatedMessage = {
      type: "message",
      kind: "replay",
      aggregated: true,
      pubsubId: 42,
      senderId: "agent-1",
      senderName: "Claude",
      senderType: "agent",
      senderHandle: "claude",
      ts: 12345,
      id: "msg-1",
      content: "Hello there",
      complete: true,
      incomplete: false,
      replyTo: "msg-0",
      contentType: "text/plain",
    };
    const msg = aggregatedToChatMessage(agg);
    expect(msg.id).toBe("msg-1");
    expect(msg.pubsubId).toBe(42);
    expect(msg.senderId).toBe("agent-1");
    expect(msg.content).toBe("Hello there");
    expect(msg.contentType).toBe("text/plain");
    expect(msg.kind).toBe("message");
    expect(msg.complete).toBe(true);
    expect(msg.replyTo).toBe("msg-0");
    expect(msg.error).toBeUndefined();
  });

  it("sets senderMetadata from senderName/senderType/senderHandle", () => {
    const agg: AggregatedMessage = {
      type: "message",
      kind: "replay",
      aggregated: true,
      pubsubId: 1,
      senderId: "s1",
      senderName: "Alice",
      senderType: "panel",
      senderHandle: "alice",
      ts: 100,
      id: "m1",
      content: "",
      complete: true,
      incomplete: false,
    };
    const msg = aggregatedToChatMessage(agg);
    expect(msg.senderMetadata).toEqual({
      name: "Alice",
      type: "panel",
      handle: "alice",
    });
  });

  it("marks complete=true when error is present even if complete is false", () => {
    const agg: AggregatedMessage = {
      type: "message",
      kind: "replay",
      aggregated: true,
      pubsubId: 1,
      senderId: "s1",
      ts: 100,
      id: "m1",
      content: "",
      complete: false,
      incomplete: true,
      error: "something failed",
    };
    const msg = aggregatedToChatMessage(agg);
    expect(msg.complete).toBe(true);
    expect(msg.error).toBe("something failed");
  });

  it("handles missing optional fields", () => {
    const agg: AggregatedMessage = {
      type: "message",
      kind: "replay",
      aggregated: true,
      pubsubId: 1,
      senderId: "s1",
      ts: 100,
      id: "m1",
      content: "hello",
      complete: true,
      incomplete: false,
    };
    const msg = aggregatedToChatMessage(agg);
    expect(msg.replyTo).toBeUndefined();
    expect(msg.contentType).toBeUndefined();
    expect(msg.error).toBeUndefined();
    expect(msg.senderMetadata).toEqual({
      name: undefined,
      type: undefined,
      handle: undefined,
    });
  });
});

// ============================================================================
// SessionManager
// ============================================================================

import { SessionManager } from "../session-manager.js";
import type { PendingAgent } from "../types.js";

describe("SessionManager", () => {
  function createManager() {
    return new SessionManager({
      config: { serverUrl: "ws://localhost", token: "test", clientId: "test-client" },
    });
  }

  // --------------------------------------------------------------------------
  // Construction & default state
  // --------------------------------------------------------------------------

  describe("construction and default state", () => {
    it("starts disconnected with empty state", () => {
      const manager = createManager();
      expect(manager.connected).toBe(false);
      expect(manager.status).toBe("disconnected");
      expect(manager.messages).toEqual([]);
      expect(manager.methodHistory.size).toBe(0);
      expect(manager.channelId).toBeNull();
      expect(manager.pendingAgents.size).toBe(0);
      expect(manager.debugEvents).toEqual([]);
      expect(manager.dirtyRepoWarnings.size).toBe(0);
      expect(manager.scopeManager).toBeNull();
      expect(manager.client).toBeNull();
      manager.dispose();
    });

    it("methodHistory getter returns a Map reference", () => {
      const manager = createManager();
      expect(manager.methodHistory).toBeInstanceOf(Map);
      manager.dispose();
    });
  });

  // --------------------------------------------------------------------------
  // Pending agent tracking
  // --------------------------------------------------------------------------

  describe("addPendingAgent", () => {
    it("adds an agent and emits pendingAgentsChanged", () => {
      const manager = createManager();
      const emitted: ReadonlyMap<string, PendingAgent>[] = [];
      manager.on("pendingAgentsChanged", (agents) => emitted.push(new Map(agents)));

      manager.addPendingAgent("my-agent", "agent-123");

      expect(manager.pendingAgents.get("my-agent")).toEqual({
        agentId: "agent-123",
        status: "starting",
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.get("my-agent")?.status).toBe("starting");
      manager.dispose();
    });

    it("is a no-op when handle already exists", () => {
      const manager = createManager();
      manager.addPendingAgent("my-agent", "agent-123");

      const emitted: unknown[] = [];
      manager.on("pendingAgentsChanged", (agents) => emitted.push(agents));

      manager.addPendingAgent("my-agent", "agent-999");

      // Should not have emitted again
      expect(emitted).toHaveLength(0);
      // Original agentId is preserved
      expect(manager.pendingAgents.get("my-agent")?.agentId).toBe("agent-123");
      manager.dispose();
    });

    it("tracks multiple pending agents independently", () => {
      const manager = createManager();
      manager.addPendingAgent("agent-a", "id-a");
      manager.addPendingAgent("agent-b", "id-b");

      expect(manager.pendingAgents.size).toBe(2);
      expect(manager.pendingAgents.get("agent-a")?.agentId).toBe("id-a");
      expect(manager.pendingAgents.get("agent-b")?.agentId).toBe("id-b");
      manager.dispose();
    });
  });

  // --------------------------------------------------------------------------
  // Pending agent timeout
  // --------------------------------------------------------------------------

  describe("pending agent timeout", () => {
    it("times out pending agents after 45 seconds", () => {
      vi.useFakeTimers();
      try {
        const manager = createManager();
        manager.addPendingAgent("slow-agent", "agent-456");
        expect(manager.pendingAgents.get("slow-agent")?.status).toBe("starting");

        vi.advanceTimersByTime(45_000);

        expect(manager.pendingAgents.get("slow-agent")?.status).toBe("error");
        expect(manager.pendingAgents.get("slow-agent")?.error?.message).toBe(
          "Agent failed to start (timeout)",
        );
        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("emits pendingAgentsChanged on timeout", () => {
      vi.useFakeTimers();
      try {
        const manager = createManager();
        const emitted: ReadonlyMap<string, PendingAgent>[] = [];
        manager.on("pendingAgentsChanged", (agents) => emitted.push(new Map(agents)));

        manager.addPendingAgent("agent-x", "id-x");
        expect(emitted).toHaveLength(1); // from addPendingAgent

        vi.advanceTimersByTime(45_000);

        expect(emitted).toHaveLength(2); // from timeout
        expect(emitted[1]!.get("agent-x")?.status).toBe("error");
        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not fire timeout if agent is disposed before 45s", () => {
      vi.useFakeTimers();
      try {
        const manager = createManager();
        manager.addPendingAgent("fast-agent", "id-fast");

        // Dispose clears pending timeouts
        manager.dispose();

        vi.advanceTimersByTime(45_000);

        // After dispose the agent map is untouched (still "starting") but no error
        // The timeout callback should not run because clearPendingTimeouts was called
        expect(manager.pendingAgents.get("fast-agent")?.status).toBe("starting");
      } finally {
        vi.useRealTimers();
      }
    });

    it("multiple pending agents timeout independently", () => {
      vi.useFakeTimers();
      try {
        const manager = createManager();
        manager.addPendingAgent("agent-a", "id-a");

        vi.advanceTimersByTime(20_000);
        manager.addPendingAgent("agent-b", "id-b");

        // At 45s: agent-a should timeout, agent-b should still be starting
        vi.advanceTimersByTime(25_000);
        expect(manager.pendingAgents.get("agent-a")?.status).toBe("error");
        expect(manager.pendingAgents.get("agent-b")?.status).toBe("starting");

        // At 65s (45s after agent-b was added): agent-b should timeout too
        vi.advanceTimersByTime(20_000);
        expect(manager.pendingAgents.get("agent-b")?.status).toBe("error");

        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Public mutation API
  // --------------------------------------------------------------------------

  describe("public mutation API", () => {
    it("updateMessages applies updater to message state", () => {
      const manager = createManager();
      const emitted: readonly ChatMessage[][] = [];
      manager.on("messagesChanged", (msgs) => (emitted as ChatMessage[][]).push([...msgs]));

      manager.updateMessages(() => [
        { id: "1", senderId: "s", content: "hello", kind: "message" },
      ]);

      expect(manager.messages).toHaveLength(1);
      expect(manager.messages[0]!.content).toBe("hello");
      expect(emitted).toHaveLength(1);
      manager.dispose();
    });

    it("updateMessages with identity function does not emit", () => {
      const manager = createManager();
      manager.updateMessages(() => [
        { id: "1", senderId: "s", content: "hello", kind: "message" },
      ]);

      const emitted: unknown[] = [];
      manager.on("messagesChanged", (msgs) => emitted.push(msgs));

      manager.updateMessages((prev) => prev);

      expect(emitted).toHaveLength(0);
      manager.dispose();
    });

    it("addMethodHistoryEntry creates entry and emits", () => {
      const manager = createManager();
      const emitted: ReadonlyMap<string, MethodHistoryEntry>[] = [];
      manager.on("methodHistoryChanged", (entries) => emitted.push(new Map(entries)));

      manager.addMethodHistoryEntry({
        callId: "call-1",
        methodName: "eval",
        args: { code: "1+1" },
        status: "pending",
        startedAt: 1000,
      });

      expect(manager.methodHistory.size).toBe(1);
      expect(manager.methodHistory.get("call-1")?.methodName).toBe("eval");
      expect(emitted.length).toBeGreaterThan(0);
      manager.dispose();
    });

    it("clearMethodHistory empties and emits", () => {
      const manager = createManager();
      manager.addMethodHistoryEntry({
        callId: "call-1",
        methodName: "eval",
        args: {},
        status: "pending",
        startedAt: 1000,
      });

      const emitted: ReadonlyMap<string, MethodHistoryEntry>[] = [];
      manager.on("methodHistoryChanged", (entries) => emitted.push(new Map(entries)));

      manager.clearMethodHistory();

      expect(manager.methodHistory.size).toBe(0);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.size).toBe(0);
      manager.dispose();
    });

    it("setScopeManager replaces scope manager and wires onChange", () => {
      const manager = createManager();
      expect(manager.scopeManager).toBeNull();

      // Create a minimal mock ScopeManager
      let changeCallback: (() => void) | undefined;
      const mockScopeManager = {
        onChange: (cb: () => void) => {
          changeCallback = cb;
          return () => { changeCallback = undefined; };
        },
        isDirty: false,
        current: {},
        api: null,
        persist: vi.fn(),
        dispose: vi.fn(),
      } as unknown as import("@workspace/eval").ScopeManager;

      manager.setScopeManager(mockScopeManager);
      expect(manager.scopeManager).toBe(mockScopeManager);

      // Wire up scopeDirty event
      const scopeDirtyEmitted: boolean[] = [];
      manager.on("scopeDirty", () => scopeDirtyEmitted.push(true));

      // Trigger onChange when isDirty is true
      (mockScopeManager as unknown as { isDirty: boolean }).isDirty = true;
      changeCallback!();
      expect(scopeDirtyEmitted).toHaveLength(1);

      // When isDirty is false, scopeDirty should not emit
      (mockScopeManager as unknown as { isDirty: boolean }).isDirty = false;
      changeCallback!();
      expect(scopeDirtyEmitted).toHaveLength(1);

      manager.dispose();
    });

    it("setScopeManager unsubscribes previous scope manager", () => {
      const manager = createManager();

      let unsub1Called = false;
      const mock1 = {
        onChange: () => { return () => { unsub1Called = true; }; },
        isDirty: false,
        current: {},
        api: null,
        persist: vi.fn(),
        dispose: vi.fn(),
      } as unknown as import("@workspace/eval").ScopeManager;

      const mock2 = {
        onChange: () => { return () => {}; },
        isDirty: false,
        current: {},
        api: null,
        persist: vi.fn(),
        dispose: vi.fn(),
      } as unknown as import("@workspace/eval").ScopeManager;

      manager.setScopeManager(mock1);
      manager.setScopeManager(mock2);

      expect(unsub1Called).toBe(true);
      expect(manager.scopeManager).toBe(mock2);

      manager.dispose();
    });
  });
});


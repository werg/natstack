import { describe, it, expect, vi } from "vitest";
import { HeadlessSession } from "./headless-session.js";
import type { ChatMessage, ConnectionConfig } from "@workspace/agentic-core";
import { brandId, type TurnId } from "@workspace/agentic-protocol";

function createConfig(): ConnectionConfig {
  return {
    clientId: "headless-test",
    rpc: {
      selfId: "headless-test",
      call: vi.fn(),
      onEvent: vi.fn(() => vi.fn()),
    },
  };
}

describe("HeadlessSession", () => {
  it("constructs without connecting", () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });

    expect(session.connected).toBe(false);
    expect(session.channelId).toBe(null);
    expect(session.messages).toEqual([]);
  });

  it("snapshot returns initial state for an unconnected session", () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });

    const snap = session.snapshot();
    expect(snap.connected).toBe(false);
    expect(snap.messages).toEqual([]);
    expect(snap.invocations).toEqual([]);
    expect(snap.cleanupErrors).toEqual([]);
    expect(snap.participants).toEqual({});
  });

  it("snapshot exposes transcript messages, invocation diagnostics, debug events, and participants", () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    const invocationMessage: ChatMessage = {
      id: "invocation:call-1",
      senderId: "agent-1",
      content: "",
      kind: "message",
      contentType: "invocation",
      complete: true,
      invocation: {
        id: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
        execution: {
          status: "complete",
          description: "",
          result: "contents",
          consoleOutput: "read README.md",
          isError: false,
        },
      },
    };
    (session as any)._chatMessages = new Map([[invocationMessage.id, invocationMessage]]);
    (session as any)._chatMessageOrder = [invocationMessage.id];
    (session as any)._participants = {
      "agent-1": {
        id: "agent-1",
        metadata: { name: "Agent", type: "agent", handle: "agent" },
      },
    };
    (session as any)._debugEvents = [
      {
        debugType: "log",
        agentId: "agent-1",
        handle: "agent",
        level: "info",
        message: "started",
        ts: 1,
      },
    ];

    const snap = session.snapshot();
    expect(snap.messages).toEqual([invocationMessage]);
    expect(snap.invocations).toEqual([
      {
        id: "call-1",
        name: "read_file",
        status: "complete",
        args: { path: "README.md" },
        result: "contents",
        consoleOutput: "read README.md",
        error: undefined,
      },
    ]);
    expect(snap.participants).toEqual({
      "agent-1": { name: "Agent", type: "agent", handle: "agent", connected: true },
    });
    expect(snap.debugEvents).toEqual([
      {
        debugType: "log",
        agentId: "agent-1",
        handle: "agent",
        level: "info",
        message: "started",
        ts: 1,
      },
    ]);
  });

  it("dispose is idempotent", () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });

    expect(() => {
      session.dispose();
      session.dispose();
    }).not.toThrow();
  });

  it("unsubscribes the agent DO before retiring its runtime entity", async () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    const calls: Array<{ target: string; method: string; args: unknown[] }> = [];
    (session as any)._agentEntityId = "do:workers/agent-worker:AiChatWorker:obj-1";
    (session as any)._agentTargetId = "do:workers/agent-worker:AiChatWorker:obj-1";
    (session as any)._channelId = "ch-1";
    (session as any)._agentRpcCall = vi.fn(async (target: string, method: string, args: unknown[]) => {
      calls.push({ target, method, args });
      return undefined;
    });

    await session.close();

    expect(calls).toEqual([
      {
        target: "do:workers/agent-worker:AiChatWorker:obj-1",
        method: "unsubscribeChannel",
        args: ["ch-1"],
      },
      {
        target: "main",
        method: "runtime.retireEntity",
        args: [{ id: "do:workers/agent-worker:AiChatWorker:obj-1" }],
      },
    ]);
  });

  it("records cleanup errors from headless agent teardown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    (session as any)._agentEntityId = "entity-1";
    (session as any)._agentTargetId = "agent-target";
    (session as any)._channelId = "ch-1";
    (session as any)._agentRpcCall = vi.fn(async (_target: string, method: string) => {
      if (method === "unsubscribeChannel") throw new Error("unsubscribe failed");
      if (method === "runtime.retireEntity") throw new Error("retire failed");
      return undefined;
    });

    await session.close();

    expect(session.snapshot().cleanupErrors).toEqual([
      expect.objectContaining({ phase: "unsubscribeHeadlessAgent", message: "unsubscribe failed" }),
      expect.objectContaining({ phase: "retireHeadlessAgent", message: "retire failed" }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[HeadlessSession] unsubscribeHeadlessAgent failed:",
      expect.any(Error)
    );
    expect(warn).toHaveBeenCalledWith(
      "[HeadlessSession] retireHeadlessAgent failed:",
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it("callMethod returns the provider payload and callMethodResult returns the full envelope", async () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    const envelope = {
      content: { ok: true },
      contentType: "application/json",
    };
    (session as any)._client = {
      callMethod: vi.fn(() => ({ result: Promise.resolve(envelope) })),
    };

    await expect(session.callMethod("agent-1", "work", {})).resolves.toEqual({ ok: true });
    await expect(session.callMethodResult("agent-1", "work", {})).resolves.toEqual(envelope);
  });

  it("sandbox callMethod follows the same raw-payload contract", async () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    (session as any)._client = {
      callMethod: vi.fn(() => ({
        result: Promise.resolve({ content: { resumed: true } }),
      })),
    };

    const chat = (session as any).buildChatSandboxValue();

    await expect(chat.callMethod("agent-1", "credentialConnected", {})).resolves.toEqual({ resumed: true });
    await expect(chat.callMethodResult("agent-1", "credentialConnected", {})).resolves.toEqual({
      content: { resumed: true },
    });
  });

  it("sandbox callMethod times out and cancels pending participant calls", async () => {
    vi.useFakeTimers();
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    const cancel = vi.fn(async () => undefined);
    (session as any)._client = {
      callMethod: vi.fn(() => ({
        result: new Promise(() => undefined),
        cancel,
      })),
    };
    const chat = (session as any).buildChatSandboxValue();
    const promise = chat.callMethod("agent-1", "getDebugState", {}, { timeoutMs: 5 });
    const expectation = expect(promise).rejects.toThrow("Method call timed out after 5ms");

    await vi.advanceTimersByTimeAsync(5);

    await expectation;
    expect(cancel).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("sendAndWait starts waiting before publishing the prompt", async () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    }) as HeadlessSession & {
      waitForIdle: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    const idleMessage = {
      id: "agent-message",
      senderId: "agent-1",
      content: "done",
      kind: "message" as const,
      complete: true,
    } satisfies ChatMessage;
    const order: string[] = [];
    session.waitForIdle = vi.fn(() => {
      order.push("wait");
      return Promise.resolve(idleMessage);
    });
    session.send = vi.fn(async () => {
      order.push("send");
      return "message-user";
    });

    await expect(session.sendAndWait("hello")).resolves.toBe(idleMessage);
    expect(order).toEqual(["wait", "send"]);
  });

  it("waitForIdle waits until the durable agent turn is closed", async () => {
    vi.useFakeTimers();
    const session = HeadlessSession.create({
      config: createConfig(),
    });
    const turnId = brandId<TurnId>("turn-open");
    const idleMessage = {
      id: "agent-message",
      senderId: "agent-1",
      content: "done",
      kind: "message" as const,
      complete: true,
    } satisfies ChatMessage;
    (session as any)._channelId = "ch-1";
    (session as any)._channelView = {
      ...(session as any)._channelView,
      turns: {
        [turnId]: {
          turnId,
          actor: { kind: "agent", id: "agent-1" },
          status: "open",
          openedAt: "2026-05-27T00:00:00.000Z",
        },
      },
    };

    const wait = session.waitForIdle({ debounce: 5, timeoutMs: 1000 });
    (session as any)._chatMessages = new Map([[idleMessage.id, idleMessage]]);
    (session as any)._chatMessageOrder = [idleMessage.id];
    (session as any).notifyListeners();
    await vi.advanceTimersByTimeAsync(20);

    let resolved = false;
    void wait.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    (session as any)._channelView = {
      ...(session as any)._channelView,
      turns: {
        [turnId]: {
          ...(session as any)._channelView.turns[turnId],
          status: "closed",
          closedAt: "2026-05-27T00:00:01.000Z",
        },
      },
    };
    (session as any).notifyListeners();
    await vi.advanceTimersByTimeAsync(5);

    await expect(wait).resolves.toBe(idleMessage);
    vi.useRealTimers();
  });
});

import { describe, it, expect, vi } from "vitest";
import { HeadlessSession } from "./headless-session.js";
import type { ChatMessage, ConnectionConfig } from "@workspace/agentic-core";

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
});

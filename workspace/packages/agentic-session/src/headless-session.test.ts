import { describe, it, expect, vi } from "vitest";
import { HeadlessSession } from "./headless-session.js";
import type { ConnectionConfig } from "@workspace/agentic-core";

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
    expect(session.methodEntries.size).toBe(0);
  });

  it("snapshot returns initial state for an unconnected session", () => {
    const session = HeadlessSession.create({
      config: createConfig(),
    });

    const snap = session.snapshot();
    expect(snap.connected).toBe(false);
    expect(snap.messages).toEqual([]);
    expect(snap.methodHistory).toEqual([]);
    expect(snap.participants).toEqual({});
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
});

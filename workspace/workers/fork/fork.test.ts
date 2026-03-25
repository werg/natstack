import { describe, it, expect, vi } from "vitest";
import { fork, type ForkRuntime } from "./fork.js";

// ─── Mock runtime with RPC ──────────────────────────────────────────────────

interface RpcCall { targetId: string; method: string; args: unknown[] }

function createMockRuntime() {
  const rpcCalls: RpcCall[] = [];
  const mainCalls: Array<{ method: string; args: unknown[] }> = [];

  // DO method handlers keyed by "method" name
  const doHandlers = new Map<string, (...args: unknown[]) => unknown>();

  const rpc = {
    async call<T>(targetId: string, method: string, ...args: unknown[]): Promise<T> {
      rpcCalls.push({ targetId, method, args });
      // Route DO calls to handlers
      if (targetId.startsWith("do:")) {
        const handler = doHandlers.get(method);
        if (handler) return handler(...args) as T;
        return undefined as T;
      }
      // Route "main" calls
      if (targetId === "main") {
        mainCalls.push({ method, args });
        return { source: "x", className: "Y", objectKey: "z" } as T;
      }
      return undefined as T;
    },
  };

  const runtime: ForkRuntime = {
    rpc,
    async callMain<T>(method: string, ...args: unknown[]): Promise<T> {
      mainCalls.push({ method, args });
      return { source: "x", className: "Y", objectKey: "z" } as T;
    },
  };
  return { runtime, rpcCalls, mainCalls, doHandlers };
}

// ─── Test data ───────────────────────────────────────────────────────────────

const agentDoRef = {
  source: "workers/agent-worker",
  className: "AiChatWorker",
  objectKey: "agent-1",
};

const agentParticipant = {
  participantId: "do:workers/agent-worker:AiChatWorker:agent-1",
  metadata: { name: "Agent" },
  transport: "do",
  doRef: agentDoRef,
};

const wsParticipant = {
  participantId: "panel-user-1",
  metadata: { callerKind: "panel" },
  transport: "ws",
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("fork()", () => {
  it("orchestrates full fork: roster → preflight → clone channel → clone agents", async () => {
    const { runtime, mainCalls, doHandlers, rpcCalls } = createMockRuntime();
    doHandlers.set("getParticipants", () => [agentParticipant, wsParticipant]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("canFork", () => ({ ok: true, subscriptionCount: 1 }));
    doHandlers.set("postClone", () => undefined);

    const result = await fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 });

    expect(result.forkedChannelId).toMatch(/^fork:chan-1:/);
    expect(result.clonedParticipants).toEqual([agentParticipant.participantId]);
    expect(result.replacedParticipants).toEqual([]);
    expect(result.excluded).toEqual([]);

    // Should have called workerd.cloneDO twice (channel + agent)
    const cloneCalls = mainCalls.filter(c => c.method === "workerd.cloneDO");
    expect(cloneCalls).toHaveLength(2);

    // Should have called postClone on both channel and agent via RPC
    const postCloneCalls = rpcCalls.filter(c => c.method === "postClone");
    expect(postCloneCalls).toHaveLength(2);
  });

  it("fails preflight when agent returns canFork=false", async () => {
    const { runtime, doHandlers } = createMockRuntime();
    doHandlers.set("getParticipants", () => [agentParticipant]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("canFork", () => ({ ok: false, subscriptionCount: 2, reason: "multi-channel" }));

    await expect(fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 }))
      .rejects.toThrow("multi-channel");
  });

  it("excludes specified participants", async () => {
    const { runtime, mainCalls, doHandlers } = createMockRuntime();
    doHandlers.set("getParticipants", () => [agentParticipant, wsParticipant]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("postClone", () => undefined);

    const result = await fork(runtime, {
      channelId: "chan-1",
      forkPointPubsubId: 42,
      exclude: [agentParticipant.participantId],
    });

    expect(result.excluded).toEqual([agentParticipant.participantId]);
    expect(result.clonedParticipants).toEqual([]);

    // Only channel clone
    const cloneCalls = mainCalls.filter(c => c.method === "workerd.cloneDO");
    expect(cloneCalls).toHaveLength(1);
  });

  it("subscribes replacement DOs instead of cloning", async () => {
    const replacementRef = { source: "workers/agent-worker", className: "AiChatWorker", objectKey: "new-agent" };

    const { runtime, mainCalls, doHandlers, rpcCalls } = createMockRuntime();
    doHandlers.set("getParticipants", () => [agentParticipant]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("canFork", () => ({ ok: true, subscriptionCount: 0 }));
    doHandlers.set("subscribeChannel", () => ({ ok: true, participantId: "p-new" }));
    doHandlers.set("postClone", () => undefined);

    const result = await fork(runtime, {
      channelId: "chan-1",
      forkPointPubsubId: 42,
      replace: { [agentParticipant.participantId]: replacementRef },
    });

    expect(result.replacedParticipants).toEqual([agentParticipant.participantId]);
    expect(result.clonedParticipants).toEqual([]);

    // Only channel clone (no agent clone)
    const cloneCalls = mainCalls.filter(c => c.method === "workerd.cloneDO");
    expect(cloneCalls).toHaveLength(1);

    // Should have called subscribeChannel via RPC on replacement DO
    const subCalls = rpcCalls.filter(c => c.method === "subscribeChannel");
    expect(subCalls).toHaveLength(1);
    expect(subCalls[0]!.targetId).toContain("new-agent");
  });

  it("rejects replacement DO with existing subscriptions", async () => {
    const replacementRef = { source: "workers/agent-worker", className: "AiChatWorker", objectKey: "busy" };

    const { runtime, doHandlers } = createMockRuntime();
    doHandlers.set("getParticipants", () => [agentParticipant]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("canFork", () => ({ ok: true, subscriptionCount: 1 }));

    await expect(fork(runtime, {
      channelId: "chan-1",
      forkPointPubsubId: 42,
      replace: { [agentParticipant.participantId]: replacementRef },
    })).rejects.toThrow("replacement DO already has subscriptions");
  });

  it("throws when channel has no contextId", async () => {
    const { runtime, doHandlers } = createMockRuntime();
    doHandlers.set("getParticipants", () => []);
    doHandlers.set("getContextId", () => null);

    await expect(fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 }))
      .rejects.toThrow("no contextId");
  });

  it("succeeds with empty roster (no DO participants to clone)", async () => {
    const { runtime, mainCalls, doHandlers } = createMockRuntime();
    doHandlers.set("getParticipants", () => [wsParticipant]); // only a WS/panel participant
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("postClone", () => undefined);

    const result = await fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 });

    expect(result.clonedParticipants).toEqual([]);
    expect(result.replacedParticipants).toEqual([]);
    expect(result.excluded).toEqual([]);

    // Only channel clone (no agent clones)
    const cloneCalls = mainCalls.filter(c => c.method === "workerd.cloneDO");
    expect(cloneCalls).toHaveLength(1);
  });

  it("rolls back channel clone when first agent clone fails", async () => {
    const { runtime, mainCalls, doHandlers } = createMockRuntime();
    doHandlers.set("getParticipants", () => [agentParticipant]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("canFork", () => ({ ok: true, subscriptionCount: 1 }));
    doHandlers.set("postClone", () => undefined);

    let cloneCount = 0;
    runtime.callMain = async (method: string, ...args: unknown[]) => {
      mainCalls.push({ method, args });
      if (method === "workerd.cloneDO") {
        cloneCount++;
        if (cloneCount === 2) throw new Error("clone failed"); // channel=1, agent=2
      }
      return { source: "x", className: "Y", objectKey: "z" } as any;
    };

    await expect(fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 }))
      .rejects.toThrow("Fork failed: clone failed");

    // Should destroy the channel clone
    const destroyCalls = mainCalls.filter(c => c.method === "workerd.destroyDO");
    expect(destroyCalls).toHaveLength(1);
  });

  it("rolls back clones on mid-fork failure", async () => {
    let cloneCount = 0;
    const { runtime, mainCalls, doHandlers } = createMockRuntime();
    doHandlers.set("getParticipants", () => [
      agentParticipant,
      { ...agentParticipant, participantId: "p2", doRef: { ...agentDoRef, objectKey: "agent-2" } },
    ]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("canFork", () => ({ ok: true, subscriptionCount: 1 }));
    doHandlers.set("postClone", () => undefined);

    // Override callMain to fail on second agent clone
    runtime.callMain = async (method: string, ...args: unknown[]) => {
      mainCalls.push({ method, args });
      if (method === "workerd.cloneDO") {
        cloneCount++;
        if (cloneCount === 3) throw new Error("disk full"); // channel=1, agent1=2, agent2=3
      }
      return { source: "x", className: "Y", objectKey: "z" } as any;
    };

    await expect(fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 }))
      .rejects.toThrow("Fork failed: disk full");

    // Should have called destroyDO for rollback (channel + agent-1 = 2)
    const destroyCalls = mainCalls.filter(c => c.method === "workerd.destroyDO");
    expect(destroyCalls).toHaveLength(2);
  });
});

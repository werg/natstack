import { describe, it, expect, vi, beforeEach } from "vitest";
import { fork, type ForkRuntime } from "./fork.js";

// ─── Fetch mock with URL-pattern handlers ────────────────────────────────────

interface FetchCall { url: string; body: unknown }

function createFetchTracker() {
  const calls: FetchCall[] = [];
  const handlers = new Map<string, () => unknown>();

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });

    for (const [pattern, handler] of handlers) {
      if (url.includes(pattern)) {
        const json = handler(); // may throw
        return {
          ok: true, status: 200,
          headers: { get: (h: string) => h === "content-type" ? "application/json" : null },
          json: async () => json,
          text: async () => JSON.stringify(json),
        };
      }
    }
    return {
      ok: true, status: 200,
      headers: { get: (h: string) => h === "content-type" ? "application/json" : null },
      json: async () => null,
      text: async () => "null",
    };
  });

  return { calls, handlers, fetchMock };
}

// ─── Mock runtime ────────────────────────────────────────────────────────────

function createMockRuntime() {
  const rpcCalls: Array<{ method: string; args: unknown[] }> = [];
  const runtime: ForkRuntime = {
    async callMain<T>(method: string, ...args: unknown[]): Promise<T> {
      rpcCalls.push({ method, args });
      return { source: "x", className: "Y", objectKey: "z" } as T;
    },
  };
  return { runtime, rpcCalls };
}

// ─── Test data ───────────────────────────────────────────────────────────────

const PORT = 9999;

const agentDoRef = {
  source: "workers/agent-worker",
  className: "AiChatWorker",
  objectKey: "agent-1",
};

const agentParticipant = {
  participantId: "/_w/workers/agent-worker/AiChatWorker/agent-1",
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
  let tracker: ReturnType<typeof createFetchTracker>;

  beforeEach(() => {
    tracker = createFetchTracker();
    vi.stubGlobal("fetch", tracker.fetchMock);
  });

  it("orchestrates full fork: roster → preflight → clone channel → clone agents", async () => {
    tracker.handlers.set("/getParticipants", () => [agentParticipant, wsParticipant]);
    tracker.handlers.set("/getContextId", () => "ctx-123");
    tracker.handlers.set("/canFork", () => ({ ok: true, subscriptionCount: 1 }));

    const { runtime, rpcCalls } = createMockRuntime();
    const result = await fork(runtime, PORT, { channelId: "chan-1", forkPointPubsubId: 42 });

    expect(result.forkedChannelId).toMatch(/^fork:chan-1:/);
    expect(result.clonedParticipants).toEqual([agentParticipant.participantId]);
    expect(result.replacedParticipants).toEqual([]);
    expect(result.excluded).toEqual([]);

    // Should have called workerd.cloneDO twice (channel + agent)
    const cloneCalls = rpcCalls.filter(c => c.method === "workerd.cloneDO");
    expect(cloneCalls).toHaveLength(2);

    // Should have called postClone on both channel and agent
    const postCloneCalls = tracker.calls.filter(c => c.url.includes("/postClone"));
    expect(postCloneCalls).toHaveLength(2);

    vi.unstubAllGlobals();
  });

  it("fails preflight when agent returns canFork=false", async () => {
    tracker.handlers.set("/getParticipants", () => [agentParticipant]);
    tracker.handlers.set("/getContextId", () => "ctx-123");
    tracker.handlers.set("/canFork", () => ({ ok: false, subscriptionCount: 2, reason: "multi-channel" }));

    const { runtime } = createMockRuntime();
    await expect(fork(runtime, PORT, { channelId: "chan-1", forkPointPubsubId: 42 }))
      .rejects.toThrow("multi-channel");

    vi.unstubAllGlobals();
  });

  it("excludes specified participants", async () => {
    tracker.handlers.set("/getParticipants", () => [agentParticipant, wsParticipant]);
    tracker.handlers.set("/getContextId", () => "ctx-123");

    const { runtime, rpcCalls } = createMockRuntime();
    const result = await fork(runtime, PORT, {
      channelId: "chan-1",
      forkPointPubsubId: 42,
      exclude: [agentParticipant.participantId],
    });

    expect(result.excluded).toEqual([agentParticipant.participantId]);
    expect(result.clonedParticipants).toEqual([]);

    // Only channel clone
    const cloneCalls = rpcCalls.filter(c => c.method === "workerd.cloneDO");
    expect(cloneCalls).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it("subscribes replacement DOs instead of cloning", async () => {
    const replacementRef = { source: "workers/agent-worker", className: "AiChatWorker", objectKey: "new-agent" };

    tracker.handlers.set("/getParticipants", () => [agentParticipant]);
    tracker.handlers.set("/getContextId", () => "ctx-123");
    tracker.handlers.set("/canFork", () => ({ ok: true, subscriptionCount: 0 }));
    tracker.handlers.set("/subscribeChannel", () => ({ ok: true, participantId: "p-new" }));

    const { runtime, rpcCalls } = createMockRuntime();
    const result = await fork(runtime, PORT, {
      channelId: "chan-1",
      forkPointPubsubId: 42,
      replace: { [agentParticipant.participantId]: replacementRef },
    });

    expect(result.replacedParticipants).toEqual([agentParticipant.participantId]);
    expect(result.clonedParticipants).toEqual([]);

    // Only channel clone (no agent clone)
    const cloneCalls = rpcCalls.filter(c => c.method === "workerd.cloneDO");
    expect(cloneCalls).toHaveLength(1);

    // Should have called subscribeChannel on replacement
    const subCalls = tracker.calls.filter(c => c.url.includes("/subscribeChannel"));
    expect(subCalls).toHaveLength(1);
    expect(subCalls[0]!.url).toContain("new-agent");

    vi.unstubAllGlobals();
  });

  it("rejects replacement DO with existing subscriptions", async () => {
    const replacementRef = { source: "workers/agent-worker", className: "AiChatWorker", objectKey: "busy" };

    tracker.handlers.set("/getParticipants", () => [agentParticipant]);
    tracker.handlers.set("/getContextId", () => "ctx-123");
    tracker.handlers.set("/canFork", () => ({ ok: true, subscriptionCount: 1 }));

    const { runtime } = createMockRuntime();
    await expect(fork(runtime, PORT, {
      channelId: "chan-1",
      forkPointPubsubId: 42,
      replace: { [agentParticipant.participantId]: replacementRef },
    })).rejects.toThrow("replacement DO already has subscriptions");

    vi.unstubAllGlobals();
  });

  it("throws when channel has no contextId", async () => {
    tracker.handlers.set("/getParticipants", () => []);
    tracker.handlers.set("/getContextId", () => null);

    const { runtime } = createMockRuntime();
    await expect(fork(runtime, PORT, { channelId: "chan-1", forkPointPubsubId: 42 }))
      .rejects.toThrow("no contextId");

    vi.unstubAllGlobals();
  });

  it("rolls back clones on mid-fork failure", async () => {
    let cloneCount = 0;
    tracker.handlers.set("/getParticipants", () => [
      agentParticipant,
      { ...agentParticipant, participantId: "p2", doRef: { ...agentDoRef, objectKey: "agent-2" } },
    ]);
    tracker.handlers.set("/getContextId", () => "ctx-123");
    tracker.handlers.set("/canFork", () => ({ ok: true, subscriptionCount: 1 }));

    const { runtime, rpcCalls } = createMockRuntime();
    // Override callMain to fail on second agent clone
    runtime.callMain = async (method: string, ...args: unknown[]) => {
      rpcCalls.push({ method, args });
      if (method === "workerd.cloneDO") {
        cloneCount++;
        if (cloneCount === 3) throw new Error("disk full"); // channel=1, agent1=2, agent2=3
      }
      return { source: "x", className: "Y", objectKey: "z" } as any;
    };

    await expect(fork(runtime, PORT, { channelId: "chan-1", forkPointPubsubId: 42 }))
      .rejects.toThrow("Fork failed: disk full");

    // Should have called destroyDO for rollback (channel + agent-1 = 2)
    const destroyCalls = rpcCalls.filter(c => c.method === "workerd.destroyDO");
    expect(destroyCalls).toHaveLength(2);

    vi.unstubAllGlobals();
  });
});

import { describe, it, expect } from "vitest";
import { fork, type ForkRuntime } from "./fork.js";

// ─── Mock runtime with RPC ──────────────────────────────────────────────────

interface RpcCall {
  targetId: string;
  method: string;
  args: unknown[];
}

interface MockOptions {
  /** Make DO `postClone` throw — for the given clone arg-arity (3 = channel, 5 = agent). */
  failPostCloneArity?: number;
}

function createMockRuntime(opts: MockOptions = {}) {
  const rpcCalls: RpcCall[] = [];
  const mainCalls: Array<{ method: string; args: unknown[] }> = [];

  // DO method handlers keyed by "method" name
  const doHandlers = new Map<string, (...args: unknown[]) => unknown>();
  let cloneSeq = 0;
  let ctxSeq = 0;

  const rpc = {
    async call<T>(targetId: string, method: string, ...args: unknown[]): Promise<T> {
      rpcCalls.push({ targetId, method, args });
      // Route DO calls to handlers
      if (targetId.startsWith("do:")) {
        // callDoTarget passes the real method args as a single array (args[0]).
        if (method === "postClone" && opts.failPostCloneArity === (args[0] as unknown[])?.length) {
          throw new Error("postClone failed");
        }
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
    stream: async () => new Response(),
  };

  // `runtime.cloneContext` mock: map each `include` id (do:source:className:key)
  // to a clone with a deterministic `fork:<key>:<n>` newKey, landing in a fresh ctx.
  const cloneContext = (sourceContextId: string, include: string[] | undefined) => {
    const ids = include ?? []; // fork always passes an explicit include (channel + kept agents)
    const entities = ids.map((id) => {
      const parts = id.split(":");
      const source = parts[1]!;
      const className = parts[2]!;
      const sourceKey = parts.slice(3).join(":");
      const newKey = `fork:${sourceKey}:${(++cloneSeq).toString(36)}`;
      return {
        sourceId: id,
        newId: `do:${source}:${className}:${newKey}`,
        kind: "do" as const,
        source,
        className,
        sourceKey,
        newKey,
        targetId: `t:${newKey}`,
      };
    });
    void sourceContextId;
    return { contextId: `fork-ctx-${++ctxSeq}`, entities };
  };

  const runtime: ForkRuntime = {
    rpc,
    async callMain<T>(method: string, ...args: unknown[]): Promise<T> {
      mainCalls.push({ method, args });
      if (method === "workers.resolveService") {
        return {
          source: "workers/pubsub-channel",
          className: "PubSubChannel",
          objectKey: args[1],
        } as T;
      }
      if (method === "runtime.cloneContext") {
        const a = (args[0] ?? {}) as { sourceContextId: string; include?: string[] };
        return cloneContext(a.sourceContextId, a.include) as T;
      }
      if (method === "runtime.destroyContext") {
        return undefined as T;
      }
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
  // Agent vessels mark themselves with receivesChannelEnvelopes (they implement onMethodCall +
  // canFork/postClone) — the discriminator fork uses to pick clonable DOs (vs RPC-style DO clients).
  metadata: { name: "Agent", receivesChannelEnvelopes: true },
  transport: "do",
  doRef: agentDoRef,
};

const wsParticipant = {
  participantId: "panel-user-1",
  metadata: { callerKind: "panel" },
  transport: "ws",
};

// An RPC-style connectionless DO client (the eval's HeadlessSession): transport "do" with a doRef,
// but NO receivesChannelEnvelopes — it is NOT an agent vessel and has no canFork/postClone, so fork
// must skip it (cloning it would fail the preflight).
const evalClientParticipant = {
  participantId: "do:natstack/internal:EvalDO:eval-1",
  metadata: { name: "Eval client" },
  transport: "do",
  doRef: { source: "natstack/internal", className: "EvalDO", objectKey: "eval-1" },
};

const cloneContextCalls = (mainCalls: Array<{ method: string; args: unknown[] }>) =>
  mainCalls.filter((c) => c.method === "runtime.cloneContext");
const includeOf = (call: { args: unknown[] }) =>
  (call.args[0] as { include?: string[] }).include ?? [];
/** A DO RPC's real method args (callDoTarget nests them as args[0]). */
const innerArgs = (c: RpcCall) => c.args[0] as unknown[];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("fork()", () => {
  it("orchestrates full fork: roster → preflight → cloneContext → rewire clones", async () => {
    const { runtime, mainCalls, doHandlers, rpcCalls } = createMockRuntime();
    doHandlers.set("getParticipants", () => [agentParticipant, wsParticipant]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("canFork", () => ({ ok: true, subscriptionCount: 1 }));
    doHandlers.set("postClone", () => undefined);

    const result = await fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 });

    expect(result.forkedChannelId).toMatch(/^fork:chan-1:/);
    expect(result.forkedContextId).toMatch(/^fork-ctx-/);
    expect(result.clonedParticipants).toEqual([agentParticipant.participantId]);
    expect(result.replacedParticipants).toEqual([]);
    expect(result.excluded).toEqual([]);

    // Cloned agent refs are returned so callers can address the fresh clone.
    expect(result.clonedAgents).toHaveLength(1);
    expect(result.clonedAgents[0]).toMatchObject({
      participantId: agentParticipant.participantId,
      source: agentDoRef.source,
      className: agentDoRef.className,
    });
    expect(result.clonedAgents[0]!.objectKey).toMatch(/^fork:agent-1:/);

    // ONE cloneContext call covering the channel + the kept agent (atomic).
    const clones = cloneContextCalls(mainCalls);
    expect(clones).toHaveLength(1);
    expect(includeOf(clones[0]!)).toEqual([
      "do:workers/pubsub-channel:PubSubChannel:chan-1",
      "do:workers/agent-worker:AiChatWorker:agent-1",
    ]);

    // postClone ran on the cloned channel + agent, threading the NEW context id.
    const postCloneCalls = rpcCalls.filter((c) => c.method === "postClone");
    expect(postCloneCalls).toHaveLength(2);
    // Channel postClone: (parentChannelId, forkPoint, newContextId).
    expect(innerArgs(postCloneCalls[0]!)).toEqual(["chan-1", 42, result.forkedContextId]);
    // Agent postClone: (parentObjectKey, newChannelId, oldChannelId, forkPoint, newContextId).
    expect(innerArgs(postCloneCalls[1]!)).toEqual([
      "agent-1",
      result.forkedChannelId,
      "chan-1",
      42,
      result.forkedContextId,
    ]);
  });

  it("skips RPC-style DO clients (eval HeadlessSession) — only agent vessels are cloned", async () => {
    const { runtime, mainCalls, doHandlers } = createMockRuntime();
    doHandlers.set("getParticipants", () => [agentParticipant, evalClientParticipant]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("canFork", () => ({ ok: true, subscriptionCount: 1 }));
    doHandlers.set("postClone", () => undefined);

    const result = await fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 });

    // The eval client is NOT a forkable participant — only the agent vessel is cloned.
    expect(result.clonedParticipants).toEqual([agentParticipant.participantId]);
    // include = channel + the single agent vessel (the eval client is absent).
    expect(includeOf(cloneContextCalls(mainCalls)[0]!)).toEqual([
      "do:workers/pubsub-channel:PubSubChannel:chan-1",
      "do:workers/agent-worker:AiChatWorker:agent-1",
    ]);
  });

  it("fails preflight when agent returns canFork=false", async () => {
    const { runtime, doHandlers } = createMockRuntime();
    doHandlers.set("getParticipants", () => [agentParticipant]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("canFork", () => ({ ok: false, subscriptionCount: 2, reason: "multi-channel" }));

    await expect(fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 })).rejects.toThrow(
      "multi-channel"
    );
  });

  it("excludes specified participants (not in the clone include)", async () => {
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

    // Only the channel is cloned.
    expect(includeOf(cloneContextCalls(mainCalls)[0]!)).toEqual([
      "do:workers/pubsub-channel:PubSubChannel:chan-1",
    ]);
  });

  it("subscribes replacement DOs instead of cloning", async () => {
    const replacementRef = {
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "new-agent",
    };

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

    // The replaced agent is NOT cloned — only the channel is in the include.
    expect(includeOf(cloneContextCalls(mainCalls)[0]!)).toEqual([
      "do:workers/pubsub-channel:PubSubChannel:chan-1",
    ]);

    // Replacement subscribes to the forked channel in the NEW context.
    const subCalls = rpcCalls.filter((c) => c.method === "subscribeChannel");
    expect(subCalls).toHaveLength(1);
    expect(subCalls[0]!.targetId).toContain("new-agent");
    expect(innerArgs(subCalls[0]!)[0]).toMatchObject({
      channelId: result.forkedChannelId,
      contextId: result.forkedContextId,
    });
  });

  it("rejects replacement DO with existing subscriptions", async () => {
    const replacementRef = {
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "busy",
    };

    const { runtime, doHandlers } = createMockRuntime();
    doHandlers.set("getParticipants", () => [agentParticipant]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("canFork", () => ({ ok: true, subscriptionCount: 1 }));

    await expect(
      fork(runtime, {
        channelId: "chan-1",
        forkPointPubsubId: 42,
        replace: { [agentParticipant.participantId]: replacementRef },
      })
    ).rejects.toThrow("replacement DO already has subscriptions");
  });

  it("throws when channel has no contextId", async () => {
    const { runtime, doHandlers } = createMockRuntime();
    doHandlers.set("getParticipants", () => []);
    doHandlers.set("getContextId", () => null);

    await expect(fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 })).rejects.toThrow(
      "no contextId"
    );
  });

  it("clones just the channel with an empty agent roster", async () => {
    const { runtime, mainCalls, doHandlers } = createMockRuntime();
    doHandlers.set("getParticipants", () => [wsParticipant]); // only a WS/panel participant
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("postClone", () => undefined);

    const result = await fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 });

    expect(result.clonedParticipants).toEqual([]);
    expect(result.replacedParticipants).toEqual([]);
    expect(result.excluded).toEqual([]);

    expect(includeOf(cloneContextCalls(mainCalls)[0]!)).toEqual([
      "do:workers/pubsub-channel:PubSubChannel:chan-1",
    ]);
  });

  it("rolls back the whole cloned context when channel rewiring fails", async () => {
    // Channel postClone has arity 3 → fail it.
    const { runtime, mainCalls, doHandlers } = createMockRuntime({ failPostCloneArity: 3 });
    doHandlers.set("getParticipants", () => [agentParticipant]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("canFork", () => ({ ok: true, subscriptionCount: 1 }));

    await expect(fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 })).rejects.toThrow(
      "Fork failed: postClone failed"
    );

    // The fork tears down the entire cloned context (one destroyContext, not per-DO destroyDO).
    const destroyCalls = mainCalls.filter((c) => c.method === "runtime.destroyContext");
    expect(destroyCalls).toHaveLength(1);
    expect((destroyCalls[0]!.args[0] as { contextId: string }).contextId).toMatch(/^fork-ctx-/);
  });

  it("rolls back the cloned context when an agent rewiring fails mid-way", async () => {
    // Agent postClone has arity 5 → channel succeeds, agent fails.
    const { runtime, mainCalls, doHandlers } = createMockRuntime({ failPostCloneArity: 5 });
    doHandlers.set("getParticipants", () => [
      agentParticipant,
      { ...agentParticipant, participantId: "p2", doRef: { ...agentDoRef, objectKey: "agent-2" } },
    ]);
    doHandlers.set("getContextId", () => "ctx-123");
    doHandlers.set("canFork", () => ({ ok: true, subscriptionCount: 1 }));

    await expect(fork(runtime, { channelId: "chan-1", forkPointPubsubId: 42 })).rejects.toThrow(
      "Fork failed: postClone failed"
    );

    const destroyCalls = mainCalls.filter((c) => c.method === "runtime.destroyContext");
    expect(destroyCalls).toHaveLength(1);
  });
});

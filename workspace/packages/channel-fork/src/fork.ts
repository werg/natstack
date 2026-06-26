/**
 * Fork orchestration logic — extracted for testability.
 *
 * The fetch handler in index.ts calls fork() with a Runtime (for RPC).
 * All DO communication goes through the RPC bridge using "do:source:className:objectKey" targets.
 *
 * Storage cloning + context isolation is delegated to the platform's
 * `runtime.cloneContext`: it copies every named DO's SQLite, snapshots the source
 * context's files into a fresh isolated context, and registers the clones (parented
 * to this fork, so we may freely `runtime.destroyContext` them on rollback). The
 * fork keeps only the conversation-specific rewiring — re-rooting each clone's log
 * at the fork point (`postClone`) and binding replacement agents (`subscribeChannel`).
 */

import type { RpcCaller } from "@natstack/rpc";

export interface DORef {
  source: string;
  className: string;
  objectKey: string;
}

export interface ForkOpts {
  channelId: string;
  forkPointPubsubId: number;
  exclude?: string[];
  replace?: Record<string, DORef>;
}

export interface ForkResult {
  forkedChannelId: string;
  /** The fresh, isolated context the fork landed in (clones + file snapshot). */
  forkedContextId: string;
  clonedParticipants: string[];
  replacedParticipants: string[];
  excluded: string[];
  /** DO refs of the freshly-cloned agents, so the caller can address them
   *  (e.g. to seed a per-fork turn) without re-resolving the new roster. */
  clonedAgents: Array<{ participantId: string } & DORef>;
}

interface ParticipantInfo {
  participantId: string;
  metadata: Record<string, unknown>;
  transport: string;
  doRef?: DORef;
}

/** Source→clone entity mapping returned by `runtime.cloneContext` (subset used here). */
interface ClonedEntity {
  sourceId: string;
  newId: string;
  kind: "do" | "worker";
  source: string;
  className?: string;
  sourceKey: string;
  newKey: string;
  targetId: string;
}
interface CloneContextResult {
  contextId: string;
  entities: ClonedEntity[];
}

export interface ForkRuntime {
  rpc: RpcCaller;
  callMain<T>(method: string, ...args: unknown[]): Promise<T>;
}

// ─── DO dispatch via RPC ────────────────────────────────────────────────────

/** Build a DO RPC target ID from a DORef: "do:{source}:{className}:{objectKey}" */
function doTarget(ref: DORef): string {
  return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
}

async function callDoTarget<T = unknown>(
  rpc: RpcCaller,
  ref: DORef,
  method: string,
  ...args: unknown[]
): Promise<T> {
  return rpc.call<T>(doTarget(ref), method, args);
}

// ─── Fork orchestration ─────────────────────────────────────────────────────

const CHANNEL_SERVICE_PROTOCOL = "natstack.channel.v1";

async function channelRef(runtime: ForkRuntime, key: string): Promise<DORef> {
  const service = await runtime.callMain<DORef & { targetId?: string }>(
    "workers.resolveService",
    CHANNEL_SERVICE_PROTOCOL,
    key
  );
  return {
    source: service.source,
    className: service.className,
    objectKey: service.objectKey,
  };
}

export async function fork(runtime: ForkRuntime, opts: ForkOpts): Promise<ForkResult> {
  const { rpc } = runtime;
  const exclude = new Set(opts.exclude ?? []);
  const replace = opts.replace ?? {};
  const sourceChannelRef = await channelRef(runtime, opts.channelId);

  // 1. Fetch roster and contextId from channel
  const [roster, sourceContextId] = await Promise.all([
    callDoTarget<ParticipantInfo[]>(rpc, sourceChannelRef, "getParticipants"),
    callDoTarget<string | null>(rpc, sourceChannelRef, "getContextId"),
  ]);

  if (!sourceContextId) throw new Error(`Channel ${opts.channelId} has no contextId`);

  // Classify participants
  const toClone: ParticipantInfo[] = [];
  const toReplace: Array<{ participantId: string; doRef: DORef }> = [];
  const excluded: string[] = [];

  for (const p of roster) {
    if (exclude.has(p.participantId)) {
      excluded.push(p.participantId);
      continue;
    }
    // Only AGENT VESSELS are forkable DOs — they carry conversation state and implement
    // canFork/postClone. An RPC-style connectionless DO client (the eval's HeadlessSession) is also
    // transport "do" with a doRef, but it's a transient host with no canFork; cloning it would fail the
    // preflight. Gate on the agent-vessel marker (`receivesChannelEnvelopes`), NOT the id-shape
    // transport. (Mirrors pubsub-channel's `participantIsAgentVessel`.)
    if (p.metadata?.["receivesChannelEnvelopes"] !== true || !p.doRef) continue;
    if (replace[p.participantId]) {
      toReplace.push({ participantId: p.participantId, doRef: replace[p.participantId]! });
    } else {
      toClone.push(p);
    }
  }

  // 2. Preflight: clones need ≤1 sub, replacements need 0
  const preflightResults = await Promise.all([
    ...toClone.map(async (p) => {
      const r = await callDoTarget<{ ok: boolean; subscriptionCount: number; reason?: string }>(
        rpc,
        p.doRef!,
        "canFork"
      );
      return { participantId: p.participantId, ...r };
    }),
    ...toReplace.map(async ({ participantId, doRef }) => {
      const r = await callDoTarget<{ ok: boolean; subscriptionCount: number; reason?: string }>(
        rpc,
        doRef,
        "canFork"
      );
      if (r.ok && r.subscriptionCount > 0) {
        return {
          participantId,
          ok: false as const,
          reason: "replacement DO already has subscriptions",
        };
      }
      return { participantId, ...r };
    }),
  ]);

  for (const r of preflightResults) {
    if (!r.ok) throw new Error(`Cannot fork participant ${r.participantId}: ${r.reason}`);
  }

  // 3. Clone the channel + the agents we keep into a fresh, isolated context. We
  //    name exactly those entities (the replaced agents stay out — replacements
  //    subscribe fresh). cloneContext copies each DO's storage + the source's file
  //    snapshot and registers the clones parented to this fork.
  //
  //    NOTE (gating): cloneContext gates on the SOURCE context — when this fork is
  //    eventually triggered from an in-context initiator, that initiator's identity
  //    should be the gate subject so forking your own conversation is free. The fork
  //    worker is the executor, not the subject.
  const include = [doTarget(sourceChannelRef), ...toClone.map((p) => doTarget(p.doRef!))];
  const clone = await runtime.callMain<CloneContextResult>("runtime.cloneContext", {
    sourceContextId,
    include,
  });
  const forkedContextId = clone.contextId;

  const findClone = (ref: DORef): ClonedEntity => {
    const id = doTarget(ref);
    const entity = clone.entities.find((e) => e.sourceId === id);
    if (!entity) throw new Error(`cloneContext did not clone ${id}`);
    return entity;
  };

  const channelClone = findClone(sourceChannelRef);
  const forkedChannelId = channelClone.newKey;
  const forkedChannelRef: DORef = {
    source: channelClone.source,
    className: channelClone.className!,
    objectKey: forkedChannelId,
  };

  const clonedParticipants: string[] = [];
  const clonedAgents: Array<{ participantId: string } & DORef> = [];
  const replacedParticipants: string[] = [];

  try {
    // Re-root the cloned channel's log at the fork point + re-home its context.
    await callDoTarget(
      rpc,
      forkedChannelRef,
      "postClone",
      opts.channelId,
      opts.forkPointPubsubId,
      forkedContextId
    );

    // Re-root + re-home each cloned agent, re-subscribing it to the forked channel.
    for (const p of toClone) {
      const ref = p.doRef!;
      const ce = findClone(ref);
      const clonedRef: DORef = {
        source: ce.source,
        className: ce.className!,
        objectKey: ce.newKey,
      };
      await callDoTarget(
        rpc,
        clonedRef,
        "postClone",
        ref.objectKey,
        forkedChannelId,
        opts.channelId,
        opts.forkPointPubsubId,
        forkedContextId
      );
      clonedParticipants.push(p.participantId);
      clonedAgents.push({ participantId: p.participantId, ...clonedRef });
    }

    // Subscribe replacement DOs to the forked channel in the new context.
    for (const { participantId, doRef } of toReplace) {
      await callDoTarget(rpc, doRef, "subscribeChannel", {
        channelId: forkedChannelId,
        contextId: forkedContextId,
      });
      replacedParticipants.push(participantId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Best-effort rollback: tear down the whole cloned context (we own it, so this
    // is ungated) — retires every clone + reclaims storage + drops the folder/VCS.
    try {
      await runtime.callMain("runtime.destroyContext", { contextId: forkedContextId });
    } catch (e) {
      console.error(`[fork] Rollback destroyContext failed for ${forkedContextId}:`, e);
    }

    // Best-effort rollback: unsubscribe replacements (safe — canFork verified 0 subs).
    for (const { doRef } of toReplace.filter((_, i) => i < replacedParticipants.length)) {
      try {
        await callDoTarget(rpc, doRef, "unsubscribeChannel", forkedChannelId);
      } catch (e) {
        console.error(`[fork] Rollback unsubscribe failed for ${doRef.objectKey}:`, e);
      }
    }

    throw new Error(`Fork failed: ${message}`);
  }

  return {
    forkedChannelId,
    forkedContextId,
    clonedParticipants,
    replacedParticipants,
    excluded,
    clonedAgents,
  };
}

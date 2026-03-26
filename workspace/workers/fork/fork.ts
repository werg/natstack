/**
 * Fork orchestration logic — extracted for testability.
 *
 * The fetch handler in index.ts calls fork() with a Runtime (for RPC).
 * All DO communication goes through the RPC bridge using "do:source:className:objectKey" targets.
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
  clonedParticipants: string[];
  replacedParticipants: string[];
  excluded: string[];
}

interface ParticipantInfo {
  participantId: string;
  metadata: Record<string, unknown>;
  transport: string;
  doRef?: DORef;
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

async function callDO<T = unknown>(
  rpc: RpcCaller, ref: DORef, method: string, ...args: unknown[]
): Promise<T> {
  return rpc.call<T>(doTarget(ref), method, ...args);
}

// ─── Fork orchestration ─────────────────────────────────────────────────────

const CHANNEL_REF = (key: string): DORef => ({
  source: "workers/pubsub-channel",
  className: "PubSubChannel",
  objectKey: key,
});

export async function fork(runtime: ForkRuntime, opts: ForkOpts): Promise<ForkResult> {
  const { rpc } = runtime;
  const exclude = new Set(opts.exclude ?? []);
  const replace = opts.replace ?? {};

  // 1. Fetch roster and contextId from channel
  const [roster, contextId] = await Promise.all([
    callDO<ParticipantInfo[]>(rpc, CHANNEL_REF(opts.channelId), "getParticipants"),
    callDO<string | null>(rpc, CHANNEL_REF(opts.channelId), "getContextId"),
  ]);

  if (!contextId) throw new Error(`Channel ${opts.channelId} has no contextId`);

  // Classify participants
  const toClone: ParticipantInfo[] = [];
  const toReplace: Array<{ participantId: string; doRef: DORef }> = [];
  const excluded: string[] = [];

  for (const p of roster) {
    if (exclude.has(p.participantId)) { excluded.push(p.participantId); continue; }
    if (p.transport !== "do" || !p.doRef) continue;
    if (replace[p.participantId]) {
      toReplace.push({ participantId: p.participantId, doRef: replace[p.participantId]! });
    } else {
      toClone.push(p);
    }
  }

  // 2. Preflight: clones need ≤1 sub, replacements need 0
  const preflightResults = await Promise.all([
    ...toClone.map(async (p) => {
      const r = await callDO<{ ok: boolean; subscriptionCount: number; reason?: string }>(rpc, p.doRef!, "canFork");
      return { participantId: p.participantId, ...r };
    }),
    ...toReplace.map(async ({ participantId, doRef }) => {
      const r = await callDO<{ ok: boolean; subscriptionCount: number; reason?: string }>(rpc, doRef, "canFork");
      if (r.ok && r.subscriptionCount > 0) {
        return { participantId, ok: false as const, reason: "replacement DO already has subscriptions" };
      }
      return { participantId, ...r };
    }),
  ]);

  for (const r of preflightResults) {
    if (!r.ok) throw new Error(`Cannot fork participant ${r.participantId}: ${r.reason}`);
  }

  // 3. Mutation phase — track cloned refs for rollback
  const forkedChannelId = `fork:${opts.channelId}:${crypto.randomUUID().slice(0, 8)}`;
  const clonedRefs: DORef[] = [];
  const clonedParticipants: string[] = [];
  const replacedParticipants: string[] = [];

  try {
    // Clone channel
    await runtime.callMain("workerd.cloneDO", CHANNEL_REF(opts.channelId), forkedChannelId);
    clonedRefs.push(CHANNEL_REF(forkedChannelId));
    await callDO(rpc, CHANNEL_REF(forkedChannelId), "postClone", opts.channelId, opts.forkPointPubsubId);

    // Clone each agent DO
    for (const p of toClone) {
      const ref = p.doRef!;
      const forkedKey = `fork:${ref.objectKey}:${crypto.randomUUID().slice(0, 8)}`;
      await runtime.callMain("workerd.cloneDO", ref, forkedKey);
      const clonedRef: DORef = { source: ref.source, className: ref.className, objectKey: forkedKey };
      clonedRefs.push(clonedRef);
      await callDO(rpc, clonedRef, "postClone", ref.objectKey, forkedChannelId, opts.channelId, opts.forkPointPubsubId);
      clonedParticipants.push(p.participantId);
    }

    // Subscribe replacement DOs
    for (const { participantId, doRef } of toReplace) {
      await callDO(rpc, doRef, "subscribeChannel", { channelId: forkedChannelId, contextId });
      replacedParticipants.push(participantId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Best-effort rollback: destroy cloned SQLite files
    for (const ref of clonedRefs) {
      try { await runtime.callMain("workerd.destroyDO", ref); }
      catch (e) { console.error(`[fork] Rollback destroy failed for ${ref.objectKey}:`, e); }
    }

    // Best-effort rollback: unsubscribe replacements (safe — canFork verified 0 subs)
    for (const { doRef } of toReplace.filter((_, i) => i < replacedParticipants.length)) {
      try { await callDO(rpc, doRef, "unsubscribeChannel", forkedChannelId); }
      catch (e) { console.error(`[fork] Rollback unsubscribe failed for ${doRef.objectKey}:`, e); }
    }

    throw new Error(`Fork failed: ${message}`);
  }

  return { forkedChannelId, clonedParticipants, replacedParticipants, excluded };
}

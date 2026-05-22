/**
 * Channel + agent bootstrap helpers for the Spectrolite panel.
 *
 * Mirrors `workspace/panels/chat/bootstrap.ts` and the bootstrap fragments
 * inside `panels/chat/index.tsx`. The DO subscription pattern is identical;
 * only the system prompt and channel-name prefix differ.
 */

import { rpc } from "@workspace/runtime";
import { parseDoTargetId } from "@workspace/runtime/workerd-client";

const CHANNEL_SERVICE_PROTOCOL = "natstack.channel.v1";

export interface PendingAgentRecord {
  agentId: string;
  handle: string;
  key: string;
  source: string;
  className: string;
}

export function resolveContextId(
  fromStateArgs: string | undefined,
  fromRuntime: string | undefined,
): string | undefined {
  const id = fromStateArgs ?? fromRuntime;
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function appendPendingAgent(
  existing: PendingAgentRecord[] | undefined,
  agent: PendingAgentRecord,
): PendingAgentRecord[] {
  return [...(existing ?? []), agent];
}

export function newChannelName(): string {
  return `kb-${crypto.randomUUID().slice(0, 8)}`;
}

export function newAgentKey(handle: string): string {
  return `${handle}-${crypto.randomUUID().slice(0, 8)}`;
}

export interface CreateAndSubscribeArgs {
  source: string;
  className: string;
  key: string;
  channelId: string;
  channelContextId: string;
  config?: Record<string, unknown>;
  replay?: boolean;
}

export async function createAndSubscribeAgent(args: CreateAndSubscribeArgs): Promise<{ ok: boolean; participantId?: string }> {
  if (!args.channelContextId) {
    throw new Error("Cannot subscribe an agent DO without a context ID");
  }
  const handle = await rpc.call<{ targetId: string }>(
    "main",
    "runtime.createEntity",
    [{
      kind: "do",
      source: args.source,
      className: args.className,
      key: args.key,
      contextId: args.channelContextId,
    }],
  );
  return rpc.call<{ ok: boolean; participantId?: string }>(
    handle.targetId,
    "subscribeChannel",
    [{
      channelId: args.channelId,
      contextId: args.channelContextId,
      config: args.config,
      replay: args.replay,
    }],
  );
}

interface ChannelParticipant {
  participantId: string;
  metadata: Record<string, unknown>;
}

export interface ChannelDORef {
  source: string;
  className: string;
  objectKey: string;
}

export async function getChannelDOParticipants(channelId: string): Promise<ChannelDORef[]> {
  const channelService = await rpc.call<{ kind: string; targetId?: string }>(
    "main",
    "workers.resolveService",
    [CHANNEL_SERVICE_PROTOCOL, channelId],
  );
  if (channelService.kind !== "durable-object" || !channelService.targetId) {
    throw new Error("Channel service must resolve to a Durable Object service");
  }
  const participants = await rpc.call<ChannelParticipant[]>(
    channelService.targetId,
    "getParticipants",
    [],
  );
  // Delegate to the canonical parser in `@workspace/runtime/workerd-client`
  // rather than maintaining a local copy. If upstream evolves the
  // do-target format (e.g. to handle no-slash sources), Spectrolite
  // benefits automatically.
  return participants
    .map((p) => parseDoTargetId(p.participantId))
    .filter((p): p is ChannelDORef => p !== null);
}

export async function unsubscribeDOFromChannel(
  source: string,
  className: string,
  objectKey: string,
  channelId: string,
): Promise<void> {
  const target = await rpc.call<{ targetId: string }>(
    "main",
    "workers.resolveDurableObject",
    [source, className, objectKey],
  );
  await rpc.call(target.targetId, "unsubscribeChannel", [channelId]);
}

export interface WorkerSourceEntry {
  name: string;
  source: string;
  title?: string;
  classes: Array<{ className: string }>;
}

export interface AvailableAgent {
  id: string;
  name: string;
  proposedHandle: string;
  className: string;
}

function proposedHandleFromName(name: string): string {
  const packageName = name.split("/").pop() ?? name;
  const handle = packageName
    .replace(/-worker$/i, "")
    .replace(/-agent$/i, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return handle || "agent";
}

export async function listAvailableAgents(): Promise<AvailableAgent[]> {
  const sources = await rpc.call<WorkerSourceEntry[]>("main", "workers.listSources", []);
  const out: AvailableAgent[] = [];
  for (const source of sources) {
    for (const cls of source.classes) {
      out.push({
        id: source.source,
        name: source.title ?? source.name,
        proposedHandle: proposedHandleFromName(source.name),
        className: cls.className,
      });
    }
  }
  return out;
}

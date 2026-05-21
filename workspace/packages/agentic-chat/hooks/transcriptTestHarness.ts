import { vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  brandId,
  type AgenticEvent,
  type InvocationId,
  type MessageId,
} from "@workspace/agentic-protocol";
import { connectViaRpc, type PubSubClient } from "@workspace/pubsub";
import { GadWorkspaceDO } from "../../../workers/gad-store/index.js";
import { PubSubChannel } from "../../../workers/pubsub-channel/channel-do.js";

export const TRANSCRIPT_TEST_CHANNEL_ID = "transcript-pipeline";
export const TRANSCRIPT_TEST_CHANNEL_TARGET =
  `do:workers/pubsub-channel:PubSubChannel:${TRANSCRIPT_TEST_CHANNEL_ID}`;
export const TRANSCRIPT_TEST_GAD_TARGET = "do:workers/gad-store:GadWorkspaceDO:workspace-gad";

function setRpcCaller(instance: PubSubChannel, callerId: string | null, callerKind: string | null): void {
  (instance as unknown as { _currentRpcCallerId: string | null })._currentRpcCallerId = callerId;
  (instance as unknown as { _currentRpcCallerKind: string | null })._currentRpcCallerKind = callerKind;
}

export async function createTranscriptHarness(channelId = TRANSCRIPT_TEST_CHANNEL_ID) {
  const channelTarget = `do:workers/pubsub-channel:PubSubChannel:${channelId}`;
  const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "workspace-gad" });
  const channel = await createTestDO(PubSubChannel, { __objectKey: channelId });
  const listeners = new Map<string, (fromId: string, payload: unknown) => void>();

  (channel.instance as unknown as {
    _rpc: {
      emit: (target: string, event: string, payload: unknown) => Promise<void>;
      call: (target: string, method: string, args: unknown[]) => Promise<unknown>;
    };
  })._rpc = {
    emit: vi.fn(async (target, event, payload) => {
      listeners.get(target)?.(event, payload);
    }),
    call: vi.fn(async (target, method, args) => {
      if (target === "main" && method === "workers.resolveService") {
        return {
          kind: "durable-object",
          source: "workers/gad-store",
          className: "GadWorkspaceDO",
          objectKey: "workspace-gad",
          targetId: TRANSCRIPT_TEST_GAD_TARGET,
        };
      }
      if (target === TRANSCRIPT_TEST_GAD_TARGET) {
        const callable = gad.instance as unknown as Record<string, (...methodArgs: unknown[]) => unknown>;
        return await callable[method]!(...args);
      }
      throw new Error(`unexpected channel rpc call ${target}.${method}`);
    }),
  };

  function createParticipantRpc(opts: {
    id: string;
    name: string;
    type: string;
    handle: string;
  }) {
    return {
      selfId: opts.id,
      call: vi.fn(async (target: string, method: string, args: unknown[]) => {
        if (target === "main" && method === "workers.resolveService") {
          return { kind: "durable-object", targetId: channelTarget };
        }
        if (target === channelTarget) {
          const participantId = typeof args[0] === "string" ? args[0] : null;
          const participantKind = participantId?.startsWith("panel:")
            ? "panel"
            : participantId?.startsWith("agent:")
              ? "agent"
              : null;
          setRpcCaller(channel.instance, participantId, participantKind);
          const callable = channel.instance as unknown as Record<string, (...methodArgs: unknown[]) => unknown>;
          return await callable[method]!(...args);
        }
        throw new Error(`unexpected client rpc call ${target}.${method}`);
      }),
      onEvent: vi.fn((_event: string, listener: (fromId: string, payload: unknown) => void) => {
        listeners.set(opts.id, listener);
        return () => listeners.delete(opts.id);
      }),
    };
  }

  function connectParticipant(opts: {
    id: string;
    name: string;
    type: string;
    handle: string;
    contextId?: string;
  }): PubSubClient {
    const rpc = createParticipantRpc(opts);
    return connectViaRpc({
      rpc: rpc as never,
      channel: channelId,
      clientId: opts.id,
      name: opts.name,
      type: opts.type,
      handle: opts.handle,
      contextId: opts.contextId ?? "ctx-transcript-pipeline",
    });
  }

  return { gad, channel, channelId, connectParticipant, createParticipantRpc };
}

export async function appendTrajectoryEventsAndBroadcast(
  harness: Awaited<ReturnType<typeof createTranscriptHarness>>,
  events: AgenticEvent[],
) {
  const result = await harness.gad.call<{
    published: Array<{ channelId: string; envelopeId: string }>;
  }>("appendTrajectoryBatch", {
    trajectoryId: "trajectory:test",
    branchId: "branch:test",
    owner: { kind: "agent", id: "agent:onboarding" },
    events: events.map((event) => ({
      event: { ...event, turnId: "turn:test" },
      publish: { channelIds: [harness.channelId] },
    })),
  });
  await harness.channel.call(
    "broadcastStoredEnvelopes",
    result.published.map((publication) => publication.envelopeId),
  );
  return result;
}

export function agenticPublication(event: AgenticEvent) {
  return event;
}

export function assistantMessage(id: string, content: string): AgenticEvent<"message.completed"> {
  return {
    kind: "message.completed",
    actor: { kind: "agent", id: "agent:onboarding", displayName: "Onboarding Agent" },
    causality: { messageId: brandId<MessageId>(id) },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      role: "assistant",
      content,
    },
    createdAt: new Date().toISOString(),
  };
}

export function invocationStarted(
  id: string,
  name: string,
  request: Record<string, unknown>,
): AgenticEvent<"invocation.started"> {
  return {
    kind: "invocation.started",
    actor: { kind: "agent", id: "agent:onboarding", displayName: "Onboarding Agent" },
    causality: { invocationId: brandId<InvocationId>(id) },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      name,
      request,
    },
    createdAt: new Date().toISOString(),
  };
}

export function invocationCompleted(
  id: string,
  result: unknown,
): AgenticEvent<"invocation.completed"> {
  return {
    kind: "invocation.completed",
    actor: { kind: "agent", id: "agent:onboarding", displayName: "Onboarding Agent" },
    causality: { invocationId: brandId<InvocationId>(id) },
    payload: {
      protocol: AGENTIC_PROTOCOL_VERSION,
      result,
    },
    createdAt: new Date().toISOString(),
  };
}

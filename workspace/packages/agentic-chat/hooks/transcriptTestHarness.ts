import { vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  brandId,
  encodeChannelPayloadStoredValues,
  invocationCompletedPayload,
  type AgenticEvent,
  type BlockId,
  type InvocationId,
  type MessageId,
} from "@workspace/agentic-protocol";
import { connectViaRpc, type PubSubClient } from "@workspace/pubsub";
import { GadWorkspaceDO } from "../../../workers/gad-store/index.js";
import { PubSubChannel } from "../../../workers/pubsub-channel/channel-do.js";

export const TRANSCRIPT_TEST_CHANNEL_ID = "transcript-pipeline";
export const TRANSCRIPT_TEST_CHANNEL_TARGET = `do:workers/pubsub-channel:PubSubChannel:${TRANSCRIPT_TEST_CHANNEL_ID}`;
export const TRANSCRIPT_TEST_GAD_TARGET = "do:workers/gad-store:GadWorkspaceDO:workspace-gad";

function setRpcCaller(
  instance: PubSubChannel,
  callerId: string | null,
  callerKind: string | null
): void {
  (instance as unknown as { _currentRpcCallerId: string | null })._currentRpcCallerId = callerId;
  (instance as unknown as { _currentRpcCallerKind: string | null })._currentRpcCallerKind =
    callerKind;
}

export async function createTranscriptHarness(channelId = TRANSCRIPT_TEST_CHANNEL_ID) {
  const channelTarget = `do:workers/pubsub-channel:PubSubChannel:${channelId}`;
  const gad = await createTestDO(GadWorkspaceDO, { __objectKey: "workspace-gad" });
  const channel = await createTestDO(PubSubChannel, { __objectKey: channelId });
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const blobs = new Map<string, string>();
  let blobCounter = 0;
  const putTextBlob = (value: string) => {
    const digest = `test-digest-${++blobCounter}`;
    blobs.set(digest, value);
    return { digest, size: value.length };
  };

  // The DO base now holds a ConnectionlessRpcClient ({ client, respond, deliver })
  // behind the `rpc` getter; pre-setting `_connectionless` short-circuits the
  // real (network) client construction.
  const mockClient = {
    emit: vi.fn(async (target: string, _event: string, payload: unknown) => {
      listeners.get(target)?.({ payload });
    }),
    call: vi.fn(async (target: string, method: string, args: unknown[]) => {
      if (target === "main" && method === "workers.resolveService") {
        return {
          kind: "durable-object",
          source: "workers/gad-store",
          className: "GadWorkspaceDO",
          objectKey: "workspace-gad",
          targetId: TRANSCRIPT_TEST_GAD_TARGET,
        };
      }
      if (target === "main" && method === "blobstore.putText") {
        const value = String(args[0] ?? "");
        return putTextBlob(value);
      }
      if (target === "main" && method === "blobstore.getText") {
        return blobs.get(String(args[0] ?? "")) ?? null;
      }
      if (target === TRANSCRIPT_TEST_GAD_TARGET) {
        const callable = gad.instance as unknown as Record<
          string,
          (...methodArgs: unknown[]) => unknown
        >;
        return await callable[method]!(...args);
      }
      // Fire-and-forget server housekeeping (alarmSet, setTitle,
      // resolveDurableObject validation) is a no-op in these unit tests.
      if (target === "main") return undefined;
      throw new Error(`unexpected channel rpc call ${target}.${method}`);
    }),
    expose: () => {},
    exposeAll: () => {},
    on: () => () => {},
  };
  (
    channel.instance as unknown as {
      _connectionless: { client: unknown; respond: unknown; deliver: unknown };
    }
  )._connectionless = {
    client: mockClient,
    // Inbound dispatch: `harness.channel.call(...)` reaches the DO via fetch →
    // the method-path adapter calls `respond(envelope)` to invoke the method.
    // Dispatch it straight onto the instance (the converged core's respond would
    // need a real exposeAll/transport; this mock invokes the class method).
    respond: async (envelope: {
      from?: string;
      target?: string;
      message?: { type?: string; requestId?: string; method?: string; args?: unknown[] };
    }) => {
      const msg = envelope.message ?? {};
      if (msg.type !== "request") return null;
      const callable = channel.instance as unknown as Record<string, (...a: unknown[]) => unknown>;
      const result = await callable[msg.method ?? ""]!(...(msg.args ?? []));
      return {
        from: envelope.target,
        target: envelope.from,
        delivery: { caller: { callerId: "main", callerKind: "server" } },
        provenance: [],
        message: { type: "response", requestId: msg.requestId, result },
      };
    },
    deliver: () => {},
  };

  function createParticipantRpc(opts: { id: string; name: string; type: string; handle: string }) {
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
          const callable = channel.instance as unknown as Record<
            string,
            (...methodArgs: unknown[]) => unknown
          >;
          return await callable[method]!(...args);
        }
        throw new Error(`unexpected client rpc call ${target}.${method}`);
      }),
      on: vi.fn((_event: string, listener: (event: { payload: unknown }) => void) => {
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

  return { gad, channel, channelId, connectParticipant, createParticipantRpc, putTextBlob };
}

export async function appendTrajectoryEventsAndBroadcast(
  harness: Awaited<ReturnType<typeof createTranscriptHarness>>,
  events: AgenticEvent[]
) {
  const result = await harness.gad.call<{
    published: Array<{ channelId: string; envelopeId: string }>;
  }>("appendTrajectoryBatch", {
    trajectoryId: "trajectory:test",
    branchId: "branch:test",
    owner: { kind: "agent", id: "agent:onboarding" },
    events: await Promise.all(
      events.map(async (event) => ({
        event: await encodeChannelPayloadStoredValues(
          { ...event, turnId: "turn:test" },
          {
            putText: async (value) => harness.putTextBlob(value),
          }
        ),
        publish: { channelIds: [harness.channelId] },
      }))
    ),
  });
  await harness.channel.call(
    "broadcastStoredEnvelopes",
    result.published.map((publication) => publication.envelopeId)
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
      blocks: [{ blockId: brandId<BlockId>(`${id}:block:0`), type: "text", content }],
      outcome: "completed",
    },
    createdAt: new Date().toISOString(),
  };
}

export function invocationStarted(
  id: string,
  name: string,
  request: Record<string, unknown>
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
  result: unknown
): AgenticEvent<"invocation.completed"> {
  return {
    kind: "invocation.completed",
    actor: { kind: "agent", id: "agent:onboarding", displayName: "Onboarding Agent" },
    causality: { invocationId: brandId<InvocationId>(id) },
    payload: invocationCompletedPayload({ result }),
    createdAt: new Date().toISOString(),
  };
}

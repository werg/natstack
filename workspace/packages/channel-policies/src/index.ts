import type {
  AgenticEvent,
  InvocationOutcome,
  ParticipantRef,
} from "@workspace/agentic-protocol";
import { conversationV1Policy } from "./conversation-v1.js";

/** Minimal durable-envelope view a policy folds over. Pure data. */
export interface PolicyEnvelopeView {
  envelopeId: string;
  seq: number;
  payloadKind: string;
  /** Hydration NOT guaranteed; policies must not depend on blob-spilled fields. */
  payload: unknown;
  /** actor.participantId ?? actor.id */
  senderId: string;
  senderKind: string;
  annotations?: Record<string, unknown>;
  /** ISO timestamp — the ONLY time source available to a policy (P4). */
  appendedAt: string;
}

/** Draft of an envelope about to be appended (annotate input). */
export interface PolicyAppendDraft {
  payloadKind: string;
  payload: unknown;
  senderId: string;
  senderKind: string;
}

export interface ChannelCallDescriptor {
  channelId: string;
  caller: ParticipantRef;
  target: ParticipantRef;
  invocationId: string;
  transportCallId: string;
  turnId?: string;
  method: string;
  args?: unknown;
  /** Epoch ms; journaled on the started payload so deadlines survive amnesia. */
  deadlineAt?: number;
  /** Injected by the host — never wall clock inside the policy (P4). */
  createdAt: string;
}

export interface ChannelCallTerminalInput {
  descriptor: Pick<
    ChannelCallDescriptor,
    "channelId" | "caller" | "invocationId" | "transportCallId" | "turnId"
  >;
  result: unknown;
  isError: boolean;
  terminalOutcome?: InvocationOutcome;
  terminalReasonCode?: string;
  createdAt: string;
}

/** Synthesizes the call-transport event payloads. All pure. */
export interface ChannelCallEventBuilders {
  started(input: ChannelCallDescriptor): AgenticEvent;
  terminal(input: ChannelCallTerminalInput): AgenticEvent;
  output(input: {
    descriptor: ChannelCallTerminalInput["descriptor"];
    output: unknown;
    createdAt: string;
  }): AgenticEvent;
  cancelled(input: {
    descriptor: ChannelCallTerminalInput["descriptor"];
    actor: ParticipantRef;
    reason: string;
    createdAt: string;
  }): AgenticEvent;
}

export interface ChannelPolicy<S = unknown> {
  /** Registry key, e.g. "agentic.conversation.v1". */
  readonly name: string;
  /** Bump ⇒ policy_state cache invalidated and rebuilt by replay. */
  readonly version: number;
  init(): S;
  /** Pure fold over durable envelopes in seq order (P4: no clock/random/IO). */
  reduce(state: S, envelope: PolicyEnvelopeView): S;
  /** Pure pre-append pass. Returns annotations to merge onto the envelope
   *  being appended, or null. MUST NOT mutate the payload. */
  annotate(state: S, draft: PolicyAppendDraft): Record<string, unknown> | null;
  /** Present on the (single) policy owning the call transport's vocabulary. */
  callEventPayload?: ChannelCallEventBuilders;
}

export { conversationV1Policy } from "./conversation-v1.js";
export type { ConversationStateV1 } from "./conversation-v1.js";

export const CHANNEL_POLICIES: ReadonlyMap<string, ChannelPolicy> = new Map<
  string,
  ChannelPolicy
>([[conversationV1Policy.name, conversationV1Policy as ChannelPolicy]]);

export function getChannelPolicy(name: string): ChannelPolicy {
  const policy = CHANNEL_POLICIES.get(name);
  if (!policy) throw new Error(`Unknown channel policy: ${name}`);
  return policy;
}

export const DEFAULT_CHANNEL_POLICIES: readonly string[] = ["agentic.conversation.v1"];

export function resolveChannelPolicies(names: readonly string[] | undefined): ChannelPolicy[] {
  const resolved = (names && names.length > 0 ? names : DEFAULT_CHANNEL_POLICIES).map(
    getChannelPolicy
  );
  const owners = resolved.filter((policy) => policy.callEventPayload);
  if (owners.length > 1) {
    throw new Error(
      `Channel policy conflict: more than one policy owns callEventPayload (${owners
        .map((policy) => policy.name)
        .join(", ")})`
    );
  }
  return resolved;
}

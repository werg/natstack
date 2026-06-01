import type {
  AuthenticatedCaller,
  CallerKind,
  RpcEnvelope,
  RpcMessage,
} from "./types.js";

export interface EnvelopeInput {
  selfId: string;
  from: string;
  target: string;
  message: RpcMessage;
  callerKind?: CallerKind | "unknown";
  caller?: AuthenticatedCaller;
  provenance?: AuthenticatedCaller[];
  idempotencyKey?: string;
}

export function authenticatedCaller(
  callerId: string,
  callerKind: CallerKind | "unknown" = "unknown",
): AuthenticatedCaller {
  return { callerId, callerKind };
}

export function originOfEnvelope(envelope: RpcEnvelope): AuthenticatedCaller {
  return envelope.provenance[0] ?? envelope.delivery.caller;
}

export function envelopeFromMessage(input: EnvelopeInput): RpcEnvelope {
  const caller = input.caller ?? authenticatedCaller(input.from, input.callerKind);
  return {
    from: input.from,
    target: input.target,
    delivery: {
      caller,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
    provenance: input.provenance?.length ? input.provenance : [caller],
    message: input.message,
  };
}

export function retargetEnvelope(envelope: RpcEnvelope, target: string): RpcEnvelope {
  if (envelope.target === target) return envelope;
  return { ...envelope, target };
}

export function responseEnvelopeFor(
  requestEnvelope: RpcEnvelope,
  responder: AuthenticatedCaller,
  message: RpcMessage,
): RpcEnvelope {
  return {
    from: requestEnvelope.target,
    target: requestEnvelope.from,
    delivery: { caller: responder },
    provenance: requestEnvelope.provenance,
    message,
  };
}

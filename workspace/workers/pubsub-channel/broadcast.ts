/**
 * Broadcast + delivery for the PubSub Channel DO.
 *
 * All participants (panels and DOs) receive events via RPC emit.
 * ChannelEvent is the worker-internal durable row format. RPC clients receive
 * explicit log/control/signal envelopes; DO participants receive the same
 * envelope shape over ordered RPC calls.
 */

import type { SqlStorage } from "@workspace/runtime/worker";
import type { RpcBridge } from "@natstack/rpc";
import type { ChannelEvent } from "@natstack/harness/types";
import type { BroadcastEnvelope } from "./types.js";
import type { RpcChannelMessage } from "@workspace/pubsub";

export interface BroadcastDeps {
  sql: SqlStorage;
  rpc: RpcBridge;
  objectKey: string;
}

/** Delivery chains for ordered DO delivery. Resets on hibernation — safe because
 *  agent DOs handle ordering via their own checkpoints. */
const deliveryChains = new Map<string, Promise<void>>();

/** Per-subscriber emit chains. Used to serialize `rpc.emit` calls to the same
 *  subscriber in FIFO order without blocking the caller — awaiting each emit
 *  inline would deadlock against RPC transport backpressure (the subscriber
 *  is typically parked on an outstanding RPC call when replay runs). */
const emitChains = new Map<string, Promise<void>>();

/**
 * Queue an `rpc.emit` to `subscriberId` behind any previously queued emits to
 * the same subscriber. Returns the tail of the chain for callers that want to
 * wait until every enqueued emit has drained (e.g. subscribe handlers that
 * need `ready` to land after replay before they return).
 */
export function queueEmit(
  deps: BroadcastDeps,
  subscriberId: string,
  payload: unknown,
  onFatalDelivery?: (err: { code?: string }) => void,
): Promise<void> {
  const prev = emitChains.get(subscriberId) ?? Promise.resolve();
  const next = prev.then(() =>
    deps.rpc.emit(subscriberId, "channel:message", payload).catch((err) => {
      onFatalDelivery?.(err as { code?: string });
    }),
  );
  emitChains.set(subscriberId, next);
  return next;
}

/** Clean up delivery chain for a participant that unsubscribed. */
export function cleanupDeliveryChain(participantId: string): void {
  deliveryChains.delete(participantId);
  emitChains.delete(participantId);
}

/** Queue an ordered structured envelope delivery to a DO participant. */
export function queueDoEnvelope(
  deps: BroadcastDeps,
  participantId: string,
  envelope: RpcChannelMessage,
  onFatalDelivery?: (err: { code?: string }) => void,
): Promise<void> {
  const prev = deliveryChains.get(participantId) ?? Promise.resolve();
  const next: Promise<void> = prev.then(() =>
    deps.rpc.call(participantId, "onChannelEnvelope", [deps.objectKey, envelope])
      .then(() => {})
      .catch((err) => {
        onFatalDelivery?.(err as { code?: string });
        console.error(`[Channel] delivery failed for ${participantId}:`, err);
      }),
  );
  deliveryChains.set(participantId, next);
  return next;
}

// ── Broadcast ────────────────────────────────────────────────────────────────

/**
 * Broadcast a ChannelEvent to all participants via RPC.
 * RPC clients receive the same envelope shape as DO subscribers.
 */
export function broadcast(
  deps: BroadcastDeps,
  event: ChannelEvent,
  envelope: BroadcastEnvelope,
  senderId: string,
): void {
  const participants = deps.sql.exec(
    `SELECT id, transport FROM participants`,
  ).toArray();

  const msg = envelope.kind === "log"
    ? channelEventToRpcLog(event, envelope.phase ?? "live", envelope.ref)
    : channelEventToRpcSignal(event, envelope.ref);

  for (const p of participants) {
    const pid = p["id"] as string;
    const removeParticipantOnFatalDelivery = (err: { code?: string }) => {
      const code = err?.code;
      if (
        code === "TARGET_NOT_REACHABLE" ||
        code === "RECONNECT_GRACE_EXPIRED" ||
        code === "DO_NOT_CREATED"
      ) {
        deps.sql.exec(`DELETE FROM participants WHERE id = ?`, pid);
        cleanupDeliveryChain(pid);
      }
    };
    const data = pid === senderId && envelope.ref !== undefined
      ? { channelId: deps.objectKey, message: { ...msg, ref: envelope.ref } }
      : { channelId: deps.objectKey, message: msg };

    // Route through the per-subscriber emit chain so replay emits queued
    // during a concurrent subscribe stay ahead of live broadcasts.
    void queueEmit(deps, pid, data, removeParticipantOnFatalDelivery);

    // For DO participants, also deliver the structured envelope via RPC call.
    if (p["transport"] === "do") {
      void queueDoEnvelope(
        deps,
        pid,
        envelope.kind === "log"
          ? { kind: "log", phase: envelope.phase ?? "live", event }
          : channelEventToRpcSignal(event),
        removeParticipantOnFatalDelivery,
      );
    }
  }
}

// ── ChannelEvent builders ────────────────────────────────────────────────────

/**
 * Build a ChannelEvent from message data.
 * This is the canonical event format for both RPC emit and DO delivery.
 */
export function buildChannelEvent(
  id: number,
  messageId: string,
  type: string,
  payloadJson: string,
  senderId: string,
  senderMetadata: Record<string, unknown> | undefined,
  ts: number,
  attachments?: Array<{ id: string; data: string; mimeType: string; name?: string; size: number }>,
): ChannelEvent {
  let parsedPayload: unknown;
  try { parsedPayload = JSON.parse(payloadJson); } catch { parsedPayload = payloadJson; }

  const payloadObj = parsedPayload && typeof parsedPayload === "object"
    ? parsedPayload as Record<string, unknown>
    : null;
  const contentType = payloadObj?.["contentType"] as string | undefined;

  const mappedAttachments = attachments?.map(att => ({
    id: att.id,
    type: att.mimeType?.startsWith("image/") ? "image" : "file",
    data: att.data,
    mimeType: att.mimeType,
    filename: att.name,
    size: att.size,
  }));

  return {
    id,
    messageId: messageId || `${id}`,
    type,
    payload: parsedPayload,
    senderId,
    senderMetadata,
    ...(contentType ? { contentType } : {}),
    ts,
    ...(mappedAttachments && mappedAttachments.length > 0 ? { attachments: mappedAttachments } : {}),
  };
}

// ── Wire encoding ────────────────────────────────────────────────────────────

export function channelEventToRpcLog(
  event: ChannelEvent,
  phase: "replay" | "live",
  ref?: number
): RpcChannelMessage {
  return {
    kind: "log",
    phase,
    event,
    ...(ref !== undefined ? { ref } : {}),
  };
}

export function channelEventToRpcSignal(
  event: ChannelEvent,
  ref?: number
): RpcChannelMessage {
  return {
    kind: "signal",
    type: event.type,
    payload: event.payload,
    senderId: event.senderId,
    ts: event.ts,
    ...(ref !== undefined ? { ref } : {}),
  };
}

/**
 * PubSubFacade -- glue between PubSub callback participants and DO dispatch.
 *
 * When a DO subscribes to a channel, the facade registers a callback
 * participant on the PubSub server. When channel events arrive, it
 * dispatches them to the owning DO and executes the returned actions.
 *
 * Uses an async queue per participant for ordered event processing
 * (PubSub calls onEvent synchronously -- we queue and process sequentially).
 */

import { randomUUID } from "crypto";
import type {
  PubSubServer,
  ParticipantHandle,
  ChannelBroadcastEvent,
} from "@natstack/pubsub-server";
import type { WorkerRouter } from "../workerRouter.js";
import type {
  WorkerAction,
  WorkerActions,
  ParticipantDescriptor,
  SendOptions,
} from "@natstack/harness";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("PubSubFacade");

// ─── Async queue ────────────────────────────────────────────────────────────

type QueueItem = () => Promise<void>;

function createAsyncQueue() {
  let chain = Promise.resolve();

  return {
    enqueue(fn: QueueItem): void {
      chain = chain.then(fn).catch((err) => {
        log.error("Queue item error:", err);
      });
    },
    /** Wait for all currently-queued items to settle */
    async flush(): Promise<void> {
      await chain;
    },
  };
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ParticipantEntry {
  handle: ParticipantHandle;
  channelId: string;
  className: string;
  objectKey: string;
  participantId: string;
  queue: ReturnType<typeof createAsyncQueue>;
}

export interface ExecuteActionsFn {
  (
    actions: WorkerActions,
    context: { participantId: string },
  ): Promise<void>;
}

// ─── PubSubFacade ───────────────────────────────────────────────────────────

export class PubSubFacade {
  private handles = new Map<string, ParticipantEntry>();

  constructor(
    private pubsub: PubSubServer,
    private router: WorkerRouter,
    private executeActions: ExecuteActionsFn,
  ) {}

  /**
   * Subscribe a DO to a channel as a callback participant.
   */
  async subscribe(opts: {
    channelId: string;
    participantId: string;
    className: string;
    objectKey: string;
    descriptor: ParticipantDescriptor;
  }): Promise<void> {
    const { channelId, participantId, className, objectKey, descriptor } = opts;

    // If already subscribed, unsubscribe first
    if (this.handles.has(participantId)) {
      this.unsubscribe(participantId);
    }

    const queue = createAsyncQueue();

    const metadata: Record<string, unknown> = {
      name: descriptor.name,
      type: descriptor.type,
      handle: descriptor.handle,
      ...descriptor.metadata,
    };

    // Include method advertisements if the DO exposes them
    if (descriptor.methods && descriptor.methods.length > 0) {
      metadata["methods"] = descriptor.methods;
    }

    const handle = this.pubsub.registerParticipant(
      channelId,
      participantId,
      metadata,
      {
        onEvent: (event: ChannelBroadcastEvent) => {
          // Skip events from ourselves to avoid feedback loops
          if (event.senderId === participantId) return;

          queue.enqueue(async () => {
            try {
              // Dispatch the channel event to the owning DO
              // Extract the logical message UUID from the payload (the pubsub
              // client puts it as payload.id). Fall back to stringified row id.
              const parsedPayload = typeof event.payload === "string"
                ? tryParseJson(event.payload)
                : event.payload;
              const logicalId = (
                parsedPayload && typeof parsedPayload === "object"
                  ? (parsedPayload as Record<string, unknown>)["id"] as string | undefined
                  : undefined
              ) ?? `${event.id}`;

              // Map stored attachments to the ChannelEvent attachment format
              const attachments = event.attachments?.map(att => ({
                type: att.mimeType?.startsWith("image/") ? "image" : "file",
                data: typeof att.data === "string" ? att.data : Buffer.from(att.data).toString("base64"),
                mimeType: att.mimeType,
                filename: att.name,
              }));

              // Extract contentType from payload (e.g., "typing" for typing indicators)
              const contentType = (
                parsedPayload && typeof parsedPayload === "object"
                  ? (parsedPayload as Record<string, unknown>)["contentType"] as string | undefined
                  : undefined
              );

              const actions = await this.router.dispatch(
                className,
                objectKey,
                "onChannelEvent",
                channelId,
                {
                  id: event.id,
                  messageId: logicalId,
                  type: event.type,
                  payload: parsedPayload,
                  senderId: event.senderId,
                  senderType: event.senderMetadata
                    ? (tryParseJson(event.senderMetadata) as Record<string, unknown> | null)?.["type"] as string | undefined
                    : undefined,
                  ...(contentType ? { contentType } : {}),
                  ts: event.ts,
                  persist: event.persist,
                  ...(attachments && attachments.length > 0 ? { attachments } : {}),
                },
              );

              // Execute returned actions
              if (actions && actions.actions && actions.actions.length > 0) {
                await this.executeActions(actions, { participantId });
              }
            } catch (err) {
              log.error(
                `Error dispatching channel event to DO ${className}/${objectKey}:`,
                err,
              );
            }
          });
        },
      },
    );

    const entry: ParticipantEntry = {
      handle,
      channelId,
      className,
      objectKey,
      participantId,
      queue,
    };
    this.handles.set(participantId, entry);
    this.router.registerParticipant(participantId, className, objectKey);

    log.info(
      `Subscribed DO ${className}/${objectKey} to channel ${channelId} as ${participantId}`,
    );
  }

  /**
   * Unsubscribe a DO from a channel.
   */
  unsubscribe(participantId: string): void {
    const entry = this.handles.get(participantId);
    if (entry) {
      entry.handle.leave();
      this.handles.delete(participantId);
      log.info(`Unsubscribed participant ${participantId}`);
    }
  }

  /**
   * Execute a channel action from a DO response.
   * Routes to the stored ParticipantHandle (in-process, no network).
   */
  executeChannelAction(
    action: WorkerAction & { target: "channel" },
    participantId: string,
  ): void {
    const entry = this.handles.get(participantId);
    if (!entry) {
      log.warn(
        `executeChannelAction: no entry for participant ${participantId}`,
      );
      return;
    }
    const { handle } = entry;

    switch (action.op) {
      case "send":
        handle.sendMessage(action.messageId, action.content, mapSendOptions(action.options));
        break;
      case "update":
        handle.updateMessage(action.messageId, action.content);
        break;
      case "complete":
        handle.completeMessage(action.messageId);
        break;
      case "method-result":
        handle.sendMethodResult(action.callId, action.content, action.isError);
        break;
      case "update-metadata":
        handle.updateMetadata(action.metadata);
        break;
      case "send-ephemeral":
        handle.sendMessage(randomUUID(), action.content, {
          contentType: action.contentType,
          persist: false,
        });
        break;
      case "call-method": {
        // Route through PubSub's callParticipantMethod. Fire async — the
        // result is delivered back to the DO via onCallResult.
        const { callId, participantId: targetId, method, args } = action;
        log.info(`call-method: ${method} -> ${targetId} (callId=${callId}, caller=${participantId})`);
        void this.callParticipantMethod(
          participantId,
          action.channelId,
          targetId,
          callId,
          method,
          args,
        ).then(async (result) => {
          log.info(`call-method result received (callId=${callId}, method=${method})`);
          // Deliver result back to the calling DO
          const doReg = this.router.getDOForParticipant(participantId);
          if (!doReg) {
            log.error(`call-method: no DO registration for ${participantId} to deliver result (callId=${callId})`);
            return;
          }
          const resultActions = await this.router.dispatch(
            doReg.className, doReg.objectKey,
            "onCallResult", callId, result, false,
          );
          if (resultActions.actions.length > 0) {
            await this.executeActions(resultActions, { participantId });
          }
        }).catch(async (err) => {
          log.error(`call-method failed (callId=${callId}, method=${method}, target=${targetId}):`, err);
          try {
            const doReg = this.router.getDOForParticipant(participantId);
            if (!doReg) {
              log.error(`call-method: no DO registration for ${participantId} to deliver error (callId=${callId})`);
              return;
            }
            const resultActions = await this.router.dispatch(
              doReg.className, doReg.objectKey,
              "onCallResult", callId, String(err), true,
            );
            if (resultActions.actions.length > 0) {
              await this.executeActions(resultActions, { participantId });
            }
          } catch (innerErr) {
            log.error(`call-method error recovery also failed (callId=${callId}):`, innerErr);
          }
        });
        break;
      }
    }
  }

  /**
   * Call a method on a channel participant, handling both DO and WebSocket targets.
   *
   * Case A — target is a callback participant (another DO): Direct dispatch via
   * router.dispatch, extract result from method-result action.
   *
   * Case B — target is a WebSocket participant (panel): Use the calling DO's
   * existing handle to broadcast method-call, listen for method-result.
   */
  async callParticipantMethod(
    callerParticipantId: string,
    channelId: string,
    targetParticipantId: string,
    callId: string,
    methodName: string,
    args: unknown,
  ): Promise<unknown> {
    // Case A: target is a DO — direct dispatch
    const doReg = this.router.getDOForParticipant(targetParticipantId);
    if (doReg) {
      const actions = await this.router.dispatch(
        doReg.className, doReg.objectKey,
        "onMethodCall", channelId, callId, methodName, args,
      );
      // Extract result from method-result action and execute all actions
      let result: unknown;
      let isError = false;
      for (const action of actions.actions) {
        if (action.target === "channel" && action.op === "method-result" && action.callId === callId) {
          result = action.content;
          isError = action.isError ?? false;
        }
      }
      // Execute all actions under the target's identity (the callee produced them)
      if (actions.actions.length > 0) {
        await this.executeActions(actions, { participantId: targetParticipantId });
      }
      if (isError) throw new Error(stringifyMethodError(result));
      return result;
    }

    // Case B: target is a WebSocket participant — broadcast method-call via caller's handle, wait for result
    const callerEntry = this.handles.get(callerParticipantId);
    if (!callerEntry) {
      throw new Error(`No participant entry for caller ${callerParticipantId}`);
    }

    return new Promise<unknown>((resolve, reject) => {
      log.info(`callParticipantMethod: waiting for WS participant ${targetParticipantId} to respond (method=${methodName}, callId=${callId})`);
      const timeout = setTimeout(() => {
        unsub();
        log.error(`callParticipantMethod: TIMEOUT waiting for ${methodName} response from ${targetParticipantId} (callId=${callId}) after 5m`);
        reject(new Error(`Method call ${methodName} timed out after 5m (callId=${callId}, target=${targetParticipantId})`));
      }, 300_000);

      const unsub = this.pubsub.onChannelEvent((ch, event) => {
        if (ch !== channelId || event.type !== "method-result") return;
        try {
          const payload = typeof event.payload === "string"
            ? JSON.parse(event.payload) as Record<string, unknown>
            : event.payload as Record<string, unknown>;
          if (payload && payload["callId"] === callId) {
            clearTimeout(timeout);
            unsub();
            if (payload["isError"]) {
              reject(new Error(stringifyMethodError(payload["content"])));
            } else {
              resolve(payload["content"]);
            }
          }
        } catch { /* ignore parse errors */ }
      });

      // Broadcast method-call through caller's handle
      // Uses sendMethodCall which produces MethodCallSchema-compatible payload
      callerEntry.handle.sendMethodCall(callId, targetParticipantId, methodName, args);
    });
  }

  /**
   * Get handle for a participant.
   */
  getHandle(participantId: string): ParticipantEntry | undefined {
    return this.handles.get(participantId);
  }

  /**
   * Get all participant entries.
   */
  getAllEntries(): ParticipantEntry[] {
    return [...this.handles.values()];
  }

  /**
   * Flush all queues (for graceful shutdown).
   */
  async flushAll(): Promise<void> {
    const flushes = [...this.handles.values()].map((e) => e.queue.flush());
    await Promise.allSettled(flushes);
  }

  /**
   * Unsubscribe all participants (shutdown).
   */
  unsubscribeAll(): void {
    for (const entry of this.handles.values()) {
      entry.handle.leave();
    }
    this.handles.clear();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function tryParseJson(s: unknown): unknown {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function mapSendOptions(
  opts?: SendOptions,
): import("@natstack/pubsub-server").SendMessageOptions | undefined {
  if (!opts) return undefined;
  return {
    contentType: opts.type,
    persist: opts.persist,
    senderMetadata: opts.senderMetadata,
    replyTo: opts.replyTo,
  };
}

/** Safely stringify a method error result into a human-readable message */
function stringifyMethodError(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "error" in content) {
    return String((content as { error: unknown }).error);
  }
  return JSON.stringify(content);
}

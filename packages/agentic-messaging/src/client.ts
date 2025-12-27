import {
  connect as connectPubSub,
  type PubSubMessage,
  type RosterUpdate,
} from "@natstack/pubsub";
import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

import type {
  AgenticClient,
  AgenticParticipantMetadata,
  AggregatedEvent,
  ConnectOptions,
  ConversationMessage,
  DiscoveredTool,
  EventFilterOptions,
  EventStreamItem,
  EventStreamOptions,
  IncomingEvent,
  IncomingNewMessage,
  IncomingPresenceEvent,
  IncomingToolCall,
  IncomingToolResult,
  PresenceAction,
  SendResult,
  ToolAdvertisement,
  ToolCallResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolResultChunk,
  ToolResultValue,
  ToolResultWithAttachment,
  JsonSchema,
  MissedContext,
  FormatOptions,
} from "./types.js";
import { AgenticError, ValidationError } from "./types.js";
import { aggregateReplayEvents, formatMissedContext } from "./missed-context.js";
import { SessionDb, type SessionRow } from "./session-db.js";
import {
  ErrorMessageSchema,
  ExecutionPauseSchema,
  NewMessageSchema,
  ToolCallSchema,
  ToolCancelSchema,
  ToolResultSchema,
  UpdateMessageSchema,
} from "./protocol.js";

const INTERNAL_METADATA_KEY = "_agentic";

/**
 * Schema for validating participant metadata at connection time.
 * Ensures required fields are present and have valid values.
 */
const AgenticMetadataSchema = z.object({
  name: z.string().min(1, "name is required"),
  type: z.string().min(1, "type is required"),
  handle: z.string().min(1, "handle is required"),
}).passthrough();

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isToolResultWithAttachment(value: unknown): value is ToolResultWithAttachment<unknown> {
  return isRecord(value) && value["attachment"] instanceof Uint8Array && "content" in value;
}

function randomId(): string {
  const cryptoObj = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  throw new Error("crypto.randomUUID not available");
}

function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convertZodToJsonSchema(schema, { target: "openApi3" }) as JsonSchema;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;
  private closeError: Error | null = null;

  push(value: T): void {
    if (this.closed) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value, done: false });
    else this.values.push(value);
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error ?? null;
    for (const resolve of this.resolvers.splice(0)) {
      resolve({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.closed) {
        if (this.closeError) throw this.closeError;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      if (next.done) {
        if (this.closeError) throw this.closeError;
        return;
      }
      yield next.value;
    }
  }
}

function createFanout<T>() {
  const subscribers = new Set<AsyncQueue<T>>();
  return {
    emit(value: T) {
      for (const q of subscribers) q.push(value);
    },
    close(error?: Error) {
      for (const q of subscribers) q.close(error);
      subscribers.clear();
    },
    /**
     * Subscribe to the fanout. The subscription is registered immediately
     * (synchronously) when this method is called, before iteration begins.
     * This ensures no messages are missed between subscribe() and the first await.
     */
    subscribe(): AsyncIterableIterator<T> {
      const q = new AsyncQueue<T>();
      // Register the subscription IMMEDIATELY, not when iteration starts
      subscribers.add(q);

      const cleanup = () => {
        subscribers.delete(q);
        q.close();
      };

      // Get a single iterator from the queue to use for all next() calls
      const queueIterator = q[Symbol.asyncIterator]();

      // Return an async iterator that yields from the queue
      const iterator: AsyncIterableIterator<T> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next(): Promise<IteratorResult<T>> {
          try {
            const result = await queueIterator.next();
            if (result.done) {
              cleanup();
            }
            return result;
          } catch (err) {
            cleanup();
            throw err;
          }
        },
        async return(value?: T): Promise<IteratorResult<T>> {
          cleanup();
          return { value: value as T, done: true };
        },
        async throw(err?: unknown): Promise<IteratorResult<T>> {
          cleanup();
          throw err;
        },
      };

      return iterator;
    },
  };
}

interface ToolCallState {
  readonly callId: string;
  readonly chunks: ToolResultChunk[];
  readonly stream: ReturnType<typeof createFanout<ToolResultChunk>>;
  readonly resolve: (value: ToolResultValue) => void;
  readonly reject: (error: Error) => void;
  complete: boolean;
  isError: boolean;
}

function createToolCallState(callId: string) {
  let resolve!: (value: ToolResultValue) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<ToolResultValue>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const stream = createFanout<ToolResultChunk>();
  const state: ToolCallState = {
    callId,
    chunks: [],
    stream,
    resolve,
    reject,
    complete: false,
    isError: false,
  };
  return { state, result };
}

function toAgenticErrorFromToolResult(content: unknown): AgenticError {
  if (isRecord(content) && typeof content["error"] === "string") {
    const code = typeof content["code"] === "string" ? content["code"] : "execution-error";
    return new AgenticError(content["error"], code as never, content);
  }
  return new AgenticError("tool execution failed", "execution-error", content);
}

export interface AgenticClientImpl<T extends AgenticParticipantMetadata = AgenticParticipantMetadata>
  extends AgenticClient<T> {}

/**
 * Connect to an agentic messaging channel.
 *
 * This is the main entry point for the agentic messaging system. It establishes
 * a WebSocket connection to the pubsub server, registers tools, and sets up
 * session persistence if a workspace ID is provided.
 *
 * The returned promise resolves after:
 * 1. WebSocket connection is established
 * 2. Initial replay is complete (messages collected or streamed based on replayMode)
 * 3. Session state is loaded (if workspaceId provided)
 *
 * @param options - Connection configuration
 * @param options.serverUrl - WebSocket server URL (e.g., "ws://127.0.0.1:49452")
 * @param options.token - Authentication token for the pubsub server
 * @param options.channel - Channel name to join
 * @param options.handle - Unique handle for @-mentions (must be unique within channel)
 * @param options.name - Display name for this participant
 * @param options.type - Participant type (e.g., "panel", "worker", "agent", "claude-code")
 * @param options.extraMetadata - Additional metadata to include in presence
 * @param options.workspaceId - Workspace ID for session persistence (optional)
 * @param options.reconnect - Auto-reconnect on disconnect (boolean or ReconnectConfig)
 * @param options.replayMode - How to handle replay: "collect" (aggregate), "stream" (emit), or "skip"
 * @param options.tools - Tools this participant provides (auto-executed on tool-call)
 * @param options.clientId - Custom client ID (defaults to random UUID)
 * @param options.skipOwnMessages - Skip messages sent by this client in events()
 *
 * @returns Promise resolving to an AgenticClient instance
 *
 * @throws {AgenticError} With code "validation-error" if metadata is invalid
 * @throws {AgenticError} With code "handle-conflict" if handle already in use
 * @throws {AgenticError} With code "connection-error" if connection fails
 *
 * @example
 * ```typescript
 * // Basic connection
 * const client = await connect({
 *   serverUrl: "ws://localhost:49452",
 *   token: "my-token",
 *   channel: "my-channel",
 *   handle: "my-agent",
 *   name: "My Agent",
 *   type: "agent",
 * });
 *
 * // With session persistence and tools
 * const client = await connect({
 *   serverUrl,
 *   token,
 *   channel: "chat-room",
 *   handle: "assistant",
 *   name: "AI Assistant",
 *   type: "worker",
 *   workspaceId: process.env.WORKSPACE_ID,
 *   reconnect: true,
 *   tools: {
 *     search: {
 *       description: "Search for files",
 *       parameters: z.object({ query: z.string() }),
 *       execute: async (args) => ({ results: [] }),
 *     },
 *   },
 * });
 * ```
 */
export async function connect<T extends AgenticParticipantMetadata = AgenticParticipantMetadata>(
  options: ConnectOptions<T>
): Promise<AgenticClient<T>> {
  const {
    serverUrl,
    token,
    channel,
    handle,
    name,
    type,
    extraMetadata,
    workspaceId,
    reconnect,
    replayMode = "collect",
    tools: initialTools,
    clientId,
    skipOwnMessages,
  } = options;

  const userMetadata: AnyRecord = {
    name,
    type,
    handle,
    ...(extraMetadata ?? {}),
  };

  // Validate metadata has required fields (name, type, handle)
  const metadataValidation = AgenticMetadataSchema.safeParse(userMetadata);
  if (!metadataValidation.success) {
    const errors = metadataValidation.error.errors.map((e) => e.message).join(", ");
    throw new AgenticError(`Invalid metadata: ${errors}`, "validation-error", metadataValidation.error.errors);
  }

  let sessionDb: SessionDb | undefined;
  let sessionRow: SessionRow | undefined;

  if (workspaceId) {
    try {
      sessionDb = new SessionDb(workspaceId, channel, handle);
      await sessionDb.initialize();
      sessionRow = await sessionDb.getOrCreateSession();
    } catch (err) {
      console.warn("[AgenticClient] Session DB unavailable:", err);
      sessionDb = undefined;
      sessionRow = undefined;
    }
  }

  // Determine replay starting point:
  // - undefined: No replay (skip mode) - server sends no historical messages
  // - checkpoint: Resume from last committed position (session resumption)
  // - 0: Replay everything from beginning (new session or no checkpoint)
  let sinceId: number | undefined;
  if (replayMode === "skip") {
    sinceId = undefined;
  } else if (sessionRow?.checkpointPubsubId !== undefined) {
    sinceId = sessionRow.checkpointPubsubId;
  } else {
    sinceId = 0;
  }

  const instanceId = randomId();

  const tools: Record<string, ToolDefinition> = { ...(initialTools ?? {}) };
  const currentMetadata: AnyRecord = { ...(userMetadata as AnyRecord) };

  const errorHandlers = new Set<(error: Error) => void>();
  const eventsFanout = createFanout<IncomingEvent>();
  const toolCallHandlers = new Set<(call: IncomingToolCall) => void>();

  const replayEvents: IncomingEvent[] = [];
  let missedMessages: AggregatedEvent[] = [];

  let checkpoint = sessionRow?.checkpointPubsubId;
  let sdkSessionId = sessionRow?.sdkSessionId;
  let status: "active" | "interrupted" | undefined = sessionRow?.status;

  const callStates = new Map<string, ToolCallState>();
  const providerAbortControllers = new Map<string, AbortController>();
  /** Tool calls waiting for selfId to be resolved (for auto-execution) */
  const pendingToolCalls: IncomingToolCall[] = [];

  let selfId: string | null = null;

  function emitError(error: Error): void {
    for (const handler of errorHandlers) handler(error);
  }

  function emitToolCall(call: IncomingToolCall): void {
    for (const handler of toolCallHandlers) handler(call);
  }

  /**
   * Emit tool call if it targets this client, then handle it.
   * Centralizes the selfId check and emission logic.
   */
  function emitAndHandleToolCall(call: IncomingToolCall): void {
    if (call.providerId === selfId) {
      emitToolCall(call);
    }
    handleIncomingToolCall(call).catch((err) =>
      emitError(err instanceof Error ? err : new Error(String(err)))
    );
  }

  function getToolAdvertisements(fromTools: Record<string, ToolDefinition>): ToolAdvertisement[] {
    return Object.entries(fromTools).map(([name, def]) => {
      // Handle both Zod schemas and plain JSON schema objects
      const parameters = def.parameters && typeof def.parameters === "object" && !("_def" in def.parameters)
        ? (def.parameters as JsonSchema) // Already a JSON schema
        : zodToJsonSchema(def.parameters as z.ZodTypeAny); // Convert Zod schema

      const returns = def.returns
        ? (def.returns && typeof def.returns === "object" && !("_def" in def.returns)
          ? (def.returns as JsonSchema)
          : zodToJsonSchema(def.returns as z.ZodTypeAny))
        : undefined;

      return {
        name,
        description: def.description,
        parameters,
        returns,
        streaming: def.streaming ?? false,
        timeout: def.timeout,
      };
    });
  }

  function buildMetadataWithTools(): AnyRecord {
    const advertisedTools = Object.keys(tools).length > 0 ? getToolAdvertisements(tools) : undefined;
    return {
      ...currentMetadata,
      tools: advertisedTools,
      [INTERNAL_METADATA_KEY]: { instanceId, v: 1 },
    };
  }

  const pubsub = connectPubSub<T>(serverUrl, token, {
    channel,
    sinceId,
    reconnect,
    metadata: buildMetadataWithTools() as T,
    clientId,
    skipOwnMessages,
  });

  const unsubTransportError = pubsub.onError((e: Error) =>
    emitError(new AgenticError(e.message, "connection-error", e))
  );

  // Track if we've detected a handle conflict (to close connection)
  let handleConflictError: AgenticError | null = null;

  // Track when we first saw each participant (for conflict resolution)
  // Earlier timestamp = older participant = wins conflicts
  const participantFirstSeen = new Map<string, number>();

  /**
   * Get the handle for a participant, normalized (lowercase, no @ prefix).
   */
  function getParticipantHandle(participant: { metadata: unknown }): string | undefined {
    const meta = participant.metadata as AnyRecord;
    const handle = meta["handle"];
    return typeof handle === "string" ? handle.toLowerCase().replace(/^@/, "") : undefined;
  }

  /**
   * Check for handle conflicts and detect if we're conflicting with an older participant.
   * Returns the conflicting participant ID if our handle is taken, undefined otherwise.
   */
  function checkHandleConflict(roster: RosterUpdate<T>): string | undefined {
    if (!selfId) return undefined;

    const ourHandle = getParticipantHandle({ metadata: currentMetadata });
    if (!ourHandle) return undefined;

    const ourFirstSeen = participantFirstSeen.get(selfId) ?? Date.now();

    for (const [id, participant] of Object.entries(roster.participants)) {
      if (id === selfId) continue;
      const theirHandle = getParticipantHandle(participant);
      if (theirHandle === ourHandle) {
        // Conflict detected - check who was seen first
        const theirFirstSeen = participantFirstSeen.get(id) ?? 0;
        if (theirFirstSeen <= ourFirstSeen) {
          // They were here first, we should error out
          return id;
        }
        // We were here first, they should error out (not our problem)
      }
    }
    return undefined;
  }

  const unsubRoster = pubsub.onRoster((roster: RosterUpdate<T>) => {
    const now = Date.now();

    // Track first-seen time for all participants
    for (const id of Object.keys(roster.participants)) {
      if (!participantFirstSeen.has(id)) {
        participantFirstSeen.set(id, now);
      }
    }

    // Clean up participants that left
    for (const id of participantFirstSeen.keys()) {
      if (!(id in roster.participants)) {
        participantFirstSeen.delete(id);
      }
    }

    // Try to find our own ID if we don't have it yet
    if (!selfId) {
      for (const [id, participant] of Object.entries(roster.participants)) {
        const meta = participant.metadata as AnyRecord;
        const internal = meta[INTERNAL_METADATA_KEY];
        if (isRecord(internal) && internal["instanceId"] === instanceId) {
          selfId = id;
          break;
        }
      }
    }

    // Check for handle conflicts now that we know who we are
    if (selfId && !handleConflictError) {
      const conflictingId = checkHandleConflict(roster);
      if (conflictingId) {
        const ourHandle = getParticipantHandle({ metadata: currentMetadata });
        handleConflictError = new AgenticError(
          `Handle conflict: "@${ourHandle}" is already taken by participant ${conflictingId}`,
          "handle-conflict",
          { conflictingId, handle: ourHandle }
        );
        emitError(handleConflictError);
        if (!initialReplayComplete) {
          readyReject(handleConflictError);
        }
        // Close the connection - we shouldn't stay connected with a conflicting handle
        pubsub.close();
        return;
      }
    }

    // Process any tool calls that arrived before we knew our own ID
    if (selfId) {
      while (pendingToolCalls.length > 0) {
        const call = pendingToolCalls.shift()!;
        // Only execute tools for live messages, not replay
        if (call.kind !== "replay") {
          emitAndHandleToolCall(call);
        } else if (call.providerId === selfId) {
          // Still emit to targeted handlers for replay, just don't execute
          emitToolCall(call);
        }
      }
    }
  });

  function validateSend<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    value: unknown,
    context: string
  ): z.infer<TSchema> {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const error = new ValidationError(`Invalid ${context}`, "send", parsed.error);
    emitError(error);
    throw error;
  }

  function validateReceive<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    value: unknown,
    context: string
  ): z.infer<TSchema> | null {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    emitError(new ValidationError(`Invalid ${context}`, "receive", parsed.error));
    return null;
  }

  async function publishValidated(
    type: string,
    payload: unknown,
    options?: { persist?: boolean; attachment?: Uint8Array }
  ): Promise<number | undefined> {
    try {
      return await pubsub.publish(type, payload, options);
    } catch (err) {
      throw new AgenticError(
        err instanceof Error ? err.message : String(err),
        "connection-error",
        err
      );
    }
  }

  async function publishToolResult(
    callId: string,
    chunk: Omit<ToolResultChunk, "attachment" | "contentType"> & {
      content?: unknown;
      attachment?: Uint8Array;
      contentType?: string;
    }
  ): Promise<void> {
    const payload = validateSend(
      ToolResultSchema,
      {
        callId,
        content: chunk.content,
        contentType: chunk.contentType,
        complete: chunk.complete,
        isError: chunk.isError,
        progress: chunk.progress,
      },
      "ToolResult"
    );

    await pubsub.publish("tool-result", payload, {
      persist: true,
      attachment: chunk.attachment,
    });
  }

  async function publishToolError(callId: string, message: string, code: string): Promise<void> {
    await publishToolResult(callId, {
      content: { error: message, code },
      complete: true,
      isError: true,
    });
  }

  async function executeToolCall(call: IncomingToolCall): Promise<void> {
    const tool = tools[call.toolName];
    if (!tool) {
      await publishToolError(call.callId, `Tool not found: ${call.toolName}`, "tool-not-found");
      return;
    }

    const controller = new AbortController();
    providerAbortControllers.set(call.callId, controller);
    const timeoutMs = tool.timeout;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const ctx: ToolExecutionContext = {
      callId: call.callId,
      callerId: call.senderId,
      signal: controller.signal,
      stream: async (content) =>
        publishToolResult(call.callId, { content, complete: false, isError: false }),
      streamWithAttachment: async (content, attachment, options) =>
        publishToolResult(call.callId, {
          content,
          attachment,
          contentType: options?.contentType,
          complete: false,
          isError: false,
        }),
      resultWithAttachment: (content, attachment, options) => ({
        content,
        attachment,
        contentType: options?.contentType,
      }),
      progress: async (percent) =>
        publishToolResult(call.callId, { content: undefined, progress: percent, complete: false, isError: false }),
    };

    // Sentinel for timeout - allows distinguishing timeout from other rejections
    const TIMEOUT_SENTINEL = Symbol("timeout");

    try {
      // Handle both Zod schemas and plain JSON schema objects
      const parsedArgs = tool.parameters && "_def" in tool.parameters
        ? (tool.parameters as z.ZodTypeAny).parse(call.args)  // Zod schema
        : call.args;  // Plain JSON schema - pass through as-is

      // Build race competitors
      const competitors: Promise<unknown>[] = [Promise.resolve(tool.execute(parsedArgs, ctx))];

      if (timeoutMs !== undefined && timeoutMs > 0) {
        competitors.push(
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              controller.abort();
              reject(TIMEOUT_SENTINEL);
            }, timeoutMs);
          })
        );
      }

      const rawResult = await Promise.race(competitors);

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      if (controller.signal.aborted) {
        await publishToolError(call.callId, "cancelled", "cancelled");
        return;
      }

      let result: unknown = rawResult;
      if (tool.returns) {
        result = (tool.returns as z.ZodTypeAny).parse(rawResult);
      }

      if (isToolResultWithAttachment(result)) {
        await publishToolResult(call.callId, {
          content: result.content,
          attachment: result.attachment,
          contentType: result.contentType,
          complete: true,
          isError: false,
        });
      } else {
        await publishToolResult(call.callId, { content: result, complete: true, isError: false });
      }
    } catch (err) {
      // Handle timeout via sentinel
      if (err === TIMEOUT_SENTINEL) {
        await publishToolError(call.callId, "timeout", "timeout");
        return;
      }
      // Handle cancellation (external abort or AbortError from tool)
      const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
      if (aborted) {
        await publishToolError(call.callId, "cancelled", "cancelled");
      } else if (err instanceof z.ZodError) {
        await publishToolError(call.callId, err.message, "validation-error");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        await publishToolError(call.callId, message, "execution-error");
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      providerAbortControllers.delete(call.callId);
    }
  }

  async function handleIncomingToolCall(call: IncomingToolCall): Promise<void> {
    if (!selfId || call.providerId !== selfId) return;
    await executeToolCall(call);
  }

  function normalizeSenderMetadata(
    metadata: Record<string, unknown> | undefined
  ): { name?: string; type?: string; handle?: string } | undefined {
    if (!metadata) return undefined;
    const result: { name?: string; type?: string; handle?: string } = {};
    if (typeof metadata["name"] === "string") result.name = metadata["name"] as string;
    if (typeof metadata["type"] === "string") result.type = metadata["type"] as string;
    if (typeof metadata["handle"] === "string") result.handle = metadata["handle"] as string;
    return Object.keys(result).length > 0 ? result : undefined;
  }

  function parseIncoming(pubsubMsg: PubSubMessage): IncomingEvent | null {
    const {
      type,
      payload,
      attachment,
      senderId,
      ts,
      kind,
      id: pubsubId,
      senderMetadata,
    } = pubsubMsg;
    const normalizedSender = normalizeSenderMetadata(senderMetadata);

    if (type === "message") {
      const parsed = validateReceive(NewMessageSchema, payload, "NewMessage");
      if (!parsed) {
        return null;
      }
      return {
        type: "message",
        kind,
        senderId,
        ts,
        attachment,
        pubsubId,
        senderMetadata: normalizedSender,
        id: parsed.id,
        content: parsed.content,
        replyTo: parsed.replyTo,
        contentType: parsed.contentType,
        at: parsed.at,
      };
    }

    if (type === "update-message") {
      const parsed = validateReceive(UpdateMessageSchema, payload, "UpdateMessage");
      if (!parsed) return null;
      return {
        type: "update-message",
        kind,
        senderId,
        ts,
        attachment,
        pubsubId,
        senderMetadata: normalizedSender,
        id: parsed.id,
        content: parsed.content,
        complete: parsed.complete,
        contentType: parsed.contentType,
      };
    }

    if (type === "error") {
      const parsed = validateReceive(ErrorMessageSchema, payload, "ErrorMessage");
      if (!parsed) return null;
      return {
        type: "error",
        kind,
        senderId,
        ts,
        attachment,
        pubsubId,
        senderMetadata: normalizedSender,
        id: parsed.id,
        error: parsed.error,
        code: parsed.code,
      };
    }

    if (type === "tool-call") {
      const parsed = validateReceive(ToolCallSchema, payload, "ToolCall");
      if (!parsed) return null;
      return {
        type: "tool-call",
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        callId: parsed.callId,
        toolName: parsed.toolName,
        providerId: parsed.providerId,
        args: parsed.args,
      };
    }

    if (type === "tool-cancel") {
      const parsed = validateReceive(ToolCancelSchema, payload, "ToolCancel");
      if (!parsed) return null;
      const controller = providerAbortControllers.get(parsed.callId);
      controller?.abort();
      const state = callStates.get(parsed.callId);
      if (state && !state.complete) {
        state.complete = true;
        state.isError = true;
        const error = new AgenticError("cancelled", "cancelled");
        state.stream.emit({
          content: { error: "cancelled", code: "cancelled" },
          complete: true,
          isError: true,
        });
        state.stream.close();
        state.reject(error);
      }
      return null;
    }

    if (type === "tool-result") {
      const parsed = validateReceive(ToolResultSchema, payload, "ToolResult");
      if (!parsed) return null;
      const complete = parsed.complete ?? false;
      const isError = parsed.isError ?? false;
      const incomingResult: IncomingToolResult = {
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        callId: parsed.callId,
        content: parsed.content,
        contentType: parsed.contentType,
        complete,
        isError,
        progress: parsed.progress,
        attachment,
      };

      const state = callStates.get(parsed.callId);
      if (!state) return { ...incomingResult, type: "tool-result" };

      const chunk: ToolResultChunk = {
        content: parsed.content,
        attachment,
        contentType: parsed.contentType,
        complete,
        isError,
        progress: parsed.progress,
      };

      state.chunks.push(chunk);
      state.stream.emit(chunk);

      if (chunk.complete) {
        state.complete = true;
        state.isError = chunk.isError;
        state.stream.close();

        if (chunk.isError) {
          state.reject(toAgenticErrorFromToolResult(chunk.content));
        } else {
          state.resolve({
            content: chunk.content,
            attachment: chunk.attachment,
            contentType: chunk.contentType,
          });
        }
        callStates.delete(parsed.callId);
      }

      return { ...incomingResult, type: "tool-result" };
    }

    if (type === "execution-pause") {
      const parsed = validateReceive(ExecutionPauseSchema, payload, "ExecutionPause");
      if (!parsed) return null;
      return {
        type: "execution-pause",
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        messageId: parsed.messageId,
        status: parsed.status,
        reason: parsed.reason,
      };
    }

    if (type === "presence") {
      const presencePayload = payload as { action?: PresenceAction; metadata?: Record<string, unknown> };
      if (!presencePayload.action || !presencePayload.metadata) {
        return null;
      }
      const presenceEvent: IncomingPresenceEvent = {
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        action: presencePayload.action,
        metadata: presencePayload.metadata,
      };
      return { ...presenceEvent, type: "presence" };
    }

    return null;
  }

  let readySettled = false;
  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = () => {
      if (readySettled) return;
      readySettled = true;
      resolve();
    };
    readyReject = (error: Error) => {
      if (readySettled) return;
      readySettled = true;
      reject(error);
    };
  });
  let initialReplayComplete = false;
  let bufferingReplay = replayMode !== "skip";
  let pendingReplay: IncomingEvent[] = replayEvents;

  const unsubReconnect = pubsub.onReconnect(() => {
    if (replayMode === "skip") return;
    bufferingReplay = true;
    pendingReplay = [];
  });

  const unsubDisconnect = pubsub.onDisconnect(() => {
    if (workspaceId) {
      status = "interrupted";
      if (sessionDb) {
        void sessionDb.markInterrupted();
      }
    }
    if (!initialReplayComplete) {
      readyReject(new AgenticError("connection closed", "connection-error"));
    }
  });

  void (async () => {
    try {
      for await (const msg of pubsub.messages()) {
        try {
          if (msg.kind === "ready") {
            if (replayMode !== "skip") {
              const aggregated = aggregateReplayEvents(pendingReplay);
              if (!initialReplayComplete) {
                missedMessages = aggregated;
              } else if (aggregated.length > 0) {
                missedMessages = [...missedMessages, ...aggregated];
              }
            }

            bufferingReplay = false;
            pendingReplay = [];

            if (!initialReplayComplete) {
              initialReplayComplete = true;
              readyResolve();
            }
            continue;
          }

          const event = parseIncoming(msg);
          if (!event) continue;

          if (event.type === "tool-call") {
            if (selfId) {
              if (event.kind !== "replay") {
                emitAndHandleToolCall(event);
              } else if (event.providerId === selfId) {
                emitToolCall(event);
              }
            } else {
              pendingToolCalls.push(event);
            }
          }

          // Buffer replay events until "ready" signal is received.
          // Replay events are collected into pendingReplay, then aggregated when ready.
          // If bufferingReplay is false but we receive a replay event, this indicates
          // a reconnection scenario where replay started again mid-stream.
          if (event.kind === "replay") {
            if (replayMode === "skip") {
              continue;
            }
            if (!bufferingReplay) {
              bufferingReplay = true;
              pendingReplay = [];
            }
            pendingReplay.push(event);
            continue;
          }

          eventsFanout.emit(event);
        } catch (err) {
          // Don't let a single bad message kill the entire processing loop
          const error = err instanceof Error ? err : new Error(String(err));
          emitError(error);
        }
      }
    } catch (err) {
      // Transport-level error (e.g., connection closed)
      const error = err instanceof Error ? err : new Error(String(err));
      if (!initialReplayComplete) {
        readyReject(error);
      }
      emitError(error);
    } finally {
      eventsFanout.close();
      unsubTransportError();
      unsubRoster();
      unsubReconnect();
      unsubDisconnect();
    }
  })();

  /**
   * Check if this client is the only non-panel participant in the channel.
   */
  function isSoloResponder(): boolean {
    if (!selfId) return false;
    for (const [participantId, participant] of Object.entries(pubsub.roster)) {
      if (participantId === selfId) continue;
      const meta = participant.metadata as AnyRecord;
      if (meta["type"] !== "panel") {
        // Found another non-panel participant
        return false;
      }
    }
    return true;
  }

  /**
   * Check if an event should be yielded based on filter options.
   * Only message events with `at` field are subject to filtering.
   */
  function shouldYieldEvent(event: IncomingEvent, options: EventFilterOptions): boolean {
    // Only filter "message" type, always yield other event types
    if (event.type !== "message") return true;

    // If at is undefined or empty, it's a broadcast - always yield
    if (!event.at || event.at.length === 0) return true;

    // If at includes this client, yield
    if (selfId && event.at.includes(selfId)) return true;

    // If respondWhenSolo and we're the only non-panel participant, yield
    if (options.respondWhenSolo && isSoloResponder()) return true;

    return false;
  }

  function isIncomingEvent(event: EventStreamItem): event is IncomingEvent {
    return "kind" in event;
  }

  function events(options?: EventStreamOptions): AsyncIterableIterator<EventStreamItem> {
    const source = eventsFanout.subscribe();
    const includeReplay = options?.includeReplay ?? false;
    const includeEphemeral = options?.includeEphemeral ?? false;

    return (async function* () {
      if (includeReplay && replayMode !== "skip") {
        const replaySeed: EventStreamItem[] =
          replayMode === "stream" ? replayEvents : missedMessages;
        for (const item of replaySeed) {
          if (isIncomingEvent(item)) {
            if (!includeEphemeral && item.kind === "ephemeral") continue;
            if (options?.targetedOnly && !shouldYieldEvent(item, options)) {
              options.onFiltered?.(item);
              continue;
            }
          }
          yield item;
        }
      }

      for await (const event of source) {
        if (!includeEphemeral && event.kind === "ephemeral") continue;
        if (options?.targetedOnly && !shouldYieldEvent(event, options)) {
          options.onFiltered?.(event);
          continue;
        }
        yield event;
      }
    })();
  }

  /**
   * Resolve @handle mentions to participant IDs.
   * Handles can be provided with or without the @ prefix.
   * Unknown handles are silently omitted from the result.
   */
  function resolveHandlesImpl(handles: string[]): string[] {
    const result: string[] = [];
    for (const handle of handles) {
      const normalized = handle.toLowerCase().replace(/^@/, "");
      for (const [participantId, participant] of Object.entries(pubsub.roster)) {
        const participantHandle = getParticipantHandle(participant);
        if (participantHandle === normalized) {
          result.push(participantId);
          break;
        }
      }
    }
    return result;
  }

  /**
   * Get participant ID by handle.
   * Handle can be provided with or without the @ prefix.
   */
  function getParticipantByHandleImpl(handle: string): string | undefined {
    const normalized = handle.toLowerCase().replace(/^@/, "");
    for (const [participantId, participant] of Object.entries(pubsub.roster)) {
      const participantHandle = getParticipantHandle(participant);
      if (participantHandle === normalized) {
        return participantId;
      }
    }
    return undefined;
  }

  async function send(
    content: string,
    options?: {
      replyTo?: string;
      persist?: boolean;
      attachment?: Uint8Array;
      contentType?: string;
      at?: string[];
      resolveHandles?: boolean;
    }
  ): Promise<SendResult> {
    const id = randomId();

    // Resolve @handle mentions to participant IDs if requested
    let resolvedAt = options?.at;
    if (options?.resolveHandles && resolvedAt && resolvedAt.length > 0) {
      resolvedAt = resolveHandlesImpl(resolvedAt);
    }

    const payload = validateSend(
      NewMessageSchema,
      { id, content, replyTo: options?.replyTo, contentType: options?.contentType, at: resolvedAt },
      "NewMessage"
    );
    // Default to persisting messages (explicit true, not undefined)
    const persist = options?.persist ?? true;
    const pubsubId = await publishValidated("message", payload, {
      persist,
      attachment: options?.attachment,
    });
    return { messageId: id, pubsubId };
  }

  async function update(
    id: string,
    content: string,
    options?: { complete?: boolean; persist?: boolean; attachment?: Uint8Array; contentType?: string }
  ): Promise<number | undefined> {
    const payload = validateSend(
      UpdateMessageSchema,
      { id, content, complete: options?.complete, contentType: options?.contentType },
      "UpdateMessage"
    );
    // Default to persisting updates (explicit true, not undefined)
    const persist = options?.persist ?? true;
    return await publishValidated("update-message", payload, {
      persist,
      attachment: options?.attachment,
    });
  }

  async function complete(id: string): Promise<number | undefined> {
    const payload = validateSend(UpdateMessageSchema, { id, complete: true }, "UpdateMessage");
    return await publishValidated("update-message", payload, { persist: true });
  }

  async function error(id: string, err: string, code?: string): Promise<number | undefined> {
    const payload = validateSend(ErrorMessageSchema, { id, error: err, code }, "ErrorMessage");
    return await publishValidated("error", payload, { persist: true });
  }

  function discoverToolDefsFrom(providerId: string): DiscoveredTool[] {
    const participant = pubsub.roster[providerId];
    if (!participant) return [];
    const meta = participant.metadata as AnyRecord;
    const advertised = Array.isArray(meta["tools"]) ? (meta["tools"] as ToolAdvertisement[]) : [];
    const providerName = typeof meta["name"] === "string" ? meta["name"] : providerId;
    return advertised.map((t) => ({
      providerId,
      providerName,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      returns: t.returns,
      streaming: t.streaming ?? false,
      timeout: t.timeout,
    }));
  }

  function discoverToolDefs(): DiscoveredTool[] {
    return Object.keys(pubsub.roster).flatMap((id) => discoverToolDefsFrom(id));
  }

  function callTool(
    providerId: string,
    toolName: string,
    args: unknown,
    callOptions?: { signal?: AbortSignal; validateArgs?: z.ZodTypeAny; timeoutMs?: number }
  ): ToolCallResult {
    const provider = pubsub.roster[providerId];
    if (!provider) throw new AgenticError(`Provider not found: ${providerId}`, "provider-not-found");

    const meta = provider.metadata as AnyRecord;
    const advertised = Array.isArray(meta["tools"]) ? (meta["tools"] as ToolAdvertisement[]) : [];
    const toolAd = advertised.find((t: ToolAdvertisement) => t.name === toolName);
    if (advertised.length > 0 && !toolAd) {
      throw new AgenticError(`Tool not found: ${providerId}:${toolName}`, "tool-not-found");
    }

    const callId = randomId();
    const { state, result } = createToolCallState(callId);
    callStates.set(callId, state);

    if (callOptions?.validateArgs) {
      args = callOptions.validateArgs.parse(args);
    }

    const payload = validateSend(ToolCallSchema, { callId, toolName, providerId, args }, "ToolCall");

    void pubsub.publish("tool-call", payload, { persist: true }).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      state.complete = true;
      state.isError = true;
      state.stream.close(err);
      state.reject(new AgenticError(err.message, "connection-error", err));
      callStates.delete(callId);
    });

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cancel = async (reason: "cancelled" | "timeout" = "cancelled"): Promise<void> => {
      if (state.complete) return;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      state.complete = true;
      state.isError = true;
      state.stream.close();
      state.reject(new AgenticError(reason, reason));
      callStates.delete(callId);
      const cancelPayload = validateSend(ToolCancelSchema, { callId }, "ToolCancel");
      await pubsub.publish("tool-cancel", cancelPayload, { persist: true });
    };

    // Set up timeout - use explicit option, fall back to advertised timeout
    const timeoutMs = callOptions?.timeoutMs ?? toolAd?.timeout;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timeoutId = null;
        void cancel("timeout");
      }, timeoutMs);
    }

    // Clean up timeout when result resolves
    void result.finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    });

    if (callOptions?.signal) {
      if (callOptions.signal.aborted) void cancel();
      else {
        callOptions.signal.addEventListener("abort", () => void cancel(), { once: true });
      }
    }

    return {
      callId,
      result,
      stream: (async function* () {
        for (const chunk of state.chunks) yield chunk;
        for await (const chunk of state.stream.subscribe()) yield chunk;
      })(),
      cancel: () => cancel("cancelled"),
      get complete() {
        return state.complete;
      },
      get isError() {
        return state.isError;
      },
    };
  }

  function requireSessionEnabled(method: string): void {
    if (!workspaceId) {
      throw new AgenticError(`${method} requires workspaceId`, "validation-error");
    }
  }

  function getSessionDbOrWarn(method: string): SessionDb | undefined {
    if (!sessionDb) {
      console.warn(`[AgenticClient] ${method} skipped (session DB unavailable)`);
      return undefined;
    }
    return sessionDb;
  }

  function getSessionDbOrThrow(method: string): SessionDb {
    if (!sessionDb) {
      throw new Error(`[AgenticClient] ${method} failed (session DB unavailable)`);
    }
    return sessionDb;
  }

  async function commitCheckpoint(pubsubId: number): Promise<void> {
    requireSessionEnabled("commitCheckpoint");
    const db = getSessionDbOrWarn("commitCheckpoint");
    if (!db) return;
    await db.commitCheckpoint(pubsubId);
    checkpoint = pubsubId;
    status = "active";
  }

  async function updateSdkSession(sessionId: string): Promise<void> {
    requireSessionEnabled("updateSdkSession");
    const db = getSessionDbOrWarn("updateSdkSession");
    if (!db) return;
    await db.updateSdkSession(sessionId);
    sdkSessionId = sessionId;
    status = "active";
  }

  async function clearSdkSession(): Promise<void> {
    requireSessionEnabled("clearSdkSession");
    const db = getSessionDbOrWarn("clearSdkSession");
    if (!db) return;
    await db.clearSdkSession();
    sdkSessionId = undefined;
  }

  async function storeMessage(role: "user" | "assistant", content: string): Promise<void> {
    requireSessionEnabled("storeMessage");
    const db = getSessionDbOrThrow("storeMessage");
    await db.storeMessage(role, content);
  }

  async function getHistory(limit?: number): Promise<ConversationMessage[]> {
    requireSessionEnabled("getHistory");
    const db = getSessionDbOrThrow("getHistory");
    return await db.getHistory(limit);
  }

  async function clearHistory(): Promise<void> {
    requireSessionEnabled("clearHistory");
    const db = getSessionDbOrThrow("clearHistory");
    await db.clearHistory();
  }

  function formatMissedContextImpl(options?: FormatOptions): MissedContext {
    return formatMissedContext(missedMessages, options);
  }

  function getMissedByType<K extends AggregatedEvent["type"]>(
    type: K
  ): Extract<AggregatedEvent, { type: K }>[] {
    return missedMessages.filter((event) => event.type === type) as Extract<
      AggregatedEvent,
      { type: K }
    >[];
  }

  try {
    await readyPromise;
  } catch (err) {
    pubsub.close();
    if (sessionDb) {
      await sessionDb.close();
    }
    throw err;
  }

  return {
    handle,
    get clientId() {
      return selfId;
    },
    get sessionEnabled() {
      return sessionDb !== undefined;
    },
    get sessionKey() {
      return sessionDb?.getSessionKey();
    },
    get checkpoint() {
      return checkpoint;
    },
    get sdkSessionId() {
      return sdkSessionId;
    },
    get status() {
      return status;
    },
    get missedMessages() {
      return missedMessages;
    },
    formatMissedContext: formatMissedContextImpl,
    getMissedByType,
    events,
    commitCheckpoint,
    updateSdkSession,
    clearSdkSession,
    send,
    update,
    complete,
    error,
    storeMessage,
    getHistory,
    clearHistory,
    discoverToolDefs,
    discoverToolDefsFrom,
    callTool,
    get roster() {
      return pubsub.roster;
    },
    resolveHandles: resolveHandlesImpl,
    getParticipantByHandle: getParticipantByHandleImpl,
    onRoster: pubsub.onRoster,
    get connected() {
      return pubsub.connected;
    },
    get reconnecting() {
      return pubsub.reconnecting;
    },
    close: async () => {
      pubsub.close();
      if (sessionDb) {
        await sessionDb.close();
      }
    },
    onError: (handler) => {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    onDisconnect: pubsub.onDisconnect,
    onReconnect: pubsub.onReconnect,
    pubsub,
    sendToolResult: async (
      callId: string,
      content: unknown,
      options?: {
        complete?: boolean;
        isError?: boolean;
        progress?: number;
        attachment?: Uint8Array;
        contentType?: string;
      }
    ) => {
      await publishToolResult(callId, {
        content,
        complete: options?.complete ?? true,
        isError: options?.isError ?? false,
        progress: options?.progress,
        attachment: options?.attachment,
        contentType: options?.contentType,
      });
    },
  };
}

/**
 * Create tool definitions suitable for agent SDK integration.
 * Produces stable, conflict-free tool names and a single execute() dispatcher.
 */
export function createToolsForAgentSDK(
  client: AgenticClient,
  options?: {
    filter?: (tool: DiscoveredTool) => boolean;
    namePrefix?: string;
  }
): {
  definitions: Array<{ name: string; description?: string; parameters: JsonSchema }>;
  execute: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
} {
  const tools = client.discoverToolDefs();
  const filtered = options?.filter ? tools.filter(options.filter) : tools;

  const prefix = options?.namePrefix ?? "pubsub";
  const nameMap = new Map<string, DiscoveredTool>();

  const definitions = filtered.map((tool) => {
    const name = `${prefix}_${tool.providerId}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    nameMap.set(name, tool);
    return {
      name,
      description: tool.description ? `[${tool.providerName}] ${tool.description}` : undefined,
      parameters: tool.parameters,
    };
  });

  return {
    definitions,
    execute: async (name, args, signal) => {
      const tool = nameMap.get(name);
      if (!tool) throw new AgenticError(`Tool not found: ${name}`, "tool-not-found");
      const result = client.callTool(tool.providerId, tool.name, args, { signal });
      return (await result.result).content;
    },
  };
}

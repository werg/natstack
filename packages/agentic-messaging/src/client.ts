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
  AggregatedMessage,
  Attachment,
  AttachmentInput,
  ConnectOptions,
  ConversationMessage,
  DiscoveredMethod,
  EventFilterOptions,
  EventStreamItem,
  EventStreamOptions,
  IncomingEvent,
  IncomingPresenceEvent,
  IncomingMethodCall,
  IncomingMethodResult,
  LeaveReason,
  PresenceAction,
  SendResult,
  MethodAdvertisement,
  MethodCallHandle,
  MethodDefinition,
  MethodExecutionContext,
  MethodResultChunk,
  MethodResultValue,
  MethodResultWithAttachments,
  JsonSchema,
  MissedContext,
  FormatOptions,
  ToolGroup,
  ToolRoleConflict,
} from "./types.js";
import { AgenticError, ValidationError } from "./types.js";
import { aggregateReplayEvents, formatMissedContext } from "./missed-context.js";
// SessionDb is lazily imported to reduce bundle size when session persistence is not used
import type { SessionDb, SessionRow } from "./session-db.js";
import {
  ErrorMessageSchema,
  ExecutionPauseSchema,
  NewMessageSchema,
  MethodCallSchema,
  MethodCancelSchema,
  MethodResultSchema,
  UpdateMessageSchema,
  ToolRoleRequestSchema,
  ToolRoleResponseSchema,
  ToolRoleHandoffSchema,
} from "./protocol.js";
import { ALL_TOOL_GROUPS } from "./tool-schemas.js";

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

/**
 * Schema for validating tool role declarations in participant metadata.
 * Used during conflict detection to safely extract toolRoles.
 */
const ToolRoleDeclarationSchema = z.object({
  providing: z.boolean(),
  priority: z.number().optional(),
});

const ToolRolesSchema = z.record(
  z.enum(["file-ops", "git-ops"]),
  ToolRoleDeclarationSchema
).optional();

/**
 * Schema for extracting conflict-relevant fields from participant metadata.
 * Uses safeParse to gracefully handle malformed metadata.
 */
const ConflictMetadataSchema = z.object({
  name: z.string().optional(),
  toolRoles: ToolRolesSchema,
}).passthrough();

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMethodResultWithAttachments(value: unknown): value is MethodResultWithAttachments<unknown> {
  return isRecord(value) && Array.isArray(value["attachments"]) && "content" in value;
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

interface MethodCallState {
  readonly callId: string;
  readonly chunks: MethodResultChunk[];
  readonly stream: ReturnType<typeof createFanout<MethodResultChunk>>;
  readonly resolve: (value: MethodResultValue) => void;
  readonly reject: (error: Error) => void;
  complete: boolean;
  isError: boolean;
}

function createMethodCallState(callId: string) {
  let resolve!: (value: MethodResultValue) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<MethodResultValue>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const stream = createFanout<MethodResultChunk>();
  const state: MethodCallState = {
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

function toAgenticErrorFromMethodResult(content: unknown): AgenticError {
  if (isRecord(content) && typeof content["error"] === "string") {
    const code = typeof content["code"] === "string" ? content["code"] : "execution-error";
    return new AgenticError(content["error"], code as never, content);
  }
  return new AgenticError("method execution failed", "execution-error", content);
}

// ============================================================================
// Tool Role Conflict Detection
// ============================================================================

/**
 * Detect tool role conflicts in the roster.
 * A conflict exists when multiple participants claim to provide the same tool group.
 */
function detectToolRoleConflicts<T extends AgenticParticipantMetadata>(
  roster: Record<string, { metadata: T }>,
  participantFirstSeen: Map<string, number>
): ToolRoleConflict[] {
  const conflicts: ToolRoleConflict[] = [];

  for (const group of ALL_TOOL_GROUPS) {
    // Find all participants claiming this group
    const providers: Array<{
      id: string;
      name: string;
      joinedAt: number;
      priority?: number;
    }> = [];

    for (const [id, participant] of Object.entries(roster)) {
      // Use Zod safeParse to gracefully handle malformed metadata
      const parsed = ConflictMetadataSchema.safeParse(participant.metadata);
      if (!parsed.success) continue; // Skip participants with invalid metadata

      const meta = parsed.data;
      const roleDecl = meta.toolRoles?.[group];
      if (roleDecl?.providing) {
        providers.push({
          id,
          name: meta.name || id,
          joinedAt: participantFirstSeen.get(id) ?? Date.now(),
          priority: roleDecl.priority,
        });
      }
    }

    // Only a conflict if more than one provider
    if (providers.length > 1) {
      const resolvedProvider = resolveToolRoleConflict(providers);
      conflicts.push({
        group,
        providers,
        resolvedProvider,
      });
    }
  }

  return conflicts;
}

/**
 * Resolve a tool role conflict by selecting the winning provider.
 * Priority: lower priority wins → earlier joinedAt wins → lexicographic id wins
 */
function resolveToolRoleConflict(
  providers: Array<{ id: string; joinedAt: number; priority?: number }>
): string {
  if (providers.length === 0) {
    throw new Error("resolveToolRoleConflict called with empty providers array");
  }
  const sorted = [...providers].sort((a, b) => {
    // Priority: lower wins (undefined treated as Infinity)
    const aPriority = a.priority ?? Infinity;
    const bPriority = b.priority ?? Infinity;
    if (aPriority !== bPriority) return aPriority - bPriority;
    // Join time: earlier wins
    if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
    // ID: lexicographic tiebreaker
    return a.id.localeCompare(b.id);
  });
  return sorted[0]!.id;
}

export interface AgenticClientImpl<T extends AgenticParticipantMetadata = AgenticParticipantMetadata>
  extends AgenticClient<T> {}

// ============================================================================
// Session Initialization Helper
// ============================================================================

interface SessionInitResult {
  sessionDb: SessionDb | undefined;
  sessionRow: SessionRow | undefined;
}

/**
 * Initialize session database after connection.
 * Uses the contextId from the server (authoritative) to create/load session.
 */
async function initializeSessionDb(
  contextId: string | undefined,
  channel: string,
  handle: string
): Promise<SessionInitResult> {
  if (!contextId) {
    return { sessionDb: undefined, sessionRow: undefined };
  }

  try {
    const { SessionDb } = await import("./session-db.js");
    const sessionDb = new SessionDb(contextId, channel, handle);
    await sessionDb.initialize();
    const sessionRow = await sessionDb.getOrCreateSession();
    return { sessionDb, sessionRow };
  } catch (err) {
    console.warn("[AgenticClient] Session DB init failed:", err);
    return { sessionDb: undefined, sessionRow: undefined };
  }
}

/**
 * Connect to an agentic messaging channel.
 *
 * This is the main entry point for the agentic messaging system. It establishes
 * a WebSocket connection to the pubsub server, registers methods, and sets up
 * session persistence using the server's contextId.
 *
 * The returned promise resolves after:
 * 1. WebSocket connection is established
 * 2. Initial replay is complete (messages collected or streamed based on replayMode)
 * 3. Session state is loaded (using server's contextId)
 *
 * @param options - Connection configuration
 * @param options.serverUrl - WebSocket server URL (e.g., "ws://127.0.0.1:49452")
 * @param options.token - Authentication token for the pubsub server
 * @param options.channel - Channel name to join
 * @param options.handle - Unique handle for @-mentions (must be unique within channel)
 * @param options.name - Display name for this participant
 * @param options.type - Participant type (e.g., "panel", "worker", "agent", "claude-code")
 * @param options.extraMetadata - Additional metadata to include in presence
 * @param options.contextId - Context ID for channel creators (joiners get it from server)
 * @param options.reconnect - Auto-reconnect on disconnect (boolean or ReconnectConfig)
 * @param options.replayMode - How to handle replay: "collect" (aggregate), "stream" (emit), or "skip"
 * @param options.methods - Methods this participant provides (auto-executed on method-call)
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
 *   contextId: "my-workspace-id",
 *   reconnect: true,
 *   methods: {
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
    contextId: providedContextId,
    channelConfig: providedChannelConfig,
    reconnect,
    replayMode = "collect",
    methods: initialMethods,
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

  // Session DB is initialized AFTER connection using server's contextId
  // This provides a single code path for both channel creators and joiners
  // These are assigned after connection, so we can't use const
  let sessionDb: SessionDb | undefined; // eslint-disable-line prefer-const
  let sessionRow: SessionRow | undefined; // eslint-disable-line prefer-const

  // Determine replay starting point:
  // - undefined: No replay (skip mode) - server sends no historical messages
  // - 0: Replay everything from beginning
  // Note: Checkpoint-based resumption happens on RECONNECTION (handled by pubsub layer),
  // not on initial connection. Initial connection always replays from beginning.
  const sinceId = replayMode === "skip" ? undefined : 0;

  const instanceId = randomId();

  const methods: Record<string, MethodDefinition> = { ...(initialMethods ?? {}) };
  const currentMetadata: AnyRecord = { ...(userMetadata as AnyRecord) };

  const errorHandlers = new Set<(error: Error) => void>();
  const eventsFanout = createFanout<IncomingEvent>();
  const methodCallHandlers = new Set<(call: IncomingMethodCall) => void>();
  const toolRoleConflictHandlers = new Set<(conflicts: ToolRoleConflict[]) => void>();

  const replayEvents: IncomingEvent[] = [];
  let missedMessages: AggregatedEvent[] = [];

  let checkpoint = sessionRow?.checkpointPubsubId;
  let sdkSessionId = sessionRow?.sdkSessionId;
  let status: "active" | "interrupted" | undefined = sessionRow?.status;

  const callStates = new Map<string, MethodCallState>();
  const providerAbortControllers = new Map<string, AbortController>();
  /** Method calls waiting for selfId to be resolved (for auto-execution) */
  const pendingMethodCalls: IncomingMethodCall[] = [];

  let selfId: string | null = null;

  function emitError(error: Error): void {
    for (const handler of errorHandlers) handler(error);
  }

  function emitMethodCall(call: IncomingMethodCall): void {
    for (const handler of methodCallHandlers) handler(call);
  }

  function emitToolRoleConflicts(conflicts: ToolRoleConflict[]): void {
    for (const handler of toolRoleConflictHandlers) handler(conflicts);
  }

  /**
   * Emit method call if it targets this client, then handle it.
   * Centralizes the selfId check and emission logic.
   */
  function emitAndHandleMethodCall(call: IncomingMethodCall): void {
    if (call.providerId === selfId) {
      emitMethodCall(call);
    }
    handleIncomingMethodCall(call).catch((err) =>
      emitError(err instanceof Error ? err : new Error(String(err)))
    );
  }

  function getMethodAdvertisements(fromMethods: Record<string, MethodDefinition>): MethodAdvertisement[] {
    return Object.entries(fromMethods).map(([name, def]) => {
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
        menu: def.menu ?? false,
      };
    });
  }

  function buildMetadataWithMethods(): AnyRecord {
    const advertisedMethods = Object.keys(methods).length > 0 ? getMethodAdvertisements(methods) : undefined;
    return {
      ...currentMetadata,
      methods: advertisedMethods,
      [INTERNAL_METADATA_KEY]: { instanceId, v: 1 },
    };
  }

  // Build initial metadata without methods (methods are advertised via updateMetadata
  // after connection is established, to allow session state to inform method registration)
  function buildInitialMetadata(): AnyRecord {
    return {
      ...currentMetadata,
      [INTERNAL_METADATA_KEY]: { instanceId, v: 1 },
    };
  }

  const pubsub = connectPubSub<T>(serverUrl, token, {
    channel,
    contextId: providedContextId,
    channelConfig: providedChannelConfig,
    sinceId,
    reconnect,
    metadata: buildInitialMetadata() as T,
    clientId,
    skipOwnMessages,
  });

  const unsubTransportError = pubsub.onError((e: Error) =>
    emitError(new AgenticError(e.message, "connection-error", e))
  );

  // Track if we've detected a handle conflict (to close connection)
  let handleConflictError: AgenticError | null = null;

  // Track when we first saw each participant (for conflict resolution).
  // Earlier timestamp = older participant = wins conflicts.
  //
  // LIMITATION: These are client-side observation times, not server join times.
  // Different clients may observe participants at slightly different times due to
  // network delays. This means conflict resolution may vary between clients in
  // rare edge cases. For deterministic resolution, we use lexicographic ID as the
  // final tiebreaker when timestamps match.
  //
  // A future improvement could capture the `ts` from presence "join" events
  // during replay, which would provide server-authoritative timestamps.
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

    // Process any method calls that arrived before we knew our own ID
    if (selfId) {
      while (pendingMethodCalls.length > 0) {
        const call = pendingMethodCalls.shift()!;
        // Only execute methods for live messages, not replay
        if (call.kind !== "replay") {
          emitAndHandleMethodCall(call);
        } else if (call.providerId === selfId) {
          // Still emit to targeted handlers for replay, just don't execute
          emitMethodCall(call);
        }
      }
    }

    // Check for tool role conflicts after initial replay is complete
    // This avoids false conflicts during replay as participants are being reconstructed
    if (initialReplayComplete) {
      const conflicts = detectToolRoleConflicts(roster.participants, participantFirstSeen);
      if (conflicts.length > 0) {
        emitToolRoleConflicts(conflicts);
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
    options?: { persist?: boolean; attachments?: AttachmentInput[] }
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

  async function publishMethodResult(
    callId: string,
    chunk: Omit<MethodResultChunk, "attachments" | "contentType"> & {
      content?: unknown;
      attachments?: AttachmentInput[];
      contentType?: string;
    }
  ): Promise<void> {
    const payload = validateSend(
      MethodResultSchema,
      {
        callId,
        content: chunk.content,
        contentType: chunk.contentType,
        complete: chunk.complete,
        isError: chunk.isError,
        progress: chunk.progress,
      },
      "MethodResult"
    );

    await pubsub.publish("method-result", payload, {
      persist: true,
      attachments: chunk.attachments,
    });
  }

  async function publishMethodError(callId: string, message: string, code: string): Promise<void> {
    await publishMethodResult(callId, {
      content: { error: message, code },
      complete: true,
      isError: true,
    });
  }

  async function executeMethodCall(call: IncomingMethodCall): Promise<void> {
    const method = methods[call.methodName];
    if (!method) {
      await publishMethodError(call.callId, `Method not found: ${call.methodName}`, "method-not-found");
      return;
    }

    const controller = new AbortController();
    providerAbortControllers.set(call.callId, controller);
    const timeoutMs = method.timeout;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const ctx: MethodExecutionContext = {
      callId: call.callId,
      callerId: call.senderId,
      signal: controller.signal,
      stream: async (content) =>
        publishMethodResult(call.callId, { content, complete: false, isError: false }),
      streamWithAttachments: async (content, attachments, options) =>
        publishMethodResult(call.callId, {
          content,
          attachments,
          contentType: options?.contentType,
          complete: false,
          isError: false,
        }),
      resultWithAttachments: (content, attachments, options) => ({
        content,
        attachments,
        contentType: options?.contentType,
      }),
      progress: async (percent) =>
        publishMethodResult(call.callId, { content: undefined, progress: percent, complete: false, isError: false }),
    };

    // Sentinel for timeout - allows distinguishing timeout from other rejections
    const TIMEOUT_SENTINEL = Symbol("timeout");

    try {
      // Handle both Zod schemas and plain JSON schema objects
      const parsedArgs = method.parameters && "_def" in method.parameters
        ? (method.parameters as z.ZodTypeAny).parse(call.args)  // Zod schema
        : call.args;  // Plain JSON schema - pass through as-is

      // Build race competitors
      const competitors: Promise<unknown>[] = [Promise.resolve(method.execute(parsedArgs, ctx))];

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
        await publishMethodError(call.callId, "cancelled", "cancelled");
        return;
      }

      let result: unknown = rawResult;
      if (method.returns) {
        result = (method.returns as z.ZodTypeAny).parse(rawResult);
      }

      if (isMethodResultWithAttachments(result)) {
        await publishMethodResult(call.callId, {
          content: result.content,
          attachments: result.attachments,
          contentType: result.contentType,
          complete: true,
          isError: false,
        });
      } else {
        await publishMethodResult(call.callId, { content: result, complete: true, isError: false });
      }
    } catch (err) {
      // Handle timeout via sentinel
      if (err === TIMEOUT_SENTINEL) {
        await publishMethodError(call.callId, "timeout", "timeout");
        return;
      }
      // Handle cancellation (external abort or AbortError from method)
      const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
      if (aborted) {
        await publishMethodError(call.callId, "cancelled", "cancelled");
      } else if (err instanceof z.ZodError) {
        await publishMethodError(call.callId, err.message, "validation-error");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        await publishMethodError(call.callId, message, "execution-error");
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      providerAbortControllers.delete(call.callId);
    }
  }

  async function handleIncomingMethodCall(call: IncomingMethodCall): Promise<void> {
    if (!selfId || call.providerId !== selfId) return;
    await executeMethodCall(call);
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
      attachments,
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
        attachments,
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
        attachments,
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
        attachments,
        pubsubId,
        senderMetadata: normalizedSender,
        id: parsed.id,
        error: parsed.error,
        code: parsed.code,
      };
    }

    if (type === "method-call") {
      const parsed = validateReceive(MethodCallSchema, payload, "MethodCall");
      if (!parsed) return null;
      return {
        type: "method-call",
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        callId: parsed.callId,
        methodName: parsed.methodName,
        providerId: parsed.providerId,
        args: parsed.args,
      };
    }

    if (type === "method-cancel") {
      const parsed = validateReceive(MethodCancelSchema, payload, "MethodCancel");
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

    if (type === "method-result") {
      const parsed = validateReceive(MethodResultSchema, payload, "MethodResult");
      if (!parsed) return null;
      const complete = parsed.complete ?? false;
      const isError = parsed.isError ?? false;
      const incomingResult: IncomingMethodResult = {
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
        attachments,
      };

      const state = callStates.get(parsed.callId);
      if (!state) return { ...incomingResult, type: "method-result" };

      const chunk: MethodResultChunk = {
        content: parsed.content,
        attachments,
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
          state.reject(toAgenticErrorFromMethodResult(chunk.content));
        } else {
          state.resolve({
            content: chunk.content,
            attachments: chunk.attachments,
            contentType: chunk.contentType,
          });
        }
        callStates.delete(parsed.callId);
      }

      return { ...incomingResult, type: "method-result" };
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
      const presencePayload = payload as { action?: PresenceAction; metadata?: Record<string, unknown>; leaveReason?: LeaveReason };
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
        leaveReason: presencePayload.leaveReason,
        metadata: presencePayload.metadata,
      };
      return { ...presenceEvent, type: "presence" };
    }

    // Tool Role Negotiation Messages
    if (type === "tool-role-request") {
      const parsed = validateReceive(ToolRoleRequestSchema, payload, "ToolRoleRequest");
      if (!parsed) return null;
      return {
        type: "tool-role-request",
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        group: parsed.group,
        requesterId: parsed.requesterId,
        requesterType: parsed.requesterType,
      };
    }

    if (type === "tool-role-response") {
      const parsed = validateReceive(ToolRoleResponseSchema, payload, "ToolRoleResponse");
      if (!parsed) return null;
      return {
        type: "tool-role-response",
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        group: parsed.group,
        accepted: parsed.accepted,
        handoffTo: parsed.handoffTo,
      };
    }

    if (type === "tool-role-handoff") {
      const parsed = validateReceive(ToolRoleHandoffSchema, payload, "ToolRoleHandoff");
      if (!parsed) return null;
      return {
        type: "tool-role-handoff",
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        group: parsed.group,
        from: parsed.from,
        to: parsed.to,
      };
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
    if (sessionDb) {
      status = "interrupted";
      void sessionDb.markInterrupted();
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

          if (event.type === "method-call") {
            if (selfId) {
              if (event.kind !== "replay") {
                emitAndHandleMethodCall(event);
              } else if (event.providerId === selfId) {
                emitMethodCall(event);
              }
            } else {
              pendingMethodCalls.push(event);
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
      attachments?: AttachmentInput[];
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
      attachments: options?.attachments,
    });
    return { messageId: id, pubsubId };
  }

  async function update(
    id: string,
    content: string,
    options?: { complete?: boolean; persist?: boolean; attachments?: AttachmentInput[]; contentType?: string }
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
      attachments: options?.attachments,
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

  function discoverMethodDefsFrom(providerId: string): DiscoveredMethod[] {
    const participant = pubsub.roster[providerId];
    if (!participant) return [];
    const meta = participant.metadata as AnyRecord;
    const advertised = Array.isArray(meta["methods"]) ? (meta["methods"] as MethodAdvertisement[]) : [];
    const providerName = typeof meta["name"] === "string" ? meta["name"] : providerId;
    return advertised.map((m) => ({
      providerId,
      providerName,
      name: m.name,
      description: m.description,
      parameters: m.parameters,
      returns: m.returns,
      streaming: m.streaming ?? false,
      timeout: m.timeout,
      menu: m.menu ?? false,
    }));
  }

  function discoverMethodDefs(): DiscoveredMethod[] {
    return Object.keys(pubsub.roster).flatMap((id) => discoverMethodDefsFrom(id));
  }

  function callMethod(
    providerId: string,
    methodName: string,
    args: unknown,
    callOptions?: { signal?: AbortSignal; validateArgs?: z.ZodTypeAny; timeoutMs?: number }
  ): MethodCallHandle {
    const provider = pubsub.roster[providerId];
    if (!provider) throw new AgenticError(`Provider not found: ${providerId}`, "provider-not-found");

    const meta = provider.metadata as AnyRecord;
    const advertised = Array.isArray(meta["methods"]) ? (meta["methods"] as MethodAdvertisement[]) : [];
    const methodAd = advertised.find((m: MethodAdvertisement) => m.name === methodName);
    if (advertised.length > 0 && !methodAd) {
      throw new AgenticError(`Method not found: ${providerId}:${methodName}`, "method-not-found");
    }

    const callId = randomId();
    const { state, result } = createMethodCallState(callId);
    callStates.set(callId, state);

    if (callOptions?.validateArgs) {
      args = callOptions.validateArgs.parse(args);
    }

    const payload = validateSend(MethodCallSchema, { callId, methodName, providerId, args }, "MethodCall");

    void pubsub.publish("method-call", payload, { persist: true }).catch((e: unknown) => {
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
      const cancelPayload = validateSend(MethodCancelSchema, { callId }, "MethodCancel");
      await pubsub.publish("method-cancel", cancelPayload, { persist: true });
    };

    // Set up timeout - use explicit option, fall back to advertised timeout
    const timeoutMs = callOptions?.timeoutMs ?? methodAd?.timeout;
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
    if (!sessionDb) {
      throw new AgenticError(`${method} requires session (contextId not available)`, "validation-error");
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

  /**
   * Get conversation history derived from pubsub replay.
   * Messages from panel participants are treated as "user" role,
   * messages from other participants (workers/agents) are "assistant" role.
   */
  function getConversationHistory(): ConversationMessage[] {
    return missedMessages
      .filter((e): e is AggregatedMessage => e.type === "message" && !e.incomplete)
      .map((e) => ({
        role: (e.senderType === "panel" ? "user" : "assistant") as "user" | "assistant",
        content: e.content,
      }));
  }

  async function updateSettings(settings: Record<string, unknown>): Promise<void> {
    requireSessionEnabled("updateSettings");
    const db = getSessionDbOrThrow("updateSettings");
    await db.updateSettings(settings);
  }

  async function getSettings<T = Record<string, unknown>>(): Promise<T | null> {
    requireSessionEnabled("getSettings");
    const db = getSessionDbOrThrow("getSettings");
    return await db.getSettings<T>();
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
    throw err;
  }

  // Initialize session DB after connection using server's authoritative contextId
  // This is the single code path for both channel creators and joiners
  const sessionInit = await initializeSessionDb(pubsub.contextId, channel, handle);
  sessionDb = sessionInit.sessionDb;
  sessionRow = sessionInit.sessionRow;

  // Restore session state if available
  if (sessionRow) {
    checkpoint = sessionRow.checkpointPubsubId;
    sdkSessionId = sessionRow.sdkSessionId;
    if (status === undefined) {
      status = sessionRow.status;
    }
  }

  // After connection is established, advertise methods via metadata update
  // The pubsub layer sends basic metadata on connect; we update with full method schemas here
  if (Object.keys(methods).length > 0) {
    try {
      await pubsub.updateMetadata(buildMetadataWithMethods() as T);
    } catch (err) {
      // Log but don't fail - methods can be updated later if needed
      console.warn("[AgenticClient] Failed to advertise methods:", err);
    }
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
    getConversationHistory,
    updateSettings,
    getSettings,
    discoverMethodDefs,
    discoverMethodDefsFrom,
    callMethod,
    get roster() {
      return pubsub.roster;
    },
    resolveHandles: resolveHandlesImpl,
    getParticipantByHandle: getParticipantByHandleImpl,
    onRoster: pubsub.onRoster,
    // Tool Role Negotiation
    onToolRoleConflict: (handler) => {
      toolRoleConflictHandlers.add(handler);
      return () => toolRoleConflictHandlers.delete(handler);
    },
    requestToolRole: async (group: ToolGroup) => {
      await pubsub.publish("tool-role-request", {
        group,
        requesterId: selfId ?? instanceId,
        requesterType: currentMetadata["type"] ?? "unknown",
      });
    },
    respondToolRole: async (group: ToolGroup, accepted: boolean, handoffTo?: string) => {
      await pubsub.publish("tool-role-response", {
        group,
        accepted,
        handoffTo,
      });
    },
    announceToolRoleHandoff: async (group: ToolGroup, from: string, to: string) => {
      await pubsub.publish("tool-role-handoff", {
        group,
        from,
        to,
      });
    },
    get channelConfig() {
      return pubsub.channelConfig;
    },
    // Channel Title (via channel config)
    setChannelTitle: async (title: string) => {
      await pubsub.updateChannelConfig({ title });
    },
    onTitleChange: (handler: (title: string) => void) => {
      return pubsub.onConfigChange((config) => {
        if (config.title !== undefined) {
          handler(config.title);
        }
      });
    },
    get connected() {
      return pubsub.connected;
    },
    get reconnecting() {
      return pubsub.reconnecting;
    },
    close: async () => {
      // Send graceful close message to server before disconnecting
      // This allows the server to record a "graceful" leave reason instead of "disconnect"
      try {
        await pubsub.sendRaw({ action: "close" });
      } catch {
        // Ignore errors - connection may already be closed
      }
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
    sendMethodResult: async (
      callId: string,
      content: unknown,
      options?: {
        complete?: boolean;
        isError?: boolean;
        progress?: number;
        attachments?: AttachmentInput[];
        contentType?: string;
      }
    ) => {
      await publishMethodResult(callId, {
        content,
        complete: options?.complete ?? true,
        isError: options?.isError ?? false,
        progress: options?.progress,
        attachments: options?.attachments,
        contentType: options?.contentType,
      });
    },
  };
}

/** Tool definition returned by createToolsForAgentSDK */
export interface AgentSDKToolDefinition {
  /** Prefixed tool name for SDK consumption (e.g., "pubsub_panelId_file_read") */
  name: string;
  /** Original method name without prefix (e.g., "file_read") */
  originalMethodName: string;
  /** Provider ID that registered this method */
  providerId: string;
  /** Tool description */
  description?: string;
  /** JSON Schema for tool parameters */
  parameters: JsonSchema;
}

/**
 * Create tool definitions suitable for agent SDK integration.
 * Produces stable, conflict-free tool names and a single execute() dispatcher.
 * Note: This function maintains the "tools" naming because it produces output
 * for LLM SDK integration where "tools" is the standard terminology.
 */
export function createToolsForAgentSDK(
  client: AgenticClient,
  options?: {
    filter?: (method: DiscoveredMethod) => boolean;
    namePrefix?: string;
  }
): {
  definitions: AgentSDKToolDefinition[];
  execute: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
} {
  const methods = client.discoverMethodDefs();
  const filtered = options?.filter ? methods.filter(options.filter) : methods;

  const prefix = options?.namePrefix ?? "pubsub";
  const nameMap = new Map<string, DiscoveredMethod>();

  const definitions = filtered.map((method) => {
    const name = `${prefix}_${method.providerId}_${method.name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    nameMap.set(name, method);
    return {
      name,
      originalMethodName: method.name,
      providerId: method.providerId,
      description: method.description ? `[${method.providerName}] ${method.description}` : undefined,
      parameters: method.parameters,
    };
  });

  return {
    definitions,
    execute: async (name, args, signal) => {
      const method = nameMap.get(name);
      if (!method) throw new AgenticError(`Method not found: ${name}`, "method-not-found");
      const result = client.callMethod(method.providerId, method.name, args, { signal });
      return (await result.result).content;
    },
  };
}

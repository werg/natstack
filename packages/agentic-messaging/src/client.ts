import { connect as connectPubSub, type Message as PubSubMessage, type RosterUpdate } from "@natstack/pubsub";
import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

import type {
  AgenticClient,
  AgenticParticipantMetadata,
  ConflictResolver,
  ConnectOptions,
  DiscoveredTool,
  IncomingMessage,
  IncomingToolCall,
  ToolAdvertisement,
  ToolCallResult,
  ToolConflict,
  ToolDefinition,
  ToolExecutionContext,
  ToolResultChunk,
  ToolResultValue,
  ToolResultWithAttachment,
  AIToolDefinition,
  JsonSchema,
} from "./types.js";
import { AgenticError, ValidationError } from "./types.js";
import {
  ErrorMessageSchema,
  NewMessageSchema,
  ToolCallSchema,
  ToolCancelSchema,
  ToolResultSchema,
  UpdateMessageSchema,
} from "./protocol.js";

const INTERNAL_METADATA_KEY = "_agentic";

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
    async *subscribe(): AsyncIterableIterator<T> {
      const q = new AsyncQueue<T>();
      subscribers.add(q);
      try {
        for await (const v of q) yield v;
      } finally {
        subscribers.delete(q);
        q.close();
      }
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

/**
 * Default conflict resolver that throws an error on name collision.
 */
const throwOnConflict: ConflictResolver = (conflict: ToolConflict) => {
  const providers = conflict.tools.map((t) => t.providerId).join(", ");
  throw new AgenticError(
    `Tool name conflict: "${conflict.name}" is provided by multiple sources: ${providers}`,
    "validation-error"
  );
};

/**
 * Conflict resolver that renames tools using `{providerId}__{toolName}` format.
 * Useful when you want to include all tools regardless of name collisions.
 */
export const renamingConflictResolver: ConflictResolver = (conflict: ToolConflict) => {
  const result: Record<string, string> = {};
  for (const tool of conflict.tools) {
    const base = `${tool.providerId}__${tool.name}`;
    result[tool.providerId] = base.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  }
  return result;
};

export interface AgenticClientImpl<T extends AgenticParticipantMetadata = AgenticParticipantMetadata>
  extends AgenticClient<T> {}

export function connect<T extends AgenticParticipantMetadata = AgenticParticipantMetadata>(
  serverUrl: string,
  token: string,
  options: ConnectOptions<T>
): AgenticClient<T> {
  const {
    channel,
    sinceId,
    reconnect,
    metadata: userMetadata,
    tools: initialTools,
    clientId,
    skipOwnMessages,
  } = options;

  const instanceId = randomId();

  const tools: Record<string, ToolDefinition> = { ...(initialTools ?? {}) };
  const currentMetadata: AnyRecord = { ...(userMetadata as AnyRecord) };

  const errorHandlers = new Set<(error: Error) => void>();
  const messagesFanout = createFanout<IncomingMessage>();

  const callStates = new Map<string, ToolCallState>();
  const providerAbortControllers = new Map<string, AbortController>();
  /** Tool calls waiting for selfId to be resolved (for auto-execution) */
  const pendingToolCalls: IncomingToolCall[] = [];

  let selfId: string | null = null;

  function emitError(error: Error): void {
    for (const handler of errorHandlers) handler(error);
  }

  function getToolAdvertisements(fromTools: Record<string, ToolDefinition>): ToolAdvertisement[] {
    return Object.entries(fromTools).map(([name, def]) => ({
      name,
      description: def.description,
      parameters: zodToJsonSchema(def.parameters),
      returns: def.returns ? zodToJsonSchema(def.returns) : undefined,
      streaming: def.streaming ?? false,
      timeout: def.timeout,
    }));
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

  const unsubRoster = pubsub.onRoster((roster: RosterUpdate<T>) => {
    if (selfId) return;
    for (const [id, participant] of Object.entries(roster.participants)) {
      const meta = participant.metadata as AnyRecord;
      const internal = meta[INTERNAL_METADATA_KEY];
      if (isRecord(internal) && internal["instanceId"] === instanceId) {
        selfId = id;
        // Process any tool calls that arrived before we knew our own ID
        while (pendingToolCalls.length > 0) {
          const call = pendingToolCalls.shift()!;
          handleIncomingToolCall(call).catch((err) => emitError(err instanceof Error ? err : new Error(String(err))));
        }
        break;
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
  ): Promise<void> {
    try {
      await pubsub.publish(type, payload, options);
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

    try {
      const parsedArgs = (tool.parameters as z.ZodTypeAny).parse(call.args);
      const rawResult = await tool.execute(parsedArgs, ctx);

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
      providerAbortControllers.delete(call.callId);
    }
  }

  async function handleIncomingToolCall(call: IncomingToolCall): Promise<void> {
    if (!selfId || call.providerId !== selfId) return;
    await executeToolCall(call);
  }

  async function handleIncoming(pubsubMsg: PubSubMessage): Promise<void> {
    const { type, payload, attachment, senderId, ts, kind } = pubsubMsg;

    if (type === "message") {
      const parsed = validateReceive(NewMessageSchema, payload, "NewMessage");
      if (!parsed) return;
      messagesFanout.emit({
        type: "message",
        kind,
        senderId,
        ts,
        attachment,
        id: parsed.id,
        content: parsed.content,
        replyTo: parsed.replyTo,
        contentType: parsed.contentType,
      });
      return;
    }

    if (type === "update-message") {
      const parsed = validateReceive(UpdateMessageSchema, payload, "UpdateMessage");
      if (!parsed) return;
      messagesFanout.emit({
        type: "update-message",
        kind,
        senderId,
        ts,
        attachment,
        id: parsed.id,
        content: parsed.content,
        complete: parsed.complete,
        contentType: parsed.contentType,
      });
      return;
    }

    if (type === "error") {
      const parsed = validateReceive(ErrorMessageSchema, payload, "ErrorMessage");
      if (!parsed) return;
      messagesFanout.emit({
        type: "error",
        kind,
        senderId,
        ts,
        attachment,
        id: parsed.id,
        error: parsed.error,
        code: parsed.code,
      });
      return;
    }

    if (type === "tool-call") {
      const parsed = validateReceive(ToolCallSchema, payload, "ToolCall");
      if (!parsed) return;
      const incoming: IncomingToolCall = {
        kind,
        senderId,
        ts,
        callId: parsed.callId,
        toolName: parsed.toolName,
        providerId: parsed.providerId,
        args: parsed.args,
      };
      if (selfId) {
        await handleIncomingToolCall(incoming);
      } else {
        pendingToolCalls.push(incoming);
      }
      return;
    }

    if (type === "tool-cancel") {
      const parsed = validateReceive(ToolCancelSchema, payload, "ToolCancel");
      if (!parsed) return;
      const controller = providerAbortControllers.get(parsed.callId);
      controller?.abort();
      const state = callStates.get(parsed.callId);
      if (state && !state.complete) {
        state.complete = true;
        state.isError = true;
        const error = new AgenticError("cancelled", "cancelled");
        state.stream.emit({ content: { error: "cancelled", code: "cancelled" }, complete: true, isError: true });
        state.stream.close();
        state.reject(error);
      }
      return;
    }

    if (type === "tool-result") {
      const parsed = validateReceive(ToolResultSchema, payload, "ToolResult");
      if (!parsed) return;
      const state = callStates.get(parsed.callId);
      if (!state) return;

      const chunk: ToolResultChunk = {
        content: parsed.content,
        attachment,
        contentType: parsed.contentType,
        complete: parsed.complete ?? false,
        isError: parsed.isError ?? false,
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
          state.resolve({ content: chunk.content, attachment: chunk.attachment, contentType: chunk.contentType });
        }
        callStates.delete(parsed.callId);
      }
      return;
    }
  }

  void (async () => {
    try {
      for await (const msg of pubsub.messages()) {
        try {
          await handleIncoming(msg);
        } catch (err) {
          // Don't let a single bad message kill the entire processing loop
          const error = err instanceof Error ? err : new Error(String(err));
          emitError(error);
        }
      }
    } catch (err) {
      // Transport-level error (e.g., connection closed)
      const error = err instanceof Error ? err : new Error(String(err));
      emitError(error);
    } finally {
      messagesFanout.close();
      unsubTransportError();
      unsubRoster();
    }
  })();

  function messages(): AsyncIterableIterator<IncomingMessage> {
    return messagesFanout.subscribe();
  }

  async function send(
    content: string,
    options?: { replyTo?: string; persist?: boolean; attachment?: Uint8Array; contentType?: string }
  ): Promise<string> {
    const id = randomId();
    const payload = validateSend(
      NewMessageSchema,
      { id, content, replyTo: options?.replyTo, contentType: options?.contentType },
      "NewMessage"
    );
    await publishValidated("message", payload, { persist: options?.persist, attachment: options?.attachment });
    return id;
  }

  async function update(
    id: string,
    content: string,
    options?: { complete?: boolean; persist?: boolean; attachment?: Uint8Array; contentType?: string }
  ): Promise<void> {
    const payload = validateSend(
      UpdateMessageSchema,
      { id, content, complete: options?.complete, contentType: options?.contentType },
      "UpdateMessage"
    );
    await publishValidated("update-message", payload, { persist: options?.persist, attachment: options?.attachment });
  }

  async function complete(id: string): Promise<void> {
    const payload = validateSend(UpdateMessageSchema, { id, complete: true }, "UpdateMessage");
    await publishValidated("update-message", payload, { persist: true });
  }

  async function error(id: string, err: string, code?: string): Promise<void> {
    const payload = validateSend(ErrorMessageSchema, { id, error: err, code }, "ErrorMessage");
    await publishValidated("error", payload, { persist: true });
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

  function collectExecutableTools(onConflict: ConflictResolver = throwOnConflict): Record<string, AIToolDefinition> {
    const discovered = discoverToolDefs();

    // Group tools by name to detect conflicts
    const byName = new Map<string, DiscoveredTool[]>();
    for (const tool of discovered) {
      const existing = byName.get(tool.name);
      if (existing) existing.push(tool);
      else byName.set(tool.name, [tool]);
    }

    // Build result, resolving conflicts as needed
    const toolsForAI: Record<string, AIToolDefinition> = {};

    const addTool = (key: string, tool: DiscoveredTool) => {
      toolsForAI[key] = {
        description: tool.description,
        parameters: tool.parameters,
        execute: async (args, signal) => {
          const result = callTool(tool.providerId, tool.name, args, { signal });
          const value = await result.result;
          return value.content;
        },
      };
    };

    for (const [name, tools] of byName) {
      if (tools.length === 1) {
        // No conflict - use original name
        addTool(name, tools[0]!);
      } else {
        // Conflict - invoke resolver
        const renames = onConflict({ name, tools });
        for (const tool of tools) {
          const newName = renames[tool.providerId];
          if (newName !== undefined) {
            addTool(newName, tool);
          }
        }
      }
    }

    return toolsForAI;
  }

  return {
    messages,
    send,
    update,
    complete,
    error,
    discoverToolDefs,
    discoverToolDefsFrom,
    callTool,
    collectExecutableTools,
    get roster() {
      return pubsub.roster;
    },
    onRoster: pubsub.onRoster,
    get connected() {
      return pubsub.connected;
    },
    get reconnecting() {
      return pubsub.reconnecting;
    },
    ready: pubsub.ready,
    close: pubsub.close,
    onError: (handler) => {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    onDisconnect: pubsub.onDisconnect,
    onReconnect: pubsub.onReconnect,
    pubsub,
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

/**
 * model_call executor (WS1 §2.4.1) — drives @earendil-works/pi-ai `stream`
 * directly. The prompt is re-derived purely from the log (entries through
 * contextThroughSeq) + blobstore hashes — nothing closure-bound. Streaming
 * deltas ride the channel's ephemeral signal mode; the durable terminal is
 * `message.completed` with authoritative blocks.
 */

import { getModel, stream, type Context, type Message } from "@earendil-works/pi-ai";
import {
  buildModelContext,
  classifyModelFailure,
  type EffectOutcome,
  modelFailureInputFromUnknown,
  type ModelCallEffect,
  type ModelMessage,
} from "@workspace/agent-loop";
import {
  AGENTIC_PROTOCOL_VERSION,
  hydrateStoredValueRefs,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import { buildRawThinkingOptions, type RawThinkingModel } from "./pi-raw-thinking-options.js";
import {
  CredentialApprovalDeferredError,
  CredentialPendingError,
  type EffectExecutor,
} from "./types.js";
import { modelCredentialReconnectOutcome } from "../model-credential-suspension.js";

const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const PI_REPLAY_METADATA_KEY = "pi";
const MAX_PROVIDER_SESSION_ID_LENGTH = 64;

type PiReplayMetadata = {
  textSignature?: string;
  thinkingSignature?: string;
  thoughtSignature?: string;
  redacted?: boolean;
};

class ModelStreamIdleTimeoutError extends Error {
  constructor(timeoutMs: number, phase: ModelStreamIdlePhase) {
    super(`model stream idle timeout after ${timeoutMs}ms while waiting for ${phase}`);
    this.name = "ModelStreamIdleTimeoutError";
  }
}

type ModelStreamIdlePhase = "stream event" | "stream result";

async function withModelStreamIdleTimeout<T>(
  promise: Promise<T>,
  input: {
    timeoutMs: number | null;
    outerSignal: AbortSignal;
    streamAbort: AbortController;
    phase: ModelStreamIdlePhase;
    onIdleTimeout?: () => void;
  }
): Promise<T> {
  if (input.outerSignal.aborted) {
    input.streamAbort.abort(input.outerSignal.reason);
    throw input.outerSignal.reason ?? new Error("model stream aborted");
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  const races: Array<Promise<T>> = [promise];
  const timeoutMs = input.timeoutMs;
  if (timeoutMs !== null) {
    races.push(
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const err = new ModelStreamIdleTimeoutError(timeoutMs, input.phase);
          input.onIdleTimeout?.();
          input.streamAbort.abort(err);
          reject(err);
        }, timeoutMs);
      })
    );
  }
  const abort = new Promise<T>((_resolve, reject) => {
    abortListener = () => {
      input.streamAbort.abort(input.outerSignal.reason);
      reject(input.outerSignal.reason ?? new Error("model stream aborted"));
    };
    input.outerSignal.addEventListener("abort", abortListener, { once: true });
  });
  races.push(abort);

  try {
    return await Promise.race(races);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abortListener) input.outerSignal.removeEventListener("abort", abortListener);
  }
}

function modelStreamIdleTimeoutMs(request: ModelCallEffect["request"]): number | null {
  const configured = request.streamOptions?.idleTimeoutMs;
  if (configured === null) return null;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS;
}

function modelStreamIdleTimeoutReason(timeoutMs: number, phase: ModelStreamIdlePhase): string {
  return `model_stream_idle_timeout: no ${phase} within ${timeoutMs}ms`;
}

function modelFailureOutcome(
  err: unknown,
  request: ModelCallEffect["request"],
  opts: { modelBaseUrl?: string } = {}
): EffectOutcome {
  const failure = classifyModelFailure(
    modelFailureInputFromUnknown(err, {
      provider: request.provider,
      model: request.model,
      now: new Date().toISOString(),
    })
  );
  if (failure.code === "auth_or_credentials") {
    return modelCredentialReconnectOutcome({
      providerId: request.provider,
      modelBaseUrl: opts.modelBaseUrl ?? request.modelBaseUrl,
      reason: failure.reason,
      failureCode: failure.code,
    });
  }
  if (failure.recoverable && failure.retryAfterMs !== undefined) {
    return {
      kind: "retry",
      reason: failure.reason,
      retryAfterMs: failure.retryAfterMs,
      code: failure.code,
    };
  }
  return {
    kind: "model",
    blocks: [],
    stopReason: "error",
    errorReason: failure.reason,
    recoverable: failure.recoverable,
    failure,
  };
}

function modelFailureOutcomeFromMessage(
  message: string,
  request: ModelCallEffect["request"],
  opts: { modelBaseUrl?: string } = {}
): EffectOutcome {
  return modelFailureOutcome(new Error(message), request, opts);
}

function traceModelCallStage(
  stage: string,
  descriptor: ModelCallEffect,
  extra?: Record<string, unknown>,
  env?: Record<string, unknown>
): void {
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  const traceEnabled =
    env?.["NATSTACK_MODEL_CALL_TRACE"] === "1" ||
    env?.["NATSTACK_MODEL_CALL_TRACE"] === true ||
    processEnv?.["NATSTACK_MODEL_CALL_TRACE"] === "1" ||
    processEnv?.["NATSTACK_MODEL_CALL_TRACE"] === "true" ||
    env?.["NATSTACK_LOG_LEVEL"] === "verbose" ||
    processEnv?.["NATSTACK_LOG_LEVEL"] === "verbose";
  if (!traceEnabled) return;
  console.info("[model-call] trace:", {
    stage,
    channelId: descriptor.channelId,
    turnId: descriptor.turnId,
    messageId: descriptor.messageId,
    provider: descriptor.request.provider,
    model: descriptor.request.model,
    attemptId: descriptor.request.attemptId,
    ...extra,
  });
}

function modelStreamSessionId(
  descriptor: ModelCallEffect,
  selfRef: { id: string; participantId?: string }
): string {
  return providerSafeSessionId(`${descriptor.channelId}:${selfRef.participantId ?? selfRef.id}`);
}

function providerSafeSessionId(raw: string): string {
  if (raw.length <= MAX_PROVIDER_SESSION_ID_LENGTH) return raw;
  const hash = stableShortHash(raw);
  const prefixLength = MAX_PROVIDER_SESSION_ID_LENGTH - hash.length - 1;
  return `${raw.slice(0, prefixLength)}-${hash}`;
}

function stableShortHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(36).padStart(7, "0")}${(h1 >>> 0).toString(36).padStart(7, "0")}`;
}

function toPiMessages(messages: ModelMessage[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({
        role: "user",
        content:
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : extractUserContent(message.content),
        timestamp: 0,
      } as unknown as Message);
    } else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: toPiAssistantBlocks(message.blocks ?? []) as never,
        usage: {},
        stopReason: "stop",
        timestamp: 0,
      } as unknown as Message);
    } else {
      out.push({
        role: "toolResult",
        toolCallId: message.toolCallId ?? "",
        toolName: message.toolName ?? "",
        content: [{ type: "text", text: safeText(message.content) }],
        isError: message.isError ?? false,
        timestamp: 0,
      } as unknown as Message);
    }
  }
  return out;
}

/** Journaled protocol blocks carry `content`; pi-ai message blocks carry
 *  `text` / `thinking`. Passing protocol blocks through raw makes pi-ai call
 *  `text.replace` on undefined for every historical text block — which fails
 *  every model call in any turn whose context contains assistant prose. */
export function toPiAssistantBlocks(blocks: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    const type = block["type"];
    const replay = readPiReplayMetadata(block["metadata"]);
    const content = typeof block["content"] === "string" ? (block["content"] as string) : "";
    if (type === "text") {
      out.push({
        type: "text",
        text: typeof block["text"] === "string" ? block["text"] : content,
        ...(replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {}),
      });
    } else if (type === "thinking") {
      out.push({
        type: "thinking",
        thinking: typeof block["thinking"] === "string" ? block["thinking"] : content,
        ...(replay.thinkingSignature !== undefined
          ? { thinkingSignature: replay.thinkingSignature }
          : {}),
        ...(replay.redacted !== undefined ? { redacted: replay.redacted } : {}),
      });
    } else if (type === "toolCall") {
      out.push({
        type: "toolCall",
        id: block["id"],
        name: block["name"],
        arguments: block["arguments"] ?? {},
        ...(replay.thoughtSignature !== undefined
          ? { thoughtSignature: replay.thoughtSignature }
          : {}),
      });
    }
    // diagnostic / unknown block types are agent-internal — not model input.
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readPiReplayMetadata(metadata: unknown): PiReplayMetadata {
  if (!isRecord(metadata)) return {};
  const pi = metadata[PI_REPLAY_METADATA_KEY];
  if (!isRecord(pi)) return {};
  return {
    ...(typeof pi["textSignature"] === "string" ? { textSignature: pi["textSignature"] } : {}),
    ...(typeof pi["thinkingSignature"] === "string"
      ? { thinkingSignature: pi["thinkingSignature"] }
      : {}),
    ...(typeof pi["thoughtSignature"] === "string"
      ? { thoughtSignature: pi["thoughtSignature"] }
      : {}),
    ...(typeof pi["redacted"] === "boolean" ? { redacted: pi["redacted"] } : {}),
  };
}

function metadataWithPiReplay(
  existing: unknown,
  replay: PiReplayMetadata
): Record<string, unknown> | undefined {
  const base = isRecord(existing) ? { ...existing } : {};
  const pi = readDefinedReplayMetadata(replay);
  if (Object.keys(pi).length > 0) {
    const existingPi = isRecord(base[PI_REPLAY_METADATA_KEY]) ? base[PI_REPLAY_METADATA_KEY] : {};
    base[PI_REPLAY_METADATA_KEY] = { ...existingPi, ...pi };
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

function readDefinedReplayMetadata(replay: PiReplayMetadata): Record<string, unknown> {
  return {
    ...(replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {}),
    ...(replay.thinkingSignature !== undefined
      ? { thinkingSignature: replay.thinkingSignature }
      : {}),
    ...(replay.thoughtSignature !== undefined ? { thoughtSignature: replay.thoughtSignature } : {}),
    ...(replay.redacted !== undefined ? { redacted: replay.redacted } : {}),
  };
}

function extractUserContent(content: unknown): Array<{ type: "text"; text: string }> {
  if (
    content &&
    typeof content === "object" &&
    Array.isArray((content as { blocks?: unknown[] }).blocks)
  ) {
    const blocks = (content as { blocks: unknown[] }).blocks;
    const texts = blocks
      .map((block) =>
        block &&
        typeof block === "object" &&
        typeof (block as { content?: unknown }).content === "string"
          ? (block as { content: string }).content
          : null
      )
      .filter((text): text is string => text !== null);
    if (texts.length > 0) return texts.map((text) => ({ type: "text", text }));
  }
  return [{ type: "text", text: safeText(content) }];
}

function safeText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function deterministicTestModeModelOutcome(
  descriptor: ModelCallEffect,
  env?: Record<string, unknown>
): EffectOutcome | null {
  const testMode = env?.["NATSTACK_TEST_MODE"];
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  if (testMode !== "1" && processEnv?.["NATSTACK_TEST_MODE"] !== "1") return null;
  if (descriptor.request.provider !== "openai-codex") return null;
  return {
    kind: "model",
    blocks: [
      {
        blockId: `${descriptor.messageId}:block:0`,
        type: "text",
        content: "E2E model response: initial agent turn completed.",
      },
    ],
    stopReason: "completed",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

export const modelCallExecutor: EffectExecutor<ModelCallEffect> = {
  kind: "model_call",

  async execute({ descriptor, state, signal, deps, onEphemeral }) {
    const request = descriptor.request;
    const trace = (stage: string, extra?: Record<string, unknown>) =>
      traceModelCallStage(stage, descriptor, extra, deps.env);
    trace("start");

    // Resolve the model first: credentials are URL-bound, so the lookup (and
    // any connect-card suspension) needs the model's base URL even when the
    // request descriptor doesn't carry one — pi-ai's registry is the default.
    const registryModel = getModel(request.provider as never, request.model as never) as
      | { baseUrl?: string }
      | undefined;
    const modelBaseUrl =
      request.modelBaseUrl ??
      (typeof registryModel?.baseUrl === "string" ? registryModel.baseUrl : undefined);

    const systemPromptPromise = deps.blobstore.getText(request.systemPromptHash);
    const toolsJsonPromise = request.toolSchemasHash
      ? deps.blobstore.getText(request.toolSchemasHash)
      : Promise.resolve(null);
    // The credential lookup below can return (suspend) or throw before these
    // are awaited; detached no-op handlers prevent an unhandled rejection in
    // that window. The awaited Promise.all still observes any real rejection.
    systemPromptPromise.catch(() => {});
    toolsJsonPromise.catch(() => {});

    const testModeOutcome = deterministicTestModeModelOutcome(descriptor, deps.env);
    if (testModeOutcome) {
      trace("test-mode.completed");
      return testModeOutcome;
    }

    // A pending connect suspends the turn, not fails it. Immutable prompt/tool
    // blob reads above can run concurrently with this lookup.
    let credentials: { apiKey: string; headers?: Record<string, string> };
    try {
      trace("credential.resolve.start", { modelBaseUrl });
      credentials = await deps.credentials.getApiKey({
        providerId: request.provider,
        ...(modelBaseUrl ? { modelBaseUrl } : {}),
        requestId: descriptor.effectId,
        idempotencyKey: descriptor.idempotencyKey,
      });
      trace("credential.resolve.completed", {
        hasHeaders: !!credentials.headers,
      });
    } catch (err) {
      if (err instanceof CredentialApprovalDeferredError) {
        return { deferred: true };
      }
      if (err instanceof CredentialPendingError) {
        trace("credential.pending", {
          providerId: err.providerId,
          modelBaseUrl: err.modelBaseUrl ?? modelBaseUrl,
        });
        return {
          kind: "model-suspended",
          reason: "credential",
          providerId: err.providerId,
          ...((err.modelBaseUrl ?? modelBaseUrl)
            ? { modelBaseUrl: err.modelBaseUrl ?? modelBaseUrl }
            : {}),
        } satisfies EffectOutcome;
      }
      throw err;
    }

    const [systemPromptRaw, toolsJson] = await Promise.all([systemPromptPromise, toolsJsonPromise]);
    trace("context.blobs.loaded", {
      hasSystemPrompt: systemPromptRaw !== null,
      hasTools: toolsJson !== null,
    });
    const systemPrompt = systemPromptRaw ?? undefined;
    const tools = toolsJson ? (JSON.parse(toolsJson) as Context["tools"]) : undefined;

    const model = registryModel as ReturnType<typeof getModel>;
    if (!model) {
      return {
        kind: "model",
        blocks: [],
        stopReason: "error",
        errorReason: `unknown model ${request.provider}:${request.model}`,
      };
    }

    // Storage boundary, model-input side: fold entries keep spilled fields
    // (tool results, large user content) as blob refs — the model must see
    // the actual bytes, never `natstack.blob-ref.v1` pointers (a model that
    // reads pointer JSON emits garbage tool args and pointer-shaped paths).
    const hydratedMessages = (await hydrateStoredValueRefs(
      buildModelContext(state, request.contextThroughSeq),
      { getText: (digest) => deps.blobstore.getText(digest) }
    )) as ModelMessage[];
    const context: Context = {
      ...(systemPrompt ? { systemPrompt } : {}),
      messages: toPiMessages(hydratedMessages),
      ...(tools ? { tools } : {}),
    };
    trace("context.built", {
      messageCount: context.messages.length,
      toolCount: Array.isArray(context.tools) ? context.tools.length : undefined,
    });

    const streamAbort = new AbortController();
    let idleTimedOut = false;
    if (signal.aborted) {
      streamAbort.abort(signal.reason);
    }
    const forwardAbort = () => streamAbort.abort(signal.reason);
    signal.addEventListener("abort", forwardAbort, { once: true });

    trace("stream.start", {
      modelBaseUrl: request.modelBaseUrl ?? modelBaseUrl,
    });
    const eventStream = stream(model as never, context, {
      apiKey: credentials.apiKey,
      ...(credentials.headers ? { headers: credentials.headers } : {}),
      ...(request.modelBaseUrl ? { baseUrl: request.modelBaseUrl } : {}), // explicit override only — registry models already carry their own baseUrl
      signal: streamAbort.signal,
      sessionId: modelStreamSessionId(descriptor, deps.selfRef),
      ...buildRawThinkingOptions(model as RawThinkingModel, request.thinkingLevel),
    } as never);

    const blockIds = new Map<number, string>();
    let deltaCounter = 0;
    let sawFirstStreamEvent = false;
    const idleTimeoutMs = modelStreamIdleTimeoutMs(request);
    let idleTimeoutPhase: ModelStreamIdlePhase | null = null;
    try {
      const iterator = (eventStream as AsyncIterable<Record<string, unknown>>)[
        Symbol.asyncIterator
      ]();
      for (;;) {
        const next = await withModelStreamIdleTimeout(iterator.next(), {
          timeoutMs: idleTimeoutMs,
          outerSignal: signal,
          streamAbort,
          phase: "stream event",
          onIdleTimeout: () => {
            idleTimedOut = true;
            idleTimeoutPhase = "stream event";
          },
        }).catch((err) => {
          if (err instanceof ModelStreamIdleTimeoutError) idleTimedOut = true;
          throw err;
        });
        if (next.done) break;
        const event = next.value;
        if (!sawFirstStreamEvent) {
          sawFirstStreamEvent = true;
          trace("stream.first-event", {
            eventType: String(event["type"] ?? ""),
          });
        }
        const type = String(event["type"] ?? "");
        if (type === "text_delta" || type === "thinking_delta") {
          const index = Number(event["contentIndex"] ?? event["index"] ?? 0);
          if (!blockIds.has(index)) {
            blockIds.set(index, `${descriptor.messageId}:block:${index}`);
          }
          deltaCounter += 1;
          const deltaEvent: AgenticEvent = {
            kind: "message.delta",
            actor: deps.selfRef,
            causality: { messageId: descriptor.messageId as never },
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              blockId: blockIds.get(index) as never,
              type: type === "text_delta" ? "text" : "thinking",
              text: String(event["delta"] ?? event["text"] ?? ""),
            },
            createdAt: new Date().toISOString(),
          } as AgenticEvent;
          onEphemeral({
            kind: "signal-event",
            channelId: descriptor.channelId,
            event: deltaEvent,
          });
        }
      }
    } catch (err) {
      signal.removeEventListener("abort", forwardAbort);
      if (signal.aborted) {
        return { kind: "model", blocks: [], stopReason: "aborted" };
      }
      if (idleTimedOut || err instanceof ModelStreamIdleTimeoutError) {
        const timeoutMs = idleTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS;
        const phase = idleTimeoutPhase ?? "stream event";
        const errorReason = modelStreamIdleTimeoutReason(timeoutMs, phase);
        console.warn("[model-call] stream idle watchdog fired:", {
          channelId: descriptor.channelId,
          messageId: descriptor.messageId,
          provider: request.provider,
          model: request.model,
          timeoutMs,
          phase,
        });
        trace("stream.idle-timeout", { timeoutMs, phase });
        return {
          kind: "model",
          blocks: [],
          stopReason: "error",
          errorReason,
        };
      }
      // The journaled message.failed only keeps the message — log the stack
      // here so a deterministic crash in the request path is traceable.
      console.warn(
        "[model-call] stream failed:",
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      );
      trace("stream.failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return modelFailureOutcome(err, request, { modelBaseUrl });
    }
    void deltaCounter;

    let result: Record<string, unknown>;
    try {
      trace("stream.result.start");
      result = await withModelStreamIdleTimeout(
        (eventStream as unknown as { result(): Promise<Record<string, unknown>> }).result(),
        {
          timeoutMs: idleTimeoutMs,
          outerSignal: signal,
          streamAbort,
          phase: "stream result",
          onIdleTimeout: () => {
            idleTimedOut = true;
            idleTimeoutPhase = "stream result";
          },
        }
      );
    } catch (err) {
      if (signal.aborted) {
        return { kind: "model", blocks: [], stopReason: "aborted" };
      }
      if (idleTimedOut || err instanceof ModelStreamIdleTimeoutError) {
        const timeoutMs = idleTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS;
        const phase = idleTimeoutPhase ?? "stream result";
        const errorReason = modelStreamIdleTimeoutReason(timeoutMs, phase);
        console.warn("[model-call] stream idle watchdog fired:", {
          channelId: descriptor.channelId,
          messageId: descriptor.messageId,
          provider: request.provider,
          model: request.model,
          timeoutMs,
          phase,
        });
        trace("stream.idle-timeout", { timeoutMs, phase });
        return {
          kind: "model",
          blocks: [],
          stopReason: "error",
          errorReason,
        };
      }
      return modelFailureOutcome(
        err instanceof Error ? err : new Error("model stream failed"),
        request,
        { modelBaseUrl }
      );
    } finally {
      signal.removeEventListener("abort", forwardAbort);
    }
    const content = Array.isArray(result["content"]) ? (result["content"] as unknown[]) : [];
    const stopReason = String(result["stopReason"] ?? "stop");
    trace("stream.result.completed", {
      stopReason,
      blockCount: content.length,
    });
    if (signal.aborted || stopReason === "aborted") {
      return {
        kind: "model",
        blocks: toProtocolBlocks(content, descriptor.messageId),
        stopReason: "aborted",
      };
    }
    if (stopReason === "error") {
      return modelFailureOutcomeFromMessage(
        String(result["errorMessage"] ?? "model error"),
        request,
        { modelBaseUrl }
      );
    }
    return {
      kind: "model",
      blocks: toProtocolBlocks(content, descriptor.messageId),
      stopReason: "completed",
      usage: (result["usage"] as Record<string, unknown>) ?? undefined,
    };
  },
};

/** Block content is class-INLINE (the fold and step read block structure;
 *  there is no implicit spill), so this emitter must bound it: text and
 *  thinking content larger than this splits into multiple blocks. Margin
 *  below MAX_INLINE_TRAJECTORY_TEXT_BYTES leaves room for envelope framing. */
const MAX_BLOCK_CONTENT_BYTES = 96 * 1024;

/** Split on code-point boundaries so no chunk exceeds maxBytes of UTF-8. */
function splitTextByBytes(text: string, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes) return [text];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of text) {
    const chBytes = encoder.encode(ch).byteLength;
    if (currentBytes + chBytes > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Map pi-ai assistant content to the loop's block shapes: text/thinking
 *  blocks keep their content (split into multiple blocks when oversized —
 *  provider metadata/signatures stay on the first chunk); tool calls become
 *  `toolCall` blocks the step function recognizes (E-model-terminal). */
export function toProtocolBlocks(content: unknown[], messageId: string): unknown[] {
  return content.flatMap((block, index) => {
    if (!block || typeof block !== "object") return [block];
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" || record["type"] === "thinking") {
      const type = record["type"];
      const metadata =
        type === "text"
          ? metadataWithPiReplay(record["metadata"], {
              ...(typeof record["textSignature"] === "string"
                ? { textSignature: record["textSignature"] }
                : {}),
            })
          : metadataWithPiReplay(record["metadata"], {
              ...(typeof record["thinkingSignature"] === "string"
                ? { thinkingSignature: record["thinkingSignature"] }
                : {}),
              ...(typeof record["redacted"] === "boolean" ? { redacted: record["redacted"] } : {}),
            });
      const text =
        type === "text"
          ? String(record["text"] ?? "")
          : String(record["thinking"] ?? record["text"] ?? "");
      return splitTextByBytes(text, MAX_BLOCK_CONTENT_BYTES).map((chunk, chunkIndex) => ({
        type,
        blockId:
          chunkIndex === 0
            ? `${messageId}:block:${index}`
            : `${messageId}:block:${index}:${chunkIndex}`,
        content: chunk,
        ...(chunkIndex === 0 && metadata ? { metadata } : {}),
      }));
    }
    if (record["type"] === "toolCall") {
      const metadata = metadataWithPiReplay(record["metadata"], {
        ...(typeof record["thoughtSignature"] === "string"
          ? { thoughtSignature: record["thoughtSignature"] }
          : {}),
      });
      return [
        {
          type: "toolCall",
          id: String(record["id"] ?? ""),
          name: String(record["name"] ?? ""),
          arguments: record["arguments"],
          ...(metadata ? { metadata } : {}),
        },
      ];
    }
    return [block];
  });
}

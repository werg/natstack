/**
 * TrajectoryVesselBase — Pi-native agent DO base.
 *
 * Embeds `@earendil-works/pi-agent-core`'s `Agent` in-process via `PiRunner`
 * from `@natstack/harness`. One PiRunner per channel, owned by the DO for
 * the lifetime of the chat. The runner drives agent state (messages,
 * streaming, tool calls); durable transcript persistence lives in gad,
 * while this DO only keeps execution-local runner/cache state and forwards
 * runner events to the channel as signals.
 *
 * Composes:
 * - `DOIdentity`: stable DO ref + workerd session id
 * - `SubscriptionManager`: channel membership + replay state
 * - `ChannelClient`: typed wrapper around channel DO RPC
 * - `TurnDispatcher` (one per channel): queues user messages, chooses
 *   runTurn vs steer, self-heals pi-core's steering-queue exit race,
 *   drives the typing indicator from real busy state
 *
 * `PiRunner` writes canonical trajectory events and publishes opaque
 * `agentic.trajectory.v1/event` envelopes for channel consumers.
 *
 * Message dispatch flow (normal turn):
 *   processChannelEvent → refreshRoster → getOrCreateRunner → resizeAttachments
 *     → TurnDispatcher.submit
 *   TurnDispatcher routes to prompt (idle) or steer (mid-run);
 *   typing indicator reflects `running || pending || pendingSteered > 0`.
 */

import {
  DurableObjectBase,
  type DurableObjectContext,
  type DORef,
} from "@workspace/runtime/worker";
import { createExtensionsClient } from "@natstack/extension";
import type {
  Attachment,
  ChannelEvent,
  ParticipantDescriptor,
  TurnInput,
  UnsubscribeResult,
} from "@natstack/harness/types";
import { isClientParticipantType } from "@workspace/pubsub";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  hydrateStoredValueRefs,
} from "@workspace/agentic-protocol";
import {
  PiRunner,
  type PiRunnerOptions,
  type ChannelToolMethod,
  type NatStackScopedUiContext,
  type AskUserParams,
  type ApprovalLevel,
  type ThinkingLevel,
  type SystemPromptMode,
  AgentWorkerError,
  type RunnerEvent,
  type TurnSnapshot,
} from "@natstack/harness";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { getModel as getPiModel, type ImageContent } from "@earendil-works/pi-ai";

import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";
import { ChannelClient } from "./channel-client.js";
import { TurnDispatcher } from "./turn-dispatcher.js";
import {
  createGadServiceClient,
  type DurableObjectServiceClient,
} from "@natstack/shared/userlandServiceRpc";

const SAFE_TOOL_NAMES_DEFAULT: ReadonlySet<string> = new Set(["read", "ls", "grep", "find"]);
const URL_BOUND_MODEL_CREDENTIAL_SENTINEL = "natstack-url-bound-model-credential";
const URL_BOUND_MODEL_CREDENTIAL_SENTINEL_CLAIM =
  "https://natstack.local/url-bound-model-credential";
const IMAGE_SERVICE_EXTENSION = "@workspace-extensions/image-service";
const DEBUG_RING_LIMIT = 80;
const DEBUG_PREVIEW_LIMIT = 240;
const DEBUG_COLLECTION_LIMIT = 16;
const DEBUG_DEPTH_LIMIT = 3;
const MAX_PARTIAL_UPDATES_PER_CALL = 256;
const CLAIM_LOST = Symbol("CLAIM_LOST");
export type RespondPolicy = "all" | "mentioned" | "mentioned-strict" | "from-participants";
type CachedParticipant = Awaited<ReturnType<ChannelClient["getParticipants"]>>[number];
type AgentSettingSource = "state" | "config" | "default";
export type CustomMessageReducer = (state: unknown, update: unknown) => unknown;

function gadBranchIdForChannel(channelId: string): string {
  return `branch:channel:${channelId}`;
}

function isExpectedTestServerFailure(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return (
    String(error).includes("test-server.invalid") || String(cause).includes("test-server.invalid")
  );
}

function isTranscriptShapeError(error: unknown): boolean {
  if (error instanceof Error && error.name === "TranscriptShapeError") return true;
  return /\bMalformed (?:agent|GAD) (?:append|transcript)\b/.test(String(error));
}

function pushBounded<T>(items: T[], item: T, limit = DEBUG_RING_LIMIT): void {
  items.push(item);
  if (items.length > limit) items.splice(0, items.length - limit);
}

function previewDebugText(value: string, limit = DEBUG_PREVIEW_LIMIT): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}

function summarizeDebugValue(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return previewDebugText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    const sample = value
      .slice(0, DEBUG_COLLECTION_LIMIT)
      .map((item) => summarizeDebugValue(item, depth + 1));
    return value.length > sample.length
      ? [...sample, { omittedItems: value.length - sample.length }]
      : sample;
  }
  if (typeof value === "object") {
    if (depth >= DEBUG_DEPTH_LIMIT) return "[object]";
    const entries = Object.entries(value as Record<string, unknown>);
    const sample = entries
      .slice(0, DEBUG_COLLECTION_LIMIT)
      .map(([key, item]) => [key, summarizeDebugValue(item, depth + 1)]);
    const result = Object.fromEntries(sample) as Record<string, unknown>;
    if (entries.length > sample.length) result["omittedKeys"] = entries.length - sample.length;
    return result;
  }
  return String(value);
}

function summarizeDebugRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, summarizeDebugValue(value)])
  );
}

export interface ModelCredentialSummary {
  id: string;
  accountIdentity?: {
    providerUserId?: string;
  };
  metadata?: Record<string, string>;
}

export type ModelCredentialSetupProps = Record<string, unknown>;

interface ModelCredentialOAuthConfig {
  type: "oauth2-auth-code-pkce" | "oauth2-auth-code" | "oauth2-device-code";
  authorizeUrl?: string;
  tokenUrl: string;
  clientId?: string;
  scopes?: string[];
  extraAuthorizeParams?: Record<string, string>;
  allowMissingExpiry?: boolean;
  [key: string]: unknown;
}

interface ModelCredentialApiKeyConfig {
  type: "api-key";
  title?: string;
  description?: string;
  fields: Array<{
    name: string;
    label: string;
    type: "text" | "secret";
    required?: boolean;
    description?: string;
  }>;
  materialTemplate: {
    type: "bearer-token" | "api-key";
    valueTemplate: string;
  };
  accountValidation?: "http-probe" | "none";
}

type ModelCredentialConnectFlow = ModelCredentialOAuthConfig | ModelCredentialApiKeyConfig;

interface ModelCredentialRedirectConfig {
  type?: "loopback" | "public" | "client-forwarded" | "client-loopback";
  host?: string;
  port?: number;
  callbackPath?: string;
  fallback?: "dynamic-port";
}

type ModelCredentialRedirectPolicy = "loopback-required";

interface ConnectModelCredentialOAuthArgs {
  providerId?: unknown;
  browserOpenMode?: unknown;
  browserHandoffCallerId?: unknown;
  browserHandoffCallerKind?: unknown;
  browserHandoffPlatform?: unknown;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return value === "minimal" || value === "low" || value === "medium" || value === "high";
}

function isApprovalLevel(value: unknown): value is ApprovalLevel {
  return value === 0 || value === 1 || value === 2;
}

function isRespondPolicy(value: unknown): value is RespondPolicy {
  return (
    value === "all" ||
    value === "mentioned" ||
    value === "mentioned-strict" ||
    value === "from-participants"
  );
}

const MODEL_CREDENTIAL_REQUIRED_CARD_TSX = `
import { useState } from "react";
import { Box, Button, Callout, Card, Code, Flex, Spinner, Text } from "@radix-ui/themes";

export default function ModelCredentialRequiredCard({ props, chat }) {
  const providerId = props.providerId;
  const modelBaseUrl = props.modelBaseUrl;
  const flow = props.flow;
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  const resolveBrowserHandoffPlatform = () => {
    if (props.browserHandoffPlatform) return props.browserHandoffPlatform;
    if (globalThis.__natstackHostPlatform === "mobile") return "mobile";
    if (typeof navigator !== "undefined" && /\\bNatStack-Mobile\\//.test(navigator.userAgent)) return "mobile";
    return undefined;
  };

  const startOAuth = async (openMode) => {
    if (!flow || !modelBaseUrl) return;
    setStatus("starting");
    setError("");
    try {
      if (!props.agentParticipantId) {
        throw new Error("Missing agent participant for credential setup");
      }
      setStatus("waiting");
      await chat.callMethod(props.agentParticipantId, "connectModelCredential", {
        providerId,
        browserOpenMode: openMode,
        browserHandoffCallerId: props.browserHandoffCallerId,
        browserHandoffCallerKind: props.browserHandoffCallerKind,
        browserHandoffPlatform: resolveBrowserHandoffPlatform(),
      });
      if (props.agentParticipantId) {
        const result = await chat.callMethod(props.agentParticipantId, "credentialConnected", {
          providerId,
          modelBaseUrl,
        });
        if (!result?.resumed) {
          throw new Error("Credential connected, but there was no interrupted turn to continue.");
        }
      }
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  };

  const busy = status === "starting" || status === "waiting" || status === "approval";
  const unsupported = !flow || !modelBaseUrl;

  return (
    <Card variant="surface" size="2">
      <Flex direction="column" gap="3">
        <Box>
          <Text as="div" size="2" weight="medium">Credential required for {providerId}</Text>
          <Text as="div" size="1" color="gray" mt="1">
            Connect a URL-bound model credential for <Code size="1">{modelBaseUrl || providerId}</Code>.
          </Text>
        </Box>
        {unsupported ? (
          <Callout.Root color="amber" size="1">
            <Callout.Text>No built-in OAuth setup is available for this model provider.</Callout.Text>
          </Callout.Root>
        ) : null}
        {status === "done" ? (
          <Callout.Root color="green" size="1">
            <Callout.Text>Credential connected. Continuing...</Callout.Text>
          </Callout.Root>
        ) : null}
        {error ? (
          <Callout.Root color="red" size="1">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        ) : null}
        <Flex gap="2" wrap="wrap">
          <Button size="1" onClick={() => startOAuth("internal")} disabled={busy || unsupported || status === "done"}>
            {busy ? <Spinner size="1" /> : null}
            {status === "done" ? "Connected" : status === "error" ? "Try Again" : "Internal Browser"}
          </Button>
          <Button size="1" variant="soft" onClick={() => startOAuth("external")} disabled={busy || unsupported || status === "done"}>
            External Browser
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}
`.trim();

function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isModelCredentialSentinel(value: string): boolean {
  if (value === URL_BOUND_MODEL_CREDENTIAL_SENTINEL) {
    return true;
  }
  const parts = value.split(".");
  if (parts.length !== 3) {
    return false;
  }
  try {
    const normalized = (parts[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
    return payload[URL_BOUND_MODEL_CREDENTIAL_SENTINEL_CLAIM] === true;
  } catch {
    return false;
  }
}

function credentialRequiredMessage(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  return code === "CREDENTIAL_REQUIRED" ||
    /^No URL-bound model credential is configured for model provider: /.test(message)
    ? message
    : null;
}

function shouldProxyUrlBoundModelFetch(url: URL, baseUrls: readonly string[]): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1")
    return false;
  return baseUrls.some((baseUrl) => isUrlWithinBase(url, baseUrl));
}

interface UrlBoundModelCredentialFetchRoute {
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  debug?: {
    channelId: string;
    record: (phase: string, detail?: Record<string, unknown>) => void;
    error: (scope: string, error: unknown) => void;
  };
}

interface UrlBoundModelFetchProxyState {
  originalFetch: typeof fetch;
  routes: Map<string, UrlBoundModelCredentialFetchRoute>;
}

function findUrlBoundModelFetchProxyRoute(
  url: URL,
  routes: ReadonlyMap<string, UrlBoundModelCredentialFetchRoute>
): { baseUrl: string; route: UrlBoundModelCredentialFetchRoute } | null {
  if (!shouldProxyUrlBoundModelFetch(url, [...routes.keys()])) return null;
  let best: { baseUrl: string; route: UrlBoundModelCredentialFetchRoute } | null = null;
  for (const [baseUrl, route] of routes.entries()) {
    if (!isUrlWithinBase(url, baseUrl)) continue;
    if (!best || baseUrl.length > best.baseUrl.length) {
      best = { baseUrl, route };
    }
  }
  return best;
}

function isModelCredentialOAuthConfig(value: unknown): value is ModelCredentialOAuthConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    (config["type"] === "oauth2-auth-code-pkce" ||
      config["type"] === "oauth2-auth-code" ||
      config["type"] === "oauth2-device-code") &&
    (config["authorizeUrl"] === undefined || typeof config["authorizeUrl"] === "string") &&
    typeof config["tokenUrl"] === "string" &&
    (config["clientId"] === undefined || typeof config["clientId"] === "string") &&
    (config["scopes"] === undefined ||
      (Array.isArray(config["scopes"]) &&
        config["scopes"].every((scope) => typeof scope === "string"))) &&
    (config["extraAuthorizeParams"] === undefined ||
      (!!config["extraAuthorizeParams"] &&
        typeof config["extraAuthorizeParams"] === "object" &&
        Object.values(config["extraAuthorizeParams"]).every(
          (param) => typeof param === "string"
        ))) &&
    (config["allowMissingExpiry"] === undefined ||
      typeof config["allowMissingExpiry"] === "boolean")
  );
}

function isModelCredentialApiKeyConfig(value: unknown): value is ModelCredentialApiKeyConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  const materialTemplate = config["materialTemplate"] as Record<string, unknown> | undefined;
  return (
    config["type"] === "api-key" &&
    Array.isArray(config["fields"]) &&
    config["fields"].every((field) => {
      if (!field || typeof field !== "object") return false;
      const f = field as Record<string, unknown>;
      return (
        typeof f["name"] === "string" &&
        typeof f["label"] === "string" &&
        (f["type"] === "text" || f["type"] === "secret") &&
        (f["required"] === undefined || typeof f["required"] === "boolean")
      );
    }) &&
    !!materialTemplate &&
    (materialTemplate["type"] === "bearer-token" || materialTemplate["type"] === "api-key") &&
    typeof materialTemplate["valueTemplate"] === "string"
  );
}

function isModelCredentialConnectFlow(value: unknown): value is ModelCredentialConnectFlow {
  return isModelCredentialOAuthConfig(value) || isModelCredentialApiKeyConfig(value);
}

function isModelCredentialRedirectConfig(value: unknown): value is ModelCredentialRedirectConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    (config["type"] === undefined ||
      config["type"] === "loopback" ||
      config["type"] === "public" ||
      config["type"] === "client-forwarded" ||
      config["type"] === "client-loopback") &&
    (config["host"] === undefined || typeof config["host"] === "string") &&
    (config["port"] === undefined || typeof config["port"] === "number") &&
    (config["callbackPath"] === undefined || typeof config["callbackPath"] === "string") &&
    (config["fallback"] === undefined || config["fallback"] === "dynamic-port")
  );
}

function isUrlWithinBase(url: URL, rawBaseUrl: string): boolean {
  try {
    const base = new URL(rawBaseUrl);
    if (url.origin !== base.origin) return false;
    const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    return url.pathname === base.pathname || url.pathname.startsWith(basePath);
  } catch {
    return false;
  }
}

function trimTrailingEmptyAbortedAssistant(messages: AgentMessage[]): AgentMessage[] {
  const last = messages[messages.length - 1] as
    | { role?: string; stopReason?: string; content?: unknown }
    | undefined;
  if (!last || last.role !== "assistant" || last.stopReason !== "aborted") {
    return messages;
  }
  const content = Array.isArray(last.content) ? last.content : [];
  const hasVisibleContent = content.some((block) => {
    if (!block || typeof block !== "object") return true;
    if ((block as { type?: string }).type === "text") {
      return Boolean((block as { text?: string }).text);
    }
    if ((block as { type?: string }).type === "thinking") {
      return Boolean((block as { thinking?: string }).thinking);
    }
    return true;
  });
  return hasVisibleContent ? messages : messages.slice(0, -1);
}

function isCredentialRequiredAssistantMessage(message: AgentMessage | undefined): boolean {
  const candidate = message as
    | { role?: string; stopReason?: string; errorMessage?: string }
    | undefined;
  return (
    candidate?.role === "assistant" &&
    candidate.stopReason === "error" &&
    !!credentialRequiredMessage(candidate.errorMessage ?? "")
  );
}

interface RunnerEntry {
  runner: PiRunner;
}

interface MethodResultCompletion {
  result: unknown;
  isError: boolean;
}

interface MethodResultWaiter {
  channelId: string;
  invocationId: string;
  method: string;
  targetParticipantId?: string;
  participantHandle?: string;
  createdAt: number;
  turnId?: string;
  argsSummary?: unknown;
  resolve: (completion: MethodResultCompletion) => void;
  reject: (error: unknown) => void;
}

type MethodSuspensionKind = "channelMethod" | "askUser" | "uiPrompt" | "approval";
type MethodSuspensionTerminalKind = "none" | "completed" | "failed" | "cancelled";
type MethodSuspensionDeliveryStatus =
  | "pending"
  | "delivered_live"
  | "recovering"
  | "transcript_admitted"
  | "recovered"
  | "superseded"
  | "cancelled"
  | "ignored"
  | "stale"
  | "dispatch_failed"
  | "recovery_error";

interface MethodSuspensionRow {
  transportCallId: string;
  channelId: string;
  invocationId: string;
  modelToolCallId: string;
  assistantMessageId: string | null;
  toolCallIndex: number | null;
  toolName: string;
  turnId: string | null;
  kind: MethodSuspensionKind;
  method: string;
  participantHandle: string | null;
  targetParticipantId: string | null;
  argsJson: string | null;
  sessionLeafBeforeCall: string | null;
  terminalKind: MethodSuspensionTerminalKind;
  resultJson: string | null;
  resultIsError: number | null;
  resultEventId: number | null;
  resultReceivedAt: number | null;
  deliveryStatus: MethodSuspensionDeliveryStatus;
  recoveredEntryId: string | null;
  recoveryError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface AgentDebugPhase {
  channelId: string;
  phase: string;
  at: number;
  detail?: Record<string, unknown>;
}

interface AgentDebugChannelEvent {
  channelId: string;
  eventId?: number;
  messageId?: string;
  type: string;
  kind?: string;
  senderId: string;
  mode?: "auto" | "sequential";
  at: number;
}

interface AgentDebugError {
  channelId?: string;
  scope: string;
  at: number;
  message: string;
  name?: string;
}

interface ModelCredentialInterruption {
  providerId: string;
  modelBaseUrl?: string;
  resumeCount: number;
  createdAt: number;
}

type AgentAbortReason = "channel-unsubscribe" | "interrupt-all" | "interrupt-channel";

interface AgentAbortContext {
  reason: AgentAbortReason;
  detail?: string;
  at: number;
}

function abortedAgentEndMessage(event: RunnerEvent): string | null {
  if (event.type !== "agent_end") return null;
  const messages = (event as { messages?: unknown[] }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
  } | null;
  if (!last || last.role !== "assistant" || last.stopReason !== "aborted") return null;
  return last.errorMessage ?? "Turn aborted.";
}

/**
 * Derive a short, human-readable display title from a free-form user message.
 * Strips markdown noise, collapses whitespace, prefers the first sentence,
 * and caps the result around 60 chars.
 */
function deriveFallbackTitleFromMessage(content: string): string | null {
  const stripped = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[#>\-*+\s]+/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  // Prefer the first sentence-ish segment.
  const sentence = stripped.split(/(?<=[.!?])\s|\n/)[0] ?? stripped;
  const candidate = (sentence || stripped).trim();
  if (!candidate) return null;
  const MAX = 60;
  if (candidate.length <= MAX) return candidate;
  return candidate.slice(0, MAX - 1).trimEnd() + "…";
}

export abstract class TrajectoryVesselBase extends DurableObjectBase {
  static override schemaVersion = 14;

  protected identity: DOIdentity;
  protected subscriptions: SubscriptionManager;

  /** One PiRunner per channel — created lazily on first user message. */
  private runners = new Map<string, RunnerEntry>();

  /** Last intentional abort reason per channel, used to annotate pi-core's
   *  generic "Request was aborted" terminal event. */
  private abortContexts = new Map<string, AgentAbortContext>();

  /** Last explicit user stop per channel. Suppresses late dispatch continuations. */
  private lastUserInterruptAt = new Map<string, number>();

  /** Streaming callbacks keyed by invocation id. When an invocation output
   *  arrives before completion, the callback is invoked with the content.
   *  This bridges ctx.stream() from method providers to Pi's onUpdate. */
  private streamCallbacks = new Map<string, (content: unknown) => void>();

  /** Awaiters for canonical invocation completions. Channel methods are
   *  first-class tool suspension points: the Pi tool promise stays pending
   *  until the channel broadcasts the completed result. */
  private methodResultWaiters = new Map<string, MethodResultWaiter>();

  /** Dedup inline credential prompts per channel/provider while this DO is alive. */
  private credentialPromptCardsEmitted = new Set<string>();
  private modelCredentialResolutionAbortControllers = new Map<string, AbortController>();

  /** Channels currently receiving replay envelopes. Replay dispatch stays
   * sequential so recovered turns do not collapse into a single live steer. */
  private channelsInReplay = new Set<string>();

  /** Channels with structurally invalid transcript state. Fail closed and
   *  surface one visible error instead of repeatedly reprocessing the same
   *  malformed history. */
  private transcriptPoisonedChannels = new Map<string, string>();
  private transcriptPoisonNotified = new Set<string>();

  private readonly recentDebugPhases: AgentDebugPhase[] = [];
  private readonly recentChannelEvents: AgentDebugChannelEvent[] = [];
  private readonly lastErrors: AgentDebugError[] = [];
  private readonly recoveryChainByChannel = new Map<string, Promise<void>>();
  private readonly recoveredUiPromptReplies = new Map<
    string,
    Array<{ result: unknown; isError: boolean }>
  >();
  private readonly recoveryDirectAbortControllers = new Map<string, Set<AbortController>>();
  private activationReadyPromise: Promise<void> | null = null;
  private lastActivationTypingCleanup: { at: number; count: number; errors: string[] } | null =
    null;

  /** Phase 0D: Transient poison message tracker. Resets on hibernation. */
  private failedEvents = new Map<number, number>();
  private static readonly POISON_MAX_ATTEMPTS = 3;
  private gad: DurableObjectServiceClient;

  /** Cached contextId for this DO instance — fetched via `runtime.resolveContext`
   *  on first need and reused for every subsequent check. The runtime entity row
   *  is immutable for the lifetime of a DO instance, so caching is safe. */
  private _ownContextId: string | null = null;

  /** Resolve this DO instance's own canonical id (`do:<source>:<class>:<key>`)
   *  from the workerd env bindings + objectKey accessor. */
  private getOwnCanonicalId(): string {
    const source = (this.env as Record<string, string>)["WORKER_SOURCE"];
    const className = (this.env as Record<string, string>)["WORKER_CLASS_NAME"];
    if (!source || !className) {
      throw new Error("getOwnCanonicalId: WORKER_SOURCE / WORKER_CLASS_NAME env bindings missing");
    }
    return `do:${source}:${className}:${this.objectKey}`;
  }

  /** Look up this DO's contextId via `runtime.resolveContext`. Cached after first
   *  successful lookup. Throws if the runtime row cannot be found. */
  private async resolveOwnContextId(): Promise<string> {
    if (this._ownContextId != null) return this._ownContextId;
    const canonicalId = this.getOwnCanonicalId();
    const ctx = await this.rpc.call<string | null>("main", "runtime.resolveContext", [canonicalId]);
    if (ctx == null || ctx === "") {
      throw new Error(`resolveOwnContextId: no runtime entity row for ${canonicalId}`);
    }
    this._ownContextId = ctx;
    return ctx;
  }

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);

    const lazyRpc = {
      call: <T = unknown>(targetId: string, method: string, args: unknown[]): Promise<T> => {
        return this.rpc.call<T>(targetId, method, args);
      },
      streamCall: (
        targetId: string,
        method: string,
        args: unknown[],
        options?: { signal?: AbortSignal }
      ): Promise<Response> => {
        return this.rpc.streamCall(targetId, method, args, options);
      },
    };
    this.gad = createGadServiceClient(lazyRpc);

    this.identity = new DOIdentity(this.sql);
    this.subscriptions = new SubscriptionManager(
      this.sql,
      (channelId) => new ChannelClient(lazyRpc, channelId),
      this.identity
    );
    this.ensureReady();
    this.identity.restore();
  }

  private recordDebugPhase(
    channelId: string,
    phase: string,
    detail?: Record<string, unknown>
  ): void {
    pushBounded(this.recentDebugPhases, {
      channelId,
      phase,
      at: Date.now(),
      ...(detail ? { detail: summarizeDebugRecord(detail) } : {}),
    });
  }

  private recordLastError(scope: string, error: unknown, channelId?: string): void {
    const err = error instanceof Error ? error : new Error(String(error));
    pushBounded(this.lastErrors, {
      ...(channelId ? { channelId } : {}),
      scope,
      at: Date.now(),
      message: err.message,
      name: err.name,
    });
  }

  private recordChannelDebugEvent(
    channelId: string,
    event: ChannelEvent,
    opts?: { mode?: "auto" | "sequential" }
  ): void {
    const agentic = this.agenticEventFromChannelEvent(event);
    pushBounded(this.recentChannelEvents, {
      channelId,
      ...(event.id !== undefined ? { eventId: event.id } : {}),
      ...(event.messageId ? { messageId: event.messageId } : {}),
      type: event.type,
      ...(typeof agentic?.kind === "string" ? { kind: agentic.kind } : {}),
      senderId: event.senderId,
      ...(opts?.mode ? { mode: opts.mode } : {}),
      at: Date.now(),
    });
  }

  private stringifySuspensionJson(value: unknown): string | null {
    if (value === undefined) return null;
    try {
      return JSON.stringify(value);
    } catch {
      return JSON.stringify(summarizeDebugValue(value));
    }
  }

  private parseSuspensionJson(value: string | null): unknown {
    if (value == null) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private recoveredUiPromptKey(channelId: string, invocationId: string): string {
    return `${channelId}\u0000${invocationId}`;
  }

  private enqueueRecoveredUiPromptReply(
    channelId: string,
    invocationId: string,
    result: unknown,
    isError: boolean
  ): void {
    const key = this.recoveredUiPromptKey(channelId, invocationId);
    const replies = this.recoveredUiPromptReplies.get(key) ?? [];
    replies.push({ result, isError });
    this.recoveredUiPromptReplies.set(key, replies);
  }

  private consumeRecoveredUiPromptReply(
    channelId: string,
    invocationId: string
  ): { result: unknown; isError: boolean } | null {
    const key = this.recoveredUiPromptKey(channelId, invocationId);
    const replies = this.recoveredUiPromptReplies.get(key);
    if (!replies || replies.length === 0) return null;
    const reply = replies.shift()!;
    if (replies.length === 0) this.recoveredUiPromptReplies.delete(key);
    return reply;
  }

  private clearRecoveredUiPromptReplies(channelId: string, invocationId: string): void {
    this.recoveredUiPromptReplies.delete(this.recoveredUiPromptKey(channelId, invocationId));
  }

  private trackRecoveryDirectAbort(channelId: string, controller: AbortController): () => void {
    const controllers = this.recoveryDirectAbortControllers.get(channelId) ?? new Set();
    controllers.add(controller);
    this.recoveryDirectAbortControllers.set(channelId, controllers);
    return () => {
      controllers.delete(controller);
      if (controllers.size === 0) this.recoveryDirectAbortControllers.delete(channelId);
    };
  }

  private abortRecoveryDirectExecutions(channelId: string, reason: string): void {
    const controllers = this.recoveryDirectAbortControllers.get(channelId);
    if (!controllers) return;
    for (const controller of controllers) {
      controller.abort(new Error(reason));
    }
    controllers.clear();
    this.recoveryDirectAbortControllers.delete(channelId);
  }

  private methodSuspensionRow(row: Record<string, unknown>): MethodSuspensionRow {
    return {
      transportCallId: row["transport_call_id"] as string,
      channelId: row["channel_id"] as string,
      invocationId: row["invocation_id"] as string,
      modelToolCallId: row["model_tool_call_id"] as string,
      assistantMessageId: (row["assistant_message_id"] as string | null) ?? null,
      toolCallIndex:
        typeof row["tool_call_index"] === "number" ? (row["tool_call_index"] as number) : null,
      toolName: row["tool_name"] as string,
      turnId: (row["turn_id"] as string | null) ?? null,
      kind: row["kind"] as MethodSuspensionKind,
      method: row["method"] as string,
      participantHandle: (row["participant_handle"] as string | null) ?? null,
      targetParticipantId: (row["target_participant_id"] as string | null) ?? null,
      argsJson: (row["args_json"] as string | null) ?? null,
      sessionLeafBeforeCall: (row["session_leaf_before_call"] as string | null) ?? null,
      terminalKind: row["terminal_kind"] as MethodSuspensionTerminalKind,
      resultJson: (row["result_json"] as string | null) ?? null,
      resultIsError:
        typeof row["result_is_error"] === "number" ? (row["result_is_error"] as number) : null,
      resultEventId:
        typeof row["result_event_id"] === "number" ? (row["result_event_id"] as number) : null,
      resultReceivedAt:
        typeof row["result_received_at"] === "number"
          ? (row["result_received_at"] as number)
          : null,
      deliveryStatus: row["delivery_status"] as MethodSuspensionDeliveryStatus,
      recoveredEntryId: (row["recovered_entry_id"] as string | null) ?? null,
      recoveryError: (row["recovery_error"] as string | null) ?? null,
      createdAt: row["created_at"] as number,
      updatedAt: row["updated_at"] as number,
    };
  }

  private loadMethodSuspension(callId: string): MethodSuspensionRow | null {
    const rows = this.sql
      .exec(`SELECT * FROM agent_method_suspensions WHERE transport_call_id = ?`, callId)
      .toArray();
    return rows.length > 0 ? this.methodSuspensionRow(rows[0]!) : null;
  }

  private async recordMethodSuspension(opts: {
    channelId: string;
    transportCallId: string;
    invocationId: string;
    kind: MethodSuspensionKind;
    method: string;
    participantHandle?: string;
    targetParticipantId?: string;
    args?: unknown;
    turnId?: string;
    fallbackToolName?: string;
    requireOpenInvocation?: boolean;
  }): Promise<boolean> {
    const runner = this.runners.get(opts.channelId)?.runner;
    const open =
      runner && typeof runner.getOpenInvocation === "function"
        ? runner.getOpenInvocation(opts.invocationId)
        : undefined;
    if (opts.requireOpenInvocation && !open) {
      this.recordDebugPhase(
        opts.channelId,
        "channel_method.suspension.skipped_no_open_invocation",
        {
          invocationId: opts.invocationId,
          transportCallId: opts.transportCallId,
          kind: opts.kind,
        }
      );
      return false;
    }
    let sessionLeafBeforeCall: string | null = null;
    try {
      sessionLeafBeforeCall = (await runner?.session?.getLeafId()) ?? null;
    } catch (err) {
      this.recordLastError("channel_method.suspension.leaf", err, opts.channelId);
    }
    const now = Date.now();
    this.sql.exec(
      `INSERT OR REPLACE INTO agent_method_suspensions (
         transport_call_id, channel_id, invocation_id, model_tool_call_id,
         assistant_message_id, tool_call_index, tool_name, turn_id, kind, method,
         participant_handle, target_participant_id, args_json, session_leaf_before_call,
         terminal_kind, delivery_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 'pending', ?, ?)`,
      opts.transportCallId,
      opts.channelId,
      opts.invocationId,
      open?.modelToolCallId ?? opts.invocationId,
      open?.messageId ?? null,
      open?.blockIndex ?? null,
      open?.name ?? opts.fallbackToolName ?? opts.method,
      opts.turnId ?? open?.turnId ?? null,
      opts.kind,
      opts.method,
      opts.participantHandle ?? null,
      opts.targetParticipantId ?? null,
      this.stringifySuspensionJson(opts.args),
      sessionLeafBeforeCall,
      now,
      now
    );
    return true;
  }

  private appendMethodSuspensionUpdate(callId: string, content: unknown): void {
    const row = this.loadMethodSuspension(callId);
    if (!row) return;
    const seqRow = this.sql
      .exec(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
           FROM agent_method_suspension_updates
           WHERE transport_call_id = ?`,
        callId
      )
      .one();
    const seq = seqRow["next_seq"] as number;
    this.sql.exec(
      `INSERT INTO agent_method_suspension_updates
         (transport_call_id, seq, content_json, received_at)
       VALUES (?, ?, ?, ?)`,
      callId,
      seq,
      this.stringifySuspensionJson(content) ?? "null",
      Date.now()
    );
    this.sql.exec(
      `DELETE FROM agent_method_suspension_updates
         WHERE transport_call_id = ?
           AND seq <= ? - ?`,
      callId,
      seq,
      MAX_PARTIAL_UPDATES_PER_CALL
    );
  }

  private deletePartials(callId: string): void {
    this.sql.exec(
      `DELETE FROM agent_method_suspension_updates WHERE transport_call_id = ?`,
      callId
    );
  }

  private deletePartialsForInvocation(channelId: string, invocationId: string): void {
    this.sql.exec(
      `DELETE FROM agent_method_suspension_updates
         WHERE transport_call_id IN (
           SELECT transport_call_id FROM agent_method_suspensions
           WHERE channel_id = ? AND invocation_id = ?
         )`,
      channelId,
      invocationId
    );
  }

  private markMethodSuspensionTerminal(
    callId: string,
    opts: {
      terminalKind: Exclude<MethodSuspensionTerminalKind, "none">;
      result: unknown;
      isError: boolean;
      eventId?: number;
      waiterPresent: boolean;
    }
  ): void {
    this.sql.exec(
      `UPDATE agent_method_suspensions
         SET terminal_kind = CASE WHEN terminal_kind = 'none' THEN ? ELSE terminal_kind END,
             result_json = CASE WHEN terminal_kind = 'none' THEN ? ELSE result_json END,
             result_is_error = CASE WHEN terminal_kind = 'none' THEN ? ELSE result_is_error END,
             result_event_id = CASE WHEN terminal_kind = 'none' THEN ? ELSE result_event_id END,
             result_received_at = CASE WHEN terminal_kind = 'none' THEN ? ELSE result_received_at END,
             delivery_status = CASE
               WHEN terminal_kind = 'none' AND delivery_status = 'pending' AND ? = 1
                 THEN 'delivered_live'
               ELSE delivery_status
             END,
             updated_at = ?
         WHERE transport_call_id = ?`,
      opts.terminalKind,
      this.stringifySuspensionJson(opts.result),
      opts.isError ? 1 : 0,
      opts.eventId ?? null,
      Date.now(),
      opts.waiterPresent ? 1 : 0,
      Date.now(),
      callId
    );
  }

  private markMethodSuspensionDispatchFailed(callId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    this.sql.exec(
      `UPDATE agent_method_suspensions
         SET terminal_kind = 'failed',
             result_json = ?,
             result_is_error = 1,
             result_received_at = ?,
             delivery_status = 'dispatch_failed',
             recovery_error = ?,
             updated_at = ?
         WHERE transport_call_id = ?
           AND terminal_kind = 'none'
           AND delivery_status = 'pending'`,
      this.stringifySuspensionJson({ error: message }),
      now,
      `dispatch_failed: ${message}`,
      now,
      callId
    );
  }

  private cancelMethodSuspension(callId: string, reason: string): void {
    const now = Date.now();
    const cancelled = this.sql
      .exec(
        `UPDATE agent_method_suspensions
         SET terminal_kind = 'cancelled',
             result_json = ?,
             result_is_error = 1,
             result_received_at = ?,
             delivery_status = 'cancelled',
             recovery_error = ?,
             updated_at = ?
         WHERE transport_call_id = ?
           AND terminal_kind = 'none'
           AND delivery_status = 'pending'
         RETURNING transport_call_id`,
        this.stringifySuspensionJson({ reason }),
        now,
        reason,
        now,
        callId
      )
      .toArray();
    if (cancelled.length > 0) this.deletePartials(callId);
  }

  private cancelMethodSuspensionsForChannel(channelId: string, reason: string): string[] {
    const rows = this.sql
      .exec(
        `SELECT transport_call_id FROM agent_method_suspensions
           WHERE channel_id = ?
             AND delivery_status IN ('pending', 'delivered_live', 'recovering')`,
        channelId
      )
      .toArray();
    const callIds = rows.map((row) => row["transport_call_id"] as string);
    if (callIds.length === 0) return [];
    const now = Date.now();
    this.sql.exec(
      `UPDATE agent_method_suspensions
         SET terminal_kind = 'cancelled',
             result_json = ?,
             result_is_error = 1,
             result_received_at = ?,
             delivery_status = 'cancelled',
             recovery_error = ?,
             updated_at = ?
         WHERE channel_id = ?
           AND delivery_status IN ('pending', 'delivered_live', 'recovering')`,
      this.stringifySuspensionJson({ reason }),
      now,
      reason,
      now,
      channelId
    );
    for (const callId of callIds) this.deletePartials(callId);
    return callIds;
  }

  private markMethodSuspensionIgnored(callId: string, lateResult?: unknown): void {
    const now = Date.now();
    this.sql.exec(
      `UPDATE agent_method_suspensions
         SET delivery_status = 'ignored',
             recovery_error = ?,
             updated_at = ?
         WHERE transport_call_id = ?
           AND delivery_status IN ('cancelled', 'ignored', 'dispatch_failed')`,
      lateResult === undefined
        ? "late terminal ignored"
        : `late terminal ignored: ${JSON.stringify(summarizeDebugValue(lateResult))}`,
      now,
      callId
    );
    this.deletePartials(callId);
  }

  private recordIfSuspensionStillPending(channelId: string, callId: string): void {
    const row = this.loadMethodSuspension(callId);
    if (!row || row.deliveryStatus !== "pending") return;
    this.recordDebugPhase(channelId, "channel_method.suspension.still_pending_after_waiter", {
      callId,
      invocationId: row.invocationId,
      terminalKind: row.terminalKind,
    });
  }

  private pickChosenSuspension(rows: MethodSuspensionRow[]): MethodSuspensionRow | null {
    const terminalRows = rows.filter((row) => row.terminalKind !== "none");
    if (terminalRows.length === 0) return null;
    const pendingModelVisible = rows.some(
      (row) =>
        (row.kind === "channelMethod" || row.kind === "askUser") && row.terminalKind === "none"
    );
    if (pendingModelVisible) return null;
    const priority = (row: MethodSuspensionRow) =>
      row.kind === "channelMethod" || row.kind === "askUser" ? 0 : 1;
    return (
      terminalRows.sort((a, b) => {
        const priorityDiff = priority(a) - priority(b);
        if (priorityDiff !== 0) return priorityDiff;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        if ((a.resultEventId ?? 0) !== (b.resultEventId ?? 0)) {
          return (a.resultEventId ?? 0) - (b.resultEventId ?? 0);
        }
        return a.transportCallId.localeCompare(b.transportCallId);
      })[0] ?? null
    );
  }

  private sortChosenSuspensions(rows: MethodSuspensionRow[]): MethodSuspensionRow[] {
    return rows.sort((a, b) => {
      const messageDiff = (a.assistantMessageId ?? "").localeCompare(b.assistantMessageId ?? "");
      if (messageDiff !== 0) return messageDiff;
      if (
        (a.toolCallIndex ?? Number.MAX_SAFE_INTEGER) !==
        (b.toolCallIndex ?? Number.MAX_SAFE_INTEGER)
      ) {
        return (
          (a.toolCallIndex ?? Number.MAX_SAFE_INTEGER) -
          (b.toolCallIndex ?? Number.MAX_SAFE_INTEGER)
        );
      }
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      if ((a.resultEventId ?? 0) !== (b.resultEventId ?? 0)) {
        return (a.resultEventId ?? 0) - (b.resultEventId ?? 0);
      }
      return a.transportCallId.localeCompare(b.transportCallId);
    });
  }

  private claimGroupForRecovery(
    channelId: string,
    invocationId: string,
    chosenCallId: string
  ): boolean {
    try {
      this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        const won = this.sql
          .exec(
            `UPDATE agent_method_suspensions
               SET delivery_status = 'recovering', updated_at = ?
               WHERE transport_call_id = ?
                 AND delivery_status IN ('pending', 'delivered_live')
               RETURNING transport_call_id`,
            now,
            chosenCallId
          )
          .toArray();
        if (won.length !== 1) throw CLAIM_LOST;
        this.sql.exec(
          `UPDATE agent_method_suspensions
             SET delivery_status = 'superseded', updated_at = ?
             WHERE channel_id = ?
               AND invocation_id = ?
               AND transport_call_id != ?
               AND delivery_status IN ('pending', 'delivered_live')`,
          now,
          channelId,
          invocationId,
          chosenCallId
        );
      });
      return true;
    } catch (err) {
      if (err === CLAIM_LOST) return false;
      throw err;
    }
  }

  private markRecovered(callId: string, entryId: string): void {
    this.sql.exec(
      `UPDATE agent_method_suspensions
         SET delivery_status = 'recovered',
             recovered_entry_id = ?,
             updated_at = ?
         WHERE transport_call_id = ? AND delivery_status = 'recovering'`,
      entryId,
      Date.now(),
      callId
    );
  }

  private markResumeInternalSuspensionsSuperseded(
    channelId: string,
    invocationId: string,
    chosenCallId: string
  ): void {
    this.sql.exec(
      `UPDATE agent_method_suspensions
         SET delivery_status = 'superseded',
             updated_at = ?
         WHERE channel_id = ?
           AND invocation_id = ?
           AND transport_call_id != ?
           AND delivery_status IN ('pending', 'delivered_live')`,
      Date.now(),
      channelId,
      invocationId,
      chosenCallId
    );
  }

  private markStale(callId: string, reason: string): void {
    this.sql.exec(
      `UPDATE agent_method_suspensions
         SET delivery_status = 'stale',
             recovery_error = ?,
             updated_at = ?
         WHERE transport_call_id = ? AND delivery_status = 'recovering'`,
      reason,
      Date.now(),
      callId
    );
    this.deletePartials(callId);
  }

  private markRecoveryError(callId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.sql.exec(
      `UPDATE agent_method_suspensions
         SET delivery_status = 'recovery_error',
             recovery_error = ?,
             updated_at = ?
         WHERE transport_call_id = ? AND delivery_status = 'recovering'`,
      message,
      Date.now(),
      callId
    );
  }

  private extractResumeToolInput(row: MethodSuspensionRow): unknown {
    const args = this.parseSuspensionJson(row.argsJson);
    if (args && typeof args === "object" && "resumeToolInput" in args) {
      return (args as { resumeToolInput?: unknown }).resumeToolInput ?? {};
    }
    return {};
  }

  private enqueueRecoveredUiPromptRepliesForInvocation(
    channelId: string,
    invocationId: string
  ): void {
    const rows = this.sql
      .exec(
        `SELECT * FROM agent_method_suspensions
           WHERE channel_id = ?
             AND invocation_id = ?
             AND kind = 'uiPrompt'
             AND terminal_kind != 'none'
           ORDER BY created_at, COALESCE(result_event_id, 0), transport_call_id`,
        channelId,
        invocationId
      )
      .toArray()
      .map((row) => this.methodSuspensionRow(row));
    for (const row of rows) {
      this.enqueueRecoveredUiPromptReply(
        channelId,
        invocationId,
        this.parseSuspensionJson(row.resultJson),
        row.resultIsError === 1
      );
    }
  }

  private composePromptRecoveryError(row: MethodSuspensionRow, result: unknown): AgentMessage {
    const text =
      row.resultIsError === 1
        ? resultToAnswerText(result)
        : row.kind === "approval"
          ? "User denied tool call"
          : "Tool execution was interrupted by hibernation before completion; please retry.";
    return {
      role: "toolResult",
      toolCallId: row.invocationId,
      toolName: row.toolName,
      content: [{ type: "text", text }],
      isError: true,
    } as AgentMessage;
  }

  private toolResultMessageFromDirectResult(
    row: MethodSuspensionRow,
    result: AgentToolResult<any>
  ): AgentMessage {
    return {
      role: "toolResult",
      toolCallId: row.invocationId,
      toolName: row.toolName,
      ...result,
    } as AgentMessage;
  }

  private toolResultMessageFromDirectError(row: MethodSuspensionRow, err: unknown): AgentMessage {
    return {
      role: "toolResult",
      toolCallId: row.invocationId,
      toolName: row.toolName,
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    } as AgentMessage;
  }

  private async composeRecoveredToolResult(
    channelId: string,
    runner: PiRunner,
    row: MethodSuspensionRow
  ): Promise<AgentMessage> {
    const result = await this.hydrateStoredTransportValue(this.parseSuspensionJson(row.resultJson));
    if (row.kind === "channelMethod") {
      const toolResult =
        row.resultIsError === 1 ? methodErrorResult(result) : toAgentToolResult(result);
      return {
        role: "toolResult",
        toolCallId: row.invocationId,
        toolName: row.toolName,
        ...toolResult,
      } as AgentMessage;
    }
    if (row.kind === "askUser") {
      return {
        role: "toolResult",
        toolCallId: row.invocationId,
        toolName: row.toolName,
        content: [{ type: "text", text: resultToAnswerText(result) }],
        isError: row.resultIsError === 1,
      } as AgentMessage;
    }

    if (row.kind === "approval") {
      if (row.resultIsError === 1 || result !== true) {
        return this.composePromptRecoveryError(row, result);
      }
    } else if (row.resultIsError === 1) {
      return this.composePromptRecoveryError(row, result);
    }

    this.enqueueRecoveredUiPromptRepliesForInvocation(channelId, row.invocationId);
    const controller = new AbortController();
    const untrack = this.trackRecoveryDirectAbort(channelId, controller);
    try {
      const directResult = await runner.executeToolDirect(
        row.toolName,
        row.invocationId,
        this.extractResumeToolInput(row),
        controller.signal
      );
      return this.toolResultMessageFromDirectResult(row, directResult);
    } catch (err) {
      return this.toolResultMessageFromDirectError(row, err);
    } finally {
      untrack();
      this.clearRecoveredUiPromptReplies(channelId, row.invocationId);
    }
  }

  private async preflightRecoveredSuspension(
    runner: PiRunner,
    row: MethodSuspensionRow
  ): Promise<string | null> {
    if (
      !runner.isInvocationOpen(row.invocationId) &&
      (await runner.hasToolResult(row.invocationId))
    ) {
      return "invocation closed";
    }
    if (row.sessionLeafBeforeCall) {
      const onActiveBranch = await runner.isLeafDescendantOf(row.sessionLeafBeforeCall);
      if (!onActiveBranch) return "session branch moved";
    }
    return null;
  }

  private runOnChannelRecoveryChain(channelId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.recoveryChainByChannel.get(channelId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.recoveryChainByChannel.set(channelId, next);
    return next;
  }

  private async recoverDeliveredAndOrphanedSuspensions(channelId: string): Promise<void> {
    if (this.transcriptPoisonedChannels.has(channelId)) {
      this.recordDebugPhase(channelId, "channel_method.recovery.skipped_poisoned");
      return;
    }
    const invocationRows = this.sql
      .exec(
        `SELECT DISTINCT invocation_id
           FROM agent_method_suspensions
           WHERE channel_id = ?
             AND terminal_kind != 'none'
             AND delivery_status IN ('pending', 'delivered_live')`,
        channelId
      )
      .toArray();
    const invocationIds = invocationRows
      .map((row) => row["invocation_id"])
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (invocationIds.length === 0) return;

    const placeholders = invocationIds.map(() => "?").join(", ");
    const rows = this.sql
      .exec(
        `SELECT * FROM agent_method_suspensions
           WHERE channel_id = ?
             AND invocation_id IN (${placeholders})
             AND delivery_status IN ('pending', 'delivered_live')`,
        channelId,
        ...invocationIds
      )
      .toArray()
      .map((row) => this.methodSuspensionRow(row));

    const grouped = new Map<string, MethodSuspensionRow[]>();
    for (const row of rows) {
      const group = grouped.get(row.invocationId) ?? [];
      group.push(row);
      grouped.set(row.invocationId, group);
    }

    const chosen = this.sortChosenSuspensions(
      [...grouped.values()]
        .map((group) => this.pickChosenSuspension(group))
        .filter((row): row is MethodSuspensionRow => row !== null)
    );
    if (chosen.length === 0) return;

    const runner = await this.getOrCreateRunner(channelId);
    let admitted = 0;
    for (const row of chosen) {
      if (!this.claimGroupForRecovery(channelId, row.invocationId, row.transportCallId)) continue;
      const staleReason = await this.preflightRecoveredSuspension(runner, row);
      if (staleReason) {
        this.markStale(row.transportCallId, staleReason);
        this.recordDebugPhase(channelId, "channel_method.recovery.stale", {
          callId: row.transportCallId,
          invocationId: row.invocationId,
          reason: staleReason,
        });
        continue;
      }
      try {
        const entryId = await runner.appendToolResult(
          await this.composeRecoveredToolResult(channelId, runner, row)
        );
        this.markResumeInternalSuspensionsSuperseded(
          channelId,
          row.invocationId,
          row.transportCallId
        );
        this.markRecovered(row.transportCallId, entryId);
        this.deletePartialsForInvocation(channelId, row.invocationId);
        admitted++;
      } catch (err) {
        this.markRecoveryError(row.transportCallId, err);
        this.recordDebugPhase(channelId, "channel_method.recovery.append_failed", {
          callId: row.transportCallId,
          invocationId: row.invocationId,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }
    if (admitted > 0) {
      this.submitRecoveryContinue(channelId, runner, "method_suspension_recovered");
    }
  }

  private async sweepStuckDelivery(channelId: string, runner: PiRunner): Promise<void> {
    const rows = this.sql
      .exec(
        `SELECT * FROM agent_method_suspensions
           WHERE channel_id = ? AND delivery_status IN ('delivered_live', 'recovering')`,
        channelId
      )
      .toArray()
      .map((row) => this.methodSuspensionRow(row));
    const grouped = new Map<string, MethodSuspensionRow[]>();
    for (const row of rows) {
      const group = grouped.get(row.invocationId) ?? [];
      group.push(row);
      grouped.set(row.invocationId, group);
    }
    for (const [invocationId, group] of grouped.entries()) {
      if (runner.isInvocationOpen(invocationId)) {
        for (const row of group) {
          this.sql.exec(
            `UPDATE agent_method_suspensions
               SET delivery_status = 'delivered_live',
                   recovery_error = NULL,
                   updated_at = ?
               WHERE transport_call_id = ?
                 AND delivery_status IN ('delivered_live', 'recovering')`,
            Date.now(),
            row.transportCallId
          );
        }
        continue;
      }
      const hasToolResult = await runner.hasToolResult(invocationId);
      if (!hasToolResult) {
        for (const row of group) {
          this.sql.exec(
            `UPDATE agent_method_suspensions
               SET delivery_status = 'delivered_live',
                   recovery_error = NULL,
                   updated_at = ?
               WHERE transport_call_id = ?
                 AND delivery_status IN ('delivered_live', 'recovering')`,
            Date.now(),
            row.transportCallId
          );
        }
        continue;
      }
      const shouldContinue = await runner.isCurrentLeafToolResult(invocationId);

      const chosen = this.pickChosenSuspension(group);
      if (!chosen) continue;
      const now = Date.now();
      for (const row of group) {
        const nextStatus =
          row.transportCallId === chosen.transportCallId
            ? row.deliveryStatus === "recovering"
              ? "recovered"
              : "transcript_admitted"
            : "superseded";
        this.sql.exec(
          `UPDATE agent_method_suspensions
             SET delivery_status = ?, updated_at = ?
             WHERE transport_call_id = ?
               AND delivery_status IN ('delivered_live', 'recovering')`,
          nextStatus,
          now,
          row.transportCallId
        );
      }
      this.deletePartialsForInvocation(channelId, invocationId);
      if (shouldContinue) {
        this.markRecoveryContinuePending(channelId, "method_suspension_recovered");
      }
    }
  }

  private markLiveToolResultAdmitted(channelId: string, message: AgentMessage): void {
    const invocationId = (message as { toolCallId?: unknown }).toolCallId;
    if (typeof invocationId !== "string" || invocationId.length === 0) return;
    const settled = this.ctx.storage.transactionSync(() => {
      const rows = this.sql
        .exec(
          `SELECT * FROM agent_method_suspensions
             WHERE channel_id = ?
               AND invocation_id = ?
               AND delivery_status = 'delivered_live'`,
          channelId,
          invocationId
        )
        .toArray()
        .map((row) => this.methodSuspensionRow(row));
      // Hot-path admission only sees delivered_live rows. Those rows have
      // already received a terminal event, so pending higher-priority siblings
      // are intentionally outside this transaction.
      const chosen = this.pickChosenSuspension(rows);
      if (!chosen) return false;
      const now = Date.now();
      this.sql.exec(
        `UPDATE agent_method_suspensions
           SET delivery_status = 'transcript_admitted', updated_at = ?
           WHERE transport_call_id = ?
             AND delivery_status = 'delivered_live'`,
        now,
        chosen.transportCallId
      );
      this.sql.exec(
        `UPDATE agent_method_suspensions
           SET delivery_status = 'superseded', updated_at = ?
           WHERE channel_id = ?
             AND invocation_id = ?
             AND transport_call_id != ?
             AND delivery_status = 'delivered_live'`,
        now,
        channelId,
        invocationId,
        chosen.transportCallId
      );
      return true;
    });
    if (settled) this.deletePartialsForInvocation(channelId, invocationId);
  }

  private markRecoveryContinuePending(channelId: string, reason: string): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO agent_recovery_continuations (channel_id, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at`,
      channelId,
      reason,
      now,
      now
    );
  }

  private clearRecoveryContinuePending(channelId: string): void {
    this.sql.exec(`DELETE FROM agent_recovery_continuations WHERE channel_id = ?`, channelId);
  }

  private hasRecoveryContinuePending(channelId: string): boolean {
    return (
      this.sql
        .exec(`SELECT channel_id FROM agent_recovery_continuations WHERE channel_id = ?`, channelId)
        .toArray().length > 0
    );
  }

  private submitRecoveryContinue(channelId: string, runner: PiRunner, reason: string): void {
    this.markRecoveryContinuePending(channelId, reason);
    this.getOrCreateDispatcher(channelId, runner).submitContinue();
  }

  private replayPendingRecoveryContinue(channelId: string, runner: PiRunner): void {
    if (!this.hasRecoveryContinuePending(channelId)) return;
    this.getOrCreateDispatcher(channelId, runner).submitContinue();
  }

  private async ensureAgentActivationReady(): Promise<void> {
    if (!this.activationReadyPromise) {
      this.activationReadyPromise = this.runAgentActivationOnce().catch((err) => {
        this.recordLastError("activation", err);
        this.activationReadyPromise = null;
        throw err;
      });
    }
    return this.activationReadyPromise;
  }

  private async runAgentActivationOnce(): Promise<void> {
    await this.clearStaleTypingForPersistedSubscriptions();
  }

  private async clearStaleTypingForPersistedSubscriptions(): Promise<void> {
    const rows = this.subscriptions.listAll();
    let cleared = 0;
    const errors: string[] = [];
    for (const { channelId, participantId } of rows) {
      if (!participantId) continue;
      const dispatcherState = this.dispatchers.get(channelId)?.getDebugState() as
        | { busy?: boolean }
        | undefined;
      if (dispatcherState?.busy) continue;
      try {
        await this.createChannelClient(channelId).setTypingState(participantId, false);
        cleared++;
      } catch (err) {
        errors.push(`${channelId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.lastActivationTypingCleanup = { at: Date.now(), count: cleared, errors };
    this.recordDebugPhase("activation", "activation.typing_cleared", {
      count: cleared,
      errors,
    });
  }

  protected createTables(): void {
    this.identity.createTables();
    this.subscriptions.createTables();
    // Delivery cursor for event dedup + gap repair.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS delivery_cursor (
        channel_id TEXT PRIMARY KEY,
        last_delivered_seq INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS model_credential_interruptions (
        channel_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_base_url TEXT,
        resume_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, provider_id)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_method_suspensions (
        transport_call_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        model_tool_call_id TEXT NOT NULL,
        assistant_message_id TEXT,
        tool_call_index INTEGER,
        tool_name TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        method TEXT NOT NULL,
        participant_handle TEXT,
        target_participant_id TEXT,
        args_json TEXT,
        session_leaf_before_call TEXT,
        terminal_kind TEXT NOT NULL DEFAULT 'none',
        result_json TEXT,
        result_is_error INTEGER,
        result_event_id INTEGER,
        result_received_at INTEGER,
        delivery_status TEXT NOT NULL DEFAULT 'pending',
        recovered_entry_id TEXT,
        recovery_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_suspensions_channel_delivery
        ON agent_method_suspensions(channel_id, delivery_status, assistant_message_id, tool_call_index, created_at)
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_suspensions_invocation
        ON agent_method_suspensions(invocation_id)
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_method_suspension_updates (
        transport_call_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (transport_call_id, seq)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_recovery_continuations (
        channel_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  // ── Identity bootstrap ──────────────────────────────────────────────────

  private _bootstrapped = false;

  private ensureBootstrapped(): void {
    if (this._bootstrapped) return;
    try {
      const key = this.objectKey;
      const source = (this.env as Record<string, string>)["WORKER_SOURCE"];
      const className = (this.env as Record<string, string>)["WORKER_CLASS_NAME"];
      const sessionId = (this.env as Record<string, string>)["WORKERD_SESSION_ID"];
      if (source && className && sessionId) {
        const doRef: DORef = { source, className, objectKey: key };
        this.identity.bootstrap(doRef, sessionId);
        this._bootstrapped = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("objectKey not available")) {
        console.error("[TrajectoryVesselBase] ensureBootstrapped failed:", err);
      }
    }
  }

  protected get doRef(): DORef {
    return this.identity.ref;
  }

  protected createChannelClient(channelId: string): ChannelClient {
    return new ChannelClient(this.rpc, channelId);
  }

  // ── Customization hooks (Pi-native) ─────────────────────────────────────

  /**
   * Model id in `provider:model` format (e.g. `openai-codex:gpt-5.5`).
   * Concrete agent workers must pick their own model.
   * PiRunner passes this directly to `pi-ai.getModel(provider, modelId)`.
   */
  protected getDefaultModel(): string {
    throw new AgentWorkerError(
      "invalid_state",
      "TrajectoryVesselBase subclasses must override getDefaultModel()"
    );
  }

  protected getDefaultThinkingLevel(): ThinkingLevel {
    return "medium";
  }

  protected getDefaultApprovalLevel(): ApprovalLevel {
    return 2;
  }

  protected getDefaultRespondPolicy(): RespondPolicy {
    return "all";
  }

  protected getDefaultRespondFrom(): string[] {
    return [];
  }

  protected getModel(channelId: string): string {
    const config = this.subscriptions.getConfig(channelId);
    return typeof config?.model === "string" && config.model.length > 0
      ? config.model
      : this.getDefaultModel();
  }

  protected getThinkingLevel(channelId: string): ThinkingLevel {
    const stateValue = this.getStateValue(`thinkingLevel:${channelId}`);
    if (isThinkingLevel(stateValue)) return stateValue;
    const config = this.subscriptions.getConfig(channelId);
    return isThinkingLevel(config?.thinkingLevel)
      ? config.thinkingLevel
      : this.getDefaultThinkingLevel();
  }

  protected setThinkingLevel(channelId: string, level: ThinkingLevel): void {
    this.setStateValue(`thinkingLevel:${channelId}`, level);
  }

  protected getModelProviderId(channelId: string): string {
    const model = this.getModel(channelId);
    const colonIdx = model.indexOf(":");
    return colonIdx >= 0 ? model.slice(0, colonIdx) : model;
  }

  protected getApiKeyForChannel(channelId: string): () => Promise<string> {
    const providerId = this.getModelProviderId(channelId);
    return async () => {
      const modelBaseUrl = this.getModelBaseUrl(channelId);
      this.recordDebugPhase(channelId, "model_credential.resolve.start", {
        providerId,
        modelBaseUrl,
      });
      this.installUrlBoundModelFetchProxy(channelId, modelBaseUrl);
      const signal = this.getModelCredentialResolutionSignal(channelId);
      let credential: ModelCredentialSummary | null;
      try {
        credential = await this.rpc.call<ModelCredentialSummary | null>(
          "main",
          "credentials.resolveCredential",
          [{ url: modelBaseUrl }],
          { signal }
        );
      } catch (err) {
        this.recordLastError("model_credential.resolve", err, channelId);
        this.recordDebugPhase(channelId, "model_credential.resolve.error", {
          providerId,
          modelBaseUrl,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        const controller = this.modelCredentialResolutionAbortControllers.get(channelId);
        if (controller?.signal === signal) {
          this.modelCredentialResolutionAbortControllers.delete(channelId);
        }
      }
      if (!credential) {
        this.recordDebugPhase(channelId, "model_credential.resolve.missing", {
          providerId,
          modelBaseUrl,
        });
        this.queueModelCredentialInterruptionRecord(channelId, providerId, modelBaseUrl);
        this.emitModelCredentialRequiredCard(channelId, providerId, modelBaseUrl);
        throw new AgentWorkerError(
          "auth",
          `No URL-bound model credential is configured for model provider: ${providerId}`
        );
      }
      this.recordDebugPhase(channelId, "model_credential.resolve.ok", {
        providerId,
        modelBaseUrl,
        credentialId: credential.id,
        accountIdentity: credential.accountIdentity ?? null,
        metadata: credential.metadata ?? {},
      });
      return this.createModelCredentialSentinel(providerId, credential);
    };
  }

  private getModelCredentialResolutionSignal(channelId: string): AbortSignal {
    let controller = this.modelCredentialResolutionAbortControllers.get(channelId);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      this.modelCredentialResolutionAbortControllers.set(channelId, controller);
    }
    return controller.signal;
  }

  private abortModelCredentialResolution(channelId: string, reason: string): void {
    const controller = this.modelCredentialResolutionAbortControllers.get(channelId);
    if (!controller || controller.signal.aborted) return;
    controller.abort(new Error(reason));
    this.modelCredentialResolutionAbortControllers.delete(channelId);
  }

  protected getModelCredentialSetupProps(_providerId: string): ModelCredentialSetupProps | null {
    return null;
  }

  protected getModelCredentialTokenClaims(
    _providerId: string,
    _credential: ModelCredentialSummary
  ): Record<string, unknown> {
    return {};
  }

  protected async handleModelCredentialMethodCall(
    channelId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean } | null> {
    switch (methodName) {
      case "connectModelCredential":
        return {
          result: await this.connectModelCredential(
            channelId,
            args as ConnectModelCredentialOAuthArgs
          ),
        };
      default:
        return null;
    }
  }

  private getModelCredentialConnectSpec(
    channelId: string,
    providerId: string
  ): {
    flow: ModelCredentialConnectFlow;
    redirect?: ModelCredentialRedirectConfig;
    clientLoopbackRedirect?: ModelCredentialRedirectConfig;
    redirectPolicy?: ModelCredentialRedirectPolicy;
    credential?: Record<string, unknown>;
    credentialLabel: string;
    accountIdentityJwtClaimRoot: string;
    accountIdentityJwtClaimField: string;
  } {
    if (providerId !== this.getModelProviderId(channelId)) {
      throw new Error(`Model credential provider mismatch: ${providerId}`);
    }
    const setup = this.getModelCredentialSetupProps(providerId);
    const flow = setup?.["flow"];
    if (!isModelCredentialConnectFlow(flow)) {
      throw new Error(`No credential setup is available for model provider: ${providerId}`);
    }
    const credentialLabel = setup?.["credentialLabel"];
    const redirect = setup?.["redirect"];
    const clientLoopbackRedirect = setup?.["clientLoopbackRedirect"];
    const redirectPolicy = setup?.["redirectPolicy"];
    const credential = setup?.["credential"];
    const accountIdentityJwtClaimRoot = setup?.["accountIdentityJwtClaimRoot"];
    const accountIdentityJwtClaimField = setup?.["accountIdentityJwtClaimField"];
    return {
      flow,
      ...(isModelCredentialRedirectConfig(redirect) ? { redirect } : {}),
      ...(isModelCredentialRedirectConfig(clientLoopbackRedirect)
        ? { clientLoopbackRedirect }
        : {}),
      ...(redirectPolicy === "loopback-required" ? { redirectPolicy } : {}),
      ...(credential && typeof credential === "object"
        ? { credential: credential as Record<string, unknown> }
        : {}),
      credentialLabel:
        typeof credentialLabel === "string" ? credentialLabel : `Model credential: ${providerId}`,
      accountIdentityJwtClaimRoot:
        typeof accountIdentityJwtClaimRoot === "string" ? accountIdentityJwtClaimRoot : "",
      accountIdentityJwtClaimField:
        typeof accountIdentityJwtClaimField === "string" ? accountIdentityJwtClaimField : "",
    };
  }

  private async connectModelCredential(
    channelId: string,
    args: ConnectModelCredentialOAuthArgs
  ): Promise<ModelCredentialSummary> {
    if (typeof args?.providerId !== "string") {
      throw new Error("connectModelCredential requires providerId");
    }
    const browserOpenMode = args.browserOpenMode === "external" ? "external" : "internal";
    const browserHandoffCallerId =
      typeof args.browserHandoffCallerId === "string" ? args.browserHandoffCallerId : undefined;
    const browserHandoffCallerKind = args.browserHandoffCallerKind === "shell" ? "shell" : "panel";
    const browserHandoffPlatform =
      typeof args.browserHandoffPlatform === "string" ? args.browserHandoffPlatform : undefined;
    const modelBaseUrl = this.getModelBaseUrl(channelId);
    const setup = this.getModelCredentialConnectSpec(channelId, args.providerId);
    const redirect =
      (browserOpenMode === "external" || browserHandoffPlatform === "mobile") &&
      setup.clientLoopbackRedirect
        ? setup.clientLoopbackRedirect
        : setup.redirect;
    if (
      isModelCredentialOAuthConfig(setup.flow) &&
      setup.redirectPolicy === "loopback-required" &&
      (!redirect || (redirect.type !== "loopback" && redirect.type !== "client-loopback"))
    ) {
      throw new Error(`Model provider ${args.providerId} requires a loopback OAuth redirect`);
    }
    const defaultCredential = {
      label: setup.credentialLabel,
      audience: [{ url: modelBaseUrl, match: "path-prefix" }],
      injection: {
        type: "header",
        name: "Authorization",
        valueTemplate: "Bearer {token}",
        stripIncoming: ["authorization"],
      },
      scopes: isModelCredentialOAuthConfig(setup.flow) ? (setup.flow.scopes ?? []) : [],
      metadata: {
        modelProviderId: args.providerId,
        accountIdentityJwtClaimRoot: setup.accountIdentityJwtClaimRoot,
        accountIdentityJwtClaimField: setup.accountIdentityJwtClaimField,
      },
    };
    const spec = {
      flow: {
        ...setup.flow,
      },
      credential: {
        ...defaultCredential,
        ...(setup.credential ?? {}),
        label:
          typeof setup.credential?.["label"] === "string"
            ? setup.credential["label"]
            : defaultCredential.label,
        audience: Array.isArray(setup.credential?.["audience"])
          ? setup.credential["audience"]
          : defaultCredential.audience,
        metadata: {
          ...defaultCredential.metadata,
          ...(setup.credential?.["metadata"] && typeof setup.credential["metadata"] === "object"
            ? (setup.credential["metadata"] as Record<string, string>)
            : {}),
        },
      },
      browser: browserOpenMode,
      ...(redirect ? { redirect } : {}),
    };
    return this.rpc.call<ModelCredentialSummary>("main", "credentials.connect", [
      browserHandoffCallerId
        ? {
            spec,
            handoffTarget: {
              callerId: browserHandoffCallerId,
              callerKind: browserHandoffCallerKind,
            },
          }
        : spec,
    ]);
  }

  private createModelCredentialSentinel(
    providerId: string,
    credential: ModelCredentialSummary
  ): string {
    const providerClaims = this.getModelCredentialTokenClaims(providerId, credential);
    if (Object.keys(providerClaims).length === 0) {
      return URL_BOUND_MODEL_CREDENTIAL_SENTINEL;
    }
    return [
      "natstack",
      base64UrlJson({
        [URL_BOUND_MODEL_CREDENTIAL_SENTINEL_CLAIM]: true,
        ...providerClaims,
      }),
      "url-bound",
    ].join(".");
  }

  private getModelBaseUrl(channelId: string): string {
    const model = this.getModel(channelId);
    const colonIdx = model.indexOf(":");
    if (colonIdx < 0) {
      throw new Error(`Model must be "provider:model", got: ${model}`);
    }
    const provider = model.slice(0, colonIdx);
    const modelId = model.slice(colonIdx + 1);
    const resolved = getPiModel(provider as never, modelId as never);
    if (!resolved?.baseUrl) {
      throw new Error(`No model metadata found for model provider: ${provider}`);
    }
    return resolved.baseUrl;
  }

  private installUrlBoundModelFetchProxy(channelId: string, modelBaseUrl: string): void {
    const globals = globalThis as typeof globalThis & {
      __natstackModelFetchProxyInstalled?: boolean;
      __natstackModelFetchProxyBaseUrls?: string[];
      __natstackModelFetchProxyState?: UrlBoundModelFetchProxyState;
    };
    let state = globals.__natstackModelFetchProxyState;
    if (!state) {
      state = {
        originalFetch: globalThis.fetch.bind(globalThis),
        routes: new Map(),
      };
      globals.__natstackModelFetchProxyState = state;
    }
    state.routes.set(modelBaseUrl, {
      fetcher: this.credentials.fetch.bind(this.credentials),
      debug: {
        channelId,
        record: (phase, detail) => this.recordDebugPhase(channelId, phase, detail),
        error: (scope, error) => this.recordLastError(scope, error, channelId),
      },
    });
    globals.__natstackModelFetchProxyBaseUrls = Array.from(
      new Set([...(globals.__natstackModelFetchProxyBaseUrls ?? []), modelBaseUrl])
    );
    if (globals.__natstackModelFetchProxyInstalled) return;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const targetUrl = new URL(request.url);
      const headers = new Headers(request.headers);
      const authorization = headers.get("authorization");
      const hasSentinel = authorization?.startsWith("Bearer ")
        ? isModelCredentialSentinel(authorization.slice("Bearer ".length))
        : false;
      if (!hasSentinel) {
        return state.originalFetch(input, init);
      }
      const route = findUrlBoundModelFetchProxyRoute(targetUrl, state.routes);
      if (!route) {
        throw new Error(
          `Refusing to send URL-bound model credential to non-model URL: ${targetUrl.toString()}`
        );
      }
      route.route.debug?.record("model_fetch.proxy.start", {
        baseUrl: route.baseUrl,
        url: targetUrl.toString(),
        method: request.method,
      });
      headers.delete("authorization");
      if (request.signal.aborted) {
        route.route.debug?.record("model_fetch.proxy.aborted", {
          baseUrl: route.baseUrl,
          url: targetUrl.toString(),
          before: "dispatch",
        });
        throw new Error("URL-bound model credential fetch aborted before proxy dispatch");
      }

      // Route through the credentialed client. The shared client uses
      // `rpc.streamCall` so model SSE responses arrive as a real
      // ReadableStream (HTTP transport) — without this the model SDK
      // would either block until the completion finishes or buffer
      // the entire event stream before yielding the first token.
      //
      // Body forwarded as bytes (not text) so binary model payloads
      // round-trip intact. `request.signal` forwarded so aborting
      // the model SDK's fetch reaches the upstream — without that,
      // a canceled turn keeps the remote completion running.
      const upstreamBody =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : new Uint8Array(await request.arrayBuffer());
      if (request.signal.aborted) {
        route.route.debug?.record("model_fetch.proxy.aborted", {
          baseUrl: route.baseUrl,
          url: targetUrl.toString(),
          before: "upstream",
        });
        throw new Error("URL-bound model credential fetch aborted before upstream dispatch");
      }
      try {
        const upstream = await route.route.fetcher(targetUrl.toString(), {
          method: request.method,
          headers,
          body: upstreamBody,
          signal: request.signal,
        });
        route.route.debug?.record("model_fetch.proxy.response", {
          baseUrl: route.baseUrl,
          url: targetUrl.toString(),
          status: upstream.status,
          ok: upstream.ok,
        });
        return upstream;
      } catch (err) {
        route.route.debug?.error("model_fetch.proxy", err);
        route.route.debug?.record("model_fetch.proxy.error", {
          baseUrl: route.baseUrl,
          url: targetUrl.toString(),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };

    globals.__natstackModelFetchProxyInstalled = true;
  }

  protected getApprovalLevel(channelId: string): ApprovalLevel {
    const value = this.getStateValue(`approvalLevel:${channelId}`);
    const parsed = value ? parseInt(value, 10) : undefined;
    if (parsed === 0 || parsed === 1 || parsed === 2) return parsed;
    const config = this.subscriptions.getConfig(channelId);
    return isApprovalLevel(config?.approvalLevel)
      ? config.approvalLevel
      : this.getDefaultApprovalLevel();
  }

  protected setApprovalLevel(channelId: string, level: ApprovalLevel): void {
    this.setStateValue(`approvalLevel:${channelId}`, String(level));
    const entry = this.runners.get(channelId);
    if (entry) entry.runner.setApprovalLevel(level);
  }

  protected shouldProcess(event: ChannelEvent): boolean {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return false;
    const senderType = event.senderMetadata?.["type"] as string | undefined;
    if (!isClientParticipantType(senderType)) return false;
    const agentic = this.agenticEventFromChannelEvent(event);
    return agentic?.kind === "message.completed";
  }

  protected getRespondPolicy(channelId: string): RespondPolicy {
    const stateValue = this.getStateValue(`respondPolicy:${channelId}`);
    if (isRespondPolicy(stateValue)) return stateValue;
    const config = this.subscriptions.getConfig(channelId);
    return isRespondPolicy(config?.respondPolicy)
      ? config.respondPolicy
      : this.getDefaultRespondPolicy();
  }

  protected getRespondFrom(channelId: string): string[] {
    const stateValue = this.getStateValue(`respondFrom:${channelId}`);
    if (stateValue) {
      try {
        const parsed = JSON.parse(stateValue);
        if (Array.isArray(parsed)) {
          return parsed.filter((id): id is string => typeof id === "string");
        }
      } catch {
        /* ignore malformed state */
      }
    }
    const config = this.subscriptions.getConfig(channelId);
    return Array.isArray(config?.respondFrom)
      ? config.respondFrom.filter((id): id is string => typeof id === "string")
      : this.getDefaultRespondFrom();
  }

  protected setRespondPolicy(
    channelId: string,
    policy: RespondPolicy,
    respondFrom?: readonly string[]
  ): void {
    this.setStateValue(`respondPolicy:${channelId}`, policy);
    if (respondFrom !== undefined) {
      this.setStateValue(
        `respondFrom:${channelId}`,
        JSON.stringify(respondFrom.filter((id): id is string => typeof id === "string"))
      );
    } else if (policy !== "from-participants") {
      this.setStateValue(`respondFrom:${channelId}`, JSON.stringify([]));
    }
  }

  protected getAgentSettings(channelId: string): {
    model: { value: string; source: AgentSettingSource };
    thinkingLevel: { value: ThinkingLevel; source: AgentSettingSource };
    approvalLevel: { value: ApprovalLevel; source: AgentSettingSource };
    respondPolicy: { value: RespondPolicy; source: AgentSettingSource };
    respondFrom: { value: string[]; source: AgentSettingSource };
  } {
    const config = this.subscriptions.getConfig(channelId);
    const thinkingState = this.getStateValue(`thinkingLevel:${channelId}`);
    const approvalState = this.getStateValue(`approvalLevel:${channelId}`);
    const approvalParsed = approvalState ? parseInt(approvalState, 10) : undefined;
    const respondPolicyState = this.getStateValue(`respondPolicy:${channelId}`);
    const respondFromState = this.getStateValue(`respondFrom:${channelId}`);
    const parseRespondFromState = (): string[] | null => {
      if (!respondFromState) return null;
      try {
        const parsed = JSON.parse(respondFromState);
        return Array.isArray(parsed)
          ? parsed.filter((id): id is string => typeof id === "string")
          : null;
      } catch {
        return null;
      }
    };
    const stateRespondFrom = parseRespondFromState();
    const configRespondFrom = Array.isArray(config?.respondFrom)
      ? config.respondFrom.filter((id): id is string => typeof id === "string")
      : null;
    return {
      model: {
        value: this.getModel(channelId),
        source: typeof config?.model === "string" && config.model.length > 0 ? "config" : "default",
      },
      thinkingLevel: {
        value: this.getThinkingLevel(channelId),
        source: isThinkingLevel(thinkingState)
          ? "state"
          : isThinkingLevel(config?.thinkingLevel)
            ? "config"
            : "default",
      },
      approvalLevel: {
        value: this.getApprovalLevel(channelId),
        source: isApprovalLevel(approvalParsed)
          ? "state"
          : isApprovalLevel(config?.approvalLevel)
            ? "config"
            : "default",
      },
      respondPolicy: {
        value: this.getRespondPolicy(channelId),
        source: isRespondPolicy(respondPolicyState)
          ? "state"
          : isRespondPolicy(config?.respondPolicy)
            ? "config"
            : "default",
      },
      respondFrom: {
        value: this.getRespondFrom(channelId),
        source: stateRespondFrom ? "state" : configRespondFrom ? "config" : "default",
      },
    };
  }

  protected async shouldRespond(channelId: string, event: ChannelEvent): Promise<boolean> {
    const policy = this.getRespondPolicy(channelId);
    if (policy === "all") return true;
    if (policy === "from-participants")
      return this.getRespondFrom(channelId).includes(event.senderId);

    const selfParticipantId = this.subscriptions.getParticipantId(channelId);
    if (!selfParticipantId) return false;
    const meta = this.extractMessageMeta(event);
    if (meta.mentions?.includes(selfParticipantId)) return true;
    if (policy === "mentioned-strict") return false;

    const participants = this.cachedParticipants.get(channelId) ?? [];
    const nonSenders = participants.filter(
      (participant) => participant.participantId !== event.senderId
    );
    return nonSenders.length === 1 && nonSenders[0]?.participantId === selfParticipantId;
  }

  private extractMessageMeta(event: ChannelEvent): { mentions?: string[]; replyTo?: string } {
    const agentic = this.agenticEventFromChannelEvent(event);
    const payload = (agentic?.payload ?? {}) as { mentions?: string[]; replyTo?: string };
    return { mentions: payload.mentions, replyTo: payload.replyTo };
  }

  protected buildTurnInput(event: ChannelEvent): TurnInput {
    const agentic = this.agenticEventFromChannelEvent(event);
    const payload = agentic?.payload as { content?: unknown } | undefined;
    return {
      content: typeof payload?.content === "string" ? payload.content : "",
      senderId: event.senderId,
      attachments: event.attachments,
    };
  }

  private agenticEventFromChannelEvent(event: ChannelEvent): {
    kind?: string;
    actor?: { id?: string; participantId?: string };
    causality?: { invocationId?: string; transportCallId?: string };
    payload?: unknown;
  } | null {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return null;
    return event.payload && typeof event.payload === "object"
      ? (event.payload as {
          kind?: string;
          actor?: { id?: string; participantId?: string };
          causality?: { invocationId?: string; transportCallId?: string };
          payload?: unknown;
        })
      : null;
  }

  protected async indexOwnCustomMessages(
    channelId: string,
    reducerLookup?: (typeId: string) => CustomMessageReducer | undefined | null
  ): Promise<Map<string, Map<string, unknown>>> {
    const selfParticipantId = this.subscriptions.getParticipantId(channelId);
    if (!selfParticipantId) {
      return new Map();
    }

    const byMessageId = new Map<string, { typeId: string; state: unknown }>();
    const channel = this.createChannelClient(channelId);
    let cursor = 0;

    while (true) {
      const envelope = await channel.getReplayAfter(cursor);
      const events = envelope.logEvents;
      if (events.length === 0) break;

      let nextCursor = cursor;
      for (const event of events) {
        nextCursor = Math.max(nextCursor, event.id ?? 0);
        const agentic = this.agenticEventFromChannelEvent(event as ChannelEvent);
        if (!agentic || !this.isOwnCustomMessageActor(agentic.actor, selfParticipantId)) {
          continue;
        }

        if (agentic.kind === "custom.started") {
          const payload = this.customPayload(agentic.payload);
          const messageId = typeof payload["messageId"] === "string" ? payload["messageId"] : null;
          const typeId = typeof payload["typeId"] === "string" ? payload["typeId"] : null;
          if (!messageId || !typeId) continue;
          byMessageId.set(messageId, {
            typeId,
            state: await this.hydrateStoredTransportValue(payload["initialState"]),
          });
          continue;
        }

        if (agentic.kind === "custom.updated") {
          const payload = this.customPayload(agentic.payload);
          const messageId = typeof payload["messageId"] === "string" ? payload["messageId"] : null;
          if (!messageId) continue;
          const existing = byMessageId.get(messageId);
          if (!existing) continue;
          const reducer = reducerLookup?.(existing.typeId) ?? null;
          const update = await this.hydrateStoredTransportValue(payload["update"]);
          byMessageId.set(messageId, {
            typeId: existing.typeId,
            state: reducer ? reducer(existing.state, update) : update,
          });
        }
      }

      if (nextCursor <= cursor) break;
      cursor = nextCursor;
    }

    const byType = new Map<string, Map<string, unknown>>();
    for (const [messageId, { typeId, state }] of byMessageId.entries()) {
      let messages = byType.get(typeId);
      if (!messages) {
        messages = new Map();
        byType.set(typeId, messages);
      }
      messages.set(messageId, state);
    }
    return byType;
  }

  private customPayload(payload: unknown): Record<string, unknown> {
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  }

  private async hydrateStoredTransportValue(value: unknown): Promise<unknown> {
    return hydrateStoredValueRefs(value, {
      getText: async (digest) => {
        const text = await this.rpc.call<string | null>("main", "blobstore.getText", [digest]);
        if (text === null) {
          throw new AgentWorkerError(
            "transcript_shape",
            `Stored transport blob is missing: ${digest}`
          );
        }
        return text;
      },
    });
  }

  private isOwnCustomMessageActor(
    actor: { id?: string; participantId?: string } | undefined,
    selfParticipantId: string
  ): boolean {
    return actor?.participantId === selfParticipantId || actor?.id === selfParticipantId;
  }

  private channelInvocationResult(event: ChannelEvent): {
    callId: string;
    content: unknown;
    complete: boolean;
    isError: boolean;
    terminalKind?: Exclude<MethodSuspensionTerminalKind, "none">;
    eventId?: number;
  } | null {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return null;
    const agentic = this.agenticEventFromChannelEvent(event);
    if (!agentic?.kind?.startsWith("invocation.") || agentic.kind === "invocation.started") {
      return null;
    }
    const callId = agentic.causality?.transportCallId;
    if (!callId) return null;
    const payload =
      agentic.payload && typeof agentic.payload === "object"
        ? (agentic.payload as Record<string, unknown>)
        : {};
    if (agentic.kind === "invocation.completed") {
      return {
        callId,
        content: payload["result"],
        complete: true,
        isError: false,
        terminalKind: "completed",
        ...(event.id !== undefined ? { eventId: event.id } : {}),
      };
    }
    if (agentic.kind === "invocation.failed" || agentic.kind === "invocation.cancelled") {
      return {
        callId,
        content: payload["error"] ?? payload["reason"] ?? "Invocation failed",
        complete: true,
        isError: true,
        terminalKind: agentic.kind === "invocation.cancelled" ? "cancelled" : "failed",
        ...(event.id !== undefined ? { eventId: event.id } : {}),
      };
    }
    return {
      callId,
      content: payload["output"] ?? payload["data"] ?? payload["message"],
      complete: false,
      isError: false,
    };
  }

  protected getParticipantInfo(_channelId: string, config?: unknown): ParticipantDescriptor {
    const cfg = config as Record<string, unknown> | undefined;
    return {
      handle: (cfg?.["handle"] as string) ?? "agent",
      name: "AI Agent",
      type: "agent",
      metadata: {},
      methods: [],
    };
  }

  protected getRunnerPromptConfig(channelId: string): {
    systemPrompt?: string;
    systemPromptMode?: SystemPromptMode;
  } {
    const config = this.subscriptions.getConfig(channelId);
    if (!config) return {};
    const systemPrompt =
      typeof config["systemPrompt"] === "string" ? config["systemPrompt"] : undefined;
    const rawMode = config["systemPromptMode"];
    const systemPromptMode =
      rawMode === "append" || rawMode === "replace-natstack" || rawMode === "replace"
        ? rawMode
        : undefined;
    return {
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(systemPromptMode ? { systemPromptMode } : {}),
    };
  }

  protected getRunnerTools(_channelId: string): PiRunnerOptions["extraTools"] | null {
    return null;
  }

  /**
   * Tools always available to the agent in addition to whatever
   * `getRunnerTools` returns. Subclasses can override to suppress or
   * replace the defaults; the base set includes a `set_title` tool that
   * persists an explicit display title via the runtime title registry.
   */
  protected getBuiltInTools(channelId: string): NonNullable<PiRunnerOptions["extraTools"]> {
    return [this.createSetTitleTool(channelId)];
  }

  /**
   * Built-in `set_title` tool — lets an agent rename itself in the shell
   * (approval bar, panel tree, status surfaces). Calling this records an
   * explicit-title flag so the heuristic first-message fallback no longer
   * fires on subsequent activations.
   */
  protected createSetTitleTool(
    _channelId: string
  ): NonNullable<PiRunnerOptions["extraTools"]>[number] {
    return {
      name: "set_title",
      label: "set_title",
      description:
        "Set this agent's display title in the shell. Use a short, descriptive label (under ~60 chars) that summarises the conversation or the agent's purpose. Calling this overrides the auto-generated title and persists across restarts.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "The new display title. Empty string clears any explicit title.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      } as never,
      execute: async (_toolCallId, params) => {
        const input = params as { title?: unknown };
        const raw = typeof input.title === "string" ? input.title : "";
        const trimmed = raw.trim();
        await this.setOwnTitleExplicitly(trimmed.length === 0 ? null : trimmed);
        return {
          content: [
            {
              type: "text",
              text:
                trimmed.length === 0
                  ? "Cleared explicit display title."
                  : `Display title set to: ${trimmed}`,
            },
          ],
          details: { title: trimmed || null },
        };
      },
    };
  }

  protected getRunnerToolFilter(_channelId: string): PiRunnerOptions["toolFilter"] | null {
    return null;
  }

  protected getRunnerSkills(_channelId: string): unknown[] | null {
    return null;
  }

  // ── Subscription lifecycle ──────────────────────────────────────────────

  async subscribeChannel(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    replay?: boolean;
  }): Promise<{ ok: boolean; participantId: string }> {
    await this.ensureAgentActivationReady();
    // Security: a buggy or malicious caller can hand us any string for
    // opts.contextId. Before subscribing, verify that the requested contextId
    // actually matches this DO's own runtime contextId — otherwise a caller
    // could pivot this DO into another context's channel feed.
    const ownContextId = await this.resolveOwnContextId();
    if (opts.contextId !== ownContextId) {
      throw new Error(
        `subscribeChannel denied: contextId ${opts.contextId} does not match DO context ${ownContextId}`
      );
    }

    const descriptor = this.getParticipantInfo(opts.channelId, opts.config);
    const result = await this.subscriptions.subscribe({
      channelId: opts.channelId,
      contextId: opts.contextId,
      config: opts.config,
      descriptor,
      replay: opts.replay,
    });

    if (result.channelConfig?.["approvalLevel"] != null) {
      const level = result.channelConfig["approvalLevel"] as number;
      if (level === 0 || level === 1 || level === 2) {
        this.setApprovalLevel(opts.channelId, level);
      }
    }

    return { ok: result.ok, participantId: result.participantId };
  }

  async unsubscribeChannel(channelId: string): Promise<UnsubscribeResult> {
    await this.ensureAgentActivationReady();
    this.abortRecoveryDirectExecutions(channelId, "channel_unsubscribe");
    this.clearRecoveryContinuePending(channelId);
    this.cancelMethodSuspensionsForChannel(channelId, "channel_unsubscribe");
    await this.subscriptions.unsubscribeFromChannel(channelId);

    // Dispose dispatcher before the runner — unsubscribes its listener
    // and broadcasts typing off.
    const dispatcher = this.dispatchers.get(channelId);
    if (dispatcher) {
      dispatcher.dispose();
      this.dispatchers.delete(channelId);
    }

    const entry = this.runners.get(channelId);
    if (entry) {
      this.recordAbort(channelId, "channel-unsubscribe");
      entry.runner.dispose();
      this.abortContexts.delete(channelId);
      this.runners.delete(channelId);
    }

    this.rejectMethodWaitersForChannel(channelId, "Channel was unsubscribed");
    this.subscriptions.deleteSubscription(channelId);
    this.transcriptPoisonedChannels.delete(channelId);
    this.transcriptPoisonNotified.delete(channelId);

    return { ok: true };
  }

  // ── Channel event pipeline (dedup → gap repair → dispatch) ──────────────

  private async handleIncomingChannelEvent(
    channelId: string,
    event: ChannelEvent,
    opts?: { mode?: "auto" | "sequential" }
  ): Promise<void> {
    await this.ensureAgentActivationReady();
    this.recordChannelDebugEvent(channelId, event, opts);
    const eventId = event.id;

    if (eventId !== undefined && eventId > 0) {
      const lastSeq = this.getDeliveryCursor(channelId);
      if (eventId <= lastSeq) {
        return;
      }

      if (eventId > lastSeq + 1) {
        await this.repairGap(channelId, lastSeq, eventId);
      }

      const attempts = this.failedEvents.get(eventId) ?? 0;
      if (attempts >= TrajectoryVesselBase.POISON_MAX_ATTEMPTS) {
        console.error(
          `[TrajectoryVesselBase] Skipping poison event id=${eventId} after ${attempts} failed attempts`
        );
        this.advanceDeliveryCursor(channelId, eventId);
        this.failedEvents.delete(eventId);
        return;
      }
    }

    try {
      await this.dispatchChannelEvent(channelId, event, opts);
      if (eventId !== undefined && eventId > 0) {
        this.advanceDeliveryCursor(channelId, eventId);
        this.failedEvents.delete(eventId);
      }
    } catch (err) {
      this.recordLastError("channel_event.dispatch", err, channelId);
      if (eventId !== undefined && eventId > 0) {
        const count = (this.failedEvents.get(eventId) ?? 0) + 1;
        this.failedEvents.set(eventId, count);
        if (count >= TrajectoryVesselBase.POISON_MAX_ATTEMPTS) {
          console.error(
            `[TrajectoryVesselBase] Poison event id=${eventId} failed ${count} times, will skip on next delivery:`,
            err
          );
        } else {
          console.warn(
            `[TrajectoryVesselBase] processChannelEvent failed for id=${eventId} (attempt ${count}/${TrajectoryVesselBase.POISON_MAX_ATTEMPTS}):`,
            err
          );
        }
      } else {
        console.error("[TrajectoryVesselBase] processChannelEvent failed for signal event:", err);
      }
    }
  }

  private getDeliveryCursor(channelId: string): number {
    const cursor = this.sql
      .exec(`SELECT last_delivered_seq FROM delivery_cursor WHERE channel_id = ?`, channelId)
      .toArray();
    return cursor.length > 0 ? (cursor[0]!["last_delivered_seq"] as number) : 0;
  }

  private advanceDeliveryCursor(channelId: string, seq: number): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO delivery_cursor (channel_id, last_delivered_seq) VALUES (?, ?)`,
      channelId,
      seq
    );
  }

  private async repairGap(channelId: string, lastSeq: number, eventId: number): Promise<void> {
    const gap = eventId - lastSeq - 1;
    if (gap > 1000) {
      console.error(
        `[TrajectoryVesselBase] Gap too large (${gap} events) in channel=${channelId}, skipping repair`
      );
      return;
    }
    try {
      const channel = this.createChannelClient(channelId);
      const missedEnvelope = await channel.getReplayAfter(lastSeq);
      const missed = missedEnvelope.logEvents
        .filter((event) => event.id <= eventId - 1)
        .map((event) => event as ChannelEvent);

      for (const missedEvent of missed) {
        try {
          await this.dispatchChannelEvent(channelId, missedEvent);
          if (missedEvent.id !== undefined && missedEvent.id > 0) {
            this.advanceDeliveryCursor(channelId, missedEvent.id);
          }
        } catch (missedErr) {
          const missedId = missedEvent.id;
          if (missedId !== undefined && missedId > 0) {
            const count = (this.failedEvents.get(missedId) ?? 0) + 1;
            this.failedEvents.set(missedId, count);
            if (count >= TrajectoryVesselBase.POISON_MAX_ATTEMPTS) {
              console.error(
                `[TrajectoryVesselBase] Poison event id=${missedId} in gap repair, skipping:`,
                missedErr
              );
              this.advanceDeliveryCursor(channelId, missedId);
            } else {
              console.warn(
                `[TrajectoryVesselBase] Gap repair event id=${missedId} failed (attempt ${count}):`,
                missedErr
              );
            }
          }
        }
      }
    } catch (err) {
      console.warn(
        `[TrajectoryVesselBase] Gap repair failed for channel=${channelId} gap=${lastSeq + 1}..${eventId - 1}:`,
        err
      );
    }
  }

  private async dispatchChannelEvent(
    channelId: string,
    event: ChannelEvent,
    opts?: { mode?: "auto" | "sequential" }
  ): Promise<void> {
    if (event.type === "config-update") {
      let newLevel: number | undefined;
      try {
        const config =
          typeof event.payload === "object" && event.payload !== null
            ? (event.payload as Record<string, unknown>)
            : {};
        if ("approvalLevel" in config) {
          newLevel = config["approvalLevel"] as number;
        }
      } catch {
        /* ignore parse errors */
      }
      if (newLevel !== undefined && (newLevel === 0 || newLevel === 1 || newLevel === 2)) {
        this.setApprovalLevel(channelId, newLevel);
      }
      return;
    }

    if (await this.failIfTranscriptPoisoned(channelId)) return;

    const invocationResult = this.channelInvocationResult(event);
    if (invocationResult) {
      const content = await this.hydrateStoredTransportValue(invocationResult.content);
      if (!invocationResult.complete) {
        this.appendMethodSuspensionUpdate(invocationResult.callId, content);
        const cb = this.streamCallbacks.get(invocationResult.callId);
        if (cb) cb(content);
      } else {
        await this.handleCompletedMethodResult(
          channelId,
          invocationResult.callId,
          content,
          invocationResult.isError,
          invocationResult.terminalKind ?? (invocationResult.isError ? "failed" : "completed"),
          invocationResult.eventId
        );
      }
      return;
    }

    await this.processChannelEvent(channelId, event, opts);
  }

  // ── PiRunner lifecycle (one per channel, lazy) ──────────────────────────

  protected async getOrCreateRunner(channelId: string): Promise<PiRunner> {
    await this.ensureAgentActivationReady();
    const existing = this.runners.get(channelId);
    if (existing) return existing.runner;

    const subclassExtraTools = this.getRunnerTools(channelId);
    const builtInTools = this.getBuiltInTools(channelId);
    const extraTools =
      builtInTools.length === 0 && !subclassExtraTools
        ? null
        : [...builtInTools, ...(subclassExtraTools ?? [])];
    const toolFilter = this.getRunnerToolFilter(channelId);
    void this.getRunnerSkills(channelId);

    // Build options as a strongly-typed PiRunnerOptions object. The runner is
    // responsible for materializing Pi session state from trajectory events.
    const runnerOptions: PiRunnerOptions = {
      rpc: {
        call: <T = unknown>(target: string, method: string, args: unknown[]): Promise<T> => {
          return this.rpc.call<T>(target, method, args);
        },
        streamCall: (
          target: string,
          method: string,
          args: unknown[],
          options?: { signal?: AbortSignal }
        ): Promise<Response> => {
          return this.rpc.streamCall(target, method, args, options);
        },
      },
      fs: this.fs,
      uiCallbacks: this.buildUICallbacks(channelId),
      rosterCallback: () => this.buildRoster(channelId),
      callMethodCallback: (
        toolCallId: string,
        handle: string,
        method: string,
        args: unknown,
        signal: AbortSignal | undefined,
        onStreamUpdate?: (content: unknown) => void,
        turnId?: string
      ) =>
        this.invokeChannelMethod(
          channelId,
          toolCallId,
          handle,
          method,
          args,
          signal,
          onStreamUpdate,
          turnId
        ),
      askUserCallback: (
        toolCallId: string,
        params: AskUserParams,
        signal: AbortSignal | undefined,
        turnId?: string
      ) => this.askUser(channelId, toolCallId, params, signal, turnId),
      model: this.getModel(channelId),
      getApiKey: this.getApiKeyForChannel(channelId),
      hasCredentialForOrigin: async (originUrl: string) => {
        try {
          // `resolveCredential` matches the probe URL against stored
          // audience patterns. Model credentials are stored against
          // `modelBaseUrl` with `match: "path-prefix"` (see
          // `installUrlBoundModelFetchProxy`), so if the caller's
          // probe is just the origin, a path-prefixed audience like
          // `https://host/v1/` won't match. When the origins agree,
          // probe with the full model base URL so path-prefix
          // credentials are detected.
          let probeUrl = originUrl;
          try {
            const modelBaseUrl = this.getModelBaseUrl(channelId);
            if (new URL(modelBaseUrl).origin === new URL(originUrl).origin) {
              probeUrl = modelBaseUrl;
            }
          } catch {
            // No model URL configured (or unparseable). Fall through
            // and probe with the caller's URL as-is — that's correct
            // for search-provider credentials registered with
            // `match: "origin"`.
          }
          const c = await this.rpc.call<{ id: string } | null>(
            "main",
            "credentials.resolveCredential",
            [{ url: probeUrl }]
          );
          return c !== null;
        } catch {
          return false;
        }
      },
      // Credentialed fetcher — `this.credentials.fetch` is bound to
      // this DO's RPC bridge (`this.rpc`) via createCredentialClient
      // and routes through `rpc.streamCall` so HTTP transport gives
      // real streaming and other transports synthesize a Response
      // uniformly. The harness never sees credential values.
      fetcher: this.credentials.fetch.bind(this.credentials) as typeof fetch,
      thinkingLevel: this.getThinkingLevel(channelId),
      ...this.getRunnerPromptConfig(channelId),
      ...(extraTools ? { extraTools } : {}),
      ...(toolFilter ? { toolFilter } : {}),
      approvalLevel: this.getApprovalLevel(channelId),
      agentActor: this.agentActorForChannel(channelId),
      gad: {
        branchId: gadBranchIdForChannel(channelId),
        channelId,
        contextId: this.subscriptions.getContextId(channelId),
        source: "agent-worker",
        metadata: {
          workerRef: this.identity.refOrNull,
        },
      },
    };
    const runner = this.createRunner(channelId, {
      ...runnerOptions,
      onPrepareNextTurn: async (snapshot) => {
        await this.prepareNextTurnHook(channelId, snapshot);
      },
    });

    await runner.init();
    await this.sweepStuckDelivery(channelId, runner);

    const abortedTurnListener = (event: RunnerEvent) => {
      const msg = abortedAgentEndMessage(event);
      if (!msg) return;
      const context = this.abortContexts.get(channelId);
      this.abortContexts.delete(channelId);
      console.log(
        `[TrajectoryVesselBase] Agent turn aborted on channel=${channelId}: ` +
          `reason=${context?.reason ?? "unknown"}${context?.detail ? ` detail=${context.detail}` : ""}; ${msg}`
      );
    };
    runner.hooks.on("event", abortedTurnListener);
    runner.hooks.on("event", (event: RunnerEvent) => {
      if (event.type !== "message_end") return;
      const message = (event as { message?: AgentMessage }).message;
      if (!message) return;
      const role = (message as { role?: unknown }).role;
      if (role === "assistant") {
        this.clearRecoveryContinuePending(channelId);
        return;
      }
      if (role !== "toolResult") return;
      this.markLiveToolResultAdmitted(channelId, message);
    });

    this.runners.set(channelId, { runner });
    // Dispatcher self-subscribes to runner events for absorption tracking
    // and sweep. Created here so it exists before the first processChannelEvent
    // (which expects to hand messages to it).
    this.getOrCreateDispatcher(channelId, runner);
    this.replayPendingRecoveryContinue(channelId, runner);
    return runner;
  }

  protected createRunner(_channelId: string, opts: PiRunnerOptions): PiRunner {
    return new PiRunner(opts);
  }

  private agentActorForChannel(channelId: string) {
    const participantId = this.subscriptions.getParticipantId(channelId);
    const descriptor = this.getParticipantInfo(channelId, this.subscriptions.getConfig(channelId));
    return {
      kind: "agent" as const,
      id: participantId ?? descriptor.handle ?? "agent",
      displayName: descriptor.name ?? descriptor.handle ?? "AI Agent",
      metadata: {
        handle: descriptor.handle,
        workerRef: this.identity.refOrNull,
      },
      ...(participantId ? { participantId } : {}),
    };
  }

  private currentTurnIdForChannel(channelId: string): string | undefined {
    return this.runners.get(channelId)?.runner.getCurrentTurnId() ?? undefined;
  }

  /**
   * Phase 4 — the only async-between-turns seam. The runner invokes this
   * between turns (after one `turn_end`, before the next provider request);
   * the worker re-reads the channel roster and re-evaluates model /
   * thinking-level. The hook receives the current `TurnSnapshot` but the
   * default implementation only needs `channelId`. Subclasses may override.
   */
  protected async prepareNextTurnHook(channelId: string, _snapshot: TurnSnapshot): Promise<void> {
    await this.refreshRoster(channelId);
    // Re-evaluating `getModel`/`getThinkingLevel` is implicit: the runner
    // picks up new values via the standard getters on its next prompt.
    // Subclasses that cache may override this hook to invalidate.
    void this.getModel(channelId);
    void this.getThinkingLevel(channelId);
  }

  private transcriptShapeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async emitTranscriptShapeError(channelId: string, detail: string): Promise<void> {
    if (this.transcriptPoisonNotified.has(channelId)) return;
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;

    this.transcriptPoisonNotified.add(channelId);
    const channel = this.createChannelClient(channelId);
    const descriptor = this.getParticipantInfo(channelId, this.subscriptions.getConfig(channelId));
    const messageId = crypto.randomUUID();
    await channel
      .send(participantId, messageId, `Transcript error: ${detail}`, {
        senderMetadata: {
          ...descriptor.metadata,
          name: descriptor.name,
          type: descriptor.type,
          handle: descriptor.handle,
        },
        idempotencyKey: `transcript-shape-error:${channelId}`,
      })
      .catch((err) => {
        console.error(
          `[TrajectoryVesselBase] Failed to emit transcript-shape error for channel=${channelId}:`,
          err
        );
        this.transcriptPoisonNotified.delete(channelId);
      });
  }

  private async handleTranscriptShapeError(channelId: string, error: unknown): Promise<void> {
    const detail = this.transcriptShapeErrorMessage(error);
    const existing = this.transcriptPoisonedChannels.get(channelId);
    if (!existing) {
      this.transcriptPoisonedChannels.set(channelId, detail);
      console.error(
        `[TrajectoryVesselBase] Transcript shape error on channel=${channelId}: ${detail}`
      );
      this.dispatchers.get(channelId)?.reset();
      this.abortContexts.set(channelId, {
        reason: "interrupt-channel",
        detail: "transcript-shape-error",
        at: Date.now(),
      });
      const runner = this.runners.get(channelId)?.runner as
        | { abort?: () => Promise<unknown> }
        | undefined;
      void runner?.abort?.();
    }
    await this.emitTranscriptShapeError(channelId, existing ?? detail);
  }

  private async failIfTranscriptPoisoned(channelId: string): Promise<boolean> {
    const detail = this.transcriptPoisonedChannels.get(channelId);
    if (!detail) return false;
    await this.emitTranscriptShapeError(channelId, detail);
    return true;
  }

  /**
   * Read the runner's transcript from the Session-backed materialized context.
   */
  protected async readRunnerMessages(channelId: string): Promise<AgentMessage[]> {
    if (await this.failIfTranscriptPoisoned(channelId)) {
      throw new AgentWorkerError(
        "transcript_shape",
        this.transcriptPoisonedChannels.get(channelId) ?? "transcript poisoned"
      );
    }
    const entry = this.runners.get(channelId);
    if (!entry) return [];
    try {
      const runner = entry.runner;
      if (runner.session) {
        const ctx = await runner.session.buildContext();
        return validateAgentMessages(
          ctx.messages ?? [],
          `session.buildContext channel=${channelId}`
        );
      }
      const snapshot = await runner.getStateSnapshot();
      return validateAgentMessages(
        snapshot.messages,
        `runner.getStateSnapshot channel=${channelId}`
      );
    } catch (err) {
      if (isTranscriptShapeError(err)) {
        await this.handleTranscriptShapeError(channelId, err);
        throw err;
      }
      console.warn(
        `[TrajectoryVesselBase] readRunnerMessages failed for channel=${channelId}:`,
        err
      );
    }
    return [];
  }

  private async recordModelCredentialInterruption(
    channelId: string,
    providerId: string,
    modelBaseUrl: string
  ): Promise<void> {
    // Tolerate a missing runner (this method can be called before the
    // runner is constructed); pass count = 0 in that case.
    let resumeCount = 0;
    if (this.runners.has(channelId)) {
      try {
        const messages = await this.readRunnerMessages(channelId);
        resumeCount = messages.length;
      } catch (err) {
        // If the read fails (e.g. transcript poisoned), fall back to 0.
        console.warn(
          `[TrajectoryVesselBase] recordModelCredentialInterruption: readRunnerMessages failed:`,
          err
        );
      }
    }
    this.recordModelCredentialInterruptionCursor(channelId, providerId, modelBaseUrl, resumeCount);
  }

  private recordModelCredentialInterruptionCursor(
    channelId: string,
    providerId: string,
    modelBaseUrl: string,
    resumeCount: number
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO model_credential_interruptions
        (channel_id, provider_id, model_base_url, resume_count, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      channelId,
      providerId,
      modelBaseUrl,
      resumeCount,
      Date.now()
    );
  }

  private queueModelCredentialInterruptionRecord(
    channelId: string,
    providerId: string,
    modelBaseUrl: string
  ): void {
    this.recordModelCredentialInterruptionCursor(channelId, providerId, modelBaseUrl, 0);
    if (!this.runners.has(channelId)) return;

    void (async () => {
      try {
        const messages = await this.readRunnerMessages(channelId);
        this.recordModelCredentialInterruptionCursor(
          channelId,
          providerId,
          modelBaseUrl,
          messages.length
        );
      } catch (err) {
        console.warn(
          `[TrajectoryVesselBase] queueModelCredentialInterruptionRecord: readRunnerMessages failed:`,
          err
        );
      }
    })();
  }

  private getModelCredentialInterruption(
    channelId: string,
    providerId: string,
    modelBaseUrl?: string
  ): ModelCredentialInterruption | null {
    const rows = this.sql
      .exec(
        `SELECT provider_id, model_base_url, resume_count, created_at
       FROM model_credential_interruptions
       WHERE channel_id = ? AND provider_id = ?`,
        channelId,
        providerId
      )
      .toArray();
    if (rows.length === 0) return null;
    const row = rows[0]!;
    const storedModelBaseUrl = row["model_base_url"] as string | null;
    if (modelBaseUrl && storedModelBaseUrl && storedModelBaseUrl !== modelBaseUrl) {
      return null;
    }
    return {
      providerId: row["provider_id"] as string,
      ...(storedModelBaseUrl ? { modelBaseUrl: storedModelBaseUrl } : {}),
      resumeCount: Number(row["resume_count"]),
      createdAt: Number(row["created_at"]),
    };
  }

  private clearModelCredentialInterruption(channelId: string, providerId: string): void {
    this.sql.exec(
      `DELETE FROM model_credential_interruptions WHERE channel_id = ? AND provider_id = ?`,
      channelId,
      providerId
    );
  }

  private async ensureChannelContext(channelId: string): Promise<void> {
    await this.refreshRoster(channelId);
    await this.getOrCreateRunner(channelId);
  }

  private recordAbort(channelId: string, reason: AgentAbortReason, detail?: string): void {
    this.abortContexts.set(channelId, { reason, detail, at: Date.now() });
    console.log(
      `[TrajectoryVesselBase] Agent abort requested on channel=${channelId}: ` +
        `reason=${reason}${detail ? ` detail=${detail}` : ""}`
    );
  }

  // ── Dispatch + typing (delegated to TurnDispatcher) ─────────────────────
  //
  // One TurnDispatcher per channel. Every incoming user message flows
  // through `dispatcher.submit`; the dispatcher owns the queue, steer
  // tracking, self-healing sweep, and typing-indicator broadcasts.
  // See `turn-dispatcher.ts` for the full state-machine doc.

  protected dispatchers = new Map<string, TurnDispatcher>();

  protected getOrCreateDispatcher(channelId: string, runner: PiRunner): TurnDispatcher {
    const existing = this.dispatchers.get(channelId);
    if (existing) return existing;
    const dispatcher = new TurnDispatcher({
      runner,
      projector: { closeAll: async () => undefined },
      notifyTyping: (busy) => this.broadcastTyping(channelId, busy),
    });
    this.dispatchers.set(channelId, dispatcher);
    return dispatcher;
  }

  /** Signal setTypingState broadcast. Fire-and-forget; errors logged. */
  private broadcastTyping(channelId: string, busy: boolean): void {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const channel = this.createChannelClient(channelId);
    void channel.setTypingState(participantId, busy).catch((err) => {
      console.warn(
        `[TrajectoryVesselBase] setTypingState(${busy}) failed for channel=${channelId}:`,
        err
      );
    });
  }

  // ── Channel-tools extension wiring ──────────────────────────────────────

  /** Sync getter for the channel-tools extension. The extension expects a
   *  sync callback; we serve from the most-recently-cached roster. Refresh
   *  happens before each turn via `refreshRoster`. */
  private buildRoster(channelId: string): ChannelToolMethod[] {
    return this.cachedRoster.get(channelId) ?? [];
  }

  private cachedRoster = new Map<string, ChannelToolMethod[]>();
  private cachedParticipants = new Map<string, CachedParticipant[]>();

  /** Refresh the cached roster for a channel. Called before each turn. */
  protected async refreshRoster(channelId: string): Promise<void> {
    const channel = this.createChannelClient(channelId);
    const participants = await channel.getParticipants();
    this.cachedParticipants.set(channelId, participants);
    const selfId = this.subscriptions.getParticipantId(channelId);
    const roster: ChannelToolMethod[] = [];
    for (const p of participants) {
      if (p.participantId === selfId) continue;
      const handle = p.metadata["handle"] as string | undefined;
      if (!handle) continue;
      const advertised = p.metadata["methods"];
      if (!Array.isArray(advertised)) continue;
      for (const m of advertised) {
        const method = m as Record<string, unknown>;
        const name = method["name"] as string | undefined;
        if (!name) continue;
        roster.push({
          participantHandle: handle,
          name,
          description: (method["description"] as string) ?? "",
          parameters: method["parameters"] ?? { type: "object" },
        });
      }
    }
    this.cachedRoster.set(channelId, roster);
  }

  private async invokeChannelMethod(
    channelId: string,
    toolCallId: string,
    participantHandle: string,
    method: string,
    args: unknown,
    signal: AbortSignal | undefined,
    onStreamUpdate?: (content: unknown) => void,
    turnId?: string
  ): Promise<AgentToolResult<any>> {
    if (signal?.aborted) throw new Error("aborted");
    const channel = this.createChannelClient(channelId);
    const participants = await channel.getParticipants();
    const target = participants.find((p) => p.metadata["handle"] === participantHandle);
    if (!target) {
      throw new Error(`No participant with handle "${participantHandle}" in channel ${channelId}`);
    }
    const callerId = this.subscriptions.getParticipantId(channelId);
    if (!callerId) throw new Error(`Not subscribed to channel ${channelId}`);

    const invocationId = toolCallId;
    const transportCallId = crypto.randomUUID();
    await this.recordMethodSuspension({
      channelId,
      transportCallId,
      invocationId,
      kind: "channelMethod",
      method,
      participantHandle,
      targetParticipantId: target.participantId,
      args,
      turnId,
      fallbackToolName: method,
    });
    const waiter = this.createMethodResultWaiter(channelId, transportCallId, invocationId, {
      method,
      participantHandle,
      targetParticipantId: target.participantId,
      args,
      turnId,
      signal,
    });
    if (onStreamUpdate) this.streamCallbacks.set(transportCallId, onStreamUpdate);
    try {
      try {
        await channel.callMethod(callerId, target.participantId, transportCallId, method, args, {
          invocationId,
          transportCallId,
          ...(turnId ? { turnId } : {}),
        });
      } catch (err) {
        this.markMethodSuspensionDispatchFailed(transportCallId, err);
        waiter.cancel(err);
        void waiter.promise.catch(() => undefined);
        throw err;
      }
      const completion = await waiter.promise;
      if (completion.isError) return methodErrorResult(completion.result);
      return toAgentToolResult(completion.result);
    } catch (err) {
      this.cancelMethodSuspension(transportCallId, "waiter_rejected");
      waiter.cancel(err);
      await this.cancelChannelMethodCall(channelId, transportCallId);
      throw err;
    } finally {
      this.streamCallbacks.delete(transportCallId);
      this.recordIfSuspensionStillPending(channelId, transportCallId);
    }
  }

  private async askUser(
    channelId: string,
    toolCallId: string,
    params: AskUserParams,
    signal: AbortSignal | undefined,
    turnId?: string
  ): Promise<string | AgentToolResult<any>> {
    if (signal?.aborted) throw new Error("aborted");
    const callerId = this.subscriptions.getParticipantId(channelId);
    if (!callerId) throw new Error(`Not subscribed to channel ${channelId}`);
    const channel = this.createChannelClient(channelId);
    // Find a panel-type participant to ask.
    const participants = await channel.getParticipants();
    const panel = participants.find((p) => {
      const t = p.metadata["type"] as string | undefined;
      return t === "panel" || t === "client";
    });
    if (!panel) {
      throw new Error(`No panel participant in channel ${channelId} to ask`);
    }

    const invocationId = toolCallId || crypto.randomUUID();
    const transportCallId = crypto.randomUUID();
    await this.recordMethodSuspension({
      channelId,
      transportCallId,
      invocationId,
      kind: "askUser",
      method: "feedback_form",
      targetParticipantId: panel.participantId,
      args: params,
      turnId,
      fallbackToolName: "feedback_form",
    });
    const waiter = this.createMethodResultWaiter(channelId, transportCallId, invocationId, {
      method: "feedback_form",
      targetParticipantId: panel.participantId,
      args: params,
      turnId,
      signal,
    });
    try {
      try {
        await channel.callMethod(
          callerId,
          panel.participantId,
          transportCallId,
          "feedback_form",
          params,
          {
            invocationId,
            transportCallId,
            ...(turnId ? { turnId } : {}),
          }
        );
      } catch (err) {
        this.markMethodSuspensionDispatchFailed(transportCallId, err);
        waiter.cancel(err);
        void waiter.promise.catch(() => undefined);
        throw err;
      }
      const completion = await waiter.promise;
      if (completion.isError) return methodErrorResult(completion.result);
      return resultToAnswerText(completion.result);
    } catch (err) {
      this.cancelMethodSuspension(transportCallId, "waiter_rejected");
      waiter.cancel(err);
      await this.cancelChannelMethodCall(channelId, transportCallId);
      throw err;
    } finally {
      this.streamCallbacks.delete(transportCallId);
      this.recordIfSuspensionStillPending(channelId, transportCallId);
    }
  }

  private buildUICallbacks(channelId: string): NatStackScopedUiContext {
    return {
      selectForTool: async (toolCallId, title, options, opts) =>
        this.dispatchUiPrompt(
          channelId,
          toolCallId,
          "select",
          { title, options },
          opts?.signal
        ) as Promise<string | undefined>,
      confirmForTool: async (toolCallId, title, message, opts, meta) =>
        this.dispatchUiPrompt(
          channelId,
          toolCallId,
          "confirm",
          { title, message },
          opts?.signal,
          meta
        ) as Promise<boolean>,
      inputForTool: async (toolCallId, title, placeholder, opts) =>
        this.dispatchUiPrompt(
          channelId,
          toolCallId,
          "input",
          { title, placeholder },
          opts?.signal
        ) as Promise<string | undefined>,
      editorForTool: async (toolCallId, title, prefill) =>
        this.dispatchUiPrompt(
          channelId,
          toolCallId,
          "editor",
          { title, prefill },
          undefined
        ) as Promise<string | undefined>,
      notify: (message, type) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendSignal(participantId, message, `notify:${type ?? "info"}`);
      },
      setStatus: (key, text) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendSignalEvent(participantId, "natstack-ext-status", { key, text });
      },
      setWidget: (key, content, options) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendSignalEvent(participantId, "natstack-ext-widget", {
          key,
          content,
          options,
        });
      },
      setWorkingMessage: (message) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendSignalEvent(participantId, "natstack-ext-working", {
          message: message ?? null,
        });
      },
    };
  }

  private coerceUiPromptResult(
    kind: "select" | "confirm" | "input" | "editor",
    result: unknown
  ): unknown {
    if (kind === "confirm") return result === true || result === "true";
    if (result == null) return undefined;
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  private emitModelCredentialRequiredCard(
    channelId: string,
    providerId: string,
    modelBaseUrl: string
  ): void {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const key = `${channelId}::model-credential::${providerId}`;
    if (this.credentialPromptCardsEmitted.has(key)) return;
    this.credentialPromptCardsEmitted.add(key);

    const channel = this.createChannelClient(channelId);
    let browserHandoffCallerId: string | undefined;
    let browserHandoffPlatform: string | undefined;
    const panel = (this.cachedParticipants.get(channelId) ?? []).find((p) => {
      const t = p.metadata["type"] as string | undefined;
      return t === "panel" || t === "client";
    });
    browserHandoffCallerId = panel?.participantId;
    browserHandoffPlatform =
      typeof panel?.metadata["hostPlatform"] === "string"
        ? (panel.metadata["hostPlatform"] as string)
        : undefined;
    const messageId = crypto.randomUUID();
    const content = JSON.stringify({
      id: `model-credential-${providerId}-${messageId}`,
      code: MODEL_CREDENTIAL_REQUIRED_CARD_TSX,
      props: {
        providerId,
        modelBaseUrl,
        agentParticipantId: participantId,
        browserHandoffCallerId,
        browserHandoffCallerKind: browserHandoffCallerId ? "panel" : undefined,
        browserHandoffPlatform,
        ...(this.getModelCredentialSetupProps(providerId) ?? {}),
      },
    });
    void channel.sendSignal(participantId, content, "inline_ui").catch((err) => {
      console.error(
        `[TrajectoryVesselBase] Failed to emit model credential card for ${providerId}:`,
        err
      );
      this.credentialPromptCardsEmitted.delete(key);
    });
  }

  private createMethodResultWaiter(
    channelId: string,
    callId: string,
    invocationId: string,
    opts: {
      method: string;
      signal?: AbortSignal;
      targetParticipantId?: string;
      participantHandle?: string;
      turnId?: string;
      args?: unknown;
    }
  ): { promise: Promise<MethodResultCompletion>; cancel: (error?: unknown) => void } {
    let settled = false;
    let removeAbortListener: (() => void) | undefined;
    const cleanup = () => {
      this.methodResultWaiters.delete(callId);
      removeAbortListener?.();
      removeAbortListener = undefined;
    };

    const promise = new Promise<MethodResultCompletion>((resolve, reject) => {
      const complete = (completion: MethodResultCompletion) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(completion);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      this.methodResultWaiters.set(callId, {
        channelId,
        invocationId,
        method: opts.method,
        targetParticipantId: opts.targetParticipantId,
        participantHandle: opts.participantHandle,
        createdAt: Date.now(),
        turnId: opts.turnId,
        argsSummary: summarizeDebugValue(opts.args),
        resolve: complete,
        reject: fail,
      });
      const signal = opts.signal;
      if (signal) {
        const onAbort = () => {
          this.cancelMethodSuspension(callId, "aborted");
          fail(new Error("Request was aborted"));
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        }
      }
    });

    return {
      promise,
      cancel: (error?: unknown) => {
        const waiter = this.methodResultWaiters.get(callId);
        waiter?.reject(error ?? new Error("Method call was cancelled"));
      },
    };
  }

  private rejectMethodWaitersForChannel(channelId: string, reason: string): void {
    for (const [callId, waiter] of this.methodResultWaiters.entries()) {
      if (waiter.channelId !== channelId) continue;
      waiter.reject(new Error(reason));
      this.streamCallbacks.delete(callId);
    }
  }

  private async cancelChannelMethodCall(channelId: string, callId: string): Promise<void> {
    try {
      await this.createChannelClient(channelId).cancelCall(callId);
    } catch (err) {
      console.warn(
        `[TrajectoryVesselBase] Failed to cancel channel method call: channel=${channelId} callId=${callId}`,
        err
      );
    }
  }

  private async handleCompletedMethodResult(
    channelId: string,
    callId: string,
    result: unknown,
    isError: boolean,
    terminalKind: Exclude<MethodSuspensionTerminalKind, "none"> = isError ? "failed" : "completed",
    eventId?: number
  ): Promise<void> {
    this.streamCallbacks.delete(callId);
    const row = this.loadMethodSuspension(callId);
    if (!row) {
      this.recordDebugPhase(channelId, "channel_method.orphan_result_without_suspension", {
        callId,
        isError,
      });
      const dispatcher = this.dispatchers.get(channelId);
      const dispatcherState = dispatcher?.getDebugState() as { busy?: boolean } | undefined;
      if (!dispatcherState?.busy) this.broadcastTyping(channelId, false);
      return;
    }

    if (
      row.deliveryStatus === "cancelled" ||
      row.deliveryStatus === "ignored" ||
      row.deliveryStatus === "dispatch_failed"
    ) {
      this.markMethodSuspensionIgnored(callId, { result, isError });
      return;
    }

    if (
      row.deliveryStatus === "transcript_admitted" ||
      row.deliveryStatus === "recovered" ||
      row.deliveryStatus === "superseded" ||
      row.deliveryStatus === "stale" ||
      row.deliveryStatus === "recovery_error"
    ) {
      return;
    }

    if (row.deliveryStatus === "delivered_live") {
      this.recordDebugPhase(channelId, "channel_method.duplicate_live_terminal_ignored", {
        callId,
        invocationId: row.invocationId,
        terminalKind: row.terminalKind,
      });
      return;
    }

    const hydratedResult = await this.hydrateStoredTransportValue(result);
    const waiter = this.methodResultWaiters.get(callId);
    this.markMethodSuspensionTerminal(callId, {
      terminalKind,
      result: hydratedResult,
      isError,
      eventId,
      waiterPresent: Boolean(waiter),
    });
    if (waiter) {
      waiter.resolve({ result: hydratedResult, isError });
      return;
    }

    await this.getOrCreateRunner(channelId);
    await this.runOnChannelRecoveryChain(channelId, () =>
      this.recoverDeliveredAndOrphanedSuspensions(channelId)
    );
  }

  private async dispatchUiPrompt(
    channelId: string,
    toolCallId: string,
    kind: "select" | "confirm" | "input" | "editor",
    params: Record<string, unknown>,
    signal?: AbortSignal,
    meta?: { toolName?: string; toolInput?: unknown; mode?: "approval" | "ui-prompt" }
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error("aborted");
    const invocationId = toolCallId || crypto.randomUUID();
    const recoveredReply = this.consumeRecoveredUiPromptReply(channelId, invocationId);
    if (recoveredReply) {
      if (recoveredReply.isError) {
        throw new Error(resultToAnswerText(recoveredReply.result));
      }
      return this.coerceUiPromptResult(kind, recoveredReply.result);
    }

    const callerId = this.subscriptions.getParticipantId(channelId);
    if (!callerId) throw new Error(`Not subscribed to channel ${channelId}`);
    const channel = this.createChannelClient(channelId);
    const participants = await channel.getParticipants();
    const panel = participants.find((p) => {
      const t = p.metadata["type"] as string | undefined;
      return t === "panel" || t === "client";
    });
    if (!panel) throw new Error(`No panel participant in channel ${channelId}`);

    const transportCallId = crypto.randomUUID();
    const turnId = this.currentTurnIdForChannel(channelId);
    await this.recordMethodSuspension({
      channelId,
      transportCallId,
      invocationId,
      kind: meta?.mode === "approval" ? "approval" : "uiPrompt",
      method: "ui_prompt",
      targetParticipantId: panel.participantId,
      args: {
        prompt: { kind, ...params },
        resumeToolInput: meta?.toolInput,
      },
      turnId,
      fallbackToolName: meta?.toolName ?? "ui_prompt",
      requireOpenInvocation: true,
    });
    const waiter = this.createMethodResultWaiter(channelId, transportCallId, invocationId, {
      method: "ui_prompt",
      targetParticipantId: panel.participantId,
      args: { kind, ...params },
      turnId,
      signal,
    });
    try {
      try {
        await channel.callMethod(
          callerId,
          panel.participantId,
          transportCallId,
          "ui_prompt",
          {
            kind,
            ...params,
          },
          {
            invocationId,
            transportCallId,
            ...(turnId ? { turnId } : {}),
          }
        );
      } catch (err) {
        this.markMethodSuspensionDispatchFailed(transportCallId, err);
        waiter.cancel(err);
        void waiter.promise.catch(() => undefined);
        throw err;
      }
      const completion = await waiter.promise;
      if (completion.isError) {
        throw new Error(resultToAnswerText(completion.result));
      }
      return this.coerceUiPromptResult(kind, completion.result);
    } catch (err) {
      this.cancelMethodSuspension(transportCallId, "waiter_rejected");
      waiter.cancel(err);
      await this.cancelChannelMethodCall(channelId, transportCallId);
      throw err;
    } finally {
      this.streamCallbacks.delete(transportCallId);
      this.recordIfSuspensionStillPending(channelId, transportCallId);
    }
  }

  private async sendDispatchCancel(
    channelId: string,
    callId: string,
    reason: "user-superseded" | "worker-restart" | "user-interrupted"
  ): Promise<void> {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    await this.createChannelClient(channelId).sendSignalEvent(
      participantId,
      "natstack-dispatch-cancel",
      { callId, reason }
    );
  }

  private async notifyDispatchesInterrupted(channelId: string): Promise<void> {
    const pendingCalls = [...this.methodResultWaiters.entries()]
      .filter(([, waiter]) => waiter.channelId === channelId)
      .map(([callId, waiter]) => ({ callId, invocationId: waiter.invocationId }));
    this.abortRecoveryDirectExecutions(channelId, "user_interrupted");
    this.clearRecoveryContinuePending(channelId);
    this.cancelMethodSuspensionsForChannel(channelId, "user_interrupted");
    this.rejectMethodWaitersForChannel(channelId, "Request was aborted");
    const runner = this.runners.get(channelId)?.runner;
    for (const { callId, invocationId } of pendingCalls) {
      try {
        runner?.forgetOpenInvocation(invocationId);
        await this.cancelChannelMethodCall(channelId, callId);
        await this.sendDispatchCancel(channelId, callId, "user-interrupted");
      } catch (err) {
        console.warn(
          `[TrajectoryVesselBase] Failed to cancel dispatch ${callId} on interrupt:`,
          err
        );
      }
    }
  }

  // ── Default channel event handler ────────────────────────────────────────
  //
  // Subclasses MAY override this for custom routing, but the default behavior
  // covers the common case: incoming user messages are forwarded to Pi via the
  // per-channel runner. Pi handles the rest.

  async processChannelEvent(
    channelId: string,
    event: ChannelEvent,
    opts?: { mode?: "auto" | "sequential" }
  ): Promise<void> {
    await this.ensureAgentActivationReady();
    if (!this.shouldProcess(event)) return;
    await this.ensureChannelContext(channelId);
    if (!(await this.shouldRespond(channelId, event))) return;

    const runner = this.runners.get(channelId)!.runner;
    const input = this.buildTurnInput(event);
    // Fall back to the first user message as the display title when no
    // explicit (tool-driven) title has been set and no in-activation title
    // is in flight yet. Heuristic-only — doesn't persist a flag, so a
    // later activation will re-derive from a (possibly more representative)
    // message if no one calls `set_title` in the meantime.
    if (
      this.titleSetForThisActivation === null &&
      input.content &&
      !this.isOwnTitleExplicitlySet()
    ) {
      void this.setOwnTitle(deriveFallbackTitleFromMessage(input.content));
    }
    const images = await this.resizeAttachments(channelId, input.attachments);
    const dispatcher = this.getOrCreateDispatcher(channelId, runner);
    dispatcher.submit({ content: input.content, ...(images ? { images } : {}) }, opts);
  }

  async onChannelEnvelope(
    channelId: string,
    envelope: {
      kind: "log" | "control" | "signal";
      phase?: "replay" | "live";
      event?: ChannelEvent;
      type?: string;
      payload?: unknown;
      senderId?: string;
      ts?: number;
    }
  ): Promise<void> {
    await this.ensureAgentActivationReady();
    if (envelope.kind === "control") {
      if (envelope.type === "ready") this.channelsInReplay.delete(channelId);
      return;
    }
    if (envelope.kind === "log" && envelope.event) {
      if (envelope.phase === "replay") this.channelsInReplay.add(channelId);
      const mode =
        envelope.phase === "replay" || this.channelsInReplay.has(channelId) ? "sequential" : "auto";
      await this.handleIncomingChannelEvent(channelId, envelope.event, { mode });
      return;
    }
    if (envelope.kind === "signal" && envelope.type) {
      await this.handleIncomingChannelEvent(channelId, {
        id: 0,
        messageId: "",
        type: envelope.type,
        payload: envelope.payload,
        senderId: envelope.senderId ?? "system",
        ts: envelope.ts ?? Date.now(),
      });
    }
  }

  /** Resize user-pasted image attachments via the image service extension.
   *  Best-effort: on failure, fall through to the original bytes. */
  private async resizeAttachments(
    channelId: string,
    attachments: Attachment[] | undefined
  ): Promise<ImageContent[] | undefined> {
    if (!attachments || attachments.length === 0) return undefined;
    const images: ImageContent[] = [];
    const imageService = createExtensionsClient(this.rpc).use(IMAGE_SERVICE_EXTENSION);
    for (const att of attachments) {
      if (!att.mimeType?.startsWith("image/")) continue;
      try {
        const bytes = Buffer.from(att.data, "base64");
        const resized = await imageService.resize(bytes, att.mimeType, {
          maxWidth: 2000,
          maxHeight: 2000,
        });
        images.push({
          type: "image",
          mimeType: resized.mimeType,
          data: Buffer.from(resized.data).toString("base64"),
        });
      } catch (err) {
        console.warn(
          `[TrajectoryVesselBase] image-service.resize failed for channel=${channelId}; passing original:`,
          err
        );
        images.push({ type: "image", mimeType: att.mimeType, data: att.data });
      }
    }
    return images.length > 0 ? images : undefined;
  }

  // ── Method calls (subclass hook) ─────────────────────────────────────────

  async onMethodCall(
    _channelId: string,
    _transportCallId: string,
    _methodName: string,
    _args: unknown,
    _metadata?: { invocationId?: string; turnId?: string }
  ): Promise<{ result: unknown; isError?: boolean }> {
    return { result: { error: "not implemented" }, isError: true };
  }

  protected async resumeAfterModelCredentialConnected(
    channelId: string,
    opts?: { providerId?: string; modelBaseUrl?: string }
  ): Promise<boolean> {
    await this.ensureAgentActivationReady();
    await this.ensureChannelContext(channelId);
    const entry = this.runners.get(channelId);
    if (!entry) {
      console.warn(
        `[TrajectoryVesselBase] credential resume failed for channel=${channelId}: runner missing`
      );
      return false;
    }

    const providerId = opts?.providerId ?? this.getModelProviderId(channelId);
    const interruption = this.getModelCredentialInterruption(
      channelId,
      providerId,
      opts?.modelBaseUrl
    );
    const messages = await this.readRunnerMessages(channelId);
    const last = messages[messages.length - 1];
    let resumableMessages: AgentMessage[];
    if (isCredentialRequiredAssistantMessage(last)) {
      resumableMessages = messages.slice(0, -1);
    } else if (
      interruption &&
      interruption.resumeCount > 0 &&
      messages.length >= interruption.resumeCount
    ) {
      resumableMessages = messages.slice(0, interruption.resumeCount);
    } else {
      console.warn(
        `[TrajectoryVesselBase] credential resume failed for channel=${channelId}: ` +
          `no resumable turn provider=${providerId} messages=${messages.length} ` +
          `interruptionCount=${interruption?.resumeCount ?? "none"} lastRole=${String((last as { role?: unknown } | undefined)?.role ?? "none")} ` +
          `lastStop=${String((last as { stopReason?: unknown } | undefined)?.stopReason ?? "none")}`
      );
      return false;
    }

    const resumeFrom = resumableMessages[resumableMessages.length - 1] as
      | { role?: string }
      | undefined;
    if (!resumeFrom || (resumeFrom.role !== "user" && resumeFrom.role !== "toolResult")) {
      console.warn(
        `[TrajectoryVesselBase] credential resume failed for channel=${channelId}: ` +
          `resume cursor is ${String(resumeFrom?.role ?? "missing")}`
      );
      return false;
    }

    const messageEntries = (await entry.runner.session?.getEntries())?.filter(
      (sessionEntry) => sessionEntry.type === "message"
    );
    const target = messageEntries?.[resumableMessages.length - 1];
    if (!target) {
      console.warn(
        `[TrajectoryVesselBase] credential resume failed for channel=${channelId}: ` +
          `session entry missing for messageIndex=${resumableMessages.length - 1} entries=${messageEntries?.length ?? 0}`
      );
      return false;
    }
    await entry.runner.session?.moveTo(target.id);
    this.clearModelCredentialInterruption(channelId, providerId);
    this.credentialPromptCardsEmitted.delete(`${channelId}::model-credential::${providerId}`);
    const dispatcher = this.getOrCreateDispatcher(channelId, entry.runner);
    dispatcher.submitContinue();
    return true;
  }

  /** Interrupt the in-flight Pi turn for every active channel runner. */
  protected async interruptAllRunners(): Promise<void> {
    for (const [channelId] of this.runners.entries()) {
      await this.interruptRunner(channelId, "interrupt-all");
    }
  }

  /** Interrupt the in-flight Pi turn for a specific channel. */
  protected async interruptRunner(
    channelId: string,
    reason: AgentAbortReason = "interrupt-channel"
  ): Promise<void> {
    await this.ensureAgentActivationReady();
    this.abortModelCredentialResolution(channelId, "Model credential resolution aborted by user");
    const entry = this.runners.get(channelId);
    if (entry) {
      // Drop any pending/steered messages — interrupt means the user wants
      // everything stopped, not just the current turn. Dispatcher's reset()
      // also clears pi-core's steering queue and broadcasts typing=false.
      this.dispatchers.get(channelId)?.reset();
      this.lastUserInterruptAt.set(channelId, Date.now());
      await this.notifyDispatchesInterrupted(channelId);
      this.recordAbort(channelId, reason);

      // A provider stream or pi-core promise may be wedged. The user-visible
      // pause operation must still close the durable turn and clear typing;
      // do that synchronously before asking the runner to abort best-effort.
      await entry.runner
        .forceCloseCurrentTurn("user_interrupted", "Agent turn interrupted by user")
        .catch((err) => {
          console.warn(
            `[TrajectoryVesselBase] forceCloseCurrentTurn failed for channel=${channelId}:`,
            err
          );
        });
      void entry.runner.interrupt().catch((err) => {
        console.warn(
          `[TrajectoryVesselBase] runner interrupt failed for channel=${channelId}:`,
          err
        );
      });
    }
  }

  // ── Fork support (Pi-native) ────────────────────────────────────────────

  async canFork(): Promise<{ ok: boolean; subscriptionCount: number; reason?: string }> {
    await this.ensureAgentActivationReady();
    const count = this.sql.exec(`SELECT COUNT(*) as cnt FROM subscriptions`).toArray();
    const n = (count[0]?.["cnt"] as number) ?? 0;
    if (n > 1) {
      return { ok: false, subscriptionCount: n, reason: "multi-channel" };
    }
    return { ok: true, subscriptionCount: n };
  }

  /**
   * Called on the newly cloned agent DO after cloneDO copies parent's SQLite.
   * Rewrites identity, clears signal-only state, resubscribes to forked channel,
   * and forks gad by moving only immutable head pointers.
   */
  async postClone(
    parentObjectKey: string,
    newChannelId: string,
    oldChannelId: string,
    forkAtMessageIndex: number | null
  ): Promise<void> {
    await this.ensureAgentActivationReady();
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey
    );

    this.setStateValue("forkedFrom", parentObjectKey);
    if (forkAtMessageIndex != null) {
      this.setStateValue("forkAtMessageIndex", String(forkAtMessageIndex));
    }
    this.setStateValue("forkSourceChannel", oldChannelId);

    // Clear signal-only state copied from parent.
    this.sql.exec(`DELETE FROM delivery_cursor`);
    if (forkAtMessageIndex != null) {
      this.advanceDeliveryCursor(newChannelId, forkAtMessageIndex);
    }

    await this.forkPiBranchForClone(oldChannelId, newChannelId, forkAtMessageIndex);

    // Rename channel-scoped live setting state keys.
    for (const key of ["approvalLevel", "thinkingLevel", "respondPolicy", "respondFrom"]) {
      const oldKey = `${key}:${oldChannelId}`;
      const newKey = `${key}:${newChannelId}`;
      const value = this.getStateValue(oldKey);
      if (value) {
        this.setStateValue(newKey, value);
        this.deleteStateValue(oldKey);
      }
    }

    // Resubscribe to the forked channel.
    const subRow = this.sql
      .exec(`SELECT context_id, config FROM subscriptions WHERE channel_id = ?`, oldChannelId)
      .toArray();
    const contextId = subRow.length > 0 ? (subRow[0]!["context_id"] as string) : undefined;
    const configRaw = subRow.length > 0 ? (subRow[0]!["config"] as string | null) : null;
    const config = configRaw ? JSON.parse(configRaw) : undefined;

    this.sql.exec(`DELETE FROM subscriptions`);
    // Dispose dispatchers first (releases their runner subscriptions)
    // before wiping the runner map. On a freshly-cloned DO these maps
    // are already empty, but this keeps the teardown order correct if
    // postClone is ever re-entered.
    for (const dispatcher of this.dispatchers.values()) dispatcher.dispose();
    this.dispatchers.clear();
    this.runners.clear();

    if (contextId) {
      await this.subscribeChannel({ channelId: newChannelId, contextId, config, replay: false });
    }

    await this.onPostClone(parentObjectKey, newChannelId, oldChannelId, forkAtMessageIndex);
  }

  protected async onPostClone(
    _parentObjectKey: string,
    _newChannelId: string,
    _oldChannelId: string,
    _forkAtMessageIndex: number | null
  ): Promise<void> {
    // Default: no-op
  }

  protected async onForkRequested(
    _oldChannelId: string,
    _newChannelId: string,
    _forkAtMessageIndex: number | null
  ): Promise<void> {
    // Extension hook for subclasses that maintain additional forkable state.
  }

  private async forkPiBranchForClone(
    oldChannelId: string,
    newChannelId: string,
    forkAtMessageIndex: number | null
  ): Promise<void> {
    await this.gad.call("forkTrajectoryBranch", {
      fromTrajectoryId: gadBranchIdForChannel(oldChannelId),
      fromBranchId: gadBranchIdForChannel(oldChannelId),
      toTrajectoryId: gadBranchIdForChannel(newChannelId),
      toBranchId: gadBranchIdForChannel(newChannelId),
      throughPublishedChannelId: forkAtMessageIndex == null ? null : oldChannelId,
      throughPublishedChannelSeq: forkAtMessageIndex,
      toPublishedChannelId: newChannelId,
      owner: { kind: "agent", id: this.getOwnCanonicalId() },
    });
    await this.onForkRequested(oldChannelId, newChannelId, forkAtMessageIndex);
  }

  private getSuspensionDebugState(channelId?: string): Record<string, unknown> {
    const where = channelId ? "WHERE channel_id = ?" : "";
    const params = channelId ? [channelId] : [];
    const rows = this.sql
      .exec(`SELECT * FROM agent_method_suspensions ${where}`, ...params)
      .toArray()
      .map((row) => this.methodSuspensionRow(row));
    const partialCounts = new Map<string, number>();
    for (const row of this.sql
      .exec(
        `SELECT transport_call_id, COUNT(*) AS count
           FROM agent_method_suspension_updates
           GROUP BY transport_call_id`
      )
      .toArray()) {
      partialCounts.set(row["transport_call_id"] as string, row["count"] as number);
    }
    const latestPartials = new Map<string, unknown>();
    for (const row of this.sql
      .exec(
        `SELECT u.transport_call_id, u.content_json
           FROM agent_method_suspension_updates u
           INNER JOIN (
             SELECT transport_call_id, MAX(seq) AS seq
               FROM agent_method_suspension_updates
               GROUP BY transport_call_id
           ) latest
             ON latest.transport_call_id = u.transport_call_id
            AND latest.seq = u.seq`
      )
      .toArray()) {
      latestPartials.set(
        row["transport_call_id"] as string,
        summarizeDebugValue(this.parseSuspensionJson(row["content_json"] as string))
      );
    }
    const statuses: MethodSuspensionDeliveryStatus[] = [
      "pending",
      "delivered_live",
      "recovering",
      "transcript_admitted",
      "recovered",
      "superseded",
      "cancelled",
      "ignored",
      "stale",
      "dispatch_failed",
      "recovery_error",
    ];
    const byDeliveryStatus = Object.fromEntries(
      statuses.map((status) => [status, rows.filter((row) => row.deliveryStatus === status).length])
    );
    const compact = (row: MethodSuspensionRow) => ({
      callId: row.transportCallId,
      channelId: row.channelId,
      invocationId: row.invocationId,
      modelToolCallId: row.modelToolCallId,
      assistantMessageId: row.assistantMessageId,
      toolCallIndex: row.toolCallIndex,
      toolName: row.toolName,
      kind: row.kind,
      terminalKind: row.terminalKind,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      partialCount: partialCounts.get(row.transportCallId) ?? 0,
      latestPartialSummary: latestPartials.get(row.transportCallId) ?? null,
    });
    const bucket = (status: MethodSuspensionDeliveryStatus) =>
      rows
        .filter((row) => row.deliveryStatus === status)
        .slice(0, DEBUG_RING_LIMIT)
        .map(compact);
    return {
      byDeliveryStatus,
      pending: bucket("pending"),
      delivered_live: bucket("delivered_live"),
      recovering: bucket("recovering"),
      recovered: bucket("recovered"),
      recoveryErrors: rows
        .filter((row) => row.deliveryStatus === "recovery_error")
        .slice(0, DEBUG_RING_LIMIT)
        .map((row) => ({ ...compact(row), error: row.recoveryError })),
      ignoredAfterCancel: bucket("ignored"),
      dispatchFailed: rows
        .filter((row) => row.deliveryStatus === "dispatch_failed")
        .slice(0, DEBUG_RING_LIMIT)
        .map((row) => ({ ...compact(row), error: row.recoveryError })),
      lastActivationTypingCleanup: this.lastActivationTypingCleanup,
    };
  }

  // ── Fetch override ───────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !(this as unknown as { _objectKey?: string })._objectKey) {
      (this as unknown as { _objectKey?: string })._objectKey = decodeURIComponent(segments[0]!);
    }

    this.ensureReady();
    this.ensureBootstrapped();
    await this.ensureAgentActivationReady();

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    const method = segments.slice(1).join("/") || "getState";

    if (method === "__rpc") {
      const body = await request.json();
      const result = await this.rpc.handleIncomingPost(body);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "__event") {
      let args: unknown[] = [];
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const result = this.parseRequestBody(body);
          if (result.error) {
            return new Response(JSON.stringify({ error: result.error }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          args = result.args;
        }
      }
      if (args.length < 2) {
        return new Response(
          JSON.stringify({ error: "__event requires at least [event, payload]" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      const [event, payload, fromId] = args as [string, unknown, string | undefined];
      await this.rpc.handleIncomingPost({ type: "emit", event, payload, fromId: fromId ?? "" });
      return new Response(JSON.stringify({ result: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      let args: unknown[] = [];
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const result = this.parseRequestBody(body);
          if (result.error) {
            return new Response(JSON.stringify({ error: result.error }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          args = result.args;
        }
      }

      const previousCallerId = this._currentRpcCallerId;
      const previousCallerKind = this._currentRpcCallerKind;
      this._currentRpcCallerId = request.headers.get("X-Natstack-Rpc-Caller-Id");
      this._currentRpcCallerKind = request.headers.get("X-Natstack-Rpc-Caller-Kind");
      try {
        if (method === "onChannelEnvelope" && args.length === 2) {
          await this.onChannelEnvelope(
            args[0] as string,
            args[1] as Parameters<this["onChannelEnvelope"]>[1]
          );
          return new Response(JSON.stringify(null), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (method === "processChannelEvent" && args.length === 2) {
          await this.handleIncomingChannelEvent(args[0] as string, args[1] as ChannelEvent);
          return new Response(JSON.stringify(null), {
            headers: { "Content-Type": "application/json" },
          });
        }

        const fn = (this as unknown as Record<string, unknown>)[method];
        if (typeof fn !== "function") {
          return new Response(JSON.stringify({ error: `Unknown method: ${method}` }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        const result = await (fn as (...a: unknown[]) => Promise<unknown>).call(this, ...args);
        return new Response(JSON.stringify(result ?? null), {
          headers: { "Content-Type": "application/json" },
        });
      } finally {
        this._currentRpcCallerId = previousCallerId;
        this._currentRpcCallerKind = previousCallerKind;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  async getDebugState(channelId?: string): Promise<Record<string, unknown>> {
    await this.ensureAgentActivationReady();
    const readTable = (table: string): unknown[] => {
      try {
        return this.sql.exec(`SELECT * FROM ${table}`).toArray();
      } catch (err) {
        return [{ error: err instanceof Error ? err.message : String(err) }];
      }
    };
    const runnerEntries = await Promise.all(
      [...this.runners.entries()]
        .filter(([id]) => !channelId || id === channelId)
        .map(async ([id, entry]) => [id, await entry.runner.getDebugState()] as const)
    );
    const channelFilter = ([id]: [string, unknown]) => !channelId || id === channelId;
    const subscriptionRows = readTable("subscriptions");
    const subscribedChannels = subscriptionRows
      .map((row) => (row as { channel_id?: unknown })["channel_id"])
      .filter((id): id is string => typeof id === "string");
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      requestedChannelId: channelId ?? null,
      branchInfo: subscribedChannels
        .filter((id) => !channelId || id === channelId)
        .map((id) => ({
          channelId: id,
          trajectoryId: gadBranchIdForChannel(id),
          branchId: gadBranchIdForChannel(id),
          contextId: this.subscriptions.getContextId(id),
          participantId: this.subscriptions.getParticipantId(id),
          forkedFrom: this.getStateValue("forkedFrom") ?? null,
          forkAtMessageIndex: this.getStateValue("forkAtMessageIndex") ?? null,
          forkSourceChannel: this.getStateValue("forkSourceChannel") ?? null,
        })),
      persisted: {
        state: readTable("state"),
        doIdentity: readTable("do_identity"),
        subscriptions: subscriptionRows,
        deliveryCursor: readTable("delivery_cursor"),
        modelCredentialInterruptions: readTable("model_credential_interruptions"),
        methodSuspensions: readTable("agent_method_suspensions"),
        methodSuspensionUpdates: readTable("agent_method_suspension_updates"),
        recoveryContinuations: readTable("agent_recovery_continuations"),
      },
      volatile: {
        runners: Object.fromEntries(runnerEntries),
        dispatchers: Object.fromEntries(
          [...this.dispatchers.entries()]
            .filter(([id]) => !channelId || id === channelId)
            .map(([id, dispatcher]) => [id, dispatcher.getDebugState()])
        ),
        streamCallbacks: [...this.streamCallbacks.keys()],
        methodResultWaiters: [...this.methodResultWaiters.entries()].map(([callId, waiter]) => ({
          callId,
          channelId: waiter.channelId,
          invocationId: waiter.invocationId,
          method: waiter.method,
          targetParticipantId: waiter.targetParticipantId ?? null,
          participantHandle: waiter.participantHandle ?? null,
          createdAt: new Date(waiter.createdAt).toISOString(),
          turnId: waiter.turnId ?? null,
          argsSummary: waiter.argsSummary,
        })),
        modelCredentialResolutionAbortControllers: [
          ...this.modelCredentialResolutionAbortControllers.entries(),
        ]
          .filter(([id]) => !channelId || id === channelId)
          .map(([id, controller]) => ({
            channelId: id,
            aborted: controller.signal.aborted,
            reason: controller.signal.reason ? String(controller.signal.reason) : null,
          })),
        recentPhases: this.recentDebugPhases.filter(
          (phase) => !channelId || phase.channelId === channelId
        ),
        recentChannelEvents: this.recentChannelEvents.filter(
          (event) => !channelId || event.channelId === channelId
        ),
        lastErrors: this.lastErrors.filter((error) => !channelId || error.channelId === channelId),
        failedEvents: [...this.failedEvents.entries()],
        channelsInReplay: [...this.channelsInReplay],
        transcriptPoisonedChannels: [...this.transcriptPoisonedChannels],
        transcriptPoisonNotified: [...this.transcriptPoisonNotified],
        credentialPromptCardsEmitted: [...this.credentialPromptCardsEmitted],
        lastUserInterruptAt: [...this.lastUserInterruptAt.entries()],
        suspensions: this.getSuspensionDebugState(channelId),
        cachedRoster: Object.fromEntries([...this.cachedRoster.entries()].filter(channelFilter)),
        cachedParticipants: Object.fromEntries(
          [...this.cachedParticipants.entries()].filter(channelFilter)
        ),
      },
    };
  }

  override async getState(): Promise<Record<string, unknown>> {
    await this.ensureAgentActivationReady();
    const subscriptions = this.sql.exec(`SELECT * FROM subscriptions`).toArray();
    const deliveryCursors = this.sql.exec(`SELECT * FROM delivery_cursor`).toArray();
    return { subscriptions, deliveryCursors };
  }

  // Reference SAFE_TOOL_NAMES_DEFAULT to suppress unused-import warnings;
  // it's exported from the harness package via DEFAULT_SAFE_TOOL_NAMES, but
  // we keep a local reference here for documentation/symmetry.
  protected static readonly _SAFE_TOOL_NAMES_REFERENCE = SAFE_TOOL_NAMES_DEFAULT;
}

function validateAgentMessages(messages: AgentMessage[], source: string): AgentMessage[] {
  for (const [index, message] of messages.entries()) {
    if ((message as { role?: string }).role !== "toolResult") continue;
    const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
    const valid = typeof toolCallId === "string" && toolCallId.length > 0;
    if (!valid) {
      console.error("[TrajectoryVesselBase] Malformed toolResult without toolCallId", {
        source,
        index,
        toolName: (message as { toolName?: unknown }).toolName,
      });
      throw new AgentWorkerError(
        "transcript_shape",
        `Malformed agent transcript: toolResult at ${source}[${index}] is missing toolCallId`
      );
    }
  }
  return trimTrailingEmptyAbortedAssistant(messages);
}

function methodErrorResult(result: unknown): AgentToolResult<any> {
  return {
    content: [{ type: "text", text: resultToAnswerText(result) }],
    details: undefined,
    isError: true,
  } as unknown as AgentToolResult<any>;
}

function toAgentToolResult(result: unknown): AgentToolResult<any> {
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return result as AgentToolResult<any>;
  }
  return {
    content: [{ type: "text", text: resultToAnswerText(result) }],
    details: undefined,
  };
}

function resultToAnswerText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null) {
    const error = (result as { error?: unknown }).error;
    if (typeof error === "string") return error;
    const message = (result as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(result) ?? String(result);
}

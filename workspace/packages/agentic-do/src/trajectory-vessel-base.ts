/**
 * TrajectoryVesselBase — Pi-native agent DO base.
 *
 * Embeds `@earendil-works/pi-agent-core`'s `Agent` in-process via `PiRunner`
 * from `@workspace/harness`. One PiRunner per channel, owned by the DO for
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
  type LifecyclePrepareInput,
  type LifecyclePrepareResult,
  type LifecycleResumeInput,
} from "@workspace/runtime/worker";
import { createExtensionsClient } from "@natstack/extension";
import type {
  Attachment,
  ChannelEvent,
  ParticipantDescriptor,
  TurnInput,
  UnsubscribeResult,
} from "@workspace/harness";
import { isClientParticipantType, type RpcChannelMessage } from "@workspace/pubsub";
import {
  AGENT_INTERRUPTED_BEFORE_TOOL_DISPATCH,
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  LIFECYCLE_RECOVERY_NOTICES,
  assertNoStoredValueRefs,
  hydrateStoredValueRefs,
  lifecycleRecoveryNoticeForMessage,
  messageDisplayText,
  publicParticipantMetadata,
  type AgenticEvent,
  type MessageBlockInput,
  type InvocationOutcome,
  type LifecycleMessageReasonCode,
  type TurnReasonCode,
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
  TurnSuspensionSignal,
  type RunnerEvent,
  type RunnerTurnInput,
  type TurnSnapshot,
} from "@workspace/harness";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { getModel as getPiModel, type ImageContent } from "@earendil-works/pi-ai";

import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";
import { ChannelClient } from "./channel-client.js";
import { TurnDispatcher } from "./turn-dispatcher.js";
import { SuspensionStore, credentialSuspensionId } from "./suspension-store.js";
import { RunController, isTerminalRunPhase } from "./run-controller.js";
import {
  createGadServiceClient,
  type DurableObjectServiceClient,
} from "@natstack/shared/userlandServiceRpc";

const HARNESS_MODEL_REPLAY_TOOL_SAFETY: ReadonlyMap<string, ReplayToolSafety> = new Map([
  ["read", "pure-read"],
  ["ls", "pure-read"],
  ["grep", "pure-read"],
  ["find", "pure-read"],
  ["ask_user", "journal-before-dispatch"],
  ["edit", "unsafe"],
  ["write", "unsafe"],
  ["web_search", "unsafe"],
  ["web_fetch", "unsafe"],
  ["web_read", "unsafe"],
]);
const URL_BOUND_MODEL_CREDENTIAL_SENTINEL = "natstack-url-bound-model-credential";
const URL_BOUND_MODEL_CREDENTIAL_SENTINEL_CLAIM =
  "https://natstack.local/url-bound-model-credential";
const IMAGE_SERVICE_EXTENSION = "@workspace-extensions/image-service";

function objectToNumericKeyBytes(obj: Record<string, unknown>): Buffer | undefined {
  const keys = Object.keys(obj);
  if (keys.length === 0) return undefined;
  if (!keys.every((key) => /^(0|[1-9]\d*)$/.test(key))) return undefined;

  const indexes = keys.map((key) => Number(key)).sort((a, b) => a - b);
  if (indexes[0] !== 0 || indexes[indexes.length - 1] !== keys.length - 1) return undefined;

  const bytes = new Uint8Array(keys.length);
  for (const index of indexes) {
    const byte = obj[String(index)];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return undefined;
    }
    bytes[index] = byte;
  }
  return Buffer.from(bytes);
}

function imageBinaryToBuffer(value: unknown): Buffer {
  if (typeof value === "string") return Buffer.from(value, "base64");
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Buffer.from(value);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj["__bin"] === true && typeof obj["data"] === "string") {
      return Buffer.from(obj["data"], "base64");
    }
    if (obj["type"] === "Buffer" && Array.isArray(obj["data"])) {
      return Buffer.from(obj["data"] as number[]);
    }
    if (Number.isSafeInteger(obj["length"])) {
      return Buffer.from(value as ArrayLike<number>);
    }
    const bytes = objectToNumericKeyBytes(obj);
    if (bytes) return bytes;
  }
  throw new TypeError("Expected image data to be base64 text or binary bytes");
}

function imageBinaryToBase64(value: unknown): string {
  return typeof value === "string" ? value : imageBinaryToBuffer(value).toString("base64");
}

const DEBUG_RING_LIMIT = 80;
const DEBUG_PREVIEW_LIMIT = 240;
const DEBUG_COLLECTION_LIMIT = 16;
const DEBUG_DEPTH_LIMIT = 3;
const MAX_PARTIAL_UPDATES_PER_CALL = 256;
const MAX_INLINE_SUSPENSION_RESULT_BYTES = 256 * 1024;
const EXPECTED_CHANNEL_TOOL_READY_TIMEOUT_MS = 5_000;
const EXPECTED_CHANNEL_TOOL_READY_POLL_MS = 100;
const CLAIM_LOST = Symbol("CLAIM_LOST");
export type RespondPolicy = "all" | "mentioned" | "mentioned-strict" | "from-participants";
type CachedParticipant = Awaited<ReturnType<ChannelClient["getParticipants"]>>[number];
type AgentSettingSource = "state" | "config" | "default";
export type CustomMessageReducer = (state: unknown, update: unknown) => unknown;
type LifecycleRecoveryDiagnostic = {
  type: "lifecycle_recovery";
  status: "recovered" | "interrupted" | "failed";
  title: string;
  detail: string;
  reason: LifecycleMessageReasonCode;
};

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
  if (error instanceof AgentWorkerError && error.code === "transcript_shape") return true;
  return /\bMalformed (?:agent|GAD) (?:append|transcript)\b/.test(String(error));
}

class AgentLifecycleError extends Error {
  outcome: Extract<InvocationOutcome, "stale_dispatch" | "cancelled">;
  reasonCode: string;

  constructor(
    message: string,
    outcome: Extract<InvocationOutcome, "stale_dispatch" | "cancelled">,
    reasonCode: string
  ) {
    super(message);
    this.name = "AgentLifecycleError";
    this.outcome = outcome;
    this.reasonCode = reasonCode;
  }
}

function lifecycleToolResult(error: AgentLifecycleError): AgentToolResult<any> {
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
    details: {
      __natstack_terminal: {
        outcome: error.outcome,
        reasonCode: error.reasonCode,
      },
    },
  } as AgentToolResult<any>;
}

function throwIfAbortSignalAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error(
    typeof reason === "string" && reason.length > 0 ? reason : "Request was aborted"
  );
  error.name = "AbortError";
  throw error;
}

function pushBounded<T>(items: T[], item: T, limit = DEBUG_RING_LIMIT): void {
  items.push(item);
  if (items.length > limit) items.splice(0, items.length - limit);
}

function previewDebugText(value: string, limit = DEBUG_PREVIEW_LIMIT): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function previewText(value: string, limit = DEBUG_PREVIEW_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function summarizeDebugRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, summarizeDebugValue(value)])
  );
}

function summarizeStoredJsonColumns(
  json: string | null,
  refJson: string | null
): Record<string, unknown> {
  if (refJson) {
    try {
      const ref = JSON.parse(refJson) as Record<string, unknown>;
      return {
        storage: "blob",
        digest: ref["digest"] ?? null,
        encoding: ref["encoding"] ?? null,
        size: ref["size"] ?? null,
        originalBytes: ref["originalBytes"] ?? null,
      };
    } catch {
      return { storage: "blob", malformedRef: true, refBytes: refJson.length };
    }
  }
  if (json == null) return { storage: "empty" };
  return {
    storage: "inline",
    bytes: utf8Bytes(json),
    summary: summarizeDebugValue(parseJsonForDebug(json)),
  };
}

function parseJsonForDebug(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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
  const reconnectReason = typeof props.reason === "string" && props.reason.trim() ? props.reason : "";
  const diagnosticReason =
    typeof props.diagnosticReason === "string" && props.diagnosticReason.trim()
      ? props.diagnosticReason
      : "";
  const failureCode =
    typeof props.failureCode === "string" && props.failureCode.trim() ? props.failureCode : "";
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
      if (props.resumeAfterConnect !== false && props.agentParticipantId) {
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
          <Text as="div" size="2" weight="medium">
            {reconnectReason ? "Credential needs refresh for " : "Credential required for "}{providerId}
          </Text>
          <Text as="div" size="1" color="gray" mt="1">
            {reconnectReason ? "Reconnect" : "Connect"} a URL-bound model credential for <Code size="1">{modelBaseUrl || providerId}</Code>.
          </Text>
        </Box>
        {reconnectReason ? (
          <Callout.Root color="amber" size="1">
            <Callout.Text>{reconnectReason}</Callout.Text>
          </Callout.Root>
        ) : null}
        {diagnosticReason || failureCode ? (
          <Box>
            <Text as="div" size="1" color="gray">Diagnostic</Text>
            <Code size="1">
              {failureCode ? failureCode + ": " : ""}{diagnosticReason || "No provider details available."}
            </Code>
          </Box>
        ) : null}
        {unsupported ? (
          <Callout.Root color="amber" size="1">
            <Callout.Text>No built-in OAuth setup is available for this model provider.</Callout.Text>
          </Callout.Root>
        ) : null}
        {status === "done" ? (
          <Callout.Root color="green" size="1">
            <Callout.Text>
              {props.resumeAfterConnect === false ? "Credential connected." : "Credential connected. Continuing..."}
            </Callout.Text>
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
            {status === "done" ? "Connected" : status === "error" ? "Try Again" : reconnectReason ? "Reconnect" : "Internal Browser"}
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

/**
 * Message prefix of the credential-use-approval park (getApiKeyForChannel throws
 * this when resolveCredential is deferred pending a human approval). Like the
 * missing/reconnect cases, the turn must be kept OPEN so the credential resume
 * continues it instead of re-opening (which the GAD store rejects as a duplicate
 * turn.opened). Kept as a shared prefix so the throw and the keep-open predicate
 * can't drift.
 */
const MODEL_CREDENTIAL_APPROVAL_PENDING_PREFIX = "Waiting for model credential approval";

/** How long after a credential park to fire the durable liveness backstop alarm. */
const CREDENTIAL_BACKSTOP_ALARM_MS = 2 * 60 * 1000;

function isModelCredentialApprovalPendingFailure(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.startsWith(MODEL_CREDENTIAL_APPROVAL_PENDING_PREFIX);
  }
  // Also match the assistant-message shape (stopReason "error"), which carries
  // the text under `message` OR `errorMessage` — the form `resolveAfter...`'s
  // rewind matcher inspects.
  if (err && typeof err === "object") {
    const candidate = err as { message?: unknown; errorMessage?: unknown };
    const text =
      typeof candidate.message === "string"
        ? candidate.message
        : typeof candidate.errorMessage === "string"
          ? candidate.errorMessage
          : null;
    if (text) return text.startsWith(MODEL_CREDENTIAL_APPROVAL_PENDING_PREFIX);
  }
  return String(err).startsWith(MODEL_CREDENTIAL_APPROVAL_PENDING_PREFIX);
}

const MODEL_CREDENTIAL_RECONNECT_CODES = new Set([
  "CREDENTIAL_EXPIRED",
  "OAUTH_REFRESH_FAILED",
  "credential-expired",
  "credential_expired_reauth_required",
  "client_not_authorized",
  "invalid_grant",
  "token_exchange_failed",
  "invalid_token_response",
  "client_config_unavailable",
  "oauth-refresh-failed",
]);

const MODEL_CREDENTIAL_RECONNECT_MESSAGE_PATTERNS = [
  /\bauthentication token is expired\b/i,
  /\btoken (?:is )?expired\b/i,
  /\bcredential (?:is )?expired\b/i,
  /\bsign(?:ed)? in again\b/i,
  /\bre-?auth(?:enticate|entication)? required\b/i,
  /\binvalid[_ -]grant\b/i,
  /\bclient[_ -]not[_ -]authorized\b/i,
  /\bunauthori[sz]ed\b/i,
] as const;

interface AgentFailureInfo {
  message: string;
  code?: string;
}

function stringErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && MODEL_CREDENTIAL_RECONNECT_CODES.has(value)
    ? value
    : undefined;
}

function errorCodeFromUnknown(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return stringErrorCode(err);
  const record = err as {
    code?: unknown;
    errorCode?: unknown;
    errorMessage?: unknown;
    error?: { code?: unknown } | unknown;
    cause?: unknown;
  };
  return (
    stringErrorCode(record.code) ??
    stringErrorCode(record.errorCode) ??
    stringErrorCode(record.errorMessage) ??
    (record.error && typeof record.error === "object"
      ? stringErrorCode((record.error as { code?: unknown }).code)
      : undefined) ??
    errorCodeFromUnknown(record.cause)
  );
}

function modelCredentialReconnectFailure(err: unknown): AgentFailureInfo | null {
  const missingCredential = credentialRequiredMessage(err);
  if (missingCredential) return { message: missingCredential, code: "CREDENTIAL_REQUIRED" };
  const code = errorCodeFromUnknown(err);
  const objectMessage =
    err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : undefined;
  const objectErrorMessage =
    err &&
    typeof err === "object" &&
    typeof (err as { errorMessage?: unknown }).errorMessage === "string"
      ? (err as { errorMessage: string }).errorMessage
      : undefined;
  const message =
    err instanceof Error ? err.message : (objectMessage ?? objectErrorMessage ?? String(err));
  if (
    !code &&
    !MODEL_CREDENTIAL_RECONNECT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return null;
  }
  return {
    message: message || code || "Model credential reconnect required",
    ...(code ? { code } : {}),
  };
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
    | {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
        code?: unknown;
        errorCode?: unknown;
      }
    | undefined;
  return (
    candidate?.role === "assistant" &&
    candidate.stopReason === "error" &&
    (!!modelCredentialReconnectFailure(candidate) ||
      isModelCredentialApprovalPendingFailure(candidate))
  );
}

function lastModelCredentialResumePrefix(messages: AgentMessage[]): AgentMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = (messages[index] as { role?: unknown } | undefined)?.role;
    if (role === "user" || role === "toolResult") {
      return messages.slice(0, index + 1);
    }
  }
  return [];
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
type MethodSuspensionTransitionIntent =
  | "terminal_received"
  | "delivered_to_live_waiter"
  | "admitted_to_session"
  | "resume_started"
  | "resume_succeeded"
  | "resume_failed"
  | "already_admitted"
  | "unsafe_to_replay"
  | "superseded"
  | "cancelled"
  | "dispatch_failed"
  | "ignored_terminal";

type AgentTurnRunStatus =
  | "starting"
  | "running_model"
  | "waiting_external"
  | "continuing"
  | "closing"
  | "closed"
  | "failed"
  | "interrupted";

type ReplayToolSafety = "journal-before-dispatch" | "idempotent-by-key" | "pure-read" | "unsafe";

interface AgentTurnRunRow {
  turnId: string;
  channelId: string;
  status: AgentTurnRunStatus;
  resumeCursorEntryId: string | null;
  turnOpenCursorEntryId: string | null;
  modelStartCursorEntryId: string | null;
  checkpointPhase: string | null;
  checkpointEntryId: string | null;
  checkpointGeneration: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  openedAt: number;
  updatedAt: number;
  closedAt: number | null;
}

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
  argsRefJson: string | null;
  sessionLeafBeforeCall: string | null;
  terminalKind: MethodSuspensionTerminalKind;
  resultJson: string | null;
  resultRefJson: string | null;
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

interface RecoveryStaleDiagnostic {
  reason: "invocation closed" | "session branch moved";
  invocationOpen: boolean;
  hasToolResult: boolean;
  sessionLeafBeforeCall?: string | null;
  activeBranchEntryIds?: string[];
  activeBranchEntryIdsError?: string;
  currentBranchTail?: string | null;
  resultEventId?: number | null;
  resultReceivedAt?: number | null;
}

interface AgentDebugError {
  channelId?: string;
  scope: string;
  at: number;
  message: string;
  name?: string;
}

interface AgentInvariantViolation {
  channelId: string;
  code: string;
  at: number;
  detail?: Record<string, unknown>;
  visible: boolean;
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

function failedAgentEndFailure(event: RunnerEvent | undefined): AgentFailureInfo | null {
  if (!event || event.type !== "agent_end") return null;
  const messages = (event as { messages?: unknown[] }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as {
    role?: string;
    stopReason?: string;
    errorMessage?: unknown;
    code?: unknown;
    errorCode?: unknown;
  } | null;
  if (!last || last.role !== "assistant") return null;
  if (last.stopReason !== "error" && last.stopReason !== "aborted") return null;
  const message =
    typeof last.errorMessage === "string" && last.errorMessage.trim()
      ? last.errorMessage
      : last.stopReason === "aborted"
        ? "Runner aborted before model generation completed."
        : "Runner failed before model generation began.";
  const failure = {
    message,
    ...(errorCodeFromUnknown(last) ? { code: errorCodeFromUnknown(last) } : {}),
  };
  if (last.stopReason === "aborted" && !modelCredentialReconnectFailure(failure)) {
    return null;
  }
  return failure;
}

function runnerEventMetadata(event: RunnerEvent | undefined): {
  operationId?: string;
  turnId?: string;
  lifecycleMatched?: boolean;
} {
  return (
    (
      event as
        | { natstack?: { operationId?: string; turnId?: string; lifecycleMatched?: boolean } }
        | undefined
    )?.natstack ?? {}
  );
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
  static override schemaVersion = 15;

  protected identity: DOIdentity;
  /** The single durable spine for parked-turn ("suspended") state. */
  protected suspensions: SuspensionStore;
  protected subscriptions: SubscriptionManager;

  /** One PiRunner per channel — created lazily on first user message. */
  private runners = new Map<string, RunnerEntry>();
  /** Pending runner factory promises, published before async init awaits. */
  private runnerCreations = new Map<string, Promise<PiRunner>>();
  /**
   * Phase 1 shadow projection: the consolidated, channel-scoped run-state owner.
   * Driven from the durable transition chokepoints (`insertTurnRun` /
   * `transitionTurn`) so it always mirrors `agent_turn_runs.status`. Currently a
   * read-through projection; later migration steps make it the sole writer.
   */
  private runControllers = new Map<string, RunController>();

  protected runControllerFor(channelId: string): RunController {
    let controller = this.runControllers.get(channelId);
    if (!controller) {
      controller = new RunController();
      this.runControllers.set(channelId, controller);
    }
    return controller;
  }

  /** Last intentional abort reason per channel, used to annotate pi-core's
   *  generic "Request was aborted" terminal event. */
  private abortContexts = new Map<string, AgentAbortContext>();

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
  /**
   * Credential-deferral requestIds issued but whose interruption row isn't written
   * yet (same activation). Lets onDeferredResult tell a credential deferral from a
   * generic one before the row exists. In-memory is sufficient: if the DO
   * hibernates, getApiKey's init has already completed and written the row, so the
   * row path catches the delivery on wake.
   */
  private inFlightCredentialDeferrals = new Set<string>();
  /** Credential deliveries that arrived before their interruption row was written. */
  private bufferedCredentialDeliveries = new Map<string, { isError: boolean }>();

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
  private readonly recentInvariantViolations: AgentInvariantViolation[] = [];
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
      stream: (
        targetId: string,
        method: string,
        args: unknown[],
        options?: { signal?: AbortSignal }
      ): Promise<Response> => {
        return this.rpc.stream(targetId, method, args, options);
      },
    };
    this.gad = createGadServiceClient(lazyRpc);

    this.identity = new DOIdentity(this.sql);
    this.suspensions = new SuspensionStore(this.sql);
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

  private recordInvariantViolation(
    channelId: string,
    code: string,
    detail?: Record<string, unknown>,
    opts: { visible?: boolean } = {}
  ): void {
    pushBounded(this.recentInvariantViolations, {
      channelId,
      code,
      at: Date.now(),
      visible: opts.visible ?? false,
      ...(detail ? { detail: summarizeDebugRecord(detail) } : {}),
    });
    this.recordDebugPhase(channelId, `invariant.${code}`, detail);
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

  private async encodeSuspensionStorage(
    value: unknown
  ): Promise<{ json: string | null; refJson: string | null }> {
    if (value === undefined) return { json: null, refJson: null };
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch {
      json = JSON.stringify(summarizeDebugValue(value));
    }
    if (utf8Bytes(json) <= MAX_INLINE_SUSPENSION_RESULT_BYTES) {
      return { json, refJson: null };
    }

    try {
      const blob = await this.rpc.call<{ digest: string; size: number }>(
        "main",
        "blobstore.putText",
        [json]
      );
      const ref = {
        protocol: "natstack.blob-ref.v1",
        digest: blob.digest,
        size: blob.size,
        encoding: "json",
        originalBytes: utf8Bytes(json),
      };
      return { json: null, refJson: JSON.stringify(ref) };
    } catch (err) {
      this.recordLastError("channel_method.suspension.result_blob", err);
      return {
        json: JSON.stringify({
          omitted: true,
          reason: "large suspension result could not be stored",
          originalBytes: utf8Bytes(json),
        }),
        refJson: null,
      };
    }
  }

  private parseSuspensionJson(value: string | null, refValue?: string | null): unknown {
    if (refValue != null) return this.parseSuspensionJson(refValue);
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
      argsRefJson: (row["args_ref_json"] as string | null) ?? null,
      sessionLeafBeforeCall: (row["session_leaf_before_call"] as string | null) ?? null,
      terminalKind: row["terminal_kind"] as MethodSuspensionTerminalKind,
      resultJson: (row["result_json"] as string | null) ?? null,
      resultRefJson: (row["result_ref_json"] as string | null) ?? null,
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

  private turnRunRow(raw: Record<string, unknown>): AgentTurnRunRow {
    return {
      turnId: raw["turn_id"] as string,
      channelId: raw["channel_id"] as string,
      status: raw["status"] as AgentTurnRunStatus,
      resumeCursorEntryId: (raw["resume_cursor_entry_id"] as string | null) ?? null,
      turnOpenCursorEntryId: (raw["turn_open_cursor_entry_id"] as string | null) ?? null,
      modelStartCursorEntryId: (raw["model_start_cursor_entry_id"] as string | null) ?? null,
      checkpointPhase: (raw["checkpoint_phase"] as string | null) ?? null,
      checkpointEntryId: (raw["checkpoint_entry_id"] as string | null) ?? null,
      checkpointGeneration:
        typeof raw["checkpoint_generation"] === "number"
          ? (raw["checkpoint_generation"] as number)
          : null,
      failureCode: (raw["failure_code"] as string | null) ?? null,
      failureMessage: (raw["failure_message"] as string | null) ?? null,
      openedAt: Number(raw["opened_at"]),
      updatedAt: Number(raw["updated_at"]),
      closedAt: typeof raw["closed_at"] === "number" ? (raw["closed_at"] as number) : null,
    };
  }

  private loadTurnRun(turnId: string): AgentTurnRunRow | null {
    const rows = this.sql.exec(`SELECT * FROM agent_turn_runs WHERE turn_id = ?`, turnId).toArray();
    return rows.length > 0 ? this.turnRunRow(rows[0]!) : null;
  }

  private currentTurnRunForChannel(channelId: string): AgentTurnRunRow | null {
    const rows = this.sql
      .exec(
        `SELECT * FROM agent_turn_runs
         WHERE channel_id = ?
           AND status NOT IN ('closed', 'failed', 'interrupted')
         ORDER BY opened_at DESC
         LIMIT 1`,
        channelId
      )
      .toArray();
    return rows.length > 0 ? this.turnRunRow(rows[0]!) : null;
  }

  private channelHasNonTerminalTurnRuns(channelId: string): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM agent_turn_runs
           WHERE channel_id = ?
             AND status NOT IN ('closed', 'failed', 'interrupted')
           LIMIT 1`,
          channelId
        )
        .toArray().length > 0
    );
  }

  private hasAnyNonTerminalTurnRuns(): boolean {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM agent_turn_runs
           WHERE status NOT IN ('closed', 'failed', 'interrupted')
           LIMIT 1`
        )
        .toArray().length > 0
    );
  }

  private insertTurnRun(
    channelId: string,
    turnId: string,
    checkpoint?: { entryId?: string | null; phase?: "turn_open" | "model_start" }
  ): Promise<void> {
    const now = Date.now();
    const checkpointEntryId = checkpoint?.entryId ?? null;
    const phase = checkpoint?.phase ?? "turn_open";
    const generation = this.identity.bootGeneration;
    this.sql.exec(
      `INSERT INTO agent_turn_runs (
         turn_id, channel_id, status, resume_cursor_entry_id,
         turn_open_cursor_entry_id, model_start_cursor_entry_id,
         checkpoint_phase, checkpoint_entry_id, checkpoint_generation,
         failure_code, failure_message, opened_at, updated_at, closed_at
       ) VALUES (?, ?, 'starting', NULL, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, NULL)
       ON CONFLICT(turn_id) DO NOTHING`,
      turnId,
      channelId,
      checkpointEntryId,
      phase,
      checkpointEntryId,
      generation,
      now,
      now
    );
    // Phase 1 shadow projection: a freshly-opened turn starts at `starting`.
    this.runControllerFor(channelId).projectNewTurn(turnId);
    const leaseActive = this.markCheckpointableWorkActive({ channelId, turnId }).catch((err) => {
      // Persistent failure (after retries) means this turn is running UNLEASED —
      // it won't get prepare/resume on a restart. Surface it loudly rather than
      // swallowing silently, so it's visible instead of a silent recovery gap.
      this.recordLastError("lifecycle.lease_active", err, channelId);
      console.warn(
        `[TrajectoryVesselBase] lease registration failed for channel=${channelId} turn=${turnId} — ` +
          `turn is running UNLEASED and will not recover across a restart: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    });
    this.ctx.waitUntil?.(leaseActive);
    return leaseActive;
  }

  private async captureTurnCheckpoint(
    channelId: string,
    turnId: string,
    runner: Pick<PiRunner, "session"> | undefined,
    phase: "turn_open" | "model_start"
  ): Promise<string | null> {
    let entryId: string | null = null;
    try {
      entryId = (await runner?.session?.getLeafId?.()) ?? null;
    } catch (err) {
      this.recordLastError(`turn_checkpoint.${phase}`, err, channelId);
    }
    this.recordTurnCheckpoint(turnId, phase, entryId);
    return entryId;
  }

  private recordTurnCheckpoint(
    turnId: string,
    phase: "turn_open" | "model_start",
    entryId: string | null
  ): void {
    const now = Date.now();
    this.sql.exec(
      `UPDATE agent_turn_runs
       SET turn_open_cursor_entry_id = CASE WHEN ? = 'turn_open' THEN ? ELSE turn_open_cursor_entry_id END,
           model_start_cursor_entry_id = CASE WHEN ? = 'model_start' THEN ? ELSE model_start_cursor_entry_id END,
           checkpoint_phase = ?,
           checkpoint_entry_id = ?,
           checkpoint_generation = ?,
           updated_at = ?
       WHERE turn_id = ?`,
      phase,
      entryId,
      phase,
      entryId,
      phase,
      entryId,
      this.identity.bootGeneration,
      now,
      turnId
    );
  }

  private recordResumeAttemptOnce(
    turnId: string,
    generation: number | null,
    reason: string
  ): boolean {
    if (generation === null) return true;
    const inserted = this.sql
      .exec(
        `INSERT OR IGNORE INTO agent_turn_resume_attempts
           (turn_id, generation, reason, attempted_at)
         VALUES (?, ?, ?, ?)
         RETURNING turn_id`,
        turnId,
        generation,
        reason,
        Date.now()
      )
      .toArray();
    return inserted.length === 1;
  }

  private transitionTurn(
    turnId: string,
    expectedFrom: AgentTurnRunStatus[],
    to: AgentTurnRunStatus,
    fields: {
      resumeCursorEntryId?: string | null;
      failureCode?: string | null;
      failureMessage?: string | null;
    } = {}
  ): boolean {
    const current = this.loadTurnRun(turnId);
    if (!current) return false;
    if (current.status === to) return true;
    // Check the caller's expected-from set BEFORE asserting legality: a turn
    // that has raced to another state (e.g. terminal via a concurrent
    // interrupt) is a benign no-op for callers using the boolean return, not
    // an illegal-transition error. Mirrors markSuspensionDeliveryStatus.
    if (!expectedFrom.includes(current.status)) return false;
    this.assertTurnTransition(current.status, to);
    const now = Date.now();
    const placeholders = expectedFrom.map(() => "?").join(", ");
    const updated = this.sql
      .exec(
        `UPDATE agent_turn_runs
           SET status = ?,
               resume_cursor_entry_id = CASE WHEN ? = 1 THEN ? ELSE resume_cursor_entry_id END,
               failure_code = CASE WHEN ? = 1 THEN ? ELSE failure_code END,
               failure_message = CASE WHEN ? = 1 THEN ? ELSE failure_message END,
               updated_at = ?,
               closed_at = CASE WHEN ? IN ('closed', 'failed', 'interrupted') THEN ? ELSE closed_at END
         WHERE turn_id = ?
           AND status IN (${placeholders})
         RETURNING turn_id`,
        to,
        fields.resumeCursorEntryId !== undefined ? 1 : 0,
        fields.resumeCursorEntryId ?? null,
        fields.failureCode !== undefined ? 1 : 0,
        fields.failureCode ?? null,
        fields.failureMessage !== undefined ? 1 : 0,
        fields.failureMessage ?? null,
        now,
        to,
        now,
        turnId,
        ...expectedFrom
      )
      .toArray();
    const changed = updated.length === 1;
    if (changed) {
      // Phase 1 shadow projection: mirror the authoritative durable status.
      this.runControllerFor(current.channelId).project(turnId, to);
    }
    if (
      changed &&
      (to === "closed" || to === "failed" || to === "interrupted") &&
      !this.hasAnyNonTerminalTurnRuns()
    ) {
      const leaseInactive = this.markCheckpointableWorkInactive().catch((err) => {
        this.recordLastError("lifecycle.lease_inactive", err, current.channelId);
      });
      this.ctx.waitUntil?.(leaseInactive);
    }
    return changed;
  }

  private assertTurnTransition(from: AgentTurnRunStatus, to: AgentTurnRunStatus): void {
    const terminal: AgentTurnRunStatus[] = ["closed", "failed", "interrupted"];
    if (from === to) return;
    if (terminal.includes(from)) throw new Error(`illegal turn transition ${from} -> ${to}`);
    const allowed: Record<AgentTurnRunStatus, AgentTurnRunStatus[]> = {
      starting: ["running_model", "waiting_external", "continuing", "failed", "interrupted"],
      running_model: ["waiting_external", "continuing", "closing", "failed", "interrupted"],
      waiting_external: ["continuing", "running_model", "failed", "interrupted"],
      continuing: ["running_model", "waiting_external", "closing", "failed", "interrupted"],
      closing: ["closed", "failed", "interrupted"],
      closed: ["closed"],
      failed: ["failed"],
      interrupted: ["interrupted"],
    };
    if (allowed[from]?.includes(to)) return;
    throw new Error(`illegal turn transition ${from} -> ${to}`);
  }

  private turnHasOpenExternalWait(turnId: string): boolean {
    const turn = this.loadTurnRun(turnId);
    if (
      !turn ||
      turn.status === "closed" ||
      turn.status === "failed" ||
      turn.status === "interrupted"
    ) {
      return false;
    }
    const suspension = this.sql
      .exec(
        `SELECT 1 FROM agent_method_suspensions
         WHERE turn_id = ?
           AND terminal_kind = 'none'
           AND delivery_status IN ('pending', 'delivered_live', 'recovering')
         LIMIT 1`,
        turnId
      )
      .toArray();
    if (suspension.length > 0) return true;
    // A credential wait keeps the turn parked too; it lives on the suspension spine.
    return this.suspensions.hasOpenSuspensionForTurn(turnId);
  }

  private latestResolvedSuspensionEntryId(turnId: string): string | null {
    const rows = this.sql
      .exec(
        `SELECT COALESCE(admitted_entry_id, recovered_entry_id) AS entry_id
         FROM agent_method_suspensions
         WHERE turn_id = ?
           AND COALESCE(admitted_entry_id, recovered_entry_id) IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 1`,
        turnId
      )
      .toArray();
    return rows.length > 0 ? ((rows[0]!["entry_id"] as string | null) ?? null) : null;
  }

  private async recoverFromTurnLedger(channelId: string, runner: PiRunner): Promise<boolean> {
    await this.drainTurnOutbox(channelId, runner);
    const rows = this.sql
      .exec(
        `SELECT * FROM agent_turn_runs
         WHERE channel_id = ?
           AND status NOT IN ('closed', 'failed', 'interrupted')
         ORDER BY opened_at ASC`,
        channelId
      )
      .toArray()
      .map((row) => this.turnRunRow(row));
    if (rows.length === 0) {
      // Missed terminals are recovered from replayed invocation.* log events
      // (the control:ready hook), not a channel side-table read-back.
      await this.sweepStuckDelivery(channelId, runner);
      const recovered = await this.recoverDeliveredAndOrphanedSuspensions(channelId);
      return this.recoverOrphanedPendingSteering(channelId, runner) || recovered;
    }
    let submittedContinue = false;
    for (const row of rows) {
      switch (row.status) {
        case "starting": {
          if (this.turnHasOpenExternalWait(row.turnId)) {
            this.transitionTurn(row.turnId, ["starting"], "waiting_external");
          } else if (
            await this.tryReplayInterruptedModelTurn(
              channelId,
              runner,
              row,
              row.turnOpenCursorEntryId,
              "starting_replay"
            )
          ) {
            submittedContinue = true;
          } else {
            this.transitionTurn(row.turnId, ["starting"], "interrupted", {
              failureCode: "runner_restarted_before_model",
              failureMessage: "Runner restarted before model generation began.",
            });
            await this.enqueueTurnOutbox({
              channelId,
              turnId: row.turnId,
              kind: "emit_diagnostic",
              dedupKey: "starting-interrupted",
              payload: {
                message: LIFECYCLE_RECOVERY_NOTICES.runner_restarted_before_model.message,
              },
            });
            await this.drainTurnOutbox(channelId, runner);
          }
          break;
        }
        case "waiting_external": {
          // Missed terminals are recovered from replayed invocation.* log events
          // (the control:ready hook); just sweep + recover from the local ledger.
          await this.sweepStuckDelivery(channelId, runner);
          const recovered = await this.recoverDeliveredAndOrphanedSuspensions(channelId);
          submittedContinue = submittedContinue || recovered;
          if (!this.turnHasOpenExternalWait(row.turnId)) {
            const cursor = this.latestResolvedSuspensionEntryId(row.turnId);
            if (cursor) {
              this.transitionTurn(row.turnId, ["waiting_external"], "continuing", {
                resumeCursorEntryId: cursor,
              });
            } else {
              this.transitionTurn(row.turnId, ["waiting_external"], "failed", {
                failureCode: "external_wait_unrecoverable",
                failureMessage: "External wait resolved without a resumable cursor.",
              });
              await this.enqueueTurnOutbox({
                channelId,
                turnId: row.turnId,
                kind: "emit_diagnostic",
                dedupKey: "external-wait-unrecoverable",
                payload: {
                  message: "External wait resolved without a resumable cursor.",
                },
              });
              await this.drainTurnOutbox(channelId, runner);
            }
          }
          break;
        }
        case "continuing": {
          if (row.resumeCursorEntryId) {
            const entries = await runner.session?.getEntries();
            const target = entries?.find((entry) => entry.id === row.resumeCursorEntryId);
            if (!target) {
              this.transitionTurn(row.turnId, ["continuing"], "failed", {
                failureCode: "invalid_resume_cursor",
                failureMessage: `Recovery cursor ${row.resumeCursorEntryId} was not found.`,
              });
              await this.enqueueTurnOutbox({
                channelId,
                turnId: row.turnId,
                kind: "emit_diagnostic",
                dedupKey: "invalid-resume-cursor",
                payload: {
                  message: "Agent recovery cursor was missing; the turn cannot continue.",
                },
              });
              await this.drainTurnOutbox(channelId, runner);
              break;
            }
            await runner.session?.moveTo(target.id);
          }
          this.recordDebugPhase(channelId, "turn_ledger.continuing_recovered", {
            turnId: row.turnId,
          });
          if (this.recordResumeAttemptOnce(row.turnId, this.identity.bootGeneration, "ledger")) {
            this.submitRecoveryContinue(
              channelId,
              runner,
              "ledger_continuing_recovered",
              row.turnId
            );
            submittedContinue = true;
          } else {
            this.recordDebugPhase(channelId, "turn_ledger.continuing_duplicate_resume_skipped", {
              turnId: row.turnId,
              generation: this.identity.bootGeneration,
            });
          }
          break;
        }
        case "running_model": {
          if (
            await this.tryReplayInterruptedModelTurn(
              channelId,
              runner,
              row,
              row.modelStartCursorEntryId ?? row.checkpointEntryId,
              "running_model_replay"
            )
          ) {
            submittedContinue = true;
          } else {
            this.transitionTurn(row.turnId, ["running_model"], "interrupted", {
              failureCode: "runner_restarted_mid_model",
              failureMessage: "Runner restarted during model generation.",
            });
            await this.enqueueTurnOutbox({
              channelId,
              turnId: row.turnId,
              kind: "emit_diagnostic",
              dedupKey: "running-model-interrupted",
              payload: {
                message: LIFECYCLE_RECOVERY_NOTICES.runner_restarted_mid_model.message,
              },
            });
            await this.drainTurnOutbox(channelId, runner);
          }
          break;
        }
        case "closing": {
          await this.enqueueTurnOutbox({
            channelId,
            turnId: row.turnId,
            kind: "close_turn_projection",
            dedupKey: "close-turn-projection",
          });
          await this.drainTurnOutbox(channelId, runner);
          this.transitionTurn(row.turnId, ["closing"], "closed");
          break;
        }
        case "closed":
        case "failed":
        case "interrupted":
          break;
      }
    }
    return this.recoverOrphanedPendingSteering(channelId, runner) || submittedContinue;
  }

  private async tryReplayInterruptedModelTurn(
    channelId: string,
    runner: PiRunner,
    row: AgentTurnRunRow,
    cursorEntryId: string | null,
    reason: string
  ): Promise<boolean> {
    if (!this.canReplayInterruptedModelTurn()) return false;
    const safety = this.replayToolSurfaceSafety(channelId);
    if (!safety.safe) {
      this.recordDebugPhase(channelId, "turn_ledger.model_replay_unsafe_tool_surface", {
        turnId: row.turnId,
        status: row.status,
        unsafeTools: safety.unsafeTools,
        reason,
      });
      return false;
    }
    if (!cursorEntryId) {
      this.recordDebugPhase(channelId, "turn_ledger.model_replay_missing_cursor", {
        turnId: row.turnId,
        status: row.status,
        reason,
      });
      return false;
    }
    const entries = await runner.session?.getEntries?.();
    const target = entries?.find((entry) => entry.id === cursorEntryId);
    if (!target) {
      this.recordDebugPhase(channelId, "turn_ledger.model_replay_invalid_cursor", {
        turnId: row.turnId,
        status: row.status,
        cursorEntryId,
        reason,
      });
      return false;
    }
    await runner.session?.moveTo?.(target.id);
    const transitioned = this.transitionTurn(row.turnId, [row.status], "continuing", {
      resumeCursorEntryId: target.id,
    });
    if (!transitioned) return false;
    if (!this.recordResumeAttemptOnce(row.turnId, this.identity.bootGeneration, reason)) {
      this.recordDebugPhase(channelId, "turn_ledger.model_replay_duplicate_skipped", {
        turnId: row.turnId,
        generation: this.identity.bootGeneration,
        reason,
      });
      return false;
    }
    this.recordDebugPhase(channelId, "turn_ledger.model_replay_submitted", {
      turnId: row.turnId,
      cursorEntryId: target.id,
      status: row.status,
      generation: this.identity.bootGeneration,
      reason,
    });
    this.submitRecoveryContinue(channelId, runner, reason, row.turnId);
    return true;
  }

  private assertSuspensionTransition(
    from: MethodSuspensionDeliveryStatus,
    to: MethodSuspensionDeliveryStatus,
    intent: MethodSuspensionTransitionIntent
  ): void {
    const allowed: Record<MethodSuspensionDeliveryStatus, MethodSuspensionDeliveryStatus[]> = {
      pending: [
        "delivered_live",
        "recovering",
        "superseded",
        "cancelled",
        "dispatch_failed",
        "ignored",
      ],
      delivered_live: [
        "recovering",
        "transcript_admitted",
        "superseded",
        "cancelled",
        "delivered_live",
      ],
      recovering: ["recovered", "stale", "recovery_error", "delivered_live", "cancelled"],
      transcript_admitted: ["transcript_admitted"],
      recovered: ["recovered"],
      superseded: ["superseded"],
      cancelled: ["ignored", "cancelled"],
      ignored: ["ignored"],
      stale: ["stale"],
      dispatch_failed: ["dispatch_failed"],
      recovery_error: ["recovery_error", "recovering"],
    };
    if (allowed[from]?.includes(to)) return;
    throw new Error(`illegal method suspension transition ${from} -> ${to} (${intent})`);
  }

  private markSuspensionDeliveryStatus(
    callId: string,
    from: MethodSuspensionDeliveryStatus,
    to: MethodSuspensionDeliveryStatus,
    intent: MethodSuspensionTransitionIntent,
    opts: { recoveryError?: string | null; recoveredEntryId?: string | null } = {}
  ): boolean {
    const row = this.loadMethodSuspension(callId);
    if (!row) return false;
    if (row.deliveryStatus === to) return true;
    if (row.deliveryStatus !== from) return false;
    this.assertSuspensionTransition(from, to, intent);
    const now = Date.now();
    const updated = this.sql
      .exec(
        `UPDATE agent_method_suspensions
         SET delivery_status = ?,
             recovery_error = CASE WHEN ? = 1 THEN ? ELSE recovery_error END,
             recovered_entry_id = COALESCE(?, recovered_entry_id),
             updated_at = ?
         WHERE transport_call_id = ? AND delivery_status = ?
         RETURNING transport_call_id`,
        to,
        opts.recoveryError !== undefined ? 1 : 0,
        opts.recoveryError ?? null,
        opts.recoveredEntryId ?? null,
        now,
        callId,
        from
      )
      .toArray();
    return updated.length === 1;
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
    const resolvedTurnId =
      opts.turnId ?? open?.turnId ?? this.currentTurnIdForChannel(opts.channelId);
    if (!resolvedTurnId) {
      throw new Error(
        `Cannot record ${opts.kind} suspension ${opts.transportCallId} without a turn_id`
      );
    }
    let sessionLeafBeforeCall: string | null = null;
    try {
      sessionLeafBeforeCall = (await runner?.session?.getLeafId()) ?? null;
    } catch (err) {
      this.recordLastError("channel_method.suspension.leaf", err, opts.channelId);
    }
    const now = Date.now();
    const argsStorage = await this.encodeSuspensionStorage(opts.args);
    this.sql.exec(
      `INSERT OR REPLACE INTO agent_method_suspensions (
         transport_call_id, channel_id, invocation_id, model_tool_call_id,
         assistant_message_id, tool_call_index, tool_name, turn_id, kind, method,
         participant_handle, target_participant_id, args_json, args_ref_json, session_leaf_before_call,
         terminal_kind, delivery_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 'pending', ?, ?)`,
      opts.transportCallId,
      opts.channelId,
      opts.invocationId,
      open?.modelToolCallId ?? opts.invocationId,
      open?.messageId ?? null,
      open?.blockIndex ?? null,
      open?.name ?? opts.fallbackToolName ?? opts.method,
      resolvedTurnId,
      opts.kind,
      opts.method,
      opts.participantHandle ?? null,
      opts.targetParticipantId ?? null,
      argsStorage.json,
      argsStorage.refJson,
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

  private async markMethodSuspensionTerminal(
    callId: string,
    opts: {
      terminalKind: Exclude<MethodSuspensionTerminalKind, "none">;
      result: unknown;
      isError: boolean;
      eventId?: number;
      waiterPresent: boolean;
    }
  ): Promise<void> {
    const resultStorage = await this.encodeSuspensionStorage(opts.result);
    this.sql.exec(
      `UPDATE agent_method_suspensions
         SET terminal_kind = CASE WHEN terminal_kind = 'none' THEN ? ELSE terminal_kind END,
             result_json = CASE WHEN terminal_kind = 'none' THEN ? ELSE result_json END,
             result_ref_json = CASE WHEN terminal_kind = 'none' THEN ? ELSE result_ref_json END,
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
      resultStorage.json,
      resultStorage.refJson,
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
             result_ref_json = NULL,
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
             result_ref_json = NULL,
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
             result_ref_json = NULL,
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
    const row = this.loadMethodSuspension(callId);
    if (!row) return;
    this.markSuspensionDeliveryStatus(callId, row.deliveryStatus, "recovered", "resume_succeeded", {
      recoveredEntryId: entryId,
    });
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
    const row = this.loadMethodSuspension(callId);
    if (!row) return;
    this.markSuspensionDeliveryStatus(callId, row.deliveryStatus, "stale", "unsafe_to_replay", {
      recoveryError: reason,
    });
    this.deletePartials(callId);
  }

  private markRecoveryError(callId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const row = this.loadMethodSuspension(callId);
    if (!row) return;
    this.markSuspensionDeliveryStatus(
      callId,
      row.deliveryStatus,
      "recovery_error",
      "resume_failed",
      {
        recoveryError: message,
      }
    );
  }

  private extractResumeToolInput(row: MethodSuspensionRow): unknown {
    const args = this.parseSuspensionJson(row.argsJson, row.argsRefJson);
    if (args && typeof args === "object" && "resumeToolInput" in args) {
      return (args as { resumeToolInput?: unknown }).resumeToolInput ?? {};
    }
    return {};
  }

  private async enqueueRecoveredUiPromptRepliesForInvocation(
    channelId: string,
    invocationId: string
  ): Promise<void> {
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
      // Results are stored ref-preserving in the ledger, so hydrate at this
      // model/tool-visible boundary (mirroring composeRecoveredToolResult)
      // before replaying the reply — otherwise a spilled UI-prompt reply
      // would be fed back to the resumed tool as a raw blob ref.
      this.enqueueRecoveredUiPromptReply(
        channelId,
        invocationId,
        await this.hydrateStoredTransportValue(
          this.parseSuspensionJson(row.resultJson, row.resultRefJson)
        ),
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
    const result = await this.hydrateStoredTransportValue(
      this.parseSuspensionJson(row.resultJson, row.resultRefJson),
      `recovered suspension channel=${channelId} invocation=${row.invocationId} call=${row.transportCallId}`
    );
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

    await this.enqueueRecoveredUiPromptRepliesForInvocation(channelId, row.invocationId);
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
  ): Promise<RecoveryStaleDiagnostic | null> {
    const invocationOpen = runner.isInvocationOpen(row.invocationId);
    const hasToolResult = await runner.hasToolResult(row.invocationId);
    if (!invocationOpen && hasToolResult) {
      return {
        reason: "invocation closed",
        invocationOpen,
        hasToolResult,
        sessionLeafBeforeCall: row.sessionLeafBeforeCall,
        resultEventId: row.resultEventId,
        resultReceivedAt: row.resultReceivedAt,
      };
    }
    if (!invocationOpen && row.sessionLeafBeforeCall) {
      const onActiveBranch = await runner.isLeafDescendantOf(row.sessionLeafBeforeCall);
      if (!onActiveBranch) {
        let activeBranchEntryIds: string[] = [];
        let activeBranchEntryIdsError: string | undefined;
        try {
          activeBranchEntryIds = await runner.getSessionBranchEntryIds();
        } catch (err) {
          this.recordLastError("channel_method.recovery.branch_entry_ids", err);
          activeBranchEntryIdsError = err instanceof Error ? err.message : String(err);
        }
        return {
          reason: "session branch moved",
          invocationOpen,
          hasToolResult,
          sessionLeafBeforeCall: row.sessionLeafBeforeCall,
          activeBranchEntryIds,
          ...(activeBranchEntryIdsError ? { activeBranchEntryIdsError } : {}),
          currentBranchTail: activeBranchEntryIds[activeBranchEntryIds.length - 1] ?? null,
          resultEventId: row.resultEventId,
          resultReceivedAt: row.resultReceivedAt,
        };
      }
    }
    return null;
  }

  private async emitRecoveryStaleDiagnostic(
    channelId: string,
    row: MethodSuspensionRow,
    diagnostic: RecoveryStaleDiagnostic
  ): Promise<void> {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const channel = this.createChannelClient(channelId);
    const descriptor = this.getParticipantInfo(channelId, this.subscriptions.getConfig(channelId));
    const messageId = crypto.randomUUID();
    const content =
      `Tool result could not be safely resumed after runner recovery: ${diagnostic.reason}. ` +
      `Invocation ${row.invocationId} completed outside the active transcript branch.`;
    await channel
      .send(participantId, messageId, content, {
        senderMetadata: {
          ...descriptor.metadata,
          name: descriptor.name,
          type: descriptor.type,
          handle: descriptor.handle,
        },
        idempotencyKey: `method-recovery-stale:${channelId}:${row.transportCallId}`,
      })
      .catch((err) => {
        console.error(
          `[TrajectoryVesselBase] Failed to emit recovery diagnostic for channel=${channelId} call=${row.transportCallId}:`,
          err
        );
      });
  }

  private runOnChannelRecoveryChain(channelId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.recoveryChainByChannel.get(channelId) ?? Promise.resolve();
    const next = prev
      .catch((err) => {
        this.recordLastError("channel_method.recovery.previous_failed", err, channelId);
        this.recordDebugPhase(channelId, "channel_method.recovery.previous_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .then(fn);
    this.recoveryChainByChannel.set(channelId, next);
    return next;
  }

  private async recoverDeliveredAndOrphanedSuspensions(channelId: string): Promise<boolean> {
    if (this.transcriptPoisonedChannels.has(channelId)) {
      this.recordDebugPhase(channelId, "channel_method.recovery.skipped_poisoned");
      return false;
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
    if (invocationIds.length === 0) return false;

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
    if (chosen.length === 0) return false;

    const runner = await this.getOrCreateRunner(channelId);
    let admitted = 0;
    let resumeTurnId: string | undefined;
    let resumeCursorEntryId: string | null = null;
    for (const row of chosen) {
      if (!row.turnId) {
        this.markStale(row.transportCallId, "missing_turn_metadata");
        continue;
      }
      if (!this.claimGroupForRecovery(channelId, row.invocationId, row.transportCallId)) continue;
      const staleDiagnostic = await this.preflightRecoveredSuspension(runner, row);
      if (staleDiagnostic) {
        this.markStale(row.transportCallId, staleDiagnostic.reason);
        await this.emitRecoveryStaleDiagnostic(channelId, row, staleDiagnostic);
        this.recordDebugPhase(channelId, "channel_method.recovery.stale", {
          callId: row.transportCallId,
          invocationId: row.invocationId,
          reason: staleDiagnostic.reason,
          diagnostic: staleDiagnostic,
        });
        continue;
      }
      try {
        const recovered = await this.composeRecoveredToolResult(channelId, runner, row);
        const entryId = await runner.appendToolResult(
          this.toolResultMessageForAdmission(
            recovered,
            `recovered tool result channel=${channelId} invocation=${row.invocationId}`
          )
        );
        this.markResumeInternalSuspensionsSuperseded(
          channelId,
          row.invocationId,
          row.transportCallId
        );
        this.markRecovered(row.transportCallId, entryId);
        this.deletePartialsForInvocation(channelId, row.invocationId);
        admitted++;
        resumeTurnId ??= row.turnId;
        resumeCursorEntryId ??= entryId;
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
      if (resumeTurnId) {
        this.transitionTurn(resumeTurnId, ["waiting_external"], "continuing", {
          resumeCursorEntryId,
        });
      }
      this.submitRecoveryContinue(channelId, runner, "method_suspension_recovered", resumeTurnId);
      return true;
    }
    return false;
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
        if (!chosen.turnId) {
          this.markStale(chosen.transportCallId, "missing_turn_metadata");
          continue;
        }
        let liveLeafId: string | null = null;
        if (!chosen.recoveredEntryId && runner.session) {
          try {
            liveLeafId = await runner.session.getLeafId();
          } catch (err) {
            this.recordLastError("channel_method.recovery.cursor_leaf", err, channelId);
            this.recordDebugPhase(channelId, "channel_method.recovery.cursor_leaf_failed", {
              transportCallId: chosen.transportCallId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const cursorEntryId = chosen.recoveredEntryId ?? liveLeafId;
        this.transitionTurn(chosen.turnId, ["waiting_external", "running_model"], "continuing", {
          resumeCursorEntryId: cursorEntryId,
        });
        this.submitRecoveryContinue(
          channelId,
          runner,
          "method_suspension_recovered",
          chosen.turnId
        );
      }
    }
  }

  private markLiveToolResultAdmitted(
    channelId: string,
    message: AgentMessage,
    entryId: string | null = null
  ): void {
    const invocationId = (message as { toolCallId?: unknown }).toolCallId;
    if (typeof invocationId !== "string" || invocationId.length === 0) return;
    let admittedTurnId: string | null = null;
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
      admittedTurnId = chosen.turnId;
      const now = Date.now();
      this.sql.exec(
        `UPDATE agent_method_suspensions
           SET delivery_status = 'transcript_admitted',
               admitted_entry_id = COALESCE(?, admitted_entry_id),
               updated_at = ?
           WHERE transport_call_id = ?
             AND delivery_status = 'delivered_live'`,
        entryId,
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
    if (settled && admittedTurnId && !this.turnHasOpenExternalWait(admittedTurnId)) {
      this.transitionTurn(admittedTurnId, ["waiting_external"], "continuing", {
        resumeCursorEntryId: entryId,
      });
    }
  }

  private async emitRecoveryContinueFailedDiagnostic(
    channelId: string,
    error: unknown
  ): Promise<void> {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const descriptor = this.getParticipantInfo(channelId, this.subscriptions.getConfig(channelId));
    const content = `${LIFECYCLE_RECOVERY_NOTICES.recovery_continue_failed.message} ${
      error instanceof Error ? error.message : String(error)
    }`;
    await this.createChannelClient(channelId)
      .send(participantId, crypto.randomUUID(), content, {
        senderMetadata: {
          ...descriptor.metadata,
          name: descriptor.name,
          type: descriptor.type,
          handle: descriptor.handle,
        },
        idempotencyKey: `recovery-continue-failed:${channelId}`,
      })
      .catch((err) => {
        console.error(
          `[TrajectoryVesselBase] Failed to emit recovery-continue failure for channel=${channelId}:`,
          err
        );
      });
  }

  private async emitTurnWorkFailureDiagnostic(
    channelId: string,
    workKind: "prompt" | "continue",
    error: unknown
  ): Promise<void> {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const descriptor = this.getParticipantInfo(channelId, this.subscriptions.getConfig(channelId));
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    const content = `Agent turn failed while ${workKind === "continue" ? "continuing" : "running"}: ${message}`;
    await this.createChannelClient(channelId)
      .send(participantId, crypto.randomUUID(), content, {
        senderMetadata: {
          ...descriptor.metadata,
          name: descriptor.name,
          type: descriptor.type,
          handle: descriptor.handle,
        },
        idempotencyKey: `turn-work-failed:${channelId}:${workKind}:${String(code ?? "error")}:${message}`,
      })
      .catch((err) => {
        console.error(
          `[TrajectoryVesselBase] Failed to emit turn work failure for channel=${channelId}:`,
          err
        );
      });
  }

  private async emitTurnLedgerDiagnostic(
    channelId: string,
    turnId: string,
    message: string
  ): Promise<void> {
    await this.sendTurnLedgerDiagnostic(channelId, turnId, message).catch((err) => {
      console.error(
        `[TrajectoryVesselBase] Failed to emit turn ledger diagnostic for channel=${channelId}:`,
        err
      );
    });
  }

  private async emitInfrastructureDiagnostic(
    channelId: string,
    code: string,
    message: string,
    detail?: Record<string, unknown>
  ): Promise<void> {
    this.recordInvariantViolation(channelId, code, detail, { visible: true });
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const descriptor = this.getParticipantInfo(channelId, this.subscriptions.getConfig(channelId));
    await this.createChannelClient(channelId)
      .send(participantId, crypto.randomUUID(), message, {
        senderMetadata: {
          ...descriptor.metadata,
          name: descriptor.name,
          type: descriptor.type,
          handle: descriptor.handle,
        },
        idempotencyKey: `agent-infrastructure-diagnostic:${channelId}:${code}`,
      })
      .catch((err) => {
        this.recordLastError("infrastructure_diagnostic.emit", err, channelId);
        console.error(
          `[TrajectoryVesselBase] Failed to emit infrastructure diagnostic ${code} for channel=${channelId}:`,
          err
        );
      });
  }

  private async sendTurnLedgerDiagnostic(
    channelId: string,
    turnId: string,
    message: string
  ): Promise<void> {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const descriptor = this.getParticipantInfo(channelId, this.subscriptions.getConfig(channelId));
    await this.createChannelClient(channelId).send(participantId, crypto.randomUUID(), message, {
      senderMetadata: {
        ...descriptor.metadata,
        name: descriptor.name,
        type: descriptor.type,
        handle: descriptor.handle,
        natstackDiagnostic: this.lifecycleDiagnosticForTurnLedgerMessage(message),
      },
      idempotencyKey: `turn-ledger-diagnostic:${turnId}`,
    });
  }

  private lifecycleDiagnosticForTurnLedgerMessage(
    message: string
  ): LifecycleRecoveryDiagnostic | undefined {
    // Classification + prose live in one shared place (agentic-protocol); the
    // typed `reason` code is the authoritative control-flow signal.
    const notice = lifecycleRecoveryNoticeForMessage(message);
    if (!notice) return undefined;
    return {
      type: "lifecycle_recovery",
      status: notice.status,
      title: notice.title,
      detail: notice.detail,
      reason: notice.reason,
    };
  }

  private async enqueueTurnOutbox(opts: {
    channelId: string;
    turnId: string;
    kind: "emit_diagnostic" | "close_turn_projection";
    dedupKey: string;
    payload?: unknown;
  }): Promise<void> {
    const now = Date.now();
    const payload = await this.encodeSuspensionStorage(opts.payload);
    this.sql.exec(
      `INSERT OR IGNORE INTO agent_turn_outbox (
         channel_id, turn_id, kind, dedup_key, payload_json, payload_ref_json,
         status, attempts, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
      opts.channelId,
      opts.turnId,
      opts.kind,
      opts.dedupKey,
      payload.json,
      payload.refJson,
      now,
      now
    );
  }

  private async drainTurnOutbox(channelId: string, runner?: PiRunner): Promise<void> {
    const rows = this.sql
      .exec(
        `SELECT * FROM agent_turn_outbox
         WHERE channel_id = ? AND status IN ('pending', 'failed')
         ORDER BY id ASC`,
        channelId
      )
      .toArray();
    for (const row of rows) {
      const id = row["id"] as number;
      try {
        const kind = row["kind"] as string;
        if (kind === "emit_diagnostic") {
          const payload = await this.hydrateStoredTransportValue(
            this.parseSuspensionJson(
              (row["payload_json"] as string | null) ?? null,
              (row["payload_ref_json"] as string | null) ?? null
            )
          );
          const message =
            payload &&
            typeof payload === "object" &&
            typeof (payload as { message?: unknown }).message === "string"
              ? (payload as { message: string }).message
              : typeof payload === "string"
                ? payload
                : "Agent recovery diagnostic.";
          await this.sendTurnLedgerDiagnostic(
            channelId,
            (row["turn_id"] as string | null) ?? `outbox:${id}`,
            message
          );
        } else if (kind === "close_turn_projection") {
          if (!runner) throw new Error("close_turn_projection requires a runner");
          await runner.repairDurableOpenState({ closeOpenTurns: true });
        } else {
          throw new Error(`unknown turn outbox kind: ${kind}`);
        }
        this.sql.exec(
          `UPDATE agent_turn_outbox
           SET status = 'done', last_error = NULL, updated_at = ?
           WHERE id = ?`,
          Date.now(),
          id
        );
      } catch (err) {
        this.sql.exec(
          `UPDATE agent_turn_outbox
           SET status = 'failed',
               attempts = attempts + 1,
               last_error = ?,
               updated_at = ?
           WHERE id = ?`,
          err instanceof Error ? err.message : String(err),
          Date.now(),
          id
        );
      }
    }
  }

  private durableSteeringId(channelId: string, event: ChannelEvent): string {
    return `${channelId}:${event.id ?? event.messageId ?? Date.now()}`;
  }

  private persistPendingSteering(
    channelId: string,
    turnId: string,
    steeringId: string,
    input: RunnerTurnInput
  ): boolean {
    const existing = this.sql
      .exec(
        `SELECT observed_at FROM agent_pending_steering
         WHERE steering_id = ?
         LIMIT 1`,
        steeringId
      )
      .toArray();
    if (existing.length > 0) {
      return existing[0]?.["observed_at"] == null;
    }
    this.sql.exec(
      `INSERT INTO agent_pending_steering
         (steering_id, channel_id, turn_id, input_json, created_at, observed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      steeringId,
      channelId,
      turnId,
      JSON.stringify(input),
      Date.now()
    );
    return true;
  }

  private markPendingSteeringObserved(steeringId: string): void {
    this.sql.exec(
      `UPDATE agent_pending_steering
       SET observed_at = COALESCE(observed_at, ?)
       WHERE steering_id = ?`,
      Date.now(),
      steeringId
    );
  }

  private replayDurablePendingSteering(
    channelId: string,
    turnId: string,
    dispatcher: TurnDispatcher
  ): void {
    const rows = this.sql
      .exec(
        `SELECT steering_id, input_json
         FROM agent_pending_steering
         WHERE channel_id = ?
           AND turn_id = ?
           AND observed_at IS NULL
         ORDER BY created_at ASC`,
        channelId,
        turnId
      )
      .toArray();
    for (const row of rows) {
      try {
        const input = JSON.parse(String(row["input_json"])) as RunnerTurnInput;
        dispatcher.steerIntoActiveTurn(input, { steeringId: String(row["steering_id"]) });
      } catch (err) {
        this.recordLastError("pending_steering.replay", err, channelId);
      }
    }
  }

  private recoverOrphanedPendingSteering(channelId: string, runner: PiRunner): boolean {
    const rows = this.sql
      .exec(
        `SELECT steering_id, turn_id, input_json
         FROM agent_pending_steering
         WHERE channel_id = ?
           AND observed_at IS NULL
         ORDER BY created_at ASC`,
        channelId
      )
      .toArray();
    let dispatcher: TurnDispatcher | null = null;
    let submitted = false;
    for (const row of rows) {
      const turnId = String(row["turn_id"]);
      const turn = this.loadTurnRun(turnId);
      if (
        turn &&
        turn.status !== "closed" &&
        turn.status !== "failed" &&
        turn.status !== "interrupted"
      ) {
        continue;
      }
      try {
        const input = JSON.parse(String(row["input_json"])) as RunnerTurnInput;
        dispatcher ??= this.getOrCreateDispatcher(channelId, runner);
        dispatcher.submit(input, {
          mode: "sequential",
          steeringId: String(row["steering_id"]),
        });
        submitted = true;
      } catch (err) {
        this.recordLastError("pending_steering.orphan_recover", err, channelId);
      }
    }
    return submitted;
  }

  private submitRecoveryContinue(
    channelId: string,
    runner: PiRunner,
    reason: string,
    turnId?: string
  ): void {
    const resumeTurnId = turnId ?? this.currentTurnIdForChannel(channelId);
    if (!resumeTurnId) {
      throw new Error("Cannot submit recovery continue without an existing agent turn");
    }
    // Consolidated admission gate: a recovery continue for a user-interrupted or
    // terminal turn is dropped here, at the single resume chokepoint, so a late
    // suspension result can never resurrect a stopped agent.
    if (this.runControllerFor(channelId).isResumeBlocked(resumeTurnId)) {
      this.recordDebugPhase(channelId, "channel_method.recovery_continue.gated", {
        reason,
        turnId: resumeTurnId,
      });
      return;
    }
    this.recordDebugPhase(channelId, "channel_method.recovery_continue.submitted", {
      reason,
      turnId: resumeTurnId,
    });
    const dispatcher = this.getOrCreateDispatcher(channelId, runner);
    this.replayDurablePendingSteering(channelId, resumeTurnId, dispatcher);
    dispatcher.submitContinue({ turnId: resumeTurnId });
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
    this.suspensions.createTables();
    this.subscriptions.createTables();
    // Delivery cursor for event dedup + gap repair.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS delivery_cursor (
        channel_id TEXT PRIMARY KEY,
        last_delivered_seq INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_turn_runs (
        turn_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        status TEXT NOT NULL,
        resume_cursor_entry_id TEXT,
        turn_open_cursor_entry_id TEXT,
        model_start_cursor_entry_id TEXT,
        checkpoint_phase TEXT,
        checkpoint_entry_id TEXT,
        checkpoint_generation INTEGER,
        failure_code TEXT,
        failure_message TEXT,
        opened_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_turn_runs_channel_status
        ON agent_turn_runs(channel_id, status)
    `);
    this.ensureColumn("agent_turn_runs", "turn_open_cursor_entry_id", "TEXT");
    this.ensureColumn("agent_turn_runs", "model_start_cursor_entry_id", "TEXT");
    this.ensureColumn("agent_turn_runs", "checkpoint_phase", "TEXT");
    this.ensureColumn("agent_turn_runs", "checkpoint_entry_id", "TEXT");
    this.ensureColumn("agent_turn_runs", "checkpoint_generation", "INTEGER");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_turn_resume_attempts (
        turn_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        reason TEXT NOT NULL,
        attempted_at INTEGER NOT NULL,
        PRIMARY KEY (turn_id, generation)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_pending_steering (
        steering_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        observed_at INTEGER
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_pending_steering_turn
        ON agent_pending_steering(channel_id, turn_id, observed_at, created_at)
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_turn_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        payload_json TEXT,
        payload_ref_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(turn_id, kind, dedup_key)
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
        args_ref_json TEXT,
        session_leaf_before_call TEXT,
        terminal_kind TEXT NOT NULL DEFAULT 'none',
        result_json TEXT,
        result_ref_json TEXT,
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
    this.ensureColumn("agent_method_suspensions", "args_ref_json", "TEXT");
    this.ensureColumn("agent_method_suspensions", "result_ref_json", "TEXT");
    this.ensureColumn("agent_method_suspensions", "terminal_event_id", "TEXT");
    this.ensureColumn("agent_method_suspensions", "admitted_entry_id", "TEXT");
    this.ensureColumn("agent_method_suspensions", "failure_code", "TEXT");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS agent_method_suspension_updates (
        transport_call_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (transport_call_id, seq)
      )
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const exists = this.sql
      .exec(`PRAGMA table_info(${table})`)
      .toArray()
      .some((row) => row["name"] === column);
    if (!exists) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
      const bootGenerationRaw = (this.env as Record<string, string>)["WORKERD_BOOT_GENERATION"];
      const bootGeneration =
        typeof bootGenerationRaw === "string" && bootGenerationRaw.length > 0
          ? Number.parseInt(bootGenerationRaw, 10)
          : null;
      if (source && className && sessionId) {
        const doRef: DORef = { source, className, objectKey: key };
        this.identity.bootstrap(
          doRef,
          sessionId,
          Number.isFinite(bootGeneration) ? bootGeneration : null
        );
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

  override async prepareForRestart(_input: LifecyclePrepareInput): Promise<LifecyclePrepareResult> {
    this.ensureBootstrapped();
    for (const [channelId, entry] of this.runners.entries()) {
      const turnId =
        (entry.runner as { getCurrentTurnId?: () => string | null }).getCurrentTurnId?.() ??
        this.currentTurnRunForChannel(channelId)?.turnId;
      if (turnId) {
        const row = this.loadTurnRun(turnId);
        await this.captureTurnCheckpoint(
          channelId,
          turnId,
          entry.runner,
          row?.status === "running_model" ? "model_start" : "turn_open"
        );
      }
      this.abortContexts.set(channelId, {
        reason: "interrupt-channel",
        detail: "workerd-restart",
        at: Date.now(),
      });
      const abort = (entry.runner as { abort?: () => Promise<unknown> }).abort;
      await abort?.call(entry.runner)?.catch((err) => {
        this.recordLastError("lifecycle.prepare.abort", err, channelId);
      });
    }
    return { status: "ready" };
  }

  override async resumeAfterRestart(_input: LifecycleResumeInput): Promise<void> {
    this.ensureBootstrapped();
    const channels = this.sql
      .exec(
        `SELECT DISTINCT channel_id FROM agent_turn_runs
         WHERE status NOT IN ('closed', 'failed', 'interrupted')
         ORDER BY channel_id`
      )
      .toArray()
      .map((row) => row["channel_id"])
      .filter((channelId): channelId is string => typeof channelId === "string");
    for (const channelId of channels) {
      await this.getOrCreateRunner(channelId);
    }
    // Re-drive credential deferrals whose server-side wait was lost on restart
    // (the DeferralRegistry is in-memory). Reissue resolves inline if the grant
    // persisted, else re-registers the approval.
    await this.redrivePendingCredentialInterruptions();
    if (channels.length === 0) {
      await this.markCheckpointableWorkInactive();
    }
  }

  /**
   * Reissue every parked credential deferral by its request_id. On a server/DO
   * restart the in-memory DeferralRegistry entry is gone, so without this a turn
   * could sit in waiting_external forever. Reissue with the same requestId: the
   * server resolves inline when the grant persisted (resume, no re-prompt) or
   * re-registers the approval (a future onDeferredResult resumes via the row).
   */
  private async redrivePendingCredentialInterruptions(): Promise<void> {
    for (const suspension of this.suspensions.listRedrivable("credential")) {
      const channelId = suspension.channelId;
      const requestId = suspension.requestId;
      if (!requestId) continue;
      const providerId = (suspension.payload["providerId"] as string | undefined) ?? "";
      const modelBaseUrl =
        (suspension.payload["modelBaseUrl"] as string | undefined) ??
        this.getModelBaseUrl(channelId);
      try {
        const ack = await this.rpc.callDeferred(
          "main",
          "credentials.resolveCredential",
          [{ url: modelBaseUrl }],
          { requestId }
        );
        if (ack.status === "completed" && ack.result) {
          await this.resolveDeferredModelCredential({ channelId, providerId, modelBaseUrl }, false);
        }
      } catch (err) {
        console.warn(
          `[TrajectoryVesselBase] credential re-drive failed for ${channelId}/${providerId}:`,
          err
        );
      }
    }
  }

  /**
   * Durable liveness backstop. Fired by the server-driven alarm armed when a
   * turn parks on a credential wait. Redrives pending credential suspensions
   * (idempotent) so a wait resumes even with no other activity, then re-arms
   * while any remain — so a long human approval is still covered.
   */
  override async alarm(): Promise<void> {
    await super.alarm();
    await this.ensureAgentActivationReady().catch(() => undefined);
    await this.redrivePendingCredentialInterruptions();
    if (this.suspensions.listRedrivable("credential").length > 0) {
      this.setAlarm(CREDENTIAL_BACKSTOP_ALARM_MS);
    }
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

  protected getApiKeyForChannel(
    channelId: string,
    opts?: { resumeCurrentTurnOnMissingCredential?: boolean }
  ): () => Promise<string> {
    const providerId = this.getModelProviderId(channelId);
    return async () => {
      const modelBaseUrl = this.getModelBaseUrl(channelId);
      this.recordDebugPhase(channelId, "model_credential.resolve.start", {
        providerId,
        modelBaseUrl,
      });
      this.installUrlBoundModelFetchProxy(channelId, modelBaseUrl);
      const signal = this.getModelCredentialResolutionSignal(channelId);
      // Issue resolveCredential as a deferrable call: when the server needs
      // (human) credential-use approval it returns `deferred` immediately
      // instead of holding this request open across a possible hibernation.
      const credentialRequestId = crypto.randomUUID();
      // Mark in-flight *before* issuing, so a delivery that races ahead of the
      // interruption-row write is recognized as ours and buffered (see
      // onDeferredResult), not dropped.
      this.inFlightCredentialDeferrals.add(credentialRequestId);
      let ack: { status: "completed"; result: unknown } | { status: "deferred"; requestId: string };
      try {
        ack = await this.rpc.callDeferred(
          "main",
          "credentials.resolveCredential",
          [{ url: modelBaseUrl }],
          { requestId: credentialRequestId }
        );
      } catch (err) {
        this.inFlightCredentialDeferrals.delete(credentialRequestId);
        this.bufferedCredentialDeliveries.delete(credentialRequestId);
        this.recordLastError("model_credential.resolve", err, channelId);
        this.recordDebugPhase(channelId, "model_credential.resolve.error", {
          providerId,
          modelBaseUrl,
          error: err instanceof Error ? err.message : String(err),
        });
        const reconnectFailure = modelCredentialReconnectFailure(err);
        let reconnectSuspended = false;
        if (reconnectFailure) {
          const shouldResumeCurrentTurn = opts?.resumeCurrentTurnOnMissingCredential !== false;
          if (shouldResumeCurrentTurn) {
            const credentialTurnId = await this.transitionCurrentTurnToWaiting(
              channelId,
              this.currentTurnIdForChannel(channelId) ?? undefined
            );
            this.publishTurnWaitingEvent(channelId, credentialTurnId, {
              reason: "model_credential_reconnect_required",
              summary: "Waiting for model credential refresh",
            });
            this.recordModelCredentialInterruption(
              channelId,
              providerId,
              modelBaseUrl,
              credentialTurnId
            );
            reconnectSuspended = true;
          }
          this.emitModelCredentialRequiredCard(channelId, providerId, modelBaseUrl, {
            resumeAfterConnect: shouldResumeCurrentTurn,
            reason: "Your model sign-in needs to be refreshed before this turn can continue.",
            diagnosticReason: reconnectFailure.message,
            failureCode: reconnectFailure.code,
            ...(shouldResumeCurrentTurn
              ? { turnId: this.currentTurnIdForChannel(channelId) ?? undefined }
              : {}),
          });
        }
        // A parked reconnect is a pause: throw a typed suspension (carrying the
        // reconnect message so the resume path still recognizes it) so pi-runner
        // keeps the turn open and never publishes it as a red error.
        if (reconnectSuspended) {
          throw new TurnSuspensionSignal({
            reason: "credential",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      } finally {
        const controller = this.modelCredentialResolutionAbortControllers.get(channelId);
        if (controller?.signal === signal) {
          this.modelCredentialResolutionAbortControllers.delete(channelId);
        }
      }
      if (ack.status === "deferred") {
        // Approval is pending server-side. Park the turn keyed by the deferred
        // requestId; it resumes when onDeferredResult arrives (revives the DO if
        // hibernated). The approval prompt itself is the user-facing UI.
        this.recordDebugPhase(channelId, "model_credential.resolve.deferred", {
          providerId,
          modelBaseUrl,
        });
        const shouldResumeCurrentTurn = opts?.resumeCurrentTurnOnMissingCredential !== false;
        if (shouldResumeCurrentTurn) {
          const credentialTurnId = await this.transitionCurrentTurnToWaiting(
            channelId,
            this.currentTurnIdForChannel(channelId) ?? undefined
          );
          this.publishTurnWaitingEvent(channelId, credentialTurnId, {
            reason: "model_credential_required",
            summary: "Waiting for model credential approval",
          });
          this.recordModelCredentialInterruption(
            channelId,
            providerId,
            modelBaseUrl,
            credentialTurnId,
            credentialRequestId
          );
          // The row now exists. If a delivery raced ahead of it (e.g. auto-approve),
          // apply it now — scheduled, so it runs after this init unwinds and the
          // turn is fully parked.
          const buffered = this.bufferedCredentialDeliveries.get(credentialRequestId);
          if (buffered) {
            void this.resolveDeferredModelCredential(
              { channelId, providerId, modelBaseUrl },
              buffered.isError
            );
          }
        }
        this.inFlightCredentialDeferrals.delete(credentialRequestId);
        this.bufferedCredentialDeliveries.delete(credentialRequestId);
        const approvalMessage = `${MODEL_CREDENTIAL_APPROVAL_PENDING_PREFIX} for provider: ${providerId}`;
        // A parked turn pauses (typed suspension → no red error); a non-resuming
        // caller (e.g. a secondary credential) gets a plain auth failure.
        throw shouldResumeCurrentTurn
          ? new TurnSuspensionSignal({
              reason: "credential",
              message: approvalMessage,
              requestId: credentialRequestId,
            })
          : new AgentWorkerError("auth", approvalMessage);
      }
      this.inFlightCredentialDeferrals.delete(credentialRequestId);
      this.bufferedCredentialDeliveries.delete(credentialRequestId);
      const credential = ack.result as ModelCredentialSummary | null;
      if (!credential) {
        this.recordDebugPhase(channelId, "model_credential.resolve.missing", {
          providerId,
          modelBaseUrl,
        });
        const shouldResumeCurrentTurn = opts?.resumeCurrentTurnOnMissingCredential !== false;
        if (shouldResumeCurrentTurn) {
          const credentialTurnId = await this.transitionCurrentTurnToWaiting(
            channelId,
            this.currentTurnIdForChannel(channelId) ?? undefined
          );
          this.publishTurnWaitingEvent(channelId, credentialTurnId, {
            reason: "model_credential_required",
            summary: "Waiting for model credential connection",
          });
          this.recordModelCredentialInterruption(
            channelId,
            providerId,
            modelBaseUrl,
            credentialTurnId
          );
        }
        this.emitModelCredentialRequiredCard(channelId, providerId, modelBaseUrl, {
          resumeAfterConnect: shouldResumeCurrentTurn,
          ...(shouldResumeCurrentTurn
            ? { turnId: this.currentTurnIdForChannel(channelId) ?? undefined }
            : {}),
        });
        const missingMessage = `No URL-bound model credential is configured for model provider: ${providerId}`;
        throw shouldResumeCurrentTurn
          ? new TurnSuspensionSignal({ reason: "credential", message: missingMessage })
          : new AgentWorkerError("auth", missingMessage);
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
      // `rpc.stream` so model SSE responses arrive as a real
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
    return this.agenticEventFromChannelEvent(event)?.kind === "message.completed";
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
    const payload = agentic?.payload as { blocks?: MessageBlockInput[] } | undefined;
    return {
      content: messageDisplayText(payload?.blocks),
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
          const initialState = await this.hydrateStoredTransportValue(
            payload["initialState"],
            `custom message initialState channel=${channelId} message=${messageId}`
          );
          this.assertNoStoredRefsForAdmission(
            initialState,
            `custom message initialState channel=${channelId} message=${messageId}`
          );
          byMessageId.set(messageId, {
            typeId,
            state: initialState,
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
          const update = await this.hydrateStoredTransportValue(
            payload["update"],
            `custom message update channel=${channelId} message=${messageId}`
          );
          this.assertNoStoredRefsForAdmission(
            update,
            `custom message update channel=${channelId} message=${messageId}`
          );
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

  private async hydrateStoredTransportValue(
    value: unknown,
    context = "transport payload"
  ): Promise<unknown> {
    try {
      return await hydrateStoredValueRefs(
        value,
        {
          getText: (digest) => this.rpc.call<string | null>("main", "blobstore.getText", [digest]),
        },
        { strict: true, context }
      );
    } catch (err) {
      if (err instanceof AgentWorkerError) throw err;
      throw new AgentWorkerError(
        "transcript_shape",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private assertNoStoredRefsForAdmission(value: unknown, context: string): void {
    try {
      assertNoStoredValueRefs(value, context);
    } catch (err) {
      throw new AgentWorkerError(
        "transcript_shape",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private toolResultMessageForAdmission(message: AgentMessage, context: string): AgentMessage {
    this.assertNoStoredRefsForAdmission(message, context);
    return message;
  }

  private toolResultForAdmission(
    result: AgentToolResult<any>,
    context: string
  ): AgentToolResult<any> {
    this.assertNoStoredRefsForAdmission(result, context);
    return result;
  }

  private turnInputForAdmission(input: RunnerTurnInput, context: string): RunnerTurnInput {
    this.assertNoStoredRefsForAdmission(input, context);
    return input;
  }

  private isOwnCustomMessageActor(
    actor: { id?: string; participantId?: string } | undefined,
    selfParticipantId: string
  ): boolean {
    return actor?.participantId === selfParticipantId || actor?.id === selfParticipantId;
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

  protected getExpectedChannelToolNames(_channelId: string): readonly string[] | null {
    return null;
  }

  protected getExpectedChannelToolReadinessTimeoutMs(_channelId: string): number {
    return EXPECTED_CHANNEL_TOOL_READY_TIMEOUT_MS;
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
    this.cancelMethodSuspensionsForChannel(channelId, "channel_unsubscribe");
    await this.subscriptions.unsubscribeFromChannel(channelId);

    // Dispose dispatcher before the runner — unsubscribes its listener
    // and broadcasts typing off.
    const dispatcher = this.dispatchers.get(channelId);
    if (dispatcher) {
      dispatcher.dispose();
      this.dispatchers.delete(channelId);
      this.dispatcherRunners.delete(channelId);
    }

    const entry = this.runners.get(channelId);
    if (entry) {
      this.recordAbort(channelId, "channel-unsubscribe");
      await entry.runner
        .forceCloseCurrentTurn("channel_unsubscribe", "Turn closed after channel unsubscribe")
        .catch((err) => {
          this.recordLastError("runner.force_close.unsubscribe", err, channelId);
          this.recordDebugPhase(channelId, "runner.force_close.unsubscribe_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
          console.warn(
            `[TrajectoryVesselBase] forceCloseCurrentTurn failed during unsubscribe for channel=${channelId}:`,
            err
          );
        });
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
        await this.emitInfrastructureDiagnostic(
          channelId,
          "channel_event_poison_skipped",
          `Skipped channel event ${eventId} after repeated processing failures.`,
          { eventId, attempts }
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
      await this.emitInfrastructureDiagnostic(
        channelId,
        "channel_gap_repair_too_large",
        `Skipped channel gap repair for ${gap} missing events.`,
        { lastSeq, eventId, gap }
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
              await this.emitInfrastructureDiagnostic(
                channelId,
                "channel_gap_poison_event_skipped",
                `Skipped channel event ${missedId} during gap repair after repeated failures.`,
                {
                  eventId: missedId,
                  attempts: count,
                  error: missedErr instanceof Error ? missedErr.message : String(missedErr),
                }
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

    // Method lifecycle decoder. Runs BEFORE the transcript-poison gate so a
    // terminal is still recorded on its suspension under poison; the recovery
    // continuation stays poison-gated inside recoverDeliveredAndOrphanedSuspensions.
    if (await this.dispatchInvocationLifecycle(channelId, event)) return;

    if (await this.failIfTranscriptPoisoned(channelId)) return;

    await this.processChannelEvent(channelId, event, opts);
  }

  /**
   * Canonical method-lifecycle ingestion. The channel emits durable `invocation.*`
   * log events for every channel method call; terminals settle/recover the
   * agent's suspension and `invocation.output` streams progress. Returns true if
   * the event was a method-lifecycle event (handled here, not forwarded to Pi).
   */
  private async dispatchInvocationLifecycle(
    channelId: string,
    event: ChannelEvent
  ): Promise<boolean> {
    const agentic = this.agenticEventFromChannelEvent(event);
    const kind = agentic?.kind;
    if (
      kind !== "invocation.output" &&
      kind !== "invocation.completed" &&
      kind !== "invocation.failed" &&
      kind !== "invocation.cancelled" &&
      kind !== "invocation.abandoned"
    ) {
      // invocation.started and non-invocation events flow on normally.
      return false;
    }
    const callId = agentic?.causality?.transportCallId;
    if (!callId) {
      this.recordDebugPhase(channelId, "invocation.malformed_no_call_id", { kind });
      return true;
    }
    const body = (agentic?.payload ?? {}) as Record<string, unknown>;
    if (kind === "invocation.output") {
      await this.handleMethodProgress(channelId, callId, body["output"]);
      return true;
    }
    const isError = kind !== "invocation.completed";
    const result = isError ? (body["error"] ?? body["reason"]) : body["result"];
    const terminalKind: Exclude<MethodSuspensionTerminalKind, "none"> =
      kind === "invocation.completed"
        ? "completed"
        : kind === "invocation.failed"
          ? "failed"
          : "cancelled";
    await this.handleCompletedMethodResult(
      channelId,
      callId,
      result,
      isError,
      terminalKind,
      event.id
    );
    return true;
  }

  // ── PiRunner lifecycle (one per channel, lazy) ──────────────────────────

  protected async getOrCreateRunner(channelId: string): Promise<PiRunner> {
    const existing = this.runners.get(channelId);
    if (existing) return existing.runner;
    const pending = this.runnerCreations.get(channelId);
    if (pending) return pending;

    const creation = this.createRunnerForChannel(channelId);
    this.runnerCreations.set(channelId, creation);
    try {
      return await creation;
    } finally {
      if (this.runnerCreations.get(channelId) === creation) {
        this.runnerCreations.delete(channelId);
      }
    }
  }

  private async createRunnerForChannel(channelId: string): Promise<PiRunner> {
    await this.ensureAgentActivationReady();
    const existing = this.runners.get(channelId);
    if (existing) return existing.runner;
    await this.ensureExpectedChannelToolsAvailable(channelId, "runner.init");

    const subclassExtraTools = this.getRunnerTools(channelId);
    const builtInTools = this.getBuiltInTools(channelId);
    const extraTools =
      builtInTools.length === 0 && !subclassExtraTools
        ? null
        : [...builtInTools, ...(subclassExtraTools ?? [])];
    const toolFilter = this.getRunnerToolFilter(channelId);
    const expectedChannelToolNames = this.getExpectedChannelToolNames(channelId);
    void this.getRunnerSkills(channelId);

    // Build options as a strongly-typed PiRunnerOptions object. The runner is
    // responsible for materializing Pi session state from trajectory events.
    const runnerOptions: PiRunnerOptions = {
      rpc: {
        call: <T = unknown>(target: string, method: string, args: unknown[]): Promise<T> => {
          return this.rpc.call<T>(target, method, args);
        },
        stream: (
          target: string,
          method: string,
          args: unknown[],
          options?: { signal?: AbortSignal }
        ): Promise<Response> => {
          return this.rpc.stream(target, method, args, options);
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
      // and routes through `rpc.stream` so HTTP transport gives
      // real streaming and other transports synthesize a Response
      // uniformly. The harness never sees credential values.
      fetcher: this.credentials.fetch.bind(this.credentials) as typeof fetch,
      thinkingLevel: this.getThinkingLevel(channelId),
      ...this.getRunnerPromptConfig(channelId),
      ...(extraTools ? { extraTools } : {}),
      ...(toolFilter ? { toolFilter } : {}),
      ...(expectedChannelToolNames?.length ? { expectedChannelToolNames } : {}),
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
      repairDurableOpenStateOnInit: false,
    };
    const runner = this.createRunner(channelId, {
      ...runnerOptions,
      onPrepareNextTurn: async (snapshot) => {
        await this.prepareNextTurnHook(channelId, snapshot);
      },
      onTurnPhase: async ({ turnId, phase }) => {
        if (phase !== "model_start") return;
        await this.captureTurnCheckpoint(channelId, turnId, runner, "model_start");
        this.transitionTurn(
          turnId,
          ["starting", "continuing", "waiting_external"],
          "running_model"
        );
      },
      keepTurnOpenOnAgentEnd: (event) => {
        const failure = failedAgentEndFailure(event as RunnerEvent);
        if (!failure) return false;
        return (
          !!modelCredentialReconnectFailure(failure) ||
          isModelCredentialApprovalPendingFailure(failure)
        );
      },
    });

    await runner.init();

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
    runner.hooks.on("event", async (event: RunnerEvent) => {
      if (event.type === "agent_start") {
        return;
      }
      if (event.type === "agent_end") {
        await this.handleRunnerAgentEndForTurnLedger(channelId, runner, event);
        return;
      }
      if (event.type !== "message_end") return;
      const message = (event as { message?: AgentMessage }).message;
      if (!message) return;
      await this.handleRunnerMessageEndForTurnLedger(channelId, runner, message);
    });

    this.runners.set(channelId, { runner });
    // Dispatcher self-subscribes to runner events for absorption tracking
    // and sweep. Created here so it exists before the first processChannelEvent
    // (which expects to hand messages to it).
    this.getOrCreateDispatcher(channelId, runner);
    const submittedRecoveryContinue = await this.recoverFromTurnLedger(channelId, runner);
    await runner.repairDurableOpenState({
      closeOpenTurns: !submittedRecoveryContinue && !this.channelHasNonTerminalTurnRuns(channelId),
      // Invocations still in flight on the suspension ledger are durable method
      // calls that survive the restart; the ledger recovers them. Tell repair to
      // leave them alone so it only abandons genuinely-dead in-runner work.
      recoverableInvocationIds: this.recoverableSuspensionInvocationIds(channelId),
    });
    return runner;
  }

  /**
   * Invocation ids of method-call suspensions that are still in flight (no
   * durable terminal yet). These survive a runner restart and are recovered
   * through the suspension ledger, so trajectory repair must not abandon them.
   */
  private recoverableSuspensionInvocationIds(channelId: string): Set<string> {
    const rows = this.sql
      .exec(
        `SELECT DISTINCT invocation_id FROM agent_method_suspensions
         WHERE channel_id = ?
           AND terminal_kind = 'none'
           AND delivery_status IN ('pending', 'delivered_live', 'recovering')`,
        channelId
      )
      .toArray();
    return new Set(
      rows
        .map((row) => row["invocation_id"])
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    );
  }

  protected createRunner(_channelId: string, opts: PiRunnerOptions): PiRunner {
    return new PiRunner(opts);
  }

  protected canReplayInterruptedModelTurn(): boolean {
    return false;
  }

  protected getRunnerToolReplaySafety(
    _channelId: string,
    tool: NonNullable<PiRunnerOptions["extraTools"]>[number]
  ): ReplayToolSafety {
    const annotated = tool as typeof tool & { natstackReplay?: { safety?: ReplayToolSafety } };
    return annotated.natstackReplay?.safety ?? "unsafe";
  }

  protected getHarnessToolReplaySafety(_channelId: string, toolName: string): ReplayToolSafety {
    return HARNESS_MODEL_REPLAY_TOOL_SAFETY.get(toolName) ?? "unsafe";
  }

  private replayToolSurfaceSafety(channelId: string): {
    safe: boolean;
    unsafeTools: string[];
  } {
    const filter = this.getRunnerToolFilter(channelId);
    const accepts = (toolName: string) => !filter || filter(toolName);
    const entries: Array<{ name: string; safety: ReplayToolSafety }> = [];

    for (const [name, safety] of HARNESS_MODEL_REPLAY_TOOL_SAFETY) {
      if (accepts(name))
        entries.push({ name, safety: this.getHarnessToolReplaySafety(channelId, name) });
    }
    for (const method of this.buildRoster(channelId)) {
      if (accepts(method.name))
        entries.push({ name: method.name, safety: "journal-before-dispatch" });
    }
    for (const tool of [
      ...this.getBuiltInTools(channelId),
      ...(this.getRunnerTools(channelId) ?? []),
    ]) {
      if (accepts(tool.name)) {
        entries.push({ name: tool.name, safety: this.getRunnerToolReplaySafety(channelId, tool) });
      }
    }

    const unsafeTools = [
      ...new Set(entries.filter((entry) => entry.safety === "unsafe").map((entry) => entry.name)),
    ];
    return { safe: unsafeTools.length === 0, unsafeTools };
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

  /**
   * Before opening a fresh user turn, supersede any turn the runner still holds
   * open from a prior activation.
   *
   * The dispatcher drains FIFO and any recovery `continue` for a parked turn is
   * enqueued at runner creation (ahead of this prompt). So if a fresh prompt
   * reaches `onWorkStart` with the runner still holding an open turn, that turn
   * has no driver left to close it — e.g. a `waiting_external` turn whose
   * in-runner invocation was abandoned by the post-restart repair
   * (`repairDurableOpenState({ closeOpenTurns: false })`) and can never resolve.
   * Left in place it wedges `PiRunner.adoptTurnId` ("turn … is already open"),
   * permanently blocking every future prompt on the channel. Supersede it:
   * mark the ledger row terminal and durably close the runner's open turn so the
   * new turn can be adopted cleanly.
   */
  private async supersedeOrphanedOpenTurn(channelId: string, runner: PiRunner): Promise<void> {
    // Optional-chained to match the rest of the file's treatment of these
    // accessors (e.g. `currentTurnIdForChannel`): production runners are always
    // full PiRunners, but minimal test doubles may omit them.
    const staleTurnId = runner.getCurrentTurnId?.() ?? null;
    if (!staleTurnId) return;
    // A turn parked on a live external wait is a surviving method call, not an
    // orphan — it will be driven to completion when the result redelivers, and
    // a concurrent fresh prompt is steered into it (see processChannelEvent).
    // Only supersede a genuinely dead open turn: one with no live wait and no
    // driver, which would otherwise wedge adoptTurnId forever.
    if (this.turnHasOpenExternalWait(staleTurnId)) return;
    this.recordDebugPhase(channelId, "turn_ledger.superseded_orphaned_open_turn", {
      staleTurnId,
    });
    this.transitionTurn(
      staleTurnId,
      ["starting", "running_model", "waiting_external", "continuing", "closing"],
      "interrupted",
      {
        failureCode: "turn_superseded",
        failureMessage: "Turn superseded by a new user turn after runner restart.",
      }
    );
    await runner.forceCloseCurrentTurn?.("turn_superseded", "Turn superseded by a new user turn");
  }

  private currentTurnIdForChannel(channelId: string): string | undefined {
    // Step 2: the consolidated RunController is the authoritative source for the
    // active turn; fall back to the runner's in-memory id while writers migrate.
    const controllerTurn = this.runControllerFor(channelId).currentTurnId;
    if (controllerTurn) return controllerTurn;
    const runner = this.runners.get(channelId)?.runner as
      | { getCurrentTurnId?: () => string | null }
      | undefined;
    return runner?.getCurrentTurnId?.() ?? undefined;
  }

  protected async handleRunnerMessageEndForTurnLedger(
    channelId: string,
    runner: Pick<PiRunner, "getCurrentTurnId" | "session">,
    message: AgentMessage
  ): Promise<void> {
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") return;
    if (role !== "toolResult") return;
    let entryId: string | null = null;
    if (runner.session) {
      try {
        entryId = await runner.session.getLeafId();
      } catch (err) {
        this.recordLastError("turn_ledger.tool_result_leaf", err, channelId);
        this.recordDebugPhase(channelId, "turn_ledger.tool_result_leaf_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.markLiveToolResultAdmitted(channelId, message, entryId ?? null);
  }

  protected async handleRunnerAgentEndForTurnLedger(
    channelId: string,
    runner: PiRunner,
    event?: RunnerEvent
  ): Promise<void> {
    const turnId =
      this.currentTurnIdForChannel(channelId) ?? this.currentTurnRunForChannel(channelId)?.turnId;
    if (!turnId) return;
    const meta = runnerEventMetadata(event);
    if (meta.turnId && meta.turnId !== turnId) {
      this.recordDebugPhase(channelId, "turn_ledger.agent_end_turn_mismatch_ignored", {
        turnId,
        eventTurnId: meta.turnId,
        operationId: meta.operationId ?? null,
      });
      return;
    }
    if (meta.lifecycleMatched === false) {
      this.recordDebugPhase(channelId, "turn_ledger.agent_end_unmatched_ignored", {
        turnId,
        eventTurnId: meta.turnId ?? null,
        operationId: meta.operationId ?? null,
      });
      return;
    }
    const row = this.loadTurnRun(turnId);
    if (!row) return;
    if (row.status === "closed" || row.status === "failed" || row.status === "interrupted") return;
    const failure = failedAgentEndFailure(event);
    if (failure) {
      const reconnectFailure = modelCredentialReconnectFailure(failure);
      if (reconnectFailure && row.status !== "closing") {
        let reconnectPrompted = false;
        try {
          const providerId = this.getModelProviderId(channelId);
          const modelBaseUrl = this.getModelBaseUrl(channelId);
          this.recordModelCredentialInterruption(channelId, providerId, modelBaseUrl, turnId);
          this.emitModelCredentialRequiredCard(channelId, providerId, modelBaseUrl, {
            resumeAfterConnect: true,
            reason: "Your model sign-in needs to be refreshed before this turn can continue.",
            diagnosticReason: reconnectFailure.message,
            failureCode: reconnectFailure.code,
            turnId,
          });
          this.publishTurnWaitingEvent(channelId, turnId, {
            reason: "model_credential_reconnect_required",
            summary: "Waiting for model credential refresh",
          });
          reconnectPrompted = true;
        } catch (err) {
          this.recordLastError("turn_ledger.credential_reconnect_prompt_failed", err, channelId);
          this.recordDebugPhase(channelId, "turn_ledger.credential_reconnect_prompt_failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (reconnectPrompted) {
          const transitioned = this.transitionTurn(
            turnId,
            ["starting", "running_model", "continuing"],
            "waiting_external",
            {
              failureCode: "model_credential_reconnect_required",
              failureMessage: failure.message,
            }
          );
          if (!transitioned) {
            this.recordDebugPhase(channelId, "turn_ledger.credential_reconnect_wait_skipped", {
              turnId,
              status: this.loadTurnRun(turnId)?.status ?? "missing",
            });
          }
          return;
        }
      }
      const beforeModel = row.status === "starting";
      const transitioned = this.transitionTurn(
        turnId,
        ["starting", "running_model", "continuing", "closing"],
        "failed",
        {
          failureCode: beforeModel ? "runner_failed_before_model" : "runner_failed",
          failureMessage: failure.message,
        }
      );
      if (!transitioned) {
        this.recordDebugPhase(channelId, "turn_ledger.agent_end_failure_skipped", {
          turnId,
          status: this.loadTurnRun(turnId)?.status ?? "missing",
        });
        return;
      }
      if (beforeModel) {
        await this.enqueueTurnOutbox({
          channelId,
          turnId,
          kind: "emit_diagnostic",
          dedupKey: "starting-failed",
          payload: {
            message: `Agent turn failed before model generation began: ${failure.message}`,
          },
        });
        await this.drainTurnOutbox(channelId, runner);
      }
      return;
    }
    if (row.status === "starting") {
      this.transitionTurn(turnId, ["starting"], "interrupted", {
        failureCode: "runner_ended_before_model",
        failureMessage: "Runner ended before model generation began.",
      });
      await this.enqueueTurnOutbox({
        channelId,
        turnId,
        kind: "emit_diagnostic",
        dedupKey: "starting-ended",
        payload: {
          message: "Agent turn ended before model generation began.",
        },
      });
      await this.drainTurnOutbox(channelId, runner);
      return;
    }
    if (row.status === "waiting_external") {
      this.recordDebugPhase(channelId, "turn_ledger.agent_end_waiting_external", {
        turnId,
        openWait: this.turnHasOpenExternalWait(turnId),
      });
      return;
    }
    if (row.status !== "closing") {
      if (!this.transitionTurn(turnId, ["running_model", "continuing"], "closing")) {
        this.recordDebugPhase(channelId, "turn_ledger.agent_end_close_skipped", {
          turnId,
          status: this.loadTurnRun(turnId)?.status ?? "missing",
        });
        return;
      }
      await this.enqueueTurnOutbox({
        channelId,
        turnId,
        kind: "close_turn_projection",
        dedupKey: "close-turn-projection",
      });
    }
    await this.drainTurnOutbox(channelId, runner);
    this.transitionTurn(turnId, ["closing"], "closed");
  }

  private async transitionCurrentTurnToWaiting(
    channelId: string,
    turnId?: string
  ): Promise<string> {
    const currentTurnId = this.currentTurnIdForChannel(channelId);
    const id = turnId ?? currentTurnId;
    if (!id) {
      throw new Error("Cannot enter external wait without an active agent turn");
    }
    if (turnId && currentTurnId && turnId !== currentTurnId) {
      throw new Error(
        `Cannot enter external wait for turn ${turnId}; active turn is ${currentTurnId}`
      );
    }
    let row = this.loadTurnRun(id);
    if (!row) {
      await this.insertTurnRun(channelId, id);
      row = this.loadTurnRun(id);
    }
    if (!row) throw new Error(`Could not create turn ledger row for ${id}`);
    if (row.status === "waiting_external") return id;
    if (row.status === "interrupted") {
      this.recordDebugPhase(channelId, "turn_ledger.external_wait_after_interrupt", {
        turnId: id,
      });
      throw new AgentLifecycleError(
        AGENT_INTERRUPTED_BEFORE_TOOL_DISPATCH,
        "stale_dispatch",
        "aborted_before_dispatch"
      );
    }
    if (row.status === "closed" || row.status === "failed") {
      this.recordDebugPhase(channelId, "turn_ledger.external_wait_after_terminal", {
        turnId: id,
        status: row.status,
      });
      throw new AgentLifecycleError(
        `Agent turn is already ${row.status}; cannot dispatch tool call.`,
        "stale_dispatch",
        "aborted_before_dispatch"
      );
    }
    if (
      !this.transitionTurn(
        id,
        ["starting", "running_model", "continuing", "waiting_external"],
        "waiting_external"
      )
    ) {
      const latest = this.loadTurnRun(id);
      if (latest?.status === "interrupted") {
        this.recordDebugPhase(channelId, "turn_ledger.external_wait_interrupt_race", {
          turnId: id,
        });
        throw new AgentLifecycleError(
          AGENT_INTERRUPTED_BEFORE_TOOL_DISPATCH,
          "stale_dispatch",
          "aborted_before_dispatch"
        );
      }
      throw new Error(
        `Could not transition turn ${id} to waiting_external from ${latest?.status ?? "missing"}`
      );
    }
    return id;
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

  /**
   * Record a credential wait on the suspension spine. The resume cursor (message
   * count) is computed up front and written ONCE — no detached second writer, so
   * there is no orphan-row resurrection race (P1-2). `requestId` is set for a
   * deferred wait (so an inbound onDeferredResult matches); absent for the
   * reconnect/missing waits resumed by the UI credential-connected callback.
   */
  private recordModelCredentialInterruption(
    channelId: string,
    providerId: string,
    modelBaseUrl: string,
    turnId?: string,
    requestId?: string
  ): void {
    const resolvedTurnId = turnId ?? this.currentTurnIdForChannel(channelId);
    if (!resolvedTurnId) return; // no turn to suspend
    const id = credentialSuspensionId(channelId, providerId);
    // Write the row SYNCHRONOUSLY (cursor 0) so the park never blocks on a model
    // round-trip before throwing, and a racing delivery always finds a complete
    // row. Refine the resume cursor out-of-band via a CONDITIONAL update that
    // can't resurrect a resolved row (P1-2). In the common case the resume keys
    // off the credential-required assistant message anyway, so cursor 0 is fine.
    this.suspensions.record({
      id,
      channelId,
      turnId: resolvedTurnId,
      reason: "credential",
      ...(requestId ? { requestId } : {}),
      resumeCount: 0,
      payload: { providerId, modelBaseUrl },
    });
    if (this.runners.has(channelId)) {
      void this.readRunnerMessages(channelId)
        .then((messages) => this.suspensions.setResumeCountIfSuspended(id, messages.length))
        .catch((err) =>
          console.warn(
            `[TrajectoryVesselBase] recordModelCredentialInterruption: readRunnerMessages failed:`,
            err
          )
        );
    }
    // Durable liveness backstop: arm a server-driven alarm so the wait resumes
    // even if the onDeferredResult push is lost and the DO is otherwise idle
    // (e.g. evicted between approval-request and approval). The alarm redrives;
    // delivery is idempotent, so a redundant fire after a successful push is a
    // no-op (P1-4).
    this.setAlarm(CREDENTIAL_BACKSTOP_ALARM_MS);
  }

  private findModelCredentialInterruptionByRequestId(
    requestId: string
  ): { channelId: string; providerId: string; modelBaseUrl?: string } | null {
    const row = this.suspensions.findByRequestId(requestId);
    if (!row || row.reason !== "credential") return null;
    const providerId = (row.payload["providerId"] as string | undefined) ?? "";
    const modelBaseUrl = (row.payload["modelBaseUrl"] as string | undefined) ?? undefined;
    return {
      channelId: row.channelId,
      providerId,
      ...(modelBaseUrl ? { modelBaseUrl } : {}),
    };
  }

  private clearModelCredentialInterruption(channelId: string, providerId: string): void {
    this.suspensions.resolve(credentialSuspensionId(channelId, providerId));
  }

  /**
   * Inbound delivery of a settled deferred server call. Routes a deferred
   * credentials.resolveCredential resolution (credential-use approval) back to
   * the parked model-acquisition; anything else falls through to the generic
   * DurableObjectBase handler.
   */
  override async onDeferredResult(payload: {
    requestId: string;
    result: unknown;
    isError: boolean;
  }): Promise<{ ok: boolean }> {
    if (this.caller?.callerKind !== "server") {
      throw new Error("onDeferredResult requires a server caller");
    }
    const requestId = payload && typeof payload.requestId === "string" ? payload.requestId : null;
    const interruption = requestId
      ? this.findModelCredentialInterruptionByRequestId(requestId)
      : null;
    if (interruption) {
      await this.resolveDeferredModelCredential(interruption, Boolean(payload.isError));
      return { ok: true };
    }
    // A credential deferral whose interruption row isn't written yet (raced ahead
    // of getApiKey's park). Buffer it; the deferred branch applies it after writing
    // the row. (Distinguished from generic deferred calls, which always persist
    // their row before issuing, so super finds them.)
    if (requestId && this.inFlightCredentialDeferrals.has(requestId)) {
      this.bufferedCredentialDeliveries.set(requestId, { isError: Boolean(payload.isError) });
      return { ok: true };
    }
    return super.onDeferredResult(payload);
  }

  private async resolveDeferredModelCredential(
    interruption: { channelId: string; providerId: string; modelBaseUrl?: string },
    isError: boolean
  ): Promise<void> {
    const { channelId, providerId } = interruption;
    const modelBaseUrl = interruption.modelBaseUrl ?? this.getModelBaseUrl(channelId);
    if (isError) {
      // Approval was declined / errored — surface the credential card so the
      // user can reconnect or retry. The wait stays parked, but it is no longer
      // redrivable by requestId; otherwise the backstop alarm would re-prompt
      // the same denied approval on every wake.
      this.suspensions.clearRequestIdIfSuspended(credentialSuspensionId(channelId, providerId));
      this.recordDebugPhase(channelId, "model_credential.deferred.denied", {
        providerId,
        modelBaseUrl,
      });
      this.emitModelCredentialRequiredCard(channelId, providerId, modelBaseUrl, {
        resumeAfterConnect: true,
        reason: "Model credential approval was declined.",
        ...(this.currentTurnIdForChannel(channelId)
          ? { turnId: this.currentTurnIdForChannel(channelId) ?? undefined }
          : {}),
      });
      return;
    }
    this.recordDebugPhase(channelId, "model_credential.deferred.approved", {
      providerId,
      modelBaseUrl,
    });
    // Re-probe + rewind: resolveCredential now succeeds (grant persisted, or the
    // approval applies to this resume), and the turn continues. This clears the
    // interruption on success.
    await this.resumeAfterModelCredentialConnected(channelId, {
      providerId,
      ...(interruption.modelBaseUrl ? { modelBaseUrl: interruption.modelBaseUrl } : {}),
    });
  }

  private async ensureChannelContext(channelId: string): Promise<void> {
    await this.refreshRoster(channelId);
    await this.getOrCreateRunner(channelId);
  }

  private recordAbort(channelId: string, reason: AgentAbortReason, detail?: string): void {
    this.abortContexts.set(channelId, { reason, detail, at: Date.now() });
    if (reason !== "channel-unsubscribe") {
      console.log(
        `[TrajectoryVesselBase] Agent abort requested on channel=${channelId}: ` +
          `reason=${reason}${detail ? ` detail=${detail}` : ""}`
      );
    }
  }

  // ── Dispatch + typing (delegated to TurnDispatcher) ─────────────────────
  //
  // One TurnDispatcher per channel. Every incoming user message flows
  // through `dispatcher.submit`; the dispatcher owns the queue, steer
  // tracking, self-healing sweep, and typing-indicator broadcasts.
  // See `turn-dispatcher.ts` for the full state-machine doc.

  protected dispatchers = new Map<string, TurnDispatcher>();
  protected dispatcherRunners = new Map<string, PiRunner>();

  protected getOrCreateDispatcher(channelId: string, requestedRunner: PiRunner): TurnDispatcher {
    const canonicalRunner = this.runners.get(channelId)?.runner ?? requestedRunner;
    const existing = this.dispatchers.get(channelId);
    if (existing) {
      const existingRunner = this.dispatcherRunners.get(channelId);
      if (!existingRunner) {
        this.dispatcherRunners.set(channelId, canonicalRunner);
        return existing;
      }
      if (existingRunner === canonicalRunner) return existing;
      this.recordInvariantViolation(channelId, "dispatcher_runner_mismatch", {
        hasExistingRunner: Boolean(existingRunner),
        requestedRunnerIsCanonical: requestedRunner === canonicalRunner,
        hasCanonicalRunner: Boolean(this.runners.get(channelId)?.runner),
      });
      existing.dispose();
      this.dispatchers.delete(channelId);
      this.dispatcherRunners.delete(channelId);
    }
    const runner = canonicalRunner;
    const dispatcher = new TurnDispatcher({
      runner,
      notifyTyping: (busy) => this.broadcastTyping(channelId, busy),
      onWorkStart: async (work) => {
        await this.ensureExpectedChannelToolsAvailable(channelId, `turn_dispatcher.${work.kind}`);
        if (work.kind === "continue") {
          const turnId = work.turnId ?? this.currentTurnIdForChannel(channelId);
          if (!turnId) {
            throw new Error("Cannot continue without an existing agent turn");
          }
          const row = this.loadTurnRun(turnId);
          if (!row) {
            throw new Error(`Cannot continue unknown agent turn ${turnId}`);
          }
          this.recordDebugPhase(channelId, "turn_ledger.continuing", {
            turnId,
            workKind: work.kind,
          });
          return turnId;
        }
        await this.supersedeOrphanedOpenTurn(channelId, runner);
        const turnId = crypto.randomUUID();
        let entryId: string | null = null;
        try {
          entryId = (await runner.session?.getLeafId?.()) ?? null;
        } catch (err) {
          this.recordLastError("turn_checkpoint.turn_open", err, channelId);
        }
        await this.insertTurnRun(channelId, turnId, { phase: "turn_open", entryId });
        this.recordDebugPhase(channelId, "turn_ledger.started", {
          turnId,
          workKind: work.kind,
        });
        return turnId;
      },
      onWorkFailure: async (work, error, workTurnId) => {
        const turnId = workTurnId ?? (work.kind === "continue" ? work.turnId : undefined);
        if (
          turnId &&
          (modelCredentialReconnectFailure(error) || isModelCredentialApprovalPendingFailure(error))
        ) {
          const row = this.loadTurnRun(turnId);
          if (row?.status === "waiting_external") {
            // A credential wait (reconnect or approval-pending) parked this turn;
            // it stays open for the resume. Don't fail the ledger or surface a
            // work-failure diagnostic — the open turn keeps the dispatcher
            // steering new input in, and the resume continues the turn.
            this.recordDebugPhase(channelId, "turn_dispatcher.credential_wait_failure_suppressed", {
              turnId,
              workKind: work.kind,
              error: error instanceof Error ? error.message : String(error),
            });
            return;
          }
        }
        if (turnId) {
          this.transitionTurn(
            turnId,
            ["starting", "running_model", "waiting_external", "continuing", "closing"],
            "failed",
            {
              failureCode: (error as { code?: unknown } | null)?.code
                ? String((error as { code?: unknown }).code)
                : "work_failed",
              failureMessage: error instanceof Error ? error.message : String(error),
            }
          );
        }
        if (work.kind === "continue") {
          await this.emitRecoveryContinueFailedDiagnostic(channelId, error);
          return;
        }
        await this.emitTurnWorkFailureDiagnostic(channelId, work.kind, error);
      },
      onSteeredMessageObserved: async (steeringId) => {
        this.markPendingSteeringObserved(steeringId);
      },
      diagnosticContext: () => ({
        channelId,
        objectKey: this.objectKey,
        participantId: this.subscriptions.getParticipantId(channelId),
        subscriptions: this.subscriptions.listAll(),
        runnerOpenTurnId: runner.getCurrentTurnId?.() ?? null,
      }),
      onInvariantViolation: async (code, detail) => {
        this.recordInvariantViolation(channelId, code, detail);
        if (
          code === "dispatcher_drain_loop_crashed" ||
          code === "dispatcher_on_work_failure_failed"
        ) {
          await this.emitInfrastructureDiagnostic(
            channelId,
            code,
            `Agent dispatcher invariant failed: ${code}. See debug state for details.`,
            detail
          );
        }
      },
      // The drain loop is started fire-and-forget from whichever inbound
      // request enqueued the work; that request returns immediately, so
      // workerd would otherwise bind the drain's promise continuations (and
      // the in-flight method-call result waiter created inside the turn) to an
      // already-completed request context and cancel them on cross-request
      // resolution ("A promise was resolved or rejected from a different
      // request context..."). Anchoring the drain to ctx.waitUntil keeps a
      // live context around for the warm turn. It is best-effort: a long
      // suspension (e.g. askUser) that outlives the keep-alive window simply
      // falls back to the durable suspension-recovery path on the next event.
      // Optional-chained because some workerd builds / test stubs omit it.
      keepAlive: (promise) => {
        this.ctx.waitUntil?.(promise);
      },
    });
    this.dispatchers.set(channelId, dispatcher);
    this.dispatcherRunners.set(channelId, runner);
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

  private missingExpectedChannelTools(channelId: string): string[] {
    const expected = this.getExpectedChannelToolNames(channelId);
    if (!expected?.length) return [];
    const available = new Set(
      (this.cachedRoster.get(channelId) ?? []).map((method) => method.name)
    );
    return [...new Set(expected)].filter((name) => !available.has(name));
  }

  private async ensureExpectedChannelToolsAvailable(
    channelId: string,
    reason: string
  ): Promise<void> {
    const expected = this.getExpectedChannelToolNames(channelId);
    if (!expected?.length) return;

    const timeoutMs = Math.max(0, this.getExpectedChannelToolReadinessTimeoutMs(channelId));
    const deadline = Date.now() + timeoutMs;
    let missing: string[] = [];
    let attempts = 0;
    do {
      attempts += 1;
      await this.refreshRoster(channelId);
      missing = this.missingExpectedChannelTools(channelId);
      if (missing.length === 0) return;
      if (Date.now() >= deadline) break;
      await sleep(
        Math.min(EXPECTED_CHANNEL_TOOL_READY_POLL_MS, Math.max(0, deadline - Date.now()))
      );
    } while (true);

    const rosterToolNames = [
      ...new Set((this.cachedRoster.get(channelId) ?? []).map((m) => m.name)),
    ].sort();
    const participants = this.cachedParticipants.get(channelId) ?? [];
    const detail = {
      channelId,
      reason,
      attempts,
      timeoutMs,
      missingExpectedChannelToolNames: missing,
      expectedChannelToolNames: [...new Set(expected)],
      rosterToolNames,
      participantCount: participants.length,
      participants: participants.slice(0, DEBUG_COLLECTION_LIMIT).map((participant) => ({
        participantId: participant.participantId,
        handle: participant.metadata["handle"],
        type: participant.metadata["type"],
        methodNames: Array.isArray(participant.metadata["methods"])
          ? (participant.metadata["methods"] as Array<Record<string, unknown>>)
              .map((method) => method?.["name"])
              .filter((name): name is string => typeof name === "string")
          : [],
      })),
    };
    console.error("[TrajectoryVesselBase] Expected channel tools were not available", detail);
    this.recordDebugPhase(channelId, "channel_tools.expected_missing", detail);
    throw new AgentWorkerError(
      "invalid_state",
      `Cannot start agent model turn: missing expected channel tool(s): ${missing.join(", ")}`
    );
  }

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
    try {
      throwIfAbortSignalAborted(signal);
      const channel = this.createChannelClient(channelId);
      const participants = await channel.getParticipants();
      const target = participants.find((p) => p.metadata["handle"] === participantHandle);
      if (!target) {
        throw new Error(
          `No participant with handle "${participantHandle}" in channel ${channelId}`
        );
      }
      const callerId = this.subscriptions.getParticipantId(channelId);
      if (!callerId) throw new Error(`Not subscribed to channel ${channelId}`);
      throwIfAbortSignalAborted(signal);

      const invocationId = toolCallId;
      const transportCallId = crypto.randomUUID();
      const suspensionTurnId = await this.transitionCurrentTurnToWaiting(channelId, turnId);
      const recorded = await this.recordMethodSuspension({
        channelId,
        transportCallId,
        invocationId,
        kind: "channelMethod",
        method,
        participantHandle,
        targetParticipantId: target.participantId,
        args,
        turnId: suspensionTurnId,
        fallbackToolName: method,
      });
      if (!recorded) throw new Error(`Failed to record durable suspension for ${method}`);
      const waiter = this.createMethodResultWaiter(channelId, transportCallId, invocationId, {
        method,
        participantHandle,
        targetParticipantId: target.participantId,
        args,
        turnId: suspensionTurnId,
        signal,
      });
      if (onStreamUpdate) this.streamCallbacks.set(transportCallId, onStreamUpdate);
      try {
        try {
          await channel.callMethod(callerId, target.participantId, transportCallId, method, args, {
            invocationId,
            transportCallId,
            turnId: suspensionTurnId,
          });
        } catch (err) {
          this.markMethodSuspensionDispatchFailed(transportCallId, err);
          waiter.cancel(err);
          void waiter.promise.catch(() => undefined);
          throw err;
        }
        const completion = await waiter.promise;
        const toolResult = completion.isError
          ? methodErrorResult(completion.result, "method_failed")
          : toAgentToolResult(completion.result);
        return this.toolResultForAdmission(
          toolResult,
          `live channel method result channel=${channelId} invocation=${invocationId}`
        );
      } catch (err) {
        this.cancelMethodSuspension(transportCallId, "waiter_rejected");
        waiter.cancel(err);
        await this.cancelChannelMethodCall(channelId, transportCallId);
        throw err;
      } finally {
        this.streamCallbacks.delete(transportCallId);
        this.recordIfSuspensionStillPending(channelId, transportCallId);
      }
    } catch (err) {
      if (err instanceof AgentLifecycleError) return lifecycleToolResult(err);
      throw err;
    }
  }

  private async askUser(
    channelId: string,
    toolCallId: string,
    params: AskUserParams,
    signal: AbortSignal | undefined,
    turnId?: string
  ): Promise<string | AgentToolResult<any>> {
    try {
      throwIfAbortSignalAborted(signal);
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
      throwIfAbortSignalAborted(signal);

      const invocationId = toolCallId || crypto.randomUUID();
      const transportCallId = crypto.randomUUID();
      const suspensionTurnId = await this.transitionCurrentTurnToWaiting(channelId, turnId);
      const recorded = await this.recordMethodSuspension({
        channelId,
        transportCallId,
        invocationId,
        kind: "askUser",
        method: "feedback_form",
        targetParticipantId: panel.participantId,
        args: params,
        turnId: suspensionTurnId,
        fallbackToolName: "feedback_form",
      });
      if (!recorded) throw new Error("Failed to record durable askUser suspension");
      const waiter = this.createMethodResultWaiter(channelId, transportCallId, invocationId, {
        method: "feedback_form",
        targetParticipantId: panel.participantId,
        args: params,
        turnId: suspensionTurnId,
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
              turnId: suspensionTurnId,
            }
          );
        } catch (err) {
          this.markMethodSuspensionDispatchFailed(transportCallId, err);
          waiter.cancel(err);
          void waiter.promise.catch(() => undefined);
          throw err;
        }
        const completion = await waiter.promise;
        if (completion.isError) return methodErrorResult(completion.result, "method_failed");
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
    } catch (err) {
      if (err instanceof AgentLifecycleError) return lifecycleToolResult(err);
      throw err;
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
    modelBaseUrl: string,
    opts?: {
      resumeAfterConnect?: boolean;
      reason?: string;
      diagnosticReason?: string;
      failureCode?: string;
      turnId?: string;
    }
  ): void {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const key = `${channelId}::model-credential::${providerId}::${
      opts?.resumeAfterConnect === false ? "connect-only" : "resume-turn"
    }`;
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
    const cardId = `model-credential-${providerId}-${crypto.randomUUID()}`;
    const props = {
      providerId,
      modelBaseUrl,
      agentParticipantId: participantId,
      browserHandoffCallerId,
      browserHandoffCallerKind: browserHandoffCallerId ? "panel" : undefined,
      browserHandoffPlatform,
      resumeAfterConnect: opts?.resumeAfterConnect,
      reason: opts?.reason,
      diagnosticReason: opts?.diagnosticReason,
      failureCode: opts?.failureCode,
      ...(this.getModelCredentialSetupProps(providerId) ?? {}),
    };
    const event: AgenticEvent<"ui.inline_rendered"> = {
      kind: "ui.inline_rendered",
      actor: {
        kind: "agent",
        id: participantId,
        displayName: participantId,
      },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "inline",
        id: cardId,
        source: { type: "code", code: MODEL_CREDENTIAL_REQUIRED_CARD_TSX },
        props,
      },
      ...(opts?.turnId ? { turnId: opts.turnId as never } : {}),
      createdAt: new Date().toISOString(),
    };
    const delivery = channel
      .publishAgenticEvent(participantId, event, {
        idempotencyKey: cardId,
        senderMetadata: { type: "agent", name: participantId },
      })
      .catch((err) => {
        console.error(
          `[TrajectoryVesselBase] Failed to emit model credential card for ${providerId}:`,
          err
        );
        this.credentialPromptCardsEmitted.delete(key);
      });
    this.ctx.waitUntil?.(delivery);
    void delivery;
  }

  private publishTurnWaitingEvent(
    channelId: string,
    turnId: string,
    payload: { reason: TurnReasonCode; summary: string }
  ): void {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const event: AgenticEvent<"turn.waiting"> = {
      kind: "turn.waiting",
      actor: {
        kind: "agent",
        id: participantId,
        displayName: participantId,
      },
      turnId: turnId as never,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        summary: payload.summary,
        reason: payload.reason,
      },
      createdAt: new Date().toISOString(),
    };
    const delivery = this.createChannelClient(channelId)
      .publishAgenticEvent(participantId, event, {
        idempotencyKey: `turn-waiting:${turnId}:${payload.reason}`,
        senderMetadata: { type: "agent", name: participantId },
      })
      .catch((err) => {
        this.recordLastError("turn_waiting.publish_failed", err, channelId);
        this.recordDebugPhase(channelId, "turn_waiting.publish_failed", {
          turnId,
          reason: payload.reason,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    this.ctx.waitUntil?.(delivery);
    void delivery;
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
      this.recordLastError("channel_method.cancel_call", err, channelId);
      this.recordDebugPhase(channelId, "channel_method.cancel_call.failed", {
        callId,
        error: err instanceof Error ? err.message : String(err),
      });
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
    const waiter = this.methodResultWaiters.get(callId);
    const row = this.loadMethodSuspension(callId);
    if (!row) {
      const hydratedResult = await this.hydrateStoredTransportValue(result);
      this.recordDebugPhase(channelId, "channel_method.orphan_result_without_suspension", {
        callId,
        isError,
        waiterPresent: Boolean(waiter),
      });
      if (waiter) {
        waiter.resolve({ result: hydratedResult, isError });
        return;
      }
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

    // Turn-terminal guard (ports the deleted reconcile guard, 2634-2645): a tool
    // that raced a user interrupt can record a fresh pending suspension on a turn
    // that then became interrupted/failed. Admitting it would resurrect a stopped
    // agent ("stopped agent churns again"). Mark it ignored and stop.
    if (row.turnId) {
      const turn = this.loadTurnRun(row.turnId);
      if (turn && isTerminalRunPhase(turn.status)) {
        this.recordDebugPhase(channelId, "channel_method.terminal_on_terminal_turn_ignored", {
          callId,
          invocationId: row.invocationId,
          turnId: row.turnId,
          turnStatus: turn.status,
        });
        this.markMethodSuspensionIgnored(callId, { result, isError });
        return;
      }
    }

    // Validate that stored-value refs resolve before committing a terminal:
    // a missing blob must leave the suspension pending for retry rather than
    // persisting an unhydratable ref. We still store the raw (ref-preserving)
    // result so spilled payloads (e.g. large eval output) keep their original
    // blobstore ref instead of being hydrated and re-spilled into a duplicate
    // blob by encodeSuspensionStorage; the hydrated form is recomputed at the
    // model-visible boundary — here for a live waiter, or in
    // composeRecoveredToolResult during recovery.
    const hydratedResult = await this.hydrateStoredTransportValue(
      result,
      `method result channel=${channelId} call=${callId} invocation=${row.invocationId}`
    );
    await this.markMethodSuspensionTerminal(callId, {
      terminalKind,
      result,
      isError,
      eventId,
      waiterPresent: Boolean(waiter),
    });
    if (waiter) {
      waiter.resolve({ result: hydratedResult, isError });
      return;
    }

    // Defer the recovery continuation during replay: terminals marked while
    // replaying are admitted exactly once by the control:ready hook, after the
    // full log has been processed. Avoids kicking recovery per-terminal mid-replay.
    if (this.channelsInReplay.has(channelId)) return;

    await this.getOrCreateRunner(channelId);
    await this.runOnChannelRecoveryChain(channelId, async () => {
      await this.recoverDeliveredAndOrphanedSuspensions(channelId);
    });
  }

  private async handleMethodProgress(
    channelId: string,
    callId: string,
    content: unknown
  ): Promise<void> {
    // Progress streams only while the suspension is live/pending. Drop it once
    // the suspension is terminal/cancelled/admitted or its turn is terminal —
    // a chunk that races the terminal must not append to a settled suspension.
    const row = this.loadMethodSuspension(callId);
    if (!row || row.terminalKind !== "none" || row.deliveryStatus !== "pending") return;
    if (row.turnId) {
      const turn = this.loadTurnRun(row.turnId);
      if (turn && isTerminalRunPhase(turn.status)) return;
    }
    // Keep stored-value refs intact in the suspension ledger so large payloads
    // stay in the blobstore instead of being inlined into DO SQLite. Hydration
    // happens only at the live stream callback boundary.
    this.appendMethodSuspensionUpdate(callId, content);
    const cb = this.streamCallbacks.get(callId);
    if (cb) {
      cb(
        await this.hydrateStoredTransportValue(
          content,
          `method progress channel=${channelId} call=${callId}`
        )
      );
    }
  }

  private async dispatchUiPrompt(
    channelId: string,
    toolCallId: string,
    kind: "select" | "confirm" | "input" | "editor",
    params: Record<string, unknown>,
    signal?: AbortSignal,
    meta?: { toolName?: string; toolInput?: unknown; mode?: "approval" | "ui-prompt" }
  ): Promise<unknown> {
    try {
      throwIfAbortSignalAborted(signal);
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
      throwIfAbortSignalAborted(signal);

      const transportCallId = crypto.randomUUID();
      const turnId = this.currentTurnIdForChannel(channelId);
      const suspensionTurnId = await this.transitionCurrentTurnToWaiting(channelId, turnId);
      const recorded = await this.recordMethodSuspension({
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
        turnId: suspensionTurnId,
        fallbackToolName: meta?.toolName ?? "ui_prompt",
        requireOpenInvocation: true,
      });
      if (!recorded) {
        throw new Error("Cannot dispatch UI prompt without a durable suspension row");
      }
      const waiter = this.createMethodResultWaiter(channelId, transportCallId, invocationId, {
        method: "ui_prompt",
        targetParticipantId: panel.participantId,
        args: { kind, ...params },
        turnId: suspensionTurnId,
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
              turnId: suspensionTurnId,
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
    } catch (err) {
      if (err instanceof AgentLifecycleError) return lifecycleToolResult(err);
      throw err;
    }
  }

  private async notifyDispatchesInterrupted(channelId: string): Promise<void> {
    const pendingCalls = [...this.methodResultWaiters.entries()]
      .filter(([, waiter]) => waiter.channelId === channelId)
      .map(([callId, waiter]) => ({ callId, invocationId: waiter.invocationId }));
    this.abortRecoveryDirectExecutions(channelId, "user_interrupted");
    this.cancelMethodSuspensionsForChannel(channelId, "user_interrupted");
    this.rejectMethodWaitersForChannel(channelId, "Request was aborted");
    for (const { callId, invocationId } of pendingCalls) {
      try {
        // channel.cancelCall emits invocation.cancelled; the provider aborts its
        // executor (and feedback UIs complete) by observing that terminal.
        await this.cancelChannelMethodCall(channelId, callId);
      } catch (err) {
        this.recordLastError("channel_method.dispatch_cancel", err, channelId);
        this.recordDebugPhase(channelId, "channel_method.dispatch_cancel.failed", {
          callId,
          invocationId,
          error: err instanceof Error ? err.message : String(err),
        });
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
    await this.refreshRoster(channelId);
    if (!(await this.shouldRespond(channelId, event))) return;
    await this.getOrCreateRunner(channelId);

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
    const turnInput = this.turnInputForAdmission(
      { content: input.content, ...(images ? { images } : {}) },
      `user turn input channel=${channelId}`
    );
    // Mid-turn steering must be durable. Channel delivery is durable, but the
    // runner/dispatcher steering queue is in-memory; if the DO hibernates while
    // a tool call or model turn is active, an accepted steer can otherwise be
    // lost before the runner consumes it. Persist any steer for the current
    // turn, then mark it observed when the runner starts that exact message (or
    // requeues it as a fresh prompt).
    const dispatcherState = (
      dispatcher as {
        getDebugState?: () => {
          busy?: unknown;
          activeWork?: { turnId?: unknown } | null;
        };
      }
    ).getDebugState?.();
    const openTurnId =
      runner.getCurrentTurnId?.() ??
      (typeof dispatcherState?.activeWork?.turnId === "string"
        ? dispatcherState.activeWork.turnId
        : undefined);
    const dispatcherBusy = Boolean(dispatcherState?.busy);
    const hasExternalWait = openTurnId ? this.turnHasOpenExternalWait(openTurnId) : false;
    if (
      openTurnId &&
      (hasExternalWait || ((!opts || opts.mode !== "sequential") && dispatcherBusy))
    ) {
      const steeringId = this.durableSteeringId(channelId, event);
      if (!this.persistPendingSteering(channelId, openTurnId, steeringId, turnInput)) {
        return;
      }
      if (hasExternalWait) {
        dispatcher.steerIntoActiveTurn(turnInput, { steeringId });
        return;
      }
      dispatcher.submit(turnInput, { ...opts, steeringId });
      return;
    }
    dispatcher.submit(turnInput, opts);
  }

  async onChannelEnvelope(channelId: string, envelope: RpcChannelMessage): Promise<void> {
    await this.ensureAgentActivationReady();
    if (envelope.kind === "control") {
      if (envelope.type === "ready") {
        this.channelsInReplay.delete(channelId);
        // Replay finished: admit any terminals marked during replay exactly once.
        // Routes through the poison-guarded recovery (skips a poisoned channel)
        // and never submits a Pi continuation directly. Idempotent with the
        // wake-time recoverFromTurnLedger recovery via the serialized chain.
        void this.runOnChannelRecoveryChain(channelId, async () => {
          await this.recoverDeliveredAndOrphanedSuspensions(channelId);
        });
      }
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
      return;
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
      let originalBase64: string | undefined;
      try {
        originalBase64 = imageBinaryToBase64(att.data);
        const bytes = Buffer.from(originalBase64, "base64");
        const resized = await imageService.resize(bytes, att.mimeType, {
          maxWidth: 2000,
          maxHeight: 2000,
        });
        images.push({
          type: "image",
          mimeType: resized.mimeType,
          data: imageBinaryToBase64(resized.data),
        });
      } catch (err) {
        console.warn(
          `[TrajectoryVesselBase] image-service.resize failed for channel=${channelId}; passing original:`,
          err
        );
        try {
          originalBase64 ??= imageBinaryToBase64(att.data);
          images.push({ type: "image", mimeType: att.mimeType, data: originalBase64 });
        } catch {
          // The attachment reached this worker in an unsupported shape. We
          // cannot safely forward it to the model as image content.
        }
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
    const suspensionId = credentialSuspensionId(channelId, providerId);
    const suspension = this.suspensions.findById(suspensionId);
    if (suspension) {
      const storedModelBaseUrl =
        (suspension.payload["modelBaseUrl"] as string | undefined) ?? undefined;
      if (opts?.modelBaseUrl && storedModelBaseUrl && storedModelBaseUrl !== opts.modelBaseUrl) {
        this.recordDebugPhase(channelId, "model_credential.resume_model_base_mismatch", {
          providerId,
          requestedModelBaseUrl: opts.modelBaseUrl,
          storedModelBaseUrl,
        });
        return false;
      }
      const row = this.loadTurnRun(suspension.turnId);
      if (
        row?.status === "closed" ||
        row?.status === "failed" ||
        row?.status === "interrupted" ||
        this.runControllerFor(channelId).isResumeBlocked(suspension.turnId)
      ) {
        this.suspensions.resolve(suspensionId);
        this.recordDebugPhase(channelId, "model_credential.resume_terminal_turn_dropped", {
          providerId,
          turnId: suspension.turnId,
          status: row?.status ?? "missing",
        });
        return false;
      }
    }
    // Idempotent resume: atomically claim the suspension. A concurrent trigger
    // (duplicate onDeferredResult, restart redrive, UI credential-connected) that
    // already claimed turns this into a no-op — the single guard that kills the
    // double-resume race (P1-1). No row ⇒ a legacy last-message-driven resume.
    if (suspension) {
      if (suspension.reason !== "credential" || !this.suspensions.claimResume(suspensionId)) {
        this.recordDebugPhase(channelId, "model_credential.resume_already_claimed", { providerId });
        return false;
      }
    }
    // Re-arm the claim if we bail before continuing, so a later trigger can retry.
    const bail = (): false => {
      if (suspension) this.suspensions.releaseClaim(suspensionId);
      return false;
    };

    const resumeCount = suspension?.resumeCount ?? 0;
    const messages = await this.readRunnerMessages(channelId);
    const last = messages[messages.length - 1];
    let resumableMessages: AgentMessage[];
    if (isCredentialRequiredAssistantMessage(last)) {
      resumableMessages = messages.slice(0, -1);
    } else if (suspension && resumeCount > 0 && messages.length >= resumeCount) {
      resumableMessages = messages.slice(0, resumeCount);
    } else {
      console.warn(
        `[TrajectoryVesselBase] credential resume failed for channel=${channelId}: ` +
          `no resumable turn provider=${providerId} messages=${messages.length} ` +
          `resumeCount=${resumeCount} lastRole=${String((last as { role?: unknown } | undefined)?.role ?? "none")} ` +
          `lastStop=${String((last as { stopReason?: unknown } | undefined)?.stopReason ?? "none")}`
      );
      return bail();
    }

    const resumeFrom = resumableMessages[resumableMessages.length - 1] as
      | { role?: string }
      | undefined;
    if (!resumeFrom || (resumeFrom.role !== "user" && resumeFrom.role !== "toolResult")) {
      const rewound = lastModelCredentialResumePrefix(resumableMessages);
      if (rewound.length === 0) {
        console.warn(
          `[TrajectoryVesselBase] credential resume failed for channel=${channelId}: ` +
            `resume cursor is ${String(resumeFrom?.role ?? "missing")}`
        );
        return bail();
      }
      this.recordDebugPhase(channelId, "model_credential.resume_cursor_rewound", {
        providerId,
        fromRole: resumeFrom?.role ?? "missing",
        fromCount: resumableMessages.length,
        toCount: rewound.length,
      });
      resumableMessages = rewound;
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
      return bail();
    }
    const turnId = suspension?.turnId;
    if (turnId) {
      const latest = this.loadTurnRun(turnId);
      if (
        latest?.status === "closed" ||
        latest?.status === "failed" ||
        latest?.status === "interrupted" ||
        this.runControllerFor(channelId).isResumeBlocked(turnId)
      ) {
        this.suspensions.resolve(suspensionId);
        this.recordDebugPhase(channelId, "model_credential.resume_terminal_turn_dropped", {
          providerId,
          turnId,
          status: latest?.status ?? "missing",
        });
        return false;
      }
    }
    await entry.runner.session?.moveTo(target.id);
    if (turnId) {
      this.transitionTurn(turnId, ["waiting_external", "starting"], "continuing", {
        resumeCursorEntryId: target.id,
      });
    }
    this.clearModelCredentialInterruption(channelId, providerId);
    this.credentialPromptCardsEmitted.delete(
      `${channelId}::model-credential::${providerId}::resume-turn`
    );
    this.credentialPromptCardsEmitted.delete(
      `${channelId}::model-credential::${providerId}::connect-only`
    );
    this.submitRecoveryContinue(channelId, entry.runner, "model_credential_connected", turnId);
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
    reason: AgentAbortReason = "interrupt-channel",
    detail?: string
  ): Promise<void> {
    await this.ensureAgentActivationReady();
    this.abortModelCredentialResolution(channelId, "Model credential resolution aborted by user");
    const entry = this.runners.get(channelId);
    const dispatcher = this.dispatchers.get(channelId);
    if (entry) {
      // Drop any pending/steered messages AND suppress auto-continuation until
      // the next user message — interrupt means the user wants everything
      // stopped, not just the current turn. Without this, a suspension result
      // or recovery pass that resolves after the interrupt re-submits a
      // `continue`, restarting the agent loop with a fresh (non-aborted) signal
      // so it keeps churning. `interrupt()` also clears pi-core's steering
      // queue and broadcasts typing=false (via reset()).
      dispatcher?.interrupt();
      this.recordAbort(channelId, reason, detail);
      // Abort the active Pi run before manufacturing cancellation results for
      // outstanding method dispatches. If the loop sees those cancelled tool
      // results while its signal is still live, it can feed them back into the
      // model and continue after the user pressed stop.
      const abort = (entry.runner as { abort?: () => Promise<unknown> }).abort;
      void abort?.call(entry.runner)?.catch((err) => {
        this.recordLastError("runner.abort", err, channelId);
        this.recordDebugPhase(channelId, "runner.abort.failed", {
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
        console.warn(`[TrajectoryVesselBase] runner abort failed for channel=${channelId}:`, err);
      });
      await this.notifyDispatchesInterrupted(channelId);
      const turnId =
        (entry.runner as { getCurrentTurnId?: () => string | null }).getCurrentTurnId?.() ??
        this.currentTurnRunForChannel(channelId)?.turnId;
      if (turnId) {
        // Consolidated authoritative gate: record the user interrupt on this
        // turn so every resume path drops intrinsically (in addition to the
        // durable terminal `interrupted` status written just below).
        this.runControllerFor(channelId).gateInterrupt(turnId);
        this.suspensions.clearForTurn(channelId, turnId);
        this.transitionTurn(
          turnId,
          ["starting", "running_model", "waiting_external", "continuing", "closing"],
          "interrupted",
          {
            failureCode: "user_interrupted",
            failureMessage: "Turn closed after user interruption",
          }
        );
      }

      // A provider stream or pi-core promise may be wedged. The user-visible
      // pause operation must still close the durable turn and clear typing;
      // do that synchronously before asking the runner to abort best-effort.
      await entry.runner
        .forceCloseCurrentTurn("user_interrupted", "Turn closed after user interruption")
        .catch(async (err) => {
          this.recordLastError("runner.force_close", err, channelId);
          this.recordDebugPhase(channelId, "runner.force_close.failed", {
            reason,
            error: err instanceof Error ? err.message : String(err),
          });
          await this.emitInfrastructureDiagnostic(
            channelId,
            "runner_force_close_failed",
            "Agent interrupt could not durably close the active turn.",
            { reason, error: err instanceof Error ? err.message : String(err) }
          );
          console.warn(
            `[TrajectoryVesselBase] forceCloseCurrentTurn failed for channel=${channelId}:`,
            err
          );
        });
      void entry.runner.interrupt().catch((err) => {
        this.recordLastError("runner.interrupt", err, channelId);
        this.recordDebugPhase(channelId, "runner.interrupt.failed", {
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
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
    this.dispatcherRunners.clear();
    this.runnerCreations.clear();
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
      args: summarizeStoredJsonColumns(row.argsJson, row.argsRefJson),
      result: summarizeStoredJsonColumns(row.resultJson, row.resultRefJson),
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

  private summarizeMethodSuspensionRows(channelId?: string): unknown[] {
    const where = channelId ? "WHERE channel_id = ?" : "";
    const params = channelId ? [channelId] : [];
    return this.sql
      .exec(`SELECT * FROM agent_method_suspensions ${where}`, ...params)
      .toArray()
      .map((raw) => {
        const row = this.methodSuspensionRow(raw);
        return {
          transport_call_id: row.transportCallId,
          channel_id: row.channelId,
          invocation_id: row.invocationId,
          model_tool_call_id: row.modelToolCallId,
          assistant_message_id: row.assistantMessageId,
          tool_call_index: row.toolCallIndex,
          tool_name: row.toolName,
          turn_id: row.turnId,
          kind: row.kind,
          method: row.method,
          participant_handle: row.participantHandle,
          target_participant_id: row.targetParticipantId,
          terminal_kind: row.terminalKind,
          result_is_error: row.resultIsError,
          result_event_id: row.resultEventId,
          result_received_at: row.resultReceivedAt,
          delivery_status: row.deliveryStatus,
          recovered_entry_id: row.recoveredEntryId,
          recovery_error: row.recoveryError,
          args: summarizeStoredJsonColumns(row.argsJson, row.argsRefJson),
          result: summarizeStoredJsonColumns(row.resultJson, row.resultRefJson),
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        };
      });
  }

  private summarizeMethodSuspensionUpdateRows(): unknown[] {
    return this.sql
      .exec(
        `SELECT * FROM agent_method_suspension_updates ORDER BY received_at DESC LIMIT ?`,
        DEBUG_RING_LIMIT
      )
      .toArray()
      .map((row) => ({
        transport_call_id: row["transport_call_id"],
        seq: row["seq"],
        received_at: row["received_at"],
        content: summarizeDebugValue(this.parseSuspensionJson(row["content_json"] as string)),
      }));
  }

  private summarizeCachedParticipants(channelId?: string): Record<string, unknown> {
    return Object.fromEntries(
      [...this.cachedParticipants.entries()]
        .filter(([id]) => !channelId || id === channelId)
        .map(([id, participants]) => [
          id,
          participants.slice(0, DEBUG_COLLECTION_LIMIT).map((participant) => ({
            participantId: participant.participantId,
            metadata: publicParticipantMetadata(participant.metadata) ?? {},
          })),
        ])
    );
  }

  // ── Fetch override ───────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !(this as unknown as { _objectKey?: string })._objectKey) {
      (this as unknown as { _objectKey?: string })._objectKey = decodeURIComponent(segments[0]!);
    }
    const method = segments.slice(1).join("/") || "getState";

    if (
      method === "__lifecycle/prepare" ||
      method === "__lifecycle/resume" ||
      method === "__alarm"
    ) {
      return super.fetch(request);
    }

    this.ensureReady();
    this.ensureBootstrapped();
    await this.ensureAgentActivationReady();

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

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
    const readTable = (table: string): unknown[] => {
      try {
        return this.sql.exec(`SELECT * FROM ${table}`).toArray();
      } catch (err) {
        return [{ error: err instanceof Error ? err.message : String(err) }];
      }
    };
    const runnerEntries = [...this.runners.entries()]
      .filter(([id]) => !channelId || id === channelId)
      .map(([id, entry]) => [id, entry.runner.getDebugState()] as const);
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
        suspensions: readTable("suspensions"),
        methodSuspensions: this.summarizeMethodSuspensionRows(channelId),
        methodSuspensionUpdates: this.summarizeMethodSuspensionUpdateRows(),
      },
      volatile: {
        runners: Object.fromEntries(runnerEntries),
        runControllers: Object.fromEntries(
          [...this.runControllers.entries()]
            .filter(([id]) => !channelId || id === channelId)
            .map(([id, controller]) => [id, controller.getDebugState()])
        ),
        dispatchers: Object.fromEntries(
          [...this.dispatchers.entries()]
            .filter(([id]) => !channelId || id === channelId)
            .map(([id, dispatcher]) => [id, dispatcher.getDebugState()])
        ),
        dispatcherBindings: Object.fromEntries(
          [...this.dispatcherRunners.entries()]
            .filter(([id]) => !channelId || id === channelId)
            .map(([id, runner]) => [
              id,
              {
                matchesCanonicalRunner: this.runners.get(id)?.runner === runner,
                hasCanonicalRunner: this.runners.has(id),
              },
            ])
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
        recentInvariantViolations: this.recentInvariantViolations.filter(
          (violation) => !channelId || violation.channelId === channelId
        ),
        lastErrors: this.lastErrors.filter((error) => !channelId || error.channelId === channelId),
        failedEvents: [...this.failedEvents.entries()],
        channelsInReplay: [...this.channelsInReplay],
        transcriptPoisonedChannels: [...this.transcriptPoisonedChannels],
        transcriptPoisonNotified: [...this.transcriptPoisonNotified],
        credentialPromptCardsEmitted: [...this.credentialPromptCardsEmitted],
        suspensions: this.getSuspensionDebugState(channelId),
        cachedRoster: Object.fromEntries([...this.cachedRoster.entries()].filter(channelFilter)),
        cachedParticipants: this.summarizeCachedParticipants(channelId),
      },
    };
  }

  async getMethodSuspensionPayload(
    transportCallId: string
  ): Promise<{ args: unknown; result: unknown } | null> {
    await this.ensureAgentActivationReady();
    const row = this.loadMethodSuspension(transportCallId);
    if (!row) return null;
    return {
      args: await this.hydrateStoredTransportValue(
        this.parseSuspensionJson(row.argsJson, row.argsRefJson)
      ),
      result: await this.hydrateStoredTransportValue(
        this.parseSuspensionJson(row.resultJson, row.resultRefJson)
      ),
    };
  }

  async inspectMethodSuspensions(channelId?: string): Promise<Record<string, unknown>> {
    await this.ensureAgentActivationReady();
    const rows = this.summarizeMethodSuspensionRows(channelId) as Array<Record<string, unknown>>;
    const diagnostics = await Promise.all(
      rows.slice(0, DEBUG_COLLECTION_LIMIT).map(async (row) => {
        const rowChannelId = typeof row["channel_id"] === "string" ? row["channel_id"] : channelId;
        const branchId = rowChannelId ? gadBranchIdForChannel(rowChannelId) : null;
        const invocationId =
          typeof row["invocation_id"] === "string" ? row["invocation_id"] : undefined;
        const transportCallId =
          typeof row["transport_call_id"] === "string" ? row["transport_call_id"] : undefined;
        let gadInvocation: unknown = null;
        let gadError: string | null = null;
        if (branchId && (invocationId || transportCallId)) {
          try {
            gadInvocation = await this.gad.call("inspectInvocationState", {
              branchId,
              invocationId,
              transportCallId,
              limit: 5,
            });
          } catch (err) {
            gadError = err instanceof Error ? err.message : String(err);
          }
        }
        return {
          ...row,
          gad: {
            branchId,
            invocation: gadInvocation,
            error: gadError,
          },
        };
      })
    );
    return {
      generatedAt: new Date().toISOString(),
      requestedChannelId: channelId ?? null,
      summary: {
        localRows: rows.length,
        inspectedRows: diagnostics.length,
        byDeliveryStatus: Object.fromEntries(
          [...new Set(rows.map((row) => String(row["delivery_status"] ?? "unknown")))].map(
            (status) => [
              status,
              rows.filter((row) => String(row["delivery_status"] ?? "unknown") === status).length,
            ]
          )
        ),
        byTerminalKind: Object.fromEntries(
          [...new Set(rows.map((row) => String(row["terminal_kind"] ?? "none")))].map((kind) => [
            kind,
            rows.filter((row) => String(row["terminal_kind"] ?? "none") === kind).length,
          ])
        ),
      },
      rows: diagnostics,
    };
  }

  override async getState(): Promise<Record<string, unknown>> {
    await this.ensureAgentActivationReady();
    const subscriptions = this.sql.exec(`SELECT * FROM subscriptions`).toArray();
    const deliveryCursors = this.sql.exec(`SELECT * FROM delivery_cursor`).toArray();
    return { subscriptions, deliveryCursors };
  }
}

function validateAgentMessages(messages: AgentMessage[], source: string): AgentMessage[] {
  for (const [index, message] of messages.entries()) {
    try {
      assertNoStoredValueRefs(message, `${source}[${index}]`);
    } catch (err) {
      throw new AgentWorkerError(
        "transcript_shape",
        err instanceof Error ? err.message : String(err)
      );
    }
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

function methodErrorResult(result: unknown, reasonCode = "method_failed"): AgentToolResult<any> {
  return {
    content: [{ type: "text", text: resultToAnswerText(result) }],
    details: {
      __natstack_terminal: {
        outcome: "tool_error",
        reasonCode,
      },
    },
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

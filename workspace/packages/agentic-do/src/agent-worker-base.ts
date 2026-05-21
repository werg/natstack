/**
 * AgentWorkerBase — Pi-native agent DO base.
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
import type {
  Attachment,
  ChannelEvent,
  ParticipantDescriptor,
  TurnInput,
  UnsubscribeResult,
} from "@natstack/harness/types";
import { isClientParticipantType } from "@workspace/pubsub";
import { AGENTIC_EVENT_PAYLOAD_KIND } from "@workspace/agentic-protocol";
import {
  PiRunner,
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

export interface ModelCredentialSummary {
  id: string;
  accountIdentity?: {
    providerUserId?: string;
  };
  metadata?: Record<string, string>;
}

export type ModelCredentialSetupProps = Record<string, unknown>;

interface ModelCredentialOAuthConfig {
  type: "oauth2-auth-code-pkce";
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
  extraAuthorizeParams?: Record<string, string>;
  allowMissingExpiry?: boolean;
}

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
      await chat.callMethod(props.agentParticipantId, "connectModelCredentialOAuth", {
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

function isModelCredentialOAuthConfig(value: unknown): value is ModelCredentialOAuthConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    config["type"] === "oauth2-auth-code-pkce" &&
    typeof config["authorizeUrl"] === "string" &&
    typeof config["tokenUrl"] === "string" &&
    typeof config["clientId"] === "string" &&
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
  resolve: (completion: MethodResultCompletion) => void;
  reject: (error: unknown) => void;
}

const DEFAULT_CHANNEL_METHOD_TIMEOUT_MS = 10 * 60 * 1000;

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

export abstract class AgentWorkerBase extends DurableObjectBase {
  static override schemaVersion = 12;

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

  /** Channels currently receiving replay envelopes. Replay dispatch stays
   * sequential so recovered turns do not collapse into a single live steer. */
  private channelsInReplay = new Set<string>();

  /** Channels with structurally invalid transcript state. Fail closed and
   *  surface one visible error instead of repeatedly reprocessing the same
   *  malformed history. */
  private transcriptPoisonedChannels = new Map<string, string>();
  private transcriptPoisonNotified = new Set<string>();

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
        console.error("[AgentWorkerBase] ensureBootstrapped failed:", err);
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
  protected getModel(): string {
    throw new AgentWorkerError(
      "invalid_state",
      "AgentWorkerBase subclasses must override getModel()"
    );
  }

  protected getThinkingLevel(): ThinkingLevel {
    return "medium";
  }

  protected getModelProviderId(): string {
    const model = this.getModel();
    const colonIdx = model.indexOf(":");
    return colonIdx >= 0 ? model.slice(0, colonIdx) : model;
  }

  private getApiKeyForChannel(channelId: string): () => Promise<string> {
    const providerId = this.getModelProviderId();
    return async () => {
      const modelBaseUrl = this.getModelBaseUrl();
      this.installUrlBoundModelFetchProxy(modelBaseUrl);
      const credential = await this.rpc.call<ModelCredentialSummary | null>(
        "main",
        "credentials.resolveCredential",
        [{ url: modelBaseUrl }]
      );
      if (!credential) {
        await this.recordModelCredentialInterruption(channelId, providerId, modelBaseUrl);
        await this.emitModelCredentialRequiredCard(channelId, providerId, modelBaseUrl);
        throw new AgentWorkerError(
          "auth",
          `No URL-bound model credential is configured for model provider: ${providerId}`
        );
      }
      return this.createModelCredentialSentinel(providerId, credential);
    };
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
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean } | null> {
    switch (methodName) {
      case "connectModelCredentialOAuth":
        return {
          result: await this.connectModelCredentialOAuth(args as ConnectModelCredentialOAuthArgs),
        };
      default:
        return null;
    }
  }

  private getModelCredentialOAuthConfig(providerId: string): {
    flow: ModelCredentialOAuthConfig & { type: "oauth2-auth-code-pkce" };
    redirect?: ModelCredentialRedirectConfig;
    clientLoopbackRedirect?: ModelCredentialRedirectConfig;
    redirectPolicy?: ModelCredentialRedirectPolicy;
    credentialLabel: string;
    accountIdentityJwtClaimRoot: string;
    accountIdentityJwtClaimField: string;
  } {
    if (providerId !== this.getModelProviderId()) {
      throw new Error(`Model credential provider mismatch: ${providerId}`);
    }
    const setup = this.getModelCredentialSetupProps(providerId);
    const flow = setup?.["flow"];
    if (!isModelCredentialOAuthConfig(flow)) {
      throw new Error(`No OAuth setup is available for model provider: ${providerId}`);
    }
    const credentialLabel = setup?.["credentialLabel"];
    const redirect = setup?.["redirect"];
    const clientLoopbackRedirect = setup?.["clientLoopbackRedirect"];
    const redirectPolicy = setup?.["redirectPolicy"];
    const accountIdentityJwtClaimRoot = setup?.["accountIdentityJwtClaimRoot"];
    const accountIdentityJwtClaimField = setup?.["accountIdentityJwtClaimField"];
    return {
      flow,
      ...(isModelCredentialRedirectConfig(redirect) ? { redirect } : {}),
      ...(isModelCredentialRedirectConfig(clientLoopbackRedirect)
        ? { clientLoopbackRedirect }
        : {}),
      ...(redirectPolicy === "loopback-required" ? { redirectPolicy } : {}),
      credentialLabel:
        typeof credentialLabel === "string" ? credentialLabel : `Model credential: ${providerId}`,
      accountIdentityJwtClaimRoot:
        typeof accountIdentityJwtClaimRoot === "string" ? accountIdentityJwtClaimRoot : "",
      accountIdentityJwtClaimField:
        typeof accountIdentityJwtClaimField === "string" ? accountIdentityJwtClaimField : "",
    };
  }

  private async connectModelCredentialOAuth(
    args: ConnectModelCredentialOAuthArgs
  ): Promise<ModelCredentialSummary> {
    if (typeof args?.providerId !== "string") {
      throw new Error("connectModelCredentialOAuth requires providerId");
    }
    const browserOpenMode = args.browserOpenMode === "external" ? "external" : "internal";
    const browserHandoffCallerId =
      typeof args.browserHandoffCallerId === "string" ? args.browserHandoffCallerId : undefined;
    const browserHandoffCallerKind = args.browserHandoffCallerKind === "shell" ? "shell" : "panel";
    const browserHandoffPlatform =
      typeof args.browserHandoffPlatform === "string" ? args.browserHandoffPlatform : undefined;
    const modelBaseUrl = this.getModelBaseUrl();
    const setup = this.getModelCredentialOAuthConfig(args.providerId);
    const redirect =
      (browserOpenMode === "external" || browserHandoffPlatform === "mobile") &&
      setup.clientLoopbackRedirect
        ? setup.clientLoopbackRedirect
        : setup.redirect;
    if (
      setup.redirectPolicy === "loopback-required" &&
      (!redirect || (redirect.type !== "loopback" && redirect.type !== "client-loopback"))
    ) {
      throw new Error(`Model provider ${args.providerId} requires a loopback OAuth redirect`);
    }
    const spec = {
      flow: {
        ...setup.flow,
      },
      credential: {
        label: setup.credentialLabel,
        audience: [{ url: modelBaseUrl, match: "path-prefix" }],
        injection: {
          type: "header",
          name: "Authorization",
          valueTemplate: "Bearer {token}",
          stripIncoming: ["authorization"],
        },
        scopes: setup.flow.scopes ?? [],
        metadata: {
          modelProviderId: args.providerId,
          accountIdentityJwtClaimRoot: setup.accountIdentityJwtClaimRoot,
          accountIdentityJwtClaimField: setup.accountIdentityJwtClaimField,
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

  private getModelBaseUrl(): string {
    const model = this.getModel();
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

  private installUrlBoundModelFetchProxy(modelBaseUrl: string): void {
    const globals = globalThis as typeof globalThis & {
      __natstackModelFetchProxyInstalled?: boolean;
      __natstackModelFetchProxyBaseUrls?: string[];
    };
    globals.__natstackModelFetchProxyBaseUrls = Array.from(
      new Set([...(globals.__natstackModelFetchProxyBaseUrls ?? []), modelBaseUrl])
    );
    if (globals.__natstackModelFetchProxyInstalled) return;

    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const targetUrl = new URL(request.url);
      const headers = new Headers(request.headers);
      const authorization = headers.get("authorization");
      const hasSentinel = authorization?.startsWith("Bearer ")
        ? isModelCredentialSentinel(authorization.slice("Bearer ".length))
        : false;
      if (!hasSentinel) {
        return originalFetch(input, init);
      }
      if (
        !shouldProxyUrlBoundModelFetch(targetUrl, globals.__natstackModelFetchProxyBaseUrls ?? [])
      ) {
        throw new Error(
          `Refusing to send URL-bound model credential to non-model URL: ${targetUrl.origin}`
        );
      }
      headers.delete("authorization");

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
      const upstream = await this.credentials.fetch(targetUrl.toString(), {
        method: request.method,
        headers,
        body: upstreamBody,
        signal: request.signal,
      });
      return upstream;
    };

    globals.__natstackModelFetchProxyInstalled = true;
  }

  protected getApprovalLevel(channelId: string): ApprovalLevel {
    const value = this.getStateValue(`approvalLevel:${channelId}`);
    if (!value) return 2; // Default: full auto
    const parsed = parseInt(value, 10);
    if (parsed === 0 || parsed === 1 || parsed === 2) return parsed;
    return 2;
  }

  protected setApprovalLevel(channelId: string, level: ApprovalLevel): void {
    this.setStateValue(`approvalLevel:${channelId}`, String(level));
    const entry = this.runners.get(channelId);
    if (entry) entry.runner.setApprovalLevel(level);
  }

  protected shouldProcess(event: ChannelEvent): boolean {
    if (event.type !== "message" && event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return false;
    if (event.type === "message" && event.contentType) return false;
    const senderType = event.senderMetadata?.["type"] as string | undefined;
    if (!isClientParticipantType(senderType)) return false;
    if (event.type === AGENTIC_EVENT_PAYLOAD_KIND) {
      const agentic = this.agenticEventFromChannelEvent(event);
      return agentic?.kind === "message.completed";
    }
    return true;
  }

  protected buildTurnInput(event: ChannelEvent): TurnInput {
    const agentic = event.type === AGENTIC_EVENT_PAYLOAD_KIND ? this.agenticEventFromChannelEvent(event) : null;
    if (agentic?.kind === "message.completed") {
      const payload = agentic.payload as { content?: unknown };
      return {
        content: typeof payload.content === "string" ? payload.content : "",
        senderId: event.senderId,
        attachments: event.attachments,
      };
    }
    const payload = event.payload as { content?: string; attachments?: Attachment[] };
    return {
      content: payload.content ?? "",
      senderId: event.senderId,
      attachments: event.attachments,
    };
  }

  private agenticEventFromChannelEvent(event: ChannelEvent): {
    kind?: string;
    causality?: { invocationId?: string; transportCallId?: string };
    payload?: unknown;
  } | null {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return null;
    return event.payload && typeof event.payload === "object"
      ? event.payload as { kind?: string; causality?: { invocationId?: string; transportCallId?: string }; payload?: unknown }
      : null;
  }

  private channelInvocationResult(event: ChannelEvent): {
    callId: string;
    content: unknown;
    complete: boolean;
    isError: boolean;
  } | null {
    if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) return null;
    const agentic = this.agenticEventFromChannelEvent(event);
    if (!agentic?.kind?.startsWith("invocation.") || agentic.kind === "invocation.started") {
      return null;
    }
    const callId = agentic.causality?.transportCallId ?? agentic.causality?.invocationId;
    if (!callId) return null;
    const payload = agentic.payload && typeof agentic.payload === "object"
      ? agentic.payload as Record<string, unknown>
      : {};
    if (agentic.kind === "invocation.completed") {
      return { callId, content: payload["result"], complete: true, isError: false };
    }
    if (agentic.kind === "invocation.failed" || agentic.kind === "invocation.cancelled") {
      return {
        callId,
        content: payload["error"] ?? payload["reason"] ?? "Invocation failed",
        complete: true,
        isError: true,
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

  // ── Subscription lifecycle ──────────────────────────────────────────────

  async subscribeChannel(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    replay?: boolean;
  }): Promise<{ ok: boolean; participantId: string }> {
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
      if (attempts >= AgentWorkerBase.POISON_MAX_ATTEMPTS) {
        console.error(
          `[AgentWorkerBase] Skipping poison event id=${eventId} after ${attempts} failed attempts`
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
      if (eventId !== undefined && eventId > 0) {
        const count = (this.failedEvents.get(eventId) ?? 0) + 1;
        this.failedEvents.set(eventId, count);
        if (count >= AgentWorkerBase.POISON_MAX_ATTEMPTS) {
          console.error(
            `[AgentWorkerBase] Poison event id=${eventId} failed ${count} times, will skip on next delivery:`,
            err
          );
        } else {
          console.warn(
            `[AgentWorkerBase] processChannelEvent failed for id=${eventId} (attempt ${count}/${AgentWorkerBase.POISON_MAX_ATTEMPTS}):`,
            err
          );
        }
      } else {
        console.error("[AgentWorkerBase] processChannelEvent failed for signal event:", err);
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
        `[AgentWorkerBase] Gap too large (${gap} events) in channel=${channelId}, skipping repair`
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
            if (count >= AgentWorkerBase.POISON_MAX_ATTEMPTS) {
              console.error(
                `[AgentWorkerBase] Poison event id=${missedId} in gap repair, skipping:`,
                missedErr
              );
              this.advanceDeliveryCursor(channelId, missedId);
            } else {
              console.warn(
                `[AgentWorkerBase] Gap repair event id=${missedId} failed (attempt ${count}):`,
                missedErr
              );
            }
          }
        }
      }
    } catch (err) {
      console.warn(
        `[AgentWorkerBase] Gap repair failed for channel=${channelId} gap=${lastSeq + 1}..${eventId - 1}:`,
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
      if (!invocationResult.complete) {
        const cb = this.streamCallbacks.get(invocationResult.callId);
        if (cb) cb(invocationResult.content);
      } else {
        await this.handleCompletedMethodResult(
          invocationResult.callId,
          invocationResult.content,
          invocationResult.isError
        );
      }
      return;
    }

    await this.processChannelEvent(channelId, event, opts);
  }

  // ── PiRunner lifecycle (one per channel, lazy) ──────────────────────────

  protected async getOrCreateRunner(channelId: string): Promise<PiRunner> {
    const existing = this.runners.get(channelId);
    if (existing) return existing.runner;

    // Build options as a strongly-typed PiRunnerOptions object. The runner is
    // responsible for materializing Pi session state from trajectory events.
    const runnerOptions = {
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
      model: this.getModel(),
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
            const modelBaseUrl = this.getModelBaseUrl();
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
      thinkingLevel: this.getThinkingLevel(),
      ...this.getRunnerPromptConfig(channelId),
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
    const runner = new PiRunner({
      ...runnerOptions,
      onPrepareNextTurn: async (snapshot) => {
        await this.prepareNextTurnHook(channelId, snapshot);
      },
    });

    await runner.init();

    const abortedTurnListener = (event: RunnerEvent) => {
      const msg = abortedAgentEndMessage(event);
      if (!msg) return;
      const context = this.abortContexts.get(channelId);
      this.abortContexts.delete(channelId);
      console.log(
        `[AgentWorkerBase] Agent turn aborted on channel=${channelId}: ` +
          `reason=${context?.reason ?? "unknown"}${context?.detail ? ` detail=${context.detail}` : ""}; ${msg}`
      );
    };
    runner.hooks.on("event", abortedTurnListener);

    this.runners.set(channelId, { runner });
    // Dispatcher self-subscribes to runner events for absorption tracking
    // and sweep. Created here so it exists before the first processChannelEvent
    // (which expects to hand messages to it).
    this.getOrCreateDispatcher(channelId, runner);
    return runner;
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
    void this.getModel();
    void this.getThinkingLevel();
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
    const messageId = crypto.randomUUID();
    await channel
      .send(participantId, messageId, `Transcript error: ${detail}`, {
        contentType: "error",
        idempotencyKey: `transcript-shape-error:${channelId}`,
      })
      .catch((err) => {
        console.error(
          `[AgentWorkerBase] Failed to emit transcript-shape error for channel=${channelId}:`,
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
      console.error(`[AgentWorkerBase] Transcript shape error on channel=${channelId}: ${detail}`);
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
      console.warn(`[AgentWorkerBase] readRunnerMessages failed for channel=${channelId}:`, err);
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
          `[AgentWorkerBase] recordModelCredentialInterruption: readRunnerMessages failed:`,
          err
        );
      }
    }
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
      `[AgentWorkerBase] Agent abort requested on channel=${channelId}: ` +
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
        `[AgentWorkerBase] setTypingState(${busy}) failed for channel=${channelId}:`,
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

  /** Refresh the cached roster for a channel. Called before each turn. */
  protected async refreshRoster(channelId: string): Promise<void> {
    const channel = this.createChannelClient(channelId);
    const participants = await channel.getParticipants();
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
    const waiter = this.createMethodResultWaiter(channelId, transportCallId, invocationId, signal);
    if (onStreamUpdate) this.streamCallbacks.set(transportCallId, onStreamUpdate);
    try {
      await channel.callMethod(callerId, target.participantId, transportCallId, method, args, {
        invocationId,
        transportCallId,
        timeoutMs: DEFAULT_CHANNEL_METHOD_TIMEOUT_MS,
        ...(turnId ? { turnId } : {}),
      });
      const completion = await waiter.promise;
      if (completion.isError) return methodErrorResult(completion.result);
      return toAgentToolResult(completion.result);
    } catch (err) {
      waiter.cancel(err);
      await this.cancelChannelMethodCall(channelId, transportCallId);
      throw err;
    } finally {
      this.streamCallbacks.delete(transportCallId);
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
    const waiter = this.createMethodResultWaiter(channelId, transportCallId, invocationId, signal);
    try {
      await channel.callMethod(callerId, panel.participantId, transportCallId, "feedback_form", params, {
        invocationId,
        transportCallId,
        timeoutMs: DEFAULT_CHANNEL_METHOD_TIMEOUT_MS,
        ...(turnId ? { turnId } : {}),
      });
      const completion = await waiter.promise;
      if (completion.isError) return methodErrorResult(completion.result);
      return resultToAnswerText(completion.result);
    } catch (err) {
      waiter.cancel(err);
      await this.cancelChannelMethodCall(channelId, transportCallId);
      throw err;
    } finally {
      this.streamCallbacks.delete(transportCallId);
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

  private async emitModelCredentialRequiredCard(
    channelId: string,
    providerId: string,
    modelBaseUrl: string
  ): Promise<void> {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const key = `${channelId}::model-credential::${providerId}`;
    if (this.credentialPromptCardsEmitted.has(key)) return;
    this.credentialPromptCardsEmitted.add(key);

    const channel = this.createChannelClient(channelId);
    let browserHandoffCallerId: string | undefined;
    let browserHandoffPlatform: string | undefined;
    try {
      const participants = await channel.getParticipants();
      const panel = participants.find((p) => {
        const t = p.metadata["type"] as string | undefined;
        return t === "panel" || t === "client";
      });
      browserHandoffCallerId = panel?.participantId;
      browserHandoffPlatform =
        typeof panel?.metadata["hostPlatform"] === "string"
          ? (panel.metadata["hostPlatform"] as string)
          : undefined;
    } catch (err) {
      console.warn(
        `[AgentWorkerBase] Failed to resolve browser handoff panel for ${providerId}:`,
        err
      );
    }
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
    void channel
      .sendSignal(participantId, content, "inline_ui")
      .catch((err) => {
        console.error(
          `[AgentWorkerBase] Failed to emit model credential card for ${providerId}:`,
          err
        );
        this.credentialPromptCardsEmitted.delete(key);
      });
  }

  private createMethodResultWaiter(
    channelId: string,
    callId: string,
    invocationId: string,
    signal?: AbortSignal
  ): { promise: Promise<MethodResultCompletion>; cancel: (error?: unknown) => void } {
    let settled = false;
    let removeAbortListener: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
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
      this.methodResultWaiters.set(callId, { channelId, invocationId, resolve: complete, reject: fail });
      timeout = setTimeout(() => {
        const error = new Error(`Channel method call timed out after ${DEFAULT_CHANNEL_METHOD_TIMEOUT_MS}ms`);
        fail(error);
        void this.createChannelClient(channelId)
          .timeoutCall(callId, error.message)
          .catch((err) => {
            console.warn(
              `[AgentWorkerBase] Failed to mark channel method timeout: channel=${channelId} callId=${callId}`,
              err,
            );
          });
      }, DEFAULT_CHANNEL_METHOD_TIMEOUT_MS);
      if (signal) {
        const onAbort = () => fail(new Error("Request was aborted"));
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
        `[AgentWorkerBase] Failed to cancel channel method call: channel=${channelId} callId=${callId}`,
        err
      );
    }
  }

  private async handleCompletedMethodResult(
    callId: string,
    result: unknown,
    isError: boolean
  ): Promise<void> {
    this.streamCallbacks.delete(callId);
    const waiter = this.methodResultWaiters.get(callId);
    if (waiter) {
      waiter.resolve({ result, isError });
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
    if (signal?.aborted) throw new Error("aborted");
    const callerId = this.subscriptions.getParticipantId(channelId);
    if (!callerId) throw new Error(`Not subscribed to channel ${channelId}`);
    const channel = this.createChannelClient(channelId);
    const participants = await channel.getParticipants();
    const panel = participants.find((p) => {
      const t = p.metadata["type"] as string | undefined;
      return t === "panel" || t === "client";
    });
    if (!panel) throw new Error(`No panel participant in channel ${channelId}`);

    const invocationId = toolCallId || crypto.randomUUID();
    const transportCallId = crypto.randomUUID();
    const waiter = this.createMethodResultWaiter(channelId, transportCallId, invocationId, signal);
    try {
      await channel.callMethod(callerId, panel.participantId, transportCallId, "ui_prompt", {
        kind,
        ...params,
      }, {
        invocationId,
        transportCallId,
        timeoutMs: DEFAULT_CHANNEL_METHOD_TIMEOUT_MS,
        ...(this.currentTurnIdForChannel(channelId) ? { turnId: this.currentTurnIdForChannel(channelId) } : {}),
      });
      const completion = await waiter.promise;
      if (completion.isError) {
        throw new Error(resultToAnswerText(completion.result));
      }
      if (kind === "confirm") return completion.result === true || completion.result === "true";
      if (completion.result == null) return undefined;
      return typeof completion.result === "string"
        ? completion.result
        : JSON.stringify(completion.result);
    } catch (err) {
      waiter.cancel(err);
      await this.cancelChannelMethodCall(channelId, transportCallId);
      throw err;
    } finally {
      this.streamCallbacks.delete(transportCallId);
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
    this.rejectMethodWaitersForChannel(channelId, "Request was aborted");
    const runner = this.runners.get(channelId)?.runner;
    for (const { callId, invocationId } of pendingCalls) {
      try {
        runner?.forgetOpenInvocation(invocationId);
        await this.cancelChannelMethodCall(channelId, callId);
        await this.sendDispatchCancel(channelId, callId, "user-interrupted");
      } catch (err) {
        console.warn(
          `[AgentWorkerBase] Failed to cancel dispatch ${callId} on interrupt:`,
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
    if (!this.shouldProcess(event)) return;
    await this.ensureChannelContext(channelId);

    const runner = this.runners.get(channelId)!.runner;
    const input = this.buildTurnInput(event);
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
    if (envelope.kind === "control") {
      if (envelope.type === "ready") this.channelsInReplay.delete(channelId);
      return;
    }
    if (envelope.kind === "log" && envelope.event) {
      if (envelope.phase === "replay") this.channelsInReplay.add(channelId);
      const mode = envelope.phase === "replay" || this.channelsInReplay.has(channelId)
        ? "sequential"
        : "auto";
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
    for (const att of attachments) {
      if (!att.mimeType?.startsWith("image/")) continue;
      try {
        const bytes = Buffer.from(att.data, "base64");
        const resized = await this.rpc.call<{
          data: Uint8Array;
          mimeType: string;
          wasResized: boolean;
        }>("main", "extensions.invoke", [
          IMAGE_SERVICE_EXTENSION,
          "resize",
          [bytes, att.mimeType, { maxWidth: 2000, maxHeight: 2000 }],
        ]);
        images.push({
          type: "image",
          mimeType: resized.mimeType,
          data: Buffer.from(resized.data).toString("base64"),
        });
      } catch (err) {
        console.warn(
          `[AgentWorkerBase] image-service.resize failed for channel=${channelId}; passing original:`,
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
    await this.ensureChannelContext(channelId);
    const entry = this.runners.get(channelId);
    if (!entry) {
      console.warn(
        `[AgentWorkerBase] credential resume failed for channel=${channelId}: runner missing`
      );
      return false;
    }

    const providerId = opts?.providerId ?? this.getModelProviderId();
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
        `[AgentWorkerBase] credential resume failed for channel=${channelId}: ` +
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
        `[AgentWorkerBase] credential resume failed for channel=${channelId}: ` +
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
        `[AgentWorkerBase] credential resume failed for channel=${channelId}: ` +
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
    for (const [channelId, entry] of this.runners.entries()) {
      this.dispatchers.get(channelId)?.reset();
      this.lastUserInterruptAt.set(channelId, Date.now());
      await this.notifyDispatchesInterrupted(channelId);
      this.recordAbort(channelId, "interrupt-all");
      await entry.runner.interrupt();
    }
  }

  /** Interrupt the in-flight Pi turn for a specific channel. */
  protected async interruptRunner(channelId: string): Promise<void> {
    const entry = this.runners.get(channelId);
    if (entry) {
      // Drop any pending/steered messages — interrupt means the user wants
      // everything stopped, not just the current turn. Dispatcher's reset()
      // also clears pi-core's steering queue.
      this.dispatchers.get(channelId)?.reset();
      this.lastUserInterruptAt.set(channelId, Date.now());
      await this.notifyDispatchesInterrupted(channelId);
      this.recordAbort(channelId, "interrupt-channel");
      await entry.runner.interrupt();
    }
  }

  // ── Fork support (Pi-native) ────────────────────────────────────────────

  async canFork(): Promise<{ ok: boolean; subscriptionCount: number; reason?: string }> {
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

    // Rename approvalLevel state key.
    const oldApprovalKey = `approvalLevel:${oldChannelId}`;
    const newApprovalKey = `approvalLevel:${newChannelId}`;
    const approvalValue = this.getStateValue(oldApprovalKey);
    if (approvalValue) {
      this.setStateValue(newApprovalKey, approvalValue);
      this.deleteStateValue(oldApprovalKey);
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

  // ── Fetch override ───────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !(this as unknown as { _objectKey?: string })._objectKey) {
      (this as unknown as { _objectKey?: string })._objectKey = decodeURIComponent(segments[0]!);
    }

    this.ensureReady();
    this.ensureBootstrapped();

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
          await this.onChannelEnvelope(args[0] as string, args[1] as Parameters<this["onChannelEnvelope"]>[1]);
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

  override async getState(): Promise<Record<string, unknown>> {
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
      console.error("[AgentWorkerBase] Malformed toolResult without toolCallId", {
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

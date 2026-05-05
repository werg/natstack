/**
 * AgentWorkerBase — Pi-native agent DO base.
 *
 * Embeds `@mariozechner/pi-agent-core`'s `Agent` in-process via `PiRunner`
 * from `@natstack/harness`. One PiRunner per channel, owned by the DO for
 * the lifetime of the chat. The runner drives agent state (messages,
 * streaming, tool calls); the DO persists `AgentMessage[]` snapshots to
 * its SQL storage and forwards runner events to the channel as ephemeral
 * events.
 *
 * Composes:
 * - `DOIdentity`: stable DO ref + workerd session id
 * - `SubscriptionManager`: channel membership + replay state
 * - `DispatchedCallStore`: durable breadcrumb index for interactive dispatches
 *   that must survive DO hibernation
 * - `ChannelClient`: typed wrapper around channel DO RPC
 * - `TurnDispatcher` (one per channel): queues user messages, chooses
 *   runTurn vs steer, self-heals pi-core's steering-queue exit race,
 *   drives the typing indicator from real busy state
 * - `ContentBlockProjector` (one per channel): maps Pi content events
 *   onto channel messages
 *
 * Publishes Pi events as real channel messages via `ContentBlockProjector`
 * (one channel message per Pi content block):
 * - Text blocks stream via send → delta updates → complete
 * - Thinking blocks stream via send → delta updates (append flag) → complete
 * - Tool calls publish as contentType "toolCall" (ToolCallPayload snapshot)
 * - Tool-result images fold into the tool call's `execution.resultImages`
 *
 * Message dispatch flow (normal turn):
 *   onChannelEvent → refreshRoster → getOrCreateRunner → resizeAttachments
 *     → runner.buildUserMessage → TurnDispatcher.submit
 *   TurnDispatcher routes to runTurnMessage (idle) or steerMessage (mid-run);
 *   typing indicator reflects `running || pending || pendingSteered > 0`.
 */

import { DurableObjectBase, type DurableObjectContext, type DORef } from "@workspace/runtime/worker";
import type {
  Attachment,
  ChannelEvent,
  ParticipantDescriptor,
  TurnInput,
  UnsubscribeResult,
} from "@natstack/harness/types";
import { isClientParticipantType } from "@natstack/pubsub";
import {
  PiRunner,
  type ChannelToolMethod,
  type NatStackScopedUiContext,
  type AskUserParams,
  type ApprovalLevel,
  type ThinkingLevel,
  type SystemPromptMode,
  DispatchedError,
} from "@natstack/harness";
import type { AgentEvent, AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import { getModel as getPiModel, type ImageContent } from "@mariozechner/pi-ai";

import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";
import {
  DispatchedCallStore,
  type DispatchedCall,
  type DispatchedCallKind,
} from "./dispatched-call-store.js";
import { ChannelClient } from "./channel-client.js";
import { ContentBlockProjector, type ProjectorSink } from "./content-block-projector.js";
import { TurnDispatcher } from "./turn-dispatcher.js";

const SAFE_TOOL_NAMES_DEFAULT: ReadonlySet<string> = new Set(["read", "ls", "grep", "find"]);
const URL_BOUND_MODEL_CREDENTIAL_SENTINEL = "natstack-url-bound-model-credential";
const URL_BOUND_MODEL_CREDENTIAL_SENTINEL_CLAIM = "https://natstack.local/url-bound-model-credential";

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
  type?: "loopback" | "public" | "client-forwarded";
  host?: string;
  port?: number;
  callbackPath?: string;
  fallback?: "dynamic-port";
}

interface ConnectModelCredentialOAuthArgs {
  providerId?: unknown;
  browserOpenMode?: unknown;
  browserHandoffCallerId?: unknown;
  browserHandoffCallerKind?: unknown;
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
      });
      setStatus("done");
      if (props.agentParticipantId) {
        await chat.callMethod(props.agentParticipantId, "credentialConnected", {
          providerId,
          modelBaseUrl,
        }).catch(() => {});
      }
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
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
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
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") return false;
  return baseUrls.some((baseUrl) => isUrlWithinBase(url, baseUrl));
}

function isModelCredentialOAuthConfig(value: unknown): value is ModelCredentialOAuthConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return config["type"] === "oauth2-auth-code-pkce"
    && typeof config["authorizeUrl"] === "string"
    && typeof config["tokenUrl"] === "string"
    && typeof config["clientId"] === "string"
    && (
      config["scopes"] === undefined ||
      (Array.isArray(config["scopes"]) && config["scopes"].every((scope) => typeof scope === "string"))
    )
    && (
      config["extraAuthorizeParams"] === undefined ||
      (
        !!config["extraAuthorizeParams"] &&
        typeof config["extraAuthorizeParams"] === "object" &&
        Object.values(config["extraAuthorizeParams"]).every((param) => typeof param === "string")
      )
    )
    && (
      config["allowMissingExpiry"] === undefined ||
      typeof config["allowMissingExpiry"] === "boolean"
    );
}

function isModelCredentialRedirectConfig(value: unknown): value is ModelCredentialRedirectConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return (
    (config["type"] === undefined ||
      config["type"] === "loopback" ||
      config["type"] === "public" ||
      config["type"] === "client-forwarded") &&
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

interface RunnerEntry {
  runner: PiRunner;
}

type AgentAbortReason =
  | "channel-unsubscribe"
  | "participant-method-dispatch"
  | "ask-user-dispatch"
  | "ui-prompt-dispatch"
  | "interrupt-all"
  | "interrupt-channel";

interface AgentAbortContext {
  reason: AgentAbortReason;
  detail?: string;
  at: number;
}

export abstract class AgentWorkerBase extends DurableObjectBase {
  static override schemaVersion = 9;

  protected identity: DOIdentity;
  protected subscriptions: SubscriptionManager;
  protected dispatches: DispatchedCallStore;

  /** One PiRunner per channel — created lazily on first user message. */
  private runners = new Map<string, RunnerEntry>();

  /** Last intentional abort reason per channel, used to annotate pi-core's
   *  generic "Request was aborted" terminal event. */
  private abortContexts = new Map<string, AgentAbortContext>();

  /** Last explicit user stop per channel. Suppresses late dispatch continuations. */
  private lastUserInterruptAt = new Map<string, number>();

  /** Channels whose `fs.bindContext` has been called at least once per DO
   *  lifetime. The FsService caller→context map is process-scoped, so we
   *  only need to bind once per DO startup per context. */
  private _fsContextBound = new Set<string>();

  /** Streaming callbacks keyed by method callId. When a method-result event
   *  arrives with complete:false, the callback is invoked with the content.
   *  This bridges ctx.stream() from method providers to Pi's onUpdate. */
  private streamCallbacks = new Map<string, (content: unknown) => void>();

  /** Dedup inline credential prompts per channel/provider while this DO is alive. */
  private credentialPromptCardsEmitted = new Set<string>();

  /** Phase 0D: Transient poison message tracker. Resets on hibernation. */
  private failedEvents = new Map<number, number>();
  private static readonly POISON_MAX_ATTEMPTS = 3;
  private recoveredChannels = new Set<string>();

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);

    const lazyRpc = {
      call: <T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T> => {
        return this.rpc.call<T>(targetId, method, ...args);
      },
    };

    this.identity = new DOIdentity(this.sql);
    this.subscriptions = new SubscriptionManager(
      this.sql,
      (channelId) => new ChannelClient(lazyRpc, channelId),
      this.identity,
    );
    this.dispatches = new DispatchedCallStore(this.sql);

    this.ensureReady();
    this.dispatches.clearResolvingTokens();
    this.identity.restore();
  }

  protected createTables(): void {
    this.identity.createTables();
    this.subscriptions.createTables();
    this.dispatches.createTables();
    this.sql.exec(`DROP TABLE IF EXISTS pending_calls`);
    // Delivery cursor for event dedup + gap repair.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS delivery_cursor (
        channel_id TEXT PRIMARY KEY,
        last_delivered_seq INTEGER NOT NULL
      )
    `);
    // Legacy table — kept for lazy migration to pi_messages.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pi_sessions (
        channel_id TEXT PRIMARY KEY,
        messages_blob TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    // Per-channel Pi agent message history for warm restore after DO hibernation.
    // One row per message — avoids SQLITE_TOOBIG on long conversations and
    // makes persist append-only instead of full-rewrite.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pi_messages (
        channel_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (channel_id, idx)
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
    throw new Error("AgentWorkerBase subclasses must override getModel()");
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
      const credential = await this.rpc.call<ModelCredentialSummary | null>("main", "credentials.resolveCredential", {
        url: modelBaseUrl,
      });
      if (!credential) {
        await this.emitModelCredentialRequiredCard(channelId, providerId, modelBaseUrl);
        throw new Error(
          `No URL-bound model credential is configured for model provider: ${providerId}`,
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
    _credential: ModelCredentialSummary,
  ): Record<string, unknown> {
    return {};
  }

  protected async handleModelCredentialMethodCall(
    methodName: string,
    args: unknown,
  ): Promise<{ result: unknown; isError?: boolean } | null> {
    switch (methodName) {
      case "connectModelCredentialOAuth":
        return { result: await this.connectModelCredentialOAuth(args as ConnectModelCredentialOAuthArgs) };
      default:
        return null;
    }
  }

  private getModelCredentialOAuthConfig(providerId: string): {
    flow: ModelCredentialOAuthConfig & { type: "oauth2-auth-code-pkce" };
    redirect?: ModelCredentialRedirectConfig;
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
    const redirect = setup?.["loopback"];
    const accountIdentityJwtClaimRoot = setup?.["accountIdentityJwtClaimRoot"];
    const accountIdentityJwtClaimField = setup?.["accountIdentityJwtClaimField"];
    return {
      flow,
      ...(isModelCredentialRedirectConfig(redirect) ? { redirect } : {}),
      credentialLabel: typeof credentialLabel === "string"
        ? credentialLabel
        : `Model credential: ${providerId}`,
      accountIdentityJwtClaimRoot: typeof accountIdentityJwtClaimRoot === "string"
        ? accountIdentityJwtClaimRoot
        : "",
      accountIdentityJwtClaimField: typeof accountIdentityJwtClaimField === "string"
        ? accountIdentityJwtClaimField
        : "",
    };
  }

  private async connectModelCredentialOAuth(
    args: ConnectModelCredentialOAuthArgs,
  ): Promise<ModelCredentialSummary> {
    if (typeof args?.providerId !== "string") {
      throw new Error("connectModelCredentialOAuth requires providerId");
    }
    const browserOpenMode = args.browserOpenMode === "external" ? "external" : "internal";
    const browserHandoffCallerId = typeof args.browserHandoffCallerId === "string"
      ? args.browserHandoffCallerId
      : undefined;
    const browserHandoffCallerKind = args.browserHandoffCallerKind === "shell"
      ? "shell"
      : "panel";
    const modelBaseUrl = this.getModelBaseUrl();
    const setup = this.getModelCredentialOAuthConfig(args.providerId);
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
      ...(setup.redirect ? { redirect: setup.redirect } : {}),
    };
    return this.rpc.call<ModelCredentialSummary>(
      "main",
      "credentials.connect",
      browserHandoffCallerId
        ? {
          spec,
          handoffTarget: {
            callerId: browserHandoffCallerId,
            callerKind: browserHandoffCallerKind,
          },
        }
        : spec,
    );
  }

  private createModelCredentialSentinel(providerId: string, credential: ModelCredentialSummary): string {
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
    globals.__natstackModelFetchProxyBaseUrls = Array.from(new Set([
      ...(globals.__natstackModelFetchProxyBaseUrls ?? []),
      modelBaseUrl,
    ]));
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
      if (!shouldProxyUrlBoundModelFetch(targetUrl, globals.__natstackModelFetchProxyBaseUrls ?? [])) {
        throw new Error(`Refusing to send URL-bound model credential to non-model URL: ${targetUrl.origin}`);
      }
      headers.delete("authorization");

      const result = await this.rpc.call<{
        status: number;
        statusText: string;
        headers: Record<string, string>;
        body: string;
      }>("main", "credentials.proxyFetch", {
        url: targetUrl.toString(),
        method: request.method,
        headers: Object.fromEntries(headers.entries()),
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
      });

      return new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
      });
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
    if (event.type !== "message") return false;
    if (event.contentType) return false;
    const senderType = event.senderMetadata?.["type"] as string | undefined;
    if (!isClientParticipantType(senderType)) return false;
    return true;
  }

  protected buildTurnInput(event: ChannelEvent): TurnInput {
    const payload = event.payload as { content?: string; attachments?: Attachment[] };
    return { content: payload.content ?? "", senderId: event.senderId, attachments: event.attachments };
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
    const systemPrompt = typeof config["systemPrompt"] === "string"
      ? config["systemPrompt"]
      : undefined;
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
    const descriptor = this.getParticipantInfo(opts.channelId, opts.config);
    const result = await this.subscriptions.subscribe({
      channelId: opts.channelId,
      contextId: opts.contextId,
      config: opts.config,
      descriptor,
      replay: opts.replay,
    });

    // Bind this DO's caller identity to the context folder in FsService's
    // caller→context map. Required before `runtime.fs.*` calls can resolve
    // paths. Idempotent; guarded by _fsContextBound so we don't re-call
    // across repeated subscribes to the same context.
    if (!this._fsContextBound.has(opts.contextId)) {
      try {
        await this.rpc.call<void>("main", "fs.bindContext", opts.contextId);
        this._fsContextBound.add(opts.contextId);
      } catch (err) {
        console.warn(
          `[AgentWorkerBase] fs.bindContext failed for contextId=${opts.contextId}:`,
          err,
        );
      }
    }

    if (result.channelConfig?.["approvalLevel"] != null) {
      const level = result.channelConfig["approvalLevel"] as number;
      if (level === 0 || level === 1 || level === 2) {
        this.setApprovalLevel(opts.channelId, level);
      }
    }

    if (result.replay) {
      try {
        for (const event of result.replay) {
          // Sequential mode: missed messages run as independent turns rather
          // than collapsing into a single steered run. Without this, the 2nd
          // and later replay events would hit `running=true` (set by the 1st
          // event's drainLoop pre-await) and route to steer.
          await this.onChannelEvent(opts.channelId, event, { mode: "sequential" });
        }
      } catch (err) {
        console.warn(`[AgentWorkerBase] Replay processing stopped:`, err);
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

    // Clean up per-channel projector state. closeAll before deletion so any
    // still-open channel messages receive their final `complete` (defensive —
    // the runner.dispose above should have drained pi events already).
    const projector = this.projectors.get(channelId);
    if (projector) {
      try { await projector.closeAll(); }
      catch (err) {
        console.warn(`[AgentWorkerBase] projector.closeAll on unsubscribe failed for ${channelId}:`, err);
      }
      this.projectors.delete(channelId);
    }

    this.dispatches.deleteForChannel(channelId);
    this.subscriptions.deleteSubscription(channelId);
    this.sql.exec(`DELETE FROM pi_messages WHERE channel_id = ?`, channelId);
    this.sql.exec(`DELETE FROM pi_sessions WHERE channel_id = ?`, channelId);

    return { ok: true };
  }

  // ── Channel event pipeline (dedup → gap repair → dispatch) ──────────────

  private async handleIncomingChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    const eventId = event.id;

    if (eventId !== undefined && eventId > 0) {
      const lastSeq = this.getDeliveryCursor(channelId);
      if (eventId <= lastSeq) return;

      if (eventId > lastSeq + 1) {
        await this.repairGap(channelId, lastSeq, eventId);
      }

      const attempts = this.failedEvents.get(eventId) ?? 0;
      if (attempts >= AgentWorkerBase.POISON_MAX_ATTEMPTS) {
        console.error(`[AgentWorkerBase] Skipping poison event id=${eventId} after ${attempts} failed attempts`);
        this.advanceDeliveryCursor(channelId, eventId);
        this.failedEvents.delete(eventId);
        return;
      }
    }

    try {
      await this.dispatchChannelEvent(channelId, event);
      if (eventId !== undefined && eventId > 0) {
        this.advanceDeliveryCursor(channelId, eventId);
        this.failedEvents.delete(eventId);
      }
    } catch (err) {
      if (eventId !== undefined && eventId > 0) {
        const count = (this.failedEvents.get(eventId) ?? 0) + 1;
        this.failedEvents.set(eventId, count);
        if (count >= AgentWorkerBase.POISON_MAX_ATTEMPTS) {
          console.error(`[AgentWorkerBase] Poison event id=${eventId} failed ${count} times, will skip on next delivery:`, err);
        } else {
          console.warn(`[AgentWorkerBase] onChannelEvent failed for id=${eventId} (attempt ${count}/${AgentWorkerBase.POISON_MAX_ATTEMPTS}):`, err);
        }
      } else {
        console.error("[AgentWorkerBase] onChannelEvent failed for ephemeral event:", err);
      }
    }
  }

  private getDeliveryCursor(channelId: string): number {
    const cursor = this.sql.exec(
      `SELECT last_delivered_seq FROM delivery_cursor WHERE channel_id = ?`, channelId,
    ).toArray();
    return cursor.length > 0 ? (cursor[0]!["last_delivered_seq"] as number) : 0;
  }

  private advanceDeliveryCursor(channelId: string, seq: number): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO delivery_cursor (channel_id, last_delivered_seq) VALUES (?, ?)`,
      channelId, seq,
    );
  }

  private async repairGap(channelId: string, lastSeq: number, eventId: number): Promise<void> {
    const gap = eventId - lastSeq - 1;
    if (gap > 1000) {
      console.error(`[AgentWorkerBase] Gap too large (${gap} events) in channel=${channelId}, skipping repair`);
      return;
    }
    try {
      const channel = this.createChannelClient(channelId);
      const missed = await channel.getEventRange(lastSeq, eventId - 1);
      if (!missed || !Array.isArray(missed)) return;

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
              console.error(`[AgentWorkerBase] Poison event id=${missedId} in gap repair, skipping:`, missedErr);
              this.advanceDeliveryCursor(channelId, missedId);
            } else {
              console.warn(`[AgentWorkerBase] Gap repair event id=${missedId} failed (attempt ${count}):`, missedErr);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[AgentWorkerBase] Gap repair failed for channel=${channelId} gap=${lastSeq+1}..${eventId-1}:`, err);
    }
  }

  private async dispatchChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    if (event.type === "config-update") {
      let newLevel: number | undefined;
      try {
        const config = typeof event.payload === "object" && event.payload !== null
          ? event.payload as Record<string, unknown>
          : {};
        if ("approvalLevel" in config) {
          newLevel = config["approvalLevel"] as number;
        }
      } catch { /* ignore parse errors */ }
      if (newLevel !== undefined && (newLevel === 0 || newLevel === 1 || newLevel === 2)) {
        this.setApprovalLevel(channelId, newLevel);
      }
      return;
    }

    // Intercept streaming method-result events (complete: false) and forward
    // to the registered stream callback. This bridges ctx.stream() from method
    // providers through to Pi's tool_execution_update event system.
    if (event.type === "method-result") {
      const payload = event.payload as Record<string, unknown> | undefined;
      const callId = payload?.["callId"] as string | undefined;
      if (payload?.["complete"] === false) {
        if (callId) {
          const cb = this.streamCallbacks.get(callId);
          if (cb) cb(payload["content"]);
        }
      } else if (payload?.["complete"] === true && callId) {
        await this.onCallResult(
          callId,
          payload["content"],
          payload["isError"] === true,
        );
      }
      return;
    }

    await this.onChannelEvent(channelId, event);
  }

  // ── PiRunner lifecycle (one per channel, lazy) ──────────────────────────

  protected async getOrCreateRunner(channelId: string): Promise<PiRunner> {
    const existing = this.runners.get(channelId);
    if (existing) return existing.runner;

    // Restore prior messages from SQL (warm-restart after DO hibernation,
    // or freshly cloned DO whose parent's blob was copied in postClone).
    let initialMessages: AgentMessage[] = [];

    // Try normalized pi_messages table first.
    const msgRows = this.sql.exec(
      `SELECT content FROM pi_messages WHERE channel_id = ? ORDER BY idx`,
      channelId,
    ).toArray();
    if (msgRows.length > 0) {
      try {
        initialMessages = msgRows.map(r => JSON.parse(r["content"] as string) as AgentMessage);
      } catch (err) {
        console.warn(`[AgentWorkerBase] failed to parse pi_messages for channel=${channelId}:`, err);
      }
    } else {
      // Lazy migration: read from legacy pi_sessions blob, migrate to pi_messages.
      const sessionRow = this.sql.exec(
        `SELECT messages_blob FROM pi_sessions WHERE channel_id = ?`, channelId,
      ).toArray();
      if (sessionRow.length > 0 && sessionRow[0]!["messages_blob"]) {
        try {
          initialMessages = JSON.parse(sessionRow[0]!["messages_blob"] as string) as AgentMessage[];
          // Migrate to normalized table.
          for (let i = 0; i < initialMessages.length; i++) {
            this.sql.exec(
              `INSERT INTO pi_messages (channel_id, idx, content) VALUES (?, ?, ?)`,
              channelId, i, JSON.stringify(initialMessages[i]),
            );
          }
          this.sql.exec(`DELETE FROM pi_sessions WHERE channel_id = ?`, channelId);
        } catch (err) {
          console.warn(`[AgentWorkerBase] failed to migrate pi_sessions for channel=${channelId}:`, err);
        }
      }
    }

    const runner = new PiRunner({
      rpc: {
        call: <T = unknown>(target: string, method: string, ...args: unknown[]): Promise<T> =>
          this.rpc.call<T>(target, method, ...args),
      },
      fs: this.fs,
      uiCallbacks: this.buildUICallbacks(channelId),
      rosterCallback: () => this.buildRoster(channelId),
      callMethodCallback: (toolCallId, handle, method, args, signal, onStreamUpdate) =>
        this.invokeChannelMethod(
          channelId,
          toolCallId,
          handle,
          method,
          args,
          signal,
          onStreamUpdate,
        ),
      askUserCallback: (toolCallId, params, signal) =>
        this.askUser(channelId, toolCallId, params, signal),
      model: this.getModel(),
      getApiKey: this.getApiKeyForChannel(channelId),
      thinkingLevel: this.getThinkingLevel(),
      ...this.getRunnerPromptConfig(channelId),
      approvalLevel: this.getApprovalLevel(channelId),
      initialMessages,
      onPersist: async (messages) => {
        await this.saveMessages(channelId, runner.trimTrailingAbortedAssistant(messages));
        await this.drainDeferredDispatchesFor(channelId);
      },
    });

    await runner.init();

    // Warm-restore: no synthetic snapshot needed — the channel already has
    // persisted messages that replay on panel connect.

    const projector = this.getOrCreateProjector(channelId);
    runner.subscribe((event) => projector.handleEvent(event));

    // Surface terminal-error agent runs as a visible system message and a
    // worker-log line. Without this, a thrown getApiKey (e.g. "Sign in
    // required", "Permission required") ends the turn silently — the chat UI
    // just sees typing stop, and the terminal sees nothing. pi-agent-core's
    // `handleRunFailure` attaches the thrown error message to the final
    // assistant message as `errorMessage`; we relay that to both surfaces.
    runner.subscribe((event) => {
      if (event.type !== "agent_end") return;
      const messages = (event as { messages?: unknown[] }).messages;
      if (!Array.isArray(messages) || messages.length === 0) return;
      const last = messages[messages.length - 1] as
        | { role?: string; stopReason?: string; errorMessage?: string }
        | null;
      if (!last || last.role !== "assistant") return;
      if (last.stopReason === "aborted") {
        const msg = last.errorMessage ?? "Turn aborted.";
        const context = this.abortContexts.get(channelId);
        this.abortContexts.delete(channelId);
        console.log(
          `[AgentWorkerBase] Agent turn aborted on channel=${channelId}: ` +
          `reason=${context?.reason ?? "unknown"}${context?.detail ? ` detail=${context.detail}` : ""}; ${msg}`,
        );
        return;
      }
      if (last.stopReason !== "error") return;
      const msg = last.errorMessage ?? "Turn failed.";
      if (credentialRequiredMessage(msg)) {
        this.emitModelCredentialRequiredCard(channelId, this.getModelProviderId(), this.getModelBaseUrl());
        return;
      }
      console.error(`[AgentWorkerBase] Agent turn ended with error on channel=${channelId}: ${msg}`);
      const participantId = this.subscriptions.getParticipantId(channelId);
      if (!participantId) return;
      const channel = this.createChannelClient(channelId);
      const messageId = crypto.randomUUID();
      void channel.send(participantId, messageId, msg, {
        contentType: "error",
        persist: true,
      }).catch((err) => {
        console.error(`[AgentWorkerBase] Failed to emit turn-error message for channel=${channelId}:`, err);
      });
    });

    this.runners.set(channelId, { runner });
    // Dispatcher self-subscribes to runner events for absorption tracking
    // and sweep. Created here so it exists before the first onChannelEvent
    // (which expects to hand messages to it).
    this.getOrCreateDispatcher(channelId, runner, projector);
    return runner;
  }

  // ── Per-channel projector (Pi events → channel messages) ───────────────

  /** One projector per channel, created lazily when the runner is wired up. */
  protected projectors = new Map<string, ContentBlockProjector>();

  protected getOrCreateProjector(channelId: string): ContentBlockProjector {
    const existing = this.projectors.get(channelId);
    if (existing) return existing;
    const projector = new ContentBlockProjector(this.createProjectorSink(channelId));
    this.projectors.set(channelId, projector);
    return projector;
  }

  private createProjectorSink(channelId: string): ProjectorSink {
    return {
      send: async (msgId, content, opts) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        await channel.send(participantId, msgId, content, {
          persist: true,
          contentType: opts?.contentType,
          attachments: opts?.attachments,
        });
      },
      update: async (msgId, content, opts) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        await channel.update(participantId, msgId, content, undefined, opts);
      },
      complete: async (msgId) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        await channel.complete(participantId, msgId);
      },
      error: async (msgId, message, code) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        await channel.error(participantId, msgId, message, code);
      },
    };
  }

  private loadMessages(channelId: string): AgentMessage[] {
    const rows = this.sql.exec(
      `SELECT content FROM pi_messages WHERE channel_id = ? ORDER BY idx`,
      channelId,
    ).toArray();
    return rows.map((row) => JSON.parse(row["content"] as string) as AgentMessage);
  }

  private async saveMessages(channelId: string, messages: AgentMessage[]): Promise<void> {
    messages = trimTrailingEmptyAbortedAssistant(messages);
    this.sql.exec(`DELETE FROM pi_messages WHERE channel_id = ?`, channelId);
    for (let i = 0; i < messages.length; i++) {
      this.sql.exec(
        `INSERT INTO pi_messages (channel_id, idx, content) VALUES (?, ?, ?)`,
        channelId,
        i,
        JSON.stringify(messages[i]),
      );
    }
  }

  private async ensureChannelContext(channelId: string): Promise<void> {
    await this.recoverDispatchesForChannel(channelId);
    await this.refreshRoster(channelId);
    await this.getOrCreateRunner(channelId);
    this.getOrCreateProjector(channelId);
  }

  private recordAbort(channelId: string, reason: AgentAbortReason, detail?: string): void {
    this.abortContexts.set(channelId, { reason, detail, at: Date.now() });
    console.log(
      `[AgentWorkerBase] Agent abort requested on channel=${channelId}: ` +
      `reason=${reason}${detail ? ` detail=${detail}` : ""}`,
    );
  }

  private async abortAgentForReason(
    channelId: string,
    reason: AgentAbortReason,
    detail?: string,
  ): Promise<void> {
    const runner = await this.getOrCreateRunner(channelId);
    this.recordAbort(channelId, reason, detail);
    runner.abortAgent();
  }

  private async recoverDispatchesForChannel(channelId: string): Promise<void> {
    if (this.recoveredChannels.has(channelId)) return;

    const messages = this.loadMessages(channelId);
    const pending = this.dispatches.listForChannel(channelId);
    for (const breadcrumb of pending) {
      if (hasToolResultMessage(messages, breadcrumb.toolCallId)) continue;
      this.dispatches.deleteOne(breadcrumb.callId);
      await this.sendDispatchCancel(channelId, breadcrumb.callId, "worker-restart");
    }
    this.recoveredChannels.add(channelId);
  }

  private async drainDeferredDispatchesFor(channelId: string): Promise<void> {
    const deferred = this.dispatches.listDeferredForChannel(channelId);
    for (const breadcrumb of deferred) {
      const messages = this.loadMessages(channelId);
      if (!hasToolResultMessage(messages, breadcrumb.toolCallId)) continue;
      const claimed = this.dispatches.tryClaim(breadcrumb.callId);
      if (!claimed) continue;
      try {
        if (claimed.abandonedReason) {
          await this.finalizeAbandonedDispatch(claimed, messages);
        } else if (claimed.pendingResultJson) {
          await this.applyResult(
            claimed,
            decodeBufferedDispatchResult(claimed.pendingResultJson),
            claimed.pendingIsError ?? false,
          );
        } else {
          this.dispatches.releaseClaim(claimed.callId, claimed.resolvingToken);
        }
      } catch (err) {
        this.dispatches.releaseClaim(claimed.callId, claimed.resolvingToken);
        throw err;
      }
    }
  }

  // ── Dispatch + typing (delegated to TurnDispatcher) ─────────────────────
  //
  // One TurnDispatcher per channel. Every incoming user message flows
  // through `dispatcher.submit`; the dispatcher owns the queue, steer
  // tracking, self-healing sweep, and typing-indicator broadcasts.
  // See `turn-dispatcher.ts` for the full state-machine doc.

  protected dispatchers = new Map<string, TurnDispatcher>();

  protected getOrCreateDispatcher(
    channelId: string,
    runner: PiRunner,
    projector: ContentBlockProjector,
  ): TurnDispatcher {
    const existing = this.dispatchers.get(channelId);
    if (existing) return existing;
    const dispatcher = new TurnDispatcher({
      runner,
      projector,
      notifyTyping: (busy) => this.broadcastTyping(channelId, busy),
    });
    this.dispatchers.set(channelId, dispatcher);
    return dispatcher;
  }

  /** Ephemeral setTypingState broadcast. Fire-and-forget; errors logged. */
  private broadcastTyping(channelId: string, busy: boolean): void {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const channel = this.createChannelClient(channelId);
    void channel.setTypingState(participantId, busy).catch((err) => {
      console.warn(`[AgentWorkerBase] setTypingState(${busy}) failed for channel=${channelId}:`, err);
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

    const callId = crypto.randomUUID();
    if (onStreamUpdate) this.streamCallbacks.set(callId, onStreamUpdate);
    this.dispatches.store({
      callId,
      channelId,
      kind: "tool-call",
      toolCallId,
    });
    try {
      await channel.callMethod(callerId, target.participantId, callId, method, args);
    } catch (err) {
      this.dispatches.deleteOne(callId);
      this.streamCallbacks.delete(callId);
      throw err;
    }
    await this.abortAgentForReason(channelId, "participant-method-dispatch", `${participantHandle}.${method}`);
    return makeDispatchPlaceholder(toolCallId, callId, "tool-call");
  }

  private async askUser(
    channelId: string,
    toolCallId: string,
    params: AskUserParams,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult<any>> {
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

    const callId = crypto.randomUUID();
    this.dispatches.store({
      callId,
      channelId,
      kind: "ask-user",
      toolCallId,
    });
    try {
      await channel.callMethod(callerId, panel.participantId, callId, "feedback_form", params);
    } catch (err) {
      this.dispatches.deleteOne(callId);
      throw err;
    }
    await this.abortAgentForReason(channelId, "ask-user-dispatch");
    return makeDispatchPlaceholder(toolCallId, callId, "ask-user");
  }

  private buildUICallbacks(channelId: string): NatStackScopedUiContext {
    return {
      selectForTool: async (toolCallId, title, options, opts) =>
        this.dispatchUiPrompt(
          channelId,
          toolCallId,
          "select",
          { title, options },
          opts?.signal,
        ) as Promise<string | undefined>,
      confirmForTool: async (toolCallId, title, message, opts, meta) =>
        this.dispatchUiPrompt(
          channelId,
          toolCallId,
          "confirm",
          { title, message },
          opts?.signal,
          meta,
        ) as Promise<boolean>,
      inputForTool: async (toolCallId, title, placeholder, opts) =>
        this.dispatchUiPrompt(
          channelId,
          toolCallId,
          "input",
          { title, placeholder },
          opts?.signal,
        ) as Promise<string | undefined>,
      editorForTool: async (toolCallId, title, prefill) =>
        this.dispatchUiPrompt(
          channelId,
          toolCallId,
          "editor",
          { title, prefill },
          undefined,
        ) as Promise<string | undefined>,
      notify: (message, type) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendEphemeral(participantId, message, `notify:${type ?? "info"}`);
      },
      setStatus: (key, text) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendEphemeralEvent(participantId, "natstack-ext-status", { key, text });
      },
      setWidget: (key, content, options) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendEphemeralEvent(participantId, "natstack-ext-widget", { key, content, options });
      },
      setWorkingMessage: (message) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendEphemeralEvent(participantId, "natstack-ext-working", { message: message ?? null });
      },
    };
  }

  private async emitModelCredentialRequiredCard(channelId: string, providerId: string, modelBaseUrl: string): Promise<void> {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const key = `${channelId}::model-credential::${providerId}`;
    if (this.credentialPromptCardsEmitted.has(key)) return;
    this.credentialPromptCardsEmitted.add(key);

    const channel = this.createChannelClient(channelId);
    let browserHandoffCallerId: string | undefined;
    try {
      const participants = await channel.getParticipants();
      const panel = participants.find((p) => {
        const t = p.metadata["type"] as string | undefined;
        return t === "panel" || t === "client";
      });
      browserHandoffCallerId = panel?.participantId;
    } catch (err) {
      console.warn(`[AgentWorkerBase] Failed to resolve browser handoff panel for ${providerId}:`, err);
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
        ...(this.getModelCredentialSetupProps(providerId) ?? {}),
      },
    });
    void channel
      .send(participantId, messageId, content, {
        contentType: "inline_ui",
        persist: false,
      })
      .catch((err) => {
        console.error(`[AgentWorkerBase] Failed to emit model credential card for ${providerId}:`, err);
        this.credentialPromptCardsEmitted.delete(key);
      });
  }

  async onCallResult(callId: string, result: unknown, isError: boolean): Promise<void> {
    this.streamCallbacks.delete(callId);
    const breadcrumb = this.dispatches.peek(callId);
    if (!breadcrumb) return;
    this.dispatches.bufferResult(callId, result, isError);

    const messages = this.loadMessages(breadcrumb.channelId);
    if (!hasToolResultMessage(messages, breadcrumb.toolCallId)) return;

    const claimed = this.dispatches.tryClaim(callId);
    if (!claimed) return;
    try {
      if (claimed.abandonedReason) {
        await this.finalizeAbandonedDispatch(claimed, messages);
      } else if (claimed.pendingResultJson) {
        await this.applyResult(
          claimed,
          decodeBufferedDispatchResult(claimed.pendingResultJson),
          claimed.pendingIsError ?? false,
        );
      } else {
        this.dispatches.releaseClaim(claimed.callId, claimed.resolvingToken);
      }
    } catch (err) {
      this.dispatches.releaseClaim(claimed.callId, claimed.resolvingToken);
      throw err;
    }
  }

  private async applyResult(
    breadcrumb: DispatchedCall,
    result: unknown,
    isError: boolean,
  ): Promise<void> {
    let messages = this.loadMessages(breadcrumb.channelId);
    const timestamp = Date.now();

    if (breadcrumb.kind === "approval") {
      if (isError || result === false || result === "deny") {
        messages = replaceToolResultMessage(messages, breadcrumb.toolCallId, {
          role: "toolResult",
          toolCallId: breadcrumb.toolCallId,
          toolName: breadcrumb.toolName ?? toolNameFromMessages(messages, breadcrumb.toolCallId),
          content: [{ type: "text", text: "User denied tool call" }],
          isError: true,
          timestamp,
        });
      } else {
        await this.ensureChannelContext(breadcrumb.channelId);
        const runner = this.runners.get(breadcrumb.channelId)!.runner;
        let execResult: AgentToolResult<any>;
        try {
          execResult = await runner.executeToolDirect(
            breadcrumb.toolName ?? toolNameFromMessages(messages, breadcrumb.toolCallId),
            breadcrumb.toolCallId,
            breadcrumb.paramsJson ? JSON.parse(breadcrumb.paramsJson) : {},
          );
        } catch (err) {
          messages = replaceToolResultMessage(messages, breadcrumb.toolCallId, {
            role: "toolResult",
            toolCallId: breadcrumb.toolCallId,
            toolName: breadcrumb.toolName ?? toolNameFromMessages(messages, breadcrumb.toolCallId),
            content: [{
              type: "text",
              text: err instanceof Error ? err.message : String(err),
            }],
            details: { __natstack_resume_execution_failed: true },
            isError: true,
            timestamp,
          });
          await this.finishDispatchResolution(breadcrumb, messages, false);
          return;
        }
        messages = replaceToolResultMessage(messages, breadcrumb.toolCallId, {
          role: "toolResult",
          toolCallId: breadcrumb.toolCallId,
          toolName: breadcrumb.toolName ?? toolNameFromMessages(messages, breadcrumb.toolCallId),
          content: execResult.content,
          details: execResult.details,
          isError: false,
          timestamp,
        });
      }
    } else {
      const toolResult = toAgentToolResult(result);
      messages = replaceToolResultMessage(messages, breadcrumb.toolCallId, {
        role: "toolResult",
        toolCallId: breadcrumb.toolCallId,
        toolName: toolNameFromMessages(messages, breadcrumb.toolCallId),
        content: toolResult.content,
        details: toolResult.details,
        isError,
        timestamp,
      });
    }

    await this.finishDispatchResolution(breadcrumb, messages, true);
  }

  private async finishDispatchResolution(
    breadcrumb: DispatchedCall,
    messages: AgentMessage[],
    continueWhenClear: boolean,
  ): Promise<void> {
    await this.ensureChannelContext(breadcrumb.channelId);
    const runner = this.runners.get(breadcrumb.channelId)!.runner;
    messages = runner.trimTrailingAbortedAssistant(messages);

    await this.saveMessages(breadcrumb.channelId, messages);
    runner.replaceHistory(messages);
    this.dispatches.deleteClaimed(breadcrumb.callId, breadcrumb.resolvingToken);

    const interruptedAfterDispatch =
      (this.lastUserInterruptAt.get(breadcrumb.channelId) ?? 0) >= breadcrumb.createdAt;
    if (
      continueWhenClear &&
      !interruptedAfterDispatch &&
      this.dispatches.listForChannel(breadcrumb.channelId).length === 0
    ) {
      const projector = this.getOrCreateProjector(breadcrumb.channelId);
      const dispatcher = this.getOrCreateDispatcher(breadcrumb.channelId, runner, projector);
      dispatcher.submitContinue();
    }
  }

  private async finalizeAbandonedDispatch(
    breadcrumb: DispatchedCall,
    messages: AgentMessage[],
  ): Promise<void> {
    const nextMessages = replaceToolResultMessage(messages, breadcrumb.toolCallId, {
      role: "toolResult",
      toolCallId: breadcrumb.toolCallId,
      toolName: toolNameFromMessages(messages, breadcrumb.toolCallId),
      content: [{ type: "text", text: "Dispatched call superseded by user message" }],
      details: {
        __natstack_dispatch_abandoned: true,
        callId: breadcrumb.callId,
      },
      isError: true,
      timestamp: Date.now(),
    });
    await this.finishDispatchResolution(breadcrumb, nextMessages, false);
  }

  private async dispatchUiPrompt(
    channelId: string,
    toolCallId: string,
    kind: "select" | "confirm" | "input" | "editor",
    params: Record<string, unknown>,
    signal?: AbortSignal,
    meta?: { toolName?: string; toolInput?: unknown; mode?: "approval" | "ui-prompt" },
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

    const callId = crypto.randomUUID();
    const breadcrumbKind: DispatchedCallKind =
      meta?.mode === "approval" ? "approval" : "ui-prompt";
    this.dispatches.store({
      callId,
      channelId,
      kind: breadcrumbKind,
      toolCallId,
      toolName: breadcrumbKind === "approval" ? meta?.toolName ?? null : null,
      paramsJson:
        breadcrumbKind === "approval"
          ? JSON.stringify(meta?.toolInput ?? {})
          : null,
    });
    try {
      await channel.callMethod(
        callerId,
        panel.participantId,
        callId,
        "ui_prompt",
        { kind, ...params },
      );
    } catch (err) {
      this.dispatches.deleteOne(callId);
      throw err;
    }

    const runner = await this.getOrCreateRunner(channelId);
    this.recordAbort(channelId, "ui-prompt-dispatch", kind);
    runner.abortAgent();
    const placeholder = makeDispatchPlaceholder(toolCallId, callId, breadcrumbKind);
    throw new DispatchedError(placeholder);
  }

  private async absorbAbandonedDispatches(channelId: string): Promise<void> {
    const pending = this.dispatches.listForChannel(channelId);
    if (pending.length === 0) return;

    for (const breadcrumb of pending) {
      this.dispatches.markAbandoned(breadcrumb.callId, "user-superseded");
      await this.sendDispatchCancel(channelId, breadcrumb.callId, "user-superseded");
    }
  }

  private async sendDispatchCancel(
    channelId: string,
    callId: string,
    reason: "user-superseded" | "worker-restart" | "user-interrupted",
  ): Promise<void> {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    await this.createChannelClient(channelId).sendEphemeralEvent(
      participantId,
      "natstack-dispatch-cancel",
      { callId, reason },
    );
  }

  private async notifyDispatchesInterrupted(channelId: string): Promise<void> {
    const pending = this.dispatches.listForChannel(channelId);
    if (pending.length === 0) return;

    for (const breadcrumb of pending) {
      try {
        await this.sendDispatchCancel(channelId, breadcrumb.callId, "user-interrupted");
      } catch (err) {
        console.warn(
          `[AgentWorkerBase] Failed to cancel dispatch ${breadcrumb.callId} on interrupt:`,
          err,
        );
      }
    }
  }

  // ── Default channel event handler ────────────────────────────────────────
  //
  // Subclasses MAY override this for custom routing, but the default behavior
  // covers the common case: incoming user messages are forwarded to Pi via the
  // per-channel runner. Pi handles the rest.

  async onChannelEvent(
    channelId: string,
    event: ChannelEvent,
    opts?: { mode?: "auto" | "sequential" },
  ): Promise<void> {
    if (!this.shouldProcess(event)) return;
    await this.ensureChannelContext(channelId);
    await this.absorbAbandonedDispatches(channelId);
    await this.drainDeferredDispatchesFor(channelId);

    const runner = this.runners.get(channelId)!.runner;
    const projector = this.getOrCreateProjector(channelId);
    const input = this.buildTurnInput(event);
    const images = await this.resizeAttachments(channelId, input.attachments);
    const agentMsg = runner.buildUserMessage(input.content, images);
    const dispatcher = this.getOrCreateDispatcher(channelId, runner, projector);
    dispatcher.submit(agentMsg, opts);
  }

  /** Resize user-pasted image attachments via the server-side image service.
   *  Best-effort: on failure, fall through to the original bytes. */
  private async resizeAttachments(
    channelId: string,
    attachments: Attachment[] | undefined,
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
        }>(
          "main",
          "image.resize",
          bytes,
          att.mimeType,
          { maxWidth: 2000, maxHeight: 2000 },
        );
        images.push({
          type: "image",
          mimeType: resized.mimeType,
          data: Buffer.from(resized.data).toString("base64"),
        });
      } catch (err) {
        console.warn(
          `[AgentWorkerBase] image.resize failed for channel=${channelId}; passing original:`,
          err,
        );
        images.push({ type: "image", mimeType: att.mimeType, data: att.data });
      }
    }
    return images.length > 0 ? images : undefined;
  }

  // ── Method calls (subclass hook) ─────────────────────────────────────────

  async onMethodCall(_channelId: string, _callId: string, _methodName: string, _args: unknown): Promise<{ result: unknown; isError?: boolean }> {
    return { result: { error: "not implemented" }, isError: true };
  }

  protected async resumeAfterModelCredentialConnected(channelId: string): Promise<boolean> {
    await this.ensureChannelContext(channelId);
    const entry = this.runners.get(channelId);
    if (!entry) return false;

    const messages = this.loadMessages(channelId);
    const last = messages[messages.length - 1] as
      | { role?: string; stopReason?: string; errorMessage?: string }
      | undefined;
    if (
      last?.role !== "assistant" ||
      last.stopReason !== "error" ||
      !credentialRequiredMessage(last.errorMessage ?? "")
    ) {
      return false;
    }

    const resumableMessages = messages.slice(0, -1);
    const resumeFrom = resumableMessages[resumableMessages.length - 1] as
      | { role?: string }
      | undefined;
    if (!resumeFrom || (resumeFrom.role !== "user" && resumeFrom.role !== "toolResult")) {
      return false;
    }

    await this.saveMessages(channelId, resumableMessages);
    entry.runner.replaceHistory(resumableMessages);
    this.credentialPromptCardsEmitted.delete(`${channelId}::model-credential::${this.getModelProviderId()}`);
    const projector = this.getOrCreateProjector(channelId);
    const dispatcher = this.getOrCreateDispatcher(channelId, entry.runner, projector);
    dispatcher.submitContinue();
    return true;
  }

  /** Interrupt the in-flight Pi turn for every active channel runner. */
  protected async interruptAllRunners(): Promise<void> {
    for (const [channelId, entry] of this.runners.entries()) {
      const projector = this.projectors.get(channelId);
      if (projector) await projector.closeAll();
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
      // Close every in-flight channel message (text/thinking/toolCall) before
      // tearing down the runner, so the client sees clean completion events
      // even though the *_end Pi events won't fire post-abort.
      const projector = this.projectors.get(channelId);
      if (projector) await projector.closeAll();
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
   * Rewrites identity, clears ephemeral state, resubscribes to forked channel.
   * The cloned worker boots its own PiRunner from the persisted pi_messages
   * on first user message (optionally truncated to `forkAtMessageIndex`).
   */
  async postClone(
    parentObjectKey: string,
    newChannelId: string,
    oldChannelId: string,
    forkAtMessageIndex: number | null,
  ): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey,
    );

    this.setStateValue("forkedFrom", parentObjectKey);
    if (forkAtMessageIndex != null) {
      this.setStateValue("forkAtMessageIndex", String(forkAtMessageIndex));
    }
    this.setStateValue("forkSourceChannel", oldChannelId);

    // Clear ephemeral state copied from parent.
    this.sql.exec(`DELETE FROM delivery_cursor`);
    this.sql.exec(`DELETE FROM dispatched_calls`);

    // Migrate parent's message history from oldChannelId → newChannelId.
    // Check pi_messages first (normalized), fall back to legacy pi_sessions blob.
    const hasPiMessages = (this.sql.exec(
      `SELECT COUNT(*) as cnt FROM pi_messages WHERE channel_id = ?`, oldChannelId,
    ).toArray()[0]?.["cnt"] as number ?? 0) > 0;

    if (hasPiMessages) {
      // Normalized path: rename channel via UPDATE, trim via DELETE.
      this.sql.exec(
        `UPDATE pi_messages SET channel_id = ? WHERE channel_id = ?`,
        newChannelId, oldChannelId,
      );
      if (forkAtMessageIndex != null) {
        this.sql.exec(
          `DELETE FROM pi_messages WHERE channel_id = ? AND idx >= ?`,
          newChannelId, forkAtMessageIndex,
        );
      }
    } else {
      // Legacy blob path: migrate to pi_messages during fork.
      const parentSession = this.sql.exec(
        `SELECT messages_blob FROM pi_sessions WHERE channel_id = ?`, oldChannelId,
      ).toArray();
      if (parentSession.length > 0) {
        try {
          let messages = JSON.parse(parentSession[0]!["messages_blob"] as string) as AgentMessage[];
          if (forkAtMessageIndex != null) messages = messages.slice(0, forkAtMessageIndex);
          for (let i = 0; i < messages.length; i++) {
            this.sql.exec(
              `INSERT INTO pi_messages (channel_id, idx, content) VALUES (?, ?, ?)`,
              newChannelId, i, JSON.stringify(messages[i]),
            );
          }
          this.sql.exec(`DELETE FROM pi_sessions WHERE channel_id = ?`, oldChannelId);
        } catch (err) {
          console.warn(`[AgentWorkerBase] failed to migrate pi_sessions during fork:`, err);
        }
      }
    }

    // Rename approvalLevel state key.
    const oldApprovalKey = `approvalLevel:${oldChannelId}`;
    const newApprovalKey = `approvalLevel:${newChannelId}`;
    const approvalValue = this.getStateValue(oldApprovalKey);
    if (approvalValue) {
      this.setStateValue(newApprovalKey, approvalValue);
      this.deleteStateValue(oldApprovalKey);
    }

    // Resubscribe to the forked channel.
    const subRow = this.sql.exec(
      `SELECT context_id, config FROM subscriptions WHERE channel_id = ?`, oldChannelId,
    ).toArray();
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
    this.projectors.clear();
    this._fsContextBound.clear(); // Re-bind fs context on first resubscribe.

    if (contextId) {
      await this.subscribeChannel({ channelId: newChannelId, contextId, config });
    }

    await this.onPostClone(parentObjectKey, newChannelId, oldChannelId, forkAtMessageIndex);
  }

  protected async onPostClone(
    _parentObjectKey: string,
    _newChannelId: string,
    _oldChannelId: string,
    _forkAtMessageIndex: number | null,
  ): Promise<void> {
    // Default: no-op
  }

  // ── Fetch override ───────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    this.ensureReady();

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !(this as unknown as { _objectKey?: string })._objectKey) {
      (this as unknown as { _objectKey?: string })._objectKey = decodeURIComponent(segments[0]!);
    }

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
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          args = result.args;
        }
      }
      if (args.length < 2) {
        return new Response(JSON.stringify({ error: "__event requires at least [event, payload]" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
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
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          args = result.args;
        }
      }

      if (method === "onChannelEvent" && args.length === 2) {
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
    const piMessages = this.sql.exec(
      `SELECT channel_id, idx, LENGTH(content) as content_len FROM pi_messages`,
    ).toArray();
    const piSessionsLegacy = this.sql.exec(`SELECT channel_id, updated_at FROM pi_sessions`).toArray();
    const dispatchedCalls = this.sql.exec(`SELECT * FROM dispatched_calls`).toArray();
    const deliveryCursors = this.sql.exec(`SELECT * FROM delivery_cursor`).toArray();
    return { subscriptions, piMessages, piSessionsLegacy, dispatchedCalls, deliveryCursors };
  }

  // Reference SAFE_TOOL_NAMES_DEFAULT to suppress unused-import warnings;
  // it's exported from the harness package via DEFAULT_SAFE_TOOL_NAMES, but
  // we keep a local reference here for documentation/symmetry.
  protected static readonly _SAFE_TOOL_NAMES_REFERENCE = SAFE_TOOL_NAMES_DEFAULT;
}

function makeDispatchPlaceholder(
  toolCallId: string,
  callId: string,
  kind: DispatchedCallKind,
): AgentToolResult<any> {
  return {
    content: [{ type: "text", text: `dispatched: ${kind} callId=${callId}` }],
    details: { __natstack_dispatch: true, callId, kind, toolCallId },
  };
}

function hasToolResultMessage(messages: AgentMessage[], toolCallId: string): boolean {
  return messages.some((message) => (
    (message as { role?: string; toolCallId?: string }).role === "toolResult" &&
    (message as { toolCallId?: string }).toolCallId === toolCallId
  ));
}

function toolNameFromMessages(messages: AgentMessage[], toolCallId: string): string {
  const match = messages.find((message) => (
    (message as { role?: string; toolCallId?: string }).role === "toolResult" &&
    (message as { toolCallId?: string }).toolCallId === toolCallId
  )) as { toolName?: string } | undefined;
  return match?.toolName ?? "unknown";
}

function replaceToolResultMessage(
  messages: AgentMessage[],
  toolCallId: string,
  replacement: AgentMessage,
): AgentMessage[] {
  const index = messages.findIndex((message) => (
    (message as { role?: string; toolCallId?: string }).role === "toolResult" &&
    (message as { toolCallId?: string }).toolCallId === toolCallId
  ));
  if (index < 0) return messages;
  const next = messages.slice();
  next[index] = replacement;
  return next;
}

function toAgentToolResult(result: unknown): AgentToolResult<any> {
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return result as AgentToolResult<any>;
  }
  const text =
    typeof result === "string"
      ? result
      : JSON.stringify(result) ?? String(result);
  return {
    content: [{ type: "text", text }],
    details: undefined,
  };
}

function decodeBufferedDispatchResult(json: string): unknown {
  const parsed = JSON.parse(json) as { value?: unknown };
  return parsed.value;
}

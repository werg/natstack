import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { ServiceError, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { EventName } from "@natstack/shared/events";
import type { NotificationPayload } from "@natstack/shared/events";
import type { EventService, Subscriber } from "@natstack/shared/eventsService";
import { EXTENSION_RUNTIME_ABI_VERSION } from "@natstack/shared/extensionRuntimeAbi";
import type {
  PendingExtensionApproval,
  PendingExtensionApprovalAction,
  UserlandApprovalChoice,
  UserlandApprovalIssuer,
  UserlandApprovalRequest,
} from "@natstack/shared/approvals";
import { userlandApprovalRequestSchema } from "@natstack/shared/approvals";
import { execGitFileSync } from "@natstack/shared/gitRuntime";

import { ExtensionRegistry } from "./registry.js";
import { ExtensionProcessManager } from "./processManager.js";
import { SourcePushGrantStore } from "./sourcePushGrants.js";
import {
  isBinaryEnvelope,
  isStreamEnvelope,
  type BinaryEnvelope,
  type BodyEnvelope,
  type StreamChunkEnvelope,
  type StreamEnvelope,
} from "./wireEnvelopes.js";
import type {
  ExtensionHostCodeIdentityResolver,
  ExtensionHealth,
  ExtensionInvocation,
  InstallSpec,
  RegistryEntry,
} from "./types.js";
import { invocationFromServiceContext } from "./types.js";

interface BuildSystemLike {
  getBuild(
    unitPath: string,
    ref?: string,
  ): Promise<{ bundlePath: string; dir: string; metadata: ExtensionBuildMetadataLike }>;
  getBuildByKey?(key: string): { bundlePath: string; dir: string; metadata: ExtensionBuildMetadataLike } | null;
  getEffectiveVersion(unitName: string): string | null;
  getExternalDeps(unitName: string): Record<string, string>;
  getGraph(): {
    allNodes(): Array<{
      name: string;
      kind: string;
      relativePath: string;
      path: string;
      dependencies: Record<string, string>;
      internalDeps: string[];
      manifest: { displayName?: string; extension?: { activationEvents?: string[] } };
    }>;
  };
  onPushBuild(callback: (source: string) => void): void;
}

interface ExtensionBuildMetadataLike {
  ev: string;
  runtimeDepsKey?: string | null;
  extensionRuntimeAbi?: string | null;
  extensionExternalDeps?: Record<string, string>;
}

interface ExtensionTransportLike {
  call(name: string, method: string, ...args: unknown[]): Promise<unknown>;
}

interface ApprovalQueueLike {
  request(req: ({
    kind: "capability";
    callerId: string;
    callerKind: "panel" | "worker";
    repoPath: string;
    effectiveVersion: string;
    capability: string;
    dedupKey?: string | null;
    title: string;
    description?: string;
    resource?: { type: string; label: string; value: string };
    details?: Array<{ label: string; value: string }>;
  } | {
    kind: "extension";
    callerId: string;
    callerKind: "panel" | "worker";
    repoPath: string;
    effectiveVersion: string;
    dedupKey?: string | null;
    action: PendingExtensionApprovalAction;
    extensionName: string;
    version?: string | null;
    source: PendingExtensionApproval["source"];
    title: string;
    description: string;
    ev?: string | null;
    previousEv?: string | null;
    sha?: string | null;
    previousSha?: string | null;
    activeDependencyEvs?: Record<string, string>;
    candidateDependencyEvs?: Record<string, string>;
    activeRuntimeDepsKey?: string | null;
    candidateRuntimeDepsKey?: string | null;
    extensionDiff?: PendingExtensionApproval["extensionDiff"];
    workspaceDepChanges?: PendingExtensionApproval["workspaceDepChanges"];
    externalDepChanges?: PendingExtensionApproval["externalDepChanges"];
    integrity?: string | null;
    capabilities?: string[];
    details?: PendingExtensionApproval["details"];
  })): Promise<"once" | "session" | "version" | "repo" | "deny">;
  requestUserland(req: {
    principal: {
      callerId: string;
      callerKind: "panel" | "worker";
      repoPath: string;
      effectiveVersion: string;
    };
    issuer?: UserlandApprovalIssuer;
  } & UserlandApprovalRequest): Promise<UserlandApprovalChoice>;
}

interface NotificationServiceLike {
  show(notification: Omit<NotificationPayload, "id"> & { id?: string }): string;
}

interface UserlandApprovalGrantStoreLike {
  lookup(callerId: string, subjectId: string, issuer?: UserlandApprovalIssuer): { choice: string } | null;
  record(
    principal: { callerId: string; callerKind: "panel" | "worker" },
    subject: { id: string; label?: string },
    choice: string,
    now?: number,
    issuer?: UserlandApprovalIssuer,
  ): Promise<void>;
}

export interface ExtensionHostDeps {
  statePath: string;
  workspacePath: string;
  workspaceId: string;
  buildSystem: BuildSystemLike;
  tokenManager: TokenManager;
  eventService: EventService;
  approvalQueue: ApprovalQueueLike;
  userlandApprovalGrantStore: UserlandApprovalGrantStoreLike;
  notificationService?: NotificationServiceLike;
  codeIdentityResolver: ExtensionHostCodeIdentityResolver;
  getGatewayUrl(): string;
  /**
   * Bridge from the dispatcher to a connected extension's WebSocket. Required
   * — `invoke` and `handleExtensionHttpRequest` need this to reach the child.
   */
  extensionTransport: ExtensionTransportLike;
}

export class ExtensionHost {
  readonly registry: ExtensionRegistry;
  readonly processes: ExtensionProcessManager;
  private health = new Map<string, unknown>();
  private inspectorUrls = new Map<string, string | null>();
  private unitLogs = new Map<string, UnitLogRecord[]>();
  private fetchRequestBodies = new Map<string, FetchRequestBodyStream>();
  private invokeAvailability = new Map<string, Promise<RegistryEntry | null>>();
  private readonly sourcePushGrants: SourcePushGrantStore;

  constructor(private readonly deps: ExtensionHostDeps) {
    this.registry = new ExtensionRegistry({ statePath: deps.statePath });
    this.sourcePushGrants = new SourcePushGrantStore({ statePath: deps.statePath });
    this.processes = new ExtensionProcessManager({
      onStatus: (name, status, error) => {
        if (this.registry.has(name)) {
          this.registry.patch(name, { status, lastError: error ?? null });
        }
        this.deps.eventService.emit("extensions:status", { name, status, error: error ?? null });
      },
      onError: (name, error, attempts) => {
        this.deps.eventService.emit("extensions:error", { name, error, attempts });
      },
      onHealth: (name, health) => {
        this.reportExtensionHealth(name, health);
      },
      onLog: (name, level, message, fields, source = "ctx.log") => {
        this.recordExtensionLog(name, level, message, fields, source);
      },
      onCrashLimit: (name, error, attempts) => {
        this.deps.notificationService?.show({
          id: `extension-crash-${encodeURIComponent(name)}`,
          type: "error",
          title: "Extension stopped",
          message: `${name} failed ${attempts} times and will not restart until reloaded. ${error}`,
        });
      },
      onInspectorUrl: (name, inspectorUrl) => {
        this.inspectorUrls.set(name, inspectorUrl);
        this.deps.eventService.emit("extensions:status", {
          name,
          status: this.registry.get(name)?.status ?? "running",
          inspectorUrl,
        });
      },
    });
    deps.buildSystem.onPushBuild((source) => {
      this.handleSourceRebuilt(source).catch((err) => {
        console.error(
          `[ExtensionHost] Failed to reload rebuilt extension source ${source}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    });
  }

  async startEnabled(): Promise<void> {
    for (const entry of this.registry.list()) {
      if (!entry.enabled || !entry.activeBundleKey) continue;
      try {
        const node = this.findExtensionNode(entry.name);
        if (this.needsBuildRefresh(entry, node)) {
          await this.buildAndActivate(entry.name, entry.source.ref);
        } else {
          await this.activate(entry.name);
        }
      } catch (err) {
        this.registry.patch(entry.name, {
          status: "error",
          lastError: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async ensureBuiltInExtensions(names: string[]): Promise<void> {
    const newlyPending: string[] = [];
    for (const name of names) {
      const node = this.findExtensionNode(name);
      const current = this.registry.get(node.name);
      if (!current) {
        this.registry.upsert({
          name: node.name,
          version: this.readNodeVersion(node.path),
          source: { kind: "internal-git", repo: node.relativePath, ref: "HEAD" },
          installedAt: Date.now(),
          activeEv: null,
          activeSha: null,
          activeBundleKey: null,
          activeDependencyEvs: {},
          activeExternalDeps: {},
          activeRuntimeDepsKey: null,
          enabled: false,
          status: "pending-approval",
          lastError: null,
        });
        newlyPending.push(node.name);
        continue;
      }

      const patch: Partial<RegistryEntry> = {};
      if (current.enabled && current.status === "error" && !current.activeBundleKey) {
        patch.status = "building";
        patch.lastError = null;
      }
      if (Object.keys(patch).length > 0) {
        this.registry.patch(node.name, patch);
      }
      if (current.enabled && !current.activeBundleKey) {
        await this.buildAndActivate(node.name);
      }
    }
    if (newlyPending.length > 0) {
      // Surface the pending-approval state on first boot so the user knows
      // the migrated built-in extensions need to be installed; without this
      // the user only discovers them when a feature that depends on them
      // appears broken.
      const list = newlyPending.length === 1
        ? newlyPending[0]!
        : `${newlyPending.slice(0, -1).join(", ")} and ${newlyPending[newlyPending.length - 1]!}`;
      this.deps.notificationService?.show({
        id: `extensions-pending-approval-${newlyPending.join(",")}`,
        type: "info",
        title: "Extensions need approval",
        message: `${list} ${newlyPending.length === 1 ? "is" : "are"} installed but disabled. Approve installation from the extensions panel to enable.`,
      });
      for (const pendingName of newlyPending) {
        this.deps.eventService.emit("extensions:status", {
          name: pendingName,
          status: "pending-approval",
          error: null,
        });
      }
    }
  }

  async shutdown(): Promise<void> {
    await this.processes.shutdown();
  }

  createServiceDefinition(): ServiceDefinition {
    return {
      name: "extensions",
      description: "Installed extension management and invocation",
      policy: { allowed: ["panel", "worker", "shell", "extension"] },
      methods: {
        invoke: { args: z.tuple([z.string(), z.string(), z.array(z.unknown())]) },
        list: { args: z.tuple([]) },
        on: { args: z.tuple([z.string(), z.string()]) },
        ready: { args: z.tuple([z.object({ methods: z.array(z.string()), hasFetch: z.boolean() })]) },
        emit: { args: z.tuple([z.string(), z.unknown()]) },
        fetchRequestBodyChunk: { args: z.tuple([z.string()]) },
        fetchRequestBodyClose: { args: z.tuple([z.string()]) },
        health: { args: z.tuple([z.enum(["healthy", "degraded", "unhealthy"]), z.unknown().optional()]) },
        log: { args: z.tuple([z.enum(["debug", "info", "warn", "error"]), z.string(), z.record(z.unknown()).optional()]) },
        approvalForCaller: { args: z.tuple([z.unknown(), z.unknown()]) },
        install: { args: z.tuple([installSpecSchema]) },
        uninstall: { args: z.tuple([z.string(), z.object({ purge: z.boolean().optional() }).optional()]) },
        setEnabled: { args: z.tuple([z.string(), z.boolean()]) },
        update: { args: z.tuple([z.string()]) },
        reload: { args: z.tuple([z.string()]) },
      },
      handler: (ctx, method, args) => this.handle(ctx, method, args),
    };
  }

  private async handle(ctx: ServiceContext, method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "invoke":
        return this.invoke(ctx, args[0] as string, args[1] as string, args[2] as unknown[]);
      case "list":
        return this.registry.list();
      case "on":
        return this.subscribe(ctx, args[0] as string, args[1] as string);
      case "ready":
        return this.readyFromExtension(
          ctx,
          args[0] as { methods: string[]; hasFetch: boolean },
        );
      case "emit":
        return this.emitFromExtension(ctx, args[0] as string, args[1]);
      case "fetchRequestBodyChunk":
        return this.fetchRequestBodyChunk(ctx, args[0] as string);
      case "fetchRequestBodyClose":
        return this.fetchRequestBodyClose(ctx, args[0] as string);
      case "health":
        return this.healthFromExtension(ctx, args[0] as ExtensionHealth["state"], args[1]);
      case "log":
        return this.logFromExtension(
          ctx,
          args[0] as UnitLogRecord["level"],
          args[1] as string,
          args[2] as Record<string, unknown> | undefined,
        );
      case "approvalForCaller":
        return this.approvalForCallerFromExtension(ctx, args[0], args[1]);
      case "install":
        return this.install(ctx, args[0] as InstallSpec);
      case "uninstall":
        return this.uninstall(ctx, args[0] as string, args[1] as { purge?: boolean } | undefined);
      case "setEnabled":
        return this.setEnabled(ctx, args[0] as string, args[1] as boolean);
      case "update":
        return this.update(ctx, args[0] as string);
      case "reload":
        return this.reload(ctx, args[0] as string);
      default:
        throw new ServiceError("extensions", method, `Unknown extensions method: ${method}`, "ENOSYS");
    }
  }

  async invoke(ctx: ServiceContext, name: string, method: string, args: unknown[]): Promise<unknown> {
    const entry = await this.ensureAvailableForInvoke(ctx, name);
    if (!entry || !entry.enabled) {
      throw new ServiceError("extensions", "invoke", `Extension is not installed or enabled: ${name}`, "ENOEXT");
    }
    const invocation: ExtensionInvocation = invocationFromServiceContext(
      ctx,
      entry.name,
      method,
      randomUUID(),
      this.deps.codeIdentityResolver,
    );
    if (!this.processes.isRunning(entry.name)) {
      throw new ServiceError("extensions", "invoke", `Extension is not running: ${entry.name}`, "ENOEXT");
    }
    try {
      return await this.deps.extensionTransport.call(
        entry.name,
        "extension.invoke",
        method,
        args,
        invocation,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(
        `Extension ${entry.name}.${method} invocation failed: ${message}`,
      );
      if (error instanceof Error) {
        (wrapped as Error & { cause?: unknown }).cause = error;
        if (error.stack) {
          wrapped.stack = `${wrapped.message}\nCaused by: ${error.stack}`;
        }
      }
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (typeof code === "string") {
        (wrapped as NodeJS.ErrnoException).code = code;
      }
      this.recordExtensionLog(
        entry.name,
        "error",
        wrapped.message,
        {
          method,
          callerId: ctx.callerId,
          callerKind: ctx.callerKind,
          code: typeof code === "string" ? code : undefined,
          stack: wrapped.stack,
        },
        "console",
      );
      throw wrapped;
    }
  }

  private async ensureAvailableForInvoke(
    ctx: ServiceContext,
    name: string,
  ): Promise<RegistryEntry | null> {
    let node: ReturnType<ExtensionHost["findExtensionNode"]>;
    try {
      node = this.findExtensionNode(name);
    } catch {
      const entry = this.registry.get(name);
      return entry?.enabled ? entry : null;
    }

    // Re-entrant self-invocation: extension code that calls
    // `extensions.use("self")` during its own activate / fetch / invoke
    // would otherwise await the same in-flight install/update promise that
    // its own activation is fulfilling. If the process is already running
    // and the registry entry is enabled, skip the availability gate.
    if (ctx.callerKind === "extension" && ctx.callerId === node.name) {
      const entry = this.registry.get(node.name);
      if (entry?.enabled && this.processes.isRunning(node.name)) {
        return entry;
      }
    }

    const entry = this.registry.get(node.name);
    if (entry?.enabled) {
      if (!entry.activeBundleKey) {
        return this.runInvokeAvailability(node.name, () => this.buildAndActivate(entry.name, entry.source.ref));
      }
      if (this.needsBuildRefresh(entry, node)) {
        return this.runInvokeAvailability(node.name, () => this.update(ctx, entry.name));
      }
      return entry;
    }

    return this.runInvokeAvailability(node.name, async () => {
      const current = this.registry.get(node.name);
      if (current?.enabled && current.activeBundleKey && !this.needsBuildRefresh(current, node)) return;
      if (current?.enabled && current.activeBundleKey) {
        await this.update(ctx, current.name);
        return;
      }
      if (current?.enabled && !current.activeBundleKey) {
        await this.buildAndActivate(current.name, current.source.ref);
        return;
      }

      if (!current) {
        await this.install(ctx, {
          source: { kind: "internal-git", repo: node.relativePath, ref: "HEAD" },
        });
        return;
      }

      if (!current.activeBundleKey) {
        await this.install(ctx, { source: current.source });
        return;
      }

      await this.setEnabled(ctx, node.name, true);
    });
  }

  private async runInvokeAvailability(
    name: string,
    work: () => Promise<void>,
  ): Promise<RegistryEntry | null> {
    const existing = this.invokeAvailability.get(name);
    if (existing) return existing;

    const promise = (async () => {
      await work();
      return this.registry.get(name) ?? null;
    })();
    this.invokeAvailability.set(name, promise);
    try {
      return await promise;
    } finally {
      this.invokeAvailability.delete(name);
    }
  }

  async handleExtensionHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
    remainderPath: string,
    caller: { callerId: string; callerKind: string },
  ): Promise<void> {
    const entry = this.registry.get(name);
    if (!entry || !entry.enabled) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end(`Extension is not installed or enabled: ${name}`);
      return;
    }

    let body: BodyEnvelope | undefined;
    try {
      body = this.registerRequestBody(name, req);
    } catch (err) {
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end(err instanceof Error ? err.message : "Request body too large");
      return;
    }

    const method = "fetch";
    const ctx: ServiceContext = {
      callerId: caller.callerId,
      callerKind: caller.callerKind === "extension"
        ? "extension"
        : caller.callerKind === "worker"
          ? "worker"
          : caller.callerKind === "shell"
            ? "shell"
            : "panel",
    };
    const invocation = invocationFromServiceContext(
      ctx,
      name,
      method,
      randomUUID(),
      this.deps.codeIdentityResolver,
    );
    invocation.caller.callerKind = caller.callerKind === "panel" || caller.callerKind === "worker" || caller.callerKind === "shell" || caller.callerKind === "extension"
      ? caller.callerKind
      : "http";

    const originalUrl = req.url ?? "/";
    const query = originalUrl.includes("?") ? `?${originalUrl.split("?").slice(1).join("?")}` : "";
    const forwardedUrl = `${this.deps.getGatewayUrl()}/_r/ext/${encodeURIComponent(name)}${remainderPath}${query}`;

    try {
      const requestEnvelope = {
        url: forwardedUrl,
        method: req.method ?? "GET",
        headers: headersToRecord(req.headers),
        ...(body !== undefined ? { body } : {}),
      };
      const response = await this.deps.extensionTransport.call(name, "extension.fetch", requestEnvelope, invocation);
      const typedResponse = response as {
        status: number;
        headers: Record<string, string>;
        body: BodyEnvelope | string;
      };
      res.writeHead(typedResponse.status, typedResponse.headers);
      await this.writeExtensionResponseBody(name, res, typedResponse.body);
    } catch (err) {
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      const status = code === "ENOFETCH" ? 404 : code === "ENOEXT" ? 503 : 500;
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end(err instanceof Error ? err.message : String(err));
    } finally {
      if (isStreamEnvelope(body)) {
        await this.closeFetchRequestBody(body.id);
      }
    }
  }

  private registerRequestBody(extensionName: string, req: IncomingMessage): StreamEnvelope | undefined {
    if (req.method === "GET" || req.method === "HEAD") return undefined;
    const contentLengthHeader = req.headers["content-length"];
    if (typeof contentLengthHeader === "string") {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > EXTENSION_REQUEST_BODY_MAX_BYTES) {
        const err = new Error(
          `Request body exceeds the ${EXTENSION_REQUEST_BODY_MAX_BYTES}-byte extension fetch limit`,
        );
        (err as NodeJS.ErrnoException).code = "EFBIG";
        throw err;
      }
    }
    const id = randomUUID();
    this.fetchRequestBodies.set(id, {
      extensionName,
      iterator: req[Symbol.asyncIterator](),
      pending: null,
      offset: 0,
      bytesRead: 0,
    });
    return { __stream: true, id };
  }

  private async closeFetchRequestBody(id: string): Promise<void> {
    const stream = this.fetchRequestBodies.get(id);
    if (!stream) return;
    this.fetchRequestBodies.delete(id);
    try {
      await stream.iterator.return?.();
    } catch {
      // Ignore cancellation failures while cleaning up a proxied HTTP stream.
    }
  }

  private async writeExtensionResponseBody(
    extensionName: string,
    res: ServerResponse,
    body: BodyEnvelope | string,
  ): Promise<void> {
    if (!isStreamEnvelope(body)) {
      await writeInlineResponseBody(res, body);
      return;
    }
    try {
      while (true) {
        const next = await this.deps.extensionTransport.call(
          extensionName,
          "extension.fetchResponseBodyChunk",
          body.id,
        ) as StreamChunkEnvelope;
        if (next.done) break;
        if (next.chunk) {
          await writeResponseChunk(res, Buffer.from(next.chunk.data, "base64"));
        }
      }
      const finished = waitForResponseFinish(res);
      res.end();
      await finished;
    } finally {
      await this.deps.extensionTransport.call(
        extensionName,
        "extension.fetchResponseBodyClose",
        body.id,
      ).catch(() => {});
    }
  }

  private subscribe(ctx: ServiceContext, name: string, event: string): null {
    const eventName = `extensions:${name}::${event}` as const;
    const subscriber = this.deps.eventService.getOrCreateSubscriber(ctx);
    this.deps.eventService.subscribe(eventName, ctx.callerId, subscriber, ctx.connectionId);
    return null;
  }

  private emitFromExtension(ctx: ServiceContext, event: string, payload: unknown): null {
    if (ctx.callerKind !== "extension") {
      throw new ServiceError("extensions", "emit", "Only extensions can emit extension events", "EACCES");
    }
    this.deps.eventService.emit(`extensions:${ctx.callerId}::${event}` as EventName, payload);
    return null;
  }

  private async fetchRequestBodyChunk(ctx: ServiceContext, streamId: string): Promise<StreamChunkEnvelope> {
    if (ctx.callerKind !== "extension") {
      throw new ServiceError("extensions", "fetchRequestBodyChunk", "Only extensions can read extension fetch request bodies", "EACCES");
    }
    const stream = this.fetchRequestBodies.get(streamId);
    if (!stream || stream.extensionName !== ctx.callerId) {
      throw new ServiceError("extensions", "fetchRequestBodyChunk", `Unknown extension fetch request body stream: ${streamId}`, "ENOENT");
    }
    return readNextBodyChunk(stream);
  }

  private async fetchRequestBodyClose(ctx: ServiceContext, streamId: string): Promise<null> {
    if (ctx.callerKind !== "extension") {
      throw new ServiceError("extensions", "fetchRequestBodyClose", "Only extensions can close extension fetch request bodies", "EACCES");
    }
    const stream = this.fetchRequestBodies.get(streamId);
    if (!stream || stream.extensionName !== ctx.callerId) return null;
    await this.closeFetchRequestBody(streamId);
    return null;
  }

  private readyFromExtension(ctx: ServiceContext, ready: { methods: string[]; hasFetch: boolean }): null {
    if (ctx.callerKind !== "extension") {
      throw new ServiceError("extensions", "ready", "Only extensions can complete extension startup", "EACCES");
    }
    this.processes.markReady(ctx.callerId, ready);
    return null;
  }

  private healthFromExtension(ctx: ServiceContext, state: ExtensionHealth["state"], detail: unknown): null {
    if (ctx.callerKind !== "extension") {
      throw new ServiceError("extensions", "health", "Only extensions can report extension health", "EACCES");
    }
    const healthDetail = detail as { summary?: string; reasons?: string[]; retryAt?: number } | undefined;
    this.reportExtensionHealth(ctx.callerId, {
      state,
      summary: healthDetail?.summary ?? state,
      reasons: healthDetail?.reasons,
      retryAt: healthDetail?.retryAt,
      reportedAt: Date.now(),
    });
    return null;
  }

  private logFromExtension(
    ctx: ServiceContext,
    level: UnitLogRecord["level"],
    message: string,
    fields?: Record<string, unknown>,
  ): null {
    if (ctx.callerKind !== "extension") {
      throw new ServiceError("extensions", "log", "Only extensions can write extension logs", "EACCES");
    }
    this.recordExtensionLog(ctx.callerId, level, message, fields, "ctx.log");
    return null;
  }

  private async approvalForCallerFromExtension(
    ctx: ServiceContext,
    invocationValue: unknown,
    reqValue: unknown,
  ): Promise<unknown> {
    if (ctx.callerKind !== "extension") {
      throw new ServiceError("extensions", "approvalForCaller", "Only extensions can request caller approvals", "EACCES");
    }
    const invocation = invocationValue as ExtensionInvocation;
    if (!invocation || invocation.extensionName !== ctx.callerId) {
      throw new ServiceError("extensions", "approvalForCaller", "Extension approval invocation mismatch", "EACCES");
    }
    // Enforce the same schema validation the direct panel/worker path applies
    // in userlandApprovalService. Without this, an extension can inject
    // control chars, oversized fields, or reserved option values into the
    // shell's approval prompt.
    let parsed: UserlandApprovalRequest;
    try {
      parsed = userlandApprovalRequestSchema.parse(reqValue) as UserlandApprovalRequest;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ServiceError("extensions", "approvalForCaller", `Invalid approval request: ${message}`, "EINVAL");
    }
    return this.requestUserlandApprovalForCaller(invocation, parsed);
  }

  private async requestUserlandApprovalForCaller(
    invocation: ExtensionInvocation,
    reqValue: UserlandApprovalRequest,
  ): Promise<unknown> {
    if (!invocation.userlandCaller) {
      throw Object.assign(new Error("No userland caller available"), { code: "ENOCALLER" });
    }
    const issuer: UserlandApprovalIssuer = {
      kind: "extension",
      id: invocation.extensionName,
    };
    const req = decorateExtensionUserlandApproval(invocation.extensionName, reqValue);
    const grant = this.deps.userlandApprovalGrantStore.lookup(
      invocation.userlandCaller.callerId,
      req.subject.id,
      issuer,
    );
    if (grant && req.options.some((option) => option.value === grant.choice)) {
      return { kind: "choice", choice: grant.choice };
    }
    const result = await this.deps.approvalQueue.requestUserland({
      principal: invocation.userlandCaller,
      issuer,
      ...req,
    });
    if (result.kind === "choice") {
      await this.deps.userlandApprovalGrantStore.record(
        {
          callerId: invocation.userlandCaller.callerId,
          callerKind: invocation.userlandCaller.callerKind,
        },
        req.subject,
        result.choice,
        Date.now(),
        issuer,
      );
    }
    return result;
  }

  async install(ctx: ServiceContext, spec: InstallSpec): Promise<void> {
    const node = this.findExtensionNode(spec.source.repo);
    await this.requestManagementApproval(ctx, "install", node.name);
    const version = this.readNodeVersion(node.path);
    const ev = this.deps.buildSystem.getEffectiveVersion(node.name);
    if (!ev) throw new Error(`No effective version for extension ${node.name}`);
    const entry: RegistryEntry = {
      name: node.name,
      version,
      source: spec.source,
      installedAt: Date.now(),
      activeEv: null,
      activeSha: null,
      activeBundleKey: null,
      activeDependencyEvs: {},
      activeExternalDeps: {},
      activeRuntimeDepsKey: null,
      enabled: true,
      status: "building",
      lastError: null,
    };
    this.registry.upsert(entry);
    await this.buildAndActivate(node.name, spec.source.ref);
  }

  async uninstall(ctx: ServiceContext, name: string, opts?: { purge?: boolean }): Promise<void> {
    await this.requestManagementApproval(ctx, "uninstall", name);
    await this.processes.stop(name);
    this.registry.delete(name);
    if (opts?.purge) {
      const storageDir = this.storageDirFor(name);
      await import("node:fs/promises").then((fs) => fs.rm(storageDir, { recursive: true, force: true }));
    }
  }

  async setEnabled(ctx: ServiceContext, name: string, enabled: boolean): Promise<void> {
    await this.requestManagementApproval(ctx, enabled ? "enable" : "disable", name);
    if (!enabled) {
      this.registry.patch(name, { enabled: false, status: "stopped" });
      await this.processes.stop(name);
      return;
    }

    const entry = this.registry.get(name);
    if (!entry?.activeBundleKey) {
      await this.buildAndActivate(name, entry?.source.ref);
      return;
    }

    this.registry.patch(name, { enabled: true, status: "stopped" });
    await this.activate(name);
  }

  async update(ctx: ServiceContext, name: string): Promise<void> {
    const entry = this.registry.get(name);
    if (!entry) throw new Error(`Extension is not installed: ${name}`);
    const node = this.findExtensionNode(name);
    const currentEv = this.deps.buildSystem.getEffectiveVersion(node.name);
    const currentDependencyEvs = this.currentDependencyEvs(node);
    const currentExternalDeps = this.currentExternalDeps(node);
    if (
      currentEv
      && entry.activeEv === currentEv
      && shallowRecordEqual(entry.activeDependencyEvs, currentDependencyEvs)
      && shallowRecordEqual(entry.activeExternalDeps ?? {}, currentExternalDeps)
      && (Object.keys(currentExternalDeps).length === 0 || entry.activeRuntimeDepsKey)
      && this.hasCurrentExtensionRuntimeAbi(entry)
    ) {
      return;
    }
    await this.requestManagementApproval(ctx, "update", name);
    await this.buildAndActivate(name, entry.source.ref);
  }

  async reload(ctx: ServiceContext, name: string): Promise<void> {
    await this.requestManagementApproval(ctx, "reload", name);
    await this.activate(name);
  }

  listWorkspaceUnits(): Array<{
    name: string;
    kind: "extension";
    source: string;
    displayName: string;
    enabled: boolean;
    status: RegistryEntry["status"];
    version: string;
    ev: string | null;
    activeEv: string | null;
    activeBundleKey: string | null;
    activeRuntimeDepsKey: string | null;
    lastError: string | null;
    health: unknown;
    methods: string[];
    hasFetch: boolean;
    respawn: { attempts: number; nextAttemptAt: number | null } | null;
    inspectorUrl: string | null;
  }> {
    const runningByName = new Map(this.processes.listRunning().map((entry) => [entry.name, entry]));
    return this.registry.list().map((entry) => {
      const node = this.findExtensionNode(entry.name);
      const running = runningByName.get(entry.name);
      return {
        name: entry.name,
        kind: "extension",
        source: node.relativePath,
        displayName: node.manifest.displayName ?? entry.name,
        enabled: entry.enabled,
        status: entry.status,
        version: entry.version,
        ev: entry.activeEv,
        activeEv: entry.activeEv,
        activeBundleKey: entry.activeBundleKey,
        activeRuntimeDepsKey: entry.activeRuntimeDepsKey,
        lastError: entry.lastError,
        health: running?.health ?? this.health.get(entry.name) ?? null,
        methods: running?.methods ?? [],
        hasFetch: running?.hasFetch ?? false,
        respawn: this.processes.getRespawn(entry.name),
        inspectorUrl: running?.inspectorUrl ?? this.inspectorUrls.get(entry.name) ?? null,
      };
    });
  }

  listWorkspaceUnitLogs(
    name: string,
    opts?: { since?: number; level?: "debug" | "info" | "warn" | "error"; limit?: number },
  ): UnitLogRecord[] {
    const logs = this.unitLogs.get(name) ?? [];
    const minLevel = opts?.level ? LOG_LEVEL_RANK[opts.level] : null;
    const filtered = logs.filter((record) =>
      (opts?.since === undefined || record.timestamp >= opts.since)
      && (minLevel === null || LOG_LEVEL_RANK[record.level] >= minLevel)
    );
    const limit = opts?.limit && opts.limit > 0 ? Math.min(Math.floor(opts.limit), 1000) : 200;
    return filtered.slice(-limit);
  }

  async authorizeSourcePush(request: {
    callerId: string;
    callerKind: string;
    repoPath: string;
    branch: string;
    commit: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const repoPath = normalizeRepoPath(request.repoPath);
    const installed = this.findInstalledExtensionByRepo(repoPath);
    if (!installed) return { allowed: true };
    if (request.branch !== "main" && request.branch !== "master") return { allowed: true };

    // Trusted internal callers (CLI, server bootstrap) bypass the prompt.
    // The approval is meant to capture an interactive decision; shell/server
    // pushes are already authorized by their callerKind.
    if (request.callerKind === "shell" || request.callerKind === "server") {
      return { allowed: true };
    }

    const sessionGrantKey = extensionPushSessionGrantKey(installed.entry.name, repoPath, request.branch);
    if (this.sourcePushGrants.hasActive(sessionGrantKey)) {
      return { allowed: true };
    }

    if (request.callerKind !== "panel" && request.callerKind !== "worker") {
      return {
        allowed: false,
        reason: `Extension source pushes from ${request.callerKind} callers are not supported`,
      };
    }
    const identity = this.deps.codeIdentityResolver.resolveByCallerId(request.callerId);
    if (!identity || identity.callerKind !== request.callerKind) {
      return { allowed: false, reason: `Unknown caller identity: ${request.callerId}` };
    }
    const decision = await this.deps.approvalQueue.request({
      kind: "extension",
      callerId: request.callerId,
      callerKind: request.callerKind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      action: "source-push",
      extensionName: installed.entry.name,
      version: installed.entry.version,
      source: installed.entry.source,
      dedupKey: `extension-source-push:${installed.entry.name}:${request.branch}`,
      title: `${installed.entry.name} source push`,
      description: "Accepting this push updates trusted native extension code.",
      previousEv: installed.entry.activeEv,
      previousSha: installed.entry.activeSha,
      sha: request.commit,
      activeDependencyEvs: installed.entry.activeDependencyEvs,
      activeRuntimeDepsKey: installed.entry.activeRuntimeDepsKey,
      extensionDiff: makeExtensionDiff(repoPath, installed.entry.activeSha, request.commit, {
        ref: request.branch,
        pushedAt: Date.now(),
        pushedBy: identity.callerId,
      }),
      capabilities: extensionRuntimeCapabilities(),
      details: [
        { label: "Repository", value: repoPath },
        { label: "Branch", value: request.branch },
        { label: "Commit", value: request.commit },
      ],
    });
    if (decision === "deny") {
      return { allowed: false, reason: "Extension source push denied" };
    }
    if (decision === "session") {
      this.sourcePushGrants.grant(sessionGrantKey, EXTENSION_DEV_SESSION_TTL_MS);
    }
    return { allowed: true };
  }

  async activate(name: string): Promise<void> {
    const entry = this.registry.get(name);
    if (!entry?.activeBundleKey) throw new Error(`Extension has no active approved build: ${name}`);
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    if (!build) {
      throw new Error(`Approved extension build is missing from build store: ${entry.activeBundleKey}`);
    }
    const token = this.deps.tokenManager.ensureToken(name, "extension");
    this.registry.patch(name, { status: "building", lastError: null });
    await this.processes.start({
      name,
      version: entry.version,
      bundlePath: build.bundlePath,
      storageDir: this.storageDirFor(name),
      gatewayUrl: this.deps.getGatewayUrl(),
      rpcToken: token,
    });
  }

  private async buildAndActivate(name: string, ref?: string): Promise<void> {
    const node = this.findExtensionNode(name);
    const previous = this.registry.get(node.name);
    this.registry.patch(node.name, { status: "building", lastError: null });
    const build = await this.deps.buildSystem.getBuild(node.name, ref);
    const activeDependencyEvs = this.currentDependencyEvs(node);
    const activeExternalDeps = this.currentExternalDeps(node);
    this.registry.patch(node.name, {
      activeEv: build.metadata.ev,
      activeSha: resolveGitCommit(node.path, ref),
      activeBundleKey: path.basename(build.dir),
      activeDependencyEvs,
      activeExternalDeps,
      activeRuntimeDepsKey: build.metadata.runtimeDepsKey ?? null,
      enabled: true,
      lastError: null,
    });
    try {
      await this.activate(node.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (previous?.activeBundleKey) {
        this.registry.patch(node.name, {
          activeEv: previous.activeEv,
          activeSha: previous.activeSha,
          activeBundleKey: previous.activeBundleKey,
          activeDependencyEvs: previous.activeDependencyEvs,
          activeExternalDeps: previous.activeExternalDeps ?? {},
          activeRuntimeDepsKey: previous.activeRuntimeDepsKey,
          enabled: previous.enabled,
          status: "error",
          lastError: message,
        });
        if (previous.enabled) {
          try {
            await this.activate(node.name);
          } catch (rollbackErr) {
            this.registry.patch(node.name, {
              status: "error",
              lastError: `Activation failed: ${message}; rollback failed: ${
                rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
              }`,
            });
          }
        }
      } else {
        this.registry.patch(node.name, {
          activeEv: previous?.activeEv ?? null,
          activeSha: previous?.activeSha ?? null,
          activeBundleKey: previous?.activeBundleKey ?? null,
          activeDependencyEvs: previous?.activeDependencyEvs ?? {},
          activeExternalDeps: previous?.activeExternalDeps ?? {},
          activeRuntimeDepsKey: previous?.activeRuntimeDepsKey ?? null,
          enabled: previous?.enabled ?? true,
          status: "error",
          lastError: message,
        });
      }
      throw err;
    }
  }

  private async handleSourceRebuilt(source: string): Promise<void> {
    const installed = this.findInstalledExtensionByRepo(source);
    if (!installed?.entry.enabled) return;
    try {
      await this.buildAndActivate(installed.entry.name, installed.entry.source.ref);
    } catch (err) {
      this.registry.patch(installed.entry.name, {
        status: "error",
        lastError: err instanceof Error ? err.message : String(err),
      });
      this.deps.eventService.emit("extensions:error", {
        name: installed.entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private findInstalledExtensionByRepo(repoPath: string):
    | { entry: RegistryEntry; node: ReturnType<ExtensionHost["findExtensionNode"]> }
    | null {
    const normalizedRepo = normalizeRepoPath(repoPath);
    for (const entry of this.registry.list()) {
      let node: ReturnType<ExtensionHost["findExtensionNode"]>;
      try {
        node = this.findExtensionNode(entry.name);
      } catch {
        continue;
      }
      const sourceRepo = normalizeRepoPath(entry.source.repo);
      const relativePath = normalizeRepoPath(node.relativePath);
      if (sourceRepo === normalizedRepo || relativePath === normalizedRepo) {
        return { entry, node };
      }
    }
    return null;
  }

  private currentDependencyEvs(node: ReturnType<ExtensionHost["findExtensionNode"]>): Record<string, string> {
    const activeDependencyEvs: Record<string, string> = {};
    const byName = new Map(this.deps.buildSystem.getGraph().allNodes().map((graphNode) => [graphNode.name, graphNode]));
    const visited = new Set<string>();

    const visit = (depName: string): void => {
      if (visited.has(depName)) return;
      visited.add(depName);
      const depEv = this.deps.buildSystem.getEffectiveVersion(depName);
      if (depEv) activeDependencyEvs[depName] = depEv;
      const depNode = byName.get(depName);
      if (!depNode) return;
      for (const transitive of depNode.internalDeps) visit(transitive);
    };

    for (const dep of node.internalDeps) {
      visit(dep);
    }
    return activeDependencyEvs;
  }

  private currentExternalDeps(node: ReturnType<ExtensionHost["findExtensionNode"]>): Record<string, string> {
    return this.deps.buildSystem.getExternalDeps(node.name);
  }

  private needsBuildRefresh(
    entry: RegistryEntry,
    node: ReturnType<ExtensionHost["findExtensionNode"]>,
  ): boolean {
    const currentEv = this.deps.buildSystem.getEffectiveVersion(node.name);
    if (currentEv && entry.activeEv !== currentEv) return true;
    if (!shallowRecordEqual(entry.activeDependencyEvs, this.currentDependencyEvs(node))) return true;
    const currentExternalDeps = this.currentExternalDeps(node);
    if (!shallowRecordEqual(entry.activeExternalDeps ?? {}, currentExternalDeps)) return true;
    if (!this.hasCurrentExtensionRuntimeAbi(entry)) return true;
    return Object.keys(currentExternalDeps).length > 0 && !this.hasUsableActiveRuntimeDeps(entry);
  }

  private hasCurrentExtensionRuntimeAbi(entry: RegistryEntry): boolean {
    if (!entry.activeBundleKey) return false;
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    return build?.metadata.extensionRuntimeAbi === EXTENSION_RUNTIME_ABI_VERSION;
  }

  private hasUsableActiveRuntimeDeps(entry: RegistryEntry): boolean {
    if (!entry.activeBundleKey || !entry.activeRuntimeDepsKey) return false;
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    if (!build) return false;
    const externalDeps = build.metadata.extensionExternalDeps ?? {};
    if (Object.keys(externalDeps).length === 0) return true;
    return fs.existsSync(path.join(build.dir, "node_modules"));
  }

  private findExtensionNode(nameOrRepo: string) {
    const normalizedRepo = nameOrRepo.replace(/^workspace\//, "");
    const node = this.deps.buildSystem.getGraph().allNodes().find((candidate) =>
      candidate.kind === "extension"
      && (candidate.name === nameOrRepo || candidate.relativePath === normalizedRepo || candidate.relativePath === nameOrRepo)
    );
    if (!node) throw new Error(`Unknown extension unit: ${nameOrRepo}`);
    const events = node.manifest.extension?.activationEvents ?? ["*"];
    if (events.some((event) => event !== "*")) {
      throw new Error(`Extension ${node.name} only supports eager activation in v1`);
    }
    return node;
  }

  private storageDirFor(name: string): string {
    return path.join(this.deps.statePath, "extensions", "storage", this.deps.workspaceId, encodeURIComponent(name));
  }

  private readNodeVersion(nodePath: string): string {
    const pkg = JSON.parse(fs.readFileSync(path.join(nodePath, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  }

  private async requestManagementApproval(
    ctx: ServiceContext,
    action: "install" | "uninstall" | "enable" | "disable" | "update" | "reload",
    name: string,
  ): Promise<void> {
    // Trusted internal callers (CLI shell) are pre-authorized and skip the
    // user prompt. Panels and workers always go through approval. Other
    // caller kinds (e.g., `extension`) are rejected — extensions cannot
    // self-install other extensions in v1. `server` is not in the
    // dispatcher's allow list for `extensions`, so it never reaches here.
    if (ctx.callerKind === "shell") return;
    if (ctx.callerKind !== "panel" && ctx.callerKind !== "worker") {
      throw new ServiceError(
        "extensions",
        action,
        `Extension management is not available to ${ctx.callerKind} callers`,
        "EACCES",
      );
    }
    const identity = this.deps.codeIdentityResolver.resolveByCallerId(ctx.callerId);
    if (!identity || identity.callerKind !== ctx.callerKind) {
      throw new ServiceError("extensions", action, `Unknown caller identity: ${ctx.callerId}`, "ENOENT");
    }
    const node = this.findExtensionNode(name);
    const entry = this.registry.get(node.name);
    const approvalAction = extensionManagementAction(action);
    const currentEv = this.deps.buildSystem.getEffectiveVersion(node.name);
    const candidateDependencyEvs = this.currentDependencyEvs(node);
    const candidateExternalDeps = this.currentExternalDeps(node);
    const workspaceDepChanges = dependencyEvChanges(entry?.activeDependencyEvs ?? {}, candidateDependencyEvs);
    const externalDepChanges = externalDependencyChanges(entry?.activeExternalDeps ?? {}, candidateExternalDeps);
    const source = entry?.source ?? {
      kind: "internal-git" as const,
      repo: node.relativePath,
      ref: "HEAD",
    };
    const version = entry?.version ?? this.readNodeVersion(node.path);
    const details = [
      { label: "Action", value: action },
      { label: "Extension", value: node.name },
      { label: "Source", value: `${source.repo}@${source.ref}` },
    ];
    if (entry?.activeEv) details.push({ label: "Current EV", value: entry.activeEv });
    if (currentEv) details.push({ label: "Candidate EV", value: currentEv });
    const decision = await this.deps.approvalQueue.request({
      kind: "extension",
      callerId: ctx.callerId,
      callerKind: ctx.callerKind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      action: approvalAction,
      extensionName: node.name,
      version,
      source,
      title: `${actionTitle(action)} extension`,
      description: `Allow ${ctx.callerKind} ${ctx.callerId} to ${action} ${name}.`,
      ev: currentEv,
      previousEv: entry?.activeEv,
      previousSha: entry?.activeSha,
      activeDependencyEvs: entry?.activeDependencyEvs,
      candidateDependencyEvs,
      activeRuntimeDepsKey: entry?.activeRuntimeDepsKey,
      candidateRuntimeDepsKey: null,
      extensionDiff: null,
      workspaceDepChanges,
      externalDepChanges,
      integrity: null,
      capabilities: extensionRuntimeCapabilities(),
      details,
    });
    if (decision === "deny") {
      throw new ServiceError("extensions", action, "Extension management approval denied", "EACCES");
    }
  }

  private recordUnitLog(record: UnitLogRecord): void {
    const logs = this.unitLogs.get(record.unitName) ?? [];
    logs.push(record);
    if (logs.length > 1000) logs.splice(0, logs.length - 1000);
    this.unitLogs.set(record.unitName, logs);
  }

  private reportExtensionHealth(name: string, health: ExtensionHealth): void {
    this.health.set(name, health);
    this.deps.eventService.emit("extensions:health", { name, health });
  }

  private recordExtensionLog(
    name: string,
    level: UnitLogRecord["level"],
    message: string,
    fields?: Record<string, unknown>,
    source: UnitLogRecord["source"] = "ctx.log",
  ): void {
    const record: UnitLogRecord = {
      workspaceId: this.deps.workspaceId,
      unitName: name,
      kind: "extension",
      timestamp: Date.now(),
      level,
      message,
      fields,
      source,
    };
    this.recordUnitLog(record);
    this.deps.eventService.emit("workspace:unit-log", record);
  }

}

interface UnitLogRecord {
  workspaceId: string;
  unitName: string;
  kind: "extension";
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields?: Record<string, unknown>;
  source?: "stdout" | "stderr" | "ctx.log" | "console";
}

const LOG_LEVEL_RANK = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

const installSpecSchema = z.object({
  source: z.object({
    kind: z.literal("internal-git"),
    repo: z.string().min(1),
    ref: z.string().min(1).default("main"),
  }),
}).strict();

function headersToRecord(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

interface FetchRequestBodyStream {
  extensionName: string;
  iterator: AsyncIterator<unknown>;
  pending: Buffer | null;
  offset: number;
  bytesRead: number;
}

const STREAM_CHUNK_BYTES = 64 * 1024;
const EXTENSION_REQUEST_BODY_MAX_BYTES = 32 * 1024 * 1024;

function bufferToChunk(buf: Buffer): StreamChunkEnvelope {
  return { done: false, chunk: { __bin: true, data: buf.toString("base64") } };
}

async function readNextBodyChunk(stream: FetchRequestBodyStream): Promise<StreamChunkEnvelope> {
  if (stream.pending && stream.offset < stream.pending.length) {
    const nextOffset = Math.min(stream.offset + STREAM_CHUNK_BYTES, stream.pending.length);
    const chunk = stream.pending.subarray(stream.offset, nextOffset);
    stream.offset = nextOffset;
    if (stream.offset >= stream.pending.length) {
      stream.pending = null;
      stream.offset = 0;
    }
    return bufferToChunk(chunk);
  }

  const next = await stream.iterator.next();
  if (next.done) return { done: true };
  const buf = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value as ArrayBufferLike);
  stream.bytesRead += buf.length;
  if (stream.bytesRead > EXTENSION_REQUEST_BODY_MAX_BYTES) {
    try {
      await stream.iterator.return?.();
    } catch {
      // Best-effort: caller already saw the failure.
    }
    const err = new Error(
      `Request body exceeds the ${EXTENSION_REQUEST_BODY_MAX_BYTES}-byte extension fetch limit`,
    );
    (err as NodeJS.ErrnoException).code = "EFBIG";
    throw err;
  }
  if (buf.length <= STREAM_CHUNK_BYTES) return bufferToChunk(buf);
  stream.pending = buf;
  stream.offset = 0;
  return readNextBodyChunk(stream);
}

function waitForResponseFinish(res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    res.once("finish", resolve);
    res.once("error", reject);
  });
}

async function writeResponseChunk(res: ServerResponse, chunk: Buffer): Promise<void> {
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    res.once("drain", resolve);
    res.once("error", reject);
  });
}

async function writeInlineResponseBody(res: ServerResponse, body: BinaryEnvelope | string): Promise<void> {
  if (typeof body === "string") {
    res.end(body);
    return;
  }
  if (isBinaryEnvelope(body)) {
    res.end(Buffer.from(body.data, "base64"));
    return;
  }
  res.end();
}

function normalizeRepoPath(repoPath: string): string {
  return repoPath
    .replace(/^workspace\//, "")
    .replace(/^\/+/, "")
    .replace(/\.git(\/.*)?$/, "")
    .replace(/\/+$/, "");
}

function decorateExtensionUserlandApproval(
  extensionName: string,
  req: UserlandApprovalRequest,
): UserlandApprovalRequest {
  // Subject id is left as-is — issuer namespacing now lives on the structured
  // issuer field (carried through the approval queue and grant store). The
  // "Extension" detail is still added as a UI affordance for the prompt.
  return {
    ...req,
    details: [
      { label: "Extension", value: extensionName },
      ...(req.details ?? []),
    ].slice(0, 8),
  };
}

const EXTENSION_DEV_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

function extensionPushSessionGrantKey(extensionName: string, repoPath: string, branch: string): string {
  return `${extensionName}\x00${repoPath}\x00${branch}`;
}

function extensionManagementAction(
  action: "install" | "uninstall" | "enable" | "disable" | "update" | "reload",
): PendingExtensionApprovalAction {
  return action === "enable" || action === "disable" ? "toggle" : action;
}

function actionTitle(action: "install" | "uninstall" | "enable" | "disable" | "update" | "reload"): string {
  return `${action[0]!.toUpperCase()}${action.slice(1)}`;
}

function extensionRuntimeCapabilities(): string[] {
  return ["node:fs", "node:child_process", "node:net", "node:process", "userland:*"];
}

function resolveGitCommit(repoPath: string, ref = "HEAD"): string | null {
  try {
    return String(execGitFileSync(["rev-parse", "--verify", "--end-of-options", ref], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })).trim() || null;
  } catch {
    return null;
  }
}

function dependencyEvChanges(
  active: Record<string, string>,
  candidate: Record<string, string>,
): NonNullable<PendingExtensionApproval["workspaceDepChanges"]> {
  const names = [...new Set([...Object.keys(active), ...Object.keys(candidate)])].sort();
  return names
    .filter((name) => active[name] !== candidate[name])
    .map((name) => ({
      name,
      fromEv: active[name] ?? null,
      toEv: candidate[name] ?? null,
    }));
}

function externalDependencyChanges(
  active: Record<string, string>,
  candidate: Record<string, string>,
): NonNullable<PendingExtensionApproval["externalDepChanges"]> {
  const names = [...new Set([...Object.keys(active), ...Object.keys(candidate)])].sort();
  return names
    .filter((name) => active[name] !== candidate[name])
    .map((name) => ({
      name,
      fromVersion: active[name] ?? null,
      toVersion: candidate[name] ?? null,
    }));
}

function makeExtensionDiff(
  repoPath: string,
  previousSha: string | null | undefined,
  sha: string | null | undefined,
  push?: PendingExtensionApproval["extensionDiff"] extends infer Diff
    ? Diff extends { push?: infer Push } ? Push : never
    : never,
): PendingExtensionApproval["extensionDiff"] {
  const resolvedSha = sha ? resolveGitCommit(repoPath, sha) ?? sha : null;
  return {
    sha: resolvedSha,
    previousSha: previousSha ?? null,
    stat: readGitDiffStat(repoPath, previousSha ?? null, resolvedSha),
    commit: readGitCommit(repoPath, resolvedSha),
    push: push ?? null,
  };
}

function readGitDiffStat(
  repoPath: string,
  previousSha: string | null,
  sha: string | null,
): PendingExtensionApproval["extensionDiff"] extends infer Diff
  ? Diff extends { stat?: infer Stat } ? Stat : never
  : never {
  if (!previousSha || !sha) return null;
  try {
    const output = String(execGitFileSync(["diff", "--shortstat", "--end-of-options", previousSha, sha], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })).trim();
    if (!output) return { filesChanged: 0, insertions: 0, deletions: 0 };
    return {
      filesChanged: parseGitStatPart(output, /(\d+) files? changed/),
      insertions: parseGitStatPart(output, /(\d+) insertions?\(\+\)/),
      deletions: parseGitStatPart(output, /(\d+) deletions?\(-\)/),
    };
  } catch {
    return null;
  }
}

function readGitCommit(
  repoPath: string,
  sha: string | null,
): PendingExtensionApproval["extensionDiff"] extends infer Diff
  ? Diff extends { commit?: infer Commit } ? Commit : never
  : never {
  if (!sha) return null;
  try {
    const output = String(execGitFileSync([
      "show",
      "-s",
      "--format=%an%x00%ae%x00%cn%x00%ce%x00%ct%x00%B",
      "--end-of-options",
      sha,
    ], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
    const [authorName, authorEmail, committerName, committerEmail, timestamp, ...messageParts] = output.split("\0");
    return {
      author: { name: authorName ?? "", email: authorEmail ?? "" },
      committer: { name: committerName ?? "", email: committerEmail ?? "" },
      message: messageParts.join("\0").trim(),
      timestamp: Number(timestamp) || 0,
    };
  } catch {
    return null;
  }
}

function parseGitStatPart(input: string, pattern: RegExp): number {
  const match = input.match(pattern);
  return match ? Number(match[1]) || 0 : 0;
}

function shallowRecordEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

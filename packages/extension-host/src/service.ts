import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import {
  ServiceError,
  type ServiceContext,
  type VerifiedCaller,
} from "@natstack/shared/serviceDispatcher";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { EventName } from "@natstack/shared/events";
import type { NotificationPayload } from "@natstack/shared/events";
import type { EventService, Subscriber } from "@natstack/shared/eventsService";
import { EXTENSION_RUNTIME_ABI_VERSION } from "@natstack/shared/extensionRuntimeAbi";
import type {
  ExtensionBatchEntry,
  PendingExtensionApproval,
  PendingExtensionApprovalAction,
  PendingExtensionBatchApproval,
} from "@natstack/shared/approvals";
import {
  ExtensionManifestError,
  readAndValidateExtensionManifest,
} from "@natstack/shared/extensionManifest";
import { execGitFileSync } from "@natstack/shared/gitRuntime";
import YAML from "yaml";

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
  ExtensionHealth,
  ExtensionInvocation,
  ExtensionUserlandCaller,
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
      manifest: { displayName?: string; extension?: { activationEvents?: string[]; streamingMethods?: string[] } };
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
  streamCallTarget?(name: string, method: string, ...args: unknown[]): Promise<Response>;
}

interface ApprovalQueueLike {
  request(req: ({
    kind: "capability";
    callerId: string;
    callerKind: "panel" | "worker" | "do";
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
    callerKind: "panel" | "worker" | "do";
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
  } | {
    kind: "extension-batch";
    callerId: string;
    callerKind: "panel" | "worker" | "do" | "system";
    repoPath: string;
    effectiveVersion: string;
    dedupKey?: string | null;
    trigger: "startup" | "meta-push";
    title: string;
    description: string;
    extensions: PendingExtensionBatchApproval["extensions"];
    configWrite?: PendingExtensionBatchApproval["configWrite"];
  })): Promise<"once" | "session" | "version" | "repo" | "deny">;
}

interface NotificationServiceLike {
  show(notification: Omit<NotificationPayload, "id"> & { id?: string }): string;
}

export interface ExtensionHostDeps {
  statePath: string;
  workspacePath: string;
  workspaceId: string;
  buildSystem: BuildSystemLike;
  tokenManager: TokenManager;
  eventService: EventService;
  approvalQueue: ApprovalQueueLike;
  notificationService?: NotificationServiceLike;
  getContextIdForCaller?: (callerId: string) => string | null;
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
  private activeInvocations = new Map<string, ExtensionInvocation>();
  private readonly sourcePushGrants: SourcePushGrantStore;
  // Single in-flight reconcile guard (meta-push uses queueMicrotask, so two
  // pushes can overlap).
  private reconciling: Promise<void> | null = null;
  // Background joint-approval flows (startup). Chained so boot never blocks on
  // a user decision; awaitable via whenSettled() for tests/diagnostics.
  private backgroundFlow: Promise<void> = Promise.resolve();
  // Set by the meta-push combined approval (§4): the exact extension
  // declarations the user just trusted as part of an accepted meta push,
  // consumed by the immediately following reconcile so it activates them
  // without a second prompt.
  private pendingMetaApproval: { commit: string; declarationKeys: Set<string> } | null = null;

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

  /**
   * Reconcile the registry against the declared extension set from
   * `meta/natstack.yml`. This is the single entry point that installs, enables,
   * disables, or removes extensions — there is no imperative path. Called at
   * boot and after a meta push (post-receive). The declared set is
   * authoritative: anything in the registry but not declared is removed.
   */
  async reconcileDeclared(
    declared: Array<{ source: string; ref: string; enabled: boolean }>,
  ): Promise<void> {
    // Serialize overlapping reconciles (two meta pushes in quick succession).
    const run = (this.reconciling ?? Promise.resolve()).then(() =>
      this.reconcileDeclaredOnce(declared),
    );
    this.reconciling = run.catch(() => {});
    await run;
  }

  /**
   * Test/diagnostic hook: resolves once the synchronous reconcile AND any
   * background joint-approval flow it kicked off have settled.
   */
  async whenSettled(): Promise<void> {
    await this.reconciling;
    await this.backgroundFlow;
  }

  private async reconcileDeclaredOnce(
    declared: Array<{ source: string; ref: string; enabled: boolean }>,
  ): Promise<void> {
    const metaRepoDir = path.join(this.deps.workspacePath, "meta");
    const metaHead = resolveGitCommit(metaRepoDir, "HEAD");
    const preApproved =
      this.pendingMetaApproval && metaHead === this.pendingMetaApproval.commit
        ? this.pendingMetaApproval.declarationKeys
        : new Set<string>();
    this.pendingMetaApproval = null;

    const resolved: Array<{ decl: { ref: string; enabled: boolean }; node: ReturnType<ExtensionHost["findExtensionNode"]> }> = [];
    const unresolved: string[] = [];
    for (const decl of declared) {
      try {
        resolved.push({ decl, node: this.findExtensionNode(decl.source) });
      } catch {
        unresolved.push(decl.source);
      }
    }
    if (unresolved.length > 0) {
      this.deps.notificationService?.show({
        id: `extensions-unresolved-${encodeURIComponent(unresolved.join(","))}`,
        type: "error",
        title: "Unknown extensions declared",
        message: `meta/natstack.yml declares extensions that don't exist: ${unresolved.join(", ")}.`,
      });
    }

    const declaredByName = new Map(resolved.map((r) => [r.node.name, r]));

    // Build/start the already-approved and the meta-push-pre-approved set now
    // (awaited); collect the genuinely-unapproved for a background prompt so
    // boot never blocks on a user decision.
    const needsApproval: Array<{ node: ReturnType<ExtensionHost["findExtensionNode"]>; decl: { ref: string; enabled: boolean } }> = [];
    for (const { node, decl } of resolved) {
      const entry = this.registry.get(node.name);
      const isApproved = this.isApprovedForDeclaration(entry, node, decl.ref);
      const declarationKey = this.declarationTrustKey(node, decl.ref);
      if (isApproved || preApproved.has(declarationKey)) {
        await this.applyDeclared(node, decl);
      } else if (decl.enabled) {
        if (!entry) this.registry.upsert(this.pendingEntryFor(node, decl));
        needsApproval.push({ node, decl });
      } else {
        // Declared but disabled and unapproved — register, do not prompt.
        if (!entry) this.registry.upsert(this.pendingEntryFor(node, decl));
        if (this.processes.isRunning(node.name)) await this.processes.stop(node.name);
      }
    }

    // Removal pass: anything in the registry but no longer declared is stopped
    // and removed (storage retained). The meta edit was the gate; no prompt.
    for (const entry of this.registry.list()) {
      if (declaredByName.has(entry.name)) continue;
      try {
        await this.processes.stop(entry.name);
      } catch {
        // best-effort
      }
      this.registry.delete(entry.name);
      this.deps.eventService.emit("extensions:status", {
        name: entry.name,
        status: "stopped",
        error: null,
      });
    }

    if (needsApproval.length > 0) {
      // Boot must not block on the user. Present the joint approval in the
      // background and build/activate each extension once granted.
      this.backgroundFlow = this.backgroundFlow
        .then(() => this.promptAndActivate(needsApproval))
        .catch((err) => {
          console.error(
            "[ExtensionHost] Background extension approval flow failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
    }
  }

  private async promptAndActivate(
    needsApproval: Array<{ node: ReturnType<ExtensionHost["findExtensionNode"]>; decl: { ref: string; enabled: boolean } }>,
  ): Promise<void> {
    const decision = await this.requestBatchApproval(
      needsApproval.map(({ node, decl }) => this.buildBatchEntry(node, decl.ref)),
      "startup",
    );
    if (decision === "deny") {
      const names = needsApproval.map((p) => p.node.name);
      for (const name of names) {
        this.deps.eventService.emit("extensions:status", { name, status: "pending-approval", error: null });
      }
      this.deps.notificationService?.show({
        id: `extensions-pending-approval-${names.join(",")}`,
        type: "info",
        title: "Extensions need approval",
        message: `${names.join(", ")} ${names.length === 1 ? "is" : "are"} declared but not approved. They will be offered again on next startup or when meta is edited.`,
      });
      return;
    }
    for (const { node, decl } of needsApproval) {
      await this.applyDeclared(node, decl);
    }
  }

  /** Build/start (or stop) a single declared extension per its declaration. */
  private async applyDeclared(
    node: ReturnType<ExtensionHost["findExtensionNode"]>,
    decl: { ref: string; enabled: boolean },
  ): Promise<void> {
    try {
      const entry = this.registry.get(node.name);
      if (!decl.enabled) {
        if (this.processes.isRunning(node.name)) await this.processes.stop(node.name);
        if (entry) {
          const patch: Partial<RegistryEntry> = {
            enabled: false,
            status: "stopped",
            lastError: null,
          };
          if (!this.entrySourceMatches(entry, node, decl.ref)) {
            Object.assign(patch, {
              source: { kind: "internal-git" as const, repo: node.relativePath, ref: decl.ref },
              activeEv: null,
              activeSha: null,
              activeBundleKey: null,
              activeDependencyEvs: {},
              activeExternalDeps: {},
              activeRuntimeDepsKey: null,
            });
          }
          this.registry.patch(node.name, patch);
        } else {
          this.registry.upsert(this.pendingEntryFor(node, decl));
        }
        return;
      }
      const isApproved = this.isApprovedForDeclaration(entry, node, decl.ref);
      if (!isApproved) {
        if (!entry) this.registry.upsert(this.pendingEntryFor(node, decl, true));
        await this.buildAndActivate(node.name, decl.ref);
        return;
      }
      // Already approved: fail-closed manifest validation, then (re)start.
      this.validateExtensionManifestAtPath(node.path, node.name);
      if (this.needsBuildRefresh(entry, node)) {
        await this.buildAndActivate(node.name, decl.ref);
      } else {
        await this.activate(node.name);
      }
    } catch (err) {
      this.registry.patch(node.name, {
        status: "error",
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private pendingEntryFor(
    node: ReturnType<ExtensionHost["findExtensionNode"]>,
    decl: { ref: string; enabled: boolean },
    building = false,
  ): RegistryEntry {
    return {
      name: node.name,
      version: this.readNodeVersion(node.path),
      source: { kind: "internal-git", repo: node.relativePath, ref: decl.ref },
      installedAt: Date.now(),
      activeEv: null,
      activeSha: null,
      activeBundleKey: null,
      activeDependencyEvs: {},
      activeExternalDeps: {},
      activeRuntimeDepsKey: null,
      enabled: decl.enabled,
      status: building ? "building" : decl.enabled ? "pending-approval" : "stopped",
      lastError: null,
    };
  }

  private validateExtensionManifestAtPath(nodePath: string, unitName: string): void {
    try {
      readAndValidateExtensionManifest(
        path.join(nodePath, "package.json"),
        { unitName },
        fs.readFileSync as (p: string, encoding: "utf-8") => string,
      );
    } catch (err) {
      if (err instanceof ExtensionManifestError) throw err;
      throw new ExtensionManifestError(
        `Extension ${unitName} manifest validation failed: ${err instanceof Error ? err.message : String(err)}`,
        "MANIFEST_INTERNAL",
      );
    }
  }

  async shutdown(): Promise<void> {
    await this.processes.shutdown();
  }

  createServiceDefinition(): ServiceDefinition {
    return {
      name: "extensions",
      description: "Installed extension management and invocation",
      policy: { allowed: ["panel", "worker", "do", "shell", "extension"] },
      methods: {
        invoke: { args: z.tuple([z.string(), z.string(), z.array(z.unknown())]) },
        invokeStream: { args: z.tuple([z.string(), z.string(), z.array(z.unknown())]) },
        streamingMethods: { args: z.tuple([z.string()]) },
        list: { args: z.tuple([]) },
        on: { args: z.tuple([z.string(), z.string()]) },
        ready: { args: z.tuple([z.object({ methods: z.array(z.string()), hasFetch: z.boolean() })]) },
        emit: { args: z.tuple([z.string(), z.unknown()]) },
        fetchRequestBodyChunk: { args: z.tuple([z.string()]) },
        fetchRequestBodyClose: { args: z.tuple([z.string()]) },
        health: { args: z.tuple([z.enum(["healthy", "degraded", "unhealthy"]), z.unknown().optional()]) },
        log: { args: z.tuple([z.enum(["debug", "info", "warn", "error"]), z.string(), z.record(z.unknown()).optional()]) },
        reload: { args: z.tuple([z.string()]) },
      },
      handler: (ctx, method, args) => this.handle(ctx, method, args),
    };
  }

  private async handle(ctx: ServiceContext, method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "invoke":
        return this.invoke(ctx, args[0] as string, args[1] as string, args[2] as unknown[]);
      case "invokeStream":
        return this.invokeStream(ctx, args[0] as string, args[1] as string, args[2] as unknown[]);
      case "streamingMethods":
        return this.streamingMethodsFor(args[0] as string);
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
      case "reload":
        return this.reload(ctx, args[0] as string);
      default:
        throw new ServiceError("extensions", method, `Unknown extensions method: ${method}`, "ENOSYS");
    }
  }

  async invoke(ctx: ServiceContext, name: string, method: string, args: unknown[]): Promise<unknown> {
    const entry = this.lookupForInvoke(name);
    if (!entry || !entry.enabled) {
      throw new ServiceError("extensions", "invoke", `Extension is not installed or enabled: ${name}`, "ENOEXT");
    }
    const invocation = this.createTrackedInvocation(ctx, entry.name, method);
    if (!this.processes.isRunning(entry.name)) {
      throw new ServiceError("extensions", "invoke", `Extension is not running: ${entry.name}`, "ENOTREADY");
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
          callerId: ctx.caller.runtime.id,
          callerKind: ctx.caller.runtime.kind,
          code: typeof code === "string" ? code : undefined,
          stack: wrapped.stack,
        },
        "console",
      );
      throw wrapped;
    } finally {
      this.clearTrackedInvocation(invocation);
    }
  }

  /**
   * Streaming method names declared in the extension's manifest. Consumers use
   * this to route the right methods through `invokeStream` without hardcoding
   * the set at the call site. Unknown extensions return an empty list.
   */
  streamingMethodsFor(name: string): string[] {
    try {
      const node = this.findExtensionNode(name);
      return node.manifest.extension?.streamingMethods ?? [];
    } catch {
      return [];
    }
  }

  async invokeStream(ctx: ServiceContext, name: string, method: string, args: unknown[]): Promise<Response> {
    const entry = this.lookupForInvoke(name);
    if (!entry || !entry.enabled) {
      throw new ServiceError("extensions", "invokeStream", `Extension is not installed or enabled: ${name}`, "ENOEXT");
    }
    if (!this.deps.extensionTransport.streamCallTarget) {
      throw new ServiceError("extensions", "invokeStream", "Extension streaming transport is unavailable", "ENOTIMPL");
    }
    const invocation = this.createTrackedInvocation(ctx, entry.name, method);
    if (!this.processes.isRunning(entry.name)) {
      throw new ServiceError("extensions", "invokeStream", `Extension is not running: ${entry.name}`, "ENOTREADY");
    }
    try {
      const response = await this.deps.extensionTransport.streamCallTarget(
        entry.name,
        "extension.invokeStream",
        method,
        args,
        invocation,
      );
      return this.responseWithInvocationCleanup(response, invocation);
    } catch (err) {
      this.clearTrackedInvocation(invocation);
      throw err;
    }
  }

  private responseWithInvocationCleanup(response: Response, invocation: ExtensionInvocation): Response {
    if (!response.body) {
      this.clearTrackedInvocation(invocation);
      return response;
    }
    const cleanup = () => this.clearTrackedInvocation(invocation);
    const reader = response.body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      },
      async cancel(reason) {
        cleanup();
        await reader.cancel(reason);
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  resolveActiveInvocation(
    extensionName: string,
    invocationToken: string,
  ): (ExtensionInvocation & { chainCaller?: ExtensionUserlandCaller }) | null {
    return (this.activeInvocations.get(this.invocationKey(extensionName, invocationToken)) as
      | (ExtensionInvocation & { chainCaller?: ExtensionUserlandCaller })
      | undefined) ?? null;
  }

  private createTrackedInvocation(ctx: ServiceContext, extensionName: string, method: string): ExtensionInvocation {
    const invocation = invocationFromServiceContext(
      ctx,
      extensionName,
      method,
      randomUUID(),
      this.deps.getContextIdForCaller,
    );
    const token = randomUUID();
    invocation.invocationToken = token;
    this.activeInvocations.set(this.invocationKey(extensionName, token), invocation);
    return invocation;
  }

  private clearTrackedInvocation(invocation: ExtensionInvocation): void {
    if (invocation.invocationToken) {
      this.activeInvocations.delete(this.invocationKey(invocation.extensionName, invocation.invocationToken));
    }
  }

  private invocationKey(extensionName: string, invocationToken: string): string {
    return `${extensionName}\x00${invocationToken}`;
  }

  /**
   * Pure lookup for the invoke path — never installs, builds, or enables.
   * Returns the running-eligible registry entry, or null. Trust is granted at
   * declaration time (startup / meta-push reconcile), not at invocation.
   */
  private lookupForInvoke(name: string): RegistryEntry | null {
    let resolvedName = name;
    try {
      resolvedName = this.findExtensionNode(name).name;
    } catch {
      // Not a known extension unit — fall back to a direct registry lookup so
      // a stale name still yields a clean ENOEXT rather than throwing here.
    }
    const entry = this.registry.get(resolvedName);
    return entry?.enabled && entry.activeBundleKey ? entry : null;
  }

  async handleExtensionHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
    remainderPath: string,
    caller: VerifiedCaller,
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
      caller,
    };
    const invocation = this.createTrackedInvocation(ctx, name, method);
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
      this.clearTrackedInvocation(invocation);
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
    this.deps.eventService.subscribe(eventName, ctx.caller.runtime.id, subscriber, ctx.connectionId);
    return null;
  }

  private emitFromExtension(ctx: ServiceContext, event: string, payload: unknown): null {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError("extensions", "emit", "Only extensions can emit extension events", "EACCES");
    }
    this.deps.eventService.emit(`extensions:${ctx.caller.runtime.id}::${event}` as EventName, payload);
    return null;
  }

  private async fetchRequestBodyChunk(ctx: ServiceContext, streamId: string): Promise<StreamChunkEnvelope> {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError("extensions", "fetchRequestBodyChunk", "Only extensions can read extension fetch request bodies", "EACCES");
    }
    const stream = this.fetchRequestBodies.get(streamId);
    if (!stream || stream.extensionName !== ctx.caller.runtime.id) {
      throw new ServiceError("extensions", "fetchRequestBodyChunk", `Unknown extension fetch request body stream: ${streamId}`, "ENOENT");
    }
    return readNextBodyChunk(stream);
  }

  private async fetchRequestBodyClose(ctx: ServiceContext, streamId: string): Promise<null> {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError("extensions", "fetchRequestBodyClose", "Only extensions can close extension fetch request bodies", "EACCES");
    }
    const stream = this.fetchRequestBodies.get(streamId);
    if (!stream || stream.extensionName !== ctx.caller.runtime.id) return null;
    await this.closeFetchRequestBody(streamId);
    return null;
  }

  private readyFromExtension(ctx: ServiceContext, ready: { methods: string[]; hasFetch: boolean }): null {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError("extensions", "ready", "Only extensions can complete extension startup", "EACCES");
    }
    this.processes.markReady(ctx.caller.runtime.id, ready);
    return null;
  }

  private healthFromExtension(ctx: ServiceContext, state: ExtensionHealth["state"], detail: unknown): null {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError("extensions", "health", "Only extensions can report extension health", "EACCES");
    }
    const healthDetail = detail as { summary?: string; reasons?: string[]; retryAt?: number } | undefined;
    this.reportExtensionHealth(ctx.caller.runtime.id, {
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
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError("extensions", "log", "Only extensions can write extension logs", "EACCES");
    }
    this.recordExtensionLog(ctx.caller.runtime.id, level, message, fields, "ctx.log");
    return null;
  }

  async reload(ctx: ServiceContext, name: string): Promise<void> {
    await this.reloadApproval(ctx, name);
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
    lastBuiltAt: number | null;
    pendingApproval: { kind: string; submittedAt: number } | null;
    availableUpdate: { reason: "dependency"; checkedAt: number } | null;
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
      const lastBuiltAt = this.resolveBundleMtime(entry);
      const pendingApproval = entry.status === "pending-approval"
        ? { kind: entry.activeBundleKey ? "extension.update" : "extension.install", submittedAt: entry.installedAt }
        : null;
      const availableUpdate = entry.enabled && entry.activeBundleKey && this.needsBuildRefresh(entry, node)
        ? { reason: "dependency" as const, checkedAt: Date.now() }
        : null;
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
        lastBuiltAt,
        pendingApproval,
        availableUpdate,
        lastError: entry.lastError,
        health: running?.health ?? this.health.get(entry.name) ?? null,
        methods: running?.methods ?? [],
        hasFetch: running?.hasFetch ?? false,
        respawn: this.processes.getRespawn(entry.name),
        inspectorUrl: running?.inspectorUrl ?? this.inspectorUrls.get(entry.name) ?? null,
      };
    });
  }

  private resolveBundleMtime(entry: RegistryEntry): number | null {
    if (!entry.activeBundleKey) return null;
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    if (!build) return null;
    try {
      return Math.floor(fs.statSync(build.bundlePath).mtimeMs);
    } catch {
      return null;
    }
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
    caller: VerifiedCaller;
    repoPath: string;
    branch: string;
    commit: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const repoPath = normalizeRepoPath(request.repoPath);
    // meta/ pushes are the sole gate for workspace-config writes AND for
    // trusting any newly-declared extensions — one combined prompt (§4).
    if (repoPath === "meta") {
      return this.authorizeMetaPush(request);
    }
    const installed = this.findInstalledExtensionByRepo(repoPath);
    if (!installed) return { allowed: true };
    if (request.branch !== "main" && request.branch !== "master") return { allowed: true };

    // Trusted internal callers (CLI, server bootstrap) bypass the prompt.
    // The approval is meant to capture an interactive decision; shell/server
    // pushes are already authorized by their callerKind.
    if (request.caller.runtime.kind === "shell" || request.caller.runtime.kind === "server") {
      return { allowed: true };
    }

    const sessionGrantKey = extensionPushSessionGrantKey(
      request.caller.runtime.id,
      installed.entry.name,
      repoPath,
      request.branch
    );
    if (this.sourcePushGrants.hasActive(sessionGrantKey)) {
      return { allowed: true };
    }

    if (
      request.caller.runtime.kind !== "panel" &&
      request.caller.runtime.kind !== "worker" &&
      request.caller.runtime.kind !== "do"
    ) {
      return {
        allowed: false,
        reason: `Extension source pushes from ${request.caller.runtime.kind} callers are not supported`,
      };
    }
    const identity = request.caller.code;
    if (!identity || identity.callerKind !== request.caller.runtime.kind) {
      return { allowed: false, reason: `Unknown caller identity: ${request.caller.runtime.id}` };
    }
    const decision = await this.deps.approvalQueue.request({
      kind: "extension",
      callerId: request.caller.runtime.id,
      callerKind: request.caller.runtime.kind,
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
        pushedBy: request.caller.runtime.id,
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

  /**
   * Combined meta-push approval (§4): one prompt covering the workspace-config
   * write AND trust for any newly-declared extensions in the pushed commit. On
   * approval the trusted names are stashed for the post-push reconcile so it
   * activates them without a second prompt.
   */
  private async authorizeMetaPush(request: {
    caller: VerifiedCaller;
    branch: string;
    commit: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    // Trusted internal callers (CLI, server bootstrap) are not interactively
    // prompted; the post-push reconcile still surfaces the joint approval.
    if (request.caller.runtime.kind === "shell" || request.caller.runtime.kind === "server") {
      return { allowed: true };
    }

    const declared = this.readDeclaredExtensionsFromCommit(request.commit);
    const unapproved: Array<{ node: ReturnType<ExtensionHost["findExtensionNode"]>; ref: string }> = [];
    for (const decl of declared) {
      if (!decl.enabled) continue;
      let node: ReturnType<ExtensionHost["findExtensionNode"]>;
      try {
        node = this.findExtensionNode(decl.source);
      } catch {
        continue;
      }
      const entry = this.registry.get(node.name);
      if (!this.isApprovedForDeclaration(entry, node, decl.ref)) {
        unapproved.push({ node, ref: decl.ref });
      }
    }
    const declarationKeys = new Set(unapproved.map(({ node, ref }) => this.declarationTrustKey(node, ref)));
    const names = unapproved.map(({ node }) => node.name);
    const approvedCommit = resolveGitCommit(path.join(this.deps.workspacePath, "meta"), request.commit) ?? request.commit;

    const sessionGrantKey = extensionPushSessionGrantKey(
      request.caller.runtime.id,
      "meta",
      "meta",
      request.branch,
    );
    if (this.sourcePushGrants.hasActive(sessionGrantKey) && declarationKeys.size === 0) {
      return { allowed: true };
    }

    if (
      request.caller.runtime.kind !== "panel" &&
      request.caller.runtime.kind !== "worker" &&
      request.caller.runtime.kind !== "do"
    ) {
      return {
        allowed: false,
        reason: `Workspace config pushes from ${request.caller.runtime.kind} callers are not supported`,
      };
    }
    const identity = request.caller.code;
    if (!identity || identity.callerKind !== request.caller.runtime.kind) {
      return { allowed: false, reason: `Unknown caller identity: ${request.caller.runtime.id}` };
    }

    const decision = await this.deps.approvalQueue.request({
      kind: "extension-batch",
      callerId: request.caller.runtime.id,
      callerKind: request.caller.runtime.kind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      dedupKey: `extension-meta-push:${request.caller.runtime.id}:${request.branch}:${approvedCommit}`,
      trigger: "meta-push",
      title: names.length > 0 ? "Workspace extensions changed" : "Edit workspace config",
      description:
        names.length > 0
          ? `This push edits workspace config and adds ${names.length} extension${names.length === 1 ? "" : "s"} that will run as native code.`
          : "This push edits sensitive workspace configuration.",
      extensions: unapproved.map(({ node, ref }) => this.buildBatchEntry(node, ref)),
      configWrite: { repoPath: "meta", summary: this.metaDiffSummary(request.commit) },
    });
    if (decision === "deny") {
      return { allowed: false, reason: "Workspace config push denied" };
    }
    if (decision === "session") {
      this.sourcePushGrants.grant(sessionGrantKey, EXTENSION_DEV_SESSION_TTL_MS);
    }
    if (declarationKeys.size > 0) {
      this.pendingMetaApproval = { commit: approvedCommit, declarationKeys };
    }
    return { allowed: true };
  }

  private readDeclaredExtensionsFromCommit(
    commit: string,
  ): Array<{ source: string; ref: string; enabled: boolean }> {
    const metaRepoDir = path.join(this.deps.workspacePath, "meta");
    try {
      const out = String(
        execGitFileSync(["show", "--end-of-options", `${commit}:natstack.yml`], {
          cwd: metaRepoDir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
      const parsed = YAML.parse(out) as
        | { extensions?: Array<{ source?: string; ref?: string; enabled?: boolean }> }
        | null;
      return (parsed?.extensions ?? [])
        .filter((d): d is { source: string; ref?: string; enabled?: boolean } =>
          typeof d?.source === "string" && d.source.length > 0,
        )
        .map((d) => ({ source: d.source, ref: d.ref ?? "main", enabled: d.enabled ?? true }));
    } catch {
      return [];
    }
  }

  private metaDiffSummary(commit: string): string {
    const metaRepoDir = path.join(this.deps.workspacePath, "meta");
    const previous = resolveGitCommit(metaRepoDir, "HEAD");
    const stat = readGitDiffStat(metaRepoDir, previous, resolveGitCommit(metaRepoDir, commit) ?? commit);
    return stat
      ? `${stat.filesChanged} file(s) changed, +${stat.insertions} -${stat.deletions}`
      : "workspace config change";
  }

  private buildBatchEntry(
    node: ReturnType<ExtensionHost["findExtensionNode"]>,
    ref: string,
  ): ExtensionBatchEntry {
    return {
      extensionName: node.name,
      displayName: node.manifest.displayName ?? node.name,
      version: this.readNodeVersion(node.path),
      source: { kind: "internal-git", repo: node.relativePath, ref },
      ev: this.deps.buildSystem.getEffectiveVersion(node.name),
      capabilities: extensionRuntimeCapabilities(),
      dependencyEvs: this.currentDependencyEvs(node),
      externalDeps: this.currentExternalDeps(node),
      commit: null,
    };
  }

  private isApprovedForDeclaration(
    entry: RegistryEntry | null,
    node: ReturnType<ExtensionHost["findExtensionNode"]>,
    ref: string,
  ): entry is RegistryEntry {
    return Boolean(
      entry?.activeBundleKey
        && entry.status !== "pending-approval"
        && this.entrySourceMatches(entry, node, ref),
    );
  }

  private entrySourceMatches(
    entry: RegistryEntry,
    node: ReturnType<ExtensionHost["findExtensionNode"]>,
    ref: string,
  ): boolean {
    return normalizeRepoPath(entry.source.repo) === normalizeRepoPath(node.relativePath)
      && entry.source.ref === ref;
  }

  private declarationTrustKey(
    node: ReturnType<ExtensionHost["findExtensionNode"]>,
    ref: string,
  ): string {
    return [
      node.name,
      normalizeRepoPath(node.relativePath),
      ref,
      this.deps.buildSystem.getEffectiveVersion(node.name) ?? "",
    ].join("\x00");
  }

  private async requestBatchApproval(
    entries: ExtensionBatchEntry[],
    trigger: "startup" | "meta-push",
    configWrite?: PendingExtensionBatchApproval["configWrite"],
  ): Promise<"once" | "session" | "version" | "repo" | "deny"> {
    const count = entries.length;
    return this.deps.approvalQueue.request({
      kind: "extension-batch",
      callerId: "system:extensions",
      callerKind: "system",
      repoPath: "meta",
      effectiveVersion: "",
      trigger,
      title: "Approve workspace extensions",
      description: `This workspace uses ${count} extension${count === 1 ? "" : "s"} that need your approval to run as native code.`,
      extensions: entries,
      configWrite: configWrite ?? null,
    });
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
      source: { kind: "internal-git", repo: node.relativePath, ref: ref ?? "main" },
      version: this.readNodeVersion(node.path),
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

  private async reloadApproval(ctx: ServiceContext, name: string): Promise<void> {
    // Trusted internal callers (CLI shell) are pre-authorized and skip the
    // prompt. Panels, workers, and DOs go through approval. Other caller kinds
    // are rejected.
    if (ctx.caller.runtime.kind === "shell") return;
    if (
      ctx.caller.runtime.kind !== "panel" &&
      ctx.caller.runtime.kind !== "worker" &&
      ctx.caller.runtime.kind !== "do"
    ) {
      throw new ServiceError(
        "extensions",
        "reload",
        `Extension reload is not available to ${ctx.caller.runtime.kind} callers`,
        "EACCES",
      );
    }
    const identity = ctx.caller.code;
    if (!identity || identity.callerKind !== ctx.caller.runtime.kind) {
      throw new ServiceError("extensions", "reload", `Unknown caller identity: ${ctx.caller.runtime.id}`, "ENOENT");
    }
    const node = this.findExtensionNode(name);
    const entry = this.registry.get(node.name);
    const source = entry?.source ?? {
      kind: "internal-git" as const,
      repo: node.relativePath,
      ref: "main",
    };
    const decision = await this.deps.approvalQueue.request({
      kind: "extension",
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      action: "reload",
      extensionName: node.name,
      version: entry?.version ?? this.readNodeVersion(node.path),
      source,
      title: "Reload extension",
      description: `Allow ${ctx.caller.runtime.kind} ${ctx.caller.runtime.id} to reload ${name}.`,
      ev: entry?.activeEv,
      previousEv: entry?.activeEv,
      previousSha: entry?.activeSha,
      capabilities: extensionRuntimeCapabilities(),
      details: [
        { label: "Extension", value: node.name },
        { label: "Source", value: `${source.repo}@${source.ref}` },
      ],
    });
    if (decision === "deny") {
      throw new ServiceError("extensions", "reload", "Extension reload approval denied", "EACCES");
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

const EXTENSION_DEV_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

function extensionPushSessionGrantKey(
  callerId: string,
  extensionName: string,
  repoPath: string,
  branch: string
): string {
  return `${callerId}\x00${extensionName}\x00${repoPath}\x00${branch}`;
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

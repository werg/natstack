import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { extensionsMethods } from "@natstack/shared/serviceSchemas/extensions";
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
  BuildProvider,
  BuildProviderOutput,
  BuildProviderTarget,
} from "@natstack/shared/buildProvider";
import type { PendingUnitBatchApproval, UnitBatchEntry } from "@natstack/shared/approvals";
import {
  parseWorkspaceConfigContentWithId,
  resolveDeclaredExtensions,
} from "@natstack/shared/workspace/configParser";
import {
  UnitManifestError,
  extensionUnitManifestDescriptor,
  readAndValidateUnitManifest,
} from "@natstack/shared/unitManifest";
import {
  UnitHost,
  UnitRegistry,
  UnitSourceChangeGrantStore,
  UnitTrustResolver,
  authorizeUnitSourceChange,
  collectTransitiveUnitDependencyEvs,
  createPendingUnitRegistryEntry,
  createUnitBuildIdentity,
  createUnitBatchEntryBase,
  findUnitGraphNode,
  normalizeUnitRepoPath as normalizeRepoPath,
  normalizeUnitRef as normalizeRef,
  requestUnitBatchApproval,
  unitBuildIdentityFromRegistryEntry,
  type UnitDeclaration,
  type UnitApprovalCoordinator,
  type UnitBuildIdentity,
  type UnitDescriptor,
  type UnitMetaChangeApprovalProvider,
  type UnitReconcileTrigger,
  type UnitWorkspaceStatus,
} from "@natstack/unit-host";

import { ExtensionProcessManager } from "./processManager.js";
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

const EXTENSION_UNIT_DESCRIPTOR: UnitDescriptor<"extension"> = {
  kind: "extension",
  sourceRoot: "extensions",
  buildKind: "extension",
  approvalFraming: {
    serviceName: "extensions",
    unitLabel: "extension",
    unitLabelPlural: "extensions",
    nativeCode: true,
  },
  seedTrustEligible: true,
};

interface BuildSystemLike {
  getBuild(
    unitPath: string,
    ref?: string
  ): Promise<{
    dir: string;
    sourceStateHash?: string | null;
    metadata: ExtensionBuildMetadataLike;
    artifacts: ExtensionBuildArtifactLike[];
  }>;
  getBuildByKey?(
    key: string
  ): {
    dir: string;
    sourceStateHash?: string | null;
    metadata: ExtensionBuildMetadataLike;
    artifacts: ExtensionBuildArtifactLike[];
  } | null;
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
      manifest: {
        displayName?: string;
        extension?: {
          activationEvents?: string[];
          streamingMethods?: string[];
          contributes?: { buildTargets?: string[] };
        };
      };
    }>;
  };
  onPushBuild(callback: (source: string, trigger?: { head: string }) => void): void;
  onUnitChange?(
    callback: (event: {
      name: string;
      relativePath: string;
      kind: string;
      trigger: { head: string };
    }) => void
  ): () => void;
}

interface ExtensionBuildMetadataLike {
  ev: string;
  sourceStateHash?: string | null;
  details?:
    | {
        kind: "extension";
        runtimeDepsKey?: string | null;
        runtimeAbi?: string | null;
        externalDeps?: Record<string, string>;
      }
    | { kind: string };
}

interface ExtensionBuildArtifactLike {
  path: string;
  role: string;
  platform?: string;
}

interface ExtensionTransportLike {
  call(name: string, method: string, ...args: unknown[]): Promise<unknown>;
  streamCallTarget?(name: string, method: string, ...args: unknown[]): Promise<Response>;
}

interface ApprovalQueueLike {
  request(
    req:
      | {
          kind: "capability";
          callerId: string;
          callerKind: "panel" | "app" | "worker" | "do";
          repoPath: string;
          effectiveVersion: string;
          capability: string;
          dedupKey?: string | null;
          title: string;
          description?: string;
          resource?: { type: string; label: string; value: string };
          details?: Array<{ label: string; value: string }>;
        }
      | {
          kind: "unit-batch";
          callerId: string;
          callerKind: "panel" | "app" | "worker" | "do" | "system";
          repoPath: string;
          effectiveVersion: string;
          dedupKey?: string | null;
          trigger: PendingUnitBatchApproval["trigger"];
          title: string;
          description: string;
          units: PendingUnitBatchApproval["units"];
          configWrite?: PendingUnitBatchApproval["configWrite"];
        }
  ): Promise<"once" | "session" | "version" | "repo" | "deny">;
}

interface NotificationServiceLike {
  show(notification: Omit<NotificationPayload, "id"> & { id?: string }): string;
}

export interface ExtensionHostDeps {
  statePath: string;
  workspacePath: string;
  workspaceId: string;
  readWorkspaceFileAtCommit(commit: string, filePath: string): Promise<string | null>;
  buildSystem: BuildSystemLike;
  tokenManager: TokenManager;
  eventService: EventService;
  approvalQueue: ApprovalQueueLike;
  approvalCoordinator?: UnitApprovalCoordinator<UnitBatchEntry>;
  notificationService?: NotificationServiceLike;
  recordUnitLog?: (record: UnitLogRecord) => void;
  getContextIdForCaller?: (callerId: string) => string | null;
  getGatewayUrl(): string;
  /**
   * Bridge from the dispatcher to a connected extension's WebSocket. Required
   * — `invoke` and `handleExtensionHttpRequest` need this to reach the child.
   */
  extensionTransport: ExtensionTransportLike;
  registerBuildProvider?: (provider: BuildProvider) => void;
  unregisterBuildProvider?: (target: BuildProviderTarget, name: string) => void;
  onWorkspaceUnitsChanged?: (reason: string) => void;
}

export class ExtensionHost implements UnitMetaChangeApprovalProvider<UnitBatchEntry> {
  readonly registry: UnitRegistry<RegistryEntry>;
  readonly processes: ExtensionProcessManager;
  private readonly extensionTrustResolver: UnitTrustResolver<RegistryEntry>;
  private readonly unitHost: UnitHost<
    RegistryEntry,
    UnitDeclaration,
    ReturnType<ExtensionHost["findExtensionNode"]>,
    UnitBatchEntry
  >;
  private health = new Map<string, unknown>();
  private inspectorUrls = new Map<string, string | null>();
  private unitLogs = new Map<string, UnitLogRecord[]>();
  private extensionErrorHistory = new Map<string, ExtensionErrorHistoryItem[]>();
  private fetchRequestBodies = new Map<string, FetchRequestBodyStream>();
  private activeInvocations = new Map<string, ExtensionInvocation>();
  private registeredBuildProviderTargets = new Map<string, Set<BuildProviderTarget>>();
  private readonly sourceChangeGrants: UnitSourceChangeGrantStore;

  constructor(private readonly deps: ExtensionHostDeps) {
    this.registry = new UnitRegistry<RegistryEntry>({
      statePath: deps.statePath,
      unitKind: EXTENSION_UNIT_DESCRIPTOR.kind,
    });
    this.extensionTrustResolver = new UnitTrustResolver<RegistryEntry>({
      entryIdentity: (entry) => this.registryEntryBuildIdentity(entry),
    });
    this.sourceChangeGrants = new UnitSourceChangeGrantStore({ statePath: deps.statePath });
    this.processes = new ExtensionProcessManager({
      onStatus: (name, status, error) => {
        if (status === "running") {
          this.extensionErrorHistory.delete(name);
        }
        if (this.registry.has(name)) {
          this.registry.patch(name, { status, lastError: error ?? null });
        }
        this.deps.eventService.emit("extensions:status", { name, status, error: error ?? null });
        this.deps.onWorkspaceUnitsChanged?.("extension-status");
      },
      onError: (name, error, attempts) => {
        this.rememberExtensionError(name, error, attempts);
        this.deps.eventService.emit("extensions:error", { name, error, attempts });
      },
      onHealth: (name, health) => {
        this.reportExtensionHealth(name, health);
      },
      onLog: (name, level, message, fields, source = "ctx.log") => {
        this.recordExtensionLog(name, level, message, fields, source);
      },
      onCrashLimit: (name, error, attempts) => {
        const history = this.extensionErrorHistory.get(name) ?? [
          { attempts, error, timestamp: Date.now() },
        ];
        this.deps.notificationService?.show({
          id: `extension-crash-${encodeURIComponent(name)}`,
          type: "error",
          title: "Extension stopped",
          message: `${name} failed ${attempts} times and will not restart until reloaded.`,
          details: [
            { label: "Extension", value: name, mono: true },
            { label: "Attempts", value: String(attempts) },
            { label: "Latest error", value: error, mono: true },
          ],
          history: history.map((item) => ({
            title: `Attempt ${item.attempts}`,
            message: item.error,
            timestamp: item.timestamp,
          })),
          actions: [
            {
              id: "reload",
              label: "Reload",
              variant: "solid",
              command: { type: "workspace.restartUnit", name },
            },
          ],
        });
      },
      onInspectorUrl: (name, inspectorUrl) => {
        this.inspectorUrls.set(name, inspectorUrl);
        this.deps.eventService.emit("extensions:status", {
          name,
          status: this.registry.get(name)?.status ?? "running",
          inspectorUrl,
        });
        this.deps.onWorkspaceUnitsChanged?.("extension-status");
      },
    });
    this.unitHost = new UnitHost({
      descriptor: EXTENSION_UNIT_DESCRIPTOR,
      registry: this.registry,
      resolveNode: (source) => this.findExtensionNode(source),
      candidateIdentity: (node, decl) => this.declarationBuildIdentity(node, decl.ref),
      trustResolver: this.extensionTrustResolver,
      makePendingEntry: (node, decl, building) => this.pendingEntryFor(node, decl, building),
      applyTrusted: (node, decl) => this.applyDeclared(node, decl),
      removeUndeclared: async (entry) => {
        this.unregisterBuildProvidersFor(entry.name);
        try {
          await this.processes.stop(entry.name);
        } catch {
          // best-effort
        }
      },
      emitRemoved: (entry) => {
        this.deps.eventService.emit("extensions:status", {
          name: entry.name,
          status: "stopped",
          error: null,
        });
        this.deps.onWorkspaceUnitsChanged?.("extension-removed");
      },
      notifyUnresolved: (sources) => {
        this.deps.notificationService?.show({
          id: `extensions-unresolved-${encodeURIComponent(sources.join(","))}`,
          type: "error",
          title: "Unknown extensions declared",
          message: `meta/natstack.yml declares extensions that don't exist: ${sources.join(", ")}.`,
        });
      },
      validateBeforeApproval: (node) => this.validateExtensionManifestAtPath(node.path, node.name),
      onApprovalCandidateError: (node, _decl, message) => {
        this.deps.eventService.emit("extensions:status", {
          name: node.name,
          status: "error",
          error: message,
        });
        this.deps.onWorkspaceUnitsChanged?.("extension-status");
      },
      approvalEntry: (node, decl) => this.buildBatchEntry(node, decl.ref),
      requestApproval: (entries, trigger) =>
        requestUnitBatchApproval({
          descriptor: EXTENSION_UNIT_DESCRIPTOR,
          approvalQueue: this.deps.approvalQueue,
          entries,
          trigger,
        }),
      approvalCoordinator: deps.approvalCoordinator,
      onApprovalDenied: (items) => {
        const names = items.map((item) => item.node.name);
        for (const name of names) {
          this.deps.eventService.emit("extensions:status", {
            name,
            status: "pending-approval",
            error: null,
          });
        }
        this.deps.onWorkspaceUnitsChanged?.("extension-status");
        this.deps.notificationService?.show({
          id: `extensions-pending-approval-${names.join(",")}`,
          type: "info",
          title: "Extensions need approval",
          message: `${names.join(", ")} ${names.length === 1 ? "is" : "are"} declared but not approved. They will be offered again on next startup or when meta is edited.`,
        });
      },
      onBackgroundError: (err) => {
        console.error(
          "[ExtensionHost] Background unit approval flow failed:",
          err instanceof Error ? err.message : String(err)
        );
      },
    });
    deps.buildSystem.onPushBuild((source, trigger) => {
      this.handleSourceRebuilt(source, trigger).catch((err) => {
        console.error(
          `[ExtensionHost] Failed to reload rebuilt extension source ${source}:`,
          err instanceof Error ? err.message : String(err)
        );
      });
    });
    deps.buildSystem.onUnitChange?.((event) => {
      if (event.kind !== "extension") return;
      this.handleChangedExtensionUnit(event).catch((err) => {
        console.error(
          `[ExtensionHost] Failed to reconcile changed extension unit ${event.relativePath}:`,
          err instanceof Error ? err.message : String(err)
        );
      });
    });
  }

  /**
   * Reconcile the registry against the declared extension set from
   * `meta/natstack.yml`. This is the single entry point that installs or
   * removes extensions. Called at boot and after a meta-state update (post-receive).
   * The declared set is authoritative: anything in the registry but not
   * declared is removed.
   */
  async reconcileDeclared(
    declared: Array<{ source: string; ref: string }>,
    opts: { trigger?: UnitReconcileTrigger } = {}
  ): Promise<void> {
    await this.unitHost.reconcileDeclared(declared, opts);
  }

  /**
   * Test/diagnostic hook: resolves once the synchronous reconcile AND any
   * background joint-approval flow it kicked off have settled.
   */
  async whenSettled(): Promise<void> {
    await this.unitHost.whenSettled();
  }

  async whenReconciled(): Promise<void> {
    await this.unitHost.whenReconciled();
  }

  /** Build/start a single declared extension. */
  private async applyDeclared(
    node: ReturnType<ExtensionHost["findExtensionNode"]>,
    decl: UnitDeclaration
  ): Promise<void> {
    await this.unitHost.applyRuntimeDeclaration({
      node,
      decl,
      validateBeforeActivateCurrent: () =>
        this.validateExtensionManifestAtPath(node.path, node.name),
      needsBuildRefresh: (entry) => this.needsBuildRefresh(entry, node),
      buildAndActivate: async (_node, d) => this.buildAndActivate(node.name, d.ref),
      activateCurrent: async () => this.activate(node.name),
    });
  }

  private pendingEntryFor(
    node: ReturnType<ExtensionHost["findExtensionNode"]>,
    decl: UnitDeclaration,
    building = false
  ): RegistryEntry {
    return createPendingUnitRegistryEntry({
      unitKind: "extension",
      name: node.name,
      version: this.readNodeVersion(node.path),
      sourceRepo: node.relativePath,
      ref: decl.ref,
      building,
    });
  }

  private validateExtensionManifestAtPath(nodePath: string, unitName: string): void {
    try {
      readAndValidateUnitManifest(
        extensionUnitManifestDescriptor,
        path.join(nodePath, "package.json"),
        { unitName },
        fs.readFileSync as (p: string, encoding: "utf-8") => string
      );
    } catch (err) {
      if (err instanceof UnitManifestError) throw err;
      throw new UnitManifestError(
        `Extension ${unitName} manifest validation failed: ${err instanceof Error ? err.message : String(err)}`,
        "MANIFEST_INTERNAL"
      );
    }
  }

  async shutdown(): Promise<void> {
    await this.processes.shutdown();
  }

  async metaChangeApprovalForCommit(
    commit: string
  ): Promise<{ units: UnitBatchEntry[]; identityKeys: string[] }> {
    const approval = this.unitHost.approvalForDeclarations(
      await this.readDeclaredExtensionsFromCommit(commit)
    );
    return { units: approval.entries, identityKeys: approval.identityKeys };
  }

  acceptPreapprovedTrust(keys: Iterable<string>): void {
    this.unitHost.acceptPreapprovedTrust(keys);
  }

  createServiceDefinition(): ServiceDefinition {
    return {
      name: "extensions",
      description: "Installed extension management and invocation",
      policy: { allowed: ["panel", "app", "worker", "do", "shell", "server", "extension"] },
      methods: extensionsMethods,
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
        return this.readyFromExtension(ctx, args[0] as { methods: string[]; hasFetch: boolean });
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
          args[2] as Record<string, unknown> | undefined
        );
      case "reload":
        return this.reload(ctx, args[0] as string);
      default:
        throw new ServiceError(
          "extensions",
          method,
          `Unknown extensions method: ${method}`,
          "ENOSYS"
        );
    }
  }

  async invoke(
    ctx: ServiceContext,
    name: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    // Do not wait for the global background approval/build flow here. Invocation is target-local:
    // use the currently active bundle if one exists, or fail fast below. Waiting for `whenSettled()`
    // can park a low-value call to an already-running extension behind an unrelated pending
    // extension approval, which in turn can wedge eval/tool callers that are just awaiting an
    // extension-backed helper.
    await this.whenReconciled();
    const entry = this.lookupForInvoke(name);
    if (!entry) {
      throw new ServiceError(
        "extensions",
        "invoke",
        `Extension is not installed: ${name}`,
        "ENOEXT"
      );
    }
    const invocation = this.createTrackedInvocation(ctx, entry.name, method);
    if (!this.processes.isRunning(entry.name)) {
      throw new ServiceError(
        "extensions",
        "invoke",
        `Extension is not running: ${entry.name}`,
        "ENOTREADY"
      );
    }
    try {
      return await this.deps.extensionTransport.call(
        entry.name,
        "extension.invoke",
        method,
        args,
        invocation
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(`Extension ${entry.name}.${method} invocation failed: ${message}`);
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
        "console"
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

  async invokeStream(
    ctx: ServiceContext,
    name: string,
    method: string,
    args: unknown[]
  ): Promise<Response> {
    // See invoke(): stream calls should not wait behind unrelated extension approval/build work.
    await this.whenReconciled();
    const entry = this.lookupForInvoke(name);
    if (!entry) {
      throw new ServiceError(
        "extensions",
        "invokeStream",
        `Extension is not installed: ${name}`,
        "ENOEXT"
      );
    }
    if (!this.deps.extensionTransport.streamCallTarget) {
      throw new ServiceError(
        "extensions",
        "invokeStream",
        "Extension streaming transport is unavailable",
        "ENOTIMPL"
      );
    }
    const invocation = this.createTrackedInvocation(ctx, entry.name, method);
    if (!this.processes.isRunning(entry.name)) {
      throw new ServiceError(
        "extensions",
        "invokeStream",
        `Extension is not running: ${entry.name}`,
        "ENOTREADY"
      );
    }
    try {
      const response = await this.deps.extensionTransport.streamCallTarget(
        entry.name,
        "extension.invokeStream",
        method,
        args,
        invocation
      );
      return this.responseWithInvocationCleanup(response, invocation);
    } catch (err) {
      this.clearTrackedInvocation(invocation);
      throw err;
    }
  }

  private responseWithInvocationCleanup(
    response: Response,
    invocation: ExtensionInvocation
  ): Response {
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
    invocationToken: string
  ): (ExtensionInvocation & { chainCaller?: ExtensionUserlandCaller }) | null {
    return (
      (this.activeInvocations.get(this.invocationKey(extensionName, invocationToken)) as
        | (ExtensionInvocation & { chainCaller?: ExtensionUserlandCaller })
        | undefined) ?? null
    );
  }

  private createTrackedInvocation(
    ctx: ServiceContext,
    extensionName: string,
    method: string
  ): ExtensionInvocation {
    const invocation = invocationFromServiceContext(
      ctx,
      extensionName,
      method,
      randomUUID(),
      this.deps.getContextIdForCaller
    );
    const token = randomUUID();
    invocation.invocationToken = token;
    this.activeInvocations.set(this.invocationKey(extensionName, token), invocation);
    return invocation;
  }

  private clearTrackedInvocation(invocation: ExtensionInvocation): void {
    if (invocation.invocationToken) {
      this.activeInvocations.delete(
        this.invocationKey(invocation.extensionName, invocation.invocationToken)
      );
    }
  }

  private invocationKey(extensionName: string, invocationToken: string): string {
    return `${extensionName}\x00${invocationToken}`;
  }

  /**
   * Pure lookup for the invoke path — never installs or builds.
   * Returns the running-eligible registry entry, or null. Trust is granted at
   * declaration time (startup / meta-change reconcile), not at invocation.
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
    return entry?.activeBundleKey ? entry : null;
  }

  async handleExtensionHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
    remainderPath: string,
    caller: VerifiedCaller
  ): Promise<void> {
    const entry = this.registry.get(name);
    if (!entry) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end(`Extension is not installed: ${name}`);
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
      const response = await this.deps.extensionTransport.call(
        name,
        "extension.fetch",
        requestEnvelope,
        invocation
      );
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

  private registerRequestBody(
    extensionName: string,
    req: IncomingMessage
  ): StreamEnvelope | undefined {
    if (req.method === "GET" || req.method === "HEAD") return undefined;
    const contentLengthHeader = req.headers["content-length"];
    if (typeof contentLengthHeader === "string") {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > EXTENSION_REQUEST_BODY_MAX_BYTES) {
        const err = new Error(
          `Request body exceeds the ${EXTENSION_REQUEST_BODY_MAX_BYTES}-byte extension fetch limit`
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
    body: BodyEnvelope | string
  ): Promise<void> {
    if (!isStreamEnvelope(body)) {
      await writeInlineResponseBody(res, body);
      return;
    }
    try {
      while (true) {
        const next = (await this.deps.extensionTransport.call(
          extensionName,
          "extension.fetchResponseBodyChunk",
          body.id
        )) as StreamChunkEnvelope;
        if (next.done) break;
        if (next.chunk) {
          await writeResponseChunk(res, Buffer.from(next.chunk.data, "base64"));
        }
      }
      const finished = waitForResponseFinish(res);
      res.end();
      await finished;
    } finally {
      await this.deps.extensionTransport
        .call(extensionName, "extension.fetchResponseBodyClose", body.id)
        .catch(() => {});
    }
  }

  private subscribe(ctx: ServiceContext, name: string, event: string): null {
    const eventName = `extensions:${name}::${event}` as const;
    const subscriber = this.deps.eventService.getOrCreateSubscriber(ctx);
    this.deps.eventService.subscribe(
      eventName,
      ctx.caller.runtime.id,
      subscriber,
      ctx.connectionId
    );
    return null;
  }

  private emitFromExtension(ctx: ServiceContext, event: string, payload: unknown): null {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError(
        "extensions",
        "emit",
        "Only extensions can emit extension events",
        "EACCES"
      );
    }
    this.deps.eventService.emit(
      `extensions:${ctx.caller.runtime.id}::${event}` as EventName,
      payload
    );
    return null;
  }

  private async fetchRequestBodyChunk(
    ctx: ServiceContext,
    streamId: string
  ): Promise<StreamChunkEnvelope> {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError(
        "extensions",
        "fetchRequestBodyChunk",
        "Only extensions can read extension fetch request bodies",
        "EACCES"
      );
    }
    const stream = this.fetchRequestBodies.get(streamId);
    if (!stream || stream.extensionName !== ctx.caller.runtime.id) {
      throw new ServiceError(
        "extensions",
        "fetchRequestBodyChunk",
        `Unknown extension fetch request body stream: ${streamId}`,
        "ENOENT"
      );
    }
    return readNextBodyChunk(stream);
  }

  private async fetchRequestBodyClose(ctx: ServiceContext, streamId: string): Promise<null> {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError(
        "extensions",
        "fetchRequestBodyClose",
        "Only extensions can close extension fetch request bodies",
        "EACCES"
      );
    }
    const stream = this.fetchRequestBodies.get(streamId);
    if (!stream || stream.extensionName !== ctx.caller.runtime.id) return null;
    await this.closeFetchRequestBody(streamId);
    return null;
  }

  private readyFromExtension(
    ctx: ServiceContext,
    ready: { methods: string[]; hasFetch: boolean }
  ): null {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError(
        "extensions",
        "ready",
        "Only extensions can complete extension startup",
        "EACCES"
      );
    }
    this.processes.markReady(ctx.caller.runtime.id, ready);
    return null;
  }

  private healthFromExtension(
    ctx: ServiceContext,
    state: ExtensionHealth["state"],
    detail: unknown
  ): null {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError(
        "extensions",
        "health",
        "Only extensions can report extension health",
        "EACCES"
      );
    }
    const healthDetail = detail as
      | { summary?: string; reasons?: string[]; retryAt?: number }
      | undefined;
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
    fields?: Record<string, unknown>
  ): null {
    if (ctx.caller.runtime.kind !== "extension") {
      throw new ServiceError(
        "extensions",
        "log",
        "Only extensions can write extension logs",
        "EACCES"
      );
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
    const baseByName = new Map(
      this.unitHost.listWorkspaceUnits().map((entry) => [entry.name, entry])
    );
    return this.registry.list().map((entry) => {
      const node = this.findExtensionNode(entry.name);
      const base = baseByName.get(entry.name) ?? extensionWorkspaceStatusFallback(entry, node);
      const running = runningByName.get(entry.name);
      const lastBuiltAt = this.resolveBundleMtime(entry);
      const pendingApproval =
        entry.status === "pending-approval"
          ? {
              kind: entry.activeBundleKey ? "extension.update" : "extension.install",
              submittedAt: entry.installedAt,
            }
          : null;
      const availableUpdate =
        entry.activeBundleKey && this.needsBuildRefresh(entry, node)
          ? { reason: "dependency" as const, checkedAt: Date.now() }
          : null;
      return {
        ...base,
        lastBuiltAt,
        pendingApproval,
        availableUpdate,
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
      return Math.floor(fs.statSync(extensionPrimaryArtifactPath(build)).mtimeMs);
    } catch {
      return null;
    }
  }

  listWorkspaceUnitLogs(
    name: string,
    opts?: { since?: number; level?: "debug" | "info" | "warn" | "error"; limit?: number }
  ): UnitLogRecord[] {
    const logs = this.unitLogs.get(name) ?? [];
    const minLevel = opts?.level ? LOG_LEVEL_RANK[opts.level] : null;
    const filtered = logs.filter(
      (record) =>
        (opts?.since === undefined || record.timestamp >= opts.since) &&
        (minLevel === null || LOG_LEVEL_RANK[record.level] >= minLevel)
    );
    const limit = opts?.limit && opts.limit > 0 ? Math.min(Math.floor(opts.limit), 1000) : 200;
    return filtered.slice(-limit);
  }

  async authorizeSourceChange(request: {
    caller: VerifiedCaller;
    repoPath: string;
    branch: string;
    commit: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const repoPath = normalizeRepoPath(request.repoPath);
    if (repoPath === "meta") {
      return { allowed: true };
    }
    return authorizeUnitSourceChange(
      {
        descriptor: EXTENSION_UNIT_DESCRIPTOR,
        grantStore: this.sourceChangeGrants,
        grantTtlMs: EXTENSION_DEV_SESSION_TTL_MS,
        findInstalledByRepo: (source) => this.unitHost.findInstalledByRepo(source),
        requestApproval: async ({ request: sourceChange, installed, identity, callerKind }) =>
          this.deps.approvalQueue.request({
            kind: "unit-batch",
            callerId: sourceChange.caller.runtime.id,
            callerKind,
            repoPath: identity.repoPath,
            effectiveVersion: identity.effectiveVersion,
            dedupKey: `unit-source-change:extension:${installed.entry.name}:${sourceChange.branch}`,
            trigger: "source-change",
            title: `${installed.entry.name} source change`,
            description: "Accepting this push updates trusted native extension code.",
            units: [
              {
                ...this.buildBatchEntry(installed.node, installed.entry.source.ref),
                ev: installed.entry.activeEv,
              },
            ],
            configWrite: null,
          }),
      },
      request
    );
  }

  private async readDeclaredExtensionsFromCommit(commit: string): Promise<UnitDeclaration[]> {
    try {
      const content = await this.deps.readWorkspaceFileAtCommit(commit, "meta/natstack.yml");
      if (!content) return [];
      return resolveDeclaredExtensions(
        parseWorkspaceConfigContentWithId(content, this.deps.workspaceId)
      );
    } catch {
      return [];
    }
  }

  private buildBatchEntry(
    node: ReturnType<ExtensionHost["findExtensionNode"]>,
    ref: string
  ): UnitBatchEntry {
    return {
      ...createUnitBatchEntryBase({
        unitKind: "extension",
        name: node.name,
        displayName: node.manifest.displayName,
        version: this.readNodeVersion(node.path),
        sourceRepo: node.relativePath,
        ref,
        effectiveVersion: this.deps.buildSystem.getEffectiveVersion(node.name),
        dependencyEvs: this.currentDependencyEvs(node),
        externalDeps: this.currentExternalDeps(node),
      }),
      target: null,
      capabilities: extensionRuntimeCapabilities(),
    };
  }

  private declarationBuildIdentity(
    node: ReturnType<ExtensionHost["findExtensionNode"]>,
    ref: string
  ): UnitBuildIdentity<"extension"> {
    return createUnitBuildIdentity({
      unitKind: "extension" as const,
      name: node.name,
      sourceRepo: node.relativePath,
      ref,
      effectiveVersion: this.deps.buildSystem.getEffectiveVersion(node.name),
      dependencyEvs: this.currentDependencyEvs(node),
      externalDeps: this.currentExternalDeps(node),
      capabilities: extensionRuntimeCapabilities(),
    });
  }

  private registryEntryBuildIdentity(entry: RegistryEntry): UnitBuildIdentity<"extension"> {
    return unitBuildIdentityFromRegistryEntry(entry, extensionRuntimeCapabilities());
  }

  private registerBuildProvidersFor(entry: RegistryEntry): void {
    const nextTargets = new Set(this.buildProviderTargetsFor(entry.name));
    this.unregisterStaleBuildProvidersFor(entry.name, nextTargets);
    if (!this.deps.registerBuildProvider) {
      if (nextTargets.size === 0) this.registeredBuildProviderTargets.delete(entry.name);
      return;
    }
    for (const target of nextTargets) {
      this.deps.registerBuildProvider({
        name: entry.name,
        target,
        contractVersion: "natstack-build-provider-v1",
        activeEv: entry.activeEv,
        activeBuildKey: entry.activeBundleKey,
        build: async (input) => {
          const invocation: ExtensionInvocation = {
            requestId: randomUUID(),
            extensionName: entry.name,
            method: "build",
            caller: {
              callerId: "server:build-system",
              callerKind: "server",
            },
          };
          const output = await this.deps.extensionTransport.call(
            entry.name,
            "extension.invoke",
            "build",
            [input],
            invocation
          );
          return assertBuildProviderOutput(entry.name, target, output);
        },
        streamArtifact: async (artifact, input) => {
          if (!artifact.stream) {
            throw new Error(
              `Build provider ${entry.name} artifact ${artifact.path} is not stream-backed`
            );
          }
          if (!this.deps.extensionTransport.streamCallTarget) {
            throw new Error(`Build provider ${entry.name} streaming transport is unavailable`);
          }
          const invocation: ExtensionInvocation = {
            requestId: randomUUID(),
            extensionName: entry.name,
            method: artifact.stream.method,
            caller: {
              callerId: "server:build-system",
              callerKind: "server",
            },
          };
          return this.deps.extensionTransport.streamCallTarget(
            entry.name,
            "extension.invokeStream",
            artifact.stream.method,
            artifact.stream.args ?? [artifact.path, input],
            invocation
          );
        },
      });
    }
    if (nextTargets.size > 0) this.registeredBuildProviderTargets.set(entry.name, nextTargets);
    else this.registeredBuildProviderTargets.delete(entry.name);
  }

  private unregisterBuildProvidersFor(name: string): void {
    if (!this.deps.unregisterBuildProvider) return;
    const targets =
      this.registeredBuildProviderTargets.get(name) ?? new Set(this.buildProviderTargetsFor(name));
    for (const target of targets) {
      this.deps.unregisterBuildProvider(target, name);
    }
    this.registeredBuildProviderTargets.delete(name);
  }

  private unregisterStaleBuildProvidersFor(
    name: string,
    nextTargets: ReadonlySet<BuildProviderTarget>
  ): void {
    if (!this.deps.unregisterBuildProvider) return;
    const previousTargets = this.registeredBuildProviderTargets.get(name);
    if (!previousTargets) return;
    for (const target of previousTargets) {
      if (!nextTargets.has(target)) {
        this.deps.unregisterBuildProvider(target, name);
      }
    }
  }

  private buildProviderTargetsFor(name: string): BuildProviderTarget[] {
    try {
      const targets =
        this.findExtensionNode(name).manifest.extension?.contributes?.buildTargets ?? [];
      return targets.filter((target): target is BuildProviderTarget => target === "react-native");
    } catch {
      return [];
    }
  }

  async activate(name: string): Promise<void> {
    const entry = this.registry.get(name);
    if (!entry?.activeBundleKey) throw new Error(`Extension has no active approved build: ${name}`);
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    if (!build) {
      throw new Error(
        `Approved extension build is missing from build store: ${entry.activeBundleKey}`
      );
    }
    const token = this.deps.tokenManager.ensureToken(name, "extension");
    this.registry.patch(name, { status: "building", lastError: null });
    await this.processes.start({
      name,
      version: entry.version,
      bundlePath: extensionPrimaryArtifactPath(build),
      storageDir: this.storageDirFor(name),
      gatewayUrl: this.deps.getGatewayUrl(),
      rpcToken: token,
    });
    this.registerBuildProvidersFor(entry);
  }

  private async buildAndActivate(name: string, ref?: string): Promise<void> {
    const node = this.findExtensionNode(name);
    const previous = this.registry.get(node.name);
    this.unitHost.markBuilding(node.name);
    const build = await this.deps.buildSystem.getBuild(node.name, ref);
    const activeSourceHash = requireBuildSourceStateHash(node.name, build);
    const activeDependencyEvs = this.currentDependencyEvs(node);
    const activeExternalDeps = this.currentExternalDeps(node);
    this.unitHost.activateBuild({
      name: node.name,
      version: this.readNodeVersion(node.path),
      sourceRepo: node.relativePath,
      ref: ref ?? "main",
      buildDir: build.dir,
      effectiveVersion: build.metadata.ev,
      activeSourceHash,
      dependencyEvs: activeDependencyEvs,
      externalDeps: activeExternalDeps,
      runtimeDepsKey: extensionMetadataDetails(build.metadata)?.runtimeDepsKey ?? null,
      status: "building",
    });
    try {
      await this.activate(node.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (previous?.activeBundleKey) {
        this.registry.patch(node.name, {
          activeEv: previous.activeEv,
          activeSourceHash: previous.activeSourceHash,
          activeBundleKey: previous.activeBundleKey,
          activeDependencyEvs: previous.activeDependencyEvs,
          activeExternalDeps: previous.activeExternalDeps ?? {},
          activeRuntimeDepsKey: previous.activeRuntimeDepsKey,
          status: "error",
          lastError: message,
        });
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
      } else {
        this.registry.patch(node.name, {
          activeEv: previous?.activeEv ?? null,
          activeSourceHash: previous?.activeSourceHash ?? null,
          activeBundleKey: previous?.activeBundleKey ?? null,
          activeDependencyEvs: previous?.activeDependencyEvs ?? {},
          activeExternalDeps: previous?.activeExternalDeps ?? {},
          activeRuntimeDepsKey: previous?.activeRuntimeDepsKey ?? null,
          status: "error",
          lastError: message,
        });
      }
      throw err;
    }
  }

  private async handleChangedExtensionUnit(event: {
    name: string;
    relativePath: string;
    trigger?: { head: string };
  }): Promise<void> {
    const installed =
      this.registry.get(event.name) ??
      this.registry
        .list()
        .find(
          (candidate) =>
            normalizeRepoPath(candidate.source.repo) === normalizeRepoPath(event.relativePath)
        );
    if (!installed) return;
    if (!this.sourceChangeAppliesToEntry(event.trigger, installed)) return;
    await this.handleSourceRebuilt(installed.source.repo, event.trigger);
  }

  private sourceChangeAppliesToEntry(
    trigger: { head: string } | undefined,
    entry: RegistryEntry
  ): boolean {
    if (!trigger?.head) return true;
    return normalizeRef(trigger.head) === normalizeRef(entry.source.ref);
  }

  private async handleSourceRebuilt(source: string, trigger?: { head: string }): Promise<void> {
    const installed = this.unitHost.findInstalledByRepo(source);
    if (!installed) return;
    if (!this.sourceChangeAppliesToEntry(trigger, installed.entry)) return;
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

  private currentDependencyEvs(
    node: ReturnType<ExtensionHost["findExtensionNode"]>
  ): Record<string, string> {
    return collectTransitiveUnitDependencyEvs(
      this.deps.buildSystem.getGraph().allNodes(),
      node,
      (name) => this.deps.buildSystem.getEffectiveVersion(name)
    );
  }

  private currentExternalDeps(
    node: ReturnType<ExtensionHost["findExtensionNode"]>
  ): Record<string, string> {
    return this.deps.buildSystem.getExternalDeps(node.name);
  }

  private needsBuildRefresh(
    entry: RegistryEntry,
    node: ReturnType<ExtensionHost["findExtensionNode"]>
  ): boolean {
    const currentExternalDeps = this.currentExternalDeps(node);
    if (
      this.unitHost.needsBuildRefresh(entry, {
        sourceRepo: node.relativePath,
        ref: entry.source.ref,
        effectiveVersion: this.deps.buildSystem.getEffectiveVersion(node.name),
        dependencyEvs: this.currentDependencyEvs(node),
        externalDeps: currentExternalDeps,
      })
    ) {
      return true;
    }
    if (!this.hasCurrentExtensionRuntimeAbi(entry)) return true;
    return Object.keys(currentExternalDeps).length > 0 && !this.hasUsableActiveRuntimeDeps(entry);
  }

  private hasCurrentExtensionRuntimeAbi(entry: RegistryEntry): boolean {
    if (!entry.activeBundleKey) return false;
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    return extensionMetadataDetails(build?.metadata)?.runtimeAbi === EXTENSION_RUNTIME_ABI_VERSION;
  }

  private hasUsableActiveRuntimeDeps(entry: RegistryEntry): boolean {
    if (!entry.activeBundleKey || !entry.activeRuntimeDepsKey) return false;
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    if (!build) return false;
    const externalDeps = extensionMetadataDetails(build.metadata)?.externalDeps ?? {};
    if (Object.keys(externalDeps).length === 0) return true;
    return fs.existsSync(path.join(build.dir, "node_modules"));
  }

  private findExtensionNode(nameOrRepo: string) {
    const node = findUnitGraphNode(
      this.deps.buildSystem.getGraph().allNodes(),
      EXTENSION_UNIT_DESCRIPTOR,
      nameOrRepo
    );
    const events = node.manifest.extension?.activationEvents ?? ["*"];
    if (events.some((event) => event !== "*")) {
      throw new Error(`Extension ${node.name} only supports eager activation in v1`);
    }
    return node;
  }

  private storageDirFor(name: string): string {
    return path.join(
      this.deps.statePath,
      "extensions",
      "storage",
      this.deps.workspaceId,
      encodeURIComponent(name)
    );
  }

  private readNodeVersion(nodePath: string): string {
    const pkg = JSON.parse(fs.readFileSync(path.join(nodePath, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  }

  private async reloadApproval(ctx: ServiceContext, name: string): Promise<void> {
    // Trusted internal callers (CLI shell) are pre-authorized and skip the
    // prompt. Panels, workers, and DOs go through approval. Other caller kinds
    // are rejected.
    if (ctx.caller.runtime.kind === "shell") return;
    if (
      ctx.caller.runtime.kind !== "panel" &&
      ctx.caller.runtime.kind !== "app" &&
      ctx.caller.runtime.kind !== "worker" &&
      ctx.caller.runtime.kind !== "do"
    ) {
      throw new ServiceError(
        "extensions",
        "reload",
        `Extension reload is not available to ${ctx.caller.runtime.kind} callers`,
        "EACCES"
      );
    }
    const identity = ctx.caller.code;
    if (!identity || identity.callerKind !== ctx.caller.runtime.kind) {
      throw new ServiceError(
        "extensions",
        "reload",
        `Unknown caller identity: ${ctx.caller.runtime.id}`,
        "ENOENT"
      );
    }
    const node = this.findExtensionNode(name);
    const entry = this.registry.get(node.name);
    const source = entry?.source ?? {
      kind: "workspace-repo" as const,
      repo: node.relativePath,
      ref: "main",
    };
    const decision = await this.deps.approvalQueue.request({
      kind: "unit-batch",
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      dedupKey: `unit-management:extension:reload:${node.name}`,
      trigger: "management",
      title: "Reload extension",
      description: `Allow ${ctx.caller.runtime.kind} ${ctx.caller.runtime.id} to reload ${name}.`,
      units: [
        {
          unitKind: "extension",
          unitName: node.name,
          displayName: node.manifest.displayName ?? node.name,
          version: entry?.version ?? this.readNodeVersion(node.path),
          target: null,
          source,
          ev: entry?.activeEv ?? null,
          capabilities: extensionRuntimeCapabilities(),
          dependencyEvs: entry?.activeDependencyEvs ?? this.currentDependencyEvs(node),
          externalDeps: entry?.activeExternalDeps ?? this.currentExternalDeps(node),
        },
      ],
      configWrite: null,
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
    source: UnitLogRecord["source"] = "ctx.log"
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
    this.deps.recordUnitLog?.(record);
    this.deps.eventService.emit("workspace:unit-log", record);
  }

  private rememberExtensionError(name: string, error: string, attempts: number): void {
    const items = this.extensionErrorHistory.get(name) ?? [];
    items.push({ attempts, error, timestamp: Date.now() });
    if (items.length > 20) {
      items.splice(0, items.length - 20);
    }
    this.extensionErrorHistory.set(name, items);
  }
}

interface ExtensionErrorHistoryItem {
  attempts: number;
  error: string;
  timestamp: number;
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
      `Request body exceeds the ${EXTENSION_REQUEST_BODY_MAX_BYTES}-byte extension fetch limit`
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

async function writeInlineResponseBody(
  res: ServerResponse,
  body: BinaryEnvelope | string
): Promise<void> {
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

function extensionMetadataDetails(metadata: ExtensionBuildMetadataLike | undefined): {
  kind: "extension";
  runtimeDepsKey?: string | null;
  runtimeAbi?: string | null;
  externalDeps?: Record<string, string>;
} | null {
  const details = metadata?.details;
  if (details?.kind !== "extension") return null;
  return details as {
    kind: "extension";
    runtimeDepsKey?: string | null;
    runtimeAbi?: string | null;
    externalDeps?: Record<string, string>;
  };
}

function requireBuildSourceStateHash(
  unitName: string,
  build: {
    sourceStateHash?: string | null;
    metadata: ExtensionBuildMetadataLike;
  }
): string {
  if (build.sourceStateHash) return build.sourceStateHash;
  if (build.metadata.sourceStateHash) return build.metadata.sourceStateHash;
  throw new Error(`Build for ${unitName} is missing workspace source state provenance`);
}

function extensionPrimaryArtifactPath(build: {
  dir: string;
  artifacts: ExtensionBuildArtifactLike[];
}): string {
  const artifact =
    build.artifacts.find((entry) => entry.role === "primary" && entry.platform === undefined) ??
    build.artifacts.find((entry) => entry.role === "primary");
  if (!artifact) {
    throw new Error("Extension build has no primary artifact");
  }
  if (path.isAbsolute(artifact.path) || artifact.path.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid extension build artifact path: ${artifact.path}`);
  }
  return path.join(build.dir, artifact.path);
}

const EXTENSION_DEV_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

function extensionRuntimeCapabilities(): string[] {
  return ["node:fs", "node:child_process", "node:net", "node:process", "userland:*"];
}

function assertBuildProviderOutput(
  providerName: string,
  target: BuildProviderTarget,
  value: unknown
): BuildProviderOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Build provider ${providerName} for ${target} returned a non-object output`);
  }
  const output = value as Partial<BuildProviderOutput>;
  if (
    !Array.isArray(output.artifacts) ||
    output.artifacts.some(
      (artifact) =>
        !artifact ||
        typeof artifact !== "object" ||
        typeof artifact.path !== "string" ||
        typeof artifact.role !== "string" ||
        typeof artifact.contentType !== "string" ||
        (typeof artifact.content !== "string" && !isBuildProviderArtifactStream(artifact.stream)) ||
        (artifact.encoding !== undefined &&
          artifact.encoding !== "utf8" &&
          artifact.encoding !== "base64")
    )
  ) {
    throw new Error(`Build provider ${providerName} for ${target} returned invalid artifacts`);
  }
  return {
    artifacts: output.artifacts,
    ...(output.metadata ? { metadata: output.metadata } : {}),
  };
}

function extensionWorkspaceStatusFallback(
  entry: RegistryEntry,
  node: ReturnType<ExtensionHost["findExtensionNode"]>
): UnitWorkspaceStatus<"extension"> {
  return {
    name: entry.name,
    kind: "extension",
    source: node.relativePath,
    displayName: node.manifest.displayName ?? entry.name,
    status: entry.status,
    version: entry.version,
    ev: entry.activeEv,
    activeEv: entry.activeEv,
    activeBundleKey: entry.activeBundleKey,
    activeRuntimeDepsKey: entry.activeRuntimeDepsKey,
    lastError: entry.lastError,
  };
}

function isBuildProviderArtifactStream(
  value: unknown
): value is { method: string; args?: unknown[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stream = value as { method?: unknown; args?: unknown };
  return (
    typeof stream.method === "string" &&
    stream.method.trim().length > 0 &&
    (stream.args === undefined || Array.isArray(stream.args))
  );
}

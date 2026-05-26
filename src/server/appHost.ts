import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  UnitHost,
  UnitRegistry,
  UnitSourcePushGrantStore,
  UnitTrustResolver,
  authorizeUnitSourcePush,
  collectTransitiveUnitDependencyEvs,
  createPendingUnitRegistryEntry,
  createUnitBuildIdentity,
  createUnitBatchEntryBase,
  findUnitGraphNode,
  normalizeUnitRepoPath as normalizeRepoPath,
  requestUnitBatchApproval,
  unitBuildIdentityFromRegistryEntry,
  type UnitBuildIdentity,
  type UnitDeclaration,
  type UnitDescriptor,
  type UnitApprovalCoordinator,
  type UnitReconcileTrigger,
  type UnitRegistryEntryBase,
} from "@natstack/unit-host";
import { execGitFileSync } from "@natstack/shared/gitRuntime";
import type { EventService } from "@natstack/shared/eventsService";
import type { EventName } from "@natstack/shared/events";
import type { PendingUnitBatchApproval, UnitBatchEntry } from "@natstack/shared/approvals";
import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { verifyProductSeedSource } from "@natstack/shared/productSeedTrust";
import {
  parseWorkspaceConfigContentWithId,
  resolveDeclaredApps,
} from "@natstack/shared/workspace/configParser";
import {
  UnitManifestError,
  appUnitManifestDescriptor,
  readAndValidateUnitManifest,
  type AppCapability,
  type WorkspaceAppTarget,
} from "@natstack/shared/unitManifest";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetSelection,
  HostTargetSelectionInput,
} from "@natstack/shared/hostTargets";
import type { EntityCache } from "@natstack/shared/runtime/entityCache";
import type { EntityRecord } from "@natstack/shared/runtime/entitySpec";
import { writeAppDistBake, type AppDistBakeManifest } from "./buildV2/distBake.js";
import type { BuildArtifactManifestEntry, BuildMetadata } from "./buildV2/buildStore.js";
import {
  createCapabilityAuthorizer,
  type CapabilityAuthorizer,
} from "./services/capabilityAuthorizer.js";
import type { ConnectionGrantService } from "@natstack/shared/connectionGrants";
import { TerminalAppRunner } from "./terminalAppRunner.js";

const APP_UNIT_DESCRIPTOR: UnitDescriptor<"app"> = {
  kind: "app",
  sourceRoot: "apps",
  buildKind: "app",
  approvalFraming: {
    serviceName: "apps",
    unitLabel: "app",
    unitLabelPlural: "apps",
    nativeCode: false,
  },
  seedTrustEligible: true,
};
const APP_ROLLBACK_HISTORY_LIMIT = 5;

export interface AppUpdateErrorDiagnostic {
  phase: "build" | "target-validation" | "activation";
  target?: WorkspaceAppTarget;
  buildKey?: string | null;
  source: string;
}

export interface WorkspaceAppDeclaration extends UnitDeclaration {
  target?: WorkspaceAppTarget;
  autostart?: boolean;
}

export interface AppRegistryEntry extends UnitRegistryEntryBase {
  unitKind: "app";
  target: WorkspaceAppTarget;
  autostart: boolean;
  capabilities: AppCapability[];
  previousVersions: AppVersionRecord[];
  lastErrorDetails?: AppUpdateErrorDiagnostic | null;
}

export interface AppVersionRecord {
  version: string;
  target: WorkspaceAppTarget;
  autostart: boolean;
  capabilities: AppCapability[];
  activeEv: string | null;
  activeSha: string | null;
  activeBundleKey: string;
  activeDependencyEvs: Record<string, string>;
  activeExternalDeps: Record<string, string>;
  activeRuntimeDepsKey: string | null;
  activatedAt: number;
}

export interface ReactNativeAppBootstrap {
  appId: string;
  buildKey: string;
  effectiveVersion: string | null;
  capabilities: AppCapability[];
  rnHostAbi: string;
  integrity: string;
  artifacts: Array<{
    path: string;
    role: string;
    contentType: string;
    encoding: string;
    platform?: string;
    integrity: string;
    url: string;
  }>;
  provider?: AppBuildProviderDetails | null;
}

interface BuildSystemLike {
  getBuild(
    unitPath: string,
    ref?: string
  ): Promise<{ dir: string; metadata: AppBuildMetadataLike; artifacts?: AppBuildArtifactLike[] }>;
  getBuildByKey?(
    key: string
  ): { dir: string; metadata: AppBuildMetadataLike; artifacts?: AppBuildArtifactLike[] } | null;
  getEffectiveVersion(unitName: string): string | null;
  getExternalDeps(unitName: string): Record<string, string>;
  getBuildProviderDetails?(target: "react-native"): AppBuildProviderDetails | null;
  onBuildProviderChange?(
    callback: (event: {
      type: "registered" | "unregistered";
      target: "react-native";
      provider: AppBuildProviderDetails;
    }) => void
  ): () => void;
  getGraph(): {
    allNodes(): AppGraphNode[];
  };
  onPushBuild(callback: (source: string) => void): void;
}

interface HostTargetSelectionState {
  selections?: HostTargetSelection[];
}

interface AppBuildArtifactLike {
  path: string;
  role: string;
  contentType: string;
  encoding: string;
  platform?: string;
  integrity?: string;
  content: string;
}

interface AppBuildProviderDetails {
  name: string;
  activeEv: string | null;
  activeBuildKey: string | null;
  contractVersion: string;
}

interface AppGraphNode {
  name: string;
  kind: string;
  relativePath: string;
  path: string;
  internalDeps: string[];
  manifest: {
    displayName?: string;
    app?: { target?: WorkspaceAppTarget; capabilities?: AppCapability[] };
  };
}

interface AppBuildMetadataLike {
  ev: string;
  details?:
    | {
        kind: "app";
        target: WorkspaceAppTarget;
        integrity?: string | null;
        rnHostAbi?: string | null;
        provider?: {
          name: string;
          activeEv: string | null;
          activeBuildKey: string | null;
          contractVersion: string;
        } | null;
      }
    | { kind: string };
}

interface ApprovalQueueLike {
  request(req: {
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
  }): Promise<"once" | "session" | "version" | "repo" | "deny">;
}

interface NotificationServiceLike {
  show(notification: {
    id?: string;
    type: "info" | "error" | "success" | "warning";
    title: string;
    message?: string;
    ttl?: number;
    actions?: Array<{
      id: string;
      label: string;
      variant?: "solid" | "soft" | "ghost";
      command?:
        | { type: "app.applyUpdate"; appId: string }
        | { type: "app.rollback"; appId: string; buildKey?: string }
        | { type: "workspace.restartUnit"; name: string };
    }>;
  }): string;
}

export interface AppHostDeps {
  statePath: string;
  workspacePath: string;
  workspaceId: string;
  buildSystem: BuildSystemLike;
  eventService: EventService;
  approvalQueue: ApprovalQueueLike;
  notificationService?: NotificationServiceLike;
  approvalCoordinator?: UnitApprovalCoordinator<UnitBatchEntry>;
  entityCache?: Pick<EntityCache, "resolve" | "listActive" | "_onActivate" | "_onRetire">;
  connectionGrants?: Pick<ConnectionGrantService, "grant" | "revokeForPrincipal">;
  getGatewayUrl(): string;
}

export class AppHost {
  readonly registry: UnitRegistry<AppRegistryEntry>;
  private readonly trustResolver: UnitTrustResolver<AppRegistryEntry>;
  private readonly unitHost: UnitHost<
    AppRegistryEntry,
    WorkspaceAppDeclaration,
    AppGraphNode,
    UnitBatchEntry
  >;
  private readonly sourcePushGrants: UnitSourcePushGrantStore;
  private readonly terminalRunner: TerminalAppRunner | null;
  private readonly appLogs = new Map<
    string,
    Array<{
      workspaceId: string;
      unitName: string;
      kind: "app";
      timestamp: number;
      level: "info" | "error";
      message: string;
      source?: "stdout" | "stderr" | "runner";
    }>
  >();
  private lastDeclared: WorkspaceAppDeclaration[] = [];
  private lastDirtyDevDiagnosticKey: string | null = null;

  constructor(private readonly deps: AppHostDeps) {
    this.registry = new UnitRegistry<AppRegistryEntry>({
      statePath: deps.statePath,
      unitKind: "app",
      normalizeEntry: (entry) => ({
        ...entry,
        activeDependencyEvs: entry.activeDependencyEvs ?? {},
        activeExternalDeps: entry.activeExternalDeps ?? {},
        capabilities: entry.capabilities ?? [],
        autostart: entry.autostart ?? false,
        previousVersions: entry.previousVersions ?? [],
        lastErrorDetails: entry.lastErrorDetails ?? null,
      }),
    });
    this.sourcePushGrants = new UnitSourcePushGrantStore({ statePath: deps.statePath });
    this.terminalRunner =
      deps.connectionGrants && deps.entityCache
        ? new TerminalAppRunner({
            connectionGrants: deps.connectionGrants,
            onStatus: (appId, status, error = null) =>
              this.updateTerminalRuntimeStatus(appId, status, error),
            onLog: (appId, level, message, source) =>
              this.recordAppLog(appId, level, message, source),
          })
        : null;
    this.trustResolver = new UnitTrustResolver<AppRegistryEntry>({
      entryIdentity: (entry) => this.registryEntryIdentity(entry),
      productSeedTrust: (identity) =>
        verifyProductSeedSource({
          unitDir: path.join(this.deps.workspacePath, identity.source.repo),
          identity,
        }) !== null,
    });
    this.unitHost = new UnitHost({
      descriptor: APP_UNIT_DESCRIPTOR,
      registry: this.registry,
      currentDeclarationVersion: () =>
        resolveGitCommit(path.join(this.deps.workspacePath, "meta"), "HEAD"),
      resolveNode: (source) => this.findAppNode(source),
      candidateIdentity: (node, decl) => this.declarationIdentity(node, decl),
      trustResolver: this.trustResolver,
      makePendingEntry: (node, decl, building) => this.pendingEntryFor(node, decl, building),
      applyTrusted: (node, decl) => this.applyDeclared(node, decl),
      applyUntrustedDisabled: async (node) => {
        const entry = this.registry.get(node.name);
        await this.stopTerminalApp(node.name);
        if (entry) this.retireDeviceScopedAppEntities(entry);
        this.retireAppEntity(node.name);
        this.emitStatus(node.name, "stopped", null);
      },
      removeUndeclared: async (entry) => {
        await this.stopTerminalApp(entry.name);
        this.retireDeviceScopedAppEntities(entry);
        this.retireAppEntity(entry.name);
        this.emitStatus(entry.name, "stopped", null);
      },
      emitRemoved: (entry) => {
        this.deps.eventService.emit("apps:status" as EventName, {
          name: entry.name,
          status: "stopped",
          error: null,
        });
      },
      notifyUnresolved: (sources) => {
        this.deps.notificationService?.show({
          id: `apps-unresolved-${encodeURIComponent(sources.join(","))}`,
          type: "error",
          title: "Unknown apps declared",
          message: `meta/natstack.yml declares apps that don't exist: ${sources.join(", ")}.`,
        });
      },
      approvalEntry: (node, decl) => this.buildBatchEntry(node, decl),
      requestApproval: (entries, trigger) =>
        requestUnitBatchApproval({
          descriptor: APP_UNIT_DESCRIPTOR,
          approvalQueue: this.deps.approvalQueue,
          entries,
          trigger,
        }),
      approvalCoordinator: deps.approvalCoordinator,
      onApprovalDenied: (items) => {
        for (const { node } of items) this.emitStatus(node.name, "pending-approval", null);
      },
      onBackgroundError: (err) => {
        console.error(
          "[AppHost] Background app approval flow failed:",
          err instanceof Error ? err.message : String(err)
        );
      },
    });
    deps.buildSystem.onPushBuild((source) => {
      this.handleSourceRebuilt(source).catch((err) => {
        console.error(
          `[AppHost] Failed to reload rebuilt app source ${source}:`,
          err instanceof Error ? err.message : String(err)
        );
      });
    });
    deps.buildSystem.onBuildProviderChange?.((event) => {
      if (event.target !== "react-native") return;
      this.reconcileAfterProviderChange(event.provider.name).catch((err) => {
        console.error(
          `[AppHost] Failed to reconcile apps after provider change ${event.provider.name}:`,
          err instanceof Error ? err.message : String(err)
        );
      });
    });
  }

  async reconcileDeclared(
    declared: WorkspaceAppDeclaration[],
    opts: { trigger?: UnitReconcileTrigger } = {}
  ): Promise<void> {
    this.lastDeclared = declared.map((decl) => ({ ...decl }));
    await this.unitHost.reconcileDeclared(declared, opts);
    this.emitDevStatusDiagnostic(opts.trigger ?? "startup");
  }

  async whenSettled(): Promise<void> {
    await this.unitHost.whenSettled();
  }

  async shutdown(): Promise<void> {
    await this.terminalRunner?.stopAll();
  }

  acceptPreapprovedTrust(version: string, keys: Iterable<string>): void {
    this.unitHost.acceptPreapprovedTrust(version, keys);
  }

  listWorkspaceUnits(): Array<{
    name: string;
    kind: "app";
    source: string;
    displayName: string;
    enabled: boolean;
    status: AppRegistryEntry["status"];
    version: string;
    ev: string | null;
    activeEv: string | null;
    activeBundleKey: string | null;
    activeRuntimeDepsKey: string | null;
    lastError: string | null;
    lastErrorDetails?: AppUpdateErrorDiagnostic | null;
    target: WorkspaceAppTarget;
    canRollback: boolean;
    rollbackRetentionLimit: number;
    previousVersions: AppVersionRecord[];
  }> {
    return this.unitHost.listWorkspaceUnits().map((row) => {
      const entry = this.registry.get(row.name);
      return {
        ...row,
        target: entry?.target ?? "electron",
        canRollback: !!entry?.previousVersions?.length,
        rollbackRetentionLimit: APP_ROLLBACK_HISTORY_LIMIT,
        lastErrorDetails: entry?.lastErrorDetails ?? null,
        previousVersions: entry?.previousVersions ?? [],
      };
    });
  }

  listAppVersions(sourceOrName: string): {
    current: AppVersionRecord | null;
    previous: AppVersionRecord[];
    retentionLimit: number;
  } {
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry) return { current: null, previous: [], retentionLimit: APP_ROLLBACK_HISTORY_LIMIT };
    return {
      current: appVersionRecordFromEntry(entry),
      previous: [...entry.previousVersions],
      retentionLimit: APP_ROLLBACK_HISTORY_LIMIT,
    };
  }

  listHostTargetCandidates(target: HostTarget): HostTargetCandidate[] {
    const declaredNames = new Set(
      this.lastDeclared
        .map((decl) => this.tryFindAppNode(decl.source)?.name)
        .filter((name): name is string => typeof name === "string")
    );
    return this.deps.buildSystem
      .getGraph()
      .allNodes()
      .filter(
        (node) => node.kind === "app" && normalizeRepoPath(node.relativePath).startsWith("apps/")
      )
      .filter(
        (node) =>
          this.appTarget(node, { source: node.relativePath, ref: "main", enabled: true }) === target
      )
      .map((node) => this.hostTargetCandidate(node, target, declaredNames.has(node.name)))
      .sort((a, b) => Number(b.declared) - Number(a.declared) || a.source.localeCompare(b.source));
  }

  getHostTargetSelection(target: HostTarget): {
    selection: HostTargetSelection | null;
    valid: boolean;
    reason?: string;
  } {
    const selection = this.readHostTargetSelections().find(
      (candidate) => candidate.workspaceId === this.deps.workspaceId && candidate.target === target
    );
    if (!selection) return { selection: null, valid: false, reason: "No app selected" };
    const candidate = this.listHostTargetCandidates(target).find(
      (item) => item.name === selection.appId || item.source === selection.source
    );
    if (!candidate)
      return { selection, valid: false, reason: "Selected app is no longer available" };
    if (!candidate.compatibility.selectable) {
      return {
        selection,
        valid: false,
        reason: candidate.compatibility.reasons.join("; ") || "Selected app is not compatible",
      };
    }
    if (selection.mode === "pinned-build" || selection.mode === "pinned-commit") {
      const versions = this.listAppVersions(selection.appId);
      const known = [versions.current, ...versions.previous].some(
        (version) => version?.activeBundleKey === selection.buildKey
      );
      if (!known)
        return { selection, valid: false, reason: "Selected build is no longer retained" };
    }
    return { selection, valid: true };
  }

  setHostTargetSelection(target: HostTarget, input: HostTargetSelectionInput): HostTargetSelection {
    const candidate = this.listHostTargetCandidates(target).find(
      (item) => item.name === input.source || item.source === normalizeRepoPath(input.source)
    );
    if (!candidate) throw new Error(`No ${target} app candidate found for ${input.source}`);
    if (!candidate.compatibility.selectable) {
      throw new Error(
        `App ${candidate.name} cannot be selected for ${target}: ${candidate.compatibility.reasons.join("; ")}`
      );
    }
    const mode = input.mode ?? "follow-ref";
    if (mode === "pinned-build" || mode === "pinned-commit") {
      if (!input.buildKey) throw new Error(`${mode} selections require buildKey`);
      const versions = this.listAppVersions(candidate.name);
      const known = [versions.current, ...versions.previous].some(
        (version) => version?.activeBundleKey === input.buildKey
      );
      if (!known) throw new Error(`Build ${input.buildKey} is not retained for ${candidate.name}`);
    }
    if (mode === "pinned-commit" && !input.commit) {
      throw new Error("pinned-commit selections require commit");
    }
    const selection: HostTargetSelection = {
      workspaceId: this.deps.workspaceId,
      target,
      source: candidate.source,
      appId: candidate.name,
      mode,
      ref: input.ref,
      buildKey: input.buildKey,
      commit: input.commit,
      updatedAt: Date.now(),
      autoSelected: input.autoSelected,
    };
    this.writeHostTargetSelection(selection);
    if (target === "electron" || target === "terminal") {
      void this.launchHostTarget(target).catch((err) => {
        console.error(
          `[AppHost] Failed to launch selected ${target} app ${selection.appId}:`,
          err instanceof Error ? err.message : String(err)
        );
      });
    }
    return selection;
  }

  clearHostTargetSelection(target: HostTarget): void {
    const selections = this.readHostTargetSelections().filter(
      (selection) =>
        !(selection.workspaceId === this.deps.workspaceId && selection.target === target)
    );
    this.writeHostTargetSelections(selections);
  }

  listHostTargetVersions(
    target: HostTarget,
    sourceOrName: string
  ): {
    current: AppVersionRecord | null;
    previous: AppVersionRecord[];
    retentionLimit: number;
  } {
    const candidate = this.listHostTargetCandidates(target).find(
      (item) => item.name === sourceOrName || item.source === normalizeRepoPath(sourceOrName)
    );
    if (!candidate)
      return { current: null, previous: [], retentionLimit: APP_ROLLBACK_HISTORY_LIMIT };
    return this.listAppVersions(candidate.name);
  }

  async prepareHostTargetPinnedCommit(
    target: HostTarget,
    sourceOrName: string,
    commit: string
  ): Promise<{ buildKey: string; effectiveVersion: string; appId: string; source: string }> {
    const candidate = this.listHostTargetCandidates(target).find(
      (item) => item.name === sourceOrName || item.source === normalizeRepoPath(sourceOrName)
    );
    if (!candidate) throw new Error(`No ${target} app candidate found for ${sourceOrName}`);
    const node = this.findAppNode(candidate.name);
    const previous = this.registry.get(candidate.name) ?? null;
    const build = await this.deps.buildSystem.getBuild(candidate.name, commit);
    this.validateBuildForTarget(candidate.name, target, build);
    const decl: WorkspaceAppDeclaration = {
      source: candidate.source,
      ref: commit,
      target,
      enabled: true,
    };
    let entry = this.unitHost.activateBuild({
      name: node.name,
      version: readPackageVersion(node.path),
      sourceRepo: node.relativePath,
      ref: commit,
      buildDir: build.dir,
      effectiveVersion: build.metadata.ev,
      activeSha: commit,
      dependencyEvs: this.currentDependencyEvs(node),
      externalDeps: this.externalDepsForBuild(node, build.metadata, decl),
      runtimeDepsKey: null,
      status: appRegistryStatusForTarget(target),
      extra: {
        target,
        autostart: false,
        capabilities: this.appCapabilities(node),
      },
    });
    const previousRecord =
      previous && previous.activeBundleKey && previous.activeBundleKey !== entry.activeBundleKey
        ? appVersionRecordFromEntry(previous)
        : null;
    if (previousRecord) {
      entry = this.registry.patch(entry.name, {
        previousVersions: appVersionHistory([
          previousRecord,
          ...(previous?.previousVersions ?? []),
        ]),
        lastErrorDetails: null,
      });
    } else {
      entry = this.registry.patch(entry.name, { lastErrorDetails: null });
    }
    this.activateAppEntity(entry);
    await this.syncTerminalRuntime(entry, previous);
    this.emitAvailable(this.registry.get(entry.name) ?? entry);
    return {
      buildKey: path.basename(build.dir),
      effectiveVersion: build.metadata.ev,
      appId: candidate.name,
      source: candidate.source,
    };
  }

  async launchHostTarget(target: HostTarget): Promise<boolean> {
    const { selection, valid } = this.getHostTargetSelection(target);
    if (!selection || !valid) return false;
    if (
      (selection.mode === "pinned-build" || selection.mode === "pinned-commit") &&
      selection.buildKey
    ) {
      const current = this.findRegistryEntry(selection.appId);
      if (current?.activeBundleKey && current.activeBundleKey !== selection.buildKey) {
        await this.rollbackAppVersion(selection.appId, selection.buildKey);
      }
    }
    const entry = this.findRegistryEntry(selection.appId);
    if (!entry || entry.target !== target || !entry.activeBundleKey) return false;
    if (target === "electron") {
      this.emitAvailable(entry);
      return true;
    }
    if (target === "terminal") {
      for (const other of this.registry.list()) {
        if (other.target === "terminal" && other.name !== entry.name) {
          await this.stopTerminalApp(other.name);
        }
      }
      await this.startTerminalApp(entry);
      return true;
    }
    return true;
  }

  async rollbackAppVersion(sourceOrName: string, buildKey?: string): Promise<AppRegistryEntry> {
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry) throw new Error(`Unknown app: ${sourceOrName}`);
    const selected = buildKey
      ? entry.previousVersions.find((candidate) => candidate.activeBundleKey === buildKey)
      : entry.previousVersions[0];
    if (!selected) {
      throw new Error(
        buildKey
          ? `No rollback version ${buildKey} is available for app ${entry.name}`
          : `No rollback version is available for app ${entry.name}`
      );
    }
    const build = this.deps.buildSystem.getBuildByKey?.(selected.activeBundleKey);
    if (!build)
      throw new Error(
        `Rollback app build is missing from the build store: ${selected.activeBundleKey}`
      );
    this.validateBuildForTarget(entry.name, selected.target, build);

    const current = appVersionRecordFromEntry(entry);
    const remaining = entry.previousVersions.filter(
      (candidate) => candidate.activeBundleKey !== selected.activeBundleKey
    );
    const updated = this.registry.patch(entry.name, {
      version: selected.version,
      target: selected.target,
      autostart: selected.autostart,
      capabilities: selected.capabilities,
      activeEv: selected.activeEv,
      activeSha: selected.activeSha,
      activeBundleKey: selected.activeBundleKey,
      activeDependencyEvs: selected.activeDependencyEvs,
      activeExternalDeps: selected.activeExternalDeps,
      activeRuntimeDepsKey: selected.activeRuntimeDepsKey,
      status: appRegistryStatusForTarget(selected.target),
      lastError: null,
      lastErrorDetails: null,
      previousVersions: current
        ? appVersionHistory([current, ...remaining])
        : appVersionHistory(remaining),
    });
    this.activateAppEntity(updated);
    await this.syncTerminalRuntime(updated, entry);
    const activated = this.registry.get(updated.name) ?? updated;
    this.emitAvailable(activated, {
      lifecycleType: "rolled-back",
      previousBuildKey: entry.activeBundleKey ?? null,
      notify: true,
    });
    return activated;
  }

  listWorkspaceUnitLogs(name: string): Array<{
    workspaceId: string;
    unitName: string;
    kind: "app";
    timestamp: number;
    level: "info" | "error";
    message: string;
  }> {
    return this.unitHost
      .listWorkspaceUnitLogs(this.deps.workspaceId, name)
      .concat(this.appLogs.get(this.resolveAppLogName(name)) ?? [])
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  hasAppCapability(callerId: string, capability: AppCapability): boolean {
    const entry =
      this.registry.get(callerId) ??
      this.registry.list().find((candidate) => {
        const source = normalizeRepoPath(candidate.source.repo);
        return callerId.startsWith(`app:${source}:`);
      });
    return (
      !!entry?.enabled &&
      isCapabilityActiveStatus(entry.status) &&
      entry.capabilities.includes(capability)
    );
  }

  capabilityAuthorizer(): CapabilityAuthorizer {
    return createCapabilityAuthorizer({
      hasAppCapability: (callerId, capability) => this.hasAppCapability(callerId, capability),
    });
  }

  bakeDist(sourceOrName: string, outDir: string): AppDistBakeManifest {
    const entry =
      this.registry.get(sourceOrName) ??
      this.registry
        .list()
        .find(
          (candidate) =>
            normalizeRepoPath(candidate.source.repo) === normalizeRepoPath(sourceOrName)
        );
    if (!entry?.activeBundleKey) {
      throw new Error(`No active approved app build found for dist bake: ${sourceOrName}`);
    }
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    if (!build) {
      throw new Error(`Active app build is missing from the build store: ${entry.activeBundleKey}`);
    }
    return writeAppDistBake({
      entry,
      build: {
        metadata: appBuildMetadataForDist(entry, build.metadata),
        artifacts: appArtifactsForDist(entry, build.artifacts ?? []),
      },
      outDir,
      buildKey: entry.activeBundleKey,
    });
  }

  metaPushApprovalForCommit(commit: string): { units: UnitBatchEntry[]; identityKeys: string[] } {
    const approval = this.unitHost.approvalForDeclarations(this.readDeclaredAppsFromCommit(commit));
    return { units: approval.entries, identityKeys: approval.identityKeys };
  }

  async authorizeSourcePush(request: {
    caller: VerifiedCaller;
    repoPath: string;
    branch: string;
    commit: string;
  }): Promise<{ allowed: boolean; reason?: string }> {
    return authorizeUnitSourcePush(
      {
        descriptor: APP_UNIT_DESCRIPTOR,
        grantStore: this.sourcePushGrants,
        grantTtlMs: UNIT_DEV_SESSION_TTL_MS,
        findInstalledByRepo: (repoPath) => this.unitHost.findInstalledByRepo(repoPath),
        requestApproval: async ({ request: sourcePush, installed, identity, callerKind }) =>
          this.deps.approvalQueue.request({
            kind: "unit-batch",
            callerId: sourcePush.caller.runtime.id,
            callerKind,
            repoPath: identity.repoPath,
            effectiveVersion: identity.effectiveVersion,
            dedupKey: `app-source-push:${installed.entry.name}:${sourcePush.branch}`,
            trigger: "source-push",
            title: `${installed.entry.name} app source push`,
            description: "Accepting this push updates trusted workspace app code.",
            units: [
              {
                ...this.buildBatchEntry(installed.node, {
                  source: installed.node.relativePath,
                  ref: installed.entry.source.ref,
                  enabled: installed.entry.enabled,
                  target: installed.entry.target,
                  autostart: true,
                }),
                ev: installed.entry.activeEv,
              },
            ],
            configWrite: null,
          }),
      },
      request
    );
  }

  handleAppArtifactRequest(
    req: IncomingMessage,
    res: ServerResponse,
    buildKey: string,
    remainderPath: string
  ): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }
    if (
      !this.registry
        .list()
        .some(
          (entry) =>
            entry.enabled &&
            (entry.activeBundleKey === buildKey ||
              entry.previousVersions.some((version) => version.activeBundleKey === buildKey))
        )
    ) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("App artifact not active");
      return;
    }
    const build = this.deps.buildSystem.getBuildByKey?.(buildKey);
    const artifactPath = normalizeArtifactPath(remainderPath || "index.html");
    const artifact = build?.artifacts?.find((entry) => entry.path === artifactPath);
    if (!artifact) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("App artifact not found");
      return;
    }
    const headers: Record<string, string> = {
      "Content-Type": artifact.contentType,
      "Cache-Control": "no-store",
    };
    if (artifact.role === "html") {
      headers["Content-Security-Policy"] =
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss: http: https:";
    }
    const body =
      artifact.encoding === "base64"
        ? Buffer.from(artifact.content, "base64")
        : Buffer.from(artifact.content);
    headers["Content-Length"] = String(body.byteLength);
    res.writeHead(200, headers);
    if (req.method === "HEAD") res.end();
    else res.end(body);
  }

  getReactNativeBootstrap(source?: string | null): ReactNativeAppBootstrap | null {
    const resolvedSource = source ?? this.getSelectedReactNativeSource();
    if (!resolvedSource) return null;
    const normalizedSource = normalizeRepoPath(resolvedSource);
    const entry = this.registry
      .list()
      .find(
        (candidate) =>
          candidate.target === "react-native" &&
          candidate.enabled &&
          candidate.status === "running" &&
          normalizeRepoPath(candidate.source.repo) === normalizedSource &&
          candidate.activeBundleKey
      );
    if (!entry?.activeBundleKey) return null;
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    const details =
      build?.metadata.details &&
      build.metadata.details.kind === "app" &&
      "rnHostAbi" in build.metadata.details
        ? build.metadata.details
        : null;
    const rnHostAbi = details?.rnHostAbi;
    const integrity = details?.integrity;
    if (
      !build ||
      !details ||
      typeof rnHostAbi !== "string" ||
      rnHostAbi.length === 0 ||
      typeof integrity !== "string" ||
      integrity.length === 0 ||
      !isBuildProviderDetailsLike(details.provider)
    ) {
      return null;
    }
    const baseUrl = `${this.deps.getGatewayUrl()}/_a/${encodeURIComponent(entry.activeBundleKey)}`;
    const primaryArtifacts = (build.artifacts ?? []).filter(
      (artifact) => artifact.role === "primary"
    );
    if (!hasMobilePrimaryArtifacts(primaryArtifacts)) {
      return null;
    }
    if (
      primaryArtifacts.some(
        (artifact) => typeof artifact.integrity !== "string" || artifact.integrity.length === 0
      )
    ) {
      return null;
    }
    const artifacts = primaryArtifacts.map((artifact) => ({
      path: artifact.path,
      role: artifact.role,
      contentType: artifact.contentType,
      encoding: artifact.encoding,
      platform: artifact.platform,
      integrity: artifact.integrity ?? "",
      url: `${baseUrl}/${encodeArtifactPath(artifact.path)}`,
    }));
    return {
      appId: entry.name,
      buildKey: entry.activeBundleKey,
      effectiveVersion: entry.activeEv,
      capabilities: entry.capabilities,
      rnHostAbi,
      integrity,
      artifacts,
      provider: details.provider,
    };
  }

  registerReactNativeAppPrincipal(deviceId: string, source?: string | null): string | null {
    const resolvedSource = source ?? this.getSelectedReactNativeSource();
    if (!resolvedSource) return null;
    const normalizedSource = normalizeRepoPath(resolvedSource);
    const entry = this.registry
      .list()
      .find(
        (candidate) =>
          candidate.target === "react-native" &&
          candidate.enabled &&
          candidate.status === "running" &&
          !!candidate.activeEv &&
          !!candidate.activeBundleKey &&
          normalizeRepoPath(candidate.source.repo) === normalizedSource
      );
    if (!entry || !this.deps.entityCache) return null;
    return this.activateDeviceScopedAppEntity(entry, deviceId);
  }

  retireReactNativeAppPrincipal(deviceId: string): number {
    let retired = 0;
    for (const entry of this.registry.list()) {
      if (entry.target !== "react-native") continue;
      if (this.retireAppEntity(mobileAppPrincipalId(entry.source.repo, deviceId))) retired++;
    }
    return retired;
  }

  private async applyDeclared(node: AppGraphNode, decl: WorkspaceAppDeclaration): Promise<void> {
    await this.unitHost.applyRuntimeDeclaration({
      node,
      decl,
      validateBeforeApply: () => this.validateAppManifestAtPath(node.path, node.name),
      afterDisabled: async (entry) => {
        await this.stopTerminalApp(node.name);
        if (entry) this.retireDeviceScopedAppEntities(entry);
        this.retireAppEntity(node.name);
        this.emitStatus(node.name, "stopped", null);
      },
      needsBuildRefresh: (entry) => this.needsBuildRefresh(entry, node, decl),
      buildAndActivate: (n, d) => this.buildAndActivate(n, d),
      validateBeforeActivateCurrent: (entry) => this.validateActiveBuild(entry),
      activateCurrent: async (entry) => {
        await this.syncTerminalRuntime(entry);
        this.emitAvailable(this.registry.get(entry.name) ?? entry);
      },
      onError: (_node, _decl, message) => this.emitStatus(node.name, "error", message),
    });
  }

  private async buildAndActivate(node: AppGraphNode, decl: WorkspaceAppDeclaration): Promise<void> {
    const previous = this.registry.get(node.name) ?? null;
    const diagnostic: AppUpdateErrorDiagnostic = { phase: "build", source: node.relativePath };
    try {
      if (!previous) this.registry.upsert(this.pendingEntryFor(node, decl, true));
      else this.unitHost.markBuilding(node.name);
      const build = await this.deps.buildSystem.getBuild(node.name, decl.ref);
      diagnostic.buildKey = path.basename(build.dir);
      diagnostic.phase = "target-validation";
      const target = this.appTarget(node, decl);
      diagnostic.target = target;
      this.validateBuildForTarget(node.name, target, build);
      diagnostic.phase = "activation";
      const capabilities = this.appCapabilities(node);
      let entry = this.unitHost.activateBuild({
        name: node.name,
        version: readPackageVersion(node.path),
        sourceRepo: node.relativePath,
        ref: decl.ref,
        buildDir: build.dir,
        effectiveVersion: build.metadata.ev,
        activeSha: resolveGitCommit(node.path, decl.ref),
        dependencyEvs: this.currentDependencyEvs(node),
        externalDeps: this.externalDepsForBuild(node, build.metadata, decl),
        runtimeDepsKey: null,
        status: appRegistryStatusForTarget(target),
        extra: {
          target,
          autostart: decl.autostart ?? false,
          capabilities,
        },
      });
      const previousRecord =
        previous && previous.activeBundleKey && previous.activeBundleKey !== entry.activeBundleKey
          ? appVersionRecordFromEntry(previous)
          : null;
      if (previousRecord) {
        entry = this.registry.patch(entry.name, {
          previousVersions: appVersionHistory([
            previousRecord,
            ...(previous?.previousVersions ?? []),
          ]),
          lastErrorDetails: null,
        });
      } else {
        entry = this.registry.patch(entry.name, { lastErrorDetails: null });
      }
      const pinnedSelection = this.pinnedSelectionForEntry(entry);
      if (
        pinnedSelection?.buildKey &&
        pinnedSelection.buildKey !== entry.activeBundleKey &&
        entry.previousVersions.some(
          (candidate) => candidate.activeBundleKey === pinnedSelection.buildKey
        )
      ) {
        await this.rollbackAppVersion(entry.name, pinnedSelection.buildKey);
        return;
      }
      this.activateAppEntity(entry);
      await this.syncTerminalRuntime(entry, previous);
      entry = this.registry.get(entry.name) ?? entry;
      this.emitAvailable(entry, {
        lifecycleType: previousRecord ? "update-available" : "available",
        previousBuildKey: previous?.activeBundleKey ?? null,
        previousEffectiveVersion: previous?.activeEv ?? null,
        notify: !!previousRecord,
      });
    } catch (err) {
      if (err && typeof err === "object") {
        (err as { appUpdateDiagnostic?: AppUpdateErrorDiagnostic }).appUpdateDiagnostic =
          diagnostic;
      }
      this.restorePreviousBuildAfterActivationError(
        node.name,
        previous,
        err instanceof Error ? err.message : String(err),
        diagnostic
      );
      throw err;
    }
  }

  private emitAvailable(
    entry: AppRegistryEntry,
    opts: {
      lifecycleType?: "available" | "update-available" | "rolled-back";
      previousBuildKey?: string | null;
      previousEffectiveVersion?: string | null;
      notify?: boolean;
    } = {}
  ): void {
    const buildKey = entry.activeBundleKey ?? "";
    const baseUrl = `${this.deps.getGatewayUrl()}/_a/${encodeURIComponent(buildKey)}`;
    const build = buildKey ? this.deps.buildSystem.getBuildByKey?.(buildKey) : null;
    const artifactUrls = (build?.artifacts ?? []).map((artifact) => ({
      path: artifact.path,
      role: artifact.role,
      contentType: artifact.contentType,
      encoding: artifact.encoding,
      platform: artifact.platform,
      integrity: artifact.integrity,
      url: `${baseUrl}/${encodeArtifactPath(artifact.path)}`,
    }));
    const primaryArtifact =
      artifactUrls.find((artifact) => entry.target === "electron" && artifact.role === "html") ??
      artifactUrls.find((artifact) => artifact.role === "primary") ??
      artifactUrls[0];
    const selectedForHost = this.isSelectedForHost(entry);
    const details =
      build?.metadata.details &&
      build.metadata.details.kind === "app" &&
      "integrity" in build.metadata.details
        ? build.metadata.details
        : null;
    const url = primaryArtifact?.url ?? `${baseUrl}/index.html`;
    this.deps.eventService.emit("apps:available" as EventName, {
      appId: entry.name,
      source: normalizeRepoPath(entry.source.repo),
      target: entry.target,
      launchMode: appLaunchMode(entry.target),
      url,
      artifacts: artifactUrls,
      capabilities: entry.capabilities,
      buildKey: entry.activeBundleKey,
      effectiveVersion: entry.activeEv,
      previousBuildKey: opts.previousBuildKey ?? null,
      previousEffectiveVersion: opts.previousEffectiveVersion ?? null,
      canRollback: entry.previousVersions.length > 0,
      adoptionPolicy: appAdoptionPolicy(entry.target, opts.lifecycleType ?? "available"),
      selectedForHost,
      integrity: details?.integrity ?? null,
      rnHostAbi: details?.rnHostAbi ?? null,
      provider: details?.provider ?? null,
    });
    this.emitAppLifecycle({
      type: opts.lifecycleType ?? "available",
      appId: entry.name,
      source: normalizeRepoPath(entry.source.repo),
      target: entry.target,
      buildKey: entry.activeBundleKey,
      effectiveVersion: entry.activeEv,
      previousBuildKey: opts.previousBuildKey ?? null,
      previousEffectiveVersion: opts.previousEffectiveVersion ?? null,
      canRollback: entry.previousVersions.length > 0,
      requiresReload: entry.target !== "terminal",
      adoptionPolicy: appAdoptionPolicy(entry.target, opts.lifecycleType ?? "available"),
      ...(selectedForHost === undefined ? {} : { selectedForHost }),
    });
    if (opts.notify) this.notifyAppUpdateAvailable(entry);
    this.emitStatus(entry.name, entry.status, entry.lastError ?? null);
  }

  private validateActiveBuild(entry: AppRegistryEntry): void {
    if (!entry.activeBundleKey) throw new Error(`Active app ${entry.name} has no active build key`);
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    if (!build)
      throw new Error(`Active app build is missing from the build store: ${entry.activeBundleKey}`);
    this.validateBuildForTarget(entry.name, entry.target, build);
  }

  private validateBuildForTarget(
    appName: string,
    target: WorkspaceAppTarget,
    build: Awaited<ReturnType<BuildSystemLike["getBuild"]>>
  ): void {
    if (target === "terminal") {
      const details = build.metadata.details;
      if (!isAppBuildDetailsLike(details) || details.target !== "terminal") {
        throw new Error(`Terminal app ${appName} build is missing terminal app metadata`);
      }
      const primaryArtifacts = (build.artifacts ?? []).filter(
        (artifact) => artifact.role === "primary"
      );
      if (primaryArtifacts.length !== 1) {
        throw new Error(
          `Terminal app ${appName} build must include exactly one primary entry artifact`
        );
      }
      if (!primaryArtifacts[0]?.path.endsWith(".mjs")) {
        throw new Error(`Terminal app ${appName} primary artifact must be an ESM .mjs entry`);
      }
      return;
    }
    if (target !== "react-native") return;
    const details = build.metadata.details;
    if (
      !isAppBuildDetailsLike(details) ||
      details.target !== "react-native" ||
      typeof details.rnHostAbi !== "string" ||
      details.rnHostAbi.length === 0 ||
      typeof details.integrity !== "string" ||
      details.integrity.length === 0 ||
      !isBuildProviderDetailsLike(details.provider)
    ) {
      throw new Error(
        `React Native app ${appName} build is missing signed RN metadata or provider identity`
      );
    }
    const primaryArtifacts = (build.artifacts ?? []).filter(
      (artifact) => artifact.role === "primary"
    );
    if (primaryArtifacts.length === 0) {
      throw new Error(`React Native app ${appName} build has no primary mobile artifact`);
    }
    const seenPlatforms = new Set<"android" | "ios">();
    for (const artifact of primaryArtifacts) {
      if (artifact.platform !== "android" && artifact.platform !== "ios") {
        throw new Error(
          `React Native app ${appName} primary artifact ${artifact.path} is missing a mobile platform`
        );
      }
      if (seenPlatforms.has(artifact.platform)) {
        throw new Error(
          `React Native app ${appName} has multiple primary artifacts for ${artifact.platform}`
        );
      }
      if (typeof artifact.integrity !== "string" || artifact.integrity.length === 0) {
        throw new Error(
          `React Native app ${appName} primary artifact ${artifact.path} is missing integrity`
        );
      }
      seenPlatforms.add(artifact.platform);
    }
  }

  private emitStatus(
    name: string,
    status: AppRegistryEntry["status"],
    error: string | null,
    errorDetails?: AppUpdateErrorDiagnostic | null
  ): void {
    const entry = this.registry.get(name);
    this.deps.eventService.emit("apps:status" as EventName, {
      name,
      status,
      error,
      errorDetails: errorDetails ?? entry?.lastErrorDetails ?? null,
      buildKey: entry?.activeBundleKey ?? null,
      effectiveVersion: entry?.activeEv ?? null,
      canRollback: !!entry?.previousVersions?.length,
    });
  }

  private emitAppLifecycle(payload: {
    type: "available" | "update-available" | "update-error" | "rolled-back";
    appId: string;
    source: string;
    target?: WorkspaceAppTarget;
    buildKey?: string | null;
    effectiveVersion?: string | null;
    previousBuildKey?: string | null;
    previousEffectiveVersion?: string | null;
    error?: string;
    errorDetails?: AppUpdateErrorDiagnostic | null;
    canRollback: boolean;
    requiresReload?: boolean;
    adoptionPolicy?: "immediate" | "prompt";
    selectedForHost?: boolean;
  }): void {
    this.deps.eventService.emit("apps:lifecycle" as EventName, {
      ...payload,
      emittedAt: Date.now(),
    });
  }

  private notifyAppUpdateAvailable(entry: AppRegistryEntry): void {
    const targetCopy = appUpdateTargetCopy(entry.target);
    const actions = [
      ...(entry.target === "electron"
        ? [
            {
              id: "app.applyUpdate",
              label: "Load update",
              variant: "solid" as const,
              command: { type: "app.applyUpdate" as const, appId: entry.name },
            },
          ]
        : []),
      ...(entry.target === "terminal"
        ? [
            {
              id: "workspace.restartUnit",
              label: entry.status === "running" ? "Restart" : "Start",
              variant: "solid" as const,
              command: {
                type: "workspace.restartUnit" as const,
                name: entry.name,
              },
            },
          ]
        : []),
      ...(entry.previousVersions.length > 0
        ? [
            {
              id: "app.rollback",
              label: "Roll back",
              variant: entry.target === "electron" ? ("soft" as const) : ("solid" as const),
              command: { type: "app.rollback" as const, appId: entry.name },
            },
          ]
        : []),
    ];
    this.deps.notificationService?.show({
      id: `app-update-${encodeURIComponent(entry.name)}`,
      type: "info",
      title: targetCopy.title,
      message: `${entry.name}: ${targetCopy.message}`,
      ttl: 0,
      actions: actions.length > 0 ? actions : undefined,
    });
  }

  private notifyAppUpdateError(
    entry: AppRegistryEntry,
    message: string,
    diagnostic?: AppUpdateErrorDiagnostic | null
  ): void {
    const detail = diagnostic
      ? ` (${diagnostic.phase}${diagnostic.target ? `, ${diagnostic.target}` : ""})`
      : "";
    this.deps.notificationService?.show({
      id: `app-update-error-${encodeURIComponent(entry.name)}`,
      type: "error",
      title: "App update failed",
      message: `${entry.name}: ${message}${detail}`,
      ttl: 0,
      actions:
        entry.previousVersions.length > 0
          ? [
              {
                id: "app.rollback",
                label: "Roll back",
                variant: "solid",
                command: { type: "app.rollback", appId: entry.name },
              },
            ]
          : undefined,
    });
  }

  private restorePreviousBuildAfterActivationError(
    name: string,
    previous: AppRegistryEntry | null,
    message: string,
    diagnostic: AppUpdateErrorDiagnostic
  ): void {
    if (!previous?.activeBundleKey) {
      this.unitHost.markError(name, message);
      this.registry.patch(name, { lastErrorDetails: diagnostic });
      return;
    }
    this.registry.patch(name, {
      activeEv: previous.activeEv,
      activeSha: previous.activeSha,
      activeBundleKey: previous.activeBundleKey,
      activeDependencyEvs: previous.activeDependencyEvs ?? {},
      activeExternalDeps: previous.activeExternalDeps ?? {},
      activeRuntimeDepsKey: previous.activeRuntimeDepsKey ?? null,
      target: previous.target,
      capabilities: previous.capabilities,
      previousVersions: previous.previousVersions ?? [],
      status: "error",
      lastError: message,
      lastErrorDetails: diagnostic,
    });
  }

  private findRegistryEntry(sourceOrName: string): AppRegistryEntry | null {
    return (
      this.registry.get(sourceOrName) ??
      this.registry
        .list()
        .find(
          (candidate) =>
            normalizeRepoPath(candidate.source.repo) === normalizeRepoPath(sourceOrName)
        ) ??
      null
    );
  }

  private hostTargetCandidate(
    node: AppGraphNode,
    target: HostTarget,
    declared: boolean
  ): HostTargetCandidate {
    const entry = this.registry.get(node.name);
    const capabilities = this.appCapabilities(node);
    const reasons: string[] = [];
    if (target === "electron" && !capabilities.includes("panel-hosting")) {
      reasons.push("Electron shell apps must declare the panel-hosting capability");
    }
    const activeBuild = entry?.activeBundleKey
      ? this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey)
      : null;
    if (target === "react-native" && activeBuild) {
      const details = activeBuild.metadata.details;
      if (
        !isAppBuildDetailsLike(details) ||
        details.target !== "react-native" ||
        typeof details.rnHostAbi !== "string" ||
        !details.rnHostAbi ||
        typeof details.integrity !== "string" ||
        !details.integrity ||
        !isBuildProviderDetailsLike(details.provider)
      ) {
        reasons.push("Active React Native build is missing signed native metadata");
      }
    }
    if (target === "terminal" && activeBuild) {
      const details = activeBuild.metadata.details;
      const primaryArtifacts = (activeBuild.artifacts ?? []).filter(
        (artifact) => artifact.role === "primary"
      );
      if (!isAppBuildDetailsLike(details) || details.target !== "terminal") {
        reasons.push("Active terminal build is missing terminal metadata");
      } else if (primaryArtifacts.length !== 1 || !primaryArtifacts[0]?.path.endsWith(".mjs")) {
        reasons.push("Terminal builds need exactly one primary .mjs artifact");
      }
    }
    return {
      name: node.name,
      source: normalizeRepoPath(node.relativePath),
      displayName: node.manifest.displayName ?? node.name,
      target,
      declared,
      enabled: entry?.enabled,
      status: entry?.status ?? "not-built",
      activeEv: entry?.activeEv ?? null,
      activeBundleKey: entry?.activeBundleKey ?? null,
      capabilities,
      canRollback: !!entry?.previousVersions.length,
      previousVersions: entry?.previousVersions ?? [],
      lastError: entry?.lastError ?? null,
      lastErrorDetails: entry?.lastErrorDetails ?? null,
      compatibility: {
        selectable: reasons.length === 0,
        reasons,
        recommended: target !== "electron" || capabilities.includes("panel-hosting"),
      },
    };
  }

  private hostTargetSelectionPath(): string {
    return path.join(this.deps.statePath, "host-targets", "selections.json");
  }

  private readHostTargetSelections(): HostTargetSelection[] {
    const filePath = this.hostTargetSelectionPath();
    if (!fs.existsSync(filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as HostTargetSelectionState;
      return Array.isArray(parsed.selections)
        ? parsed.selections.filter(isHostTargetSelection)
        : [];
    } catch (err) {
      console.warn(
        `[AppHost] Failed to read host target selections: ${err instanceof Error ? err.message : String(err)}`
      );
      return [];
    }
  }

  private writeHostTargetSelection(selection: HostTargetSelection): void {
    const selections = this.readHostTargetSelections().filter(
      (candidate) =>
        !(candidate.workspaceId === selection.workspaceId && candidate.target === selection.target)
    );
    selections.push(selection);
    this.writeHostTargetSelections(selections);
  }

  private writeHostTargetSelections(selections: HostTargetSelection[]): void {
    const filePath = this.hostTargetSelectionPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ selections }, null, 2), "utf8");
  }

  private getSelectedReactNativeSource(): string | null {
    const current = this.getHostTargetSelection("react-native");
    if (current.valid && current.selection) return current.selection.source;
    const activeEntries = this.registry
      .list()
      .filter(
        (entry) =>
          entry.target === "react-native" &&
          entry.enabled &&
          entry.status === "running" &&
          !!entry.activeBundleKey
      );
    const canonicalMobile = activeEntries.find(
      (entry) => normalizeRepoPath(entry.source.repo) === "apps/mobile"
    );
    if (canonicalMobile) return normalizeRepoPath(canonicalMobile.source.repo);
    const onlyActiveEntry = activeEntries[0];
    if (activeEntries.length === 1 && onlyActiveEntry) {
      return normalizeRepoPath(onlyActiveEntry.source.repo);
    }
    const candidates = this.listHostTargetCandidates("react-native").filter(
      (candidate) => candidate.compatibility.selectable
    );
    const onlyCandidate = candidates[0];
    if (candidates.length === 1 && onlyCandidate) return onlyCandidate.source;
    return null;
  }

  private isSelectedForHost(entry: AppRegistryEntry): boolean | undefined {
    const current = this.getHostTargetSelection(entry.target);
    if (!current.selection) return undefined;
    return (
      normalizeRepoPath(current.selection.source) === normalizeRepoPath(entry.source.repo) ||
      current.selection.appId === entry.name
    );
  }

  private pinnedSelectionForEntry(entry: AppRegistryEntry): HostTargetSelection | null {
    const current = this.getHostTargetSelection(entry.target);
    const selection = current.valid ? current.selection : null;
    if (!selection) return null;
    if (selection.mode !== "pinned-build" && selection.mode !== "pinned-commit") return null;
    if (
      selection.appId !== entry.name &&
      normalizeRepoPath(selection.source) !== normalizeRepoPath(entry.source.repo)
    ) {
      return null;
    }
    return selection;
  }

  private activateAppEntity(entry: AppRegistryEntry): void {
    if (!this.deps.entityCache || !entry.activeEv) return;
    const existing = this.deps.entityCache.resolve(entry.name);
    const sourceRepo = normalizeRepoPath(entry.source.repo);
    const contextId = createHash("sha256")
      .update(`${this.deps.workspaceId}\x00app\x00${entry.name}\x00${sourceRepo}`)
      .digest("hex");
    const record: EntityRecord = {
      id: entry.name,
      kind: "app",
      source: { repoPath: sourceRepo, effectiveVersion: entry.activeEv },
      contextId,
      key: entry.name,
      createdAt: existing?.createdAt ?? Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    this.deps.entityCache._onActivate(record);
  }

  private activateDeviceScopedAppEntity(entry: AppRegistryEntry, deviceId: string): string {
    if (!this.deps.entityCache || !entry.activeEv) {
      throw new Error("Cannot activate device-scoped app principal without an active app entity");
    }
    const sourceRepo = normalizeRepoPath(entry.source.repo);
    const principalId = mobileAppPrincipalId(sourceRepo, deviceId);
    const existing = this.deps.entityCache.resolve(principalId);
    const contextId = createHash("sha256")
      .update(`${this.deps.workspaceId}\x00app-device\x00${sourceRepo}\x00${deviceId}`)
      .digest("hex");
    const record: EntityRecord = {
      id: principalId,
      kind: "app",
      source: { repoPath: sourceRepo, effectiveVersion: entry.activeEv },
      contextId,
      key: principalId,
      createdAt: existing?.createdAt ?? Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    this.deps.entityCache._onActivate(record);
    return principalId;
  }

  private retireAppEntity(name: string): boolean {
    const existing = this.deps.entityCache?.resolve(name);
    if (!existing || existing.kind !== "app" || existing.status !== "active") return false;
    this.deps.entityCache?._onRetire({
      ...existing,
      status: "retired",
      retiredAt: Date.now(),
      cleanupComplete: true,
    });
    return true;
  }

  private retireDeviceScopedAppEntities(entry: AppRegistryEntry): void {
    if (!this.deps.entityCache?.listActive) return;
    const prefix = `app:${normalizeRepoPath(entry.source.repo)}:`;
    for (const record of this.deps.entityCache.listActive()) {
      if (record.kind === "app" && record.id.startsWith(prefix)) {
        this.retireAppEntity(record.id);
      }
    }
  }

  private pendingEntryFor(
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration,
    building = false
  ): AppRegistryEntry {
    return {
      ...createPendingUnitRegistryEntry({
        unitKind: "app",
        name: node.name,
        version: readPackageVersion(node.path),
        sourceRepo: node.relativePath,
        ref: decl.ref,
        enabled: decl.enabled,
        building,
      }),
      target: this.appTarget(node, decl),
      autostart: decl.autostart ?? false,
      capabilities: this.appCapabilities(node),
      previousVersions: [],
    };
  }

  private buildBatchEntry(node: AppGraphNode, decl: WorkspaceAppDeclaration): UnitBatchEntry {
    const details = this.appBuildDetails(node.name);
    return {
      ...createUnitBatchEntryBase({
        unitKind: "app",
        name: node.name,
        displayName: node.manifest.displayName,
        version: readPackageVersion(node.path),
        sourceRepo: node.relativePath,
        ref: decl.ref,
        effectiveVersion: this.deps.buildSystem.getEffectiveVersion(node.name),
        dependencyEvs: this.currentDependencyEvs(node),
        externalDeps: this.currentExternalDeps(node, decl),
      }),
      target: this.appTarget(node, decl),
      capabilities: this.appCapabilities(node),
      integrity: details?.integrity ?? null,
      provider: this.currentBuildProviderDetails(node, decl) ?? details?.provider ?? null,
    };
  }

  private declarationIdentity(
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration
  ): UnitBuildIdentity<"app"> {
    return createUnitBuildIdentity({
      unitKind: "app" as const,
      name: node.name,
      sourceRepo: node.relativePath,
      ref: decl.ref,
      effectiveVersion: this.deps.buildSystem.getEffectiveVersion(node.name),
      dependencyEvs: this.currentDependencyEvs(node),
      externalDeps: this.currentExternalDeps(node, decl),
      capabilities: this.appCapabilities(node),
    });
  }

  private registryEntryIdentity(entry: AppRegistryEntry): UnitBuildIdentity<"app"> {
    return unitBuildIdentityFromRegistryEntry(entry, entry.capabilities);
  }

  private appBuildDetails(
    name: string
  ): Extract<NonNullable<AppBuildMetadataLike["details"]>, { kind: "app" }> | null {
    const entry = this.registry.get(name);
    const metadata = entry?.activeBundleKey
      ? this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey)?.metadata
      : null;
    return metadata?.details?.kind === "app"
      ? (metadata.details as Extract<NonNullable<AppBuildMetadataLike["details"]>, { kind: "app" }>)
      : null;
  }

  private needsBuildRefresh(
    entry: AppRegistryEntry,
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration
  ): boolean {
    return this.unitHost.needsBuildRefresh(entry, {
      sourceRepo: node.relativePath,
      ref: decl.ref,
      effectiveVersion: this.deps.buildSystem.getEffectiveVersion(node.name),
      dependencyEvs: this.currentDependencyEvs(node),
      externalDeps: this.currentExternalDeps(node, decl),
    });
  }

  private async reconcileAfterProviderChange(_providerName: string): Promise<void> {
    if (this.lastDeclared.length === 0) return;
    let hasReactNativeApp = false;
    for (const decl of this.lastDeclared) {
      try {
        if (this.appTarget(this.findAppNode(decl.source), decl) === "react-native") {
          hasReactNativeApp = true;
          break;
        }
      } catch {
        // The normal declared-unit reconciliation path will surface unresolved apps.
      }
    }
    if (!hasReactNativeApp) return;
    await this.unitHost.reconcileDeclared(this.lastDeclared.map((decl) => ({ ...decl })));
    this.emitDevStatusDiagnostic("provider-change");
  }

  private async handleSourceRebuilt(source: string): Promise<void> {
    const normalized = normalizeRepoPath(source);
    const entry = this.registry
      .list()
      .find((candidate) => normalizeRepoPath(candidate.source.repo) === normalized);
    if (!entry?.enabled) return;
    const node = this.findAppNode(entry.name);
    try {
      await this.buildAndActivate(node, {
        source: node.relativePath,
        ref: entry.source.ref,
        enabled: true,
        target: entry.target,
        autostart: entry.autostart,
      });
      this.emitDevStatusDiagnostic("source-rebuilt");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const diagnostic =
        err && typeof err === "object"
          ? ((err as { appUpdateDiagnostic?: AppUpdateErrorDiagnostic }).appUpdateDiagnostic ??
            null)
          : null;
      const updated = this.registry.get(entry.name) ?? entry;
      this.emitStatus(entry.name, "error", message, diagnostic);
      this.emitAppLifecycle({
        type: "update-error",
        appId: entry.name,
        source: normalizeRepoPath(entry.source.repo),
        target: entry.target,
        buildKey: updated.activeBundleKey,
        effectiveVersion: updated.activeEv,
        error: message,
        errorDetails: diagnostic,
        canRollback: updated.previousVersions.length > 0,
        requiresReload: false,
      });
      this.notifyAppUpdateError(updated, message, diagnostic);
    }
  }

  private emitDevStatusDiagnostic(trigger: string): void {
    if (!appDevDiagnosticsEnabled() || this.lastDeclared.length === 0) return;

    const rows: string[] = [];
    const dirtyRows: Array<{ name: string; source: string; files: string[] }> = [];

    for (const decl of this.lastDeclared) {
      try {
        const node = this.findAppNode(decl.source);
        const entry = this.registry.get(node.name);
        const target = this.appTarget(node, decl);
        const dirtyFiles = readGitDirtyFiles(node.path);
        const activeEv = entry?.activeEv ? shortId(entry.activeEv) : "none";
        const activeBuild = entry?.activeBundleKey ? shortId(entry.activeBundleKey) : "none";
        const head = shortId(resolveGitCommit(node.path, decl.ref)) ?? "unknown";
        const dirtyLabel = dirtyFiles
          ? dirtyFiles.length > 0
            ? `dirty=${dirtyFiles.length}`
            : "clean"
          : "git=unavailable";

        rows.push(
          `${node.name} target=${target} source=${node.relativePath} status=${entry?.status ?? "uninstalled"} ev=${activeEv} build=${activeBuild} head=${head} ${dirtyLabel}`
        );

        if (dirtyFiles && dirtyFiles.length > 0) {
          dirtyRows.push({ name: node.name, source: node.relativePath, files: dirtyFiles });
        }
      } catch (error) {
        rows.push(
          `${decl.source} status=unresolved error=${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    console.info(`[Apps] Dev status (${trigger}):\n  ${rows.join("\n  ")}`);

    const dirtyKey = dirtyRows
      .map((row) => `${row.name}:${row.files.join(",")}`)
      .sort()
      .join("|");
    if (!dirtyKey) {
      this.lastDirtyDevDiagnosticKey = null;
      return;
    }
    if (dirtyKey === this.lastDirtyDevDiagnosticKey) return;
    this.lastDirtyDevDiagnosticKey = dirtyKey;

    const details = dirtyRows
      .map((row) => `${row.name} (${row.source}): ${summarizeFiles(row.files)}`)
      .join("; ");
    this.deps.notificationService?.show({
      id: "apps-dev-dirty",
      type: "warning",
      title: "Workspace app source has uncommitted changes",
      message: `Trusted app builds use committed source. Commit/push or approve the app update before expecting these changes to load. ${details}`,
    });
  }

  private readDeclaredAppsFromCommit(commit: string): WorkspaceAppDeclaration[] {
    const metaRepoDir = path.join(this.deps.workspacePath, "meta");
    try {
      const out = String(
        execGitFileSync(["show", "--end-of-options", `${commit}:natstack.yml`], {
          cwd: metaRepoDir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        })
      );
      return resolveDeclaredApps(parseWorkspaceConfigContentWithId(out, this.deps.workspaceId));
    } catch {
      return [];
    }
  }

  private findAppNode(nameOrRepo: string): AppGraphNode {
    return findUnitGraphNode(
      this.deps.buildSystem.getGraph().allNodes(),
      APP_UNIT_DESCRIPTOR,
      nameOrRepo
    );
  }

  private tryFindAppNode(nameOrRepo: string): AppGraphNode | null {
    try {
      return this.findAppNode(nameOrRepo);
    } catch {
      return null;
    }
  }

  private validateAppManifestAtPath(nodePath: string, unitName: string): void {
    try {
      readAndValidateUnitManifest(
        appUnitManifestDescriptor,
        path.join(nodePath, "package.json"),
        { unitName },
        fs.readFileSync as (p: string, encoding: "utf-8") => string
      );
    } catch (err) {
      if (err instanceof UnitManifestError) throw err;
      throw new UnitManifestError(
        `App ${unitName} manifest validation failed: ${err instanceof Error ? err.message : String(err)}`,
        "MANIFEST_INTERNAL"
      );
    }
  }

  private appTarget(node: AppGraphNode, decl: WorkspaceAppDeclaration): WorkspaceAppTarget {
    return decl.target ?? node.manifest.app?.target ?? "electron";
  }

  private appCapabilities(node: AppGraphNode): AppCapability[] {
    return [...(node.manifest.app?.capabilities ?? [])].sort();
  }

  private currentDependencyEvs(node: AppGraphNode): Record<string, string> {
    return collectTransitiveUnitDependencyEvs(
      this.deps.buildSystem.getGraph().allNodes(),
      node,
      (name) => this.deps.buildSystem.getEffectiveVersion(name)
    );
  }

  private currentExternalDeps(
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration
  ): Record<string, string> {
    return this.externalDepsWithProvider(
      this.deps.buildSystem.getExternalDeps(node.name),
      this.currentBuildProviderDetails(node, decl)
    );
  }

  private externalDepsForBuild(
    node: AppGraphNode,
    metadata: AppBuildMetadataLike,
    decl: WorkspaceAppDeclaration
  ): Record<string, string> {
    const details =
      metadata.details && metadata.details.kind === "app" && "provider" in metadata.details
        ? metadata.details
        : null;
    return this.externalDepsWithProvider(
      this.deps.buildSystem.getExternalDeps(node.name),
      details?.provider ?? this.currentBuildProviderDetails(node, decl)
    );
  }

  private currentBuildProviderDetails(
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration
  ): AppBuildProviderDetails | null {
    if (this.appTarget(node, decl) !== "react-native") return null;
    return this.deps.buildSystem.getBuildProviderDetails?.("react-native") ?? null;
  }

  private externalDepsWithProvider(
    externalDeps: Record<string, string>,
    provider: AppBuildProviderDetails | null
  ): Record<string, string> {
    if (!provider) return externalDeps;
    return {
      ...externalDeps,
      [`build-provider:${provider.name}`]: buildProviderIdentityValue(provider),
    };
  }

  async restartApp(sourceOrName: string): Promise<void> {
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry) throw new Error(`Unknown app: ${sourceOrName}`);
    if (entry.target !== "terminal") {
      throw new Error(`App ${entry.name} is not restartable by the terminal runner`);
    }
    await this.startTerminalApp(entry);
  }

  private async syncTerminalRuntime(
    entry: AppRegistryEntry,
    previous: AppRegistryEntry | null = null
  ): Promise<void> {
    if (entry.target !== "terminal") return;
    const wasRunning = previous ? this.terminalRunner?.isRunning(previous.name) === true : false;
    if (entry.autostart || wasRunning) {
      await this.startTerminalApp(entry);
    } else {
      await this.stopTerminalApp(entry.name);
      this.registry.patch(entry.name, { status: "available", lastError: null });
    }
  }

  private async startTerminalApp(entry: AppRegistryEntry): Promise<void> {
    if (!this.terminalRunner) {
      this.registry.patch(entry.name, {
        status: "error",
        lastError: "Terminal app runner is not configured",
      });
      this.emitStatus(entry.name, "error", "Terminal app runner is not configured");
      return;
    }
    if (!entry.activeBundleKey) throw new Error(`Terminal app ${entry.name} has no active build`);
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    if (!build) throw new Error(`Terminal app build is missing: ${entry.activeBundleKey}`);
    this.validateBuildForTarget(entry.name, "terminal", build);
    await this.terminalRunner.start({
      appId: entry.name,
      source: normalizeRepoPath(entry.source.repo),
      buildKey: entry.activeBundleKey,
      effectiveVersion: entry.activeEv,
      gatewayUrl: this.deps.getGatewayUrl(),
      build,
    });
  }

  private async stopTerminalApp(appId: string): Promise<void> {
    await this.terminalRunner?.stop(appId);
  }

  private updateTerminalRuntimeStatus(
    appId: string,
    status: "running" | "stopped" | "error",
    error: string | null
  ): void {
    const entry = this.registry.get(appId);
    if (!entry || entry.target !== "terminal") return;
    const nextStatus = status === "stopped" && entry.enabled ? "available" : status;
    this.registry.patch(appId, { status: nextStatus, lastError: error });
    this.emitStatus(appId, nextStatus, error);
  }

  private recordAppLog(
    appId: string,
    level: "info" | "error",
    message: string,
    source: "stdout" | "stderr" | "runner"
  ): void {
    const records = this.appLogs.get(appId) ?? [];
    records.push({
      workspaceId: this.deps.workspaceId,
      unitName: appId,
      kind: "app",
      timestamp: Date.now(),
      level,
      message,
      source,
    });
    if (records.length > 500) records.splice(0, records.length - 500);
    this.appLogs.set(appId, records);
  }

  private resolveAppLogName(sourceOrName: string): string {
    return this.findRegistryEntry(sourceOrName)?.name ?? sourceOrName;
  }
}

function buildProviderIdentityValue(provider: AppBuildProviderDetails): string {
  return [provider.activeEv ?? "", provider.activeBuildKey ?? "", provider.contractVersion].join(
    ":"
  );
}

function appLaunchMode(
  target: WorkspaceAppTarget
): "hosted-view" | "native-bootstrap" | "terminal-process" {
  if (target === "electron") return "hosted-view";
  if (target === "react-native") return "native-bootstrap";
  return "terminal-process";
}

function appRegistryStatusForTarget(target: WorkspaceAppTarget): AppRegistryEntry["status"] {
  return target === "terminal" ? "available" : "running";
}

function isCapabilityActiveStatus(status: AppRegistryEntry["status"]): boolean {
  return status === "running" || status === "available";
}

function isBuildProviderDetailsLike(value: unknown): value is AppBuildProviderDetails {
  if (!value || typeof value !== "object") return false;
  const provider = value as Partial<AppBuildProviderDetails>;
  return (
    typeof provider.name === "string" &&
    provider.name.length > 0 &&
    (typeof provider.activeEv === "string" || provider.activeEv === null) &&
    (typeof provider.activeBuildKey === "string" || provider.activeBuildKey === null) &&
    typeof provider.contractVersion === "string" &&
    provider.contractVersion.length > 0
  );
}

function appBuildMetadataForDist(
  entry: AppRegistryEntry,
  metadata: AppBuildMetadataLike
): BuildMetadata {
  const details = metadata.details;
  if (!isAppBuildDetailsLike(details)) {
    throw new Error(`Active build for ${entry.name} is not an app build`);
  }
  return {
    kind: "app",
    name: entry.name,
    ev: metadata.ev,
    sourcemap: true,
    details: {
      kind: "app",
      target: details.target,
      integrity: details.integrity ?? null,
      rnHostAbi: details.rnHostAbi ?? null,
      provider: details.provider ?? null,
    },
    builtAt: new Date().toISOString(),
  };
}

function isAppBuildDetailsLike(
  details: AppBuildMetadataLike["details"]
): details is Extract<NonNullable<AppBuildMetadataLike["details"]>, { kind: "app" }> {
  return (
    !!details && details.kind === "app" && (details as { target?: unknown }).target !== undefined
  );
}

function hasMobilePrimaryArtifacts(artifacts: Array<{ platform?: string }>): boolean {
  const seenPlatforms = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.platform !== "android" && artifact.platform !== "ios") return false;
    if (seenPlatforms.has(artifact.platform)) return false;
    seenPlatforms.add(artifact.platform);
  }
  return seenPlatforms.size > 0;
}

function appArtifactsForDist(
  entry: AppRegistryEntry,
  artifacts: Array<{
    path: string;
    role: string;
    contentType: string;
    encoding: string;
    platform?: string;
    content: string;
  }>
): Array<BuildArtifactManifestEntry & { content: string }> {
  return artifacts.map((artifact) => {
    if (!isBuildArtifactRole(artifact.role)) {
      throw new Error(`Active build for ${entry.name} has invalid artifact role: ${artifact.role}`);
    }
    if (!isBuildArtifactEncoding(artifact.encoding)) {
      throw new Error(
        `Active build for ${entry.name} has invalid artifact encoding: ${artifact.encoding}`
      );
    }
    return {
      path: artifact.path,
      role: artifact.role,
      contentType: artifact.contentType,
      encoding: artifact.encoding,
      ...(artifact.platform ? { platform: artifact.platform } : {}),
      content: artifact.content,
    };
  });
}

function isBuildArtifactRole(role: string): role is BuildArtifactManifestEntry["role"] {
  return (
    role === "primary" || role === "asset" || role === "html" || role === "css" || role === "map"
  );
}

function isBuildArtifactEncoding(
  encoding: string
): encoding is BuildArtifactManifestEntry["encoding"] {
  return encoding === "utf8" || encoding === "base64";
}

function encodeArtifactPath(artifactPath: string): string {
  return artifactPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function normalizeArtifactPath(remainderPath: string): string {
  const clean = decodeURIComponent(remainderPath.replace(/^\/+/, "")) || "index.html";
  if (path.isAbsolute(clean) || clean.split(/[\\/]/).includes("..")) return "__invalid__";
  return clean.replace(/\\/g, "/");
}

function mobileAppPrincipalId(repoPath: string, deviceId: string): string {
  return `app:${normalizeRepoPath(repoPath)}:${deviceId}`;
}

function isHostTargetSelection(value: unknown): value is HostTargetSelection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HostTargetSelection>;
  return (
    typeof candidate.workspaceId === "string" &&
    (candidate.target === "electron" ||
      candidate.target === "react-native" ||
      candidate.target === "terminal") &&
    typeof candidate.source === "string" &&
    typeof candidate.appId === "string" &&
    (candidate.mode === "follow-ref" ||
      candidate.mode === "pinned-build" ||
      candidate.mode === "pinned-commit") &&
    typeof candidate.updatedAt === "number"
  );
}

function appVersionRecordFromEntry(entry: AppRegistryEntry): AppVersionRecord | null {
  if (!entry.activeBundleKey) return null;
  return {
    version: entry.version,
    target: entry.target,
    autostart: entry.autostart,
    capabilities: [...entry.capabilities],
    activeEv: entry.activeEv,
    activeSha: entry.activeSha,
    activeBundleKey: entry.activeBundleKey,
    activeDependencyEvs: { ...(entry.activeDependencyEvs ?? {}) },
    activeExternalDeps: { ...(entry.activeExternalDeps ?? {}) },
    activeRuntimeDepsKey: entry.activeRuntimeDepsKey ?? null,
    activatedAt: Date.now(),
  };
}

function appVersionHistory(
  records: Array<AppVersionRecord | null | undefined>,
  limit = 5
): AppVersionRecord[] {
  const history: AppVersionRecord[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (!record || seen.has(record.activeBundleKey)) continue;
    seen.add(record.activeBundleKey);
    history.push(record);
    if (history.length >= limit) break;
  }
  return history;
}

function appAdoptionPolicy(
  target: WorkspaceAppTarget,
  lifecycleType: "available" | "update-available" | "rolled-back"
): "immediate" | "prompt" {
  if (target === "terminal") return "immediate";
  if (lifecycleType === "update-available") return "prompt";
  return "immediate";
}

function appUpdateTargetCopy(target: WorkspaceAppTarget): { title: string; message: string } {
  if (target === "react-native") {
    return {
      title: "Mobile app update available",
      message: "a new trusted bundle is ready. Open the mobile app to install it.",
    };
  }
  if (target === "terminal") {
    return {
      title: "Terminal app update available",
      message: "a new trusted terminal build is ready.",
    };
  }
  return {
    title: "Desktop app update available",
    message: "a new trusted build is ready to load.",
  };
}

function readPackageVersion(nodePath: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(nodePath, "package.json"), "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}

function resolveGitCommit(repoPath: string, ref = "HEAD"): string | null {
  try {
    return (
      String(
        execGitFileSync(["rev-parse", "--verify", "--end-of-options", ref], {
          cwd: repoPath,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        })
      ).trim() || null
    );
  } catch {
    return null;
  }
}

function readGitDirtyFiles(repoPath: string): string[] | null {
  try {
    const output = String(
      execGitFileSync(["status", "--porcelain=v1", "--untracked-files=normal"], {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    ).trimEnd();
    if (!output) return [];
    return output
      .split("\n")
      .map((line) => {
        const rawPath = line.length > 3 ? line.slice(3).trim() : line.trim();
        const renameParts = rawPath.split(" -> ");
        const renameTarget = rawPath.includes(" -> ")
          ? renameParts[renameParts.length - 1]
          : rawPath;
        return renameTarget?.replace(/^"|"$/g, "") ?? rawPath;
      })
      .filter((file) => file.length > 0);
  } catch {
    return null;
  }
}

function appDevDiagnosticsEnabled(): boolean {
  const override = process.env["NATSTACK_APP_DEV_STATUS"];
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  return process.env["NODE_ENV"] === "development";
}

function shortId(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 12 ? value.slice(0, 12) : value;
}

function summarizeFiles(files: readonly string[]): string {
  const shown = files.slice(0, 5);
  const suffix = files.length > shown.length ? `, +${files.length - shown.length} more` : "";
  return `${shown.join(", ")}${suffix}`;
}

const UNIT_DEV_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

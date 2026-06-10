import * as fs from "node:fs";
import * as path from "node:path";

export type UnitKind = "extension" | "app";

export interface UnitDescriptor<Kind extends UnitKind = UnitKind> {
  kind: Kind;
  sourceRoot: "extensions" | "apps";
  buildKind: Kind;
  approvalFraming: {
    serviceName: string;
    unitLabel: string;
    unitLabelPlural: string;
    nativeCode: boolean;
  };
  seedTrustEligible: boolean;
}

export type UnitRegistryStatus =
  | "running"
  | "available"
  | "stopped"
  | "error"
  | "pending-approval"
  | "building";

export interface UnitSource {
  kind: "internal-git";
  repo: string;
  ref: string;
}

export interface UnitBuildIdentity<Kind extends UnitKind = UnitKind> {
  unitKind: Kind;
  name: string;
  source: UnitSource;
  effectiveVersion: string | null;
  dependencyEvs: Record<string, string>;
  externalDeps: Record<string, string>;
  capabilities?: string[];
}

export type UnitTrustDecision =
  | "product-seed-trusted"
  | "user-approved"
  | "session-granted"
  | "preapproved"
  | "needs-approval";

export interface UnitTrustResolution {
  decision: UnitTrustDecision;
  identityKey: string;
}

export interface UnitTrustResolverOptions<Entry extends UnitRegistryEntryBase> {
  entryIdentity?: (entry: Entry) => UnitBuildIdentity<Entry["unitKind"]> | null;
  productSeedTrust?: (identity: UnitBuildIdentity<Entry["unitKind"]>) => boolean;
}

export interface UnitTrustResolveContext<Entry extends UnitRegistryEntryBase> {
  identity: UnitBuildIdentity<Entry["unitKind"]>;
  entry: Entry | null;
  sessionGrantedIdentityKeys?: ReadonlySet<string>;
  preapprovedIdentityKeys?: ReadonlySet<string>;
}

export class UnitTrustResolver<Entry extends UnitRegistryEntryBase> {
  constructor(private readonly opts: UnitTrustResolverOptions<Entry> = {}) {}

  resolve(ctx: UnitTrustResolveContext<Entry>): UnitTrustResolution {
    const identityKey = canonicalUnitBuildIdentity(ctx.identity);
    if (this.isUserApproved(ctx.entry, ctx.identity)) {
      return { decision: "user-approved", identityKey };
    }
    if (this.opts.productSeedTrust?.(ctx.identity)) {
      return { decision: "product-seed-trusted", identityKey };
    }
    if (ctx.sessionGrantedIdentityKeys?.has(identityKey)) {
      return { decision: "session-granted", identityKey };
    }
    if (ctx.preapprovedIdentityKeys?.has(identityKey)) {
      return { decision: "preapproved", identityKey };
    }
    return { decision: "needs-approval", identityKey };
  }

  private isUserApproved(entry: Entry | null, identity: UnitBuildIdentity<Entry["unitKind"]>): boolean {
    if (!entry?.activeBundleKey || entry.status === "pending-approval") return false;
    const entryIdentity = this.opts.entryIdentity?.(entry) ?? unitBuildIdentityFromRegistryEntry(entry);
    if (!entryIdentity) return false;
    return unitBuildIdentitiesMatch(entryIdentity, identity);
  }
}

export interface UnitRegistryEntryBase {
  unitKind: UnitKind;
  name: string;
  version: string;
  source: UnitSource;
  installedAt: number;
  activeEv: string | null;
  activeSha: string | null;
  activeBundleKey: string | null;
  activeDependencyEvs: Record<string, string>;
  activeExternalDeps: Record<string, string>;
  activeRuntimeDepsKey: string | null;
  status: UnitRegistryStatus;
  lastError: string | null;
}

export interface UnitDeclaration {
  source: string;
  ref: string;
}

export interface UnitGraphNode {
  name: string;
  relativePath: string;
  manifest?: {
    displayName?: string;
  };
}

export interface UnitDependencyGraphNode extends UnitGraphNode {
  internalDeps: string[];
}

export interface UnitTypedGraphNode extends UnitGraphNode {
  kind: string;
}

export function findUnitGraphNode<Node extends UnitTypedGraphNode>(
  nodes: Iterable<Node>,
  descriptor: { buildKind: UnitKind; approvalFraming: Pick<UnitDescriptor["approvalFraming"], "unitLabel"> },
  nameOrRepo: string,
): Node {
  const normalizedRepo = normalizeUnitRepoPath(nameOrRepo);
  for (const candidate of nodes) {
    if (candidate.kind !== descriptor.buildKind) continue;
    if (
      candidate.name === nameOrRepo
      || normalizeUnitRepoPath(candidate.relativePath) === normalizedRepo
    ) {
      return candidate;
    }
  }
  throw new Error(`Unknown ${descriptor.approvalFraming.unitLabel} unit: ${nameOrRepo}`);
}

export function collectTransitiveUnitDependencyEvs<Node extends UnitDependencyGraphNode>(
  nodes: Iterable<Node>,
  root: Node,
  getEffectiveVersion: (name: string) => string | null | undefined,
): Record<string, string> {
  const activeDependencyEvs: Record<string, string> = {};
  const byName = new Map(Array.from(nodes, (node) => [node.name, node] as const));
  const visited = new Set<string>();

  const visit = (depName: string): void => {
    if (visited.has(depName)) return;
    visited.add(depName);
    const depEv = getEffectiveVersion(depName);
    if (depEv) activeDependencyEvs[depName] = depEv;
    const depNode = byName.get(depName);
    if (!depNode) return;
    for (const transitive of depNode.internalDeps) visit(transitive);
  };

  for (const dep of root.internalDeps) visit(dep);
  return activeDependencyEvs;
}

export interface UnitWorkspaceStatus<Kind extends UnitKind = UnitKind> {
  name: string;
  kind: Kind;
  source: string;
  displayName: string;
  status: UnitRegistryStatus;
  version: string;
  ev: string | null;
  activeEv: string | null;
  activeBundleKey: string | null;
  activeRuntimeDepsKey: string | null;
  lastError: string | null;
}

export interface UnitWorkspaceLogRecord<Kind extends UnitKind = UnitKind> {
  workspaceId: string;
  unitName: string;
  kind: Kind;
  timestamp: number;
  level: "info" | "error";
  message: string;
}

export interface UnitBuildActivationOptions<Entry extends UnitRegistryEntryBase> {
  name: string;
  version: string;
  sourceRepo: string;
  ref: string;
  buildDir: string;
  effectiveVersion: string;
  activeSha: string | null;
  dependencyEvs: Record<string, string>;
  externalDeps: Record<string, string>;
  runtimeDepsKey?: string | null;
  status?: UnitRegistryStatus;
  extra?: Partial<Entry>;
}

export interface UnitBuildRefreshOptions {
  sourceRepo: string;
  ref: string;
  effectiveVersion: string | null;
  dependencyEvs: Record<string, string>;
  externalDeps: Record<string, string>;
  runtimeDepsKey?: string | null;
}

export interface UnitBuildIdentityOptions<Kind extends UnitKind> {
  unitKind: Kind;
  name: string;
  sourceRepo: string;
  ref: string;
  effectiveVersion: string | null;
  dependencyEvs: Record<string, string>;
  externalDeps: Record<string, string>;
  capabilities?: Iterable<string>;
}

export function createUnitBuildIdentity<Kind extends UnitKind>(
  opts: UnitBuildIdentityOptions<Kind>,
): UnitBuildIdentity<Kind> {
  const capabilities = opts.capabilities ? [...opts.capabilities].sort() : undefined;
  return {
    unitKind: opts.unitKind,
    name: opts.name,
    source: { kind: "internal-git", repo: normalizeUnitRepoPath(opts.sourceRepo), ref: opts.ref },
    effectiveVersion: opts.effectiveVersion,
    dependencyEvs: opts.dependencyEvs,
    externalDeps: opts.externalDeps,
    ...(capabilities ? { capabilities } : {}),
  };
}

export interface UnitBatchEntryBase<Kind extends UnitKind = UnitKind> {
  unitKind: Kind;
  unitName: string;
  displayName: string;
  version: string | null;
  source: UnitSource;
  ev: string | null;
  dependencyEvs: Record<string, string>;
  externalDeps: Record<string, string>;
  commit: null;
}

export interface UnitBatchEntryBaseOptions<Kind extends UnitKind> {
  unitKind: Kind;
  name: string;
  displayName?: string;
  version: string | null;
  sourceRepo: string;
  ref: string;
  effectiveVersion: string | null;
  dependencyEvs: Record<string, string>;
  externalDeps: Record<string, string>;
}

export interface UnitRuntimeApplyOptions<
  Entry extends UnitRegistryEntryBase,
  Decl extends UnitDeclaration,
  Node extends UnitGraphNode,
> {
  node: Node;
  decl: Decl;
  validateBeforeApply?: (node: Node, decl: Decl) => void;
  validateBeforeActivateCurrent?: (entry: Entry, node: Node, decl: Decl) => void;
  needsBuildRefresh: (entry: Entry, node: Node, decl: Decl) => boolean;
  buildAndActivate: (node: Node, decl: Decl) => Promise<void>;
  activateCurrent: (entry: Entry, node: Node, decl: Decl) => Promise<void>;
  onError?: (node: Node, decl: Decl, message: string) => void;
}

export interface ResolvedUnitDeclaration<Decl extends UnitDeclaration, Node extends UnitGraphNode> {
  decl: Decl;
  node: Node;
}

export interface UnitHostOptions<
  Entry extends UnitRegistryEntryBase,
  Decl extends UnitDeclaration,
  Node extends UnitGraphNode,
  ApprovalEntry,
> {
  descriptor: UnitDescriptor<Entry["unitKind"]>;
  registry: UnitRegistry<Entry>;
  currentDeclarationVersion(): string | null;
  resolveNode(source: string): Node;
  candidateIdentity(node: Node, decl: Decl): UnitBuildIdentity<Entry["unitKind"]>;
  trustResolver?: UnitTrustResolver<Entry>;
  makePendingEntry(node: Node, decl: Decl, building?: boolean): Entry;
  applyTrusted(node: Node, decl: Decl): Promise<void>;
  removeUndeclared(entry: Entry): Promise<void>;
  emitRemoved(entry: Entry): void;
  notifyUnresolved(sources: string[]): void;
  approvalEntry(node: Node, decl: Decl): ApprovalEntry;
  requestApproval(entries: ApprovalEntry[], trigger: "startup" | "meta-push"): Promise<"once" | "session" | "version" | "repo" | "deny">;
  approvalCoordinator?: UnitApprovalCoordinator<ApprovalEntry>;
  onApprovalDenied(items: Array<ResolvedUnitDeclaration<Decl, Node>>): void;
  onBackgroundError(error: unknown): void;
}

export interface UnitApprovalCoordinator<ApprovalEntry> {
  enqueue(request: {
    entries: ApprovalEntry[];
    trigger: "startup" | "meta-push";
    applyApproved(): Promise<void>;
    applyDenied(): void;
  }): Promise<void>;
}

export type UnitReconcileTrigger = "startup" | "meta-push";
export type UnitApprovalDecision = "once" | "session" | "version" | "repo" | "deny";

export interface UnitBatchApprovalQueue<ApprovalEntry, ConfigWrite = unknown> {
  request(req: {
    kind: "unit-batch";
    callerId: string;
    callerKind: "system";
    repoPath: string;
    effectiveVersion: string;
    trigger: UnitReconcileTrigger;
    title: string;
    description: string;
    units: ApprovalEntry[];
    configWrite?: ConfigWrite | null;
  }): Promise<UnitApprovalDecision>;
}

export function requestUnitBatchApproval<
  Kind extends UnitKind,
  ApprovalEntry,
  ConfigWrite = unknown,
>(opts: {
  descriptor: UnitDescriptor<Kind>;
  approvalQueue: UnitBatchApprovalQueue<ApprovalEntry, ConfigWrite>;
  entries: ApprovalEntry[];
  trigger: UnitReconcileTrigger;
  configWrite?: ConfigWrite | null;
}): Promise<UnitApprovalDecision> {
  return opts.approvalQueue.request({
    kind: "unit-batch",
    callerId: `system:${opts.descriptor.sourceRoot}`,
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "",
    trigger: opts.trigger,
    title: `Approve workspace ${opts.descriptor.approvalFraming.unitLabelPlural}`,
    description: unitBatchApprovalDescription(opts.descriptor, opts.entries.length),
    units: opts.entries,
    configWrite: opts.configWrite ?? null,
  });
}

function unitBatchApprovalDescription(descriptor: UnitDescriptor, count: number): string {
  const label = count === 1
    ? descriptor.approvalFraming.unitLabel
    : descriptor.approvalFraming.unitLabelPlural;
  const privilege = descriptor.kind === "app"
    ? "privileged"
    : descriptor.approvalFraming.nativeCode
      ? "native-code"
      : "trusted";
  const runtime = descriptor.kind === "app" ? "in the app host" : "as native code";
  const verb = count === 1 ? "needs" : "need";
  return `This workspace uses ${count} ${privilege} ${label} that ${verb} approval to run ${runtime}.`;
}

interface UnitSourcePushGrantFile {
  grants: Array<{ key: string; expiresAt: number }>;
}

/**
 * Persistent per-unit dev-session push grants. These are intentionally keyed
 * by callers and unit/repo/branch by the host that owns the push decision.
 */
export class UnitSourcePushGrantStore {
  private readonly filePath: string;
  private grants = new Map<string, number>();

  constructor(opts: { statePath: string }) {
    this.filePath = path.join(opts.statePath, "units", "source-push-grants.json");
    this.load();
  }

  hasActive(key: string, now = Date.now()): boolean {
    const expiresAt = this.grants.get(key);
    if (!expiresAt) return false;
    if (expiresAt > now) return true;
    this.grants.delete(key);
    this.save();
    return false;
  }

  grant(key: string, ttlMs: number, now = Date.now()): void {
    this.grants.set(key, now + ttlMs);
    this.save();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as UnitSourcePushGrantFile;
      const now = Date.now();
      this.grants = new Map(
        (Array.isArray(parsed.grants) ? parsed.grants : [])
          .filter((grant) =>
            typeof grant.key === "string"
            && typeof grant.expiresAt === "number"
            && grant.expiresAt > now
          )
          .map((grant) => [grant.key, grant.expiresAt]),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[UnitSourcePushGrantStore] Failed to load grants:", err);
      }
      this.grants = new Map();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    const payload: UnitSourcePushGrantFile = {
      grants: [...this.grants.entries()].map(([key, expiresAt]) => ({ key, expiresAt })),
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

export type UnitSourcePushDecision = UnitApprovalDecision;
export type UnitUserlandCallerKind = "panel" | "app" | "worker" | "do";

export interface UnitSourcePushCallerIdentity {
  callerKind: string;
  repoPath: string;
  effectiveVersion: string;
}

export interface UnitSourcePushCaller {
  runtime: { id: string; kind: string };
  code?: UnitSourcePushCallerIdentity | null;
}

export interface UnitSourcePushRequest {
  caller: UnitSourcePushCaller;
  repoPath: string;
  branch: string;
  commit: string;
}

export interface UnitSourcePushAuthorizationDecision {
  allowed: boolean;
  reason?: string;
}

export interface UnitSourcePushHandler {
  authorizeSourcePush(
    request: UnitSourcePushRequest,
  ): Promise<UnitSourcePushAuthorizationDecision> | UnitSourcePushAuthorizationDecision;
}

export interface UnitSourcePushTarget {
  sourceRoot: string;
  getHandler(): UnitSourcePushHandler | null | undefined;
}

export interface UnitMetaPushApprovalProvider<ApprovalEntry = unknown> {
  metaPushApprovalForCommit(commit: string): { units: ApprovalEntry[]; identityKeys: string[] };
  acceptPreapprovedTrust(version: string, keys: Iterable<string>): void;
}

export interface InstalledUnitForSourcePush<Entry extends UnitRegistryEntryBase, Node extends UnitGraphNode> {
  entry: Entry;
  node: Node;
}

export interface UnitSourcePushApprovalContext<
  Entry extends UnitRegistryEntryBase,
  Node extends UnitGraphNode,
> {
  request: UnitSourcePushRequest;
  repoPath: string;
  installed: InstalledUnitForSourcePush<Entry, Node>;
  identity: UnitSourcePushCallerIdentity;
  callerKind: UnitUserlandCallerKind;
  sessionGrantKey: string;
}

export interface UnitSourcePushAuthorizerOptions<
  Entry extends UnitRegistryEntryBase,
  Node extends UnitGraphNode,
> {
  descriptor: UnitDescriptor<Entry["unitKind"]>;
  grantStore: Pick<UnitSourcePushGrantStore, "hasActive" | "grant">;
  grantTtlMs: number;
  findInstalledByRepo(repoPath: string): InstalledUnitForSourcePush<Entry, Node> | null;
  requestApproval(ctx: UnitSourcePushApprovalContext<Entry, Node>): Promise<UnitSourcePushDecision>;
}

export async function authorizeUnitSourcePush<
  Entry extends UnitRegistryEntryBase,
  Node extends UnitGraphNode,
>(
  opts: UnitSourcePushAuthorizerOptions<Entry, Node>,
  request: UnitSourcePushRequest,
): Promise<UnitSourcePushAuthorizationDecision> {
  const repoPath = normalizeUnitRepoPath(request.repoPath);
  const branch = normalizeUnitRef(request.branch);
  const normalizedRequest = { ...request, repoPath, branch };
  const installed = opts.findInstalledByRepo(repoPath);
  if (!installed) return { allowed: true };
  if (!sourcePushTouchesUnitRef(branch, installed.entry.source.ref)) {
    return { allowed: true };
  }

  if (request.caller.runtime.kind === "shell" || request.caller.runtime.kind === "server") {
    return { allowed: true };
  }

  const sessionGrantKey = unitPushSessionGrantKey(
    request.caller.runtime.id,
    installed.entry.name,
    repoPath,
    branch,
  );
  if (opts.grantStore.hasActive(sessionGrantKey)) {
    return { allowed: true };
  }

  const callerKind = unitUserlandCallerKind(request.caller.runtime.kind);
  if (!callerKind) {
    return {
      allowed: false,
      reason: `${capitalize(opts.descriptor.approvalFraming.unitLabel)} source pushes from ${request.caller.runtime.kind} callers are not supported`,
    };
  }

  const identity = request.caller.code;
  if (!identity || identity.callerKind !== request.caller.runtime.kind) {
    return { allowed: false, reason: `Unknown caller identity: ${request.caller.runtime.id}` };
  }

  const decision = await opts.requestApproval({
    request: normalizedRequest,
    repoPath,
    installed,
    identity,
    callerKind,
    sessionGrantKey,
  });
  if (decision === "deny") {
    return {
      allowed: false,
      reason: `${capitalize(opts.descriptor.approvalFraming.unitLabel)} source push denied`,
    };
  }
  if (decision === "session") {
    opts.grantStore.grant(sessionGrantKey, opts.grantTtlMs);
  }
  return { allowed: true };
}

export function normalizeUnitRepoPath(repoPath: string): string {
  return repoPath
    .replace(/^\/+/, "")
    .replace(/^workspace\//, "")
    .replace(/\.git(\/.*)?$/, "")
    .replace(/\/+$/, "");
}

export function normalizeUnitRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

export function unitPushSessionGrantKey(
  callerId: string,
  unitName: string,
  repoPath: string,
  branch: string,
): string {
  return `${callerId}\x00${unitName}\x00${repoPath}\x00${branch}`;
}

function unitUserlandCallerKind(kind: string): UnitUserlandCallerKind | null {
  if (kind === "panel" || kind === "app" || kind === "worker" || kind === "do") return kind;
  return null;
}

function sourcePushTouchesUnitRef(branch: string, ref: string): boolean {
  return normalizeUnitRef(branch) === normalizeUnitRef(ref);
}

function capitalize(value: string): string {
  if (value.length === 0) return value;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export class UnitHost<
  Entry extends UnitRegistryEntryBase,
  Decl extends UnitDeclaration,
  Node extends UnitGraphNode,
  ApprovalEntry,
> {
  private reconciling: Promise<void> | null = null;
  private backgroundFlow: Promise<void> | null = null;
  private preapprovedTrust: { version: string | null; keys: Set<string> } | null = null;
  private readonly trustResolver: UnitTrustResolver<Entry>;

  constructor(private readonly opts: UnitHostOptions<Entry, Decl, Node, ApprovalEntry>) {
    this.trustResolver = opts.trustResolver ?? new UnitTrustResolver<Entry>();
  }

  acceptPreapprovedTrust(version: string, keys: Iterable<string>): void {
    this.preapprovedTrust = { version, keys: new Set(keys) };
  }

  async reconcileDeclared(
    declared: Decl[],
    opts: { trigger?: UnitReconcileTrigger } = {},
  ): Promise<void> {
    const run = (this.reconciling ?? Promise.resolve()).then(() =>
      this.reconcileDeclaredOnce(declared, opts.trigger ?? "startup"),
    );
    this.reconciling = run.catch(() => {});
    await run;
  }

  async whenSettled(): Promise<void> {
    await this.reconciling;
    await this.backgroundFlow;
  }

  async whenReconciled(): Promise<void> {
    await this.reconciling;
  }

  approvalForDeclarations(declared: Decl[]): { entries: ApprovalEntry[]; identityKeys: string[] } {
    const entries: ApprovalEntry[] = [];
    const identityKeys: string[] = [];
    for (const decl of declared) {
      let node: Node;
      try {
        node = this.opts.resolveNode(decl.source);
      } catch {
        continue;
      }
      const entry = this.opts.registry.get(node.name);
      const identity = this.opts.candidateIdentity(node, decl);
      const trust = this.trustResolver.resolve({ identity, entry });
      if (trust.decision !== "needs-approval") continue;
      entries.push(this.opts.approvalEntry(node, decl));
      identityKeys.push(trust.identityKey);
    }
    return { entries, identityKeys };
  }

  preapproveDeclarations(declared: Decl[]): { entries: ApprovalEntry[]; identityKeys: string[] } {
    const approval = this.approvalForDeclarations(declared);
    const version = this.opts.currentDeclarationVersion();
    if (approval.identityKeys.length > 0) {
      this.preapprovedTrust = { version, keys: new Set(approval.identityKeys) };
    }
    return approval;
  }

  trustForDeclaration(node: Node, decl: Decl): UnitTrustResolution {
    return this.trustResolver.resolve({
      identity: this.opts.candidateIdentity(node, decl),
      entry: this.opts.registry.get(node.name),
    });
  }

  async applyRuntimeDeclaration(
    opts: UnitRuntimeApplyOptions<Entry, Decl, Node>,
  ): Promise<void> {
    const { node, decl } = opts;
    try {
      opts.validateBeforeApply?.(node, decl);
      const entry = this.opts.registry.get(node.name);
      const trust = this.trustForDeclaration(node, decl);
      if (!entry || trust.decision !== "user-approved" || opts.needsBuildRefresh(entry, node, decl)) {
        if (!entry) {
          this.opts.registry.upsert(this.opts.makePendingEntry(node, decl, true));
        }
        await opts.buildAndActivate(node, decl);
        return;
      }

      opts.validateBeforeActivateCurrent?.(entry, node, decl);
      await opts.activateCurrent(entry, node, decl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.markError(node.name, message);
      opts.onError?.(node, decl, message);
    }
  }

  activateBuild(opts: UnitBuildActivationOptions<Entry>): Entry {
    return this.opts.registry.patch(opts.name, {
      ...opts.extra,
      source: { kind: "internal-git", repo: normalizeUnitRepoPath(opts.sourceRepo), ref: opts.ref },
      version: opts.version,
      activeEv: opts.effectiveVersion,
      activeSha: opts.activeSha,
      activeBundleKey: path.basename(opts.buildDir),
      activeDependencyEvs: opts.dependencyEvs,
      activeExternalDeps: opts.externalDeps,
      activeRuntimeDepsKey: opts.runtimeDepsKey ?? null,
      status: opts.status ?? "running",
      lastError: null,
    } as Partial<Entry>);
  }

  activeSourceMatches(
    entry: Entry,
    sourceRepo: string,
    ref: string,
  ): boolean {
    return unitEntrySourceMatches(entry, sourceRepo, ref);
  }

  needsBuildRefresh(entry: Entry, opts: UnitBuildRefreshOptions): boolean {
    if (!unitEntrySourceMatches(entry, opts.sourceRepo, opts.ref)) return true;
    if (opts.effectiveVersion && entry.activeEv !== opts.effectiveVersion) return true;
    if (!recordsEqual(entry.activeDependencyEvs ?? {}, opts.dependencyEvs)) return true;
    if (!recordsEqual(entry.activeExternalDeps ?? {}, opts.externalDeps)) return true;
    if (
      opts.runtimeDepsKey !== undefined
      && (entry.activeRuntimeDepsKey ?? null) !== opts.runtimeDepsKey
    ) {
      return true;
    }
    return false;
  }

  markBuilding(name: string): Entry {
    return this.opts.registry.patch(name, {
      status: "building",
      lastError: null,
    } as Partial<Entry>);
  }

  markError(name: string, message: string): Entry | null {
    if (!this.opts.registry.has(name)) return null;
    return this.opts.registry.patch(name, {
      status: "error",
      lastError: message,
    } as Partial<Entry>);
  }

  findInstalledByRepo(repoPath: string): InstalledUnitForSourcePush<Entry, Node> | null {
    const normalizedRepo = normalizeUnitRepoPath(repoPath);
    for (const entry of this.opts.registry.list()) {
      let node: Node;
      try {
        node = this.opts.resolveNode(entry.name);
      } catch {
        continue;
      }
      const sourceRepo = normalizeUnitRepoPath(entry.source.repo);
      const relativePath = normalizeUnitRepoPath(node.relativePath);
      if (
        normalizedRepo === sourceRepo
        || normalizedRepo.startsWith(`${sourceRepo}/`)
        || normalizedRepo === relativePath
        || normalizedRepo.startsWith(`${relativePath}/`)
      ) {
        return { entry, node };
      }
    }
    return null;
  }

  listWorkspaceUnits(): Array<UnitWorkspaceStatus<Entry["unitKind"]>> {
    return this.opts.registry.list().map((entry) => {
      const node = this.tryResolveNode(entry.name);
      return unitWorkspaceStatus(this.opts.descriptor.kind, entry, {
        source: node?.relativePath ?? entry.source.repo,
        displayName: node?.manifest?.displayName,
      });
    });
  }

  listWorkspaceUnitLogs(
    workspaceId: string,
    sourceOrName: string,
  ): Array<UnitWorkspaceLogRecord<Entry["unitKind"]>> {
    const entry = this.opts.registry.get(sourceOrName)
      ?? this.opts.registry.list().find((candidate) =>
        normalizeUnitRepoPath(candidate.source.repo) === normalizeUnitRepoPath(sourceOrName)
      );
    if (!entry) return [];
    return [unitWorkspaceLogRecord(this.opts.descriptor.kind, workspaceId, entry)];
  }

  private async reconcileDeclaredOnce(declared: Decl[], trigger: UnitReconcileTrigger): Promise<void> {
    const version = this.opts.currentDeclarationVersion();
    const preApproved =
      this.preapprovedTrust && version === this.preapprovedTrust.version
        ? this.preapprovedTrust.keys
        : new Set<string>();
    this.preapprovedTrust = null;

    const resolved: Array<ResolvedUnitDeclaration<Decl, Node>> = [];
    const unresolved: string[] = [];
    for (const decl of declared) {
      try {
        resolved.push({ decl, node: this.opts.resolveNode(decl.source) });
      } catch {
        unresolved.push(decl.source);
      }
    }
    if (unresolved.length > 0) this.opts.notifyUnresolved(unresolved);

    const declaredByName = new Map(resolved.map((item) => [item.node.name, item]));
    const needsApproval: Array<ResolvedUnitDeclaration<Decl, Node>> = [];

    for (const { node, decl } of resolved) {
      const entry = this.opts.registry.get(node.name);
      const trust = this.trustResolver.resolve({
        identity: this.opts.candidateIdentity(node, decl),
        entry,
        preapprovedIdentityKeys: preApproved,
      });
      if (trust.decision !== "needs-approval") {
        await this.opts.applyTrusted(node, decl);
      } else {
        if (!entry) this.opts.registry.upsert(this.opts.makePendingEntry(node, decl));
        needsApproval.push({ node, decl });
      }
    }

    for (const entry of this.opts.registry.list()) {
      if (declaredByName.has(entry.name)) continue;
      await this.opts.removeUndeclared(entry);
      this.opts.registry.delete(entry.name);
      this.opts.emitRemoved(entry);
    }

    if (needsApproval.length > 0) {
      const startApproval = () => this.promptAndApply(needsApproval, trigger);
      const flow = this.backgroundFlow ? this.backgroundFlow.then(startApproval) : startApproval();
      const tracked = flow
        .catch((err) => this.opts.onBackgroundError(err))
        .finally(() => {
          if (this.backgroundFlow === tracked) {
            this.backgroundFlow = null;
          }
        });
      this.backgroundFlow = tracked;
    }
  }

  private async promptAndApply(
    items: Array<ResolvedUnitDeclaration<Decl, Node>>,
    trigger: UnitReconcileTrigger,
  ): Promise<void> {
    const entries = items.map(({ node, decl }) => this.opts.approvalEntry(node, decl));
    if (this.opts.approvalCoordinator) {
      await this.opts.approvalCoordinator.enqueue({
        entries,
        trigger,
        applyApproved: async () => {
          for (const { node, decl } of items) {
            await this.opts.applyTrusted(node, decl);
          }
        },
        applyDenied: () => this.opts.onApprovalDenied(items),
      });
      return;
    }
    const decision = await this.opts.requestApproval(entries, trigger);
    if (decision === "deny") {
      this.opts.onApprovalDenied(items);
      return;
    }
    for (const { node, decl } of items) {
      await this.opts.applyTrusted(node, decl);
    }
  }

  private tryResolveNode(source: string): Node | null {
    try {
      return this.opts.resolveNode(source);
    } catch {
      return null;
    }
  }

}

export function unitWorkspaceStatus<Entry extends UnitRegistryEntryBase>(
  kind: Entry["unitKind"],
  entry: Entry,
  opts: { source?: string; displayName?: string } = {},
): UnitWorkspaceStatus<Entry["unitKind"]> {
  return {
    name: entry.name,
    kind,
    source: opts.source ?? entry.source.repo,
    displayName: opts.displayName ?? entry.name,
    status: entry.status,
    version: entry.version,
    ev: entry.activeEv,
    activeEv: entry.activeEv,
    activeBundleKey: entry.activeBundleKey,
    activeRuntimeDepsKey: entry.activeRuntimeDepsKey,
    lastError: entry.lastError,
  };
}

export function unitWorkspaceLogRecord<Entry extends UnitRegistryEntryBase>(
  kind: Entry["unitKind"],
  workspaceId: string,
  entry: Entry,
): UnitWorkspaceLogRecord<Entry["unitKind"]> {
  const level = entry.status === "error" ? "error" : "info";
  return {
    workspaceId,
    unitName: entry.name,
    kind,
    timestamp: entry.installedAt,
    level,
    message: entry.lastError ?? `${kind === "app" ? "App" : "Extension"} ${entry.name} is ${entry.status}`,
  };
}

export function createPendingUnitRegistryEntry<Kind extends UnitKind>(opts: {
  unitKind: Kind;
  name: string;
  version: string;
  sourceRepo: string;
  ref: string;
  building?: boolean;
  installedAt?: number;
}): UnitRegistryEntryBase & { unitKind: Kind } {
  return {
    unitKind: opts.unitKind,
    name: opts.name,
    version: opts.version,
    source: { kind: "internal-git", repo: normalizeUnitRepoPath(opts.sourceRepo), ref: opts.ref },
    installedAt: opts.installedAt ?? Date.now(),
    activeEv: null,
    activeSha: null,
    activeBundleKey: null,
    activeDependencyEvs: {},
    activeExternalDeps: {},
    activeRuntimeDepsKey: null,
    status: opts.building ? "building" : "pending-approval",
    lastError: null,
  };
}

export function createUnitBatchEntryBase<Kind extends UnitKind>(
  opts: UnitBatchEntryBaseOptions<Kind>,
): UnitBatchEntryBase<Kind> {
  return {
    unitKind: opts.unitKind,
    unitName: opts.name,
    displayName: opts.displayName ?? opts.name,
    version: opts.version,
    source: { kind: "internal-git", repo: normalizeUnitRepoPath(opts.sourceRepo), ref: opts.ref },
    ev: opts.effectiveVersion,
    dependencyEvs: opts.dependencyEvs,
    externalDeps: opts.externalDeps,
    commit: null,
  };
}

interface UnitRegistryFile<Entry extends UnitRegistryEntryBase> {
  unitKind: Entry["unitKind"];
  entries: Entry[];
}

export interface UnitRegistryOptions<Entry extends UnitRegistryEntryBase> {
  statePath: string;
  unitKind: Entry["unitKind"];
  isEntry?: (value: unknown) => value is Entry;
  normalizeEntry?: (entry: Entry) => Entry;
}

export class UnitRegistry<Entry extends UnitRegistryEntryBase> {
  private entries = new Map<string, Entry>();
  private readonly filePath: string;
  private readonly unitKind: Entry["unitKind"];
  private readonly isEntry: (value: unknown) => value is Entry;
  private readonly normalizeEntry: (entry: Entry) => Entry;

  constructor(opts: UnitRegistryOptions<Entry>) {
    this.unitKind = opts.unitKind;
    this.filePath = path.join(opts.statePath, "units", this.unitKind, "registry.json");
    this.isEntry = opts.isEntry ?? ((value): value is Entry => isUnitRegistryEntry(value, this.unitKind));
    this.normalizeEntry = opts.normalizeEntry ?? ((entry) => normalizeUnitRegistryEntry(entry));
    this.load();
  }

  list(): Entry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  get(name: string): Entry | null {
    const entry = this.entries.get(name);
    return entry ? { ...entry } : null;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  upsert(entry: Entry): void {
    this.assertUnitKind(entry);
    this.entries.set(entry.name, this.normalizeEntry({ ...entry }));
    this.save();
  }

  patch(name: string, patch: Partial<Entry>): Entry {
    const current = this.entries.get(name);
    if (!current) throw new Error(`Unit is not installed: ${name}`);
    const next = this.normalizeEntry({ ...current, ...patch, unitKind: this.unitKind, name });
    this.assertUnitKind(next);
    this.entries.set(name, next);
    this.save();
    return { ...next };
  }

  delete(name: string): boolean {
    const deleted = this.entries.delete(name);
    if (deleted) this.save();
    return deleted;
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as UnitRegistryFile<Entry>;
      if (parsed.unitKind !== this.unitKind) {
        throw new Error(`Registry kind mismatch: expected ${this.unitKind}, found ${String(parsed.unitKind)}`);
      }
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.filter(this.isEntry).map(this.normalizeEntry)
        : [];
      this.entries = new Map(entries.map((entry) => [entry.name, entry]));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[UnitRegistry:${this.unitKind}] Failed to load registry:`, err);
      }
      this.entries = new Map();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    const payload: UnitRegistryFile<Entry> = {
      unitKind: this.unitKind,
      entries: this.list(),
    };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  private assertUnitKind(entry: Entry): void {
    if (entry.unitKind !== this.unitKind) {
      throw new Error(`Cannot store ${entry.unitKind} in ${this.unitKind} registry: ${entry.name}`);
    }
  }
}

export function normalizeUnitRegistryEntry<Entry extends UnitRegistryEntryBase>(entry: Entry): Entry {
  return {
    ...entry,
    activeDependencyEvs: entry.activeDependencyEvs ?? {},
    activeExternalDeps: entry.activeExternalDeps ?? {},
  };
}

export function isUnitRegistryEntry<Kind extends UnitKind>(
  value: unknown,
  unitKind: Kind,
): value is UnitRegistryEntryBase & { unitKind: Kind } {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<UnitRegistryEntryBase>;
  return (
    entry.unitKind === unitKind
    && typeof entry.name === "string"
    && typeof entry.version === "string"
    && !!entry.source
    && entry.source.kind === "internal-git"
    && typeof entry.source.repo === "string"
    && typeof entry.source.ref === "string"
    && typeof entry.installedAt === "number"
    && typeof entry.status === "string"
  );
}

export function unitBuildIdentityFromRegistryEntry<Entry extends UnitRegistryEntryBase>(
  entry: Entry,
  capabilities?: Iterable<string>,
): UnitBuildIdentity<Entry["unitKind"]> {
  return createUnitBuildIdentity({
    unitKind: entry.unitKind,
    name: entry.name,
    sourceRepo: entry.source.repo,
    ref: entry.source.ref,
    effectiveVersion: entry.activeEv,
    dependencyEvs: entry.activeDependencyEvs ?? {},
    externalDeps: entry.activeExternalDeps ?? {},
    capabilities,
  });
}

export function canonicalUnitBuildIdentity(identity: UnitBuildIdentity): string {
  return JSON.stringify(canonicalize(identity));
}

function unitBuildIdentitiesMatch(
  approved: UnitBuildIdentity,
  candidate: UnitBuildIdentity,
): boolean {
  if (approved.unitKind !== candidate.unitKind) return false;
  if (approved.name !== candidate.name) return false;
  if (approved.source.kind !== candidate.source.kind) return false;
  if (approved.source.repo !== candidate.source.repo) return false;
  if (approved.source.ref !== candidate.source.ref) return false;
  if (approved.effectiveVersion === null || candidate.effectiveVersion === null) return false;
  if (approved.effectiveVersion !== candidate.effectiveVersion) return false;
  if (!recordsEqual(approved.dependencyEvs, candidate.dependencyEvs)) return false;
  if (!recordsEqual(approved.externalDeps, candidate.externalDeps)) return false;
  const approvedCapabilities = approved.capabilities ?? null;
  const candidateCapabilities = candidate.capabilities ?? null;
  if ((approvedCapabilities === null) !== (candidateCapabilities === null)) return false;
  if (approvedCapabilities && candidateCapabilities && approvedCapabilities.join("\0") !== candidateCapabilities.join("\0")) {
    return false;
  }
  return true;
}

function recordsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function unitEntrySourceMatches(
  entry: UnitRegistryEntryBase,
  sourceRepo: string,
  ref: string,
): boolean {
  return normalizeUnitRepoPath(entry.source.repo) === normalizeUnitRepoPath(sourceRepo)
    && entry.source.ref === ref;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== undefined) out[key] = canonicalize(nested);
  }
  return out;
}

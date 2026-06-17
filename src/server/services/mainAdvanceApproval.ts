import * as fs from "node:fs";
import * as path from "node:path";
import {
  unitChangeSessionGrantKey,
  type UnitMetaChangeApprovalProvider,
} from "@natstack/unit-host";
import type { UnitBatchEntry } from "@natstack/shared/approvals";
import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { StateAdvancedEvent } from "../buildV2/stateTrigger.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

const WORKSPACE_REPO_WRITE_CAPABILITY = "workspace-repo-write";

export interface MainAdvanceApprovalCandidate {
  event: StateAdvancedEvent;
  caller: VerifiedCaller;
  operation: "apply-edits" | "revert" | "merge" | "abort-merge" | "publish";
  sourceHead?: string;
}

export interface MainAdvanceApprovalGate {
  approve(candidate: MainAdvanceApprovalCandidate): Promise<void>;
}

export interface MetaApprovalGrantStore {
  hasActive(key: string): boolean;
  grant(key: string, ttlMs: number): void;
}

export class FileMetaApprovalGrantStore implements MetaApprovalGrantStore {
  private readonly filePath: string;
  private grants = new Map<string, number>();

  constructor(opts: { statePath: string }) {
    this.filePath = path.join(opts.statePath, "units", "meta-approval-grants.json");
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

  grant(key: string, ttlMs: number): void {
    this.grants.set(key, Date.now() + ttlMs);
    this.save();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as {
        grants?: Array<{ key: string; expiresAt: number }>;
      };
      this.grants = new Map(
        (Array.isArray(parsed.grants) ? parsed.grants : [])
          .filter((grant) => typeof grant.key === "string" && typeof grant.expiresAt === "number")
          .map((grant) => [grant.key, grant.expiresAt])
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[MainAdvanceApproval] Failed to load meta approval grants:", err);
      }
      this.grants = new Map();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(
      tmp,
      `${JSON.stringify(
        {
          grants: [...this.grants.entries()].map(([key, expiresAt]) => ({ key, expiresAt })),
        },
        null,
        2
      )}\n`
    );
    fs.renameSync(tmp, this.filePath);
  }
}

export function createMainAdvanceApprovalGate(deps: {
  approvalQueue: ApprovalQueue;
  grantStore: MetaApprovalGrantStore;
  grantTtlMs: number;
  capabilityGrantStore: CapabilityGrantStore;
  getProviders(): Array<UnitMetaChangeApprovalProvider<UnitBatchEntry> | null | undefined>;
}): MainAdvanceApprovalGate {
  return {
    async approve(candidate) {
      if (candidate.event.head !== "main") return;
      if (candidate.event.changedPaths.length === 0) return;
      const metaChanged = candidate.event.changedPaths.some(isMetaPath);

      const runtimeKind = candidate.caller.runtime.kind;
      if (runtimeKind === "shell" || runtimeKind === "server" || runtimeKind === "harness") {
        return;
      }

      const callerKind = userlandCallerKind(runtimeKind);
      if (!callerKind) {
        throw new Error(`Workspace main advances from ${runtimeKind} callers are not supported`);
      }

      const identity = candidate.caller.code;
      if (!identity || identity.callerKind !== runtimeKind) {
        throw new Error(`Unknown caller identity: ${candidate.caller.runtime.id}`);
      }

      if (!metaChanged) {
        await approveWorkspaceMainAdvance(deps, candidate);
        return;
      }

      const providers = deps
        .getProviders()
        .filter(
          (provider): provider is UnitMetaChangeApprovalProvider<UnitBatchEntry> =>
            provider !== null && provider !== undefined
        );
      const approvals = await Promise.all(
        providers.map(async (provider) => ({
          provider,
          approval: await provider.metaChangeApprovalForCommit(candidate.event.stateHash),
        }))
      );
      const units = approvals.flatMap(({ approval }) => approval.units);
      const identityKeys = approvals.flatMap(({ approval }) => approval.identityKeys);

      const grantKey = unitChangeSessionGrantKey(
        candidate.caller.runtime.id,
        "meta",
        "meta",
        "main"
      );
      const onlyMetaChanged = candidate.event.changedPaths.every(isMetaPath);
      if (deps.grantStore.hasActive(grantKey) && units.length === 0 && onlyMetaChanged) return;

      if (
        onlyMetaChanged &&
        units.length > 0 &&
        identityKeys.length > 0 &&
        identityKeys.every((key) => deps.grantStore.hasActive(metaIdentityGrantKey(key)))
      ) {
        for (const { provider, approval } of approvals) {
          provider.acceptPreapprovedTrust(approval.identityKeys);
        }
        return;
      }

      const decision = await deps.approvalQueue.request({
        kind: "unit-batch",
        callerId: candidate.caller.runtime.id,
        callerKind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
        dedupKey: `unit-meta-change:${candidate.caller.runtime.id}:${candidate.event.stateHash}`,
        trigger: "meta-change",
        title: metaChangeTitle(units),
        description: metaChangeDescription(units),
        units,
        configWrite: {
          repoPath: "meta",
          summary: metaChangeSummary(candidate),
        },
      });
      if (decision === "deny") {
        throw new Error("Workspace config publish denied");
      }
      for (const { provider, approval } of approvals) {
        provider.acceptPreapprovedTrust(approval.identityKeys);
      }
      for (const key of identityKeys) {
        deps.grantStore.grant(metaIdentityGrantKey(key), deps.grantTtlMs);
      }
      if (decision === "session") {
        deps.grantStore.grant(grantKey, deps.grantTtlMs);
      }
    },
  };
}

async function approveWorkspaceMainAdvance(
  deps: {
    approvalQueue: ApprovalQueue;
    capabilityGrantStore: CapabilityGrantStore;
  },
  candidate: MainAdvanceApprovalCandidate
): Promise<void> {
  const authorization = await requestCapabilityPermission(
    {
      approvalQueue: deps.approvalQueue,
      grantStore: deps.capabilityGrantStore,
    },
    {
      caller: candidate.caller,
      capability: WORKSPACE_REPO_WRITE_CAPABILITY,
      dedupKey: `workspace-source-change:main:${candidate.event.stateHash}`,
      resource: {
        type: "vcs-head",
        label: "Head",
        value: "workspace main",
        key: "workspace-source-change:main",
      },
      title: mainAdvanceTitle(candidate),
      description: mainAdvanceDescription(candidate),
      details: mainAdvanceDetails(candidate),
      deniedReason: "Workspace main update denied",
    }
  );
  if (!authorization.allowed) {
    throw new Error(authorization.reason ?? "Workspace main update denied");
  }
}

function isMetaPath(filePath: string): boolean {
  return filePath === "meta" || filePath.startsWith("meta/");
}

function metaIdentityGrantKey(identityKey: string): string {
  return `unit-meta-identity\x00${identityKey}`;
}

function userlandCallerKind(kind: string): "panel" | "app" | "worker" | "do" | null {
  if (kind === "panel" || kind === "app" || kind === "worker" || kind === "do") return kind;
  return null;
}

function metaChangeSummary(candidate: MainAdvanceApprovalCandidate): string {
  const metaPaths = candidate.event.changedPaths.filter(isMetaPath);
  const otherCount = candidate.event.changedPaths.length - metaPaths.length;
  const metaSummary =
    metaPaths.length === 0
      ? "workspace config change"
      : metaPaths.length === 1
        ? `${metaPaths[0]} changed`
        : `${metaPaths.length} workspace config files changed`;
  return otherCount > 0
    ? `${metaSummary}; ${otherCount} other workspace path${otherCount === 1 ? "" : "s"} changed`
    : metaSummary;
}

function metaChangeTitle(units: UnitBatchEntry[]): string {
  const hasApps = units.some((unit) => unit.unitKind === "app");
  const hasExtensions = units.some((unit) => unit.unitKind === "extension");
  const hasScheduledJobs = units.some((unit) => unit.unitKind === "scheduled-job");
  if ([hasApps, hasExtensions, hasScheduledJobs].filter(Boolean).length > 1) {
    return "Workspace units changed";
  }
  if (hasApps) return "Workspace apps changed";
  if (hasExtensions) return "Workspace extensions changed";
  if (hasScheduledJobs) return "Workspace scheduled jobs changed";
  return "Edit workspace config";
}

function metaChangeDescription(units: UnitBatchEntry[]): string {
  const appCount = units.filter((unit) => unit.unitKind === "app").length;
  const extensionCount = units.filter((unit) => unit.unitKind === "extension").length;
  const jobCount = units.filter((unit) => unit.unitKind === "scheduled-job").length;
  const parts: string[] = [];
  if (extensionCount > 0) {
    parts.push(
      `${extensionCount} extension${extensionCount === 1 ? "" : "s"} that will run as native code`
    );
  }
  if (appCount > 0) {
    parts.push(
      `${appCount} privileged app${appCount === 1 ? "" : "s"} that will run in the app host`
    );
  }
  if (jobCount > 0) {
    parts.push(`${jobCount} scheduled job${jobCount === 1 ? "" : "s"} that will run automatically`);
  }
  return parts.length > 0
    ? `This publish edits workspace config and adds ${parts.join(" and ")}.`
    : "This publish edits sensitive workspace configuration.";
}

function mainAdvanceTitle(candidate: MainAdvanceApprovalCandidate): string {
  if (candidate.operation === "publish") return "Publish workspace changes";
  if (candidate.operation === "merge") return "Merge into workspace main";
  if (candidate.operation === "abort-merge") return "Abort workspace main merge";
  if (candidate.operation === "revert") return "Revert workspace main";
  return "Update workspace main";
}

function mainAdvanceDescription(candidate: MainAdvanceApprovalCandidate): string {
  return `This ${operationLabel(candidate.operation)} moves workspace main and changes ${pathCountSummary(candidate.event.changedPaths)}.`;
}

function mainAdvanceDetails(
  candidate: MainAdvanceApprovalCandidate
): Array<{ label: string; value: string }> {
  return [
    { label: "Operation", value: operationLabel(candidate.operation) },
    { label: "Head", value: candidate.event.head },
    ...(candidate.sourceHead ? [{ label: "Source", value: candidate.sourceHead }] : []),
    { label: "State", value: candidate.event.stateHash },
    { label: "Changes", value: changedPathsSummary(candidate.event.changedPaths) },
  ];
}

function operationLabel(operation: MainAdvanceApprovalCandidate["operation"]): string {
  switch (operation) {
    case "apply-edits":
      return "vcs apply edits";
    case "abort-merge":
      return "vcs abort merge";
    case "merge":
      return "vcs merge";
    case "publish":
      return "vcs publish";
    case "revert":
      return "vcs revert";
  }
}

function pathCountSummary(paths: string[]): string {
  if (paths.length === 1) return "1 path";
  return `${paths.length} paths`;
}

function changedPathsSummary(paths: string[]): string {
  if (paths.length === 0) return "no paths";
  if (paths.length <= 3) return paths.join(", ");
  return `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more`;
}

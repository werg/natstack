import * as path from "node:path";
import {
  normalizeUnitRef,
  normalizeUnitRepoPath,
  unitPushSessionGrantKey,
  type UnitMetaPushApprovalProvider,
  type UnitSourcePushAuthorizationDecision as UnitPushDecision,
  type UnitSourcePushHandler as UnitPushHandler,
  type UnitSourcePushRequest as UnitPushRequest,
  type UnitSourcePushTarget as UnitPushTarget,
} from "@natstack/unit-host";
import type { PendingUnitBatchApproval, UnitBatchEntry } from "@natstack/shared/approvals";
import { execGitFileSync } from "@natstack/shared/gitRuntime";

export interface UnitMetaPushGrantStore {
  hasActive(key: string): boolean;
  grant(key: string, ttlMs: number): void;
}

export interface UnitMetaPushApprovalQueue {
  request(req: {
    kind: "unit-batch";
    callerId: string;
    callerKind: "panel" | "app" | "worker" | "do";
    repoPath: string;
    effectiveVersion: string;
    dedupKey: string;
    trigger: "meta-push";
    title: string;
    description: string;
    units: PendingUnitBatchApproval["units"];
    configWrite: NonNullable<PendingUnitBatchApproval["configWrite"]>;
  }): Promise<"once" | "session" | "version" | "repo" | "deny">;
}

export function createWorkspaceUnitPushAuthorizer(deps: {
  targets: UnitPushTarget[];
  getMetaHandler(): UnitPushHandler | null | undefined;
}): (request: UnitPushRequest) => Promise<UnitPushDecision> {
  return async (request) => {
    const repoPath = normalizeUnitRepoPath(request.repoPath);
    const routedRequest = { ...request, repoPath };
    if (repoPath === "meta") {
      const handler = deps.getMetaHandler();
      if (!handler) {
        return { allowed: false, reason: "Workspace config push authorizer is unavailable" };
      }
      return handler.authorizeSourcePush(routedRequest);
    }

    const target = deps.targets.find(
      (candidate) =>
        repoPath === candidate.sourceRoot || repoPath.startsWith(`${candidate.sourceRoot}/`)
    );
    if (!target) return { allowed: true };
    const handler = target.getHandler();
    if (!handler) {
      return {
        allowed: false,
        reason: `Workspace ${target.sourceRoot} push authorizer is unavailable`,
      };
    }
    return handler.authorizeSourcePush(routedRequest);
  };
}

export function createWorkspaceMetaPushAuthorizer(deps: {
  workspacePath: string;
  approvalQueue: UnitMetaPushApprovalQueue;
  grantStore: UnitMetaPushGrantStore;
  grantTtlMs: number;
  getProviders(): Array<UnitMetaPushApprovalProvider<UnitBatchEntry> | null | undefined>;
  resolveMetaCommit?: (commit: string) => string | null;
  summarizeMetaDiff?: (commit: string) => string;
}): UnitPushHandler {
  return {
    async authorizeSourcePush(request) {
      if (request.caller.runtime.kind === "shell" || request.caller.runtime.kind === "server") {
        return { allowed: true };
      }
      const branch = normalizeUnitRef(request.branch);

      const providers = deps
        .getProviders()
        .filter(
          (provider): provider is UnitMetaPushApprovalProvider<UnitBatchEntry> =>
            provider !== null && provider !== undefined
        );
      const approvals = providers.map((provider) =>
        provider.metaPushApprovalForCommit(request.commit)
      );
      const units = approvals.flatMap((approval) => approval.units);
      const declarationKeys = new Set(approvals.flatMap((approval) => approval.identityKeys));
      const approvedCommit =
        deps.resolveMetaCommit?.(request.commit) ??
        resolveGitCommit(path.join(deps.workspacePath, "meta"), request.commit) ??
        request.commit;

      const sessionGrantKey = unitPushSessionGrantKey(
        request.caller.runtime.id,
        "meta",
        "meta",
        branch
      );
      if (deps.grantStore.hasActive(sessionGrantKey) && declarationKeys.size === 0) {
        return { allowed: true };
      }

      const callerKind = metaPushCallerKind(request.caller.runtime.kind);
      if (!callerKind) {
        return {
          allowed: false,
          reason: `Workspace config pushes from ${request.caller.runtime.kind} callers are not supported`,
        };
      }
      const identity = request.caller.code;
      if (!identity || identity.callerKind !== request.caller.runtime.kind) {
        return { allowed: false, reason: `Unknown caller identity: ${request.caller.runtime.id}` };
      }

      const decision = await deps.approvalQueue.request({
        kind: "unit-batch",
        callerId: request.caller.runtime.id,
        callerKind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
        dedupKey: `unit-meta-push:${request.caller.runtime.id}:${branch}:${approvedCommit}`,
        trigger: "meta-push",
        title: metaPushTitle(units),
        description: metaPushDescription(units),
        units,
        configWrite: {
          repoPath: "meta",
          summary:
            deps.summarizeMetaDiff?.(request.commit) ??
            metaDiffSummary(deps.workspacePath, request.commit),
        },
      });
      if (decision === "deny") {
        return { allowed: false, reason: "Workspace config push denied" };
      }
      if (decision === "session") {
        deps.grantStore.grant(sessionGrantKey, deps.grantTtlMs);
      }
      providers.forEach((provider, index) => {
        const keys = approvals[index]?.identityKeys ?? [];
        if (keys.length > 0) provider.acceptPreapprovedTrust(approvedCommit, keys);
      });
      return { allowed: true };
    },
  };
}

function metaPushCallerKind(kind: string): "panel" | "app" | "worker" | "do" | null {
  if (kind === "panel" || kind === "app" || kind === "worker" || kind === "do") return kind;
  return null;
}

function metaDiffSummary(workspacePath: string, commit: string): string {
  const metaRepoDir = path.join(workspacePath, "meta");
  const previous = resolveGitCommit(metaRepoDir, "HEAD");
  const stat = readGitDiffStat(
    metaRepoDir,
    previous,
    resolveGitCommit(metaRepoDir, commit) ?? commit
  );
  return stat
    ? `${stat.filesChanged} file(s) changed, +${stat.insertions} -${stat.deletions}`
    : "workspace config change";
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

function readGitDiffStat(
  repoPath: string,
  previousSha: string | null,
  sha: string | null
): { filesChanged: number; insertions: number; deletions: number } | null {
  if (!previousSha || !sha) return null;
  try {
    const output = String(
      execGitFileSync(["diff", "--shortstat", "--end-of-options", previousSha, sha], {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    ).trim();
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

function parseGitStatPart(input: string, pattern: RegExp): number {
  const match = input.match(pattern);
  return match ? Number(match[1]) || 0 : 0;
}

function metaPushTitle(units: UnitBatchEntry[]): string {
  const hasApps = units.some((unit) => unit.unitKind === "app");
  const hasExtensions = units.some((unit) => unit.unitKind === "extension");
  if (hasApps && hasExtensions) return "Workspace units changed";
  if (hasApps) return "Workspace apps changed";
  if (hasExtensions) return "Workspace extensions changed";
  return "Edit workspace config";
}

function metaPushDescription(units: UnitBatchEntry[]): string {
  const appCount = units.filter((unit) => unit.unitKind === "app").length;
  const extensionCount = units.filter((unit) => unit.unitKind === "extension").length;
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
  return parts.length > 0
    ? `This push edits workspace config and adds ${parts.join(" and ")}.`
    : "This push edits sensitive workspace configuration.";
}

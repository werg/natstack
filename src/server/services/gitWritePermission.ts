import type { GitWriteAuthorizer } from "@natstack/git-server";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { CodeIdentityResolver } from "./codeIdentityResolver.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";

export const INTERNAL_GIT_WRITE_CAPABILITY = "internal-git-write";

export function createGitWriteAuthorizer(deps: {
  approvalQueue: ApprovalQueue;
  grantStore: CapabilityGrantStore;
  codeIdentityResolver: Pick<CodeIdentityResolver, "resolveByCallerId">;
}): GitWriteAuthorizer {
  return async (request) => {
    const repoPath = normalizeRepoPathForPermission(request.repoPath);
    return requestCapabilityPermission(deps, {
      callerId: request.callerId,
      callerKind: request.callerKind,
      capability: INTERNAL_GIT_WRITE_CAPABILITY,
      dedupKey: null,
      title: "Write project files",
      description: "Allow this code version to push changes to an internal git repository.",
      resource: {
        type: "git-repo",
        label: "Repository",
        value: repoPath,
      },
      details: [
        { label: "Operation", value: "git push" },
      ],
      deniedReason: "Git write permission denied",
    });
  };
}

function normalizeRepoPathForPermission(repoPath: string): string {
  return repoPath
    .replace(/^\/+/, "")
    .replace(/\.git(\/.*)?$/, "")
    .replace(/\/+$/, "");
}

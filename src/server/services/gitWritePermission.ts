import type { GitWriteAuthorizer } from "@natstack/git-server";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { requestCapabilityPermission } from "./capabilityPermission.js";

export const INTERNAL_GIT_WRITE_CAPABILITY = "internal-git-write";

export function createGitWriteAuthorizer(deps: {
  approvalQueue: ApprovalQueue;
  grantStore: CapabilityGrantStore;
}): GitWriteAuthorizer {
  return async (request) => {
    const repoPath = normalizeRepoPathForPermission(request.repoPath);
    // meta/ writes are gated by the commit-aware push-phase combined approval
    // (config write + extension trust) in the extension host's push authorizer.
    // The pre-flight write gate would have no commit and could not list the
    // candidate extensions, so it defers here.
    if (repoPath === "meta") {
      return { allowed: true };
    }
    return requestCapabilityPermission(deps, {
      caller: request.caller,
      capability: INTERNAL_GIT_WRITE_CAPABILITY,
      dedupKey: null,
      title: "Write project files",
      description: "Allow this code version to push changes to an internal git repository.",
      resource: {
        type: "git-repo",
        label: "Repository",
        value: repoPath,
      },
      details: [{ label: "Operation", value: "git push" }],
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

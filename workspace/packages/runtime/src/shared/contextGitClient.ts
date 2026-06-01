import type { RpcClient } from "@natstack/rpc";
import type { GitClient, RepoStatus } from "@natstack/git";

function isWorkspaceRepoPath(dir: unknown): dir is string {
  if (typeof dir !== "string") return false;
  if (!dir || dir.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(dir)) return false;
  if (dir.includes("..") || dir.includes("\\")) return false;
  const segments = dir.split("/").filter(Boolean);
  return segments.length >= 2 && segments.every((segment) => /^[A-Za-z0-9._@-]+$/.test(segment));
}

export function createContextAwareGitClient(
  client: GitClient,
  rpc: Pick<RpcClient, "call">,
): GitClient {
  const originalStatus = client.status.bind(client);
  const originalAddAll = client.addAll.bind(client);

  client.status = async (dir: string): Promise<RepoStatus> => {
    if (!isWorkspaceRepoPath(dir)) return originalStatus(dir);
    return rpc.call<RepoStatus>("main", "git.contextStatus", [dir]);
  };

  client.addAll = async (dir: string): Promise<void> => {
    if (!isWorkspaceRepoPath(dir)) return originalAddAll(dir);
    await rpc.call<void>("main", "git.contextAddAll", [dir]);
  };

  return client;
}

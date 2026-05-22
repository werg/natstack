export type GitOperation = "branches" | "checkout" | "commit" | "status";

export function formatGitError(operation: GitOperation, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const lower = detail.toLowerCase();

  if (lower.includes("working tree") || lower.includes("local changes") || lower.includes("would be overwritten")) {
    return "Commit or discard changes before switching branches.";
  }

  if (lower.includes("not a git repository") || lower.includes("repository not found")) {
    return "This vault is not initialized as a git repo yet. Reopen the workspace or create a first commit, then try again.";
  }

  if (lower.includes("could not find object") || lower.includes("bad object") || lower.includes("missing object")) {
    return "Git data for this vault appears incomplete. Refresh the workspace or reopen the vault, then try again.";
  }

  if (lower.includes("author identity unknown") || lower.includes("unable to auto-detect email")) {
    return "Git needs an author name and email before it can commit. Configure your git identity, then try again.";
  }

  if (lower.includes("authentication") || lower.includes("permission denied") || lower.includes("access denied")) {
    return "Git could not authenticate for this vault. Check repository access and try again.";
  }

  switch (operation) {
    case "branches":
      return "Branches are unavailable right now. Refresh the workspace or reopen this vault.";
    case "checkout":
      return "Could not switch branches. Commit or discard local changes, refresh the workspace, then try again.";
    case "commit":
      return "Commit failed. Check that the vault has changes and git is configured, then try again.";
    case "status":
      return "Git status is unavailable right now. Refresh the workspace or reopen this vault.";
  }
}

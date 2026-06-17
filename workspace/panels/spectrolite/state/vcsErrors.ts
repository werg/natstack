export type VcsOperation = "head" | "status";

export function formatVcsError(operation: VcsOperation, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const lower = detail.toLowerCase();

  if (lower.includes("unknown vcs ref") || lower.includes("unknown build unit")) {
    return "This VCS head is unavailable. Refresh the workspace or reopen this vault.";
  }

  if (lower.includes("could not find object") || lower.includes("bad object") || lower.includes("missing object")) {
    return "Workspace VCS data for this vault appears incomplete. Refresh the workspace or reopen the vault, then try again.";
  }

  if (lower.includes("authentication") || lower.includes("permission denied") || lower.includes("access denied")) {
    return "Workspace VCS could not access this vault. Check workspace permissions and try again.";
  }

  switch (operation) {
    case "head":
      return "The VCS head is unavailable right now. Refresh the workspace or reopen this vault.";
    case "status":
      return "Workspace VCS status is unavailable right now. Refresh the workspace or reopen this vault.";
  }
}

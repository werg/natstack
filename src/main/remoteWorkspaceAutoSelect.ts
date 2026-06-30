export type RemoteWorkspaceLaunchCandidate = {
  name: string;
  ephemeral?: boolean;
};

export function autoLaunchRemoteWorkspaceName(
  workspaces: RemoteWorkspaceLaunchCandidate[],
  opts?: { allowSingleWorkspace?: boolean }
): string | null {
  const ephemeralDev = workspaces.find(
    (workspace) => workspace.name === "dev" && workspace.ephemeral === true
  );
  if (ephemeralDev) return ephemeralDev.name;
  if (workspaces.length === 1 && workspaces[0]?.name === "default") return "default";
  if (opts?.allowSingleWorkspace && workspaces.length === 1) {
    return workspaces[0]?.name ?? null;
  }
  return null;
}

import type { PrincipalRegistry } from "@natstack/shared/principalRegistry";

export interface ResolvedCodeIdentity {
  callerId: string;
  callerKind: "worker" | "panel";
  repoPath: string;
  effectiveVersion: string;
}

export function resolveCodeIdentity(
  principalRegistry: Pick<PrincipalRegistry, "resolve" | "resolveSource">,
  callerId: string
): ResolvedCodeIdentity | null {
  const source = principalRegistry.resolveSource(callerId);
  if (!source) return null;
  const kind = principalRegistry.resolve(callerId)?.kind;
  if (kind !== "panel" && kind !== "worker" && kind !== "do-service") return null;
  return {
    callerId,
    callerKind: kind === "panel" ? "panel" : "worker",
    repoPath: source.repoPath,
    effectiveVersion: source.effectiveVersion,
  };
}

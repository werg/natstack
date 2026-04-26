export interface ResolvedCodeIdentity {
  callerId: string;
  callerKind: "worker" | "panel";
  repoPath: string;
  effectiveVersion: string;
}

export class CodeIdentityResolver {
  private readonly byCallerId = new Map<string, ResolvedCodeIdentity>();

  upsertCallerIdentity(identity: ResolvedCodeIdentity): void {
    this.byCallerId.set(identity.callerId, identity);
  }

  resolveByCallerId(callerId: string): ResolvedCodeIdentity | null {
    return this.byCallerId.get(callerId) ?? null;
  }

  unregisterCaller(callerId: string): void {
    this.byCallerId.delete(callerId);
  }
}

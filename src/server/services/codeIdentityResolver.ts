export interface ResolvedCodeIdentity {
  callerId: string;
  callerKind: "worker" | "panel";
  repoPath: string;
  effectiveVersion: string;
}

export class CodeIdentityResolver {
  private readonly byProxyToken = new Map<string, string>();
  private readonly byCallerId = new Map<string, ResolvedCodeIdentity>();

  upsertCallerIdentity(identity: ResolvedCodeIdentity): void {
    this.byCallerId.set(identity.callerId, identity);
  }

  registerProxyToken(proxyAuthToken: string, callerId: string): void {
    this.byProxyToken.set(proxyAuthToken, callerId);
  }

  resolve(proxyAuthToken: string): ResolvedCodeIdentity | null {
    const callerId = this.byProxyToken.get(proxyAuthToken);
    if (!callerId) {
      return null;
    }
    return this.resolveByCallerId(callerId);
  }

  resolveByCallerId(callerId: string): ResolvedCodeIdentity | null {
    return this.byCallerId.get(callerId) ?? null;
  }

  unregisterCaller(callerId: string): void {
    this.byCallerId.delete(callerId);
    for (const [token, tokenCallerId] of Array.from(this.byProxyToken.entries())) {
      if (tokenCallerId === callerId) {
        this.byProxyToken.delete(token);
      }
    }
  }
}

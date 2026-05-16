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
    const exact = this.byCallerId.get(callerId);
    if (exact) return exact;
    const doServiceCallerId = doObjectToServiceCallerId(callerId);
    if (!doServiceCallerId) return null;
    const serviceIdentity = this.byCallerId.get(doServiceCallerId);
    if (!serviceIdentity) return null;
    const identity = { ...serviceIdentity, callerId };
    this.byCallerId.set(callerId, identity);
    return identity;
  }

  unregisterCaller(callerId: string): void {
    this.byCallerId.delete(callerId);
  }
}

function doObjectToServiceCallerId(callerId: string): string | null {
  if (!callerId.startsWith("do:")) return null;
  const body = callerId.slice("do:".length);
  const slashIdx = body.indexOf("/");
  if (slashIdx === -1) return null;
  const classSep = body.indexOf(":", slashIdx);
  if (classSep === -1) return null;
  const rest = body.slice(classSep + 1);
  const objectSep = rest.indexOf(":");
  if (objectSep === -1) return null;
  const source = body.slice(0, classSep);
  const className = rest.slice(0, objectSep);
  return `do-service:${source}:${className}`;
}

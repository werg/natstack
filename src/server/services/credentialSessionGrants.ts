export interface CredentialSessionGrantScope {
  callerId?: string;
  repoPath?: string;
  effectiveVersion?: string;
}

export interface CredentialSessionGrantResource {
  bindingId: string;
  resource: string;
  action: string;
}

export class CredentialSessionGrantStore {
  private readonly grants = new Set<string>();

  grant(
    credentialId: string,
    scope: CredentialSessionGrantScope,
    resource?: CredentialSessionGrantResource
  ): void {
    this.grants.add(sessionGrantKey(credentialId, scope, resource));
  }

  has(
    credentialId: string,
    scope: CredentialSessionGrantScope,
    resource?: CredentialSessionGrantResource
  ): boolean {
    return this.grants.has(sessionGrantKey(credentialId, scope, resource));
  }

  /**
   * Drop every session-scope grant tied to this caller id. Called from the
   * runtime-retire cleanup hook so a retired panel/worker/DO can never reach
   * a credential it was once granted access to, even if its principal id is
   * reused later.
   */
  dropForCaller(callerId: string): number {
    if (!callerId) return 0;
    let dropped = 0;
    const suffix = JSON.stringify(callerId);
    for (const key of this.grants) {
      // Caller-scoped grants serialize the callerId as the trailing JSON
      // element; bail fast if the key doesn't end with it.
      if (key.endsWith(`,${suffix}]`)) {
        this.grants.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }
}

function sessionGrantKey(
  credentialId: string,
  scope: CredentialSessionGrantScope,
  resource?: CredentialSessionGrantResource
): string {
  const resourceParts = resource
    ? [resource.bindingId, resource.resource, resource.action]
    : ["*", "*", "*"];
  if (scope.repoPath) {
    if (scope.callerId) {
      return JSON.stringify([credentialId, ...resourceParts, "caller", scope.callerId]);
    }
    return JSON.stringify([
      credentialId,
      ...resourceParts,
      "version",
      scope.repoPath,
      scope.effectiveVersion ?? "",
    ]);
  }
  return JSON.stringify([credentialId, ...resourceParts, "caller", scope.callerId ?? ""]);
}

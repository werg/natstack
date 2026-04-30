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

  grant(credentialId: string, scope: CredentialSessionGrantScope, resource?: CredentialSessionGrantResource): void {
    this.grants.add(sessionGrantKey(credentialId, scope, resource));
  }

  has(credentialId: string, scope: CredentialSessionGrantScope, resource?: CredentialSessionGrantResource): boolean {
    return this.grants.has(sessionGrantKey(credentialId, scope, resource));
  }
}

function sessionGrantKey(
  credentialId: string,
  scope: CredentialSessionGrantScope,
  resource?: CredentialSessionGrantResource,
): string {
  const resourceParts = resource
    ? [resource.bindingId, resource.resource, resource.action]
    : ["*", "*", "*"];
  if (scope.repoPath) {
    return JSON.stringify([
      credentialId,
      ...resourceParts,
      "version",
      scope.repoPath,
      scope.effectiveVersion ?? "",
    ]);
  }
  return JSON.stringify([
    credentialId,
    ...resourceParts,
    "caller",
    scope.callerId ?? "",
  ]);
}

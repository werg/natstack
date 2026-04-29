export interface CredentialSessionGrantScope {
  callerId?: string;
  repoPath?: string;
  effectiveVersion?: string;
}

export class CredentialSessionGrantStore {
  private readonly grants = new Set<string>();

  grant(credentialId: string, scope: CredentialSessionGrantScope): void {
    this.grants.add(sessionGrantKey(credentialId, scope));
  }

  has(credentialId: string, scope: CredentialSessionGrantScope): boolean {
    return this.grants.has(sessionGrantKey(credentialId, scope));
  }
}

function sessionGrantKey(credentialId: string, scope: CredentialSessionGrantScope): string {
  if (scope.repoPath) {
    return JSON.stringify([
      credentialId,
      "version",
      scope.repoPath,
      scope.effectiveVersion ?? "",
    ]);
  }
  return JSON.stringify([
    credentialId,
    "caller",
    scope.callerId ?? "",
  ]);
}

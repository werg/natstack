/**
 * ConsentGate — shared grant-check-or-prompt helper.
 *
 * Factored out of EgressProxy.authorizeRequest so the capability broker and
 * any legacy egress path can share one implementation. The gate:
 *   1. Checks for an existing consent grant at (repoPath, effectiveVersion,
 *      provider namespace, provider binding fingerprint).
 *   2. If none, requires a credential to exist (otherwise 403 "sign in first").
 *   3. Prompts via the approvalQueue (shell consent bar).
 *   4. On approve, writes a grant scoped to the decision ("session"/"version"/"repo").
 *   5. Resolves the final (connectionId, credential) pair.
 */
import type {
  ConsentGrant,
  Credential,
  ProviderManifest,
} from "../../../packages/shared/src/credentials/types.js";
import type { ResolvedCodeIdentity } from "./codeIdentityResolver.js";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import { listProviderConnections, resolveProviderConnection } from "./providerConnections.js";
import { createProviderBinding } from "../../../packages/shared/src/credentials/providerBinding.js";

type ApprovalGrantDecision = Exclude<GrantedDecision, "deny">;

export interface ConsentGateResult {
  grant: ConsentGrant;
  credential: Credential;
}

export interface ConsentGateError {
  statusCode: number;
  message: string;
  code?: "CREDENTIAL_REQUIRED" | "CREDENTIAL_NOT_FOUND" | "CONSENT_DENIED";
}

export interface ConsentGateCredentialStore {
  load(providerId: string, connectionId: string): Promise<Credential | null> | Credential | null;
  list(providerId?: string): Promise<Credential[]> | Credential[];
}

export interface ConsentGateConsentStore {
  check(query: {
    repoPath: string;
    effectiveVersion: string;
    providerId: string;
    providerFingerprint: string;
  }): Promise<ConsentGrant | null> | ConsentGrant | null;
  grant(grant: ConsentGrant): Promise<void> | void;
}

export interface ConsentGateDeps {
  credentialStore: ConsentGateCredentialStore;
  consentStore: ConsentGateConsentStore;
  approvalQueue: ApprovalQueue;
}

export class ConsentGate {
  constructor(private readonly deps: ConsentGateDeps) {}

  async ensureGrant(params: {
    identity: ResolvedCodeIdentity;
    provider: ProviderManifest;
    connectionIdOverride?: string | null;
    signal?: AbortSignal;
  }): Promise<ConsentGateResult | { error: ConsentGateError }> {
    const { identity, provider } = params;
    const binding = createProviderBinding(provider);

    let grant = await Promise.resolve(this.deps.consentStore.check({
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      providerId: provider.id,
      providerFingerprint: binding.fingerprint,
    }));

    if (!grant) {
      const credentials = await listProviderConnections(this.deps.credentialStore, provider);
      if (credentials.length === 0) {
        return {
          error: {
            statusCode: 403,
            code: "CREDENTIAL_REQUIRED",
            message: `No credential for ${provider.displayName} — connect in Connected Accounts`,
          },
        };
      }

      const defaultCredential = await resolveProviderConnection(
        this.deps.credentialStore,
        provider.id,
        provider,
        params.connectionIdOverride ?? undefined,
      );
      if (!defaultCredential) {
        return {
          error: {
            statusCode: params.connectionIdOverride ? 502 : 403,
            code: params.connectionIdOverride ? "CREDENTIAL_NOT_FOUND" : "CREDENTIAL_REQUIRED",
            message: params.connectionIdOverride
              ? `No credential found for connection ${params.connectionIdOverride}`
              : `No credential for ${provider.displayName} — connect in Connected Accounts`,
          },
        };
      }

      const decision = await this.deps.approvalQueue.request({
        callerId: identity.callerId,
        callerKind: identity.callerKind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
        providerNamespace: provider.id,
        providerFingerprint: binding.fingerprint,
        providerDisplayName: provider.displayName,
        providerAudience: binding.audience,
        injection: binding.injection,
        connectionId: defaultCredential.connectionId,
        accountIdentity: defaultCredential.accountIdentity,
        scopes: defaultCredential.scopes,
        signal: params.signal,
      });

      if (decision === "deny") {
        return {
          error: {
            statusCode: 403,
            code: "CONSENT_DENIED",
            message: "Consent denied by user",
          },
        };
      }

      const writtenGrant = buildGrantForDecision(
        decision,
        identity,
        provider.id,
        binding,
        defaultCredential.connectionId,
        defaultCredential.scopes,
      );
      await Promise.resolve(this.deps.consentStore.grant(writtenGrant));
      grant = writtenGrant;
    }

    const resolvedConnectionId = params.connectionIdOverride || grant.connectionId;
    const credential = await resolveProviderConnection(
      this.deps.credentialStore,
      provider.id,
      provider,
      resolvedConnectionId,
    );
    if (!credential) {
      return {
        error: {
          statusCode: 502,
          code: "CREDENTIAL_NOT_FOUND",
          message: `No credential found for connection ${resolvedConnectionId}`,
        },
      };
    }

    return {
      grant: { ...grant, connectionId: resolvedConnectionId },
      credential,
    };
  }
}

export function createConsentGate(deps: ConsentGateDeps): ConsentGate {
  return new ConsentGate(deps);
}

function buildGrantForDecision(
  decision: ApprovalGrantDecision,
  identity: Pick<ResolvedCodeIdentity, "repoPath" | "effectiveVersion" | "callerId">,
  providerId: string,
  binding: ReturnType<typeof createProviderBinding>,
  connectionId: string,
  scopes: readonly string[],
): ConsentGrant {
  const base = {
    providerId,
    providerFingerprint: binding.fingerprint,
    providerAudience: binding.audience,
    connectionId,
    scopes: Array.from(scopes),
    grantedAt: Date.now(),
    grantedBy: identity.callerId,
  };
  switch (decision) {
    case "session":
      return {
        ...base,
        codeIdentity: identity.effectiveVersion,
        codeIdentityType: "hash",
        transient: true,
      };
    case "version":
      return {
        ...base,
        codeIdentity: identity.effectiveVersion,
        codeIdentityType: "hash",
      };
    case "repo":
      return {
        ...base,
        codeIdentity: identity.repoPath,
        codeIdentityType: "repo",
      };
    default: {
      const exhaustive: never = decision;
      throw new Error(`Unhandled approval decision: ${String(exhaustive)}`);
    }
  }
}

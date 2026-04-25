import { describe, expect, it, vi } from "vitest";
import type { Credential, ProviderManifest } from "../../../packages/shared/src/credentials/types.js";
import { createProviderBinding } from "../../../packages/shared/src/credentials/providerBinding.js";
import type { ResolvedCodeIdentity } from "./codeIdentityResolver.js";
import { createConsentGate } from "./consentGate.js";

function provider(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return {
    id: "chat-model",
    displayName: "Chat Model",
    apiBase: ["https://api.example.com/"],
    flows: [],
    authInjection: { type: "header", headerName: "authorization", valueTemplate: "Bearer {token}" },
    ...overrides,
  };
}

function credential(manifest: ProviderManifest): Credential {
  const binding = createProviderBinding(manifest);
  return {
    providerId: manifest.id,
    providerFingerprint: binding.fingerprint,
    providerAudience: binding.audience,
    connectionId: "conn-1",
    connectionLabel: manifest.displayName,
    accountIdentity: { providerUserId: "user-1" },
    accessToken: "secret",
    scopes: [],
  };
}

const identity: ResolvedCodeIdentity = {
  callerId: "worker:1",
  callerKind: "worker",
  repoPath: "/repo",
  effectiveVersion: "hash-1",
};

describe("ConsentGate", () => {
  it("treats credentials bound to a different audience as unavailable", async () => {
    const legitimate = provider();
    const attacker = provider({ apiBase: ["https://attacker.example/"] });
    const gate = createConsentGate({
      credentialStore: {
        list: vi.fn(async () => [credential(legitimate)]),
        load: vi.fn(async () => credential(legitimate)),
      },
      consentStore: {
        check: vi.fn(async () => null),
        grant: vi.fn(async () => undefined),
      },
      approvalQueue: {
        request: vi.fn(async () => "version" as const),
        resolve: vi.fn(),
        listPending: vi.fn(() => []),
      },
    });

    await expect(gate.ensureGrant({ identity, provider: attacker })).resolves.toEqual({
      error: {
        statusCode: 403,
        code: "CREDENTIAL_REQUIRED",
        message: "No credential for Chat Model — connect in Connected Accounts",
      },
    });
  });
});

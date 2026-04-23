import { afterEach, describe, expect, it } from "vitest";
import type { Credential, ProviderManifest } from "../../../packages/shared/src/credentials/types.js";
import {
  getEnvVarCredential,
  listProviderConnections,
  resolveProviderConnection,
} from "./providerConnections.js";

class MemoryCredentialStore {
  constructor(private readonly credentials: Credential[] = []) {}

  async load(providerId: string, connectionId: string): Promise<Credential | null> {
    return this.credentials.find((credential) =>
      credential.providerId === providerId && credential.connectionId === connectionId
    ) ?? null;
  }

  async list(providerId?: string): Promise<Credential[]> {
    return this.credentials.filter((credential) =>
      providerId ? credential.providerId === providerId : true
    );
  }
}

const anthropicManifest: ProviderManifest = {
  id: "anthropic",
  displayName: "Anthropic",
  apiBase: ["https://api.anthropic.com"],
  authInjection: {
    type: "header",
    headerName: "x-api-key",
    valueTemplate: "{token}",
  },
  flows: [{ type: "env-var", envVar: "ANTHROPIC_API_KEY" }],
};

describe("providerConnections", () => {
  afterEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
  });

  it("builds an env-var-backed credential dynamically", () => {
    process.env["ANTHROPIC_API_KEY"] = "secret";

    expect(getEnvVarCredential("anthropic", anthropicManifest)).toMatchObject({
      providerId: "anthropic",
      connectionId: "env:ANTHROPIC_API_KEY",
      accessToken: "secret",
    });
  });

  it("includes env-var-backed credentials in provider listings", async () => {
    process.env["ANTHROPIC_API_KEY"] = "secret";
    const store = new MemoryCredentialStore();

    await expect(listProviderConnections(store, anthropicManifest)).resolves.toEqual([
      expect.objectContaining({
        providerId: "anthropic",
        connectionId: "env:ANTHROPIC_API_KEY",
      }),
    ]);
  });

  it("resolves env-var-backed credentials when no stored connection exists", async () => {
    process.env["ANTHROPIC_API_KEY"] = "secret";
    const store = new MemoryCredentialStore();

    await expect(resolveProviderConnection(store, "anthropic", anthropicManifest)).resolves.toMatchObject({
      providerId: "anthropic",
      connectionId: "env:ANTHROPIC_API_KEY",
      accessToken: "secret",
    });
  });

  it("prefers an explicitly requested stored connection over the env-var fallback", async () => {
    process.env["ANTHROPIC_API_KEY"] = "secret";
    const store = new MemoryCredentialStore([
      {
        providerId: "anthropic",
        connectionId: "saved",
        connectionLabel: "Saved",
        accountIdentity: { providerUserId: "user-1" },
        accessToken: "stored-secret",
        scopes: [],
      },
    ]);

    await expect(resolveProviderConnection(store, "anthropic", anthropicManifest, "saved")).resolves.toMatchObject({
      providerId: "anthropic",
      connectionId: "saved",
      accessToken: "stored-secret",
    });
  });
});

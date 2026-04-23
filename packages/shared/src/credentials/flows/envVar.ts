import type { Credential, FlowConfig } from "../types.js";

export async function envVar(config: FlowConfig, providerId?: string): Promise<Credential | null> {
  const envVarName = config.envVar;
  if (!envVarName) {
    return null;
  }

  const accessToken = process.env[envVarName];
  if (!accessToken) {
    return null;
  }

  return {
    providerId: providerId ?? "env-var",
    connectionId: `env:${envVarName}`,
    connectionLabel: `Environment variable ${envVarName}`,
    accountIdentity: { providerUserId: envVarName },
    accessToken,
    scopes: [],
  };
}

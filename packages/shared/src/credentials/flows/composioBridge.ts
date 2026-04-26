import { randomUUID } from "node:crypto";
import type { Credential, FlowConfig } from "../types.js";

export async function composioBridge(config: FlowConfig): Promise<Credential | null> {
  const apiKey = process.env["COMPOSIO_API_KEY"]?.trim();
  if (!apiKey) {
    return null;
  }

  let ComposioToolset: (new (...args: unknown[]) => unknown) | undefined;
  try {
    const moduleName = "composio-core";
    const mod = await import(/* webpackIgnore: true */ moduleName);
    ComposioToolset = mod.Composio ?? mod.default?.Composio ?? mod.default;
  } catch {
    return null;
  }

  if (!ComposioToolset) {
    return null;
  }

  try {
    const client = new ComposioToolset({ apiKey }) as {
      getEntity?: (entityId: string) => {
        initiateConnection?: (provider: string) => Promise<{ redirectUrl?: string } | null> | { redirectUrl?: string } | null;
        getConnection?: (provider: string) => Promise<{
          status?: string;
          id?: string;
          connectionParams?: {
            access_token?: string;
            token?: string;
            email?: string;
            sub?: string;
            refresh_token?: string;
            expires_at?: number | string;
          };
        } | null>;
      } | null;
    };
    const entityId = `natstack-${randomUUID().slice(0, 8)}`;

    const entity = client.getEntity?.(entityId);
    if (!entity) {
      return null;
    }

    const connection = await entity.initiateConnection?.("google");
    if (!connection?.redirectUrl) {
      return null;
    }

    try {
      const openModule = await import("open");
      await openModule.default(connection.redirectUrl);
    } catch {
      console.log(`Open this URL to authorize: ${connection.redirectUrl}`);
    }

    console.log("Waiting for authorization...");

    const maxWaitMs = 300_000;
    const pollIntervalMs = 3_000;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));

      try {
        const result = await entity.getConnection?.("google");
        if (result?.status === "ACTIVE" || result?.connectionParams?.access_token) {
          const accessToken =
            result.connectionParams?.access_token ??
            result.connectionParams?.token;

          if (typeof accessToken !== "string") {
            continue;
          }

          return {
            providerId: "google",
            connectionId: randomUUID(),
            connectionLabel: "Google (via Composio)",
            accountIdentity: {
              email: result.connectionParams?.email ?? undefined,
              providerUserId: result.connectionParams?.sub ?? result.id ?? entityId,
            },
            accessToken,
            refreshToken: result.connectionParams?.refresh_token ?? undefined,
            scopes: [],
            expiresAt: result.connectionParams?.expires_at
              ? Number(result.connectionParams.expires_at) * 1000
              : undefined,
          };
        }
      } catch {
        // not ready yet
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * OAuth RPC Service — dynamic OAuth token management with consent.
 *
 * Key feature: the `connect` handler implements a dynamic consent flow.
 * When a panel calls `oauth.connect("google-mail")` and hasn't been
 * granted consent, a notification appears in the shell chrome area.
 * The call blocks until the user approves or denies.
 */

import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { OAuthManager } from "../../shared/oauth/oauthManager.js";
import type { NotificationServiceInternal } from "./notificationService.js";
import type { PanelRegistry } from "../../shared/panelRegistry.js";
import { randomUUID } from "node:crypto";

export function createOAuthService(deps: {
  oauthManager: OAuthManager;
  panelRegistry: PanelRegistry;
  notificationService: NotificationServiceInternal;
}): ServiceDefinition {
  const { oauthManager, panelRegistry, notificationService } = deps;

  /** Resolve callerId to panel source path (e.g., "panels/email"). */
  function getPanelSource(callerId: string): string | null {
    const panels = panelRegistry.listPanels();
    const panel = panels.find(p => p.panelId === callerId);
    return panel?.source ?? null;
  }

  /** Get panel title for consent notification. */
  function getPanelTitle(callerId: string): string {
    const panels = panelRegistry.listPanels();
    const panel = panels.find(p => p.panelId === callerId);
    return panel?.title ?? "Unknown Panel";
  }

  return {
    name: "oauth",
    description: "OAuth token management via Nango with dynamic consent",
    policy: { allowed: ["shell", "panel", "worker", "server"] },
    methods: {
      getToken: {
        args: z.tuple([z.string(), z.string()]),
      },
      connect: {
        args: z.tuple([
          z.string(),
          z.string(),
          z.object({
            scopes: z.array(z.string()).optional(),
            reason: z.string().optional(),
          }).optional(),
        ]),
      },
      disconnect: {
        args: z.tuple([z.string(), z.string()]),
      },
      getConnection: {
        args: z.tuple([z.string(), z.string()]),
      },
      listConnections: {
        args: z.tuple([]),
      },
      grantConsent: {
        args: z.tuple([z.string(), z.array(z.string())]),
      },
      revokeConsent: {
        args: z.tuple([z.string()]),
      },
      listConsents: {
        args: z.tuple([]),
      },
    },
    handler: async (ctx, method, args) => {
      const panelSource = getPanelSource(ctx.callerId);
      const isWorker = ctx.callerKind === "worker" || ctx.callerKind === "server";

      switch (method) {
        case "getToken": {
          const [providerKey, connectionId] = args as [string, string];
          // Check consent (skip for workers/server)
          if (!isWorker && panelSource) {
            const hasConsent = await oauthManager.hasConsent(panelSource, providerKey);
            if (!hasConsent) {
              throw new Error(
                `Panel "${panelSource}" has not been granted consent for provider "${providerKey}". ` +
                `Call oauth.connect() first to initiate the consent and auth flow.`,
              );
            }
          }
          return oauthManager.getToken(providerKey, connectionId);
        }

        case "connect": {
          const [providerKey, connectionId, opts] = args as [string, string, { scopes?: string[]; reason?: string } | undefined];
          const scopes = opts?.scopes ?? [];

          // Check consent (skip for workers/server)
          if (!isWorker && panelSource) {
            const hasConsent = await oauthManager.hasConsent(panelSource, providerKey);

            if (!hasConsent) {
              // Push a consent notification to the shell
              const notifId = `oauth-consent-${randomUUID()}`;
              const panelTitle = getPanelTitle(ctx.callerId);

              notificationService.show({
                id: notifId,
                type: "consent",
                title: "OAuth Access Requested",
                consent: {
                  provider: providerKey,
                  scopes,
                  panelSource: panelSource,
                  panelTitle,
                },
              });

              // Block until user approves or denies (120s timeout)
              const actionId = await notificationService.waitForAction(notifId, 120_000);

              if (actionId !== "approve") {
                throw new Error(`OAuth consent denied for provider "${providerKey}"`);
              }

              // Store consent
              await oauthManager.grantConsent(panelSource, providerKey, scopes);
            }
          }

          // Get the auth URL and return it — the panel opens it in a browser panel
          const authUrl = await oauthManager.getAuthUrl(providerKey, connectionId);

          // Poll for connection completion
          const deadline = Date.now() + 120_000;
          while (Date.now() < deadline) {
            const conn = await oauthManager.getConnection(providerKey, connectionId);
            if (conn.connected) return conn;
            await new Promise(r => setTimeout(r, 2000));
          }

          throw new Error(`OAuth connection timed out for "${providerKey}"`);
        }

        case "disconnect": {
          const [providerKey, connectionId] = args as [string, string];
          await oauthManager.disconnect(providerKey, connectionId);
          return;
        }

        case "getConnection": {
          const [providerKey, connectionId] = args as [string, string];
          return oauthManager.getConnection(providerKey, connectionId);
        }

        case "listConnections": {
          return oauthManager.listConnections();
        }

        case "grantConsent": {
          const [providerKey, scopes] = args as [string, string[]];
          if (!panelSource) throw new Error("Cannot grant consent: panel source unknown");
          await oauthManager.grantConsent(panelSource, providerKey, scopes);
          return;
        }

        case "revokeConsent": {
          const [providerKey] = args as [string];
          if (!panelSource) throw new Error("Cannot revoke consent: panel source unknown");
          await oauthManager.revokeConsent(panelSource, providerKey);
          return;
        }

        case "listConsents": {
          if (!panelSource) return [];
          return oauthManager.listConsents(panelSource);
        }

        default:
          throw new Error(`Unknown oauth method: ${method}`);
      }
    },
  };
}

/**
 * OAuth RPC Service — dynamic OAuth token management with consent.
 *
 * Key features:
 * - Dynamic consent flow: panels/workers call oauth.connect(), a notification
 *   appears in the shell chrome, blocks until the user approves.
 * - Cookie pre-sync: before opening the OAuth browser panel, syncs
 *   imported cookies for the provider's auth domains so the user
 *   may already be logged in.
 * - Browser panel: opens the OAuth auth URL in a managed browser panel
 *   where autofill handles password entry automatically.
 */

import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { CallerKind } from "../../shared/serviceDispatcher.js";
import type { OAuthManager } from "../../shared/oauth/oauthManager.js";
import type { NotificationServiceInternal } from "./notificationService.js";
import type { PanelRegistry } from "../../shared/panelRegistry.js";
import { randomUUID } from "node:crypto";

/**
 * Maps OAuth provider keys to the auth domains whose cookies
 * should be synced to the browser session before opening the
 * auth URL. This enables pre-authentication when the user has
 * imported browser cookies/passwords.
 */
const PROVIDER_AUTH_DOMAINS: Record<string, string[]> = {
  "google-mail": ["google.com", "accounts.google.com", "myaccount.google.com"],
  "google-calendar": ["google.com", "accounts.google.com", "myaccount.google.com"],
  "google-drive": ["google.com", "accounts.google.com", "myaccount.google.com"],
  "github": ["github.com"],
  "slack": ["slack.com"],
  "microsoft": ["microsoft.com", "login.microsoftonline.com", "live.com"],
  "notion": ["notion.so"],
  "linear": ["linear.app"],
};

export function createOAuthService(deps: {
  oauthManager: OAuthManager;
  panelRegistry?: PanelRegistry;
  notificationService: NotificationServiceInternal;
  syncCookiesToSession?: (domain: string) => Promise<{ synced: number; failed: number }>;
}): ServiceDefinition {
  const { oauthManager, panelRegistry, notificationService, syncCookiesToSession } = deps;

  /** Get a human-readable title for the caller (panel or worker). */
  function getCallerTitle(callerId: string, callerKind: string): string {
    if (callerKind === "panel" && panelRegistry) {
      const panels = panelRegistry.listPanels();
      const panel = panels.find(p => p.panelId === callerId);
      return panel?.title ?? callerId;
    }
    // Workers: strip "worker:" prefix if present, use the worker ID
    return callerId.replace(/^worker:/, "");
  }

  /**
   * Pre-sync imported cookies for a provider's auth domains.
   * This ensures the OAuth browser panel inherits any existing
   * sessions from imported browser data.
   */
  async function presyncCookiesForProvider(providerKey: string): Promise<void> {
    if (!syncCookiesToSession) return;

    const domains = PROVIDER_AUTH_DOMAINS[providerKey];
    if (!domains) return;

    for (const domain of domains) {
      try {
        await syncCookiesToSession(domain);
      } catch {
        // Non-fatal: browser data service may not be available
      }
    }
  }

  return {
    name: "oauth",
    description: "OAuth token management with dynamic consent",
    policy: { allowed: ["shell", "panel", "worker"] },
    methods: {
      getToken: {
        args: z.tuple([z.string(), z.string()]),
      },
      requestConsent: {
        args: z.tuple([
          z.string(),
          z.object({ scopes: z.array(z.string()).optional() }).optional(),
        ]),
        policy: { allowed: ["shell", "panel", "worker"] as CallerKind[] },
      },
      startAuth: {
        args: z.tuple([z.string(), z.string()]),
        policy: { allowed: ["panel"] as CallerKind[] },
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
      listProviders: {
        args: z.tuple([]),
      },
      listConsents: {
        args: z.tuple([]),
      },
    },
    handler: async (ctx, method, args) => {
      const callerId = ctx.callerId;
      const callerKind = ctx.callerKind as "panel" | "worker" | "shell";

      /** Show consent notification and wait for user action. */
      async function requestConsentFlow(providerKey: string, scopes: string[]): Promise<void> {
        const notifId = `oauth-consent-${randomUUID()}`;
        const callerTitle = getCallerTitle(callerId, callerKind);
        const effectiveKind = callerKind === "worker" ? "worker" as const : "panel" as const;

        notificationService.show({
          id: notifId,
          type: "consent",
          title: "OAuth Access Requested",
          consent: {
            provider: providerKey,
            scopes,
            callerId,
            callerTitle,
            callerKind: effectiveKind,
          },
          // Only set sourcePanelId for panels (clicking navigates to the panel)
          sourcePanelId: callerKind === "panel" ? callerId : undefined,
        });

        const actionId = await notificationService.waitForAction(notifId, 120_000);
        if (actionId === "approve-workspace") {
          await oauthManager.grantConsent(callerId, providerKey, scopes, true);
        } else if (actionId === "approve") {
          await oauthManager.grantConsent(callerId, providerKey, scopes);
        } else {
          throw new Error(`OAuth consent denied for provider "${providerKey}"`);
        }
      }

      switch (method) {
        case "getToken": {
          const [providerKey, connectionId] = args as [string, string];
          const hasConsent = await oauthManager.hasConsent(callerId, providerKey);
          if (!hasConsent) {
            throw new Error(
              `Caller has not been granted consent for provider "${providerKey}". ` +
              `Call oauth.requestConsent() first to initiate the consent flow.`,
            );
          }
          return oauthManager.getToken(providerKey, connectionId);
        }

        case "requestConsent": {
          const [providerKey, opts] = args as [string, { scopes?: string[] } | undefined];
          const scopes = opts?.scopes ?? [];

          if (await oauthManager.hasConsent(callerId, providerKey, scopes)) {
            return { consented: true };
          }

          await requestConsentFlow(providerKey, scopes);
          return { consented: true };
        }

        case "startAuth": {
          const [providerKey, connectionId] = args as [string, string];

          await presyncCookiesForProvider(providerKey);

          const authUrl = await oauthManager.getAuthUrl(providerKey, connectionId);

          // Return the auth URL — the client-side OAuthClient handles opening
          // it in a browser panel or system browser based on the caller's
          // openIn preference. Server-side cookie pre-sync above ensures
          // the browser panel (if used) will have imported cookies available.
          return { authUrl };
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

        case "listProviders": {
          return oauthManager.listProviders();
        }

        case "listConsents": {
          return oauthManager.listConsents(callerId);
        }

        default:
          throw new Error(`Unknown oauth method: ${method}`);
      }
    },
  };
}

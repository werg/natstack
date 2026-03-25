/**
 * OAuth RPC Service — dynamic OAuth token management with consent.
 *
 * Key features:
 * - Dynamic consent flow: panels call oauth.connect(), a notification
 *   appears in the shell chrome, blocks until the user approves.
 * - Cookie pre-sync: before opening the OAuth browser panel, syncs
 *   imported cookies for the provider's auth domains so the user
 *   may already be logged in.
 * - Browser panel: opens the Nango auth URL in a managed browser panel
 *   where autofill handles password entry automatically.
 */

import { z } from "zod";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
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
  panelRegistry: PanelRegistry;
  notificationService: NotificationServiceInternal;
  /**
   * Sync imported cookies to the browser session for a domain.
   * Called before opening OAuth browser panels so the user may
   * already be authenticated. Optional — gracefully degrades if
   * browser data service is unavailable (e.g., headless mode).
   */
  syncCookiesToSession?: (domain: string) => Promise<{ synced: number; failed: number }>;
  /**
   * Open a URL in a managed browser panel (child of the calling panel).
   * Browser panels use the shared BROWSER_SESSION_PARTITION and have
   * autofill attached, so imported passwords auto-fill login forms.
   * Optional — in headless mode, the auth URL is returned for manual opening.
   */
  openBrowserPanel?: (callerId: string, url: string, opts?: { name?: string; focus?: boolean }) => Promise<{ id: string; title: string }>;
}): ServiceDefinition {
  const { oauthManager, panelRegistry, notificationService, syncCookiesToSession, openBrowserPanel } = deps;

  /** Get panel title for consent notification. */
  function getPanelTitle(callerId: string): string {
    const panels = panelRegistry.listPanels();
    const panel = panels.find(p => p.panelId === callerId);
    return panel?.title ?? "Unknown Panel";
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
        const result = await syncCookiesToSession(domain);
        if (result.synced > 0) {
          // Cookies found and synced — user may already be authenticated
        }
      } catch {
        // Non-fatal: browser data service may not be available
      }
    }
  }

  return {
    name: "oauth",
    description: "OAuth token management via Nango with dynamic consent",
    policy: { allowed: ["shell", "panel"] },
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
      requestConsent: {
        args: z.tuple([
          z.string(),
          z.object({ scopes: z.array(z.string()).optional() }).optional(),
        ]),
      },
      startAuth: {
        args: z.tuple([z.string(), z.string()]),
      },
      waitForConnection: {
        args: z.tuple([z.string(), z.string(), z.number().optional()]),
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
      const callerId = ctx.callerId;

      /** Show consent notification and wait for user action. Returns the granted scope. */
      async function requestConsentFlow(providerKey: string, scopes: string[]): Promise<void> {
        const notifId = `oauth-consent-${randomUUID()}`;
        const panelTitle = getPanelTitle(callerId);

        notificationService.show({
          id: notifId,
          type: "consent",
          title: "OAuth Access Requested",
          consent: {
            provider: providerKey,
            scopes,
            panelId: callerId,
            panelTitle,
          },
          sourcePanelId: callerId,
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
              `Panel has not been granted consent for provider "${providerKey}". ` +
              `Call oauth.connect() first to initiate the consent and auth flow.`,
            );
          }
          return oauthManager.getToken(providerKey, connectionId);
        }

        case "connect": {
          const [providerKey, connectionId, opts] = args as [string, string, { scopes?: string[]; reason?: string } | undefined];
          const scopes = opts?.scopes ?? [];

          if (!(await oauthManager.hasConsent(callerId, providerKey))) {
            await requestConsentFlow(providerKey, scopes);
          }

          await presyncCookiesForProvider(providerKey);
          const authUrl = await oauthManager.getAuthUrl(providerKey, connectionId);

          if (openBrowserPanel) {
            try {
              await openBrowserPanel(callerId, authUrl, {
                name: `Sign in — ${providerKey}`,
                focus: true,
              });
            } catch {
              // Non-fatal
            }
          }

          const deadline = Date.now() + 120_000;
          while (Date.now() < deadline) {
            const conn = await oauthManager.getConnection(providerKey, connectionId);
            if (conn.connected) return conn;
            await new Promise(r => setTimeout(r, 2000));
          }

          throw new Error(`OAuth connection timed out for "${providerKey}"`);
        }

        // --- Staged flow: panel-driven connect with progress feedback ---

        case "requestConsent": {
          const [providerKey, opts] = args as [string, { scopes?: string[] } | undefined];
          const scopes = opts?.scopes ?? [];

          if (await oauthManager.hasConsent(callerId, providerKey)) {
            return { consented: true };
          }

          await requestConsentFlow(providerKey, scopes);
          return { consented: true };
        }

        case "startAuth": {
          const [providerKey, connectionId] = args as [string, string];

          // Pre-sync imported cookies so the browser panel may already be authenticated
          await presyncCookiesForProvider(providerKey);

          const authUrl = await oauthManager.getAuthUrl(providerKey, connectionId);

          // Open browser panel (non-blocking — returns immediately)
          let browserPanelId: string | undefined;
          if (openBrowserPanel) {
            try {
              const result = await openBrowserPanel(ctx.callerId, authUrl, {
                name: `Sign in — ${providerKey}`,
                focus: true,
              });
              browserPanelId = result.id;
            } catch {
              // Non-fatal: panel can open URL manually
            }
          }

          return { authUrl, browserPanelId };
        }

        case "waitForConnection": {
          const [providerKey, connectionId, timeoutMs] = args as [string, string, number | undefined];
          const deadline = Date.now() + (timeoutMs ?? 120_000);
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

        case "listProviders": {
          return oauthManager.listProviders();
        }

        case "grantConsent": {
          const [providerKey, scopes] = args as [string, string[]];
          await oauthManager.grantConsent(callerId, providerKey, scopes);
          return;
        }

        case "revokeConsent": {
          const [providerKey] = args as [string];
          await oauthManager.revokeConsent(callerId, providerKey);
          return;
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

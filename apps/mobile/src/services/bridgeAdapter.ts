import { Linking } from "react-native";
import type { PanelManager } from "@natstack/shared/shell/panelManager";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { ProviderManifest } from "@natstack/shared/credentials/types";
import type { MobileTransport } from "./mobileTransport";
import { runOpenaiCodexFlow } from "./codexAuthFlow";

export interface BridgeAdapterCallbacks {
  navigateToPanel(panelId: string): void;
}

const inFlightLogins = new Map<string, Promise<{ success: boolean; error?: string }>>();

function chooseNextPanel(registry: PanelRegistry, closingPanelId: string): string | null {
  const parentId = registry.findParentId(closingPanelId);
  const parent = parentId ? registry.getPanel(parentId) : null;
  if (parent) {
    const siblings = parent.children.filter((child) => child.id !== closingPanelId);
    return siblings.length > 0 ? siblings[siblings.length - 1]!.id : parentId;
  }
  const roots = registry.getRootPanels().filter((panel) => panel.id !== closingPanelId);
  return roots[0]?.id ?? null;
}

export function createBridgeAdapter(deps: {
  panelManager: PanelManager;
  registry: PanelRegistry;
  transport: MobileTransport;
  callbacks: BridgeAdapterCallbacks;
}) {
  /**
   * Run the client-owned OAuth flow for a provider, then ship the
   * resulting authorization code back to the server's credentials service. Concurrent
   * calls for the same provider share the in-flight promise so the OS
   * browser is opened at most once per attempt.
   */
  async function startOAuthLogin(provider: ProviderManifest): Promise<{ success: boolean; error?: string }> {
    const providerId = provider.id;
    const existing = inFlightLogins.get(providerId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const { authorizeUrl, nonce } = await deps.transport.call<{
          authorizeUrl: string;
          nonce: string;
        }>("main", "credentials.beginConsent", {
          provider,
          scopes: [],
          redirect: "mobile-universal",
        });
        const code = await runOpenaiCodexFlow(authorizeUrl, nonce);
        await deps.transport.call("main", "credentials.completeConsent", {
          nonce,
          code,
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    })().finally(() => {
      inFlightLogins.delete(providerId);
    });

    inFlightLogins.set(providerId, promise);
    return promise;
  }

  return {
    async handle(panelId: string, method: string, args: unknown[]): Promise<unknown> {
      switch (method) {
        case "credentialFlow.connect":
          return startOAuthLogin(args[0] as ProviderManifest);
        case "credentialFlow.disconnect":
          return deps.transport.call("main", "credentials.revokeConsent", {
            providerId: args[0] as string,
          });
        case "getPanelInit":
          return deps.panelManager.getPanelInit(panelId);
        case "getInfo":
          return deps.panelManager.getInfo(panelId);
        case "setStateArgs":
          return deps.panelManager.updateStateArgs(panelId, (args[0] ?? {}) as Record<string, unknown>);
        case "closeSelf": {
          const nextPanelId = chooseNextPanel(deps.registry, panelId);
          await deps.panelManager.close(panelId);
          if (nextPanelId) deps.callbacks.navigateToPanel(nextPanelId);
          return;
        }
        case "closeChild": {
          const childId = args[0] as string;
          await deps.panelManager.closeChild(panelId, childId);
          return;
        }
        case "focusPanel": {
          const targetId = args[0] as string;
          await deps.panelManager.notifyFocused(targetId);
          deps.callbacks.navigateToPanel(targetId);
          return;
        }
        case "createBrowserPanel": {
          const [url, options] = args as [string, { name?: string; focus?: boolean }?];
          const created = await deps.panelManager.createBrowser(panelId, url, { name: options?.name });
          if (options?.focus !== false) {
            deps.callbacks.navigateToPanel(created.panelId);
          }
          return { id: created.panelId, title: created.title };
        }
        case "openExternal": {
          const [url] = args as [string];
          await Linking.openURL(url);
          return;
        }
        case "getCdpEndpoint":
          throw new Error("CDP is not available on mobile");
        case "navigate":
        case "goBack":
        case "goForward":
        case "reload":
        case "stop":
          throw new Error(`Browser automation method "${method}" is not available on mobile`);
        case "openDevtools":
          return;
        case "openFolderDialog":
          return null;
        default:
          throw new Error(`Unknown mobile bridge method: ${method}`);
      }
    },
  };
}

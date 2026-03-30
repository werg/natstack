/**
 * Panel URL construction for React Native.
 *
 * Builds the URL that a WebView should load for a given panel.
 * Mirrors the URL pattern from PanelView.setAuthCookiesAndBuildUrl()
 * in src/main/panelView.ts, but passes auth info via query params
 * instead of Electron session cookies (react-native-webview doesn't
 * support pre-setting cookies reliably across all platforms).
 *
 * URL pattern:
 *   {protocol}://{subdomain}.{host}:{port}/{source}/?pid={panelId}&rpcToken={token}
 *
 * The configLoader.js bootstrap on the server reads pid and rpcToken
 * from the URL query string as a fallback when cookies aren't available.
 */

import { isManagedHost, parsePanelUrl } from "@natstack/shared/shell/urlParsing";
import { contextIdToSubdomain } from "@natstack/shared/contextIdToSubdomain";

export { isManagedHost, parsePanelUrl };

/**
 * Host configuration extracted from the server URL.
 *
 * Example: serverUrl "https://natstack.example.com:3000"
 *   -> protocol: "https"
 *   -> host: "natstack.example.com"
 *   -> port: "3000" (or empty for default ports)
 */
export interface HostConfig {
  /** Protocol without trailing colon (e.g. "https") */
  protocol: string;
  /** Host without port (e.g. "natstack.example.com") */
  host: string;
  /** Port string, or empty if using default port for protocol */
  port: string;
}

/**
 * Parse a server URL into a HostConfig.
 *
 * @param serverUrl - Full server URL, e.g. "https://natstack.example.com:3000"
 */
export function parseHostConfig(serverUrl: string): HostConfig {
  // Manual parsing instead of `new URL()` — Hermes doesn't fully implement URL API
  const match = serverUrl.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/);
  if (!match) throw new Error(`Invalid server URL: ${serverUrl}`);
  return {
    protocol: match[1]!,
    host: match[2]!,
    port: match[3] ?? "",
  };
}

/**
 * Build the full URL to load a panel in a WebView.
 *
 * @param panelId - The panel's unique ID
 * @param source - Panel source path (e.g. "panels/chat")
 * @param contextId - Context ID for subdomain isolation
 * @param panelToken - Per-panel RPC token (from panel.getCredentials)
 * @param rpcPort - The RPC port for the panel's WebSocket connection
 * @param hostConfig - Parsed server host configuration
 *
 * @returns The URL string to load in the WebView
 */
export function buildPanelUrl(
  panelId: string,
  source: string,
  contextId: string,
  panelToken: string,
  rpcPort: number,
  hostConfig: HostConfig,
): string {
  const subdomain = contextIdToSubdomain(contextId);
  const portSuffix = hostConfig.port ? `:${hostConfig.port}` : "";
  const origin = `${hostConfig.protocol}://${subdomain}.${hostConfig.host}${portSuffix}`;

  const params = new URLSearchParams();
  params.set("pid", panelId);
  params.set("rpcPort", String(rpcPort));
  params.set("rpcToken", panelToken);
  params.set("rpcHost", hostConfig.host);

  return `${origin}/${source}/?${params.toString()}`;
}

/**
 * Extract the externalHost value from a HostConfig.
 * This is the host that isManagedHost() and parsePanelUrl() check against.
 */
export function getExternalHost(hostConfig: HostConfig): string {
  return hostConfig.host;
}

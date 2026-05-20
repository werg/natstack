import { createConnectDeepLink } from "@natstack/shared/connect";

export function formatPairUrlLine(targetUrl: string, pairingCode: string): string {
  return `  Pair URL:     ${createConnectDeepLink(targetUrl, pairingCode)}`;
}

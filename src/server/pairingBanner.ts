import { type ConnectPairing, createConnectDeepLink } from "@natstack/shared/connect";

export function formatPairUrlLine(pairing: ConnectPairing): string {
  return `  Pair URL:     ${createConnectDeepLink(pairing)}`;
}

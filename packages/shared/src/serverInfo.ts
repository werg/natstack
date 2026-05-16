export interface ProxyIdentityServerInfo {
  egressProxyPort?: number;
  assertionSecret?: string;
  internalHopSecret?: string;
}

export interface ServerReadyPayload extends ProxyIdentityServerInfo {
  type: "ready";
  workerdPort?: number;
  gatewayPort: number;
  adminToken: string;
  shellToken?: string;
}

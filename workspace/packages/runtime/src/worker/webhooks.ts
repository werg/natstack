export interface RegisteredWebhookHandler {
  moduleName: string;
  eventType: string;
  rpcMethod: string;
  subscriptionId: string;
  leaseId?: string;
}

export interface RegisterWebhookOptions {
  methodPrefix?: string;
}

export async function registerManifestWebhooks(): Promise<RegisteredWebhookHandler[]> {
  throw new Error("Managed credential-backed webhook registration has been removed. Use a provider-agnostic webhook model instead.");
}

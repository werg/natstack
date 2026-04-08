/**
 * SettingsClient -- Shared settings RPC wrappers.
 *
 * Wraps settings-related server RPC calls for provider configuration
 * and model role management.
 */

import type { RpcBridge } from "@natstack/rpc";
import type { SettingsData } from "../types.js";

export class SettingsClient {
  private rpc: RpcBridge;

  constructor(rpc: RpcBridge) {
    this.rpc = rpc;
  }

  getData(): Promise<SettingsData> {
    return this.rpc.call<SettingsData>("main", "settings.getData");
  }

  setApiKey(providerId: string, apiKey: string): Promise<void> {
    return this.rpc.call<void>("main", "settings.setApiKey", providerId, apiKey);
  }

  removeApiKey(providerId: string): Promise<void> {
    return this.rpc.call<void>("main", "settings.removeApiKey", providerId);
  }

  setModelRole(role: string, modelSpec: string): Promise<void> {
    return this.rpc.call<void>("main", "settings.setModelRole", role, modelSpec);
  }
}

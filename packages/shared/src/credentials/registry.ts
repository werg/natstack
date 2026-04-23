import type { ProviderManifest, FlowConfig } from './types.js';

export class ProviderRegistry {
  private readonly manifests = new Map<string, ProviderManifest>();

  register(manifest: ProviderManifest): void {
    this.manifests.set(manifest.id, manifest);
  }

  get(providerId: string): ProviderManifest | undefined {
    return this.manifests.get(providerId);
  }

  list(): ProviderManifest[] {
    return [...this.manifests.values()];
  }

  applyConfig(providerConfigs: Record<string, { clientId?: string; clientSecret?: string }>): void {
    for (const [providerId, overrides] of Object.entries(providerConfigs)) {
      const manifest = this.manifests.get(providerId);
      if (!manifest) {
        continue;
      }

      if (overrides.clientId) {
        const updated: ProviderManifest = {
          ...manifest,
          clientId: overrides.clientId,
          flows: manifest.flows.map((flow): FlowConfig => {
            if (flow.clientId) {
              return { ...flow, clientId: overrides.clientId! };
            }
            return flow;
          }),
        };
        if (overrides.clientSecret) {
          updated.flows = updated.flows.map((flow): FlowConfig => ({
            ...flow,
            clientSecret: overrides.clientSecret,
          }));
        }
        this.manifests.set(providerId, updated);
      }
    }
  }

  applyEnvironment(): void {
    for (const [providerId, manifest] of this.manifests) {
      const envPrefix = `NATSTACK_${providerId.toUpperCase()}`;
      const envClientId = process.env[`${envPrefix}_CLIENT_ID`];
      const envClientSecret = process.env[`${envPrefix}_CLIENT_SECRET`];

      if (envClientId) {
        this.applyConfig({ [providerId]: { clientId: envClientId, clientSecret: envClientSecret } });
      }
    }
  }
}

import type { ProviderManifest } from "./types.js";

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

  async loadFromConfig(packageNames: string[]): Promise<void> {
    console.info("ProviderRegistry.loadFromConfig is not implemented", { packageNames });
  }
}

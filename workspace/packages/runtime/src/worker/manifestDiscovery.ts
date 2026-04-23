import type { CredentialHandle } from "./credentials.js";

export interface EndpointDeclaration {
  url: string;
  methods: string[] | "*";
}

export interface WebhookBinding {
  event: string;
  deliver: string;
}

export interface IntegrationManifest {
  providers: (string | { id: string; role: string })[];
  scopes: Record<string, string[]>;
  endpoints: Record<string, EndpointDeclaration[]>;
  webhooks?: Record<string, WebhookBinding[]>;
}

export interface DiscoveredManifest {
  moduleName: string;
  manifest: IntegrationManifest;
}

export interface ResolvedProviderBinding {
  providerId: string;
  role?: string;
  scopes: string[];
  endpoints: EndpointDeclaration[];
  webhooks: WebhookBinding[];
}

export function collectManifests(modules: Record<string, unknown>): DiscoveredManifest[] {
  const results: DiscoveredManifest[] = [];

  for (const [name, mod] of Object.entries(modules)) {
    if (!mod || typeof mod !== "object") continue;
    const manifest = (mod as Record<string, unknown>)["manifest"];
    if (!manifest || typeof manifest !== "object") continue;
    if (!isIntegrationManifest(manifest)) continue;
    results.push({ moduleName: name, manifest: manifest as IntegrationManifest });
  }

  return results;
}

export function resolveProviderBindings(manifests: DiscoveredManifest[]): ResolvedProviderBinding[] {
  const byProvider = new Map<string, ResolvedProviderBinding>();

  for (const { manifest } of manifests) {
    for (const provider of manifest.providers) {
      const providerId = typeof provider === "string" ? provider : provider.id;
      const role = typeof provider === "object" ? provider.role : undefined;
      const key = role ? `${providerId}:${role}` : providerId;

      let binding = byProvider.get(key);
      if (!binding) {
        binding = {
          providerId,
          role,
          scopes: [],
          endpoints: [],
          webhooks: [],
        };
        byProvider.set(key, binding);
      }

      const providerScopes = manifest.scopes[providerId] ?? [];
      for (const scope of providerScopes) {
        if (!binding.scopes.includes(scope)) {
          binding.scopes.push(scope);
        }
      }

      const providerEndpoints = manifest.endpoints[providerId] ?? [];
      binding.endpoints.push(...providerEndpoints);

      const providerWebhooks = manifest.webhooks?.[providerId] ?? [];
      binding.webhooks.push(...providerWebhooks);
    }
  }

  return Array.from(byProvider.values());
}

function isIntegrationManifest(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj["providers"]) && typeof obj["scopes"] === "object";
}

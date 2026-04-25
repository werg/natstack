import type { WorkerRuntime } from "./index.js";
import { collectManifests } from "./manifestDiscovery.js";

type IntegrationModule = Record<string, unknown>;

export interface RegisteredWebhookHandler {
  moduleName: string;
  providerId: string;
  eventType: string;
  rpcMethod: string;
  subscriptionId: string;
  leaseId?: string;
}

export interface RegisterWebhookOptions {
  connectionIds?: Record<string, string | undefined>;
  resolveConnectionId?: (params: {
    moduleName: string;
    providerId: string;
    eventType: string;
  }) => Promise<string | undefined> | string | undefined;
  methodPrefix?: string;
}

export async function registerManifestWebhooks(
  runtime: Pick<WorkerRuntime, "credentials" | "exposeMethod">,
  modules: Record<string, IntegrationModule>,
  options: RegisterWebhookOptions = {},
): Promise<RegisteredWebhookHandler[]> {
  const registrations: RegisteredWebhookHandler[] = [];
  const manifests = collectManifests(modules);

  for (const { moduleName, manifest } of manifests) {
    const module = modules[moduleName];
    const providerEntries = Object.entries(manifest.webhooks ?? {});
    const providersById = new Map(
      manifest.providers.map((entry) => {
        const provider = "provider" in entry ? entry.provider : entry;
        return [provider.id, provider] as const;
      }),
    );

    for (const [providerId, bindings] of providerEntries) {
      const provider = providersById.get(providerId);
      if (!provider) {
        throw new Error(`Webhook provider "${providerId}" was not declared in module "${moduleName}"`);
      }
      for (const binding of bindings) {
        const handler = module?.[binding.deliver];
        if (typeof handler !== "function") {
          throw new Error(
            `Webhook handler "${binding.deliver}" was not found in module "${moduleName}"`,
          );
        }

        const rpcMethod =
          `${options.methodPrefix ?? "__webhook__"}.` +
          [moduleName, providerId, binding.event, binding.deliver].map(sanitizeSegment).join(".");
        runtime.exposeMethod(rpcMethod, async (event: unknown) => await handler(event));

        const connectionId =
          options.connectionIds?.[providerId] ??
          await options.resolveConnectionId?.({
            moduleName,
            providerId,
            eventType: binding.event,
          });

        const subscription = await runtime.credentials.subscribeWebhook(provider, binding.event, {
          connectionId,
          handler: rpcMethod,
        });

        registrations.push({
          moduleName,
          providerId,
          eventType: binding.event,
          rpcMethod,
          subscriptionId: subscription.subscriptionId,
          leaseId: subscription.leaseId,
        });
      }
    }
  }

  return registrations;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

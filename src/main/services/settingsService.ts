import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type {
  SettingsData,
  ProviderInfo,
  AvailableProvider,
  ModelRoleConfig,
} from "@natstack/shared/types";
import type { SupportedProvider } from "@natstack/shared/workspace/types";
import type { ServerClient } from "../serverClient.js";
import {
  loadCentralConfig,
  saveCentralConfig,
  loadSecrets,
  saveSecrets,
} from "@natstack/shared/workspace/loader";
import {
  getSupportedProviders,
  getProviderEnvVars,
  getProviderDisplayName,
  getDefaultModelsForProvider,
  hasProviderApiKey,
  usesCliAuth,
} from "@natstack/shared/ai/providerFactory";
import { fetchModelsForProvider, type FetchedModel } from "@natstack/shared/ai/modelFetcher";

function getApiKeyForProvider(
  providerId: SupportedProvider,
  envVars: Record<SupportedProvider, string>,
  secrets: Record<string, string>,
): string | undefined {
  const envVar = envVars[providerId];
  return process.env[envVar] || secrets[providerId];
}

function hasConfiguredProviders(): boolean {
  const providers = getSupportedProviders();
  const secrets = loadSecrets();
  return providers.some((providerId) => {
    if (usesCliAuth(providerId)) return secrets[providerId] === "enabled";
    return hasProviderApiKey(providerId);
  });
}

export function createSettingsService(deps: {
  serverClient: ServerClient | null;
}): ServiceDefinition {
  async function refreshAiProviders(): Promise<void> {
    if (!deps.serverClient) return;
    try {
      await deps.serverClient.call("ai", "reinitialize", []);
    } catch (error) {
      console.error("[Settings] Failed to refresh AI providers:", error);
    }
  }

  return {
    name: "settings",
    description: "Settings, API keys, model roles",
    policy: { allowed: ["shell"] },
    methods: {
      getData: { args: z.tuple([]) },
      setApiKey: { args: z.tuple([z.string(), z.string()]) },
      removeApiKey: { args: z.tuple([z.string()]) },
      setModelRole: { args: z.tuple([z.string(), z.string()]) },
      enableProvider: { args: z.tuple([z.string()]) },
      disableProvider: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "getData": {
          const centralConfig = loadCentralConfig();
          const supportedProviders = getSupportedProviders();
          const envVars = getProviderEnvVars();
          const secrets = loadSecrets();

          const fetchedModels = new Map<SupportedProvider, FetchedModel[]>();
          const fetchPromises = supportedProviders.map(async (providerId) => {
            const cliAuth = usesCliAuth(providerId);
            const hasKey = hasProviderApiKey(providerId);
            const isEnabled = cliAuth ? secrets[providerId] === "enabled" : false;

            if (hasKey || (cliAuth && isEnabled)) {
              const apiKey = getApiKeyForProvider(providerId, envVars, secrets);
              if (apiKey || cliAuth) {
                try {
                  const models = await fetchModelsForProvider(providerId, apiKey ?? "");
                  if (models && models.length > 0) {
                    fetchedModels.set(providerId, models);
                  }
                } catch (error) {
                  console.warn(`[Settings] Failed to fetch models for ${providerId}:`, error);
                }
              }
            }
          });

          await Promise.race([
            Promise.all(fetchPromises),
            new Promise((resolve) => setTimeout(resolve, 15000)),
          ]);

          const providers: ProviderInfo[] = supportedProviders.map((providerId) => {
            const cliAuth = usesCliAuth(providerId);
            const fetched = fetchedModels.get(providerId);
            const models = fetched
              ? fetched.map((m) => m.id)
              : getDefaultModelsForProvider(providerId).map((m) => m.id);

            return {
              id: providerId,
              name: getProviderDisplayName(providerId),
              hasApiKey: hasProviderApiKey(providerId),
              models,
              usesCliAuth: cliAuth,
              isEnabled: cliAuth ? secrets[providerId] === "enabled" : undefined,
            };
          });

          const availableProviders: AvailableProvider[] = supportedProviders.map((providerId) => ({
            id: providerId,
            name: getProviderDisplayName(providerId),
            envVar: envVars[providerId],
            usesCliAuth: usesCliAuth(providerId),
          }));

          const modelRoles: ModelRoleConfig = {};
          if (centralConfig.models) {
            for (const [role, value] of Object.entries(centralConfig.models)) {
              if (typeof value === "string") {
                modelRoles[role] = value;
              } else if (value && typeof value === "object" && "provider" in value && "model" in value) {
                modelRoles[role] = `${value.provider}:${value.model}`;
              }
            }
          }

          return {
            providers,
            modelRoles,
            availableProviders,
            hasConfiguredProviders: hasConfiguredProviders(),
          } as SettingsData;
        }

        case "setApiKey": {
          const [providerId, apiKey] = args as [string, string];
          const secrets = loadSecrets();
          secrets[providerId] = apiKey;
          saveSecrets(secrets);

          const envVars = getProviderEnvVars();
          const envVar = envVars[providerId as SupportedProvider];
          if (envVar) process.env[envVar] = apiKey;

          await refreshAiProviders();
          return;
        }

        case "removeApiKey": {
          const providerId = args[0] as string;
          const secrets = loadSecrets();
          delete secrets[providerId];
          saveSecrets(secrets);

          const envVars = getProviderEnvVars();
          const envVar = envVars[providerId as SupportedProvider];
          if (envVar) delete process.env[envVar];

          await refreshAiProviders();
          return;
        }

        case "setModelRole": {
          const [role, modelSpec] = args as [string, string];
          const config = loadCentralConfig();
          if (!config.models) config.models = {};
          config.models[role] = modelSpec;
          saveCentralConfig(config);

          await refreshAiProviders();
          return;
        }

        case "enableProvider": {
          const providerId = args[0] as string;
          if (!usesCliAuth(providerId as SupportedProvider)) {
            console.warn(`[Settings] Cannot enable provider ${providerId} - not a CLI-auth provider`);
            return;
          }
          const secrets = loadSecrets();
          secrets[providerId] = "enabled";
          saveSecrets(secrets);

          await refreshAiProviders();
          return;
        }

        case "disableProvider": {
          const providerId = args[0] as string;
          if (!usesCliAuth(providerId as SupportedProvider)) {
            console.warn(`[Settings] Cannot disable provider ${providerId} - not a CLI-auth provider`);
            return;
          }
          const secrets = loadSecrets();
          delete secrets[providerId];
          saveSecrets(secrets);

          await refreshAiProviders();
          return;
        }

        default:
          throw new Error(`Unknown settings method: ${method}`);
      }
    },
  };
}

/**
 * Model Fetcher - Dynamically fetch available models from AI providers.
 *
 * Fetches model lists from provider APIs when the Model Provider Config UI is loaded.
 * Falls back to hardcoded defaults if API calls fail.
 */

import type { SupportedProvider } from "../workspace/types.js";

/**
 * Model information returned from provider APIs
 */
export interface FetchedModel {
  id: string;
  displayName: string;
  description?: string;
}

/**
 * Provider API configurations
 */
interface ProviderApiConfig {
  url: string;
  getHeaders: (apiKey: string) => Record<string, string>;
  parseResponse: (data: unknown) => FetchedModel[];
}

/**
 * API configurations for each provider
 */
const PROVIDER_API_CONFIGS: Partial<Record<SupportedProvider, ProviderApiConfig>> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    getHeaders: (apiKey) => ({
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    }),
    parseResponse: (data) => {
      const response = data as { data?: Array<{ id: string; display_name?: string }> };
      return (response.data ?? [])
        .filter((m) => m.id.startsWith("claude-") && !m.id.includes("embed"))
        .map((m) => ({
          id: m.id,
          displayName: m.display_name ?? m.id,
        }));
    },
  },

  openai: {
    url: "https://api.openai.com/v1/models",
    getHeaders: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
    }),
    parseResponse: (data) => {
      const response = data as { data?: Array<{ id: string; owned_by?: string }> };
      // Filter to chat/completion models, exclude embeddings, whisper, dall-e, etc.
      const chatModels = ["gpt-4", "gpt-3.5", "o1", "o3", "chatgpt"];
      return (response.data ?? [])
        .filter((m) => chatModels.some((prefix) => m.id.startsWith(prefix) || m.id.includes(prefix)))
        .filter((m) => !m.id.includes("realtime") && !m.id.includes("audio"))
        .map((m) => ({
          id: m.id,
          displayName: m.id,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
  },

  google: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    getHeaders: () => ({}), // API key goes in URL
    parseResponse: (data) => {
      const response = data as {
        models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
      };
      return (response.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => {
          // name is like "models/gemini-1.5-pro"
          const id = m.name.replace("models/", "");
          return {
            id,
            displayName: m.displayName ?? id,
          };
        });
    },
  },

  groq: {
    url: "https://api.groq.com/openai/v1/models",
    getHeaders: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
    }),
    parseResponse: (data) => {
      const response = data as { data?: Array<{ id: string; owned_by?: string }> };
      // Filter out whisper and other non-chat models
      return (response.data ?? [])
        .filter((m) => !m.id.includes("whisper") && !m.id.includes("guard"))
        .map((m) => ({
          id: m.id,
          displayName: m.id,
        }));
    },
  },

  openrouter: {
    url: "https://openrouter.ai/api/v1/models",
    getHeaders: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
    }),
    parseResponse: (data) => {
      const response = data as { data?: Array<{ id: string; name?: string }> };
      // Return top models by popularity/usefulness
      const preferredPrefixes = [
        "anthropic/",
        "openai/",
        "google/",
        "meta-llama/",
        "mistralai/",
        "deepseek/",
        "qwen/",
      ];
      return (response.data ?? [])
        .filter((m) => preferredPrefixes.some((p) => m.id.toLowerCase().startsWith(p)))
        .slice(0, 50) // Limit to top 50
        .map((m) => ({
          id: m.id,
          displayName: m.name ?? m.id,
        }));
    },
  },

  mistral: {
    url: "https://api.mistral.ai/v1/models",
    getHeaders: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
    }),
    parseResponse: (data) => {
      const response = data as { data?: Array<{ id: string; name?: string }> };
      return (response.data ?? [])
        .filter((m) => !m.id.includes("embed"))
        .map((m) => ({
          id: m.id,
          displayName: m.name ?? m.id,
        }));
    },
  },

  together: {
    url: "https://api.together.xyz/v1/models",
    getHeaders: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
    }),
    parseResponse: (data) => {
      const response = data as Array<{ id: string; display_name?: string; type?: string }>;
      // Filter to chat models only
      return (Array.isArray(response) ? response : [])
        .filter((m) => m.type === "chat" || m.type === "language")
        .slice(0, 50) // Limit results
        .map((m) => ({
          id: m.id,
          displayName: m.display_name ?? m.id,
        }));
    },
  },

  replicate: {
    url: "https://api.replicate.com/v1/models",
    getHeaders: (apiKey) => ({
      Authorization: `Bearer ${apiKey}`,
    }),
    parseResponse: (data) => {
      const response = data as { results?: Array<{ owner: string; name: string; description?: string }> };
      // Filter to language models
      return (response.results ?? [])
        .filter((m) => m.name.includes("llama") || m.name.includes("mistral") || m.name.includes("codellama"))
        .slice(0, 20)
        .map((m) => ({
          id: `${m.owner}/${m.name}`,
          displayName: m.name,
          description: m.description,
        }));
    },
  },
};

/**
 * Hardcoded models for Perplexity (no list endpoint available)
 */
const PERPLEXITY_MODELS: FetchedModel[] = [
  { id: "sonar", displayName: "Sonar", description: "Lightweight grounded search" },
  { id: "sonar-pro", displayName: "Sonar Pro", description: "Deeper retrieval with follow-ups" },
  { id: "sonar-reasoning", displayName: "Sonar Reasoning", description: "Real-time reasoning with search" },
  {
    id: "sonar-reasoning-pro",
    displayName: "Sonar Reasoning Pro",
    description: "Powered by DeepSeek-R1",
  },
  {
    id: "sonar-deep-research",
    displayName: "Sonar Deep Research",
    description: "Long-form source-dense reports",
  },
];

/**
 * Hardcoded models for CLI-based providers
 */
const CLI_PROVIDER_MODELS: Record<string, FetchedModel[]> = {
  "claude-code": [
    { id: "sonnet", displayName: "Claude Code (Sonnet)", description: "Optimized for coding tasks" },
    { id: "opus", displayName: "Claude Code (Opus)", description: "Most capable for complex coding" },
    { id: "haiku", displayName: "Claude Code (Haiku)", description: "Fast and efficient" },
  ],
  "codex-cli": [
    { id: "gpt-5.1-codex", displayName: "Codex CLI (GPT-5.1 Codex)", description: "Optimized for coding" },
    { id: "gpt-5.1-codex-max", displayName: "Codex CLI (GPT-5.1 Codex Max)", description: "Flagship model" },
    { id: "gpt-5.1-codex-mini", displayName: "Codex CLI (GPT-5.1 Codex Mini)", description: "Lightweight" },
  ],
};

/**
 * Fetch models from a provider's API
 */
export async function fetchModelsForProvider(
  providerId: SupportedProvider,
  apiKey: string
): Promise<FetchedModel[] | null> {
  // Handle CLI-based providers
  if (providerId === "claude-code" || providerId === "codex-cli") {
    return CLI_PROVIDER_MODELS[providerId] ?? null;
  }

  // Handle Perplexity (no list endpoint)
  if (providerId === "perplexity") {
    return PERPLEXITY_MODELS;
  }

  const config = PROVIDER_API_CONFIGS[providerId];
  if (!config) {
    console.warn(`[ModelFetcher] No API config for provider: ${providerId}`);
    return null;
  }

  try {
    // Build URL (Google needs API key in URL)
    let url = config.url;
    if (providerId === "google") {
      url = `${config.url}?key=${apiKey}`;
    }

    const headers = config.getHeaders(apiKey);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(
        `[ModelFetcher] Failed to fetch models for ${providerId}: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data = await response.json();
    const models = config.parseResponse(data);

    console.log(`[ModelFetcher] Fetched ${models.length} models for ${providerId}`);
    return models;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.warn(`[ModelFetcher] Timeout fetching models for ${providerId}`);
    } else {
      console.warn(`[ModelFetcher] Error fetching models for ${providerId}:`, error);
    }
    return null;
  }
}

/**
 * Fetch models for all configured providers
 */
export async function fetchAllProviderModels(
  providers: Array<{ id: SupportedProvider; apiKey?: string; isEnabled?: boolean }>
): Promise<Map<SupportedProvider, FetchedModel[]>> {
  const results = new Map<SupportedProvider, FetchedModel[]>();

  // Fetch in parallel with individual error handling
  const fetchPromises = providers.map(async (provider) => {
    // Skip providers without API keys (except CLI-based ones)
    const isCli = provider.id === "claude-code" || provider.id === "codex-cli";
    if (!isCli && !provider.apiKey) {
      return;
    }

    // For CLI providers, only fetch if enabled
    if (isCli && !provider.isEnabled) {
      return;
    }

    const models = await fetchModelsForProvider(provider.id, provider.apiKey ?? "");
    if (models && models.length > 0) {
      results.set(provider.id, models);
    }
  });

  await Promise.all(fetchPromises);

  return results;
}

/**
 * AI Provider Factory — Pi-native model/provider helpers.
 *
 * The Vercel AI SDK provider machinery and the Claude Agent CLI provider were
 * removed in Phase 5. Pi (`@mariozechner/pi-ai` + `@mariozechner/pi-coding-agent`)
 * is now the sole runtime; this module just exposes thin helpers used by the
 * Settings UI and central-config plumbing.
 */

import { execSync } from "child_process";
import { getModels as piGetModels, getProviders as piGetProviders } from "@mariozechner/pi-ai";
import type { SupportedProvider } from "../workspace/types.js";

/**
 * Find an executable in the system PATH.
 * Cross-platform: uses `where` on Windows, `which` on Unix-like systems.
 */
export function findExecutable(name: string): string | undefined {
  const isWindows = process.platform === "win32";
  const command = isWindows ? `where ${name}` : `which ${name}`;

  try {
    const result = execSync(command, { encoding: "utf-8" }).trim();
    // `where` on Windows may return multiple lines; take the first one
    const firstLine = result.split(/\r?\n/)[0];
    return firstLine || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Model information for a provider (Settings UI shape).
 */
export interface ModelInfo {
  id: string;
  displayName: string;
  description?: string;
}

/**
 * Environment variable names for each NatStack provider's API key.
 */
const PROVIDER_ENV_VARS: Record<SupportedProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  replicate: "REPLICATE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

/**
 * Display names for NatStack-recognized providers.
 */
const PROVIDER_DISPLAY_NAMES: Record<SupportedProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  groq: "Groq",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  together: "Together AI",
  replicate: "Replicate",
  perplexity: "Perplexity",
};

/**
 * Static fallback model lists for providers Pi doesn't ship a registry for
 * (Together, Replicate, Perplexity), or for which we want to surface a curated
 * subset in the Settings UI.
 *
 * For Pi-known providers, the live list comes from `piGetModels()`.
 */
const STATIC_FALLBACK_MODELS: Partial<Record<SupportedProvider, ModelInfo[]>> = {
  together: [
    {
      id: "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
      displayName: "Llama 3.1 405B",
      description: "Largest Llama model",
    },
    {
      id: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
      displayName: "Llama 3.1 70B",
      description: "Large Llama model",
    },
    {
      id: "Qwen/Qwen2.5-72B-Instruct-Turbo",
      displayName: "Qwen 2.5 72B",
      description: "Large Qwen model",
    },
  ],
  replicate: [
    {
      id: "meta/meta-llama-3-70b-instruct",
      displayName: "Llama 3 70B",
      description: "Llama on Replicate",
    },
  ],
  perplexity: [
    {
      id: "sonar",
      displayName: "Sonar",
      description: "Lightweight grounded search",
    },
    {
      id: "sonar-pro",
      displayName: "Sonar Pro",
      description: "Deeper retrieval with follow-ups",
    },
  ],
};

/**
 * Get the default models for a provider.
 *
 * Pulls from Pi's built-in model registry where possible; falls back to a
 * static curated list for providers Pi doesn't ship metadata for.
 */
export function getDefaultModelsForProvider(providerId: SupportedProvider): ModelInfo[] {
  // Try Pi's built-in registry first.
  try {
    // pi-ai's KnownProvider type is narrower than NatStack's SupportedProvider,
    // but the runtime accepts any string and returns [] for unknown providers.
    const piModels = piGetModels(providerId as never) as Array<{ id: string; name: string }>;
    if (piModels && piModels.length > 0) {
      return piModels.map((m) => ({
        id: m.id,
        displayName: m.name ?? m.id,
      }));
    }
  } catch {
    // Pi rejected the provider id — fall through to static list.
  }

  return STATIC_FALLBACK_MODELS[providerId] ?? [];
}

/**
 * Check if a provider ID is supported (i.e., NatStack knows about it).
 */
export function isSupportedProvider(providerId: string): providerId is SupportedProvider {
  return providerId in PROVIDER_ENV_VARS;
}

/**
 * Get all supported provider IDs.
 */
export function getSupportedProviders(): SupportedProvider[] {
  return Object.keys(PROVIDER_ENV_VARS) as SupportedProvider[];
}

/**
 * Get provider env-var mapping.
 */
export function getProviderEnvVars(): Record<SupportedProvider, string> {
  return PROVIDER_ENV_VARS;
}

/**
 * Get a provider's display name.
 */
export function getProviderDisplayName(providerId: SupportedProvider): string {
  return PROVIDER_DISPLAY_NAMES[providerId] ?? providerId;
}

/**
 * Check if a provider has an API key configured in the environment.
 */
export function hasProviderApiKey(providerId: SupportedProvider): boolean {
  const envVar = PROVIDER_ENV_VARS[providerId];
  return !!process.env[envVar];
}

/**
 * Get the list of providers Pi knows about natively (for diagnostics / Settings).
 */
export function getPiKnownProviders(): string[] {
  try {
    return piGetProviders() as string[];
  } catch {
    return [];
  }
}

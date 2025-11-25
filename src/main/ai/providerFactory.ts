/**
 * AI Provider Factory
 *
 * Creates AI SDK providers from workspace configuration.
 * Supports multiple providers with OpenAI-compatible fallbacks for some.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createClaudeCode } from "ai-sdk-provider-claude-code";
import { codexCli } from "ai-sdk-provider-codex-cli";
import { execSync } from "child_process";
import type { AIProviderConfig } from "./aiHandler.js";
import type { SupportedProvider } from "../workspace/types.js";

/**
 * Find an executable in the system PATH.
 * Cross-platform: uses `where` on Windows, `which` on Unix-like systems.
 */
function findExecutable(name: string): string | undefined {
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
 * Find the path to the Claude Code CLI executable.
 */
function findClaudeCodeExecutable(): string | undefined {
  return findExecutable("claude");
}

/**
 * Find the path to the Codex CLI executable.
 */
function findCodexCliExecutable(): string | undefined {
  return findExecutable("codex");
}

/**
 * Model information for a provider
 */
interface ModelInfo {
  id: string;
  displayName: string;
  description?: string;
}

/**
 * Default models for each provider.
 * These are commonly available models - the actual availability depends on the user's API access.
 */
const DEFAULT_MODELS: Record<SupportedProvider, ModelInfo[]> = {
  anthropic: [
    {
      id: "claude-sonnet-4-20250514",
      displayName: "Claude Sonnet 4",
      description: "Most intelligent model, best for complex tasks",
    },
    {
      id: "claude-haiku-4-5-20251001",
      displayName: "Claude 4.5 Haiku",
      description: "Fast and efficient for simpler tasks",
    },
  ],
  openai: [
    {
      id: "gpt-4o",
      displayName: "GPT-4o",
      description: "Most capable OpenAI model",
    },
    {
      id: "gpt-4o-mini",
      displayName: "GPT-4o Mini",
      description: "Smaller, faster GPT-4o variant",
    },
    {
      id: "gpt-4-turbo",
      displayName: "GPT-4 Turbo",
      description: "Fast GPT-4 with large context",
    },
    {
      id: "o1",
      displayName: "o1",
      description: "Advanced reasoning model",
    },
    {
      id: "o1-mini",
      displayName: "o1 Mini",
      description: "Smaller reasoning model",
    },
  ],
  google: [
    {
      id: "gemini-2.0-flash",
      displayName: "Gemini 2.0 Flash",
      description: "Fast multimodal model",
    },
    {
      id: "gemini-1.5-pro",
      displayName: "Gemini 1.5 Pro",
      description: "Powerful model with long context",
    },
    {
      id: "gemini-1.5-flash",
      displayName: "Gemini 1.5 Flash",
      description: "Fast and efficient",
    },
  ],
  groq: [
    {
      id: "llama-3.3-70b-versatile",
      displayName: "Llama 3.3 70B",
      description: "Large Llama model on Groq",
    },
    {
      id: "llama-3.1-8b-instant",
      displayName: "Llama 3.1 8B Instant",
      description: "Very fast small Llama model",
    },
    {
      id: "mixtral-8x7b-32768",
      displayName: "Mixtral 8x7B",
      description: "Mixtral MoE model",
    },
  ],
  openrouter: [
    {
      id: "anthropic/claude-sonnet-4",
      displayName: "Claude Sonnet 4 (OpenRouter)",
      description: "Claude via OpenRouter",
    },
    {
      id: "openai/gpt-4o",
      displayName: "GPT-4o (OpenRouter)",
      description: "GPT-4o via OpenRouter",
    },
    {
      id: "google/gemini-2.0-flash-001",
      displayName: "Gemini 2.0 Flash (OpenRouter)",
      description: "Gemini via OpenRouter",
    },
    {
      id: "meta-llama/llama-3.3-70b-instruct",
      displayName: "Llama 3.3 70B (OpenRouter)",
      description: "Llama via OpenRouter",
    },
  ],
  mistral: [
    {
      id: "mistral-large-latest",
      displayName: "Mistral Large",
      description: "Most capable Mistral model",
    },
    {
      id: "mistral-medium-latest",
      displayName: "Mistral Medium",
      description: "Balanced performance",
    },
    {
      id: "mistral-small-latest",
      displayName: "Mistral Small",
      description: "Fast and efficient",
    },
    {
      id: "codestral-latest",
      displayName: "Codestral",
      description: "Optimized for code generation",
    },
  ],
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
      id: "llama-3.1-sonar-large-128k-online",
      displayName: "Sonar Large Online",
      description: "Web-connected reasoning",
    },
    {
      id: "llama-3.1-sonar-small-128k-online",
      displayName: "Sonar Small Online",
      description: "Fast web-connected model",
    },
  ],
  "claude-code": [
    {
      id: "sonnet",
      displayName: "Claude Code (Sonnet)",
      description: "Claude Code agent with Sonnet model - optimized for coding tasks",
    },
    {
      id: "opus",
      displayName: "Claude Code (Opus)",
      description: "Claude Code agent with Opus model - most capable for complex coding",
    },
    {
      id: "haiku",
      displayName: "Claude Code (Haiku)",
      description: "Claude Code agent with Haiku model - fast and efficient",
    },
  ],
  "codex-cli": [
    {
      id: "gpt-5.1-codex",
      displayName: "Codex CLI (GPT-5.1 Codex)",
      description: "OpenAI Codex agent - optimized for coding tasks",
    },
    {
      id: "gpt-5.1-codex-max",
      displayName: "Codex CLI (GPT-5.1 Codex Max)",
      description: "OpenAI Codex agent - flagship model for complex coding",
    },
    {
      id: "gpt-5.1-codex-mini",
      displayName: "Codex CLI (GPT-5.1 Codex Mini)",
      description: "OpenAI Codex agent - lightweight and fast",
    },
  ],
};

/**
 * Base URLs for OpenAI-compatible providers
 */
const OPENAI_COMPATIBLE_BASE_URLS: Partial<Record<SupportedProvider, string>> = {
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  together: "https://api.together.xyz/v1",
  replicate: "https://openai-proxy.replicate.com/v1",
  perplexity: "https://api.perplexity.ai",
};

/**
 * Environment variable names for each provider's API key.
 * Note: Claude Code uses CLI authentication via `claude login`, not an API key.
 * The empty string indicates no API key is needed.
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
  "claude-code": "", // Uses CLI auth, not API key
  "codex-cli": "", // Uses CLI auth, not API key
};

/**
 * Get the API key for a provider from environment variables.
 * API keys come from .secrets.yml (loaded into env) or .env file.
 */
function getApiKey(providerId: SupportedProvider): string | undefined {
  const envVar = PROVIDER_ENV_VARS[providerId];
  return process.env[envVar];
}

/**
 * Create an AI provider configuration.
 * API keys are read from environment variables (populated from .secrets.yml or .env).
 * Returns null if the provider cannot be created (e.g., missing API key).
 * Note: Claude Code uses CLI authentication and doesn't require an API key.
 */
export function createProviderFromConfig(providerId: SupportedProvider): AIProviderConfig | null {
  const models = DEFAULT_MODELS[providerId] ?? [];

  // Claude Code uses CLI authentication, not API keys
  if (providerId === "claude-code") {
    // Find the Claude Code CLI executable path
    // This is needed because import.meta.url is not available in Electron's bundled environment
    const claudeExecutable = findClaudeCodeExecutable();
    if (!claudeExecutable) {
      console.warn("[ProviderFactory] Claude Code CLI not found in PATH, skipping");
      return null;
    }

    return {
      id: providerId,
      name: "Claude Code",
      createModel: (modelId) =>
        createClaudeCode()(modelId as "sonnet" | "opus" | "haiku", {
          // Explicitly provide the path to the Claude CLI
          // Required because import.meta.url is undefined in Electron's bundled environment
          pathToClaudeCodeExecutable: claudeExecutable,
          // Use current working directory as the project root
          cwd: process.cwd(),
          // Use default permission mode (will prompt for permissions)
          permissionMode: "default",
        }),
      models,
    };
  }

  // Codex CLI uses CLI authentication, not API keys
  if (providerId === "codex-cli") {
    // Find the Codex CLI executable path or fall back to npx
    const codexExecutable = findCodexCliExecutable();

    return {
      id: providerId,
      name: "Codex CLI",
      createModel: (modelId) =>
        codexCli(modelId, {
          // Fall back to npx if CLI not installed
          allowNpx: !codexExecutable,
          // Skip git repo check for flexibility
          skipGitRepoCheck: true,
          // Use current working directory as the project root
          cwd: process.cwd(),
        }),
      models,
    };
  }

  const apiKey = getApiKey(providerId);

  if (!apiKey) {
    console.warn(`[ProviderFactory] No API key for ${providerId}, skipping`);
    return null;
  }

  switch (providerId) {
    case "anthropic": {
      const provider = createAnthropic({ apiKey });
      return {
        id: providerId,
        name: "Anthropic",
        createModel: (modelId) => provider(modelId),
        models,
      };
    }

    case "openai": {
      const provider = createOpenAI({ apiKey });
      return {
        id: providerId,
        name: "OpenAI",
        createModel: (modelId) => provider(modelId),
        models,
      };
    }

    case "google": {
      const provider = createGoogleGenerativeAI({ apiKey });
      return {
        id: providerId,
        name: "Google",
        createModel: (modelId) => provider(modelId),
        models,
      };
    }

    case "mistral": {
      const provider = createMistral({ apiKey });
      return {
        id: providerId,
        name: "Mistral",
        createModel: (modelId) => provider(modelId),
        models,
      };
    }

    // OpenAI-compatible providers
    case "groq":
    case "openrouter":
    case "together":
    case "replicate":
    case "perplexity": {
      const provider = createOpenAI({
        apiKey,
        baseURL: OPENAI_COMPATIBLE_BASE_URLS[providerId],
      });
      const displayNames: Record<string, string> = {
        groq: "Groq",
        openrouter: "OpenRouter",
        together: "Together AI",
        replicate: "Replicate",
        perplexity: "Perplexity",
      };
      return {
        id: providerId,
        name: displayNames[providerId] ?? providerId,
        createModel: (modelId) => provider(modelId),
        models,
      };
    }

    default:
      console.warn(`[ProviderFactory] Unknown provider: ${providerId}`);
      return null;
  }
}

/**
 * Get the default models for a provider
 */
export function getDefaultModelsForProvider(providerId: SupportedProvider): ModelInfo[] {
  return DEFAULT_MODELS[providerId] ?? [];
}

/**
 * Check if a provider ID is supported
 */
export function isSupportedProvider(providerId: string): providerId is SupportedProvider {
  return providerId in DEFAULT_MODELS;
}

/**
 * Get all supported provider IDs
 */
export function getSupportedProviders(): SupportedProvider[] {
  return Object.keys(DEFAULT_MODELS) as SupportedProvider[];
}

/**
 * Get provider env var mapping
 */
export function getProviderEnvVars(): Record<SupportedProvider, string> {
  return PROVIDER_ENV_VARS;
}

/**
 * Get provider display name
 */
export function getProviderDisplayName(providerId: SupportedProvider): string {
  const displayNames: Record<SupportedProvider, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    groq: "Groq",
    openrouter: "OpenRouter",
    mistral: "Mistral",
    together: "Together AI",
    replicate: "Replicate",
    perplexity: "Perplexity",
    "claude-code": "Claude Code",
    "codex-cli": "Codex CLI",
  };
  return displayNames[providerId] ?? providerId;
}

/**
 * Check if a provider has an API key configured
 */
export function hasProviderApiKey(providerId: SupportedProvider): boolean {
  const envVar = PROVIDER_ENV_VARS[providerId];
  return !!process.env[envVar];
}

/**
 * Check if a provider uses CLI authentication instead of API keys
 */
export function usesCliAuth(providerId: SupportedProvider): boolean {
  return providerId === "claude-code" || providerId === "codex-cli";
}

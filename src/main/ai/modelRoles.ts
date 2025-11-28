/**
 * Model Role Resolver
 *
 * Resolves model roles (smart, coding, fast, cheap) to actual model specifications
 * with fallback behavior when roles are not configured.
 *
 * Fallback graph:
 * - smart <-> coding (bidirectional fallback)
 * - fast <-> cheap (bidirectional fallback)
 * - If one pair is unavailable, try the other pair
 */

import type {
  ModelRoleConfig,
  ModelRoleValue,
  ModelConfig,
  StandardModelRole,
  SupportedProvider,
} from "../workspace/types.js";

/**
 * Resolved model specification with provider, model ID, and optional parameters.
 * This is the normalized form used internally.
 */
export interface ResolvedModelSpec {
  /** Full model ID in format "provider:model" */
  modelId: string;
  /** Provider ID */
  provider: SupportedProvider;
  /** Model name within the provider */
  model: string;
  /** Optional generation parameters */
  params?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    topK?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    stopSequences?: string[];
  };
}

/**
 * Default model assignments for each role
 */
const DEFAULT_MODELS: Record<StandardModelRole, ResolvedModelSpec> = {
  smart: {
    modelId: "anthropic:claude-sonnet-4-20250514",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
  },
  coding: {
    modelId: "anthropic:claude-sonnet-4-20250514",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
  },
  fast: {
    modelId: "groq:llama-3.1-8b-instant",
    provider: "groq",
    model: "llama-3.1-8b-instant",
  },
  cheap: {
    modelId: "groq:llama-3.1-8b-instant",
    provider: "groq",
    model: "llama-3.1-8b-instant",
  },
};

/**
 * Fallback relationships between roles
 */
const FALLBACK_MAP: Record<StandardModelRole, StandardModelRole[]> = {
  smart: ["coding", "fast", "cheap"],
  coding: ["smart", "fast", "cheap"],
  fast: ["cheap", "smart", "coding"],
  cheap: ["fast", "smart", "coding"],
};

/**
 * Check if a string is a standard model role
 */
export function isStandardRole(role: string): role is StandardModelRole {
  return role === "smart" || role === "coding" || role === "fast" || role === "cheap";
}

/**
 * Check if a value is a ModelConfig object (not a string)
 */
function isModelConfig(value: ModelRoleValue): value is ModelConfig {
  return typeof value === "object" && value !== null && "provider" in value && "model" in value;
}

/**
 * Parse a model string in format "provider:model" into components
 */
function parseModelString(modelStr: string): { provider: SupportedProvider; model: string } | null {
  if (!modelStr.includes(":")) {
    return null;
  }
  const [provider, ...modelParts] = modelStr.split(":");
  const model = modelParts.join(":"); // Handle model IDs that contain colons
  return {
    provider: provider as SupportedProvider,
    model,
  };
}

/**
 * Convert a ModelRoleValue (string or object) to a ResolvedModelSpec
 */
function resolveModelValue(value: ModelRoleValue): ResolvedModelSpec | null {
  if (typeof value === "string") {
    const parsed = parseModelString(value);
    if (!parsed) {
      console.warn(`[ModelRoles] Invalid model string format: ${value}`);
      return null;
    }
    return {
      modelId: value,
      provider: parsed.provider,
      model: parsed.model,
    };
  }

  if (isModelConfig(value)) {
    const spec: ResolvedModelSpec = {
      modelId: `${value.provider}:${value.model}`,
      provider: value.provider,
      model: value.model,
    };

    // Add optional parameters if present
    const params: ResolvedModelSpec["params"] = {};
    if (value.temperature !== undefined) params.temperature = value.temperature;
    if (value.maxTokens !== undefined) params.maxTokens = value.maxTokens;
    if (value.topP !== undefined) params.topP = value.topP;
    if (value.topK !== undefined) params.topK = value.topK;
    if (value.presencePenalty !== undefined) params.presencePenalty = value.presencePenalty;
    if (value.frequencyPenalty !== undefined) params.frequencyPenalty = value.frequencyPenalty;
    if (value.stopSequences !== undefined) params.stopSequences = value.stopSequences;

    if (Object.keys(params).length > 0) {
      spec.params = params;
    }

    return spec;
  }

  return null;
}

/**
 * Model Role Resolver
 *
 * Resolves role names to model specifications, handling fallbacks when a role is not configured.
 */
export class ModelRoleResolver {
  private config: ModelRoleConfig;

  constructor(config?: ModelRoleConfig) {
    this.config = config ?? {};
  }

  /**
   * Resolve a standard role to a full model specification.
   * Returns null if no model is available for this role (even after fallbacks).
   */
  resolveSpec(role: StandardModelRole): ResolvedModelSpec | null {
    // Check if role is directly configured
    const configured = this.config[role];
    if (configured !== undefined) {
      const spec = resolveModelValue(configured);
      if (spec) return spec;
    }

    // Try fallback roles
    const fallbacks = FALLBACK_MAP[role];
    for (const fallbackRole of fallbacks) {
      const fallbackValue = this.config[fallbackRole];
      if (fallbackValue !== undefined) {
        const spec = resolveModelValue(fallbackValue);
        if (spec) return spec;
      }
    }

    // Use default if no config at all
    return DEFAULT_MODELS[role];
  }

  /**
   * Resolve a standard role to a model ID string (for backwards compatibility).
   * Returns null if no model is available for this role (even after fallbacks).
   */
  resolve(role: StandardModelRole): string | null {
    const spec = this.resolveSpec(role);
    return spec?.modelId ?? null;
  }

  /**
   * Get a model specification by role or direct model ID.
   *
   * If the input is a standard role name, resolves it to a full spec.
   * Otherwise, parses it as a direct "provider:model" string.
   */
  getModelSpec(roleOrId: string): ResolvedModelSpec {
    if (isStandardRole(roleOrId)) {
      const spec = this.resolveSpec(roleOrId);
      if (spec) return spec;
      // If resolution failed, return the default
      return DEFAULT_MODELS[roleOrId];
    }

    // Not a role, treat as direct model ID
    const parsed = parseModelString(roleOrId);
    if (parsed) {
      return {
        modelId: roleOrId,
        provider: parsed.provider,
        model: parsed.model,
      };
    }

    // Fallback: assume it's a model name without provider prefix
    // Default to anthropic for backwards compatibility
    console.warn(
      `[ModelRoles] Model ID without provider prefix: ${roleOrId}, defaulting to anthropic`
    );
    return {
      modelId: `anthropic:${roleOrId}`,
      provider: "anthropic",
      model: roleOrId,
    };
  }

  /**
   * Get a model ID by role or direct model ID (for backwards compatibility).
   *
   * If the input is a standard role name, resolves it to a model ID.
   * Otherwise, returns the input as-is (assuming it's a direct model ID).
   */
  getModel(roleOrId: string): string {
    return this.getModelSpec(roleOrId).modelId;
  }

  /**
   * Get all configured role mappings as model IDs
   */
  getAllRoles(): Record<string, string> {
    const result: Record<string, string> = {};

    // Standard roles with resolution
    for (const role of ["smart", "coding", "fast", "cheap"] as StandardModelRole[]) {
      const spec = this.resolveSpec(role);
      if (spec) {
        result[role] = spec.modelId;
      }
    }

    // Custom roles (direct pass-through)
    for (const [key, value] of Object.entries(this.config)) {
      if (value !== undefined && !isStandardRole(key)) {
        const spec = resolveModelValue(value);
        if (spec) {
          result[key] = spec.modelId;
        }
      }
    }

    return result;
  }

  /**
   * Get all configured role mappings as full specifications
   */
  getAllRoleSpecs(): Record<string, ResolvedModelSpec> {
    const result: Record<string, ResolvedModelSpec> = {};

    // Standard roles with resolution
    for (const role of ["smart", "coding", "fast", "cheap"] as StandardModelRole[]) {
      const spec = this.resolveSpec(role);
      if (spec) {
        result[role] = spec;
      }
    }

    // Custom roles (direct pass-through)
    for (const [key, value] of Object.entries(this.config)) {
      if (value !== undefined && !isStandardRole(key)) {
        const spec = resolveModelValue(value);
        if (spec) {
          result[key] = spec;
        }
      }
    }

    return result;
  }

  /**
   * Get the raw configuration (without fallback resolution)
   */
  getRawConfig(): ModelRoleConfig {
    return { ...this.config };
  }

  /**
   * Update the configuration
   */
  updateConfig(config: ModelRoleConfig): void {
    this.config = config;
  }
}

/**
 * Create a model role resolver from workspace config
 */
export function createModelRoleResolver(config?: ModelRoleConfig): ModelRoleResolver {
  return new ModelRoleResolver(config);
}

/**
 * Centralized Agent Configuration Definitions
 *
 * Single source of truth for all agent parameters. Used by:
 * - Agent Manager to advertise agent capabilities
 * - Pre-connection UI (AgentSetupPhase) to render parameter inputs
 * - Workers to validate and merge initialization config
 * - Settings UI generator to create runtime settings forms
 */

import type { FieldDefinition, FieldValue } from "@natstack/core";

// ============================================================================
// Model Version Parsing & Auto-Selection
// ============================================================================

/**
 * Parsed model version information
 */
export interface ParsedModelVersion {
  /** Original model ID */
  id: string;
  /** Model family (e.g., "opus", "sonnet", "haiku", "codex") */
  family: string;
  /** Major version number */
  major: number;
  /** Minor version number (0 if not present) */
  minor: number;
  /** Date suffix if present (YYYYMMDD format) */
  dateSuffix?: string;
  /** Provider prefix if present */
  provider?: string;
  /** Variant suffix (e.g., "max", "mini") */
  variant?: string;
}

/**
 * Model family tier rankings (higher = more capable, preferred as default)
 */
const MODEL_FAMILY_TIERS: Record<string, number> = {
  // Claude families
  opus: 100,
  sonnet: 80,
  haiku: 60,
  // OpenAI/Codex families
  codex: 90,
  gpt: 85,
  o3: 95,
  o1: 70,
};

/**
 * Variant rankings (higher = more capable)
 */
const VARIANT_RANKINGS: Record<string, number> = {
  max: 10,
  pro: 5,
  mini: -10,
  lite: -15,
};

/**
 * Parse a model ID into version components
 *
 * Handles formats like:
 * - claude-opus-4-6
 * - claude-opus-4-5-20251101
 * - gpt-5.3-codex
 * - gpt-5.2-codex-max
 * - anthropic:claude-sonnet-4-5-20250929
 */
export function parseModelVersion(modelId: string): ParsedModelVersion | null {
  let id = modelId;
  let provider: string | undefined;

  // Extract provider prefix if present
  if (id.includes(":")) {
    const parts = id.split(":", 2);
    provider = parts[0];
    id = parts[1] ?? id;
  }

  // Try Claude-style parsing: claude-{family}-{major}-{minor}[-YYYYMMDD]
  const claudeMatch = id.match(
    /^claude-(\w+)-(\d+)(?:-(\d+))?(?:-(\d{8}))?$/i
  );
  if (claudeMatch) {
    const [, family, majorStr, minorStr, dateSuffix] = claudeMatch;
    if (family && majorStr) {
      return {
        id: modelId,
        family: family.toLowerCase(),
        major: parseInt(majorStr, 10),
        minor: minorStr ? parseInt(minorStr, 10) : 0,
        dateSuffix,
        provider,
      };
    }
  }

  // Try GPT/Codex-style parsing: gpt-{major}.{minor}[-codex][-variant]
  const gptMatch = id.match(
    /^(gpt|o\d)-(\d+)(?:\.(\d+))?(?:-(codex|turbo))?(?:-(max|mini|pro|lite))?$/i
  );
  if (gptMatch) {
    const [, prefix, majorStr, minorStr, family, variant] = gptMatch;
    if (prefix && majorStr) {
      return {
        id: modelId,
        family: family?.toLowerCase() ?? prefix.toLowerCase(),
        major: parseInt(majorStr, 10),
        minor: minorStr ? parseInt(minorStr, 10) : 0,
        provider,
        variant: variant?.toLowerCase(),
      };
    }
  }

  // Try simple codex format: codex-{major}.{minor}[-variant]
  const codexMatch = id.match(
    /^codex-(\d+)(?:\.(\d+))?(?:-(max|mini|pro|lite))?$/i
  );
  if (codexMatch) {
    const [, majorStr, minorStr, variant] = codexMatch;
    if (majorStr) {
      return {
        id: modelId,
        family: "codex",
        major: parseInt(majorStr, 10),
        minor: minorStr ? parseInt(minorStr, 10) : 0,
        provider,
        variant: variant?.toLowerCase(),
      };
    }
  }

  return null;
}

/**
 * Compare two parsed model versions
 * Returns positive if a > b, negative if a < b, 0 if equal
 */
export function compareModelVersions(
  a: ParsedModelVersion,
  b: ParsedModelVersion
): number {
  // First compare by family tier
  const tierA = MODEL_FAMILY_TIERS[a.family] ?? 50;
  const tierB = MODEL_FAMILY_TIERS[b.family] ?? 50;
  if (tierA !== tierB) {
    return tierA - tierB;
  }

  // Same family tier - compare versions
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }

  // Same version - compare by date suffix (newer is better)
  if (a.dateSuffix && b.dateSuffix) {
    return a.dateSuffix.localeCompare(b.dateSuffix);
  }
  if (a.dateSuffix && !b.dateSuffix) {
    // Models without date suffix are usually aliases for latest
    return -1;
  }
  if (!a.dateSuffix && b.dateSuffix) {
    return 1;
  }

  // Compare variants (max > base > mini)
  const variantA = VARIANT_RANKINGS[a.variant ?? ""] ?? 0;
  const variantB = VARIANT_RANKINGS[b.variant ?? ""] ?? 0;
  return variantA - variantB;
}

/**
 * Find the newest/most capable model from a list of model IDs
 *
 * @param models - Array of model options with value (id) property
 * @param familyFilter - Optional filter to only consider specific families (e.g., ["opus", "sonnet"])
 * @returns The model ID of the newest model, or null if none could be parsed
 */
export function findNewestModel(
  models: Array<{ value: string; label?: string }>,
  familyFilter?: string[]
): string | null {
  let newest: ParsedModelVersion | null = null;

  for (const model of models) {
    const parsed = parseModelVersion(model.value);
    if (!parsed) continue;

    // Apply family filter if specified
    if (familyFilter && !familyFilter.includes(parsed.family)) {
      continue;
    }

    if (!newest || compareModelVersions(parsed, newest) > 0) {
      newest = parsed;
    }
  }

  return newest?.id ?? null;
}

/**
 * Find the newest model within a specific family
 */
export function findNewestInFamily(
  models: Array<{ value: string; label?: string }>,
  family: string
): string | null {
  return findNewestModel(models, [family.toLowerCase()]);
}

/**
 * Get the recommended default model from a list
 * Prefers the highest-tier family's newest version
 */
export function getRecommendedDefault(
  models: Array<{ value: string; label?: string }>
): string | null {
  return findNewestModel(models);
}

// ============================================================================
// Shared Parameter Components
// ============================================================================

/**
 * Shared autonomy level notches used across agents and session settings.
 * Extracted to ensure consistency.
 */
export const AUTONOMY_NOTCHES = [
  { value: 0, label: "Restricted", description: "Read-only access, requires approval" },
  { value: 1, label: "Standard", description: "Can modify workspace" },
  { value: 2, label: "Autonomous", description: "Full access, minimal restrictions" },
] as const;

/**
 * Project location options for session settings
 */
export const PROJECT_LOCATION_OPTIONS = [
  { value: "external", label: "External Filesystem", description: "Access files on your local machine" },
  { value: "browser", label: "Browser Storage", description: "Sandboxed browser storage (restricted mode)" },
] as const;

/**
 * Session-level parameters for chat-launcher.
 * These configure the channel/session, not individual agents.
 */
export const SESSION_PARAMETERS: FieldDefinition[] = [
  {
    key: "projectLocation",
    label: "Project Location",
    description: "Where the project files are stored",
    type: "segmented",
    default: "external",
    options: [...PROJECT_LOCATION_OPTIONS],
    group: "Session",
    order: 0,
  },
  {
    key: "workingDirectory",
    label: "Working Directory",
    description: "Path to the project directory",
    type: "string",
    placeholder: "/path/to/project",
    visibleWhen: { field: "projectLocation", operator: "eq", value: "external" },
    group: "Session",
    order: 1,
  },
  {
    key: "defaultAutonomy",
    label: "Default Autonomy",
    description: "Default autonomy level for agents (can be overridden per-agent)",
    type: "slider",
    default: 0,
    min: 0,
    max: 2,
    step: 1,
    notches: [...AUTONOMY_NOTCHES],
    warnings: [{ when: 2, message: "Allows unrestricted tool execution", severity: "danger" }],
    group: "Session",
    order: 2,
  },
];

/**
 * Filter parameters to only include per-agent configurable ones.
 * Excludes channelLevel parameters which are set at the session level.
 */
export function filterPerAgentParameters(params: FieldDefinition[]): FieldDefinition[] {
  return params.filter((p) => !p.channelLevel);
}

// ============================================================================
// Model Fallback Lists
// ============================================================================

/**
 * Fallback model lists for when SDK is unavailable.
 * These are used as default options in parameter definitions.
 */
export const CLAUDE_MODEL_FALLBACKS: Array<{ value: string; label: string; description?: string }> = [
  { value: "claude-opus-4-6", label: "Claude Opus 4.6", description: "Most capable model" },
  { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5", description: "Balanced performance" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", description: "Fast and efficient" },
  { value: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" },
  { value: "claude-opus-4-1-20250805", label: "Claude Opus 4.1" },
  { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
];

export const AI_ROLE_FALLBACKS: Array<{ value: string; label: string; description?: string }> = [
  { value: "fast", label: "Fast", description: "Quick responses, lower latency" },
  { value: "smart", label: "Smart", description: "More thoughtful, higher quality" },
  { value: "coding", label: "Coding", description: "Optimized for code generation" },
];

/**
 * Claude Code agent parameters
 */
export const CLAUDE_CODE_PARAMETERS: FieldDefinition[] = [
  {
    key: "workingDirectory",
    label: "Working Directory",
    description: "Required: Set in Session Settings",
    type: "string",
    channelLevel: true, // Value comes from channel config
    required: true,     // This agent requires a working directory
    placeholder: "/path/to/project",
    group: "Environment",
    order: 0,
  },
  {
    key: "model",
    label: "Model",
    description: "Claude model for code generation",
    type: "select",
    required: false,
    default: "claude-opus-4-6",
    // Fallback options - workers may override with dynamic SDK list at runtime
    options: CLAUDE_MODEL_FALLBACKS,
    group: "Model",
    order: 1,
  },
  {
    key: "maxThinkingTokens",
    label: "Thinking Budget",
    description: "Extended thinking token budget for complex reasoning",
    type: "slider",
    required: false,
    default: 10240,
    min: 0,
    max: 32000,
    step: 1024,
    sliderLabels: { min: "Off", max: "Maximum" },
    group: "Model",
    order: 2,
  },
  {
    key: "executionMode",
    label: "Execution Mode",
    type: "toggle",
    default: "edit",
    options: [
      { value: "plan", label: "Plan", description: "Explore and plan without executing tools" },
      { value: "edit", label: "Edit", description: "Execute tools to make changes" },
    ],
    group: "Permissions",
    order: 3,
  },
  {
    key: "autonomyLevel",
    label: "Autonomy",
    type: "slider",
    default: 2,
    min: 0,
    max: 2,
    step: 1,
    notches: [...AUTONOMY_NOTCHES],
    visibleWhen: { field: "executionMode", operator: "eq", value: "edit" },
    warnings: [{ when: 2, message: "Allows unrestricted tool execution", severity: "danger" }],
    group: "Permissions",
    order: 4,
  },
  {
    key: "restrictedMode",
    label: "Restricted Mode",
    description: "Determined by Session Settings (browser storage = restricted)",
    type: "boolean",
    channelLevel: true, // Value comes from channel config
    required: false,    // Optional - has sensible default
    default: false,
    group: "Environment",
    order: 5,
  },
];

/**
 * AI Responder (fast AI) agent parameters
 */
export const AI_RESPONDER_PARAMETERS: FieldDefinition[] = [
  {
    key: "modelRole",
    label: "Model Role",
    description: "Optimized model configuration for different tasks",
    type: "select",
    required: false,
    default: "coding",
    // Fallback options - workers may override with dynamic ai.listRoles() at runtime
    options: AI_ROLE_FALLBACKS,
    group: "Model",
    order: 0,
  },
  {
    key: "temperature",
    label: "Temperature",
    description: "Controls randomness in responses",
    type: "slider",
    required: false,
    default: 0.7,
    min: 0,
    max: 2,
    step: 0.1,
    sliderLabels: { min: "Precise", max: "Creative" },
    group: "Model",
    order: 1,
  },
  {
    key: "maxOutputTokens",
    label: "Response Length",
    description: "Maximum tokens in generated responses",
    type: "slider",
    required: false,
    default: 1024,
    min: 256,
    max: 4096,
    step: 256,
    sliderLabels: { min: "Brief", max: "Detailed" },
    group: "Model",
    order: 2,
  },
  {
    key: "autonomyLevel",
    label: "Autonomy",
    type: "slider",
    default: 2,
    min: 0,
    max: 2,
    step: 1,
    notches: [...AUTONOMY_NOTCHES],
    warnings: [{ when: 2, message: "Allows unrestricted tool execution", severity: "warning" }],
    group: "Permissions",
    order: 3,
  },
  {
    key: "maxSteps",
    label: "Max Agent Steps",
    type: "slider",
    default: 5,
    min: 1,
    max: 20,
    step: 1,
    sliderLabels: { min: "1", max: "20" },
    group: "Capabilities",
    order: 4,
  },
  {
    key: "thinkingBudget",
    label: "Thinking Budget",
    description: "Extended thinking token budget for complex reasoning (0 = disabled)",
    type: "slider",
    required: false,
    default: 0,
    min: 0,
    max: 32000,
    step: 1024,
    sliderLabels: { min: "Off", max: "Maximum" },
    group: "Model",
    order: 5,
  },
];

/**
 * Codex agent parameters
 */
export const CODEX_PARAMETERS: FieldDefinition[] = [
  {
    key: "workingDirectory",
    label: "Working Directory",
    description: "Required: Set in Session Settings",
    type: "string",
    channelLevel: true, // Value comes from channel config
    required: true,     // This agent requires a working directory
    placeholder: "/path/to/project",
    group: "Environment",
    order: 0,
  },
  {
    key: "model",
    label: "Model",
    description: "OpenAI Codex model for code generation",
    type: "select",
    required: false,
    default: "gpt-5.3-codex",
    options: [
      { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", description: "Most advanced agentic coding model" },
      { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", description: "Previous generation" },
      { value: "gpt-5.2-codex-max", label: "GPT-5.2 Codex Max", description: "Long-horizon agentic coding" },
      { value: "gpt-5.2-codex-mini", label: "GPT-5.2 Codex Mini", description: "Cost-effective coding" },
      { value: "gpt-5.2", label: "GPT-5.2", description: "Best general agentic model" },
      { value: "gpt-5.1-codex", label: "GPT-5.1 Codex", description: "Legacy Codex model" },
    ],
    group: "Model",
    order: 1,
  },
  {
    key: "reasoningEffort",
    label: "Reasoning Effort",
    description: "Higher effort = more thorough but slower",
    type: "slider",
    required: false,
    default: 3, // high
    min: 0,
    max: 3,
    step: 1,
    notches: [
      { value: 0, label: "Minimal", description: "Fast, minimal reasoning" },
      { value: 1, label: "Low", description: "Quick reasoning" },
      { value: 2, label: "Medium", description: "Balanced approach" },
      { value: 3, label: "High", description: "Thorough, slower" },
    ],
    group: "Model",
    order: 2,
  },
  {
    key: "autonomyLevel",
    label: "Autonomy",
    type: "slider",
    default: 2,
    min: 0,
    max: 2,
    step: 1,
    notches: [...AUTONOMY_NOTCHES],
    warnings: [{ when: 2, message: "Allows unrestricted file system access", severity: "danger" }],
    group: "Permissions",
    order: 3,
  },
  {
    key: "webSearchEnabled",
    label: "Web Search",
    description: "Allow web search capabilities",
    type: "boolean",
    required: false,
    default: true,
    group: "Permissions",
    order: 4,
  },
  {
    key: "restrictedMode",
    label: "Restricted Mode",
    description: "Determined by Session Settings (browser storage = restricted)",
    type: "boolean",
    channelLevel: true, // Value comes from channel config
    required: false,    // Optional - has sensible default
    default: false,
    group: "Environment",
    order: 5,
  },
];

/**
 * Get default values from parameter definitions
 */
export function getParameterDefaults(
  parameters: FieldDefinition[]
): Record<string, FieldValue> {
  const defaults: Record<string, FieldValue> = {};
  for (const param of parameters) {
    if (param.default !== undefined) {
      defaults[param.key] = param.default;
    }
  }
  return defaults;
}

// ============================================================================
// Agent Parameter Registry
// ============================================================================

/**
 * Maps agent IDs to their authoritative parameter definitions.
 * package.json parameters are merged in at runtime only for keys
 * not already covered here.
 */
export const AGENT_PARAMETER_REGISTRY: Record<string, FieldDefinition[]> = {
  "claude-code-responder": CLAUDE_CODE_PARAMETERS,
  "codex-responder": CODEX_PARAMETERS,
  "pubsub-chat-responder": AI_RESPONDER_PARAMETERS,
};

/**
 * Enrich a manifest's parameters using the central registry.
 * Central params take precedence; any extra keys from the manifest
 * (e.g. agent-specific params not yet in the registry) are appended.
 */
export function enrichManifestParameters(
  manifest: { id: string; parameters?: FieldDefinition[] }
): FieldDefinition[] {
  const centralParams = AGENT_PARAMETER_REGISTRY[manifest.id];
  if (!centralParams) return manifest.parameters ?? [];
  const centralKeys = new Set(centralParams.map((p) => p.key));
  const extraParams = (manifest.parameters ?? []).filter((p) => !centralKeys.has(p.key));
  return [...centralParams, ...extraParams];
}
